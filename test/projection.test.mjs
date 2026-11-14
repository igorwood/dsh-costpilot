import test from 'node:test'
import assert from 'node:assert/strict'
import { createCostProjectionDefinition, applyCostProjection, initCostState } from '../lib/projection.js'

const pricing = { deepseek: { 'deepseek-chat': { uncachedInput: 1, cacheWrite: 2, cacheRead: 0.1, output: 10 } } }

function ev(seq, type, data) { return { seq, time: 1000 + seq, type, data } }

function fold(events, definition) {
  let state = definition.init()
  for (const event of events) state = definition.apply(state, event)
  return definition.wire.view(state)
}

function definition(overrides = {}) {
  return createCostProjectionDefinition({ mode: 'assist', modules: { M1: { enabled: true }, M9: { enabled: true } }, pricing, ...overrides })
}

test('projection: folds route + usage into USD and token buckets', () => {
  const def = definition()
  const view = fold([
    ev(0, 'request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial', startsSeries: true }),
    ev(1, 'assistant/message', { turn: 1, step: 1, message: {}, stream: [], usage: { inputTokens: 1000, cacheReadTokens: 8000, cacheWriteTokens: 1000, outputTokens: 500 } }),
  ], def)
  assert.equal(view.calls, 1)
  assert.equal(view.usd, 0.0088)
  assert.deepEqual(view.tokens, { uncachedInput: 1000, cacheRead: 8000, cacheWrite: 1000, output: 500 })
  assert.equal(view.route.model, 'deepseek-chat')
  assert.equal(view.mode, 'assist')
  assert.equal(view.m1Enabled, true)
  assert.equal(view.m9Enabled, true)
})

test('projection: M1 marker in tool/result accumulates savings', () => {
  const def = definition()
  const view = fold([
    ev(0, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'short\n\n[costpilot:m1 removed_tokens=1200 added_tokens=80 pointers=2]' }] } }),
    ev(1, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'x\n\n[costpilot:m1 removed_tokens=300 added_tokens=10 pointers=0]' }] } }),
  ], def)
  assert.deepEqual(view.m1, { removedTokens: 1500, addedTokens: 90, ops: 2 })
})

test('projection: guard marker in costpilot user/message is counted', () => {
  const def = definition()
  const view = fold([
    ev(0, 'user/message', { content: [{ type: 'text', text: '[costpilot:guard action=warn reason=budget-warning] slow down' }], source: { kind: 'costpilot' } }),
    ev(1, 'user/message', { content: [{ type: 'text', text: 'ordinary user message' }], source: { kind: 'user' } }),
  ], def)
  assert.equal(view.guard.count, 1)
  assert.equal(view.guard.lastReason, 'budget-warning')
})

test('projection: unknown price keeps tokens and marks confidence unknown', () => {
  const def = definition({ pricing: {} })
  const view = fold([
    ev(0, 'request/header', { header: { config: { provider: 'nope', model: 'unknown' } } }),
    ev(1, 'assistant/message', { turn: 1, step: 1, message: {}, stream: [], usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 } }),
  ], def)
  assert.equal(view.usd, 0)
  assert.equal(view.confidence, 'unknown')
  assert.equal(view.tokens.uncachedInput, 100)
})

test('projection: replay is idempotent per seq and ignores unknown events', () => {
  const def = definition()
  let state = initCostState()
  const header = ev(0, 'request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } } })
  const usage = ev(1, 'assistant/message', { turn: 1, step: 1, message: {}, stream: [], usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 } })
  state = applyCostProjection(state, header, { pricing })
  state = applyCostProjection(state, usage, { pricing })
  const once = state.usd
  state = applyCostProjection(state, usage, { pricing })
  assert.equal(state.usd, once, 'duplicate seq must not double count')
  state = applyCostProjection(state, ev(2, 'turn/start', { turn: 1 }), { pricing })
  assert.equal(state.usd, once)
})

test('projection: identity schemas let the registry parse state and view', () => {
  const def = definition()
  const state = def.apply(def.init(), ev(0, 'request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-chat' } } }))
  assert.doesNotThrow(() => def.stateSchema.parse(state))
  assert.doesNotThrow(() => def.wire.viewSchema.parse(def.wire.view(state)))
})