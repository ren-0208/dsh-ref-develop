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

test('host wiring: sections, tools, command, routes, events and API', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'growth-host-'))
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'growth-cwd-'))
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

  // Boot is async; wait for the settings file read and store warm-up.
  await settle(200)

  assert.equal(host.sections[0]?.name, 'GROWTH_NOTE')
  assert.equal(host.sections[0]?.order, 60)
  assert.equal(host.tools.size, 7)
  assert.equal(host.getCommand()?.name, 'growth')
  assert.equal(host.getRoute()?.path, '/growth-note/api')
  assert.equal(host.getRoute()?.kind, 'prefix')

  // agent/created registers the scoped section and warms the store.
  host.handlers.get('agent/created')({ agent })
  await settle(200)
  assert.equal(host.sections.length, 2)
  assert.equal(host.sections[1].name, 'GROWTH_NOTE')

  const digest = () => host.sections[1].text()
  assert.match(digest(), /还没有可用记忆/)
  assert.match(digest(), /记忆目录/)

  // pre-step feeds the current question into recall.
  const next = async () => ({ kind: 'enter', messages: [] })
  await host.handlers.get('agent/pre-step')(
    { agent, messages: [{ role: 'user', content: [{ type: 'text', text: 'cordis 服务怎么注入' }] }], turn: 1 },
    next,
  )
  assert.match(digest(), /本轮问题：cordis 服务怎么注入/)

  // growth_remember writes, and the next digest render sees the entry.
  const remember = await host.tools.get('growth_remember').execute(
    { kind: 'method', title: '插件服务优先读 ctx 属性', body: 'ctx.get("tools") 在真机是 undefined，先读属性。', tags: ['cordis'] },
    { agent },
  )
  assert.match(remember, /已新增/)
  assert.match(digest(), /插件服务优先读 ctx 属性/)

  // turn-stopping: session note + model distillation (fake LLM).
  await host.handlers.get('agent/turn-stopping')({ agent, turn: 6 })
  await settle(500)
  const globalRoot = path.join(home, 'growth-note', 'global')
  const memory = await fs.readFile(path.join(globalRoot, 'memory.jsonl'), 'utf8')
  assert.match(memory, /本机没有 make/)
  assert.match(memory, /插件服务优先读 ctx 属性/)

  // The slash command reads the same state.
  const status = await host.getCommand().handler({ agent, rawInput: 'status' })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /全局记忆/)

  // The settings API over real HTTP.
  const server = http.createServer((req, res) => {
    host.getRoute().handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const state = await (await fetch(`${base}/growth-note/api/state`)).json()
    assert.equal(state.ok, true)
    assert.equal(state.config.scope, 'global')
    assert.ok(state.stats.total >= 2)
    assert.ok(Array.isArray(state.workspaces), 'state.workspaces must be a list')

    const list = await (await fetch(`${base}/growth-note/api/entries?q=make`)).json()
    assert.ok(list.entries.some((entry) => entry.title.includes('make')))

    const switched = await (
      await fetch(`${base}/growth-note/api/config`, { method: 'POST', body: JSON.stringify({ config: { ...state.config, scope: 'workspace' } }) })
    ).json()
    assert.equal(switched.ok, true)
    assert.equal(switched.config.scope, 'workspace')
    assert.equal(switched.migration.added, 2)

    const workspaceState = await (await fetch(`${base}/growth-note/api/state`)).json()
    assert.ok(workspaceState.root.endsWith('.growth-note'))
    assert.equal(workspaceState.stats.total, 2)

    // Selecting another already-known workspace switches the directory only:
    // no migration between workspaces, so the new one starts empty.
    const otherCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'growth-cwd2-'))
    const picked = await (
      await fetch(`${base}/growth-note/api/config`, {
        method: 'POST',
        body: JSON.stringify({ config: { ...switched.config, workspacePath: otherCwd } }),
      })
    ).json()
    assert.equal(picked.ok, true)
    assert.equal(picked.migration, null, 'workspace -> workspace must not migrate')
    const pickedState = await (await fetch(`${base}/growth-note/api/state`)).json()
    assert.equal(pickedState.root, path.join(otherCwd, '.growth-note'))
    assert.equal(pickedState.stats.total, 0)
    await fs.rm(path.join(otherCwd, '.growth-note'), { recursive: true, force: true })
    await fs.rm(otherCwd, { recursive: true, force: true })

    const exported = await (await fetch(`${base}/growth-note/api/export?format=md`)).text()
    assert.match(exported, /记忆与成长导出/)

    const rejected = await fetch(`${base}/growth-note/api/entries`, { method: 'POST', body: JSON.stringify({ kind: 'preference', title: 'x', body: 'y' }) })
    assert.equal(rejected.status, 400)

    // Turning memory off: no injection, no writes, no distillation. Stored data stays.
    const offSwitch = await (
      await fetch(`${base}/growth-note/api/config`, { method: 'POST', body: JSON.stringify({ config: { ...pickedState.config, scope: 'off' } }) })
    ).json()
    assert.equal(offSwitch.ok, true)
    assert.equal(offSwitch.config.scope, 'off')
    const offState = await (await fetch(`${base}/growth-note/api/state`)).json()
    assert.equal(offState.enabled, false)
    assert.match(digest(), /记忆已关闭/)

    const refusedOff = await host.tools.get('growth_remember').execute({ kind: 'method', title: '不该写入', body: '关闭时不许写' }, { agent })
    assert.match(refusedOff, /记忆已关闭/)
    const consolidateOff = await fetch(`${base}/growth-note/api/consolidate`, { method: 'POST', body: JSON.stringify({}) })
    assert.equal(consolidateOff.status, 409)

    // turn-stopping must not even touch a store while off (no directory created).
    await host.handlers.get('agent/turn-stopping')({ agent, turn: 7 })
    await settle(200)
    await assert.rejects(fs.access(path.join(otherCwd, '.growth-note')), 'off must not create a store')

    // Switching back restores the global library untouched (no migration happened).
    const back = await (
      await fetch(`${base}/growth-note/api/config`, { method: 'POST', body: JSON.stringify({ config: { ...pickedState.config, scope: 'global' } }) })
    ).json()
    assert.equal(back.ok, true)
    assert.equal(back.migration, null, 'off -> global must not migrate')
    const backState = await (await fetch(`${base}/growth-note/api/state`)).json()
    assert.equal(backState.enabled, true)
    assert.equal(backState.stats.total, 2)
    assert.match(digest(), /插件服务优先读 ctx 属性/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  // Remove the workspace memory the test created (no stray dirs in the repo).
  await fs.rm(path.join(cwd, '.growth-note'), { recursive: true, force: true })
  await fs.rm(home, { recursive: true, force: true })
  delete process.env.DSH_HOME
})
