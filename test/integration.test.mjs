import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { createHarness, emitSession, emitSessionWithProjections, runPostExecute, runPreStep, MockProjectionRegistry } from './mock-ctx.mjs'
import { readSessionRecords, summarizeRecords } from '../lib/sim.js'

const PRICE = { provider: 'deepseek', model: 'deepseek-chat' }

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'costpilot-' + label + '-'))
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

function configFor(dir, overrides = {}) {
  return {
    dataDir: dir,
    mode: 'observe',
    usageSemantics: 'exclusive',
    pricing: { deepseek: { 'deepseek-chat': { uncachedInput: 1, cacheWrite: 2, cacheRead: 0.1, output: 10 } } },
    budgets: { sessionUSD: 100, warnAtPct: 80, hardStopAtPct: 120 },
    modules: {
      M1: { enabled: true, mode: 'assist', minDeltaTokens: 100, sideStore: true },
      M9: { enabled: true, mode: 'assist', maxSteps: 160, maxToolCalls: 400, maxTurnCostUSD: 100, noProgressSteps: 99, warnOncePerSession: true, hardStop: false, keepInbox: true },
    },
    ...overrides,
  }
}

function headerEvent(harness) {
  return harness.event('request/header', {
    header: { config: { provider: PRICE.provider, model: PRICE.model } },
    reason: 'initial',
    startsSeries: true,
  })
}

function assistantEvent(harness, turn, step, usage, extra = {}) {
  return harness.event('assistant/message', {
    turn, step,
    message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    stream: [],
    usage,
    ...extra,
  })
}

test('integration: ledger records provider usage and exact USD', async () => {
  const dir = tempDir('ledger')
  const harness = createHarness()
  apply(harness.ctx, configFor(dir))

  harness.event('turn/start', { turn: 1 })
  headerEvent(harness)
  harness.event('step/start', { turn: 1, step: 1 })
  await emitSession(harness.ctx, harness.session, assistantEvent(harness, 1, 1, {
    inputTokens: 1000, cacheReadTokens: 8000, cacheWriteTokens: 1000, outputTokens: 500,
  }))
  harness.event('turn/end', { turn: 1, reason: 'completed' })
  harness.ctx.dispose()

  const records = readSessionRecords(path.join(dir, 'sessions'), 'sess-1')
  const summary = summarizeRecords(records, 'sess-1')
  // uncached=1000*1e-6*1 + write=1000*2e-6 + read=8000*0.1e-6 + out=500*10e-6
  const expected = 0.001 + 0.002 + 0.0008 + 0.005
  assert.equal(summary.counts.calls, 1)
  assert.ok(Math.abs(summary.usd - expected) < 1e-9, 'usd ' + summary.usd + ' != ' + expected)
  assert.equal(summary.tokens.cacheRead, 8000)
  assert.equal(summary.tokens.cacheWrite, 1000)
  assert.equal(summary.tokens.uncachedInput, 1000)
  assert.equal(summary.tokens.output, 500)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('integration: M1 compresses oversized tool output and keeps a side-store original', async () => {
  const dir = tempDir('m1')
  const projections = new MockProjectionRegistry()
  const harness = createHarness({ services: { sessionProjections: projections } })
  apply(harness.ctx, configFor(dir))
  const sessionId = harness.session.id

  const original = bigLog(240)
  const exec = { name: 'bash', callId: 'c2', agent: harness.agent, arguments: '{"cmd":"cat log"}' }
  const result = { content: [{ type: 'text', text: original }], isError: false }
  const decision = await runPostExecute(harness.ctx, exec, result)
  assert.equal(decision.kind, 'accept')
  const text = decision.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
  assert.ok(text.length < original.length, 'compressed output should be shorter')
  assert.ok(text.includes('ERROR'), 'error lines must be retained')
  assert.ok(text.includes('costpilot'), 'compressed output should carry a costpilot marker')

  const sidePath = path.join(dir, 'originals', sessionId, 'c2.txt')
  assert.ok(fs.existsSync(sidePath), 'side-store original written at ' + sidePath)
  assert.equal(fs.readFileSync(sidePath, 'utf8'), original)

  await emitSessionWithProjections(harness.ctx, projections, harness.session, harness.event('tool/call', {
    turn: 1, step: 1, callId: 'c2', name: 'bash', arguments: '{"cmd":"cat log"}',
  }))
  await emitSessionWithProjections(harness.ctx, projections, harness.session, harness.event('tool/result', {
    turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text }] },
  }))
  harness.ctx.dispose()

  const summary = summarizeRecords(readSessionRecords(path.join(dir, 'sessions'), sessionId), sessionId)
  assert.ok(summary.byModule.M1, 'M1 mutation recorded')
  assert.ok(summary.byModule.M1.removedTokens > 0)
  assert.equal(summary.counts.tools, 1)

  // UI projection folds the committed marker: the dock shows the same effect.
  const view = projections.view(harness.session, 'costpilot')
  assert.ok(view, 'costpilot projection registered')
  assert.equal(view.m1.ops, 1)
  assert.equal(view.m1.removedTokens, summary.byModule.M1.removedTokens)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('integration: M9 warns over budget via steer and records a guard event', async () => {
  const dir = tempDir('m9')
  const harness = createHarness()
  const config = configFor(dir)
  config.budgets = { sessionUSD: 0.001, warnAtPct: 1, hardStopAtPct: 500 }
  apply(harness.ctx, config)

  harness.event('turn/start', { turn: 1 })
  headerEvent(harness)
  harness.event('step/start', { turn: 1, step: 1 })
  await emitSession(harness.ctx, harness.session, assistantEvent(harness, 1, 1, {
    inputTokens: 10000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500,
  }))
  harness.event('turn/end', { turn: 1, reason: 'completed' })

  const payload = { agent: harness.agent, messages: [], turn: 2, step: 1, signal: {}, modelSelection: { provider: PRICE.provider, model: PRICE.model } }
  const decision = await runPreStep(harness.ctx, payload)
  assert.equal(decision.kind, 'enter')
  assert.equal(harness.agent.steered.length, 1, 'one steer message expected')
  assert.match(harness.agent.steered[0].content[0].text, /budget/i)
  harness.ctx.dispose()

  const summary = summarizeRecords(readSessionRecords(path.join(dir, 'sessions'), harness.session.id), harness.session.id)
  assert.equal(summary.guard.count, 1)
  assert.match(summary.guard.lastReason, /budget/i)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('integration: /cost command renders a summary after usage', async () => {
  const dir = tempDir('cmd')
  const harness = createHarness()
  apply(harness.ctx, configFor(dir))
  headerEvent(harness)
  await emitSession(harness.ctx, harness.session, assistantEvent(harness, 1, 1, {
    inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100,
  }))
  const result = await harness.commands.execute('cost', { agent: harness.agent, rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /¥/)
  assert.match(result.text, /sess-1/)
  harness.ctx.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('integration: observe mode records but does not compress', async () => {
  const dir = tempDir('observe')
  const harness = createHarness()
  const config = configFor(dir)
  config.modules.M1 = { enabled: true, mode: 'observe', minDeltaTokens: 100, sideStore: true }
  apply(harness.ctx, config)
  const original = bigLog(240)
  const result = { content: [{ type: 'text', text: original }], isError: false }
  const decision = await runPostExecute(harness.ctx,
    { name: 'bash', callId: 'c9', agent: harness.agent }, result)
  assert.equal(decision.kind, 'accept')
  const content = decision.content ?? result.content
  const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('')
  assert.equal(text, original, 'observe mode must not mutate')
  harness.ctx.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})