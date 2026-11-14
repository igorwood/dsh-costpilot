/**
 * Tests for dsh-costpilot M2/M3 compaction planner and compactor.
 * Run: node --test test/compaction.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createCompactionPlanner } from '../lib/compaction-plan.js'
import { createCompactor } from '../lib/compactor.js'
import { estimateToolResult } from '../lib/estimate.js'

const PRICE = Object.freeze({
  uncachedInput: 0.27,
  cacheWrite: 0.27,
  cacheRead: 0.07,
  output: 1.1,
  writePremium: false,
  source: 'config',
})

const SURFACE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

function makeEvent(seq, type, data, extra = {}) {
  return { type, seq, time: 1000 + seq, data, ...extra }
}

function textBlock(text) {
  return { type: 'text', text }
}

function userMessage(id, text) {
  return { id, role: 'user', content: [textBlock(text)] }
}

function assistantText(id, text) {
  return { id, role: 'assistant', content: [textBlock(text)] }
}

function assistantToolCall(id, callId, name, args) {
  return {
    id,
    role: 'assistant',
    content: [{
      type: 'tool-call',
      callId,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    }],
  }
}

function toolResultMessage(id, callId, text, isError = false) {
  return { id, role: 'tool', toolCallId: callId, content: [textBlock(text)], isError }
}

function createMockSession(events = [], options = {}) {
  const log = events.slice()
  let nextSeq = log.reduce((max, event) => Math.max(max, Number.isFinite(event.seq) ? event.seq : -1), -1) + 1
  return {
    id: options.id ?? 'sess-compaction',
    get appended() { return log },
    get seq() { return nextSeq },
    append(type, data, appendOptions = {}) {
      const event = { type, seq: nextSeq, time: 1000 + nextSeq, data, ...appendOptions }
      nextSeq += 1
      log.push(event)
      return event
    },
    ownEvents() { return log.slice() },
    eventAt(seq) { return log.find((event) => event.seq === seq) },
  }
}

function surfaceSeqs(events) {
  const nodes = []
  for (const event of events.slice().sort((left, right) => left.seq - right.seq)) {
    if (!SURFACE_TYPES.has(event.type)) continue
    const operation = event.surfaceOp
    if (operation && operation.op === 'replace') {
      const startIndex = nodes.indexOf(operation.startSeq)
      const endIndex = nodes.indexOf(operation.endSeq)
      if (startIndex >= 0 && endIndex >= startIndex) {
        nodes.splice(startIndex, endIndex - startIndex + 1, event.seq)
        continue
      }
    }
    nodes.push(event.seq)
  }
  return nodes
}

function buildConversation(options = {}) {
  const steps = options.steps ?? 12
  const phasePattern = options.phasePattern ?? null
  const bigTokens = options.bigTokens ?? 1200
  const errorStep = options.errorStep ?? -1
  const closeTurn = options.closeTurn !== false
  const events = []
  let seq = 0
  let turn = 0
  function push(type, data) {
    const event = makeEvent(seq, type, data)
    seq += 1
    events.push(event)
    return event
  }
  push('system/message', { message: { role: 'system', content: [textBlock('system prompt')] } })
  for (let step = 1; step <= steps; step++) {
    if ((step - 1) % 4 === 0) {
      turn += 1
      push('turn/start', { turn })
      push('user/message', userMessage('u' + step, 'task request ' + step))
    }
    const phase = phasePattern ? phasePattern[step - 1] : 'read'
    const callId = 'c' + step
    let message
    if (phase === 'search') message = assistantToolCall('a' + step, callId, 'glob', '{"pattern":"**/*.js"}')
    else if (phase === 'read') message = assistantToolCall('a' + step, callId, 'read', '{"path":"src/file' + step + '.js"}')
    else if (phase === 'edit') message = assistantToolCall('a' + step, callId, 'write', '{"path":"src/file' + step + '.js","content":"x"}')
    else if (phase === 'test') message = assistantToolCall('a' + step, callId, 'bash', '{"command":"npm test"}')
    else if (phase === 'execute') message = assistantToolCall('a' + step, callId, 'bash', '{"command":"ls -la"}')
    else message = assistantText('a' + step, 'assistant note ' + step)
    push('assistant/message', { turn, step, message, stream: [] })
    if (phase !== 'setup') {
      const body = (phase === 'search' ? 'search hits ' : 'file content ') + 'y'.repeat(bigTokens)
      push('tool/result', { turn, step, message: toolResultMessage('r' + step, callId, body, step === errorStep) })
    }
  }
  if (closeTurn) push('turn/end', { turn, reason: 'completed' })
  return events
}

