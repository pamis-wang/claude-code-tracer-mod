// The web dashboard's recorder: what happened in this session, written to
// `~/.claude/tracer/data/` as script files the page loads from disk.
//
// One file per session (summary rows of turns, requests, tool calls, agents),
// one per main turn for the bulky text (prompts, answers, tool inputs and
// results), one for the system prompt, and a shared index of every session.
// Each file is `__tracer(<json>);` so a page opened from file:// can load it
// with a script tag, which fetch() cannot do there.

import type { EngineInterface } from 'claude-code'

type Engine = EngineInterface

const TEXT_CAP = 20_000
const TOOL_INPUT_CAP = 4_000
const TOOL_RESULT_CAP = 8_000
const RETENTION_MS = 120 * 24 * 3_600_000
const FLUSH_MS = 1_500
const WEB_FILES = ['index.html', 'style.css', 'app.js', 'timeline.js', 'pages.js']

export type Usage4 = [input: number, output: number, cacheRead: number, cacheWrite: number]

export type StepRec = {
  id: string
  turn: number
  loop: string
  index: number
  startedAt: number
  firstAt?: number
  endedAt?: number
  model?: string
  effort?: string | number
  messages: number
  usage?: Usage4
  costUsd?: number
  stop?: string | null
  tools: string[]
  answerChars: number
  hasThinking: boolean
}

export type ToolRec = {
  id: string
  name: string
  loop: string
  turn: number
  startedAt: number
  endedAt?: number
  isError?: boolean
  isDenied?: boolean
  summary: string
  /** A hash of the exact input: the same call made again shows as a loop. */
  sig?: string
}

export type TurnRec = {
  n: number
  id: string
  prompt: string
  startedAt: number
  endedAt?: number
  reason?: string
  costAtStart: number
  costUsd?: number
}

export type AgentRec = {
  id: string
  type: string
  description: string
  model?: string
  parentId?: string
  isBackground: boolean
  turn: number
  startedAt: number
  endedAt?: number
  reason?: string
}

export type SessionRec = {
  id: string
  project: string
  cwd: string
  title: string
  startedAt: number
  updatedAt: number
  ttlMs: number
  meter: Record<string, unknown>
  turns: TurnRec[]
  steps: StepRec[]
  tools: ToolRec[]
  agents: AgentRec[]
}

export type TurnDetail = {
  prompt: string
  answer?: string
  steps: Record<string, { answer: string; thinking: string }>
  tools: Record<string, { input: string; result: string }>
  agents: Record<string, { prompt: string; answer?: string }>
}

export type PromptRec = {
  versions: { n: number; at: number; model: string; hash: string; chars: number; changed: string[]; added: string[]; removed: string[] }[]
  current: { id: string; text: string }[]
  previous: { id: string; text: string }[]
}

type IndexEntry = {
  id: string
  project: string
  cwd: string
  title: string
  model?: string
  startedAt: number
  updatedAt: number
  turns: number
  requests: number
  agents: number
  costUsd: number
  tokens: Usage4
  contextPct?: number
  lastMainResponseAt?: number
  /** A turn or request still open: streaming, if the session is also recent. */
  isBusy: boolean
  lastPrompt: string
  toolErrors: number
  ttlMs: number
  hourly: [hour: number, cost: number, ...tokens: Usage4][]
  weather: Weather
  /** A request or tool call the person is being asked about right now. */
  held?: { kind: 'request' | 'tool'; since: number }
}

export type Flags = { stats: boolean; intercept: 'off' | 'next' | 'all'; interceptTools: boolean }

type IndexFile = {
  updatedAt: number
  limits?: { at: number; rateLimits: unknown[] }
  flags?: Flags & { at: number }
  sessions: IndexEntry[]
}

/** A session's health: the strongest signal plus a third of the runner-up. */
export type Weather = { score: number; factors: { name: string; severity: number; detail: string }[] }

// ---------- module state ----------

let base = ''
let rec: SessionRec | null = null
let prompt: PromptRec = { versions: [], current: [], previous: [] }
const details = new Map<number, TurnDetail>()
const dirtyTurns = new Set<number>()
let isSessionDirty = false
let isPromptDirty = false
let flushTimer: { cancel: () => void } | null = null
let lastLimits: { at: number; rateLimits: unknown[] } | undefined
let flags: (Flags & { at: number }) | undefined
let held: IndexEntry['held']

