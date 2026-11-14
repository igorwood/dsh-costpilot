/**
 * CostOracle: DSH version of Eq.2 (suffix-breakpoint form), cache warmth, and
 * apply/skip decisions. Dependency-free and deterministic.
 *
 * Formula (design section 5.2.1, derivation in appendix C):
 *
 *   S = p_r * N * delta
 *       - (p_w - p_r) * suffix
 *       - C_llm
 *       - risk * C_extra
 *
 * where suffix is the token count that must be rewritten after the last cache
 * breakpoint, N is the remaining call count, and all prices are USD per 1M
 * tokens. A pure-append rewrite has suffix 0, so it never pays a rewrite cost.
 *
 * @module dsh-costpilot/lib/oracle
 */
import { roundUSD } from './pricing.js'

const PER_MILLION = 1e6
const DEFAULT_TTL_SECONDS = 120

function toNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function nonNegative(value) {
  const number = toNumber(value)
  return number > 0 ? number : 0
}

function clamp01(value) {
  return Math.min(1, Math.max(0, nonNegative(value)))
}

/**
 * Infer whether the provider prefix cache is warm for the next call.
 *
 * startsSeries (from request/header) wins: a new series must rebuild the prefix,
 * so it is cold regardless of timing. Otherwise the cache is warm when the last
 * call happened within ttlSeconds. Missing timing evidence is treated as cold,
 * which underestimates savings and never over-claims (design section 5.2.2).
 *
 * @param {{lastCallAt?: number, now?: number, startsSeries?: boolean, ttlSeconds?: number}} [input]
 * @returns {{warm: boolean, ageSeconds: number|null, ttlSeconds: number}}
 */
export function cacheState(input = {}) {
  const ttl = typeof input.ttlSeconds === 'number' && Number.isFinite(input.ttlSeconds) && input.ttlSeconds >= 0
    ? input.ttlSeconds
    : DEFAULT_TTL_SECONDS
  if (input.startsSeries === true) return { warm: false, ageSeconds: null, ttlSeconds: ttl }
  if (!Number.isFinite(input.lastCallAt) || !Number.isFinite(input.now)) {
    return { warm: false, ageSeconds: null, ttlSeconds: ttl }
  }
  const ageSeconds = Math.max(0, (input.now - input.lastCallAt) / 1000)
  return { warm: ageSeconds <= ttl, ageSeconds, ttlSeconds: ttl }
}

/**
 * Expected net USD saving of removing deltaTokens from the context when N more
 * calls remain. Positive means the mutation is predicted to pay for itself.
 *
 * @param {{price?: any, remainingCalls?: number, deltaTokens?: number, suffixTokens?: number, llmUSD?: number, extraTurnRisk?: number, extraTurnUSD?: number}} [input]
 * @returns {{readSavingsUSD: number, rewriteCostUSD: number, netUSD: number, formula: string}}
 */
export function savingsForRemoval(input = {}) {
  const price = input.price ?? {}
  const readRate = nonNegative(price.cacheRead)
  const writeRate = Number.isFinite(price.cacheWrite) && price.cacheWrite >= 0
    ? price.cacheWrite
    : (Number.isFinite(price.uncachedInput) && price.uncachedInput >= 0 ? price.uncachedInput : readRate)
  const remainingCalls = nonNegative(input.remainingCalls)
  const deltaTokens = nonNegative(input.deltaTokens)
  const suffixTokens = nonNegative(input.suffixTokens)
  const llmUSD = nonNegative(input.llmUSD)
  const extraTurnRisk = clamp01(input.extraTurnRisk)
  const extraTurnUSD = nonNegative(input.extraTurnUSD)

  const readSavingsUSD = roundUSD(readRate * remainingCalls * deltaTokens / PER_MILLION)
  const rewriteCostUSD = roundUSD(Math.max(0, writeRate - readRate) * suffixTokens / PER_MILLION)
  const extraCostUSD = roundUSD(extraTurnRisk * extraTurnUSD)
  const netUSD = roundUSD(readSavingsUSD - rewriteCostUSD - llmUSD - extraCostUSD)
  const formula = 'S = p_r*N*delta - (p_w-p_r)*suffix - C_llm - risk*C_extra = ' +
    readSavingsUSD + ' - ' + rewriteCostUSD + ' - ' + llmUSD + ' - ' + extraCostUSD + ' = ' + netUSD

  return { readSavingsUSD, rewriteCostUSD, netUSD, formula }
}

/**
 * Apply when net savings strictly exceed the configured minimum.
 * @param {{netUSD?: number, minNetUSD?: number}} [input]
 * @returns {boolean}
 */
export function shouldApply(input = {}) {
  const netUSD = toNumber(input.netUSD)
  const minNetUSD = toNumber(input.minNetUSD)
  return netUSD > minNetUSD
}
