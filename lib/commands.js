/**
 * /cost human command. Rendered outside model history (dsh-commands contract).
 * @module dsh-costpilot/lib/commands
 */
import { summarizeStore, currencySymbol } from './sim.js'

function fmtMoney(value, currency) {
  const n = Number.isFinite(value) ? value : 0
  return currencySymbol(currency) + n.toFixed(n >= 1 ? 2 : 4)
}

function fmtInt(value) {
  const n = Number.isFinite(value) ? Math.round(value) : 0
  return n.toLocaleString('en-US')
}

/** Build the human-readable /cost report text. */
export function renderCostReport(summary, { mode = 'observe', title = 'session' } = {}) {
  const tokens = summary?.tokens ?? {}
  const counts = summary?.counts ?? {}
  const modules = summary?.byModule ?? {}
  const lines = []
  lines.push('CostPilot (' + mode + ') — ' + title + ' ' + (summary?.sessionId ?? 'unknown'))
  lines.push('cost: ' + fmtMoney(summary?.cost ?? summary?.usd, summary?.currency) + (summary?.confidence === 'provider' ? '' : ' (heuristic)'))
  lines.push('tokens: in ' + fmtInt((tokens.uncachedInput ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0))
    + ' (cache r ' + fmtInt(tokens.cacheRead) + ' / w ' + fmtInt(tokens.cacheWrite)
    + ' / uncached ' + fmtInt(tokens.uncachedInput) + ') out ' + fmtInt(tokens.output))
  lines.push('calls: ' + fmtInt(counts.calls) + ' · tools: ' + fmtInt(counts.tools)
    + ' · turns: ' + fmtInt(counts.turns) + ' · steps: ' + fmtInt(counts.steps))
  const moduleLine = Object.entries(modules)
    .filter(([, value]) => value && (value.count > 0 || value.removedTokens > 0))
    .map(([id, value]) => id + ': ' + Math.round(value.removedTokens ?? 0) + ' tok removed / '
      + (value.count ?? 0) + ' ops')
  if (moduleLine.length > 0) lines.push(moduleLine.join(' · '))
  const guardCount = summary?.guard?.count ?? 0
  if (guardCount > 0) lines.push('guard: ' + guardCount + ' warning(s)' + (summary?.guard?.lastReason ? ' — ' + summary.guard.lastReason : ''))
  return lines.join('\n')
}

/**
 * Register the /cost command when the profile has a commands service.
 * @param {any} ctx
 * @param {{commandService?: any, config: any, getSummary: (sessionId?: string) => any, listSessionIds: () => string[], storeDir: string}} options
 */
export function registerCostCommand(ctx, options) {
  const service = options.commandService ?? ctx?.commands
  if (!service || typeof service.register !== 'function') return false
  const mode = options.config?.mode ?? 'observe'
  let lastSessionId

  service.register({
    name: 'cost',
    description: 'Show CostPilot cost/token summary for the current or most recent session',
    input: { hint: '[session-id|all]' },
    handler: (invocation) => {
      try {
        const raw = String(invocation?.rawInput ?? '').trim()
        const sessionId = invocation?.agent?.session?.id ?? lastSessionId
        if (raw === 'all' || (!sessionId && options.listSessionIds().length !== 1)) {
          const storeSummary = summarizeStore(options.storeDir)
          if (!storeSummary) return { kind: 'success', text: 'CostPilot: no sessions recorded yet' }
          return { kind: 'success', text: renderCostReport(storeSummary, { mode, title: 'all sessions' }) }
        }
        if (sessionId) lastSessionId = sessionId
        const summary = options.getSummary(sessionId) ?? summarizeStore(options.storeDir, sessionId)
        if (!summary) return { kind: 'success', text: 'CostPilot: no cost data for ' + (sessionId ?? 'this session') + ' yet' }
        return { kind: 'success', text: renderCostReport(summary, { mode, title: 'session' }) }
      } catch (error) {
        return { kind: 'error', text: 'CostPilot /cost failed: ' + (error?.message ?? String(error)) }
      }
    },
  })
  return true
}

/**
 * Register /costpilot: status | on <M#> | off <M#> | simulate.
 * Runtime toggles only affect this process; persistent state lives in config.
 */
export function registerCostPilotCommand(ctx, options) {
  const service = options.commandService ?? ctx?.commands
  if (!service || typeof service.register !== 'function') return false
  const moduleIds = options.moduleIds ?? ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9']
  const handler = (invocation) => {
    try {
      const raw = String(invocation?.rawInput ?? '').trim()
      const [verb, argument] = raw.split(/\s+/, 2)
      const runtime = options.getRuntimeConfig()
      if (verb === '' || verb === 'status') {
        const lines = ['CostPilot status · mode=' + runtime.mode + ' · currency=' + (runtime.currency ?? 'CNY')]
        for (const id of moduleIds) {
          const module = runtime.modules?.[id] ?? {}
          lines.push('  ' + id + ': ' + (module.enabled === true ? 'on' : 'off') + (module.mode ? ' (' + module.mode + ')' : ''))
        }
        lines.push('dataDir: ' + runtime.dataDir)
        return { kind: 'success', text: lines.join('\n') }
      }
      if (verb === 'on' || verb === 'off') {
        const target = argument ?? ''
        const ids = target === 'all' ? moduleIds : moduleIds.filter((id) => id.toLowerCase() === target.toLowerCase())
        if (ids.length === 0) return { kind: 'error', text: 'CostPilot: unknown module ' + JSON.stringify(target) + '; expected M1..M9 or all' }
        for (const id of ids) options.setModuleEnabled(id, verb === 'on')
        return { kind: 'success', text: 'CostPilot: ' + verb + ' ' + ids.join(', ') + ' (runtime only; not persisted)' }
      }
      if (verb === 'simulate') {
        const sessionId = invocation?.agent?.session?.id
        const summary = options.getSummary?.(sessionId) ?? summarizeStore(options.storeDir, sessionId)
        if (!summary) return { kind: 'success', text: 'CostPilot simulate: no ledger yet' }
        const estimate = options.estimateSavings(summary)
        const symbol = currencySymbol(estimate.currency)
        const lines = ['CostPilot simulate (static, no model call) — ' + summary.sessionId]
        lines.push('actual cost: ' + symbol + estimate.actualCost.toFixed(4) + ' · estimated future saving over ' + estimate.remainingCalls + ' calls:')
        for (const [module, bucket] of Object.entries(estimate.byModule)) {
          lines.push('  ' + module + ': −' + Math.round(bucket.removedTokens) + ' tok → ' + symbol + bucket.estimatedSaved.toFixed(4) + ' (' + bucket.count + ' ops)')
        }
        if (Object.keys(estimate.byModule).length === 0) lines.push('  (no compaction recorded yet; enable M1/M2/M3 in assist mode)')
        lines.push('total estimated saving: ' + symbol + estimate.totalEstimatedSaved.toFixed(4))
        return { kind: 'success', text: lines.join('\n') }
      }
      return { kind: 'error', text: 'CostPilot: usage /costpilot status | on <M#> | off <M#> | simulate' }
    } catch (error) {
      return { kind: 'error', text: 'CostPilot /costpilot failed: ' + (error?.message ?? String(error)) }
    }
  }
  service.register({
    name: 'costpilot',
    description: 'CostPilot status and runtime controls (status | on <M#> | off <M#> | simulate)',
    input: { hint: 'status | on M1 | off M2 | simulate' },
    handler,
  })
  return true
}
