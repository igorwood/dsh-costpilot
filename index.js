/**
 * dsh-costpilot v1.0 plugin entry (function plugin, zero cordis imports).
 *
 * Phase 0 cost ledger + M1..M9 cost modules + client dock projection.
 * Every capability is used through ctx.inject; listeners never fail the host turn.
 *
 * @module dsh-costpilot
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveConfig, isActive } from './lib/config.js'
import { textOfContent, GUARD_ACTION } from './lib/contracts.js'
import { createStore } from './lib/store.js'
import { createLedger } from './lib/ledger.js'
import { compressToolResult, writeSideStore } from './lib/compress.js'
import { createGuard } from './lib/guard.js'
import { registerCostCommand, registerCostPilotCommand } from './lib/commands.js'
import { estimateSavings, summarizeStore } from './lib/sim.js'
import { createCostProjectionDefinition } from './lib/projection.js'
import { resolvePrice } from './lib/pricing.js'
import { estimateToolSchema } from './lib/estimate.js'
import { createBatchingNudge, createToolsetScheduler, createRouteSelector } from './lib/turn-policy.js'
import { createRepeatCache } from './lib/repeat-cache.js'
import { reconcileUsage } from './lib/audit.js'
import { createIndex } from './lib/indexer.js'
import { createIndexTool } from './lib/index-tool.js'
import { createCompactionPlanner } from './lib/compaction-plan.js'
import { createCompactor } from './lib/compactor.js'
import { estimateTokens } from './lib/estimate.js'
import { createUserNotice } from './lib/messages.js'

export const name = 'dsh-costpilot'
/** No hard service dependencies: every capability is used through ctx.inject. */
export const inject = []

const ALL_MODULES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9']

/** Derive a coarse phase label from the most recent tool call. */
function phaseOf(toolName) {
  if (typeof toolName !== 'string') return 'setup'
  if (/^(glob|grep|ls|find|index_query|web_search)$/.test(toolName)) return 'search'
  if (/^(read|cat|head|tail)$/.test(toolName)) return 'read'
  if (/^(edit|write|str_replace_editor|patch)$/.test(toolName)) return 'edit'
  if (/test|lint/i.test(toolName)) return 'test'
  if (toolName === 'bash' || toolName === 'run_code') return 'execute'
  return 'other'
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
}

