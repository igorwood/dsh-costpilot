/**
 * Hooks tests: M1 deterministic tool-output compaction + M9 runaway guard.
 * Run: cd dsh-costpilot && node --test test/hooks.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { resolveConfig } from '../lib/config.js'
import { compressToolResult, writeSideStore } from '../lib/compress.js'
import { createGuard } from '../lib/guard.js'

const defaultConfig = resolveConfig({})

function m1Config(overrides = {}) {
  return resolveConfig({ modules: { M1: overrides } })
}

function m9Config({ m9 = {}, budgets = {} } = {}) {
  return resolveConfig({ budgets, modules: { M9: m9 } })
}

function pad2(value) {
  return value < 10 ? '0' + value : String(value)
}

function textResult(text, extra = {}) {
  return { content: [{ type: 'text', text }], isError: false, ...extra }
}

/* ------------------------------------------------------------------ fixtures */

function logFixture() {
  const esc = String.fromCharCode(27)
  const lines = ['=== build started ===']
  for (let index = 0; index < 40; index += 1) {
    lines.push('2026-01-01T00:00:' + pad2(index % 60) + '.000Z INFO worker-' + (index % 7) +
      ' processed item ' + index + ' in ' + (index % 13) + 'ms')
  }
  for (let index = 0; index < 20; index += 1) {
    lines.push('2026-01-01T00:00:01.000Z WARN retry scheduled')
  }
  for (let index = 40; index < 320; index += 1) {
    if (index % 37 === 0) {
      lines.push(esc + '[31m2026-01-01T00:01:' + pad2(index % 60) + '.000Z ERROR worker-' +
        (index % 5) + ' failed job ' + index + ': connection reset' + esc + '[0m')
    } else {
      lines.push('2026-01-01T00:01:' + pad2(index % 60) + '.000Z INFO worker-' + (index % 7) +
        ' processed item ' + index + ' in ' + (index % 13) + 'ms')
    }
  }
  lines.push('progress 10%' + String.fromCharCode(13) + 'progress 55%' + String.fromCharCode(13) + 'progress 100%')
  lines.push('=== build finished ===')
  return String.fromCharCode(0xFEFF) + lines.join(String.fromCharCode(13, 10))
}

function jsonFixture() {
  const items = []
  for (let index = 0; index < 120; index += 1) {
    items.push({
      id: 'item-' + String(index).padStart(3, '0'),
      name: 'Widget number ' + index,
      status: index % 17 === 0 ? 'error' : 'ok',
      tags: ['alpha', 'beta', 'gamma', 'tag-' + index],
      metrics: { latencyMs: index * 3, ok: index % 5 !== 0 },
      note: index === 0 ? 'detail: ' + 'x'.repeat(3000) : 'fine',
    })
  }
  return JSON.stringify({ status: 'ok', total: items.length, query: { page: 1, size: 120 }, items, message: 'all good' }, null, 2)
}

function diffFixture() {
  const lines = ['diff --git a/src/app.js b/src/app.js', 'index abc..def 100644', '--- a/src/app.js', '+++ b/src/app.js', '@@ -1,200 +1,200 @@']
  for (let hunk = 0; hunk < 5; hunk += 1) {
    for (let index = 0; index < 25; index += 1) lines.push(' context line ' + hunk + '-' + index + ' lorem ipsum dolor sit amet')
    lines.push('-const old' + hunk + ' = compute(' + hunk + ')')
    lines.push('+const new' + hunk + ' = compute(' + (hunk + 1) + ')')
    for (let index = 0; index < 25; index += 1) lines.push(' context tail ' + hunk + '-' + index + ' lorem ipsum dolor sit amet')
    if (hunk < 4) lines.push('@@ -' + (hunk * 50 + 100) + ',50 +' + (hunk * 50 + 100) + ',50 @@')
  }
  return lines.join('\n')
}

