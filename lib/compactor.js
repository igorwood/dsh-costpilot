/**
 * Compaction transaction writer for dsh-costpilot M2/M3. Dependency-free.
 *
 * Writes the exact DSH compaction protocol (verified against
 * dsh-compaction-basic/lib/index.js and dsh-compaction/lib/index.js):
 *
 *   1. compaction/start   { compactionId, turn }
 *   2. compaction/summary { compactionId, summary: ContentBlock[], shadowedRange, shadowedSeqs, shadowedTokenCount, provider, model }
 *   3. user/message       checkpoint message with source.kind = 'compact-checkpoint'
 *                         appended with { surfaceOp: { op: 'replace', startSeq, endSeq },
 *                                        sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs] }
 *   4. compaction/end     { compactionId, turn } (with error string on failure)
 *
 * The surface range is validated against the current model-visible surface:
 * every shadowed seq must be an exact current surface node and both cuts must be
 * tool-pairing balanced. If the durable log shows an unmatched compaction/start
 * (a later session/end-seed proves a stale process lifecycle), run returns
 * { ok: false, error: 'busy' } and writes nothing.
 *
 * @module dsh-costpilot/lib/compactor
 */
import { randomUUID } from 'node:crypto'

const SURFACE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'
const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'
const CHECKPOINT_ID_PREFIX = 'costpilot-checkpoint-'
const COMPACTION_ID_PREFIX = 'costpilot-'

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function seqOf(event) {
  const seq = finiteNumber(event?.seq)
  return seq !== undefined ? seq : -1
}

function sortBySeq(events) {
  return events.slice().sort((left, right) => seqOf(left) - seqOf(right))
}

function listSessionEvents(session) {
  if (!session) return []
  try {
    if (typeof session.ownEvents === 'function') {
      const own = session.ownEvents()
      if (Array.isArray(own)) return [...own]
    }
  } catch {
    // Fall through.
  }
  if (Array.isArray(session.appended)) return [...session.appended]
  try {
    if (typeof session.snapshotEvents === 'function') {
      const snapshot = session.snapshotEvents()
      if (Array.isArray(snapshot)) return [...snapshot]
    }
  } catch {
    // No readable log.
  }
  return []
}

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

function surfaceFor(session, events) {
  const surfaceNodes = session?.surface?.nodes
  if (Array.isArray(surfaceNodes)) return [...surfaceNodes]
  return foldSurface(events)
}

function buildEventLookup(events, session) {
  const bySeq = new Map()
  for (const event of events) {
    const seq = seqOf(event)
    if (seq >= 0) bySeq.set(seq, event)
  }
  return function getEvent(seq) {
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
}

function toolCallCount(event) {
  if (!event || event.type !== 'assistant/message') return 0
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return 0
  let count = 0
  for (const block of content) {
    if (block && (block.type === 'tool-call' || block.type === 'tool_use')) count += 1
  }
  return count
}

function toolCallDelta(event) {
  if (!event) return 0
  if (event.type === 'assistant/message') return toolCallCount(event)
  if (event.type === 'tool/result') return -1
  return 0
}

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

/** Recover durable lock/turn state from the log tail (dsh-compaction-basic logic). */
function inspectState(events) {
  let openTurn = null
  let openTurnKnown = false
  let unmatchedStart
  let compactionKnown = false
  let latestEndSeedSeq
  let lastSeq = -1
  for (const event of events) {
    const seq = seqOf(event)
    if (seq > lastSeq) lastSeq = seq
  }
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') {
      latestEndSeedSeq = seqOf(event)
    }
    if (!compactionKnown) {
      if (event.type === 'compaction/start') {
        unmatchedStart = event
        compactionKnown = true
      } else if (event.type === 'compaction/end') {
        compactionKnown = true
      }
    }
    if (!openTurnKnown) {
      if (event.type === 'turn/start') {
        const turn = finiteNumber(event.data?.turn)
        openTurn = turn !== undefined ? turn : null
        openTurnKnown = true
      } else if (event.type === 'turn/end') {
        openTurnKnown = true
      }
    }
    if (openTurnKnown && compactionKnown && latestEndSeedSeq !== undefined) break
  }
  const stale = unmatchedStart !== undefined && latestEndSeedSeq !== undefined && latestEndSeedSeq > seqOf(unmatchedStart)
  return {
    busy: unmatchedStart !== undefined && !stale,
    openTurn,
    lastSeq,
  }
}

function normalizeSummaryBlocks(summary) {
  if (Array.isArray(summary)) {
    const blocks = []
    for (const block of summary) {
      if (isPlainObject(block) && typeof block.type === 'string') {
        blocks.push(block)
      } else if (typeof block === 'string' && block.length > 0) {
        blocks.push({ type: 'text', text: block })
      }
    }
    return blocks
  }
  if (typeof summary === 'string' && summary.length > 0) {
    return [{ type: 'text', text: summary }]
  }
  return []
}

