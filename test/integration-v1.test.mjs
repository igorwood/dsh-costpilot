import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { createHarness, emitSession, runPostExecute, runPreStep } from './mock-ctx.mjs'

const PRICE = { deepseek: { 'deepseek-chat': { uncachedInput: 2, cacheWrite: 2, cacheRead: 0.5, output: 8 } } }

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'costpilot-v1-' + label + '-'))
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
    header: { config: { provider: 'deepseek', model: 'deepseek-chat' } },
    reason: 'initial',
    startsSeries: true,
  })
}

async function priceRoute(harness, usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }) {
  header(harness)
  await emitSession(harness.ctx, harness.session, harness.event('assistant/message', {
    turn: 1, step: 1, message: {}, stream: [], usage,
  }))
}

test('v1 M5: pre-step injects a batching nudge when enabled', async () => {
  const dir = tempDir('m5')
  const harness = createHarness()
  apply(harness.ctx, configFor(dir, { M5: { enabled: true, maxInjections: 3, firstTurns: 5 } }))
  const payload = { agent: harness.agent, messages: [], turn: 1, step: 1, signal: {}, modelSelection: {} }
  await runPreStep(harness.ctx, payload)
  assert.equal(harness.agent.steered.length, 1)
  assert.match(harness.agent.steered[0].content[0].text, /batch/i)
  harness.ctx.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('v1 M6: pre-step restricts candidate tools with large schemas', async () => {
  const dir = tempDir('m6')
  const harness = createHarness()
  const bigParameters = { type: 'object', properties: Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['field' + i, { type: 'string', description: 'description '.repeat(8) }])) }
  for (const name of ['bash', 'read', 'web_search', 'office']) {
    harness.tools.register({ name, description: 'tool ' + name + ' ' + 'x'.repeat(200), parameters: bigParameters, output: { schema: { type: 'object' }, render: () => [] }, execute: async () => ({}) })
  }
  apply(harness.ctx, configFor(dir, { M6: { enabled: true, maxSwitches: 3, minRemainingSteps: 6, keep: ['bash', 'read'], hideCandidates: ['web_search', 'office'] } }))
  // establish phase=search
  await emitSession(harness.ctx, harness.session, harness.event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'glob', arguments: '{}' }))
  const payload = { agent: harness.agent, messages: [], turn: 1, step: 3, signal: {}, modelSelection: {} }
  await runPreStep(harness.ctx, payload)
  const denied = harness.tools.denied()
  assert.ok(denied.length > 0, 'some tools should be restricted')
  assert.ok(denied.includes('web_search') || denied.includes('office'))
  assert.ok(!denied.includes('bash'))
  harness.ctx.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('v1 M7: turn-stopping selects the cheap route for search/read phases', async () => {
  const dir = tempDir('m7')
  const harness = createHarness()
  apply(harness.ctx, configFor(dir, { M7: { enabled: true, routeDown: { provider: 'deepseek-account', model: 'deepseek-flash' }, phases: ['search', 'read'], minRemainingSteps: 10, maxSwitches: 2 } }))
  await priceRoute(harness)
  await emitSession(harness.ctx, harness.session, harness.event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'grep', arguments: '{}' }))
  await harness.ctx.emit('agent/turn-stopping', { agent: harness.agent, turn: 1, signal: {} })
  assert.equal(harness.agent.modelSelections.length, 1)
  assert.deepEqual(harness.agent.modelSelections[0], { provider: 'deepseek-account', model: 'deepseek-flash' })
  harness.ctx.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('v1 M8: deny level blocks an identical repeated read-only call', async () => {
  const dir = tempDir('m8')
  const harness = createHarness()
  apply(harness.ctx, configFor(dir, { M8: { enabled: true, level: 'deny', allowTools: ['read'], ttlSeconds: 600 } }))
  const exec = { name: 'read', arguments: '{"file_path":"a.txt"}', callId: 'r1', agent: harness.agent }
  const first = await harness.ctx.waterfall('tools/pre-execute', [exec], async () => ({ kind: 'allow' }))
  assert.equal(first.kind, 'allow')
  // pipeline settles the read result
  await harness.ctx.waterfall('tools/post-execute', [exec, { content: [{ type: 'text', text: 'file body' }], isError: false }], async () => ({ kind: 'accept' }))
  const exec2 = { name: 'read', arguments: '{"file_path":"a.txt"}', callId: 'r2', agent: harness.agent }
  const second = await harness.ctx.waterfall('tools/pre-execute', [exec2], async () => ({ kind: 'allow' }))
  assert.equal(second.kind, 'deny')
  assert.match(second.reason, /seq|reuse|already/i)
  harness.ctx.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})


