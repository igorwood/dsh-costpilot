/**
 * M2/M3 compaction planner for dsh-costpilot. Pure functions, no IO.
 *
 * M2 (region GC): scores contiguous step units by reuse probability using
 * deterministic rules (age, tool type, error/path/reference signals) and picks a
 * run whose mean reuse probability is at or below tauLineReuse. It never
 * proposes user messages, error results, recent steps, orphan tool results, or
 * tool-pair-unbalanced boundaries, and caps one region by maxRegionRatio.
 *
 * M3 (subtask stack): classifies each LLM step into setup/search/read/edit/test/
 * execute, groups adjacent same-phase steps, and proposes a closed segment that
 * is long enough (segmentSteps) inside a session that is long enough
 * (minStepsBefore), leaving keepRecentSteps untouched and staying under
 * maxCompactionsPerSession.
 *
 * Both planners derive the model-visible surface from session events (honouring
 * surface replace ops) so seq ranges name exact surface nodes, and both emit a
 * template summary with no LLM call.
 *
 * @module dsh-costpilot/lib/compaction-plan
 */
import { estimateMessage, estimateTokens, estimateToolResult } from './estimate.js'
import { savingsForRemoval } from './oracle.js'

const SURFACE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

const PHASES = ['setup', 'search', 'read', 'edit', 'test', 'execute']
const DEFAULT_REMAINING_STEPS = 6
const DEFAULT_KEEP_RECENT_STEPS = 3
const MAX_SUMMARY_CHARS = 2000
const MAX_SUMMARY_ITEMS = 8
const PATH_RE = /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/
const REFERENCE_TOKEN_RE = /[A-Za-z0-9_.\/-]{8,}/
const TEST_COMMAND_RE = /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|pytest|vitest|jest|go\s+test|cargo\s+test|node\s+--test|make\s+test/i
const TEST_RESULT_RE = /pass|fail|tests?|assert|error/i

const DEFAULT_M2 = Object.freeze({
  enabled: false,
  tauLineReuse: 0.3,
  maxRegionRatio: 0.6,
  minRemainingSteps: 6,
})

const DEFAULT_M3 = Object.freeze({
  enabled: false,
  segmentSteps: 6,
  minStepsBefore: 10,
  maxCompactionsPerSession: 3,
  keepRecentSteps: 3,
})

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value))
}

function seqOf(event) {
  const seq = finiteNumber(event?.seq)
  return seq !== undefined ? seq : -1
}

function sortBySeq(events) {
  return events.slice().sort((left, right) => seqOf(left) - seqOf(right))
}

/** Read a session event list without importing DSH internals. */
function listSessionEvents(session) {
  if (!session) return []
  try {
    if (typeof session.ownEvents === 'function') {
      const own = session.ownEvents()
      if (Array.isArray(own)) return [...own]
    }
  } catch {
    // Fall through to the next source.
  }
  if (Array.isArray(session.appended)) return [...session.appended]
  try {
    if (typeof session.snapshotEvents === 'function') {
      const snapshot = session.snapshotEvents()
      if (Array.isArray(snapshot)) return [...snapshot]
    }
  } catch {
    // No readable event log.
  }
  return []
}

function inputEvents(input) {
  if (Array.isArray(input.events) && input.events.length > 0) return sortBySeq(input.events)
  return sortBySeq(listSessionEvents(input.session))
}

function buildEventLookup(events, session) {
  const bySeq = new Map()
  for (const event of events) {
    const seq = seqOf(event)
    if (seq >= 0) bySeq.set(seq, event)
  }
  function getEvent(seq) {
    const found = bySeq.get(seq)
    if (found !== undefined) return found
    if (session && typeof session.eventAt === 'function') {
      try {
        return session.eventAt(seq)
      } catch {
        return undefined
      }
    }
    return undefined
  }
  return { getEvent }
}

