/**
 * Message construction for agent inbox APIs. Dependency-free.
 *
 * `agent.steer()` / `agent.inject()` hand their argument straight to the session
 * inbox and the agent loop appends it as a `user/message` surface event. DSH
 * validates that event on replay: the payload must be a complete message with a
 * stable `id`, `role: 'user'`, a non-empty `source.kind`, and an array `content`.
 * Passing a bare `{ content, source }` shape is accepted by the inbox but later
 * makes the whole session appear corrupt ("lacks an identified message") and
 * produces an API request message without `role`.
 *
 * @module dsh-costpilot/lib/messages
 */
import { randomUUID } from 'node:crypto'

/**
 * Build a complete, identified user-role message for steer/inject.
 *
 * Mirrors DSH's `createUserMessage({ content, source })`: a fresh stable
 * identity plus the fixed user role.
 *
 * @param {{ content: Array<object>, source?: object }} input
 * @returns {{ id: string, role: 'user', content: Array<object>, source: object }}
 */
export function createUserNotice({ content, source = { kind: 'costpilot' } }) {
  return { id: randomUUID(), role: 'user', content, source }
}
