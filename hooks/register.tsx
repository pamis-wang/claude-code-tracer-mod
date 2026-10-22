import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import {
  clearRecorder,
  dashboardPath,
  flush,
  promptLabel,
  recordFlags,
  recordHeld,
  recordAgentEnd,
  recordAgentSpawn,
  recordMeter,
  recordPrompt as recordPromptFile,
  recordTurnEnd,
  recordTurnStart,
  startRecorder,
  stepClose,
  stepOpen,
  toolClose,
  toolOpen,
} from './recorder'
import type { Flags } from './recorder'
import { agentGantt, compositionChart, laneChart, lanesOf, quotaChart } from './charts'
import type { Line } from './charts'
import type {
  AgentRow,
  Diag,
  Meter,
  PromptSectionRow,
  PromptState,
  RateLimitRow,
  StepRow,
  Tab,
  Tokens,
  TurnRow,
  ViewState,
} from '../types'

type Engine = EngineInterface

const PANE = 'tracer'
const TITLE = 'Tracer'
const MAX_TURNS = 60
const MAX_AGENTS = 60
const MAX_VERSIONS = 30
const MAX_TEXT_LINES = 160
const MAX_STEPS = 400

const steps = atom({ plugin: 'tracer', key: 'steps' } as const, [])
const turns = atom({ plugin: 'tracer', key: 'turns' } as const, [])
const agents = atom({ plugin: 'tracer', key: 'agents' } as const, [])
const meter = atom({ plugin: 'tracer', key: 'meter' } as const, { rateLimits: [] })
const prompt = atom({ plugin: 'tracer', key: 'prompt' } as const, {
  versions: [],
  current: [],
  previous: [],
})
const view = atom({ plugin: 'tracer', key: 'view' } as const, { tab: 'timeline', isDiff: false })
const tick = atom({ plugin: 'tracer', key: 'tick' } as const, 0)
const diag = atom({ plugin: 'tracer', key: 'diag' } as const, { pricedSteps: 0, zeroDeltaSteps: 0 })

const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const TABS: { tab: Tab; label: string; hotkey: string }[] = [
  { tab: 'timeline', label: 'Timeline', hotkey: '1' },
  { tab: 'agents', label: 'Subagent', hotkey: '2' },
  { tab: 'context', label: 'Context', hotkey: '3' },
  { tab: 'prompt', label: 'Prompt', hotkey: '4' },
]

// ---------- numbers and words ----------

function addTokens(t: Tokens, u: ModelUsage): Tokens {
  return {
    input: t.input + (u.input_tokens ?? 0),
    output: t.output + (u.output_tokens ?? 0),
    cacheRead: t.cacheRead + (u.cache_read_input_tokens ?? 0),
    cacheWrite: t.cacheWrite + (u.cache_creation_input_tokens ?? 0),
  }
}

function sumTokens(list: Tokens[]): Tokens {
  return list.reduce(
    (a, t) => ({
      input: a.input + t.input,
      output: a.output + t.output,
      cacheRead: a.cacheRead + t.cacheRead,
      cacheWrite: a.cacheWrite + t.cacheWrite,
    }),
    ZERO,
  )
}

function promptTokens(t: Tokens): number {
  return t.input + t.cacheRead + t.cacheWrite
}

/** Share of the prompt the cache served; undefined with no prompt at all. */
function hitPct(t: Tokens): number | undefined {
  const all = promptTokens(t)
  return all === 0 ? undefined : Math.round((t.cacheRead / all) * 100)
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(n)
}

