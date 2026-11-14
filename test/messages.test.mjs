/**
 * Session replay contract for agent inbox notices.
 *
 * DSH appends whatever `agent.steer()` receives as a `user/message` event and
 * validates it when the stored session is loaded: the payload must carry a
 * non-empty string `id`, `role: 'user'`, a non-empty `source.kind`, and an array
 * `content`. These tests pin that shape so a notice can never again corrupt a
 * transcript or produce an API request message without `role`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createUserNotice } from '../lib/messages.js'

test('createUserNotice builds an identified user message', () => {
  const notice = createUserNotice({ content: [{ type: 'text', text: 'hello' }] })
  assert.equal(typeof notice.id, 'string')
  assert.ok(notice.id.length > 0)
  assert.equal(notice.role, 'user')
  assert.deepEqual(notice.source, { kind: 'costpilot' })
  assert.deepEqual(notice.content, [{ type: 'text', text: 'hello' }])
})

test('createUserNotice keeps a caller-supplied source and a fresh id per notice', () => {
  const first = createUserNotice({ content: [], source: { kind: 'custom', form: 'notice' } })
  const second = createUserNotice({ content: [], source: { kind: 'custom', form: 'notice' } })
  assert.deepEqual(first.source, { kind: 'custom', form: 'notice' })
  assert.notEqual(first.id, second.id)
})
