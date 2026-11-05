// dsh-emotion 客户端：在 DSH 里注册一个「情绪」页，内容用 iframe 嵌本机面板。
// 只做容器，UI 仍在 http://127.0.0.1:7799/ —— 这样面板样式改一次两边都生效。
window.__ModuleLoader__.load({
  id: 'dsh-affect',
  factory: (require) => {
    const React = require('react')
    const PANEL_URL = 'http://127.0.0.1:7799/'
    const KEY = 'dsh-emotion-panel'

    function EmotionPanel() {
      return React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'stretch',
            width: '100%',
            height: '100%',
            padding: '12px 16px',
            boxSizing: 'border-box',
            overflow: 'hidden',
          },
        },
        React.createElement('iframe', {
          src: PANEL_URL,
          title: '情绪',
          style: {
            width: 'min(1080px, 100%)',
            height: '100%',
            border: '1px solid rgba(138,109,40,.45)',
            borderRadius: '14px',
            background: 'transparent',
          },
        }),
      )
    }

    // 每条回复下面那一行：实时显示当前各轴（低 / 中 / 高 / max）。
    // 面板服务的端口可能被别的软件占着，所以从 7799 往上试几个，找到就记住。
    const STATE_PORTS = [7799, 7800, 7801, 7802, 7803, 7804, 7805]

    function band(v) {
      if (v >= 90) return 'max'
      if (v >= 60) return '高'
      if (v >= 30) return '中'
      return '低'
    }

    function EmotionLine() {
      const [snap, setSnap] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        let idx = 0
        const pull = (i = idx) => {
          fetch(`http://127.0.0.1:${STATE_PORTS[i]}/state`, { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
              if (!alive) return
              if (d && d.axes) { idx = i; setSnap(d) } else setSnap(null)
            })
            .catch(() => {
              if (!alive) return
              if (i + 1 < STATE_PORTS.length) pull(i + 1)
              else { idx = 0; setSnap(null) }
            })
        }
        pull()
        const timer = setInterval(() => pull(), 8000)
        return () => { alive = false; clearInterval(timer) }
      }, [])
      // 连不上也渲染一行：能看到「情绪 —」就说明 slot 挂上了，只是数据没来。
      if (!snap) {
        return React.createElement(
          'div',
          { style: { marginTop: '6px', fontSize: '12px', opacity: 0.45 } },
          '情绪 —',
        )
      }
      const names = snap.names || {}
      const parts = Object.entries(snap.axes).map(
        ([k, v]) => `${names[k] || k} ${Math.round(v)}·${band(v)}`,
      )
      if (parts.length === 0) {
        // 能连上但一个轴都没配——刚装好就是这样，得让他知道去哪儿配，而不是什么都不显示。
        return React.createElement(
          'div',
          { style: { marginTop: '6px', fontSize: '12px', opacity: 0.55 } },
          '情绪未配置 · 点左侧「情绪」面板加轴，或让模型先蒸馏一遍',
        )
      }
      return React.createElement(
        'div',
        {
          style: {
            marginTop: '6px',
            fontSize: '12px',
            lineHeight: '18px',
            opacity: 0.62,
            fontVariantNumeric: 'tabular-nums',
          },
        },
        parts.join('  ·  '),
      )
    }

    function EmotionIcon() {
      return React.createElement('span', { 'aria-hidden': 'true' }, '\u25CE')
    }

    // 服务名，不是包名 —— 写成 ['layout'] 会让 cordis 永远不注入，apply 根本不执行
    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.inject(['layout'], (pageCtx) => {
        if (!pageCtx || !pageCtx.slots) return
        pageCtx.slots.inject('main', () =>
          pageCtx.slots.register(
            {
              name: 'main',
              key: KEY,
              locale: 'emotion',
              inject: () => ({ renderPanel: () => React.createElement(EmotionPanel) }),
            },
            EmotionPanel,
          ),
        )
        pageCtx.slots.inject('sidebar.panellist', () =>
          pageCtx.slots.register(
            {
              name: 'sidebar.panellist',
              id: KEY,
              order: 30,
              label: () => '情绪',
              locale: 'emotion',
            },
            EmotionIcon,
          ),
        )
      })

      // 每条回复尾部的实时状态行。必须在**顶层** ctx 上注册 ——
      // 塞进 ctx.inject(['layout']) 的回调里永远挂不上（官方 message-feedback 也是顶层 ctx.slots）。
      ctx.slots.inject('conversation.chat.assistant-actions', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.assistant-actions',
            id: 'emotion-line',
            order: 6,
            inject: () => ({}),
          },
          EmotionLine,
        ),
      )
    }

    return { name: 'emotion', apply, inject }
  },
})
