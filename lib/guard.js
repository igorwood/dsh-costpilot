/**
 * M9: budget governance and runaway-loop guard (Runaway Guard).
 *
 * Detection is per step / per tool-call (NOT per turn): agent/pre-step fires on
 * every step, so a loop that keeps calling tools never reaches turn-stopping.
 * This module only computes decisions; the executor (index.js) injects the
 * warning message or cancels the agent with keepInbox.
 *
 * Design §6.9 invariants:
 *  - warn first, never kill silently;
 *  - hard stop is OFF by default and only fires above budgets.hardStopAtPct;
 *  - keepInbox defaults to true so user input is not lost.
 *
 * Pure ESM, zero runtime dependencies, deterministic given the observed events.
 *
 * @module dsh-costpilot/lib/guard
 */
import { hashKey } from './contracts.js'

const DEFAULT_M9 = Object.freeze({
  enabled: true,
  mode: 'assist',
  maxSteps: 160,
  maxToolCalls: 400,
  maxTurnCostUSD: 1.0,
  noProgressSteps: 6,
  costSpikeMultiplier: 3,
  warnOncePerSession: true,
  hardStop: false,
  hardStopSteps: 2,
  keepInbox: true,
  subagentLimit: 8,
  toolQuotas: {},
})

const DEFAULT_BUDGETS = Object.freeze({ sessionUSD: 5, warnAtPct: 80, hardStopAtPct: 120 })

const M9_KEYS = ['enabled', 'mode', 'maxSteps', 'maxToolCalls', 'maxTurnCostUSD', 'noProgressSteps',
  'costSpikeMultiplier', 'warnOncePerSession', 'hardStop', 'hardStopSteps', 'keepInbox', 'subagentLimit', 'toolQuotas']

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveNumber(value) {
  return Number.isFinite(value) && value > 0
}

function round(value, digits = 6) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function fmtUsd(value) {
  const safe = Number.isFinite(value) ? value : 0
  return (Math.round(safe * 100) / 100).toFixed(2)
}

function pickM9(config) {
  const merged = { ...DEFAULT_M9 }
  if (!isObject(config)) return merged
  const modules = isObject(config.modules) ? config.modules : null
  let slice = {}
  if (modules && isObject(modules.M9)) slice = modules.M9
  else if (isObject(config.M9)) slice = config.M9
  else if (!('modules' in config) && !('budgets' in config) && M9_KEYS.some((key) => key in config)) slice = config
  for (const [key, value] of Object.entries(slice)) if (value !== undefined) merged[key] = value
  return merged
}

function pickBudgets(config) {
  const raw = isObject(config) && isObject(config.budgets) ? config.budgets : {}
  return {
    sessionUSD: positiveNumber(raw.sessionUSD) ? raw.sessionUSD : DEFAULT_BUDGETS.sessionUSD,
    warnAtPct: positiveNumber(raw.warnAtPct) ? raw.warnAtPct : DEFAULT_BUDGETS.warnAtPct,
    hardStopAtPct: positiveNumber(raw.hardStopAtPct) ? raw.hardStopAtPct : DEFAULT_BUDGETS.hardStopAtPct,
  }
}

function extractToolCall(data) {
  const source = isObject(data) ? data : {}
  const name = typeof source.name === 'string'
    ? source.name
    : typeof source.toolName === 'string'
      ? source.toolName
      : isObject(source.tool) && typeof source.tool.name === 'string'
        ? source.tool.name
        : 'unknown'
  const args = source.arguments ?? source.args ?? source.input ?? source.parameters ?? source.params
    ?? (isObject(source.tool) ? source.tool.arguments : undefined)
    ?? null
  return { name, args }
}

function signatureOf(data) {
  const { name, args } = extractToolCall(data)
  return name + ':' + hashKey(args ?? null)
}

function isFailedToolResult(data) {
  if (!isObject(data)) return false
  if (data.isError === true) return true
  if (isObject(data.result) && data.result.isError === true) return true
  if (data.error !== undefined && data.error !== null && data.error !== false) return true
  if (data.ok === false) return true
  return false
}

function usdOf(data) {
  if (!isObject(data)) return 0
  for (const key of ['usd', 'costUSD', 'costUsd', 'totalUSD', 'totalUsd']) {
    const value = data[key]
    if (Number.isFinite(value) && value > 0) return value
  }
  return 0
}

function clampMessage(message, max = 200) {
  if (typeof message !== 'string') return ''
  return message.length <= max ? message : message.slice(0, max - 3) + '...'
}