/** Fold session log events into current surface sequence numbers. */
function foldSurface(events) {
  const nodes = []
  for (const event of sortBySeq(events)) {
    if (!SURFACE_TYPES.has(event.type)) continue
    const operation = event.surfaceOp
    if (isPlainObject(operation) && operation.op === 'replace') {
      const startIndex = nodes.indexOf(operation.startSeq)
      const endIndex = nodes.indexOf(operation.endSeq)
      if (startIndex >= 0 && endIndex >= startIndex) {
        nodes.splice(startIndex, endIndex - startIndex + 1, seqOf(event))
        continue
      }
      const kept = nodes.filter((seq) => seq < operation.startSeq || seq > operation.endSeq)
      nodes.length = 0
      for (const seq of kept) nodes.push(seq)
      nodes.push(seqOf(event))
      continue
    }
    nodes.push(seqOf(event))
  }
  return nodes
}

function surfaceFor(input, events) {
  const surfaceNodes = input?.session?.surface?.nodes
  if (Array.isArray(surfaceNodes)) return [...surfaceNodes]
  return foldSurface(events)
}

function messageBlocks(message) {
  return Array.isArray(message?.content) ? message.content : []
}

function blocksText(blocks) {
  let text = ''
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

function toolCallBlocks(message) {
  const calls = []
  for (const block of messageBlocks(message)) {
    if (block && (block.type === 'tool-call' || block.type === 'tool_use')) calls.push(block)
  }
  return calls
}

function toolArguments(block) {
  if (typeof block.arguments === 'string') return block.arguments
  if (block.arguments !== undefined) {
    try {
      return JSON.stringify(block.arguments)
    } catch {
      return ''
    }
  }
  if (typeof block.input === 'string') return block.input
  if (block.input !== undefined) {
    try {
      return JSON.stringify(block.input)
    } catch {
      return ''
    }
  }
  return ''
}

function textOfEvent(event) {
  if (!event) return ''
  const data = event.data ?? {}
  if (event.type === 'tool/result') return blocksText(messageBlocks(data.message))
  if (event.type === 'assistant/message') return blocksText(messageBlocks(data.message))
  if (event.type === 'user/message') return blocksText(messageBlocks(data))
  if (event.type === 'system/message' || event.type === 'developer/message') return blocksText(messageBlocks(data.message))
  return ''
}

function assistantMessageTokens(message) {
  let tokens = estimateMessage(message)
  for (const block of toolCallBlocks(message)) {
    tokens += 4 + estimateTokens(typeof block.name === 'string' ? block.name : '') + estimateTokens(toolArguments(block))
  }
  return tokens
}

function eventTokens(event) {
  if (!event) return 0
  const data = event.data ?? {}
  switch (event.type) {
    case 'tool/result':
      return estimateToolResult(data.message ? data.message.content : undefined)
    case 'assistant/message':
      return assistantMessageTokens(data.message)
    case 'user/message':
      return estimateMessage({ role: 'user', content: data.content })
    case 'system/message':
    case 'developer/message':
      return estimateMessage(data.message ?? {})
    default:
      return 0
  }
}

function stepTag(event) {
  const data = event?.data
  if (!isPlainObject(data)) return null
  const turn = finiteNumber(data.turn)
  const step = finiteNumber(data.step)
  if (turn === undefined || step === undefined) return null
  return turn + ':' + step
}

function toolCallDelta(event) {
  if (!event) return 0
  if (event.type === 'assistant/message') return toolCallBlocks(event.data?.message).length
  if (event.type === 'tool/result') return -1
  return 0
}

/** Tool-pairing balance for every cut of the surface; null when corrupt. */
function pairingCuts(surface, getEvent) {
  const cuts = [true]
  let pending = 0
  for (const seq of surface) {
    const event = getEvent(seq)
    if (!event) return null
    pending += toolCallDelta(event)
    if (pending < 0) return null
    cuts.push(pending === 0)
  }
  return cuts
}

function buildMetas(surface, getEvent) {
  return surface.map((seq, index) => {
    const event = getEvent(seq)
    const message = event?.data?.message
    const calls = event?.type === 'assistant/message' ? toolCallBlocks(message) : []
    const text = textOfEvent(event)
    const toolNames = []
    const toolArgs = []
    for (const call of calls) {
      toolNames.push(typeof call.name === 'string' ? call.name : 'unknown')
      toolArgs.push(toolArguments(call))
    }
    const data = event?.data ?? {}
    const isError = event?.type === 'tool/result'
      ? (data.message?.isError === true || data.error !== undefined)
      : false
    return {
      index,
      seq,
      type: typeof event?.type === 'string' ? event.type : 'unknown',
      event,
      tokens: eventTokens(event),
      toolNames,
      toolArgs,
      isError,
      text,
      hasPath: PATH_RE.test(text),
      referenced: false,
      stepIndex: -1,
    }
  })
}

/** Group the surface into step units (assistant + following tool results). */
function buildSegments(metas) {
  const segments = []
  let current = null
  let stepCount = 0
  for (let index = 0; index < metas.length; index++) {
    const meta = metas[index]
    if (meta.type === 'assistant/message') {
      current = {
        kind: 'step',
        indices: [index],
        startIdx: index,
        endIdx: index,
        toolNames: [...meta.toolNames],
        toolArgs: [...meta.toolArgs],
        hasError: false,
        stepIndex: stepCount,
      }
      stepCount += 1
      segments.push(current)
      continue
    }
    if (meta.type === 'tool/result' && current && current.kind === 'step' && current.endIdx === index - 1) {
      current.indices.push(index)
      current.endIdx = index
      current.toolNames.push(...meta.toolNames)
      current.toolArgs.push(...meta.toolArgs)
      if (meta.isError) current.hasError = true
      continue
    }
    current = null
    const kind = meta.type === 'user/message'
      ? 'user'
      : (meta.type === 'tool/result' ? 'orphan' : 'barrier')
    segments.push({
      kind,
      indices: [index],
      startIdx: index,
      endIdx: index,
      toolNames: [],
      toolArgs: [],
      hasError: Boolean(meta.isError),
      stepIndex: -1,
    })
  }
  return { segments, stepCount }
}

function markStepIndices(metas, segments) {
  for (const segment of segments) {
    if (segment.kind !== 'step') continue
    for (const index of segment.indices) metas[index].stepIndex = segment.stepIndex
  }
  return segments.filter((segment) => segment.kind === 'step').length
}

/** Cheap later-reference detection used by the M2 reuse rule. */
function markReferences(metas) {
  for (let index = 0; index < metas.length; index++) {
    const meta = metas[index]
    if (!meta.text) continue
    const match = REFERENCE_TOKEN_RE.exec(meta.text)
    if (!match) continue
    const token = match[0]
    for (let later = index + 1; later < metas.length; later++) {
      if (metas[later].text.includes(token)) {
        meta.referenced = true
        break
      }
    }
  }
}

function shorten(text, limit = 60) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (collapsed.length <= limit) return collapsed
  return collapsed.slice(0, limit) + '...'
}