function buildCheckpointMessage(compactionId, summaryBlocks) {
  return {
    id: CHECKPOINT_ID_PREFIX + compactionId,
    role: 'user',
    content: [
      { type: 'text', text: CHECKPOINT_PREAMBLE + '\n\n' + SUMMARY_OPEN_TAG },
      ...summaryBlocks,
      { type: 'text', text: SUMMARY_CLOSE_TAG },
    ],
    source: { kind: 'compact-checkpoint', compactionId },
  }
}

function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function uniqueSeqs(values) {
  const seen = new Set()
  const out = []
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function validatePlan(plan) {
  if (!isPlainObject(plan)) return 'invalid-plan'
  if (!Number.isSafeInteger(plan.startSeq) || !Number.isSafeInteger(plan.endSeq)) return 'invalid-plan'
  if (plan.startSeq < 0 || plan.endSeq < plan.startSeq) return 'invalid-plan'
  if (normalizeSummaryBlocks(plan.summary).length === 0) return 'invalid-plan'
  if (finiteNumber(plan.shadowedTokenCount) === undefined || plan.shadowedTokenCount < 0) return 'invalid-plan'
  return null
}

/**
 * Create a compactor.
 * @param {{config?: any, generateId?: (context: {sessionId?: string, turn?: number|null, seq: number}) => string}} [options]
 * @returns {{run: (plan: any, session: any) => Promise<{ok: true} | {ok: false, error: string}>}}
 */
export function createCompactor(options = {}) {
  const config = isPlainObject(options.config) ? options.config : {}
  const prefix = typeof config.compactionIdPrefix === 'string' && config.compactionIdPrefix.length > 0
    ? config.compactionIdPrefix
    : COMPACTION_ID_PREFIX
  const generateId = typeof options.generateId === 'function'
    ? options.generateId
    : () => prefix + randomUUID()

  async function run(plan, session) {
    if (!session || typeof session.append !== 'function') return { ok: false, error: 'invalid-session' }
    const events = sortBySeq(listSessionEvents(session))
    const state = inspectState(events)
    if (state.busy) return { ok: false, error: 'busy' }
    const invalid = validatePlan(plan)
    if (invalid) return { ok: false, error: invalid }

    const surface = surfaceFor(session, events)
    const getEvent = buildEventLookup(events, session)
    const startIndex = surface.indexOf(plan.startSeq)
    const endIndex = surface.indexOf(plan.endSeq)
    if (startIndex < 0 || endIndex < startIndex) return { ok: false, error: 'invalid-range' }
    const cuts = pairingCuts(surface, getEvent)
    if (!cuts || !cuts[startIndex] || !cuts[endIndex + 1]) return { ok: false, error: 'invalid-range' }
    const shadowedSeqs = surface.slice(startIndex, endIndex + 1)
    if (shadowedSeqs.length === 0) return { ok: false, error: 'invalid-range' }
    if (startIndex === 0) {
      const first = getEvent(shadowedSeqs[0])
      if (first && first.type === 'system/message') return { ok: false, error: 'invalid-range' }
    }

    const summaryBlocks = normalizeSummaryBlocks(plan.summary)
    const shadowedTokenCount = plan.shadowedTokenCount
    // The persisted summary types provider/model as strings; a template summary
    // bills no model call, so record empty strings rather than null.
    const provider = typeof plan.provider === 'string' ? plan.provider : ''
    const model = typeof plan.model === 'string' ? plan.model : ''
    const compactionId = String(generateId({
      sessionId: session?.id,
      turn: state.openTurn,
      seq: state.lastSeq + 1,
    }))
    const turn = state.openTurn

    let startEvent
    try {
      startEvent = session.append('compaction/start', { compactionId, turn })
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }

    try {
      const summaryEvent = session.append('compaction/summary', {
        compactionId,
        summary: summaryBlocks,
        shadowedRange: { start: plan.startSeq, end: plan.endSeq },
        shadowedSeqs,
        shadowedTokenCount,
        provider,
        model,
      })
      const checkpointMessage = buildCheckpointMessage(compactionId, summaryBlocks)
      const fallbackSeq = state.lastSeq + 1
      const sourceEventSeqs = uniqueSeqs([
        seqOf(startEvent) >= 0 ? seqOf(startEvent) : fallbackSeq,
        seqOf(summaryEvent) >= 0 ? seqOf(summaryEvent) : fallbackSeq + 1,
        ...shadowedSeqs,
      ])
      session.append('user/message', checkpointMessage, {
        surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
        sourceEventSeqs,
      })
      session.append('compaction/end', { compactionId, turn })
      return { ok: true }
    } catch (error) {
      const message = errorMessage(error)
      try {
        session.append('compaction/end', { compactionId, turn, error: message })
      } catch {
        // The durable lock may already be unusable; report the original failure.
      }
      return { ok: false, error: message }
    }
  }

  return { run }
}
