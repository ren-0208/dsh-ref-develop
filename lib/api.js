/**
 * Local HTTP API for the settings page.
 *
 * The Web UI has no generic host RPC for plugins, so the section fetches these
 * same-origin endpoints. They are loopback-only by construction (the host binds
 * 127.0.0.1) and additionally refuse obviously cross-site requests.
 */
import { SCOPE_LABEL, normalizeConfig } from './config.js'
import { rankEntries } from './recall.js'
import { oneLine, tokenize } from './util.js'

const PREFIX = '/growth-note/api'
const MAX_BODY = 256 * 1024

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sameSite(req) {
  const origin = req.headers?.origin
  if (!origin) return true
  try {
    const host = new URL(origin).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

export function createApiHandler({ runtime }) {
  function currentEnabled() {
    const cwd = runtime.cwdSync?.() || ''
    return runtime.enabledFor ? runtime.enabledFor(cwd) : runtime.getConfig().scope !== 'off'
  }

  async function state() {
    const config = runtime.getConfig()
    const agent = runtime.agentForApi()
    const cwd = runtime.cwdSync?.() || ''
    const enabled = currentEnabled()
    const store = await runtime.storeForAgent(agent)
    const stats = store ? await store.stats() : null
    const embedder = runtime.embeddings?.()
    let vectors = null
    try {
      vectors = store ? await store.vectorStats() : null
    } catch {
      vectors = null
    }
    return {
      ok: true,
      config,
      enabled,
      scopeLabel: SCOPE_LABEL[config.scope],
      workspacePaths: config.workspacePaths ?? [],
      activeWorkspacePath: runtime.activeWorkspace ? runtime.activeWorkspace(cwd) : null,
      root: stats?.root ?? null,
      stats,
      embedding: {
        provider: config.embeddingProvider ?? 'none',
        model: config.embeddingModel ?? '',
        baseUrl: embedder?.baseUrl ?? '',
        available: Boolean(embedder?.available),
        signature: embedder?.signature ?? '',
        vectors,
      },
      workspaces: runtime.workspaces ? runtime.workspaces() : [],
      model: Boolean(runtime.llm() && runtime.currentSelection()?.model),
      activeAgent: agent?.id ?? null,
    }
  }

  /** Fall back to a browsable library when the current session has memory disabled. */
  async function browseStore() {
    const config = runtime.getConfig()
    const path = (config.workspacePaths ?? [])[0]
    if (path) return runtime.storeForWorkspace(path)
    return runtime.storeForGlobal ? runtime.storeForGlobal() : null
  }

  /** A workspace store chosen by `?path=` wins over the active scope (read-only inspection). */
  async function storeForQuery(query) {
    const path = String(query.get('path') ?? '').trim()
    if (path) return runtime.storeForWorkspace(path)
    const store = await runtime.storeForAgent(runtime.agentForApi())
    return store ?? (await browseStore())
  }

  async function entries(query) {
    const config = runtime.getConfig()
    const store = await storeForQuery(query)
    if (!store) return { ok: true, total: 0, entries: [] }
    const all = await store.load()
    const q = String(query.get('q') ?? '').trim()
    const kind = String(query.get('kind') ?? '')
    const archived = query.get('archived') === '1'
    const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 200))
    let list = all.filter((entry) => (archived ? true : entry.status === 'active'))
    if (kind) list = list.filter((entry) => entry.kind === kind)
    if (q) {
      const tokens = tokenize(q)
      const ranked = rankEntries(list, { tokens, halfLifeDays: config.halfLifeDays, minConfidence: 0 })
      list = ranked.map((item) => item.entry)
    } else {
      list = [...list].sort((a, b) => Date.parse(b.updatedAt ?? 0) - Date.parse(a.updatedAt ?? 0))
    }
    return {
      ok: true,
      total: list.length,
      entries: list.slice(0, limit).map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        body: entry.body,
        tags: entry.tags ?? [],
        meta: entry.meta ?? {},
        confidence: entry.confidence,
        status: entry.status,
        useCount: entry.useCount ?? 0,
        verified: entry.verified === true,
        evidence: (entry.evidence ?? []).map((item) => item.quote),
        updatedAt: entry.updatedAt,
      })),
    }
  }

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith(PREFIX)) return false
    if (!sameSite(req)) {
      send(res, 403, { ok: false, error: 'cross-site request rejected' })
      return true
    }
    const route = url.pathname.slice(PREFIX.length) || '/'
    const method = (req.method ?? 'GET').toUpperCase()
    try {
      if (route === '/state' && method === 'GET') {
        send(res, 200, await state())
        return true
      }
      if (route === '/entries' && method === 'GET') {
        send(res, 200, await entries(url.searchParams))
        return true
      }
      if (route === '/recall' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const config = runtime.getConfig()
        const store = await runtime.storeForAgent(runtime.agentForApi())
        if (!store) {
          send(res, 200, { ok: true, items: [], inactive: true })
          return true
        }
        const list = (await store.load()).filter((entry) => entry.status === 'active')
        const embedder = runtime.embeddings?.()
        let queryVector = null
        if (embedder?.available && body.query) {
          const embedded = await embedder.embed([oneLine(body.query, 2000)])
          queryVector = embedded[0]?.length ? embedded[0] : null
        }
        const ranked = rankEntries(list, {
          tokens: tokenize(body.query ?? ''),
          halfLifeDays: config.halfLifeDays,
          minConfidence: 0,
          vectors: queryVector ? await store.loadVectors() : null,
          queryVector,
        })
        const top = ranked.slice(0, Math.min(20, Math.max(1, Number(body.limit) || 6)))
        await store.touchEntry(top.map((item) => item.entry.id))
        send(res, 200, {
          ok: true,
          semantic: Boolean(queryVector),
          items: top.map((item) => ({
            id: item.entry.id,
            title: item.entry.title,
            kind: item.entry.kind,
            body: oneLine(item.entry.body, 400),
            score: Number(item.score.toFixed(2)),
            lexical: Number(item.lexical.toFixed(2)),
            semantic: Number(item.semantic.toFixed(3)),
          })),
        })
        return true
      }
      if (route === '/embeddings' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const store = await storeForQuery(new URLSearchParams(body.path ? `path=${encodeURIComponent(body.path)}` : ''))
        if (!store) {
          send(res, 409, { ok: false, error: '记忆未启用：没有可用的记忆库。' })
          return true
        }
        if (body.op === 'clear') {
          await store.clearVectors()
          runtime.markDirty()
          send(res, 200, { ok: true, cleared: true })
          return true
        }
        const result = await runtime.reindexVectors(store)
        if (!result?.ok) {
          send(res, 409, { ok: false, error: result?.error ?? '重建失败' })
          return true
        }
        send(res, 200, { ok: true, result, vectors: await store.vectorStats() })
        return true
      }
      if (route === '/config' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const next = normalizeConfig(body?.config ?? body, runtime.getConfig())
        const change = await runtime.setConfig(next, { agent: runtime.agentForApi(), migrate: body?.migrate === true })
        runtime.markDirty()
        send(res, 200, {
          ok: true,
          config: runtime.getConfig(),
          enabled: currentEnabled(),
          workspacePaths: runtime.getConfig().workspacePaths ?? [],
          activeWorkspacePath: runtime.activeWorkspace ? runtime.activeWorkspace(runtime.cwdSync?.() || '') : null,
          migration: change?.migration ?? null,
        })
        return true
      }
      if (route === '/entries' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const store = await runtime.storeForAgent(runtime.agentForApi())
        const config = runtime.getConfig()
        if (!store) {
          send(res, 409, { ok: false, error: '记忆未启用：当前范围是「无」，或本会话目录不在所选工作区内。' })
          return true
        }
        if (body.op === 'delete') {
          const removed = await store.removeEntry(String(body.id ?? ''), { soft: body.hard !== true })
          runtime.markDirty()
          send(res, removed ? 200 : 404, removed ? { ok: true, removed } : { ok: false, error: 'not found' })
          return true
        }
        if (body.op === 'edit') {
          const updated = await store.updateEntry(String(body.id ?? ''), body.patch ?? {})
          runtime.markDirty()
          send(res, updated ? 200 : 404, updated ? { ok: true, entry: updated } : { ok: false, error: 'not found' })
          return true
        }
        if (!body.op && !store) {
          send(res, 409, { ok: false, error: '记忆未启用：先切回全局或选中本会话所在的工作区再新增条目。' })
          return true
        }
        if (body.kind === 'preference' && !config.personalization) {
          send(res, 400, { ok: false, error: '个性化匹配未开启：先在设置里打开，再记录画像。' })
          return true
        }
        const result = await store.addEntry(
          {
            kind: body.kind,
            title: body.title,
            body: body.body,
            tags: body.tags,
            confidence: body.confidence,
            meta: body.meta,
            source: { sessionId: 'settings-page' },
          },
          { maxEntries: config.maxEntries, dedupeThreshold: config.dedupeThreshold, promoteLessonAfter: config.promoteLessonAfter },
        )
        runtime.markDirty()
        send(res, 200, { ok: true, merged: result.merged, entry: result.entry })
        return true
      }
      if (route === '/consolidate' && method === 'POST') {
        const agent = runtime.agentForApi()
        if (!agent) {
          send(res, 409, { ok: false, error: '当前没有活动会话，无法立即总结' })
          return true
        }
        if (!(await runtime.storeForAgent(agent))) {
          send(res, 409, { ok: false, error: '记忆未启用：当前范围是「无」，或本会话目录不在所选工作区内。' })
          return true
        }
        const config = runtime.getConfig()
        // Scope the read to the current turn: an unscoped read deserialises the
        // whole session just to summarise one turn.
        const turn = runtime.currentTurn(agent)
        const events = await runtime.readTurnEvents(agent, turn)
        const result = await runtime.consolidator.run({ agent, turn, events, force: config.autoSummarize })
        send(res, 200, { ok: true, result })
        return true
      }
      if (route === '/export' && method === 'GET') {
        const store = await storeForQuery(url.searchParams)
        if (!store) {
          send(res, 409, { ok: false, error: '记忆未启用：没有可导出的记忆库。' })
          return true
        }
        const format = url.searchParams.get('format') === 'json' ? 'json' : 'md'
        const body = format === 'json' ? JSON.stringify(await store.exportJson(), null, 2) : await store.exportMarkdown()
        send(res, 200, body, format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8')
        return true
      }
      send(res, 404, { ok: false, error: `unknown route ${method} ${route}` })
      return true
    } catch (error) {
      send(res, 500, { ok: false, error: String(error?.message ?? error) })
      return true
    }
  }
}

export { PREFIX }
