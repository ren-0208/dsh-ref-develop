/**
 * Runtime configuration (schema v2).
 *
 * The plugin deliberately exports no Cordis `Config` schema: the host composes
 * this bundle with `config: {}` and everything the user changes at runtime
 * lives in `$DSH_HOME/growth-note/settings.json`, edited through the
 * `growth_config` tool, the `/growth` command, or the settings page.
 */
import { clampNumber, toText } from './util.js'

export const MEMORY_KINDS = ['method', 'lesson', 'knowledge', 'wp', 'preference', 'state']

export const CONFIG_DEFAULTS = Object.freeze({
  scope: 'global',
  /** Absolute workspace directory chosen in Settings; empty means "current session cwd". */
  workspacePath: '',
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
})

/** Keys a user (or the model) may change at runtime. */
export const MUTABLE_KEYS = Object.freeze([
  'scope',
  'workspacePath',
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
])

export const SCOPE_LABEL = {
  global: '全局记忆（所有工作区共享）',
  workspace: '单工作区记忆（仅当前工作区）',
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

export function normalizeConfig(raw, base = CONFIG_DEFAULTS) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = { ...base }
  if (SCOPE_VALUES.includes(src.scope)) out.scope = src.scope
  out.workspacePath = typeof src.workspacePath === 'string' ? src.workspacePath.trim() : out.workspacePath
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
  out.locale = toText(src.locale).trim() === 'en' ? 'en' : 'zh'
  return out
}
