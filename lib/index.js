/**
 * growth-note — cross-session memory & growth for DeepSeek Harness.
 *
 * What it does
 *   1. injects a compact memory digest into the system prompt;
 *   2. exposes growth_remember / growth_recall / growth_config / growth_status /
 *      growth_forget tools;
 *   3. at the end of each turn writes a session note, and every N turns asks the
 *      session model to distill those notes into reusable entries.
 *
 * Memory roots are managed per scope:
 *   scope=global    -> <DSH_HOME>/growth-note/global   (shared by all workspaces)
 *   scope=workspace -> <cwd>/.growth-note              (one per workspace)
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { CONFIG_DEFAULTS, normalizeConfig } from './config.js'
import { Consolidator } from './consolidate.js'
import { buildDigest } from './prompt.js'
import { GrowthStore, resolveDshHome, resolveRoot, settingsFilePath } from './store.js'
import { createTools } from './tools.js'

export const name = 'growth-note'
export const inject = ['tools', 'systemPrompt', 'sessionQuery', 'workingDirectory']

function service(ctx, name) {
  if (ctx[name] != null) return ctx[name]
  try {
    return ctx.get?.(name) ?? null
  } catch {
    return null
  }
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const home = resolveDshHome()
  const file = settingsFilePath(home)

  let settings = normalizeConfig(config)
  let lastCwd = process.cwd()
  let activeDigest = ''
  let digestDirty = false

  // Persisted settings win over the bundle config, but never block plugin load.
  const ready = fs
    .readFile(file, 'utf8')
    .then((raw) => {
      settings = normalizeConfig({ ...config, ...JSON.parse(raw) }, CONFIG_DEFAULTS)
    })
    .catch(() => {})

  const stores = new Map()

  function memoryStore() {
    const root = resolveRoot({ scope: settings.scope, cwd: lastCwd, home })
    let store = stores.get(root)
    if (!store) {
      store = new GrowthStore(root)
      stores.set(root, store)
    }
    return store
  }

  async function resolveCwd(agent, signal) {
    try {
      const wd = service(ctx, 'workingDirectory')
      const directory = await wd?.ensure?.(agent, signal)
      if (typeof directory === 'string' && directory) {
        lastCwd = directory
        return directory
      }
    } catch {
      // fall through to the last known directory
    }
    return lastCwd
  }

  async function buildActiveDigest() {
    await ready
    try {
      const store = await memoryStore().ensure()
      const entries = await store.entries()
      activeDigest = buildDigest({ entries, config: settings, root: store.root, cwd: lastCwd })
      digestDirty = false
    } catch (error) {
      logger.warn?.(`[growth-note] digest build failed: ${error?.message ?? error}`)
    }
  }

  const runtime = {
    logger,
    settingsPath: () => file,
    getConfig: () => settings,
    markDirty() {
      digestDirty = true
    },
    async setConfig(patch) {
      await ready
      settings = normalizeConfig({ ...settings, ...patch }, settings)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      await buildActiveDigest()
      return settings
    },
    async storeFor(target) {
      await ready
      const agent = target?.agent ?? (target && typeof target.id === 'string' ? target : undefined)
      if (agent) await resolveCwd(agent)
      return memoryStore().ensure()
    },
    cwdSync: () => lastCwd,
    readEvents: async (sessionId) => {
      const query = service(ctx, 'sessionQuery')
      if (!query) return []
      try {
        const snapshot = await query.readSession(sessionId)
        if (Array.isArray(snapshot?.events)) return snapshot.events
      } catch {
        // fall back to the observation API below
      }
      try {
        const observation = await query.observeSession(sessionId, { projectionMode: 'none' })
        try {
          return Array.isArray(observation?.events) ? observation.events : []
        } finally {
          observation?.[Symbol.dispose]?.()
        }
      } catch {
        return []
      }
    },
    currentSelection: () => {
      try {
        return service(ctx, 'agentDefaultModel')?.currentSelection?.() ?? null
      } catch {
        return null
      }
    },
    llm: () => service(ctx, 'llm'),
  }

  const consolidator = new Consolidator(runtime)

  // Tools -----------------------------------------------------------------
  const toolsService = service(ctx, 'tools')
  for (const tool of createTools({ runtime })) {
    if (!toolsService) break
    ctx.effect(() => toolsService.register(tool))
  }

  // Prompt ----------------------------------------------------------------
  let order = 100
  try {
    const identity = service(ctx, 'systemPrompt').getSectionOrder('HARNESS_IDENTITY')
    if (typeof identity === 'number') order = identity + 50
  } catch {
    // section ordering is advisory; keep the fallback
  }

  const promptService = service(ctx, 'systemPrompt')
  ctx.effect(() =>
    promptService.section({
      name: 'GROWTH_NOTE',
      order,
      text: () => activeDigest,
    }),
  )

  // Events ----------------------------------------------------------------
  ctx.on('agent/created', async (payload) => {
    await resolveCwd(payload?.agent)
    await buildActiveDigest()
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    if (!activeDigest || digestDirty) {
      await resolveCwd(payload?.agent, payload?.signal)
      await buildActiveDigest()
    }
    return next()
  })

  ctx.on('agent/turn-stopping', (payload) => {
    const turn = Number(payload?.turn) || 0
    // Never block the turn: notes and distillation run in the background.
    void consolidator.run({ agent: payload?.agent, turn }).catch((error) => {
      logger.warn?.(`[growth-note] consolidation error: ${error?.message ?? error}`)
    })
  })

  logger.info?.(`[growth-note] ready (scope=${settings.scope}, home=${home})`)
}

export default { name, inject, apply }
