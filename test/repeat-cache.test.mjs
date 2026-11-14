/**
 * M8 repeat-cache + tokenUsage audit tests.
 * Run: cd dsh-costpilot && node --test test/repeat-cache.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../lib/config.js'
import {
  createRepeatCache,
  canonicalizeArgs,
  buildCacheKey,
} from '../lib/repeat-cache.js'
import { reconcileUsage, RECONCILE_THRESHOLDS } from '../lib/audit.js'

function m8Config(overrides = {}) {
  return resolveConfig({ modules: { M8: { enabled: true, ...overrides } } })
}

/* ----------------------------------------------------------- M8 repeat-cache */

test('M8 advisory detects an identical call and points at the previous seq', () => {
  const cache = createRepeatCache({ config: m8Config() })
  cache.record({ toolName: 'read', argsText: '{"path":"src/a.js"}', resultText: 'A', resultSeq: 7, now: 1000 })
  const decision = cache.decide({ toolName: 'read', argsText: '{"path":"src/a.js"}', turn: 1, step: 2, now: 1001 })
  assert.equal(decision.action, 'advisory')
  assert.match(decision.text, /seq 7/)
  assert.match(decision.text, /read/)
  assert.equal(typeof decision.key, 'string')
  assert.ok(decision.text.length < 400)
})

test('M8 canonical args ignore object key order and whitespace', () => {
  const cache = createRepeatCache({ config: m8Config() })
  cache.record({ toolName: 'glob', argsText: '{"b":2,"a":{"y":1,"x":0}}', resultSeq: 3, now: 0 })
  const decision = cache.decide({ toolName: 'glob', argsText: '{ "a": { "x": 0, "y": 1 }, "b": 2 }', now: 1 })
  assert.equal(decision.action, 'advisory')
  assert.match(decision.text, /seq 3/)
  assert.equal(
    canonicalizeArgs('{"b":2,"a":{"y":1,"x":0}}'),
    canonicalizeArgs('{ "a": { "x": 0, "y": 1 }, "b": 2 }'),
  )
})

test('M8 canonical args keep array order significant', () => {
  const cache = createRepeatCache({ config: m8Config() })
  cache.record({ toolName: 'read', argsText: '{"paths":["a","b"]}', resultSeq: 1, now: 0 })
  const reordered = cache.decide({ toolName: 'read', argsText: '{"paths":["b","a"]}', now: 1 })
  assert.equal(reordered.action, 'none')
  const same = cache.decide({ toolName: 'read', argsText: '{"paths":["a","b"]}', now: 1 })
  assert.equal(same.action, 'advisory')
})

test('M8 canonical args are deterministic for nested structures', () => {
  const first = canonicalizeArgs({ z: [{ b: 2, a: 1 }, null], a: true })
  const second = canonicalizeArgs({ a: true, z: [{ a: 1, b: 2 }, null] })
  assert.equal(first, second)
  assert.equal(buildCacheKey('read', { z: [{ b: 2, a: 1 }], a: true }), buildCacheKey('read', { a: true, z: [{ a: 1, b: 2 }] }))
})

test('M8 non-JSON args fall back to a stable raw hash', () => {
  const cache = createRepeatCache({ config: m8Config() })
  const key = buildCacheKey('read', 'raw text not json')
  assert.match(key, /:raw:[0-9a-f]{8}:/)
  cache.record({ toolName: 'read', argsText: 'raw text not json', resultSeq: 5, now: 0 })
  assert.equal(cache.decide({ toolName: 'read', argsText: ' raw text not json ', now: 1 }).action, 'advisory')
  assert.equal(cache.decide({ toolName: 'read', argsText: 'another raw text', now: 1 }).action, 'none')
})

