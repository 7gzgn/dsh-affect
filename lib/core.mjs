// dsh-emotion 内核：一个状态、一个写者、一处裁边界。
// 旧实现的问题是「同一个状态有七八个地方各写一遍」，
// 这里把「能改数值」收成一个函数 set()，所有入口都必须走它。
import fs from 'node:fs'
import path from 'node:path'

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

function readJson(file, fb) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fb
  }
}

// 先写临时文件再改名，避免另一个进程读到写了一半的 JSON
function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1))
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

function normAxis(a) {
  if (!a || typeof a.key !== 'string' || !a.key) return null
  const floor = Number.isFinite(a.floor) ? Number(a.floor) : 10
  const ceil = Number.isFinite(a.ceil) ? Number(a.ceil) : 100
  const hi = Math.max(floor, ceil)
  return {
    key: a.key,
    zh: typeof a.zh === 'string' && a.zh.trim() ? a.zh.trim() : a.key,
    value: Number.isFinite(a.value) ? clamp(Number(a.value), floor, hi) : clamp(30, floor, hi),
    floor,
    ceil: hi,
    rate: Number.isFinite(a.rate) ? Number(a.rate) : 0,
    decay: Number.isFinite(a.decay) ? Number(a.decay) : 0,
    polarity: a.polarity === 'pos' || a.polarity === 'neg' ? a.polarity : 'neutral',
    tag: typeof a.tag === 'string' ? a.tag : '',
    tags: Array.isArray(a.tags) ? a.tags.filter((t) => typeof t === 'string' && t) : [],
    stages:
      Array.isArray(a.stages) && a.stages.length === 4
        ? a.stages.map((s) => String(s ?? ''))
        : ['', '', '', ''],
  }
}

function normDefs(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const axes = {}
  for (const a of Array.isArray(src.axes) ? src.axes : []) {
    const n = normAxis(a)
    if (n) axes[n.key] = n
  }
  const rules = (Array.isArray(src.rules) ? src.rules : [])
    .filter((r) => r && typeof r.axis === 'string' && typeof r.pattern === 'string')
    .map((r) => {
      let re = null
      try {
        re = new RegExp(r.pattern)
      } catch {
        re = null
      }
      return { axis: r.axis, delta: Number(r.delta) || 0, pattern: r.pattern, re }
    })
    .filter((r) => r.re)
  const links = (Array.isArray(src.links) ? src.links : [])
    .filter((l) => l && typeof l.from === 'string' && typeof l.to === 'string')
    .map((l) => ({ from: l.from, to: l.to, ratio: Number(l.ratio) || -1 }))
  const events = (Array.isArray(src.events) ? src.events : [])
    .filter((e) => e && typeof e.on === 'string' && typeof e.axis === 'string')
    .map((e) => ({ on: e.on, axis: e.axis, delta: Number(e.delta) || 0 }))
  return { axes, rules, links, events }
}

