/**
 * User-facing settings for growth-note.
 *
 * `scope` decides where memory lives:
 *   - `global`    : one shared memory for every workspace of this DSH profile
 *   - `workspace` : one memory per working directory
 *
 * The persisted copy lives in `<DSH_HOME>/growth-note/settings.json` so that a
 * runtime switch through the `growth_config` tool survives restarts. The
 * bundle's cordis.patch.yml `config` only supplies initial defaults.
 */
import { clampNumber } from './util.js'

export const CONFIG_DEFAULTS = {
  scope: 'global',
  personalization: false,
  autoCapture: true,
  autoSummarize: true,
  consolidateEveryTurns: 6,
  promptBudgetChars: 1800,
  maxEntries: 3000,
  sessionNotesPerConsolidation: 6,
  locale: 'zh',
}

export const MEMORY_KINDS = ['method', 'lesson', 'knowledge', 'wp', 'preference', 'state']

const KINDS = new Set(MEMORY_KINDS)

export function normalizeConfig(raw, base = CONFIG_DEFAULTS) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const merged = { ...base, ...input }
  return {
    scope: merged.scope === 'workspace' ? 'workspace' : 'global',
    personalization: merged.personalization === true,
    autoCapture: merged.autoCapture !== false,
    autoSummarize: merged.autoSummarize !== false,
    consolidateEveryTurns: clampNumber(merged.consolidateEveryTurns, 1, 100, CONFIG_DEFAULTS.consolidateEveryTurns),
    promptBudgetChars: clampNumber(merged.promptBudgetChars, 400, 12000, CONFIG_DEFAULTS.promptBudgetChars),
    maxEntries: clampNumber(merged.maxEntries, 50, 20000, CONFIG_DEFAULTS.maxEntries),
    sessionNotesPerConsolidation: clampNumber(
      merged.sessionNotesPerConsolidation,
      1,
      30,
      CONFIG_DEFAULTS.sessionNotesPerConsolidation,
    ),
    locale: merged.locale === 'en' ? 'en' : 'zh',
  }
}

export function isMemoryKind(value) {
  return KINDS.has(value)
}

/** Fields a user may change at runtime through `growth_config`. */
export const MUTABLE_KEYS = [
  'scope',
  'personalization',
  'autoCapture',
  'autoSummarize',
  'consolidateEveryTurns',
  'promptBudgetChars',
  'maxEntries',
  'sessionNotesPerConsolidation',
]
