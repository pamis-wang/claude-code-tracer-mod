'use strict'

// tracer dashboard: the Usage page (quota, cost by month and by day, tokens,
// projects) and the System Prompt page (versions per session, the sections,
// and a diff of what changed).

window.XR_PAGES = (() => {
  const PALETTE = ['#58a6ff', '#3fb950', '#d29922', '#bc8cff', '#f0883e', '#39c5cf', '#f85149', '#8b949e']
  const DAY = 86_400_000
  const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

  const U = { project: null, year: new Date().getFullYear() }
  const P = { session: null, version: null, mode: 'content', hunk: 0, hideMinor: false }

  // ---------- usage ----------

  function dayKey(ts) {
    const d = new Date(ts)
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  }

  function aggregate() {
    const sessions = TR.entries()
    const projects = TR.projects()
    const color = new Map()
    projects.slice().sort((a, b) => b.cost - a.cost).forEach((p, i) => color.set(p.key, PALETTE[Math.min(i, PALETTE.length - 1)]))
    const nameOf = new Map(projects.map(p => [p.key, p.name]))
    const days = new Map()
    const months = new Map()
    for (const e of sessions) {
      const key = TR.projectOf(e)
      if (U.project && U.project !== key) continue
      for (const [hour, cost, inp, out, cr, cw] of e.hourly || []) {
        const dk = dayKey(hour)
        const d = days.get(dk) || { cost: 0, by: new Map(), inp: 0, out: 0, cr: 0, cw: 0 }
        d.cost += cost
        d.by.set(key, (d.by.get(key) || 0) + cost)
        d.inp += inp
        d.out += out
        d.cr += cr
        d.cw += cw
        days.set(dk, d)
        const date = new Date(hour)
        const mk = date.getFullYear() + '-' + (date.getMonth() + 1)
        const m = months.get(mk) || { cost: 0, by: new Map() }
        m.cost += cost
        m.by.set(key, (m.by.get(key) || 0) + cost)
        months.set(mk, m)
      }
    }
    return { projects, color, nameOf, days, months }
  }

  function stack(by, total, max, color, tall) {
    if (!total) return `<div class="stack${tall ? ' tall' : ''}"></div>`
    const parts = [...by.entries()].sort((a, b) => b[1] - a[1])
    return `<div class="stack${tall ? ' tall' : ''}" style="width:${Math.max(1, (total / max) * 100)}%">${parts
      .map(([k, v]) => `<div style="width:${(v / total) * 100}%;background:${color.get(k) || '#8b949e'}" title="${TR.esc(k)} ${TR.usd(v)}"></div>`)
      .join('')}</div>`
  }

  function usage() {
    const box = document.getElementById('page-usage')
    const limits = TR.S.index && TR.S.index.limits
    const a = aggregate()
    const now = TR.S.now
    const isLive = limits && now - limits.at < 10 * 60_000

    const windowCard = r => {
      const left = Math.max(0, 100 - r.percentUsed)
      const color = left > 30 ? 'var(--green)' : left > 10 ? 'var(--yellow)' : 'var(--red)'
      const reset = r.resetsAt ? Date.parse(r.resetsAt) - now : NaN
      const label = r.kind === 'five_hour' ? '5-Hour' : r.kind === 'seven_day' ? 'Weekly' : r.kind
      return `<div class="win"><div class="card-t" style="margin:0">${label}</div>
        <div class="big">${left.toFixed(0)}% left</div>
        <div class="wbar"><div style="width:${left}%;background:${color}"></div></div>
        <div class="dim" style="font-size:11px">已用 ${(+r.percentUsed).toFixed(1)}%${reset > 0 ? ` · ${TR.dur(reset)} 後重置` : ''}</div></div>`
    }

    const today = a.days.get(dayKey(now))
    const month = a.months.get(new Date(now).getFullYear() + '-' + (new Date(now).getMonth() + 1))
    const accounts = `<div class="card"><div class="card-t">Accounts</div>
      <div style="display:flex;justify-content:space-between;align-items:center"><span style="color:#e8956a;font-weight:700">Claude</span>
      <span class="${isLive ? 'green' : 'dim'}" style="font-size:11px">${isLive ? '● live' : limits ? '○ cached' : ''}</span></div>
      ${limits && limits.rateLimits && limits.rateLimits.length ? limits.rateLimits.map(windowCard).join('') : '<div class="dim" style="margin-top:8px;font-size:11px">還沒有配額資料。用訂閱方案登入、送出一個請求後就會出現。</div>'}
      <div class="win"><div class="card-t" style="margin:0">Today</div><div class="big">${TR.usd(today ? today.cost : 0)}</div></div>
      <div class="win"><div class="card-t" style="margin:0">Month</div><div class="big">${TR.usd(month ? month.cost : 0)}</div></div>
      </div>`

    // Filter pills: all, then each project by cost.
    const pills = `<div class="pills"><button class="upill${U.project ? '' : ' on'}" data-proj="">All</button>${a.projects
      .slice()
      .sort((x, y) => y.cost - x.cost)
      .slice(0, 12)
      .map(p => `<button class="upill${U.project === p.key ? ' on' : ''}" data-proj="${TR.esc(p.key)}"><span class="swatch" style="background:${a.color.get(p.key)}"></span>${TR.esc(p.name)}</button>`)
      .join('')}</div>`

    // Monthly.
    const years = [...new Set([...a.months.keys()].map(k => +k.split('-')[0]))].sort()
    if (!years.includes(U.year) && years.length) U.year = years[years.length - 1]
    const monthRows = []
    let monthMax = 0
    for (let mth = 1; mth <= 12; mth++) {
      const m = a.months.get(U.year + '-' + mth)
      monthRows.push([mth, m])
      if (m) monthMax = Math.max(monthMax, m.cost)
    }
    const monthly = `<div class="card wide"><div class="card-t">Monthly <select data-year>${(years.length ? years : [U.year]).map(y => `<option${y === U.year ? ' selected' : ''}>${y}</option>`).join('')}</select></div>
      ${monthRows
        .filter(([mth, m]) => m || mth <= new Date(now).getMonth() + 1 || U.year < new Date(now).getFullYear())
        .map(([mth, m]) => `<div class="drow${m ? '' : ' zero'}" style="height:18px"><span>${String(mth).padStart(2, '0')}</span>${m ? stack(m.by, m.cost, monthMax, a.color, true) : '<div class="stack tall"></div>'}<span class="val">${TR.usd(m ? m.cost : 0)}</span></div>`)
        .join('')}</div>`

    // Daily, last 30 days.
    const dayRows = []
    let dayMax = 0
    let sum = 0
    let active = 0
    for (let i = 29; i >= 0; i--) {
      const ts = now - i * DAY
      const d = a.days.get(dayKey(ts))
      dayRows.push([ts, d])
      if (d) { dayMax = Math.max(dayMax, d.cost); sum += d.cost; if (d.cost > 0) active++ }
    }
    const daily = `<div class="card wide"><div class="card-t">Daily Cost</div>
      ${dayRows
        .map(([ts, d]) => {
          const date = new Date(ts)
          const we = date.getDay() === 0 || date.getDay() === 6
          return `<div class="drow${d && d.cost ? '' : ' zero'}"><span class="${we ? 'we' : ''}">${TR.date(ts)} ${WEEKDAY[date.getDay()]}</span>${d ? stack(d.by, d.cost, dayMax, a.color) : '<div class="stack"></div>'}<span class="val">${TR.usd(d ? d.cost : 0)}</span></div>`
        })
        .join('')}
      <div class="legend"><span>最近 30 天：<b class="yellow">${TR.usd(sum)}</b></span><span>平均 ${TR.usd(active ? sum / active : 0)}／有用量的天</span></div></div>`

    // Tokens per day, by kind, with the cache hit rate.
    let tokMax = 0
    for (const [, d] of dayRows) if (d) tokMax = Math.max(tokMax, d.inp + d.out + d.cr + d.cw)
    const kinds = [['cr', 'var(--bar-read)', 'cache read'], ['cw', 'var(--bar-write)', 'cache write'], ['inp', 'var(--bar-input)', 'input'], ['out', 'var(--green)', 'output']]
    const tokens = `<div class="card wide"><div class="card-t">Tokens（最近 14 天）<span>命中率</span></div>
      ${dayRows
        .slice(-14)
        .map(([ts, d]) => {
          const total = d ? d.inp + d.out + d.cr + d.cw : 0
          const hitPct = d && d.inp + d.cr + d.cw ? Math.round((d.cr / (d.inp + d.cr + d.cw)) * 100) : null
          return `<div class="drow${total ? '' : ' zero'}"><span>${TR.date(ts)}</span><div class="stack" style="width:${total ? Math.max(1, (total / tokMax) * 100) : 0}%">${kinds
            .map(([k, c, label]) => (d && d[k] ? `<div style="width:${(d[k] / total) * 100}%;background:${c}" title="${label} ${TR.tok(d[k])}"></div>` : ''))
            .join('')}</div><span class="val">${hitPct == null ? '—' : `<span class="${hitPct >= 80 ? 'green' : hitPct >= 50 ? 'yellow' : 'red'}">${hitPct}%</span>`} ${TR.tok(total)}</span></div>`
        })
        .join('')}
      <div class="legend">${kinds.map(([, c, label]) => `<span><span class="swatch" style="background:${c}"></span> ${label}</span>`).join('')}</div></div>`

    // Projects table.
    const sessions = TR.entries()
    const rows = a.projects
      .map(p => {
        const t = p.sessions.reduce((acc, e) => { const u = e.tokens || [0, 0, 0, 0]; for (let i = 0; i < 4; i++) acc[i] += u[i]; return acc }, [0, 0, 0, 0])
        return { p, t, req: p.sessions.reduce((n, e) => n + (e.requests || 0), 0) }
      })
      .sort((x, y) => y.p.cost - x.p.cost)
    const table = `<div class="card wide"><div class="card-t">Projects <span>${sessions.length} sessions</span></div>
      <table class="tbl"><tr><th>專案</th><th class="r">sessions</th><th class="r">requests</th><th class="r">tokens</th><th class="r">hit</th><th class="r">cost</th></tr>
      ${rows
        .map(({ p, t, req }) => {
          const hitPct = TR.hit(t)
          return `<tr><td><span class="swatch" style="background:${a.color.get(p.key)}"></span> <span title="${TR.esc(p.cwd)}">${TR.esc(p.name)}</span></td><td class="r">${p.sessions.length}</td><td class="r">${req}</td><td class="r">${TR.tok(t[0] + t[1] + t[2] + t[3])}</td><td class="r">${hitPct == null ? '—' : hitPct + '%'}</td><td class="r yellow">${TR.usd(p.cost)}</td></tr>`
        })
        .join('')}</table></div>`

    box.innerHTML = `<div class="ucol-left">${accounts}</div><div class="ucol-right">${pills}${daily}${tokens}${monthly}${table}</div>`
    box.querySelectorAll('[data-proj]').forEach(b => (b.onclick = () => { U.project = b.dataset.proj || null; TR.render() }))
    const year = box.querySelector('[data-year]')
    if (year) year.onchange = () => { U.year = +year.value; TR.render() }
  }

  // ---------- system prompt ----------

  function diffLines(before, after) {
    const a = before ? before.split('\n') : []
    const b = after ? after.split('\n') : []
    if (a.length * b.length > 400_000) return a.map(t => ({ k: '-', t })).concat(b.map(t => ({ k: '+', t })))
    const dp = []
    for (let i = 0; i <= a.length; i++) dp.push(new Int32Array(b.length + 1))
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    const out = []
    let i = 0
    let j = 0
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ k: ' ', t: a[i] }); i++; j++ }
      else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) { out.push({ k: '+', t: b[j] }); j++ }
      else { out.push({ k: '-', t: a[i] }); i++ }
    }
    return out
  }

  /** Changes grouped with two lines of context, each with its added and removed line counts. */
  function hunks(section, before, after) {
    const lines = diffLines(before, after)
    const out = []
    let cur = null
    lines.forEach((l, idx) => {
      if (l.k === ' ') return
      const from = Math.max(0, idx - 2)
      if (cur && from <= cur.end + 1) cur.end = Math.min(lines.length - 1, idx + 2)
      else { cur = { section, start: from, end: Math.min(lines.length - 1, idx + 2) }; out.push(cur) }
    })
    for (const h of out) {
      h.lines = lines.slice(h.start, h.end + 1)
      h.add = h.lines.filter(l => l.k === '+').length
      h.del = h.lines.filter(l => l.k === '-').length
    }
    return out
  }

  function lineCounts(h) {
    const parts = [h.add ? `<span class="green">+${h.add}</span>` : '', h.del ? `<span class="red">−${h.del}</span>` : ''].filter(Boolean)
    return `<span>${parts.join('<span class="dim">／</span>')} 行</span>`
  }

  function promptSessions() {
    return (TR.entries()).filter(e => e.turns).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40)
  }

  let allLoadedAt = 0
  async function pollPrompt() {
    if (Date.now() - allLoadedAt > 60_000) {
      allLoadedAt = Date.now()
      await TR.load('data/prompts-all.js')
    }
    if (!P.session) P.session = promptSources()[0] || null
    if (P.session && !P.session.startsWith('all:')) await TR.loadPrompt(P.session)
  }

  /** Every entry of the left pane: the cross-session histories, then sessions. */
  function promptSources() {
    return [...(TR.S.promptGroups || []), ...promptSessions().map(e => e.id)]
  }

  function sysprompt() {
    const box = document.getElementById('page-sysprompt')
    const list = promptSessions()
    const p = P.session && TR.S.prompts[P.session]
    const versions = p ? p.versions.slice().reverse() : []
    const latest = versions[0]
    if (P.version == null && latest) P.version = latest.n
    const ver = versions.find(v => v.n === P.version) || latest
    const isLatest = ver && latest && ver.n === latest.n
    if (latest) TR.write('tracer-sp-seen', latest.hash)
    document.getElementById('sp-dot').hidden = true

    const groups = (TR.S.promptGroups || []).map(id => TR.S.prompts[id]).filter(Boolean)
    const groupsHtml = groups.length
      ? `<div class="sp-group">── 跨 session ──</div>` +
        groups
          .map(g => `<div class="sp-item${g.session === P.session ? ' sel' : ''}" data-sess="${TR.esc(g.session)}"><span style="color:#e8956a">◆</span> ${TR.esc(TR.shortModel(g.model))}
            <div class="m">${g.versions.length} vers · ${g.sessions} sessions</div></div>`)
          .join('')
      : ''
    const agents = groupsHtml + `<div class="sp-group">── Claude Code ──</div>${list
      .map(e => {
        const pr = TR.S.prompts[e.id]
        return `<div class="sp-item${e.id === P.session ? ' sel' : ''}" data-sess="${TR.esc(e.id)}"><span style="color:#a855f7">●</span> ${TR.esc(TR.middle(e.project, 14))} <span class="purple">${TR.esc(e.id.slice(0, 6))}</span>
          <div class="m">${pr ? pr.versions.length + ' vers · ' + pr.versions.filter(v => v.changed.length + v.added.length + v.removed.length).length + ' changes' : TR.ago(e.updatedAt)}</div></div>`
      })
      .join('')}`

    const vrows = versions
      .map((v, i) => {
        const older = versions[i + 1]
        const delta = older ? v.chars - older.chars : 0
        const changed = v.changed.length + v.added.length + v.removed.length > 0
        const cls = !older ? '' : delta > 0 ? ' grow' : delta < 0 ? ' shrink' : changed ? '' : ' same'
        return `<div class="vrow${cls}${ver && v.n === ver.n ? ' sel' : ''}" data-ver="${v.n}" title="${TR.esc([...v.changed.map(s => '~' + s), ...v.added.map(s => '+' + s), ...v.removed.map(s => '-' + s)].join(' '))}">
          <span class="dim">${TR.date(v.at)}</span><span><span class="${changed ? 'yellow' : 'dim'}">${v.hash.slice(0, 5)}</span> v${v.n} <span class="dim">${TR.esc(TR.shortModel(v.model))}${v.sessions ? ` · ${v.sessions} sess` : ''}</span></span>
          <span>${TR.tok(v.chars)}</span><span class="${delta > 0 ? 'green' : delta < 0 ? 'red' : 'dim'}">${older ? (delta >= 0 ? '+' : '') + (delta / 1000).toFixed(1) + 'k' : ''}</span></div>`
      })
      .join('')

    // The selected version's sections and its predecessor's: a cross-session
    // history keeps every version's text; a session's, the last two only.
    const older = ver ? versions[versions.indexOf(ver) + 1] : undefined
    let cur = null
    let before = []
    if (p && ver && p.texts) {
      cur = p.texts[ver.hash] || null
      before = (older && p.texts[older.hash]) || []
    } else if (p && ver && isLatest) {
      cur = p.current
      before = p.previous
    }

    let content = '<div class="dim">選一個 session。它送出下一個請求後就會記錄 system prompt。</div>'
    let status = ''
    if (p && ver) {
      if (cur === null) {
        const what = [...ver.changed.map(s => '~' + s), ...ver.added.map(s => '+' + s), ...ver.removed.map(s => '-' + s)]
        content = `<div class="detail-title">v${ver.n} <span class="dim">${new Date(ver.at).toLocaleString()}</span></div>
          <div class="dim" style="margin-bottom:8px">只保留最新版與前一版的全文；這一版記下的變更：</div>
          <div>${what.length ? what.map(w => `<span class="tag ${w[0] === '+' ? 'green' : w[0] === '-' ? 'red' : 'yellow'}">${TR.esc(w)}</span>`).join(' ') : '<span class="dim">（初版或無變更）</span>'}</div>`
      } else if (P.mode === 'content') {
        content = (p.texts ? `<div class="dim" style="margin-bottom:8px">${TR.esc(ver.model)} · ${ver.sessions || 0} 個 session 用過 · 不含各專案的 memory 與當天的 environment</div>` : '') +
          cur
            .map(s => `<details class="sec-block"${cur.length <= 3 ? ' open' : ''}><summary><b>${TR.esc(s.id)}</b>${ver.changed.includes(s.id) || ver.added.includes(s.id) ? '<span class="tag yellow">changed</span>' : ''}<span class="sz">${(s.text.length / 1000).toFixed(1)}k chars</span></summary><pre class="code">${TR.esc(s.text)}</pre></details>`)
            .join('')
      } else {
        const prev = new Map(before.map(s => [s.id, s.text]))
        let all = []
        for (const s of cur) all = all.concat(hunks(s.id, prev.get(s.id) || '', s.text))
        for (const s of before) if (!cur.some(c => c.id === s.id)) all = all.concat(hunks(s.id, s.text, ''))
        const shown = P.hideMinor ? all.filter(h => h.add + h.del > 2) : all
        P.hunk = Math.max(0, Math.min(P.hunk, shown.length - 1))
        content =
          `<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;font-size:11px"><button class="icon-btn" data-h="-1">▲ k</button><button class="icon-btn" data-h="1">▼ j</button><span class="dim">${shown.length} hunks</span>
           <label class="dim" style="margin-left:auto"><input type="checkbox" data-minor${P.hideMinor ? ' checked' : ''}> 隱藏 2 行以內的小改動</label></div>` +
          (before.length === 0 ? '<div class="dim">這是記到的第一版，沒有可比對的前一版。</div>' : '') +
          (shown.length === 0 && before.length ? '<div class="dim">與前一版相同。</div>' : '') +
          shown
            .map((h, i) => `<div class="hunk-h${i === P.hunk ? ' cur' : ''}" data-hunk="${i}"><b>${TR.esc(h.section)}</b> @@ ${h.start + 1} ${lineCounts(h)}</div>` +
              h.lines.map(l => `<div class="dl${l.k === '+' ? ' add' : l.k === '-' ? ' del' : ''}">${l.k} ${TR.esc(l.t)}</div>`).join(''))
            .join('')
      }
      status = `<span>v${ver.n}${isLatest ? ' (latest)' : ''}</span><span>·</span><span>${versions.length} versions</span><span>·</span><span class="mode-badge ${P.mode}">${P.mode === 'content' ? 'CONTENT' : 'DIFF'}</span><span class="dim">Space 切換 · ↑↓ 版本 · j/k 區塊</span>`
    }

    box.innerHTML = `<div class="sp-panes"><div class="sp-agents">${agents}</div><div class="sp-versions">${vrows || '<div class="empty">沒有版本紀錄</div>'}</div><div class="sp-content" id="sp-content">${content}</div></div><div class="sp-status">${status}</div>`
    box.querySelectorAll('[data-sess]').forEach(el => (el.onclick = async () => {
      P.session = el.dataset.sess
      P.version = null
      if (!P.session.startsWith('all:')) await TR.loadPrompt(P.session)
      TR.render()
    }))
    box.querySelectorAll('[data-ver]').forEach(el => (el.onclick = () => { P.version = +el.dataset.ver; TR.render() }))
    box.querySelectorAll('[data-h]').forEach(el => (el.onclick = () => moveHunk(+el.dataset.h)))
    const minor = box.querySelector('[data-minor]')
    if (minor) minor.onchange = () => { P.hideMinor = minor.checked; TR.render() }
    const curHunk = box.querySelector('.hunk-h.cur')
    if (curHunk && P.scrollHunk) { curHunk.scrollIntoView({ block: 'start' }); P.scrollHunk = false }
  }

  function moveHunk(d) {
    P.hunk = Math.max(0, P.hunk + d)
    P.scrollHunk = true
    TR.render()
  }

  // ---------- shell ----------

  let lastSpCheck = 0
  async function checkUnseen() {
    if (Date.now() - lastSpCheck < 30_000) return
    lastSpCheck = Date.now()
    const first = promptSessions()[0]
    if (!first) return
    await TR.loadPrompt(first.id)
    const pr = TR.S.prompts[first.id]
    const latest = pr && pr.versions[pr.versions.length - 1]
    if (latest && TR.S.page !== 'sysprompt') document.getElementById('sp-dot').hidden = TR.read('tracer-sp-seen') === latest.hash
  }
  setInterval(() => { if (TR.S.booted) checkUnseen() }, 5000)

  function render(page) {
    if (page === 'usage') usage()
    else sysprompt()
  }

  function enter(page) {
    if (page === 'sysprompt') {
      const unseen = !document.getElementById('sp-dot').hidden
      P.mode = unseen ? 'diff' : P.mode
      // A link may name the history, the version and the mode: #view=sysprompt&sp=all:claude-opus-5-5&v=3&mode=diff
      const q = new URLSearchParams(location.hash.slice(1))
      if (q.get('sp')) P.session = q.get('sp')
      if (q.get('v')) P.version = +q.get('v')
      if (q.get('mode') === 'diff' || q.get('mode') === 'content') P.mode = q.get('mode')
      pollPrompt().then(() => TR.render())
    }
  }

  function key(page, ev) {
    if (page !== 'sysprompt') return false
    const p = P.session && TR.S.prompts[P.session]
    if (ev.key === ' ') { P.mode = P.mode === 'content' ? 'diff' : 'content'; TR.render(); return true }
    if (ev.key === 'j') { moveHunk(1); return true }
    if (ev.key === 'k') { moveHunk(-1); return true }
    if ((ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && p) {
      const ns = p.versions.map(v => v.n).reverse()
      const i = ns.indexOf(P.version)
      P.version = ns[Math.max(0, Math.min(ns.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))]
      TR.render()
      return true
    }
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      const list = promptSources()
      const i = list.indexOf(P.session)
      const next = list[Math.max(0, Math.min(list.length - 1, i + (ev.key === 'ArrowRight' ? 1 : -1)))]
      if (next && next !== P.session) { P.session = next; P.version = null; (next.startsWith('all:') ? Promise.resolve() : TR.loadPrompt(next)).then(() => TR.render()) }
      return true
    }
    return false
  }

  return { render, enter, key, pollPrompt }
})()
