/**
 * dsh-costpilot: shared contracts. No imports. Keep this file dependency-free so
 * every module (and tests) can consume the same shapes.
 *
 * @module dsh-costpilot/lib/contracts
 */

/** Ledger format version written into every record. */
export const LEDGER_VERSION = 1

/** Modules of the plugin (v0.1 implements M1 and M9 only). */
export const MODULE_IDS = Object.freeze(['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'])

/** Confidence of a cost figure. */
export const CONFIDENCE = Object.freeze({
  PROVIDER: 'provider',   // usage reported by the provider
  HEURISTIC: 'heuristic', // estimated tokens (4 chars/token) or configured price fallback
  UNKNOWN: 'unknown',     // no price for the route: tokens recorded, USD not claimed
})

/** Guard actions, ordered by severity. */
export const GUARD_ACTION = Object.freeze({
  NONE: 'none',
  WARN: 'warn',   // inject one advisory user message into the next step
  STOP: 'stop',   // reject the step and (optionally) cancel the agent
})

/**
 * @typedef {{ provider: string, model: string, reasoningEffort?: string }} Route
 * @typedef {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number, totalTokens?: number, reasoningTokens?: number }} Usage
 * @typedef {{ uncachedInput: number, cacheWrite: number, cacheRead: number, output: number, writePremium: boolean, source: 'config'|'default'|'unknown' }} Price
 * @typedef {{ read: number, write: number, uncached: number, output: number, total: number }} CostBreakdown
 *
 * @typedef {object} CostEvent
 * @property {1} v
 * @property {string} kind  llm_call | tool_call | tool_result | mutation | guard | turn | session
 * @property {string} sessionId
 * @property {number} ts          epoch ms
 * @property {number} [seq]       session seq when known
 * @property {number} [turn]
 * @property {number} [step]
 * @property {Route} [route]
 * @property {Usage} [usage]
 * @property {number} [usd]
 * @property {string} [confidence]
 * @property {object} [extra]     kind-specific payload (compression metrics, guard reason, ...)
 */

/**
 * Sample one session/event into zero or more ledger records.
 * @typedef {(session: any, event: any) => CostEvent[]} SessionEventSampler
 */

/**
 * @typedef {object} LedgerSummary
 * @property {string} sessionId
 * @property {number} usd
 * @property {{ uncachedInput: number, cacheRead: number, cacheWrite: number, output: number }} tokens
 * @property {{ calls: number, turns: number, steps: number, tools: number }} counts
 * @property {Record<string, { usd: number, removedTokens: number, addedTokens: number, count: number }>} byModule
 */

/** Convert a provider usage record to the four normalized buckets used by the design.
 * @param {Usage} usage
 * @param {'inclusive'|'exclusive'} [semantics] exclusive (DSH default): inputTokens is already the uncached prompt size;
 *   inclusive: inputTokens counts every prompt token (cache buckets must be subtracted)
 * @returns {{ uncachedInput: number, cacheWrite: number, cacheRead: number, output: number }}
 */
export function normalizeUsage(usage, semantics = 'exclusive') {
  const u = usage ?? {}
  const input = Number.isFinite(u.inputTokens) ? u.inputTokens : 0
  const cacheRead = Number.isFinite(u.cacheReadTokens) ? u.cacheReadTokens : 0
  const cacheWrite = Number.isFinite(u.cacheWriteTokens) ? u.cacheWriteTokens : 0
  const output = Number.isFinite(u.outputTokens) ? u.outputTokens : 0
  const uncachedInput = semantics === 'exclusive'
    ? Math.max(0, input)
    : Math.max(0, input - cacheRead - cacheWrite)
  return { uncachedInput, cacheWrite, cacheRead, output }
}

/** Stable 64-bit-ish hash for tool arguments / keys (FNV-1a 32-bit, hex). */
export function hashKey(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** Text content of a model-visible message or content-block array. */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}