function fmtUsd(n: number | undefined): string {
  if (n === undefined) return '—'
  if (n === 0) return '$0'
  if (n < 0.01) return '<$0.01'
  return `$${n.toFixed(n >= 100 ? 0 : 2)}`
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h${String(m % 60).padStart(2, '0')}m`
}

function fmtMinutes(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

function fmtAgo(ms: number): string {
  return ms < 60_000 ? '剛剛' : `${fmtMinutes(ms)}前`
}

function shortModel(id: string | undefined): string {
  return id === undefined ? '?' : id.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

function shortTool(name: string): string {
  if (!name.startsWith('mcp__')) return name
  const parts = name.split('__')
  return parts[parts.length - 1] ?? name
}

function topTools(tools: Record<string, number>, n = 5): string {
  const list = Object.entries(tools).sort((a, b) => b[1] - a[1])
  const shown = list.slice(0, n).map(([k, v]) => (v > 1 ? `${k}×${v}` : k))
  const rest = list.length - shown.length
  return rest > 0 ? `${shown.join(' ')} +${rest}` : shown.join(' ')
}

function toolCount(tools: Record<string, number>): number {
  return Object.values(tools).reduce((a, b) => a + b, 0)
}

/** The one argument that says what a tool call was about, for a timeline row. */
function toolSummary(name: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof input[k] === 'string' && input[k] !== '') return input[k] as string
    return undefined
  }
  const first = Object.values(input).find(v => typeof v === 'string') as string | undefined
  const text =
    name === 'Bash' || name === 'PowerShell'
      ? pick('command', 'description')
      : pick('file_path', 'path', 'pattern', 'url', 'query', 'description', 'skill', 'prompt') ?? first
  return oneLine(text ?? '').slice(0, 160)
}

/** A tool call's own arguments, without the envelope every call carries. */
function toolInput(e: Record<string, unknown>): Record<string, unknown> {
  const { tool: _tool, tool_use_id: _id, agentId: _agent, ...rest } = e
  return rest
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200)
}

function pctColor(pct: number): string {
  return pct >= 85 ? 'error' : pct >= 60 ? 'warning' : 'success'
}

function bar(pct: number, width: number): string {
  const w = Math.max(4, width)
  const full = Math.min(w, Math.round((Math.min(100, Math.max(0, pct)) / 100) * w))
  return '█'.repeat(full) + '░'.repeat(w - full)
}

function limitName(kind: string): string {
  return kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind
}

/** FNV-1a, 32 bits: enough to tell prompt versions apart. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

type DiffLine = { kind: ' ' | '+' | '-' | '…'; text: string }

/** Line diff by LCS, with one line of context around each change. */
function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length * b.length > 250_000) {
    return [
      { kind: '-', text: `（舊版 ${a.length} 行，太長不逐行比對）` },
      { kind: '+', text: `（新版 ${b.length} 行）` },
    ]
  }
  const dp: Int32Array[] = []
  for (let i = 0; i <= a.length; i++) dp.push(new Int32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const all: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      all.push({ kind: ' ', text: a[i]! })
      i++
      j++
    } else if (j < b.length && (i >= a.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      all.push({ kind: '+', text: b[j]! })
      j++
    } else {
      all.push({ kind: '-', text: a[i]! })
      i++
    }
  }
  const keep = all.map((line, k) =>
    line.kind !== ' ' || all[k - 1]?.kind === '+' || all[k - 1]?.kind === '-' ||
    all[k + 1]?.kind === '+' || all[k + 1]?.kind === '-',
  )
  const out: DiffLine[] = []
  all.forEach((line, k) => {
    if (keep[k]) out.push(line)
    else if (keep[k - 1] || k === 0) out.push({ kind: '…', text: '' })
  })
  return out
}

/** Background work whose failure only means a figure stays stale. */
function quietly(work: Promise<unknown>): void {
  work.catch(() => undefined)
}

// ---------- the cost ledger ----------

let lastLedger: number | undefined
let isCacheWarned = false

async function ledger($: Engine): Promise<number> {
  const usage = await $.session.usage()
  return usage.cost?.usd ?? 0
}

/** What the ledger grew by since the last look: the response that just ended. */
async function takeCostDelta($: Engine): Promise<number> {
  const now = await ledger($)
  const before = lastLedger ?? now
  lastLedger = Math.max(lastLedger ?? now, now)
  return Math.max(0, now - before)
}

function limitsOf(list: readonly { kind: string; percentUsed: number; resetsAt?: string }[]): RateLimitRow[] {
  return list.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))
}

async function refreshMeter($: Engine, isBreakdown: boolean): Promise<void> {
  const usage = await $.session.usage(isBreakdown ? { breakdown: 'summary' } : undefined)
  const b = usage.context.breakdown
  const now = await $.clock.now()
  await update($, meter, m => ({
    ...m,
    contextPct: usage.context.percent ?? m.contextPct,
    contextTokens: usage.context.tokens ?? m.contextTokens,
    window: usage.context.window,
    costUsd: usage.cost?.usd ?? m.costUsd,
    rateLimits: usage.rateLimits.length > 0 ? limitsOf(usage.rateLimits) : m.rateLimits,
    breakdown: b ? b.categories.map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind })) : m.breakdown,
    memoryFiles: b ? b.memoryFiles.map(f => ({ path: f.path, tokens: f.tokens })) : m.memoryFiles,
    breakdownAt: b ? now : m.breakdownAt,
  }))
  recordMeter($, { ...(await read($, meter)) }, now)
}

// ---------- cache TTL and the status line ----------

function cacheLeft(m: Meter, now: number, ttlMs: number): number | undefined {
  return m.lastMainResponseAt === undefined ? undefined : ttlMs - (now - m.lastMainResponseAt)
}

async function pushStatus($: Engine, ttlMs: number): Promise<void> {
  const m = await read($, meter)
  const now = await $.clock.now()
  const parts = [`tracer ${fmtUsd(m.costUsd)}`]
  if (m.contextPct !== undefined) parts.push(`ctx ${m.contextPct}%`)
  const left = cacheLeft(m, now, ttlMs)
  if (left !== undefined) parts.push(left > 0 ? `cache ${fmtMinutes(left)}` : 'cache 已過期')
  $.ui.status(parts.join(' · '))
}

async function onTick($: Engine, ttlMs: number): Promise<void> {
  const now = await $.clock.now()
  await update($, tick, () => now)
  await pushStatus($, ttlMs)
  const m = await read($, meter)
  const left = cacheLeft(m, now, ttlMs)
  const warnMs = ttlMs >= 30 * 60_000 ? 5 * 60_000 : 60_000
  const isIdle = (await read($, turns)).every(t => t.endedAt !== undefined)
  if (left !== undefined && left > 0 && left <= warnMs && isIdle && !isCacheWarned) {
    isCacheWarned = true
    $.ui.toast(`prompt cache 再 ${fmtMinutes(left)} 就過期；過期後下一個請求要重寫整段 context`)
  }
}

// ---------- the system prompt ----------

async function recordPrompt(
  $: Engine,
  model: string,
  sections: readonly { id: string; text: string }[],
): Promise<void> {
  const rows: PromptSectionRow[] = sections.map(s => ({ id: s.id, hash: hash(s.text), text: s.text }))
  const whole = hash(rows.map(r => `${r.id}:${r.hash}`).join('|'))
  const now = await $.clock.now()
  await update($, prompt, (p: PromptState): PromptState => {
    if (p.versions.some(v => v.hash === whole)) return p
    const before = new Map(p.current.map(r => [r.id, r.hash]))
    const after = new Map(rows.map(r => [r.id, r.hash]))
    const isFirst = p.versions.length === 0
    const version = {
      n: (p.versions[p.versions.length - 1]?.n ?? 0) + 1,
      at: now,
      model,
      hash: whole,
      chars: rows.reduce((a, r) => a + r.text.length, 0),
      added: isFirst ? [] : rows.filter(r => !before.has(r.id)).map(r => r.id),
      removed: isFirst ? [] : p.current.filter(r => !after.has(r.id)).map(r => r.id),
      changed: rows.filter(r => before.has(r.id) && before.get(r.id) !== r.hash).map(r => r.id),
    }
    return {
      versions: [...p.versions, version].slice(-MAX_VERSIONS),
      current: rows,
      previous: p.current,
    }
  })
  const p = await read($, prompt)
  recordPromptFile($, {
    versions: p.versions,
    current: p.current.map(s => ({ id: s.id, text: s.text })),
    previous: p.previous.map(s => ({ id: s.id, text: s.text })),
  })
}

// ---------- intercept and the stats line ----------

type InterceptMode = Flags['intercept']
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

let isStatsOn = true
let interceptMode: InterceptMode = 'off'
let isInterceptingTools = false

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const REJECTED = '（tracer：這個請求在送出前被攔截並拒絕。）'

type Decision = { kind: 'pass' } | { kind: 'reject' } | { kind: 'model'; model: string } | { kind: 'effort'; effort: Effort }

function flagsNow(): Flags {
  return { stats: isStatsOn, intercept: interceptMode, interceptTools: isInterceptingTools }
}

async function saveFlags($: Engine): Promise<void> {
  await $.store.set('flags', flagsNow())
  recordFlags($, flagsNow(), await $.clock.now())
}

/** Holds a main-loop request and asks the person what to do with it. */
async function askRequest($: Engine, e: { index: number; model: string; effort?: unknown; messageCount: number }): Promise<Decision> {
  const m = await read($, meter)
  const what =
    `#${e.index + 1}（${shortModel(e.model)}${e.effort !== undefined ? ` · effort ${String(e.effort)}` : ''}` +
    ` · ${e.messageCount} 則訊息${m.contextPct !== undefined ? ` · context ${m.contextPct}%` : ''}）`
  const first = await $.ui.ask(`tracer 攔截了請求 ${what}，要怎麼處理?`, {
    header: 'tracer 攔截',
    options: ['放行', '換模型', '調整 effort', '拒絕這個請求'],
  })
  if (first === '拒絕這個請求') return { kind: 'reject' }
  if (first === '換模型') {
    const others = MODELS.filter(id => id !== e.model).slice(0, 3)
    const pick = await $.ui.ask(`改用哪個模型?（目前 ${shortModel(e.model)}；Other 可輸入完整模型 id）`, {
      header: '模型',
      options: others.map(shortModel),
    })
    const model = others.find(id => shortModel(id) === pick) ?? pick.trim()
    return model === '' ? { kind: 'pass' } : { kind: 'model', model }
  }
  if (first === '調整 effort') {
    const pick = (
      await $.ui.ask(`effort 要調成多少?（目前 ${String(e.effort ?? '預設')}；Other 可輸入 max）`, {
        header: 'effort',
        options: ['low', 'medium', 'high', 'xhigh'],
      })
    ).trim() as Effort
    return EFFORTS.includes(pick) ? { kind: 'effort', effort: pick } : { kind: 'pass' }
  }
  return { kind: 'pass' }
}

