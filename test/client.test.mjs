import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function loadClient() {
  let loadArgs
  const styles = []
  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: (tag) => styles.push(tag) },
  }
  const window = { __ModuleLoader__: { load: (args) => { loadArgs = args } } }
  const run = new Function('window', 'document', source)
  run(window, document)
  const require = (id) => {
    if (id === 'react') {
      return {
        createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
        useRef: () => ({ current: null }),
        useState: () => [false, () => {}],
        useEffect: () => {},
      }
    }
    if (id === 'react-dom') return { createPortal: (node) => node }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      return { Tooltip: (props) => ({ type: 'Tooltip', props }) }
    }
    return {}
  }
  const exports = loadArgs.factory(require)
  return { exports, loadArgs, styles }
}

const VIEW = {
  mode: 'assist',
  calls: 3,
  usd: 0.0123,
  cost: 0.0123,
  currency: 'CNY',
  confidence: 'provider',
  tokens: { uncachedInput: 2000, cacheRead: 8000, cacheWrite: 1000, output: 500 },
  m1: { removedTokens: 1200, addedTokens: 80, ops: 2 },
  guard: { count: 1, lastReason: 'budget-warning' },
  route: { provider: 'deepseek', model: 'deepseek-chat' },
}

test('client: loaded through __ModuleLoader__ with the bundle id', () => {
  const { exports, loadArgs } = loadClient()
  assert.equal(loadArgs.id, 'dsh-costpilot')
  assert.equal(typeof loadArgs.factory, 'function')
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
})

test('client: registers into conversation.composer.dock like sibling pills', () => {
  const { exports } = loadClient()
  let registered
  const ctx = {
    slots: {
      inject(owner, callback) {
        assert.equal(owner, 'conversation.composer.dock')
        registered = callback()
      },
      register(options, component) {
        return { options, component }
      },
    },
  }
  exports.apply(ctx)
  assert.equal(registered.options.name, 'conversation.composer.dock')
  assert.equal(registered.options.id, 'costpilot')
  assert.equal(registered.options.order, 2)
  assert.equal(typeof registered.component, 'function')
})

test('client: renders a cost-only pill and a clamped click panel', () => {
  const { exports } = loadClient()
  const tree = exports.CostPilotPill({ useProjection: (key) => { assert.equal(key, 'costpilot'); return VIEW } })
  assert.equal(tree.type, 'span')
  assert.match(tree.props.className, /CPx9_anchor/)
  assert.equal(tree.props['data-composer-stat'], 'costpilot')
  assert.equal(tree.props['data-costpilot-mode'], 'assist')

  const pill = tree.props.children[0]
  assert.equal(pill.type, 'button', 'the pill itself is the click target')
  assert.match(pill.props.className, /CPx9_pill/)
  assert.equal(pill.props['aria-haspopup'], 'dialog')
  assert.match(String(pill.props.title), /本会话累计成本/)
  assert.match(String(pill.props.title), /次模型调用/)

  const icon = pill.props.children[0]
  assert.equal(typeof icon.type, 'function')
  const label = pill.props.children[1]
  assert.equal(label.type, 'span')
  assert.match(label.props.className, /CPx9_label/)
  const labelText = String(label.props.children.join(''))
  assert.match(labelText, /^¥[\d.]+ · 省1\.2K$/, 'pill shows the session total cost and M1 saved tokens')

  const rows = Object.fromEntries(exports.breakdownRows(VIEW))
  assert.match(rows['本会话累计成本'], /¥/)
  assert.match(rows['缓存命中率'], /%/)
  assert.match(rows['M1 已节省'], /1\.2K/)
  assert.match(rows['说明'], /不含子会话/)
})

test('client: hides itself without projection data and injects its CSS once', () => {
  const { exports, styles } = loadClient()
  assert.equal(exports.CostPilotPill({ useProjection: () => undefined }), null)
  assert.ok(styles.length >= 1, 'style tag injected')
  assert.match(String(styles[0].dataset.pluginCss), /dock-pill/)
})