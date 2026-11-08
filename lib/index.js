/**
 * 「记忆与成长」— host half (bundle/package `dsh-ref-develop`).
 *
 * Wiring, in one place:
 *   settings.json          persisted runtime config ($DSH_HOME/growth-note/)
 *   agent/{created,pre-step,turn-stopping}   capture, recall query, consolidation
 *   systemPrompt.section   per-agent digest (scoped section shadows the global one)
 *   tools                  growth_remember / recall / config / status / forget / edit / export
 *   commands               /growth ...
 *   webServer prefix route /growth-note/api/* for the settings page
 */
import fs from 'node:fs/promises'

import { CONFIG_DEFAULTS, normalizeConfig, scopeEnabled } from './config.js'
import { Consolidator } from './consolidate.js'
import { createCommand } from './commands.js'
import { createTools } from './tools.js'
import { PREFIX, createApiHandler } from './api.js'
import { buildDigest, buildOffDigest } from './prompt.js'
import { selectForDigest, tokensFromMessages } from './recall.js'
import { GrowthStore, resolveDshHome, resolveRoot, settingsFilePath } from './store.js'
import { writeJsonAtomic } from './fsx.js'

export const name = 'dsh-ref-develop'
export const inject = ['tools', 'systemPrompt', 'sessionQuery', 'workingDirectory', 'commands', 'webServer']

/**
 * Cordis services hang off ctx directly, but reading an undeclared dependency
 * throws ("cannot get property X without inject") — optional services must be
 * probed inside try/catch, and get() remains the compatibility fallback.
 */
function service(ctx, key) {
  if (ctx) {
    try {
      if (ctx[key] != null) return ctx[key]
    } catch {
      /* not injected: fall through */
    }
  }
  try {
    return ctx?.get?.(key) ?? null
  } catch {
    return null
  }
}