function conversationNodes(events) {
  return events.filter((event) => event.type === 'assistant/message' || event.type === 'tool/result')
}

function linesWithProbability(events, reuseProbability, steps) {
  const lines = []
  for (const event of conversationNodes(events)) {
    if (steps && !steps.has(event.data.step)) continue
    lines.push({
      seq: event.seq,
      tokens: event.type === 'tool/result'
        ? estimateToolResult(event.data.message.content)
        : 120,
      reuseProbability,
    })
  }
  return lines
}

function plannerFor(m2, m3 = { enabled: false }) {
  return createCompactionPlanner({
    config: { modules: { M2: { enabled: false, ...m2 }, M3: { enabled: false, ...m3 } } },
  })
}

function rangeSeqs(surface, plan) {
  const startIndex = surface.indexOf(plan.startSeq)
  const endIndex = surface.indexOf(plan.endSeq)
  assert.ok(startIndex >= 0 && endIndex >= startIndex, 'plan range must be on the surface')
  return surface.slice(startIndex, endIndex + 1)
}

// ---------------------------------------------------------------- planner M2

test('planner: disabled modules produce no plan', () => {
  const planner = createCompactionPlanner({ config: { modules: { M2: { enabled: false }, M3: { enabled: false } } } })
  assert.equal(planner.plan({ events: buildConversation({ steps: 12 }), remainingSteps: 12 }), null)
})

test('planner: M2 selects a low-reuse balanced region with template summary and USD', () => {
  const events = buildConversation({ steps: 12 })
  const surface = surfaceSeqs(events)
  const oldSteps = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9])
  const planner = plannerFor({ enabled: true, tauLineReuse: 0.3, maxRegionRatio: 0.6, minRemainingSteps: 1 })
  const plan = planner.plan({
    events,
    price: PRICE,
    remainingSteps: 12,
    lines: linesWithProbability(events, 0.05, oldSteps),
  })
  assert.ok(plan)
  assert.equal(plan.module, 'M2')
  assert.ok(plan.startSeq <= plan.endSeq)
  assert.ok(plan.shadowedTokenCount > 0)
  assert.ok(plan.deltaTokens > 0)
  assert.ok(plan.deltaTokens < plan.shadowedTokenCount)
  assert.ok(plan.netUSD > 0)
  assert.equal(plan.remainingSteps, 12)
  assert.ok(plan.summary.includes('Region GC checkpoint'))
  assert.ok(plan.summary.includes(String(plan.startSeq) + '..' + String(plan.endSeq)))
  const range = rangeSeqs(surface, plan)
  // Never shadow a user message.
  const userSeqs = new Set(events.filter((event) => event.type === 'user/message').map((event) => event.seq))
  assert.equal(range.some((seq) => userSeqs.has(seq)), false)
  // Never shadow the most recent keepRecentSteps (3) steps.
  const recent = new Set(events
    .filter((event) => (event.type === 'assistant/message' || event.type === 'tool/result') && event.data.step > 9)
    .map((event) => event.seq))
  assert.equal(range.some((seq) => recent.has(seq)), false)
})

test('planner: M2 keeps error results and their tool-call step out of the region', () => {
  const events = buildConversation({ steps: 9, errorStep: 3 })
  const surface = surfaceSeqs(events)
  const planner = plannerFor({ enabled: true, tauLineReuse: 0.3, maxRegionRatio: 0.6, minRemainingSteps: 1 })
  const plan = planner.plan({
    events,
    price: PRICE,
    remainingSteps: 12,
    lines: linesWithProbability(events, 0.05),
  })
  assert.ok(plan)
  const range = rangeSeqs(surface, plan)
  const errorResult = events.find((event) => event.type === 'tool/result' && event.data.message.isError === true)
  const errorAssistant = events.find((event) => event.type === 'assistant/message' && event.data.step === 3)
  assert.ok(errorResult && errorAssistant)
  assert.equal(range.includes(errorResult.seq), false)
  assert.equal(range.includes(errorAssistant.seq), false)
})

