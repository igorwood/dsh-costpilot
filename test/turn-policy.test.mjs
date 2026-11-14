import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { estimateTokens } from '../lib/estimate.js'
import {
  BATCHING_NUDGE_TEXT,
  MIN_HIDE_SCHEMA_TOKENS,
  createBatchingNudge,
  createRouteSelector,
  createToolsetScheduler,
} from '../lib/turn-policy.js'

const DATA_DIR = '/tmp/costpilot-turn-policy-test'
const TARGET_ROUTE = { provider: 'deepseek-account', model: 'deepseek-flash' }
const PRICE_ROUTE = { provider: 'deepseek', model: 'deepseek-chat' }

function makeConfig(modules = {}) {
  return resolveConfig({ dataDir: DATA_DIR, mode: 'assist', modules })
}

function makeNudge(overrides = {}) {
  return createBatchingNudge({ config: makeConfig({ M5: { enabled: true, ...overrides } }) })
}

function makeScheduler(overrides = {}) {
  return createToolsetScheduler({ config: makeConfig({ M6: { enabled: true, ...overrides } }) })
}

function makeSelector(overrides = {}) {
  return createRouteSelector({ config: makeConfig({ M7: { enabled: true, ...overrides } }) })
}

// ---------------------------------------------------------------------------
// M5 — batching nudge (§6.5)
// ---------------------------------------------------------------------------

test('M5: default config leaves the nudge disabled', () => {
  const nudge = createBatchingNudge({ config: makeConfig() })
  assert.equal(nudge.plan({ turn: 1, step: 1, callsPerTurn: 3, recentToolNames: [], phase: 'search' }), null)
})

test('M5: converged Appendix C text is English and <= 140 tokens', () => {
  assert.match(BATCHING_NUDGE_TEXT, /Batch independent tool calls/)
  assert.match(BATCHING_NUDGE_TEXT, /^[\x20-\x7e]+$/)
  assert.ok(estimateTokens(BATCHING_NUDGE_TEXT) <= 140, 'nudge must stay <= 140 tokens')
  assert.ok(estimateTokens(BATCHING_NUDGE_TEXT) >= 60, 'nudge should still carry the instruction')
})

test('M5: injects in the first turns regardless of phase', () => {
  const nudge = makeNudge()
  const decision = nudge.plan({ turn: 3, step: 4, callsPerTurn: 4, recentToolNames: ['read', 'read', 'read'], phase: 'edit' })
  assert.deepEqual(decision, { inject: true, text: BATCHING_NUDGE_TEXT })
})

test('M5: first-turns boundary is inclusive at firstTurns (5) and stops after it', () => {
  const nudge = makeNudge()
  const quiet = { step: 1, callsPerTurn: 3, recentToolNames: ['read', 'grep', 'read'], phase: 'edit' }
  assert.ok(nudge.plan({ ...quiet, turn: 5 }))
  assert.equal(nudge.plan({ ...quiet, turn: 6 }), null)
})

test('M5: three consecutive distinct single-call steps in read phase inject after firstTurns', () => {
  const nudge = makeNudge()
  const decision = nudge.plan({
    turn: 9,
    step: 12,
    callsPerTurn: 1,
    recentToolNames: ['read', 'grep', 'glob'],
    phase: 'read',
  })
  assert.deepEqual(decision, { inject: true, text: BATCHING_NUDGE_TEXT })
})

test('M5: search phase also qualifies for the consecutive-single-call branch', () => {
  const nudge = makeNudge()
  assert.ok(nudge.plan({ turn: 9, step: 9, callsPerTurn: 1, recentToolNames: ['glob', 'grep', 'read'], phase: 'search' }))
})

test('M5: repeated tool names do not count as consecutive single calls', () => {
  const nudge = makeNudge()
  assert.equal(nudge.plan({ turn: 9, step: 9, callsPerTurn: 1, recentToolNames: ['read', 'grep', 'read'], phase: 'read' }), null)
})

test('M5: batched calls (callsPerTurn > 1) do not qualify for the single-call branch', () => {
  const nudge = makeNudge()
  assert.equal(nudge.plan({ turn: 9, step: 9, callsPerTurn: 2, recentToolNames: ['read', 'grep', 'glob'], phase: 'read' }), null)
})

test('M5: single-call branch requires a search/read phase', () => {
  const nudge = makeNudge()
  assert.equal(nudge.plan({ turn: 9, step: 9, callsPerTurn: 1, recentToolNames: ['read', 'grep', 'glob'], phase: 'edit' }), null)
})