type ToolDecision = { kind: 'pass' } | { kind: 'reject' } | { kind: 'edit'; input: Record<string, unknown> }

/** Holds a tool call and asks the person to let it run, refuse it, or rewrite its input. */
async function askTool($: Engine, name: string, input: Record<string, unknown>): Promise<ToolDecision> {
  const isShell = name === 'Bash' || name === 'PowerShell'
  const shown = isShell ? String(input.command ?? '') : JSON.stringify(input)
  const answer = await $.ui.ask(
    `tracer 攔截工具呼叫 ${name}：${shown.slice(0, 300)}${shown.length > 300 ? '…' : ''}\n` +
      `（Other 可輸入改過的${isShell ? '指令' : ' JSON 輸入'}）要放行嗎?`,
    { header: 'tracer 攔截', options: ['放行', '拒絕'] },
  )
  if (answer === '放行') return { kind: 'pass' }
  if (answer === '拒絕') return { kind: 'reject' }
  try {
    const parsed: unknown = JSON.parse(answer)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { kind: 'edit', input: parsed as Record<string, unknown> }
    }
  } catch {
    // Not JSON: for a shell tool, the text is the new command.
  }
  return isShell ? { kind: 'edit', input: { ...input, command: answer } } : { kind: 'pass' }
}

/** The line shown under each main-loop answer, in the status line's style: context, the turn's tokens, cache hits, cost. */
function statsLine(t: TurnRow, m: Meter): string {
  const parts = ['tracer']
  if (m.contextPct !== undefined) {
    const size = m.contextTokens !== undefined && m.window ? ` (${fmtTokens(m.contextTokens)}/${fmtTokens(m.window)})` : ''
    parts.push(`ctx ${m.contextPct}%${size}`)
  }
  parts.push(`${fmtTokens(t.tokens.input + t.tokens.cacheWrite)} in / ${fmtTokens(t.tokens.output)} out`)
  const hit = hitPct(t.tokens)
  if (hit !== undefined) parts.push(`cache 命中 ${hit}%`)
  if (t.costUsd !== undefined) parts.push(fmtUsd(t.costUsd))
  return parts.join(' · ')
}

/** A request's bar in the pane's charts, from its start. */
async function addRow($: Engine, row: StepRow): Promise<void> {
  await update($, steps, list => [...list.filter((s: StepRow) => s.id !== row.id), row].slice(-MAX_STEPS))
}

/**
 * Asks the engine for the system prompt it would send now. The built-in
 * policy plugin sends `prompt.compose` past every person's mod (and the
 * transcript says so on each load), so the mod asks rather than listens.
 */
async function composeNow($: Engine): Promise<void> {
  const result = await $.prompt.compose()
  await recordPrompt($, await $.session.model(), result.sections)
}

// ---------- the hooks ----------