test('planner: M2 respects maxRegionRatio as a node cap', () => {
  const events = buildConversation({ steps: 12 })
  const surface = surfaceSeqs(events)
  const planner = plannerFor({ enabled: true, tauLineReuse: 0.3, maxRegionRatio: 0.15, minRemainingSteps: 1 })
  const plan = planner.plan({
    events,
    price: PRICE,
    remainingSteps: 12,
    lines: linesWithProbability(events, 0.05),
  })
  assert.ok(plan)
  const range = rangeSeqs(surface, plan)
  assert.ok(range.length <= Math.floor(surface.length * 0.15))
})

test('planner: M2 returns null when every candidate is above the reuse tau', () => {
  const events = buildConversation({ steps: 12 })
  const planner = plannerFor({ enabled: true, tauLineReuse: 0.3, maxRegionRatio: 0.6, minRemainingSteps: 1 })
  const plan = planner.plan({
    events,
    price: PRICE,
    remainingSteps: 12,
    lines: linesWithProbability(events, 0.9),
  })
  assert.equal(plan, null)
})

test('planner: M2 respects minRemainingSteps from config', () => {
  const events = buildConversation({ steps: 12 })
  const planner = plannerFor({ enabled: true, tauLineReuse: 0.3, maxRegionRatio: 0.6, minRemainingSteps: 6 })
  const plan = planner.plan({
    events,
    price: PRICE,
    remainingSteps: 2,
    lines: linesWithProbability(events, 0.05),
  })
  assert.equal(plan, null)
})

test('planner: M2 is preferred over M3 when both are enabled', () => {
  const events = buildConversation({ steps: 12 })
  const planner = plannerFor(
    { enabled: true, tauLineReuse: 0.3, maxRegionRatio: 0.6, minRemainingSteps: 1 },
    { enabled: true, segmentSteps: 2, minStepsBefore: 4, maxCompactionsPerSession: 3, keepRecentSteps: 2 },
  )
  const plan = planner.plan({
    events,
    price: PRICE,
    remainingSteps: 12,
    lines: linesWithProbability(events, 0.05),
  })
  assert.ok(plan)
  assert.equal(plan.module, 'M2')
})

test('planner: plan output is deterministic for identical input', () => {
  const events = buildConversation({ steps: 12 })
  const input = {
    events,
    price: PRICE,
    remainingSteps: 12,
    lines: linesWithProbability(events, 0.05),
  }
  const planner = plannerFor({ enabled: true, tauLineReuse: 0.3, maxRegionRatio: 0.6, minRemainingSteps: 1 })
  assert.deepEqual(planner.plan(input), planner.plan(input))
})

// ---------------------------------------------------------------- planner M3

const M3_PATTERN = ['search', 'search', 'search', 'search', 'read', 'read', 'read', 'read', 'edit', 'edit', 'edit', 'read', 'read', 'read']

function m3Planner(overrides = {}) {
  return createCompactionPlanner({
    config: {
      modules: {
        M2: { enabled: false },
        M3: { enabled: true, segmentSteps: 3, minStepsBefore: 10, maxCompactionsPerSession: 2, keepRecentSteps: 3, ...overrides },
      },
    },
  })
}

test('planner: M3 classifies phases and compacts a closed same-phase segment', () => {
  const events = buildConversation({ steps: 14, phasePattern: M3_PATTERN })
  const plan = m3Planner().plan({ events, price: PRICE, remainingSteps: 20 })
  assert.ok(plan)
  assert.equal(plan.module, 'M3')
  assert.ok(plan.summary.includes('phase search'))
  assert.ok(plan.summary.includes('steps 1..4'))
  assert.ok(plan.shadowedTokenCount > 0)
  assert.ok(plan.deltaTokens > 0)
  assert.ok(plan.netUSD > 0)
  const assistantOne = events.find((event) => event.type === 'assistant/message' && event.data.step === 1)
  const resultFour = events.find((event) => event.type === 'tool/result' && event.data.step === 4)
  assert.equal(plan.startSeq, assistantOne.seq)
  assert.equal(plan.endSeq, resultFour.seq)
})

