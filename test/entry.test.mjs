import assert from 'node:assert/strict'
import test from 'node:test'

import { entryKey, lessonPromotion, mergeEntry, normalizeEntry, similarity, strengthOf } from '../lib/entry.js'

test('normalizeEntry fills defaults and clamps confidence', () => {
  const entry = normalizeEntry({ kind: 'method', title: '  先读 INDEX  ', body: 'x', confidence: 2 })
  assert.equal(entry.kind, 'method')
  assert.equal(entry.title, '先读 INDEX')
  assert.equal(entry.confidence, 1)
  assert.equal(entry.status, 'active')
  assert.equal(entry.schema, 2)
  assert.ok(entry.id.startsWith('mg-'))
  assert.deepEqual(entry.evidence, [])
})

test('normalizeEntry keeps only kind-specific meta keys', () => {
  const entry = normalizeEntry({ kind: 'wp', title: 't', meta: { platform: 'CTF', bogus: 1 } })
  assert.deepEqual(Object.keys(entry.meta), ['platform'])
  assert.equal(entry.meta.platform, 'CTF')
})

test('entryKey is stable across whitespace and case', () => {
  const a = normalizeEntry({ kind: 'lesson', title: 'Make 不可用' })
  const b = normalizeEntry({ kind: 'lesson', title: 'make   不可用' })
  assert.equal(entryKey(a), entryKey(b))
})

test('similarity merges paraphrases but not unrelated claims', () => {
  const a = normalizeEntry({ kind: 'method', title: '先读 INDEX 再动手', body: '打开工作区先看 MEMORY/INDEX.md' })
  const b = normalizeEntry({ kind: 'method', title: '先读 INDEX 再动手', body: '打开工作区先看 MEMORY/INDEX.md 再改代码' })
  const c = normalizeEntry({ kind: 'method', title: '用 zstd 解帧', body: 'windows 下没有原生 zstd，用 node 脚本解' })
  assert.ok(similarity(a, b) > 0.7)
  assert.ok(similarity(a, c) < 0.3)
})

test('mergeEntry unions evidence and raises confidence', () => {
  const target = normalizeEntry({ kind: 'lesson', title: 'make 不可用', body: 'make 报错', confidence: 0.6 })
  const incoming = normalizeEntry({
    kind: 'lesson',
    title: 'make 不可用',
    body: 'make 报错',
    confidence: 0.7,
    evidence: [{ quote: 'make: command not found' }],
    tags: ['windows'],
  })
  mergeEntry(target, incoming)
  assert.equal(target.tags.includes('windows'), true)
  assert.equal(target.evidence.length, 1)
  assert.ok(target.confidence > 0.7)
  assert.equal(target.body, 'make 报错')
})

test('strengthOf decays with age and rewards use', () => {
  const now = Date.now()
  const fresh = normalizeEntry({ kind: 'method', title: 'fresh', confidence: 0.9, lastUsedAt: new Date(now).toISOString() })
  const old = normalizeEntry({ kind: 'method', title: 'old', confidence: 0.9, lastUsedAt: new Date(now - 90 * 86_400_000).toISOString() })
  assert.ok(strengthOf(fresh, { now }) > strengthOf(old, { now }))
  const used = normalizeEntry({ kind: 'method', title: 'used', confidence: 0.6, useCount: 5, lastUsedAt: new Date(now).toISOString() })
  assert.ok(strengthOf(used, { now }) > strengthOf(normalizeEntry({ kind: 'method', title: 'u', confidence: 0.6 }), { now }))
  assert.equal(strengthOf({ status: 'rejected', confidence: 1 }), 0)
})

test('lessonPromotion produces a method only after corroboration and only once', () => {
  const lesson = normalizeEntry({
    kind: 'lesson',
    title: 'make 不可用',
    confidence: 0.7,
    evidence: [{ quote: 'a' }, { quote: 'b' }, { quote: 'c' }],
    meta: { trigger: '编译 C 项目', fix: '用 node 版 make' },
  })
  const method = lessonPromotion(lesson, { threshold: 3 })
  assert.ok(method)
  assert.equal(method.kind, 'method')
  assert.equal(method.promotedFrom, lesson.id)
  assert.match(method.body, /编译 C 项目/)
  lesson.promotedTo = 'mg-x'
  assert.equal(lessonPromotion(lesson, { threshold: 3 }), null)
  assert.equal(lessonPromotion(normalizeEntry({ kind: 'lesson', title: 'x' }), { threshold: 3 }), null)
})

test('lessonPromotion ignores useCount: being recalled is not being corroborated', () => {
  // Regression: `useCount` is bumped by growth_recall. Counting it as
  // corroboration promoted frequently-quoted lessons nobody re-verified.
  const lesson = normalizeEntry({ kind: 'lesson', title: 'make 不可用', body: 'b' })
  lesson.useCount = 99
  assert.equal(lesson.corroborations, 0)
  assert.equal(lessonPromotion(lesson, { threshold: 3 }), null)
})

test('mergeEntry accrues corroboration past the evidence cap', () => {
  // Regression: corroboration used to be read from evidence.length, which is
  // capped at MAX_EVIDENCE, so a capped entry stopped accruing credit entirely.
  const target = normalizeEntry({ kind: 'lesson', title: 'make 不可用', body: 'b' })
  target.corroborations = 1
  for (let i = 0; i < 10; i += 1) {
    const incoming = normalizeEntry({ kind: 'lesson', title: 'make 不可用', body: `b${i}`, evidence: [{ quote: `q${i}` }] })
    mergeEntry(target, incoming)
  }
  assert.ok(target.evidence.length <= 8)
  assert.equal(target.corroborations, 11)
  assert.ok(lessonPromotion(target, { threshold: 3 }))
})

test('normalizeEntry seeds corroborations from legacy evidence', () => {
  const legacy = normalizeEntry({ kind: 'lesson', title: 'x', evidence: [{ quote: 'a' }, { quote: 'b' }] })
  assert.equal(legacy.corroborations, 2)
  const fresh = normalizeEntry({ kind: 'lesson', title: 'y' })
  assert.equal(fresh.corroborations, 0)
})
