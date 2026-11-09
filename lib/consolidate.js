/**
 * Consolidation: turn transcript -> session note -> evidence-backed entries.
 *
 * The model is never asked to "remember everything". It is asked for a small
 * set of claims, each carrying a verbatim quotation from the transcript. A
 * claim whose quotation cannot be found back is kept, but flagged unverified
 * and its confidence is halved.
 */
import { normalizeEntry } from './entry.js'
import { messageText, oneLine, toText } from './util.js'

const NOTE_LIMIT = 6000
const MAX_ITEMS = 8

export function buildSessionNote({ sessionId, turn, events, cwd }) {
  const lines = [`## turn ${turn}`, '']
  const userLines = []
  const assistantLines = []
  const toolLines = []
  for (const event of events ?? []) {
    const type = event?.type
    const data = event?.data ?? {}
    if (type === 'user/message') {
      const text = oneLine(messageText(data), 400)
      if (text) userLines.push(`- 用户：${text}`)
    } else if (type === 'assistant/message') {
      const text = oneLine(messageText(data.message ?? data), 400)
      if (text) assistantLines.push(`- 助手：${text}`)
    } else if (type === 'tool/call') {
      const args = oneLine(data.arguments, 200)
      toolLines.push(`- 工具 ${data.name}(${args})`)
    } else if (type === 'tool/result' && data.error) {
      const error = oneLine(typeof data.error === 'string' ? data.error : data.error.message ?? JSON.stringify(data.error), 200)
      toolLines.push(`  ✗ 失败：${error}`)
    }
  }
  if (userLines.length) lines.push('### 诉求', ...userLines.slice(-3), '')
  if (assistantLines.length) lines.push('### 结论 / 动作', ...assistantLines.slice(-6), '')
  if (toolLines.length) lines.push('### 工具', ...toolLines.slice(-12), '')
  if (cwd) lines.push(`_cwd: ${cwd}_`, '')
  const text = lines.join('\n')
  return text.length > NOTE_LIMIT ? `${text.slice(0, NOTE_LIMIT)}\n…` : text
}

export function buildDistillPrompt(notes, { personalization = false } = {}) {
  const kinds = [
    'method —— 可复用的做法/命令/排查路径（写清楚什么时候用）',
    'lesson —— 试过且失败的坑（现象、原因、正确做法）',
    'knowledge —— 读书/新闻/论文/课程得到的可复用结论（写适用边界）',
    'wp —— 题目复盘：CTF、课程题、任何学科的解题思路（关键一步 + 弯路）',
    'state —— 项目现状与下一步（只写仍然成立的）',
  ]
  if (personalization) kinds.push('preference —— 用户稳定的偏好（只写有明确证据的，不猜测、不写敏感信息）')
  return [
    '你是记忆整理器。阅读下面的会话记录，提炼最多 8 条**可复用**的记忆。',
    '',
    '允许的类型：',
    ...kinds.map((line) => `- ${line}`),
    '',
    '规则：',
    '1. 只写记录里确实出现过的内容；不要补充常识、不要推测。',
    '2. 每条必须有 evidence：从记录里**原样复制**一段 10–80 字的句子作为依据。',
    '3. 同一件事只写一条；闲聊、寒暄、临时的中间状态不要写。',
    '4. confidence 取 0.3–0.95：多次出现/有验证的更高。',
    '5. 输出严格 JSON 数组，不要解释，不要 Markdown 代码块。',
    '',
    '每一项的字段：',
    '{"kind":"method|lesson|knowledge|wp|state' + (personalization ? '|preference' : '') + '","title":"不超过 40 字","body":"2–5 行，可执行的描述","tags":["最多4个"],"confidence":0.6,"evidence":[{"quote":"原样引用"}],"meta":{}}',
    '',
    'meta 按类型可选：',
    '- method: {"appliesTo":["场景"],"steps":["步骤"]}',
    '- lesson: {"trigger":"什么情况下会踩","mistake":"错在哪","fix":"正确做法","verify":"怎么验证"}',
    '- knowledge: {"subject":"学科/领域","topic":"主题","refs":["出处"]}',
    '- wp: {"platform":"CTF/LeetCode/课程/…","category":"方向","difficulty":"难度","keyIdea":"关键一步"}',
    '- state: {"project":"项目","status":"现状","next":"下一步"}',
    '- preference: {"aspect":"偏好维度","value":"偏好值"}',
    '',
    '会话记录：',
    notes,
  ].join('\n')
}