// ---------- files ----------

function wrap(kind: string, data: unknown): string {
  return `__tracer(${JSON.stringify({ kind, data })});\n`
}

function unwrap<T>(text: string): T | undefined {
  const start = text.indexOf('(')
  const end = text.lastIndexOf(')')
  if (start < 0 || end <= start) return undefined
  try {
    return (JSON.parse(text.slice(start + 1, end)) as { data: T }).data
  } catch {
    return undefined
  }
}

async function readData<T>($: Engine, path: string): Promise<T | undefined> {
  try {
    return (await $.fs.exists(path)) ? unwrap<T>(await $.fs.read(path)) : undefined
  } catch {
    return undefined
  }
}

function sessionDir(): string {
  return `${base}/data/s/${rec?.id ?? 'unknown'}`
}

export function dashboardPath(): string {
  return `${base}/index.html`
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（截斷，原長 ${text.length} 字元）`
}

function projectOf(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

/**
 * How a turn's prompt reads in a list: without the IDE's and the engine's
 * blocks around it, and a background task's notification as its summary.
 */
export function promptLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat.startsWith('<task-notification>')) {
    const bare = flat.replace(/<(ide_[a-z_]+|system-reminder)>.*?<\/\1>/g, ' ').replace(/\s+/g, ' ').trim()
    return bare || flat
  }
  const pick = (tag: string) => flat.match(new RegExp(`<${tag}>(.*?)</${tag}>`))?.[1]?.trim()
  return `🔔 ${pick('summary') ?? `背景任務 ${pick('status') ?? ''}`.trim()}`
}

function isNotification(text: string): boolean {
  return text.trimStart().startsWith('<task-notification>')
}

// ---------- start ----------

export async function startRecorder($: Engine, ttlMs: number): Promise<void> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  base = `${home.replace(/\\/g, '/')}/.claude/tracer`

  for (const name of WEB_FILES) {
    try {
      const source = await $.fs.read(`${$.plugin.root}/web/${name}`)
      const target = `${base}/${name}`
      const existing = (await $.fs.exists(target)) ? await $.fs.read(target) : undefined
      if (existing !== source) await $.fs.write(target, source)
    } catch {
      // A missing asset leaves the page as it was.
    }
  }

  const id = await $.session.id()
  const cwd = await $.session.cwd()
  const now = await $.clock.now()
  details.clear()
  dirtyTurns.clear()
  const kept = rec?.id === id ? rec : await readData<SessionRec>($, `${base}/data/s/${id}.js`)
  rec = kept ?? {
    id,
    project: projectOf(cwd),
    cwd,
    title: '',
    startedAt: now,
    updatedAt: now,
    ttlMs,
    meter: {},
    turns: [],
    steps: [],
    tools: [],
    agents: [],
  }
  rec.ttlMs = ttlMs
  // The engine may compose the system prompt before this start runs: keep
  // what was already heard over an empty or older file.
  if (prompt.versions.length === 0) {
    prompt = (await readData<PromptRec>($, `${base}/data/s/${id}/prompt.js`)) ?? prompt
  }
  if (prompt.versions.length > 0) isPromptDirty = true
  isSessionDirty = true
  schedule($)
}

/** After a /clear the conversation starts over under a fresh record. */
export async function clearRecorder($: Engine): Promise<void> {
  await flush($)
  rec = null
}

// ---------- events ----------

function currentTurn(): TurnRec | undefined {
  return rec?.turns[rec.turns.length - 1]
}

async function ensureRec($: Engine): Promise<SessionRec | null> {
  if (rec === null && base !== '') await startRecorder($, 60 * 60_000)
  return rec
}

async function detailOf($: Engine, n: number): Promise<TurnDetail> {
  let d = details.get(n)
  if (d === undefined) {
    d = (await readData<TurnDetail>($, `${sessionDir()}/t${n}.js`)) ?? { prompt: '', steps: {}, tools: {}, agents: {} }
    details.set(n, d)
  }
  return d
}

export async function recordTurnStart($: Engine, turnId: string, text: string, now: number, costAtStart: number): Promise<void> {
  const r = await ensureRec($)
  if (r === null) return
  const n = (currentTurn()?.n ?? 0) + 1
  r.turns.push({ n, id: turnId, prompt: promptLabel(text).slice(0, 300), startedAt: now, costAtStart })
  if (r.title === '' && text.trim() !== '' && !isNotification(text)) r.title = promptLabel(text).slice(0, 80)
  const d = await detailOf($, n)
  d.prompt = cap(text, TEXT_CAP)
  touch($, n)
}

export async function recordTurnEnd($: Engine, turnId: string, answer: string, reason: string, now: number, cost: number): Promise<void> {
  const turn = rec?.turns.find(t => t.id === turnId)
  if (turn === undefined) return
  turn.endedAt = now
  turn.reason = reason
  turn.costUsd = Math.max(0, cost - turn.costAtStart)
  const d = await detailOf($, turn.n)
  d.answer = cap(answer, TEXT_CAP)
  touch($, turn.n)
  // A headless run can exit right after its last turn: write now, not later.
  await flush($)
}

export async function recordAgentSpawn(
  $: Engine,
  agent: Omit<AgentRec, 'turn'>,
  task: string,
): Promise<void> {
  const r = await ensureRec($)
  if (r === null) return
  const turn = currentTurn()?.n ?? 0
  r.agents = [...r.agents.filter(a => a.id !== agent.id), { ...agent, turn }]
  const d = await detailOf($, turn)
  d.agents[agent.id] = { prompt: cap(task, TEXT_CAP) }
  touch($, turn)
}

export async function recordAgentEnd($: Engine, agentId: string, answer: string, reason: string, now: number): Promise<void> {
  const agent = rec?.agents.find(a => a.id === agentId)
  if (agent === undefined) return
  agent.endedAt = now
  agent.reason = reason
  const d = await detailOf($, agent.turn)
  d.agents[agentId] = { prompt: d.agents[agentId]?.prompt ?? '', answer: cap(answer, TEXT_CAP) }
  touch($, agent.turn)
}

export function stepOpen(
  turnId: string,
  index: number,
  loop: string,
  model: string,
  effort: string | number | undefined,
  messages: number,
  now: number,
): StepRec | undefined {
  if (rec === null) return undefined
  const step: StepRec = {
    id: `${turnId}:${index}`,
    turn: currentTurn()?.n ?? 0,
    loop,
    index,
    startedAt: now,
    model,
    effort,
    messages,
    tools: [],
    answerChars: 0,
    hasThinking: false,
  }
  rec.steps.push(step)
  isSessionDirty = true
  return step
}

export async function stepClose(
  $: Engine,
  step: StepRec,
  result: { answer: string; thinking: string; usage: Usage4 | undefined; model?: string; stop: string | null; costUsd: number },
  now: number,
): Promise<void> {
  step.endedAt = now
  step.usage = result.usage
  step.model = result.model ?? step.model
  step.stop = result.stop
  step.costUsd = result.costUsd
  step.answerChars = result.answer.length
  step.hasThinking = result.thinking.length > 0
  const d = await detailOf($, step.turn)
  d.steps[step.id] = { answer: cap(result.answer, TEXT_CAP), thinking: cap(result.thinking, TEXT_CAP) }
  touch($, step.turn)
}

export function toolOpen(id: string, name: string, loop: string, summary: string, sig: string, now: number): ToolRec | undefined {
  if (rec === null) return undefined
  const tool: ToolRec = { id, name, loop, turn: currentTurn()?.n ?? 0, startedAt: now, summary, sig }
  rec.tools.push(tool)
  const owner = [...rec.steps].reverse().find(s => s.loop === loop)
  if (owner !== undefined && !owner.tools.includes(id)) owner.tools.push(id)
  isSessionDirty = true
  return tool
}

export async function toolClose(
  $: Engine,
  tool: ToolRec,
  input: string,
  result: string,
  isError: boolean,
  isDenied: boolean,
  now: number,
): Promise<void> {
  tool.endedAt = now
  tool.isError = isError || undefined
  tool.isDenied = isDenied || undefined
  const d = await detailOf($, tool.turn)
  d.tools[tool.id] = { input: cap(input, TOOL_INPUT_CAP), result: cap(result, TOOL_RESULT_CAP) }
  touch($, tool.turn)
}

export function recordMeter($: Engine, meter: Record<string, unknown>, now: number): void {
  if (rec === null) return
  rec.meter = { ...rec.meter, ...meter }
  const limits = meter.rateLimits
  if (Array.isArray(limits) && limits.length > 0) lastLimits = { at: now, rateLimits: limits }
  isSessionDirty = true
  schedule($)
}

export function recordPrompt($: Engine, next: PromptRec): void {
  prompt = next
  isPromptDirty = true
  schedule($)
}

/** The mod's switches, shown on the page; the page cannot change them. */
export function recordFlags($: Engine, next: Flags, now: number): void {
  flags = { ...next, at: now }
  isSessionDirty = true
  schedule($)
}

/** Marks a request or tool call as held for the person's answer, or releases it. */
export async function recordHeld($: Engine, kind: 'request' | 'tool' | null, now: number): Promise<void> {
  held = kind === null ? undefined : { kind, since: now }
  isSessionDirty = true
  await flush($)
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function median(list: number[]): number {
  const sorted = [...list].sort((a, b) => a - b)
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!
}

/** Eight signals of a session going badly, each from 0 (fine) to 1 (bad). */
export function weatherOf(r: SessionRec): Weather {
  const main = r.steps.filter(s => s.loop === '' && s.usage !== undefined)
  const prompt = (s: StepRec) => (s.usage ? s.usage[0] + s.usage[2] + s.usage[3] : 0)
  const factors: Weather['factors'] = []
  const add = (name: string, severity: number, detail: string) => factors.push({ name, severity: clamp(severity), detail })

  const ctx = typeof r.meter.contextPct === 'number' ? r.meter.contextPct : 0
  add('context 壓力', (ctx - 50) / 45, `context ${ctx}%`)

  let compactions = 0
  main.forEach((s, k) => {
    const prev = main[k - 1]
    if (s.stop === 'compaction' || (prev && prompt(prev) > 20_000 && prompt(s) < prompt(prev) * 0.6)) compactions++
  })
  add('compaction', compactions * 0.3, `${compactions} 次`)

  const cut = r.steps.filter(s => s.stop === 'max_tokens' || s.stop === 'refusal' || s.stop === 'model_context_window_exceeded').length
  add('截斷／拒答', cut * 0.5, `${cut} 次`)

  let repeat = 1
  let worst = 1
  r.tools.forEach((t, k) => {
    const prev = r.tools[k - 1]
    repeat = prev && prev.loop === t.loop && prev.name === t.name && prev.sig !== undefined && prev.sig === t.sig ? repeat + 1 : 1
    worst = Math.max(worst, repeat)
  })
  add('卡住迴圈', (worst - 2) * 0.3, `同一個工具呼叫連續 ${worst} 次`)

  const durations = main.filter(s => s.endedAt !== undefined).map(s => s.endedAt! - s.startedAt)
  const drift = durations.length >= 20 ? median(durations.slice(-5)) / Math.max(1, median(durations.slice(0, 5))) : 1
  add('延遲漂移', (drift - 3) / 3, `最近的請求慢了 ${drift.toFixed(1)} 倍`)

  const calls = r.tools.length
  const errors = r.tools.filter(t => t.isError).length
  add('工具錯誤率', calls >= 4 ? (errors / calls) * 2 : 0, `${errors}/${calls}`)

  const totals = r.steps.reduce((a, s) => (s.usage ? [a[0]! + prompt(s), a[1]! + s.usage[2]] : a), [0, 0])
  const hit = totals[0]! > 0 ? (totals[1]! / totals[0]!) * 100 : 100
  add('cache 效率', totals[0]! > 50_000 ? (80 - hit) / 60 : 0, `命中 ${hit.toFixed(0)}%`)

  const denied = r.tools.filter(t => t.isDenied).length
  add('權限拒絕', denied * 0.25, `${denied} 次`)

  const sorted = factors.map(f => f.severity).sort((a, b) => b - a)
  return { score: clamp((sorted[0] ?? 0) + 0.3 * (sorted[1] ?? 0)), factors: factors.sort((a, b) => b.severity - a.severity) }
}

function touch($: Engine, turn: number): void {
  dirtyTurns.add(turn)
  isSessionDirty = true
  schedule($)
}

// ---------- writing ----------

function schedule($: Engine): void {
  if (flushTimer !== null || base === '') return
  flushTimer = $.clock.after(FLUSH_MS, () => {
    flushTimer = null
    flush($).catch(() => undefined)
  })
}

function sumUsage(steps: StepRec[]): Usage4 {
  const t: Usage4 = [0, 0, 0, 0]
  for (const s of steps) {
    if (s.usage === undefined) continue
    for (let i = 0; i < 4; i++) t[i] = t[i]! + s.usage[i]!
  }
  return t
}

function hourlyOf(steps: StepRec[]): IndexEntry['hourly'] {
  const buckets = new Map<number, [number, number, number, number, number, number]>()
  for (const s of steps) {
    if (s.usage === undefined) continue
    const hour = Math.floor(s.startedAt / 3_600_000) * 3_600_000
    const b = buckets.get(hour) ?? [hour, 0, 0, 0, 0, 0]
    b[1] += s.costUsd ?? 0
    for (let i = 0; i < 4; i++) b[i + 2] = b[i + 2]! + s.usage[i]!
    buckets.set(hour, b)
  }
  return [...buckets.values()].sort((a, b) => a[0] - b[0])
}

export async function flush($: Engine): Promise<void> {
  if (flushTimer !== null) {
    flushTimer.cancel()
    flushTimer = null
  }
  const r = rec
  if (r === null || base === '') return
  const now = await $.clock.now()
  const dir = `${base}/data/s/${r.id}`

  for (const n of [...dirtyTurns]) {
    dirtyTurns.delete(n)
    const d = details.get(n)
    if (d !== undefined) await $.fs.write(`${dir}/t${n}.js`, wrap('turn', { session: r.id, n, ...d }))
  }
  // Keep only the turns still changing in memory; the rest live on disk.
  const live = new Set(r.turns.filter(t => t.endedAt === undefined).map(t => t.n))
  for (const n of [...details.keys()]) if (!live.has(n) && !dirtyTurns.has(n)) details.delete(n)

  if (isPromptDirty) {
    isPromptDirty = false
    await $.fs.write(`${dir}/prompt.js`, wrap('prompt', { session: r.id, ...prompt }))
  }

  // A session that never got a prompt (opened and closed) stays off the list.
  if (!isSessionDirty || r.turns.length === 0) return
  isSessionDirty = false
  r.updatedAt = now
  await $.fs.write(`${base}/data/s/${r.id}.js`, wrap('session', r))

  const main = r.steps.filter(s => s.loop === '' && s.endedAt !== undefined)
  const entry: IndexEntry = {
    id: r.id,
    project: r.project,
    cwd: r.cwd,
    title: r.title,
    model: [...r.steps].reverse().find(s => s.loop === '' && s.model)?.model,
    startedAt: r.startedAt,
    updatedAt: now,
    turns: r.turns.length,
    requests: r.steps.length,
    agents: r.agents.length,
    // The meter can lag the last responses; the per-request increments cannot.
    costUsd: Math.max(
      typeof r.meter.costUsd === 'number' ? r.meter.costUsd : 0,
      r.steps.reduce((a, s) => a + (s.costUsd ?? 0), 0),
    ),
    tokens: sumUsage(r.steps),
    contextPct: typeof r.meter.contextPct === 'number' ? r.meter.contextPct : undefined,
    lastMainResponseAt: main[main.length - 1]?.endedAt,
    isBusy: r.turns.some(t => t.endedAt === undefined) || r.steps.some(s => s.endedAt === undefined),
    lastPrompt: [...r.turns].reverse().find(t => t.prompt !== '')?.prompt ?? '',
    toolErrors: r.tools.filter(t => t.isError).length,
    ttlMs: r.ttlMs,
    hourly: hourlyOf(r.steps),
    weather: weatherOf(r),
    held,
  }
  const index = (await readData<IndexFile>($, `${base}/data/index.js`)) ?? { updatedAt: now, sessions: [] }
  const sessions = [entry, ...index.sessions.filter(s => s.id !== r.id && now - s.updatedAt < RETENTION_MS)]
  const limits = lastLimits !== undefined && (index.limits === undefined || index.limits.at < lastLimits.at) ? lastLimits : index.limits
  const newestFlags = flags !== undefined && (index.flags === undefined || index.flags.at <= flags.at) ? flags : index.flags
  await $.fs.write(`${base}/data/index.js`, wrap('index', { updatedAt: now, limits, flags: newestFlags, sessions }))
}