test('M8 only considers tools in allowTools', () => {
  const cache = createRepeatCache({ config: m8Config() })
  const denied = cache.decide({ toolName: 'bash', argsText: '{"command":"rm -rf x"}', now: 0 })
  assert.equal(denied.action, 'none')
  assert.equal(denied.reason, 'not-allowed')
  const stored = cache.record({ toolName: 'bash', argsText: '{"command":"rm -rf x"}', resultSeq: 4, now: 0 })
  assert.equal(stored.stored, false)
  assert.equal(stored.reason, 'not-allowed')
  assert.equal(cache.lookup(buildCacheKey('bash', '{"command":"rm -rf x"}'), 1), null)
})

test('M8 honours a custom allowTools list', () => {
  const cache = createRepeatCache({ config: m8Config({ allowTools: ['index_query'] }) })
  assert.equal(cache.decide({ toolName: 'read', argsText: '{}', now: 0 }).reason, 'not-allowed')
  cache.record({ toolName: 'index_query', argsText: '{"sql":"select 1"}', resultSeq: 2, now: 0 })
  assert.equal(cache.decide({ toolName: 'index_query', argsText: '{"sql":"select 1"}', now: 1 }).action, 'advisory')
})

test('M8 never caches error results and invalidates a prior entry', () => {
  const cache = createRepeatCache({ config: m8Config() })
  const key = buildCacheKey('grep', '{"pattern":"x"}')
  cache.record({ toolName: 'grep', argsText: '{"pattern":"x"}', resultText: 'ok', resultSeq: 1, now: 0 })
  assert.ok(cache.lookup(key, 1))
  const errored = cache.record({ toolName: 'grep', argsText: '{"pattern":"x"}', isError: true, now: 2 })
  assert.equal(errored.stored, false)
  assert.equal(errored.reason, 'is-error')
  assert.equal(errored.invalidated, true)
  assert.equal(cache.lookup(key, 3), null)
  assert.equal(cache.decide({ toolName: 'grep', argsText: '{"pattern":"x"}', now: 3 }).action, 'none')
})

test('M8 deny level returns the previous seq and side-store pointer', () => {
  const cache = createRepeatCache({ config: m8Config({ level: 'deny' }) })
  cache.record({
    toolName: 'read',
    argsText: '{"path":"out.txt"}',
    resultText: 'BIG',
    resultSeq: 42,
    resultPointer: '/tmp/originals/s1/c42.txt',
    now: 0,
  })
  const decision = cache.decide({ toolName: 'read', argsText: '{"path":"out.txt"}', now: 1 })
  assert.equal(decision.action, 'deny')
  assert.match(decision.text, /seq 42/)
  assert.match(decision.text, /\/tmp\/originals\/s1\/c42\.txt/)
  assert.equal(decision.seq, 42)
  assert.equal(decision.pointer, '/tmp/originals/s1/c42.txt')
})

test('M8 cache level replays the stored result with a reuse marker', () => {
  const cache = createRepeatCache({ config: m8Config({ level: 'cache' }) })
  cache.record({ toolName: 'read', argsText: '{"path":"x"}', resultText: 'CACHED OUTPUT', resultSeq: 9, now: 100 })
  const decision = cache.decide({ toolName: 'read', argsText: '{"path":"x"}', now: 101 })
  assert.equal(decision.action, 'cache')
  assert.match(decision.text, /CACHED OUTPUT/)
  assert.match(decision.text, /<costpilot:cache-reuse seq="9"\/>/)
  assert.equal(decision.seq, 9)
  assert.equal(decision.recordedAt, 100)
})

test('M8 cache level returns none when nothing is recorded', () => {
  const cache = createRepeatCache({ config: m8Config({ level: 'cache' }) })
  assert.equal(cache.decide({ toolName: 'read', argsText: '{"path":"missing"}', now: 0 }).action, 'none')
})