test('planner: M3 returns null before minStepsBefore', () => {
  const events = buildConversation({ steps: 8, phasePattern: M3_PATTERN.slice(0, 8) })
  assert.equal(m3Planner().plan({ events, price: PRICE, remainingSteps: 20 }), null)
})

test('planner: M3 never compacts an open (current) phase segment', () => {
  const pattern = new Array(14).fill('read')
  const events = buildConversation({ steps: 14, phasePattern: pattern })
  assert.equal(m3Planner().plan({ events, price: PRICE, remainingSteps: 20 }), null)
})

test('planner: M3 respects maxCompactionsPerSession', () => {
  const events = buildConversation({ steps: 14, phasePattern: M3_PATTERN })
  const lastSeq = events.reduce((max, event) => Math.max(max, event.seq), -1)
  events.push(makeEvent(lastSeq + 1, 'compaction/summary', { compactionId: 'prior', summary: [], shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], shadowedTokenCount: 0 }))
  assert.equal(m3Planner({ maxCompactionsPerSession: 1 }).plan({ events, price: PRICE, remainingSteps: 20 }), null)
})

test('planner: M3 leaves keepRecentSteps untouched', () => {
  const events = buildConversation({ steps: 14, phasePattern: M3_PATTERN })
  const plan = m3Planner().plan({ events, price: PRICE, remainingSteps: 20 })
  assert.ok(plan)
  const recentSeqs = new Set(events
    .filter((event) => (event.type === 'assistant/message' || event.type === 'tool/result') && event.data.step >= 12)
    .map((event) => event.seq))
  const surface = surfaceSeqs(events)
  const range = rangeSeqs(surface, plan)
  assert.equal(range.some((seq) => recentSeqs.has(seq)), false)
})

// ----------------------------------------------------------------- compactor

function compactFixture(closeTurn = true) {
  const events = [
    makeEvent(0, 'system/message', { message: { role: 'system', content: [textBlock('sys prompt')] } }),
    makeEvent(1, 'turn/start', { turn: 1 }),
    makeEvent(2, 'user/message', userMessage('u1', 'do it')),
    makeEvent(3, 'assistant/message', {
      turn: 1,
      step: 1,
      message: assistantToolCall('a1', 'c1', 'read', '{"path":"a.js"}'),
      stream: [],
    }),
    makeEvent(4, 'tool/result', { turn: 1, step: 1, message: toolResultMessage('r1', 'c1', 'result body') }),
    makeEvent(5, 'user/message', userMessage('u2', 'continue')),
    makeEvent(6, 'assistant/message', { turn: 1, step: 2, message: assistantText('a2', 'done'), stream: [] }),
  ]
  if (closeTurn) events.push(makeEvent(7, 'turn/end', { turn: 1, reason: 'completed' }))
  return events
}

const PLAN = Object.freeze({
  startSeq: 3,
  endSeq: 4,
  summary: 'template summary of the compacted region',
  shadowedTokenCount: 500,
  deltaTokens: 400,
  remainingSteps: 10,
  netUSD: 0.01,
})

