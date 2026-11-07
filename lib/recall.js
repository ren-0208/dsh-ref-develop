/**
 * Relevance selection for prompt injection (P2).
 *
 * The prompt is assembled synchronously, so selection works off the store's
 * in-memory snapshot. Ranking combines lexical overlap with the decayed
 * strength of an entry: a fresh, often-used memory about this exact question
 * wins over an old, unrelated one.
 */
import { KIND_LABEL, strengthOf } from './entry.js'
import { scoreEntry, tokenize } from './util.js'

export const KIND_ORDER = ['state', 'preference', 'method', 'lesson', 'wp', 'knowledge']

const QUOTA = { state: 3, preference: 4, method: 5, lesson: 5, wp: 4, knowledge: 4 }

export function tokensFromMessages(messages) {
  const parts = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role && message.role !== 'user') continue
    const content = message?.content
    if (typeof content === 'string') parts.push(content)
    else if (Array.isArray(content)) {
      for (const block of content) if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    if (parts.join('').length > 4000) break
  }
  const text = parts.join('\n').slice(0, 4000)
  return { text, tokens: tokenize(text) }
}

export function rankEntries(entries, { tokens, now = Date.now(), halfLifeDays = 30, minConfidence = 0.35 } = {}) {
  const hasQuery = tokens instanceof Set && tokens.size > 0
  return entries
    .filter((entry) => entry.status === 'active' && (entry.confidence ?? 0.6) >= minConfidence)
    .map((entry) => {
      const strength = strengthOf(entry, { now, halfLifeDays })
      const lexical = hasQuery ? scoreEntry(entry, tokens, now) : 0
      return { entry, strength, lexical, score: lexical * (0.5 + strength) + strength * 0.4 }
    })
    .sort((a, b) => b.score - a.score)
}

/**
 * Pick the entries that will be rendered into the prompt: per-kind quotas,
 * personalization gate, and a hard relevance floor when a query exists.
 */
export function selectForDigest(entries, { tokens, config, now = Date.now() } = {}) {
  const ranked = rankEntries(entries, { tokens, now, halfLifeDays: config?.halfLifeDays ?? 30, minConfidence: config?.minConfidence ?? 0.35 })
  const hasQuery = tokens instanceof Set && tokens.size > 0
  const byKind = new Map()
  for (const item of ranked) {
    if (item.entry.kind === 'preference' && !config?.personalization) continue
    if (hasQuery && item.lexical <= 0 && item.entry.kind !== 'state' && item.entry.kind !== 'preference') {
      // No lexical overlap: keep only as filler during the second pass.
      item.filler = true
    }
    const list = byKind.get(item.entry.kind) ?? []
    if (list.length < (QUOTA[item.entry.kind] ?? 3) * 4) list.push(item)
    byKind.set(item.entry.kind, list)
  }

  const groups = {}
  let matched = 0
  for (const kind of KIND_ORDER) {
    const items = byKind.get(kind) ?? []
    const quota = QUOTA[kind] ?? 3
    const relevant = items.filter((item) => !item.filler)
    const filler = items.filter((item) => item.filler)
    const chosen = [...relevant.slice(0, quota)]
    if (chosen.length < quota) chosen.push(...filler.slice(0, quota - chosen.length))
    groups[kind] = chosen.map((item) => item.entry)
    matched += relevant.filter((item) => item.lexical > 0).length
  }
  return { groups, matched, hasQuery }
}

export function describeQuery(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean
}

export { KIND_LABEL }
