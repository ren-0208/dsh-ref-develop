/** Small, dependency-free helpers shared by the growth-note modules. */
import { randomUUID } from 'node:crypto'

export function uid() {
  return `mg-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
}

export function nowIso() {
  return new Date().toISOString()
}

export function toText(value) {
  return typeof value === 'string' ? value : String(value ?? '')
}

/** Collapse all whitespace so one entry always fits on one Markdown line. */
export function oneLine(value, max = 200) {
  const text = toText(value).replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(1, max - 1))}…`
}

/** Keep paragraphs but bound the total length. */
export function boundText(value, max = 4000) {
  const text = toText(value).replace(/\r\n/g, '\n').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…（已截断）`
}

export function escapeCell(value) {
  return oneLine(value, 400).replace(/\|/g, '\\|')
}

export function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

export function dedupe(list) {
  return [...new Set(list)]
}

const HAN = /\p{Script=Han}/u

/** Latin words plus CJK bigrams - enough for keyword recall without a tokenizer. */
export function tokenize(text) {
  const normalized = toText(text).toLowerCase()
  const tokens = new Set()
  for (const word of normalized.match(/[a-z0-9][a-z0-9_.+-]{1,}/g) ?? []) {
    tokens.add(word)
  }
  const han = normalized.match(/\p{Script=Han}+/gu) ?? []
  for (const run of han) {
    if (run.length === 1) tokens.add(run)
    for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2))
  }
  return tokens
}

export function hasHan(text) {
  return HAN.test(toText(text))
}

/**
 * Deterministic keyword score: query tokens against title/body/tags plus a
 * gentle recency bonus so old but exact matches still win over fresh noise.
 */
export function scoreEntry(entry, queryTokens, now = Date.now()) {
  if (queryTokens.size === 0) return 0
  const title = tokenize(entry.title)
  const body = tokenize(entry.body)
  const tags = new Set((entry.tags ?? []).map((tag) => toText(tag).toLowerCase()))
  let score = 0
  for (const token of queryTokens) {
    if (title.has(token)) score += 6
    if (tags.has(token)) score += 4
    if (body.has(token)) score += 2
  }
  if (score === 0) return 0
  const ageDays = Math.max(0, (now - Date.parse(entry.createdAt ?? 0)) / 86400000)
  score += Math.max(0, 2 - ageDays / 30)
  score += Math.min(3, (entry.useCount ?? 0) * 0.2)
  return score
}

export function safeJsonParse(text, fallback = undefined) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export function messageText(message) {
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}
