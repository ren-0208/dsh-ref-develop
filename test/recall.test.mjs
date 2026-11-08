import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeEntry } from '../lib/entry.js'
import { buildDigest, describeEntry } from '../lib/prompt.js'
import { rankEntries, selectForDigest, tokensFromMessages } from '../lib/recall.js'
import { CONFIG_DEFAULTS } from '../lib/config.js'

function config(patch = {}) {
  return { ...CONFIG_DEFAULTS, ...patch }
}

test('tokensFromMessages reads only user text blocks', () => {
  const query = tokensFromMessages([
    { role: 'user', content: [{ type: 'text', text: 'cordis 服务怎么注入' }] },
    { role: 'assistant', content: [{ type: 'text', text: '不要用这个' }] },
    { role: 'user', content: '顺便看看 ctx.get' },
  ])
  assert.match(query.text, /cordis/)
  assert.match(query.text, /ctx\.get/)
  assert.doesNotMatch(query.text, /不要用这个/)
  assert.ok(query.tokens.size > 0)
})

test('tokensFromMessages tolerates missing content', () => {
  assert.deepEqual(tokensFromMessages(undefined), { text: '', tokens: new Set() })
  assert.deepEqual(tokensFromMessages([{ role: 'user' }]).text, '')
})

test('rankEntries puts a lexical match above an unrelated fresh entry', () => {
  const fresh = normalizeEntry({ kind: 'knowledge', title: 'nginx 配置', body: '监听的端口和 upstream' })
  const relevant = normalizeEntry({ kind: 'knowledge', title: 'cordis 服务注入', body: 'ctx.get 在真机返回 undefined，直接读 ctx.tools' })
  const ranked = rankEntries([fresh, relevant], { tokens: new Set(['cordis', 'ctx']) })
  assert.equal(ranked[0].entry.id, relevant.id)
  assert.ok(ranked[0].score > 0)
})

test('rankEntries drops entries below minConfidence', () => {
  const low = normalizeEntry({ kind: 'method', title: '猜测', body: 'x', confidence: 0.2 })
  assert.equal(rankEntries([low], { tokens: new Set(), minConfidence: 0.35 }).length, 0)
})

test('selectForDigest gates preferences behind personalization', () => {
  const preference = normalizeEntry({ kind: 'preference', title: '语言', body: '中文', meta: { aspect: 'language', value: 'zh' } })
  const off = selectForDigest([preference], { tokens: new Set(), config: config({ personalization: false }) })
  assert.equal(off.groups.preference.length, 0)
  const on = selectForDigest([preference], { tokens: new Set(), config: config({ personalization: true }) })
  assert.equal(on.groups.preference.length, 1)
})

test('selectForDigest keeps state even without lexical overlap and respects quotas', () => {
  const state = normalizeEntry({ kind: 'state', title: '当前项目', body: 'growth-note 二期' })
  const methods = Array.from({ length: 9 }, (_, index) =>
    normalizeEntry({ kind: 'method', title: `方法 ${index} 的标题各不相同 ${index}`, body: `正文 ${index}` }),
  )
  const { groups } = selectForDigest([state, ...methods], { tokens: new Set(), config: config() })
  assert.equal(groups.state.length, 1)
  assert.ok(groups.method.length <= 5)
})

test('buildDigest renders sections and stays inside the budget', () => {
  const groups = {
    state: [normalizeEntry({ kind: 'state', title: '进度', body: 'P3 设置页' })],
    preference: [],
    method: Array.from({ length: 4 }, (_, index) =>
      normalizeEntry({ kind: 'method', title: `方法 ${index}`, body: '很长的正文'.repeat(80) }),
    ),
    lesson: [],
    wp: [],
    knowledge: [],
  }
  const digest = buildDigest({ groups, config: config({ promptBudgetChars: 900 }), root: 'C:/mem', cwd: 'C:/w', queryText: '怎么注入服务' })
  assert.match(digest, /## 记忆与成长/)
  assert.match(digest, /### 状态/)
  assert.ok(digest.length <= 1000, `digest too long: ${digest.length}`)
})

test('buildDigest explains an empty memory instead of inventing facts', () => {
  const digest = buildDigest({ groups: {}, config: config(), root: 'C:/mem' })
  assert.match(digest, /还没有可用记忆/)
  assert.doesNotMatch(digest, /命中/)
})

test('describeEntry includes id, confidence and body', () => {
  const entry = normalizeEntry({ kind: 'wp', title: 'CTF xor', body: '关键一步是恢复 key', confidence: 0.8 })
  const text = describeEntry(entry, 0)
  assert.match(text, /\[复盘\]/)
  assert.match(text, /CTF xor/)
  assert.match(text, /置信 80%/)
  assert.match(text, new RegExp(entry.id))
})

test('semantic vectors reorder results when lexical overlap is absent', () => {
  const lexical = normalizeEntry({ kind: 'knowledge', title: 'nginx 配置', body: '监听端口和 upstream' })
  const semantic = normalizeEntry({ kind: 'knowledge', title: '服务注入的写法', body: '插件访问宿主能力的方式' })
  const vectors = new Map([
    [lexical.id, { sig: 'openai:m', vec: [0, 1] }],
    [semantic.id, { sig: 'openai:m', vec: [1, 0] }],
  ])
  // The query matches the "semantic" entry only through its vector.
  const ranked = rankEntries([lexical, semantic], { tokens: new Set(['无关词']), vectors, queryVector: [1, 0] })
  assert.equal(ranked[0].entry.id, semantic.id)
  assert.ok(ranked[0].semantic > 0.9)
  assert.equal(ranked[0].lexical, 0)
})

test('without vectors recall behaves exactly like lexical scoring', () => {
  const entry = normalizeEntry({ kind: 'method', title: 'cordis 注入', body: 'ctx.tools' })
  const plain = rankEntries([entry], { tokens: new Set(['cordis']) })
  const withNullVectors = rankEntries([entry], { tokens: new Set(['cordis']), vectors: null, queryVector: null })
  assert.equal(plain[0].score, withNullVectors[0].score)
  assert.equal(withNullVectors[0].semantic, 0)
})

test('selectForDigest keeps a semantic-only match out of the filler bucket', () => {
  const semantic = normalizeEntry({ kind: 'method', title: '与查询词无关但语义接近', body: 'body' })
  const vectors = new Map([[semantic.id, { sig: 'openai:m', vec: [1, 0] }]])
  const { groups, matched } = selectForDigest([semantic], {
    tokens: new Set(['完全不同的词']),
    config: config(),
    vectors,
    queryVector: [1, 0],
  })
  assert.equal(groups.method.length, 1)
  assert.equal(matched, 1)
})
