/**
 * CostPilot v1.0 black-box acceptance suite.
 *
 * Drives only public entries: the plugin (index.js), public lib folds
 * (lib/projection.js, lib/sim.js), and the client half (client.js) through
 * test/mock-ctx.mjs. Assertions observe host-visible effects only: session
 * events, waterfall decisions, agent steer/cancel/model.select, registered
 * tools and restrictions, command text, ledger files, projection views, and the
 * client render tree.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'
import { createCostProjectionDefinition } from '../lib/projection.js'
import { renderReport, summarizeRecords, readSessionRecords } from '../lib/sim.js'
import {
  createHarness,
  emitSession,
  runPostExecute,
  runPreStep,
  MockProjectionRegistry,
} from './mock-ctx.mjs'

const PRICE = { deepseek: { 'deepseek-chat': { uncachedInput: 2, cacheWrite: 2, cacheRead: 0.5, output: 8 } } }
const ROUTE = { provider: 'deepseek', model: 'deepseek-chat' }

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'costpilot-v1-accept-' + label + '-'))
}

function configFor(dir, modules = {}, overrides = {}) {
  return {
    dataDir: dir,
    mode: 'assist',
    currency: 'CNY',
    usageSemantics: 'exclusive',
    pricing: PRICE,
    budgets: { sessionUSD: 100, warnAtPct: 80, hardStopAtPct: 120 },
    modules: {
      M1: { enabled: false },
      M2: { enabled: false },
      M3: { enabled: false },
      M4: { enabled: false },
      M5: { enabled: false },
      M6: { enabled: false },
      M7: { enabled: false },
      M8: { enabled: false },
      M9: { enabled: false },
      ...modules,
    },
    ...overrides,
  }
}

function header(harness) {
  return harness.event('request/header', {
    header: { config: ROUTE }, reason: 'initial', startsSeries: true,
  })
}

async function emitUsage(harness, usage, turn = 1, step = 1) {
  await emitSession(harness.ctx, harness.session, harness.event('assistant/message', {
    turn, step, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, stream: [], usage,
  }))
}

function recordsOf(dir, sessionId) {
  return readSessionRecords(path.join(dir, 'sessions'), sessionId)
}

function bigLog(lines = 240) {
  const out = []
  for (let i = 0; i < lines; i++) out.push('2026-11-13T18:00:00Z INFO step=' + (i % 7) + ' widget=' + i + ' progress ' + i + '/' + lines)
  out.push('2026-11-13T18:00:01Z ERROR boom: connection refused')
  for (let i = 0; i < 20; i++) out.push('2026-11-13T18:00:02Z INFO tail ' + i)
  return out.join('\n')
}

function textOf(blocks) {
  return (blocks ?? []).filter((b) => b && b.type === 'text').map((b) => b.text).join('')
}

// ---------------------------------------------------------------------------
// v1 M2: pre-step compaction through the DSH compaction event protocol
// ---------------------------------------------------------------------------

async function seedCompactionHistory(harness) {
  const big = 'log line '.repeat(600)
  harness.event('system/message', { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system prompt' }] } })
  await emitSession(harness.ctx, harness.session, harness.event('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial', startsSeries: true }))
  let turn = 0
  for (let step = 1; step <= 10; step++) {
    if ((step - 1) % 3 === 0) { turn += 1; harness.event('turn/start', { turn }) }
    harness.event('assistant/message', {
      turn, step,
      message: { id: 'a' + step, role: 'assistant', content: [{ type: 'tool-call', callId: 'c' + step, name: step % 2 === 0 ? 'read' : 'glob', arguments: '{"path":"a.txt"}' }] },
      stream: [],
    })
    harness.event('tool/call', { turn, step, callId: 'c' + step, name: step % 2 === 0 ? 'read' : 'glob', arguments: '{"path":"a.txt"}' })
    harness.event('tool/result', { turn, step, message: { id: 'r' + step, role: 'tool', toolCallId: 'c' + step, content: [{ type: 'text', text: big }] } })
  }
}

test('acceptance-v1: M2 pre-step writes the full compaction event protocol', async () => {
  const dir = tempDir('m2')
  const harness = createHarness()
  apply(harness.ctx, configFor(dir, {
    M2: { enabled: true, allowWithBuiltinCompaction: true, tauLineReuse: 0.9, maxRegionRatio: 0.6, minRemainingSteps: 6 },
  }))
  await seedCompactionHistory(harness)
  await runPreStep(harness.ctx, { agent: harness.agent, messages: [], turn: 2, step: 2, signal: {}, modelSelection: {} }, async () => ({ kind: 'enter', messages: [] }))

  const events = harness.session.appended
  const types = events.map((event) => event.type)
  const start = events.find((event) => event.type === 'compaction/start')
  const summary = events.find((event) => event.type === 'compaction/summary')
  const replace = events.find((event) => event.type === 'user/message' && event.surfaceOp)
  const end = events.find((event) => event.type === 'compaction/end')
  assert.ok(start && summary && replace && end, 'protocol events present: ' + types.join(','))
  assert.equal(start.data.compactionId, summary.data.compactionId)
  assert.equal(end.data.compactionId, summary.data.compactionId)
  assert.equal(summary.data.shadowedRange.start, replace.surfaceOp.startSeq)
  assert.equal(summary.data.shadowedRange.end, replace.surfaceOp.endSeq)
  assert.deepEqual(replace.surfaceOp, { op: 'replace', startSeq: summary.data.shadowedRange.start, endSeq: summary.data.shadowedRange.end })
  assert.ok(Array.isArray(summary.data.shadowedSeqs) && summary.data.shadowedSeqs.length > 0)
  assert.ok(summary.data.shadowedTokenCount > 0)
  assert.ok(Array.isArray(replace.sourceEventSeqs) && replace.sourceEventSeqs.length > 0)
  assert.equal(replace.data.role ?? replace.data.message?.role, 'user')
  harness.ctx.dispose()

  const summaryLedger = summarizeRecords(recordsOf(dir, harness.session.id), harness.session.id)
  assert.ok(summaryLedger.byModule.M2, 'M2 mutation recorded: ' + JSON.stringify(Object.keys(summaryLedger.byModule)))
  assert.ok(summaryLedger.byModule.M2.removedTokens > 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('acceptance-v1: M2 stays gated when the builtin compaction service is present', async () => {
  const dir = tempDir('m2-gated')
  const harness = createHarness({ services: { compaction: { /* builtin engine present */ } } })
  seedCompactionHistory(harness)
  apply(harness.ctx, configFor(dir, {
    M2: { enabled: true, allowWithBuiltinCompaction: false, tauLineReuse: 0.9, maxRegionRatio: 0.6 },
  }))
  await runPreStep(harness.ctx, { agent: harness.agent, messages: [], turn: 2, step: 2, signal: {}, modelSelection: {} }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(harness.session.appended.some((event) => event.type === 'compaction/start'), false)
  harness.ctx.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// v1 M4: index_query build, ignore rules, SQL safety, cross-session reuse
// ---------------------------------------------------------------------------

function seedWorkspace() {
  const workspace = tempDir('m4-workspace')
  fs.writeFileSync(path.join(workspace, 'alpha.ts'), 'export function alphaOne() {\n  return 1\n}\n')
  fs.writeFileSync(path.join(workspace, 'beta.py'), 'def beta_two():\n    return 2\n')
  fs.mkdirSync(path.join(workspace, '.git'), { recursive: true })
  fs.writeFileSync(path.join(workspace, '.git', 'secret.ts'), 'export const hidden = 1\n')
  return workspace
}

const M4_CONFIG = { enabled: true, indexPath: '.dsh-costpilot/index.db', maxFiles: 100, maxRows: 50, exclude: [], ignoreDirs: ['.git'], maxFileBytes: 100000 }

function m4Harness(workspace, sessionId = 'sess-1') {
  const harness = createHarness({ sessionId })
  harness.session.header = { cwd: workspace }
  return harness
}

test('acceptance-v1: M4 index_query builds the workspace index and enforces read-only SQL', async () => {
  const workspace = seedWorkspace()
  const dbDir = tempDir('m4-db')
  const harness = m4Harness(workspace)
  apply(harness.ctx, configFor(dbDir, { M4: M4_CONFIG }))

  const tool = harness.tools.get('index_query')
  assert.ok(tool, 'index_query is registered when M4 is on')
  assert.equal(tool.name, 'index_query')
  const files = await tool.execute({ sql: 'SELECT path, language FROM files ORDER BY path' }, { agent: harness.agent })
  assert.match(files.text, /alpha\.ts/)
  assert.match(files.text, /beta\.py/)
  assert.doesNotMatch(files.text, /secret\.ts/, 'ignored directories stay out')
  assert.match(files.text, /index_query: \d+ row/)

  const entries = await tool.execute({ sql: "SELECT path, name, kind FROM entries WHERE kind = 'function' ORDER BY path" }, { agent: harness.agent })
  assert.match(entries.text, /alphaOne/)
  assert.match(entries.text, /beta_two/)

  await assert.rejects(() => tool.execute({ sql: 'DELETE FROM files' }, { agent: harness.agent }), /SELECT|forbidden|only/i)
  await assert.rejects(() => tool.execute({ sql: 'SELECT path FROM files; DROP TABLE files' }, { agent: harness.agent }), /multiple|SELECT|forbidden/i)
  await assert.rejects(() => tool.execute({ sql: 'PRAGMA table_info(files)' }, { agent: harness.agent }), /SELECT|forbidden/i)
  assert.ok(fs.existsSync(path.join(workspace, '.dsh-costpilot', 'index.db')), 'db is stored under the workspace root')
  harness.ctx.dispose()
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.rmSync(dbDir, { recursive: true, force: true })
})

test('acceptance-v1: M4 index is reused by a second session in the same workspace', async () => {
  const workspace = seedWorkspace()
  const dbDir = tempDir('m4-reuse')
  const first = m4Harness(workspace, 'sess-a')
  apply(first.ctx, configFor(dbDir, { M4: M4_CONFIG }))
  const firstTool = first.tools.get('index_query')
  const built = await firstTool.execute({ sql: 'SELECT count(*) AS n FROM files' }, { agent: first.agent })
  assert.match(built.text, /\b2\b/)
  first.ctx.dispose()

  const second = m4Harness(workspace, 'sess-b')
  apply(second.ctx, configFor(dbDir, { M4: M4_CONFIG }))
  const secondTool = second.tools.get('index_query')
  const reused = await secondTool.execute({ sql: 'SELECT path FROM files ORDER BY path' }, { agent: second.agent })
  assert.match(reused.text, /alpha\.ts/)
  second.ctx.dispose()
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.rmSync(dbDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// v1 M5: batching nudge in pre-step, capped by maxInjections
// ---------------------------------------------------------------------------

test('acceptance-v1: M5 injects a batching nudge and respects maxInjections', async () => {
  const dir = tempDir('m5')
  const harness = createHarness()
  apply(harness.ctx, configFor(dir, { M5: { enabled: true, maxInjections: 3, firstTurns: 5, adaptive: false } }))
  const payload = { agent: harness.agent, messages: [], turn: 1, step: 1, signal: {}, modelSelection: {} }
  for (let i = 0; i < 4; i++) await runPreStep(harness.ctx, payload, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(harness.agent.steered.length, 3, 'maxInjections=3 caps the nudges')
  assert.match(harness.agent.steered[0].content[0].text, /Batch independent tool calls/)
  assert.equal(harness.agent.steered[0].source.kind, 'costpilot')
  assert.equal(harness.agent.steered[0].role, 'user', 'steer receives a complete user message')
  assert.ok(harness.agent.steered[0].id, 'the nudge has a stable identity')
  harness.ctx.dispose()
  const summary = summarizeRecords(recordsOf(dir, harness.session.id), harness.session.id)
  assert.ok(summary.metrics.count >= 3, 'each nudge is recorded as a metric')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// v1 M6: tool-set scheduling via restrict (subtractive, next step)
// ---------------------------------------------------------------------------

test('acceptance-v1: M6 restricts large-schema candidates but never keep tools', async () => {
  const dir = tempDir('m6')
  const harness = createHarness()
  const bigParameters = { type: 'object', properties: Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['field' + i, { type: 'string', description: 'description '.repeat(8) }])) }
  for (const name of ['bash', 'read', 'web_search', 'office']) {
    harness.tools.register({ name, description: 'tool ' + name + ' ' + 'x'.repeat(200), parameters: bigParameters, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })
  }
  apply(harness.ctx, configFor(dir, { M6: { enabled: true, maxSwitches: 3, minRemainingSteps: 6, keep: ['bash', 'read'], hideCandidates: ['web_search', 'office'] } }))
  await emitSession(harness.ctx, harness.session, harness.event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'glob', arguments: '{}' }))
  await runPreStep(harness.ctx, { agent: harness.agent, messages: [], turn: 1, step: 3, signal: {}, modelSelection: {} }, async () => ({ kind: 'enter', messages: [] }))
  const denied = harness.tools.denied()
  assert.ok(denied.includes('web_search') || denied.includes('office'), 'large candidate denied: ' + denied.join(','))
  assert.ok(!denied.includes('bash') && !denied.includes('read'), 'keep list is never restricted')
  assert.ok(!denied.includes('run_code'), 'run_code is never named')
  const summary = summarizeRecords(recordsOf(dir, harness.session.id), harness.session.id)
  assert.match(String(summary.metrics.lastReason), /toolset-switch/)
  harness.ctx.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// v1 M7: route-down at the turn boundary via agent.model.select
// ---------------------------------------------------------------------------

test('acceptance-v1: M7 selects the cheap route at turn-stopping and caps switches', async () => {
  const dir = tempDir('m7')
  const harness = createHarness()
  apply(harness.ctx, configFor(dir, {
    M7: { enabled: true, routeDown: { provider: 'deepseek-account', model: 'deepseek-flash' }, phases: ['search', 'read'], minRemainingSteps: 10, maxSwitches: 2 },
  }))
  header(harness)
  await emitUsage(harness, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 })
  await emitSession(harness.ctx, harness.session, harness.event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'grep', arguments: '{}' }))

  for (let i = 0; i < 3; i++) await harness.ctx.emit('agent/turn-stopping', { agent: harness.agent, turn: 1, signal: {} })
  assert.equal(harness.agent.modelSelections.length, 2, 'maxSwitches=2 caps route changes')
  assert.deepEqual(harness.agent.modelSelections[0], { provider: 'deepseek-account', model: 'deepseek-flash' })
  harness.ctx.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// v1 M8: deny duplicate read-only calls and record the guard decision
// ---------------------------------------------------------------------------

test('acceptance-v1: M8 deny blocks an identical repeated read with a pointer', async () => {
  const dir = tempDir('m8')
  const harness = createHarness()
  apply(harness.ctx, configFor(dir, { M8: { enabled: true, level: 'deny', allowTools: ['read'], ttlSeconds: 600 } }))
  const exec = { name: 'read', arguments: '{"file_path":"a.txt"}', callId: 'r1', agent: harness.agent }
  const first = await harness.ctx.waterfall('tools/pre-execute', [exec], async () => ({ kind: 'allow' }))
  assert.equal(first.kind, 'allow')
  await runPostExecute(harness.ctx, exec, { content: [{ type: 'text', text: 'file body' }], isError: false }, async () => ({ kind: 'accept' }))

  const second = await harness.ctx.waterfall('tools/pre-execute', [
    { name: 'read', arguments: '{"file_path": "a.txt"}', callId: 'r2', agent: harness.agent },
  ], async () => ({ kind: 'allow' }))
  assert.equal(second.kind, 'deny', 'the duplicate is denied')
  assert.match(second.reason, /duplicate.*read|previous result at seq/i)
  assert.match(second.reason, /Reuse/i)
  harness.ctx.dispose()

  const summary = summarizeRecords(recordsOf(dir, harness.session.id), harness.session.id)
  assert.equal(summary.guard.count, 1)
  assert.match(String(summary.guard.lastReason), /repeat-call/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('acceptance-v1: M8 advisory injects a replay-safe user message', async () => {
  const dir = tempDir('m8-advisory')
  const harness = createHarness()
  apply(harness.ctx, configFor(dir, { M8: { enabled: true, level: 'advisory', allowTools: ['read'], ttlSeconds: 600 } }))
  const exec = { name: 'read', arguments: '{"file_path":"a.txt"}', callId: 'r1', agent: harness.agent }
  await harness.ctx.waterfall('tools/pre-execute', [exec], async () => ({ kind: 'allow' }))
  await runPostExecute(harness.ctx, exec, { content: [{ type: 'text', text: 'file body' }], isError: false }, async () => ({ kind: 'accept' }))

  const second = await harness.ctx.waterfall('tools/pre-execute', [
    { name: 'read', arguments: '{"file_path":"a.txt"}', callId: 'r2', agent: harness.agent },
  ], async () => ({ kind: 'allow' }))
  assert.equal(second.kind, 'allow', 'advisory never denies')
  assert.equal(harness.agent.injected.length, 1)
  const notice = harness.agent.injected[0]
  assert.equal(typeof notice.id, 'string')
  assert.ok(notice.id.length > 0, 'the injected message has a stable identity')
  assert.equal(notice.role, 'user')
  assert.equal(notice.source.kind, 'costpilot')
  assert.ok(Array.isArray(notice.content))
  harness.ctx.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// v1 M9: warn (not cancel) with the replayable guard marker
// ---------------------------------------------------------------------------

test('acceptance-v1: M9 steers a marked warning and keeps hardStop off', async () => {
  const dir = tempDir('m9')
  const harness = createHarness()
  const config = configFor(dir, { M9: { enabled: true, maxSteps: 160, maxToolCalls: 400, maxTurnCostUSD: 100, hardStop: false, keepInbox: true, warnOncePerSession: true } })
  config.budgets = { sessionUSD: 0.0005, warnAtPct: 80, hardStopAtPct: 120 }
  apply(harness.ctx, config)
  header(harness)
  await emitUsage(harness, { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  await runPreStep(harness.ctx, { agent: harness.agent, messages: [], turn: 2, step: 1, signal: {}, modelSelection: {} }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(harness.agent.steered.length, 1)
  assert.match(harness.agent.steered[0].content[0].text, /\[costpilot:guard action=warn reason=budget\]/)
  assert.equal(harness.agent.canceled.length, 0, 'default hardStop=false never cancels')
  harness.ctx.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// v1 commands: /costpilot status, on/off (live tool registration), simulate
// ---------------------------------------------------------------------------

test('acceptance-v1: /costpilot status/on/off toggles M4 and simulate reports ¥ savings', async () => {
  const dir = tempDir('cmds')
  const harness = createHarness()
  apply(harness.ctx, configFor(dir, { M1: { enabled: true, minDeltaTokens: 100 }, M4: { enabled: false } }))
  header(harness)
  await emitUsage(harness, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 })
  const compressed = await runPostExecute(harness.ctx, { name: 'bash', callId: 'c1', agent: harness.agent }, {
    content: [{ type: 'text', text: bigLog(240) }], isError: false,
  }, async () => ({ kind: 'accept' }))
  assert.match(textOf(compressed.content), /\[costpilot:m1 /)

  const status = await harness.commands.execute('costpilot', { agent: harness.agent, rawInput: 'status' })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /mode=assist/)
  assert.match(status.text, /M1: on/)
  assert.match(status.text, /M4: off/)

  const on = await harness.commands.execute('costpilot', { agent: harness.agent, rawInput: 'on M4' })
  assert.match(on.text, /on M4/)
  assert.ok(harness.tools.get('index_query'), 'enabling M4 registers index_query at runtime')
  const off = await harness.commands.execute('costpilot', { agent: harness.agent, rawInput: 'off M4' })
  assert.match(off.text, /off M4/)
  assert.equal(harness.tools.get('index_query'), undefined, 'disabling M4 removes index_query')

  const simulate = await harness.commands.execute('costpilot', { agent: harness.agent, rawInput: 'simulate' })
  assert.equal(simulate.kind, 'success')
  assert.match(simulate.text, /¥/)
  assert.match(simulate.text, /M1:/)
  assert.match(simulate.text, /total estimated saving: ¥/)
  const bad = await harness.commands.execute('costpilot', { agent: harness.agent, rawInput: 'bogus' })
  assert.equal(bad.kind, 'error')
  harness.ctx.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// v1 currency: ¥ in /cost, sim report, and the dock label
// ---------------------------------------------------------------------------

test('acceptance-v1: CNY currency renders ¥ in /cost, sim report and the client pill', async () => {
  const dir = tempDir('currency')
  const harness = createHarness()
  apply(harness.ctx, configFor(dir))
  header(harness)
  await emitUsage(harness, { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  const cost = await harness.commands.execute('cost', { agent: harness.agent, rawInput: '' })
  assert.match(cost.text, /URL|USD|¥/)
  assert.match(cost.text, /¥0\.0020/)
  harness.ctx.dispose()

  const report = renderReport(path.join(dir, 'sessions'))
  assert.match(report, /cost=¥0\.0020/)
  assert.match(report, /total_cost=¥0\.0020/)

  const client = loadClient()
  const label = String(client.exports.CostPilotPill({ useProjection: () => ({
    mode: 'assist', calls: 1, cost: 0.002, usd: 0.002, currency: 'CNY', confidence: 'provider',
    tokens: { uncachedInput: 1000, cacheRead: 0, cacheWrite: 0, output: 0 },
    m1: { removedTokens: 0, addedTokens: 0, ops: 0 }, guard: { count: 0, lastReason: null }, route: ROUTE,
  }) }).props.children[0].props.children[1].props.children.join(''))
  assert.match(label, /¥/)
  fs.rmSync(dir, { recursive: true, force: true })
})

const CLIENT_SOURCE = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function loadClient() {
  let loadArgs
  const styles = []
  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: (tag) => styles.push(tag) },
    body: {},
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
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { Tooltip: (props) => ({ type: 'Tooltip', props }) }
    return {}
  }
  return { exports: loadArgs.factory(require), loadArgs, styles }
}

// ---------------------------------------------------------------------------
// v1 projection: folds standard events + planted markers with CNY currency
// ---------------------------------------------------------------------------

function fold(definition, events) {
  let state = definition.init(undefined, 0)
  for (const event of events) state = definition.apply(state, event)
  return definition.wire.view(state)
}

function ev(seq, type, data) {
  return { seq, time: 1000 + seq, type, data }
}

test('acceptance-v1: projection folds cost, M1/M9 markers and live module toggles', () => {
  const modules = { M1: { enabled: true }, M2: { enabled: false }, M9: { enabled: true }, M4: { enabled: true } }
  const definition = createCostProjectionDefinition({
    mode: 'assist',
    currency: 'CNY',
    modules: () => modules,
    pricing: { deepseek: { 'deepseek-chat': { uncachedInput: 2, cacheWrite: 2, cacheRead: 0.5, output: 8 } } },
    usageSemantics: 'exclusive',
  })
  const view = fold(definition, [
    ev(0, 'request/header', { header: { config: ROUTE }, reason: 'initial', startsSeries: true }),
    ev(1, 'assistant/message', { turn: 1, step: 1, message: {}, stream: [], usage: { inputTokens: 1000, cacheReadTokens: 8000, cacheWriteTokens: 1000, outputTokens: 500 } }),
    ev(2, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'x\n\n[costpilot:m1 removed_tokens=1200 added_tokens=80 pointers=2]' }] } }),
    ev(3, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'y\n\n[costpilot:m1 removed_tokens=300 added_tokens=10 pointers=0]' }] } }),
    ev(4, 'user/message', { content: [{ type: 'text', text: '[costpilot:guard action=warn reason=budget] converge' }], source: { kind: 'costpilot' } }),
  ])
  assert.equal(view.calls, 1)
  // 1000*2 + 8000*0.5 + 1000*2 + 500*8 = 2000 + 4000 + 2000 + 4000 = 12000 / 1e6
  assert.equal(view.cost, 0.012)
  assert.equal(view.usd, 0.012)
  assert.equal(view.currency, 'CNY')
  assert.deepEqual(view.m1, { removedTokens: 1500, addedTokens: 90, ops: 2 })
  assert.deepEqual(view.guard, { count: 1, lastReason: 'budget' })
  assert.equal(view.modules.M4, true)
  modules.M4.enabled = false
  const live = definition.wire.view(definition.init())
  assert.equal(live.modules.M4, false, 'module getter is read live for runtime toggles')
})

// ---------------------------------------------------------------------------
// v1 ledger: attempt/retry sampling is billed as replacement deltas
// ---------------------------------------------------------------------------

test('acceptance-v1: ledger bills assistant/attempt and llm/retry samples as deltas', async () => {
  const dir = tempDir('retry')
  const harness = createHarness()
  apply(harness.ctx, configFor(dir, { M1: { enabled: false } }))
  header(harness)
  await emitSession(harness.ctx, harness.session, harness.event('assistant/attempt', {
    turn: 1, step: 1, stream: [{ chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } } }],
  }))
  await emitUsage(harness, { inputTokens: 150, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1, 1)
  harness.event('llm/retry-started', { turn: 2, step: 1 })
  await emitSession(harness.ctx, harness.session, harness.event('assistant/attempt', {
    turn: 2, step: 1, stream: [{ chunk: { type: 'usage', usage: { inputTokens: 200, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } } }],
  }))
  harness.ctx.dispose()

  const records = recordsOf(dir, harness.session.id)
  const calls = records.filter((record) => record.kind === 'llm_call')
  assert.equal(calls.length, 3, 'attempt delta + settlement delta + retried attempt')
  const summary = summarizeRecords(records, harness.session.id)
  assert.equal(summary.tokens.uncachedInput, 350)
  assert.equal(summary.tokens.output, 25)
  // 350*2/1e6 + 25*8/1e6 = 0.0007 + 0.0002
  assert.ok(Math.abs(summary.cost - 0.0009) < 1e-12, 'cost ' + summary.cost)
  assert.equal(summary.currency, 'CNY')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// v1 audit: tokenUsage reconciliation records a guard alert on mismatch
// ---------------------------------------------------------------------------

test('acceptance-v1: turn-end tokenUsage reconciliation records a mismatch alert', async () => {
  const dir = tempDir('audit')
  const projections = new MockProjectionRegistry()
  projections.register({
    key: 'tokenUsage',
    stateVersion: 1,
    init: () => ({ uncachedInputTokens: 5000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    apply: (state) => state,
    wire: { viewSchema: { parse: (value) => value }, view: (state) => state },
  })
  const harness = createHarness({ services: { sessionProjections: projections } })
  apply(harness.ctx, configFor(dir))
  header(harness)
  await emitUsage(harness, { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  await emitSession(harness.ctx, harness.session, harness.event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  harness.ctx.dispose()

  const summary = summarizeRecords(recordsOf(dir, harness.session.id), harness.session.id)
  assert.equal(summary.metrics.count, 1)
  assert.match(String(summary.metrics.lastReason), /token-usage-mismatch/)
  fs.rmSync(dir, { recursive: true, force: true })
})