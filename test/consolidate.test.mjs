import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildSessionNote, Consolidator, eventsText, extractJsonArray, validateItems } from '../lib/consolidate.js'
import { CONFIG_DEFAULTS } from '../lib/config.js'
import { GrowthStore } from '../lib/store.js'

const events = [
  { type: 'user/message', data: { content: [{ type: 'text', text: '帮我在 windows 上编译这个 C 项目' }] } },
  { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"make"}' } },
  { type: 'tool/result', data: { error: 'make: command not found' } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '本机没有 make，改用 node 版工具链。' }] } } },
]

test('buildSessionNote keeps requests, actions and tool failures', () => {
  const note = buildSessionNote({ sessionId: 's1', turn: 3, events, cwd: 'C:/w' })
  assert.match(note, /## turn 3/)
  assert.match(note, /### 诉求/)
  assert.match(note, /编译这个 C 项目/)
  assert.match(note, /工具 bash/)
  assert.match(note, /make: command not found/)
  assert.match(note, /node 版工具链/)
})

test('buildSessionNote is bounded', () => {
  const many = Array.from({ length: 200 }, (_, index) => ({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: `第 ${index} 行`.repeat(20) }] } },
  }))
  const note = buildSessionNote({ sessionId: 's1', turn: 1, events: many })
  assert.ok(note.length <= 6100)
})

test('extractJsonArray survives fences and prose', () => {
  assert.deepEqual(extractJsonArray('好的：\n```json\n[{"a":1}]\n```\n以上'), [{ a: 1 }])
  assert.deepEqual(extractJsonArray('no json'), [])
  assert.deepEqual(extractJsonArray('[broken'), [])
})

test('validateItems verifies verbatim evidence and halves unverified confidence', () => {
  const transcript = '用户说：make 在本机不可用。助手改成 node 脚本。'
  const items = validateItems(
    [
      { kind: 'lesson', title: 'make 不可用', body: '用 node 脚本代替', confidence: 0.8, evidence: [{ quote: 'make 在本机不可用' }] },
      { kind: 'lesson', title: '编造的一条', body: 'x', confidence: 0.8, evidence: [{ quote: '这句话记录里没有' }] },
    ],
    transcript,
  )
  assert.equal(items.length, 2)
  assert.equal(items[0].verified, true)
  assert.equal(items[0].confidence, 0.8)
  assert.equal(items[1].verified, false)
  assert.equal(items[1].confidence, 0.4)
})

test('validateItems drops preferences when personalization is off', () => {
  const items = validateItems(
    [{ kind: 'preference', title: '语言', body: '中文', evidence: [{ quote: '用中文' }] }],
    '用中文回答',
  )
  assert.equal(items.length, 0)
})

test('validateItems caps at eight items', () => {
  const items = validateItems(
    Array.from({ length: 12 }, (_, index) => ({ kind: 'knowledge', title: `k${index}`, body: 'b', evidence: [{ quote: 'x' }] })),
    'x',
  )
  assert.equal(items.length, 8)
})

function fakeRuntime(store, { selection = { provider: 'p', model: 'm' }, reply } = {}) {
  const config = { ...CONFIG_DEFAULTS, personalization: false }
  return {
    logger: { warn() {} },
    getConfig: () => config,
    markDirty() {},
    storeForAgent: async () => store,
    cwdFor: async () => 'C:/w',
    readTurnEvents: async () => events,
    llm: () => ({
      async *stream() {
        yield { type: 'text-delta', index: 0, text: reply }
      },
    }),
    currentSelection: () => selection,
  }
}

async function tempStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'growth-consolidate-'))
  const store = new GrowthStore(root)
  await store.ensure()
  return store
}

test('Consolidator stores verified entries once and writes the session note', async () => {
  const store = await tempStore()
  const reply = JSON.stringify([
    {
      kind: 'lesson',
      title: '本机没有 make',
      body: '改用 node 版工具链，别直接跑 make',
      confidence: 0.7,
      evidence: [{ quote: '本机没有 make' }],
    },
  ])
  const runtime = fakeRuntime(store, { reply })
  const consolidator = new Consolidator(runtime)
  const agent = { id: 'agent-1' }
  const result = await consolidator.run({ agent, turn: 6, force: true })
  assert.equal(result.stored, 1)
  assert.equal(result.reason, undefined)

  const entries = await store.entries()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].verified, true)
  const notes = await store.readSessionNotes('agent-1', 4)
  assert.match(notes, /## turn 6/)

  const duplicate = await consolidator.run({ agent, turn: 6 })
  assert.equal(duplicate.reason, 'duplicate')
  assert.equal((await store.entries()).length, 1)
})

test('Consolidator degrades gracefully without a model', async () => {
  const store = await tempStore()
  const runtime = { ...fakeRuntime(store), llm: () => null, currentSelection: () => null }
  const result = await new Consolidator(runtime).run({ agent: { id: 'a2' }, turn: 6, force: true })
  assert.equal(result.reason, 'no-model')
  assert.equal((await store.entries()).length, 0)
  assert.match(await store.readSessionNotes('a2', 2), /turn 6/)
})

test('Consolidator only distills on the configured cadence', async () => {
  const store = await tempStore()
  const runtime = fakeRuntime(store, { reply: '[]' })
  const consolidator = new Consolidator(runtime)
  const agent = { id: 'a3' }
  const early = await consolidator.run({ agent, turn: 2 })
  assert.equal(early.reason, 'not-yet')
  assert.match(await store.readSessionNotes('a3', 2), /turn 2/)
})

test('evidence is verified against raw events, not the lossy note', () => {
  // Regression: notes truncate each user line to 400 chars. A model quoting the
  // transcript it actually saw was marked unverified (confidence halved) because
  // the note summariser had already trimmed the quote away.
  const longUser = `${'A'.repeat(880)}正确的结论是先做最小复现再扩大到全量数据${'B'.repeat(300)}`
  const quote = '正确的结论是先做最小复现再扩大到全量数据'
  const turnEvents = [{ type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: longUser }] } }]
  const note = buildSessionNote({ sessionId: 's', turn: 1, events: turnEvents })
  const item = { kind: 'method', title: 't', body: 'b', confidence: 0.8, evidence: [{ quote }] }

  const viaNote = validateItems([item], note)
  assert.equal(viaNote[0].verified, false, 'the note really did drop the quote')

  const viaEvents = validateItems([item], eventsText(turnEvents))
  assert.equal(viaEvents[0].verified, true)
  assert.equal(viaEvents[0].confidence, 0.8)
})

test('eventsText reads message text but not tool arguments', () => {
  const text = eventsText([
    { type: 'user/message', data: { content: [{ type: 'text', text: '诉求正文' }] } },
    { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"huge payload"}' } },
    { type: 'tool/result', data: { error: '命令失败原因' } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '助手结论' }] } } },
  ])
  assert.match(text, /诉求正文/)
  assert.match(text, /命令失败原因/)
  assert.match(text, /助手结论/)
  assert.doesNotMatch(text, /huge payload/)
})
