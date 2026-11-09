import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { GrowthStore, resolveRoot, settingsFilePath, resolveDshHome } from '../lib/store.js'

async function tempStore(options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'growth-store-'))
  const root = path.join(home, 'global')
  const store = new GrowthStore(root, options)
  await store.ensure()
  return { home, root, store }
}

test('ensure creates the documented layout', async () => {
  const { root, store } = await tempStore()
  const files = await fs.readdir(root)
  assert.ok(files.includes('AGENTS.md'))
  assert.ok(files.includes('memory.jsonl'))
  assert.ok(files.includes('store.json'))
  assert.ok(files.includes('MEMORY'))
  assert.ok(files.includes('sessions'))
  const views = await fs.readdir(path.join(root, 'MEMORY'))
  for (const name of ['INDEX.md', 'PLAYBOOK.md', 'KNOWLEDGE.md', 'PERSONA.md', 'SESSIONS.md', 'WP']) {
    assert.ok(views.includes(name), `missing view ${name}`)
  }
  assert.deepEqual(await store.entries(), [])
})

test('addEntry stores, dedupes by key and merges', async () => {
  const { store } = await tempStore()
  const first = await store.addEntry({ kind: 'method', title: '先读 INDEX', body: '打开工作区先看 MEMORY/INDEX.md' })
  assert.equal(first.merged, false)
  const second = await store.addEntry({ kind: 'method', title: '先读 INDEX', body: '再动手之前先读 INDEX' })
  assert.equal(second.merged, true)
  assert.equal(second.entry.id, first.entry.id)
  const entries = await store.entries()
  assert.equal(entries.length, 1)
  assert.match(entries[0].body, /再动手之前/)
})

test('concurrent writes are serialized and never corrupt the file', async () => {
  const { store, root } = await tempStore()
  const topics = ['zstd', 'cordis', 'vite', 'esbuild', 'ripgrep', 'powershell', 'wsl', 'git', 'pnpm', 'node', 'docker', 'nginx']
  await Promise.all(
    topics.map((topic) =>
      store.addEntry({ kind: 'knowledge', title: `关于 ${topic} 的结论`, body: `在 ${topic} 场景下要检查配置与环境变量，来源 ${topic} 文档`, tags: [topic] }),
    ),
  )
  const text = await fs.readFile(path.join(root, 'memory.jsonl'), 'utf8')
  const lines = text.trim().split('\n')
  assert.equal(lines.length, 12)
  for (const line of lines) JSON.parse(line)
  assert.equal((await store.entries()).length, 12)
})

test('preference supersedes an older value for the same aspect', async () => {
  const { store } = await tempStore()
  await store.addEntry({ kind: 'preference', title: '语言偏好', body: '中文', meta: { aspect: 'language', value: 'zh' } })
  await store.addEntry({ kind: 'preference', title: '语言偏好', body: '英文', meta: { aspect: 'language', value: 'en' } })
  const entries = await store.entries()
  const active = entries.filter((entry) => entry.status === 'active')
  assert.equal(active.length, 1)
  assert.equal(active[0].body, '英文')
  const superseded = entries.find((entry) => entry.status === 'superseded')
  assert.ok(superseded)
  assert.equal(superseded.supersededBy, active[0].id)
})

test('lesson promotion happens on insert once threshold is reached', async () => {
  const { store } = await tempStore()
  await store.addEntry({
    kind: 'lesson',
    title: 'make 不可用',
    body: 'make 报 command not found',
    evidence: [{ quote: 'a' }, { quote: 'b' }, { quote: 'c' }],
    meta: { trigger: '编译 C 项目', fix: '用 node 版 make' },
  }, { promoteLessonAfter: 3 })
  const entries = await store.entries()
  assert.equal(entries.length, 2)
  const method = entries.find((entry) => entry.kind === 'method')
  assert.ok(method)
  assert.equal(method.promotedFrom, entries.find((entry) => entry.kind === 'lesson').id)
})

test('pruning keeps preferences/state and drops the weakest when over budget', async () => {
  const { store } = await tempStore({ maxEntries: 3 })
  for (let index = 0; index < 6; index += 1) {
    await store.addEntry({ kind: 'knowledge', title: `k${index}`, body: 'b', confidence: 0.4 + index * 0.05 })
  }
  await store.addEntry({ kind: 'preference', title: 'p', body: 'v', meta: { aspect: 'x', value: 'y' } })
  await store.addEntry({ kind: 'state', title: 's', body: 'current' })
  const entries = await store.entries()
  assert.ok(entries.length <= 3)
  const kinds = entries.map((entry) => entry.kind)
  assert.ok(kinds.includes('preference'))
  assert.ok(kinds.includes('state'))
})

test('soft remove keeps evidence, hard remove drops it', async () => {
  const { store } = await tempStore()
  const { entry } = await store.addEntry({ kind: 'lesson', title: 't', body: 'b' })
  await store.removeEntry(entry.id, { soft: true })
  const soft = await store.entries()
  assert.equal(soft[0].status, 'rejected')
  await store.removeEntry(entry.id, { soft: false })
  assert.deepEqual(await store.entries(), [])
})