function firstPath(text) {
  const match = PATH_RE.exec(String(text ?? ''))
  return match ? match[0] : ''
}

function sumTokens(metas, startIndex, endIndex) {
  let total = 0
  for (let index = startIndex; index <= endIndex; index++) {
    if (metas[index]) total += metas[index].tokens
  }
  return total
}

function resolveRemainingSteps(input) {
  const value = finiteNumber(input.remainingSteps)
  if (value !== undefined) return Math.max(0, Math.round(value))
  return DEFAULT_REMAINING_STEPS
}

function computeNetUSD(price, remainingSteps, deltaTokens, suffixTokens) {
  if (!isPlainObject(price)) return 0
  return savingsForRemoval({
    price,
    remainingCalls: remainingSteps,
    deltaTokens,
    suffixTokens,
    llmUSD: 0,
  }).netUSD
}

function buildContext(input) {
  const events = inputEvents(input)
  const lookup = buildEventLookup(events, input.session)
  const surface = surfaceFor(input, events)
  const metas = buildMetas(surface, lookup.getEvent)
  const cuts = pairingCuts(surface, lookup.getEvent)
  const { segments, stepCount } = buildSegments(metas)
  markStepIndices(metas, segments)
  markReferences(metas)
  const linesBySeq = new Map()
  if (Array.isArray(input.lines)) {
    for (const line of input.lines) {
      const seq = finiteNumber(line?.seq)
      if (seq !== undefined) linesBySeq.set(seq, line)
    }
  }
  const compactionsDone = events.filter((event) => event && event.type === 'compaction/summary').length
  return {
    events,
    surface,
    metas,
    cuts,
    segments,
    stepCount,
    linesBySeq,
    compactionsDone,
    totalTokens: sumTokens(metas, 0, metas.length - 1),
  }
}

