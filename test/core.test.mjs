/**
 * Unit tests for dsh-costpilot core modules:
 * pricing / estimate / store / ledger / oracle.
 *
 * Run: node --test test/core.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolvePrice, costOfUsage, roundUSD } from '../lib/pricing.js'
import {
  estimateTokens,
  estimateJsonTokens,
  estimateMessage,
  estimateToolResult,
  estimateToolSchema,
  estimateRemainingSteps,
} from '../lib/estimate.js'
import { createStore, MAX_RECORD_BYTES } from '../lib/store.js'
import { createLedger } from '../lib/ledger.js'
import { cacheState, savingsForRemoval, shouldApply } from '../lib/oracle.js'
import { hashKey, normalizeUsage } from '../lib/contracts.js'
import { resolveConfig } from '../lib/config.js'

// Ledger tests pin the inclusive semantics explicitly; the shipped default is
// 'exclusive' because DSH normalizes inputTokens to the uncached prompt size.
const CONFIG = resolveConfig({
  usageSemantics: 'inclusive',
  // Pin the test price table (USD-style numbers) so the arithmetic does not move
  // when the shipped default changes currency/rates.
  pricing: { deepseek: { 'deepseek-chat': { uncachedInput: 0.27, cacheWrite: 0.27, cacheRead: 0.07, output: 1.10 } } },
})

test('config: shipped default usageSemantics matches DSH normalization (exclusive)', () => {
  assert.equal(resolveConfig({}).usageSemantics, 'exclusive')
  assert.equal(normalizeUsage({ inputTokens: 1000, cacheReadTokens: 8000 }, 'exclusive').uncachedInput, 1000)
  assert.equal(normalizeUsage({ inputTokens: 1000, cacheReadTokens: 8000 }, 'inclusive').uncachedInput, 0)
})
const T0 = 1700000000000
const DEEPSEEK_ROUTE = { provider: 'deepseek', model: 'deepseek-chat' }
const DEEPSEEK_PRICE = resolvePrice(CONFIG, DEEPSEEK_ROUTE)

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'costpilot-core-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function sessionEvent(type, data, seq, time = T0 + seq * 1000) {
  return { type, seq, time, data }
}

// ---------------------------------------------------------------- pricing

test('pricing: exact route resolves from config with cache-write premium semantics', () => {
  const price = resolvePrice(CONFIG, DEEPSEEK_ROUTE)
  assert.deepEqual(price, {
    uncachedInput: 0.27,
    cacheWrite: 0.27,
    cacheRead: 0.07,
    output: 1.1,
    writePremium: false,
    source: 'config',
  })
  const anthropic = resolvePrice(CONFIG, { provider: 'anthropic', model: 'claude-sonnet-5.5' })
  assert.equal(anthropic.cacheWrite, 2.75)
  assert.equal(anthropic.writePremium, true)
  assert.equal(anthropic.source, 'config')
  // A raw pricing table is accepted as well as the full resolved config.
  assert.deepEqual(resolvePrice(CONFIG.pricing, DEEPSEEK_ROUTE), price)
})

test('pricing: unknown route yields source unknown and never claims USD', () => {
  const price = resolvePrice(CONFIG, { provider: 'acme', model: 'mystery' })
  assert.equal(price.source, 'unknown')
  assert.equal(price.uncachedInput, 0)
  assert.equal(price.cacheWrite, 0)
  const result = costOfUsage(price, { inputTokens: 1000, outputTokens: 100 })
  assert.equal(result.usd, 0)
  assert.deepEqual(result.breakdown, { read: 0, write: 0, uncached: 0, output: 0, total: 0 })
  assert.equal(resolvePrice(CONFIG, null).source, 'unknown')
  assert.equal(resolvePrice(CONFIG, { provider: 'deepseek' }).source, 'unknown')
})

test('pricing: cacheWrite fallback plus wildcard, provider-default and global-default tiers', () => {
  const config = {
    pricing: {
      deepseek: { 'deepseek-lite': { uncachedInput: 0.2, cacheRead: 0.05, output: 0.8 } },
      openai: {
        'gpt-6-*': { uncachedInput: 0.11, cacheWrite: 0.1375, cacheRead: 0.011, output: 0.55 },
        'gpt-5': { uncachedInput: 0.2, cacheRead: 0.02, output: 1.0 },
        default: { uncachedInput: 0.3, cacheRead: 0.03, output: 1.5 },
      },
      default: { uncachedInput: 0.5, cacheRead: 0.05, output: 2.0 },
    },
  }
  const lite = resolvePrice(config, { provider: 'deepseek', model: 'deepseek-lite' })
  assert.equal(lite.cacheWrite, 0.2)
  assert.equal(lite.writePremium, false)
  assert.equal(lite.source, 'config')

  const wildcard = resolvePrice(config, { provider: 'openai', model: 'gpt-6-luna' })
  assert.equal(wildcard.uncachedInput, 0.11)
  assert.equal(wildcard.cacheWrite, 0.1375)
  assert.equal(wildcard.source, 'config')

  const providerDefault = resolvePrice(config, { provider: 'openai', model: 'gpt-5-mini' })
  assert.equal(providerDefault.uncachedInput, 0.3)

  const globalDefault = resolvePrice(config, { provider: 'acme', model: 'mystery' })
  assert.equal(globalDefault.uncachedInput, 0.5)
  assert.equal(globalDefault.source, 'default')
})

test('pricing: inclusive usage subtracts cache buckets before pricing', () => {
  const result = costOfUsage(DEEPSEEK_PRICE, {
    inputTokens: 1000,
    cacheReadTokens: 400,
    cacheWriteTokens: 100,
    outputTokens: 200,
  })
  // 500*0.27 + 100*0.27 + 400*0.07 + 200*1.10 = 410 -> 0.00041
  assert.equal(result.usd, 0.00041)
  assert.deepEqual(result.breakdown, {
    read: 0.000028,
    write: 0.000027,
    uncached: 0.000135,
    output: 0.00022,
    total: 0.00041,
  })
})

test('pricing: exclusive usage maps inputTokens directly to uncached input', () => {
  const inclusive = costOfUsage(DEEPSEEK_PRICE, {
    inputTokens: 1000,
    cacheReadTokens: 400,
    cacheWriteTokens: 100,
    outputTokens: 200,
  }, 'inclusive')
  const exclusive = costOfUsage(DEEPSEEK_PRICE, {
    inputTokens: 500,
    cacheReadTokens: 400,
    cacheWriteTokens: 100,
    outputTokens: 200,
  }, 'exclusive')
  assert.equal(exclusive.usd, inclusive.usd)
  assert.equal(exclusive.breakdown.uncached, 0.000135)
})

// --------------------------------------------------------------- estimate

test('estimate: 4 chars/token for ASCII and CJK floors for wide characters', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens(null), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('a'.repeat(400)), 100)
  assert.equal(estimateTokens('汉'.repeat(10)), 10)
  assert.ok(estimateTokens('汉字abc') > estimateTokens('abc'))
})

test('estimate: JSON structural punctuation raises the conservative floor', () => {
  const value = { a: 1, list: [true, null, 'hello'] }
  const serialized = JSON.stringify(value)
  assert.ok(estimateJsonTokens(value) > estimateTokens(serialized))
  assert.equal(estimateJsonTokens(''), 0)
  assert.ok(estimateJsonTokens({ a: 'b' }) >= 1)
})

test('estimate: message estimation adds role and envelope overhead', () => {
  const message = { role: 'user', content: 'hello world' }
  assert.equal(estimateMessage(message), 8)
  const textOnly = estimateMessage({ role: 'assistant', content: [{ type: 'text', text: 'hello' }] })
  const withBlocks = estimateMessage({
    role: 'assistant',
    content: [
      { type: 'text', text: 'hello' },
      { type: 'json', value: { a: 1 } },
      { type: 'image', data: 'x' },
    ],
  })
  assert.ok(withBlocks > textOnly)
})

test('estimate: tool results accept strings, blocks and message-like objects', () => {
  assert.equal(estimateToolResult(undefined), 0)
  assert.equal(estimateToolResult('abcd'), 5)
  assert.equal(estimateToolResult([{ type: 'text', text: 'x'.repeat(400) }]), 104)
  const wrapped = estimateToolResult({ role: 'tool', toolCallId: 'c1', content: [{ type: 'json', value: { ok: true } }] })
  assert.ok(wrapped > 4)
})

test('estimate: tool schema grows with description and parameters', () => {
  const small = estimateToolSchema({ name: 'read', description: 'read a file', parameters: { type: 'object' } })
  const large = estimateToolSchema({
    name: 'read',
    description: 'read a file '.repeat(50),
    parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' } } },
  })
  assert.ok(small > 0)
  assert.ok(large > small)
  assert.equal(estimateToolSchema(null), 0)
})

test('estimate: remaining steps is deterministic, bounded and responds to pressure', () => {
  const first = estimateRemainingSteps({ turn: 1, step: 1, toolCalls: 0, contextTokens: 0 })
  const second = estimateRemainingSteps({ turn: 1, step: 1, toolCalls: 0, contextTokens: 0 })
  assert.equal(first, second)
  assert.ok(Number.isInteger(first) && first >= 1 && first <= 16)

  const earlyBigContext = estimateRemainingSteps({ turn: 1, step: 1, toolCalls: 0, contextTokens: 400000 })
  const earlySmallContext = estimateRemainingSteps({ turn: 1, step: 1, toolCalls: 0, contextTokens: 0 })
  assert.ok(earlyBigContext > earlySmallContext)

  const late = estimateRemainingSteps({ turn: 20, step: 80, toolCalls: 200, contextTokens: 0 })
  assert.ok(late < earlySmallContext)

  for (const value of [0, 1, 5, 100, -3, Number.NaN]) {
    const estimate = estimateRemainingSteps({ turn: value, step: value, toolCalls: value, contextTokens: value })
    assert.ok(Number.isInteger(estimate) && estimate >= 1 && estimate <= 16)
  }
})

// ------------------------------------------------------------------ store

test('store: NDJSON append/read roundtrip, session listing and flush', (t) => {
  const store = createStore({ dir: tmpDir(t) })
  const records = [
    { v: 1, kind: 'llm_call', sessionId: 's1', ts: 1, usd: 0.1, usage: { uncachedInput: 10 } },
    { v: 1, kind: 'llm_call', sessionId: 's1', ts: 2, usd: 0.2 },
  ]
  assert.deepEqual(store.append('s1', records[0]), records[0])
  store.append('s1', records[1])
  assert.deepEqual(store.readSession('s1'), records)
  assert.deepEqual(store.readSession('missing'), [])
  store.append('s2', { v: 1, kind: 'turn', sessionId: 's2', ts: 3 })
  assert.deepEqual(store.listSessions(), ['s1', 's2'])
  assert.equal(store.flush(), true)
})

test('store: meta writes are merged and atomic, leaving no tmp files', (t) => {
  const dir = tmpDir(t)
  const store = createStore({ dir })
  assert.deepEqual(store.writeMeta({ version: 1, config: { mode: 'observe' } }), {
    version: 1,
    config: { mode: 'observe' },
  })
  const merged = store.writeMeta({ config: { mode: 'assist' } })
  assert.deepEqual(merged, { version: 1, config: { mode: 'assist' } })
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
  assert.deepEqual(meta, { version: 1, config: { mode: 'assist' } })
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), [])
})

test('store: oversized records truncate extra, mark the record and stay bounded', (t) => {
  const dir = tmpDir(t)
  const store = createStore({ dir })
  const big = { v: 1, kind: 'tool_result', sessionId: 'big', ts: 1, extra: { blob: 'x'.repeat(300 * 1024) } }
  const written = store.append('big', big)
  assert.equal(written.truncated, true)
  assert.equal(written.extra.truncated, true)
  assert.ok(written.extra.originalBytes > MAX_RECORD_BYTES)

  const [back] = store.readSession('big')
  assert.equal(back.truncated, true)
  const text = fs.readFileSync(path.join(dir, 'big.jsonl'), 'utf8')
  assert.ok(Buffer.byteLength(text.trimEnd(), 'utf8') <= MAX_RECORD_BYTES)
})

// ----------------------------------------------------------------- ledger

test('ledger: request/header caches the route used by the following assistant/message', (t) => {
  const store = createStore({ dir: tmpDir(t) })
  const ledger = createLedger({ sessionId: 'sess-1', store, config: CONFIG })

  const headerRecords = ledger.sample({ id: 'sess-1' }, sessionEvent('request/header', {
    header: { config: DEEPSEEK_ROUTE },
    reason: 'initial',
    startsSeries: true,
  }, 0))
  assert.deepEqual(headerRecords, [])

  const records = ledger.sample({ id: 'sess-1' }, sessionEvent('assistant/message', {
    turn: 1,
    step: 0,
    message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 400, cacheWriteTokens: 100 },
    stream: [],
  }, 1))
  assert.equal(records.length, 1)
  const call = records[0]
  assert.equal(call.kind, 'llm_call')
  assert.deepEqual(call.route, DEEPSEEK_ROUTE)
  assert.equal(call.confidence, 'provider')
  assert.equal(call.usd, 0.00041)
  assert.equal(call.usage.uncachedInput, 500)
  assert.equal(call.usage.cacheRead, 400)
  assert.equal(call.usage.cacheWrite, 100)
  assert.equal(call.usage.output, 200)
  assert.equal(call.ts, T0 + 1000)
  assert.equal(call.turn, 1)
  assert.equal(call.step, 0)

  // Sync appends make every sampled record durable immediately.
  assert.equal(store.readSession('sess-1').length, 1)
  assert.equal(ledger.flush().persisted, true)
})

test('ledger: unknown route records tokens but not USD', (t) => {
  const store = createStore({ dir: tmpDir(t) })
  const ledger = createLedger({ sessionId: 'sess-unknown', store, config: CONFIG })
  ledger.sample({}, sessionEvent('request/header', {
    header: { config: { provider: 'acme', model: 'mystery' } },
    reason: 'initial',
    startsSeries: true,
  }, 0))
  const [call] = ledger.sample({}, sessionEvent('assistant/message', {
    turn: 1,
    step: 0,
    message: { role: 'assistant', content: [] },
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 400 },
    stream: [],
  }, 1))
  assert.equal(call.confidence, 'unknown')
  assert.equal(call.usd, 0)
  assert.equal(call.usage.uncachedInput, 600)
  assert.equal(call.usage.inputTokens, 1000)

  const summary = ledger.summary()
  assert.equal(summary.usd, 0)
  assert.deepEqual(summary.tokens, { uncachedInput: 600, cacheRead: 400, cacheWrite: 0, output: 200 })
  assert.equal(summary.counts.calls, 1)
})

test('ledger: assistant/message without provider usage falls back to heuristic estimates', (t) => {
  const store = createStore({ dir: tmpDir(t) })
  const ledger = createLedger({ sessionId: 'sess-heuristic', store, config: CONFIG })
  ledger.sample({}, sessionEvent('request/header', {
    header: { config: DEEPSEEK_ROUTE },
    reason: 'initial',
    startsSeries: true,
  }, 0))
  const message = { role: 'assistant', content: [{ type: 'text', text: 'hello world' }] }
  const [call] = ledger.sample({}, sessionEvent('assistant/message', { turn: 1, step: 0, message, stream: [] }, 1))
  assert.equal(call.confidence, 'heuristic')
  const expectedTokens = estimateMessage(message)
  assert.equal(call.usage.output, expectedTokens)
  assert.equal(call.usd, roundUSD(expectedTokens * 1.1 / 1e6))
})

test('ledger: full turn sequence, tool attribution and immediate persistence', (t) => {
  const dir = tmpDir(t)
  const store = createStore({ dir })
  const ledger = createLedger({ sessionId: 'sess-seq', store, config: CONFIG })
  const events = [
    ['turn/start', { turn: 1 }],
    ['step/start', { turn: 1, step: 0 }],
    ['request/header', { header: { config: { provider: 'openai', model: 'gpt-6-luna' } }, reason: 'initial', startsSeries: true }],
    ['assistant/message', {
      turn: 1,
      step: 0,
      message: { role: 'assistant', content: [] },
      usage: { inputTokens: 2000, outputTokens: 100, cacheReadTokens: 1000 },
      stream: [],
    }],
    ['tool/call', { turn: 1, step: 0, callId: 'c1', name: 'read', arguments: '{"path":"a.txt"}' }],
    ['tool/result', {
      turn: 1,
      step: 0,
      message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'x'.repeat(400) }] },
    }],
    ['step/end', { turn: 1, step: 0 }],
    ['turn/end', { turn: 1, reason: 'completed' }],
  ]
  const produced = []
  events.forEach(([type, data], index) => {
    produced.push(...ledger.sample({}, sessionEvent(type, data, index)))
  })
  assert.deepEqual(produced.map((record) => record.kind), [
    'turn', 'turn', 'llm_call', 'tool_call', 'tool_result', 'turn', 'turn',
  ])
  // Every sampled record is persisted synchronously, including turn/end.
  assert.equal(store.readSession('sess-seq').length, 7)

  const toolCall = produced.find((record) => record.kind === 'tool_call')
  assert.equal(toolCall.extra.name, 'read')
  assert.equal(toolCall.extra.argsHash, hashKey('{"path":"a.txt"}'))
  const toolResult = produced.find((record) => record.kind === 'tool_result')
  assert.equal(toolResult.extra.isError, false)
  assert.equal(toolResult.extra.estimatedTokens, 104)

  const selection = ledger.sample({}, sessionEvent('model/selection', { provider: 'openai', model: 'gpt-6-luna' }, 8))
  assert.equal(selection.length, 1)
  assert.equal(selection[0].kind, 'session')
  assert.equal(selection[0].extra.phase, 'model_selection')

  const summary = ledger.summary()
  assert.deepEqual(summary.counts, { calls: 1, turns: 1, steps: 1, tools: 1 })
  assert.deepEqual(summary.tokens, { uncachedInput: 1000, cacheRead: 1000, cacheWrite: 0, output: 100 })
  assert.equal(summary.usd, 0.000176)
})

test('ledger: summary reconciles with hand-computed USD and token buckets', (t) => {
  const store = createStore({ dir: tmpDir(t) })
  const ledger = createLedger({ sessionId: 'sess-sum', store, config: CONFIG })
  ledger.sample({}, sessionEvent('request/header', {
    header: { config: DEEPSEEK_ROUTE },
    reason: 'initial',
    startsSeries: true,
  }, 0))
  ledger.sample({}, sessionEvent('assistant/message', {
    turn: 1,
    step: 0,
    message: { role: 'assistant', content: [] },
    usage: { inputTokens: 1000, cacheReadTokens: 500, outputTokens: 100 },
    stream: [],
  }, 1))
  ledger.sample({}, sessionEvent('assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [] },
    usage: { inputTokens: 500, outputTokens: 50 },
    stream: [],
  }, 2))

  const summary = ledger.summary()
  // call 1: 500*0.27 + 500*0.07 + 100*1.10 = 135 + 35 + 110 = 280 -> 0.00028
  // call 2: 500*0.27 + 50*1.10 = 135 + 55 = 190 -> 0.00019
  assert.equal(summary.usd, 0.00047)
  assert.deepEqual(summary.tokens, { uncachedInput: 1000, cacheRead: 500, cacheWrite: 0, output: 150 })
  assert.equal(summary.counts.calls, 2)
  const eventUsd = ledger.events()
    .filter((event) => event.kind === 'llm_call')
    .reduce((total, event) => total + event.usd, 0)
  assert.equal(roundUSD(eventUsd), summary.usd)
})

test('ledger: recordMutation aggregates byModule and recordGuard records decisions', (t) => {
  const store = createStore({ dir: tmpDir(t) })
  const ledger = createLedger({ sessionId: 'sess-mut', store, config: CONFIG })
  ledger.noteRoute(DEEPSEEK_ROUTE)

  const first = ledger.recordMutation({
    module: 'M1',
    removedTokens: 2000,
    addedTokens: 200,
    pointer: 'originals/sess-mut/c1.txt',
    count: 2,
  })
  assert.equal(first.kind, 'mutation')
  assert.equal(first.extra.module, 'M1')
  assert.equal(first.usd, 0.000126)

  ledger.recordMutation({ module: 'M1', removedTokens: 1000, addedTokens: 0, count: 1 })
  const guard = ledger.recordGuard({ action: 'warn', reason: 'budget warn at 80%', spentUSD: 4.1 })
  assert.equal(guard.kind, 'guard')
  assert.equal(guard.extra.action, 'warn')
  assert.equal(guard.extra.spentUSD, 4.1)

  const summary = ledger.summary()
  assert.deepEqual(summary.byModule.M1, { usd: 0.000196, removedTokens: 3000, addedTokens: 200, count: 3 })
  assert.equal(summary.counts.calls, 0)
  assert.equal(store.readSession('sess-mut').length, 3)
  assert.equal(ledger.flush().persisted, true)
})

test('ledger: compaction/summary records shadowed tokens and its own LLM usage', (t) => {
  const store = createStore({ dir: tmpDir(t) })
  const ledger = createLedger({ sessionId: 'sess-compact', store, config: CONFIG })
  const records = ledger.sample({}, sessionEvent('compaction/summary', {
    shadowedTokenCount: 8000,
    provider: 'deepseek',
    model: 'deepseek-chat',
    usage: { inputTokens: 1000, outputTokens: 100 },
  }, 0))
  assert.equal(records.length, 2)
  const call = records.find((record) => record.kind === 'llm_call')
  assert.equal(call.extra.purpose, 'compaction')
  assert.equal(call.usd, 0.00038)
  const sessionRecord = records.find((record) => record.kind === 'session')
  assert.equal(sessionRecord.extra.phase, 'compaction')
  assert.equal(sessionRecord.extra.shadowedTokenCount, 8000)

  const summary = ledger.summary()
  assert.equal(summary.counts.calls, 1)
  assert.equal(summary.usd, 0.00038)
})

test('ledger: unknown event types are ignored without side effects', (t) => {
  const store = createStore({ dir: tmpDir(t) })
  const ledger = createLedger({ sessionId: 'sess-ignore', store, config: CONFIG })
  assert.deepEqual(ledger.sample({}, sessionEvent('user/message', { message: {} }, 0)), [])
  assert.deepEqual(ledger.events(), [])
  assert.deepEqual(ledger.sample(null, null), [])
})

// ----------------------------------------------------------------- oracle

test('oracle: cacheState honours startsSeries and the TTL boundary', () => {
  assert.equal(cacheState({ lastCallAt: 1000, now: 1000 + 60 * 1000, ttlSeconds: 120 }).warm, true)
  assert.equal(cacheState({ lastCallAt: 1000, now: 1000 + 121 * 1000, ttlSeconds: 120 }).warm, false)
  assert.equal(cacheState({ lastCallAt: 1000, now: 1001, startsSeries: true, ttlSeconds: 120 }).warm, false)
  assert.equal(cacheState({ lastCallAt: 1000, now: 200000 }).ttlSeconds, 120)
  assert.equal(cacheState({ lastCallAt: 1000, now: 200000 }).warm, false)
  assert.equal(cacheState({}).warm, false)
})

test('oracle: savings grow monotonically with the remaining call count', () => {
  const base = { price: DEEPSEEK_PRICE, deltaTokens: 1000, suffixTokens: 5000, llmUSD: 0.0001 }
  const n4 = savingsForRemoval({ ...base, remainingCalls: 4 })
  const n8 = savingsForRemoval({ ...base, remainingCalls: 8 })
  const n16 = savingsForRemoval({ ...base, remainingCalls: 16 })
  assert.ok(n8.netUSD > n4.netUSD)
  assert.ok(n16.netUSD > n8.netUSD)
  assert.ok(n8.readSavingsUSD > n4.readSavingsUSD)
})

test('oracle: suffix 0 removes rewrite cost and delta 0 never nets positive', () => {
  const appendOnly = savingsForRemoval({
    price: DEEPSEEK_PRICE,
    remainingCalls: 8,
    deltaTokens: 1000,
    suffixTokens: 0,
  })
  assert.equal(appendOnly.rewriteCostUSD, 0)
  const rewrite = savingsForRemoval({
    price: DEEPSEEK_PRICE,
    remainingCalls: 8,
    deltaTokens: 1000,
    suffixTokens: 5000,
  })
  assert.equal(rewrite.rewriteCostUSD, 0.001)
  const zeroDelta = savingsForRemoval({
    price: DEEPSEEK_PRICE,
    remainingCalls: 8,
    deltaTokens: 0,
    suffixTokens: 5000,
    llmUSD: 0.0001,
    extraTurnRisk: 0.2,
    extraTurnUSD: 0.001,
  })
  assert.equal(zeroDelta.readSavingsUSD, 0)
  assert.ok(zeroDelta.netUSD <= 0)
})

test('oracle: savingsForRemoval matches the appendix C formula', () => {
  const price = resolvePrice(CONFIG, { provider: 'anthropic', model: 'claude-sonnet-5.5' })
  const result = savingsForRemoval({
    price,
    remainingCalls: 10,
    deltaTokens: 2000,
    suffixTokens: 1000,
    llmUSD: 0.0002,
    extraTurnRisk: 0.1,
    extraTurnUSD: 0.001,
  })
  // read: 0.11*10*2000/1e6 = 0.0022; rewrite: (2.75-0.11)*1000/1e6 = 0.00264
  assert.equal(result.readSavingsUSD, 0.0022)
  assert.equal(result.rewriteCostUSD, 0.00264)
  assert.equal(result.netUSD, -0.00074)
  assert.ok(typeof result.formula === 'string')
  assert.ok(result.formula.includes('S = p_r*N*delta'))
})

test('oracle: shouldApply is strict about the minimum net savings', () => {
  assert.equal(shouldApply({ netUSD: 0.01 }), true)
  assert.equal(shouldApply({ netUSD: 0 }), false)
  assert.equal(shouldApply({ netUSD: 0.01, minNetUSD: 0.02 }), false)
  assert.equal(shouldApply({ netUSD: 0.03, minNetUSD: 0.02 }), true)
  assert.equal(shouldApply({}), false)
})
