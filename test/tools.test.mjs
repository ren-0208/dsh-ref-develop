import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CONFIG_DEFAULTS, normalizeConfig } from '../lib/config.js'
import { GrowthStore } from '../lib/store.js'
import { createTools } from '../lib/tools.js'

async function harness({ config = {} } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'growth-tools-'))
  const root = path.join(home, 'global')
  const store = new GrowthStore(root)
  await store.ensure()
  let current = normalizeConfig(config, CONFIG_DEFAULTS)
  let dirty = 0
  const runtime = {
    logger: { warn() {} },
    getConfig: () => current,
    setConfig: async (patch) => {
      current = normalizeConfig({ ...current, ...patch }, current)
      return { config: current, migration: null }
    },
    markDirty: () => {
      dirty += 1
    },
    storeForAgent: async () => store,
    cwdSync: () => 'C:/w',
  }
  const tools = new Map(createTools({ runtime }).map((tool) => [tool.name, tool]))
  const exec = { agent: { id: 'agent-1' } }
  return { home, root, store, runtime, tools, exec, dirtyCount: () => dirty, getConfig: () => current }
}

test('tools expose the documented names and string output contract', async () => {
  const { tools } = await harness()
  for (const name of ['growth_remember', 'growth_recall', 'growth_config', 'growth_status', 'growth_forget', 'growth_edit', 'growth_export']) {
    assert.ok(tools.has(name), `missing tool ${name}`)
  }
  const result = await tools.get('growth_status').execute({}, { agent: { id: 'a' } })
  assert.equal(typeof result, 'string')
  const rendered = tools.get('growth_status').output.render({}, result)
  assert.equal(rendered[0].type, 'text')
  assert.equal(rendered[0].text, result)
})

test('growth_remember writes, growth_recall finds and bumps useCount', async () => {
  const h = await harness()
  const remember = await h.tools.get('growth_remember').execute(
    {
      kind: 'method',
      title: '插件取服务要兼容两种写法',
      body: '真机上 ctx.get("tools") 返回 undefined，先读 ctx.tools 再回退 get。',
      tags: ['cordis', 'dsh'],
      confidence: 0.8,
    },
    h.exec,
  )
  assert.match(remember, /已新增/)
  assert.equal((await h.store.entries()).length, 1)
  assert.ok(h.dirtyCount() > 0)

  const recall = await h.tools.get('growth_recall').execute({ query: 'cordis 插件 服务' }, h.exec)
  assert.match(recall, /匹配 1 条/)
  assert.match(recall, /ctx\.tools/)
  assert.equal((await h.store.entries())[0].useCount, 1)
})

test('growth_remember refuses preferences while personalization is off', async () => {
  const h = await harness()
  const text = await h.tools.get('growth_remember').execute({ kind: 'preference', title: '语言', body: '中文' }, h.exec)
  assert.match(text, /个性化匹配未开启/)
  assert.equal((await h.store.entries()).length, 0)
})

test('growth_config switches scope and reports stats', async () => {
  const h = await harness()
  const text = await h.tools.get('growth_config').execute({ scope: 'workspace', personalization: true }, h.exec)
  assert.match(text, /单工作区/)
  assert.equal(h.getConfig().scope, 'workspace')
  assert.equal(h.getConfig().personalization, true)
})

test('growth_edit and growth_forget round-trip', async () => {
  const h = await harness()
  await h.tools.get('growth_remember').execute({ kind: 'lesson', title: '坑', body: '原始' }, h.exec)
  const [entry] = await h.store.entries()
  const edited = await h.tools.get('growth_edit').execute({ id: entry.id, body: '改过', confidence: 0.9 }, h.exec)
  assert.match(edited, /已更新/)
  assert.equal((await h.store.entries())[0].body, '改过')
  const forgotten = await h.tools.get('growth_forget').execute({ id: entry.id }, h.exec)
  assert.match(forgotten, /rejected/)
  assert.equal((await h.store.entries())[0].status, 'rejected')
})

test('growth_export returns markdown and json', async () => {
  const h = await harness()
  await h.tools.get('growth_remember').execute({ kind: 'wp', title: 'CTF xor 复盘', body: '关键一步：恢复 key' }, h.exec)
  const md = await h.tools.get('growth_export').execute({}, h.exec)
  assert.match(md, /记忆与成长导出/)
  assert.match(md, /CTF xor 复盘/)
  const json = JSON.parse(await h.tools.get('growth_export').execute({ format: 'json' }, h.exec))
  assert.equal(json.entries.length, 1)
  assert.equal(json.version, 2)
})
