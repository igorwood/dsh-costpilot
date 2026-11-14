/**
 * M8: duplicate tool-call short-circuit / result reuse.
 *
 * Three levels (design section 6.8, config.modules.M8.level):
 *   advisory (default): report the previous result seq and ask the model to reuse it;
 *   deny:               tools/pre-execute can deny the exact duplicate, pointer in the reason;
 *   cache:              tools/execute may replay the recorded result (experimental).
 *
 * Only tools in config.modules.M8.allowTools (read-only tools by default) are
 * considered. Error results are never cached. Entries expire after ttlSeconds.
 *
 * The cache key is the tool name plus a canonical serialization of the arguments:
 * JSON is parsed and object keys are recursively sorted, so key order and
 * whitespace do not create distinct entries. Non-JSON arguments fall back to a
 * stable hash of the raw text.
 *
 * Pure ESM, zero runtime dependencies, no network, deterministic given the
 * optional now argument (defaults to Date.now()).
 *
 * @module dsh-costpilot/lib/repeat-cache
 */
import { hashKey } from './contracts.js'

const DEFAULT_M8 = Object.freeze({
  enabled: true,
  level: 'advisory',
  allowTools: Object.freeze(['read', 'glob', 'grep', 'index_query']),
  ttlSeconds: 600,
})

const LEVELS = new Set(['advisory', 'deny', 'cache'])
const M8_KEYS = ['enabled', 'level', 'allowTools', 'ttlSeconds']

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveNumber(value) {
  return Number.isFinite(value) && value > 0
}

