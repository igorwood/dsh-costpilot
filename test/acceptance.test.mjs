/**
 * dsh-costpilot black-box acceptance suite.
 *
 * Drives only the public entries (index.js plugin, lib/projection.js, lib/sim.js,
 * client.js) through the Cordis-like mock in test/mock-ctx.mjs. No internal
 * module is mocked or imported to bypass a hook; every assertion is made from
 * observable output: the NDJSON ledger, returned waterfall decisions, agent
 * effects, projection views, command text, and the client render tree.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'
import { createCostProjectionDefinition } from '../lib/projection.js'
import { summarizeRecords, renderReport, readSessionRecords } from '../lib/sim.js'
import {
  createHarness,
  emitSession,
  emitSessionWithProjections,
  runPostExecute,
  runPreStep,
  MockProjectionRegistry,
} from './mock-ctx.mjs'

const PRICE = {
  deepseek: {
    'deepseek-chat': { uncachedInput: 1, cacheWrite: 2, cacheRead: 0.1, output: 10 },
  },
}
const ROUTE = { provider: 'deepseek', model: 'deepseek-chat' }

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'costpilot-accept-' + label + '-'))
}

/** Shipped-default config with test-local dataDir and a hand-checkable price table. */
function configFor(dir, overrides = {}) {
  return {
    dataDir: dir,
    mode: 'observe',
    usageSemantics: 'exclusive', // DSH tokenUsage semantics: inputTokens = uncached input
    pricing: PRICE,
    budgets: { sessionUSD: 100, warnAtPct: 80, hardStopAtPct: 120 },
    modules: {
      M1: { enabled: true, mode: 'assist', minDeltaTokens: 100, sideStore: true, marker: true },
      M9: {
        enabled: true, mode: 'assist', maxSteps: 160, maxToolCalls: 400,
        maxTurnCostUSD: 100, noProgressSteps: 99, warnOncePerSession: true,
        hardStop: false, keepInbox: true,
      },
    },
    ...overrides,
  }
}

function headerEvent(harness) {
  return harness.event('request/header', {
    header: { config: ROUTE }, reason: 'initial', startsSeries: true,
  })
}

function assistantEvent(harness, usage, turn = 1, step = 1) {
  return harness.event('assistant/message', {
    turn, step,
    message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    stream: [],
    usage,
  })
}

function bigLog(lines = 240) {
  const out = []
  for (let i = 0; i < lines; i++) {
    out.push('2026-11-13T18:00:00Z INFO step=' + (i % 7) + ' widget=' + i + ' progress ' + i + '/' + lines)
  }
  out.push('2026-11-13T18:00:01Z ERROR boom: database connection refused')
  for (let i = 0; i < 20; i++) out.push('2026-11-13T18:00:02Z INFO tail ' + i)
  return out.join('\n')
}

function textOf(blocks) {
  return (blocks ?? []).filter((block) => block && block.type === 'text').map((block) => block.text).join('')
}

function recordsOf(dir, sessionId) {
  return readSessionRecords(path.join(dir, 'sessions'), sessionId)
}

// ---------------------------------------------------------------------------
// A1. Ledger: hand-computed USD over the four usage buckets
// ---------------------------------------------------------------------------

