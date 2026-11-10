/**
 * Memory entry model (schema v2).
 *
 * A memory entry is not a chat log line: it is a claim plus the evidence that
 * supports it. Growth is expressed as confidence/strength that rises when a
 * claim recurs and decays when it is never used again.
 */
import { nowIso, oneLine, toText, tokenize, uid } from './util.js'

export const SCHEMA_VERSION = 2

export const KIND_LABEL = {
  method: '方法',
  lesson: '教训',
  knowledge: '知识',
  wp: '复盘',
  preference: '画像',
  state: '状态',
}

const KIND_META_KEYS = {
  method: ['appliesTo', 'steps'],
  lesson: ['trigger', 'mistake', 'fix', 'verify'],
  knowledge: ['subject', 'topic', 'refs'],
  wp: ['platform', 'category', 'difficulty', 'keyIdea'],
  preference: ['aspect', 'value', 'evidenceCount'],
  state: ['project', 'status', 'next'],
}

const MAX_BODY = 6000
const MAX_EVIDENCE = 8
const MAX_TAGS = 12

export function clamp01(value, fallback = 0.6) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  return [...new Set(tags.map((tag) => oneLine(tag, 40)).filter(Boolean))].slice(0, MAX_TAGS)
}

function normalizeMeta(kind, meta) {
  const allowed = KIND_META_KEYS[kind] ?? []
  const out = {}
  if (!meta || typeof meta !== 'object') return out
  for (const key of allowed) {
    const value = meta[key]
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) out[key] = value.map((item) => oneLine(item, 120)).filter(Boolean).slice(0, 12)
    else out[key] = oneLine(value, 300)
  }
  return out
}

function normalizeEvidence(evidence, now) {
  if (!Array.isArray(evidence)) return []
  const seen = new Set()
  const out = []
  for (const item of evidence) {
    const quote = oneLine(item?.quote ?? item?.text ?? '', 300)
    if (!quote) continue
    const key = quote.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      sessionId: item?.sessionId ? toText(item.sessionId) : null,
      turn: Number.isFinite(Number(item?.turn)) ? Number(item.turn) : null,
      seq: Number.isFinite(Number(item?.seq)) ? Number(item.seq) : null,
      quote,
      at: item?.at ?? now,
    })
    if (out.length >= MAX_EVIDENCE) break
  }
  return out
}

export function normalizeEntry(raw, { now = nowIso() } = {}) {
  const kind = KIND_LABEL[raw?.kind] ? raw.kind : 'knowledge'
  const title = oneLine(raw?.title ?? '未命名条目', 160)
  const body = toText(raw?.body ?? '').trim().slice(0, MAX_BODY)
  const entry = {
    schema: SCHEMA_VERSION,
    id: typeof raw?.id === 'string' && raw.id ? raw.id : uid(),
    kind,
    title,
    body,
    tags: normalizeTags(raw?.tags),
    meta: normalizeMeta(kind, raw?.meta),
    confidence: clamp01(raw?.confidence, 0.6),
    status: ['active', 'superseded', 'rejected'].includes(raw?.status) ? raw.status : 'active',
    verified: raw?.verified === true,
    useCount: Math.max(0, Math.trunc(Number(raw?.useCount) || 0)),
    // How many times this claim was independently re-derived from a session.
    // Distinct from `useCount` (how often recall *served* it): only corroboration
    // promotes a lesson into a method. Older entries predate the field, so fall
    // back to the evidence count, which was the previous proxy.
    corroborations: Math.max(0, Math.trunc(Number(raw?.corroborations ?? (Array.isArray(raw?.evidence) ? raw.evidence.length : 0)) || 0)),
    createdAt: raw?.createdAt ?? now,
    updatedAt: raw?.updatedAt ?? raw?.createdAt ?? now,
    lastUsedAt: raw?.lastUsedAt ?? null,
    source: raw?.source && typeof raw.source === 'object' ? {
      sessionId: raw.source.sessionId ? toText(raw.source.sessionId) : null,
      turn: Number.isFinite(Number(raw.source.turn)) ? Number(raw.source.turn) : null,
      cwd: raw.source.cwd ? toText(raw.source.cwd) : null,
      url: raw.source.url ? toText(raw.source.url) : null,
      title: raw.source.title ? oneLine(raw.source.title, 120) : null,
    } : null,
    evidence: normalizeEvidence(raw?.evidence, now),
    supersedes: Array.isArray(raw?.supersedes) ? raw.supersedes.filter((id) => typeof id === 'string') : [],
    supersededBy: typeof raw?.supersededBy === 'string' ? raw.supersededBy : null,
    mergedFrom: Array.isArray(raw?.mergedFrom) ? raw.mergedFrom.filter((id) => typeof id === 'string') : [],
    promotedFrom: typeof raw?.promotedFrom === 'string' ? raw.promotedFrom : null,
  }
  return entry
}

/** Stable comparison key: kind + normalized title. */
export function entryKey(entry) {
  return `${entry.kind}::${oneLine(entry.title, 160).toLowerCase().replace(/\s+/g, ' ')}`
}

export function entryTokens(entry) {
  return new Set([
    ...tokenize(`${entry.title} ${(entry.tags ?? []).join(' ')}`),
    ...tokenize(`${entry.body ?? ''}`.slice(0, 400)),
  ])
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}

/**
 * 0..1 similarity used for dedupe/merge. Title dominates on purpose: two
 * entries about different topics often share boilerplate ("…的结论"、"在…场景下"),
 * and a body-only overlap must never merge them.
 */
