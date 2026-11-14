/**
 * M5/M6/M7: per-step turn policies — tool-call batching nudge, tool-set
 * scheduling, and route-down selection.
 *
 * Design references:
 *  - §6.5 M5: append one user/message (source= costpilot:nudge) in
 *    agent/pre-step. Only suggest while turn <= firstTurns, or after three
 *    consecutive single-call steps in the search/read phases; cap at
 *    maxInjections per session; self-disable online when calls/turn does not
 *    rise or total cost rises (adaptive).
 *  - §6.6 M6: hide large-schema tools that match `hideCandidates` prefixes and
 *    are not in the exact-name `keep` list. `restrict` is subtractive only and
 *    never names run_code (§4.6 R10); the tool set is resolved before pre-step,
 *    so the saving is priced with N-hat - 1. An UNKNOWN_TOOL request restores
 *    the hidden tool (noteUnknownTool / shouldRestore).
 *  - §6.7 M7: choose the cheaper route only in configured low-risk phases, with
 *    enough remaining steps, a known and different current route, and below
 *    maxSwitches. Default off (accuracy + cache invalidation risk).
 *
 * Every strategy is pure and deterministic (no IO, clocks or randomness). The
 * only mutable state is the explicit counters exposed via noteInjected,
 * noteSwitch, noteUnknownTool and switches(). The executor (index.js) owns the
 * side effects: appending messages, ctx.tools.restrict, agent.model.select.
 *
 * @module dsh-costpilot/lib/turn-policy
 */
import { resolvePrice } from './pricing.js'
import { savingsForRemoval } from './oracle.js'

/**
 * M5 message: the converged version of the paper Appendix C batched-tool-call
 * prompt (design §6.5 asks for ~120 tokens; this is <= 140 English tokens).
 * Plain ASCII, one paragraph, no template holes — deterministic.
 */
export const BATCHING_NUDGE_TEXT = 'Batch independent tool calls: when you can write a call\'s arguments now, without seeing another call\'s result, issue all of those calls as several tool calls in one response. For example, read several files or search several names at once. Make a call in a later turn only when it needs an earlier result, such as editing a file you have just read. Think ahead: ask for everything you need next at once, but do not add calls you do not need. One call is fine when there is only one thing to do.'

/** M6 only suggests hiding a tool whose declaration costs at least this many tokens. */
export const MIN_HIDE_SCHEMA_TOKENS = 300

/** Phases where a run of single-call steps means the model is not batching (M5). */
const SINGLE_CALL_PHASES = new Set(['search', 'read'])

/** Tools that `ctx.tools.restrict` must never name (design §6.6, §4.6 R10). */
const NEVER_HIDE = new Set(['run_code'])

const DEFAULT_M5 = Object.freeze({
  enabled: false,
  maxInjections: 3,
  firstTurns: 5,
  adaptive: true,
})

const DEFAULT_M6 = Object.freeze({
  enabled: false,
  maxSwitches: 3,
  minRemainingSteps: 6,
  keep: Object.freeze(['bash', 'read', 'write', 'edit', 'glob', 'grep', 'run_code']),
  hideCandidates: Object.freeze(['office', 'web_search', 'subagent', 'jobs', 'schedule', 'goal', 'workspace', 'skill']),
})

const DEFAULT_M7 = Object.freeze({
  enabled: false,
  routeDown: Object.freeze({ provider: 'deepseek-account', model: 'deepseek-flash' }),
  phases: Object.freeze(['search', 'read']),
  minRemainingSteps: 10,
  maxSwitches: 2,
})

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstFinite(...values) {
  for (const value of values) if (Number.isFinite(value)) return value
  return NaN
}

/** Non-negative integer config value with a fallback; 0 is a valid setting. */
function integerAtLeast(value, minimum, fallback) {
  if (!Number.isFinite(value)) return fallback
  const floored = Math.floor(value)
  return floored >= minimum ? floored : fallback
}

/** Array of non-empty strings; anything else falls back to the defaults. */
function stringList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  const out = []
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) out.push(item)
  }
  return out
}