test('M5: maxInjections caps a session and noteInjected counts', () => {
  const nudge = makeNudge({ maxInjections: 2 })
  const request = { turn: 1, step: 1, callsPerTurn: 1, recentToolNames: [], phase: 'search' }
  assert.ok(nudge.plan({ ...request, step: 1 }))
  nudge.noteInjected()
  assert.ok(nudge.plan({ ...request, step: 2 }))
  nudge.noteInjected()
  assert.equal(nudge.plan({ ...request, step: 3 }), null)
})

test('M5: adaptive stays on when calls/turn rises and cost falls', () => {
  const nudge = makeNudge()
  nudge.plan({ turn: 1, step: 1, callsPerTurn: 1, recentToolNames: [], phase: 'search' })
  nudge.noteInjected()
  assert.equal(nudge.shouldDisable({ after: { callsPerTurn: 2, costDelta: -0.004 } }), false)
  assert.ok(nudge.plan({ turn: 2, step: 2, callsPerTurn: 2, recentToolNames: [], phase: 'search' }))
})

test('M5: adaptive disables when calls/turn does not rise above the injection baseline', () => {
  const nudge = makeNudge()
  nudge.plan({ turn: 1, step: 1, callsPerTurn: 1, recentToolNames: [], phase: 'search' })
  nudge.noteInjected()
  assert.equal(nudge.shouldDisable({ after: { callsPerTurn: 1, costDelta: -0.01 } }), true)
  assert.equal(nudge.plan({ turn: 2, step: 2, callsPerTurn: 1, recentToolNames: [], phase: 'search' }), null)
})

test('M5: adaptive disables when the cost delta is positive (costDeltaUSD alias)', () => {
  const nudge = makeNudge()
  nudge.plan({ turn: 1, step: 1, callsPerTurn: 1, recentToolNames: [], phase: 'search' })
  nudge.noteInjected()
  assert.equal(nudge.shouldDisable({ after: { callsPerTurn: 5, costDeltaUSD: 0.002 } }), true)
  assert.equal(nudge.shouldDisable({}), true)
})

test('M5: adaptive:false keeps M5 on even when the signal is bad', () => {
  const nudge = makeNudge({ adaptive: false })
  const request = { turn: 1, step: 1, callsPerTurn: 1, recentToolNames: [], phase: 'search' }
  nudge.plan(request)
  nudge.noteInjected()
  assert.equal(nudge.shouldDisable({ after: { callsPerTurn: 0, costDelta: 1 } }), false)
  assert.ok(nudge.plan({ ...request, step: 2 }))
})

test('M5: shouldDisable before any injection is false', () => {
  const nudge = makeNudge()
  assert.equal(nudge.shouldDisable({ after: { callsPerTurn: 0, costDelta: 1 } }), false)
})

// ---------------------------------------------------------------------------
// M6 — tool-set scheduling (§6.6)
// ---------------------------------------------------------------------------

const M6_TOOLS = [
  { name: 'read', schemaTokens: 900 },
  { name: 'office_read', schemaTokens: 800 },
  { name: 'web_search', schemaTokens: 400 },
  { name: 'glob', schemaTokens: 200 },
  { name: 'office_write', schemaTokens: 250 },
  { name: 'myoffice', schemaTokens: 900 },
  { name: 'bash', schemaTokens: 1000 },
]

test('M6: default config leaves the scheduler disabled', () => {
  const scheduler = createToolsetScheduler({ config: makeConfig() })
  assert.equal(scheduler.plan({ step: 1, phase: 'search', tools: M6_TOOLS, remainingSteps: 20 }), null)
})

test('M6: deny = hideCandidates prefixes minus exact keep names, schema >= 300', () => {
  const scheduler = makeScheduler()
  const decision = scheduler.plan({ step: 4, phase: 'search', tools: M6_TOOLS, remainingSteps: 20 })
  assert.deepEqual(decision.deny, ['office_read', 'web_search'])
  assert.equal(decision.schemaTokensSaved, 1200)
  assert.equal(decision.netUSD, 0) // no price evidence: savings recorded, USD not claimed
})