test('v1 M2: pre-step compacts an old region through the compaction event protocol', async () => {
  const dir = tempDir('m2')
  const harness = createHarness()
  apply(harness.ctx, configFor(dir, {
    M2: { enabled: true, allowWithBuiltinCompaction: true, tauLineReuse: 0.9, maxRegionRatio: 0.6, minRemainingSteps: 6 },
  }))
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
  const payload = { agent: harness.agent, messages: [], turn: 2, step: 2, signal: {}, modelSelection: {} }
  await runPreStep(harness.ctx, payload)
  const types = harness.session.appended.map((event) => event.type)
  assert.ok(types.includes('compaction/start'), 'compaction started: ' + types.join(','))
  assert.ok(types.includes('compaction/summary'))
  const replacement = harness.session.appended.find((event) => event.type === 'user/message' && event.surfaceOp)
  assert.ok(replacement, 'surface replace recorded')
  assert.equal(replacement.surfaceOp.op, 'replace')
  harness.ctx.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('v1 M2/M3: disabled or builtin-compaction-gated modules do not write compaction events', async () => {
  const dir = tempDir('m2-off')
  const harness = createHarness()
  harness.event('system/message', { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'system prompt' }] } })
  for (let step = 1; step <= 8; step++) {
    harness.event('assistant/message', { turn: 1, step, message: { id: 'a' + step, role: 'assistant', content: [{ type: 'tool-call', callId: 'c' + step, name: 'read', arguments: '{}' }] }, stream: [] })
    harness.event('tool/result', { turn: 1, step, message: { id: 'r' + step, role: 'tool', toolCallId: 'c' + step, content: [{ type: 'text', text: 'output '.repeat(100) }] } })
  }
  apply(harness.ctx, configFor(dir, { M2: { enabled: false }, M3: { enabled: false } }))
  await runPreStep(harness.ctx, { agent: harness.agent, messages: [], turn: 2, step: 2, signal: {}, modelSelection: {} })
  assert.ok(!harness.session.appended.some((event) => event.type === 'compaction/start'))
  harness.ctx.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('v1 M4: index_query tool builds and reuses a workspace index across sessions', async () => {
  const workspace = tempDir('m4-workspace')
  const dbDir = tempDir('m4-db')
  fs.writeFileSync(path.join(workspace, 'alpha.ts'), 'export function alphaOne() {\n  return 1\n}\n')
  fs.writeFileSync(path.join(workspace, 'beta.py'), 'def beta_two():\n    return 2\n')
  fs.mkdirSync(path.join(workspace, '.git'), { recursive: true })
  fs.writeFileSync(path.join(workspace, '.git', 'secret.ts'), 'export const hidden = 1\n')

  const harness = createHarness()
  harness.session.header = { cwd: workspace }
  apply(harness.ctx, configFor(dbDir, { M4: { enabled: true, indexPath: '.dsh-costpilot/index.db', maxFiles: 100, maxRows: 50, exclude: [], ignoreDirs: ['.git'], maxFileBytes: 100000 } }))
  const tool = harness.tools.get('index_query')
  assert.ok(tool, 'index_query registered')
  const result = await tool.execute({ sql: 'SELECT path, language FROM files ORDER BY path' }, { agent: harness.agent })
  assert.match(result.text, /alpha\.ts/)
  assert.match(result.text, /beta\.py/)
  assert.ok(!result.text.includes('secret.ts'), 'ignored directories stay out')
  assert.ok(fs.existsSync(path.join(workspace, '.dsh-costpilot', 'index.db')), 'db stored under the workspace root')

  // Second session in the same workspace reuses the same db.
  const second = createHarness({ sessionId: 'sess-2' })
  second.session.header = { cwd: workspace }
  apply(second.ctx, configFor(dbDir, { M4: { enabled: true, indexPath: '.dsh-costpilot/index.db', maxFiles: 100, maxRows: 50, exclude: [], ignoreDirs: ['.git'], maxFileBytes: 100000 } }))
  const tool2 = second.tools.get('index_query')
  const result2 = await tool2.execute({ sql: 'SELECT count(*) AS n FROM files' }, { agent: second.agent })
  assert.match(result2.text, /\b2\b/)
  harness.ctx.dispose()
  second.ctx.dispose()
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.rmSync(dbDir, { recursive: true, force: true })
})

test('v1 commands: /costpilot status/on/off/simulate', async () => {
  const dir = tempDir('cmds')
  const harness = createHarness()
  apply(harness.ctx, configFor(dir))
  await priceRoute(harness)
  const status = await harness.commands.execute('costpilot', { agent: harness.agent, rawInput: 'status' })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /M1/)
  assert.match(status.text, /mode=/)
  const on = await harness.commands.execute('costpilot', { agent: harness.agent, rawInput: 'on M4' })
  assert.match(on.text, /M4/)
  const simulate = await harness.commands.execute('costpilot', { agent: harness.agent, rawInput: 'simulate' })
  assert.equal(simulate.kind, 'success')
  assert.match(simulate.text, /simulate|total/i)
  harness.ctx.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})
