import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLedger } from '../lib/ledger.js'
import { createStore } from '../lib/store.js'

const CONFIG = {
  usageSemantics: 'exclusive',
  currency: 'CNY',
  pricing: { deepseek: { 'deepseek-chat': { uncachedInput: 2, cacheWrite: 2, cacheRead: 0.5, output: 8 } } },
}

function event(type, data, seq, time = 1700000000000 + seq * 1000) {
  return { type, seq, time, data }
}

function ledgerFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-retry-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = createStore({ dir })
  const ledger = createLedger({ sessionId: 'sess', store, config: CONFIG })
  ledger.sample({ id: 'sess' }, event('request/header', {
    header: { config: { provider: 'deepseek', model: 'deepseek-chat' } }, reason: 'initial', startsSeries: true,
  }, 0))
  return ledger
}

test('retry: attempt and settlement share one (turn,step) slot and bill deltas', (t) => {
  const ledger = ledgerFor(t)
  const attempt = ledger.sample({}, event('assistant/attempt', {
    turn: 1, step: 1, stream: [{ chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } } }],
  }, 1))
  assert.equal(attempt.length, 1)
  assert.equal(attempt[0].usd, (100 * 2 + 10 * 8) / 1e6)

  const settled = ledger.sample({}, event('assistant/message', {
    turn: 1, step: 1, message: {}, stream: [], usage: { inputTokens: 150, outputTokens: 20 },
  }, 2))
  assert.equal(settled.length, 1)
  // Replacement: only the +50 input / +10 output delta is billed again.
  assert.equal(settled[0].usd, (50 * 2 + 10 * 8) / 1e6)
  assert.equal(settled[0].extra.replaced, true)

  const summary = ledger.summary()
  assert.equal(summary.counts.calls, 2)
  assert.equal(summary.tokens.uncachedInput, 150)
  assert.equal(summary.tokens.output, 20)
  assert.equal(summary.cost, (150 * 2 + 20 * 8) / 1e6)
})

test('retry: llm/retry-started clears the slot so a retry is billed fully', (t) => {
  const ledger = ledgerFor(t)
  ledger.sample({}, event('assistant/attempt', {
    turn: 2, step: 1, usage: { inputTokens: 100, outputTokens: 0 },
  }, 1))
  ledger.sample({}, event('llm/retry-started', { turn: 2, step: 1 }, 2))
  const retried = ledger.sample({}, event('assistant/message', {
    turn: 2, step: 1, message: {}, stream: [], usage: { inputTokens: 120, outputTokens: 0 },
  }, 3))
  assert.equal(retried.length, 1)
  assert.equal(retried[0].usd, (120 * 2) / 1e6)
  assert.equal(ledger.summary().tokens.uncachedInput, 220)
})

test('retry: identical settlement produces no extra billed record', (t) => {
  const ledger = ledgerFor(t)
  ledger.sample({}, event('assistant/attempt', {
    turn: 3, step: 1, usage: { inputTokens: 100, outputTokens: 5 },
  }, 1))
  const duplicate = ledger.sample({}, event('assistant/message', {
    turn: 3, step: 1, message: {}, stream: [], usage: { inputTokens: 100, outputTokens: 5 },
  }, 2))
  assert.deepEqual(duplicate, [])
  assert.equal(ledger.summary().counts.calls, 1)
})