export function similarity(a, b) {
  if (a.kind !== b.kind && a.kind !== 'lesson') return 0
  const titleScore = jaccard(tokenize(a.title), tokenize(b.title))
  if (titleScore < 0.5) return 0
  const bodyScore = jaccard(entryTokens(a), entryTokens(b))
  return Math.min(1, titleScore * 0.85 + bodyScore * 0.15)
}

/**
 * Merge `incoming` into `target` in place: longer body wins, unique lines are
 * appended, tags/evidence union, confidence rises with each corroboration.
 */
export function mergeEntry(target, incoming, { now = nowIso() } = {}) {
  const incomingBody = toText(incoming.body).trim()
  const targetBody = toText(target.body).trim()
  if (incomingBody && !targetBody.includes(incomingBody)) {
    const extra = targetBody ? `\n\n${incomingBody}` : incomingBody
    target.body = `${targetBody}${extra}`.slice(0, MAX_BODY)
  }
  target.tags = normalizeTags([...(target.tags ?? []), ...(incoming.tags ?? [])])
  target.meta = { ...(target.meta ?? {}), ...normalizeMeta(target.kind, incoming.meta) }
  target.confidence = Math.min(0.95, Math.max(target.confidence ?? 0.6, incoming.confidence ?? 0.6) + 0.05)
  const evidence = normalizeEvidence([...(target.evidence ?? []), ...(incoming.evidence ?? [])], now)
  target.evidence = evidence.slice(-MAX_EVIDENCE)
  // Corroboration is counted here, not derived from evidence.length: evidence is
  // capped at MAX_EVIDENCE, so a capped entry would stop accruing credit.
  target.corroborations = Math.max(0, Math.trunc((target.corroborations ?? 0) + 1))
  if (target.status !== 'active' && incoming.status === 'active') target.status = 'active'
  target.updatedAt = now
  return target
}

/**
 * Decayed strength: confidence halved every `halfLifeDays` without use, plus a
 * small boost for entries that repeatedly proved useful.
 */
export function strengthOf(entry, { now = Date.now(), halfLifeDays = 30 } = {}) {
  if (!entry || entry.status !== 'active') return 0
  const last = Date.parse(entry.lastUsedAt ?? entry.updatedAt ?? entry.createdAt ?? 0) || 0
  const ageDays = Math.max(0, (now - last) / 86_400_000)
  const decay = Math.pow(0.5, ageDays / Math.max(1, halfLifeDays))
  const useBoost = Math.min(0.25, (entry.useCount ?? 0) * 0.02)
  const evidenceBoost = Math.min(0.15, (entry.evidence?.length ?? 0) * 0.03)
  return Math.min(1, (entry.confidence ?? 0.6) * decay + useBoost + evidenceBoost)
}

/**
 * Promote a repeatedly-corroborated lesson into a reusable method.
 *
 * Deliberately ignores `useCount`: being *recalled* three times is not evidence
 * the pitfall was hit three times, and promoting on recall volume would turn
 * frequently-quoted lessons into methods nobody ever re-verified.
 */
export function lessonPromotion(entry, { now = nowIso(), threshold = 3 } = {}) {
  if (entry.kind !== 'lesson' || entry.status !== 'active') return null
  const corroborations = Math.max(0, Math.trunc(entry.corroborations ?? 0))
  if (corroborations < threshold || entry.promotedTo) return null
  const trigger = entry.meta?.trigger ?? ''
  const fix = entry.meta?.fix ?? ''
  const body = [
    trigger ? `触发场景：${trigger}` : '',
    `坑：${entry.title}`,
    entry.body ? `原教训：${entry.body}` : '',
    fix ? `做法：${fix}` : '做法：先用最小步骤复现，再按教训里的修正路径执行。',
  ].filter(Boolean).join('\n')
  return {
    kind: 'method',
    title: `避免「${oneLine(entry.title, 80)}」的稳妥做法`,
    body,
    tags: [...(entry.tags ?? []), '由教训升级'],
    confidence: Math.min(0.9, (entry.confidence ?? 0.6) + 0.1),
    verified: entry.verified,
    promotedFrom: entry.id,
    evidence: (entry.evidence ?? []).slice(-3),
    meta: { appliesTo: [...tokenize(entry.title)].slice(0, 6), steps: [] },
    source: entry.source,
    now,
  }
}

export function describeMeta(entry) {
  const meta = entry.meta ?? {}
  const parts = []
  if (meta.aspect || meta.value) parts.push(`${meta.aspect ?? '偏好'}: ${meta.value ?? ''}`.trim())
  if (meta.subject || meta.topic) parts.push(`[${meta.subject ?? ''}${meta.topic ? ` / ${meta.topic}` : ''}]`)
  if (meta.platform || meta.category) parts.push(`[${meta.platform ?? ''}${meta.category ? ` / ${meta.category}` : ''}]`)
  if (meta.project || meta.status) parts.push(`(${meta.project ?? ''}${meta.status ? ` · ${meta.status}` : ''})`)
  return parts.filter(Boolean).join(' ')
}

export function entrySummary(entry, index) {
  const prefix = index === undefined ? '' : `${index + 1}. `
  const meta = describeMeta(entry)
  const tags = entry.tags?.length ? ` · ${entry.tags.map((tag) => `#${tag}`).join(' ')}` : ''
  const confidence = Math.round((entry.confidence ?? 0.6) * 100)
  const line = `${prefix}**${oneLine(entry.title, 120)}**${meta ? ` ${meta}` : ''}${tags} · 置信 ${confidence}%`
  const body = oneLine(entry.body, 220)
  return body ? `${line}\n   ${body}` : line
}
