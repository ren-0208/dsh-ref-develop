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
  async function state() {
    const config = runtime.getConfig()
    const agent = runtime.agentForApi()
    const store = await runtime.storeForAgent(agent)
    const stats = await store.stats()
    return {
      ok: true,
      config,
      scopeLabel: SCOPE_LABEL[config.scope],
      root: stats.root,
      stats,
      workspaces: runtime.workspaces ? runtime.workspaces() : [],
      activeWorkspacePath: config.scope === 'workspace' ? config.workspacePath || runtime.cwdSync?.() || null : null,
      model: Boolean(runtime.llm() && runtime.currentSelection()?.model),
      activeAgent: agent?.id ?? null,
    }
  }

  /** A workspace store chosen by `?path=` wins over the active scope (read-only inspection). */
  async function storeForQuery(query) {
    const path = String(query.get('path') ?? '').trim()
    if (path) return runtime.storeForWorkspace(path)
    return runtime.storeForAgent(runtime.agentForApi())
  }

  async function entries(query) {
    const config = runtime.getConfig()
    const store = await storeForQuery(query)
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
        const list = (await store.load()).filter((entry) => entry.status === 'active')
        const ranked = rankEntries(list, { tokens: tokenize(body.query ?? ''), halfLifeDays: config.halfLifeDays, minConfidence: 0 })
        const top = ranked.slice(0, Math.min(20, Math.max(1, Number(body.limit) || 6)))
        await store.touchEntry(top.map((item) => item.entry.id))
        send(res, 200, { ok: true, items: top.map((item) => ({ id: item.entry.id, title: item.entry.title, kind: item.entry.kind, body: oneLine(item.entry.body, 400), score: Number(item.score.toFixed(2)) })) })
        return true
      }
      if (route === '/config' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const next = normalizeConfig(body?.config ?? body, runtime.getConfig())
        const change = await runtime.setConfig(next, { agent: runtime.agentForApi() })
        runtime.markDirty()
        send(res, 200, { ok: true, config: runtime.getConfig(), migration: change?.migration ?? null })
        return true
      }
      if (route === '/entries' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const store = await runtime.storeForAgent(runtime.agentForApi())
        const config = runtime.getConfig()
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
        const config = runtime.getConfig()
        const events = await runtime.readTurnEvents(agent, undefined)
        const result = await runtime.consolidator.run({ agent, turn: runtime.currentTurn(agent), events, force: config.autoSummarize })
        send(res, 200, { ok: true, result })
        return true
      }
      if (route === '/export' && method === 'GET') {
        const store = await storeForQuery(url.searchParams)
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