test('v1 M9: hard stop requires consecutive breaches; spawn/quota/workspace signals warn', async () => {
  const dir = tempDir('m9-ext')
  const harness = createHarness()
  apply(harness.ctx, configFor(dir, {
    M9: { enabled: true, mode: 'assist', hardStop: true, hardStopSteps: 2, maxSteps: 160, maxToolCalls: 400, maxTurnCostUSD: 100, noProgressSteps: 99, subagentLimit: 1, toolQuotas: { web_search: 1 }, warnOncePerSession: false },
  }, { budgets: { sessionUSD: 0.01, warnAtPct: 50, hardStopAtPct: 100 } }))
  header(harness)
  await emitSession(harness.ctx, harness.session, harness.event('assistant/message', {
    turn: 1, step: 1, message: {}, stream: [], usage: { inputTokens: 10000, outputTokens: 0 },
  }))
  // first breach: hardStopSteps default 2 -> no stop yet
  const first = await runPreStep(harness.ctx, { agent: harness.agent, messages: [], turn: 1, step: 2, signal: {}, modelSelection: {} })
  assert.equal(first.kind, 'enter')
  assert.equal(harness.agent.canceled.length, 0)
  // second breach: now it may stop
  const second = await runPreStep(harness.ctx, { agent: harness.agent, messages: [], turn: 1, step: 3, signal: {}, modelSelection: {} })
  assert.equal(second.kind, 'reject')
  assert.equal(harness.agent.canceled.length, 1)
  harness.ctx.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('v1 M9: spawn limit is tracked from tool calls', async () => {
  const dir = tempDir('m9-spawn')
  const harness = createHarness()
  apply(harness.ctx, configFor(dir, {
    M9: { enabled: true, mode: 'assist', subagentLimit: 1, warnOncePerSession: false, noProgressSteps: 99, maxSteps: 160, maxToolCalls: 400, maxTurnCostUSD: 100, hardStop: false },
  }))
  for (const callId of ['c1', 'c2']) {
    await emitSession(harness.ctx, harness.session, harness.event('tool/call', { turn: 1, step: 1, callId, name: 'subagent', arguments: '{}' }))
  }
  await runPreStep(harness.ctx, { agent: harness.agent, messages: [], turn: 1, step: 2, signal: {}, modelSelection: {} })
  assert.equal(harness.agent.steered.length, 1)
  assert.match(harness.agent.steered[0].content[0].text, /max-spawns|spawn/i)
  harness.ctx.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})