test('touchEntry bumps useCount and lastUsedAt', async () => {
  const { store } = await tempStore()
  const { entry } = await store.addEntry({ kind: 'method', title: 't', body: 'b' })
  await store.touchEntry([entry.id])
  const [touched] = await store.entries()
  assert.equal(touched.useCount, 1)
  assert.ok(touched.lastUsedAt)
})

test('session notes are appended and only logged once', async () => {
  const { store, root } = await tempStore()
  await store.appendSessionNote('s1', '## turn 1\n\n- 用户：hi\n', { turn: 1 })
  await store.appendSessionNote('s1', '## turn 2\n\n- 用户：again\n', { turn: 2 })
  const notes = await store.readSessionNotes('s1', 6)
  assert.match(notes, /turn 1/)
  assert.match(notes, /turn 2/)
  assert.equal(await store.sessionCount(), 1)
  const log = await fs.readFile(path.join(root, 'MEMORY', 'SESSIONS.md'), 'utf8')
  assert.equal(log.match(/`s1`/g).length, 1)
})

test('render writes markdown views with the right sections', async () => {
  const { store, root } = await tempStore()
  await store.addEntry({ kind: 'method', title: '先读 INDEX', body: 'b' })
  await store.addEntry({ kind: 'wp', title: 'CTF 反转题', body: '关键一步：看 xor key', meta: { platform: 'CTF', category: 'reverse' } })
  await store.render()
  const playbook = await fs.readFile(path.join(root, 'MEMORY', 'PLAYBOOK.md'), 'utf8')
  assert.match(playbook, /可复用方法/)
  assert.match(playbook, /先读 INDEX/)
  const wp = await fs.readFile(path.join(root, 'MEMORY', 'WP', 'INDEX.md'), 'utf8')
  assert.match(wp, /CTF 反转题/)
  const persona = await fs.readFile(path.join(root, 'MEMORY', 'PERSONA.md'), 'utf8')
  assert.match(persona, /用户画像/)
})

test('migrateTo copies active entries and session files', async () => {
  const { store, home } = await tempStore()
  await store.addEntry({ kind: 'method', title: 'm1', body: 'b1' })
  const { entry } = await store.addEntry({ kind: 'lesson', title: 'l1', body: 'b2' })
  await store.removeEntry(entry.id, { soft: true })
  await store.appendSessionNote('s1', '## turn 1\n\nx\n')

  const target = new GrowthStore(path.join(home, 'workspace-memory'))
  await target.ensure()
  const result = await store.migrateTo(target)
  assert.equal(result.added, 1)
  assert.equal(result.sessionFiles, 1)
  const copied = await target.entries()
  assert.equal(copied.length, 1)
  assert.equal(copied[0].title, 'm1')
})

test('resolveRoot switches between global and workspace memory', async () => {
  const home = path.join(os.tmpdir(), 'growth-home')
  assert.equal(resolveRoot({ scope: 'global', cwd: 'C:/w', home }), path.join(home, 'growth-note', 'global'))
  assert.equal(resolveRoot({ scope: 'workspace', cwd: 'C:/w', home }), path.join('C:/w', '.growth-note'))
  assert.equal(settingsFilePath(home), path.join(home, 'growth-note', 'settings.json'))
  assert.ok(resolveDshHome().length > 0)
})

test('vector index persists, covers active entries and survives reload', async () => {
  const { store, root } = await tempStore()
  const first = await store.addEntry({ kind: 'method', title: '向量检索', body: '把条目文本嵌入后按余弦相似度召回' })
  const second = await store.addEntry({ kind: 'lesson', title: '另一个', body: '无关内容' })
  await store.upsertVectors([
    { id: first.entry.id, sig: 'openai:m', vec: [1, 0, 0] },
    { id: second.entry.id, sig: 'openai:m', vec: [0, 1, 0] },
  ])
  const stats = await store.vectorStats()
  assert.equal(stats.total, 2)
  assert.equal(stats.covered, 2)
  assert.equal(stats.active, 2)
  assert.deepEqual(stats.signatures, ['openai:m'])

  // A fresh instance reads the same index back from vectors.jsonl.
  const reloaded = new GrowthStore(root)
  await reloaded.ensure()
  const vectors = await reloaded.loadVectors()
  assert.equal(vectors.size, 2)
  assert.deepEqual(vectors.get(first.entry.id).vec, [1, 0, 0])
  assert.equal(vectors.get(first.entry.id).sig, 'openai:m')
})

