/**
 * Price resolution and usage -> USD conversion for dsh-costpilot. Dependency-free.
 *
 * Prices in the config are USD per 1,000,000 tokens. Resolution order follows
 * design section 5.1: exact provider/model -> wildcard model key -> provider
 * default -> global default -> unknown. An unknown route still yields a Price
 * object with zero rates and source 'unknown': callers record provider token
 * counts but do not claim USD or savings (contracts.CONFIDENCE.UNKNOWN).
 *
 * @module dsh-costpilot/lib/pricing
 */
import { normalizeUsage } from './contracts.js'

const PER_MILLION = 1e6
const USD_SCALE = 1e8

/** Round a USD amount to the ledger precision of 1e-8. @param {number} value @returns {number} */
export function roundUSD(value) {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * USD_SCALE) / USD_SCALE
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function unknownPrice() {
  return { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0, writePremium: false, source: 'unknown' }
}

function minutesOf(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

/** True when `at` (epoch ms) falls inside a configured weekday peak window. */
export function isPeakAt(at, peakPricing) {
  if (!Number.isFinite(at) || !isPlainObject(peakPricing) || !Array.isArray(peakPricing.windows)) return false
  const timeZone = typeof peakPricing.timeZone === 'string' ? peakPricing.timeZone : 'Asia/Shanghai'
  let parts
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(at))
  } catch {
    return false
  }
  const get = (type) => (parts.find((part) => part.type === type)?.value ?? '')
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const day = dayMap[get('weekday')]
  const hour = Number(get('hour')) % 24
  const minute = Number(get('minute'))
  if (!Number.isFinite(day)) return false
  const minutes = hour * 60 + minute
  for (const window of peakPricing.windows) {
    if (!isPlainObject(window) || !Array.isArray(window.days) || !window.days.includes(day)) continue
    const start = minutesOf(window.start)
    const end = minutesOf(window.end)
    if (start === null || end === null) continue
    if (minutes >= start && minutes < end) return true
  }
  return false
}

/** Build a resolved Price from one pricing-table entry; null when the entry is invalid. */
function priceFrom(raw, source, peak = false) {
  if (!isPlainObject(raw)) return null
  const rates = peak && isPlainObject(raw.peak) ? raw.peak : raw
  if (!isRate(rates.uncachedInput) || !isRate(rates.cacheRead) || !isRate(rates.output)) return null
  const explicitWrite = isRate(rates.cacheWrite)
  // Providers that declare no separate cache-write fee bill writes at the uncached input price.
  const cacheWrite = explicitWrite ? rates.cacheWrite : rates.uncachedInput
  return {
    uncachedInput: rates.uncachedInput,
    cacheWrite,
    cacheRead: rates.cacheRead,
    output: rates.output,
    // True only when a cache write actually costs more than an uncached input token.
    writePremium: cacheWrite > rates.uncachedInput,
    source,
    ...(peak ? { tier: 'peak' } : (isPlainObject(raw.peak) ? { tier: 'off-peak' } : {})),
  }
}

/** Glob-ish model match supporting '*', e.g. 'gpt-6-*'. Deterministic, no regex. */
function matchesWildcard(pattern, value) {
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === value
  const parts = pattern.split('*')
  if (!value.startsWith(parts[0])) return false
  let index = parts[0].length
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]
    if (part.length === 0) continue
    const found = value.indexOf(part, index)
    if (found < 0) return false
    index = found + part.length
  }
  if (!pattern.endsWith('*') && !value.endsWith(parts[parts.length - 1])) return false
  return true
}

/**
 * Resolve a route to a price.
 * @param {any} config resolved config (only config.pricing is read)
 * @param {{provider?: string, model?: string, reasoningEffort?: string}|null|undefined} route
 * @returns {{uncachedInput: number, cacheWrite: number, cacheRead: number, output: number, writePremium: boolean, source: 'config'|'default'|'unknown'}}
 */
export function resolvePrice(config, route, at) {
  // Accept either a resolved config ({ pricing, peakPricing }) or the pricing table
  // itself (provider -> model -> price).
  const pricing = isPlainObject(config?.pricing) ? config.pricing : (isPlainObject(config) ? config : {})
  const peakPricing = isPlainObject(config?.peakPricing) ? config.peakPricing : undefined
  const peak = isPeakAt(at, peakPricing)
  const provider = typeof route?.provider === 'string' ? route.provider.trim() : ''
  const model = typeof route?.model === 'string' ? route.model.trim() : ''
  if (provider.length === 0 || model.length === 0) return unknownPrice()

  const table = isPlainObject(pricing[provider]) ? pricing[provider] : null
  if (table) {
    const exact = priceFrom(table[model], 'config', peak)
    if (exact) return exact
    // Sorted wildcard order keeps resolution deterministic.
    for (const key of Object.keys(table).sort()) {
      if (key === 'default' || key === '*' || !key.includes('*')) continue
      const wildcard = priceFrom(table[key], 'config', peak)
      if (wildcard && matchesWildcard(key, model)) return wildcard
    }
    const providerDefault = priceFrom(table.default, 'config', peak) ?? priceFrom(table['*'], 'config', peak)
    if (providerDefault) return providerDefault
  }

  const globalDefault = priceFrom(pricing.default, 'default', peak) ?? priceFrom(pricing['*'], 'default', peak)
  if (globalDefault) return globalDefault
  return unknownPrice()
}

/**
 * Convert a provider usage record into USD plus a four-bucket cost breakdown.
 *
 * semantics describes usage.inputTokens: 'inclusive' (default) means it counts
 * every prompt token including cache reads and writes; 'exclusive' means it
 * counts only uncached input. Unknown prices produce usd 0 and zero costs:
 * token counts belong in the ledger, USD does not.
 *
 * @param {any} price resolved Price
 * @param {any} usage provider-shaped usage (inputTokens?, outputTokens?, cacheReadTokens?, cacheWriteTokens?)
 * @param {'inclusive'|'exclusive'} [semantics]
 * @returns {{usd: number, breakdown: {read: number, write: number, uncached: number, output: number, total: number}}}
 */
export function costOfUsage(price, usage, semantics = 'inclusive') {
  const buckets = normalizeUsage(isPlainObject(usage) ? usage : {}, semantics)
  const known = isPlainObject(price) && price.source !== 'unknown'
  const rates = known
    ? {
        uncachedInput: isRate(price.uncachedInput) ? price.uncachedInput : 0,
        cacheWrite: isRate(price.cacheWrite) ? price.cacheWrite : (isRate(price.uncachedInput) ? price.uncachedInput : 0),
        cacheRead: isRate(price.cacheRead) ? price.cacheRead : 0,
        output: isRate(price.output) ? price.output : 0,
      }
    : { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 }

  const uncached = rates.uncachedInput * buckets.uncachedInput / PER_MILLION
  const write = rates.cacheWrite * buckets.cacheWrite / PER_MILLION
  const read = rates.cacheRead * buckets.cacheRead / PER_MILLION
  const output = rates.output * buckets.output / PER_MILLION
  const total = roundUSD(uncached + write + read + output)
  return {
    usd: total,
    breakdown: {
      read: roundUSD(read),
      write: roundUSD(write),
      uncached: roundUSD(uncached),
      output: roundUSD(output),
      total,
    },
  }
}