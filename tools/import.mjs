#!/usr/bin/env node
// tracer importer: history the dashboard never saw live, turned into its data.
//
//   node tools/import.mjs             import what the dashboard does not have yet
//   node tools/import.mjs --force     import again, replacing earlier imports
//   node tools/import.mjs --dry-run   say what would be imported, write nothing
//   node tools/import.mjs --exclude=26b25698,c1794e82   leave sessions out by id prefix
//
// The source is Claude Code's own transcripts (~/.claude/projects/*/*.jsonl, each
// session's subagents beside it): prompts, answers, tool calls with their input
// and output, timings and usage.
//
// Node built-ins only; it writes the files the mod's recorder writes.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = new Set(process.argv.slice(2))
const FORCE = args.has('--force')
const DRY = args.has('--dry-run')
const EXCLUDE = [...args]
  .filter(a => a.startsWith('--exclude='))
  .flatMap(a => a.slice('--exclude='.length).split(','))
  .filter(Boolean)
const isExcluded = id => EXCLUDE.some(prefix => id.startsWith(prefix))

const HOME = os.homedir()
const PROJECTS = path.join(HOME, '.claude', 'projects')
const DATA = path.join(HOME, '.claude', 'tracer', 'data')
const TEXT_CAP = 20_000
const TOOL_INPUT_CAP = 4_000
const TOOL_RESULT_CAP = 8_000

// Per million tokens: input, output, cache read. A cache write costs 1.25×
// input for 5 minutes, 2× for an hour. Where Claude Code recorded what the
// session cost, these only weigh the requests against each other and the
// totals are scaled to that record.
const PRICES = Object.entries({
  'claude-fable-5-1': [10, 50, 0.25],
  'claude-fable-5': [10, 50, 1],
  'claude-mythos-5': [10, 50, 0.25],
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5],
  'claude-opus-4': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-sonnet-5': [2, 10, 0.2],
  'claude-sonnet-4': [3, 15, 0.3],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
  'claude-haiku-4': [1, 5, 0.1],
}).sort((a, b) => b[0].length - a[0].length)

// ---------- small things ----------

function priceOf(model) {
  const hit = PRICES.find(([prefix]) => String(model || '').startsWith(prefix))
  return hit ? hit[1] : [3, 15, 0.3]
}

function weigh(usage, model) {
  if (!usage) return 0
  const [inp, out, read] = priceOf(model)
  const split = usage.cache_creation || {}
  const hour = split.ephemeral_1h_input_tokens || 0
  const five = Math.max(0, (usage.cache_creation_input_tokens || 0) - hour)
  return ((usage.input_tokens || 0) * inp + (usage.output_tokens || 0) * out + (usage.cache_read_input_tokens || 0) * read + five * inp * 1.25 + hour * inp * 2) / 1e6
}

const usage4 = u => (u ? [u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0] : undefined)

function cap(text, max) {
  const s = String(text ?? '')
  return s.length <= max ? s : `${s.slice(0, max)}\n…（截斷，原長 ${s.length} 字元）`
}

function wrap(kind, data) {
  return `__tracer(${JSON.stringify({ kind, data })});\n`
}

function unwrap(text) {
  const start = text.indexOf('(')
  const end = text.lastIndexOf(')')
  try {
    return JSON.parse(text.slice(start + 1, end)).data
  } catch {
    return undefined
  }
}

