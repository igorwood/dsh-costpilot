/**
 * Configuration defaults, validation and resolution. Dependency-free.
 * @module dsh-costpilot/lib/config
 */
import os from 'node:os'
import path from 'node:path'

export const DEFAULTS = Object.freeze({
  mode: 'observe', // observe | assist | enforce
  dataDir: '',     // resolved later; default $DSH_HOME/costpilot
  // DSH normalizes provider usage so that `inputTokens` is the UNCACHED prompt size
  // (token-meter maps it to uncachedInputTokens; deepseek adapter sets
  // total = input + output + cacheRead + cacheWrite). Use 'inclusive' only for a
  // provider that reports inputTokens as the full prompt.
  usageSemantics: 'exclusive',
  // Billing currency of every price below. Amounts are in this currency; the
  // display symbol is derived from it (CNY -> ¥, USD -> $).
  currency: 'CNY',
  pricing: {
    // DeepSeek official CNY list prices (yuan / 1M tokens), peak/off-peak tiers:
    // https://api-docs.deepseek.com/zh-cn/quick_start/pricing
    // Off-peak is half price; peak windows live in peakPricing below.
    // `deepseek-account` is the DSH provider id for the desktop account route.
    'deepseek-account': {
      default: {
        uncachedInput: 1, cacheWrite: 1, cacheRead: 0.02, output: 4,
        peak: { uncachedInput: 2, cacheWrite: 2, cacheRead: 0.04, output: 8 },
      },
      'deepseek-v4-pro': {
        uncachedInput: 4.5, cacheWrite: 4.5, cacheRead: 0.15, output: 13.5,
        peak: { uncachedInput: 9, cacheWrite: 9, cacheRead: 0.3, output: 27 },
      },
    },
    deepseek: {
      'deepseek-chat': {
        uncachedInput: 1, cacheWrite: 1, cacheRead: 0.02, output: 4,
        peak: { uncachedInput: 2, cacheWrite: 2, cacheRead: 0.04, output: 8 },
      },
      'deepseek-reasoner': {
        uncachedInput: 4.5, cacheWrite: 4.5, cacheRead: 0.15, output: 13.5,
        peak: { uncachedInput: 9, cacheWrite: 9, cacheRead: 0.3, output: 27 },
      },
    },
    anthropic: {
      'claude-sonnet-5.5': { uncachedInput: 2.20, cacheWrite: 2.75, cacheRead: 0.11, output: 11.00 },
    },
    openai: {
      'gpt-6-luna': { uncachedInput: 0.11, cacheWrite: 0.1375, cacheRead: 0.011, output: 0.55 },
    },
  },
  // Beijing-time peak windows: prices double inside these weekday windows.
  peakPricing: {
    timeZone: 'Asia/Shanghai',
    windows: [
      { days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' },
      { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' },
    ],
  },
  // fallback used only when a route has no configured price; writes are billed at the
  // uncached-input price when a provider declares no separate cache-write price.
  cache: { assumeWarmWithinSeconds: 120 },
  budgets: { sessionUSD: 5, warnAtPct: 80, hardStopAtPct: 120 },
  modules: {
    M1: {
      enabled: true,
      // no module mode by default: inherit the top-level `mode`, so `mode: observe`
      // really means no mutation anywhere. Set M1.mode to override for one module.
      minDeltaTokens: 400,
      sideStore: true,
      marker: true,            // append a replayable [costpilot:m1 ...] marker to compressed results
      deleteOriginalsAfterDays: 30,
      formats: { log: true, json: true, diff: true, table: true, code: true },
      pointerMaxAgeTurns: 30,
    },
    M2: {
      enabled: false,          // off by default: history rewriting needs a calibrated cache model
      strategy: 'region',      // region GC through the compaction event protocol
      tauLineReuse: 0.3,
      maxRegionRatio: 0.6,
      minRemainingSteps: 6,
    },
    M3: {
      enabled: false,
      segmentSteps: 6,
      minStepsBefore: 10,
      maxCompactionsPerSession: 3,
      keepRecentSteps: 3,
    },
    M4: {
      enabled: true,           // v1.0: cross-session index is on by default (disable for minimal schema)
      indexPath: '.dsh-costpilot/index.db',
      maxFiles: 5000,
      maxRows: 200,
      queryTimeoutMs: 200,
      exclude: ['*.pem', '*.key', '*.env*', '*.p12', 'id_rsa*'],
      ignoreDirs: ['.git', 'node_modules', 'dist', 'build', '.venv', '__pycache__', '.next', 'target'],
      maxFileBytes: 2_000_000,
    },
    M5: {
      enabled: false,
      maxInjections: 3,
      firstTurns: 5,
      adaptive: true,
    },
    M6: {
      enabled: false,
      maxSwitches: 3,
      minRemainingSteps: 6,
      keep: ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'run_code'],
      hideCandidates: ['office', 'web_search', 'subagent', 'jobs', 'schedule', 'goal', 'workspace', 'skill'],
    },
    M7: {
      enabled: false,
      routeDown: { provider: 'deepseek-account', model: 'deepseek-flash' },
      phases: ['search', 'read'],
      minRemainingSteps: 10,
      maxSwitches: 2,
    },
    M8: {
      enabled: false,
      level: 'advisory',       // advisory | deny | cache
      allowTools: ['read', 'glob', 'grep', 'index_query'],
      ttlSeconds: 600,
    },
    M9: {
      enabled: true,
      // inherit the top-level mode unless overridden (see M1).
      maxSteps: 160,
      maxToolCalls: 400,
      maxTurnCostUSD: 1.0,
      noProgressSteps: 6,
      costSpikeMultiplier: 3,
      warnOncePerSession: true,
      hardStop: false,         // v1 default: never cancel; only warn + record
      hardStopSteps: 2,        // hard stop only after N consecutive breaches
      keepInbox: true,
      subagentLimit: 8,
    },
  },
  debug: false,
})

const MODES = new Set(['observe', 'assist', 'enforce'])

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value
  }
  return out
}

