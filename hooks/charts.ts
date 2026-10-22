// The pane's charts, drawn with characters: block glyphs for heights, a
// colour per run of text. Every surface draws text, so the same lines show in
// the terminal and in VS Code (whose Claude panel does not draw SVG).
//
// Pure functions from rows to lines; a line is runs of text sharing a colour,
// sized to the columns the pane gives the body.

import type { AgentRow, BreakdownRow, RateLimitRow, StepRow } from '../types'

export const MAX_BARS = 240
export const MAX_AGENT_LANES = 6

const CYAN = '#39c5cf'
const AMBER = '#d29922'
const ORANGE = '#f0883e'
const RED = '#f85149'
const GREEN = '#3fb950'
const DIM = '#8b949e'
const MAIN = '#3b82c4'
const PALETTE = ['#d07028', '#c24878', '#6d8f1c', '#1f9990', '#9a8818', '#9838a0', '#5060d4']
const SLICES = ['#1f6feb', '#2ea043', '#e3b341', '#bc8cff', '#f0883e', '#39c5cf', '#d2a8ff', '#c24878']
// A blank cell is a no-break space: VS Code draws the pane as HTML, where a
// run of plain spaces collapses to one and every column after it shifts left.
const BLANK = '\u00a0'
const BLOCKS = [BLANK, '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
/** About how many columns a typical request may take before the chart stops stretching. */
const MAX_REQUEST_COLS = 4

export type Run = { text: string; color?: string; dim?: boolean }
export type Line = Run[]
type Cell = { ch: string; color?: string; dim?: boolean }

/**
 * Cells to grid runs: only neighbours of one glyph and one colour join, so a
 * run is `text.length` cells of the same thing. The pane draws each run in a
 * box of that many columns: VS Code shows plugin text in a proportional face,
 * and only boxes keep the columns of two rows lined up there.
 */
function toGrid(cells: Cell[]): Line {
  const out: Line = []
  for (const c of cells) {
    const last = out[out.length - 1]
    if (last !== undefined && last.text[0] === c.ch && last.color === c.color && last.dim === c.dim) last.text += c.ch
    else out.push({ text: c.ch, color: c.color, dim: c.dim })
  }
  return out
}

/** Cells to runs of text: neighbours of one colour become one run. */
function toLine(cells: Cell[]): Line {
  const out: Line = []
  for (const c of cells) {
    const last = out[out.length - 1]
    if (last !== undefined && last.color === c.color && last.dim === c.dim) last.text += c.ch
    else out.push({ text: c.ch, color: c.color, dim: c.dim })
  }
  return out
}

function tok(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return String(value)
}

function usd(value: number): string {
  return value >= 0.01 ? `$${value.toFixed(2)}` : value > 0 ? '<$0.01' : '$0'
}

export function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${(h / 24).toFixed(1)}d`
}

// ---------- time with the idle stretches squeezed out ----------

type Span = { start: number; end: number }

/**
 * A time axis over where something ran: stretches of activity keep their
 * length, and each idle stretch between them shrinks to `gap` columns.
 */
export function squeezedScale(spans: Span[], width: number, gap = 1, joinMs = 120_000, maxPerMs = Infinity) {
  const segments: Span[] = []
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = segments[segments.length - 1]
    if (last !== undefined && s.start - last.end <= joinMs) last.end = Math.max(last.end, s.end)
    else segments.push({ start: s.start, end: Math.max(s.end, s.start + 1) })
  }
  const active = segments.reduce((a, s) => a + (s.end - s.start), 0) || 1
  const gaps = Math.max(0, segments.length - 1)
  const perMs = Math.min(maxPerMs, Math.max(1, width - gaps * gap) / active)
  const offsets: number[] = []
  let at = 0
  segments.forEach((s, i) => {
    offsets.push(at)
    at += (s.end - s.start) * perMs + (i < segments.length - 1 ? gap : 0)
  })
  const x = (t: number): number => {
    if (segments.length === 0) return 0
    let i = segments.length - 1
    while (i > 0 && segments[i]!.start > t) i--
    const s = segments[i]!
    return offsets[i]! + Math.min(Math.max(t - s.start, 0), s.end - s.start) * perMs
  }
  const breaks = segments.slice(1).map((s, i) => ({ x: offsets[i + 1]! - gap / 2, idleMs: s.start - segments[i]!.end }))
  const spanMs = segments.length ? segments[segments.length - 1]!.end - segments[0]!.start : 0
  return { x, breaks, spanMs, activeMs: active }
}

// ---------- the request lanes ----------

export type Lane = { key: string; name: string; color: string; detail: string; steps: StepRow[] }

/** Main first, then the most recent agents, each with its colour and line of figures. */
export function lanesOf(steps: StepRow[], agents: AgentRow[], now: number): Lane[] {
  const recent = steps.slice(-MAX_BARS)
  const byLoop = new Map<string, StepRow[]>()
  for (const s of recent) {
    if (!byLoop.has(s.loop)) byLoop.set(s.loop, [])
    byLoop.get(s.loop)!.push(s)
  }
  const figures = (list: StepRow[]) => {
    const cost = list.reduce((a, s) => a + s.costUsd, 0)
    const peak = list.reduce((a, s) => Math.max(a, s.ctx), 0)
    return `${list.length} req · peak ${Math.round(peak)}% · ${usd(cost)}`
  }
  const lanes: Lane[] = []
  const main = byLoop.get('') ?? []
  const model = main[main.length - 1]?.model?.replace(/^claude-/, '')
  lanes.push({ key: '', name: 'main', color: MAIN, detail: `${model ? model + ' · ' : ''}${figures(main)}`, steps: main })
  const others = [...byLoop.entries()]
    .filter(([key]) => key !== '')
    .sort((a, b) => (b[1][b[1].length - 1]?.startedAt ?? 0) - (a[1][a[1].length - 1]?.startedAt ?? 0))
    .slice(0, MAX_AGENT_LANES)
    .sort((a, b) => (a[1][0]?.startedAt ?? 0) - (b[1][0]?.startedAt ?? 0))
  others.forEach(([key, list], i) => {
    const agent = agents.find(a => a.id === key)
    const mark = agent === undefined ? '' : agent.isRunning ? ' ●' : agent.reason === 'answer' ? ' ✓' : ' ✗'
    const took = agent ? dur((agent.endedAt ?? now) - agent.startedAt) : ''
    lanes.push({
      key,
      name: `${agent?.type ?? 'agent'} ${key.slice(0, 4)}${mark}`,
      color: PALETTE[i % PALETTE.length]!,
      detail: `${took ? took + ' · ' : ''}${figures(list)}`,
      steps: list,
    })
  })
  return lanes
}

/** What a column's requests say together: the tallest, the worst cache, any error. */
type Column = { ctx: number; hit: number; isError: boolean; isRunning: boolean; n: number }

function cacheColor(c: Column): string {
  if (c.isError) return RED
  if (c.isRunning) return DIM
  return c.hit >= 80 ? CYAN : c.hit >= 50 ? AMBER : ORANGE
}

export type LaneChart = { lanes: { lane: Lane; title: Line; rows: Line[] }[]; footer: Line; note: string }

/**
 * Two rows of block glyphs per lane: a column per slice of (squeezed) time,
 * as tall as the fullest context there relative to the lane's peak, coloured
 * by how well the cache served it.
 */
export function laneChart(lanes: Lane[], cols: number, now: number): LaneChart {
  const width = Math.max(10, cols)
  const all = lanes.flatMap(l => l.steps)
  // Few requests do not stretch across the pane: the chart grows rightwards.
  const durations = all.map(s => (s.endedAt ?? now) - s.startedAt).sort((a, b) => a - b)
  const typical = Math.max(2_000, durations[Math.floor(durations.length / 2)] ?? 0)
  const scale = squeezedScale(all.map(s => ({ start: s.startedAt, end: s.endedAt ?? now })), width, 1, 120_000, MAX_REQUEST_COLS / typical)
  const breakCols = new Set(scale.breaks.map(b => Math.max(0, Math.min(width - 1, Math.floor(b.x)))))
  const out: LaneChart['lanes'] = lanes.map(lane => {
    const columns: (Column | undefined)[] = new Array(width).fill(undefined)
    for (const s of lane.steps) {
      const c0 = Math.max(0, Math.min(width - 1, Math.floor(scale.x(s.startedAt))))
      const c1 = Math.max(c0, Math.min(width - 1, Math.ceil(scale.x(s.endedAt ?? now)) - 1))
      const u = s.usage ?? [0, 0, 0, 0]
      const prompt = u[0] + u[2] + u[3]
      const hit = prompt ? (u[2] / prompt) * 100 : 100
      for (let c = c0; c <= c1; c++) {
        const was = columns[c]
        columns[c] = {
          ctx: Math.max(was?.ctx ?? 0, s.ctx),
          hit: Math.min(was?.hit ?? 100, hit),
          isError: (was?.isError ?? false) || s.errors > 0,
          isRunning: (was?.isRunning ?? false) || s.endedAt === undefined,
          n: (was?.n ?? 0) + 1,
        }
      }
    }
    const peak = Math.max(10, ...columns.map(c => c?.ctx ?? 0))
    const top: Cell[] = []
    const bottom: Cell[] = []
    columns.forEach((c, i) => {
      // An idle stretch's mark wins its column: a bar's edge is worth less
      // than seeing where an hour went missing.
      if (c === undefined || breakCols.has(i)) {
        const ch = breakCols.has(i) ? '┊' : BLANK
        top.push({ ch, color: DIM, dim: true })
        bottom.push({ ch, color: DIM, dim: true })
        return
      }
      const level = Math.max(1, Math.min(16, Math.round((c.ctx / peak) * 16)))
      const color = cacheColor(c)
      top.push({ ch: BLOCKS[Math.max(0, level - 8)]!, color })
      bottom.push({ ch: BLOCKS[Math.min(8, level)]!, color })
    })
    const title: Line = [{ text: lane.name, color: lane.color }, { text: `  ${lane.detail}`, dim: true }]
    return { lane, title, rows: [toGrid(top), toGrid(bottom)] }
  })
  const span = scale.spanMs ? `跨 ${dur(scale.spanMs)}，作用中 ${dur(scale.activeMs)}` : ''
  const footer: Line = [
    { text: '█', color: CYAN },
    { text: ' 命中≥80% ', dim: true },
    { text: '█', color: AMBER },
    { text: ' ≥50% ', dim: true },
    { text: '█', color: ORANGE },
    { text: ' <50% ', dim: true },
    { text: '█', color: RED },
    { text: ' 錯誤', dim: true },
    { text: `  ${span}${breakCols.size ? ' · ┊ 閒置已壓縮' : ''}`, dim: true },
  ]
  return { lanes: out, footer, note: '高度＝context，依各 lane 的最高點縮放' }
}

// ---------- subagents ----------

export type GanttRow = { agent: AgentRow; title: Line; bar: Line }

/** One bar per subagent from its start to its end, on the session's squeezed clock. */
export function agentGantt(agents: AgentRow[], steps: StepRow[], cols: number, now: number): GanttRow[] {
  const width = Math.max(10, cols - 2)
  const list = [...agents].sort((a, b) => a.startedAt - b.startedAt).slice(-12)
  const scale = squeezedScale(
    [...steps.slice(-MAX_BARS).map(s => ({ start: s.startedAt, end: s.endedAt ?? now })), ...list.map(a => ({ start: a.startedAt, end: a.endedAt ?? now }))],
    width,
  )
  const breakCols = new Set(scale.breaks.map(b => Math.max(0, Math.min(width - 1, Math.floor(b.x)))))
  return list.map((a, i) => {
    const color = PALETTE[i % PALETTE.length]!
    const c0 = Math.max(0, Math.min(width - 1, Math.floor(scale.x(a.startedAt))))
    const c1 = Math.max(c0, Math.min(width - 1, Math.ceil(scale.x(a.endedAt ?? now)) - 1))
    const [mark, markColor] = a.isRunning ? ['●', AMBER] : a.reason === 'answer' ? ['✓', GREEN] : ['✗', RED]
    const cells: Cell[] = []
    for (let c = 0; c < width; c++) {
      if (c >= c0 && c <= c1) cells.push({ ch: a.isRunning && c === c1 ? '▒' : '█', color: a.toolErrors && c === c1 ? RED : color })
      else cells.push(breakCols.has(c) ? { ch: '┊', color: DIM, dim: true } : { ch: BLANK })
    }
    cells.push({ ch: BLANK }, { ch: mark, color: markColor })
    const title: Line = [
      { text: a.type, color },
      { text: `  ${a.description.slice(0, 48)}`, dim: true },
      { text: `  ${dur((a.endedAt ?? now) - a.startedAt)} · ${usd(a.costUsd)}${a.toolErrors ? ` · ${a.toolErrors} 錯誤` : ''}`, dim: true },
    ]
    return { agent: a, title, bar: toGrid(cells) }
  })
}

// ---------- context and quota ----------

/** What fills the window: one stacked bar, then a legend. */
export function compositionChart(rows: BreakdownRow[], cols: number): { bar: Line; legend: Line[] } {
  const width = Math.max(10, cols)
  const shown = rows.filter(r => r.tokens > 0 && r.kind !== 'deferred')
  const total = shown.reduce((a, r) => a + r.tokens, 0) || 1
  const colorOf = (r: BreakdownRow, i: number) => (r.kind === 'free' ? DIM : r.kind === 'buffer' ? '#6e7681' : SLICES[i % SLICES.length]!)
  // Every slice at least one cell; the largest gives back what rounding took.
  const sizes = shown.map(r => Math.max(1, Math.round((r.tokens / total) * width)))
  const over = sizes.reduce((a, b) => a + b, 0) - width
  if (over !== 0 && sizes.length) {
    const big = sizes.indexOf(Math.max(...sizes))
    sizes[big] = Math.max(1, sizes[big]! - over)
  }
  const cells: Cell[] = []
  shown.forEach((r, i) => {
    for (let k = 0; k < sizes[i]!; k++) cells.push({ ch: r.kind === 'free' ? '░' : '█', color: colorOf(r, i), dim: r.kind === 'free' })
  })
  const perLine = width >= 60 ? 2 : 1
  const legend: Line[] = []
  shown.forEach((r, i) => {
    const entry: Run[] = [
      { text: '■ ', color: colorOf(r, i) },
      { text: `${r.name} ${tok(r.tokens)}`.padEnd(Math.floor(width / perLine) - 2), dim: true },
    ]
    if (i % perLine === 0) legend.push(entry)
    else legend[legend.length - 1]!.push(...entry)
  })
  return { bar: toGrid(cells), legend }
}

/** Each rate-limit window: a label, and a bar with where its time stands marked. */
export function quotaChart(limits: RateLimitRow[], cols: number, now: number): { label: string; bar: Line }[] {
  const width = Math.max(10, cols)
  const windows: Record<string, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 }
  return limits.map(r => {
    const name = r.kind === 'five_hour' ? '5 小時' : r.kind === 'seven_day' ? '7 天' : r.kind
    const reset = r.resetsAt ? Date.parse(r.resetsAt) - now : NaN
    const len = windows[r.kind]
    const timeCol = len && reset > 0 ? Math.min(width - 1, Math.floor((1 - reset / len) * width)) : -1
    const color = r.percentUsed >= 85 ? RED : r.percentUsed >= 60 ? AMBER : GREEN
    const used = Math.round((Math.min(100, r.percentUsed) / 100) * width)
    const cells: Cell[] = []
    for (let c = 0; c < width; c++) {
      if (c === timeCol) cells.push({ ch: '┃', color: '#e6edf3' })
      else cells.push(c < used ? { ch: '█', color } : { ch: '░', color: DIM, dim: true })
    }
    const label = `${name} ${r.percentUsed}%${Number.isFinite(reset) && reset > 0 ? ` · ${dur(reset)} 後重置` : ''}${timeCol >= 0 ? ' · ┃ 時間已過' : ''}`
    return { label, bar: toGrid(cells) }
  })
}
