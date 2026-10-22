import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { laneChart, lanesOf, squeezedScale } from '../hooks/charts'
import type { AgentRow, StepRow } from '../types'

const PANE = {
  plugin: 'tracer',
  component: 'Pane',
  requestId: 'tracer',
  props: {
    title: 'Tracer',
    isFocused: false,
    bodyColumns: 56,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

/**
 * The engine beneath the mod: a ledger that grows by `perStep` with each
 * response, and a person who answers the mod's questions from `answers`.
 */
function engine(on: On, perStep: number, answers: string[] = []) {
  const ledger = { usd: 0.1, models: [] as string[], commands: [] as string[] }
  on('command.register', () => ({ value: { command: 'tracer' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 1_000_000, tokens: 280_000, percent: 28 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 23 }],
      cost: { usd: ledger.usd },
    },
  }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    ledger.usd += perStep
    ledger.models.push(e.model)
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        input_tokens: 100,
        output_tokens: 800,
        cache_read_input_tokens: 49_000,
        cache_creation_input_tokens: 900,
        model: 'claude-opus-5-5',
      },
    }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', (_, e) => {
    if (String(e.tool) === 'Bash') ledger.commands.push((e as unknown as { command: string }).command)
    if (String(e.tool) !== 'AskUserQuestion') return { result: {} }
    const { questions } = e as unknown as { questions: { question: string }[] }
    return { result: { questions, answers: { [questions[0]!.question]: answers.shift() ?? '放行' } } }
  })
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('ui.status', () => ({ value: undefined }))

  return ledger
}

async function drain(stream: AsyncIterable<{ kind: string; text?: string }>): Promise<string> {
  let text = ''
  for await (const chunk of stream) if (chunk.kind === 'text') text += chunk.text ?? ''
  return text
}

const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never

test('the lane charts draw on every surface', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  engine(on, 0.25)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '畫圖', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))
  await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
  await drain($.turn.step({ turnId: 't1', index: 1, model: 'claude-opus-5-5', messageCount: 3 }))
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })

  for (const surface of ['terminal', 'vscode', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /[▁▂▃▄▅▆▇█]/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /main/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /畫圖/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a long session fills the pane width exactly, idle time squeezed out', () => {
  const steps: StepRow[] = []
  const agents: AgentRow[] = []
  for (let i = 0; i < 400; i++) {
    const loop = i % 5 === 0 ? `agent${i % 40}` : ''
    // A burst every 50 requests, then an hour of nothing.
    const at = 1_000_000 + i * 4_000 + Math.floor(i / 50) * 3_600_000
    steps.push({ id: `s${i}`, loop, startedAt: at, endedAt: at + 3_000, model: 'claude-opus-5-5', ctx: (i % 90) + 5, usage: [10, 500, 90_000, 2_000], costUsd: 0.02, tools: ['Read', 'Edit'], errors: i % 37 === 0 ? 1 : 0, stop: 'tool_use' })
  }
  for (let k = 0; k < 8; k++) {
    agents.push({ id: `agent${k * 5}`, type: 'Explore', description: '找 <script> & 讀 "檔案"', isBackground: false, startedAt: 1_000_000, endedAt: 2_000_000, isRunning: false, steps: 10, tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, costUsd: 0.1, tools: {}, toolErrors: 0, reason: 'answer' })
  }
  const lanes = lanesOf(steps, agents, 40_000_000)
  const chart = laneChart(lanes, 84, 40_000_000)
  expect(lanes.length <= 7).toBe(true)
  for (const lane of chart.lanes) {
    for (const row of lane.rows) expect(row.map(r => r.text).join('').length).toBe(84)
  }
  const main = chart.lanes[0]!.rows.map(r => r.map(x => x.text).join('')).join('')
  expect(main.includes('┊')).toBe(true)
  expect(chart.lanes.some(l => l.rows.some(r => r.some(x => x.color === '#f85149')))).toBe(true)

  const scale = squeezedScale([{ start: 0, end: 10_000 }, { start: 3_600_000, end: 3_610_000 }], 210, 10)
  expect(scale.breaks.length).toBe(1)
  expect(Math.round(scale.x(3_600_000))).toBe(110)
})

test('the stats line shows beneath each answer, and turns off', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  engine(on, 0.25)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))
  const shown = await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(shown.text).toContain('tracer · ctx 28%')
  expect(shown.text).toContain('cache 命中 98%')
  expect(shown.text).toContain('$0.25')

  await $.command.run({ command: 'tracer', args: 'stats off', ...(COMMAND as object) } as never)
  await $.turn.start({ text: 'again', turnId: 't2' })
  await drain($.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 3 }))
  const plain = await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer' })
  expect(plain.text).toBe('ok')
})

test('an intercepted request can be refused before it is sent', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const sent = engine(on, 0.25, ['拒絕這個請求'])

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'tracer', args: 'intercept', ...(COMMAND as object) } as never)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const text = await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))
  expect(text).toContain('攔截並拒絕')
  expect(sent.models.length).toBe(0)

  // One-shot: the next request goes through unasked.
  await drain($.turn.step({ turnId: 't1', index: 1, model: 'claude-opus-5-5', messageCount: 2 }))
  expect(sent.models).toEqual(['claude-opus-5-5'])
})

test('an intercepted request can be sent to another model', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const sent = engine(on, 0.25, ['換模型', 'sonnet-5-5'])

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'tracer', args: 'intercept', ...(COMMAND as object) } as never)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))
  expect(sent.models).toEqual(['claude-sonnet-5-5'])
})

