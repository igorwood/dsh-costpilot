/**
 * Client-visible session projection: folds standard session events into the
 * CostPilot dock view (cost, tokens, M1 savings, guard warnings).
 *
 * It is a PURE event fold over standard events only:
 *  - request/header      -> route
 *  - assistant/message   -> usage -> USD
 *  - tool/result         -> parse the M1 marker appended by the compressor
 *  - user/message        -> parse CostPilot guard/steer markers (source.kind)
 *
 * The M1/M9 markers keep the fold replayable: no custom session event types are
 * introduced, and the same log always reconstructs the same view.
 *
 * @module dsh-costpilot/lib/projection
 */
import { normalizeUsage } from './contracts.js'
import { resolvePrice, costOfUsage } from './pricing.js'

export const PROJECTION_KEY = 'costpilot'
export const M1_MARKER_RE = /\[costpilot:m1\s+removed_tokens=(\d+)\s+added_tokens=(\d+)\s+pointers=(\d+)\]/
export const GUARD_MARKER_RE = /\[costpilot:guard\s+action=(warn|stop)\s+reason=([a-z0-9_-]+)\]/

const identitySchema = { parse: (value) => value }

/** @returns {object} fresh projection state */
export function initCostState() {
  return {
    calls: 0,
    usd: 0,
    confidence: 'provider',
    tokens: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    route: null,
    m1: { removedTokens: 0, addedTokens: 0, ops: 0 },
    guard: { count: 0, lastReason: null },
    lastSeq: -1,
    // Replacement slot for one attempt/settlement pair (turn:step).
    sampleKey: null,
    sampleBuckets: null,
    sampleUsd: 0,
  }
}

