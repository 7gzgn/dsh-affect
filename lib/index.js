// dsh-emotion 外壳：只负责接宿主（注入 / 工具 / 事件 / 面板进程）。
// 所有状态读写都在 core.mjs，这里不直接碰数值。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createCore, clamp } from './core.mjs'

export const name = 'emotion'
export const inject = ['systemPrompt', 'tools']

const DSH_HOME =
  process.env.DSH_HOME || path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')

const DEFAULTS = { state: 'emotion-state.json', defs: 'emotions.json', cmds: 'emotion-cmds.jsonl' }

function probe(msg) {
  try {
    fs.appendFileSync(
      path.join(process.env.TEMP || '.', 'dsh-emotion-load.log'),
      `${new Date().toISOString()} ${msg}\n`,
    )
  } catch {}
}

function readDefs(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' ? raw : { axes: [] }
  } catch {
    return { axes: [] }
  }
}

function writeDefs(file, defs) {
  try {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(defs, null, 2))
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

function startPanel() {
  try {
    const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/+/, ''))
    const script = path.join(dir, 'panel-server.mjs')
    if (!fs.existsSync(script)) {
      probe(`panel missing ${script}`)
      return null
    }
    const child = spawn(process.execPath, [script], {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env },
    })
    child.on('error', (err) => probe(`panel spawn ERR ${err && err.message}`))
    child.on('exit', (code) => probe(`panel exit ${code}`))
    return child
  } catch (err) {
    probe(`panel ERR ${err && err.message}`)
    return null
  }
}

