/**
 * Append-only JSONL store for dsh-costpilot ledgers. Dependency-free.
 *
 * The store directory is the ledger directory itself (the plugin passes
 * <dataDir>/sessions, matching SPEC.md and lib/sim.js):
 *
 *   <dir>/<sessionId>.jsonl   one JSON record per line, append-only
 *   <dir>/meta.json           atomic metadata snapshot (tmp file + rename)
 *
 * Writes are synchronous (appendFileSync) so tests and shutdown paths are
 * deterministic. A single record larger than MAX_RECORD_BYTES is truncated:
 * its extra payload is replaced with a small marker and the record is flagged
 * with truncated: true, so the ledger line stays bounded.
 *
 * @module dsh-costpilot/lib/store
 */
import fs from 'node:fs'
import path from 'node:path'

/** Maximum bytes for one serialized ledger line (256 KiB). */
export const MAX_RECORD_BYTES = 256 * 1024

const META_FILENAME = 'meta.json'

function sanitizeSessionId(sessionId) {
  const text = typeof sessionId === 'string' ? sessionId : String(sessionId ?? '')
  const safe = text.replace(/[^A-Za-z0-9._-]/g, '_')
  return safe.length > 0 ? safe : 'unknown'
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncateRecord(record, originalBytes) {
  const base = isPlainObject(record) ? record : { value: record }
  const marker = {
    truncated: true,
    originalBytes,
    reason: 'record exceeded MAX_RECORD_BYTES; extra truncated',
  }
  let out = { ...base, extra: marker, truncated: true }
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > MAX_RECORD_BYTES) {
    out = {
      v: base.v ?? 1,
      kind: typeof base.kind === 'string' ? base.kind : 'unknown',
      sessionId: base.sessionId,
      ts: base.ts,
      truncated: true,
      extra: marker,
    }
  }
  return out
}

/**
 * Create a store rooted at the ledger directory.
 * @param {{dir: string}} options dir is the directory that holds <sessionId>.jsonl files
 * @returns {{dir: string, append: Function, readSession: Function, listSessions: Function, writeMeta: Function, flush: Function}}
 */
export function createStore(options = {}) {
  const dir = options?.dir
  if (typeof dir !== 'string' || dir.length === 0) throw new TypeError('createStore requires { dir }')
  const root = path.resolve(dir)
  const metaPath = path.join(root, META_FILENAME)
  let ensured = false
  let tmpCounter = 0

  function ensureDirs() {
    if (ensured) return
    fs.mkdirSync(root, { recursive: true })
    ensured = true
  }

  function sessionPath(sessionId) {
    return path.join(root, sanitizeSessionId(sessionId) + '.jsonl')
  }

  /**
   * Append one record synchronously. Returns the record actually written
   * (equal to the input unless it had to be truncated).
   */
  function append(sessionId, record) {
    ensureDirs()
    let written = record
    let line = JSON.stringify(record)
    if (typeof line !== 'string') {
      written = { v: 1, kind: 'unknown', sessionId, ts: null, truncated: true }
      line = JSON.stringify(written)
    }
    const bytes = Buffer.byteLength(line, 'utf8')
    if (bytes > MAX_RECORD_BYTES) {
      written = truncateRecord(record, bytes)
      line = JSON.stringify(written)
    }
    fs.appendFileSync(sessionPath(sessionId), line + '\n', 'utf8')
    return written
  }

  /** Read all records for a session; missing files yield an empty array. */
  function readSession(sessionId) {
    const file = sessionPath(sessionId)
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
    const records = []
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim()
      if (line.length === 0) continue
      try {
        records.push(JSON.parse(line))
      } catch {
        // A corrupt line must not break the rest of the ledger.
      }
    }
    return records
  }

  /** List session ids that have a ledger file, sorted for determinism. */
  function listSessions() {
    let entries
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name.slice(0, -'.jsonl'.length))
      .sort()
  }

  function readMeta() {
    try {
      const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
      return isPlainObject(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  /** Atomically merge and persist an object into <dir>/meta.json. */
  function writeMeta(object) {
    ensureDirs()
    const next = { ...readMeta(), ...(isPlainObject(object) ? object : {}) }
    const tmpPath = metaPath + '.' + process.pid + '.' + (tmpCounter++) + '.tmp'
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
      fs.renameSync(tmpPath, metaPath)
    } catch (error) {
      try { fs.rmSync(tmpPath, { force: true }) } catch {}
      throw error
    }
    return next
  }

  /** Appends are already durable; kept for a future buffered backend. */
  function flush() {
    return true
  }

  return { dir: root, append, readSession, listSessions, writeMeta, flush }
}