function textBlocks(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

function applyAssistantSample(next, data, options, at) {
  const usage = data?.usage
  if (!usage || next.route === null) {
    if (!usage) return next
    next.confidence = 'unknown'
    return next
  }
  const semantics = options.usageSemantics ?? 'exclusive'
  const buckets = normalizeUsage(usage, semantics)
  const price = resolvePrice({ pricing: options.pricing ?? {}, peakPricing: options.peakPricing }, next.route, at)
  const unknown = !price || price.source === 'unknown'
  const usd = unknown ? 0 : costOfUsage(price, usage, semantics).usd
  const key = String(data.turn ?? '-') + ':' + String(data.step ?? '-')
  if (next.sampleKey === key && next.sampleBuckets !== null) {
    // A retried attempt and its settlement share one slot: bill only the delta.
    const previous = next.sampleBuckets
    next.tokens.uncachedInput += buckets.uncachedInput - previous.uncachedInput
    next.tokens.cacheWrite += buckets.cacheWrite - previous.cacheWrite
    next.tokens.cacheRead += buckets.cacheRead - previous.cacheRead
    next.tokens.output += buckets.output - previous.output
    next.usd += usd - next.sampleUsd
  } else {
    next.tokens.uncachedInput += buckets.uncachedInput
    next.tokens.cacheWrite += buckets.cacheWrite
    next.tokens.cacheRead += buckets.cacheRead
    next.tokens.output += buckets.output
    next.usd += usd
    next.calls += 1
  }
  next.sampleKey = key
  next.sampleBuckets = buckets
  next.sampleUsd = usd
  if (unknown) next.confidence = 'unknown'
  return next
}

/**
 * Fold one committed session event into the projection state.
 * @param {object} state
 * @param {any} event
 * @param {{ pricing?: object, usageSemantics?: 'inclusive'|'exclusive' }} [options]
 */
export function applyCostProjection(state, event, options = {}) {
  const seq = Number.isFinite(event?.seq) ? event.seq : -1
  if (seq >= 0 && seq <= state.lastSeq) return state
  const next = { ...state, tokens: { ...state.tokens }, m1: { ...state.m1 }, guard: { ...state.guard }, lastSeq: seq }
  const data = event?.data ?? {}

  if (event?.type === 'request/header') {
    const config = data.header?.config
    if (config?.provider && config?.model) next.route = { provider: config.provider, model: config.model }
    return next
  }

  if (event?.type === 'assistant/message') {
    return applyAssistantSample(next, data, options, event?.time)
  }

  if (event?.type === 'assistant/attempt') {
    // A retried/aborted attempt is billed too; the settlement replaces its slot.
    return applyAssistantSample(next, data, options)
  }

  if (event?.type === 'llm/retry-started') {
    next.sampleKey = null
    next.sampleBuckets = null
    next.sampleUsd = 0
    return next
  }

  if (event?.type === 'compaction/summary') {
    // A model-backed compaction summarisation is a real (billed) call.
    const usage = data.usage
    if (usage !== undefined && typeof data.provider === 'string' && typeof data.model === 'string') {
      const semantics = options.usageSemantics ?? 'exclusive'
      const buckets = normalizeUsage(usage, semantics)
      next.tokens.uncachedInput += buckets.uncachedInput
      next.tokens.cacheWrite += buckets.cacheWrite
      next.tokens.cacheRead += buckets.cacheRead
      next.tokens.output += buckets.output
      const route = { provider: data.provider, model: data.model }
      const price = resolvePrice({ pricing: options.pricing ?? {}, peakPricing: options.peakPricing }, route, event?.time)
      if (price && price.source !== 'unknown') {
        next.usd += costOfUsage(price, usage, semantics).usd
      } else {
        next.confidence = 'unknown'
      }
      next.calls += 1
    }
    return next
  }

  if (event?.type === 'tool/result' || event?.type === 'tool/ptc-dispatch') {
    // PTC inner tool results commit as tool/ptc-dispatch (outer run_code is tool/result).
    const text = event.type === 'tool/ptc-dispatch'
      ? (Array.isArray(data.content) ? data.content.filter((block) => block && block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('') : '')
      : textBlocks(data.message)
    const match = M1_MARKER_RE.exec(text)
    if (match) {
      next.m1.removedTokens += Number(match[1])
      next.m1.addedTokens += Number(match[2])
      next.m1.ops += 1
    }
    return next
  }

  if (event?.type === 'user/message') {
    const source = data.source
    if (source?.kind !== 'costpilot') return next
    const text = textBlocks(data)
    const match = GUARD_MARKER_RE.exec(text)
    if (match) {
      next.guard.count += 1
      next.guard.lastReason = match[2]
    }
    return next
  }

  return next
}

/**
 * Build the SessionProjectionDefinition for the costpilot key.
 * @param {{ mode?: string, modules?: object, pricing?: object, usageSemantics?: string }} options
 */
export function createCostProjectionDefinition(options = {}) {
  const mode = options.mode ?? 'observe'
  const currency = typeof options.currency === 'string' ? options.currency : 'CNY'
  // modules may be a live getter so runtime toggles (/costpilot on/off) show up.
  const modulesOf = () => (typeof options.modules === 'function' ? options.modules() : options.modules) ?? {}
  const enabled = (id) => modulesOf()?.[id]?.enabled === true
  const m1Enabled = enabled('M1')
  const m9Enabled = enabled('M9')
  return {
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: identitySchema,
    init: () => initCostState(),
    apply: (state, event) => applyCostProjection(state, event, options),
    wire: {
      viewSchema: identitySchema,
      view: (state) => ({
        mode,
        m1Enabled: enabled('M1'),
        m9Enabled: enabled('M9'),
        modules: Object.fromEntries(['M1','M2','M3','M4','M5','M6','M7','M8','M9'].map((id) => [id, enabled(id)])),
        calls: state.calls,
        usd: Number(state.usd.toFixed(6)),
        cost: Number(state.usd.toFixed(6)),
        currency,
        confidence: state.confidence,
        tokens: { ...state.tokens },
        m1: { ...state.m1 },
        guard: { ...state.guard },
        route: state.route,
      }),
    },
  }
}