/**
 * Read one module slice from either a resolved config ({ modules: { M5 } }), a
 * bare slice ({ M5 }), or a bare module config ({ enabled, ... }) — same
 * tolerance as lib/guard.js. Unknown keys are ignored by construction.
 */
function pickModule(config, id, defaults) {
  const merged = { ...defaults }
  const source = isObject(config) ? config : {}
  let slice = null
  if (isObject(source.modules) && isObject(source.modules[id])) slice = source.modules[id]
  else if (isObject(source[id])) slice = source[id]
  else if (!('modules' in source) && !('pricing' in source) && Object.keys(defaults).some((key) => key in source)) slice = source
  if (slice) {
    for (const [key, value] of Object.entries(slice)) if (value !== undefined) merged[key] = value
  }
  return merged
}

/** True when the last three tool names are all present and pairwise different. */
function isConsecutiveSingleCalls(recentToolNames) {
  if (!Array.isArray(recentToolNames) || recentToolNames.length < 3) return false
  const last = recentToolNames.slice(-3)
  if (!last.every((name) => typeof name === 'string' && name.length > 0)) return false
  return new Set(last).size === last.length
}

function hasPrefixMatch(name, candidates) {
  for (const candidate of candidates) {
    if (candidate.length > 0 && name.startsWith(candidate)) return true
  }
  return false
}

/** Resolve the price used to price an M6 saving: explicit price > route > 0. */
function resolvePlanPrice(input, moduleSlice, config) {
  if (isObject(input.price)) return input.price
  if (isObject(moduleSlice.price)) return moduleSlice.price
  const route = isObject(input.route) ? input.route : (isObject(input.currentRoute) ? input.currentRoute : null)
  if (!route) return null
  // A caller may pass either a full resolved config or the bare M6 slice; the
  // latter has no pricing table, so resolution degrades to "unknown" (0 USD).
  const price = resolvePrice(config, route, Date.now())
  return price.source === 'unknown' ? null : price
}

/**
 * M6 net saving, design §6.6: S = p_r * (N-1) * delta_schema
 * - (p_w - p_r) * suffix - E[hidden tool needed] * C_extra.
 * Reuses the §5.2 oracle; hidden-tool risk defaults to 0. Unknown price => 0.
 */
function estimateNetUSD({ price, remainingSteps, schemaTokensSaved, suffixTokens }) {
  if (!isObject(price)) return 0
  const remainingCalls = Math.max(0, Math.floor(remainingSteps) - 1)
  const suffix = Number.isFinite(suffixTokens) && suffixTokens > 0 ? suffixTokens : 0
  return savingsForRemoval({ price, remainingCalls, deltaTokens: schemaTokensSaved, suffixTokens: suffix }).netUSD
}

/**
 * M5: tool-call batching nudge.
 *
 * @param {{config?: object}} [options] resolved CostPilot config (or a bare M5 slice)
 * @returns {{
 *   plan: (request?: {turn?: number, step?: number, callsPerTurn?: number, recentToolNames?: string[], phase?: string}) => {inject: true, text: string} | null,
 *   noteInjected: () => void,
 *   shouldDisable: (request?: {after?: {callsPerTurn?: number, costDelta?: number, costDeltaUSD?: number}}) => boolean,
 * }}
 */