export function apply(ctx, pluginConfig) {
  const logger = ctx.logger?.('dsh-ref-develop') ?? console
  const home = resolveDshHome()
  const settingsFile = settingsFilePath(home)

  let config = normalizeConfig(pluginConfig ?? {}, CONFIG_DEFAULTS)
  let currentCwd = service(ctx, 'workingDirectory')?.defaultDirectory ?? process.cwd()
  let lastAgentId = null
  let digestVersion = 0

  const stores = new Map()
  const agents = new Map()
  const agentCwd = new Map()
  const agentQuery = new Map()
  const lastTurn = new Map()
  const digestCache = new Map()

  function storeFor(scope, cwd) {
    const root = resolveRoot({ scope, cwd: cwd || currentCwd, home })
    let store = stores.get(root)
    if (!store) {
      store = new GrowthStore(root, { halfLifeDays: config.halfLifeDays, maxEntries: config.maxEntries })
      stores.set(root, store)
    }
    store.configure({ halfLifeDays: config.halfLifeDays, maxEntries: config.maxEntries })
    return store
  }

  async function cwdFor(agent) {
    if (!agent) return currentCwd
    const cached = agentCwd.get(agent.id)
    if (cached) return cached
    const workingDirectory = service(ctx, 'workingDirectory')
    try {
      const dir = await workingDirectory?.ensure?.(agent)
      if (dir) {
        agentCwd.set(agent.id, dir)
        currentCwd = dir
        return dir
      }
    } catch {
      // fall through to the default directory
    }
    const fallback = workingDirectory?.defaultDirectory ?? process.cwd()
    agentCwd.set(agent.id, fallback)
    return fallback
  }

  /** True while a memory scope is active; `off` stops capture, distillation and injection. */
  function memoryOn() {
    return scopeEnabled(config.scope)
  }

  /** Scope used for reads; `off` still lets Settings inspect the last global store. */
  function readScope() {
    return memoryOn() ? config.scope : 'global'
  }

  /** Workspace whose memory is active: an explicit pick in Settings wins over the session cwd. */
  async function targetCwd(agent) {
    if (readScope() === 'workspace' && config.workspacePath) return config.workspacePath
    return cwdFor(agent)
  }

  async function storeForAgent(agent) {
    const cwd = await targetCwd(agent)
    const store = storeFor(readScope(), cwd)
    await store.ensure()
    return store
  }

  /** Open (or reuse) the memory store of one workspace directory, without changing the active one. */
  async function storeForWorkspace(path) {
    const store = storeFor('workspace', path)
    await store.ensure()
    return store
  }

  function markDirty() {
    digestVersion += 1
    digestCache.clear()
  }

  async function persist() {
    await writeJsonAtomic(settingsFile, { version: 2, updatedAt: new Date().toISOString(), config })
  }

  async function setConfig(patch, { agent } = {}) {
    const previous = config
    const next = normalizeConfig({ ...config, ...(patch ?? {}) }, CONFIG_DEFAULTS)
    let migration = null
    if (scopeEnabled(next.scope) && scopeEnabled(previous.scope) && next.scope !== previous.scope) {
      try {
        const cwd = agent ? await cwdFor(agent) : currentCwd
        const sourceCwd = previous.scope === 'workspace' ? previous.workspacePath || cwd : cwd
        const targetCwdValue = next.scope === 'workspace' ? next.workspacePath || cwd : cwd
        const source = storeFor(previous.scope, sourceCwd)
        await source.ensure()
        const target = storeFor(next.scope, targetCwdValue)
        await target.ensure()
        migration = await source.migrateTo(target)
      } catch (error) {
        logger.warn?.(`scope migration failed: ${String(error?.message ?? error)}`)
      }
    }
    config = next
    for (const store of stores.values()) store.configure({ halfLifeDays: config.halfLifeDays, maxEntries: config.maxEntries })
    try {
      await persist()
    } catch (error) {
      logger.warn?.(`settings write failed: ${String(error?.message ?? error)}`)
    }
    markDirty()
    return { config, migration }
  }

  async function readTurnEvents(agent, turn) {
    const sessionQuery = service(ctx, 'sessionQuery')
    if (!sessionQuery || !agent) return []
    let events = []
    try {
      const snapshot = await sessionQuery.readSession(agent.id)
      events = snapshot?.events ?? []
    } catch {
      try {
        const observation = await sessionQuery.observeSession(agent.id, { projectionMode: 'none' })
        try {
          events = observation?.events ?? []
        } finally {
          try {
            if (typeof observation?.[Symbol.dispose] === 'function') observation[Symbol.dispose]()
          } catch {
            // disposal is best effort
          }
        }
      } catch {
        return []
      }
    }
    if (turn !== undefined && turn !== null) events = events.filter((event) => event?.data?.turn === turn)
    return events
  }

  function currentTurn(agent) {
    if (!agent) return null
    return lastTurn.get(agent.id) ?? null
  }

  function digestFor(agentId) {
    const query = agentQuery.get(agentId) ?? { text: '', tokens: new Set() }
    const cached = digestCache.get(agentId)
    if (cached && cached.version === digestVersion && cached.query === query.text) return cached.text
    if (!memoryOn()) {
      const text = buildOffDigest()
      digestCache.set(agentId, { version: digestVersion, query: query.text, text })
      return text
    }
    const scope = readScope()
    const cwd = agentCwd.get(agentId) ?? currentCwd
    const root = resolveRoot({ scope, cwd: scope === 'workspace' && config.workspacePath ? config.workspacePath : cwd, home })
    const store = stores.get(root)
    const entries = store?.entriesSync() ?? []
    const { groups, matched } = selectForDigest(entries, { tokens: query.tokens, config })
    const text = buildDigest({ groups, config, root, cwd, queryText: query.text, matched })
    digestCache.set(agentId, { version: digestVersion, query: query.text, text })
    return text
  }

  /** Workspaces known to this profile, for the Settings picker (empty when unavailable). */
  function workspaceList() {
    const registry = service(ctx, 'workspaceRegistry')
    let list = []
    try {
      list = registry?.list?.() ?? []
    } catch (error) {
      logger.warn?.(`workspace list failed: ${String(error?.message ?? error)}`)
    }
    return list.map((workspace) => ({
      id: workspace.id,
      title: workspace.title ?? '',
      path: workspace.path,
      sessionCount: (workspace.sessionIds ?? []).length,
    }))
  }

  const runtime = {
    logger,
    getConfig: () => config,
    setConfig,
    markDirty,
    storeForAgent,
    storeForWorkspace,
    workspaces: workspaceList,
    cwdSync: () => currentCwd,
    cwdFor,
    llm: () => service(ctx, 'llm'),
    currentSelection: () => {
      const model = service(ctx, 'agentDefaultModel')
      try {
        return model?.currentSelection?.() ?? null
      } catch {
        return null
      }
    },
    readTurnEvents,
    currentTurn,
    agentForApi: () => (lastAgentId ? agents.get(lastAgentId) ?? null : null),
    consolidator: null,
  }
  runtime.consolidator = new Consolidator(runtime)

  // ---- prompt sections -------------------------------------------------
  const systemPrompt = service(ctx, 'systemPrompt')
  let sectionOrder = 100
  try {
    const base = systemPrompt?.getSectionOrder('HARNESS_IDENTITY')
    if (Number.isFinite(base)) sectionOrder = base + 50
  } catch {
    sectionOrder = 100
  }

  if (systemPrompt) {
    ctx.effect(() => systemPrompt.section({ name: 'GROWTH_NOTE', order: sectionOrder, text: () => digestFor(lastAgentId ?? '') }))
  }

  function mountAgent(agent) {
    if (!agent || agents.has(agent.id)) return
    agents.set(agent.id, agent)
    lastAgentId = agent.id
    const agentSystemPrompt = service(agent.ctx ?? ctx, 'systemPrompt')
    try {
      agentSystemPrompt?.section?.({ name: 'GROWTH_NOTE', order: sectionOrder + 1, text: () => digestFor(agent.id) })
    } catch (error) {
      logger.warn?.(`agent section failed: ${String(error?.message ?? error)}`)
    }
    void cwdFor(agent).then(() => (memoryOn() ? storeForAgent(agent) : null)).then(() => markDirty()).catch(() => {})
  }

  ctx.on('agent/created', ({ agent }) => {
    mountAgent(agent)
  })

  ctx.on('agent/pre-step', async ({ agent, messages, turn }, next) => {
    if (agent) {
      lastAgentId = agent.id
      if (!agents.has(agent.id)) mountAgent(agent)
      if (Number.isFinite(turn)) lastTurn.set(agent.id, turn)
      if (memoryOn()) {
        const query = tokensFromMessages(messages)
        const previous = agentQuery.get(agent.id)
        if (previous?.text !== query.text) {
          agentQuery.set(agent.id, query)
          digestCache.delete(agent.id)
        }
        void storeForAgent(agent).catch(() => {})
      }
    }
    return next()
  })

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (!agent || !memoryOn()) return
    lastAgentId = agent.id
    if (Number.isFinite(turn)) lastTurn.set(agent.id, turn)
    void runtime.consolidator.run({ agent, turn }).catch(() => {})
  })

  ctx.on('agent/disposed', ({ agent }) => {
    if (!agent) return
    agents.delete(agent.id)
    agentCwd.delete(agent.id)
    agentQuery.delete(agent.id)
    lastTurn.delete(agent.id)
    digestCache.delete(agent.id)
  })

  // ---- tools -----------------------------------------------------------
  const toolsService = service(ctx, 'tools')
  if (toolsService?.register) {
    for (const tool of createTools({ runtime })) {
      ctx.effect(() => toolsService.register(tool))
    }
  }

  // ---- command ---------------------------------------------------------
  const commands = service(ctx, 'commands')
  if (commands?.register) {
    ctx.effect(() => commands.register(createCommand(runtime)))
  }

  // ---- settings API ----------------------------------------------------
  const webServer = service(ctx, 'webServer')
  if (webServer?.register) {
    const handler = createApiHandler({ runtime })
    ctx.effect(() =>
      webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (error) {
            try {
              res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
            } catch {
              // response already sent
            }
          }
        },
      }),
    )
  }

  // ---- boot: load persisted settings, then warm the store ---------------
  void (async () => {
    try {
      const raw = JSON.parse(await fs.readFile(settingsFile, 'utf8'))
      config = normalizeConfig(raw?.config ?? raw, config)
    } catch {
      // no settings yet: defaults apply
    }
    try {
      if (memoryOn()) await storeFor(config.scope, currentCwd).ensure()
    } catch (error) {
      logger.warn?.(`memory store init failed: ${String(error?.message ?? error)}`)
    }
    markDirty()
  })()
}