function pruneSideStore(root, days) {
  const ttlDays = Number(days)
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) return 0
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000
  let removed = 0
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      try { if (fs.statSync(full).mtimeMs < cutoff) { fs.unlinkSync(full); removed += 1 } } catch {}
    }
  }
  walk(root)
  return removed
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  let config
  try {
    config = resolveConfig(rawConfig)
  } catch (error) {
    config = resolveConfig({})
    log(config, 'invalid config, falling back to defaults:', error.message)
  }
  /** Mutable runtime copy: /costpilot on|off changes it without touching disk. */
  const runtime = structuredClone(config)
  ensureDir(runtime.dataDir)
  pruneSideStore(path.join(runtime.dataDir, 'originals'), runtime.modules.M1.deleteOriginalsAfterDays)
  const store = createStore({ dir: path.join(runtime.dataDir, 'sessions') })
  const states = new Map()
  let toolsService = null
  let projectionRegistry = null
  const indexes = new Map()
  let indexToolDispose = null

  function workspaceRootFor(agent) {
    const session = agent?.session
    return session?.header?.cwd ?? session?.cwd ?? process.cwd()
  }

  function indexFor(root) {
    let entry = indexes.get(root)
    if (entry) return entry
    const indexPath = runtime.modules.M4.indexPath
    const dbPath = path.isAbsolute(indexPath) ? indexPath : path.join(root, indexPath)
    const index = createIndex({
      root,
      dbPath,
      config: runtime.modules.M4,
      logger: { warn: (...args) => log(runtime, ...args), error: (...args) => log(runtime, ...args) },
    })
    entry = { index }
    indexes.set(root, entry)
    return entry
  }

  /** Register index_query once M4 is enabled (startup or /costpilot on M4). */
  function ensureIndexTool() {
    if (indexToolDispose || runtime.modules.M4.enabled !== true) return
    if (!toolsService || typeof toolsService.register !== 'function') return
    try {
      const placeholder = { ensureFresh: () => ({}), query: () => ({ columns: [], rows: [], ms: 0, truncated: false }), stats: () => ({}), markDirty: () => {}, close: () => {} }
      const template = createIndexTool({ config: runtime.modules.M4, index: placeholder })
      const tool = {
        ...template,
        execute: async (args, exec) => {
          const root = workspaceRootFor(exec?.agent)
          const entry = indexFor(root)
          const definition = createIndexTool({ config: runtime.modules.M4, index: entry.index })
          return await definition.execute(args, exec)
        },
      }
      indexToolDispose = toolsService.register(tool)
    } catch (error) {
      log(runtime, 'M4 tool registration failed:', error.message)
    }
  }

  function disableIndexTool() {
    try { indexToolDispose?.() } catch {}
    indexToolDispose = null
  }
  const debug = () => runtime.debug === true

  function log(_cfg, ...args) {
    if (debug()) console.error('[costpilot]', ...args)
  }

  function stateFor(session) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    let state = states.get(sessionId)
    if (!state) {
      state = {
        sessionId,
        ledger: createLedger({ sessionId, store, config: runtime }),
        guard: createGuard({ config: runtime, sessionId }),
        nudge: null,
        scheduler: null,
        router: null,
        repeat: null,
        restrictDisposers: [],
        recentToolNames: [],
        turnCostUSD: 0,
        warned: new Set(),
        injectedNudges: 0,
        lastTool: null,
        callsThisTurn: 0,
        lastRoute: null,
        audit: null,
        compactionPlanner: null,
        compactor: null,
        lastCompactionAttempt: -99,
      }
      states.set(sessionId, state)
    }
    return state
  }

  function flushAll() {
    for (const state of states.values()) {
      try { state.ledger.flush() } catch (error) { log(config, 'flush failed:', error.message) }
    }
  }

  // ---- Phase 0: observe session events -------------------------------------
  ctx.on('session/event', (session, event) => {
    try {
      const state = stateFor(session)
      if (!state) return
      if (event?.type === 'request/header') {
        const config = event.data?.header?.config
        if (config?.provider && config?.model) state.lastRoute = { provider: config.provider, model: config.model }
      }
      const records = state.ledger.sample(session, event) ?? []
      for (const record of records) {
        if (record.kind === 'llm_call' && Number.isFinite(record.usd)) {
          state.turnCostUSD += record.usd
          state.lastRoute = record.route ?? state.lastRoute
          state.guard.noteCallCost?.(record.usd)
        }
        if (record.kind === 'tool_call') {
          state.lastTool = record.extra?.name ?? state.lastTool
          state.callsThisTurn += 1
          state.recentToolNames = [...(state.recentToolNames ?? []), state.lastTool].slice(-3)
        }
      }
      if (event?.type === 'tool/result') {
        const code = String(event?.data?.error?.code ?? '')
        if (code.includes('UNKNOWN_TOOL')) {
          for (const dispose of state.restrictDisposers.splice(0)) {
            try { dispose() } catch {}
          }
          state.scheduler?.noteUnknownTool?.(String(event?.data?.error?.reason ?? ''))
          state.ledger.recordGuard({ action: 'metric', reason: 'toolset-restore', details: { code } })
        }
      }
      state.guard.observeEvent?.(session, event)
      if (event?.type === 'turn/start') state.callsThisTurn = 0
      if (event?.type === 'turn/end') {
        state.guard.noteTurnCost?.(state.turnCostUSD)
        if (state.nudge && state.nudge.shouldDisable?.({ after: { callsPerTurn: state.callsThisTurn, costDeltaUSD: state.turnCostUSD } }) === true) {
          state.nudgeDisabled = true
        }
        state.turnCostUSD = 0
        state.callsThisTurn = 0
        reconcile(state, session)
        state.ledger.flush()
      }
    } catch (error) {
      log(config, 'session/event sampling failed:', error.message)
    }
  })

  /** Compare ledger token totals with the tokenUsage projection (advisory). */
  function reconcile(state, session) {
    try {
      if (!projectionRegistry || typeof projectionRegistry.stateOf !== 'function' || !session) return
      const tokenUsage = projectionRegistry.stateOf(session, 'tokenUsage')
      if (!tokenUsage) return
      const summary = state.ledger.summary()
      const result = reconcileUsage({ ledger: { tokens: summary.tokens }, tokenUsage })
      state.audit = result
      if (!result.ok) state.ledger.recordGuard({ action: 'audit', reason: 'token-usage-mismatch', details: result })
    } catch (error) {
      log(config, 'reconciliation skipped:', error.message)
    }
  }

  // ---- services -------------------------------------------------------------
  ctx.inject?.(['tools'], (child) => {
    toolsService = child?.tools ?? child ?? null
    ensureIndexTool()
  })

  ctx.inject?.(['sessionProjections'], (child) => {
    projectionRegistry = child?.sessionProjections ?? null
    try {
      ctx.effect?.(() => {
        const definition = createCostProjectionDefinition({
          mode: runtime.mode,
          modules: () => runtime.modules,
          pricing: runtime.pricing,
          peakPricing: runtime.peakPricing,
          usageSemantics: runtime.usageSemantics,
          currency: runtime.currency,
        })
        const registration = child.sessionProjections.register(definition)
        Promise.resolve(registration).catch((error) => log(config, 'projection registration failed:', error.message))
        return () => { Promise.resolve(registration).then((handle) => handle?.dispose?.()).catch(() => {}) }
      })
    } catch (error) {
      log(config, 'projection registration failed:', error.message)
    }
  })

  // ---- M1: tool-output compaction ------------------------------------------
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      if (decision.kind !== 'accept') return decision
      if (decision.value !== undefined) return decision
      const state = stateFor(exec?.agent?.session)
      if (!state) return decision
      // M8 records the settled read-only result even when M1 rewrites it.
      recordRepeat(state, exec, result, decision)
      if (!isActive(runtime, 'M1')) return decision
      const content = decision.content ?? result?.content ?? []
      const compressed = compressToolResult({
        toolName: exec?.name ?? 'unknown',
        result: { content, isError: result?.isError === true },
        config: { ...runtime, module: runtime.modules.M1 },
        context: { sessionId: state.sessionId, callId: exec?.callId, turn: exec?.turn, step: exec?.step },
      })
      if (!compressed.changed) return decision
      let pointer
      if (runtime.modules.M1.sideStore !== false) {
        const original = textOfContent(content)
        if (original.length > 0) {
          try {
            const written = writeSideStore({
              dir: path.join(runtime.dataDir, 'originals'),
              sessionId: state.sessionId,
              callId: String(exec?.callId ?? 'unknown'),
              text: original,
            })
            pointer = written.path
          } catch (error) {
            log(config, 'side-store write failed:', error.message)
          }
        }
      }
      state.ledger.recordMutation({
        module: 'M1',
        removedTokens: compressed.removedTokens ?? 0,
        addedTokens: compressed.addedTokens ?? 0,
        pointer,
        count: 1,
        tool: exec?.name,
        pointers: compressed.pointerCount ?? 0,
      })
      if (runtime.modules.M1.marker !== false) {
        const marker = '\n\n[costpilot:m1 removed_tokens=' + (compressed.removedTokens ?? 0)
          + ' added_tokens=' + (compressed.addedTokens ?? 0)
          + ' pointers=' + (compressed.pointerCount ?? 0) + ']'
        return { ...decision, content: [...compressed.content, { type: 'text', text: marker }] }
      }
      return { ...decision, content: compressed.content }
    } catch (error) {
      log(config, 'M1 compression failed, passing through:', error.message)
      return recordRepeat(stateFor(exec?.agent?.session), exec, result, decision)
    }
  })

  /** M8: remember a read-only result after the pipeline settles it. */
  function recordRepeat(state, exec, result, decision) {
    if (!state || !isActive(runtime, 'M8')) return decision
    try {
      state.repeat ??= createRepeatCache({ config: runtime })
      const content = decision?.content ?? result?.content
      state.repeat.record({
        toolName: exec?.name ?? '',
        argsText: stringifyArgs(exec?.arguments),
        resultText: textOfContent(content),
        resultSeq: undefined,
        pointer: 'call:' + String(exec?.callId ?? ''),
        isError: result?.isError === true,
      })
    } catch (error) {
      log(config, 'M8 record failed:', error.message)
    }
    return decision
  }

  // ---- M8: duplicate-call advisory / deny -----------------------------------
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (runtime.modules.M8.enabled !== true) return next()
      const state = stateFor(exec?.agent?.session)
      if (!state) return next()
      state.repeat ??= createRepeatCache({ config: runtime })
      const decision = state.repeat.decide({
        toolName: exec?.name ?? '',
        argsText: stringifyArgs(exec?.arguments),
        turn: exec?.turn,
        step: exec?.step,
      })
      if (!isActive(runtime, 'M8') && decision.action !== 'none') {
        state.ledger.recordGuard({ action: 'metric', reason: 'm8-observe', details: { action: decision.action, tool: exec?.name } })
      }
      if (decision.action === 'deny' && isActive(runtime, 'M8')) {
        state.ledger.recordGuard({ action: GUARD_ACTION.WARN, reason: 'repeat-call', details: { tool: exec?.name } })
        return { kind: 'deny', reason: decision.text }
      }
      if (decision.action === 'advisory') {
        try {
          exec?.agent?.inject?.(createUserNotice({
            content: [{ type: 'text', text: decision.text }],
            source: { kind: 'costpilot' },
          }))
        } catch {}
      }
      return next()
    } catch (error) {
      log(config, 'M8 decide failed, allowing:', error.message)
      return next()
    }
  })

  // ---- M9 + M5 + M6: per-step policy ---------------------------------------
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision.kind === 'reject') return decision
      const agent = payload?.agent
      const state = stateFor(agent?.session)
      if (!state) return decision

      // M9 guard: budget / runaway.
      if (isActive(runtime, 'M9')) {
        const check = state.guard.checkPreStep?.({ turn: payload.turn, step: payload.step })
        if (check && check.action !== 'none') {
          const dedupeKey = check.reason
          if (!runtime.modules.M9.warnOncePerSession || !state.warned.has(dedupeKey)) {
            state.warned.add(dedupeKey)
            state.ledger.recordGuard({ action: check.action, reason: check.reason, details: check.details })
            if (check.action === 'stop') {
              try {
                await agent?.cancel?.({ kind: 'costpilot', reason: check.reason }, { keepInbox: runtime.modules.M9.keepInbox !== false })
              } catch (error) { log(config, 'agent.cancel failed:', error.message) }
              return { kind: 'reject' }
            }
            if (typeof check.message === 'string' && check.message.length > 0) {
              const marked = '[costpilot:guard action=warn reason=' + String(check.reason ?? 'guard').toLowerCase().replace(/[^a-z0-9_-]+/g, '-') + '] ' + check.message
              const notice = createUserNotice({
                content: [{ type: 'text', text: marked }],
                source: { kind: 'costpilot' },
              })
              try { await agent?.steer?.(notice) } catch (error) { log(config, 'steer failed:', error.message) }
            }
          }
        }
      }

      // M5 batching nudge.
      if (runtime.modules.M5.enabled === true && state.nudgeDisabled !== true) {
        state.nudge ??= createBatchingNudge({ config: runtime })
        const plan = state.nudge.plan({
          turn: payload.turn,
          step: payload.step,
          callsPerTurn: state.callsThisTurn,
          recentToolNames: state.recentToolNames ?? [],
          phase: phaseOf(state.lastTool),
        })
        if (plan && plan.inject && !isActive(runtime, 'M5')) {
          state.ledger.recordGuard({ action: 'metric', reason: 'm5-observe', details: { turn: payload.turn, step: payload.step } })
        } else if (plan && plan.inject) {
          try {
            await agent?.steer?.(createUserNotice({
              content: [{ type: 'text', text: plan.text }],
              source: { kind: 'costpilot' },
            }))
            state.nudge.noteInjected?.()
            state.ledger.recordGuard({ action: 'metric', reason: 'm5-nudge' })
          } catch (error) { log(config, 'M5 nudge failed:', error.message) }
        }
      }

      // M2/M3: cost-aware history compaction through the compaction protocol.
      const compactionActive = isActive(runtime, 'M2') || isActive(runtime, 'M3')
      if (compactionActive) {
        let builtin = null
        try { builtin = typeof ctx.get === 'function' ? ctx.get('compaction') : null } catch { builtin = null }
        const stepNumber = Number.isFinite(payload.step) ? payload.step : 0
        // P0-2: M2/M3 must own the surface writer; never run beside ctx.compaction.
        if (!builtin && stepNumber - state.lastCompactionAttempt >= 3) {
          try {
            state.compactionPlanner ??= createCompactionPlanner({ config: runtime })
            state.compactor ??= createCompactor({ config: runtime })
            const price = resolvePrice(runtime, state.lastRoute ?? { provider: 'deepseek-account', model: 'deepseek-flash' }, Date.now())
            const plan = state.compactionPlanner.plan({
              session: agent?.session,
              price,
              remainingSteps: Math.max(1, 16 - stepNumber),
              phase: phaseOf(state.lastTool),
            })
            if (plan) {
              if (!compactionActive) {
                state.ledger.recordGuard({ action: 'metric', reason: 'compaction-observe', details: { module: plan.module, netUSD: plan.netUSD, deltaTokens: plan.deltaTokens } })
              } else if (!(plan.netUSD > 0)) {
                // P0-1: never rewrite history without a positive net saving.
                state.lastCompactionAttempt = stepNumber
                state.ledger.recordGuard({ action: 'metric', reason: 'compaction-deferred', details: { module: plan.module, netUSD: plan.netUSD, deltaTokens: plan.deltaTokens } })
              } else {
                const result = await state.compactor.run(plan, agent?.session)
                if (result?.ok) {
                  state.lastCompactionAttempt = stepNumber
                  state.ledger.recordMutation({
                    module: plan.module,
                    removedTokens: plan.shadowedTokenCount ?? plan.deltaTokens ?? 0,
                    addedTokens: estimateTokens(plan.summary ?? ''),
                    pointer: null,
                    count: 1,
                  })
                  state.ledger.flush()
                } else if (result?.error && result.error !== 'busy') {
                  log(runtime, 'M2/M3 compaction skipped:', result.error)
                }
              }
            }
          } catch (error) {
            log(runtime, 'M2/M3 compaction failed:', error.message)
          }
        }
      }

      // M6 tool-set scheduling: restrict for the next tools.resolve.
      if (runtime.modules.M6.enabled === true && toolsService) {
        try {
          state.scheduler ??= createToolsetScheduler({ config: runtime })
          const definitions = toolsService.definitions?.(agent) ?? []
          const tools = definitions.map((definition) => ({
            name: definition.name,
            schemaTokens: estimateToolSchema(definition),
          }))
          const plan = state.scheduler.plan({
            step: payload.step,
            phase: phaseOf(state.lastTool),
            tools,
            remainingSteps: Math.max(1, 16 - (payload.step ?? 0)),
          })
          if (plan && Array.isArray(plan.deny) && plan.deny.length > 0) {
            if (!isActive(runtime, 'M6')) {
              state.ledger.recordGuard({ action: 'metric', reason: 'm6-observe', details: { deny: plan.deny } })
            } else {
              const target = agent?.ctx?.tools ?? null
              if (target && typeof target.restrict === 'function') {
                const dispose = target.restrict({ deny: plan.deny })
                if (typeof dispose === 'function') state.restrictDisposers.push(dispose)
                state.scheduler.noteSwitch?.()
                state.ledger.recordGuard({ action: 'metric', reason: 'toolset-switch', details: { deny: plan.deny } })
              }
            }
          }
        } catch (error) {
          log(config, 'M6 scheduling failed:', error.message)
        }
      }

      return decision
    } catch (error) {
      log(config, 'step policy failed, passing through:', error.message)
      return decision
    }
  })

  // ---- M7 route-down at the turn boundary ----------------------------------
  ctx.on('agent/turn-stopping', async (payload) => {
    try {
      const state = stateFor(payload?.agent?.session)
      if (!state) return
      if (runtime.modules.M7.enabled === true) {
        state.router ??= createRouteSelector({ config: runtime })
        const plan = state.router.plan({
          phase: phaseOf(state.lastTool),
          remainingSteps: 12,
          currentRoute: state.lastRoute,
        })
        if (plan && !isActive(runtime, 'M7')) {
          state.ledger.recordGuard({ action: 'metric', reason: 'm7-observe', details: plan })
        } else if (plan) {
          try {
            await payload.agent?.model?.select?.(plan)
            state.router.noteSwitch?.()
            state.ledger.recordGuard({ action: GUARD_ACTION.WARN, reason: 'route-down', details: plan })
          } catch (error) { log(config, 'M7 select failed:', error.message) }
        }
      }
      state.ledger.flush()
    } catch (error) {
      log(config, 'turn-stopping failed:', error.message)
    }
  })

  ctx.on('fs/observed', (target, observation, actor) => {
    try {
      if (indexes.size === 0) return
      const paths = []
      for (const item of [target, observation, actor]) {
        if (typeof item === 'string') paths.push(item)
        if (!item || typeof item !== 'object') continue
        if (typeof item.path === 'string') paths.push(item.path)
        if (typeof item.target === 'string') paths.push(item.target)
        if (Array.isArray(item.changes)) {
          for (const change of item.changes) {
            if (typeof change === 'string') paths.push(change)
            else if (change && typeof change.path === 'string') paths.push(change.path)
          }
        }
      }
      if (paths.length === 0) return
      for (const [root, entry] of indexes) {
        if (!paths.some((candidate) => candidate === root || candidate.startsWith(root + '/'))) continue
        entry.index.markDirty?.(paths)
      }
    } catch (error) { log(runtime, 'M4 invalidation failed:', error.message) }
  })

  ctx.on('session/disposed', (session) => {
    try {
      const state = states.get(session?.id)
      state?.ledger.flush()
      states.delete(session?.id)
    } catch (error) { log(config, 'session dispose failed:', error.message) }
  })

  // ---- commands -------------------------------------------------------------
  ctx.inject?.(['commands'], (child) => {
    try {
      ctx.effect?.(() => {
        const commandService = child?.commands ?? ctx.commands
        const summaryFor = (sessionId) => {
          const stored = summarizeStore(path.join(runtime.dataDir, 'sessions'), sessionId)
          if (stored && ((stored.counts?.calls ?? 0) > 0 || Object.keys(stored.byModule ?? {}).length > 0)) return stored
          const target = sessionId ? states.get(sessionId) : undefined
          if (!target) return undefined
          const summary = target.ledger.summary()
          if (!summary || ((summary.counts?.calls ?? 0) === 0 && Object.keys(summary.byModule ?? {}).length === 0)) return undefined
          return summary
        }
        registerCostCommand(child ?? ctx, {
          commandService,
          config: runtime,
          getSummary: summaryFor,
          listSessionIds: () => [...states.keys()],
          storeDir: path.join(runtime.dataDir, 'sessions'),
        })
        registerCostPilotCommand(child ?? ctx, {
          commandService,
          moduleIds: ALL_MODULES,          storeDir: path.join(runtime.dataDir, 'sessions'),
          getRuntimeConfig: () => runtime,
          setModuleEnabled: (id, enabled) => {
            if (!runtime.modules?.[id]) return
            runtime.modules[id].enabled = enabled
            if (id === 'M4') {
              if (enabled) ensureIndexTool()
              else disableIndexTool()
            }
          },
          getSummary: summaryFor,
          estimateSavings: (summary) => {
            const state = [...states.values()].find((candidate) => candidate.sessionId === summary?.sessionId)
            const route = state?.lastRoute ?? { provider: 'deepseek-account', model: 'deepseek-flash' }
            const price = resolvePrice(runtime, route, Date.now())
            return estimateSavings(summary, { price, remainingCalls: 6 })
          },
        })
        return () => {}
      })
    } catch (error) {
      log(config, 'command registration failed:', error.message)
    }
  })

  ctx.effect?.(() => () => flushAll())
}

function stringifyArgs(args) {
  if (typeof args === 'string') return args
  try { return JSON.stringify(args ?? {}) } catch { return String(args) }
}