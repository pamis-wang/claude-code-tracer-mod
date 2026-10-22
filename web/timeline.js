'use strict'

// tracer dashboard: the workflow timeline. One lane per loop (the main
// conversation, then each subagent in the order it started), one bar per
// model request: x is when it ran, height how full the context was, colour
// what the cache served. Below: the lane's or the request's card, and the
// request's conversation step by step.

window.XR_TL = (() => {
  const GUTTER = 240
  const AXIS = 18
  const CTX_H = 44
  const COST_H = 8
  const EVT_H = 8
  const GAP = 4
  const MAIN_COLOR = '#3b82c4'
  const PALETTE = ['#d07028', '#c24878', '#6d8f1c', '#1f9990', '#9a8818', '#9838a0', '#5060d4']
  const GLYPHS = ['square', 'tri', 'diamond', 'plus', 'semi', 'trap', 'para']
  const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
  const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
  const EVENTS = {
    error: { track: 0, shape: 'square', color: '#f85149', label: '錯誤' },
    stop: { track: 0, shape: 'tri', color: '#ff9b8e', label: '異常停止' },
    compaction: { track: 1, shape: 'tri', color: '#bc8cff', label: 'compaction' },
    miss: { track: 1, shape: 'circle', color: '#d2a8ff', label: 'cache miss' },
    ctx80: { track: 1, shape: 'square', color: '#8957e5', label: 'context 過 80%' },
    write: { track: 2, shape: 'circle', color: '#2ea043', label: '寫檔' },
  }
  const TRACKS = ['faults', 'ctx', 'mutate']

  const T = {
    lane: null,
    step: null,
    row: null,
    zoom: null,
    birdseye: false,
    lanesH: +TR.read('tracer-lanes-h') || 240,
    expanded: new Set(),
    seenMain: 0,
    follow: true,
  }

  // ---------- the model of one session ----------

  function model() {
    const sid = TR.S.sel.session
    const rec = sid && TR.S.sessions[sid]
    if (!rec) return null
    const now = TR.S.now
    const window = (rec.meter && rec.meter.window) || 1_000_000
    const tools = new Map(rec.tools.map(t => [t.id, t]))
    const agents = new Map(rec.agents.map(a => [a.id, a]))
    const byLoop = new Map([['', []]])
    for (const s of [...rec.steps].sort((a, b) => a.startedAt - b.startedAt)) {
      if (!byLoop.has(s.loop)) byLoop.set(s.loop, [])
      byLoop.get(s.loop).push(s)
    }
    const lanes = [...byLoop.entries()]
      .filter(([key, steps]) => key === '' || steps.length > 0)
      .sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : a[1][0].startedAt - b[1][0].startedAt))
      .map(([key, steps], i) => {
        const agent = agents.get(key)
        const name = key === '' ? 'main' : `${agent ? agent.type : 'agent'} ${key.slice(0, 4)}`
        const lane = {
          key,
          name,
          agent,
          steps,
          color: key === '' ? MAIN_COLOR : PALETTE[(i - 1) % PALETTE.length],
          glyph: key === '' ? 'circle' : GLYPHS[Math.floor((i - 1) / PALETTE.length) % GLYPHS.length],
        }
        steps.forEach((s, k) => decorate(s, k, lane, tools, window))
        markEvents(lane)
        return lane
      })
    const all = lanes.flatMap(l => l.steps)
    const t0 = all.length ? Math.min(...all.map(s => s.startedAt)) : rec.startedAt
    const t1 = all.length ? Math.max(...all.map(s => s.endedAt || now)) : rec.updatedAt
    return { rec, lanes, all, tools, agents, t0, t1: Math.max(t1, t0 + 1000), window }
  }

  function decorate(s, k, lane, tools, window) {
    const u = s.usage || [0, 0, 0, 0]
    s._n = k + 1
    s._lane = lane
    s._prompt = u[0] + u[2] + u[3]
    s._ctx = ((s._prompt + u[1]) / window) * 100
    s._hit = TR.hit(s.usage)
    s._tools = s.tools.map(id => tools.get(id)).filter(Boolean)
    s._errors = s._tools.filter(t => t.isError).length
    s._events = []
  }

  function markEvents(lane) {
    let crossed = false
    const costs = lane.steps.map(s => s.costUsd || 0).filter(c => c > 0).sort((a, b) => a - b)
    lane.median = costs.length ? costs[Math.floor(costs.length / 2)] : 0
    lane.maxCost = costs.length ? costs[costs.length - 1] : 0
    lane.steps.forEach((s, k) => {
      const prev = lane.steps[k - 1]
      if (s._errors) s._events.push('error')
      if (s.stop && !['end_turn', 'tool_use', 'stop_sequence', 'pause_turn', 'compaction'].includes(s.stop)) s._events.push('stop')
      if (s.stop === 'compaction' || (prev && prev._prompt > 20_000 && s._prompt < prev._prompt * 0.6)) s._events.push('compaction')
      if (s.usage && s._prompt > 1000 && s.usage[2] < s._prompt * 0.5) s._events.push('miss')
      if (!crossed && s._ctx >= 80) { crossed = true; s._events.push('ctx80') }
      if (s._tools.some(t => WRITE_TOOLS.has(t.name))) s._events.push('write')
    })
  }

  function laneOf(m, key) {
    return m.lanes.find(l => l.key === key)
  }
  function stepById(m, id) {
    return m.all.find(s => s.id === id)
  }

  // ---------- geometry ----------

  function view(m) {
    if (T.zoom) return T.zoom
    return { t0: m.t0, t1: m.t1 }
  }
  function laneHeight(lane) {
    return CTX_H + COST_H + (lane.key === T.lane ? EVT_H * TRACKS.length : EVT_H) + GAP
  }
  function relLabel(ms) {
    const s = ms / 1000
    if (s < 60) return Math.round(s) + 's'
    if (s < 3600) return (s / 60).toFixed(1).replace(/\.0$/, '') + 'm'
    return Math.floor(s / 3600) + 'h' + Math.round((s % 3600) / 60) + 'm'
  }

  // ---------- SVG ----------

  function glyph(shape, x, y, r, color, extra) {
    const a = extra || ''
    switch (shape) {
      case 'circle': return `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}"${a}/>`
      case 'square': return `<rect x="${x - r}" y="${y - r}" width="${2 * r}" height="${2 * r}" fill="${color}"${a}/>`
      case 'tri': return `<polygon points="${x},${y - r} ${x + r},${y + r} ${x - r},${y + r}" fill="${color}"${a}/>`
      case 'diamond': return `<polygon points="${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}" fill="${color}"${a}/>`
      case 'plus': return `<path d="M${x - r} ${y}h${2 * r}M${x} ${y - r}v${2 * r}" stroke="${color}" stroke-width="2"${a}/>`
      case 'semi': return `<path d="M${x - r} ${y + r / 2}a${r} ${r} 0 0 1 ${2 * r} 0z" fill="${color}"${a}/>`
      case 'trap': return `<polygon points="${x - r / 2},${y - r} ${x + r / 2},${y - r} ${x + r},${y + r} ${x - r},${y + r}" fill="${color}"${a}/>`
      default: return `<polygon points="${x - r / 2},${y - r} ${x + r},${y - r} ${x + r / 2},${y + r} ${x - r},${y + r}" fill="${color}"${a}/>`
    }
  }

  function axisSvg(m, width, x) {
    const v = view(m)
    const spanS = (v.t1 - v.t0) / 1000
    const n = Math.max(2, Math.min(12, Math.ceil(spanS / 5)))
    let out = `<rect x="0" y="0" width="${width}" height="${AXIS}" fill="var(--bg)"/>`
    out += `<text x="8" y="12" font-size="9" fill="var(--dim)"><tspan fill="var(--bar-read)">■</tspan> read <tspan fill="var(--bar-write)">■</tspan> write <tspan fill="var(--bar-input)">■</tspan> input</text>`
    for (let i = 0; i <= n; i++) {
      const t = v.t0 + ((v.t1 - v.t0) * i) / n
      const px = x(t)
      out += `<line x1="${px}" x2="${px}" y1="${AXIS - 4}" y2="${AXIS}" stroke="var(--border)"/>`
      if (i < n || T.zoom == null) out += `<text x="${px + 2}" y="12" font-size="9" fill="var(--dim)">${relLabel(t - m.t0)}</text>`
    }
    if (T.zoom) {
      out += `<text x="${width - 6}" y="12" font-size="10" fill="var(--accent)" text-anchor="end" data-reset="1" style="cursor:pointer">${relLabel(v.t1 - v.t0)} / ${relLabel(m.t1 - m.t0)} ⟲</text>`
    }
    out += `<line x1="0" x2="${width}" y1="${AXIS - 0.5}" y2="${AXIS - 0.5}" stroke="var(--border)"/>`
    return out
  }

  function laneSvg(m, lane, top, width, x) {
    const isSel = lane.key === T.lane
    const h = laneHeight(lane)
    const dim = T.lane != null && !isSel ? ' opacity="0.55"' : ''
    const v = view(m)
    let out = `<g data-lane="${TR.esc(lane.key)}">`
    out += `<rect x="0" y="${top}" width="${width}" height="${h}" fill="${isSel ? 'rgba(88,166,255,0.04)' : 'transparent'}"/>`
    if (isSel) out += `<rect x="0" y="${top}" width="3" height="${h}" fill="var(--accent)"/>`

    // Gutter: name, glyph, model.
    const models = [...new Set(lane.steps.map(s => TR.shortModel(s.model)))]
    const modelText = models.length <= 1 ? models[0] || '' : models.length === 2 ? `${models[0]} +${models[1]}` : `${models[0]} +${models.length - 1}`
    out += glyph(lane.glyph, 14, top + 12, 4, lane.color)
    out += `<text x="24" y="${top + 16}" font-size="11" fill="var(--text)">${isSel ? '▶ ' : ''}${TR.esc(TR.middle(lane.name, 26))}</text>`
    out += `<text x="24" y="${top + 30}" font-size="10" fill="${lane.color}">${TR.esc(modelText)}<tspan fill="var(--dim)"> · ${lane.steps.length} req</tspan></text>`
    if (lane.agent && lane.agent.description) {
      out += `<text x="24" y="${top + 43}" font-size="9" fill="var(--dim)">${TR.esc(TR.middle(lane.agent.description, 34))}</text>`
    }
    if (isSel) {
      TRACKS.forEach((name, i) => {
        out += `<text x="${GUTTER - 6}" y="${top + CTX_H + COST_H + EVT_H * i + 7}" font-size="8" text-anchor="end" fill="var(--dim)">${name}</text>`
      })
    }

    // Plot area.
    out += `<g${dim}>`
    out += `<svg x="${GUTTER}" y="${top}" width="${width - GUTTER}" height="${h}" overflow="hidden"><g transform="translate(${-GUTTER},${-top})">`
    for (const pct of [40, 80]) {
      const y = top + CTX_H - (CTX_H * pct) / 100
      out += `<line x1="${GUTTER}" x2="${width}" y1="${y}" y2="${y}" stroke="${pct === 40 ? '#8b949e' : '#f85149'}" stroke-opacity="${pct === 40 ? 0.35 : 0.4}" stroke-dasharray="3 3"/>`
      out += `<text x="${width - 4}" y="${y - 2}" font-size="9" text-anchor="end" fill="var(--dim)">${pct}</text>`
    }
    if (lane.key === '') {
      for (const other of m.lanes.slice(1)) {
        const px = x(other.steps[0].startedAt)
        out += `<line x1="${px}" x2="${px}" y1="${top}" y2="${top + h}" stroke="#bc8cff" stroke-opacity="0.45"/>`
      }
      lane.steps.forEach((s, k) => {
        if (k > 0 && s.model && lane.steps[k - 1].model && s.model !== lane.steps[k - 1].model) {
          const px = x(s.startedAt)
          out += `<line x1="${px}" x2="${px}" y1="${top}" y2="${top + h}" stroke="#8b949e" stroke-dasharray="2 3"/>`
        }
      })
    }
    for (const s of lane.steps) {
      const end = s.endedAt || TR.S.now
      if (end < v.t0 || s.startedAt > v.t1) continue
      const x0 = x(s.startedAt)
      const w = Math.max(2, x(end) - x0)
      const bh = Math.max(2, Math.min(CTX_H, (CTX_H * s._ctx) / 100))
      const u = s.usage || [0, 0, 0, 0]
      const prompt = s._prompt || 1
      const segs = [[u[2], 'var(--bar-read)'], [u[3], 'var(--bar-write)'], [u[0], 'var(--bar-input)']]
      let y = top + CTX_H
      const isCur = s.id === T.step
      const fade = T.step && !isCur && s._lane.key === T.lane ? ' opacity="0.45"' : ''
      out += `<g${fade}>`
      if (!s.endedAt) {
        out += `<rect x="${x0}" y="${top + CTX_H - bh}" width="${w}" height="${bh}" fill="none" stroke="${lane.color}" stroke-dasharray="2 2"/>`
      } else {
        for (const [n, color] of segs) {
          if (!n) continue
          const sh = Math.max(1, (bh * n) / prompt)
          y -= sh
          out += `<rect x="${x0}" y="${y}" width="${w}" height="${sh}" fill="${color}"/>`
        }
      }
      if (TR.isStarred('r:' + TR.S.sel.session + '|' + s.id)) {
        out += `<text x="${x0 + w / 2}" y="${top + CTX_H - bh - 4}" font-size="10" text-anchor="middle" fill="var(--yellow)">★</text>`
      }
      const critical = s._events.includes('stop') || s._ctx > 95
      const warning = s._errors > 0 || s._ctx > 85
      if (critical || warning) out += `<rect x="${x0}" y="${top + CTX_H - bh - 2}" width="${w}" height="2" fill="${critical ? '#f85149' : '#d29922'}"/>`
      if (isCur) out += `<rect x="${x0 - 1}" y="${top}" width="${w + 2}" height="${CTX_H}" fill="var(--accent)" fill-opacity="0.18"/>`
      // Cost track.
      if (s.costUsd > 0 && lane.maxCost > 0) {
        const ch = Math.max(1, (7 * s.costUsd) / lane.maxCost)
        const outlier = lane.median > 0 && s.costUsd > 3 * lane.median
        out += `<rect x="${x0}" y="${top + CTX_H + COST_H - ch}" width="${w}" height="${ch}" fill="${outlier ? '#f0883e' : '#484f58'}"/>`
      }
      // Event tracks.
      const shown = isSel ? s._events : s._events.filter(e => EVENTS[e].track === 0)
      shown.forEach((name, i) => {
        const ev = EVENTS[name]
        const row = isSel ? ev.track : 0
        out += glyph(ev.shape, x0 + 2 + i * 5, top + CTX_H + COST_H + EVT_H * row + 4, 2, ev.color)
      })
      out += `</g>`
      out += `<rect x="${x0 - 3}" y="${top}" width="${w + 6}" height="${CTX_H + COST_H + EVT_H}" fill="transparent" data-step="${TR.esc(s.id)}" style="cursor:pointer"/>`
    }
    out += `</g></svg></g>`
    out += `<line x1="0" x2="${width}" y1="${top + h - 0.5}" y2="${top + h - 0.5}" stroke="var(--border)" stroke-opacity="0.5"/>`
    out += `</g>`
    return out
  }

  // ---------- minimap ----------

  function drawMinimap(m) {
    const canvas = document.getElementById('minimap')
    if (!canvas) return
    const rows = m.lanes.length
    const vh = window.innerHeight
    const base = Math.min(vh * 0.2, Math.max(28, rows * 7 + 6))
    const h = T.birdseye ? Math.min(vh * 0.8, Math.max(base, rows * 10 + 6)) : base
    const w = canvas.parentElement.clientWidth - GUTTER
    const dpr = window.devicePixelRatio || 1
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'
    canvas.width = Math.max(1, w * dpr)
    canvas.height = Math.max(1, h * dpr)
    const g = canvas.getContext('2d')
    g.scale(dpr, dpr)
    const css = getComputedStyle(document.documentElement)
    const rowH = (h - 12) / Math.max(1, rows)
    const barMax = Math.min(T.birdseye ? 20 : 8, rowH - 1)
    const px = t => ((t - m.t0) / (m.t1 - m.t0)) * w
    m.lanes.forEach((lane, i) => {
      const base = 2 + rowH * (i + 1)
      g.globalAlpha = lane.key === T.lane ? 0.9 : 0.65
      for (const s of lane.steps) {
        g.fillStyle = s._ctx >= 80 ? '#f85149' : s._ctx >= 40 ? '#d29922' : '#3fb950'
        const bh = Math.max(1, (barMax * Math.min(100, s._ctx)) / 100)
        g.fillRect(px(s.startedAt), base - bh, Math.max(1, px(s.endedAt || TR.S.now) - px(s.startedAt)), bh)
      }
    })
    g.globalAlpha = 1
    g.fillStyle = css.getPropertyValue('--dim').trim()
    g.font = '9px monospace'
    g.fillText('0', 2, h - 2)
    const total = relLabel(m.t1 - m.t0)
    g.fillText(total, w - g.measureText(total).width - 2, h - 2)
    if (T.zoom) {
      const accent = css.getPropertyValue('--accent').trim()
      g.strokeStyle = accent
      g.lineWidth = 1.5
      const zx = px(T.zoom.t0)
      g.strokeRect(zx, 1, Math.max(2, px(T.zoom.t1) - zx), h - 12)
    }
    if (T.brush) {
      g.fillStyle = 'rgba(88,166,255,0.2)'
      g.fillRect(Math.min(T.brush.a, T.brush.b), 0, Math.abs(T.brush.b - T.brush.a), h)
    }
    canvas._px = px
    canvas._w = w
  }

  // ---------- detail rows ----------

  function rowsFor(m, laneKey, stepId) {
    const lane = laneOf(m, laneKey)
    if (!lane || !lane.steps.length) return { rows: [], turns: [] }
    let steps
    let headText = ''
    let turnsNeeded
    if (laneKey === '') {
      const anchor = stepById(m, stepId) || lane.steps[lane.steps.length - 1]
      steps = lane.steps.filter(s => s.turn === anchor.turn)
      turnsNeeded = [anchor.turn]
    } else {
      steps = lane.steps
      turnsNeeded = [...new Set([lane.agent ? lane.agent.turn : steps[0].turn, ...steps.map(s => s.turn), ...steps.flatMap(s => s._tools.map(t => t.turn))])]
    }
    const sid = TR.S.sel.session
    const detail = n => TR.S.turns[sid + ':' + n]
    const rows = []
    if (laneKey === '') {
      const d = detail(turnsNeeded[0])
      const turn = m.rec.turns.find(t => t.n === turnsNeeded[0])
      headText = d ? d.prompt : turn ? turn.prompt : ''
      rows.push({ kind: 'human', text: headText, label: '#' + turnsNeeded[0] })
    } else {
      const d = lane.agent && detail(lane.agent.turn)
      const task = d && d.agents && d.agents[laneKey]
      rows.push({ kind: 'human', text: task ? task.prompt : (lane.agent && lane.agent.description) || '', label: 'task' })
    }
    for (const s of steps) {
      rows.push({ kind: 'request', step: s })
      const ds = detail(s.turn) && detail(s.turn).steps[s.id]
      if (ds && ds.thinking) rows.push({ kind: 'thinking', step: s, text: ds.thinking })
      if (ds && ds.answer) rows.push({ kind: 'assistant', step: s, text: ds.answer })
      s._tools.forEach((t, i) => {
        const dt = detail(t.turn) && detail(t.turn).tools[t.id]
        rows.push({ kind: 'tool', step: s, tool: t, input: dt ? dt.input : '', result: dt ? dt.result : '', pos: s._tools.length > 1 ? (i === 0 ? '┌' : i === s._tools.length - 1 ? '└' : '│') : '' })
      })
    }
    if (laneKey !== '' && lane.agent) {
      const d = detail(lane.agent.turn)
      const answer = d && d.agents && d.agents[laneKey] && d.agents[laneKey].answer
      if (answer) rows.push({ kind: 'final', text: answer })
    }
    return { rows, turns: turnsNeeded }
  }

  /** A file tool's row shows the file's name; Windows paths split on `\` too. */
  function preview(t) {
    const s = String(t.summary || '')
    const isFile = FILE_TOOLS.has(TR.shortTool(t.name)) || (/^([a-zA-Z]:)?[\\/]/.test(s) && !/\s/.test(s))
    return isFile ? TR.segments(s).pop() || s : s
  }

  function rowHtml(r, i, curStep, shown) {
    const active = i === T.row ? ' active' : ''
    const num = `<span class="num">#${shown}</span>`
    const cut = (s, n) => TR.esc(String(s || '').replace(/\s+/g, ' ').slice(0, n))
    switch (r.kind) {
      case 'human': {
        const note = String(r.text || '').trimStart().startsWith('<task-notification>')
        const summary = note && (String(r.text).match(/<summary>([\s\S]*?)<\/summary>/) || [])[1]
        return note
          ? `<div class="srow${active}" data-row="${i}">${num}<div class="body bubble-h">🔔 <span class="dim">task-notification</span> ${cut(summary || '', 200)}</div></div>`
          : `<div class="srow${active}" data-row="${i}">${num}<div class="body bubble-h">👤 ${cut(r.text, 300) || '<span class="dim">（沒有內容）</span>'}</div></div>`
      }
      case 'request': {
        const s = r.step
        const isCur = s.id === curStep
        const took = s.endedAt ? TR.dur(s.endedAt - s.startedAt) : '進行中'
        return `<div class="divider" style="${isCur ? '' : 'border-top-color:var(--border);color:var(--dim)'}" data-row="${i}"><span>${isCur ? '▸ 本次請求 ' : ''}#${s._n} ${TR.esc(TR.shortModel(s.model))} · ${took}${s.costUsd ? ' · ' + TR.usd(s.costUsd, 4) : ''}${s._hit != null ? ' · hit ' + s._hit + '%' : ''}</span></div>`
      }
      case 'thinking':
        return `<div class="srow${active}" data-row="${i}">${num}<div class="body"><span class="purple">🧠</span> <span style="opacity:.7">${cut(r.text, 80)}</span></div></div>`
      case 'assistant':
      case 'final':
        return `<div class="srow${active}" data-row="${i}">${num}<div class="body bubble-a">🤖 ${r.kind === 'final' ? '<span class="dim">回報：</span>' : ''}${cut(r.text, 200)}</div></div>`
      case 'tool': {
        const t = r.tool
        const st = !t.endedAt ? '⏳' : t.isDenied ? '<span class="yellow">⊘</span>' : t.isError ? '<span class="red">✗</span>' : '<span class="dim">✓</span>'
        return `<div class="srow${active}${t.isError ? ' err' : ''}" data-row="${i}">${num}<div class="body"><span class="bracket">${r.pos}</span> <span class="tool-name">${TR.esc(TR.shortTool(t.name))}</span> <span class="dim" title="${TR.esc(t.summary)}">${cut(preview(t), 90)}</span> ${st}${t.isError && r.result ? `<div class="red" style="font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${cut(r.result, 60)}</div>` : ''}</div></div>`
      }
    }
    return ''
  }

  function outputBlock(text, key, isError) {
    const lines = String(text || '').split('\n')
    const head = `<div class="block-t">OUTPUT ${lines.length} lines</div>`
    const cls = isError ? ' style="color:var(--red)"' : ''
    if (lines.length <= 50 || T.expanded.has(key)) return head + `<pre class="code"${cls}>${TR.esc(text || '（沒有輸出）')}</pre>`
    return head + `<pre class="code"${cls}>${TR.esc(lines.slice(0, 30).join('\n'))}</pre>` +
      `<div class="hidden-lines" data-expand="${TR.esc(key)}">⋯ ${lines.length - 40} lines hidden — 點擊展開</div>` +
      `<pre class="code"${cls}>${TR.esc(lines.slice(-10).join('\n'))}</pre>`
  }

  function parseInput(text) {
    try { return JSON.parse(text) } catch (e) { return null }
  }

  function detailHtml(m, r) {
    if (!r) return '<div class="dim">選一個步驟看內容。</div>'
    switch (r.kind) {
      case 'human':
        return `<div class="detail-title">👤 ${TR.esc(r.label)} <span class="role accent">YOU</span><span class="dim">${(r.text || '').length} 字元</span></div><div class="prose">${TR.esc(r.text)}</div>`
      case 'thinking':
        return `<div class="detail-title"><span class="purple">🧠 Thinking</span><span class="role purple">THINK</span><span class="dim">${r.text.length} 字元</span></div><div class="prose">${TR.esc(r.text)}</div>`
      case 'assistant':
      case 'final':
        return `<div class="detail-title">🤖 ${r.kind === 'final' ? 'Subagent 回報' : '回覆'}<span class="dim">${r.text.length} 字元</span></div><div class="prose">${TR.esc(r.text)}</div>`
      case 'request':
        return requestDetail(r.step)
      case 'tool':
        return toolDetail(r)
    }
    return ''
  }

  function requestDetail(s) {
    const u = s.usage || [0, 0, 0, 0]
    const kv = (k, v) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`
    return `<div class="detail-title">#${s._n} <span class="purple">${TR.esc(s.model || '')}</span>${s.effort ? `<span class="dim">effort ${TR.esc(s.effort)}</span>` : ''}</div>
      <div style="max-width:420px">
      ${kv('開始', new Date(s.startedAt).toLocaleTimeString())}
      ${kv('首個 token（TTFT）', s.firstAt ? TR.dur(s.firstAt - s.startedAt) : '—')}
      ${kv('耗時', s.endedAt ? TR.dur(s.endedAt - s.startedAt) : '進行中')}
      ${kv('訊息數', s.messages)}
      ${kv('stop reason', TR.esc(s.stop || '—'))}
      <div class="block-t">Tokens</div>
      ${kv('input（未快取）', TR.tok(u[0]))}
      ${kv('<span style="color:var(--cache-read)">cache read</span>', TR.tok(u[2]))}
      ${kv('<span style="color:var(--cache-write)">cache write</span>', TR.tok(u[3]))}
      ${kv('output', TR.tok(u[1]))}
      ${kv('cache 命中', s._hit != null ? s._hit + '%' : '—')}
      ${kv('context', s._ctx.toFixed(1) + '%')}
      <div class="block-t">成本</div>
      ${kv('這次請求', s.costUsd != null ? TR.usd(s.costUsd, 4) : '—')}
      </div>
      <details class="sec-block" style="margin-top:12px"><summary><b>Raw</b><span class="dim">tracer 記下的這個請求（不是原始 HTTP 內容：mod 拿不到）</span></summary><pre class="code">${TR.esc(JSON.stringify(rawOf(s), null, 2))}</pre></details>`
  }

  /** The request as recorded: its row, its response's text, its tool calls in and out. */
  function rawOf(s) {
    const d = TR.S.turns[TR.S.sel.session + ':' + s.turn]
    const row = {}
    for (const k of Object.keys(s)) if (!k.startsWith('_')) row[k] = s[k]
    return {
      request: row,
      response: d && d.steps[s.id],
      tools: s._tools.map(t => {
        const io = TR.S.turns[TR.S.sel.session + ':' + t.turn]
        return { ...t, ...(io && io.tools[t.id]) }
      }),
    }
  }

  // ---------- token minimap ----------

  /** Tokens a text costs, roughly: a CJK character about one, other text a quarter. */
  function estTokens(text) {
    const s = String(text || '')
    let wide = 0
    for (const ch of s) if (ch.codePointAt(0) > 0x2e80) wide++
    return Math.ceil(wide + (s.length - wide) / 4)
  }

  /**
   * A strip as tall as the request filled its window: the cache split on top,
   * then what came before this turn, then each step of the turn up to it.
   * The step blocks are estimated from their text; the total is the API's.
   */
  function minimapHtml(m, rows) {
    const requests = rows.filter(r => r.kind === 'request')
    const anchor = (T.step && requests.find(r => r.step.id === T.step)) || requests[requests.length - 1]
    if (!anchor) return ''
    const s = anchor.step
    const u = s.usage || [0, 0, 0, 0]
    const used = s._prompt + u[1]
    if (!used) return ''
    let last = rows.length - 1
    while (last > 0 && rows[last].step !== s) last--
    const blocks = []
    rows.slice(0, last + 1).forEach((r, i) => {
      if (r.kind === 'request') return
      const tok = r.kind === 'tool' ? estTokens(r.input) + estTokens(r.result) : estTokens(r.text)
      if (tok > 0) blocks.push({ i, r, tok })
    })
    const known = blocks.reduce((a, b) => a + b.tok, 0)
    const earlier = Math.max(0, used - known)
    const scale = Math.max(1, earlier + known)
    const color = r =>
      r.kind === 'human' ? 'var(--accent)' : r.kind === 'thinking' ? 'var(--input)' : r.kind === 'tool' ? 'var(--cache-read)' : 'var(--green)'
    const pct = Math.min(100, (used / m.window) * 100)
    const cache = s._prompt
      ? [[u[2], 'var(--cache-read)'], [u[3], 'var(--cache-write)'], [u[0], 'var(--input)']].map(([n, c]) => `<div style="width:${(n / s._prompt) * 100}%;background:${c}"></div>`).join('')
      : ''
    const block = (h, bg, label, extra) =>
      `<div class="mm-block" style="height:${h}%;background:${bg}"${extra}>${label}</div>`
    return `<div class="mm-cache" title="cache read / write / input">${cache}</div>
      <div class="mm-area">
        <div class="mm-strip" style="height:${Math.max(pct, 2)}%">
          ${earlier ? block((earlier / scale) * 100, '#3d5a8a', earlier / scale > 0.08 ? TR.tok(earlier) : '', ` title="system prompt、工具定義與先前的對話（約 ${TR.tok(earlier)}）"`) : ''}
          ${blocks.map(b => block((b.tok / scale) * 100, color(b.r), '', ` data-mm="${b.i}" title="#${b.i} 約 ${TR.tok(b.tok)} tokens"${b.r.tool && b.r.tool.isError ? ' data-err="1"' : ''}`)).join('')}
        </div>
        <div class="mm-line" style="top:40%;border-color:var(--green)"></div>
        <div class="mm-line" style="top:80%;border-color:var(--red)"></div>
      </div>
      <div class="mm-foot">${pct.toFixed(0)}% · ${TR.tok(m.window)}</div>`
  }

  function toolDetail(r) {
    const t = r.tool
    const input = parseInput(r.input) || {}
    const st = !t.endedAt ? '⏳ 執行中' : t.isDenied ? '<span class="yellow">⊘ 被拒絕</span>' : t.isError ? '<span class="red">✗ ERROR</span>' : '<span class="green">✓</span>'
    let meta = ''
    let body = ''
    const tag = s => `<span class="tag dim">${TR.esc(s)}</span>`
    const name = TR.shortTool(t.name)
    if (name === 'Bash' || name === 'PowerShell') {
      meta = `<span class="dim">$</span> ${TR.esc(String(input.command || '').split('\n')[0])} ${input.description ? `<span class="dim">${TR.esc(input.description)}</span>` : ''}`
      body = `<div class="block-t">COMMAND</div><pre class="code">${TR.esc(input.command || r.input)}</pre>`
    } else if (name === 'Edit' && (input.old_string != null || input.new_string != null)) {
      meta = `${TR.esc(input.file_path || '')} ${input.replace_all ? tag('replace_all') : ''}`
      const old = String(input.old_string || '').split('\n').map(l => `<span class="del">- ${TR.esc(l)}</span>`).join('')
      const neu = String(input.new_string || '').split('\n').map(l => `<span class="add">+ ${TR.esc(l)}</span>`).join('')
      body = `<div class="block-t">OLD / NEW</div><pre class="code">${old}${neu}</pre>`
    } else {
      if (name === 'Read') meta = `${TR.esc(input.file_path || '')} ${input.offset ? tag('L' + input.offset + (input.limit ? '-' + (input.offset + input.limit) : '')) : ''}`
      else if (name === 'Grep') meta = `/${TR.esc(input.pattern || '')}/ ${input.glob ? tag(input.glob) : ''} ${input.path ? '<span class="dim">in ' + TR.esc(String(input.path).split(/[\\/]/).slice(-2).join('/')) + '</span>' : ''}`
      else if (name === 'Agent' || name === 'Task') meta = `${TR.esc(input.description || '')} ${input.subagent_type ? tag(input.subagent_type) : ''}`
      else if (name === 'WebFetch') meta = TR.esc(String(input.url || '').replace(/^https?:\/\//, '').slice(0, 60))
      else meta = TR.esc(t.summary)
      body = `<div class="block-t">INPUT JSON</div><pre class="code">${TR.esc(r.input || '{}')}</pre>`
    }
    const took = t.endedAt ? TR.dur(t.endedAt - t.startedAt) : ''
    return `<div class="detail-title"><span class="tool-name">${TR.esc(t.name)}</span> ${st} <span class="dim">${took}</span><span class="role green">CALL</span><button class="icon-btn copy" data-copy="1">Copy</button></div>
      <div style="margin-bottom:6px">${meta}</div>${body}${outputBlock(r.result, t.id, t.isError)}`
  }

  // ---------- cards ----------

  function laneStats(lane) {
    const st = { req: lane.steps.length, cost: 0, inp: 0, out: 0, read: 0, write: 0, peak: 0, misses: 0, active: 0, tools: {}, toolN: 0, toolErr: 0 }
    for (const s of lane.steps) {
      const u = s.usage || [0, 0, 0, 0]
      st.cost += s.costUsd || 0
      st.inp += s._prompt
      st.out += u[1]
      st.read += u[2]
      st.write += u[3]
      st.peak = Math.max(st.peak, s._ctx)
      if (s._events.includes('miss')) st.misses++
      if (s.endedAt) st.active += s.endedAt - s.startedAt
      for (const t of s._tools) {
        const n = TR.shortTool(t.name)
        st.tools[n] = (st.tools[n] || 0) + 1
        st.toolN++
        if (t.isError) st.toolErr++
      }
    }
    return st
  }

  function cardHtml(m) {
    const kv = (k, v, cls) => `<div class="kv"><span>${k}</span><span${cls ? ` class="${cls}"` : ''}>${v}</span></div>`
    const sec = (t, body) => `<div class="sec"><div class="sec-t">${t}</div>${body}</div>`
    const svgGlyph = lane => `<svg width="10" height="10">${glyph(lane.glyph, 5, 5, 4, lane.color)}</svg>`
    const step = T.step && stepById(m, T.step)
    if (step) {
      const lane = step._lane
      const u = step.usage || [0, 0, 0, 0]
      const topTools = Object.entries(step._tools.reduce((a, t) => ((a[TR.shortTool(t.name)] = (a[TR.shortTool(t.name)] || 0) + 1), a), {}))
      return `<span class="back" data-back="1">← back</span>
        <h3>#${step._n} <span style="color:${lane.color}">${TR.esc(TR.shortModel(step.model))}</span> <span class="dim">· ${step.endedAt ? TR.dur(step.endedAt - step.startedAt) : '進行中'}</span><span class="spacer"></span>${TR.starBadge('r:' + TR.S.sel.session + '|' + step.id)}</h3>
        <div class="sub">${TR.esc(lane.name)} › #${step._n}</div>
        ${sec('Context', `${kv('使用率', step._ctx.toFixed(1) + '%')}<div class="minibar"><div style="width:${Math.min(100, step._ctx)}%;background:${TR.zoneColor(step._ctx)}"></div></div>`)}
        ${sec('Cache', kv('命中', step._hit != null ? step._hit + '%' : '—', step._hit != null && step._hit < 50 ? 'red' : '') + kv('新寫入', TR.tok(u[3])))}
        ${sec('Cost', kv('這次請求', step.costUsd != null ? TR.usd(step.costUsd, 4) : '—', 'yellow') + kv('Stop', TR.esc(step.stop || '—')))}
        ${sec('Tokens', kv('In', TR.tok(step._prompt)) + kv('Out', TR.tok(u[1])) + kv('TTFT', step.firstAt ? TR.dur(step.firstAt - step.startedAt) : '—'))}
        ${topTools.length ? sec('Tools', topTools.map(([n, c]) => kv(TR.esc(n), '×' + c)).join('') + (step._errors ? kv('Has failures', step._errors, 'red') : '')) : ''}`
    }
    const lane = T.lane != null ? laneOf(m, T.lane) : laneOf(m, '')
    if (!lane) return '<div class="dim">還沒有請求。</div>'
    const st = laneStats(lane)
    const first = lane.steps[0]
    const last = lane.steps[lane.steps.length - 1]
    const span = first ? (last.endedAt || TR.S.now) - first.startedAt : 0
    const hitRate = st.inp ? Math.round((st.read / st.inp) * 100) : null
    const tools = Object.entries(st.tools).sort((a, b) => b[1] - a[1]).slice(0, 6)
    const a = lane.agent
    const result = a ? (a.endedAt ? (a.reason === 'answer' ? '<span class="green">✓ 完成</span>' : `<span class="red">✗ ${TR.esc(a.reason || '')}</span>`) : '<span class="yellow">● 執行中</span>') : ''
    return `<h3>${svgGlyph(lane)} ${TR.esc(lane.name)} <span class="pill" style="background:${lane.color}22;color:${lane.color}">${TR.esc(TR.shortModel(last && last.model))}</span></h3>
      <div class="sub">${st.req} requests · ${TR.dur(span)} · ${lane.key === '' ? 'orchestrator' : 'subagent'}${a && a.isBackground ? ' · 背景' : ''}</div>
      ${a ? `<div style="margin-bottom:6px">${result}<div class="dim" style="margin-top:3px">${TR.esc(a.description)}</div></div>` : ''}
      ${sec('Context', kv('Peak', st.peak.toFixed(1) + '%') + kv('Window', TR.tok(m.window)))}
      ${sec('Cache', kv('Hit rate', hitRate != null ? hitRate + '%' : '—', hitRate != null ? (hitRate >= 80 ? 'green' : hitRate >= 50 ? 'yellow' : 'red') : '') + kv('Breaks', st.misses, st.misses ? 'yellow' : ''))}
      ${sec('Cost', kv('Total', TR.usd(st.cost, 4), 'yellow'))}
      ${sec('Tokens', kv('Input', TR.tok(st.inp)) + kv('Output', TR.tok(st.out)) + kv('I/O ratio', st.out ? (st.inp / st.out).toFixed(1) + ':1' : '—'))}
      ${sec('Tools', tools.map(([n, c]) => kv(TR.esc(n), '×' + c)).join('') + kv('失敗率', st.toolN ? Math.round((st.toolErr / st.toolN) * 100) + '%' : '—', st.toolErr ? 'red' : ''))}
      ${sec('Time', kv('Started', first ? TR.clock(first.startedAt) : '—') + kv('Duration', TR.dur(span)) + kv('Active', TR.dur(st.active)))}
      ${lane.key === '' ? composition(m) : ''}`
  }

  /** What fills the window, as /context last measured it for the main conversation. */
  function composition(m) {
    const meter = m.rec.meter || {}
    const rows = (meter.breakdown || []).filter(c => c.tokens > 0 && c.kind !== 'deferred')
    if (!rows.length) return ''
    const total = rows.reduce((a, c) => a + c.tokens, 0)
    const color = c => (c.kind === 'free' ? 'var(--surface-hover)' : c.kind === 'buffer' ? 'var(--dim)' : null)
    const palette = ['#1f6feb', '#2ea043', '#3fb950', '#e3b341', '#bc8cff', '#f0883e', '#39c5cf', '#d2a8ff']
    const bar = rows.map((c, i) => `<div style="width:${(c.tokens / total) * 100}%;background:${color(c) || palette[i % palette.length]}" title="${TR.esc(c.name)} ${TR.tok(c.tokens)}"></div>`).join('')
    const files = (meter.memoryFiles || []).map(f => `<div class="kv"><span title="${TR.esc(f.path)}">${TR.esc(TR.segments(f.path).slice(-2).join('/'))}</span><span>${TR.tok(f.tokens)}</span></div>`).join('')
    return `<div class="sec"><div class="sec-t">Context 組成 <span class="dim" style="text-transform:none">（/context 估算）</span></div>
      <div class="stack" style="height:8px;width:100%">${bar}</div>
      ${rows.map((c, i) => `<div class="kv"><span><span class="swatch" style="background:${color(c) || palette[i % palette.length]}"></span> ${TR.esc(c.name)}</span><span>${TR.tok(c.tokens)}</span></div>`).join('')}
      ${files ? `<div class="sec-t" style="margin-top:6px">記憶檔</div>${files}` : ''}</div>`
  }

  // ---------- render ----------

  let lastWidth = 0

  function render(col) {
    const m = model()
    if (!TR.S.sel.session) {
      col.innerHTML = '<div class="tl-empty">選一個 session 看它的時間軸。</div>'
      return
    }
    if (!m) {
      col.innerHTML = '<div class="tl-empty">載入中…</div>'
      return
    }
    // Follow the newest main request while the person sits on it.
    const main = laneOf(m, '')
    const newest = main && main.steps[main.steps.length - 1]
    if (newest && main.steps.length !== T.seenMain) {
      if (T.follow && T.step) T.step = newest.id
      T.seenMain = main.steps.length
    }

    const keepScroll = {}
    for (const sel of ['.tl-lanes', '.step-list', '.step-detail']) {
      const el = col.querySelector(sel)
      if (el) keepScroll[sel] = el.scrollTop
    }
    const width = Math.max(500, col.clientWidth)
    lastWidth = width
    const v = view(m)
    const x = t => GUTTER + ((t - v.t0) / (v.t1 - v.t0)) * (width - GUTTER - 8)

    const mainLane = m.lanes[0]
    const mainH = laneHeight(mainLane)
    let head = `<svg width="${width}" height="${AXIS + mainH}" id="tl-head">${axisSvg(m, width, x)}${laneSvg(m, mainLane, AXIS, width, x)}</svg>`
    let top = 0
    let rest = ''
    for (const lane of m.lanes.slice(1)) {
      rest += laneSvg(m, lane, top, width, x)
      top += laneHeight(lane)
    }
    const restSvg = m.lanes.length > 1 ? `<svg width="${width}" height="${top}" id="tl-rest">${rest}</svg>` : ''

    const { rows, turns } = T.lane != null || T.step ? rowsFor(m, T.step ? stepById(m, T.step)?._lane.key ?? '' : T.lane, T.step) : rowsFor(m, '', null)
    ensureTurns(turns)
    // A row the person picked stays picked; otherwise the default follows the
    // rows as they load: the request's first row, or the conversation's last.
    if (T.row == null || T.row >= rows.length) T.rowAuto = true
    if (T.rowAuto) {
      const firstOfStep = T.step ? rows.findIndex(r => r.step && r.step.id === T.step) : -1
      T.row = firstOfStep >= 0 ? firstOfStep : rows.length ? rows.length - 1 : null
    }

    // New main requests that arrived since the person picked one to look at.
    const pending = T.step && !T.follow && T.mainAtPick != null ? main.steps.length - T.mainAtPick : 0
    col.innerHTML = `
      <div class="tl-overview">
        <div class="tl-label">
          <div class="btns">
            <button class="sq" data-act="sidebar" title="收合左側欄 (\\)">${document.body.classList.contains('collapsed') ? '|▷' : '◁|'}</button>
            <span>OVERVIEW</span>
            <button class="sq" data-act="in" title="放大">+</button>
            <button class="sq" data-act="out" title="縮小">−</button>
            <button class="sq" data-act="reset" title="重設縮放 (0)">⟲</button>
            <button class="sq${T.birdseye ? ' on' : ''}" data-act="bird" title="鳥瞰 (b)">${T.birdseye ? '⤡' : '⤢'}</button>
          </div>
          <div class="btns">${m.lanes.length} lanes · ${m.all.length} requests${pending > 0 ? ` <button class="upill" data-act="newest" style="padding:0 6px">+${pending} main</button>` : ''}</div>
        </div>
        <canvas id="minimap"></canvas>
      </div>
      <div class="tl-lanes" style="height:${T.birdseye ? 0 : T.lanesH}px">${head.replace('<svg', '<svg style="position:sticky;top:0;z-index:1;background:var(--bg)"')}${restSvg}</div>
      <div class="tl-resize" data-act="resize"></div>
      <div class="tl-detail">
        <div class="card-panel">${cardHtml(m)}</div>
        <div class="steps-panel">
          <div class="minimap-col">${minimapHtml(m, rows)}</div>
          <div class="step-list"><div class="step-head">Timeline · ${rows.filter(r => r.kind === 'request').length} requests${rows.some(r => r.tool && r.tool.isError) ? ` · <span class="red">${rows.filter(r => r.tool && r.tool.isError).length}✗</span>` : ''}</div>${(() => { let shown = 0; return rows.map((r, i) => rowHtml(r, i, T.step, r.kind === 'request' ? 0 : shown++)).join('') })()}</div>
          <div class="step-detail">${detailHtml(m, rows[T.row])}</div>
        </div>
      </div>`
    if (T.birdseye) col.querySelector('.tl-lanes').style.display = 'none'
    for (const sel in keepScroll) {
      const el = col.querySelector(sel)
      if (el) el.scrollTop = keepScroll[sel]
    }
    drawMinimap(m)
    wire(col, m, rows, x, width)
  }

  const loading = new Set()
  function ensureTurns(turns) {
    const sid = TR.S.sel.session
    for (const n of turns) {
      const key = sid + ':' + n
      if (TR.S.turns[key] || loading.has(key)) continue
      loading.add(key)
      TR.loadTurn(sid, n).then(() => { loading.delete(key); if (TR.S.turns[key]) TR.render() })
    }
  }

  async function poll() {
    const m = model()
    if (!m) return
    const sid = TR.S.sel.session
    const open = new Set(m.rec.turns.filter(t => !t.endedAt).map(t => t.n))
    const lane = T.step ? stepById(m, T.step)?._lane.key : T.lane
    const { turns } = rowsFor(m, lane == null ? '' : lane, T.step)
    for (const n of turns) {
      if (open.has(n) || m.all.some(s => s.turn === n && !s.endedAt)) await TR.loadTurn(sid, n)
    }
  }

  function scrollRow(col) {
    const el = col.querySelector('.srow.active, .divider[data-row="' + T.row + '"]')
    if (el) el.scrollIntoView({ block: 'nearest' })
  }

  function tip(html, ev) {
    const el = document.getElementById('tip')
    if (!html) { el.style.display = 'none'; return }
    el.innerHTML = html
    el.style.display = 'block'
    const x = Math.min(ev.clientX + 14, window.innerWidth - el.offsetWidth - 8)
    const y = Math.min(ev.clientY + 14, window.innerHeight - el.offsetHeight - 8)
    el.style.left = x + 'px'
    el.style.top = y + 'px'
  }

  function stepTip(s) {
    const u = s.usage || [0, 0, 0, 0]
    const zone = s._ctx >= 80 ? 'danger' : s._ctx >= 40 ? 'warn' : 'safe'
    const tools = Object.entries(s._tools.reduce((a, t) => ((a[TR.shortTool(t.name)] = (a[TR.shortTool(t.name)] || 0) + 1), a), {})).map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join(', ')
    const kv = (k, v) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`
    return `<div style="margin-bottom:3px"><b>#${s._n}</b> | ${TR.esc(TR.shortModel(s.model))} <span class="dim">${TR.esc(s._lane.name)}</span></div>` +
      kv('Context', `<span style="color:${TR.zoneColor(s._ctx)}">${s._ctx.toFixed(1)}% (${zone})</span>`) +
      kv('Cache', `${TR.tok(u[2])} read / ${TR.tok(u[3])} write`) +
      kv('Cost', (s.costUsd != null ? TR.usd(s.costUsd, 4) : '—') + (s._lane.median && s.costUsd > 3 * s._lane.median ? ' <span class="orange">⚡outlier</span>' : '')) +
      kv('Duration', s.endedAt ? TR.dur(s.endedAt - s.startedAt) : '進行中') +
      kv('Tokens', `${TR.tok(s._prompt)} in / ${TR.tok(u[1])} out`) +
      (tools ? kv('Tools', TR.esc(tools)) : '') +
      (s._events.length ? kv('Events', s._events.map(e => `<span style="color:${EVENTS[e].color}">${EVENTS[e].label}</span>`).join(', ')) : '')
  }

  function selectStep(id, m) {
    const s = stepById(m, id)
    if (!s) return
    if (T.step === id) {
      T.step = null
      T.row = null
    } else {
      T.step = id
      T.lane = s._lane.key
      T.row = null
      const main = laneOf(m, '')
      T.follow = s._lane.key === '' && main.steps[main.steps.length - 1].id === id
      T.mainAtPick = main.steps.length
    }
    TR.focus = 2
    TR.render()
    requestAnimationFrame(() => scrollRow(document.getElementById('col-timeline')))
  }

  function zoomBy(m, factor, center) {
    const v = view(m)
    const c = center == null ? (v.t0 + v.t1) / 2 : center
    let span = Math.max(2000, (v.t1 - v.t0) * factor)
    if (span >= m.t1 - m.t0) { T.zoom = null; return }
    let t0 = c - (c - v.t0) * (span / (v.t1 - v.t0))
    t0 = Math.max(m.t0, Math.min(m.t1 - span, t0))
    T.zoom = { t0, t1: t0 + span }
  }

  function wire(col, m, rows, x, width) {
    const toTime = px => {
      const v = view(m)
      return v.t0 + ((px - GUTTER) / (width - GUTTER - 8)) * (v.t1 - v.t0)
    }
    col.querySelectorAll('[data-act]').forEach(b => {
      const act = b.dataset.act
      if (act === 'resize') {
        b.onmousedown = ev => {
          const y0 = ev.clientY
          const h0 = T.lanesH
          const onMove = e => {
            T.lanesH = Math.max(60, Math.min(window.innerHeight * 0.7, h0 + e.clientY - y0))
            col.querySelector('.tl-lanes').style.height = T.lanesH + 'px'
          }
          const onUp = () => {
            document.removeEventListener('mousemove', onMove)
            document.removeEventListener('mouseup', onUp)
            TR.write('tracer-lanes-h', String(Math.round(T.lanesH)))
          }
          document.addEventListener('mousemove', onMove)
          document.addEventListener('mouseup', onUp)
        }
        return
      }
      b.onclick = () => {
        if (act === 'sidebar') document.dispatchEvent(new KeyboardEvent('keydown', { key: '\\' }))
        else if (act === 'in') zoomBy(m, 0.7)
        else if (act === 'out') zoomBy(m, 1.3)
        else if (act === 'reset') T.zoom = null
        else if (act === 'bird') T.birdseye = !T.birdseye
        else if (act === 'newest') {
          const main = laneOf(m, '')
          T.step = main.steps[main.steps.length - 1].id
          T.lane = ''
          T.row = null
          T.follow = true
        }
        TR.render()
      }
    })

    const lanes = col.querySelector('.tl-lanes')
    let drag = null
    lanes.onmousedown = ev => {
      if (ev.button !== 0) return
      drag = { x: ev.clientX, t: Date.now(), zoom: T.zoom && { ...T.zoom }, moved: false }
    }
    lanes.onmousemove = ev => {
      if (drag && T.zoom && Math.abs(ev.clientX - drag.x) > 5 && Date.now() - drag.t > 200) {
        drag.moved = true
        const v = drag.zoom
        const dt = ((drag.x - ev.clientX) / (width - GUTTER - 8)) * (v.t1 - v.t0)
        const t0 = Math.max(m.t0, Math.min(m.t1 - (v.t1 - v.t0), v.t0 + dt))
        T.zoom = { t0, t1: t0 + (v.t1 - v.t0) }
        TR.render()
        return
      }
      const target = ev.target.closest('[data-step]')
      tip(target ? stepTip(stepById(m, target.dataset.step)) : null, ev)
    }
    lanes.onmouseleave = () => tip(null)
    lanes.onmouseup = ev => {
      const wasDrag = drag && drag.moved
      drag = null
      if (wasDrag) return
      if (ev.target.closest('[data-reset]')) { T.zoom = null; TR.render(); return }
      const stepEl = ev.target.closest('[data-step]')
      if (stepEl) { tip(null); selectStep(stepEl.dataset.step, m); return }
      const laneEl = ev.target.closest('[data-lane]')
      if (laneEl) {
        const rect = laneEl.ownerSVGElement ? laneEl.ownerSVGElement.getBoundingClientRect() : lanes.getBoundingClientRect()
        const inGutter = ev.clientX - rect.left < GUTTER
        if (inGutter || T.step == null) {
          T.lane = T.lane === laneEl.dataset.lane && inGutter ? null : laneEl.dataset.lane
          T.step = null
          T.row = null
          TR.focus = 2
          TR.render()
        }
      }
    }
    lanes.ondblclick = () => { T.zoom = null; TR.render() }
    lanes.onwheel = ev => {
      const rect = lanes.getBoundingClientRect()
      if (ev.ctrlKey || ev.metaKey) {
        ev.preventDefault()
        zoomBy(m, ev.deltaY < 0 ? 0.7 : 1.3, toTime(ev.clientX - rect.left))
        TR.render()
      } else if (T.zoom && (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) || ev.shiftKey)) {
        ev.preventDefault()
        const d = ev.deltaX || ev.deltaY
        const span = T.zoom.t1 - T.zoom.t0
        const t0 = Math.max(m.t0, Math.min(m.t1 - span, T.zoom.t0 + (d / (width - GUTTER)) * span))
        T.zoom = { t0, t1: t0 + span }
        TR.render()
      }
    }

    const canvas = col.querySelector('#minimap')
    canvas.onmousedown = ev => {
      const r = canvas.getBoundingClientRect()
      T.brush = { a: ev.clientX - r.left, b: ev.clientX - r.left }
      const onMove = e => { T.brush.b = Math.max(0, Math.min(canvas._w, e.clientX - r.left)); drawMinimap(m) }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        const a = Math.min(T.brush.a, T.brush.b)
        const b = Math.max(T.brush.a, T.brush.b)
        T.brush = null
        const toT = px => m.t0 + (px / canvas._w) * (m.t1 - m.t0)
        if (b - a > 3 && toT(b) - toT(a) >= 2000) {
          T.zoom = { t0: toT(a), t1: toT(b) }
        } else {
          const t = toT(a)
          const near = m.all.reduce((best, s) => (Math.abs(s.startedAt - t) < Math.abs((best ? best.startedAt : Infinity) - t) ? s : best), null)
          if (near && Math.abs(near.startedAt - t) <= (m.t1 - m.t0) * 0.02) { selectStep(near.id, m); return }
        }
        TR.render()
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }

    const card = col.querySelector('.card-panel')
    const back = card.querySelector('[data-back]')
    if (back) back.onclick = () => { T.step = null; T.row = null; TR.render() }

    col.querySelectorAll('[data-row]').forEach(el => (el.onclick = () => { T.row = +el.dataset.row; T.rowAuto = false; TR.focus = 2; TR.render() }))
    col.querySelectorAll('[data-mm]').forEach(el => {
      const row = col.querySelector(`.srow[data-row="${el.dataset.mm}"]`)
      el.onmouseenter = () => row && row.classList.add('hl')
      el.onmouseleave = () => row && row.classList.remove('hl')
      el.onclick = () => { T.row = +el.dataset.mm; T.rowAuto = false; TR.render(); requestAnimationFrame(() => scrollRow(col)) }
    })
    TR.wireStars(col.querySelector('.card-panel'))
    const detail = col.querySelector('.step-detail')
    detail.querySelectorAll('[data-expand]').forEach(el => (el.onclick = () => { T.expanded.add(el.dataset.expand); TR.render() }))
    const copy = detail.querySelector('[data-copy]')
    if (copy) copy.onclick = async () => {
      const r = rows[T.row]
      try {
        await navigator.clipboard.writeText(`${r.input || ''}\n\n${r.result || ''}`)
        copy.textContent = '✓'
      } catch (e) {
        TR.toast('沒辦法寫入剪貼簿')
      }
    }
  }

  // ---------- keys, crumbs, hash ----------

  function jump(m, test, dir) {
    const list = m.all.filter(test).sort((a, b) => a.startedAt - b.startedAt)
    if (!list.length) { TR.toast('沒有符合的請求'); return }
    const cur = T.step ? stepById(m, T.step) : null
    const at = cur ? cur.startedAt : dir > 0 ? -Infinity : Infinity
    const next = dir > 0 ? list.find(s => s.startedAt > at) : [...list].reverse().find(s => s.startedAt < at)
    if (!next) { TR.toast(dir > 0 ? '已經是最後一個' : '已經是第一個'); return }
    T.step = null
    selectStep(next.id, m)
  }
  const hasTool = test => s => s._tools.some(t => test(t.name))

  function key(ev) {
    const m = model()
    if (!m) return false
    const k = ev.key
    const lanes = m.lanes.map(l => l.key)
    if (k === 'Tab') {
      const i = lanes.indexOf(T.lane)
      T.lane = lanes[(i + (ev.shiftKey ? -1 : 1) + lanes.length) % lanes.length]
      T.step = null
      T.row = null
      TR.render()
      return true
    }
    if (k === 'j' || k === 'k') {
      const lane = laneOf(m, T.lane == null ? '' : T.lane)
      if (!lane || !lane.steps.length) return true
      const i = lane.steps.findIndex(s => s.id === T.step)
      let next
      if (i < 0) next = k === 'j' ? lane.steps[0] : lane.steps[lane.steps.length - 1]
      else next = lane.steps[Math.max(0, Math.min(lane.steps.length - 1, i + (k === 'j' ? 1 : -1)))]
      if (next.id !== T.step) { T.step = null; selectStep(next.id, m) }
      return true
    }
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      const col = document.getElementById('col-timeline')
      const n = col.querySelectorAll('[data-row]').length
      T.row = Math.max(0, Math.min(n - 1, (T.row == null ? -1 : T.row) + (k === 'ArrowDown' ? 1 : -1)))
      T.rowAuto = false
      TR.render()
      requestAnimationFrame(() => scrollRow(col))
      return true
    }
    const jumps = {
      e: s => s._errors > 0 || s._events.includes('stop'),
      a: hasTool(n => n === 'Agent' || n === 'Task'),
      s: hasTool(n => n === 'Skill'),
      m: hasTool(n => n.startsWith('mcp__')),
    }
    if (jumps[k.toLowerCase()] && k.length === 1) {
      jump(m, jumps[k.toLowerCase()], k === k.toLowerCase() ? 1 : -1)
      return true
    }
    if (k === 'b') { T.birdseye = !T.birdseye; TR.render(); return true }
    if (k === '0') { T.zoom = null; TR.render(); return true }
    if (k === '+' || k === '=') { zoomBy(m, 0.7); TR.render(); return true }
    if (k === '-') { zoomBy(m, 1.3); TR.render(); return true }
    if (k === 'Escape' || k === 'ArrowLeft') {
      if (T.birdseye) T.birdseye = false
      else if (T.step) { T.step = null; T.row = null }
      else if (T.lane != null) T.lane = null
      else if (T.zoom) T.zoom = null
      else return false
      TR.render()
      return true
    }
    return false
  }

  function hints() {
    const m = model()
    const has = test => !!(m && m.all.some(test))
    return [
      ['Tab', 'lane', !!(m && m.lanes.length > 1)],
      ['j/k', 'request', !!(m && m.all.length)],
      ['↑↓', 'steps', true],
      ['e/E', 'error', has(s => s._errors > 0)],
      ['a/A', 'agent', has(hasTool(n => n === 'Agent' || n === 'Task'))],
      ['s/S', 'skill', has(hasTool(n => n === 'Skill'))],
      ['m/M', 'mcp', has(hasTool(n => n.startsWith('mcp__')))],
      ['f', T.step && TR.isStarred('r:' + TR.S.sel.session + '|' + T.step) ? '☆ unstar' : '★ star', true],
      ['n/N', 'star', TR.starOrder().length > 0],
      ['b', 'birdseye', true],
      ['Esc', 'back', true],
      ['\\', 'sidebar', true],
      ['?', 'help', true],
    ]
  }

  function crumbs() {
    const m = model()
    if (!m) return []
    const out = ['timeline', () => { T.lane = null; T.step = null; T.row = null; TR.render() }]
    const list = [out]
    const laneKey = T.step ? stepById(m, T.step)?._lane.key : T.lane
    const lane = laneKey != null ? laneOf(m, laneKey) : null
    if (lane) list.push([lane.name, () => { T.step = null; T.row = null; T.lane = lane.key; TR.render() }])
    const s = T.step && stepById(m, T.step)
    if (s) list.push(['#' + s._n, () => { T.row = null; TR.render() }])
    return list
  }

  function toHash(q) {
    if (T.lane != null) q.set('lane', T.lane || 'main')
    if (T.step) q.set('r', T.step)
  }
  function fromHash(q) {
    const lane = q.get('lane')
    if (lane) T.lane = lane === 'main' ? '' : lane
    if (q.get('r')) {
      T.step = q.get('r')
      T.follow = false
    }
  }
  function reset() {
    T.lane = null
    T.step = null
    T.row = null
    T.zoom = null
    T.seenMain = 0
    T.follow = true
    T.expanded.clear()
  }

  window.addEventListener('resize', () => {
    const col = document.getElementById('col-timeline')
    if (col && col.clientWidth !== lastWidth) TR.render()
  })

  function selectedStep() {
    return T.step
  }
  function selectStepById(id) {
    const m = model()
    if (!m || !stepById(m, id)) { TR.toast('這個請求的資料還沒載入'); return }
    T.step = null
    selectStep(id, m)
  }

  return { render, poll, key, hints, crumbs, toHash, fromHash, reset, model, selectedStep, selectStepById }
})()
