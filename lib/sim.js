/**
 * Offline report over CostPilot NDJSON ledgers. No imports from DSH.
 * @module dsh-costpilot/lib/sim
 */
import fs from 'node:fs'
import path from 'node:path'

/** Read every JSONL record of one session ledger. */
export function readSessionRecords(dir, sessionId) {
  const file = path.join(dir, sessionId + '.jsonl')
  if (!fs.existsSync(file)) return []
  const records = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try { records.push(JSON.parse(trimmed)) } catch {}
  }
  return records
}

/** List session ids that have a ledger file. */
export function listSessions(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => name.slice(0, -'.jsonl'.length))
    .sort()
}

/**
 * Aggregate raw ledger records into the shared LedgerSummary shape.
 * Tolerant of unknown record kinds and partial fields.
 */
export function summarizeRecords(records, sessionId = 'unknown') {
  const summary = {
    sessionId,
    usd: 0,
    cost: 0,
    currency: 'CNY',
    confidence: 'provider',
    tokens: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    counts: { calls: 0, turns: 0, steps: 0, tools: 0 },
    byModule: {},
    guard: { count: 0, lastReason: undefined },
    metrics: { count: 0, lastReason: undefined },
  }
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    const kind = record.kind
    if (kind === 'llm_call') {
      summary.counts.calls += 1
      if (typeof record.currency === 'string' && record.currency.length === 3) summary.currency = record.currency
      if (Number.isFinite(record.usd)) summary.usd += record.usd
      const usage = record.usage ?? {}
      const read = Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0
      const write = Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0
      const input = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0
      const output = Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0
      summary.tokens.cacheRead += read
      summary.tokens.cacheWrite += write
      summary.tokens.output += output
      summary.tokens.uncachedInput += Math.max(0, input - read - write)
      if (record.confidence === 'unknown') summary.confidence = 'unknown'
      else if (record.confidence === 'heuristic' && summary.confidence === 'provider') summary.confidence = 'heuristic'
    } else if (kind === 'tool_call' || kind === 'tool_result') {
      if (kind === 'tool_call') summary.counts.tools += 1
    } else if (kind === 'turn') {
      if (record.extra?.event === 'turn/start') summary.counts.turns += 1
    } else if (kind === 'step' || record.extra?.event === 'step/start') {
      summary.counts.steps += 1
    } else if (kind === 'mutation') {
      const module = record.extra?.module ?? record.module ?? 'unknown'
      const bucket = summary.byModule[module] ?? { usd: 0, removedTokens: 0, addedTokens: 0, count: 0 }
      bucket.removedTokens += Number(record.extra?.removedTokens ?? 0)
      bucket.addedTokens += Number(record.extra?.addedTokens ?? 0)
      bucket.count += Number(record.extra?.count ?? 1)
      bucket.usd += Number(record.usd ?? 0)
      summary.byModule[module] = bucket
    } else if (kind === 'guard') {
      const action = record.extra?.action ?? 'warn'
      if (action === 'warn' || action === 'stop') {
        summary.guard.count += 1
        summary.guard.lastReason = record.extra?.reason ?? summary.guard.lastReason
      } else {
        summary.metrics.count += 1
        summary.metrics.lastReason = record.extra?.reason ?? summary.metrics.lastReason
      }
    }
  }
  summary.cost = summary.usd
  for (const bucket of Object.values(summary.byModule)) bucket.cost = bucket.usd
  return summary
}

/** Currency symbol used in human-readable reports. */
export function currencySymbol(currency) {
  return currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : (currency || 'CNY') + ' '
}

/** Aggregate every session ledger in a directory into one summary. */
export function summarizeStore(dir, sessionId) {
  if (sessionId) return summarizeRecords(readSessionRecords(dir, sessionId), sessionId)
  const ids = listSessions(dir)
  if (ids.length === 0) return undefined
  const all = ids.flatMap((id) => readSessionRecords(dir, id))
  const summary = summarizeRecords(all, 'all(' + ids.length + ' sessions)')
  return summary
}

/** Render a compact text report for the CLI. */
export function renderReport(dir, { sessionId, json = false } = {}) {
  if (json) {
    const data = sessionId
      ? summarizeRecords(readSessionRecords(dir, sessionId), sessionId)
      : { sessions: listSessions(dir).map((id) => summarizeRecords(readSessionRecords(dir, id), id)) }
    return JSON.stringify(data, null, 2)
  }
  const ids = sessionId ? [sessionId] : listSessions(dir)
  if (ids.length === 0) return 'CostPilot: no ledger found in ' + dir
  const lines = []
  let totalUSD = 0
  let totalRemoved = 0
  for (const id of ids) {
    const summary = summarizeRecords(readSessionRecords(dir, id), id)
    totalUSD += summary.usd
    const removed = Object.values(summary.byModule).reduce((sum, bucket) => sum + (bucket.removedTokens || 0), 0)
    totalRemoved += removed
    lines.push([
      id,
      'cost=' + currencySymbol(summary.currency) + summary.cost.toFixed(4),
      'calls=' + summary.counts.calls,
      'turns=' + summary.counts.turns,
      'tools=' + summary.counts.tools,
      'm1_removed=' + Math.round(removed) + 'tok',
      'guard=' + summary.guard.count,
    ].join(' '))
  }
  lines.push('---')
  const currency = ids.length > 0 ? summarizeRecords(readSessionRecords(dir, ids[0]), ids[0]).currency : 'CNY'
  lines.push('sessions=' + ids.length + ' total_cost=' + currencySymbol(currency) + totalUSD.toFixed(4) + ' total_m1_removed=' + Math.round(totalRemoved) + 'tok')
  return lines.join('\n')
}

/**
 * Static savings estimate for the /costpilot simulate command.
 * No model call: removed tokens are valued at the route's cache-read price for
 * the estimated remaining calls (design section 5.2).
 */
export function estimateSavings(summary, { price, remainingCalls = 6 } = {}) {
  const cacheRead = Number.isFinite(price?.cacheRead) ? price.cacheRead : 0
  const byModule = {}
  let total = 0
  for (const [module, bucket] of Object.entries(summary?.byModule ?? {})) {
    const removed = Number.isFinite(bucket.removedTokens) ? bucket.removedTokens : 0
    const saved = removed * cacheRead / 1e6 * Math.max(1, remainingCalls)
    byModule[module] = { removedTokens: removed, estimatedSaved: saved, count: bucket.count ?? 0 }
    total += saved
  }
  return {
    currency: summary?.currency ?? 'CNY',
    remainingCalls,
    byModule,
    totalEstimatedSaved: total,
    actualCost: summary?.cost ?? summary?.usd ?? 0,
  }
}
