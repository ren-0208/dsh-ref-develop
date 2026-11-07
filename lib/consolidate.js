/**
 * End-of-turn consolidation.
 *
 * Two layers, cheapest first:
 *   1. always-available session note: what was asked, what was done, which
 *      tools were used — plain text, no model call, survives without an LLM;
 *   2. optional model distillation: every `consolidateEveryTurns` turns, ask
 *      the session's own model to turn the recent notes into structured
 *      memory entries (methods / lessons / knowledge / problem reviews).
 *
 * Layer 2 is best-effort: any failure leaves layer 1 in place.
 */
import { boundText, messageText, oneLine } from './util.js'

const MAX_NOTE_CHARS = 6000
const MAX_PROMPT_CHARS = 12000

function eventsOfTurn(events, turn) {
  return events.filter((event) => {
    const data = event?.data
    return data && typeof data === 'object' && data.turn === turn
  })
}

export function buildSessionNote({ sessionId, turn, events, cwd }) {
  const users = []
  const assistants = []
  const tools = []
  for (const event of events) {
    if (event.type === 'user/message') {
      const text = messageText(event.data)
      if (text) users.push(text)
    } else if (event.type === 'assistant/message') {
      const text = messageText(event.data?.message ?? event.data)
      if (text) assistants.push(text)
    } else if (event.type === 'tool/call') {
      const name = event.data?.name ?? 'tool'
      const args = oneLine(event.data?.arguments ?? '', 120)
      tools.push(args ? `${name}(${args})` : name)
    }
  }
  if (!users.length && !assistants.length) return ''

  const lines = [`## turn ${turn} · ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`, '']
  if (cwd) lines.push(`- 工作区：\`${cwd}\``, '')
  lines.push('### 诉求', '', boundText(users.join('\n\n') || '（无文本诉求）', 1800), '')
  lines.push('### 结论/动作', '', boundText(assistants.join('\n\n') || '（无文本回复）', 2600), '')
  if (tools.length) {
    lines.push('### 工具', '', ...tools.slice(0, 40).map((item) => `- ${item}`), '')
  }
  return boundText(lines.join('\n'), MAX_NOTE_CHARS)
}

function extractJsonArray(text) {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

const DISTILL_SYSTEM = `你是会话记忆整理器。输入是若干个会话回合的原始笔记。请提炼出**跨会话仍然有用**的知识，输出 JSON 数组，不要输出任何其它文字。
每个元素形如 {"kind":"method|lesson|knowledge|wp|preference|state","title":"...","body":"...","tags":["..."]}
规则：
- method：可复用的操作套路/命令/工具链；lesson：试过且失败的做法以及失败原因（否决清单）；knowledge：读书、新闻、论文、课程里得到的领域知识；wp：任何学科题目的复盘（CTF、课程题、专业题），写清 题目→关键一步→弯路→可复用产物；preference：主人表现出的稳定偏好（沟通方式、格式、关注点），只在有明确证据时写；state：项目当前状态与下一步。
- 只写输入中有证据的内容，不要编造，不要写"本次会话做了X"这类一次性流水。
- title ≤ 40 字并可被关键词检索；body ≤ 400 字，写清适用场景与结论。
- 最多 6 条；如果本批笔记没有可跨会话复用的内容，输出 []`

export async function distillWithModel({ llm, selection, notes, locale }) {
  if (!llm || !selection?.provider || !selection?.model) return null
  const prompt = `以下是最近的会话笔记，请提炼记忆条目：\n\n${boundText(notes, MAX_PROMPT_CHARS)}`
  const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  const chunks = llm.stream({
    provider: selection.provider,
    model: selection.model,
    system: locale === 'en' ? `${DISTILL_SYSTEM}\nWrite titles and bodies in English.` : DISTILL_SYSTEM,
    messages,
    temperature: 0.2,
    maxTokens: 1600,
    purpose: 'growth-note',
  })
  let text = ''
  for await (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'error' || chunk.type === 'aborted') return null
  }
  const list = extractJsonArray(text)
  if (!list) return null
  return list
    .filter((item) => item && typeof item.title === 'string' && typeof item.body === 'string')
    .slice(0, 6)
    .map((item) => ({
      kind: typeof item.kind === 'string' ? item.kind : 'knowledge',
      title: oneLine(item.title, 120),
      body: boundText(item.body, 1200),
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 8).map(String) : [],
    }))
}

export class Consolidator {
  constructor(runtime) {
    this.runtime = runtime
    this.lastTurn = new Map()
    this.inFlight = new Set()
  }

  async run({ agent, turn }) {
    const sessionId = agent?.id
    if (!sessionId) return
    const config = this.runtime.getConfig()
    if (!config.autoCapture) return
    const key = `${sessionId}:${turn}`
    if (this.inFlight.has(key)) return
    this.inFlight.add(key)
    try {
      const store = await this.runtime.storeFor({ agent })
      const events = await this.runtime.readEvents(sessionId)
      if (!events.length) return
      const from = (this.lastTurn.get(sessionId) ?? turn - 1) + 1
      const notes = []
      for (let index = from; index <= turn; index += 1) {
        const note = buildSessionNote({
          sessionId,
          turn: index,
          events: eventsOfTurn(events, index),
          cwd: this.runtime.cwdSync(),
        })
        if (note) notes.push(note)
      }
      if (!notes.length) return
      this.lastTurn.set(sessionId, turn)
      await store.appendSessionNote(sessionId, notes.join('\n'))
      if (!config.autoSummarize) return
      if (turn % config.consolidateEveryTurns !== 0) return
      const recent = await store.readSessionNotes(sessionId, config.sessionNotesPerConsolidation)
      if (!recent.trim()) return
      const selection = this.runtime.currentSelection()
      const distilled = await distillWithModel({
        llm: this.runtime.llm(),
        selection,
        notes: recent,
        locale: config.locale,
      })
      if (!distilled?.length) return
      for (const item of distilled) {
        await store.addEntry({ ...item, source: `session:${sessionId}` }, { maxEntries: config.maxEntries })
      }
      this.runtime.markDirty?.()
    } catch (error) {
      this.runtime.logger?.warn?.(`consolidation failed: ${error?.message ?? error}`)
    } finally {
      this.inFlight.delete(key)
    }
  }
}