test('acceptance: ledger reconciles hand-computed USD across all four buckets', async () => {
  const dir = tempDir('usd')
  const harness = createHarness()
  apply(harness.ctx, configFor(dir))

  harness.event('turn/start', { turn: 1 })
  headerEvent(harness)
  harness.event('step/start', { turn: 1, step: 1 })
  // uncached=1000, cacheWrite=1000, cacheRead=8000, output=500
  await emitSession(harness.ctx, harness.session, assistantEvent(harness, {
    inputTokens: 1000, cacheReadTokens: 8000, cacheWriteTokens: 1000, outputTokens: 500,
  }))
  harness.event('turn/end', { turn: 1, reason: { kind: 'completed' } })
  harness.ctx.dispose()

  const records = recordsOf(dir, harness.session.id)
  const calls = records.filter((record) => record.kind === 'llm_call')
  assert.equal(calls.length, 1)
  assert.deepEqual(
    { u: calls[0].usage.uncachedInput, w: calls[0].usage.cacheWrite, r: calls[0].usage.cacheRead, o: calls[0].usage.output },
    { u: 1000, w: 1000, r: 8000, o: 500 },
  )
  const summary = summarizeRecords(records, harness.session.id)
  // 1000*1e-6 + 1000*2e-6 + 8000*0.1e-6 + 500*10e-6 = 0.001 + 0.002 + 0.0008 + 0.005
  assert.ok(Math.abs(summary.usd - 0.0088) < 1e-12, 'usd ' + summary.usd + ' != 0.0088')
  assert.deepEqual(summary.tokens, { uncachedInput: 1000, cacheRead: 8000, cacheWrite: 1000, output: 500 })
  assert.equal(summary.confidence, 'provider')
  assert.equal(summary.counts.calls, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('acceptance: inclusive semantics is applied exactly as documented', async () => {
  const dir = tempDir('usd-inclusive')
  const harness = createHarness()
  // The shipped default is now 'exclusive' (DSH-normalized provider usage, P0 fix),
  // so pin the documented inclusive formula with an explicit override.
  const config = configFor(dir, { usageSemantics: 'inclusive' })
  apply(harness.ctx, config)
  headerEvent(harness)
  await emitSession(harness.ctx, harness.session, assistantEvent(harness, {
    inputTokens: 1000, cacheReadTokens: 8000, cacheWriteTokens: 1000, outputTokens: 500,
  }))
  harness.ctx.dispose()

  const summary = summarizeRecords(recordsOf(dir, harness.session.id), harness.session.id)
  // uncached = max(0, 1000 - 8000 - 1000) = 0; 0 + 0.002 + 0.0008 + 0.005
  assert.equal(summary.tokens.uncachedInput, 0)
  assert.ok(Math.abs(summary.usd - 0.0078) < 1e-12, 'usd ' + summary.usd)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// A2. Unknown route: tokens recorded, USD never claimed
// ---------------------------------------------------------------------------

test('acceptance: unknown route records tokens but claims no USD', async () => {
  const dir = tempDir('unknown')
  const harness = createHarness()
  apply(harness.ctx, configFor(dir, { pricing: {} }))
  harness.event('request/header', {
    header: { config: { provider: 'mystery', model: 'ghost' } }, reason: 'initial', startsSeries: true,
  })
  await emitSession(harness.ctx, harness.session, assistantEvent(harness, {
    inputTokens: 5000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100,
  }))
  harness.ctx.dispose()

  const records = recordsOf(dir, harness.session.id)
  const call = records.find((record) => record.kind === 'llm_call')
  assert.equal(call.usd, 0)
  assert.equal(call.confidence, 'unknown')
  assert.equal(call.usage.inputTokens, 5000)
  const summary = summarizeRecords(records, harness.session.id)
  assert.equal(summary.usd, 0)
  assert.equal(summary.tokens.uncachedInput, 5000)
  assert.equal(summary.tokens.output, 100)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// A3. M1: shorter output, ERROR retained, side-store readable, committed marker
// ---------------------------------------------------------------------------

test('acceptance: M1 compacts, keeps ERROR, writes a readable original, and commits a marker', async () => {
  const dir = tempDir('m1')
  const projections = new MockProjectionRegistry()
  const harness = createHarness({ services: { sessionProjections: projections } })
  apply(harness.ctx, configFor(dir))
  const original = bigLog(240)
  const exec = { name: 'bash', callId: 'c2', agent: harness.agent }
  const result = { content: [{ type: 'text', text: original }], isError: false }

  const decision = await runPostExecute(harness.ctx, exec, result)
  assert.equal(decision.kind, 'accept')
  const committed = textOf(decision.content)
  assert.ok(committed.length < original.length, 'compressed output must be shorter')
  assert.match(committed, /ERROR/, 'error lines must survive compaction')
  const marker = /\[costpilot:m1 removed_tokens=(\d+) added_tokens=(\d+) pointers=(\d+)\]/.exec(committed)
  assert.ok(marker, 'committed content must carry the replayable [costpilot:m1 ...] marker')
  assert.ok(Number(marker[1]) > 0, 'marker removed_tokens must be positive')

  const sidePath = path.join(dir, 'originals', harness.session.id, 'c2.txt')
  assert.ok(fs.existsSync(sidePath), 'side-store original missing at ' + sidePath)
  assert.equal(fs.readFileSync(sidePath, 'utf8'), original)

  // The committed marker is what resume/fork replay folds into the dock view.
  await emitSessionWithProjections(harness.ctx, projections, harness.session, harness.event('tool/call', {
    turn: 1, step: 1, callId: 'c2', name: 'bash', arguments: '{"cmd":"cat log"}',
  }))
  await emitSessionWithProjections(harness.ctx, projections, harness.session, harness.event('tool/result', {
    turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c2', content: decision.content },
  }))
  harness.ctx.dispose()

  const summary = summarizeRecords(recordsOf(dir, harness.session.id), harness.session.id)
  assert.equal(summary.byModule.M1.count, 1)
  assert.equal(summary.byModule.M1.removedTokens, Number(marker[1]))
  const view = projections.view(harness.session, 'costpilot')
  assert.equal(view.m1.ops, 1)
  assert.equal(view.m1.removedTokens, summary.byModule.M1.removedTokens)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('acceptance: M1 is deterministic and skips secrets and error results', async () => {
  const dir = tempDir('m1-guards')
  const harness = createHarness()
  apply(harness.ctx, configFor(dir))
  const original = bigLog(240)
  const exec = { name: 'bash', callId: 'c9', agent: harness.agent }
  const result = { content: [{ type: 'text', text: original }], isError: false }

  const first = await runPostExecute(harness.ctx, exec, result)
  const second = await runPostExecute(harness.ctx, exec, result)
  assert.equal(textOf(first.content), textOf(second.content), 'same input must yield the same output')

  const secretText = 'this log mentions a password: hunter2\n' + original
  const secretInput = { content: [{ type: 'text', text: secretText }], isError: false }
  const secret = await runPostExecute(harness.ctx, { name: 'bash', callId: 'c10', agent: harness.agent }, secretInput,
    async () => ({ kind: 'accept', content: secretInput.content }))
  assert.equal(textOf(secret.content ?? secretInput.content), secretText, 'secret-looking text must not be compacted')
  assert.equal(fs.existsSync(path.join(dir, 'originals', harness.session.id, 'c10.txt')), false)

  const errorInput = { content: [{ type: 'text', text: original }], isError: true }
  const errored = await runPostExecute(harness.ctx, { name: 'bash', callId: 'c11', agent: harness.agent }, errorInput,
    async () => ({ kind: 'accept', content: errorInput.content }))
  assert.equal(textOf(errored.content ?? errorInput.content), original, 'failed results must not be compacted')
  harness.ctx.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// A4. observe mode never rewrites
// ---------------------------------------------------------------------------

test('acceptance: observe mode records decisions but never rewrites tool output', async () => {
  const dir = tempDir('observe')
  const harness = createHarness()
  const config = configFor(dir)
  config.modules.M1 = { enabled: true, mode: 'observe', minDeltaTokens: 100, sideStore: true }
  apply(harness.ctx, config)
  const original = bigLog(240)
  const result = { content: [{ type: 'text', text: original }], isError: false }
  const decision = await runPostExecute(
    harness.ctx,
    { name: 'bash', callId: 'c7', agent: harness.agent },
    result,
    async () => ({ kind: 'accept', content: result.content }),
  )
  assert.equal(decision.kind, 'accept')
  assert.deepEqual(decision.content, result.content, 'observe mode must pass content through unchanged')
  assert.equal(fs.existsSync(path.join(dir, 'originals')), false, 'observe mode must not write a side-store')
  harness.ctx.dispose()
  const summary = summarizeRecords(recordsOf(dir, harness.session.id), harness.session.id)
  assert.equal(summary.byModule.M1, undefined, 'observe mode must not record an M1 mutation')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// A5. M9: one marked steer, no cancel by default; hardStop keeps the inbox
// ---------------------------------------------------------------------------

test('acceptance: M9 steers once with a guard marker and does not cancel by default', async () => {
  const dir = tempDir('m9-warn')
  const harness = createHarness()
  const config = configFor(dir)
  config.budgets = { sessionUSD: 0.0005, warnAtPct: 80, hardStopAtPct: 120 }
  apply(harness.ctx, config)

  harness.event('turn/start', { turn: 1 })
  headerEvent(harness)
  // 1000 uncached input tokens * $1/M = $0.001 => 200% of the $0.0005 budget
  await emitSession(harness.ctx, harness.session, assistantEvent(harness, {
    inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
  }))
  harness.event('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const payload = { agent: harness.agent, messages: [], turn: 2, step: 1, signal: {} }
  const first = await runPreStep(harness.ctx, payload)
  assert.equal(first.kind, 'enter')
  assert.equal(harness.agent.steered.length, 1, 'exactly one steer expected')
  assert.match(harness.agent.steered[0].content[0].text, /\[costpilot:guard action=warn reason=budget\]/)
  assert.match(harness.agent.steered[0].content[0].text, /M9 guard \[budget\]/)
  assert.equal(harness.agent.steered[0].source.kind, 'costpilot')
  assert.equal(harness.agent.steered[0].role, 'user', 'guard steer is a complete user message')
  assert.ok(harness.agent.steered[0].id, 'guard steer has a stable identity')
  assert.equal(harness.agent.canceled.length, 0, 'hardStop=false must never cancel')

  await runPreStep(harness.ctx, payload)
  assert.equal(harness.agent.steered.length, 1, 'warnOncePerSession must suppress the repeat steer')
  harness.ctx.dispose()

  const summary = summarizeRecords(recordsOf(dir, harness.session.id), harness.session.id)
  assert.equal(summary.guard.count, 1)
  assert.equal(summary.guard.lastReason, 'budget')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('acceptance: M9 hard stop rejects the step and cancels with keepInbox', async () => {
  const dir = tempDir('m9-stop')
  const harness = createHarness()
  const config = configFor(dir)
  config.budgets = { sessionUSD: 0.0005, warnAtPct: 80, hardStopAtPct: 120 }
  config.modules.M9 = { ...config.modules.M9, hardStop: true, hardStopSteps: 1, keepInbox: true }
  apply(harness.ctx, config)

  harness.event('turn/start', { turn: 1 })
  headerEvent(harness)
  await emitSession(harness.ctx, harness.session, assistantEvent(harness, {
    inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
  }))

  const decision = await runPreStep(harness.ctx, { agent: harness.agent, messages: [], turn: 2, step: 1 })
  assert.equal(decision.kind, 'reject')
  assert.equal(harness.agent.canceled.length, 1)
  assert.equal(harness.agent.canceled[0].cause.kind, 'costpilot')
  assert.equal(harness.agent.canceled[0].options.keepInbox, true)
  assert.equal(harness.agent.steered.length, 0)
  harness.ctx.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// A6. Projection: standard-event fold for cost, M1 markers, guard markers
// ---------------------------------------------------------------------------

function fold(definition, events) {
  let state = definition.init(undefined, 0)
  for (const event of events) state = definition.apply(state, event)
  return definition.wire.view(state)
}

function ev(seq, type, data) {
  return { seq, time: 1000 + seq, type, data }
}

test('acceptance: projection folds cost, M1 savings and guard markers from standard events', () => {
  const definition = createCostProjectionDefinition({
    mode: 'assist',
    modules: { M1: { enabled: true }, M9: { enabled: true } },
    pricing: PRICE,
    usageSemantics: 'exclusive',
  })
  const view = fold(definition, [
    ev(0, 'request/header', { header: { config: ROUTE }, reason: 'initial', startsSeries: true }),
    ev(1, 'assistant/message', { turn: 1, step: 1, message: {}, stream: [], usage: { inputTokens: 1000, cacheReadTokens: 8000, cacheWriteTokens: 1000, outputTokens: 500 } }),
    ev(2, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'x\n\n[costpilot:m1 removed_tokens=1200 added_tokens=80 pointers=2]' }] } }),
    ev(3, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'y\n\n[costpilot:m1 removed_tokens=300 added_tokens=10 pointers=0]' }] } }),
    ev(4, 'user/message', { content: [{ type: 'text', text: '[costpilot:guard action=warn reason=budget] converge' }], source: { kind: 'costpilot' } }),
    ev(5, 'user/message', { content: [{ type: 'text', text: '[costpilot:guard action=warn reason=budget] ignore me' }], source: { kind: 'user' } }),
  ])
  assert.equal(view.calls, 1)
  assert.equal(view.usd, 0.0088)
  assert.deepEqual(view.tokens, { uncachedInput: 1000, cacheRead: 8000, cacheWrite: 1000, output: 500 })
  assert.deepEqual(view.m1, { removedTokens: 1500, addedTokens: 90, ops: 2 })
  assert.deepEqual(view.guard, { count: 1, lastReason: 'budget' })
  assert.equal(view.mode, 'assist')
  assert.equal(view.m1Enabled, true)
  assert.equal(view.m9Enabled, true)
  assert.equal(view.route.model, 'deepseek-chat')
})

test('acceptance: projection keeps tokens but reports unknown confidence for unpriced routes', () => {
  const definition = createCostProjectionDefinition({ mode: 'observe', modules: {}, pricing: {} })
  const view = fold(definition, [
    ev(0, 'request/header', { header: { config: { provider: 'nope', model: 'ghost' } } }),
    ev(1, 'assistant/message', { turn: 1, step: 1, message: {}, stream: [], usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 } }),
  ])
  assert.equal(view.usd, 0)
  assert.equal(view.confidence, 'unknown')
  assert.equal(view.tokens.uncachedInput, 100)
  assert.equal(view.calls, 1)
})

// ---------------------------------------------------------------------------
// A7. Client half: loader id, slots injection, dock registration, structure
// ---------------------------------------------------------------------------

const CLIENT_SOURCE = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function loadClient() {
  let loadArgs
  const styles = []
  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: (tag) => styles.push(tag) },
  }
  const window = { __ModuleLoader__: { load: (args) => { loadArgs = args } } }
  new Function('window', 'document', CLIENT_SOURCE)(window, document)
  const require = (id) => {
    if (id === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
        useRef: () => ({ current: null }),
        useState: () => [false, () => {}],
        useEffect: () => {},
      }
    }
    if (id === 'react-dom') return { createPortal: (node) => node }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      return { Tooltip: (props) => ({ type: 'Tooltip', props }) }
    }
    return {}
  }
  return { exports: loadArgs.factory(require), loadArgs, styles }
}

const VIEW = {
  mode: 'assist', calls: 3, usd: 0.0123, cost: 0.0123, currency: 'CNY', confidence: 'provider',
  tokens: { uncachedInput: 2000, cacheRead: 8000, cacheWrite: 1000, output: 500 },
  m1: { removedTokens: 1200, addedTokens: 80, ops: 2 },
  guard: { count: 1, lastReason: 'budget' },
  route: ROUTE,
}

test('acceptance: client half loads through __ModuleLoader__ and registers the dock entry', () => {
  const { exports, loadArgs } = loadClient()
  assert.equal(loadArgs.id, 'dsh-costpilot')
  assert.equal(typeof loadArgs.factory, 'function')
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')

  let registered
  const ctx = {
    slots: {
      inject(owner, callback) {
        assert.equal(owner, 'conversation.composer.dock')
        registered = callback()
      },
      register(options, component) { return { options, component } },
    },
  }
  exports.apply(ctx)
  assert.equal(registered.options.name, 'conversation.composer.dock')
  assert.equal(registered.options.id, 'costpilot')
  assert.equal(registered.options.order, 2)
  assert.equal(typeof registered.component, 'function')
})

test('acceptance: client renders a cost-only pill and hides itself without data', () => {
  const { exports } = loadClient()
  const tree = exports.CostPilotPill({ useProjection: (key) => { assert.equal(key, 'costpilot'); return VIEW } })
  assert.equal(tree.type, 'span')
  assert.match(tree.props.className, /anchor/)
  assert.equal(tree.props['data-composer-stat'], 'costpilot')

  const pill = tree.props.children[0]
  assert.equal(pill.type, 'button')
  assert.match(pill.props.className, /pill/)
  assert.match(String(pill.props.title), /本会话累计成本/)
  const icon = pill.props.children[0]
  assert.equal(typeof icon.type, 'function')
  const label = pill.props.children[1]
  const labelText = String(label.props.children.join(''))
  assert.match(labelText, /¥/)

  assert.equal(exports.CostPilotPill({ useProjection: () => undefined }), null)
  const empty = { ...VIEW, calls: 0, m1: { removedTokens: 0, addedTokens: 0, ops: 0 }, guard: { count: 0, lastReason: null } }
  assert.equal(exports.CostPilotPill({ useProjection: () => empty }), null)
})

// ---------------------------------------------------------------------------
// A8. /cost command
// ---------------------------------------------------------------------------

test('acceptance: /cost renders CNY cost and the session id from the live ledger', async () => {
  const dir = tempDir('cmd')
  const harness = createHarness()
  apply(harness.ctx, configFor(dir))
  headerEvent(harness)
  await emitSession(harness.ctx, harness.session, assistantEvent(harness, {
    inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100,
  }))
  const result = await harness.commands.execute('cost', { agent: harness.agent, rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /¥/)
  assert.match(result.text, /sess-1/)
  assert.match(result.text, /¥[\d.]+/)
  harness.ctx.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// A9. Offline report over a temporary ledger file
// ---------------------------------------------------------------------------

test('acceptance: sim reports total_cost and m1_removed from a temporary ledger', () => {
  const dir = tempDir('sim')
  const sessionId = 'sess-sim'
  const lines = [
    { v: 1, kind: 'llm_call', sessionId, ts: 1, usd: 0.0088, confidence: 'provider', usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 8000, cacheWriteTokens: 1000 } },
    { v: 1, kind: 'mutation', sessionId, ts: 2, usd: 0, confidence: 'heuristic', extra: { module: 'M1', removedTokens: 1200, addedTokens: 80, count: 1 } },
    { v: 1, kind: 'guard', sessionId, ts: 3, extra: { action: 'warn', reason: 'budget' } },
  ]
  fs.writeFileSync(path.join(dir, sessionId + '.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n')

  const records = readSessionRecords(dir, sessionId)
  const summary = summarizeRecords(records, sessionId)
  assert.equal(summary.counts.calls, 1)
  assert.ok(Math.abs(summary.usd - 0.0088) < 1e-12)
  assert.equal(summary.byModule.M1.removedTokens, 1200)
  assert.equal(summary.guard.count, 1)

  const report = renderReport(dir)
  assert.match(report, /total_cost=¥0\.0088/)
  assert.match(report, /m1_removed=1200tok/)
  const json = JSON.parse(renderReport(dir, { json: true }))
  assert.equal(json.sessions[0].usd, 0.0088)
  fs.rmSync(dir, { recursive: true, force: true })
})