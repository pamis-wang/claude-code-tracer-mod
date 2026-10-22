export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** One model request, main loop or subagent: a bar in the pane's charts. */
export type StepRow = {
  id: string
  /** The loop: '' for the main conversation, else the agent's id. */
  loop: string
  startedAt: number
  endedAt?: number
  model?: string
  /** How full the context window was, in percent. */
  ctx: number
  /** input, output, cache read, cache write. */
  usage?: [number, number, number, number]
  costUsd: number
  tools: string[]
  errors: number
  stop?: string | null
}

/** One turn of the main conversation. */
export type TurnRow = {
  id: string
  n: number
  prompt: string
  startedAt: number
  endedAt?: number
  /** Since the previous main turn's last response: how cold the cache got. */
  gapMs?: number
  model?: string
  steps: number
  tokens: Tokens
  /** The first request's tokens: where a cache miss shows. */
  firstStep?: Tokens
  /** The session's cost ledger when the turn started; its delta is the turn's cost. */
  costAtStart: number
  costUsd?: number
  tools: Record<string, number>
  toolErrors: number
  agents: number
  reason?: string
}

/** One subagent or teammate, summed over all of its runs. */
export type AgentRow = {
  id: string
  type: string
  description: string
  model?: string
  parentId?: string
  isBackground: boolean
  startedAt: number
  endedAt?: number
  isRunning: boolean
  steps: number
  tokens: Tokens
  /** Ledger increments seen right after this agent's responses. */
  costUsd: number
  tools: Record<string, number>
  toolErrors: number
  reason?: string
}

export type RateLimitRow = { kind: string; percentUsed: number; resetsAt?: string }

export type BreakdownRow = { name: string; tokens: number; kind: string }

export type Meter = {
  contextPct?: number
  contextTokens?: number
  window?: number
  costUsd?: number
  rateLimits: RateLimitRow[]
  breakdown?: BreakdownRow[]
  memoryFiles?: { path: string; tokens: number }[]
  breakdownAt?: number
  /** When the main conversation last got a response: the cache TTL runs from here. */
  lastMainResponseAt?: number
}

export type PromptSectionRow = { id: string; hash: string; text: string }

export type PromptVersion = {
  n: number
  at: number
  model: string
  hash: string
  chars: number
  added: string[]
  removed: string[]
  changed: string[]
}

export type PromptState = {
  versions: PromptVersion[]
  current: PromptSectionRow[]
  previous: PromptSectionRow[]
}

export type Tab = 'timeline' | 'agents' | 'context' | 'prompt'

export type ViewState = { tab: Tab; section?: string; isDiff: boolean }

export type Diag = { pricedSteps: number; zeroDeltaSteps: number }

declare module 'claude-code' {
  interface PluginState {
    tracer: {
      steps: StepRow[]
      turns: TurnRow[]
      agents: AgentRow[]
      meter: Meter
      prompt: PromptState
      view: ViewState
      tick: number
      diag: Diag
    }
  }
}
