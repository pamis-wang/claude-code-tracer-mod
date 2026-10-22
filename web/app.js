'use strict'

// tracer dashboard: the shell. Loads the data files the mod writes, keeps the
// selection, draws the top bar, the projects and sessions columns and the
// footer, and routes keys. timeline.js draws the third column, pages.js the
// Usage and System Prompt pages.

const TR = (() => {
  const POLL_MS = 2000
  const LIVE_MS = 5 * 60_000
  const IDLE_MS = 24 * 3_600_000
  const COMPACT_PCT = 83.5

  const S = {
    index: null,
    sessions: {},
    turns: {},
    prompts: {},
    page: 'dashboard',
    focus: 0,
    filter: read('tracer-filter') || 'recent',
    sel: { project: null, session: null },
    now: Date.now(),
    sigs: {},
    tried: {},
    booted: false,
  }

  // ---------- storage, escaping, numbers ----------

  function read(key) {
    try { return localStorage.getItem(key) } catch (e) { return null }
  }
  function write(key, value) {
    try { localStorage.setItem(key, value) } catch (e) { /* private window */ }
  }

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

  function tok(n) {
    n = n || 0
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 2).replace(/\.?0+$/, '') + 'M'
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'k'
    return String(n)
  }
  function usd(n, digits) {
    if (n == null || isNaN(n)) return '—'
    return '$' + n.toFixed(digits == null ? 2 : digits)
  }
  function dur(ms) {
    const s = Math.max(0, ms / 1000)
    if (s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s)) + 's'
    const m = s / 60
    if (m < 60) return Math.floor(m) + 'm' + String(Math.round(s % 60)).padStart(2, '0') + 's'
    const h = m / 60
    if (h < 24) return Math.floor(h) + 'h' + String(Math.round(m % 60)).padStart(2, '0') + 'm'
    return (h / 24).toFixed(1) + 'd'
  }
  function span(ms) {
    const m = ms / 60_000
    if (m < 60) return Math.max(1, Math.round(m)) + 'm'
    if (m < 60 * 24) return (m / 60).toFixed(1) + 'h'
    return (m / 1440).toFixed(1) + 'd'
  }
  function ago(ts) {
    const d = S.now - ts
    if (d < 60_000) return '剛剛'
    if (d < 3_600_000) return Math.floor(d / 60_000) + ' 分鐘前'
    if (d < 86_400_000) return Math.floor(d / 3_600_000) + ' 小時前'
    if (d < 7 * 86_400_000) return Math.floor(d / 86_400_000) + ' 天前'
    return date(ts) + ' ' + clock(ts)
  }
  const pad = n => String(n).padStart(2, '0')
  const date = ts => { const d = new Date(ts); return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }
  const clock = ts => { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()) }
  const shortModel = m => (m || '?').replace(/^claude-/, '').replace(/-\d{8}$/, '')
  const shortTool = n => (n || '').startsWith('mcp__') ? n.split('__').pop() : n
  function middle(s, max) {
    s = String(s || '')
    if (s.length <= max) return s
    const half = Math.floor((max - 1) / 2)
    return s.slice(0, half) + '…' + s.slice(s.length - (max - 1 - half))
  }
  function zoneColor(pct) {
    return pct >= 80 ? 'var(--red)' : pct >= 40 ? 'var(--yellow)' : 'var(--green)'
  }
  function hit(u) {
    if (!u) return null
    const all = u[0] + u[2] + u[3]
    return all ? Math.round((u[2] / all) * 100) : null
  }

  // ---------- loading ----------

  window.__tracer = msg => {
    const d = msg && msg.data
    if (!d) return
    if (msg.kind === 'index') {
      mark('index', d.updatedAt)
      S.index = d
    } else if (msg.kind === 'session') {
      mark('s:' + d.id, d.updatedAt)
      S.sessions[d.id] = d
    } else if (msg.kind === 'turn') {
      const key = d.session + ':' + d.n
      mark('t:' + key, JSON.stringify(d).length)
      S.turns[key] = d
    } else if (msg.kind === 'prompt') {
      mark('p:' + d.session, (d.versions || []).length + ':' + JSON.stringify(d.current || []).length)
      S.prompts[d.session] = d
    } else if (msg.kind === 'prompts-all') {
      // The system prompt across sessions, one history per model, when an importer wrote one.
      mark('pa', (d.groups || []).map(g => g.versions.length).join(','))
      for (const g of d.groups || []) S.prompts['all:' + g.model] = { ...g, session: 'all:' + g.model }
      S.promptGroups = (d.groups || []).map(g => 'all:' + g.model)
    }
  }
  let changed = false
  function mark(key, sig) {
    if (S.sigs[key] !== sig) {
      S.sigs[key] = sig
      changed = true
    }
  }

  function load(path) {
    return new Promise(resolve => {
      const s = document.createElement('script')
      s.src = path + '?t=' + Date.now()
      s.onload = s.onerror = () => { s.remove(); resolve() }
      document.head.appendChild(s)
    })
  }
  const sessionPath = id => 'data/s/' + encodeURIComponent(id) + '.js'
  const loadSession = id => load(sessionPath(id))
  const loadTurn = (id, n) => load('data/s/' + encodeURIComponent(id) + '/t' + n + '.js')
  const loadPrompt = id => load('data/s/' + encodeURIComponent(id) + '/prompt.js')

  // ---------- stars ----------
  //
  // Kept in this browser: `p:<project>`, `s:<session>`, `r:<session>|<request>`.
  // A starred session, or one holding a starred request, stays listed after
  // the index lets it go (30 days): its own file is still on disk.

  const stars = new Set(parseStars(read('tracer-stars')))
  function parseStars(text) {
    try { return JSON.parse(text || '[]') } catch (e) { return [] }
  }
  const isStarred = key => stars.has(key)
  function toggleStar(key, label) {
    if (stars.has(key)) stars.delete(key)
    else stars.add(key)
    write('tracer-stars', JSON.stringify([...stars]))
    toast((stars.has(key) ? '★ ' : '☆ ') + label + (stars.has(key) ? ' 已加星' : ' 已取消星號'))
    render()
  }
  function starredSessionIds() {
    const ids = new Set()
    for (const k of stars) {
      if (k.startsWith('s:')) ids.add(k.slice(2))
      if (k.startsWith('r:')) ids.add(k.slice(2).split('|')[0])
    }
    return ids
  }
  /** Stars beneath an item: a project's sessions and requests, a session's requests. */
  function childStars(kind, id) {
    const out = []
    for (const k of stars) {
      if (kind === 'p' && k.startsWith('s:')) {
        const e = entry(k.slice(2))
        if (e && projectOf(e) === id) out.push(k)
      }
      if (k.startsWith('r:')) {
        const sid = k.slice(2).split('|')[0]
        if (kind === 's' && sid === id) out.push(k)
        if (kind === 'p') {
          const e = entry(sid)
          if (e && projectOf(e) === id) out.push(k)
        }
      }
    }
    return out
  }
  function starBadge(key, kind, id) {
    const own = isStarred(key)
    const kids = kind ? childStars(kind, id).length : 0
    const glyph = own ? '<span class="yellow">★</span>' : `<span style="opacity:${kids ? 1 : 0.6}">☆</span>`
    return `<span class="star" data-star="${esc(key)}" title="${own ? '取消星號' : '加星'} (f)">${glyph}</span>${kids ? `<span class="chip" data-pop="${esc(kind + ':' + id)}" title="裡面有 ${kids} 個加星項目">${kids}</span>` : ''}`
  }

  /** A session the index no longer lists, rebuilt from its own file. */
  function fromRecord(rec) {
    const sum = [0, 0, 0, 0]
    for (const s of rec.steps) if (s.usage) for (let i = 0; i < 4; i++) sum[i] += s.usage[i]
    const main = rec.steps.filter(s => s.loop === '' && s.endedAt)
    const last = [...rec.turns].reverse().find(t => t.prompt)
    return {
      id: rec.id, project: rec.project, cwd: rec.cwd, title: rec.title,
      model: (main[main.length - 1] || {}).model, startedAt: rec.startedAt, updatedAt: rec.updatedAt,
      turns: rec.turns.length, requests: rec.steps.length, agents: rec.agents.length,
      costUsd: rec.steps.reduce((a, s) => a + (s.costUsd || 0), 0), tokens: sum,
      contextPct: rec.meter && rec.meter.contextPct, lastMainResponseAt: (main[main.length - 1] || {}).endedAt,
      isBusy: false, lastPrompt: last ? last.prompt : '', toolErrors: rec.tools.filter(t => t.isError).length,
      ttlMs: rec.ttlMs, hourly: [], weather: null, isKept: true,
    }
  }
  function entries() {
    const list = (S.index && S.index.sessions) || []
    const listed = new Set(list.map(e => e.id))
    const kept = [...starredSessionIds()].filter(id => !listed.has(id) && S.sessions[id]).map(id => fromRecord(S.sessions[id]))
    return list.concat(kept)
  }

  function entry(id) {
    return entries().find(s => s.id === id)
  }
  function status(e) {
    if (!e) return 'off'
    if (e.isBusy && S.now - e.updatedAt < LIVE_MS) return 'live'
    if (S.now - e.updatedAt < IDLE_MS) return 'idle'
    return 'off'
  }
  const RANK = { live: 0, idle: 1, off: 2 }

  // A project is its working directory, however Claude Code spelled it: either
  // separator, any drive-letter case. Two folders that share a leaf name stay
  // two projects, and their names then carry the parent folder.
  function projectKey(cwd) {
    return String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  }
  function segments(cwd) {
    return String(cwd || '').split(/[\\/]+/).filter(Boolean)
  }

  function projects() {
    const map = new Map()
    for (const e of entries()) {
      if (!e.turns) continue
      const key = projectKey(e.cwd || e.project)
      const p = map.get(key) || { key, name: e.project, cwd: e.cwd, sessions: [], cost: 0, first: Infinity, last: 0, status: 'off' }
      p.sessions.push(e)
      p.cost += e.costUsd || 0
      p.first = Math.min(p.first, e.startedAt)
      p.last = Math.max(p.last, e.updatedAt)
      const st = status(e)
      if (RANK[st] < RANK[p.status]) p.status = st
      map.set(key, p)
    }
    const list = [...map.values()]
    const leaf = new Map()
    for (const p of list) leaf.set(p.name.toLowerCase(), (leaf.get(p.name.toLowerCase()) || 0) + 1)
    for (const p of list) {
      if (leaf.get(p.name.toLowerCase()) > 1) p.name = segments(p.cwd).slice(-2).join('/') || p.name
    }
    for (const p of list) p.isPinned = isStarred('p:' + p.key) || childStars('p', p.key).length > 0
    return list.sort((a, b) => b.isPinned - a.isPinned || RANK[a.status] - RANK[b.status] || b.last - a.last)
  }
  function projectOf(e) {
    return projectKey(e.cwd || e.project)
  }
  const sessionPinned = e => isStarred('s:' + e.id) || childStars('s', e.id).length > 0
  function visibleProjects() {
    return projects().filter(p => S.filter === 'all' || p.status !== 'off' || p.isPinned || p.key === S.sel.project)
  }
  function visibleSessions() {
    const p = projects().find(x => x.key === S.sel.project)
    if (!p) return []
    return p.sessions
      .filter(e => S.filter === 'all' || status(e) !== 'off' || sessionPinned(e) || e.id === S.sel.session)
      .sort((a, b) => sessionPinned(b) - sessionPinned(a) || b.updatedAt - a.updatedAt)
  }

  async function poll() {
    S.now = Date.now()
    await load('data/index.js')
    const listed = new Set(((S.index && S.index.sessions) || []).map(e => e.id))
    for (const id of starredSessionIds()) {
      if (listed.has(id) || S.sessions[id] || S.now - (S.tried[id] || 0) < 60_000) continue
      S.tried[id] = S.now
      await loadSession(id)
    }
    const sid = S.sel.session
    if (sid) {
      const e = entry(sid)
      if (!S.sessions[sid] || (e && S.sessions[sid].updatedAt < e.updatedAt)) await loadSession(sid)
      if (window.XR_TL) await XR_TL.poll()
    }
    if (S.page === 'sysprompt' && window.XR_PAGES) await XR_PAGES.pollPrompt()
    if (!S.booted) {
      S.booted = true
      restore()
      changed = true
    }
    if (changed) {
      changed = false
      render()
    } else {
      tickClocks()
    }
  }

  // ---------- selection and URL ----------

  function selectProject(name) {
    if (S.sel.project === name) return
    S.sel.project = name
    S.sel.session = null
    if (window.XR_TL) XR_TL.reset()
    const first = visibleSessions()[0]
    if (first) selectSession(first.id)
    else render()
  }
  async function selectSession(id) {
    if (S.sel.session === id) return
    S.sel.session = id
    if (window.XR_TL) XR_TL.reset()
    render()
    if (!S.sessions[id]) await loadSession(id)
    render()
  }
  function syncHash() {
    const q = new URLSearchParams()
    if (S.page !== 'dashboard') q.set('view', S.page)
    if (S.sel.project) q.set('p', S.sel.project)
    if (S.sel.session) q.set('s', S.sel.session.slice(0, 8))
    if (window.XR_TL) XR_TL.toHash(q)
    const hash = '#' + q.toString()
    if (location.hash !== hash) history.replaceState(null, '', hash)
  }
  function restore() {
    const q = new URLSearchParams(location.hash.slice(1))
    const view = q.get('view')
    if (view === 'usage' || view === 'sysprompt') {
      S.page = view
      if (window.XR_PAGES) XR_PAGES.enter(view)
    }
    const sid = q.get('s')
    const e = sid && S.index && S.index.sessions.find(x => x.id.startsWith(sid))
    if (e) {
      S.sel.project = projectOf(e)
      S.sel.session = e.id
      S.focus = 2
      if (window.XR_TL) XR_TL.fromHash(q)
      loadSession(e.id).then(render)
      return
    }
    if (sid) toast('Deep link：找不到這個 session')
    const p = q.get('p') || (visibleProjects()[0] || {}).key
    if (p) {
      S.sel.project = p
      const first = visibleSessions()[0]
      if (first) {
        S.sel.session = first.id
        loadSession(first.id).then(render)
      }
    }
  }

  // ---------- drawing ----------

  function render() {
    document.body.classList.toggle('page-usage', S.page === 'usage')
    document.body.classList.toggle('page-sysprompt', S.page === 'sysprompt')
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.page === S.page)
    renderTop()
    if (S.page === 'dashboard') {
      renderProjects()
      renderSessions()
      if (window.XR_TL) XR_TL.render(document.getElementById('col-timeline'))
      document.querySelectorAll('#main .col').forEach((c, i) => c.classList.toggle('focused', i === S.focus))
    } else if (window.XR_PAGES) {
      XR_PAGES.render(S.page)
    }
    renderFooter()
    // Until the first load has read the link it was opened with, leave it alone.
    if (S.booted) syncHash()
    tickClocks()
  }

  function renderTop() {
    const all = (S.index && S.index.sessions) || []
    const live = all.filter(e => status(e) === 'live').length
    const idle = all.filter(e => status(e) === 'idle').length
    const held = all.find(e => e.held && S.now - e.held.since < 30 * 60_000)
    const flags = S.index && S.index.flags
    const stats = flags
      ? `<span class="stats-flag" title="在 Claude Code 輸入 /tracer stats 切換">統計列 <b class="${flags.stats ? 'on' : ''}">ON</b><b class="${flags.stats ? '' : 'off'}">OFF</b></span>`
      : ''
    const intercept = flags && (flags.intercept !== 'off' || flags.interceptTools)
      ? `<span class="yellow" title="用 /tracer intercept off 關閉">⏸ 攔截：${[flags.intercept === 'next' ? '下一個請求' : flags.intercept === 'all' ? '每個請求' : '', flags.interceptTools ? '工具呼叫' : ''].filter(Boolean).join('、')}</span>`
      : ''
    document.getElementById('status-cluster').innerHTML =
      (held ? `<span class="held-pill" title="tracer 正在等你回答：請回到 Claude Code">等你回應：${held.held.kind === 'tool' ? '工具呼叫' : '請求'} · ${esc(held.id.slice(0, 8))}</span>` : '') +
      intercept + stats +
      `<span class="green">●${live} streaming</span><span class="yellow">◐${idle} idle</span>`
    document.getElementById('theme-btn').textContent = document.documentElement.dataset.theme === 'light' ? '🌙' : '☀️'

    const parts = [['root', () => { S.sel.project = null; S.sel.session = null; S.focus = 0; render() }]]
    if (S.page === 'dashboard') {
      const proj = S.sel.project && projects().find(p => p.key === S.sel.project)
      if (proj) parts.push([proj.name, () => { S.focus = 1; if (window.XR_TL) XR_TL.reset(); render() }])
      if (S.sel.session) parts.push(['session: ' + S.sel.session.slice(0, 8), () => { if (window.XR_TL) XR_TL.reset(); S.focus = 2; render() }])
      if (window.XR_TL) for (const c of XR_TL.crumbs()) parts.push(c)
    } else {
      parts.push([S.page === 'usage' ? 'Usage' : 'System Prompt', null])
    }
    const crumbs = document.getElementById('crumbs')
    crumbs.innerHTML = parts
      .map(([label], i) => (i === parts.length - 1 ? `<span class="last">${esc(label)}</span>` : `<a data-i="${i}">${esc(label)}</a>`))
      .join('<span class="sep">›</span>')
    crumbs.querySelectorAll('a').forEach(a => (a.onclick = () => { const fn = parts[+a.dataset.i][1]; if (fn) fn() }))

    renderQuota()
  }

  function renderQuota() {
    const box = document.getElementById('quota')
    const limits = S.index && S.index.limits
    if (!limits || !limits.rateLimits || !limits.rateLimits.length) {
      box.innerHTML = '<span class="dim">尚無配額資料</span>'
      return
    }
    const windows = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 }
    box.innerHTML = limits.rateLimits
      .map(r => {
        const name = r.kind === 'five_hour' ? '5h' : r.kind === 'seven_day' ? '7d' : r.kind
        const reset = r.resetsAt ? Date.parse(r.resetsAt) - S.now : NaN
        const len = windows[r.kind]
        const timePct = len && reset > 0 ? Math.min(100, (1 - reset / len) * 100) : null
        const hot = timePct && timePct > 3 && r.percentUsed / timePct > 1.3
        const color = r.percentUsed >= 85 ? 'var(--red)' : r.percentUsed >= 60 ? 'var(--yellow)' : 'var(--green)'
        return `<span class="q" title="${esc(r.kind)}${timePct ? ' · 時間已過 ' + timePct.toFixed(0) + '%' : ''}">
          <span class="dim">${name}</span><span class="qbar"><div style="width:${Math.min(100, r.percentUsed)}%;background:${color}"></div></span>
          <span>${(+r.percentUsed).toFixed(1)}%${hot ? ' ⚡' : ''}</span>
          ${reset > 0 ? `<span class="dim">${dur(reset)} 後重置</span>` : ''}</span>`
      })
      .join('') + (S.now - limits.at > 15 * 60_000 ? `<span class="dim">（${ago(limits.at)}）</span>` : '')
  }

  function colHead(title, count, withFilter) {
    return `<div class="col-head">${title} <span>(${count})</span>${
      withFilter
        ? `<select data-filter><option value="recent"${S.filter === 'recent' ? ' selected' : ''}>Recent</option><option value="all"${S.filter === 'all' ? ' selected' : ''}>All</option></select>`
        : ''
    }</div>`
  }

  function renderProjects() {
    const col = document.getElementById('col-projects')
    if (!S.index) {
      col.innerHTML = colHead('Projects', 0) + '<div class="skeleton"></div>'.repeat(6)
      return
    }
    const list = visibleProjects()
    col.innerHTML =
      colHead('Projects', list.length, true) +
      (list.length === 0 ? '<div class="empty">還沒有資料。在 Claude Code 裡送出一個 prompt 後就會出現。</div>' : '') +
      list
        .map(p => {
          const range = date(p.first) === date(p.last) ? date(p.last) : date(p.first) + '—' + date(p.last)
          const tip = p.status === 'live' ? 'streaming' : p.status === 'idle' ? 'idle · ' + ago(p.last) : 'offline'
          return `<div class="row${p.key === S.sel.project ? ' sel' : ''}" data-project="${esc(p.key)}">
            <div class="l1"><span class="dot ${p.status}" title="${tip}"></span><span class="name" title="${esc(p.cwd || p.name)}">${esc(middle(p.name, 20))}</span><span class="spacer"></span>${starBadge('p:' + p.key, 'p', p.key)}</div>
            <div class="small">${p.sessions.length} sessions</div>
            <div class="cost">${usd(p.cost)}</div>
            <div class="tiny">${range}</div></div>`
        })
        .join('')
    col.querySelectorAll('[data-project]').forEach(el => (el.onclick = () => { S.focus = 0; selectProject(el.dataset.project) }))
    wireFilter(col)
    wireStars(col)
  }

  function wireStars(container) {
    container.querySelectorAll('[data-star]').forEach(el => (el.onclick = ev => {
      ev.stopPropagation()
      toggleStar(el.dataset.star, labelOf(el.dataset.star))
    }))
    container.querySelectorAll('[data-pop]').forEach(el => (el.onclick = ev => {
      ev.stopPropagation()
      const [kind, ...rest] = el.dataset.pop.split(':')
      popover(kind, rest.join(':'))
    }))
  }
  function labelOf(key) {
    if (key.startsWith('p:')) return 'Project'
    if (key.startsWith('s:')) return 'Session'
    return 'Request'
  }

  /** The starred items beneath a project or session; picking one goes there. */
  function popover(kind, id) {
    const keys = childStars(kind, id)
    const card = document.getElementById('overlay-card')
    card.innerHTML = `<h2>加星的項目（${keys.length}）</h2>` + keys
      .map((k, i) => {
        const sid = k.startsWith('s:') ? k.slice(2) : k.slice(2).split('|')[0]
        const e = entry(sid)
        const what = k.startsWith('s:') ? 'Session' : 'Request ' + (k.split('|')[1] || '').slice(-6)
        return `<div class="kline pop-row" data-go="${esc(k)}" data-i="${i}"><span class="yellow">★</span><span>${what}</span><span class="dim">${esc(sid.slice(0, 8))} ${esc(e ? (e.title || '').slice(0, 40) : '')}</span></div>`
      })
      .join('')
    card.querySelectorAll('[data-go]').forEach(el => (el.onclick = () => { document.getElementById('overlay').classList.remove('open'); helpOverlay(); goStar(el.dataset.go) }))
    document.getElementById('overlay').classList.add('open')
    S.popover = true
  }

  /** Every star in the order the columns list them: project, its sessions, their requests. */
  function starOrder() {
    const out = []
    for (const p of projects()) {
      if (isStarred('p:' + p.key)) out.push('p:' + p.key)
      for (const e of p.sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt)) {
        if (isStarred('s:' + e.id)) out.push('s:' + e.id)
        for (const k of stars) if (k.startsWith('r:' + e.id + '|')) out.push(k)
      }
    }
    return out
  }
  function currentStarKey() {
    if (S.focus === 2 && window.XR_TL && XR_TL.selectedStep() && S.sel.session) return 'r:' + S.sel.session + '|' + XR_TL.selectedStep()
    if (S.focus >= 1 && S.sel.session) return 's:' + S.sel.session
    return S.sel.project ? 'p:' + S.sel.project : null
  }
  async function goStar(key) {
    if (key.startsWith('p:')) {
      S.focus = 0
      selectProject(key.slice(2))
      return
    }
    const sid = key.slice(2).split('|')[0]
    const e = entry(sid)
    if (!e) { toast('找不到這個加星項目的資料'); return }
    S.sel.project = projectOf(e)
    if (S.sel.session !== sid) await selectSession(sid)
    if (!S.sessions[sid]) await loadSession(sid)
    if (key.startsWith('r:') && window.XR_TL) {
      S.focus = 2
      XR_TL.selectStepById(key.split('|')[1])
    } else {
      S.focus = 1
      render()
    }
  }
  function jumpStar(dir) {
    const order = starOrder()
    if (!order.length) { toast('還沒有加星的項目（按 f 加星）'); return }
    const cur = currentStarKey()
    const i = order.indexOf(cur)
    const next = order[(i < 0 ? (dir > 0 ? 0 : order.length - 1) : i + dir + order.length) % order.length]
    goStar(next)
  }

  function renderSessions() {
    const col = document.getElementById('col-sessions')
    const list = visibleSessions()
    col.innerHTML =
      colHead('Sessions', list.length, true) +
      (list.length === 0 ? '<div class="empty">No sessions yet</div>' : '') +
      list
        .map(e => {
          const st = status(e)
          const rec = S.sessions[e.id]
          const win = rec && rec.meter && rec.meter.window
          const pct = e.contextPct
          const isRecent = S.now - e.updatedAt < 3_600_000
          const barColor = !isRecent ? 'var(--dim)' : pct >= COMPACT_PCT ? 'var(--red)' : pct >= 75 ? 'var(--yellow)' : 'var(--accent)'
          return `<div class="row sess${e.id === S.sel.session ? ' sel' : ''}" data-session="${esc(e.id)}" title="開始 ${esc(new Date(e.startedAt).toLocaleString())}\n最後活動 ${esc(new Date(e.updatedAt).toLocaleString())}">
            <div class="l1"><span class="dot ${st}"></span><span class="sid">${esc(e.id.slice(0, 8))}</span>${e.held ? '<span class="held-badge">等你回應</span>' : ''}${e.toolErrors ? `<span class="red tiny">✗${e.toolErrors}</span>` : ''}<span class="spacer"></span>${starBadge('s:' + e.id, 's', e.id)}</div>
            <div class="title3">${esc((e.title || '(無標題)').slice(0, 100))}</div>
            <div class="small"><span class="purple">${esc(shortModel(e.model))}</span> · ${e.turns}t${e.agents ? ' · ' + e.agents + ' agents' : ''} · ${span(e.updatedAt - e.startedAt)}${healthHtml(e)}</div>
            ${e.isKept ? '<div class="tiny yellow">已超過保留期，因加星而保留</div>' : ''}
            <div class="cost">${usd(e.costUsd)}</div>
            ${pct != null ? `<div class="ctxbar" style="${isRecent ? '' : 'opacity:.5'}"><div style="width:${Math.min(100, pct)}%;background:${barColor}"></div><span class="tick" style="left:${COMPACT_PCT}%"></span></div>
            <div class="tiny" style="${isRecent ? '' : 'opacity:.7'}">${pct}%${win ? ' of ' + tok(win) : ''}</div>` : ''}
            ${e.lastPrompt && e.lastPrompt !== e.title ? `<div class="preview">${esc(e.lastPrompt.slice(0, 60))}${e.lastPrompt.length > 60 ? '…' : ''}</div>` : ''}
            <div class="meta"><span>${ago(e.updatedAt)}</span><span data-cache-until="${e.lastMainResponseAt ? e.lastMainResponseAt + e.ttlMs : ''}" data-ttl="${e.ttlMs}"></span></div></div>`
        })
        .join('')
    col.querySelectorAll('[data-session]').forEach(el => (el.onclick = () => { S.focus = 1; selectSession(el.dataset.session) }))
    wireFilter(col)
    wireStars(col)
    col.querySelectorAll('[data-health]').forEach(el => {
      const e = entry(el.dataset.health)
      el.onmouseenter = ev => showTip(healthTip(e), ev)
      el.onmousemove = ev => showTip(healthTip(e), ev)
      el.onmouseleave = () => showTip(null)
    })
  }

  // ---------- session health ----------

  // 100 minus each signal's deduction (severity × 40). The data files keep the signals under `weather`.
  const MAX_DEDUCTION = 40
  function healthOf(e) {
    if (!e || !e.weather) return null
    const factors = e.weather.factors.map(f => ({ ...f, points: Math.round(f.severity * MAX_DEDUCTION) }))
    return { score: Math.max(0, 100 - factors.reduce((a, f) => a + f.points, 0)), factors }
  }
  function healthLevel(score) {
    return score >= 80 ? ['good', '良好'] : score >= 50 ? ['warn', '留意'] : ['bad', '有問題']
  }
  function healthHtml(e) {
    const h = healthOf(e)
    if (!h) return ''
    return `<span class="health ${healthLevel(h.score)[0]}" data-health="${esc(e.id)}">${h.score}</span>`
  }
  function healthTip(e) {
    const h = healthOf(e)
    if (!h) return null
    const clean = h.factors.filter(f => f.points === 0).map(f => esc(f.name))
    return `<div style="margin-bottom:4px"><b>健康分數 ${h.score}</b> <span class="dim">/ 100 · ${healthLevel(h.score)[1]}</span></div>` +
      h.factors
        .filter(f => f.points > 0)
        .map(f => `<div class="kv"><span><b class="${f.severity >= 0.75 ? 'red' : 'yellow'}">−${f.points}</b> ${esc(f.name)}</span><span><span class="minibar" style="display:inline-block;width:60px;vertical-align:middle"><div style="width:${f.severity * 100}%;background:${f.severity >= 0.75 ? 'var(--red)' : 'var(--yellow)'}"></div></span> <span class="dim">${esc(f.detail)}</span></span></div>`)
        .join('') +
      (clean.length ? `<div class="dim" style="margin-top:4px">沒有扣分：${clean.join('、')}</div>` : '')
  }
  function showTip(html, ev) {
    const el = document.getElementById('tip')
    if (!html) { el.style.display = 'none'; return }
    el.innerHTML = html
    el.style.display = 'block'
    el.style.left = Math.min(ev.clientX + 14, window.innerWidth - el.offsetWidth - 8) + 'px'
    el.style.top = Math.min(ev.clientY + 14, window.innerHeight - el.offsetHeight - 8) + 'px'
  }

  function wireFilter(col) {
    const sel = col.querySelector('[data-filter]')
    if (sel) {
      sel.onclick = ev => ev.stopPropagation()
      sel.onchange = () => { S.filter = sel.value; write('tracer-filter', S.filter); render() }
    }
  }

  /** The cache countdowns and the tab title tick every second without a redraw. */
  function tickClocks() {
    S.now = Date.now()
    let urgent = false
    for (const el of document.querySelectorAll('[data-cache-until]')) {
      const until = +el.dataset.cacheUntil
      if (!until) { el.textContent = ''; continue }
      const ttl = +el.dataset.ttl || 3_600_000
      const left = until - S.now
      if (left <= 0) {
        el.className = 'cache-gone'
        el.textContent = 'cache 已過期'
        continue
      }
      if (left < 60_000) urgent = true
      const frac = left / ttl
      el.className = frac > 0.6 ? 'cache-ok' : frac > 0.3 ? 'cache-mid' : 'cache-low'
      el.textContent = left < 60_000 ? `cache 剩 ${Math.ceil(left / 1000)}s` : `cache 剩 ${Math.ceil(left / 60_000)}m`
    }
    document.title = urgent && Math.floor(S.now / 1000) % 2 ? '⚠ tracer' : 'tracer'
  }

  // ---------- footer and keys ----------

  function hints() {
    if (S.page !== 'dashboard') return []
    if (S.focus === 2 && window.XR_TL) return XR_TL.hints()
    const base = [
      ['↑↓', 'select', true],
      ['→', 'open', true],
    ]
    if (S.focus === 1) base.push(['←', 'back', true])
    const key = currentStarKey()
    const order = starOrder()
    return base.concat([
      ['f', key && isStarred(key) ? '☆ unstar' : '★ star', !!key],
      ['p', 'popover', !!(key && !key.startsWith('r:') && childStars(key[0], key.slice(2)).length)],
      ['n', 'next star', order.length > 0],
      ['N', 'prev star', order.length > 0],
      ['\\', 'sidebar', !!S.sel.session],
      ['1', 'Dashboard', true],
      ['2', 'Usage', true],
      ['3', 'Sys Prompt', true],
      ['?', 'help', true],
    ])
  }
  function renderFooter() {
    const bar = document.getElementById('cmd-bar')
    const list = hints()
    bar.innerHTML = list
      .map(([k, label, on], i) => `<button class="it${on ? '' : ' off'}" data-i="${i}"><kbd>${esc(k)}</kbd>${esc(label)}</button>`)
      .join('<span class="sep">·</span>')
    bar.querySelectorAll('.it').forEach(b => (b.onclick = () => {
      const [k, , on] = list[+b.dataset.i]
      if (on) onKey({ key: k.split('/')[0], preventDefault() {}, shiftKey: false, target: document.body })
    }))
  }

  function move(list, current, delta) {
    if (!list.length) return null
    const i = list.indexOf(current)
    return list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + delta))]
  }

  function setPage(page) {
    S.page = page
    if (page !== 'dashboard' && window.XR_PAGES) XR_PAGES.enter(page)
    render()
  }

  function toggleSidebar() {
    if (!S.sel.session && !document.body.classList.contains('collapsed')) return
    document.body.classList.toggle('collapsed')
    write('tracer-sidebar', document.body.classList.contains('collapsed') ? 'collapsed' : 'open')
    if (window.XR_TL) setTimeout(render, 200)
  }

  function onKey(ev) {
    const t = ev.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return
    const overlay = document.getElementById('overlay')
    if (ev.key === '?') { overlay.classList.toggle('open'); return ev.preventDefault() }
    if (overlay.classList.contains('open')) {
      if (ev.key === 'Escape') {
        overlay.classList.remove('open')
        helpOverlay()
      }
      return
    }
    if (S.page === 'dashboard' && (ev.key === 'f' || ev.key === 'n' || ev.key === 'N' || ev.key === 'p')) {
      const key = currentStarKey()
      if (ev.key === 'f' && key) toggleStar(key, labelOf(key))
      if (ev.key === 'n') jumpStar(1)
      if (ev.key === 'N') jumpStar(-1)
      if (ev.key === 'p' && key && !key.startsWith('r:')) popover(key[0], key.slice(2))
      return ev.preventDefault()
    }
    if (ev.key === '1') return setPage('dashboard')
    if (ev.key === '2') return setPage('usage')
    if (ev.key === '3') return setPage('sysprompt')
    if (S.page !== 'dashboard') {
      if (ev.key === 'Escape') return setPage('dashboard')
      if (window.XR_PAGES && XR_PAGES.key(S.page, ev)) ev.preventDefault()
      return
    }
    if (ev.key === '\\') return toggleSidebar()
    if (S.focus === 2 && window.XR_TL && XR_TL.key(ev)) { ev.preventDefault(); return }
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      const d = ev.key === 'ArrowUp' ? -1 : 1
      if (S.focus === 0) {
        const next = move(visibleProjects().map(p => p.key), S.sel.project, d)
        if (next) selectProject(next)
      } else if (S.focus === 1) {
        const next = move(visibleSessions().map(e => e.id), S.sel.session, d)
        if (next) selectSession(next)
      }
      ev.preventDefault()
      scrollSelected()
      return
    }
    if (ev.key === 'ArrowRight' || ev.key === 'Enter') {
      if (S.focus === 0 && S.sel.project) S.focus = 1
      else if (S.focus === 1 && S.sel.session) S.focus = 2
      ev.preventDefault()
      return render()
    }
    if (ev.key === 'ArrowLeft' || ev.key === 'Escape') {
      if (S.focus > 0) S.focus--
      ev.preventDefault()
      return render()
    }
  }
  function scrollSelected() {
    requestAnimationFrame(() => document.querySelectorAll('.row.sel').forEach(el => el.scrollIntoView({ block: 'nearest' })))
  }

  function helpOverlay() {
    const groups = [
      ['全域', [['?', '開關這個說明'], ['1 / 2 / 3', 'Dashboard / Usage / System Prompt'], ['\\', '收合左側欄'], ['Esc', '回上一層']]],
      ['星號', [['f', '目前的專案／session／請求加星或取消'], ['n / N', '下／上一個加星項目'], ['p', '列出裡面加星的項目']]],
      ['欄位', [['↑ ↓', '在欄內選取'], ['← →', '換欄'], ['Enter', '進入下一欄']]],
      ['時間軸', [['Tab / ⇧Tab', '切換 lane'], ['j / k', 'lane 內下／上一個請求'], ['↑ ↓', '請求內的步驟'], ['e / E', '下／上一個錯誤'], ['a / A', '下／上一個 Agent 呼叫'], ['s / S', '下／上一個 Skill 呼叫'], ['m / M', '下／上一個 MCP 呼叫'], ['b', '鳥瞰模式'], ['0', '重設縮放'], ['Ctrl+滾輪', '縮放時間軸']]],
      ['System Prompt', [['↑ ↓', '選版本'], ['Space', '全文／差異'], ['j / k', '下／上一個差異區塊']]],
    ]
    document.getElementById('overlay-card').innerHTML =
      '<h2>快捷鍵</h2>' +
      groups.map(([g, rows]) => `<div class="grp">${g}</div>` + rows.map(([k, d]) => `<div class="kline"><kbd>${esc(k)}</kbd><span>${esc(d)}</span></div>`).join('')).join('')
  }

  function toast(text) {
    const box = document.getElementById('toasts')
    const el = document.createElement('div')
    el.className = 'toast'
    el.textContent = text
    el.onclick = () => el.remove()
    box.appendChild(el)
    setTimeout(() => el.remove(), 5000)
  }

  function boot() {
    if (document.documentElement.classList.contains('pre-collapsed')) document.body.classList.add('collapsed')
    document.querySelectorAll('.tab').forEach(t => (t.onclick = () => setPage(t.dataset.page)))
    document.getElementById('theme-btn').onclick = () => {
      const light = document.documentElement.dataset.theme !== 'light'
      if (light) document.documentElement.dataset.theme = 'light'
      else delete document.documentElement.dataset.theme
      write('tracer-theme', light ? 'light' : 'dark')
      render()
    }
    document.getElementById('help-btn').onclick = () => document.getElementById('overlay').classList.add('open')
    document.getElementById('overlay').onclick = ev => { if (ev.target.id === 'overlay') ev.currentTarget.classList.remove('open') }
    document.getElementById('link-btn').onclick = async ev => {
      const btn = ev.currentTarget
      try {
        await navigator.clipboard.writeText(location.href)
        btn.textContent = '✓'
        btn.classList.add('green')
        setTimeout(() => { btn.textContent = '🔗'; btn.classList.remove('green') }, 1500)
      } catch (e) {
        toast('沒辦法寫入剪貼簿：' + location.href)
      }
    }
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', () => render())
    helpOverlay()
    render()
    poll()
    setInterval(poll, POLL_MS)
    setInterval(tickClocks, 1000)
  }

  return {
    S, esc, tok, usd, dur, span, ago, date, clock, shortModel, shortTool, zoneColor, hit, middle,
    entry, status, load, loadSession, loadTurn, loadPrompt, render, toast, boot, setPage,
    projects, projectOf, segments, entries, isStarred, toggleStar, starBadge, wireStars, starOrder, currentStarKey, showTip,
    selectSession, selectProject, read, write,
    get focus() { return S.focus },
    set focus(v) { S.focus = v },
  }
})()