export function apply(ctx, config = {}) {
  try {
    const stateFile = typeof config.stateFile === 'string' && config.stateFile ? config.stateFile : path.join(DSH_HOME, DEFAULTS.state)
    const defsFile = typeof config.defsFile === 'string' && config.defsFile ? config.defsFile : path.join(DSH_HOME, DEFAULTS.defs)
    const cmdFile = path.join(path.dirname(stateFile), DEFAULTS.cmds)

    const core = createCore({ stateFile, defsFile, cmdFile })
    probe(`constructed (core) ${defsFile}`)

    const axisKeys = () => Object.keys(core.snapshot().defs.axes)

    // ---- 注入 ----
    try {
      ctx.effect(() =>
        ctx.systemPrompt.section({
          name: 'emotion:state',
          order: 400,
          text: () => {
            try {
              core.drainCommands()
              return core.render()
            } catch (err) {
              probe(`render ERR ${err && err.message}`)
              return ''
            }
          },
        }),
      )
      probe('section registered')
    } catch (err) {
      probe(`section ERR ${err && err.message}`)
    }

    // ---- 事件 ----
    ctx.on('agent/turn-stopping', ({ agent }) => {
      try {
        const text = lastUserText(agent?.session)
        if (!text) return
        const hit = core.applyRules(text)
        // 轮次型轴（上头）：每聊完一轮自己涨一点，不再依赖正则
        const turn = core.applyTurn()
        if (hit.length || turn.length) probe(`auto ${[...hit, ...turn].join(' ')}`)
      } catch (err) {
        probe(`auto ERR ${err && err.message}`)
      }
    })

    ctx.on('session/event', (_session, event) => {
      try {
        if (!event || event.type !== 'tool/result') return
        const data = event.data ?? {}
        const failed = Boolean(data.error) || data.isError === true || data.ok === false
        const hit = core.applyEvent(failed ? 'tool_error' : 'tool_ok')
        if (hit.length) probe(`event ${failed ? 'tool_error' : 'tool_ok'} ${hit.join(' ')}`)
      } catch (err) {
        probe(`event ERR ${err && err.message}`)
      }
    })

    // ---- 工具 ----
    const ok = (text) => ({ ok: true, text })
    const bad = (text) => ({ ok: false, text })

    const register = (def) => {
      try {
        ctx.tools.register(def)
      } catch (err) {
        probe(`tool ${def.name} ERR ${err && err.message}`)
      }
    }

    register({
      name: 'emotion',
      description: '给情绪状态机加减分。一次只改一个轴，幅度 1-30，别一次拉满。',
      parameters: {
        type: 'object',
        properties: {
          axis: { type: 'string', description: '轴 key（用 emotion_axis 建过哪些就有哪些）' },
          delta: { type: 'number', description: '加减幅度，正数加、负数减，范围 -30 到 30' },
        },
        required: ['axis', 'delta'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        },
        render: (_a, v) => [{ type: 'text', text: String(v?.text ?? '') }],
      },
      async execute(args) {
        const key = String(args?.axis ?? '')
        const delta = clamp(Number(args?.delta) || 0, -30, 30)
        const snap = core.snapshot()
        const def = snap.defs.axes[key]
        if (!def) return bad(`emotion：没有「${key}」这个轴；现有：${axisKeys().join(' / ') || '（还没有轴，先用 emotion_axis 建）'}`)
        core.loadState()
        core.add(key, delta)
        core.commit()
        const now = Math.round(core.snapshot().axes[key])
        return ok(`emotion：${def.zh} ${now}（${delta > 0 ? '+' : ''}${delta}）`)
      },
    })

    register({
      name: 'emotion_axis',
      description: '增删改情绪轴。加轴时给 key 和 zh 就够，其余可省。删轴给 remove=true。改完立即生效，不用重启。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '轴的英文键，小写字母/数字/下划线' },
          zh: { type: 'string', description: '中文名' },
          tag: { type: 'string', description: '一个短标签' },
          value: { type: 'number', description: '基准值 0-100（不填 30），偏离后会朝它回归' },
          rate: { type: 'number', description: '回归速度，绝对值越大回得越快（0.1 约每分钟 3%）' },
          decay: { type: 'number', description: '额外回归速度，可省' },
          floor: { type: 'number', description: '下限（不填 10）' },
          ceil: { type: 'number', description: '上限（不填 100）' },
          polarity: { type: 'string', enum: ['pos', 'neg', 'neutral'], description: '正/负/中立' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签组' },
          stages: { type: 'array', items: { type: 'string' }, description: '四档描述，第一项留空' },
          remove: { type: 'boolean', description: 'true = 删掉这个轴' },
        },
        required: ['key'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        },
        render: (_a, v) => [{ type: 'text', text: String(v?.text ?? '') }],
      },
      async execute(args) {
        const key = String(args?.key ?? '').trim().toLowerCase()
        if (!/^[a-z][a-z0-9_]{1,20}$/.test(key)) return bad(`emotion_axis：key 只能用小写字母/数字/下划线，收到「${args?.key}」`)
        const defs = readDefs(defsFile)
        if (!Array.isArray(defs.axes)) defs.axes = []
        const idx = defs.axes.findIndex((a) => a && a.key === key)

        if (args?.remove === true) {
          if (idx < 0) return bad(`emotion_axis：没有「${key}」这个轴`)
          defs.axes.splice(idx, 1)
          writeDefs(defsFile, defs)
          core.loadDefs()
          return ok(`emotion_axis：已删除「${key}」，剩 ${defs.axes.length} 个轴`)
        }

        const next = idx >= 0 ? { ...defs.axes[idx] } : { key }
        if (typeof args?.zh === 'string' && args.zh.trim()) next.zh = args.zh.trim()
        if (typeof args?.tag === 'string' && args.tag.trim()) next.tag = args.tag.trim()
        if (Number.isFinite(args?.value)) next.value = clamp(Number(args.value), 0, 100)
        if (Number.isFinite(args?.rate)) next.rate = Number(args.rate)
        if (Number.isFinite(args?.decay)) next.decay = Number(args.decay)
        if (Number.isFinite(args?.floor)) next.floor = clamp(Number(args.floor), 0, 100)
        if (Number.isFinite(args?.ceil)) next.ceil = clamp(Number(args.ceil), 0, 100)
        if (args?.polarity === 'pos' || args?.polarity === 'neg' || args?.polarity === 'neutral') next.polarity = args.polarity
        if (Array.isArray(args?.tags)) next.tags = args.tags.filter((t) => typeof t === 'string' && t.trim())
        if (Array.isArray(args?.stages) && args.stages.length === 4) next.stages = args.stages.map((s) => String(s ?? ''))
        if (!next.zh) next.zh = key
        if (!Number.isFinite(next.floor)) next.floor = 10
        if (!Number.isFinite(next.ceil)) next.ceil = 100
        if (!Array.isArray(next.stages)) next.stages = ['', `${key} 上升`, `${key} 主导`, `${key} 拉满`]
        if (!Array.isArray(next.tags)) next.tags = []

        if (idx >= 0) defs.axes[idx] = next
        else defs.axes.push(next)
        if (!writeDefs(defsFile, defs)) return bad('emotion_axis：写配置失败')
        core.loadDefs()
        return ok(`emotion_axis：${idx >= 0 ? '已更新' : '已添加'}「${next.zh}」(${key})，现在共 ${defs.axes.length} 个轴，下一轮生效`)
      },
    })

    register({
      name: 'emotion_distill',
      description: '批量写「他说什么话 → 哪个轴涨/跌多少」。每条规则是正则。replace=true 先清空旧规则。',
      parameters: {
        type: 'object',
        properties: {
          rules: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                axis: { type: 'string' },
                delta: { type: 'number' },
                pattern: { type: 'string' },
              },
            },
          },
          links: {
            type: 'array',
            items: {
              type: 'object',
              properties: { from: { type: 'string' }, to: { type: 'string' }, ratio: { type: 'number' } },
            },
          },
          replace: { type: 'boolean' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        },
        render: (_a, v) => [{ type: 'text', text: String(v?.text ?? '') }],
      },
      async execute(args) {
        const keys = axisKeys()
        const incoming = Array.isArray(args?.rules) ? args.rules : []
        const links = Array.isArray(args?.links) ? args.links : []
        if (!incoming.length && !links.length) return bad('emotion_distill：rules 和 links 都是空的')
        const defs = readDefs(defsFile)
        if (!Array.isArray(defs.rules) || args?.replace === true) defs.rules = []
        if (!Array.isArray(defs.links)) defs.links = []
        let added = 0
        let updated = 0
        let bad_pattern = 0
        for (const r of incoming) {
          if (!r || typeof r.axis !== 'string' || typeof r.pattern !== 'string') continue
          if (!keys.includes(r.axis)) continue
          try {
            new RegExp(r.pattern)
          } catch {
            bad_pattern += 1
            continue
          }
          const prev = defs.rules.find((x) => x && x.axis === r.axis && x.pattern === r.pattern)
          if (prev) {
            prev.delta = Number(r.delta) || 0
            updated += 1
          } else {
            defs.rules.push({ axis: r.axis, delta: Number(r.delta) || 0, pattern: r.pattern })
            added += 1
          }
        }
        let linkAdded = 0
        for (const l of links) {
          if (!l || typeof l.from !== 'string' || typeof l.to !== 'string' || l.from === l.to) continue
          if (!keys.includes(l.from) || !keys.includes(l.to)) continue
          const prev = defs.links.find((x) => x && x.from === l.from && x.to === l.to)
          if (prev) prev.ratio = Number(l.ratio) || -1
          else {
            defs.links.push({ from: l.from, to: l.to, ratio: Number(l.ratio) || -1 })
            linkAdded += 1
          }
        }
        if (!writeDefs(defsFile, defs)) return bad('emotion_distill：写配置失败')
        core.loadDefs()
        const parts = [`新增 ${added} 条、更新 ${updated} 条`]
        if (bad_pattern) parts.push(`正则写错跳过 ${bad_pattern} 条`)
        if (linkAdded) parts.push(`联动 +${linkAdded}`)
        return ok(`emotion_distill：${parts.join('，')}；现在规则 ${defs.rules.length} 条、联动 ${defs.links.length} 条`)
      },
    })

    // ---- 面板子进程 ----
    try {
      ctx.effect(() => {
        const child = startPanel()
        return () => {
          try {
            child?.kill()
          } catch {}
        }
      })
      probe('panel server spawned')
    } catch (err) {
      probe(`panel ERR ${err && err.message}`)
    }
  } catch (err) {
    probe(`apply ERR ${err && (err.stack || err.message)}`)
  }
}

function textOf(message) {
  try {
    const content = message?.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  } catch {
    return ''
  }
}

function lastUserText(session) {
  try {
    const derive = session?.deriveMessages
    if (typeof derive !== 'function') return ''
    const messages = derive.call(session)
    if (!Array.isArray(messages)) return ''
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role !== 'user') continue
      const text = textOf(messages[i])
      if (text) return text
    }
  } catch {}
  return ''
}