test('M6: keep is matched by exact name (bash/read are never denied)', () => {
  const scheduler = makeScheduler()
  const decision = scheduler.plan({
    step: 1,
    phase: 'edit',
    tools: [{ name: 'bash', schemaTokens: 4000 }, { name: 'read', schemaTokens: 2000 }],
    remainingSteps: 30,
  })
  assert.equal(decision, null)
})

test('M6: hideCandidates is a prefix match, not a substring match', () => {
  const scheduler = makeScheduler()
  const decision = scheduler.plan({
    step: 1,
    phase: 'search',
    tools: [{ name: 'myoffice', schemaTokens: 900 }, { name: 'office_tool', schemaTokens: 900 }],
    remainingSteps: 20,
  })
  assert.deepEqual(decision.deny, ['office_tool'])
})

test('M6: schemaTokens threshold is inclusive at 300 and rejects 299', () => {
  const scheduler = makeScheduler()
  const decision = scheduler.plan({
    step: 1,
    phase: 'search',
    tools: [{ name: 'office_small', schemaTokens: 299 }, { name: 'office_big', schemaTokens: MIN_HIDE_SCHEMA_TOKENS }],
    remainingSteps: 20,
  })
  assert.deepEqual(decision.deny, ['office_big'])
})

test('M6: remainingSteps must reach minRemainingSteps (6)', () => {
  const scheduler = makeScheduler()
  const request = { step: 1, phase: 'search', tools: M6_TOOLS }
  assert.equal(scheduler.plan({ ...request, remainingSteps: 5 }), null)
  assert.ok(scheduler.plan({ ...request, remainingSteps: 6 }))
})

test('M6: maxSwitches caps per-session switches; noteSwitch is the explicit counter', () => {
  const scheduler = makeScheduler({ maxSwitches: 2 })
  const request = { step: 1, phase: 'search', tools: M6_TOOLS, remainingSteps: 20 }
  assert.ok(scheduler.plan(request))
  scheduler.noteSwitch()
  assert.ok(scheduler.plan({ ...request, step: 2 }))
  scheduler.noteSwitch()
  assert.equal(scheduler.plan({ ...request, step: 3 }), null)
})

test('M6: deny is subtractive — never run_code and never a name outside the input', () => {
  const scheduler = makeScheduler({ keep: [], hideCandidates: ['run_code', 'office'] })
  const decision = scheduler.plan({
    step: 1,
    phase: 'search',
    tools: [{ name: 'run_code', schemaTokens: 900 }, { name: 'office_read', schemaTokens: 500 }],
    remainingSteps: 20,
  })
  assert.deepEqual(decision.deny, ['office_read'])
  assert.equal(decision.deny.includes('run_code'), false)
  assert.equal(decision.deny.every((name) => ['run_code', 'office_read'].includes(name)), true)
})

test('M6: UNKNOWN_TOOL note marks the tool for restoration', () => {
  const scheduler = makeScheduler()
  assert.equal(scheduler.shouldRestore('web_search'), false)
  scheduler.noteUnknownTool('web_search')
  assert.equal(scheduler.shouldRestore('web_search'), true)
  assert.equal(scheduler.shouldRestore('read'), false)
  scheduler.noteUnknownTool('')
  scheduler.noteUnknownTool(42)
  assert.equal(scheduler.shouldRestore(''), false)
})

test('M6: netUSD uses the §5.2 oracle when a price is supplied', () => {
  const scheduler = makeScheduler()
  const decision = scheduler.plan({
    step: 1,
    phase: 'search',
    tools: [{ name: 'office_read', schemaTokens: 1000 }],
    remainingSteps: 21,
    price: { uncachedInput: 2, cacheWrite: 0.5, cacheRead: 0.5 },
  })
  assert.equal(decision.schemaTokensSaved, 1000)
  assert.equal(decision.netUSD, 0.01) // 0.5/M * (21-1) * 1000
})

test('M6: netUSD resolves a price from the configured pricing table via route', () => {
  const scheduler = createToolsetScheduler({ config: resolveConfig({
    dataDir: DATA_DIR,
    modules: { M6: { enabled: true } },
    pricing: { deepseek: { 'deepseek-chat': { uncachedInput: 2, cacheWrite: 2, cacheRead: 0.5, output: 8 } } },
  }) })
  const decision = scheduler.plan({
    step: 1,
    phase: 'search',
    tools: [{ name: 'office_read', schemaTokens: 1000 }],
    remainingSteps: 11,
    route: PRICE_ROUTE,
  })
  assert.equal(decision.netUSD, 0.005) // deepseek-chat cacheRead 0.5/M * (11-1) * 1000
})