test('writing or deleting an entry invalidates its stale vector', async () => {
  const { store } = await tempStore()
  const { entry } = await store.addEntry({ kind: 'method', title: '会被改动', body: '原始正文' })
  await store.upsertVectors([{ id: entry.id, sig: 'openai:m', vec: [1, 0] }])
  assert.equal((await store.vectorStats()).covered, 1)

  await store.updateEntry(entry.id, { body: '改过的正文' })
  assert.equal((await store.vectorStats()).covered, 0, 'update must drop the stale vector')

  await store.upsertVectors([{ id: entry.id, sig: 'openai:m', vec: [1, 0] }])
  await store.removeEntry(entry.id, { soft: true })
  assert.equal((await store.vectorStats()).total, 0, 'soft delete must drop the vector')
})

test('clearVectors empties the index without touching memories', async () => {
  const { store, root } = await tempStore()
  const { entry } = await store.addEntry({ kind: 'wp', title: 'CTF 复盘', body: '关键一步' })
  await store.upsertVectors([{ id: entry.id, sig: 'openai:m', vec: [0.5, 0.5] }])
  await store.clearVectors()
  assert.equal((await store.vectorStats()).total, 0)
  assert.equal((await store.entries()).length, 1, 'memory.jsonl must be untouched')
  assert.equal(await fs.readFile(path.join(root, 'vectors.jsonl'), 'utf8'), '')
})

test('vectors for unknown entries are never persisted', async () => {
  const { store } = await tempStore()
  await store.addEntry({ kind: 'method', title: '存在', body: 'b' })
  await store.upsertVectors([{ id: 'mg-does-not-exist', sig: 'openai:m', vec: [1, 1] }])
  const stats = await store.vectorStats()
  assert.equal(stats.total, 0)
})

test('session notes rotate so one long session cannot grow without bound', async () => {
  // Regression: notes were append-only. A long session grew the file forever and
  // every consolidation re-read all of it.
  const { root, store } = await tempStore({ maxNoteTurns: 50 })
  for (let turn = 0; turn < 300; turn += 1) {
    await store.appendSessionNote('sess', `## turn ${turn}\n\n- 用户：${'z'.repeat(400)}\n`, { turn })
  }
  const text = await fs.readFile(path.join(root, 'sessions', 'sess.md'), 'utf8')
  const sections = text.split(/\n(?=## )/).filter(Boolean)
  assert.ok(sections.length <= 50 + 13, `rotated file kept ${sections.length} sections`)
  assert.match(text, /## turn 299/)
  assert.doesNotMatch(text, /## turn 0\n/)
})

test('readSessionNotes returns the newest sections from the tail', async () => {
  const { store } = await tempStore({ maxNoteTurns: 500 })
  for (let turn = 0; turn < 40; turn += 1) {
    await store.appendSessionNote('s2', `## turn ${turn}\n\nbody ${turn}\n`, { turn })
  }
  const notes = await store.readSessionNotes('s2', 3)
  assert.match(notes, /## turn 39/)
  assert.match(notes, /## turn 37/)
  assert.doesNotMatch(notes, /## turn 36\n/)
  assert.equal(await store.readSessionNotes('missing', 3), '')
})

test('archived entries are capped instead of living for 120 days', async () => {
  // Regression: soft deletes piled up until they outnumbered live entries, and
  // every addEntry re-read the whole file.
  const { store } = await tempStore({ maxArchivedEntries: 20 })
  for (let i = 0; i < 50; i += 1) {
    const created = await store.addEntry({ kind: 'method', title: `t${i}`, body: 'b' })
    await store.removeEntry(created.entry.id)
  }
  const stats = await store.stats()
  assert.equal(stats.total, 0)
  assert.ok(stats.archived <= 20, `archived=${stats.archived}`)
})

test('archiveRetentionDays drops old tombstones', async () => {
  const { root, store } = await tempStore({ archiveRetentionDays: 1 })
  const created = await store.addEntry({ kind: 'method', title: 'old', body: 'b' })
  await store.removeEntry(created.entry.id)
  // Age the tombstone on disk: addEntry re-reads with `force`, so an in-memory
  // edit would be discarded before pruning ever saw it.
  const file = path.join(root, 'memory.jsonl')
  const lines = (await fs.readFile(file, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const tomb = lines.find((entry) => entry.id === created.entry.id)
  assert.equal(tomb.status, 'rejected')
  tomb.updatedAt = new Date(Date.now() - 10 * 86_400_000).toISOString()
  await fs.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
  store.cache = null

  await store.addEntry({ kind: 'method', title: 'trigger save', body: 'b' })
  const after = await store.load({ force: true })
  assert.equal(after.some((entry) => entry.id === created.entry.id), false)
  assert.ok(after.some((entry) => entry.title === 'trigger save'))
})

test('active entries are never evicted by the archive caps', async () => {
  const { store } = await tempStore({ maxArchivedEntries: 0 })
  for (let i = 0; i < 5; i += 1) await store.addEntry({ kind: 'method', title: `keep${i}`, body: 'b' })
  const stats = await store.stats()
  assert.equal(stats.total, 5)
  assert.equal(stats.archived, 0)
})