test('compactor: writes start/summary/checkpoint replace/end in protocol order', async () => {
  const events = compactFixture(false)
  const session = createMockSession(events)
  const compactor = createCompactor({ config: {}, generateId: () => 'cp-test-1' })
  const result = await compactor.run(PLAN, session)
  assert.deepEqual(result, { ok: true })

  const appended = session.appended.slice(events.length)
  assert.deepEqual(appended.map((event) => event.type), [
    'compaction/start',
    'compaction/summary',
    'user/message',
    'compaction/end',
  ])
  const [start, summary, checkpoint, end] = appended
  assert.deepEqual(start.data, { compactionId: 'cp-test-1', turn: 1 })

  assert.equal(summary.data.compactionId, 'cp-test-1')
  assert.deepEqual(summary.data.shadowedRange, { start: 3, end: 4 })
  assert.deepEqual(summary.data.shadowedSeqs, [3, 4])
  assert.equal(summary.data.shadowedTokenCount, 500)
  assert.equal(summary.data.provider, '')
  assert.equal(summary.data.model, '')
  assert.equal(summary.data.summary[0].type, 'text')
  assert.ok(summary.data.summary[0].text.includes('template summary'))

  assert.equal(checkpoint.data.role, 'user')
  assert.equal(checkpoint.data.source.kind, 'compact-checkpoint')
  assert.equal(checkpoint.data.source.compactionId, 'cp-test-1')
  assert.ok(checkpoint.data.content[0].text.includes('<compacted-summary>'))
  assert.equal(checkpoint.data.content[checkpoint.data.content.length - 1].text, '</compacted-summary>')
  assert.ok(checkpoint.data.content.some((block) => block.text && block.text.includes('template summary')))
  assert.deepEqual(checkpoint.surfaceOp, { op: 'replace', startSeq: 3, endSeq: 4 })
  assert.ok(checkpoint.sourceEventSeqs.includes(start.seq))
  assert.ok(checkpoint.sourceEventSeqs.includes(summary.seq))
  assert.ok(checkpoint.sourceEventSeqs.includes(3))
  assert.ok(checkpoint.sourceEventSeqs.includes(4))

  assert.deepEqual(end.data, { compactionId: 'cp-test-1', turn: 1 })
})

test('compactor: unmatched compaction/start returns busy and writes no events', async () => {
  const session = createMockSession(compactFixture())
  session.append('compaction/start', { compactionId: 'open-transaction', turn: 1 })
  const before = session.appended.length
  const compactor = createCompactor({ config: {}, generateId: () => 'cp-busy' })
  const result = await compactor.run(PLAN, session)
  assert.deepEqual(result, { ok: false, error: 'busy' })
  assert.equal(session.appended.length, before)
})

test('compactor: a closed previous compaction or a later end-seed is not busy', async () => {
  const closedSession = createMockSession(compactFixture())
  closedSession.append('compaction/start', { compactionId: 'old', turn: 1 })
  closedSession.append('compaction/end', { compactionId: 'old', turn: 1 })
  const closedResult = await createCompactor({ config: {}, generateId: () => 'cp-closed' }).run(PLAN, closedSession)
  assert.deepEqual(closedResult, { ok: true })

  const seededSession = createMockSession(compactFixture())
  seededSession.append('compaction/start', { compactionId: 'stale', turn: 1 })
  seededSession.append('session/end-seed', {})
  const seededResult = await createCompactor({ config: {}, generateId: () => 'cp-seeded' }).run(PLAN, seededSession)
  assert.deepEqual(seededResult, { ok: true })
})

test('compactor: invalid or unbalanced ranges are rejected without writes', async () => {
  const compactor = createCompactor({ config: {}, generateId: () => 'cp-invalid' })

  const missingRange = createMockSession(compactFixture())
  const missingBefore = missingRange.appended.length
  const missingResult = await compactor.run({ ...PLAN, startSeq: 99, endSeq: 99 }, missingRange)
  assert.deepEqual(missingResult, { ok: false, error: 'invalid-range' })
  assert.equal(missingRange.appended.length, missingBefore)

  const unbalanced = createMockSession(compactFixture())
  const unbalancedBefore = unbalanced.appended.length
  const unbalancedResult = await compactor.run({ ...PLAN, startSeq: 3, endSeq: 3 }, unbalanced)
  assert.deepEqual(unbalancedResult, { ok: false, error: 'invalid-range' })
  assert.equal(unbalanced.appended.length, unbalancedBefore)

  const systemHead = createMockSession(compactFixture())
  const systemHeadResult = await compactor.run({ ...PLAN, startSeq: 0, endSeq: 2 }, systemHead)
  assert.deepEqual(systemHeadResult, { ok: false, error: 'invalid-range' })
  assert.equal(systemHead.appended.length, compactFixture().length)

  const badPlan = createMockSession(compactFixture())
  const badPlanResult = await compactor.run({ startSeq: 3, endSeq: 4 }, badPlan)
  assert.deepEqual(badPlanResult, { ok: false, error: 'invalid-plan' })
})

