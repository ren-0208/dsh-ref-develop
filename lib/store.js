/**
 * File-backed memory store.
 *
 * Layout of one memory root (`<root>`):
 *
 *   AGENTS.md              human/agent entry point ("this is a memory root")
 *   memory.jsonl           canonical entries, one JSON object per line
 *   MEMORY/INDEX.md        generated overview of every entry
 *   MEMORY/PLAYBOOK.md     generated: methods + lessons
 *   MEMORY/KNOWLEDGE.md    generated: domain knowledge
 *   MEMORY/WP/INDEX.md     generated: problem reviews (CTF / coursework / any)
 *   MEMORY/SESSIONS.md     append-only session log (one line per session)
 *   MEMORY/PERSONA.md      generated: owner preferences (personalization)
 *   sessions/<id>.md       per-session notes used for consolidation
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { nowIso, oneLine, safeJsonParse, toText, uid } from './util.js'

export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function settingsFilePath(home = resolveDshHome()) {
  return path.join(home, 'growth-note', 'settings.json')
}

export function resolveRoot({ scope, cwd, home = resolveDshHome() }) {
  if (scope === 'workspace') {
    return path.join(cwd || process.cwd(), '.growth-note')
  }
  return path.join(home, 'growth-note', 'global')
}

const AGENTS_DOC = `# 记忆与成长（growth-note 自动维护）

这个目录由 DSH 插件 **growth-note** 生成，用于跨会话沉淀可复用的经验。
不要手工重写本文件；条目请通过对话中的 \`growth_*\` 工具增删（或直接编辑
MEMORY/*.md 后重新用 \`growth_consolidate\` 归档）。

## 怎么用

- 新会话开始时，插件会把本目录的摘要注入系统提示词，无需手动读取。
- 需要细节时调用 \`growth_recall\`（按关键词/类型检索条目）。
- 得到可复用的结论时调用 \`growth_remember\`（method / lesson / knowledge / wp / preference）。
- 记忆范围（全局共享或单工作区）由 \`growth_config\` 切换。

## 四类内容（对齐「记忆与成长方法」）

1. **状态**：项目现状、下一步（kind = state）
2. **否决清单**：试过什么、为什么失败，别再踩（kind = lesson）
3. **可复用套路**：方法、命令、工具链（kind = method）
4. **领域知识与复盘**：读书/新闻/论文/题目 WP（kind = knowledge / wp）

判断标准：另一个会话只看这个目录，能不能接着干而不必重新问人。
`

function head(list, count) {
  return list.slice(0, count)
}

export class GrowthStore {
  constructor(root) {
    this.root = root
    this.memoryDir = path.join(root, 'MEMORY')
    this.sessionsDir = path.join(root, 'sessions')
    this.entriesPath = path.join(root, 'memory.jsonl')
    this.chain = Promise.resolve()
  }

  /** Serialize every mutating operation so two turns cannot interleave writes. */
  #enqueue(operation) {
    const next = this.chain.then(operation, operation)
    this.chain = next.catch(() => {})
    return next
  }

  async ensure() {
    await fs.mkdir(this.memoryDir, { recursive: true })
    await fs.mkdir(path.join(this.memoryDir, 'WP'), { recursive: true })
    await fs.mkdir(this.sessionsDir, { recursive: true })
    const agents = path.join(this.root, 'AGENTS.md')
    try {
      await fs.access(agents)
    } catch {
      await fs.writeFile(agents, AGENTS_DOC, 'utf8')
    }
    try {
      await fs.access(this.entriesPath)
    } catch {
      await fs.writeFile(this.entriesPath, '', 'utf8')
    }
    return this
  }

  async entries() {
    let raw = ''
    try {
      raw = await fs.readFile(this.entriesPath, 'utf8')
    } catch {
      return []
    }
    const list = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const parsed = safeJsonParse(trimmed)
      if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') list.push(parsed)
    }
    return list
  }

  async #writeAll(entries) {
    const body = entries.map((entry) => JSON.stringify(entry)).join('\n')
    await fs.writeFile(this.entriesPath, body ? `${body}\n` : '', 'utf8')
  }

  async addEntry(input, { maxEntries = 3000 } = {}) {
    return this.#enqueue(async () => {
      const entries = await this.entries()
      const kind = toText(input.kind).trim() || 'knowledge'
      const title = oneLine(input.title, 160)
      const body = toText(input.body).trim()
      const tags = [...new Set((input.tags ?? []).map((tag) => toText(tag).trim()).filter(Boolean))].slice(0, 12)
      const duplicate = entries.find(
        (entry) => entry.kind === kind && oneLine(entry.title, 160).toLowerCase() === title.toLowerCase(),
      )
      if (duplicate) {
        duplicate.updatedAt = nowIso()
        duplicate.useCount = duplicate.useCount ?? 0
        if (body && !String(duplicate.body ?? '').includes(body)) {
          duplicate.body = `${toText(duplicate.body).trim()}\n\n${body}`.trim()
        }
        duplicate.tags = [...new Set([...(duplicate.tags ?? []), ...tags])].slice(0, 12)
        await this.#writeAll(entries)
        await this.render(entries)
        return { entry: duplicate, merged: true }
      }
      const entry = {
        id: uid(),
        kind,
        title,
        body,
        tags,
        source: input.source ?? null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        useCount: 0,
        lastUsedAt: null,
      }
      entries.push(entry)
      let kept = entries
      if (kept.length > maxEntries) {
        const pinned = kept.filter((item) => item.kind === 'preference')
        const rest = kept
          .filter((item) => item.kind !== 'preference')
          .sort((a, b) => Date.parse(a.createdAt ?? 0) - Date.parse(b.createdAt ?? 0))
        const room = Math.max(0, maxEntries - pinned.length)
        kept = [...pinned, ...rest.slice(Math.max(0, rest.length - room))].sort(
          (a, b) => Date.parse(a.createdAt ?? 0) - Date.parse(b.createdAt ?? 0),
        )
      }
      await this.#writeAll(kept)
      await this.render(kept)
      return { entry, merged: false }
    })
  }

  async touchEntry(ids) {
    if (!ids.length) return
    const wanted = new Set(ids)
    return this.#enqueue(async () => {
      const entries = await this.entries()
      let changed = false
      for (const entry of entries) {
        if (!wanted.has(entry.id)) continue
        entry.useCount = (entry.useCount ?? 0) + 1
        entry.lastUsedAt = nowIso()
        changed = true
      }
      if (changed) await this.#writeAll(entries)
    })
  }

  async removeEntry(id) {
    return this.#enqueue(async () => {
      const entries = await this.entries()
      const index = entries.findIndex((entry) => entry.id === id)
      if (index === -1) return null
      const [removed] = entries.splice(index, 1)
      await this.#writeAll(entries)
      await this.render(entries)
      return removed
    })
  }

  async appendSessionNote(sessionId, markdown) {
    return this.#enqueue(async () => {
      const file = path.join(this.sessionsDir, `${toText(sessionId).replace(/[^\w.-]/g, '_')}.md`)
      let isNew = false
      try {
        await fs.access(file)
      } catch {
        isNew = true
      }
      await fs.appendFile(file, markdown, 'utf8')
      if (isNew) {
        const line = `- ${nowIso().slice(0, 10)} · \`${sessionId}\` · ${oneLine(markdown.split('\n')[0].replace(/^#+\s*/, ''), 100)}\n`
        await fs.appendFile(path.join(this.memoryDir, 'SESSIONS.md'), line, 'utf8')
      }
    })
  }

  async readSessionNotes(sessionId, limit = 6) {
    const file = path.join(this.sessionsDir, `${toText(sessionId).replace(/[^\w.-]/g, '_')}.md`)
    let text = ''
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      return ''
    }
    const sections = text.split(/\n(?=## )/).filter(Boolean)
    return head(sections, limit).join('\n')
  }

  async sessionCount() {
    try {
      const files = await fs.readdir(this.sessionsDir)
      return files.filter((name) => name.endsWith('.md')).length
    } catch {
      return 0
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
    if (current !== content) await fs.writeFile(file, content, 'utf8')
  }

  async render(given) {
    const entries = given ?? (await this.entries())
    const updated = nowIso().slice(0, 19).replace('T', ' ')
    const byKind = (kind) =>
      entries
        .filter((entry) => entry.kind === kind)
        .sort((a, b) => Date.parse(b.updatedAt ?? 0) - Date.parse(a.updatedAt ?? 0))

    const counts = {}
    for (const entry of entries) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1

    const line = (entry) =>
      `- **${oneLine(entry.title, 120)}** \`${entry.id.slice(-6)}\` · ${oneLine(entry.body, 200)}${
        entry.tags?.length ? ` · \`${entry.tags.join('`,`')}\`` : ''
      }`

    await this.writeView(
      'INDEX.md',
      [
        '# 记忆总表',
        '',
        `> 由 growth-note 自动生成 · ${updated} · 共 ${entries.length} 条`,
        `> 方法 ${counts.method ?? 0} · 教训 ${counts.lesson ?? 0} · 知识 ${counts.knowledge ?? 0} · 复盘 ${counts.wp ?? 0} · 画像 ${counts.preference ?? 0} · 状态 ${counts.state ?? 0}`,
        '',
        '检索：`growth_recall(query)`；写入：`growth_remember(...)`。',
        '',
        '## 最近更新',
        '',
        ...head([...entries].sort((a, b) => Date.parse(b.updatedAt ?? 0) - Date.parse(a.updatedAt ?? 0)), 30).map(line),
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
        ...(byKind('knowledge').length ? byKind('knowledge').map(line) : ['_暂无_']),
        '',
      ].join('\n'),
    )

    await this.writeView(
      'WP/INDEX.md',
      [
        '# 题目复盘',
        '',
        '> 覆盖 CTF、课程题、专业题；一条复盘写清：题目 → 关键一步 → 弯路 → 可复用产物。',
        '',
        ...(byKind('wp').length ? byKind('wp').map(line) : ['_暂无_']),
        '',
      ].join('\n'),
    )

    await this.writeView(
      'PERSONA.md',
      [
        '# 主人画像（个性化匹配）',
        '',
        '> 仅在「个性化匹配」开启时注入提示词。只记录有证据的稳定偏好，不猜测。',
        '',
        ...(byKind('preference').length ? byKind('preference').map(line) : ['_暂无_']),
        '',
      ].join('\n'),
    )
  }
}