export const register: Register = (on, options) => {
  const ttlMs = (Number(String(options.cacheTtlMinutes ?? '60')) || 60) * 60_000

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'tracer',
      description: 'Tracer pane; `web` opens the dashboard, `stats` toggles the line under each answer, `intercept` holds requests or tool calls',
      argumentHint: '[open|close|web|stats [on|off]|intercept [all|tools|off]]',
    })
    lastLedger = await ledger($)
    const saved = (await $.store.get('flags')) as Partial<Flags> | undefined
    if (saved !== undefined && saved !== null) {
      isStatsOn = saved.stats ?? true
      interceptMode = saved.intercept ?? 'off'
      isInterceptingTools = saved.interceptTools ?? false
    }
    try {
      await startRecorder($, ttlMs)
      recordFlags($, flagsNow(), await $.clock.now())
      const p = await read($, prompt)
      if (p.versions.length > 0) {
        recordPromptFile($, {
          versions: p.versions,
          current: p.current.map(s => ({ id: s.id, text: s.text })),
          previous: p.previous.map(s => ({ id: s.id, text: s.text })),
        })
      }
    } catch {
      // Without the recorder the pane still works; the web page just stays stale.
    }
    $.clock.every(30_000, () => quietly(onTick($, ttlMs)))
    if ((await $.store.get('autoOpen')) !== false) {
      quietly($.ui.open({ id: PANE, title: TITLE, columns: 60 }))
    }
    quietly(refreshMeter($, false).then(() => pushStatus($, ttlMs)))
    $.clock.after(100, () => quietly(composeNow($)))

    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') await flush($).catch(() => undefined)
    if (e.reason === 'clear') {
      await clearRecorder($).catch(() => undefined)
      await update($, steps, () => [])
      await update($, turns, () => [])
      await update($, agents, () => [])
      await update($, meter, m => ({ ...m, lastMainResponseAt: undefined }))
    }

    return next(e)
  })

  on('command.run', { command: 'tracer' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().split(/\s+/)
    if (verb === 'stats') {
      isStatsOn = arg === 'on' ? true : arg === 'off' ? false : !isStatsOn
      await saveFlags($)

      return { text: `統計列已${isStatsOn ? '開啟：每個回覆下方會顯示 context、token、cache 與成本' : '關閉'}。` }
    }
    if (verb === 'intercept') {
      if (arg === 'tools') isInterceptingTools = !isInterceptingTools
      else if (arg === 'off') {
        interceptMode = 'off'
        isInterceptingTools = false
      } else interceptMode = arg === 'all' ? 'all' : interceptMode === 'next' ? 'off' : 'next'
      await saveFlags($)
      const requests =
        interceptMode === 'next' ? '下一個請求送出前會先問你' : interceptMode === 'all' ? '每個請求送出前都會先問你' : '請求不攔截'
      const tools = isInterceptingTools ? '每個工具呼叫執行前都會先問你' : '工具呼叫不攔截'

      return { text: `tracer 攔截：${requests}；${tools}。用 /tracer intercept off 全部關閉。` }
    }
    if (verb === 'web') {
      await flush($).catch(() => undefined)
      const page = dashboardPath()
      const isWindows = (await $.env.get('OS')) === 'Windows_NT'
      const where = isWindows ? page.replace(/\//g, '\\') : page
      const argv = isWindows
        ? ['rundll32', 'url.dll,FileProtocolHandler', where]
        : ['sh', '-c', 'command -v xdg-open >/dev/null && exec xdg-open "$0" || exec open "$0"', page]
      const opened = await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => undefined)

      return {
        text:
          opened !== undefined && opened.exitCode === 0
            ? `已在瀏覽器開啟 Tracer 儀表板：${where}`
            : `沒能自動開啟瀏覽器，請手動開啟：${where}`,
      }
    }
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    const wantsOpen = e.args.trim() === 'open' || (e.args.trim() !== 'close' && !isOpen)
    let unplaced = ''
    if (wantsOpen) {
      await $.store.set('autoOpen', true)
      const opened = await $.ui.open({ id: PANE, title: TITLE, columns: 60 })
      if (!opened.isPlaced) unplaced = `（這個介面沒有顯示面板：${opened.reason}；狀態列仍會更新）`
    } else {
      await $.store.set('autoOpen', false)
      await $.ui.close({ id: PANE })
    }
    const list = await read($, turns)
    const m = await read($, meter)
    const d = await read($, diag)

    return {
      text:
        `Tracer 面板已${wantsOpen ? '開啟' : '關閉'}${unplaced}。本 session ${list.length} 個 turn，` +
        `累計 ${fmtUsd(m.costUsd)}，context ${m.contextPct ?? '?'}%` +
        `（成本拆分：${d.pricedSteps} 次回應，其中 ${d.zeroDeltaSteps} 次未見帳本增加）`,
    }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await $.store.set('autoOpen', false)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      if (e.agentId === undefined) {
        const m = await read($, meter)
        const costAtStart = await ledger($)
        await update($, turns, list => {
          const row: TurnRow = {
            id: e.turnId,
            n: (list[list.length - 1]?.n ?? 0) + 1,
            prompt: promptLabel(e.text).slice(0, 200),
            startedAt: now,
            gapMs: m.lastMainResponseAt === undefined ? undefined : now - m.lastMainResponseAt,
            steps: 0,
            tokens: ZERO,
            costAtStart,
            tools: {},
            toolErrors: 0,
            agents: 0,
          }
          return [...list, row].slice(-MAX_TURNS)
        })
        await recordTurnStart($, e.turnId, e.text, now, costAtStart)
        $.clock.after(10, () => quietly(composeNow($)))
      } else {
        const id = e.agentId
        await update($, agents, list => list.map(a => (a.id === id ? { ...a, isRunning: true } : a)))
      }
    } catch {
      // An observer never holds up the turn.
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    let request = e
    if (e.agentId === undefined && interceptMode !== 'off') {
      if (interceptMode === 'next') {
        interceptMode = 'off'
        await saveFlags($)
      }
      await recordHeld($, 'request', await $.clock.now())
      const decision = await askRequest($, e).catch((): Decision => ({ kind: 'pass' }))
      await recordHeld($, null, await $.clock.now())
      if (decision.kind === 'reject') {
        const now = await $.clock.now()
        const step = stepOpen(e.turnId, e.index, '', e.model, e.effort, e.messageCount, now)
        if (step !== undefined) {
          await stepClose($, step, { answer: REJECTED, thinking: '', usage: undefined, stop: 'tracer_rejected', costUsd: 0 }, now)
        }
        await addRow($, { id: `${e.turnId}:${e.index}`, loop: '', startedAt: now, endedAt: now, model: e.model, ctx: 0, costUsd: 0, tools: [], errors: 0, stop: 'tracer_rejected' })
        yield { kind: 'text', index: 0, text: REJECTED }
        yield { kind: 'stop', stopReason: 'end_turn', usage: null }

        return { turnId: e.turnId, index: e.index, answer: REJECTED, toolUses: [], stopReason: 'end_turn', usage: null }
      }
      if (decision.kind === 'model') request = { ...e, model: decision.model }
      if (decision.kind === 'effort') request = { ...e, effort: decision.effort }
    }
    const openedAt = await $.clock.now()
    const step = stepOpen(e.turnId, e.index, e.agentId ?? '', request.model, request.effort, e.messageCount, openedAt)
    const rowId = `${e.turnId}:${e.index}`
    await addRow($, { id: rowId, loop: e.agentId ?? '', startedAt: openedAt, model: request.model, ctx: 0, costUsd: 0, tools: [], errors: 0 }).catch(
      () => undefined,
    )
    const stream = next(request)
    let thinking = ''
    for await (const chunk of stream) {
      if (step !== undefined) {
        if (step.firstAt === undefined && chunk.kind !== 'engine') step.firstAt = await $.clock.now()
        if (chunk.kind === 'thinking' && thinking.length < 20_000) thinking += chunk.text
      }
      yield chunk
    }
    const result = await stream.result
    try {
      const usage = result.usage
      const now = await $.clock.now()
      const delta = usage === null ? 0 : await takeCostDelta($)
      const tokens: [number, number, number, number] | undefined =
        usage === null
          ? undefined
          : [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens]
      const window = (await read($, meter)).window ?? 1_000_000
      await update($, steps, list =>
        list.map((s: StepRow) =>
          s.id === rowId
            ? {
                ...s,
                endedAt: now,
                model: usage?.model ?? s.model,
                usage: tokens,
                ctx: tokens ? ((tokens[0] + tokens[1] + tokens[2] + tokens[3]) / window) * 100 : s.ctx,
                costUsd: delta,
                stop: result.stopReason,
              }
            : s,
        ),
      )
      if (step !== undefined) {
        await stepClose(
          $,
          step,
          { answer: result.answer, thinking, usage: tokens, model: usage?.model, stop: result.stopReason, costUsd: delta },
          now,
        )
      }
      if (usage !== null) {
        await update($, diag, (d: Diag) => ({
          pricedSteps: d.pricedSteps + 1,
          zeroDeltaSteps: d.zeroDeltaSteps + (delta === 0 ? 1 : 0),
        }))
        if (e.agentId === undefined) {
          await update($, turns, list =>
            list.map(t =>
              t.id === e.turnId
                ? {
                    ...t,
                    steps: t.steps + 1,
                    model: usage.model,
                    tokens: addTokens(t.tokens, usage),
                    firstStep: t.firstStep ?? addTokens(ZERO, usage),
                  }
                : t,
            ),
          )
          await update($, meter, m => ({ ...m, lastMainResponseAt: now }))
          isCacheWarned = false
        } else {
          const id = e.agentId
          const known = (await read($, agents)).some(a => a.id === id)
          const info = known ? undefined : (await $.agent.list()).find(a => a.id === id)
          await update($, agents, list => {
            const base: AgentRow = list.find(a => a.id === id) ?? {
              id,
              type: info?.type ?? '(內部)',
              description: info?.description ?? '',
              parentId: info?.parentId,
              isBackground: false,
              startedAt: now,
              isRunning: true,
              steps: 0,
              tokens: ZERO,
              costUsd: 0,
              tools: {},
              toolErrors: 0,
            }
            const row: AgentRow = {
              ...base,
              steps: base.steps + 1,
              model: usage.model,
              tokens: addTokens(base.tokens, usage),
              costUsd: base.costUsd + delta,
            }
            const rest = list.filter(a => a.id !== id)
            return known ? list.map(a => (a.id === id ? row : a)) : [...rest, row].slice(-MAX_AGENTS)
          })
        }
      }
    } catch {
      // Bookkeeping failed; the response stands as streamed.
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      const now = await $.clock.now()
      if (e.agentId === undefined) {
        const cost = await ledger($)
        await update($, turns, list =>
          list.map(t =>
            t.id === e.turnId
              ? { ...t, endedAt: now, reason: e.reason, costUsd: Math.max(0, cost - t.costAtStart) }
              : t,
          ),
        )
        await recordTurnEnd($, e.turnId, e.answer, e.reason, now, cost)
        $.clock.after(50, () => quietly(refreshMeter($, true).then(() => pushStatus($, ttlMs))))
        const turn = isStatsOn && e.reason === 'answer' ? (await read($, turns)).find(t => t.id === e.turnId) : undefined
        if (turn !== undefined) return { ...result, text: statsLine(turn, await read($, meter)) }
      } else {
        const id = e.agentId
        await update($, agents, list =>
          list.map(a => (a.id === id ? { ...a, endedAt: now, isRunning: false, reason: e.reason } : a)),
        )
        await recordAgentEnd($, id, e.answer, e.reason, now)
      }
    } catch {
      // Bookkeeping failed; the turn's answer stands.
    }

    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    const id = result.agentId
    if (id !== undefined) {
      const now = await $.clock.now()
      const row: AgentRow = {
        id,
        type: e.subagentType,
        description: oneLine(e.description),
        model: result.model,
        parentId: e.parentAgentId,
        isBackground: e.background,
        startedAt: now,
        isRunning: true,
        steps: 0,
        tokens: ZERO,
        costUsd: 0,
        tools: {},
        toolErrors: 0,
      }
      await update($, agents, list => [...list.filter(a => a.id !== id), row].slice(-MAX_AGENTS))
      await recordAgentSpawn(
        $,
        {
          id,
          type: row.type,
          description: row.description,
          model: row.model,
          parentId: row.parentId,
          isBackground: row.isBackground,
          startedAt: now,
        },
        e.prompt,
      )
      if (e.parentAgentId === undefined) {
        await update($, turns, list => {
          const at = list.findLastIndex(t => t.endedAt === undefined)
          return at < 0 ? list : list.map((t, k) => (k === at ? { ...t, agents: t.agents + 1 } : t))
        })
      }
    }

    return result
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    // The mod's own questions are tool calls too: never record or hold them.
    if (next.origin.plugin === $.plugin.name) return next(e)
    let input = toolInput(e as unknown as Record<string, unknown>)
    let request = e
    if (isInterceptingTools && String(e.tool) !== 'AskUserQuestion') {
      await recordHeld($, 'tool', await $.clock.now())
      const decision = await askTool($, String(e.tool), input).catch((): ToolDecision => ({ kind: 'pass' }))
      await recordHeld($, null, await $.clock.now())
      if (decision.kind === 'reject') {
        const now = await $.clock.now()
        const call = toolOpen(e.tool_use_id, String(e.tool), e.agentId ?? '', toolSummary(String(e.tool), input), hash(JSON.stringify(input)), now)
        const reason = 'tracer：這個工具呼叫在執行前被攔截並拒絕。'
        if (call !== undefined) await toolClose($, call, JSON.stringify(input, null, 2), `（被拒絕）${reason}`, false, true, now)

        return { deny: reason }
      }
      if (decision.kind === 'edit') {
        input = { ...input, ...decision.input }
        request = { ...e, ...decision.input } as typeof e
      }
    }
    const call = toolOpen(e.tool_use_id, String(e.tool), e.agentId ?? '', toolSummary(String(e.tool), input), hash(JSON.stringify(input)), await $.clock.now())
    const result = await next(request)
    const name = shortTool(String(e.tool))
    const isError = result.isError === true
    const loop = e.agentId ?? ''
    await update($, steps, list => {
      const at = list.findLastIndex((s: StepRow) => s.loop === loop)
      return at < 0
        ? list
        : list.map((s: StepRow, k: number) => (k === at ? { ...s, tools: [...s.tools, name].slice(-20), errors: s.errors + (isError ? 1 : 0) } : s))
    })
    if (call !== undefined) {
      const answer = result.deny !== undefined ? `（被拒絕）${result.deny}` : (result.text ?? '')
      await toolClose($, call, JSON.stringify(input, null, 2), answer, isError, result.deny !== undefined, await $.clock.now())
    }
    const count = (tools: Record<string, number>) => ({ ...tools, [name]: (tools[name] ?? 0) + 1 })
    if (e.agentId === undefined) {
      await update($, turns, list => {
        const at = list.findLastIndex(t => t.endedAt === undefined)
        return at < 0
          ? list
          : list.map((t, k) =>
              k === at ? { ...t, tools: count(t.tools), toolErrors: t.toolErrors + (isError ? 1 : 0) } : t,
            )
      })
    } else {
      const id = e.agentId
      await update($, agents, list =>
        list.map(a =>
          a.id === id ? { ...a, tools: count(a.tools), toolErrors: a.toolErrors + (isError ? 1 : 0) } : a,
        ),
      )
    }

    return result
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    try {
      await update($, meter, m => ({
        ...m,
        contextPct: e.context.percent ?? m.contextPct,
        contextTokens: e.context.tokens ?? m.contextTokens,
        window: e.context.window,
        costUsd: e.cost?.usd ?? m.costUsd,
        rateLimits: e.rateLimits.length > 0 ? limitsOf(e.rateLimits) : m.rateLimits,
      }))
      recordMeter($, { ...(await read($, meter)) }, await $.clock.now())
      await pushStatus($, ttlMs)
    } catch {
      // The status line just stays as it was.
    }

    return result
  })

  // ---------- the pane ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v: ViewState = await read($, view)
    const m: Meter = await read($, meter)
    await read($, tick)
    const now = await $.clock.now()
    const cols = Math.max(24, e.props.bodyColumns)
    const barWidth = Math.min(24, Math.max(6, cols - 26))

    const row = (left: string, right: string, color?: string) => (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexShrink={1}>
          <Text wrap="truncate-end">{left}</Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Text color={color}>{right}</Text>
        </Box>
      </Box>
    )

    const dim = (text: string) => <Text dimColor wrap="truncate-end">{text}</Text>

    // Charts are cells: VS Code's Claude panel draws no SVG and shows plugin
    // text in a proportional face, so a chart row is boxes of fixed widths
    // (columns there, cells in the terminal), never a string of glyphs.
    const chartCols = Math.max(10, cols - 1)
    const line = (runs: Line) => (
      <Text wrap="truncate-end">
        {runs.map(r => (
          <Text color={r.color} dimColor={r.dim}>
            {r.text}
          </Text>
        ))}
      </Text>
    )
    const grid = (runs: Line) => (
      <Box flexDirection="row" flexWrap="nowrap" overflow="hidden">
        {runs.map(r => {
          const width = r.text.length
          if (r.text[0] === '█') return <Box width={width} height={1} flexShrink={0} backgroundColor={r.color} />
          if (r.text[0] === ' ') return <Box width={width} height={1} flexShrink={0} />
          return (
            <Box width={width} height={1} flexShrink={0} overflow="hidden">
              <Text color={r.color} dimColor={r.dim} wrap="truncate-end">
                {r.text}
              </Text>
            </Box>
          )
        })}
      </Box>
    )

    // The header: what matters at a glance, on every tab.
    const left = cacheLeft(m, now, ttlMs)
    const headParts = [`${fmtUsd(m.costUsd)}`]
    if (m.contextPct !== undefined) headParts.push(`ctx ${m.contextPct}%`)
    const limits = m.rateLimits.map(r => `${limitName(r.kind)} ${r.percentUsed}%`)
    const header = (
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text weight="bold">{headParts.join(' · ')}</Text>
          {left === undefined ? (
            <Text dimColor>cache —</Text>
          ) : left > 0 ? (
            <Text color={left <= 5 * 60_000 ? 'warning' : 'success'}>cache {fmtMinutes(left)}</Text>
          ) : (
            <Text color="error">cache 已過期</Text>
          )}
        </Box>
        {limits.length > 0 && dim(limits.join(' · '))}
        <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
          {TABS.map(t => (
            <Button
              key={`tab-${t.tab}`}
              hotkey={t.hotkey}
              plain
              variant={v.tab === t.tab ? 'primary' : undefined}
              onPress={() => update($, view, (s: ViewState) => ({ ...s, tab: t.tab }))}
            >
              <Text inverse={v.tab === t.tab}> {t.label} </Text>
            </Button>
          ))}
        </Box>
      </Box>
    )

    if (v.tab === 'agents') {
      const list: AgentRow[] = await read($, agents)
      const sorted = [...list].sort((a, b) =>
        a.isRunning !== b.isRunning ? (a.isRunning ? -1 : 1) : b.startedAt - a.startedAt,
      )
      const total = list.reduce((a, r) => a + r.costUsd, 0)
      const share = m.costUsd ? Math.round((total / m.costUsd) * 100) : undefined
      const ganttRows = list.length > 0 ? agentGantt(list, await read($, steps), chartCols, now) : []
      const gantt =
        ganttRows.length > 0 ? (
          <Box flexDirection="column" marginBottom={1}>
            {ganttRows.map(g => (
              <Box flexDirection="column">
                {line(g.title)}
                {grid(g.bar)}
              </Box>
            ))}
          </Box>
        ) : null

      return (
        <Box flexDirection="column">
          {header}
          {gantt}
          {dim(`${list.length} 個 subagent · ${fmtUsd(total)}${share === undefined ? '' : `（session 的 ${share}%）`}`)}
          {list.length === 0 && <Text dimColor>還沒有 subagent。</Text>}
          {sorted.map(a => {
            const mark = a.isRunning ? '●' : a.reason === 'answer' ? '✓' : a.reason === 'aborted' ? '■' : '✗'
            const markColor = a.isRunning ? 'warning' : a.reason === 'answer' ? 'success' : 'error'
            const took = (a.endedAt ?? now) - a.startedAt
            const hit = hitPct(a.tokens)
            const tools = toolCount(a.tools)
            return (
              <Box flexDirection="column" marginTop={1}>
                <Box flexDirection="row" justifyContent="space-between">
                  <Box flexShrink={1}>
                    <Text wrap="truncate-end">
                      <Text color={markColor}>{mark}</Text> {a.type}
                      {a.isBackground ? ' (背景)' : ''} {a.description ? `「${a.description}」` : ''}
                    </Text>
                  </Box>
                  <Box flexShrink={0} marginLeft={1}>
                    <Text>
                      {fmtDur(took)} {fmtUsd(a.costUsd)}
                    </Text>
                  </Box>
                </Box>
                {dim(
                  `  ${shortModel(a.model)} · ${a.steps} 次請求 · in ${fmtTokens(promptTokens(a.tokens))} out ${fmtTokens(a.tokens.output)}` +
                    (hit === undefined ? '' : ` · hit ${hit}%`),
                )}
                {tools > 0 && (
                  <Text wrap="truncate-end">
                    <Text dimColor>  {topTools(a.tools)}</Text>
                    {a.toolErrors > 0 && <Text color="error"> · {a.toolErrors} 失敗</Text>}
                  </Text>
                )}
              </Box>
            )
          })}
          <Box marginTop={1}>{dim('成本＝每次回應結束時帳本的增量，並行時為估算')}</Box>
        </Box>
      )
    }

    if (v.tab === 'context') {
      const turnList: TurnRow[] = await read($, turns)
      const agentList: AgentRow[] = await read($, agents)
      const all = sumTokens([...turnList.map(t => t.tokens), ...agentList.map(a => a.tokens)])
      const hit = hitPct(all)
      const used = (m.breakdown ?? []).filter(c => c.kind !== 'deferred' && c.tokens > 0)
      const composition = used.length > 0 ? compositionChart(used, chartCols) : null
      const window = m.window ?? 0

      return (
        <Box flexDirection="column">
          {header}
          <Text weight="bold">Context</Text>
          {composition !== null && (
            <Box flexDirection="column" marginBottom={1}>
              {grid(composition.bar)}
              {composition.legend.map(l => line(l))}
            </Box>
          )}
          {m.contextPct === undefined ? (
            <Text dimColor>還沒有回應可量。</Text>
          ) : (
            <Text>
              <Text color={pctColor(m.contextPct)}>{bar(m.contextPct, barWidth)}</Text> {m.contextPct}%{' '}
              <Text dimColor>
                {fmtTokens(m.contextTokens ?? 0)}/{fmtTokens(window)}
              </Text>
            </Text>
          )}
          {(m.memoryFiles ?? []).length > 0 && <Box marginTop={1}>{dim('記憶檔')}</Box>}
          {(m.memoryFiles ?? []).map(f => row(`  ${f.path.split(/[\\/]/).slice(-2).join('/')}`, fmtTokens(f.tokens)))}
          {m.breakdownAt !== undefined && dim(`  明細為估算，${fmtAgo(now - m.breakdownAt)}更新`)}
          <Box marginTop={1}>
            <Button key="refresh" label="重新整理" hotkey="r" onPress={() => refreshMeter($, true)} />
          </Box>

          <Box marginTop={1}>
            <Text weight="bold">配額</Text>
          </Box>
          {m.rateLimits.length === 0 && <Text dimColor>沒有配額資料（API key 或尚未回應）。</Text>}
          {quotaChart(m.rateLimits, chartCols, now).map(q => (
            <Box flexDirection="column">
              {dim(q.label)}
              {grid(q.bar)}
            </Box>
          ))}

          <Box marginTop={1}>
            <Text weight="bold">Prompt cache</Text>
          </Box>
          {m.lastMainResponseAt === undefined ? (
            <Text dimColor>還沒有回應。</Text>
          ) : (
            <Text>
              最後回應 {fmtAgo(now - m.lastMainResponseAt)} · TTL {fmtMinutes(ttlMs)} ·{' '}
              {left !== undefined && left > 0 ? (
                <Text color={left <= 5 * 60_000 ? 'warning' : 'success'}>剩 {fmtMinutes(left)}</Text>
              ) : (
                <Text color="error">已過期 {fmtMinutes(-(left ?? 0))}</Text>
              )}
            </Text>
          )}

          <Box marginTop={1}>
            <Text weight="bold">本 session 合計</Text>
          </Box>
          {row('  成本', fmtUsd(m.costUsd))}
          {row('  輸入（含 cache）', fmtTokens(promptTokens(all)))}
          {row('  輸出', fmtTokens(all.output))}
          {row('  cache 讀取／寫入', `${fmtTokens(all.cacheRead)} / ${fmtTokens(all.cacheWrite)}`)}
          {hit !== undefined && row('  cache 命中率', `${hit}%`, hit < 50 ? 'warning' : 'success')}
        </Box>
      )
    }

    if (v.tab === 'prompt') {
      const p: PromptState = await read($, prompt)
      const latest = p.versions[p.versions.length - 1]
      const changed = new Set([...(latest?.changed ?? []), ...(latest?.added ?? [])])
      const selected = p.current.find(s => s.id === v.section)
      const before = selected && p.previous.find(s => s.id === selected.id)

      let body: JSX.Element[] = []
      if (selected) {
        if (v.isDiff) {
          const lines = before ? diffLines(before.text, selected.text) : [{ kind: '+' as const, text: '（上一版沒有這個區段）' }]
          const isSame = before !== undefined && before.hash === selected.hash
          body = isSame
            ? [<Text dimColor>與上一版相同。</Text>]
            : lines.slice(0, MAX_TEXT_LINES).map(l =>
                l.kind === '…' ? (
                  <Text dimColor>  …</Text>
                ) : (
                  <Text color={l.kind === '+' ? 'success' : l.kind === '-' ? 'error' : undefined} dimColor={l.kind === ' '}>
                    {l.kind} {l.text}
                  </Text>
                ),
              )
        } else {
          const lines = selected.text.split('\n')
          body = lines.slice(0, MAX_TEXT_LINES).map(l => <Text>{l}</Text>)
          if (lines.length > MAX_TEXT_LINES) body.push(<Text dimColor>…還有 {lines.length - MAX_TEXT_LINES} 行</Text>)
        }
      }

      return (
        <Box flexDirection="column">
          {header}
          <Text weight="bold">版本</Text>
          {p.versions.length === 0 && <Text dimColor>下一個請求送出後就會記錄。</Text>}
          {[...p.versions]
            .reverse()
            .slice(0, 6)
            .map(ver => {
              const what = [
                ...ver.changed.map(id => `~${id}`),
                ...ver.added.map(id => `+${id}`),
                ...ver.removed.map(id => `-${id}`),
              ]
              return dim(
                `v${ver.n} · ${fmtAgo(now - ver.at)} · ${shortModel(ver.model)} · ${fmtTokens(ver.chars)} 字` +
                  (ver.n === 1 ? ' · 初版' : what.length > 0 ? ` · ${what.join(' ')}` : ''),
              )
            })}
          {p.current.length > 0 && (
            <Box marginTop={1}>
              <Text weight="bold">區段</Text>
              <Text dimColor>（~ 表示這版有改）</Text>
            </Box>
          )}
          {p.current.map(s => (
            <Button
              key={`sec-${s.id}`}
              plain
              onPress={() =>
                update($, view, (cur: ViewState) => ({ ...cur, section: cur.section === s.id ? undefined : s.id }))
              }
            >
              <Text inverse={s.id === v.section}>
                {changed.has(s.id) ? '~' : ' '} {s.id}
              </Text>
              <Text dimColor> {fmtTokens(s.text.length)} 字</Text>
            </Button>
          ))}
          {selected && (
            <Box flexDirection="column" marginTop={1}>
              <Box flexDirection="row">
                <Button
                  key="mode-text"
                  label="全文"
                  variant={v.isDiff ? undefined : 'primary'}
                  onPress={() => update($, view, (cur: ViewState) => ({ ...cur, isDiff: false }))}
                />
                <Text> </Text>
                <Button
                  key="mode-diff"
                  label="與上版差異"
                  variant={v.isDiff ? 'primary' : undefined}
                  onPress={() => update($, view, (cur: ViewState) => ({ ...cur, isDiff: true }))}
                />
              </Box>
              {body}
            </Box>
          )}
        </Box>
      )
    }

    // The timeline: a lane per loop on graphic surfaces, then the main
    // conversation's turns, newest first.
    const list: TurnRow[] = await read($, turns)
    const stepList: StepRow[] = await read($, steps)
    const chart = stepList.length > 0 ? laneChart(lanesOf(stepList, await read($, agents), now), chartCols, now) : null
    const lanes =
      chart === null ? null : (
        <Box flexDirection="column" marginBottom={1}>
          {chart.lanes.map(l => (
            <Box flexDirection="column">
              {line(l.title)}
              {l.rows.map(r => grid(r))}
            </Box>
          ))}
          {line(chart.footer)}
        </Box>
      )

    return (
      <Box flexDirection="column">
        {header}
        {lanes}
        {list.length === 0 && <Text dimColor>下一個 turn 開始後就會出現在這裡。</Text>}
        {[...list].reverse().map(t => {
          const isRunning = t.endedAt === undefined
          const took = (t.endedAt ?? now) - t.startedAt
          const cost = isRunning ? (m.costUsd ?? t.costAtStart) - t.costAtStart : t.costUsd
          const hit = hitPct(t.tokens)
          const first = t.firstStep ? hitPct(t.firstStep) : undefined
          const isMiss = first !== undefined && first < 20 && t.firstStep !== undefined && promptTokens(t.firstStep) > 10_000
          const isCold = t.gapMs !== undefined && t.gapMs > ttlMs
          const tools = toolCount(t.tools)
          return (
            <Box flexDirection="column" marginBottom={1}>
              <Box flexDirection="row" justifyContent="space-between">
                <Box flexShrink={1}>
                  <Text wrap="truncate-end">
                    <Text dimColor>#{t.n}</Text> {t.prompt ? `「${t.prompt}」` : '（接續）'}
                  </Text>
                </Box>
                <Box flexShrink={0} marginLeft={1}>
                  {isRunning ? (
                    <Text color="warning">進行中 {fmtDur(took)}</Text>
                  ) : (
                    <Text color={t.reason === 'answer' ? undefined : 'error'}>
                      {fmtDur(took)} {fmtUsd(cost)}
                    </Text>
                  )}
                </Box>
              </Box>
              <Text wrap="truncate-end">
                <Text dimColor>
                  {'  '}
                  {shortModel(t.model)} · {t.steps} 次請求 · in {fmtTokens(promptTokens(t.tokens))} out{' '}
                  {fmtTokens(t.tokens.output)}
                </Text>
                {hit !== undefined && (
                  <Text color={isMiss ? 'error' : hit < 50 ? 'warning' : undefined} dimColor={!isMiss && hit >= 50}>
                    {' '}
                    · hit {hit}%
                  </Text>
                )}
              </Text>
              {(tools > 0 || t.agents > 0) && (
                <Text wrap="truncate-end">
                  <Text dimColor>
                    {'  '}
                    {topTools(t.tools)}
                    {t.agents > 0 ? `${tools > 0 ? ' · ' : ''}subagent ${t.agents}` : ''}
                  </Text>
                  {t.toolErrors > 0 && <Text color="error"> · {t.toolErrors} 失敗</Text>}
                </Text>
              )}
              {isMiss && (
                <Text color="error" wrap="truncate-end">
                  {'  '}⚠ cache miss：第一個請求重寫了 {fmtTokens(t.firstStep!.cacheWrite + t.firstStep!.input)} token
                  {isCold ? `（距上個 turn ${fmtMinutes(t.gapMs!)}，超過 TTL）` : ''}
                </Text>
              )}
              {!isMiss && isCold && (
                <Text color="warning" wrap="truncate-end">
                  {'  '}距上個 turn {fmtMinutes(t.gapMs!)}，已超過 cache TTL
                </Text>
              )}
              {t.reason !== undefined && t.reason !== 'answer' && (
                <Text color="error">{'  '}結束原因：{t.reason === 'aborted' ? '中斷' : t.reason === 'refusal' ? '拒答' : '錯誤'}</Text>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
