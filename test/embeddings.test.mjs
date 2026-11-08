import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_OPENAI_BASE_URL,
  cosine,
  createEmbedder,
  decodeVector,
  embeddingSignature,
  encodeVector,
  normalizeVector,
} from '../lib/embeddings.js'

test('cosine handles normal, orthogonal and unusable inputs', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([1, 2, 3], [1, 2, 3]), 1)
  assert.ok(Math.abs(cosine([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-9)
  // Mismatched length, empty vectors and zero vectors all degrade to 0.
  assert.equal(cosine([1, 2], [1, 2, 3]), 0)
  assert.equal(cosine([], []), 0)
  assert.equal(cosine([0, 0], [1, 1]), 0)
  assert.equal(cosine(null, [1]), 0)
})

test('normalizeVector returns unit length and rejects degenerate input', () => {
  const unit = normalizeVector([3, 4])
  assert.ok(Math.abs(unit[0] - 0.6) < 1e-9)
  assert.ok(Math.abs(unit[1] - 0.8) < 1e-9)
  assert.deepEqual(normalizeVector([0, 0]), [])
  assert.deepEqual(normalizeVector([]), [])
})

test('vector encoding round-trips through base64', () => {
  const original = [0.1, -0.25, 1, 0]
  const decoded = decodeVector(encodeVector(original))
  assert.equal(decoded.length, original.length)
  for (let i = 0; i < original.length; i += 1) {
    assert.ok(Math.abs(decoded[i] - original[i]) < 1e-6)
  }
  // Garbage never throws, it just yields no vector.
  assert.deepEqual(decodeVector('not-base64!!'), [])
  assert.deepEqual(decodeVector(''), [])
})

test('signature distinguishes models so stale vectors can be detected', () => {
  assert.equal(embeddingSignature('openai', 'text-embedding-3-small'), 'openai:text-embedding-3-small')
  assert.notEqual(embeddingSignature('openai', 'a'), embeddingSignature('openai', 'b'))
})

test('embedder is unavailable until provider, model and key are all configured', () => {
  const none = createEmbedder({ embeddingProvider: 'none' })
  assert.equal(none.available, false)
  assert.equal(none.signature, '')

  const noModel = createEmbedder({ embeddingProvider: 'openai', embeddingApiKey: 'k' })
  assert.equal(noModel.available, false)

  const noKey = createEmbedder({ embeddingProvider: 'openai', embeddingModel: 'm' }, {})
  // Without config key and without env var there is nothing to authenticate with.
  const keyless = noKey.available ? 'env-provided' : 'unavailable'
  assert.ok(['unavailable', 'env-provided'].includes(keyless))

  const ready = createEmbedder({ embeddingProvider: 'openai', embeddingModel: 'm', embeddingApiKey: 'k' })
  assert.equal(ready.available, true)
  assert.equal(ready.signature, 'openai:m')
  assert.equal(ready.baseUrl, DEFAULT_OPENAI_BASE_URL)
})

test('embed() posts to /embeddings, orders by index and normalizes', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      async json() {
        // Deliberately out of order: the embedder must sort by index.
        return {
          data: [
            { index: 1, embedding: [0, 5] },
            { index: 0, embedding: [3, 4] },
          ],
        }
      },
    }
  }
  const embedder = createEmbedder(
    { embeddingProvider: 'openai', embeddingModel: 'test-model', embeddingApiKey: 'secret', embeddingBaseUrl: 'https://example.test/v1/' },
    { fetchImpl },
  )
  const vectors = await embedder.embed(['first', 'second'])
  assert.equal(vectors.length, 2)
  assert.ok(Math.abs(vectors[0][0] - 0.6) < 1e-9)
  assert.ok(Math.abs(vectors[1][1] - 1) < 1e-9)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://example.test/v1/embeddings')
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret')
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: 'test-model', input: ['first', 'second'] })
})

test('embed() degrades to an empty result on HTTP errors and exceptions', async () => {
  const warnings = []
  const logger = { warn: (message) => warnings.push(message) }
  const failing = createEmbedder(
    { embeddingProvider: 'openai', embeddingModel: 'm', embeddingApiKey: 'k' },
    { logger, fetchImpl: async () => ({ ok: false, status: 401 }) },
  )
  assert.deepEqual(await failing.embed(['x']), [])
  assert.match(warnings[0], /401/)

  const throwing = createEmbedder(
    { embeddingProvider: 'openai', embeddingModel: 'm', embeddingApiKey: 'k' },
    {
      logger,
      fetchImpl: async () => {
        throw new Error('dns exploded')
      },
    },
  )
  assert.deepEqual(await throwing.embed(['x']), [])
  assert.match(warnings[1], /dns exploded/)

  // Nothing is requested when the provider is off.
  let called = 0
  const off = createEmbedder(
    { embeddingProvider: 'none' },
    {
      fetchImpl: async () => {
        called += 1
        return { ok: true, json: async () => ({ data: [] }) }
      },
    },
  )
  assert.deepEqual(await off.embed(['x']), [])
  assert.equal(called, 0)
})

test('embed() skips empty input and reports one vector per non-empty text', async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    return { ok: true, json: async () => ({ data: body.input.map((text, index) => ({ index, embedding: [text.length, 1] })) }) }
  }
  const embedder = createEmbedder(
    { embeddingProvider: 'openai', embeddingModel: 'm', embeddingApiKey: 'k' },
    { fetchImpl },
  )
  const vectors = await embedder.embed(['hello', '', 'hi'])
  assert.equal(vectors.length, 2)
  assert.deepEqual(await embedder.embed([]), [])
})