export function createBatchingNudge({ config = {} } = {}) {
  const m5 = pickModule(config, 'M5', DEFAULT_M5)
  const maxInjections = integerAtLeast(m5.maxInjections, 0, DEFAULT_M5.maxInjections)
  const firstTurns = integerAtLeast(m5.firstTurns, 0, DEFAULT_M5.firstTurns)

  let injections = 0
  let disabled = false
  let injectedAtLeastOnce = false
  let pendingBaseline = 1
  let baselineCallsPerTurn = 1

  /** Pure decision; the caller appends the message and then calls noteInjected(). */
  function plan(request = {}) {
    const input = isObject(request) ? request : {}
    if (m5.enabled !== true || disabled) return null
    if (injections >= maxInjections) return null

    const calls = Number.isFinite(input.callsPerTurn) && input.callsPerTurn >= 0 ? input.callsPerTurn : null
    const withinFirstTurns = Number.isFinite(input.turn) && input.turn <= firstTurns
    const consecutiveSingleCalls = calls !== null &&
      calls <= 1 &&
      SINGLE_CALL_PHASES.has(input.phase) &&
      isConsecutiveSingleCalls(input.recentToolNames)
    if (!withinFirstTurns && !consecutiveSingleCalls) return null

    // Baseline for the adaptive check: how many calls/turn the model already
    // made when the nudge went in (batching should raise it). plan stays free of
    // committed state; noteInjected() commits this baseline.
    pendingBaseline = calls !== null && calls > 0 ? calls : 1
    return { inject: true, text: BATCHING_NUDGE_TEXT }
  }

  /** Explicit counter; index.js calls this once per committed injection. */
  function noteInjected() {
    injections += 1
    injectedAtLeastOnce = true
    baselineCallsPerTurn = pendingBaseline
  }

  /**
   * Online auto-off (design §6.5). Returns true — and disables M5 for this
   * session — when calls/turn did not rise above the injection baseline or the
   * measured cost delta is positive. `costDeltaUSD` is accepted as an alias of
   * `costDelta`. Adaptive:false keeps M5 on and returns false.
   */
  function shouldDisable(request = {}) {
    const after = isObject(request) && isObject(request.after) ? request.after : {}
    if (m5.adaptive !== true) return false
    if (disabled) return true
    if (!injectedAtLeastOnce) return false

    const costDelta = firstFinite(after.costDelta, after.costDeltaUSD)
    if (Number.isFinite(costDelta) && costDelta > 0) {
      disabled = true
      return true
    }
    const calls = firstFinite(after.callsPerTurn)
    if (Number.isFinite(calls) && calls <= baselineCallsPerTurn) {
      disabled = true
      return true
    }
    return false
  }

  return { plan, noteInjected, shouldDisable }
}

/**
 * M6: tool-set scheduling. Produces a subtractive deny list; index.js applies
 * it with agent.ctx.tools.restrict (next step, one-step lag).
 *
 * @param {{config?: object}} [options] resolved CostPilot config (or a bare M6 slice)
 * @returns {{
 *   plan: (request?: {step?: number, phase?: string, tools?: Array<{name: string, schemaTokens: number}>, remainingSteps?: number, price?: object, route?: object, suffixTokens?: number}) => {deny: string[], schemaTokensSaved: number, netUSD: number} | null,
 *   noteSwitch: () => void,
 *   noteUnknownTool: (name: string) => void,
 *   shouldRestore: (name: string) => boolean,
 * }}
 */
export function createToolsetScheduler({ config = {} } = {}) {
  const m6 = pickModule(config, 'M6', DEFAULT_M6)
  const keep = stringList(m6.keep, DEFAULT_M6.keep)
  const hideCandidates = stringList(m6.hideCandidates, DEFAULT_M6.hideCandidates)
  const maxSwitches = integerAtLeast(m6.maxSwitches, 0, DEFAULT_M6.maxSwitches)
  const minRemainingSteps = integerAtLeast(m6.minRemainingSteps, 0, DEFAULT_M6.minRemainingSteps)
  const keepSet = new Set(keep)
  const restore = new Set()
  let switches = 0

  /**
   * Decide one tool-set switch. Returns null when M6 is off, the session already
   * spent maxSwitches, too few steps remain, or nothing qualifies. The deny list
   * is subtractive: it only contains names present in `tools`, never keep names
   * and never run_code.
   */
  function plan(request = {}) {
    const input = isObject(request) ? request : {}
    if (m6.enabled !== true) return null
    if (switches >= maxSwitches) return null
    if (!Number.isFinite(input.remainingSteps) || input.remainingSteps < minRemainingSteps) return null

    const tools = Array.isArray(input.tools) ? input.tools : []
    const deny = []
    const seen = new Set()
    let schemaTokensSaved = 0

    for (const tool of tools) {
      if (!isObject(tool)) continue
      const name = typeof tool.name === 'string' ? tool.name.trim() : ''
      if (name.length === 0 || seen.has(name)) continue
      if (keepSet.has(name) || NEVER_HIDE.has(name)) continue
      const schemaTokens = Number.isFinite(tool.schemaTokens) && tool.schemaTokens > 0 ? tool.schemaTokens : 0
      if (schemaTokens < MIN_HIDE_SCHEMA_TOKENS) continue
      if (!hasPrefixMatch(name, hideCandidates)) continue
      seen.add(name)
      deny.push(name)
      schemaTokensSaved += schemaTokens
    }

    if (deny.length === 0) return null
    const price = resolvePlanPrice(input, m6, config)
    const netUSD = estimateNetUSD({
      price,
      remainingSteps: input.remainingSteps,
      schemaTokensSaved,
      suffixTokens: input.suffixTokens,
    })
    return { deny, schemaTokensSaved, netUSD }
  }

  /** Explicit counter; index.js calls this after applying one restrict switch. */
  function noteSwitch() {
    switches += 1
  }

  /** Record an UNKNOWN_TOOL misfire; the executor restores the named tool. */
  function noteUnknownTool(name) {
    if (typeof name !== 'string' || name.length === 0) return
    restore.add(name)
  }

  /** True when a previously hidden tool was requested and must be restored. */
  function shouldRestore(name) {
    if (typeof name !== 'string' || name.length === 0) return false
    return restore.has(name)
  }

  return { plan, noteSwitch, noteUnknownTool, shouldRestore }
}