function write(file, text) {
  if (DRY) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function readJsonl(file) {
  const out = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // A torn last line from a session that was still writing.
    }
  }
  return out
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(b => (b && b.type === 'text' ? b.text : b && b.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n')
}

const isCommand = text => /^\s*<(local-command|command-name|command-message|command-args)/.test(text)

/** Only the IDE's or the engine's blocks, nothing the person typed. */
const isOnlyTags = text =>
  String(text).replace(/<(ide_[a-z_]+|system-reminder)>[\s\S]*?<\/\1>/g, '').trim() === ''

/** A prompt as a list shows it: no IDE or reminder blocks, a notification as its summary. */
function promptLabel(text) {
  const raw = String(text).replace(/\s+/g, ' ').trim()
  if (raw.startsWith('<task-notification>')) {
    const summary = raw.match(/<summary>(.*?)<\/summary>/)
    return `🔔 ${summary ? summary[1].trim() : '背景任務'}`
  }
  const bare = raw.replace(/<(ide_[a-z_]+|system-reminder)>.*?<\/\1>/g, ' ').replace(/\s+/g, ' ').trim()
  return bare || raw
}

/** FNV-1a, 32 bits, as the mod hashes a tool call's input. */
function hash(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

function projectOf(cwd) {
  const parts = String(cwd || '').split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] || String(cwd || '?')
}

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function toolSummary(name, input) {
  const pick = (...keys) => keys.map(k => input[k]).find(v => typeof v === 'string' && v !== '')
  const first = Object.values(input).find(v => typeof v === 'string')
  const text = name === 'Bash' || name === 'PowerShell'
    ? pick('command', 'description')
    : pick('file_path', 'path', 'pattern', 'url', 'query', 'description', 'skill', 'prompt') ?? first
  return oneLine(text).slice(0, 160)
}

// ---------- what the index says of a session (as the recorder writes it) ----------

const clamp = n => Math.max(0, Math.min(1, n))
const median = list => {
  const s = [...list].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}

function weatherOf(r) {
  const main = r.steps.filter(s => s.loop === '' && s.usage)
  const prompt = s => (s.usage ? s.usage[0] + s.usage[2] + s.usage[3] : 0)
  const factors = []
  const add = (name, severity, detail) => factors.push({ name, severity: clamp(severity), detail })
  const ctx = typeof r.meter.contextPct === 'number' ? r.meter.contextPct : 0
  add('context 壓力', (ctx - 50) / 45, `context ${ctx}%`)
  let compactions = 0
  main.forEach((s, k) => {
    const prev = main[k - 1]
    if (s.stop === 'compaction' || (prev && prompt(prev) > 20_000 && prompt(s) < prompt(prev) * 0.6)) compactions++
  })
  add('compaction', compactions * 0.3, `${compactions} 次`)
  const cut = r.steps.filter(s => ['max_tokens', 'refusal', 'model_context_window_exceeded'].includes(s.stop)).length
  add('截斷／拒答', cut * 0.5, `${cut} 次`)
  let repeat = 1
  let worst = 1
  r.tools.forEach((t, k) => {
    const prev = r.tools[k - 1]
    repeat = prev && prev.loop === t.loop && prev.name === t.name && prev.sig !== undefined && prev.sig === t.sig ? repeat + 1 : 1
    worst = Math.max(worst, repeat)
  })
  add('卡住迴圈', (worst - 2) * 0.3, `同一個工具呼叫連續 ${worst} 次`)
  const durations = main.filter(s => s.endedAt).map(s => s.endedAt - s.startedAt)
  const drift = durations.length >= 20 ? median(durations.slice(-5)) / Math.max(1, median(durations.slice(0, 5))) : 1
  add('延遲漂移', (drift - 3) / 3, `最近的請求慢了 ${drift.toFixed(1)} 倍`)
  const calls = r.tools.length
  const errors = r.tools.filter(t => t.isError).length
  add('工具錯誤率', calls >= 4 ? (errors / calls) * 2 : 0, `${errors}/${calls}`)
  let all = 0
  let read = 0
  for (const s of r.steps) if (s.usage) { all += prompt(s); read += s.usage[2] }
  const hit = all > 0 ? (read / all) * 100 : 100
  add('cache 效率', all > 50_000 ? (80 - hit) / 60 : 0, `命中 ${hit.toFixed(0)}%`)
  const denied = r.tools.filter(t => t.isDenied).length
  add('權限拒絕', denied * 0.25, `${denied} 次`)
  const sorted = factors.map(f => f.severity).sort((a, b) => b - a)
  return { score: clamp((sorted[0] || 0) + 0.3 * (sorted[1] || 0)), factors: factors.sort((a, b) => b.severity - a.severity) }
}

function indexEntry(r) {
  const tokens = [0, 0, 0, 0]
  const hours = new Map()
  for (const s of r.steps) {
    if (!s.usage) continue
    for (let i = 0; i < 4; i++) tokens[i] += s.usage[i]
    const hour = Math.floor(s.startedAt / 3_600_000) * 3_600_000
    const b = hours.get(hour) || [hour, 0, 0, 0, 0, 0]
    b[1] += s.costUsd || 0
    for (let i = 0; i < 4; i++) b[i + 2] += s.usage[i]
    hours.set(hour, b)
  }
  const main = r.steps.filter(s => s.loop === '' && s.endedAt)
  const last = [...r.turns].reverse().find(t => t.prompt)
  return {
    id: r.id,
    project: r.project,
    cwd: r.cwd,
    title: r.title,
    model: main.length ? main[main.length - 1].model : undefined,
    startedAt: r.startedAt,
    updatedAt: r.updatedAt,
    turns: r.turns.length,
    requests: r.steps.length,
    agents: r.agents.length,
    costUsd: Math.max(r.meter.costUsd || 0, r.steps.reduce((a, s) => a + (s.costUsd || 0), 0)),
    tokens,
    contextPct: r.meter.contextPct,
    lastMainResponseAt: main.length ? main[main.length - 1].endedAt : undefined,
    isBusy: false,
    lastPrompt: last ? last.prompt : '',
    toolErrors: r.tools.filter(t => t.isError).length,
    ttlMs: r.ttlMs,
    hourly: [...hours.values()].sort((a, b) => a[0] - b[0]),
    weather: weatherOf(r),
    imported: r.imported,
  }
}

// ---------- Claude Code transcripts ----------

/** One loop's requests and tool calls, read off its transcript in order. */
function walk(entries, loop, onHuman) {
  const requests = new Map(entries.filter(e => e.type === 'api-request').map(e => [e.id, e]))
  const steps = []
  const tools = new Map()
  const byMessage = new Map()
  let lastTs
  for (const e of entries) {
    const ts = Date.parse(e.timestamp)
    if (!Number.isFinite(ts)) continue
    if (e.type === 'user' && e.message) {
      const content = e.message.content
      const results = Array.isArray(content) ? content.filter(b => b && b.type === 'tool_result') : []
      if (results.length) {
        for (const b of results) {
          const t = tools.get(b.tool_use_id)
          if (!t) continue
          t.endedAt = ts
          t.result = textOf(b.content)
          t.isError = b.is_error === true || undefined
          if (t.isError && /permission|denied|rejected/i.test(t.result)) t.isDenied = true
        }
      } else if (!e.isMeta) {
        const text = textOf(content)
        if (text.trim() && !isCommand(text) && !isOnlyTags(text)) onHuman(text, ts)
      }
      lastTs = ts
    } else if (e.type === 'assistant' && e.message && e.message.id) {
      let s = byMessage.get(e.message.id)
      if (!s) {
        const req = requests.get(e.requestRef)
        s = {
          id: e.requestRef || e.message.id,
          loop,
          startedAt: req ? Date.parse(req.timestamp) : lastTs ?? ts,
          endedAt: ts,
          model: e.message.model,
          effort: e.effort,
          rawUsage: undefined,
          stop: null,
          answer: '',
          thinking: '',
          tools: [],
          thinkingMs: e.thinkingDurationMs,
        }
        byMessage.set(e.message.id, s)
        steps.push(s)
      }
      s.endedAt = Math.max(s.endedAt, ts)
      if (e.message.usage) s.rawUsage = e.message.usage
      if (e.message.stop_reason) s.stop = e.message.stop_reason
      for (const b of e.message.content || []) {
        if (b.type === 'text' && b.text) s.answer += (s.answer ? '\n' : '') + b.text
        if (b.type === 'thinking' && b.thinking) s.thinking += b.thinking
        if (b.type === 'tool_use') {
          s.tools.push(b.id)
          tools.set(b.id, { id: b.id, name: b.name, input: b.input || {}, loop, startedAt: ts })
        }
      }
      lastTs = ts
    }
  }
  return { steps, tools }
}

function importTranscript(file) {
  const entries = readJsonl(file)
  const id = path.basename(file, '.jsonl')
  const main = entries.filter(e => !e.isSidechain)
  const cwd = (entries.find(e => e.cwd) || {}).cwd || ''
  const titles = entries.filter(e => e.type === 'ai-title' && e.aiTitle)
  const costState = [...entries].reverse().find(e => e.type === 'cost-state')

  const turns = []
  const mainWalk = walk(main, '', (text, ts) => turns.push({ prompt: text, startedAt: ts }))
  if (!mainWalk.steps.length) return null
  if (!turns.length || turns[0].startedAt > mainWalk.steps[0].startedAt) turns.unshift({ prompt: '', startedAt: mainWalk.steps[0].startedAt })
  turns.forEach((t, i) => (t.n = i + 1))
  const turnAt = ts => {
    let n = 1
    for (const t of turns) if (t.startedAt <= ts) n = t.n
    return n
  }

  // Subagents: their own transcripts, and what they were spawned as.
  const agents = []
  const loops = [mainWalk]
  const agentDir = path.join(path.dirname(file), id, 'subagents')
  if (fs.existsSync(agentDir)) {
    for (const name of fs.readdirSync(agentDir).filter(f => f.endsWith('.jsonl'))) {
      const agentId = name.replace(/^agent-/, '').replace(/\.jsonl$/, '')
      let meta = {}
      try {
        meta = JSON.parse(fs.readFileSync(path.join(agentDir, name.replace(/\.jsonl$/, '.meta.json')), 'utf8'))
      } catch {
        // No meta: an older layout.
      }
      let task = ''
      const w = walk(readJsonl(path.join(agentDir, name)), agentId, text => { if (!task) task = text })
      if (!w.steps.length) continue
      loops.push(w)
      const parent = mainWalk.tools.get(meta.toolUseId)
      const last = w.steps[w.steps.length - 1]
      agents.push({
        id: agentId,
        type: meta.agentType || 'agent',
        description: oneLine(meta.description || (parent && parent.input.description) || ''),
        model: last.model,
        isBackground: meta.requestShape === 'background',
        turn: turnAt(parent ? parent.startedAt : w.steps[0].startedAt),
        startedAt: w.steps[0].startedAt,
        endedAt: last.endedAt,
        reason: 'answer',
        task,
        answer: [...w.steps].reverse().find(s => s.answer)?.answer || '',
      })
    }
  }

  // Costs: weighed per request, scaled to what Claude Code recorded per model.
  const allSteps = loops.flatMap(l => l.steps)
  const weights = new Map()
  for (const s of allSteps) weights.set(s.model, (weights.get(s.model) || 0) + weigh(s.rawUsage, s.model))
  const factor = model => {
    const usage = costState && costState.modelUsage ? Object.entries(costState.modelUsage).find(([k]) => k.startsWith(model) || model.startsWith(k)) : undefined
    const w = weights.get(model) || 0
    return usage && usage[1].costUSD > 0 && w > 0 ? usage[1].costUSD / w : 1
  }

  const window = 1_000_000
  const steps = []
  const counters = new Map()
  for (const s of allSteps.sort((a, b) => a.startedAt - b.startedAt)) {
    const turn = turnAt(s.startedAt)
    const key = s.loop + ':' + turn
    const index = counters.get(key) || 0
    counters.set(key, index + 1)
    steps.push({
      id: s.id,
      turn,
      loop: s.loop,
      index,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      model: s.model,
      effort: s.effort,
      messages: 0,
      usage: usage4(s.rawUsage),
      // Weighed, then scaled to Claude Code's own ledger.
      costUsd: weigh(s.rawUsage, s.model) * factor(s.model),
      stop: s.stop,
      tools: s.tools,
      answerChars: s.answer.length,
      hasThinking: s.thinking.length > 0,
      _answer: s.answer,
      _thinking: s.thinking,
    })
  }
  const tools = loops.flatMap(l => [...l.tools.values()]).map(t => ({
    id: t.id,
    name: t.name,
    loop: t.loop,
    turn: turnAt(t.startedAt),
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    isError: t.isError,
    isDenied: t.isDenied,
    summary: toolSummary(t.name, t.input),
    sig: hash(JSON.stringify(t.input)),
    _input: t.input,
    _result: t.result,
  }))

  const lastMain = [...steps].reverse().find(s => s.loop === '' && s.usage)
  const used = lastMain ? lastMain.usage[0] + lastMain.usage[1] + lastMain.usage[2] + lastMain.usage[3] : 0
  const ends = turns.map((t, i) => {
    const mine = steps.filter(s => s.turn === t.n)
    return {
      n: t.n,
      id: `import-${t.n}`,
      prompt: promptLabel(t.prompt).slice(0, 300),
      startedAt: t.startedAt,
      endedAt: mine.length ? Math.max(...mine.map(s => s.endedAt)) : t.startedAt,
      reason: 'answer',
      costAtStart: 0,
      costUsd: mine.reduce((a, s) => a + s.costUsd, 0),
      _prompt: t.prompt,
      _answer: [...mine].reverse().find(s => s.loop === '' && s._answer)?._answer || '',
    }
  })
  const firstHuman = turns.find(t => t.prompt && !t.prompt.trimStart().startsWith('<task-notification>'))
  const startedAt = Math.min(...steps.map(s => s.startedAt), turns[0].startedAt)
  const updatedAt = Math.max(...steps.map(s => s.endedAt))

  const rec = {
    id,
    project: projectOf(cwd),
    cwd,
    title: titles.length ? titles[titles.length - 1].aiTitle : firstHuman ? promptLabel(firstHuman.prompt).slice(0, 80) : '',
    startedAt,
    updatedAt,
    ttlMs: 3_600_000,
    meter: {
      window,
      contextPct: Math.round((used / window) * 100),
      contextTokens: used,
      costUsd: costState ? costState.totalCostUSD : undefined,
    },
    turns: ends.map(({ _prompt, _answer, ...t }) => t),
    steps: steps.map(({ _answer, _thinking, ...s }) => s),
    tools: tools.map(({ _input, _result, ...t }) => t),
    agents: agents.map(({ task, answer, ...a }) => a),
    imported: 'claude-code',
  }

  const details = new Map()
  const detail = n => {
    if (!details.has(n)) {
      const t = ends.find(x => x.n === n)
      details.set(n, { session: id, n, prompt: cap(t ? t._prompt : '', TEXT_CAP), answer: cap(t ? t._answer : '', TEXT_CAP), steps: {}, tools: {}, agents: {} })
    }
    return details.get(n)
  }
  for (const t of ends) detail(t.n)
  for (const s of steps) detail(s.turn).steps[s.id] = { answer: cap(s._answer, TEXT_CAP), thinking: cap(s._thinking, TEXT_CAP) }
  for (const t of tools) detail(t.turn).tools[t.id] = { input: cap(JSON.stringify(t._input, null, 2), TOOL_INPUT_CAP), result: cap(t._result || '', TOOL_RESULT_CAP) }
  for (const a of agents) detail(a.turn).agents[a.id] = { prompt: cap(a.task, TEXT_CAP), answer: cap(a.answer, TEXT_CAP) }

  return { rec, details: [...details.values()] }
}

function transcriptFiles() {
  if (!fs.existsSync(PROJECTS)) return []
  const out = []
  for (const dir of fs.readdirSync(PROJECTS)) {
    const full = path.join(PROJECTS, dir)
    if (!fs.statSync(full).isDirectory()) continue
    for (const f of fs.readdirSync(full)) if (f.endsWith('.jsonl')) out.push(path.join(full, f))
  }
  return out
}

// ---------- run ----------

const indexFile = path.join(DATA, 'index.js')
const index = (fs.existsSync(indexFile) && unwrap(fs.readFileSync(indexFile, 'utf8'))) || { updatedAt: Date.now(), sessions: [] }
const known = new Set(index.sessions.filter(e => FORCE ? !e.imported : true).map(e => e.id))

const imported = []
for (const file of transcriptFiles()) {
  const id = path.basename(file, '.jsonl')
  if (known.has(id) || isExcluded(id)) continue
  try {
    const one = importTranscript(file)
    if (one) imported.push(one)
  } catch (err) {
    console.warn(`略過 ${file}：${err.message}`)
  }
}
let bytes = 0
for (const { rec, details } of imported) {
  const text = wrap('session', rec)
  bytes += text.length
  write(path.join(DATA, 's', `${rec.id}.js`), text)
  for (const d of details) {
    const t = wrap('turn', d)
    bytes += t.length
    write(path.join(DATA, 's', rec.id, `t${d.n}.js`), t)
  }
}
const added = new Set(imported.map(x => x.rec.id))
index.sessions = [...index.sessions.filter(e => !added.has(e.id)), ...imported.map(x => indexEntry(x.rec))]
index.updatedAt = Date.now()
write(indexFile, wrap('index', index))

const requests = imported.reduce((a, x) => a + x.rec.steps.length, 0)
const cost = imported.reduce((a, x) => a + indexEntry(x.rec).costUsd, 0)
console.log(
  `${DRY ? '（試跑，沒有寫入）' : ''}從 Claude Code 對話紀錄匯入 ${imported.length} 個 session；` +
    `${requests} 個請求，合計 $${cost.toFixed(2)}；${(bytes / 1024 / 1024).toFixed(1)} MB。`,
)