function expandHome(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  return value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value
}

/** Resolve a user config (object or undefined) into a validated, frozen config. */
export function resolveConfig(input = {}) {
  const merged = deepMerge(structuredClone(DEFAULTS), isPlainObject(input) ? input : {})
  // A user price entry replaces the shipped entry: do not inherit a peak tier
  // the user did not declare.
  const inputPricing = isPlainObject(input) && isPlainObject(input.pricing) ? input.pricing : {}
  for (const [provider, models] of Object.entries(inputPricing)) {
    if (!isPlainObject(models)) continue
    for (const [model, price] of Object.entries(models)) {
      const mergedEntry = merged.pricing?.[provider]?.[model]
      if (isPlainObject(mergedEntry) && !(isPlainObject(price) && isPlainObject(price.peak))) delete mergedEntry.peak
    }
  }
  const problems = []

  if (!MODES.has(merged.mode)) problems.push('mode must be observe|assist|enforce')
  if (!['inclusive', 'exclusive'].includes(merged.usageSemantics)) problems.push('usageSemantics must be inclusive|exclusive')
  if (typeof merged.currency !== 'string' || !/^[A-Z]{3}$/.test(merged.currency)) problems.push('currency must be a 3-letter ISO code, e.g. CNY')

  const dataDir = expandHome(merged.dataDir && merged.dataDir.length > 0
    ? merged.dataDir
    : path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'costpilot'))
  merged.dataDir = dataDir

  for (const [provider, models] of Object.entries(merged.pricing ?? {})) {
    if (typeof provider !== 'string' || !isPlainObject(models)) { problems.push('pricing must be provider -> model -> price'); continue }
    for (const [model, price] of Object.entries(models)) {
      if (!isPlainObject(price)) { problems.push(`pricing.${provider}.${model} must be an object`); continue }
      for (const field of ['uncachedInput', 'cacheRead', 'output']) {
        if (!Number.isFinite(price[field]) || price[field] < 0) problems.push(`pricing.${provider}.${model}.${field} must be a non-negative number`)
      }
      if (price.cacheWrite !== undefined && (!Number.isFinite(price.cacheWrite) || price.cacheWrite < 0)) problems.push(`pricing.${provider}.${model}.cacheWrite must be a non-negative number`)
    }
  }

  const b = merged.budgets ?? {}
  for (const field of ['sessionUSD']) {
    if (!Number.isFinite(b[field]) || b[field] <= 0) problems.push(`budgets.${field} must be a positive number`)
  }
  for (const field of ['warnAtPct', 'hardStopAtPct']) {
    if (!Number.isFinite(b[field]) || b[field] <= 0) problems.push(`budgets.${field} must be a positive number`)
  }
  if (Number.isFinite(b.hardStopAtPct) && Number.isFinite(b.warnAtPct) && b.hardStopAtPct < b.warnAtPct) {
    problems.push('budgets.hardStopAtPct must be >= warnAtPct')
  }

  for (const [id, moduleConfig] of Object.entries(merged.modules ?? {})) {
    if (!MODULE_ID_LIST.has(id)) problems.push(`modules.${id} is not a known module`)
    if (!isPlainObject(moduleConfig)) { problems.push(`modules.${id} must be an object`); continue }
    if (moduleConfig.mode !== undefined && !MODES.has(moduleConfig.mode)) problems.push(`modules.${id}.mode must be observe|assist|enforce`)
  }

  if (merged.debug !== undefined && typeof merged.debug !== 'boolean') problems.push('debug must be boolean')

  if (problems.length > 0) {
    const error = new Error('invalid dsh-costpilot config: ' + problems.join('; '))
    error.problems = problems
    error.config = merged
    throw error
  }
  return Object.freeze(merged)
}

const MODULE_ID_LIST = new Set(['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'])

/** True when a module runs in a mutating mode; observe only records decisions. */
export function isActive(config, id) {
  const moduleConfig = config.modules?.[id]
  if (!moduleConfig || moduleConfig.enabled !== true) return false
  const mode = moduleConfig.mode ?? config.mode
  return mode === 'assist' || mode === 'enforce'
}

/** True when decisions are recorded but no mutation is performed. */
export function isObserveOnly(config, id) {
  const moduleConfig = config.modules?.[id]
  if (!moduleConfig || moduleConfig.enabled !== true) return true
  return (moduleConfig.mode ?? config.mode) === 'observe'
}