/**
 * M7: model route-down selector. Only decides; index.js applies the route via
 * agent.model.select after the current step (design §6.7 timing).
 *
 * @param {{config?: object}} [options] resolved CostPilot config (or a bare M7 slice)
 * @returns {{
 *   plan: (request?: {phase?: string, remainingSteps?: number, currentRoute?: {provider?: string, model?: string}}) => {provider: string, model: string} | null,
 *   noteSwitch: () => void,
 *   switches: () => number,
 * }}
 */
export function createRouteSelector({ config = {} } = {}) {
  const m7 = pickModule(config, 'M7', DEFAULT_M7)
  const routeDown = isObject(m7.routeDown)
    ? { ...DEFAULT_M7.routeDown, ...m7.routeDown }
    : { ...DEFAULT_M7.routeDown }
  const phases = stringList(m7.phases, DEFAULT_M7.phases)
  const minRemainingSteps = integerAtLeast(m7.minRemainingSteps, 0, DEFAULT_M7.minRemainingSteps)
  const maxSwitches = integerAtLeast(m7.maxSwitches, 0, DEFAULT_M7.maxSwitches)
  const target = {
    provider: typeof routeDown.provider === 'string' ? routeDown.provider : '',
    model: typeof routeDown.model === 'string' ? routeDown.model : '',
  }
  let switchCount = 0

  /**
   * Return the configured cheaper route only when: M7 is on, the phase is
   * allowed, enough steps remain, the switch budget is not spent, the current
   * route is known and different from the target, and the target is valid.
   * Otherwise null (including when the current route is already the target).
   */
  function plan(request = {}) {
    const input = isObject(request) ? request : {}
    if (m7.enabled !== true) return null
    if (switchCount >= maxSwitches) return null
    if (!phases.includes(input.phase)) return null
    if (!Number.isFinite(input.remainingSteps) || input.remainingSteps < minRemainingSteps) return null
    if (target.provider.length === 0 || target.model.length === 0) return null

    const current = isObject(input.currentRoute) ? input.currentRoute : null
    if (!current) return null
    const currentProvider = typeof current.provider === 'string' ? current.provider.trim() : ''
    const currentModel = typeof current.model === 'string' ? current.model.trim() : ''
    if (currentProvider.length === 0 || currentModel.length === 0) return null
    if (currentProvider === target.provider && currentModel === target.model) return null

    return { provider: target.provider, model: target.model }
  }

  /** Explicit counter; index.js calls this after agent.model.select succeeds. */
  function noteSwitch() {
    switchCount += 1
  }

  /** Number of route switches recorded for this session. */
  function switches() {
    return switchCount
  }

  return { plan, noteSwitch, switches }
}