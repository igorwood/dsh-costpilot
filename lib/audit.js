/**
 * tokenUsage reconciliation (design section 5.1, sampling path 2).
 *
 * The ledger is the authority; the host tokenUsage projection is the independent
 * cross-check. At each turn end the four buckets are compared bucket by bucket:
 *   ledger.tokens: uncachedInput / cacheRead / cacheWrite / output
 *   tokenUsage:    uncachedInputTokens / cacheReadTokens / cacheWriteTokens / outputTokens
 *
 * A bucket is a mismatch only when the deviation is BOTH above the relative
 * tolerance (2%) AND above the absolute noise floor (100 tokens), so tiny
 * rounding differences on large sessions never trip the alarm while a systematic
 * semantic drift does. Thresholds can be overridden with the optional second
 * argument.
 *
 * Pure function, no IO, zero dependencies.
 *
 * @module dsh-costpilot/lib/audit
 */

/** Default reconciliation thresholds (design section 5.1 / v1 contract D). */
export const RECONCILE_THRESHOLDS = Object.freeze({
  relative: 0.02,      // 2% of the ledger value
  absoluteTokens: 100, // tokens
})

const BUCKETS = Object.freeze([
  Object.freeze({
    name: 'uncachedInput',
    projected: 'uncachedInputTokens',
    ledgerAliases: Object.freeze(['uncachedInput', 'uncachedInputTokens', 'inputTokens']),
  }),
  Object.freeze({
    name: 'cacheRead',
    projected: 'cacheReadTokens',
    ledgerAliases: Object.freeze(['cacheRead', 'cacheReadTokens']),
  }),
  Object.freeze({
    name: 'cacheWrite',
    projected: 'cacheWriteTokens',
    ledgerAliases: Object.freeze(['cacheWrite', 'cacheWriteTokens']),
  }),
  Object.freeze({
    name: 'output',
    projected: 'outputTokens',
    ledgerAliases: Object.freeze(['output', 'outputTokens']),
  }),
])

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveNumber(value) {
  return Number.isFinite(value) && value > 0
}

function pickNumber(source, keys) {
  if (!isObject(source)) return 0
  for (const key of keys) {
    const value = source[key]
    if (Number.isFinite(value)) return value
  }
  return 0
}

function normalizeThresholds(overrides) {
  const input = isObject(overrides) ? overrides : {}
  return {
    relative: isPositiveNumber(input.relative) ? input.relative : RECONCILE_THRESHOLDS.relative,
    absoluteTokens: isPositiveNumber(input.absoluteTokens) ? input.absoluteTokens : RECONCILE_THRESHOLDS.absoluteTokens,
  }
}

/**
 * Reconcile the ledger's token buckets against the host tokenUsage projection.
 *
 * @param {{ledger?: {tokens?: object}|object, tokenUsage?: object}} input
 *   ledger.tokens (or a bare tokens object) plus the tokenUsage projection view.
 * @param {{relative?: number, absoluteTokens?: number}} [thresholds]
 * @returns {{
 *   ok: boolean,
 *   deltas: Record<'uncachedInput'|'cacheRead'|'cacheWrite'|'output', number>,
 *   mismatched: string[],
 *   relativeDeltas: Record<string, number>,
 *   totals: {ledger: number, tokenUsage: number, delta: number},
 *   thresholds: {relative: number, absoluteTokens: number},
 * }}
 */
export function reconcileUsage({ ledger, tokenUsage } = {}, thresholds) {
  const limits = normalizeThresholds(thresholds)
  const ledgerTokens = isObject(ledger) && isObject(ledger.tokens) ? ledger.tokens : (isObject(ledger) ? ledger : {})
  const projected = isObject(tokenUsage) ? tokenUsage : {}

  const deltas = {}
  const relativeDeltas = {}
  const mismatched = []
  let ledgerTotal = 0
  let projectedTotal = 0

  for (const bucket of BUCKETS) {
    const ledgerValue = pickNumber(ledgerTokens, bucket.ledgerAliases)
    const projectedValue = pickNumber(projected, [bucket.projected])
    const delta = projectedValue - ledgerValue
    const absolute = Math.abs(delta)
    const relative = absolute / Math.max(Math.abs(ledgerValue), 1)

    deltas[bucket.name] = delta
    relativeDeltas[bucket.name] = relative
    ledgerTotal += ledgerValue
    projectedTotal += projectedValue

    const absoluteBreach = absolute > limits.absoluteTokens
    const relativeBreach = relative > limits.relative
    if (absoluteBreach && relativeBreach) mismatched.push(bucket.name)
  }

  return {
    ok: mismatched.length === 0,
    deltas,
    mismatched,
    relativeDeltas,
    totals: { ledger: ledgerTotal, tokenUsage: projectedTotal, delta: projectedTotal - ledgerTotal },
    thresholds: { relative: limits.relative, absoluteTokens: limits.absoluteTokens },
  }
}
