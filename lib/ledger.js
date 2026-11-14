/**
 * CostLedger: the single accounting authority for one session (design section 5.1).
 *
 * Consumes DSH session/event records, turns provider usage into normalized token
 * buckets plus USD, attributes tool and mutation activity, and appends CostEvent
 * records to the store. Only event.type and event.data are read; unknown event
 * types are ignored.
 *
 * Usage semantics: request/header caches the route because it is emitted before
 * assistant/message (SPEC.md). assistant/message then prices against that cached
 * route. Unpriced routes still record tokens, with confidence 'unknown' and USD 0.
 *
 * @module dsh-costpilot/lib/ledger
 */
import { LEDGER_VERSION, CONFIDENCE, GUARD_ACTION, normalizeUsage, hashKey } from './contracts.js'
import { resolvePrice, costOfUsage, roundUSD } from './pricing.js'
import { estimateMessage, estimateToolResult } from './estimate.js'

const PER_MILLION = 1e6

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function roundCount(value) {
  return Math.max(0, Math.round(toNumber(value)))
}

function routeOf(value) {
  if (!isPlainObject(value)) return null
  if (typeof value.provider !== 'string' || typeof value.model !== 'string') return null
  const route = { provider: value.provider, model: value.model }
  if (typeof value.reasoningEffort === 'string') route.reasoningEffort = value.reasoningEffort
  return route
}

function hasReportedUsage(usage) {
  if (!isPlainObject(usage)) return false
  return ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']
    .some((key) => typeof usage[key] === 'number' && Number.isFinite(usage[key]))
}

function normalizedUsagePayload(rawUsage, semantics) {
  const buckets = normalizeUsage(isPlainObject(rawUsage) ? rawUsage : {}, semantics)
  const inputTokens = buckets.uncachedInput + buckets.cacheRead + buckets.cacheWrite
  const payload = {
    inputTokens,
    outputTokens: buckets.output,
    cacheReadTokens: buckets.cacheRead,
    cacheWriteTokens: buckets.cacheWrite,
    totalTokens: inputTokens + buckets.output,
    uncachedInput: buckets.uncachedInput,
    cacheRead: buckets.cacheRead,
    cacheWrite: buckets.cacheWrite,
    output: buckets.output,
  }
  if (Number.isFinite(rawUsage?.reasoningTokens)) payload.reasoningTokens = rawUsage.reasoningTokens
  return payload
}

/**
 * Create a session ledger.
 * @param {{sessionId: string, store?: any, config?: any}} options
 * @returns {{sample: Function, noteRoute: Function, recordMutation: Function, recordGuard: Function, summary: Function, flush: Function, events: Function}}
 */