function tableFixture() {
  const rows = ['id\tname\tstatus\tlatency_ms\tregion']
  for (let index = 0; index < 100; index += 1) {
    rows.push(index + '\tcomponent-' + index + '\t' + (index % 9 === 0 ? 'error' : 'ok') +
      '\t' + (index * 7) + '\tregion-' + (index % 4))
  }
  return rows.join('\n')
}

function codeFixture() {
  const parts = []
  for (let index = 0; index < 400; index += 1) parts.push('function fn' + index + '(a){return a+' + index + '}')
  return '// generated module\n' + parts.join('') + '\n'
}

function genericFixture(count = 220) {
  const lines = []
  for (let index = 0; index < count; index += 1) {
    lines.push('Paragraph ' + index + ': lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore.')
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------ M1: compaction */

test('M1 compacts log output: head/tail, error lines and repeated-line folding', () => {
  const text = logFixture()
  const out = compressToolResult({ toolName: 'bash', result: textResult(text), config: defaultConfig, context: { sessionId: 's1', callId: 'c1' } })
  assert.equal(out.changed, true)
  const compacted = out.content[0].text
  assert.ok(compacted.length < text.length)
  assert.ok(out.removedTokens > out.addedTokens)
  assert.ok(out.pointerCount > 0)
  assert.match(compacted, /lines omitted/)
  assert.match(compacted, /repeated x20/)
  assert.equal(out.stats.format, 'log')
  assert.ok(out.stats.savingsRatio > 0)
  assert.equal(out.content.length, 1)
})

test('M1 normalizes ANSI, BOM, CRLF and progress-bar overstrikes', () => {
  const text = logFixture()
  const out = compressToolResult({ toolName: 'bash', result: textResult(text), config: defaultConfig })
  const compacted = out.content[0].text
  assert.equal(compacted.indexOf(String.fromCharCode(27)), -1)
  assert.equal(compacted.indexOf(String.fromCharCode(13)), -1)
  assert.equal(compacted.indexOf(String.fromCharCode(0xFEFF)), -1)
  const progressLine = compacted.split('\n').find((line) => line.startsWith('progress'))
  assert.equal(progressLine, 'progress 100%')
  assert.equal(compacted.includes('progress 55%'), false)
  assert.match(compacted, /=== build started ===/)
  assert.match(compacted, /=== build finished ===/)
})

test('M1 compacts JSON: skeleton, array truncation, long-string truncation', () => {
  const text = jsonFixture()
  const out = compressToolResult({ toolName: 'read', result: textResult(text), config: defaultConfig })
  assert.equal(out.changed, true)
  const compacted = out.content[0].text
  assert.ok(compacted.length < text.length)
  assert.match(compacted, /"status":"ok"/)
  assert.match(compacted, /"message":"all good"/)
  assert.match(compacted, /more items \(total 120\)/)
  assert.match(compacted, new RegExp('…\\[\\+[0-9]+ chars\\]'))
  assert.equal(out.stats.format, 'json')
  assert.ok((compacted.match(/Widget number/g) || []).length < 20)
})

test('M1 compacts diff output: keeps hunks and changed lines, drops context', () => {
  const text = diffFixture()
  const out = compressToolResult({ toolName: 'bash', result: textResult(text), config: defaultConfig })
  assert.equal(out.changed, true)
  const compacted = out.content[0].text
  assert.match(compacted, /@@ -/)
  assert.match(compacted, /\+const new0/)
  assert.match(compacted, /-const old0/)
  assert.match(compacted, /unchanged lines omitted/)
  assert.equal(compacted.includes('context tail 0-24'), false)
  assert.equal(out.stats.format, 'diff')
})

test('M1 compacts table output: header + first rows + row pointer', () => {
  const text = tableFixture()
  const out = compressToolResult({ toolName: 'bash', result: textResult(text), config: defaultConfig })
  assert.equal(out.changed, true)
  const compacted = out.content[0].text
  const lines = compacted.split('\n')
  assert.match(lines[0], /^id\tname\tstatus/)
  assert.match(lines[1], /^0\tcomponent-0/)
  assert.equal(compacted.includes('component-99'), false)
  assert.match(compacted, /more rows \(100 data rows\)/)
  assert.equal(lines.length, 14)
  assert.equal(out.stats.format, 'table')
})

test('M1 compacts minified code: truncates overlong single lines', () => {
  const text = codeFixture()
  const out = compressToolResult({ toolName: 'read', result: textResult(text), config: defaultConfig })
  assert.equal(out.changed, true)
  const compacted = out.content[0].text
  const lines = compacted.split('\n')
  assert.equal(lines[0], '// generated module')
  assert.ok(compacted.length < text.length)
  assert.ok(lines.every((line) => line.length <= 560))
  assert.match(compacted, new RegExp('…\\[\\+[0-9]+ chars\\]'))
  assert.equal(out.stats.format, 'code')
})

test('M1 compacts generic text: head + tail + omission pointer', () => {
  const text = genericFixture()
  const out = compressToolResult({ toolName: 'read', result: textResult(text), config: defaultConfig })
  assert.equal(out.changed, true)
  const compacted = out.content[0].text
  assert.match(compacted, /^Paragraph 0:/)
  assert.match(compacted, /lines omitted/)
  assert.equal(compacted.includes('Paragraph 150:'), false)
  assert.equal(out.stats.format, 'generic')
})

test('M1 is deterministic: the same input always yields the same output', () => {
  const fixtures = [
    ['log', logFixture()],
    ['json', jsonFixture()],
    ['diff', diffFixture()],
    ['table', tableFixture()],
    ['code', codeFixture()],
    ['generic', genericFixture()],
  ]
  for (const [name, text] of fixtures) {
    const context = { sessionId: 's1', callId: 'c-' + name, pointerPath: '/tmp/originals/s1/c-' + name + '.txt' }
    const first = compressToolResult({ toolName: 't', result: textResult(text), config: defaultConfig, context })
    const second = compressToolResult({ toolName: 't', result: textResult(text), config: defaultConfig, context })
    assert.equal(JSON.stringify(first), JSON.stringify(second), name)
    assert.match(first.content[0].text, /full output saved to/)
  }
})

test('M1 skips text that looks like a secret', () => {
  const text = genericFixture() + '\npassword: hunter2\n'
  const out = compressToolResult({ toolName: 'read', result: textResult(text), config: defaultConfig })
  assert.equal(out.changed, false)
  assert.equal(out.stats.skipped, 'secret')
  assert.equal(out.content[0].text, text)
  assert.equal(out.stats.skippedBlocks[0].reason, 'secret')
})

test('M1 preserves non-text blocks in order and does not mutate the input', () => {
  const logText = logFixture()
  const jsonText = jsonFixture()
  const imageBlock = { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAAA' } }
  const content = [{ type: 'text', text: logText }, imageBlock, { type: 'text', text: jsonText }]
  const out = compressToolResult({ toolName: 'read', result: { content, isError: false }, config: defaultConfig })
  assert.equal(out.changed, true)
  assert.equal(out.content.length, 3)
  assert.equal(out.content[1], imageBlock)
  assert.ok(out.content[0].text.length < logText.length)
  assert.ok(out.content[2].text.length < jsonText.length)
  assert.equal(content[0].text, logText)
  assert.equal(content[2].text, jsonText)
})

test('M1 does not compact error results unless explicitly enabled', () => {
  const text = logFixture()
  const content = [{ type: 'text', text }]
  const result = { content, isError: true }
  const skipped = compressToolResult({ toolName: 'bash', result, config: defaultConfig })
  assert.equal(skipped.changed, false)
  assert.equal(skipped.content, content)
  assert.equal(skipped.stats.skipped, 'is-error')

  const enabled = compressToolResult({ toolName: 'bash', result, config: m1Config({ compressErrors: true }) })
  assert.equal(enabled.changed, true)
  assert.equal(enabled.stats.format, 'log')
})

test('M1 enforces the minDeltaTokens threshold', () => {
  const small = compressToolResult({ toolName: 't', result: textResult('x'.repeat(800)), config: defaultConfig })
  assert.equal(small.changed, false)
  assert.equal(small.stats.skipped, 'below-min')

  const generic = genericFixture()
  const tokens = Math.ceil(generic.length / 4)
  const borderline = compressToolResult({ toolName: 't', result: textResult(generic), config: m1Config({ minDeltaTokens: tokens }) })
  assert.equal(borderline.changed, false)
  assert.equal(borderline.stats.skipped, 'below-min-delta')
})

test('M1 is disabled when the module is disabled', () => {
  const out = compressToolResult({ toolName: 'bash', result: textResult(logFixture()), config: m1Config({ enabled: false }) })
  assert.equal(out.changed, false)
  assert.equal(out.stats.skipped, 'disabled')
})

test('writeSideStore writes the original with a safe path, byte count and sha256', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'costpilot-side-'))
  try {
    const text = 'original output line\n' + 'y'.repeat(1234)
    const written = await writeSideStore({ dir, sessionId: 'sess/../1', callId: '../call 1', text })
    assert.ok(written.path.startsWith(path.join(dir, 'originals') + path.sep))
    const relative = path.relative(path.join(dir, 'originals'), written.path)
    assert.equal(relative.includes('..'), false)
    const segments = relative.split(path.sep)
    assert.equal(segments.length, 2)
    assert.match(segments[0], /^[A-Za-z0-9._-]+$/)
    assert.match(segments[1], /^[A-Za-z0-9._-]+\.txt$/)
    assert.equal(written.bytes, Buffer.byteLength(text, 'utf8'))
    assert.equal(written.sha256, createHash('sha256').update(text, 'utf8').digest('hex'))
    assert.equal(await readFile(written.path, 'utf8'), text)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------- M9 guard */

function eventOf(type, data, time) {
  return { type, data: data === undefined ? {} : data, time: time === undefined ? 1000 : time }
}

test('M9 observeEvent counts steps, tool calls, failures and repeated signatures', () => {
  const session = {}
  const guard = createGuard({ config: m9Config(), sessionId: 's1' })
  guard.observeEvent(session, eventOf('step/start'))
  guard.observeEvent(session, eventOf('step/start'))
  guard.observeEvent(session, eventOf('tool/call', { name: 'bash', args: { cmd: 'ls' } }))
  guard.observeEvent(session, eventOf('tool/call', { name: 'bash', args: { cmd: 'pwd' } }))
  guard.observeEvent(session, eventOf('tool/call', { name: 'bash', args: { cmd: 'pwd' } }))
  guard.observeEvent(session, eventOf('tool/result', { isError: true }))
  guard.observeEvent(session, eventOf('tool/result', { isError: false }))
  guard.observeEvent(session, eventOf('assistant/message', { usage: { inputTokens: 10 } }))
  const state = guard.state()
  assert.equal(state.steps, 2)
  assert.equal(state.toolCalls, 3)
  assert.equal(state.failedToolCalls, 1)
  assert.equal(state.repeatStreak, 2)
  assert.equal(typeof state.lastProgressAt, 'number')
  assert.equal(state.sessionUsd, 0)
})

test('M9 observeEvent ignores unrelated events', () => {
  const guard = createGuard({ config: m9Config(), sessionId: 's1' })
  const before = guard.state()
  guard.observeEvent({}, eventOf('session/title', { title: 'renamed' }))
  guard.observeEvent({}, eventOf('compaction/start', { marker: 1 }))
  guard.observeEvent({}, null)
  assert.deepEqual(guard.state(), before)
})

test('M9 warns when step budget is exceeded', () => {
  const guard = createGuard({ config: m9Config({ m9: { maxSteps: 2 } }), sessionId: 's1' })
  guard.observeEvent({}, eventOf('step/start'))
  guard.observeEvent({}, eventOf('step/start'))
  assert.equal(guard.checkPreStep({ turn: 1, step: 2 }).action, 'none')
  const decision = guard.checkPreStep({ turn: 1, step: 3 })
  assert.equal(decision.action, 'warn')
  assert.equal(decision.reason, 'max-steps')
  assert.match(decision.message, /max-steps/)
  assert.ok(decision.message.length <= 200)
  assert.equal(decision.details.maxSteps, 2)
})

test('M9 warns when tool-call budget is exceeded', () => {
  const guard = createGuard({ config: m9Config({ m9: { maxToolCalls: 2 } }), sessionId: 's1' })
  for (let index = 0; index < 3; index += 1) {
    guard.observeEvent({}, eventOf('tool/call', { name: 'bash', args: { cmd: 'cmd-' + index } }))
  }
  const decision = guard.checkPreStep({ turn: 1, step: 1 })
  assert.equal(decision.action, 'warn')
  assert.equal(decision.reason, 'max-tool-calls')
  assert.match(decision.message, /max-tool-calls/)
})

test('M9 warns when session cost reaches warnAtPct of the budget', () => {
  const config = m9Config({ budgets: { sessionUSD: 1, warnAtPct: 80, hardStopAtPct: 120 } })
  const guard = createGuard({ config, sessionId: 's1' })
  guard.noteCallCost(0.5)
  assert.equal(guard.checkPreStep({ turn: 1, step: 1 }).action, 'none')
  guard.noteCallCost(0.31)
  const decision = guard.checkPreStep({ turn: 1, step: 1 })
  assert.equal(decision.action, 'warn')
  assert.equal(decision.reason, 'budget')
  assert.ok(decision.details.budgetPct >= 0.8)
  assert.match(decision.message, /^M9/)
  assert.match(decision.message, /budget/)
  assert.ok(decision.message.length <= 200)
})

test('M9 warns when a single turn exceeds maxTurnCostUSD', () => {
  const guard = createGuard({ config: m9Config(), sessionId: 's1' })
  guard.noteTurnCost(1.5)
  const decision = guard.checkPreStep({ turn: 1, step: 1 })
  assert.equal(decision.action, 'warn')
  assert.equal(decision.reason, 'turn-cost')
  assert.equal(decision.details.turnUsd, 1.5)
  assert.equal(decision.details.maxTurnCostUSD, 1)
})

test('M9 warns on a cost spike versus the median turn (needs >= 3 turns)', () => {
  const guard = createGuard({ config: m9Config({ m9: { costSpikeMultiplier: 3 } }), sessionId: 's1' })
  for (const turn of [1, 2, 3]) {
    guard.observeEvent({}, eventOf('turn/start', { turn }))
    guard.noteTurnCost(0.1)
  }
  guard.observeEvent({}, eventOf('turn/start', { turn: 4 }))
  guard.noteTurnCost(0.5)
  const decision = guard.checkPreStep({ turn: 4, step: 2 })
  assert.equal(decision.action, 'warn')
  assert.equal(decision.reason, 'cost-spike')
  assert.equal(decision.details.medianTurnUsd, 0.1)
})

test('M9 does not warn on a spike with fewer than 3 historical turns', () => {
  const guard = createGuard({ config: m9Config({ m9: { costSpikeMultiplier: 3 } }), sessionId: 's1' })
  for (const turn of [1, 2]) {
    guard.observeEvent({}, eventOf('turn/start', { turn }))
    guard.noteTurnCost(0.1)
  }
  guard.observeEvent({}, eventOf('turn/start', { turn: 3 }))
  guard.noteTurnCost(0.5)
  const decision = guard.checkPreStep({ turn: 3, step: 2 })
  assert.equal(decision.action, 'none')
  assert.equal(decision.details.medianTurnUsd, null)
})

test('M9 warns when identical tool calls repeat noProgressSteps times', () => {
  const guard = createGuard({ config: m9Config({ m9: { noProgressSteps: 3 } }), sessionId: 's1' })
  for (let index = 0; index < 3; index += 1) {
    guard.observeEvent({}, eventOf('tool/call', { name: 'bash', args: { command: 'pwd' } }))
  }
  const decision = guard.checkPreStep({ turn: 1, step: 1 })
  assert.equal(decision.action, 'warn')
  assert.equal(decision.reason, 'no-progress')
  assert.equal(decision.details.repeatStreak, 3)
})

test('M9 warns once per session when warnOncePerSession is on', () => {
  const config = m9Config({ budgets: { sessionUSD: 1 } })
  const guard = createGuard({ config, sessionId: 's1' })
  guard.noteCallCost(0.9)
  const first = guard.checkPreStep({ turn: 1, step: 1 })
  assert.equal(first.action, 'warn')
  const second = guard.checkPreStep({ turn: 1, step: 1 })
  assert.equal(second.action, 'none')
  assert.equal(second.reason, 'warn-suppressed')
  assert.equal(second.details.suppressed, true)
  assert.equal(second.details.suppressedReason, 'budget')
  assert.equal(guard.state().warnCount, 1)
})

test('M9 can warn repeatedly when warnOncePerSession is off', () => {
  const config = m9Config({ m9: { warnOncePerSession: false }, budgets: { sessionUSD: 1 } })
  const guard = createGuard({ config, sessionId: 's1' })
  guard.noteCallCost(0.9)
  assert.equal(guard.checkPreStep({ turn: 1, step: 1 }).action, 'warn')
  assert.equal(guard.checkPreStep({ turn: 1, step: 1 }).action, 'warn')
  assert.equal(guard.state().warnCount, 2)
})

test('M9 never hard-stops while hardStop is off (default)', () => {
  const config = m9Config({ budgets: { sessionUSD: 1, warnAtPct: 80, hardStopAtPct: 120 } })
  const guard = createGuard({ config, sessionId: 's1' })
  guard.noteCallCost(1.3)
  const decision = guard.checkPreStep({ turn: 1, step: 1 })
  assert.equal(decision.action, 'warn')
  assert.notEqual(decision.action, 'stop')
  assert.equal(guard.state().stopped, false)
})

test('M9 hard-stops above hardStopAtPct only when hardStop is on', () => {
  const config = m9Config({ m9: { hardStop: true, hardStopSteps: 1 }, budgets: { sessionUSD: 1, warnAtPct: 80, hardStopAtPct: 120 } })
  const guard = createGuard({ config, sessionId: 's1' })
  guard.noteCallCost(1.0)
  const below = guard.checkPreStep({ turn: 1, step: 1 })
  assert.equal(below.action, 'warn')
  assert.equal(below.reason, 'budget')

  guard.noteCallCost(0.3)
  const decision = guard.checkPreStep({ turn: 1, step: 2 })
  assert.equal(decision.action, 'stop')
  assert.equal(decision.reason, 'hard-stop')
  assert.equal(decision.details.keepInbox, true)
  assert.equal(decision.details.cancel.keepInbox, true)
  assert.ok(decision.message.length <= 200)
  assert.equal(guard.state().stopped, true)
})

test('M9 check() is an alias of checkPreStep()', () => {
  const guard = createGuard({ config: m9Config(), sessionId: 's1' })
  assert.equal(typeof guard.check, 'function')
  assert.equal(guard.check({ turn: 1, step: 1 }).action, 'none')
  guard.noteCallCost(4.5)
  assert.equal(guard.check({ turn: 1, step: 1 }).action, 'warn')
})

test('M9 is inert when the module is disabled', () => {
  const config = resolveConfig({ modules: { M9: { enabled: false } } })
  const guard = createGuard({ config, sessionId: 's1' })
  guard.noteCallCost(100)
  const decision = guard.checkPreStep({ turn: 1, step: 1 })
  assert.equal(decision.action, 'none')
  assert.equal(decision.reason, 'disabled')
  assert.equal(decision.message, '')
})