function ruleReuseProbability(meta, context) {
  let probability = 0.35
  if (meta.stepIndex >= 0 && context.stepCount > 0) {
    const age = Math.max(0, context.stepCount - 1 - meta.stepIndex)
    probability -= 0.12 * Math.min(1, age / 6)
  }
  for (const name of meta.toolNames) {
    if (name === 'write' || name === 'edit') probability += 0.25
    else if (name === 'read') probability += 0.1
    else if (name === 'glob' || name === 'grep' || name === 'web_search' || name === 'office') probability += 0.05
    else if (name === 'bash' || name === 'run_code') probability += 0.03
  }
  if (meta.isError) probability += 0.5
  if (meta.hasPath) probability += 0.05
  if (meta.referenced) probability += 0.2
  return clamp01(probability)
}

function scoreSegment(segment, context) {
  if (segment.kind !== 'step') {
    return { prunable: false, probability: 1, tokens: 0, nodeCount: 0 }
  }
  let probability = 0
  let tokens = 0
  let nodeCount = 0
  for (const index of segment.indices) {
    const meta = context.metas[index]
    const line = context.linesBySeq.get(meta.seq)
    const lineProbability = finiteNumber(line?.reuseProbability)
    probability += lineProbability !== undefined ? clamp01(lineProbability) : ruleReuseProbability(meta, context)
    const lineTokens = finiteNumber(line?.tokens)
    tokens += lineTokens !== undefined ? Math.max(0, lineTokens) : meta.tokens
    nodeCount += 1
  }
  const balanced = Boolean(context.cuts && context.cuts[segment.startIdx] && context.cuts[segment.endIdx + 1])
  return {
    prunable: balanced && !segment.hasError,
    probability: nodeCount > 0 ? probability / nodeCount : 1,
    tokens,
    nodeCount,
  }
}

function collectWindows(segments, scored, options) {
  const windows = []
  let runStart = -1
  function flush(runFirst, runLast) {
    for (let first = runFirst; first <= runLast; first++) {
      let probabilitySum = 0
      let tokens = 0
      let nodeCount = 0
      for (let last = first; last <= runLast; last++) {
        if (!scored[last].prunable) break
        probabilitySum += scored[last].probability
        tokens += scored[last].tokens
        nodeCount += scored[last].nodeCount
        if (tokens <= 0) continue
        // The threshold is on the window MEAN, so a high-P unit can be followed by
        // low-P units that bring the mean back under tau: keep scanning.
        if (probabilitySum / (last - first + 1) > options.tau) continue
        if (nodeCount > options.maxNodes) break
        if (tokens > options.maxTokens) break
        windows.push({
          startIdx: segments[first].startIdx,
          endIdx: segments[last].endIdx,
          tokens,
        })
      }
    }
  }
  for (let index = 0; index <= segments.length; index++) {
    const prunable = index < segments.length && scored[index].prunable
    if (prunable && runStart < 0) runStart = index
    if (!prunable && runStart >= 0) {
      flush(runStart, index - 1)
      runStart = -1
    }
  }
  return windows
}