export function createLedger(options = {}) {
  const sessionId = options?.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new TypeError('createLedger requires { sessionId }')
  const store = options?.store ?? null
  const config = options?.config ?? {}
  const pricingConfig = isPlainObject(config.pricing) ? config.pricing : {}
  const peakPricing = isPlainObject(config.peakPricing) ? config.peakPricing : undefined
  const semantics = config.usageSemantics === 'exclusive' ? 'exclusive' : 'inclusive'
  const currency = typeof config.currency === 'string' ? config.currency : 'CNY'

  let currentTurn = null
  let currentStep = null
  let lastRoute = null
  let lastSeries = { startsSeries: true, at: null, reason: null }
  const pendingCalls = new Map()
  const _events = []

  function eventTime(event) {
    return Number.isFinite(event?.time) ? event.time : Date.now()
  }

  function eventSeq(event) {
    return Number.isFinite(event?.seq) ? event.seq : undefined
  }

  /**
   * Recover the current route when no request/header event was sampled (plugin
   * attached mid-session, or a test harness that only emits some events).
   * Prefers the Session.requestHeader() API documented by DSH, then falls back
   * to scanning the session log for the latest request/header event.
   */
  function routeFromSession(session) {
    if (!isPlainObject(session)) return null
    try {
      if (typeof session.requestHeader === 'function') {
        const header = session.requestHeader()
        const route = routeOf(header?.config)
        if (route) return route
      }
    } catch {
      // A session without a usable header is not an error for the ledger.
    }
    const logs = []
    if (Array.isArray(session.appended)) logs.push(session.appended)
    if (typeof session.ownEvents === 'function') {
      try {
        const own = session.ownEvents()
        if (Array.isArray(own)) logs.push(own)
      } catch {
        // Ignore: fall back to whatever log we already have.
      }
    }
    for (const log of logs) {
      for (let index = log.length - 1; index >= 0; index--) {
        const candidate = log[index]
        if (candidate && candidate.type === 'request/header') {
          const candidateData = isPlainObject(candidate.data) ? candidate.data : {}
          const route = routeOf(candidateData.header?.config) ?? routeOf(candidateData.config)
          if (route) return route
        }
      }
    }
    return null
  }

  function emit(record) {
    const full = {
      v: LEDGER_VERSION,
      kind: record.kind,
      sessionId,
      ts: Number.isFinite(record.ts) ? record.ts : Date.now(),
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === 'kind' || key === 'ts' || value === undefined) continue
      full[key] = value
    }
    _events.push(full)
    // Persist immediately: store.append is synchronous, so a sampled record is
    // durable even if the process exits before any explicit flush.
    if (store && typeof store.append === 'function') store.append(sessionId, full)
    return full
  }

  function addUsage(target, usage, usageSemantics) {
    if (!isPlainObject(usage)) return
    const normalized = Number.isFinite(usage.uncachedInput) && Number.isFinite(usage.cacheRead) &&
      Number.isFinite(usage.cacheWrite) && Number.isFinite(usage.output)
      ? { uncachedInput: usage.uncachedInput, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output }
      : normalizeUsage(usage, usageSemantics)
    target.uncachedInput += toNumber(normalized.uncachedInput)
    target.cacheRead += toNumber(normalized.cacheRead)
    target.cacheWrite += toNumber(normalized.cacheWrite)
    target.output += toNumber(normalized.output)
  }

  /**
   * Durability barrier. Records are appended synchronously as they are sampled,
   * so this is a no-op for the NDJSON backend (kept for a future buffered /
   * batched backend and for explicit flush points such as turn/end).
   * @returns {{flushed: number, persisted: boolean, records: number}}
   */
  function flush() {
    if (!store || typeof store.append !== 'function') return { flushed: 0, persisted: false, records: _events.length }
    if (typeof store.flush === 'function') store.flush()
    return { flushed: 0, persisted: true, records: _events.length }
  }

  /** Per-(turn,step) provider usage samples: attempt and settlement share one slot. */
  const callSamples = new Map()

  /** Provider usage from the event data or its committed stream records. */
  function usageFromEventData(data) {
    if (hasReportedUsage(data?.usage)) return data.usage
    const stream = Array.isArray(data?.stream) ? data.stream : []
    for (let index = stream.length - 1; index >= 0; index--) {
      const record = stream[index]
      const chunk = record?.chunk ?? record
      if (chunk && chunk.type === 'usage' && hasReportedUsage(chunk.usage)) return chunk.usage
      if (isPlainObject(record?.usage) && hasReportedUsage(record.usage)) return record.usage
    }
    return undefined
  }

  /**
   * Record one assistant usage sample with replacement semantics: an attempt and
   * a later settlement for the same (turn, step) share a slot, so retries and
   * aborted attempts are billed as deltas rather than double counted.
   */
  function emitCallSample({ route, usage, ts, seq, turn, step, confidenceExtra }) {
    const price = resolvePrice({ pricing: pricingConfig, peakPricing }, route, ts)
    const normalized = normalizeUsage(usage, semantics)
    const usd = costOfUsage(price, usage, semantics).usd
    const key = String(turn ?? '-') + ':' + String(step ?? '-')
    const previous = callSamples.get(key)
    const delta = previous === undefined ? normalized : {
      uncachedInput: normalized.uncachedInput - previous.normalized.uncachedInput,
      cacheRead: normalized.cacheRead - previous.normalized.cacheRead,
      cacheWrite: normalized.cacheWrite - previous.normalized.cacheWrite,
      output: normalized.output - previous.normalized.output,
    }
    const deltaUSD = previous === undefined ? usd : usd - previous.usd
    callSamples.set(key, { normalized, usd })
    const zero = delta.uncachedInput === 0 && delta.cacheRead === 0 && delta.cacheWrite === 0
      && delta.output === 0 && Math.abs(deltaUSD) < 1e-12
    if (zero) return []
    const deltaRaw = {
      inputTokens: delta.uncachedInput,
      cacheReadTokens: delta.cacheRead,
      cacheWriteTokens: delta.cacheWrite,
      outputTokens: delta.output,
    }
    const confidence = price.source === 'unknown'
      ? CONFIDENCE.UNKNOWN
      : (confidenceExtra ?? CONFIDENCE.PROVIDER)
    return [emit({
      kind: 'llm_call',
      ts,
      currency,
      seq,
      turn,
      step,
      route: route ?? undefined,
      usage: normalizedUsagePayload(deltaRaw, 'exclusive'),
      usd: roundUSD(deltaUSD),
      cost: roundUSD(deltaUSD),
      confidence,
      ...(previous !== undefined ? { extra: { replaced: true } } : {}),
    })]
  }

  function sample(session, event) {
    if (!isPlainObject(event) || typeof event.type !== 'string') return []
    const data = isPlainObject(event.data) ? event.data : {}
    const ts = eventTime(event)
    const seq = eventSeq(event)
    const records = []

    const turn = () => Number.isFinite(data.turn) ? data.turn : (Number.isFinite(currentTurn) ? currentTurn : undefined)
    const step = () => Number.isFinite(data.step) ? data.step : (Number.isFinite(currentStep) ? currentStep : undefined)

    switch (event.type) {
      case 'request/header': {
        const header = isPlainObject(data.header) ? data.header : {}
        const route = routeOf(header.config) ?? routeOf(data.config)
        if (route) lastRoute = route
        lastSeries = { startsSeries: data.startsSeries === true, at: ts, reason: typeof data.reason === 'string' ? data.reason : null }
        // Headers are route evidence, not billable events: nothing is recorded.
        return records
      }
      case 'assistant/message': {
        const route = lastRoute ?? routeFromSession(session)
        if (route) lastRoute = route
        const usage = usageFromEventData(data)
        if (usage !== undefined) {
          records.push(...emitCallSample({
            route, usage, ts, seq, turn: turn(), step: step(),
            confidenceExtra: CONFIDENCE.PROVIDER,
          }))
        } else {
          // No provider usage: estimate from the message and mark it heuristic.
          const estimated = estimateMessage(data.message ?? {})
          const synthetic = { inputTokens: 0, outputTokens: estimated }
          const price = resolvePrice({ pricing: pricingConfig, peakPricing }, route, ts)
          records.push(emit({
            kind: 'llm_call',
            ts,
            currency,
            seq,
            turn: turn(),
            step: step(),
            route: route ?? undefined,
            usage: normalizedUsagePayload(synthetic, 'exclusive'),
            usd: costOfUsage(price, synthetic, 'exclusive').usd,
            cost: costOfUsage(price, synthetic, 'exclusive').usd,
            confidence: price.source === 'unknown' ? CONFIDENCE.UNKNOWN : CONFIDENCE.HEURISTIC,
          }))
        }
        break
      }
      case 'assistant/attempt': {
        // A retried/aborted attempt is still billed; settlement replaces its slot.
        const route = lastRoute ?? routeFromSession(session)
        if (route) lastRoute = route
        const usage = usageFromEventData(data)
        if (usage !== undefined) {
          records.push(...emitCallSample({
            route, usage, ts, seq, turn: turn(), step: step(),
            confidenceExtra: CONFIDENCE.PROVIDER,
          }))
        }
        break
      }
      case 'llm/retry-started': {
        // The retried attempt starts a fresh sample slot.
        const key = String(data.turn ?? '-') + ':' + String(data.step ?? '-')
        callSamples.delete(key)
        break
      }
      case 'tool/call': {
        const callId = data.callId === undefined || data.callId === null ? null : String(data.callId)
        const argsText = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? null)
        const argsHash = hashKey(argsText)
        const bytesIn = Buffer.byteLength(argsText, 'utf8')
        const name = typeof data.name === 'string' ? data.name : 'unknown'
        if (callId !== null) pendingCalls.set(callId, { name, argsHash })
        records.push(emit({
          kind: 'tool_call',
          ts,
          seq,
          turn: turn(),
          step: step(),
          extra: { name, callId, argsHash, bytesIn },
        }))
        break
      }
      case 'tool/result': {
        const message = isPlainObject(data.message) ? data.message : {}
        const callId = message.toolCallId === undefined || message.toolCallId === null ? null : String(message.toolCallId)
        const call = callId !== null ? pendingCalls.get(callId) : undefined
        if (callId !== null) pendingCalls.delete(callId)
        const isError = message.isError === true || Boolean(data.error)
        records.push(emit({
          kind: 'tool_result',
          ts,
          seq,
          turn: turn(),
          step: step(),
          extra: {
            callId,
            name: call ? call.name : null,
            isError,
            estimatedTokens: estimateToolResult(message.content),
          },
        }))
        break
      }
      case 'turn/start': {
        currentTurn = Number.isFinite(data.turn) ? data.turn : currentTurn
        currentStep = null
        records.push(emit({ kind: 'turn', ts, seq, turn: currentTurn ?? undefined, extra: { phase: 'start', event: 'turn/start' } }))
        break
      }
      case 'turn/end': {
        currentTurn = Number.isFinite(data.turn) ? data.turn : currentTurn
        records.push(emit({
          kind: 'turn',
          ts,
          seq,
          turn: currentTurn ?? undefined,
          extra: { phase: 'end', event: 'turn/end', reason: typeof data.reason === 'string' ? data.reason : null },
        }))
        // A turn boundary is a durability boundary.
        flush()
        break
      }
      case 'step/start': {
        currentStep = Number.isFinite(data.step) ? data.step : currentStep
        records.push(emit({ kind: 'turn', ts, seq, turn: turn(), step: currentStep ?? undefined, extra: { phase: 'step_start', event: 'step/start' } }))
        break
      }
      case 'step/end': {
        records.push(emit({ kind: 'turn', ts, seq, turn: turn(), step: step(), extra: { phase: 'step_end', event: 'step/end' } }))
        break
      }
      case 'compaction/summary': {
        const provider = typeof data.provider === 'string' ? data.provider : (lastRoute ? lastRoute.provider : null)
        const model = typeof data.model === 'string' ? data.model : (lastRoute ? lastRoute.model : null)
        const route = routeOf({ provider, model })
        if (hasReportedUsage(data.usage)) {
          const price = resolvePrice({ pricing: pricingConfig }, route)
          records.push(emit({
            kind: 'llm_call',
            ts,
            currency,
            seq,
            turn: turn(),
            step: step(),
            route: route ?? undefined,
            usage: normalizedUsagePayload(data.usage, semantics),
            usd: costOfUsage(price, data.usage, semantics).usd,
            cost: costOfUsage(price, data.usage, semantics).usd,
            confidence: price.source === 'unknown' ? CONFIDENCE.UNKNOWN : CONFIDENCE.PROVIDER,
            extra: { purpose: 'compaction' },
          }))
        }
        records.push(emit({
          kind: 'session',
          ts,
          seq,
          turn: turn(),
          step: step(),
          extra: {
            phase: 'compaction',
            shadowedTokenCount: Number.isFinite(data.shadowedTokenCount) ? data.shadowedTokenCount : null,
            provider,
            model,
          },
        }))
        break
      }
      case 'model/selection': {
        const selection = routeOf(data) ?? routeOf(data.selection)
        records.push(emit({
          kind: 'session',
          ts,
          seq,
          turn: turn(),
          step: step(),
          extra: {
            phase: 'model_selection',
            provider: selection ? selection.provider : null,
            model: selection ? selection.model : null,
            reasoningEffort: selection && selection.reasoningEffort ? selection.reasoningEffort : null,
          },
        }))
        break
      }
      default:
        // Unknown session event types are ignored by design.
        return records
    }
    return records
  }

  /** Override the cached route (used by route changes before the next header arrives). */
  function noteRoute(route) {
    const resolved = routeOf(route)
    if (resolved) lastRoute = resolved
    return lastRoute
  }

  /** Record a context mutation (M1/M2/... ) and its predicted token delta. */
  function recordMutation(payload = {}) {
    const {
      module: moduleValue,
      removedTokens: removedValue,
      addedTokens: addedValue,
      pointer: pointerValue,
      count: countValue,
      usd: usdValue,
      ts: tsValue,
      turn: turnValue,
      step: stepValue,
      ...rest
    } = payload
    const module = typeof moduleValue === 'string' ? moduleValue : 'unknown'
    const removedTokens = roundCount(removedValue)
    const addedTokens = roundCount(addedValue)
    const netTokens = Math.max(0, removedTokens - addedTokens)
    const count = Number.isFinite(countValue) && countValue > 0 ? Math.round(countValue) : 1
    const price = resolvePrice({ pricing: pricingConfig, peakPricing }, lastRoute, Date.now())
    const usd = Number.isFinite(usdValue)
      ? roundUSD(usdValue)
      : roundUSD(netTokens * price.cacheRead / PER_MILLION)
    return emit({
      kind: 'mutation',
      ts: Number.isFinite(tsValue) ? tsValue : Date.now(),
      turn: Number.isFinite(turnValue) ? turnValue : (Number.isFinite(currentTurn) ? currentTurn : undefined),
      step: Number.isFinite(stepValue) ? stepValue : (Number.isFinite(currentStep) ? currentStep : undefined),
      usd,
      confidence: CONFIDENCE.HEURISTIC,
      extra: {
        module,
        removedTokens,
        addedTokens,
        netTokens,
        pointer: pointerValue ?? null,
        count,
        priceSource: price.source,
        ...rest,
      },
    })
  }

  /** Record a guard decision (M9) with action and reason. */
  function recordGuard(payload = {}) {
    const { action, reason, ts, turn: recordTurnValue, step: recordStepValue, ...rest } = payload
    return emit({
      kind: 'guard',
      ts: Number.isFinite(ts) ? ts : Date.now(),
      turn: Number.isFinite(recordTurnValue) ? recordTurnValue : (Number.isFinite(currentTurn) ? currentTurn : undefined),
      step: Number.isFinite(recordStepValue) ? recordStepValue : (Number.isFinite(currentStep) ? currentStep : undefined),
      extra: {
        action: typeof action === 'string' ? action : GUARD_ACTION.NONE,
        reason: typeof reason === 'string' ? reason : '',
        ...rest,
      },
    })
  }

  /** Aggregate the current session into a contracts.LedgerSummary. */
  function summary() {
    let usd = 0
    let confidence = 'provider'
    const tokens = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
    const counts = { calls: 0, turns: 0, steps: 0, tools: 0 }
    const byModule = {}
    const guard = { count: 0, lastReason: undefined }
    const metrics = { count: 0, lastReason: undefined }

    for (const event of _events) {
      if (event.kind === 'llm_call') {
        counts.calls += 1
        usd += toNumber(event.usd)
        addUsage(tokens, event.usage, semantics)
        if (event.confidence === 'unknown') confidence = 'unknown'
        else if (event.confidence === 'heuristic' && confidence === 'provider') confidence = 'heuristic'
      } else if (event.kind === 'tool_call') {
        counts.tools += 1
      } else if (event.kind === 'turn') {
        const phase = event.extra ? event.extra.phase : null
        if (phase === 'start') counts.turns += 1
        else if (phase === 'step_start') counts.steps += 1
      } else if (event.kind === 'guard') {
        const action = event.extra && typeof event.extra.action === 'string' ? event.extra.action : 'warn'
        // Metrics (nudge/toolset/observe/audit) are not guard warnings.
        if (action === 'warn' || action === 'stop') {
          guard.count += 1
          if (event.extra && typeof event.extra.reason === 'string') guard.lastReason = event.extra.reason
        } else {
          metrics.count += 1
          if (event.extra && typeof event.extra.reason === 'string') metrics.lastReason = event.extra.reason
        }
      } else if (event.kind === 'mutation') {
        const module = event.extra && typeof event.extra.module === 'string' ? event.extra.module : 'unknown'
        if (!byModule[module]) byModule[module] = { usd: 0, removedTokens: 0, addedTokens: 0, count: 0 }
        const entry = byModule[module]
        entry.usd = roundUSD(entry.usd + toNumber(event.usd))
        entry.removedTokens += toNumber(event.extra ? event.extra.removedTokens : 0)
        entry.addedTokens += toNumber(event.extra ? event.extra.addedTokens : 0)
        entry.count += event.extra && Number.isFinite(event.extra.count) ? event.extra.count : 1
      }
    }

    const amount = roundUSD(usd)
    // `usd` keeps the historical field name for compatibility; `cost`/`currency`
    // are the currency-aware names consumers should use (CNY by default).
    return { sessionId, usd: amount, cost: amount, currency, tokens, counts, byModule, confidence, guard, metrics }
  }

  /** Snapshot of the emitted events (oldest first). */
  function events() {
    return _events.slice()
  }

  return { sample, noteRoute, recordMutation, recordGuard, summary, flush, events }
}