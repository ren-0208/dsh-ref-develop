/**
 * Integration test without a real host: a fake Cordis context exercises the same
 * wiring the desktop profile uses (services, events, prompt sections, routes,
 * command) so regressions surface before anything is installed.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function settle(ms = 400) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) await sleep(25)
}

function makeHost({ cwd, sessionEvents, reply }) {
  const sections = []
  const tools = new Map()
  const handlers = new Map()
  let command = null
  let route = null
  const store = { created: [], disposed: 0 }

  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    effect(fn) {
      const disposer = fn()
      store.created.push(disposer)
      return () => {
        store.disposed += 1
        if (typeof disposer === 'function') disposer()
      }
    },
    on(event, listener) {
      handlers.set(event, listener)
      return () => handlers.delete(event)
    },
    get: () => undefined, // property access must win over ctx.get
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    systemPrompt: {
      sections,
      getSectionOrder(name) {
        return name === 'HARNESS_IDENTITY' ? 10 : undefined
      },
      section(definition) {
        sections.push(definition)
        return () => {}
      },
    },
    sessionQuery: {
      readSession: async (id) => ({ events: sessionEvents[id] ?? [] }),
    },
    workingDirectory: {
      defaultDirectory: cwd,
      ensure: async (agent) => agent?.cwd ?? cwd,
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) },
    llm: {
      async *stream() {
        yield { type: 'text-delta', index: 0, text: reply }
      },
    },
    commands: {
      register(definition) {
        command = definition
        return () => {}
      },
    },
    webServer: {
      register(definition) {
        route = definition
        return () => {}
      },
    },
  }
  return { ctx, sections, tools, handlers, store, getCommand: () => command, getRoute: () => route }
}

test('host wiring: sections, tools, command, routes, isolation and API', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'growth-host-'))
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'growth-cwd-'))
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'growth-other-'))
  process.env.DSH_HOME = home

  const agent = { id: 'agent-host', cwd }
  const sessionEvents = {
    'agent-host': [
      { type: 'user/message', data: { turn: 6, content: [{ type: 'text', text: '本机没有 make，怎么编译？' }] } },
      { type: 'tool/call', data: { turn: 6, name: 'bash', arguments: '{"command":"make"}' } },
      { type: 'tool/result', data: { turn: 6, error: 'make: command not found' } },
      { type: 'assistant/message', data: { turn: 6, message: { content: [{ type: 'text', text: '改用 node 版工具链。' }] } } },
    ],
  }
  const reply = JSON.stringify([
    { kind: 'lesson', title: '本机没有 make', body: '在 windows 上用 node 版工具链代替', confidence: 0.7, evidence: [{ quote: '本机没有 make' }] },
  ])

  const host = makeHost({ cwd, sessionEvents, reply })
  const { apply } = await import('../lib/index.js')
  apply(host.ctx, {})

  await settle(200)

  assert.equal(host.sections[0]?.name, 'GROWTH_NOTE')
  assert.equal(host.sections[0]?.order, 60)
  assert.equal(host.tools.size, 7)
  assert.equal(host.getCommand()?.name, 'growth')
  assert.equal(host.getRoute()?.path, '/growth-note/api')
  assert.equal(host.getRoute()?.kind, 'prefix')

  host.handlers.get('agent/created')({ agent })
  await settle(200)
  assert.equal(host.sections.length, 2)

  const digest = () => host.sections[1].text()
  assert.match(digest(), /还没有可用记忆/)

  await host.handlers.get('agent/pre-step')(
    { agent, messages: [{ role: 'user', content: [{ type: 'text', text: 'cordis 服务怎么注入' }] }], turn: 1 },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.match(digest(), /本轮问题：cordis 服务怎么注入/)

  const remember = await host.tools.get('growth_remember').execute(
    { kind: 'method', title: '插件服务优先读 ctx 属性', body: 'ctx.get("tools") 在真机是 undefined，先读属性。', tags: ['cordis'] },
    { agent },
  )
  assert.match(remember, /已新增/)
  assert.match(digest(), /插件服务优先读 ctx 属性/)

  await host.handlers.get('agent/turn-stopping')({ agent, turn: 6 })
  await settle(500)
  const globalRoot = path.join(home, 'growth-note', 'global')
  const memory = await fs.readFile(path.join(globalRoot, 'memory.jsonl'), 'utf8')
  assert.match(memory, /本机没有 make/)
  assert.match(memory, /插件服务优先读 ctx 属性/)

  const status = await host.getCommand().handler({ agent, rawInput: 'status' })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /全局记忆/)

  const server = http.createServer((req, res) => {
    host.getRoute().handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const api = (route, init) => fetch(`${base}/growth-note/api${route}`, init)
  const postConfig = (config) => api('/config', { method: 'POST', body: JSON.stringify({ config }) })
  const state = async () => (await api('/state')).json()

  try {
    const initial = await state()
    assert.equal(initial.enabled, true)
    assert.equal(initial.config.scope, 'global')
    assert.ok(initial.stats.total >= 2)

    // global -> workspace: an isolated, empty library; nothing is copied.
    const switched = await (await postConfig({ ...initial.config, scope: 'workspace', workspacePaths: [cwd] })).json()
    assert.equal(switched.ok, true)
    assert.equal(switched.migration, null)
    assert.equal(switched.enabled, true)

    const workspaceState = await state()
    assert.ok(workspaceState.root.endsWith('.growth-note'))
    assert.equal(workspaceState.stats.total, 0)
    assert.equal(workspaceState.workspacePaths[0], cwd.replace(/\\/g, '/'))

    const created = await api('/entries', {
      method: 'POST',
      body: JSON.stringify({ kind: 'method', title: '工作区专属条目', body: '只在所选工作区里可见' }),
    })
    assert.equal(created.status, 200)
    assert.equal((await state()).stats.total, 1)

    // A session outside the selected workspaces falls back to the default state.
    const inactive = await (await postConfig({ ...(await state()).config, workspacePaths: [other] })).json()
    assert.equal(inactive.enabled, false)
    const inactiveState = await state()
    assert.equal(inactiveState.root, null)
    assert.equal(digest(), '')
    assert.match(
      await host.tools.get('growth_remember').execute({ kind: 'method', title: 'x', body: 'y' }, { agent }),
      /记忆未启用/,
    )
    const refused = await api('/entries', { method: 'POST', body: JSON.stringify({ kind: 'method', title: 'x', body: 'y' }) })
    assert.equal(refused.status, 409)

    // Selecting the session directory again restores the same workspace library.
    await postConfig({ ...(await state()).config, workspacePaths: [cwd] })
    assert.equal((await state()).stats.total, 1)

    // Back to global: its own library is untouched and still everything it had.
    const back = await (await postConfig({ ...(await state()).config, scope: 'global' })).json()
    assert.equal(back.migration, null)
    assert.ok((await state()).stats.total >= 2)

    // off: no injection at all, writes refused, export still browseable.
    await postConfig({ ...(await state()).config, scope: 'off' })
    const offState = await state()
    assert.equal(offState.enabled, false)
    assert.equal(digest(), '')
    assert.equal((await api('/entries', { method: 'POST', body: JSON.stringify({ kind: 'method', title: 'x', body: 'y' }) })).status, 409)

    const exported = await (await api('/export?format=md')).text()
    assert.match(exported, /记忆与成长导出/)

    await postConfig({ ...(await state()).config, scope: 'global' })
    assert.equal((await state()).enabled, true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  await fs.rm(path.join(cwd, '.growth-note'), { recursive: true, force: true })
  await fs.rm(path.join(other, '.growth-note'), { recursive: true, force: true })
  await fs.rm(home, { recursive: true, force: true })
  delete process.env.DSH_HOME
})

test('optional embeddings: off by default, semantic once configured', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'growth-vec-home-'))
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'growth-vec-cwd-'))
  process.env.DSH_HOME = home
  const agent = { id: 'agent-vec', cwd }

  const host = makeHost({ cwd, sessionEvents: {}, reply: '[]' })
  const realFetch = globalThis.fetch
  const embeddingCalls = []
  // Only /embeddings is intercepted; the test's own API calls use the real fetch.
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('/embeddings')) return realFetch(url, init)
    const body = JSON.parse(init.body)
    embeddingCalls.push(body)
    return {
      ok: true,
      async json() {
        return { data: body.input.map((_text, index) => ({ index, embedding: [1, 0, 0] })) }
      },
    }
  }
  try {
    const { apply } = await import('../lib/index.js')
    apply(host.ctx, {})
    await settle(200)
    host.handlers.get('agent/created')({ agent })
    await settle(150)

    const server = http.createServer((req, res) => host.getRoute().handler(req, res))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const api = (route, init) => realFetch(`${base}/growth-note/api${route}`, init)
    const state = async () => (await api('/state')).json()
    const postConfig = (config) => api('/config', { method: 'POST', body: JSON.stringify({ config }) })

    try {
      // Default: no provider, no vectors, purely lexical.
      const initial = await state()
      assert.equal(initial.embedding.provider, 'none')
      assert.equal(initial.embedding.available, false)
      assert.equal(embeddingCalls.length, 0)
      const reindexOff = await api('/embeddings', { method: 'POST', body: JSON.stringify({ op: 'reindex' }) })
      assert.equal(reindexOff.status, 409, 'reindex must be refused without a provider')

      await host.tools.get('growth_remember').execute(
        { kind: 'knowledge', title: '向量检索接入方式', body: 'OpenAI 兼容 /embeddings，向量存 vectors.jsonl' },
        { agent },
      )
      const lexicalOnly = await (await api('/recall', { method: 'POST', body: JSON.stringify({ query: '解耦的无关键词查询' }) })).json()
      assert.equal(lexicalOnly.semantic, false)

      // Configure a provider: the config write triggers a background backfill.
      const saved = await (await postConfig({ ...initial.config, embeddingProvider: 'openai', embeddingModel: 'fake-embed', embeddingApiKey: 'k' })).json()
      assert.equal(saved.ok, true)
      await settle(400)

      const withVectors = await state()
      assert.equal(withVectors.embedding.provider, 'openai')
      assert.equal(withVectors.embedding.available, true)
      assert.equal(withVectors.embedding.signature, 'openai:fake-embed')
      assert.ok(withVectors.embedding.vectors.covered >= 1, 'entry should be indexed')
      assert.ok(embeddingCalls.length >= 1, 'the provider must actually be called')

      const semanticRecall = await (await api('/recall', { method: 'POST', body: JSON.stringify({ query: '完全不同的措辞' }) })).json()
      assert.equal(semanticRecall.semantic, true)
      assert.ok(semanticRecall.items.length >= 1)
      assert.ok(semanticRecall.items[0].semantic > 0.9)

      // Rebuild: clears then re-embeds, and stays consistent with active entries.
      const reindexed = await (await api('/embeddings', { method: 'POST', body: JSON.stringify({ op: 'reindex' }) })).json()
      assert.equal(reindexed.ok, true)
      assert.ok(reindexed.vectors.covered >= 1)
      assert.equal(reindexed.vectors.covered, reindexed.vectors.active)

      // Clear drops the index but keeps every memory.
      const cleared = await (await api('/embeddings', { method: 'POST', body: JSON.stringify({ op: 'clear' }) })).json()
      assert.equal(cleared.ok, true)
      const afterClear = await state()
      assert.equal(afterClear.embedding.vectors.total, 0)
      assert.ok(afterClear.stats.total >= 1, 'memories must survive clearing the index')

      // Back to lexical-only.
      await postConfig({ ...(await state()).config, embeddingProvider: 'none' })
      assert.equal((await state()).embedding.available, false)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  } finally {
    globalThis.fetch = realFetch
    await fs.rm(path.join(cwd, '.growth-note'), { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
    delete process.env.DSH_HOME
  }
})
