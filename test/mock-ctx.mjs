/**
 * Minimal Cordis-like runtime for tests. NOT shipped in the bundle.
 * Supports: on(name, fn, {prepend}), waterfall(name, args, terminal), emit(name, ...args),
 * inject(deps, cb), effect(fn), get(name), commands registry, and dispose().
 */

export class MockContext {
  #listeners = new Map()
  #services = new Map()
  #effects = []

  constructor(services = {}) {
    for (const [key, value] of Object.entries(services)) this.#install(key, value)
  }

  #install(key, value) {
    this.#services.set(key, value)
    // Cordis exposes injected services as plain properties on the context.
    if (!(key in this)) {
      Object.defineProperty(this, key, { get: () => this.#services.get(key), configurable: true })
    }
  }

  get(key) { return this.#services.get(key) }
  has(key) { return this.#services.has(key) }

  provide(key, value) {
    this.#install(key, value)
    return value
  }

  on(name, handler, options = {}) {
    const list = this.#listeners.get(name) ?? []
    if (options.prepend) list.unshift(handler)
    else list.push(handler)
    this.#listeners.set(name, list)
    return () => {
      const current = this.#listeners.get(name) ?? []
      const index = current.indexOf(handler)
      if (index >= 0) current.splice(index, 1)
    }
  }

  inject(deps, callback) {
    if (!deps.every((key) => this.#services.has(key))) return false
    callback(this)
    return true
  }

  // Cordis semantics: `ctx.effect(() => disposer)` invokes the callback and
  // stores the disposer it returns.
  effect(callback) {
    const disposer = typeof callback === 'function' ? callback() : undefined
    this.#effects.push(typeof disposer === 'function' ? disposer : () => {})
    return disposer
  }

  async waterfall(name, args, terminal) {
    const handlers = [...(this.#listeners.get(name) ?? [])]
    let index = 0
    const next = async () => {
      if (index < handlers.length) {
        const handler = handlers[index++]
        return await handler(...args, next)
      }
      return terminal ? await terminal() : undefined
    }
    return await next()
  }

  emit(name, ...args) {
    const handlers = [...(this.#listeners.get(name) ?? [])]
    const results = []
    for (const handler of handlers) {
      try {
        results.push(handler(...args))
      } catch (error) {
        results.push(Promise.reject(error))
      }
    }
    return Promise.allSettled(results)
  }

  dispose() {
    for (const disposer of this.#effects.splice(0)) {
      try { disposer() } catch {}
    }
    this.#listeners.clear()
  }
}

/** Registry stub implementing the bits of ctx.commands the plugin uses. */
export class MockCommands {
  #definitions = new Map()
  register(definition) {
    if (!definition || typeof definition.name !== 'string') throw new Error('command name required')
    if (typeof definition.handler !== 'function') throw new Error('command handler required')
    if (this.#definitions.has(definition.name)) throw new Error('duplicate command ' + definition.name)
    this.#definitions.set(definition.name, definition)
    return () => this.#definitions.delete(definition.name)
  }
  list() { return [...this.#definitions.keys()].sort() }
  async execute(name, invocation = {}) {
    const definition = this.#definitions.get(name)
    if (!definition) return undefined
    const result = await definition.handler({ rawInput: '', ...invocation })
    if (!result || (result.kind !== 'success' && result.kind !== 'error')) throw new Error('invalid command result')
    return result
  }
}



/** Minimal ctx.tools stub: registration, visibility and restrictions. */
export class MockTools {
  #definitions = new Map()
  #restrictions = []
  register(definition) {
    if (!definition || typeof definition.name !== 'string') throw new Error('tool name required')
    if (this.#definitions.has(definition.name)) throw new Error('duplicate tool ' + definition.name)
    this.#definitions.set(definition.name, definition)
    return () => this.#definitions.delete(definition.name)
  }
  definitions() { return [...this.#definitions.values()] }
  schemas() { return this.definitions().map((d) => ({ name: d.name, description: d.description ?? '', parameters: d.parameters ?? {} })) }
  get(name) { return this.#definitions.get(name) }
  restrict(filter) {
    this.#restrictions.push({ ...filter })
    return () => {}
  }
  restrictions() { return this.#restrictions.slice() }
  denied() {
    const deny = new Set()
    for (const filter of this.#restrictions) for (const name of filter.deny ?? []) deny.add(name)
    return [...deny]
  }
  async executeTool(name, args, exec) {
    const definition = this.#definitions.get(name)
    if (!definition) throw new Error('unknown tool ' + name)
    return await definition.execute(args, exec ?? {})
  }
}

/** Build a minimal session/agent pair and an event emitter with monotonic seq/time. */
export function createHarness({ services = {}, sessionId = 'sess-1', cwd = '/tmp/workspace' } = {}) {
  const commands = services.commands ?? new MockCommands()
  const tools = services.tools ?? new MockTools()
  const ctx = new MockContext({ ...services, commands, tools })
  const session = {
    id: sessionId,
    cwd,
    appended: [],
    append(type, data, options = {}) {
      const event = { type, seq: session.appended.length, time: Date.now(), data, ...options }
      session.appended.push(event)
      return event
    },
  }
  const agent = {
    session,
    steered: [],
    injected: [],
    canceled: [],
    modelSelections: [],
    steer(message) { agent.steered.push(message); return Promise.resolve() },
    inject(message) { agent.injected.push(message); return Promise.resolve() },
    cancel(cause, options) { agent.canceled.push({ cause, options }); return Promise.resolve() },
    model: {
      current: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
      select(selection) { agent.modelSelections.push(selection); return Promise.resolve() },
    },
    ctx: { tools },
  }
  function event(type, data, options = {}) {
    return session.append(type, data, options)
  }
  return { ctx, session, agent, commands, tools, event }
}

/** Convenience: dispatch a session/event emission to listeners. */
export async function emitSession(ctx, session, event) {
  await ctx.emit('session/event', session, event)
}

/** Convenience: run the tools/post-execute waterfall with a default accept terminal. */
export async function runPostExecute(ctx, exec, result, terminal = async () => ({ kind: 'accept' })) {
  return await ctx.waterfall('tools/post-execute', [exec, result], terminal)
}

/** Convenience: run agent/pre-step with a default enter decision. */
export async function runPreStep(ctx, payload, terminal) {
  return await ctx.waterfall('agent/pre-step', [payload], terminal ?? (async () => ({ kind: 'enter', messages: payload.messages ?? [] })))
}


/** Minimal SessionProjections registry: register + drive + view (test-only). */
export class MockProjectionRegistry {
  #defs = new Map()
  #cells = new Map()
  register(definition) {
    if (!definition || typeof definition.key !== 'string') throw new Error('projection key required')
    if (!Number.isSafeInteger(definition.stateVersion)) throw new Error('projection stateVersion required')
    this.#defs.set(definition.key, definition)
    return Promise.resolve({ dispose: () => { this.#defs.delete(definition.key) } })
  }
  drive(session, event) {
    const sessionId = session?.id ?? 'unknown'
    for (const [key, definition] of this.#defs) {
      const cellKey = key + ':' + sessionId
      const previous = this.#cells.get(cellKey)
      const state = previous === undefined ? definition.init(session.header, session.inheritedEventCount ?? 0) : previous
      this.#cells.set(cellKey, definition.apply(state, event))
    }
  }
  stateOf(session, key) {
    const definition = this.#defs.get(key)
    if (!definition) return undefined
    const cellKey = key + ':' + (session?.id ?? 'unknown')
    if (!this.#cells.has(cellKey)) this.#cells.set(cellKey, definition.init(session?.header, 0))
    return this.#cells.get(cellKey)
  }
  view(session, key) {
    const definition = this.#defs.get(key)
    if (!definition?.wire) return undefined
    return definition.wire.view(this.stateOf(session, key))
  }
}

/** Patch emitted session events into a projection registry when provided. */
export async function emitSessionWithProjections(ctx, registry, session, event) {
  registry?.drive(session, event)
  await ctx.emit('session/event', session, event)
}