test('an intercepted tool call can be refused or rewritten', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const ran = engine(on, 0.25, ['拒絕', 'echo safe'])

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'tracer', args: 'intercept tools', ...(COMMAND as object) } as never)
  const refused = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as never)
  expect(refused.deny).toContain('攔截並拒絕')
  expect(ran.commands).toEqual([])

  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as never)
  expect(ran.commands).toEqual(['echo safe'])
})

test('a turn shows its prompt, cost, cache hit and tools on every surface', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  engine(on, 0.25)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '修正登入按鈕', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: '/a' })
  await $.tool.call({ tool: 'Read', file_path: '/b' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // drain
  }
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /修正登入按鈕/ }))?.text).toContain('#1')
    expect(await ui.find({ type: 'Text', text: /\$0\.25/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /hit 98%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Read×2/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a subagent gets its own row with its share of the ledger', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  engine(on, 0.05)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '找出驗證程式碼', turnId: 't1' })
  await $.agent.spawn({
    prompt: 'find auth code',
    description: 'find auth code',
    subagentType: 'Explore',
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  } as never)
  await $.turn.start({ text: 'find auth code', turnId: 'a-t1', agentId: 'a1' })
  for await (const _ of $.turn.step({ turnId: 'a-t1', index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId: 'a1' })) {
    // drain
  }
  await $.tool.call({ tool: 'Grep', pattern: 'auth', agentId: 'a1' } as never)
  await $.turn.complete({ answer: 'found', durationMs: 500, isAborted: false, turnId: 'a-t1', agentId: 'a1', reason: 'answer' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-agents' })
    expect(await ui.find({ type: 'Text', text: /Explore/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\$0\.05/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Grep/ })).toBeDefined()
    await ui.press({ key: 'tab-timeline' })
    await ui.unmount()
  }
})

test('the system prompt the mod asks for keeps versions and marks the changed section', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  engine(on, 0.01)
  let memory = 'remember A'
  on('prompt.compose', () => ({
    sections: [
      { id: 'intro', text: 'You are Claude.', scope: 'shared' as const },
      { id: 'memory', text: memory, scope: 'session' as const },
    ],
  }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))

  // The mod asks once the session has started, and again as each main turn starts.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(200)
  memory = 'remember A\nremember B'
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(50)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-prompt' })
  expect(await ui.find({ type: 'Text', text: /v2 .*~memory/ })).toBeDefined()
  await ui.press({ key: 'sec-memory' })
  await ui.press({ key: 'mode-diff' })
  expect(await ui.find({ type: 'Text', text: /\+ remember B/ })).toBeDefined()
  await ui.unmount()
})

/** A disk in memory: what the recorder writes, readable back the way the page reads it. */
function disk(on: On) {
  const files = new Map<string, string>()
  const norm = (path: string) => path.replace(/\\/g, '/')
  on('fs.write', (_, e) => {
    files.set(norm(e.path), e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = files.get(norm(e.path))
    if (text === undefined) throw new Error(`no file ${e.path}`)
    return { value: text }
  })
  on('fs.exists', (_, e) => ({ value: files.has(norm(e.path)) }))
  on('session.id', () => ({ value: 'sess-1234abcd' }))
  on('session.cwd', () => ({ value: 'D:\\SideProject\\demo' }))
  mock.env(on, { USERPROFILE: 'C:\\Users\\me' })
  const load = (path: string) => {
    const text = files.get(path)
    if (text === undefined) return undefined
    const start = text.indexOf('(')
    return JSON.parse(text.slice(start + 1, text.lastIndexOf(')'))) as { kind: string; data: Record<string, unknown> }
  }
  return { files, load }
}

test('the recorder writes what the web page loads', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  engine(on, 0.2)
  const { load } = disk(on)
  const base = 'C:/Users/me/.claude/tracer'

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: '修正登入按鈕', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // drain
  }
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'tu1' } as never)
  await $.turn.complete({ answer: '修好了', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(2_000)

  const session = load(`${base}/data/s/sess-1234abcd.js`)
  expect(session?.kind).toBe('session')
  expect(session?.data.project).toBe('demo')
  expect(session?.data.title).toBe('修正登入按鈕')
  const steps = session?.data.steps as { loop: string; usage: number[]; costUsd: number; tools: string[] }[]
  expect(steps.length).toBe(1)
  expect(steps[0]?.usage).toEqual([100, 800, 49_000, 900])
  expect(Math.round((steps[0]?.costUsd ?? 0) * 100)).toBe(20)
  const tools = session?.data.tools as { name: string; summary: string }[]
  expect(tools[0]?.name).toBe('Bash')
  expect(tools[0]?.summary).toBe('npm test')

  const turn = load(`${base}/data/s/sess-1234abcd/t1.js`)
  expect(turn?.data.prompt).toBe('修正登入按鈕')
  expect(turn?.data.answer).toBe('修好了')

  const index = load(`${base}/data/index.js`)
  const sessions = index?.data.sessions as { id: string; turns: number; costUsd: number }[]
  expect(sessions[0]?.id).toBe('sess-1234abcd')
  expect(sessions[0]?.turns).toBe(1)
})

test('the cache countdown warns once before the TTL runs out', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  engine(on, 0.01)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // drain
  }
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })

  await clock.advance(50 * 60_000)
  expect(toasts.length).toBe(0)
  await clock.advance(6 * 60_000)
  expect(toasts.length).toBe(1)
  await clock.advance(2 * 60_000)
  expect(toasts.length).toBe(1)
})