test('M8 cache entries expire after ttlSeconds', () => {
  const cache = createRepeatCache({ config: m8Config({ level: 'cache', ttlSeconds: 60 }) })
  const key = buildCacheKey('read', '{"path":"ttl"}')
  cache.record({ toolName: 'read', argsText: '{"path":"ttl"}', resultText: 'R', resultSeq: 3, now: 1000 })
  assert.equal(cache.decide({ toolName: 'read', argsText: '{"path":"ttl"}', now: 1000 + 59999 }).action, 'cache')
  assert.equal(cache.decide({ toolName: 'read', argsText: '{"path":"ttl"}', now: 1000 + 60000 }).action, 'none')
  assert.equal(cache.lookup(key, 1000 + 60000), null)
})

test('M8 advisory detection also expires with the TTL', () => {
  const cache = createRepeatCache({ config: m8Config({ ttlSeconds: 1 }) })
  cache.record({ toolName: 'read', argsText: '{"path":"ttl"}', resultSeq: 2, now: 0 })
  assert.equal(cache.decide({ toolName: 'read', argsText: '{"path":"ttl"}', now: 500 }).action, 'advisory')
  assert.equal(cache.decide({ toolName: 'read', argsText: '{"path":"ttl"}', now: 1000 }).action, 'none')
})

test('M8 ttlSweep only removes expired entries', () => {
  const cache = createRepeatCache({ config: m8Config({ ttlSeconds: 10 }) })
  cache.record({ toolName: 'read', argsText: '{"path":"first"}', resultSeq: 1, now: 0 })
  cache.record({ toolName: 'read', argsText: '{"path":"second"}', resultSeq: 2, now: 5000 })
  assert.equal(cache.ttlSweep(5000), 0)
  assert.equal(cache.ttlSweep(10000), 1)
  assert.equal(cache.lookup(buildCacheKey('read', '{"path":"first"}'), 10000), null)
  assert.ok(cache.lookup(buildCacheKey('read', '{"path":"second"}'), 10000))
  assert.equal(cache.ttlSweep(15000), 1)
  assert.equal(cache.stats().entries, 0)
})

test('M8 decide can use a caller-provided lastResultSeq and pointer', () => {
  const cache = createRepeatCache({ config: m8Config() })
  const decision = cache.decide({
    toolName: 'grep',
    argsText: '{"pattern":"TODO"}',
    lastResultSeq: 88,
    lastResultPointer: '/tmp/originals/s1/c88.txt',
    now: 0,
  })
  assert.equal(decision.action, 'advisory')
  assert.match(decision.text, /seq 88/)
  assert.match(decision.text, /\/tmp\/originals\/s1\/c88\.txt/)
})

test('M8 is inert when the module is disabled', () => {
  const cache = createRepeatCache({ config: resolveConfig({}) })
  const decision = cache.decide({ toolName: 'read', argsText: '{}', now: 0 })
  assert.equal(decision.action, 'none')
  assert.equal(decision.reason, 'disabled')
  const stored = cache.record({ toolName: 'read', argsText: '{}', resultSeq: 1, now: 0 })
  assert.equal(stored.stored, false)
  assert.equal(stored.reason, 'disabled')
})

test('M8 accepts a bare module config with defaults', () => {
  const cache = createRepeatCache({ config: { level: 'deny', allowTools: ['read'], ttlSeconds: 30 } })
  const stats = cache.stats()
  assert.equal(stats.enabled, true)
  assert.equal(stats.level, 'deny')
  assert.equal(stats.ttlSeconds, 30)
  assert.deepEqual(stats.allowTools, ['read'])
  cache.record({ toolName: 'read', argsText: '{"p":1}', resultSeq: 2, now: 0 })
  assert.equal(cache.decide({ toolName: 'read', argsText: '{"p":1}', now: 1 }).action, 'deny')
})

test('M8 decisions are deterministic across repeated calls', () => {
  const cache = createRepeatCache({ config: m8Config() })
  cache.record({ toolName: 'read', argsText: '{"p":1}', resultSeq: 4, now: 0 })
  const request = { toolName: 'read', argsText: '{"p":1}', now: 5 }
  const first = cache.decide(request)
  const second = cache.decide(request)
  assert.equal(JSON.stringify(first), JSON.stringify(second))
  assert.equal(cache.stats().entries, 1)
})