function firstFinite(...values) {
  for (const value of values) if (Number.isFinite(value)) return value
  return null
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/** Resolve the M8 config slice from a full resolved config or a bare M8 object. */
function pickM8(config) {
  const base = {
    enabled: true,
    level: DEFAULT_M8.level,
    allowTools: [...DEFAULT_M8.allowTools],
    ttlSeconds: DEFAULT_M8.ttlSeconds,
  }
  // No config at all: behave like the shipped default (module off). A bare M8
  // slice passed explicitly is treated as enabled, which keeps the module usable
  // standalone and in unit tests.
  if (!isObject(config)) return { ...base, enabled: false }
  const modules = isObject(config.modules) ? config.modules : null
  let slice = {}
  let standalone = false
  if (modules && isObject(modules.M8)) slice = modules.M8
  else if (isObject(config.M8)) slice = config.M8
  else if (!('modules' in config) && !('budgets' in config) && M8_KEYS.some((key) => key in config)) {
    slice = config
    standalone = true
  }
  for (const [key, value] of Object.entries(slice)) {
    if (key === 'level' && typeof value === 'string') base.level = value.toLowerCase()
    else if (key === 'allowTools' && Array.isArray(value)) base.allowTools = value.filter((tool) => typeof tool === 'string')
    else if (key === 'ttlSeconds' && isPositiveNumber(value)) base.ttlSeconds = value
    else if (key === 'enabled') base.enabled = value !== false
  }
  if (!('enabled' in slice) && Object.keys(slice).length > 0) base.enabled = true
  if (standalone) base.enabled = slice.enabled === false ? false : true
  if (!LEVELS.has(base.level)) base.level = base.level === 'none' || base.level === 'off' ? 'none' : 'advisory'
  return base
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (isObject(value)) {
    const output = {}
    for (const key of Object.keys(value).sort()) output[key] = sortDeep(value[key])
    return output
  }
  return value
}

/**
 * Canonical string for tool arguments. JSON input is parsed and recursively
 * key-sorted; anything unparsable falls back to a stable raw-text hash.
 * @param {string|object|null|undefined} argsText
 * @returns {string}
 */
export function canonicalizeArgs(argsText) {
  if (argsText === undefined || argsText === null) return ''
  if (typeof argsText === 'string') {
    const text = argsText.trim()
    if (text.length === 0) return ''
    try {
      return JSON.stringify(sortDeep(JSON.parse(text)))
    } catch {
      return 'raw:' + hashKey(text) + ':' + text.length
    }
  }
  try {
    return JSON.stringify(sortDeep(argsText))
  } catch {
    return 'raw:' + hashKey(argsText)
  }
}

/** Stable M8 cache key: tool name + canonical arguments. */
export function buildCacheKey(toolName, argsText) {
  return String(toolName) + ':' + canonicalizeArgs(argsText)
}

/**
 * Create an M8 repeat-cache for one session.
 *
 * @param {{config?: object}} [input] resolved CostPilot config (or a bare M8 slice)
 * @returns {object} decide / record / lookup / ttlSweep / stats
 */
export function createRepeatCache({ config } = {}) {
  const m8 = pickM8(config)
  const allowTools = new Set(m8.allowTools)
  /** @type {Map<string, object>} */
  const entries = new Map()

  function clock(now) {
    return Number.isFinite(now) ? now : Date.now()
  }

  function liveEntry(key, at) {
    const entry = entries.get(key)
    if (!entry) return null
    if (at >= entry.expiresAt) {
      entries.delete(key)
      return null
    }
    return entry
  }

  function allow(toolName) {
    return typeof toolName === 'string' && toolName.length > 0 && allowTools.has(toolName)
  }

  /**
   * Decide before a tool call. When a previous identical call is known, returns
   * the configured level's action; otherwise 'none'.
   */
  function decide(request = {}) {
    const { toolName, argsText, lastResultSeq, lastResultPointer } = request
    const at = clock(request.now)
    if (!m8.enabled) return { action: 'none', reason: 'disabled' }
    if (m8.level === 'none') return { action: 'none', reason: 'level-off' }
    if (!allow(toolName)) return { action: 'none', reason: 'not-allowed' }

    const key = buildCacheKey(toolName, argsText)
    const entry = liveEntry(key, at)
    const priorSeq = firstFinite(entry ? entry.resultSeq : null, lastResultSeq)
    const priorPointer = firstString(entry ? entry.resultPointer : null, lastResultPointer)
    const duplicate = Boolean(entry) || Number.isFinite(priorSeq) || typeof priorPointer === 'string'
    if (!duplicate) return { action: 'none', reason: 'no-duplicate', key }

    const seqValue = Number.isFinite(priorSeq) ? String(priorSeq) : 'unknown'
    const pointerText = priorPointer ? '; side-store: ' + priorPointer : ''

    if (m8.level === 'cache') {
      if (!entry || typeof entry.resultText !== 'string') {
        return { action: 'none', reason: 'no-cache-entry', key, seq: priorSeq, pointer: priorPointer }
      }
      const marker = '<costpilot:cache-reuse seq="' + seqValue + '"/>'
      const text = entry.resultText.length === 0 ? marker : entry.resultText + '\n' + marker
      return {
        action: 'cache',
        key,
        text,
        seq: priorSeq,
        pointer: priorPointer,
        marker,
        recordedAt: entry.recordedAt,
        expiresAt: entry.expiresAt,
      }
    }

    if (m8.level === 'deny') {
      return {
        action: 'deny',
        key,
        seq: priorSeq,
        pointer: priorPointer,
        text: 'M8 deny: duplicate ' + toolName + ' call; previous result at seq ' + seqValue + pointerText +
          '. Reuse that result instead of re-running the tool.',
      }
    }

    return {
      action: 'advisory',
      key,
      seq: priorSeq,
      pointer: priorPointer,
      text: 'M8 advisory: duplicate ' + toolName + ' call; previous result at seq ' + seqValue + pointerText +
        '. Reuse it, or say why a refresh is needed.',
    }
  }

  /**
   * Record a completed tool result. Error results invalidate the key instead of
   * refreshing it, so a failed retry is never replayed as a cached success.
   */
  function record(result = {}) {
    const { toolName, argsText, resultText, resultSeq, resultPointer, isError } = result
    const at = clock(result.now)
    if (!m8.enabled) return { stored: false, reason: 'disabled' }
    if (m8.level === 'none') return { stored: false, reason: 'level-off' }
    if (!allow(toolName)) return { stored: false, reason: 'not-allowed' }

    const key = buildCacheKey(toolName, argsText)
    if (isError === true) {
      const invalidated = entries.delete(key)
      return { stored: false, reason: 'is-error', key, invalidated }
    }

    const entry = {
      key,
      toolName,
      resultText: typeof resultText === 'string' ? resultText : null,
      resultSeq: Number.isFinite(resultSeq) ? resultSeq : null,
      resultPointer: firstString(resultPointer),
      recordedAt: at,
      expiresAt: at + m8.ttlSeconds * 1000,
    }
    entries.set(key, entry)
    return { stored: true, key, expiresAt: entry.expiresAt }
  }

  /** Return a live entry for a key (expired entries are dropped). */
  function lookup(key, now) {
    if (typeof key !== 'string' || key.length === 0) return null
    const entry = liveEntry(key, clock(now))
    return entry ? { ...entry } : null
  }

  /** Drop every expired entry; returns the number removed. */
  function ttlSweep(now) {
    const at = clock(now)
    let removed = 0
    for (const [key, entry] of entries) {
      if (at >= entry.expiresAt) {
        entries.delete(key)
        removed += 1
      }
    }
    return removed
  }

  function stats() {
    return {
      enabled: m8.enabled,
      level: m8.level,
      ttlSeconds: m8.ttlSeconds,
      allowTools: [...m8.allowTools],
      entries: entries.size,
    }
  }

  return { decide, record, lookup, ttlSweep, stats }
}
