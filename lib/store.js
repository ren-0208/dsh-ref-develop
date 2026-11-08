/**
 * File-backed memory store (schema v2).
 *
 * Layout of one memory root (`<root>`):
 *
 *   AGENTS.md              entry point for humans/agents ("this is a memory root")
 *   store.json             {"version":2,"createdAt":...,"updatedAt":...}
 *   memory.jsonl           canonical entries, one JSON object per line
 *   MEMORY/INDEX.md        generated overview
 *   MEMORY/PLAYBOOK.md     generated: methods + lessons + state
 *   MEMORY/KNOWLEDGE.md    generated: books/news/papers/domain knowledge
 *   MEMORY/WP/INDEX.md     generated: problem reviews (CTF, coursework, any subject)
 *   MEMORY/SESSIONS.md     append-only session log
 *   MEMORY/PERSONA.md      generated: owner preferences (personalization only)
 *   sessions/<id>.md       per-session notes used for consolidation
 *
 * Concurrency: every mutator runs through a promise chain, then takes an
 * advisory file lock, then replaces memory.jsonl atomically. Readers always see
 * a complete file; the in-memory cache makes prompt assembly synchronous.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { entrySummary, mergeEntry, normalizeEntry, SCHEMA_VERSION, strengthOf, entryKey, similarity, lessonPromotion } from './entry.js'
import { parseJsonl, readJson, stringifyJsonl, withFileLock, writeFileAtomic, writeJsonAtomic } from './fsx.js'
import { nowIso, oneLine, toText, uid } from './util.js'

export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function settingsFilePath(home = resolveDshHome()) {
  return path.join(home, 'growth-note', 'settings.json')
}

export function resolveRoot({ scope, cwd, home = resolveDshHome() }) {
  if (scope === 'workspace') return path.join(cwd || process.cwd(), '.growth-note')
  return path.join(home, 'growth-note', 'global')
}

const AGENTS_DOC = `# 记忆与成长（dsh-ref-develop 自动维护）

这个目录由 DSH 插件 **growth-note** 生成，用来跨会话沉淀可复用的经验。
不要手工重写本文件；条目请通过对话中的 \`growth_*\` 工具增删（也可以直接改
\`MEMORY/*.md\` 中的视图，但以 \`memory.jsonl\` 为准）。

## 怎么用

- 新会话开始时，插件按**当前问题**把最相关的记忆注入系统提示词，无需手动读取。
- 需要细节时调用 \`growth_recall\`（按关键词 / 类型检索条目）。
- 学到可复用的结论时调用 \`growth_remember\`（method / lesson / knowledge / wp / preference / state）。
- 记忆范围（全局共享或单工作区）用 \`growth_config\` 或 \`/growth scope\` 切换。
- 不再成立的条目用 \`growth_forget\`（软删除：标记 superseded，保留证据）。

## 六类内容（对齐「记忆与成长方法」）

1. **状态** state：项目现状、下一步。
2. **教训** lesson：试过什么、为什么失败，别再踩。
3. **方法** method：可复用套路、命令、工具链（教训被反复验证后会升级成方法）。
4. **知识** knowledge：读书 / 新闻 / 论文 / 课程里的可复用结论。
5. **复盘** wp：题目（CTF、课程题、专业题）的解法与关键一步。
6. **画像** preference：用户稳定偏好（仅在「个性化匹配」开启时注入）。

判断标准：另一个会话只看这个目录，能不能接着干而不必重新问人。
`

const SESSION_LINE_HEAD = '# 会话流水\n\n> 由 growth-note 自动维护：每完成一个会话的首个回合就登记一行。\n\n'

function fileForSession(sessionsDir, sessionId) {
  return path.join(sessionsDir, `${toText(sessionId).replace(/[^\w.-]/g, '_')}.md`)
}

export class GrowthStore {
  constructor(root, options = {}) {
    this.root = root
    this.halfLifeDays = options.halfLifeDays ?? 30
    this.maxEntries = options.maxEntries ?? 3000
    this.memoryDir = path.join(root, 'MEMORY')
    this.sessionsDir = path.join(root, 'sessions')
    this.entriesPath = path.join(root, 'memory.jsonl')
    this.metaPath = path.join(root, 'store.json')
    this.chain = Promise.resolve()
    this.cache = null
    this.ensured = false
  }

  #enqueue(operation) {
    const next = this.chain.then(operation, operation)
    this.chain = next.catch(() => {})
    return next
  }

  configure({ halfLifeDays, maxEntries } = {}) {
    if (Number.isFinite(halfLifeDays)) this.halfLifeDays = halfLifeDays
    if (Number.isFinite(maxEntries)) this.maxEntries = maxEntries
  }

  async ensure() {
    if (this.ensured) {
      await this.load()
      return this
    }
    await fs.mkdir(this.memoryDir, { recursive: true })
    await fs.mkdir(path.join(this.memoryDir, 'WP'), { recursive: true })
    await fs.mkdir(this.sessionsDir, { recursive: true })
    await this.#writeIfMissing(path.join(this.root, 'AGENTS.md'), AGENTS_DOC)
    await this.#writeIfMissing(this.entriesPath, '')
    await this.#writeIfMissing(path.join(this.memoryDir, 'SESSIONS.md'), SESSION_LINE_HEAD)
    const meta = await readJson(this.metaPath, null)
    if (!meta || meta.version !== SCHEMA_VERSION) {
      await writeJsonAtomic(this.metaPath, { version: SCHEMA_VERSION, createdAt: meta?.createdAt ?? nowIso(), updatedAt: nowIso() })
    }
    this.ensured = true
    await this.load()
    await this.render()
    return this
  }

  async #writeIfMissing(file, content) {
    try {
      await fs.access(file)
    } catch {
      await writeFileAtomic(file, content)
    }
  }

  /** Load entries into memory (idempotent, cheap after the first call). */
  async load({ force = false } = {}) {
    if (this.cache && !force) return this.cache
    let raw = ''
    try {
      raw = await fs.readFile(this.entriesPath, 'utf8')
    } catch {
      raw = ''
    }
    const now = nowIso()
    const entries = parseJsonl(raw).map((item) => normalizeEntry(item, { now }))
    this.cache = entries
    return entries
  }

  /** Synchronous read of the last loaded snapshot, used by prompt assembly. */
  entriesSync() {
    return this.cache ?? []
  }

  async entries() {
    return (await this.load()).map((entry) => ({ ...entry }))
  }

  async activeEntries() {
    return (await this.load()).filter((entry) => entry.status === 'active')
  }

  async #save(entries) {
    const now = nowIso()
    const kept = this.#prune(entries)
    await withFileLock(this.entriesPath, async () => {
      await writeFileAtomic(this.entriesPath, stringifyJsonl(kept))
    })
    this.cache = kept
    await writeJsonAtomic(this.metaPath, { version: SCHEMA_VERSION, createdAt: (await readJson(this.metaPath, null))?.createdAt ?? now, updatedAt: now })
    await this.render()
    return kept
  }

  #prune(entries) {
    const live = entries.filter((entry) => {
      if (entry.status === 'active') return true
      const ageDays = (Date.now() - (Date.parse(entry.updatedAt ?? 0) || 0)) / 86_400_000
      return ageDays < 120
    })
    if (live.length <= this.maxEntries) return live
    const pinned = live.filter((entry) => entry.kind === 'preference' || entry.kind === 'state')
    const rest = live
      .filter((entry) => entry.kind !== 'preference' && entry.kind !== 'state')
      .sort((a, b) => strengthOf(b, { halfLifeDays: this.halfLifeDays }) - strengthOf(a, { halfLifeDays: this.halfLifeDays }))
    const room = Math.max(0, this.maxEntries - pinned.length)
    return [...pinned, ...rest.slice(0, room)]
  }

  /**
   * Insert or merge one entry. Merging keeps one claim per (kind, title) and
   * raises confidence when the same claim appears again.
   */
  async addEntry(input, { maxEntries, dedupeThreshold = 0.7, promoteLessonAfter = 3 } = {}) {
    const result = await this.#enqueue(async () => {
      if (Number.isFinite(maxEntries)) this.maxEntries = maxEntries
      const entries = await this.load({ force: true })
      const now = nowIso()
      const candidate = normalizeEntry(input, { now })
      const key = entryKey(candidate)
      let target = entries.find((entry) => entryKey(entry) === key && entry.status !== 'rejected')
      if (!target) {
        let best = null
        for (const entry of entries) {
          if (entry.status !== 'active') continue
          const score = similarity(entry, candidate)
          if (score >= dedupeThreshold && (!best || score > best.score)) best = { entry, score }
        }
        target = best?.entry ?? null
      }
      // A preference only merges when it carries the *same* value. A new value
      // for the same aspect supersedes the old claim instead of concatenating
      // two contradictory facts into one body.
      if (target && candidate.kind === 'preference' && target.kind === 'preference') {
        const aspect = candidate.meta?.aspect ?? ''
        const sameAspect = aspect && aspect === (target.meta?.aspect ?? '')
        const sameValue = toText(candidate.meta?.value ?? candidate.body) === toText(target.meta?.value ?? target.body)
        if (sameAspect && !sameValue) target = null
      }
      if (target) {
        mergeEntry(target, candidate, { now })
        await this.#save(entries)
        return { entry: target, merged: true, promoted: null }
      }
      entries.push(candidate)
      let promoted = null
      if (candidate.kind === 'preference') this.#supersedePreferences(entries, candidate)
      if (candidate.kind === 'lesson') {
        const promotion = lessonPromotion(candidate, { threshold: promoteLessonAfter, now })
        if (promotion) {
          const method = normalizeEntry({ ...promotion, meta: promotion.meta }, { now })
          method.promotedFrom = candidate.id
          candidate.promotedTo = method.id
          entries.push(method)
          promoted = method
        }
      }
      await this.#save(entries)
      return { entry: candidate, merged: false, promoted }
    })
    return result
  }

  #supersedePreferences(entries, fresh) {
    const aspect = fresh.meta?.aspect ?? ''
    const value = toText(fresh.meta?.value ?? fresh.body)
    if (!aspect) return
    for (const entry of entries) {
      if (entry.id === fresh.id || entry.kind !== 'preference' || entry.status !== 'active') continue
      const sameAspect = (entry.meta?.aspect ?? '') === aspect
      const sameValue = toText(entry.meta?.value ?? entry.body) === value
      if (sameAspect && !sameValue) {
        entry.status = 'superseded'
        entry.supersededBy = fresh.id
        entry.updatedAt = nowIso()
        fresh.supersedes = [...new Set([...(fresh.supersedes ?? []), entry.id])]
      }
    }
  }

  async updateEntry(id, patch = {}) {
    return this.#enqueue(async () => {
      const entries = await this.load({ force: true })
      const entry = entries.find((item) => item.id === id)
      if (!entry) return null
      if (typeof patch.title === 'string' && patch.title.trim()) entry.title = oneLine(patch.title, 160)
      if (typeof patch.body === 'string') entry.body = toText(patch.body).slice(0, 6000)
      if (Array.isArray(patch.tags)) entry.tags = [...new Set(patch.tags.map((tag) => oneLine(tag, 40)).filter(Boolean))].slice(0, 12)
      if (Number.isFinite(Number(patch.confidence))) entry.confidence = Math.min(1, Math.max(0, Number(patch.confidence)))
      if (['active', 'superseded', 'rejected'].includes(patch.status)) entry.status = patch.status
      if (patch.meta && typeof patch.meta === 'object') entry.meta = { ...(entry.meta ?? {}), ...normalizeMetaPatch(entry.kind, patch.meta) }
      entry.updatedAt = nowIso()
      await this.#save(entries)
      return entry
    })
  }

  async removeEntry(id, { soft = true } = {}) {
    return this.#enqueue(async () => {
      const entries = await this.load({ force: true })
      const index = entries.findIndex((entry) => entry.id === id)
      if (index === -1) return null
      const [removed] = entries.splice(index, 1)
      if (soft) {
        removed.status = 'rejected'
        removed.updatedAt = nowIso()
        entries.push(removed)
        await this.#save(entries)
        return removed
      }
      await this.#save(entries)
      return removed
    })
  }

  async touchEntry(ids) {
    if (!ids?.length) return
    const wanted = new Set(ids)
    return this.#enqueue(async () => {
      const entries = await this.load({ force: true })
      let changed = false
      for (const entry of entries) {
        if (!wanted.has(entry.id)) continue
        entry.useCount = (entry.useCount ?? 0) + 1
        entry.lastUsedAt = nowIso()
        changed = true
      }
      if (changed) await this.#save(entries)
    })
  }

  async appendSessionNote(sessionId, markdown, { turn } = {}) {
    return this.#enqueue(async () => {
      const file = fileForSession(this.sessionsDir, sessionId)
      let isNew = false
      try {
        await fs.access(file)
      } catch {
        isNew = true
      }
      const body = isNew ? `# 会话 ${sessionId}\n\n${markdown}` : markdown
      await fs.appendFile(file, body, 'utf8')
      if (isNew) {
        const line = `- ${nowIso().slice(0, 10)} · \`${sessionId}\` · ${oneLine(String(markdown).split('\n')[0].replace(/^#+\s*/, ''), 100)}${turn ? ` · turn ${turn}` : ''}\n`
        await fs.appendFile(path.join(this.memoryDir, 'SESSIONS.md'), line, 'utf8')
      }
    })
  }

  async readSessionNotes(sessionId, limit = 6) {
    let text = ''
    try {
      text = await fs.readFile(fileForSession(this.sessionsDir, sessionId), 'utf8')
    } catch {
      return ''
    }
    const sections = text.split(/\n(?=## )/).filter(Boolean)
    return sections.slice(-limit).join('\n')
  }

  async sessionCount() {
    try {
      const files = await fs.readdir(this.sessionsDir)
      return files.filter((name) => name.endsWith('.md')).length
    } catch {
      return 0
    }
  }

  async stats() {
    const entries = await this.load()
    const counts = {}
    for (const entry of entries) if (entry.status === 'active') counts[entry.kind] = (counts[entry.kind] ?? 0) + 1
    return {
      root: this.root,
      total: entries.filter((entry) => entry.status === 'active').length,
      archived: entries.filter((entry) => entry.status !== 'active').length,
      counts,
      sessions: await this.sessionCount(),
    }
  }

  async writeView(name, content) {
    const file = path.join(this.memoryDir, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    let current = null
    try {
      current = await fs.readFile(file, 'utf8')
    } catch {
      current = null
    }
    if (current !== content) await writeFileAtomic(file, content)
  }

  async render(given) {
    const entries = given ?? (await (async () => this.load())())
    const active = entries.filter((entry) => entry.status === 'active')
    const updated = nowIso().slice(0, 19).replace('T', ' ')
    const byKind = (kind) =>
      active
        .filter((entry) => entry.kind === kind)
        .sort((a, b) => strengthOf(b, { halfLifeDays: this.halfLifeDays }) - strengthOf(a, { halfLifeDays: this.halfLifeDays }))
    const counts = {}
    for (const entry of active) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1
    const line = (entry, index) => `- ${entrySummary(entry, index).replace(/\n {3}/g, '<br>')}`

    await this.writeView(
      'INDEX.md',
      [
        '# 记忆总表',
        '',
        `> growth-note 自动生成 · ${updated} · 活跃 ${active.length} 条 · 归档 ${entries.length - active.length} 条`,
        `> 方法 ${counts.method ?? 0} · 教训 ${counts.lesson ?? 0} · 知识 ${counts.knowledge ?? 0} · 复盘 ${counts.wp ?? 0} · 画像 ${counts.preference ?? 0} · 状态 ${counts.state ?? 0}`,
        '',
        '检索：`growth_recall(query)`；写入：`growth_remember(...)`；切换范围：`growth_config(scope)`。',
        '',
        '## 最近更新',
        '',
        ...(active.length
          ? [...active].sort((a, b) => Date.parse(b.updatedAt ?? 0) - Date.parse(a.updatedAt ?? 0)).slice(0, 40).map(line)
          : ['_暂无_']),
        '',
        '## 已否决 / 被取代',
        '',
        ...(entries.filter((entry) => entry.status !== 'active').length
          ? entries.filter((entry) => entry.status !== 'active').map((entry) => `- ~~${oneLine(entry.title, 100)}~~ · ${entry.status}${entry.supersededBy ? ` → \`${entry.supersededBy.slice(-6)}\`` : ''}`)
          : ['_暂无_']),
        '',
      ].join('\n'),
    )

    await this.writeView(
      'PLAYBOOK.md',
      [
        '# 套路与坑',
        '',
        '## 可复用方法',
        '',
        ...(byKind('method').length ? byKind('method').map(line) : ['_暂无_']),
        '',
        '## 否决清单（试过且失败的）',
        '',
        ...(byKind('lesson').length ? byKind('lesson').map(line) : ['_暂无_']),
        '',
        '## 当前状态与下一步',
        '',
        ...(byKind('state').length ? byKind('state').map(line) : ['_暂无_']),
        '',
      ].join('\n'),
    )

    await this.writeView(
      'KNOWLEDGE.md',
      [
        '# 领域知识',
        '',
        '> 来源：读书 / 新闻 / 论文 / 课程。一条知识写清「结论 + 适用边界 + 出处」。',
        '',
        ...(byKind('knowledge').length ? byKind('knowledge').map(line) : ['_暂无_']),
        '',
      ].join('\n'),
    )

    await this.writeView(
      'WP/INDEX.md',
      [
        '# 题目复盘',
        '',
        '> 覆盖 CTF、课程题、专业题，以及任何学科。一条复盘写清：题目 → 关键一步 → 弯路 → 可复用产物。',
        '',
        ...(byKind('wp').length ? byKind('wp').map(line) : ['_暂无_']),
        '',
      ].join('\n'),
    )

    await this.writeView(
      'PERSONA.md',
      [
        '# 用户画像（个性化匹配）',
        '',
        '> 仅在「个性化匹配」开启时注入提示词。只记录有证据的稳定偏好；新的偏好会取代旧的。',
        '',
        ...(byKind('preference').length ? byKind('preference').map(line) : ['_暂无_']),
        '',
      ].join('\n'),
    )
  }

  /** Human-readable export (also what /growth export prints). */
  async exportMarkdown() {
    const entries = await this.load()
    const stats = await this.stats()
    return [
      '# 记忆与成长导出',
      '',
      `- 目录：${stats.root}`,
      `- 活跃：${stats.total} · 归档：${stats.archived} · 会话笔记：${stats.sessions}`,
      `- 生成时间：${nowIso()}`,
      '',
      ...entries.map((entry) => {
        const head = `## [${entry.kind}] ${oneLine(entry.title, 160)}`
        const facts = [
          `- id：\`${entry.id}\``,
          `- 置信：${Math.round((entry.confidence ?? 0.6) * 100)}% · 使用 ${entry.useCount ?? 0} 次 · 状态 ${entry.status}`,
          entry.tags?.length ? `- 标签：${entry.tags.join(', ')}` : '',
          Object.keys(entry.meta ?? {}).length ? `- 元数据：${JSON.stringify(entry.meta)}` : '',
          entry.source?.sessionId ? `- 来源：${entry.source.sessionId}${entry.source.turn ? ` turn ${entry.source.turn}` : ''}` : '',
          entry.evidence?.length ? `- 证据：${entry.evidence.map((item) => `「${oneLine(item.quote, 80)}」`).join(' ')}` : '',
        ].filter(Boolean)
        return [`${head}`, '', ...facts, '', entry.body ?? '', ''].join('\n')
      }),
    ].join('\n')
  }

  async exportJson() {
    return { version: SCHEMA_VERSION, exportedAt: nowIso(), root: this.root, entries: await this.load() }
  }

  async importEntries(list) {
    let added = 0
    let merged = 0
    for (const item of list) {
      const result = await this.addEntry(item, { dedupeThreshold: 0.7 })
      if (result.merged) merged += 1
      else added += 1
    }
    return { added, merged }
  }

  /** Copy every active entry and session note into another store. */
  async migrateTo(target) {
    await target.ensure()
    const source = await this.load()
    let added = 0
    let merged = 0
    for (const entry of source) {
      if (entry.status !== 'active') continue
      const result = await target.addEntry({ ...entry, id: undefined, mergedFrom: [] }, { dedupeThreshold: 0.7 })
      if (result.merged) merged += 1
      else added += 1
    }
    let files = 0
    try {
      for (const name of await fs.readdir(this.sessionsDir)) {
        if (!name.endsWith('.md')) continue
        const from = path.join(this.sessionsDir, name)
        const to = path.join(target.sessionsDir, name)
        try {
          await fs.access(to)
        } catch {
          await writeFileAtomic(to, await fs.readFile(from, 'utf8'))
          files += 1
        }
      }
    } catch {
      files = 0
    }
    return { added, merged, sessionFiles: files }
  }
}

function normalizeMetaPatch(kind, meta) {
  const out = {}
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) continue
    out[key] = Array.isArray(value) ? value.map((item) => oneLine(item, 120)) : oneLine(value, 300)
  }
  return out
}