/* ------------------------------------------------------------- tokenUsage audit */

test('audit reconciles matching token buckets', () => {
  const result = reconcileUsage({
    ledger: { tokens: { uncachedInput: 1000, cacheRead: 2000, cacheWrite: 300, output: 400 } },
    tokenUsage: { uncachedInputTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 300, outputTokens: 400 },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.mismatched, [])
  assert.deepEqual(result.deltas, { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 })
  assert.deepEqual(result.totals, { ledger: 3700, tokenUsage: 3700, delta: 0 })
  assert.deepEqual(result.thresholds, { relative: RECONCILE_THRESHOLDS.relative, absoluteTokens: RECONCILE_THRESHOLDS.absoluteTokens })
})

test('audit flags a bucket above both thresholds', () => {
  const result = reconcileUsage({
    ledger: { tokens: { uncachedInput: 1000 } },
    tokenUsage: { uncachedInputTokens: 1300 },
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.mismatched, ['uncachedInput'])
  assert.equal(result.deltas.uncachedInput, 300)
  assert.ok(result.relativeDeltas.uncachedInput > 0.02)
})

test('audit ignores relative-only drift under the absolute noise floor', () => {
  const result = reconcileUsage({
    ledger: { tokens: { cacheRead: 1000 } },
    tokenUsage: { cacheReadTokens: 1030 },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.mismatched, [])
  assert.equal(result.deltas.cacheRead, 30)
})

test('audit ignores absolute-only drift under the relative tolerance', () => {
  const result = reconcileUsage({
    ledger: { tokens: { output: 100000 } },
    tokenUsage: { outputTokens: 100150 },
  })
  assert.equal(result.ok, true)
  assert.equal(result.deltas.output, 150)
  assert.equal(result.mismatched.length, 0)
})

test('audit flags every materially drifting bucket', () => {
  const result = reconcileUsage({
    ledger: { tokens: { uncachedInput: 1000, cacheRead: 1000, cacheWrite: 1000, output: 1000 } },
    tokenUsage: { uncachedInputTokens: 1300, cacheReadTokens: 1300, cacheWriteTokens: 1300, outputTokens: 1300 },
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.mismatched, ['uncachedInput', 'cacheRead', 'cacheWrite', 'output'])
})

test('audit treats a missing projection as zero and flags missing usage', () => {
  const result = reconcileUsage({ ledger: { tokens: { output: 500 } }, tokenUsage: {} })
  assert.equal(result.ok, false)
  assert.deepEqual(result.mismatched, ['output'])
  assert.equal(result.deltas.output, -500)
  assert.deepEqual(result.totals, { ledger: 500, tokenUsage: 0, delta: -500 })
})

test('audit accepts ledger aliases and supports custom thresholds', () => {
  const input = {
    ledger: { tokens: { uncachedInputTokens: 1000 } },
    tokenUsage: { uncachedInputTokens: 1200 },
  }
  const strict = reconcileUsage(input)
  assert.equal(strict.ok, false)
  assert.deepEqual(strict.mismatched, ['uncachedInput'])
  const lenient = reconcileUsage(input, { relative: 0.5, absoluteTokens: 100 })
  assert.equal(lenient.ok, true)
  assert.deepEqual(lenient.thresholds, { relative: 0.5, absoluteTokens: 100 })
})

test('audit reports negative deltas when the ledger over-claims', () => {
  const result = reconcileUsage({
    ledger: { tokens: { output: 1000 } },
    tokenUsage: { outputTokens: 200 },
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.mismatched, ['output'])
  assert.equal(result.deltas.output, -800)
  assert.ok(result.relativeDeltas.output > 0.5)
})
