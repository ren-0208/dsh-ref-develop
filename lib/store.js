/**
 * File-backed memory store (schema v2).
 *
 * Layout of one memory root (`<root>`):
 *
 *   AGENTS.md              entry point for humans/agents ("this is a memory root")
 *   store.json             {"version":2,"createdAt":...,"updatedAt":...}
 *   memory.jsonl           canonical entries, one JSON object per line
 *   vectors.jsonl          optional embedding index: one {id, sig, v} per line
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
import { decodeVector, encodeVector } from './embeddings.js'
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

const TOUCH_FLUSH_MS = 500

export class GrowthStore {
  constructor(root, options = {}) {
    this.root = root
    this.halfLifeDays = options.halfLifeDays ?? 30
    this.maxEntries = options.maxEntries ?? 3000
    this.maxNoteTurns = options.maxNoteTurns ?? 200
    this.archiveRetentionDays = options.archiveRetentionDays ?? 30
    this.maxArchivedEntries = options.maxArchivedEntries ?? 300
    this.memoryDir = path.join(root, 'MEMORY')
    this.sessionsDir = path.join(root, 'sessions')
    this.entriesPath = path.join(root, 'memory.jsonl')
    this.metaPath = path.join(root, 'store.json')
    this.vectorsPath = path.join(root, 'vectors.jsonl')
    this.stateDir = path.join(root, 'state')
    this.chain = Promise.resolve()
    this.cache = null
    this.vectorCache = null
    this.vectorRows = null
    this.ensured = false
  }

  #enqueue(operation) {
    const next = this.chain.then(operation, operation)
    this.chain = next.catch(() => {})
    return next
  }

  configure({ halfLifeDays, maxEntries, maxNoteTurns, archiveRetentionDays, maxArchivedEntries } = {}) {
    if (Number.isFinite(halfLifeDays)) this.halfLifeDays = halfLifeDays
    if (Number.isFinite(maxEntries)) this.maxEntries = maxEntries
    if (Number.isFinite(maxNoteTurns)) this.maxNoteTurns = maxNoteTurns
    if (Number.isFinite(archiveRetentionDays)) this.archiveRetentionDays = archiveRetentionDays
    if (Number.isFinite(maxArchivedEntries)) this.maxArchivedEntries = maxArchivedEntries
  }

  async ensure() {
    if (this.ensured) {
      await this.load()
      return this
    }
    await fs.mkdir(this.memoryDir, { recursive: true })
    await fs.mkdir(path.join(this.memoryDir, 'WP'), { recursive: true })
    await fs.mkdir(this.sessionsDir, { recursive: true })
    await fs.mkdir(this.stateDir, { recursive: true })
    await this.#writeIfMissing(path.join(this.root, 'AGENTS.md'), AGENTS_DOC)
    await this.#writeIfMissing(this.entriesPath, '')
    await this.#writeIfMissing(this.vectorsPath, '')
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
    // Counters applied by `touchEntry` live only in memory until they are
    // flushed. A forced re-read would silently roll them back, so carry them
    // across the reload.
    const pending = this.touchesPending
      ? new Map(this.cache.map((entry) => [entry.id, { useCount: entry.useCount, lastUsedAt: entry.lastUsedAt }]))
      : null
    let raw = ''
    try {
      raw = await fs.readFile(this.entriesPath, 'utf8')
    } catch {
      raw = ''
    }
    const now = nowIso()
    const entries = parseJsonl(raw).map((item) => normalizeEntry(item, { now }))
    if (pending) {
      for (const entry of entries) {
        const kept = pending.get(entry.id)
        if (!kept) continue
        entry.useCount = Math.max(entry.useCount ?? 0, kept.useCount ?? 0)
        entry.lastUsedAt = kept.lastUsedAt ?? entry.lastUsedAt
      }
    }
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

  // ---- optional vector index --------------------------------------------
  //
  // Vectors live next to (not inside) memory.jsonl so deleting the index never
  // touches a memory claim. A missing or empty file simply means "lexical only".

  async loadVectors({ force = false } = {}) {
    if (this.vectorCache && !force) return this.vectorCache
    let raw = ''
    try {
      raw = await fs.readFile(this.vectorsPath, 'utf8')
    } catch {
      raw = ''
    }
    const map = new Map()
    let rows = 0
    for (const record of parseJsonl(raw)) {
      if (!record?.id || typeof record.v !== 'string') continue
      const vec = decodeVector(record.v)
      if (vec.length) {
        map.set(record.id, { sig: String(record.sig ?? ''), vec })
        rows += 1
      }
    }
    this.vectorCache = map
    this.vectorRows = rows
    return map
  }

  vectorsSync() {
    return this.vectorCache ?? new Map()
  }

  async upsertVectors(items) {
    const list = (Array.isArray(items) ? items : []).filter(
      (item) => item?.id && Array.isArray(item.vec) && item.vec.length,
    )
    if (!list.length) return { total: this.vectorsSync().size }
    return this.#enqueue(async () => {
      const map = await this.loadVectors()
      // Append the new vectors instead of rewriting the whole index.
      //
      // The old path serialised and rewrote every vector on each call, and the
      // backfill feeds it 16 rows at a time: filling a 3000-entry index meant
      // ~188 full rewrites of a ~24 MB file (~19x write amplification measured).
      // Duplicate ids are harmless because `loadVectors` is last-wins, and a
      // compaction drops the stale copies from time to time.
      const known = new Set((await this.load()).map((entry) => entry.id))
      const lines = []
      for (const item of list) {
        // An append cannot later drop a row, so an id with no memory row must be
        // refused here rather than cleaned up on the next compaction.
        if (!known.has(item.id)) continue
        map.set(item.id, { sig: String(item.sig ?? ''), vec: item.vec })
        lines.push({ id: item.id, sig: String(item.sig ?? ''), v: encodeVector(item.vec) })
      }
      if (!lines.length) return { total: map.size }
      await withFileLock(this.vectorsPath, () => fs.appendFile(this.vectorsPath, stringifyJsonl(lines), 'utf8'))
      this.vectorCache = map
      this.vectorRows = (this.vectorRows ?? 0) + lines.length
      await this.#compactVectorsIfNeeded(map)
      return { total: map.size }
    })
  }

  /**
   * Rewrite the index once the append log has grown well past the live set.
   * Amortised: the rewrite cost is spread over many appends instead of paid on
   * every one.
   */
  async #compactVectorsIfNeeded(map) {
    const live = map.size
    const limit = Math.max(512, live * 2)
    if ((this.vectorRows ?? 0) <= limit) return
    await this.#writeVectorsAtomically(map)
  }

  /** Full, deduplicated rewrite of vectors.jsonl. */
  async #writeVectorsAtomically(map) {
    const entries = await this.load()
    const known = new Set(entries.map((entry) => entry.id))
    const lines = []
    for (const [id, record] of [...map]) {
      // An id with no memory row is dead weight in the index: drop it from both
      // the file and the in-memory map so vectorStats cannot over-report.
      if (known.size && !known.has(id)) {
        map.delete(id)
        continue
      }
      if (!record?.vec?.length) continue
      lines.push({ id, sig: record.sig ?? '', v: encodeVector(record.vec) })
    }
    await withFileLock(this.vectorsPath, () => writeFileAtomic(this.vectorsPath, stringifyJsonl(lines)))
    this.vectorRows = lines.length
    this.vectorCache = map
  }

  async dropVectors(ids) {
    const wanted = new Set(Array.isArray(ids) ? ids : [])
    if (!wanted.size) return
    return this.#enqueue(async () => this.#dropVectorsLocked(wanted))
  }

  async clearVectors() {
    return this.#enqueue(async () => {
      this.vectorCache = new Map()
      this.vectorRows = 0
      await withFileLock(this.vectorsPath, () => writeFileAtomic(this.vectorsPath, ''))
    })
  }

  async vectorStats() {
    const map = await this.loadVectors()
    const active = (await this.load()).filter((entry) => entry.status === 'active')
    const covered = active.filter((entry) => map.has(entry.id)).length
    const signatures = new Set([...map.values()].map((record) => record.sig).filter(Boolean))
    return { total: map.size, covered, active: active.length, signatures: [...signatures] }
  }

  /**
   * Whether every active entry already has a vector under `signature`.
   * Synchronous on purpose: it gates a per-turn backfill and must not add IO.
   */
  vectorsComplete(signature) {
    if (!signature || !this.vectorCache || !this.cache) return false
    for (const entry of this.cache) {
      if (entry.status !== 'active') continue
      const record = this.vectorCache.get(entry.id)
      if (!record || record.sig !== signature) return false
    }
    return true
  }

  /** Remove vectors without re-entering the store queue (callers already hold it). */
  async #dropVectorsLocked(ids) {
    try {
      const map = await this.loadVectors()
      let changed = false
      for (const id of ids) if (map.delete(id)) changed = true
      // Dropping is a rewrite, not an append: the rows on disk must go away so an
      // edited entry cannot be scored against a stale vector.
      if (changed) await this.#writeVectorsAtomically(map)
    } catch {
      // index maintenance must never break a memory write
    }
  }

  async #saveVectors(map) {
    await this.#writeVectorsAtomically(map)
  }

  /**
   * Persist entries and refresh views.
   *
   * `render: false` for writes that cannot change any view (`touchEntry` only
   * bumps useCount/lastUsedAt, which no view renders). Redrawing five Markdown
   * files on every recall hit was pure waste: a recall is a read operation.
   */
  async #save(entries, { render = true } = {}) {
    const now = nowIso()
    // Any write clears the pending-counter flag: this snapshot includes whatever
    // `touchEntry` already applied in memory.
    this.touchesPending = false
    const before = new Set((this.cache ?? []).map((entry) => entry.id))
    const kept = this.#prune(entries)
    const keptIds = new Set(kept.map((entry) => entry.id))
    // Entries pruned away to honour maxEntries / archive caps must take their
    // vectors with them. Otherwise the index accumulates orphans that recall skips
    // but every load still decodes and every projection still counts.
    const evicted = [...before].filter((id) => !keptIds.has(id))
    await withFileLock(this.entriesPath, async () => {
      await writeFileAtomic(this.entriesPath, stringifyJsonl(kept))
    })
    this.cache = kept
    await writeJsonAtomic(this.metaPath, { version: SCHEMA_VERSION, createdAt: (await readJson(this.metaPath, null))?.createdAt ?? now, updatedAt: now })
    if (evicted.length) await this.#dropVectorsLocked(evicted)
    if (render) await this.render()
    return kept
  }

  #prune(entries) {
    const active = entries.filter((entry) => entry.status === 'active')
    const archived = entries.filter((entry) => entry.status !== 'active')
    // Archived rows are soft deletes and superseded claims: they exist so the
    // action is reversible, not so they live forever. The old 120-day window let
    // a write-once/soft-delete-often workload turn memory.jsonl into mostly
    // tombstones, and every addEntry re-reads the whole file.
    const keepArchivedDays = this.archiveRetentionDays
    let kept = archived
      .filter((entry) => {
        const ageDays = (Date.now() - (Date.parse(entry.updatedAt ?? 0) || 0)) / 86_400_000
        return ageDays < keepArchivedDays
      })
      .sort((a, b) => Date.parse(b.updatedAt ?? 0) - Date.parse(a.updatedAt ?? 0))
    if (kept.length > this.maxArchivedEntries) kept = kept.slice(0, this.maxArchivedEntries)
    const live = [...active, ...kept]
    // Active entries are within budget: both caps apply independently, so there is
    // nothing to evict and no sorting to do.
    if (active.length <= this.maxEntries) return live
    const pinned = active.filter((entry) => entry.kind === 'preference' || entry.kind === 'state')
    const rest = active
      .filter((entry) => entry.kind !== 'preference' && entry.kind !== 'state')
      .sort((a, b) => strengthOf(b, { halfLifeDays: this.halfLifeDays }) - strengthOf(a, { halfLifeDays: this.halfLifeDays }))
    const room = Math.max(0, this.maxEntries - pinned.length)
    return [...pinned, ...rest.slice(0, room), ...kept]
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
      // A freshly extracted claim has been stated once. `normalizeEntry` seeds the
      // counter from the evidence array, which is only a proxy for imports; the
      // live path counts the actual occurrence.
      candidate.corroborations = Math.max(1, candidate.corroborations)
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
        await this.#dropVectorsLocked([target.id])
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
      await this.#dropVectorsLocked([candidate.id, ...(promoted ? [promoted.id] : [])])
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
      await this.#dropVectorsLocked([entry.id])
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
        await this.#dropVectorsLocked([removed.id])
        return removed
      }
      await this.#save(entries)
      await this.#dropVectorsLocked([removed.id])
      return removed
    })
  }

  /**
   * Record that entries were recalled.
   *
   * Applied to the in-memory snapshot immediately and flushed later, because a
   * recall is a read: rewriting a multi-megabyte memory.jsonl (and re-reading it
   * with `force`) once per query made every lookup a write. The counters are not
   * authoritative — they only feed the strength score, and losing a few increments
   * to a crash costs nothing.
   */
  async touchEntry(ids) {
    if (!ids?.length) return
    const entries = await this.load()
    const seen = new Set()
    const now = nowIso()
    for (const entry of entries) {
      if (!ids.includes(entry.id) || seen.has(entry.id)) continue
      seen.add(entry.id)
      entry.useCount = (entry.useCount ?? 0) + 1
      entry.lastUsedAt = now
    }
    this.touchesPending = true
    if (this.touchFlushTimer) return
    // Coalesce bursts (a single turn can recall several times) into one write.
    this.touchFlushTimer = setTimeout(() => {
      this.touchFlushTimer = null
      void this.flushTouches().catch(() => {})
    }, TOUCH_FLUSH_MS)
    if (typeof this.touchFlushTimer?.unref === 'function') this.touchFlushTimer.unref()
  }

  /** Persist counters accumulated by `touchEntry`. Also run before any other save. */
  async flushTouches() {
    if (!this.touchesPending) return false
    return this.#enqueue(async () => {
      if (!this.touchesPending) return false
      this.touchesPending = false
      // The in-memory snapshot already carries the increments; write it as-is
      // instead of re-reading, which would discard them.
      await this.#save(this.cache ?? [], { render: false })
      return true
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
      await this.#rotateSessionNotes(file, sessionId)
    })
  }

  /**
   * Keep one session's note file bounded.
   *
   * Notes were append-only and unbounded: a long-running session grew the file
   * without limit, and every consolidation re-read all of it. Only the newest
   * `maxNoteTurns` turns can ever be distilled, so the rest is dead weight.
   */
  async #rotateSessionNotes(file, sessionId) {
    const max = this.maxNoteTurns
    if (!(max > 0)) return
    let text = ''
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      return
    }
    const header = `# 会话 ${sessionId}\n\n`
    const body = text.startsWith(header) ? text.slice(header.length) : text
    const sections = body.split(/\n(?=## )/).filter(Boolean)
    // Rotate a little above the cap so this rewrite is amortised, not per-turn.
    if (sections.length <= max + Math.max(8, Math.ceil(max / 4))) return
    await writeFileAtomic(file, `${header}${sections.slice(-max).join('\n')}\n`)
  }

  /**
   * The most recent `limit` turn notes.
   *
   * Reads backwards from the end of the file instead of slurping it whole: the
   * file is bounded by rotation, but a session can still carry tens of thousands
   * of characters, and this runs on every consolidation.
   */
  async readSessionNotes(sessionId, limit = 6) {
    const file = fileForSession(this.sessionsDir, sessionId)
    let handle = null
    try {
      handle = await fs.open(file, 'r')
    } catch {
      return ''
    }
    try {
      const { size } = await handle.stat()
      if (!size) return ''
      const chunkSize = 16 * 1024
      const wanted = Math.max(1, Math.trunc(limit))
      let position = size
      let buffer = ''
      // Grow the tail window until it holds `wanted` section starts (or we hit
      // the head of the file), so a normal-sized session is still one read.
      for (;;) {
        const length = Math.min(chunkSize, position)
        position -= length
        const chunk = Buffer.allocUnsafe(length)
        const { bytesRead } = await handle.read(chunk, 0, length, position)
        buffer = chunk.subarray(0, bytesRead).toString('utf8') + buffer
        const starts = buffer.match(/\n(?=## )/g)?.length ?? 0
        if (position === 0 || starts >= wanted) break
      }
      const sections = buffer.split(/\n(?=## )/).filter(Boolean)
      return sections.slice(-wanted).join('\n')
    } catch {
      return ''
    } finally {
      await handle.close().catch(() => {})
    }
  }

  // ---- consolidation cursor --------------------------------------------
  //
  // `turn % consolidateEveryTurns === 0` drops a turn for good whenever that one
  // turn-stopping never fires (interrupt, crash, agent switch), because the next
  // run only looks at the newest N notes. A per-session cursor records what was
  // actually distilled, so a missed turn is picked up by the next run instead.

  #statePath(sessionId) {
    return path.join(this.stateDir, `${toText(sessionId).replace(/[^\w.-]/g, '_')}.json`)
  }

  async readConsolidationCursor(sessionId) {
    const state = await readJson(this.#statePath(sessionId), null)
    const turn = Number(state?.lastConsolidatedTurn)
    return Number.isFinite(turn) ? turn : null
  }

  async writeConsolidationCursor(sessionId, turn) {
    const value = Number(turn)
    if (!Number.isFinite(value)) return
    const file = this.#statePath(sessionId)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const previous = await readJson(file, null)
    await writeJsonAtomic(file, { ...(previous ?? {}), lastConsolidatedTurn: value, updatedAt: nowIso() })
  }

  /**
   * Notes for the pending turns, oldest first.
   *
   * Returns `{ text, throughTurn }` rather than a bare string: the caller must
   * advance the cursor to the last turn actually distilled. Writing the *current*
   * turn instead skips everything between the batch and now — with a backlog the
   * cursor would jump past turns that were never distilled.
   *
   * A backlog has to be drained in order (see `consolidateEveryTurns`), so this
   * takes the oldest pending turns, not the newest.
   */
  async readPendingNotes(sessionId, limit = 6) {
    const cursor = await this.readConsolidationCursor(sessionId)
    const wanted = Math.max(1, Math.trunc(limit))
    // No cursor yet: the first run of a session starts from the beginning, so the
    // backlog is drained in order from turn 1. Seeding from the tail instead would
    // advance the cursor past turns that were never distilled.
    const from = cursor === null ? Number.NEGATIVE_INFINITY : cursor + 1
    const fresh = await this.#readNotesFrom(sessionId, from)
    const sections = fresh.split(/\n(?=## )/).filter(Boolean)
    // Nothing pending (the backlog is fully drained): report empty rather than
    // re-sending already-distilled notes and re-advancing the cursor to them.
    if (!sections.length) return { text: '', throughTurn: null }
    return this.#asBatch(sections.slice(0, wanted).join('\n'))
  }

  #asBatch(text) {
    const turns = [...String(text ?? '').matchAll(/## turn (\d+)/g)].map((match) => Number(match[1]))
    return { text: text ?? '', throughTurn: turns.length ? Math.max(...turns) : null }
  }

  /** Every note section whose `## turn N` header is at or above `fromTurn`. */
  async #readNotesFrom(sessionId, fromTurn) {
    let text = ''
    try {
      text = await fs.readFile(fileForSession(this.sessionsDir, sessionId), 'utf8')
    } catch {
      return ''
    }
    const sections = text.split(/\n(?=## )/).filter(Boolean)
    return sections
      .filter((section) => {
        const turn = Number(/## turn (\d+)/.exec(section)?.[1])
        return Number.isFinite(turn) && turn >= fromTurn
      })
      .join('\n')
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