function buildMessage(reason, details, symbol = '¥') {
  const money = (value) => symbol + fmtUsd(value)
  switch (reason) {
    case 'max-steps':
      return `M9 guard [max-steps]: observed ${details.steps} steps, limit ${details.maxSteps}; converge and finish the task now.`
    case 'max-tool-calls':
      return `M9 guard [max-tool-calls]: ${details.toolCalls} tool calls, limit ${details.maxToolCalls}; stop exploring and summarize.`
    case 'budget':
      return `M9 guard [budget]: session cost ${money(details.sessionUsd)} is ${details.budgetPctDisplay}% of ${money(details.budgetUsd)}; converge and summarize.`
    case 'turn-cost':
      return `M9 guard [turn-cost]: this turn cost ${money(details.turnUsd)}, limit ${money(details.maxTurnCostUSD)}; reduce work per turn.`
    case 'cost-spike':
      return `M9 guard [cost-spike]: turn ${money(details.turnUsd)} > ${details.costSpikeMultiplier}x median ${money(details.medianTurnUsd)}; check repeated expensive calls.`
    case 'no-progress':
      return `M9 guard [no-progress]: ${details.repeatStreak} identical tool calls in a row; change approach or finish.`
    case 'max-spawns':
      return `M9 guard [max-spawns]: ${details.spawnCalls} subagent/spawn calls, limit ${details.subagentLimit}; finish with the agents already running.`
    case 'tool-quota':
      return `M9 guard [tool-quota]: tool "${details.quotaTool ?? 'unknown'}" used ${details.quotaUsed} times (limit ${details.quotaLimit}); use a cheaper alternative or summarize.`
    case 'no-workspace-progress':
      return `M9 guard [no-workspace-progress]: ${details.stepsSinceProgress} steps without a successful edit; re-plan or summarize.`
    case 'hard-stop':
      return `M9 guard [hard-stop]: session cost ${money(details.sessionUsd)} >= ${details.hardStopPct}% of ${money(details.budgetUsd)}; stopping with inbox kept.`
    default:
      return `M9 guard [${reason}]: ${details.message ?? 'budget guard triggered'}.`
  }
}

/**
 * Create a runaway guard for one session.
 *
 * @param {{config?: object, sessionId?: string}} input resolved CostPilot config (or a bare M9 slice)
 * @returns {{
 *   observeEvent: (session: any, event: any) => object,
 *   noteCallCost: (usd: number) => object,
 *   noteTurnCost: (usd: number) => object,
 *   checkPreStep: (request?: {turn?: number, step?: number}) => {action: 'none'|'warn'|'stop', reason: string, message: string, details: object},
 *   check: (request?: object) => object,
 *   state: () => object,
 * }}
 */
