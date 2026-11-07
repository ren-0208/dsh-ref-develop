/**
 * Filesystem primitives for growth-note.
 *
 * Everything the plugin persists must survive a crash between two writes and
 * must not be corrupted when two agents (same process) or two DSH instances
 * (different processes) touch the same memory root at once. Hence:
 *
 *   writeFileAtomic   write to a sibling temp file, fsync-free rename over target
 *   withFileLock      advisory lock file, stale lock reclamation, bounded wait
 *   readJson          tolerant JSON read (missing/broken file -> fallback)
 *   writeJsonAtomic   readJson's write counterpart
 *   parseJsonl        one JSON object per line, skips broken lines
 *   stringifyJsonl    stable one-object-per-line serialization
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const LOCK_STALE_MS = 15_000
const LOCK_WAIT_MS = 3_000

export async function writeFileAtomic(file, data) {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
  try {
    await fs.writeFile(tmp, data, 'utf8')
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Run `fn` while holding `<file>.lock`. The lock is re-entrant only within the
 * caller's own chain (the store serializes operations before calling us), so a
 * second acquisition attempt means another process/agent owns it.
 */
export async function withFileLock(file, fn) {
  const lock = `${file}.lock`
  await fs.mkdir(path.dirname(lock), { recursive: true })
  const started = Date.now()
  let handle = null
  for (;;) {
    try {
      handle = await fs.open(lock, 'wx')
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let stale = false
      try {
        const stat = await fs.stat(lock)
        stale = Date.now() - stat.mtimeMs > LOCK_STALE_MS
      } catch {
        stale = true
      }
      if (stale) {
        await fs.rm(lock, { force: true }).catch(() => {})
        continue
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        // Better to lose the advisory lock than to deadlock a reply. The atomic
        // rename below still guarantees readers never see a half-written file.
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  try {
    return await fn()
  } finally {
    if (handle) {
      await handle.close().catch(() => {})
      await fs.rm(lock, { force: true }).catch(() => {})
    }
  }
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

export async function writeJsonAtomic(file, value) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function parseJsonl(text) {
  const list = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') list.push(parsed)
    } catch {
      // one corrupt line must not take the whole memory store down
    }
  }
  return list
}

export function stringifyJsonl(list) {
  const body = list.map((item) => JSON.stringify(item)).join('\n')
  return body ? `${body}\n` : ''
}
