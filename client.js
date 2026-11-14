/**
 * dsh-costpilot client half: a composer-dock pill showing the CURRENT SESSION's
 * total cost, plus a small click panel with cost-related details only.
 *
 * Interaction: click the pill -> one clamped popover above it; no tooltip
 * portal, no extra dock/sidebar artifacts. Esc / outside click closes it.
 *
 * Loaded through window.__ModuleLoader__; no build step.
 */
window.__ModuleLoader__.load({
  id: 'dsh-costpilot',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const reactDom = require('react-dom')

    const CSS_ID = 'dsh-costpilot/dock-pill.css'
    const CSS = [
      '.CPx9_anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}',
      '.CPx9_pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}',
      '.CPx9_pill svg{flex:none;width:14px;height:14px}',
      '.CPx9_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '@media (hover:hover){.CPx9_pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}',
      '.CPx9_label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
    ].join('')

    if (typeof document !== 'undefined' && typeof document.querySelector === 'function'
      && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-costpilot'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const cx = { anchor: 'CPx9_anchor', pill: 'CPx9_pill', label: 'CPx9_label' }
    const PANEL_WIDTH = 288

    function compactTokens(value) {
      const n = Number.isFinite(value) ? value : 0
      if (n < 1000) return String(Math.round(n))
      if (n < 1e6) return (Math.round(n / 100) / 10) + 'K'
      return (Math.round(n / 1e5) / 10) + 'M'
    }

    function moneySymbol(currency) {
      return currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : (currency || 'CNY') + ' '
    }

    function compactMoney(value, currency) {
      const n = Number.isFinite(value) ? value : 0
      const symbol = moneySymbol(currency)
      if (n === 0) return symbol + '0'
      if (n < 0.01) return symbol + n.toFixed(4)
      if (n < 1) return symbol + n.toFixed(3)
      return symbol + n.toFixed(2)
    }

    function costOfView(view) {
      return Number.isFinite(view.cost) ? view.cost : view.usd
    }

    function cacheHitPercent(tokens) {
      const billed = tokens.cacheRead + tokens.cacheWrite + tokens.uncachedInput
      if (billed === 0) return null
      return Math.round(tokens.cacheRead / billed * 100)
    }

    function CostPilotIcon() {
      return React.createElement('svg', {
        viewBox: '0 0 14 14',
        width: 14,
        height: 14,
        'aria-hidden': true,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
      React.createElement('path', { d: 'M2 11.5h10' }),
      React.createElement('path', { d: 'M3 9.5V5.5M5.7 9.5V3.2M8.4 9.5V6.6M11 9.5V4.4' }))
    }

    /** Pill text: only the current session's total cost (or a price hint). */
    function readingText(view) {
      const money = view.confidence === 'unknown' ? '价格未配置' : compactMoney(costOfView(view), view.currency)
      // Always expose the M1 effect next to the session cost.
      const saved = view.m1 && view.m1.removedTokens > 0 ? '省' + compactTokens(view.m1.removedTokens) : '省0'
      return money + ' · ' + saved
    }

    function tooltipText(view) {
      const parts = []
      parts.push('本会话累计成本 ' + (view.confidence === 'unknown' ? '（未配置该模型价格）' : compactMoney(costOfView(view), view.currency)))
      parts.push(view.calls + ' 次模型调用')
      const hit = cacheHitPercent(view.tokens)
      if (hit !== null) parts.push('缓存命中 ' + hit + '%')
      const m1Saved = view.m1 && Number.isFinite(view.m1.removedTokens) ? view.m1.removedTokens : 0
      parts.push('M1 节省 ' + compactTokens(m1Saved) + ' tok')
      return parts.join(' · ')
    }

    /** Cost-related rows only (no modules/route/status noise). */
    function breakdownRows(view) {
      const rows = []
      rows.push(['本会话累计成本', view.confidence === 'unknown' ? '未配置价格' : compactMoney(costOfView(view), view.currency)])
      rows.push(['模型调用', view.calls + ' 次'])
      rows.push(['缓存读取', compactTokens(view.tokens.cacheRead) + ' tok'])
      rows.push(['缓存写入', compactTokens(view.tokens.cacheWrite) + ' tok'])
      rows.push(['未缓存输入', compactTokens(view.tokens.uncachedInput) + ' tok'])
      rows.push(['模型输出', compactTokens(view.tokens.output) + ' tok'])
      const hit = cacheHitPercent(view.tokens)
      if (hit !== null) rows.push(['缓存命中率', hit + '%'])
      const m1Removed = view.m1 && Number.isFinite(view.m1.removedTokens) ? view.m1.removedTokens : 0
      const m1Ops = view.m1 && Number.isFinite(view.m1.ops) ? view.m1.ops : 0
      rows.push(['M1 已节省', '−' + compactTokens(m1Removed) + ' tok（' + m1Ops + ' 次压缩）'])
      if (view.guard && view.guard.count > 0) {
        rows.push(['M9 告警', view.guard.count + ' 次' + (view.guard.lastReason ? ' · ' + view.guard.lastReason : '')])
      }
      rows.push(['说明', '本会话自身消耗，不含子会话'])
      return rows
    }

    const panelStyle = {
      position: 'fixed',
      zIndex: 90,
      width: PANEL_WIDTH + 'px',
      maxWidth: 'calc(100vw - 16px)',
      boxSizing: 'border-box',
      padding: '12px',
      borderRadius: '12px',
      border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))',
      background: 'var(--dsw-specific-menu, #1f1f1f)',
      boxShadow: '0 8px 28px rgba(0,0,0,.28)',
      color: 'var(--dsw-alias-label-secondary, #bbb)',
      fontSize: '12px',
      lineHeight: '18px',
    }

    function CostPilotPanel({ view, anchor, onClose }) {
      const panelRef = React.useRef(null)
      React.useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        const onDown = (event) => {
          if (panelRef.current && !panelRef.current.contains(event.target) && anchor.current && !anchor.current.contains(event.target)) onClose()
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onDown)
        return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown) }
      }, [])
      const rect = anchor.current ? anchor.current.getBoundingClientRect() : null
      const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280
      const anchorLeft = rect ? rect.left + rect.width / 2 - PANEL_WIDTH / 2 : 16
      const left = Math.min(Math.max(8, anchorLeft), Math.max(8, viewportWidth - PANEL_WIDTH - 8))
      const bottom = rect ? Math.max(12, window.innerHeight - rect.top + 8) : 80
      const style = { ...panelStyle, left: left + 'px', bottom: bottom + 'px' }
      return reactDom.createPortal(React.createElement('div', {
        ref: panelRef,
        style,
        role: 'dialog',
        'aria-label': 'CostPilot 会话成本',
        'data-costpilot-panel': true,
      },
      React.createElement('div', {
        style: { display: 'flex', justifyContent: 'space-between', gap: '12px', marginBottom: '8px', color: 'var(--dsw-alias-label-primary, #eee)', fontSize: '13px', fontWeight: 500 },
      }, React.createElement('span', null, '会话成本'), React.createElement('span', null, view.mode)),
      breakdownRows(view).map(([key, value]) => React.createElement('div', {
        key,
        style: { display: 'flex', justifyContent: 'space-between', gap: '16px', padding: '2px 0' },
      },
      React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary, #888)' } }, key),
      React.createElement('span', { style: { fontVariantNumeric: 'tabular-nums' } }, value)))), document.body)
    }

    function CostPilotPill(props) {
      const view = props.useProjection ? props.useProjection('costpilot') : undefined
      const anchor = React.useRef(null)
      const [open, setOpen] = React.useState(false)
      const hasData = view !== undefined && (view.calls > 0 || (view.m1 && view.m1.ops > 0) || (view.guard && view.guard.count > 0))
      if (!hasData) return null
      return React.createElement('span', {
        ref: anchor,
        className: cx.anchor,
        'data-composer-stat': 'costpilot',
        'data-costpilot-mode': view.mode,
      },
      React.createElement('button', {
        type: 'button',
        className: cx.pill,
        title: tooltipText(view),
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-label': 'CostPilot ' + tooltipText(view),
        onClick: () => setOpen(!open),
      },
      React.createElement(CostPilotIcon),
      React.createElement('span', { className: cx.label }, readingText(view))),
      open ? React.createElement(CostPilotPanel, { view, anchor, onClose: () => setOpen(false) }) : null)
    }

    function apply(ctx) {
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'costpilot',
        order: 2,
      }, CostPilotPill))
    }

    module.exports.apply = apply
    module.exports.inject = ['slots']
    module.exports.CostPilotPill = CostPilotPill
    module.exports.breakdownRows = breakdownRows
    return module.exports
  },
})