function buildSummary(module, shadowedSeqs, metas, extraLines) {
  const shadowed = new Set(shadowedSeqs)
  const signatures = []
  const edits = []
  const conclusions = []
  for (const meta of metas) {
    if (shadowed.has(meta.seq)) continue
    if (meta.type === 'assistant/message') {
      for (let index = 0; index < meta.toolNames.length; index++) {
        const signature = meta.toolNames[index] + '(' + shorten(meta.toolArgs[index] ?? '', 48) + ')'
        if (!signatures.includes(signature)) signatures.push(signature)
        const name = meta.toolNames[index]
        if (name === 'write' || name === 'edit') {
          const path = firstPath(meta.toolArgs[index])
          if (path && !edits.includes(path)) edits.push(path)
        }
      }
    }
    if (meta.type === 'tool/result' && !shadowed.has(meta.seq)) {
      if (meta.isError) conclusions.push('error: ' + shorten(meta.text, 100))
      else if (TEST_RESULT_RE.test(meta.text)) conclusions.push(shorten(meta.text, 100))
    }
  }
  const lines = []
  if (Array.isArray(extraLines)) {
    for (const line of extraLines) lines.push(line)
  }
  if (module === 'M2') {
    lines.unshift('Region GC checkpoint (M2): ' + shadowedSeqs.length + ' surface nodes, template summary.')
  }
  if (signatures.length > 0) {
    lines.push('Kept tool calls: ' + signatures.slice(-MAX_SUMMARY_ITEMS).join('; ') + '.')
  }
  if (edits.length > 0) {
    lines.push('Edited files: ' + edits.slice(-MAX_SUMMARY_ITEMS).join(', ') + '.')
  }
  if (conclusions.length > 0) {
    lines.push('Test/command conclusions: ' + conclusions.slice(0, 3).join(' | ') + '.')
  }
  lines.push('Original seq range: ' + shadowedSeqs[0] + '..' + shadowedSeqs[shadowedSeqs.length - 1] + '.')
  return lines.join('\n').slice(0, MAX_SUMMARY_CHARS)
}

function planM2(input, context, m2, keepRecentSteps) {
  const remainingSteps = resolveRemainingSteps(input)
  if (remainingSteps < m2.minRemainingSteps) return null
  if (!context.cuts) return null
  if (context.metas.length === 0) return null
  const maxNodes = Math.max(1, Math.floor(context.metas.length * m2.maxRegionRatio))
  const maxTokens = Math.max(1, Math.floor(context.totalTokens * m2.maxRegionRatio))
  const recentFrom = context.stepCount - keepRecentSteps
  const scored = context.segments.map((segment) => {
    const base = scoreSegment(segment, context)
    const recent = segment.kind === 'step' && segment.stepIndex >= recentFrom
    return { ...base, prunable: base.prunable && !recent }
  })
  const windows = collectWindows(context.segments, scored, { tau: m2.tauLineReuse, maxNodes, maxTokens })
  windows.sort((left, right) => right.tokens - left.tokens || left.startIdx - right.startIdx)
  for (const window of windows) {
    const nodeCount = window.endIdx - window.startIdx + 1
    const shadowedSeqs = context.surface.slice(window.startIdx, window.endIdx + 1)
    const summary = buildSummary('M2', shadowedSeqs, context.metas)
    const summaryTokens = Math.max(1, estimateTokens(summary))
    const deltaTokens = window.tokens - summaryTokens
    if (deltaTokens <= 0) continue
    const suffixTokens = sumTokens(context.metas, window.endIdx + 1, context.metas.length - 1)
    const netUSD = computeNetUSD(input.price, remainingSteps, deltaTokens, suffixTokens)
    return {
      module: 'M2',
      startSeq: shadowedSeqs[0],
      endSeq: shadowedSeqs[shadowedSeqs.length - 1],
      summary,
      shadowedTokenCount: window.tokens,
      deltaTokens,
      remainingSteps,
      netUSD,
      shadowedSeqs,
    }
  }
  return null
}

function classifyPhase(segment, fallbackPhase) {
  const argumentText = segment.toolArgs.join('\n')
  const names = segment.toolNames
  if (names.some((name) => name === 'write' || name === 'edit')) return 'edit'
  if (names.some((name) => name === 'bash' || name === 'run_code')) {
    return TEST_COMMAND_RE.test(argumentText) ? 'test' : 'execute'
  }
  if (names.some((name) => name === 'read')) return 'read'
  if (names.some((name) => name === 'glob' || name === 'grep' || name === 'web_search' || name === 'office')) return 'search'
  if (names.length > 0) return 'execute'
  if (segment.stepIndex <= 1) return 'setup'
  return PHASES.includes(fallbackPhase) ? fallbackPhase : 'read'
}