test('M6: plan is deterministic for the same input', () => {
  const request = { step: 3, phase: 'read', tools: M6_TOOLS, remainingSteps: 12 }
  const first = makeScheduler().plan(request)
  const second = makeScheduler().plan({ ...request, tools: M6_TOOLS.map((tool) => ({ ...tool })) })
  assert.deepEqual(first, second)
})

// ---------------------------------------------------------------------------
// M7 — route-down selection (§6.7)
// ---------------------------------------------------------------------------

const EXPENSIVE_ROUTE = { provider: 'deepseek-account', model: 'deepseek-reasoner' }
const OTHER_ROUTE = { provider: 'deepseek', model: 'deepseek-chat' }

test('M7: default config leaves the selector disabled', () => {
  const selector = createRouteSelector({ config: makeConfig() })
  assert.equal(selector.plan({ phase: 'search', remainingSteps: 30, currentRoute: EXPENSIVE_ROUTE }), null)
})

test('M7: allowed phase + enough steps + different route returns the configured route', () => {
  const selector = makeSelector()
  assert.deepEqual(
    selector.plan({ phase: 'search', remainingSteps: 10, currentRoute: EXPENSIVE_ROUTE }),
    TARGET_ROUTE,
  )
  assert.deepEqual(
    selector.plan({ phase: 'read', remainingSteps: 30, currentRoute: OTHER_ROUTE }),
    TARGET_ROUTE,
  )
})

test('M7: already on the target route does not switch', () => {
  const selector = makeSelector()
  assert.equal(selector.plan({ phase: 'search', remainingSteps: 30, currentRoute: TARGET_ROUTE }), null)
})

test('M7: disallowed phases do not switch', () => {
  const selector = makeSelector()
  assert.equal(selector.plan({ phase: 'edit', remainingSteps: 30, currentRoute: EXPENSIVE_ROUTE }), null)
  assert.equal(selector.plan({ phase: 'test', remainingSteps: 30, currentRoute: EXPENSIVE_ROUTE }), null)
})

test('M7: remainingSteps boundary is inclusive at minRemainingSteps (10)', () => {
  const selector = makeSelector()
  assert.equal(selector.plan({ phase: 'search', remainingSteps: 9, currentRoute: EXPENSIVE_ROUTE }), null)
  assert.deepEqual(selector.plan({ phase: 'search', remainingSteps: 10, currentRoute: EXPENSIVE_ROUTE }), TARGET_ROUTE)
})

test('M7: unknown or incomplete current route does not switch', () => {
  const selector = makeSelector()
  assert.equal(selector.plan({ phase: 'search', remainingSteps: 30 }), null)
  assert.equal(selector.plan({ phase: 'search', remainingSteps: 30, currentRoute: null }), null)
  assert.equal(selector.plan({ phase: 'search', remainingSteps: 30, currentRoute: { provider: 'deepseek-account' } }), null)
  assert.equal(selector.plan({ phase: 'search', remainingSteps: 30, currentRoute: { provider: '', model: 'x' } }), null)
})

test('M7: maxSwitches caps switches and switches() reports the count', () => {
  const selector = makeSelector({ maxSwitches: 1 })
  assert.equal(selector.switches(), 0)
  assert.deepEqual(selector.plan({ phase: 'read', remainingSteps: 20, currentRoute: OTHER_ROUTE }), TARGET_ROUTE)
  selector.noteSwitch()
  assert.equal(selector.switches(), 1)
  assert.equal(selector.plan({ phase: 'read', remainingSteps: 20, currentRoute: OTHER_ROUTE }), null)
})

test('M7: custom routeDown/phases/minRemainingSteps are honored', () => {
  const selector = makeSelector({
    routeDown: { provider: 'local', model: 'cheap' },
    phases: ['read'],
    minRemainingSteps: 3,
    maxSwitches: 2,
  })
  const target = { provider: 'local', model: 'cheap' }
  assert.deepEqual(selector.plan({ phase: 'read', remainingSteps: 3, currentRoute: EXPENSIVE_ROUTE }), target)
  assert.equal(selector.plan({ phase: 'search', remainingSteps: 30, currentRoute: EXPENSIVE_ROUTE }), null)
  assert.equal(selector.plan({ phase: 'read', remainingSteps: 2, currentRoute: EXPENSIVE_ROUTE }), null)
})