test('compactor: busy wins over an invalid plan', async () => {
  const session = createMockSession(compactFixture())
  session.append('compaction/start', { compactionId: 'open', turn: 1 })
  const before = session.appended.length
  const result = await createCompactor({ config: {}, generateId: () => 'cp-busy-2' }).run(null, session)
  assert.deepEqual(result, { ok: false, error: 'busy' })
  assert.equal(session.appended.length, before)
})

test('compactor: a failed summary closes the transaction with an error end record', async () => {
  const events = compactFixture()
  const session = createMockSession(events)
  const originalAppend = session.append
  let failed = false
  session.append = (type, data, options) => {
    if (type === 'compaction/summary' && !failed) {
      failed = true
      throw new Error('boom: summary failed')
    }
    return originalAppend(type, data, options)
  }
  const result = await createCompactor({ config: {}, generateId: () => 'cp-error' }).run(PLAN, session)
  assert.equal(result.ok, false)
  assert.match(result.error, /boom/)
  const appended = session.appended.slice(events.length)
  assert.deepEqual(appended.map((event) => event.type), ['compaction/start', 'compaction/end'])
  assert.match(appended[1].data.error, /boom/)
})

test('compactor: transactions without an open turn record turn null', async () => {
  const session = createMockSession(compactFixture(true))
  const result = await createCompactor({ config: {}, generateId: () => 'cp-null-turn' }).run(PLAN, session)
  assert.deepEqual(result, { ok: true })
  const start = session.appended.find((event) => event.type === 'compaction/start' && event.data.compactionId === 'cp-null-turn')
  assert.equal(start.data.turn, null)
})

test('compactor: accepts summary content blocks and injected id sequences', async () => {
  const ids = ['cp-a', 'cp-b']
  const compactor = createCompactor({ config: {}, generateId: () => ids.shift() })
  const firstSession = createMockSession(compactFixture())
  const summaryBlocks = [{ type: 'text', text: 'block summary one' }, { type: 'text', text: 'block summary two' }]
  const first = await compactor.run({ ...PLAN, summary: summaryBlocks }, firstSession)
  assert.deepEqual(first, { ok: true })
  const summary = firstSession.appended.find((event) => event.type === 'compaction/summary')
  assert.deepEqual(summary.data.summary, summaryBlocks)
  assert.equal(summary.data.compactionId, 'cp-a')
  assert.equal(firstSession.appended.find((event) => event.type === 'compaction/end').data.compactionId, 'cp-a')

  const secondSession = createMockSession(compactFixture())
  const second = await compactor.run(PLAN, secondSession)
  assert.deepEqual(second, { ok: true })
  assert.equal(secondSession.appended.find((event) => event.type === 'compaction/start').data.compactionId, 'cp-b')
})

test('compactor: planner output runs end-to-end and folds a replace surface', async () => {
  const events = buildConversation({ steps: 12, closeTurn: false })
  const planner = plannerFor({ enabled: true, tauLineReuse: 0.3, maxRegionRatio: 0.6, minRemainingSteps: 1 })
  const plan = planner.plan({
    events,
    price: PRICE,
    remainingSteps: 12,
    lines: linesWithProbability(events, 0.05),
  })
  assert.ok(plan)
  const session = createMockSession(events)
  const result = await createCompactor({ config: {}, generateId: () => 'cp-e2e' }).run(plan, session)
  assert.deepEqual(result, { ok: true })

  const appended = session.appended.slice(events.length)
  const summaryEvent = appended.find((event) => event.type === 'compaction/summary')
  const replaceEvent = appended.find((event) => event.type === 'user/message')
  assert.deepEqual(summaryEvent.data.shadowedSeqs, plan.shadowedSeqs)
  assert.deepEqual(replaceEvent.surfaceOp, { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq })

  const surfaceAfter = surfaceSeqs(session.appended)
  assert.ok(surfaceAfter.includes(replaceEvent.seq))
  assert.equal(surfaceAfter.includes(plan.startSeq), false)
  assert.ok(surfaceAfter.length < surfaceSeqs(events).length)
})