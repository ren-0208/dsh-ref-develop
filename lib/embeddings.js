/**
 * Embedding layer (optional).
 *
 * The plugin has no hard dependency on a model provider: this module exposes a
 * small, stable interface so a caller can plug any OpenAI-compatible
 * `/embeddings` endpoint (OpenAI, DashScope, Ollama, vLLM, …). When no provider
 * is configured every entry stays lexical-only, and all vector files stay empty.
 *
 * Interface (`createEmbedder(...)`):
 *   provider    'none' | 'openai'
 *   model       model name reported by the provider
 *   available   whether embed() can be called
 *   signature   provider:model, used to invalidate stale vectors after a switch
 *   embed(texts: string[]): Promise<number[][]>   (unit-length vectors, or [] on failure)
 *
 * Vectors are stored as base64-encoded Float32 arrays inside `vectors.jsonl`,
 * which keeps the authoritative `memory.jsonl` untouched and makes deleting the
 * vector file a safe "drop the index" operation.
 */
import { toText } from './util.js'

export const EMBEDDING_PROVIDERS = Object.freeze(['none', 'openai'])

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'

/** Embedding requests are bounded: a stalled provider must not wedge recall. */
export const DEFAULT_TIMEOUT_MS = 15_000

/** Cosine similarity of two equal-length vectors (0 when unusable). */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (!na || !nb) return 0
  return dot / Math.sqrt(na * nb)
}

/** L2-normalise so stored vectors compare by dot product alone. */
export function normalizeVector(vec) {
  if (!Array.isArray(vec) || !vec.length) return []
  let norm = 0
  for (const value of vec) norm += value * value
  norm = Math.sqrt(norm)
  if (!norm) return []
  return vec.map((value) => value / norm)
}

export function encodeVector(vec) {
  const floats = new Float32Array(vec)
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString('base64')
}

export function decodeVector(text) {
  try {
    const buffer = Buffer.from(String(text ?? ''), 'base64')
    if (!buffer.byteLength || buffer.byteLength % 4 !== 0) return []
    const floats = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
    return Array.from(floats)
  } catch {
    return []
  }
}

export function embeddingSignature(provider, model) {
  return `${provider}:${model}`
}

/**
 * Build an embedder from runtime config. Never throws: a missing key, a bad URL
 * or a failing request degrades to "no vectors" so memory keeps working.
 */
export function createEmbedder(config, { logger, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const source = config ?? {}
  const provider = EMBEDDING_PROVIDERS.includes(source.embeddingProvider) ? source.embeddingProvider : 'none'
  const model = toText(source.embeddingModel).trim()
  const configuredBase = toText(source.embeddingBaseUrl).trim().replace(/\/+$/, '')
  const baseUrl = configuredBase || DEFAULT_OPENAI_BASE_URL
  const apiKey = toText(source.embeddingApiKey).trim() || toText(process.env.DSH_GROWTH_EMBEDDING_API_KEY).trim()
  const available = provider === 'openai' && Boolean(model) && Boolean(apiKey)
  const signature = available ? embeddingSignature(provider, model) : ''

  return {
    provider,
    model,
    baseUrl,
    available,
    signature,
    /** Returns unit-length vectors in input order; failures yield []. */
    async embed(texts) {
      if (!available) return []
      const input = (Array.isArray(texts) ? texts : [texts]).map((text) => toText(text)).filter(Boolean)
      if (!input.length) return []
      // A hung provider must not wedge the caller. `backfillVectors` holds its
      // per-store guard across this await, so a request that never settles would
      // block vector indexing for the rest of the process. The signal covers
      // cooperative fetch implementations; the race also covers ones that ignore
      // it, because the guard must be released either way.
      const controller = new AbortController()
      const budget = Math.max(1000, timeoutMs)
      const timer = setTimeout(() => controller.abort(), budget)
      let timeoutHandle = null
      const timedOut = new Promise((resolve) => {
        timeoutHandle = setTimeout(() => resolve({ timedOut: true }), budget + 50)
      })
      try {
        const request = Promise.resolve(
          fetchImpl(`${baseUrl}/embeddings`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model, input }),
            signal: controller.signal,
          }),
        )
        const settled = await Promise.race([request.then((response) => ({ response }), (error) => ({ error })), timedOut])
        if (settled.timedOut) {
          logger?.warn?.(`embedding request failed: timeout after ${budget}ms`)
          return []
        }
        if (settled.error) throw settled.error
        const response = settled.response
        if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'unknown'}`)
        const payload = await response.json()
        const data = Array.isArray(payload?.data) ? [...payload.data] : []
        data.sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
        return data.map((item) => normalizeVector(Array.isArray(item?.embedding) ? item.embedding : []))
      } catch (error) {
        const reason = controller.signal.aborted ? `timeout after ${budget}ms` : String(error?.message ?? error)
        logger?.warn?.(`embedding request failed: ${reason}`)
        return []
      } finally {
        clearTimeout(timer)
        if (timeoutHandle) clearTimeout(timeoutHandle)
      }
    },
  }
}