export function createGuard({ config = {}, sessionId = 'unknown' } = {}) {
  const m9 = pickM9(config)
  const budgets = pickBudgets(config)
  const currency = typeof config.currency === 'string' ? config.currency : 'CNY'
  const SYMBOL = currency === 'USD' ? String.fromCharCode(36) : currency === 'CNY' ? '¥' : currency + ' '

  const counters = {
    steps: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    turnsSeen: 0,
    currentTurn: 0,
    lastSignature: null,
    repeatStreak: 0,
    lastProgressAt: null,
    warned: false,
    warnCount: 0,
    stopped: false,
    stopReason: null,
    currentStep: 0,
    lastToolName: null,
    spawnCalls: 0,
    toolCounts: Object.create(null),
    lastWorkspaceProgressStep: null,
    hardStopBreaches: 0,
  }
  const warnedReasons = new Set()
  /** turn key -> {calls, turns, events}; the three channels all represent USD and are de-duplicated with max(). */
  const turns = new Map()
  let callCostTotal = 0

  function ensureTurn(key) {
    let entry = turns.get(key)
    if (!entry) {
      entry = { calls: 0, turns: 0, events: 0 }
      turns.set(key, entry)
    }
    return entry
  }

  function turnKeyOf(turn) {
    const value = Number.isFinite(turn) ? turn : counters.currentTurn
    return String(value ?? 0)
  }

  function turnCostOf(key) {
    const entry = turns.get(key)
    if (!entry) return 0
    return Math.max(entry.calls, entry.turns, entry.events)
  }

  /** Prefer the requested turn when it has been observed; otherwise use the tracked current turn. */
  function resolveTurn(turn) {
    if (Number.isFinite(turn) && turns.has(String(turn))) return turn
    return counters.currentTurn
  }

  function sumChannel(channel) {
    let total = 0
    for (const entry of turns.values()) total += entry[channel] ?? 0
    return total
  }

  function sessionUsd() {
    return Math.max(callCostTotal, sumChannel('calls'), sumChannel('turns'), sumChannel('events'))
  }

  function snapshot() {
    const turnCosts = {}
    for (const [key, entry] of turns.entries()) turnCosts[key] = round(Math.max(entry.calls, entry.turns, entry.events))
    return {
      sessionId,
      steps: counters.steps,
      toolCalls: counters.toolCalls,
      failedToolCalls: counters.failedToolCalls,
      turns: counters.turnsSeen,
      currentTurn: counters.currentTurn,
      sessionUsd: round(sessionUsd()),
      currentTurnUsd: round(turnCostOf(turnKeyOf())),
      turnCosts,
      lastSignature: counters.lastSignature,
      repeatStreak: counters.repeatStreak,
      lastProgressAt: counters.lastProgressAt,
      warned: counters.warned,
      warnCount: counters.warnCount,
      warnedReasons: [...warnedReasons],
      stopped: counters.stopped,
    }
  }

  function noteTurn(turn) {
    if (!Number.isFinite(turn)) return
    counters.currentTurn = turn
    counters.turnsSeen = Math.max(counters.turnsSeen, turn)
    ensureTurn(String(turn))
  }

  /** Observe one session/event. Unknown event types are ignored. */
  function observeEvent(session, event) {
    if (!isObject(event) || typeof event.type !== 'string') return snapshot()
    const data = isObject(event.data) ? event.data : {}
    const at = Number.isFinite(event.time) ? event.time : Date.now()
    switch (event.type) {
      case 'turn/start': {
        noteTurn(Number.isFinite(data.turn) ? data.turn : counters.turnsSeen + 1)
        break
      }
      case 'turn/end':
        break
      case 'step/start': {
        counters.steps += 1
        if (Number.isFinite(data.step)) counters.currentStep = data.step
        if (Number.isFinite(data.turn)) noteTurn(data.turn)
        break
      }
      case 'tool/call': {
        counters.toolCalls += 1
        if (Number.isFinite(data.turn)) noteTurn(data.turn)
        const toolName = typeof data.name === 'string' ? data.name : 'unknown'
        counters.lastToolName = toolName
        counters.toolCounts[toolName] = (counters.toolCounts[toolName] ?? 0) + 1
        if (/^(subagent|task|agent|spawn)/i.test(toolName)) counters.spawnCalls += 1
        const signature = signatureOf(data)
        if (signature === counters.lastSignature) counters.repeatStreak += 1
        else {
          counters.lastSignature = signature
          counters.repeatStreak = 1
        }
        break
      }
      case 'tool/result': {
        if (isFailedToolResult(data)) counters.failedToolCalls += 1
        else {
          counters.lastProgressAt = at
          if (/^(edit|write|str_replace_editor|patch)$/i.test(counters.lastToolName ?? '')) {
            counters.lastWorkspaceProgressStep = counters.currentStep
          }
        }
        break
      }
      case 'assistant/message': {
        const usd = usdOf(data)
        if (usd > 0) ensureTurn(turnKeyOf()).events += usd
        break
      }
      default:
        break
    }
    return snapshot()
  }

  /**
   * Record the USD cost of one LLM call. Adds to the session total and to the
   * current turn's call channel (de-duplicated with max() when noteTurnCost also runs).
   */
  function noteCallCost(usd) {
    if (!positiveNumber(usd)) return snapshot()
    callCostTotal += usd
    ensureTurn(turnKeyOf()).calls += usd
    return snapshot()
  }

  /**
   * Record the authoritative total USD cost of the current turn (idempotent per
   * turn: repeated calls keep the maximum, so calling it once per turn or once
   * per step converges to the same value).
   */
  function noteTurnCost(usd) {
    if (!Number.isFinite(usd) || usd < 0) return snapshot()
    const entry = ensureTurn(turnKeyOf())
    entry.turns = Math.max(entry.turns, usd)
    return snapshot()
  }

  function medianOtherTurnCost(currentKey) {
    const values = []
    for (const [key, entry] of turns.entries()) {
      if (key === currentKey) continue
      values.push(Math.max(entry.calls, entry.turns, entry.events))
    }
    if (values.length < 3) return null
    values.sort((a, b) => a - b)
    const middle = Math.floor(values.length / 2)
    const median = values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2
    return median > 0 ? median : null
  }

  function baseDetails(step, turn) {
    const sessionCost = sessionUsd()
    const effectiveTurn = resolveTurn(turn)
    const turnCost = turnCostOf(turnKeyOf(effectiveTurn))
    const median = medianOtherTurnCost(turnKeyOf(effectiveTurn))
    return {
      sessionId,
      steps: counters.steps,
      step,
      toolCalls: counters.toolCalls,
      turn: effectiveTurn,
      turnCount: turns.size,
      failedToolCalls: counters.failedToolCalls,
      sessionUsd: round(sessionCost),
      budgetUsd: budgets.sessionUSD,
      budgetPct: budgets.sessionUSD > 0 ? round(sessionCost / budgets.sessionUSD, 6) : 0,
      budgetPctDisplay: budgets.sessionUSD > 0 ? Math.round((sessionCost / budgets.sessionUSD) * 100) : 0,
      warnAtPct: budgets.warnAtPct,
      hardStopPct: budgets.hardStopAtPct,
      turnUsd: round(turnCost),
      maxTurnCostUSD: m9.maxTurnCostUSD,
      medianTurnUsd: median === null ? null : round(median),
      maxSteps: m9.maxSteps,
      maxToolCalls: m9.maxToolCalls,
      noProgressSteps: m9.noProgressSteps,
      costSpikeMultiplier: m9.costSpikeMultiplier,
      repeatStreak: counters.repeatStreak,
      keepInbox: m9.keepInbox !== false,
    }
  }

  function decision(action, reason, message, details) {
    return { action, reason, message: action === 'none' ? '' : clampMessage(message), details }
  }

  function warn(reason, details) {
    if (m9.warnOncePerSession !== false && counters.warned) {
      return decision('none', 'warn-suppressed', '', {
        ...details,
        suppressed: true,
        suppressedReason: reason,
        warnCount: counters.warnCount,
      })
    }
    counters.warned = true
    counters.warnCount += 1
    warnedReasons.add(reason)
    return decision('warn', reason, buildMessage(reason, details, SYMBOL), details)
  }

  function stop(reason, details) {
    counters.stopped = true
    counters.stopReason = reason
    return decision('stop', reason, buildMessage(reason, details, SYMBOL), {
      ...details,
      keepInbox: m9.keepInbox !== false,
      cancel: { kind: 'costpilot-guard', reason, keepInbox: m9.keepInbox !== false },
    })
  }

  /**
   * Decide what to do before entering the next step.
   * @param {{turn?: number, step?: number}} [request]
   */
  function checkPreStep(request = {}) {
    const step = Number.isFinite(request?.step) ? request.step : counters.steps
    const turn = Number.isFinite(request?.turn) ? request.turn : counters.currentTurn
    const details = baseDetails(step, turn)

    if (m9.enabled === false) return decision('none', 'disabled', '', details)

    if (details.budgetPct * 100 >= budgets.hardStopAtPct) counters.hardStopBreaches += 1
    else counters.hardStopBreaches = 0
    if (m9.hardStop === true && counters.hardStopBreaches >= (m9.hardStopSteps ?? 2)) {
      return stop('hard-stop', { ...details, hardStopBreaches: counters.hardStopBreaches })
    }
    if (details.steps > m9.maxSteps || step > m9.maxSteps) {
      const withStep = { ...details, steps: Math.max(details.steps, step) }
      return warn('max-steps', withStep)
    }
    if (details.toolCalls > m9.maxToolCalls) return warn('max-tool-calls', details)
    if (details.budgetPct * 100 >= budgets.warnAtPct) return warn('budget', details)
    if (details.turnUsd > m9.maxTurnCostUSD) return warn('turn-cost', details)
    if (details.medianTurnUsd !== null && details.turnUsd > m9.costSpikeMultiplier * details.medianTurnUsd) {
      return warn('cost-spike', details)
    }
    if (counters.repeatStreak >= m9.noProgressSteps) return warn('no-progress', details)
    if (Number.isFinite(m9.subagentLimit) && counters.spawnCalls > m9.subagentLimit) {
      return warn('max-spawns', { ...details, spawnCalls: counters.spawnCalls, subagentLimit: m9.subagentLimit })
    }
    if (isObject(m9.toolQuotas)) {
      for (const [tool, limit] of Object.entries(m9.toolQuotas)) {
        if (!Number.isFinite(limit) || limit <= 0) continue
        const used = counters.toolCounts[tool] ?? 0
        if (used > limit) return warn('tool-quota', { ...details, quotaTool: tool, quotaUsed: used, quotaLimit: limit })
      }
    }
    if (counters.lastWorkspaceProgressStep !== null
      && counters.steps - counters.lastWorkspaceProgressStep >= m9.noProgressSteps) {
      return warn('no-workspace-progress', {
        ...details,
        stepsSinceProgress: counters.steps - counters.lastWorkspaceProgressStep,
      })
    }
    return decision('none', 'ok', '', details)
  }

  /** Record an external workspace change (e.g. an fs observation) as progress. */
  function noteWorkspaceChange(step) {
    counters.lastWorkspaceProgressStep = Number.isFinite(step) ? step : counters.currentStep
    return snapshot()
  }

  return {
    observeEvent,
    noteWorkspaceChange,
    noteCallCost,
    noteTurnCost,
    checkPreStep,
    check: checkPreStep,
    state: snapshot,
  }
}