export function extractJsonArray(text) {
  const raw = toText(text).trim()
  if (!raw) return []
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function normalizeForMatch(text) {
  return toText(text).replace(/\s+/g, '')
}

/**
 * Flatten raw session events into one searchable string for evidence checks.
 *
 * Not truncated on purpose: this is the source of truth a quote was lifted
 * from. Only the fields that can carry user-visible text are walked, so tool
 * payloads (the bulk of a transcript) don't bloat the haystack.
 */
export function eventsText(events) {
  const parts = []
  for (const event of Array.isArray(events) ? events : []) {
    const data = event?.data ?? {}
    const type = event?.type
    if (type === 'user/message' || type === 'assistant/message') {
      const text = messageText(data.message ?? data)
      if (text) parts.push(text)
    } else if (type === 'tool/result') {
      const error = data.error
      if (typeof error === 'string') parts.push(error)
      else if (error?.message) parts.push(toText(error.message))
      const text = messageText(data.message ?? data)
      if (text) parts.push(text)
    }
  }
  return parts.join('\n')
}

/**
 * Turn raw model output into storable candidates. Items without a verifiable
 * quotation survive as low-confidence drafts (the user can edit or forget
 * them), but they are marked `verified: false`.
 */
export function validateItems(items, transcript, { personalization = false, max = MAX_ITEMS } = {}) {
  const haystack = normalizeForMatch(transcript)
  const out = []
  for (const item of Array.isArray(items) ? items : []) {
    const kind = String(item?.kind ?? '').trim()
    if (kind === 'preference' && !personalization) continue
    const title = oneLine(item?.title, 160)
    if (!title) continue
    const evidence = []
    let verified = false
    for (const candidate of Array.isArray(item?.evidence) ? item.evidence : []) {
      const quote = oneLine(candidate?.quote ?? candidate, 120)
      if (!quote) continue
      const hit = haystack.includes(normalizeForMatch(quote))
      evidence.push({ quote, verified: hit })
      if (hit) verified = true
    }
    const confidence = Math.min(0.95, Math.max(0.1, Number(item?.confidence ?? 0.6)))
    const entry = normalizeEntry({
      kind: ['method', 'lesson', 'knowledge', 'wp', 'state', 'preference'].includes(kind) ? kind : 'knowledge',
      title,
      body: toText(item?.body).trim(),
      tags: item?.tags,
      confidence: verified ? confidence : confidence * 0.5,
      verified,
      meta: item?.meta,
      evidence: evidence.map(({ quote, verified: hit }) => ({ quote, verified: hit })),
    })
    if (!entry.body && !evidence.length) continue
    out.push(entry)
    if (out.length >= max) break
  }
  return out
}

export function buildDistillSystem(locale = 'zh') {
  return locale === 'en'
    ? 'You are a memory editor. Extract reusable claims with verbatim evidence. Reply with a JSON array only.'
    : '你是记忆整理器，只输出 JSON 数组。不要解释，不要代码块，不要编造。'
}

/** Stream the model once and return its text. */
export async function distillWithModel({ llm, selection, notes, locale = 'zh' }) {
  const chunks = []
  for await (const chunk of llm.stream({
    provider: selection.provider,
    model: selection.model,
    system: buildDistillSystem(locale),
    messages: [{ role: 'user', content: [{ type: 'text', text: buildDistillPrompt(notes, { personalization: selection.personalization }) }] }],
    temperature: 0.2,
    maxTokens: 1800,
    purpose: 'growth-note',
  })) {
    if (chunk?.type === 'text-delta') chunks.push(chunk.text)
    else if (chunk?.type === 'error') throw new Error(String(chunk.error?.message ?? chunk.error ?? 'llm stream failed'))
  }
  return chunks.join('')
}

export class Consolidator {
  constructor(runtime) {
    this.runtime = runtime
    this.inFlight = new Set()
    this.lastTurn = new Map()
  }

  /** @returns {Promise<{note:string, stored:number, merged:number, promoted:number, reason?:string}>} */
  async run({ agent, turn, events, force = false }) {
    if (this.runtime.getConfig().scope === 'off') return { note: '', stored: 0, merged: 0, promoted: 0, reason: 'off' }
    const key = `${agent.id}:${turn ?? 'x'}`
    if (!force && this.lastTurn.get(agent.id) === turn) return { note: '', stored: 0, merged: 0, promoted: 0, reason: 'duplicate' }
    if (this.inFlight.has(key)) return { note: '', stored: 0, merged: 0, promoted: 0, reason: 'in-flight' }
    this.inFlight.add(key)
    try {
      const config = this.runtime.getConfig()
      const store = await this.runtime.storeForAgent(agent)
      if (!store) return { note: '', stored: 0, merged: 0, promoted: 0, reason: 'no-store' }
      const cwd = await this.runtime.cwdFor(agent)
      const transcript = (events ?? []).length ? events : await this.runtime.readTurnEvents(agent, turn)
      const note = buildSessionNote({ sessionId: agent.id, turn, events: transcript, cwd })
      if (config.autoCapture) await store.appendSessionNote(agent.id, `${note}\n`, { turn })
      this.lastTurn.set(agent.id, turn)

      const shouldDistill = force || (config.autoSummarize && Number(turn) > 0 && Number(turn) % config.consolidateEveryTurns === 0)
      if (!shouldDistill) return { note, stored: 0, merged: 0, promoted: 0, reason: 'not-yet' }

      const llm = this.runtime.llm()
      const selection = this.runtime.currentSelection()
      if (!llm || !selection?.provider || !selection?.model) {
        return { note, stored: 0, merged: 0, promoted: 0, reason: 'no-model' }
      }
      const notes = await store.readSessionNotes(agent.id, config.sessionNotesPerConsolidation)
      const text = await distillWithModel({
        llm,
        selection: { ...selection, personalization: config.personalization },
        notes: notes || note,
        locale: config.locale,
      })
      // Evidence is checked against the *raw* events, never against the notes.
      // Notes are lossy (400-char windows, last-N lines, 6000-char cap), so a
      // model faithfully quoting the transcript it actually saw would be marked
      // unverified — and have its confidence halved — for a quote the note
      // summariser had already trimmed away.
      const haystack = eventsText(transcript)
      const items = validateItems(extractJsonArray(text), haystack, { personalization: config.personalization })
      let stored = 0
      let merged = 0
      let promoted = 0
      for (const item of items) {
        const result = await store.addEntry(item, {
          maxEntries: config.maxEntries,
          dedupeThreshold: config.dedupeThreshold,
          promoteLessonAfter: config.promoteLessonAfter,
        })
        if (result.merged) merged += 1
        else stored += 1
        if (result.promoted) promoted += 1
      }
      this.runtime.markDirty()
      return { note, stored, merged, promoted, candidates: items.length }
    } catch (error) {
      this.runtime.logger?.warn?.(`consolidation failed: ${String(error?.message ?? error)}`)
      return { note: '', stored: 0, merged: 0, promoted: 0, reason: 'error', error: String(error?.message ?? error) }
    } finally {
      this.inFlight.delete(key)
    }
  }
}
