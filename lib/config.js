/**
 * Runtime configuration (schema v2).
 *
 * The plugin deliberately exports no Cordis `Config` schema: the host composes
 * this bundle with `config: {}` and everything the user changes at runtime
 * lives in `$DSH_HOME/growth-note/settings.json`, edited through the
 * `growth_config` tool, the `/growth` command, or the settings page.
 */
import { EMBEDDING_PROVIDERS } from './embeddings.js'
import { clampNumber, toText } from './util.js'

export const MEMORY_KINDS = ['method', 'lesson', 'knowledge', 'wp', 'preference', 'state']

export const CONFIG_DEFAULTS = Object.freeze({
  scope: 'global',
  /**
   * Workspaces whose memory is active (`scope: 'workspace'`). Multi-select acts as a
   * whitelist: a session reads memory only when its working directory is one of these
   * (or inside one). Empty means "each session uses its own cwd as its library".
   */
  workspacePaths: [],
  personalization: false,
  autoCapture: true,
  autoSummarize: true,
  consolidateEveryTurns: 6,
  promptBudgetChars: 1800,
  maxEntries: 3000,
  sessionNotesPerConsolidation: 6,
  locale: 'zh',
  halfLifeDays: 30,
  minConfidence: 0.35,
  dedupeThreshold: 0.7,
  promoteLessonAfter: 3,
  /**
   * Optional embedding provider. `none` keeps recall lexical-only; `openai`
   * targets any OpenAI-compatible `/embeddings` endpoint. Vectors are cached in
   * `<memory root>/vectors.jsonl` and are always rebuildable, so this can be
   * switched on or off at any time without touching memory.jsonl.
   */
  embeddingProvider: 'none',
  embeddingModel: '',
  embeddingBaseUrl: '',
  embeddingApiKey: '',
})

/** Keys a user (or the model) may change at runtime. */
export const MUTABLE_KEYS = Object.freeze([
  'scope',
  'workspacePaths',
  'personalization',
  'autoCapture',
  'autoSummarize',
  'consolidateEveryTurns',
  'promptBudgetChars',
  'maxEntries',
  'sessionNotesPerConsolidation',
  'locale',
  'halfLifeDays',
  'minConfidence',
  'dedupeThreshold',
  'promoteLessonAfter',
  'embeddingProvider',
  'embeddingModel',
  'embeddingBaseUrl',
  'embeddingApiKey',
])

export const SCOPE_LABEL = {
  global: '全局记忆（所有工作区共享）',
  workspace: '单工作区记忆（按工作区分别存放）',
  off: '无（关闭记忆）',
}

/** `off` keeps the last stores on disk untouched but stops capture, distillation and injection. */
export const SCOPE_VALUES = Object.freeze(['global', 'workspace', 'off'])

export function scopeEnabled(scope) {
  return scope === 'global' || scope === 'workspace'
}

export function isMemoryKind(kind) {
  return MEMORY_KINDS.includes(kind)
}

function asBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 'on' || value === 1) return true
  if (value === 'false' || value === 'off' || value === 0) return false
  return fallback
}

/** Validate a path whitelist from settings/API input (array or comma-separated string). */
export function normalizePaths(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\n]/) : []
  const out = []
  const seen = new Set()
  for (const item of list) {
    const path = normalizePath(item)
    if (!path) continue
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(path)
  }
  return out.slice(0, 50)
}

export function normalizePath(value) {
  return toText(value).trim().replace(/\\/g, '/').replace(/\/+$/, '')
}

/** True when `cwd` is `base` or below it (Windows paths compare case-insensitively). */
export function pathInside(cwd, base) {
  const child = normalizePath(cwd).toLowerCase()
  const parent = normalizePath(base).toLowerCase()
  if (!child || !parent) return false
  return child === parent || child.startsWith(`${parent}/`)
}

export function normalizeConfig(raw, base = CONFIG_DEFAULTS) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = { ...base }
  if (SCOPE_VALUES.includes(src.scope)) out.scope = src.scope
  const declaredPaths =
    src.workspacePaths !== undefined
      ? src.workspacePaths
      : typeof src.workspacePath === 'string' && src.workspacePath.trim()
        ? [src.workspacePath] // v0.3 settings: single path, promoted to the whitelist
        : out.workspacePaths
  out.workspacePaths = normalizePaths(declaredPaths)
  out.personalization = asBool(src.personalization, out.personalization)
  out.autoCapture = asBool(src.autoCapture, out.autoCapture)
  out.autoSummarize = asBool(src.autoSummarize, out.autoSummarize)
  out.consolidateEveryTurns = clampNumber(src.consolidateEveryTurns, 1, 50, out.consolidateEveryTurns)
  out.promptBudgetChars = clampNumber(src.promptBudgetChars, 400, 8000, out.promptBudgetChars)
  out.maxEntries = clampNumber(src.maxEntries, 50, 20000, out.maxEntries)
  out.sessionNotesPerConsolidation = clampNumber(src.sessionNotesPerConsolidation, 1, 20, out.sessionNotesPerConsolidation)
  out.halfLifeDays = clampNumber(src.halfLifeDays, 1, 365, out.halfLifeDays)
  out.minConfidence = Math.min(0.95, Math.max(0, Number(src.minConfidence ?? out.minConfidence)))
  out.dedupeThreshold = Math.min(0.95, Math.max(0.3, Number(src.dedupeThreshold ?? out.dedupeThreshold)))
  out.promoteLessonAfter = clampNumber(src.promoteLessonAfter, 2, 20, out.promoteLessonAfter)
  out.embeddingProvider = EMBEDDING_PROVIDERS.includes(src.embeddingProvider) ? src.embeddingProvider : out.embeddingProvider
  out.embeddingModel = toText(src.embeddingModel).trim().slice(0, 120)
  out.embeddingBaseUrl = toText(src.embeddingBaseUrl).trim().replace(/\/+$/, '').slice(0, 300)
  out.embeddingApiKey = toText(src.embeddingApiKey).trim().slice(0, 400)
  out.locale = toText(src.locale).trim() === 'en' ? 'en' : 'zh'
  return out
}
