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

/** The live row for `id` on disk: memory.jsonl is an append log, last line wins. */
async function onDiskEntry(root, id) {
  const rows = (await fs.readFile(path.join(root, 'memory.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  return [...rows].reverse().find((entry) => entry.id === id)
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
  // edit would be discarded before pruning ever saw it. The log is append-only, so
  // the live row is the last line for that id.
  const file = path.join(root, 'memory.jsonl')
  const rows = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const tomb = [...rows].reverse().find((entry) => entry.id === created.entry.id)
  assert.equal(tomb.status, 'rejected')
  tomb.updatedAt = new Date(Date.now() - 10 * 86_400_000).toISOString()
  await fs.writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
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

test('touchEntry does not rewrite the memory views', async () => {
  // Regression: a recall is a read. Bumping useCount redrew five Markdown files.
  const { root, store } = await tempStore()
  const created = await store.addEntry({ kind: 'method', title: '被召回', body: 'b' })
  const viewDir = path.join(root, 'MEMORY')
  const stamp = async () => {
    const out = {}
    for (const name of await fs.readdir(viewDir)) out[name] = (await fs.stat(path.join(viewDir, name))).mtimeMs
    return out
  }
  const before = await stamp()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await store.touchEntry([created.entry.id])
  await store.flushTouches()
  assert.deepEqual(await stamp(), before, 'views must not be rewritten')
  const [entry] = await store.load()
  assert.equal(entry.useCount, 1)
})

test('vector appends are incremental, not full rewrites', async () => {
  // Regression: every upsertVectors serialised and rewrote the whole index, and
  // the backfill feeds 16 rows at a time (~19x write amplification measured).
  const { root, store } = await tempStore()
  const ids = []
  for (let i = 0; i < 40; i += 1) {
    const created = await store.addEntry({ kind: 'method', title: `唯一标题-${i}-${Math.random().toString(36).slice(2, 9)}`, body: 'b' })
    ids.push(created.entry.id)
  }
  const file = path.join(root, 'vectors.jsonl')
  for (let offset = 0; offset < ids.length; offset += 16) {
    const batch = ids.slice(offset, offset + 16)
    await store.upsertVectors(batch.map((id) => ({ id, sig: 'openai:m', vec: [1, 0] })))
    // 16 rows of a 2-float vector is well under a kilobyte; a full rewrite of the
    // batch's predecessors would show up as a jump far beyond one batch.
    const size = (await fs.stat(file)).size
    assert.ok(size < 40 * 400, `vectors.jsonl grew to ${size} bytes at offset ${offset}`)
  }
  const loaded = await store.loadVectors({ force: true })
  assert.equal(loaded.size, ids.length)
  for (const id of ids) assert.ok(loaded.has(id))
})

test('compaction collapses duplicate vector rows and keeps the newest value', async () => {
  const { root, store } = await tempStore()
  const created = await store.addEntry({ kind: 'method', title: 'x', body: 'b' })
  const id = created.entry.id
  for (let i = 0; i < 700; i += 1) await store.upsertVectors([{ id, sig: 'openai:m', vec: [i + 1, 0] }])
  const file = path.join(root, 'vectors.jsonl')
  const rows = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean)
  assert.ok(rows.length < 700, `compaction did not run: ${rows.length} rows`)
  const loaded = await store.loadVectors({ force: true })
  assert.equal(loaded.size, 1)
  assert.equal(loaded.get(id).vec[0], 700)
})

test('vectorsComplete reports whether the index needs work', async () => {
  const { store } = await tempStore()
  const created = await store.addEntry({ kind: 'method', title: 'y', body: 'b' })
  await store.loadVectors()
  assert.equal(store.vectorsComplete('openai:m'), false)
  await store.upsertVectors([{ id: created.entry.id, sig: 'openai:m', vec: [1, 0] }])
  assert.equal(store.vectorsComplete('openai:m'), true)
  assert.equal(store.vectorsComplete('openai:other'), false)
  // A new active entry invalidates the answer.
  await store.addEntry({ kind: 'method', title: 'z', body: 'b' })
  assert.equal(store.vectorsComplete('openai:m'), false)
})

test('touchEntry coalesces into one deferred write', async () => {
  // Regression: every recall rewrote a multi-megabyte memory.jsonl.
  const { root, store } = await tempStore()
  const created = await store.addEntry({ kind: 'method', title: '被召回', body: 'b' })
  const file = path.join(root, 'memory.jsonl')
  const before = (await fs.stat(file)).mtimeMs
  await new Promise((resolve) => setTimeout(resolve, 20))
  await store.touchEntry([created.entry.id])
  assert.equal((await fs.stat(file)).mtimeMs, before, 'touch must not write immediately')
  await store.flushTouches()
  assert.equal((await onDiskEntry(root, created.entry.id)).useCount, 1)
})

test('pending touches survive a forced reload', async () => {
  // A forced re-read must not silently roll back counters that `touchEntry`
  // applied in memory but has not flushed yet.
  const { store } = await tempStore()
  const created = await store.addEntry({ kind: 'method', title: 'a', body: 'b' })
  await store.touchEntry([created.entry.id])
  await store.addEntry({ kind: 'method', title: 'trigger', body: 'b' })
  const entries = await store.load({ force: true })
  assert.equal(entries.find((entry) => entry.id === created.entry.id).useCount, 1)
})

test('concurrent touches accumulate without losing increments', async () => {
  const { root, store } = await tempStore()
  const created = await store.addEntry({ kind: 'method', title: 'b', body: 'b' })
  await Promise.all([store.touchEntry([created.entry.id]), store.touchEntry([created.entry.id]), store.touchEntry([created.entry.id])])
  await store.flushTouches()
  assert.equal((await onDiskEntry(root, created.entry.id)).useCount, 3)
})

test('pruning entries also drops their vectors', async () => {
  // Regression: eviction by maxEntries dropped the memory row but left its vector
  // on disk forever — skipped by recall, still decoded on every load.
  const { store } = await tempStore({ maxEntries: 20, maxArchivedEntries: 0 })
  for (let i = 0; i < 60; i += 1) {
    const title = [...Array(4)].map(() => Math.random().toString(36).slice(2, 8)).join('-')
    const created = await store.addEntry({ kind: 'method', title, body: 'b' })
    await store.upsertVectors([{ id: created.entry.id, sig: 'openai:m', vec: [1, 0] }])
  }
  const active = await store.activeEntries()
  assert.ok(active.length <= 20)
  const vectors = await store.loadVectors({ force: true })
  const stats = await store.vectorStats()
  assert.equal(vectors.size, stats.covered, 'no orphan vectors may remain')
  for (const entry of active) assert.ok(vectors.has(entry.id))
})

test('memory.jsonl is appended to, not rewritten', async () => {
  // Writing every stored entry as a full rewrite cost 18 MB of IO per save at the
  // entry cap; the append log only needs the changed rows.
  const { root, store } = await tempStore()
  const file = path.join(root, 'memory.jsonl')
  for (let i = 0; i < 5; i += 1) await store.addEntry({ kind: 'method', title: `t${i}`, body: 'b' })
  const before = (await fs.stat(file)).size
  await store.addEntry({ kind: 'method', title: 'extra', body: 'b' })
  const after = (await fs.stat(file)).size
  assert.ok(after > before, 'the log must grow by an append')
  assert.ok(after - before < 2048, `one entry appended ${after - before} bytes`)
})

test('a re-edited entry is appended and the newest row wins', async () => {
  const { root, store } = await tempStore()
  const created = await store.addEntry({ kind: 'method', title: 'v1', body: 'b' })
  await store.updateEntry(created.entry.id, { title: 'v2' })
  const rows = (await fs.readFile(path.join(root, 'memory.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const forId = rows.filter((row) => row.id === created.entry.id)
  assert.ok(forId.length >= 2, 'the rewrite is an extra row')
  assert.equal(forId[forId.length - 1].title, 'v2')
  const loaded = await store.load({ force: true })
  assert.equal(loaded.find((entry) => entry.id === created.entry.id).title, 'v2')
})

test('evicted entries leave a tombstone instead of forcing a rewrite', async () => {
  // At the entry cap every store evicts something. Compacting on each eviction
  // meant rewriting the whole file per saved entry.
  const { root, store } = await tempStore({ maxEntries: 50, maxArchivedEntries: 0 })
  for (let i = 0; i < 50; i += 1) await store.addEntry({ kind: 'method', title: `k${i}-${Math.random().toString(36).slice(2, 9)}`, body: 'x'.repeat(2000) })
  const file = path.join(root, 'memory.jsonl')
  const before = (await fs.stat(file)).size
  await store.addEntry({ kind: 'method', title: `new-${Math.random().toString(36).slice(2, 9)}`, body: 'x'.repeat(2000) })
  const after = (await fs.stat(file)).size
  assert.ok(after > before, 'an eviction must append a tombstone, not rewrite')
  const loaded = await store.load({ force: true })
  assert.ok(loaded.length <= 50)
  // The tombstoned id must not come back.
  const rows = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
  for (const row of rows.filter((item) => item.deleted)) {
    assert.equal(loaded.some((entry) => entry.id === row.id), false)
  }
})

test('addEntries renders the views once for the whole batch', async () => {
  const { root, store } = await tempStore()
  await store.addEntry({ kind: 'method', title: 'seed', body: 'b' })
  const viewDir = path.join(root, 'MEMORY')
  const stamp = async () => {
    const out = {}
    for (const name of await fs.readdir(viewDir)) out[name] = (await fs.stat(path.join(viewDir, name))).mtimeMs
    return out
  }
  await new Promise((resolve) => setTimeout(resolve, 20))
  const before = await stamp()
  await store.addEntries([
    { kind: 'method', title: 'batch-a', body: 'b' },
    { kind: 'lesson', title: 'batch-b', body: 'b' },
    { kind: 'knowledge', title: 'batch-c', body: 'b' },
  ])
  const after = await stamp()
  assert.notDeepEqual(after, before, 'views must be refreshed after the batch')
  const index = await fs.readFile(path.join(viewDir, 'INDEX.md'), 'utf8')
  assert.match(index, /batch-a/)
  assert.match(index, /batch-c/)
})

test('render is a no-op when nothing the views show changed', async () => {
  const { root, store } = await tempStore()
  await store.addEntry({ kind: 'method', title: 'stable', body: 'b' })
  const viewDir = path.join(root, 'MEMORY')
  const stamp = async () => {
    const out = {}
    for (const name of await fs.readdir(viewDir)) out[name] = (await fs.stat(path.join(viewDir, name))).mtimeMs
    return out
  }
  const before = await stamp()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await store.render()
  assert.deepEqual(await stamp(), before)
})

test('hard delete survives a restart', async () => {
  // Regression: appending nothing cannot express a removal, so the original line
  // stayed in the log and `load` read the "deleted" entry straight back. A hard
  // delete (growth_forget hard=true) is how a user removes something they consider
  // sensitive — resurrecting it on the next start is the worst possible failure.
  const { root, store } = await tempStore()
  const created = await store.addEntry({ kind: 'method', title: '要彻底删掉的', body: '敏感内容' })
  await store.removeEntry(created.entry.id, { soft: false })
  assert.equal((await store.load()).length, 0)

  const restarted = new GrowthStore(root)
  await restarted.ensure()
  const after = await restarted.load()
  assert.equal(after.length, 0, 'the entry must not come back after a restart')
})

test('hard delete drops the vector too', async () => {
  const { root, store } = await tempStore()
  const created = await store.addEntry({ kind: 'method', title: 'x', body: 'b' })
  await store.upsertVectors([{ id: created.entry.id, sig: 'openai:m', vec: [1, 0] }])
  await store.removeEntry(created.entry.id, { soft: false })
  const restarted = new GrowthStore(root)
  await restarted.ensure()
  const vectors = await restarted.loadVectors({ force: true })
  assert.equal(vectors.has(created.entry.id), false)
})
