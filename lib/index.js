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

import { CONFIG_DEFAULTS, normalizeConfig, pathInside, scopeEnabled } from './config.js'
import { Consolidator } from './consolidate.js'
import { createCommand } from './commands.js'
import { createTools } from './tools.js'
import { PREFIX, createApiHandler } from './api.js'
import { createEmbedder } from './embeddings.js'
import { buildDigest } from './prompt.js'
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
  const agentVector = new Map()
  const lastTurn = new Map()
  const digestCache = new Map()
  const backfilling = new Set()

  // Embeddings are optional: without a configured provider everything stays lexical.
  let embedder = createEmbedder(config, { logger })
  function refreshEmbedder() {
    const next = createEmbedder(config, { logger })
    const changed = next.signature !== embedder.signature
    embedder = next
    if (changed) {
      agentVector.clear()
      markDirty()
    }
    return embedder
  }

  /** The store-shaping settings every GrowthStore needs to stay bounded. */
  function storeOptions() {
    return {
      halfLifeDays: config.halfLifeDays,
      maxEntries: config.maxEntries,
      maxNoteTurns: config.maxNoteTurns,
      archiveRetentionDays: config.archiveRetentionDays,
      maxArchivedEntries: config.maxArchivedEntries,
    }
  }

  function storeFor(scope, cwd) {
    const root = resolveRoot({ scope, cwd: cwd || currentCwd, home })
    let store = stores.get(root)
    if (!store) {
      store = new GrowthStore(root, storeOptions())
      stores.set(root, store)
    }
    store.configure(storeOptions())
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

  /**
   * The workspace whose library is active for a session directory.
   * A non-empty whitelist only matches sessions inside those directories;
   * outside of it the session stays in the default (memory-free) state.
   */
  function activeWorkspaceFor(cfg, cwd) {
    if (cfg.scope !== 'workspace') return null
    const target = cwd || currentCwd
    const list = cfg.workspacePaths ?? []
    // No selection means no workspace owns this session: default (memory-free) state.
    if (!list.length) return null
    return list.find((path) => pathInside(target, path)) ?? null
  }

  function enabledFor(cfg, cwd) {
    if (cfg.scope === 'global') return true
    if (cfg.scope !== 'workspace') return false
    return activeWorkspaceFor(cfg, cwd) !== null
  }

  async function storeForAgent(agent) {
    const cwd = await cwdFor(agent)
    if (!enabledFor(config, cwd)) return null
    const scope = config.scope === 'workspace' ? 'workspace' : 'global'
    const base = scope === 'workspace' ? activeWorkspaceFor(config, cwd) : cwd
    const store = storeFor(scope, base)
    await store.ensure()
    // Cached after the first call; keeps the vector index in memory for recall.
    await store.loadVectors()
    return store
  }

  /** Open (or reuse) the memory store of one workspace directory, without changing the active one. */
  async function storeForWorkspace(path) {
    const store = storeFor('workspace', path)
    await store.ensure()
    return store
  }

  /** The shared global library, for browsing from Settings while this session is inactive. */
  async function storeForGlobal() {
    const store = storeFor('global', currentCwd)
    await store.ensure()
    return store
  }

  // ---- optional vector index ------------------------------------------
  //
  // Embeddings never block a turn: the query vector is computed in the
  // background and the entry index is filled in batches. Everything degrades to
  // lexical recall when no provider is configured or a request fails.

  /** Text used to embed an entry (title carries the most signal). */
  function entryText(entry) {
    return `${entry.title}\n${entry.body ?? ''}`.trim().slice(0, 2000)
  }

  async function embedQuery(agentId, text) {
    if (!embedder.available || !text) return null
    const vectors = await embedder.embed([text])
    const vector = vectors[0]
    if (!vector?.length) return null
    agentVector.set(agentId, { signature: embedder.signature, text, vec: vector })
    digestCache.delete(agentId)
    return vector
  }

  function queryVectorFor(agentId) {
    const cached = agentVector.get(agentId)
    if (!cached || cached.signature !== embedder.signature) return null
    return cached.vec
  }

  /**
   * Fill missing/stale vectors for the active entries of one store.
   * `limit` bounds the work per call so consolidation is never delayed.
   */
  async function backfillVectors(store, { limit = 64, batchSize = 16 } = {}) {
    if (!store || !embedder.available) return { embedded: 0, skipped: true }
    if (backfilling.has(store.root)) return { embedded: 0, busy: true }
    backfilling.add(store.root)
    try {
      const entries = await store.activeEntries()
      const vectors = await store.loadVectors()
      const pending = entries.filter((entry) => {
        const record = vectors.get(entry.id)
        return !record || record.sig !== embedder.signature
      })
      if (!pending.length) return { embedded: 0, pending: 0 }
      const slice = pending.slice(0, limit)
      let embedded = 0
      for (let offset = 0; offset < slice.length; offset += batchSize) {
        const batch = slice.slice(offset, offset + batchSize)
        const vectorsForBatch = await embedder.embed(batch.map(entryText))
        if (!vectorsForBatch.length) break
        const items = []
        for (let i = 0; i < batch.length; i += 1) {
          const vec = vectorsForBatch[i]
          if (vec?.length) items.push({ id: batch[i].id, sig: embedder.signature, vec })
        }
        if (!items.length) break
        await store.upsertVectors(items)
        embedded += items.length
      }
      if (embedded) markDirty()
      return { embedded, pending: pending.length - embedded }
    } catch (error) {
      logger.warn?.(`vector backfill failed: ${String(error?.message ?? error)}`)
      return { embedded: 0, error: String(error?.message ?? error) }
    } finally {
      backfilling.delete(store.root)
    }
  }

  /** Drop every stored vector and rebuild from scratch (Settings / `/growth reindex`). */
  async function reindexVectors(store) {
    if (!store) return { ok: false, error: '没有可用的记忆库' }
    if (!embedder.available) return { ok: false, error: '未配置嵌入模型' }
    await store.clearVectors()
    const result = await backfillVectors(store, { limit: Number.MAX_SAFE_INTEGER, batchSize: 16 })
    markDirty()
    return { ok: true, ...result }
  }

  function markDirty() {
    digestVersion += 1
    digestCache.clear()
  }

  async function persist() {
    await writeJsonAtomic(settingsFile, { version: 2, updatedAt: new Date().toISOString(), config })
  }

  async function setConfig(patch, { agent, migrate = false } = {}) {
    const previous = config
    const next = normalizeConfig({ ...config, ...(patch ?? {}) }, CONFIG_DEFAULTS)
    let migration = null
    // Scopes are isolated: switching only changes which library is read. Copying is
    // an explicit "migrate: true" request, never an automatic side effect.
    if (migrate && scopeEnabled(previous.scope) && scopeEnabled(next.scope)) {
      try {
        const cwd = agent ? await cwdFor(agent) : currentCwd
        const fromBase = previous.scope === 'workspace' ? activeWorkspaceFor(previous, cwd) : cwd
        // `?? cwd` used to be a last resort here, which silently copied a library
        // into an unselected directory when `workspacePaths` was emptied. An empty
        // whitelist means "no workspace owns this session", so there is no target.
        const toBase = next.scope === 'workspace' ? activeWorkspaceFor(next, cwd) : cwd
        if (next.scope === 'workspace' && !toBase) {
          logger.warn?.('migration skipped: no workspace is selected for this session')
        } else if (fromBase && toBase) {
          const source = storeFor(previous.scope, fromBase)
          await source.ensure()
          const target = storeFor(next.scope, toBase)
          await target.ensure()
          migration = await source.migrateTo(target)
        }
      } catch (error) {
        logger.warn?.(`explicit migration failed: ${String(error?.message ?? error)}`)
      }
    }
    config = next
    for (const store of stores.values()) store.configure(storeOptions())
    refreshEmbedder()
    try {
      await persist()
    } catch (error) {
      logger.warn?.(`settings write failed: ${String(error?.message ?? error)}`)
    }
    markDirty()
    // Provider or model changed: existing vectors are stale, rebuild opportunistically.
    if (embedder.available) {
      if (agent) {
        void storeForAgent(agent)
          .then((store) => backfillVectors(store))
          .catch(() => {})
      }
    }
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
    const queryVector = queryVectorFor(agentId)
    const vectorKey = queryVector ? embedder.signature : ''
    const cached = digestCache.get(agentId)
    if (cached && cached.version === digestVersion && cached.query === query.text && cached.vectors === vectorKey) {
      return cached.text
    }
    const cwd = agentCwd.get(agentId) ?? currentCwd
    // Off, or a session outside the selected workspaces: behave like a vanilla session.
    if (!enabledFor(config, cwd)) {
      digestCache.set(agentId, { version: digestVersion, query: query.text, vectors: vectorKey, text: '' })
      return ''
    }
    const scope = config.scope === 'workspace' ? 'workspace' : 'global'
    const base = scope === 'workspace' ? activeWorkspaceFor(config, cwd) : cwd
    const root = resolveRoot({ scope, cwd: base, home })
    const store = stores.get(root)
    const entries = store?.entriesSync() ?? []
    const { groups, matched } = selectForDigest(entries, {
      tokens: query.tokens,
      config,
      vectors: queryVector ? store?.vectorsSync() : null,
      queryVector,
    })
    const text = buildDigest({ groups, config, root, cwd, queryText: query.text, matched })
    digestCache.set(agentId, { version: digestVersion, query: query.text, vectors: vectorKey, text })
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
    storeForGlobal,
    workspaces: workspaceList,
    /** Whether a session directory reads/writes memory under the current config. */
    enabledFor: (cwd) => enabledFor(config, cwd),
    /** The selected workspace that owns this session directory, if any. */
    activeWorkspace: (cwd) => activeWorkspaceFor(config, cwd),
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
    /** Optional embedding layer: null query vectors mean lexical-only recall. */
    embeddings: () => embedder,
    embedQuery,
    queryVectorFor,
    backfillVectors,
    reindexVectors,
    vectorStats: async (store) => (store ? store.vectorStats() : null),
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
    void cwdFor(agent)
      .then((cwd) => (enabledFor(config, cwd) ? storeForAgent(agent) : null))
      .then(() => markDirty())
      .catch(() => {})
  }

  ctx.on('agent/created', ({ agent }) => {
    mountAgent(agent)
  })

  ctx.on('agent/pre-step', async ({ agent, messages, turn }, next) => {
    if (agent) {
      lastAgentId = agent.id
      if (!agents.has(agent.id)) mountAgent(agent)
      if (Number.isFinite(turn)) lastTurn.set(agent.id, turn)
      const cwd = await cwdFor(agent)
      if (enabledFor(config, cwd)) {
        const query = tokensFromMessages(messages)
        const previous = agentQuery.get(agent.id)
        if (previous?.text !== query.text) {
          agentQuery.set(agent.id, query)
          digestCache.delete(agent.id)
        }
        if (embedder.available && query.text && queryVectorFor(agent.id)?.text !== query.text) {
          void embedQuery(agent.id, query.text).catch(() => {})
        }
        void storeForAgent(agent)
          .then((store) => backfillVectors(store, { limit: 32 }))
          .catch(() => {})
      }
    }
    return next()
  })

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (!agent) return
    const cwd = agentCwd.get(agent.id) ?? currentCwd
    if (!enabledFor(config, cwd)) return
    lastAgentId = agent.id
    if (Number.isFinite(turn)) lastTurn.set(agent.id, turn)
    void runtime.consolidator.run({ agent, turn }).catch(() => {})
  })

  ctx.on('agent/disposed', ({ agent }) => {
    if (!agent) return
    agents.delete(agent.id)
    agentCwd.delete(agent.id)
    agentQuery.delete(agent.id)
    agentVector.delete(agent.id)
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
    refreshEmbedder()
    try {
      if (enabledFor(config, currentCwd)) {
        const scope = config.scope === 'workspace' ? 'workspace' : 'global'
        const base = scope === 'workspace' ? activeWorkspaceFor(config, currentCwd) : currentCwd
        const store = storeFor(scope, base)
        await store.ensure()
        await store.loadVectors()
        if (embedder.available) void backfillVectors(store, { limit: 32 }).catch(() => {})
      }
    } catch (error) {
      logger.warn?.(`memory store init failed: ${String(error?.message ?? error)}`)
    }
    markDirty()
  })()
}