export function createCore({ stateFile, defsFile, cmdFile, maxElapsedMin = 720 }) {
  let defs = { axes: {}, rules: [], links: [], events: [] }
  let defsMtime = 0
  let state = { axes: {}, lastTick: 0, lastUserAt: 0, born: 0, intro: false }
  let dirty = false
  let inited = false

  // 只在第一次用时读盘；之后内存是权威，否则每次快照都会把内存里的改动冲掉
  function ensure() {
    loadDefs()
    if (!inited) {
      loadState()
      inited = true
      return
    }
    // 配置热载后对齐：新加的轴补基准值，删掉的轴从状态里清掉（不留残影）
    let changed = false
    for (const def of Object.values(defs.axes)) {
      if (!Number.isFinite(state.axes[def.key])) {
        state.axes[def.key] = def.value
        changed = true
      }
    }
    for (const k of Object.keys(state.axes)) {
      if (!defs.axes[k]) {
        delete state.axes[k]
        changed = true
      }
    }
    if (changed) dirty = true
  }

  // ---- 加载 ----
  function loadDefs() {
    try {
      const m = fs.statSync(defsFile).mtimeMs
      if (m === defsMtime) return
      defsMtime = m
      // 文件读不到 / 写坏：当空配置，绝不退回代码里写死的一副默认人设
      defs = normDefs(readJson(defsFile, null))
      // JSON 存不了 RegExp：把规则里的正则字符串编译回对象；坏正则当"永不匹配"，不让它抛
      for (const r of defs.rules) {
        if (!r || typeof r !== 'object') continue
        const src = typeof r.pattern === 'string' ? r.pattern : typeof r.re === 'string' ? r.re : null
        if (src) {
          try { r.re = new RegExp(src, r.flags || 'i') } catch { r.re = /(?!x)x/ }
        }
      }
    } catch {
      if (defsMtime !== -1) {
        defsMtime = -1
        defs = { axes: {}, rules: [], links: [], events: [] }
      }
    }
  }

  function loadState() {
    const raw = readJson(stateFile, null)
    const axes = {}
    for (const key of Object.keys(defs.axes)) {
      const v = raw && raw.axes ? Number(raw.axes[key]) : NaN
      const def = defs.axes[key]
      axes[key] = Number.isFinite(v) ? clamp(v, def.floor, def.ceil) : def.value
    }
    const prev = raw && typeof raw === 'object' ? raw : {}
    state = {
      axes,
      lastTick: Number.isFinite(prev.lastTick) ? Number(prev.lastTick) : 0,
      lastUserAt: Number.isFinite(prev.lastUserAt) ? Number(prev.lastUserAt) : 0,
      born: Number.isFinite(prev.born) ? Number(prev.born) : Date.now(),
      intro: prev.intro === true,
    }
  }

  function commit() {
    dirty = false
    writeJson(stateFile, state)
  }

  // 唯一的写入口：所有数值改动都必须经过它，边界只在这里裁一次
  function set(key, value) {
    const def = defs.axes[key]
    if (!def) return false
    state.axes[key] = clamp(Number(value), def.floor, def.ceil)
    dirty = true
    return true
  }

  function add(key, delta) {
    const def = defs.axes[key]
    if (!def) return false
    const cur = Number.isFinite(state.axes[key]) ? state.axes[key] : def.value
    return set(key, cur + Number(delta || 0))
  }

  // ---- 时间 ----
  function advance(now = Date.now()) {
    const span = Math.min(Math.max(0, (now - (state.lastTick || now)) / 60000), maxElapsedMin)
    if (span > 0) {
      for (const def of Object.values(defs.axes)) {
        const cur = Number.isFinite(state.axes[def.key]) ? state.axes[def.key] : def.value
        // 只朝基准值回归，不单向累积
        const k = Math.min(1, (Math.abs(def.rate) + def.decay) * span * 0.3)
        set(def.key, k > 0 ? cur + (def.value - cur) * k : cur)
      }
      for (const l of defs.links) {
        if (!defs.axes[l.from] || !defs.axes[l.to]) continue
        const from = state.axes[l.from]
        const pressure = ((from - 50) / 50) * l.ratio * span * 0.05
        add(l.to, -pressure)
      }
    }
    state.lastTick = now
    dirty = true
    return span
  }

  function minutesSinceUser(now = Date.now()) {
    const t = state.lastUserAt || state.lastTick || now
    return Math.max(0, (now - t) / 60000)
  }

  // ---- 注入文本 ----
  function render(now = Date.now()) {
    ensure()
    advance(now)
    commit()

    const entries = Object.values(defs.axes)
    if (entries.length === 0) return ''

    const mins = minutesSinceUser(now)
    const human =
      mins < 1 ? '刚刚还在一起'
        : mins < 60 ? `隔了 ${Math.round(mins)} 分钟`
          : mins < 1440 ? `隔了 ${(mins / 60).toFixed(mins < 180 ? 1 : 0)} 小时`
            : `隔了 ${(mins / 1440).toFixed(1)} 天`

    const stageOf = (v) => (v >= 90 ? 3 : v >= 60 ? 2 : v >= 30 ? 1 : 0)
    const lines = ['## 情绪状态（外部状态机维护，只读）']
    lines.push(entries.map((d) => `${d.zh} ${Math.round(state.axes[d.key])}`).join(' · '))
    lines.push(`距上次说话：${human}。`)

    const active = entries
      .map((d) => [d, state.axes[d.key]])
      .filter(([, v]) => stageOf(v) > 0)
      .sort((a, b) => b[1] - a[1])

    lines.push('')
    if (active.length === 0) {
      lines.push('所有轴都在 30 以下：正常说话，不表现情绪。')
    } else {
      lines.push('当前阶段（数值决定说到哪一层，不用解释）：')
      for (const [def, v] of active.slice(0, 4)) {
        const s = stageOf(v)
        const label = s === 3 ? 'MAX' : s === 2 ? '高' : '中'
        const pool = def.tags
        let picked = []
        if (s === 1) {
          if (Math.random() < 0.5 && pool.length) picked = [pool[Math.floor(Math.random() * pool.length)]]
        } else if (s === 2) {
          if (Math.random() < 0.75 && pool.length) {
            const n = Math.min(pool.length, Math.random() < 0.5 ? 1 : 2)
            const copy = [...pool]
            for (let i = 0; i < n; i += 1) picked.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0])
          }
        } else picked = [...pool]
        const tags = picked.length ? `｜${picked.join(' / ')}` : ''
        const pol = def.polarity === 'pos' ? '（正）' : def.polarity === 'neg' ? '（负）' : ''
        lines.push(`- ${def.zh}${pol} ${Math.round(v)}（${label}）：${def.stages[s] ?? ''}${tags}`)
      }
      lines.push('（标签是抽给你看的，不是全用——按当前这句需要选一两个）')
    }

    const heavy = active.filter(([, v]) => v >= 90)
    if (heavy.length) {
      const tag = heavy.map(([d, v]) => `${d.zh}${Math.round(v)}`).join(' ／ ')
      lines.push(`**90 以上的要在回复最后单独写一行**：〔触发 ${tag}〕。只这一行，不解释。`)
    }
    lines.push('')
    lines.push('规则：这些数字不是你算的，不许自己改，也别在正文里报别的数字。说到哪一层就停在哪一层，不用说明为什么。')
    return lines.join('\n')
  }

  // ---- 他的消息 → 自动加减 ----
  function applyRules(text, now = Date.now()) {
    if (!text) return []
    ensure()
    const gap = minutesSinceUser(now)
    advance(now)
    const hit = []
    const note = (key, delta) => {
      if (add(key, delta)) hit.push(`${key}${delta > 0 ? '+' : ''}${Math.round(delta)}`)
    }

    for (const r of defs.rules) {
      if (!r || !defs.axes[r.axis]) continue
      if (!(r.re instanceof RegExp)) continue
      if (!r.re.test(text)) continue
      note(r.axis, r.delta)
    }

    const len = text.trim().length
    const isAsk = /[？?]/.test(text) || /[吗呢嘛]\s*$|什么|怎么|哪个|几|多少|是不是|有没有/.test(text)
    const ex = (text.match(/[！!]/g) ?? []).length
    if (len <= 8 && !isAsk) note('control', 4)
    if (len <= 8 && isAsk) note('possess', 3)
    if (len >= 120) note('sloth', -4)
    if (ex >= 2) note('anger', 2)
    if (gap >= 180) note('love', 4)
    else if (gap <= 1) note('sloth', -2)

    state.lastUserAt = now
    dirty = true
    commit()
    return hit
  }

  function applyEvent(kind, now = Date.now()) {
    if (!defs.events.length) return []
    ensure()
    advance(now)
    const hit = []
    for (const e of defs.events) {
      if (e.on !== kind) continue
      if (add(e.axis, e.delta)) hit.push(`${e.axis}${e.delta > 0 ? '+' : ''}${e.delta}`)
    }
    if (hit.length) commit()
    return hit
  }

  // ---- 面板命令队列：面板进程只追加，主进程消费（保证只有一个写者）----
  function drainCommands() {
    if (!cmdFile) return []
    let raw = ''
    try {
      raw = fs.readFileSync(cmdFile, 'utf8')
    } catch {
      return []
    }
    if (!raw.trim()) return []
    try {
      fs.unlinkSync(cmdFile)
    } catch {}
    ensure()
    const out = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let cmd = null
      try {
        cmd = JSON.parse(line)
      } catch {
        continue
      }
      if (!cmd || typeof cmd !== 'object') continue
      if (cmd.op === 'set' && typeof cmd.key === 'string') {
        if (set(cmd.key, cmd.value)) out.push(`set ${cmd.key}=${Math.round(state.axes[cmd.key])}`)
      } else if (cmd.op === 'add' && typeof cmd.key === 'string') {
        if (add(cmd.key, cmd.delta)) out.push(`add ${cmd.key}`)
      }
    }
    if (dirty) commit()
    return out
  }

  // ---- 对外快照 ----
  function snapshot() {
    ensure()
    return {
      axes: Object.fromEntries(Object.keys(defs.axes).map((k) => [k, state.axes[k]])),
      defs,
      lastUserAt: state.lastUserAt,
      lastTick: state.lastTick,
    }
  }

  return { render, applyRules, applyEvent, advance, set, add, snapshot, drainCommands, loadDefs, loadState, commit }
}