function planM3(input, context, m3, keepRecentSteps) {
  const steps = context.segments.filter((segment) => segment.kind === 'step')
  if (steps.length < m3.minStepsBefore) return null
  if (context.compactionsDone >= m3.maxCompactionsPerSession) return null
  if (!context.cuts) return null
  const phases = steps.map((step) => classifyPhase(step, input.phase))
  const candidates = []
  let start = 0
  for (let index = 1; index <= steps.length; index++) {
    const boundary = index === steps.length || phases[index] !== phases[start]
    if (!boundary) continue
    const end = index - 1
    const length = end - start + 1
    const closed = end < steps.length - 1
    const leavesRecent = end < steps.length - keepRecentSteps
    if (length >= m3.segmentSteps && closed && leavesRecent) {
      candidates.push({ start, end, length, phase: phases[start] })
    }
    start = index
  }
  candidates.sort((left, right) => right.length - left.length || left.start - right.start)
  for (const candidate of candidates) {
    let startIdx = steps[candidate.start].startIdx
    let endIdx = steps[candidate.end].endIdx
    while (startIdx <= endIdx && !context.cuts[startIdx]) startIdx += 1
    while (endIdx >= startIdx && !context.cuts[endIdx + 1]) endIdx -= 1
    if (startIdx > endIdx) continue
    if (startIdx === 0 && context.metas[startIdx] && context.metas[startIdx].type === 'system/message') continue
    const shadowedSeqs = context.surface.slice(startIdx, endIdx + 1)
    const shadowedTokens = sumTokens(context.metas, startIdx, endIdx)
    if (shadowedTokens <= 0) continue
    const stepsLabel = (candidate.start + 1) + '..' + (candidate.end + 1)
    const summary = buildSummary('M3', shadowedSeqs, context.metas, [
      'Subtask stack checkpoint (M3): phase ' + candidate.phase + ', steps ' + stepsLabel + '.',
    ])
    const summaryTokens = Math.max(1, estimateTokens(summary))
    const deltaTokens = shadowedTokens - summaryTokens
    if (deltaTokens <= 0) continue
    const remainingSteps = resolveRemainingSteps(input)
    const suffixTokens = sumTokens(context.metas, endIdx + 1, context.metas.length - 1)
    return {
      module: 'M3',
      startSeq: shadowedSeqs[0],
      endSeq: shadowedSeqs[shadowedSeqs.length - 1],
      summary,
      shadowedTokenCount: shadowedTokens,
      deltaTokens,
      remainingSteps,
      netUSD: computeNetUSD(input.price, remainingSteps, deltaTokens, suffixTokens),
      shadowedSeqs,
    }
  }
  return null
}

/**
 * Create a planner.
 * @param {{config?: any}} [options]
 * @returns {{plan: (input: any) => any|null}}
 */
export function createCompactionPlanner(options = {}) {
  const config = isPlainObject(options.config) ? options.config : {}
  const modules = isPlainObject(config.modules) ? config.modules : {}
  const m2 = { ...DEFAULT_M2, ...(isPlainObject(modules.M2) ? modules.M2 : {}) }
  const m3 = { ...DEFAULT_M3, ...(isPlainObject(modules.M3) ? modules.M3 : {}) }
  const keepRecentSteps = finiteNumber(modules.M2?.keepRecentSteps) !== undefined
    ? finiteNumber(modules.M2.keepRecentSteps)
    : (finiteNumber(m3.keepRecentSteps) !== undefined ? m3.keepRecentSteps : DEFAULT_KEEP_RECENT_STEPS)

  return {
    plan(input = {}) {
      const context = buildContext(input)
      if (!context.cuts || context.metas.length === 0) return null
      if (m2.enabled === true) {
        const plan = planM2(input, context, m2, keepRecentSteps)
        if (plan) return plan
      }
      if (m3.enabled === true) return planM3(input, context, m3, keepRecentSteps)
      return null
    },
  }
}
