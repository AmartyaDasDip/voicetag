'use strict';
/* =====================================================================
   Analysis: stats (minutes, per 90, KPIs, halves), maps, PDF match
   report, and the season database (many matches together).
   ===================================================================== */
const rated = list => list.filter(e => e.success === 0 || e.success === 1);
const pctOf = list => { const r = rated(list); return r.length ? Math.round(r.filter(e => e.success === 1).length / r.length * 1000) / 10 : null; };
const teamOf = e => e.team || (e.playerId ? 'Home' : '');
function teamFilter(list, team) { return team ? list.filter(e => teamOf(e) === team || (!e.playerId && team === 'Home')) : list; }
function kpiValue(k, evs) {
  const list = evs.filter(e => e.codeId === k.codeId && (!k.team || teamOf(e) === k.team || (!e.playerId && k.team === 'Home')));
  if (k.metric === 'pct') return pctOf(list);
  return list.length;
}
function kpiPass(k, v) { if (v == null) return null; return k.cmp === '<=' ? v <= Number(k.target) : v >= Number(k.target); }

/* ---------------------------------------------------------------- STATS TAB */
function renderSummary() {
  const team = $('#sumTeam').value, per90 = $('#sumPer90').checked;
  const mins = minutesPlayed() || {};
  const pe = teamFilter(events.filter(e => e.playerId), team);
  const t = $('#sumTable');
  if (!pe.length) t.innerHTML = '<tr><td class="muted">No player tags yet for this team.</td></tr>';
  else {
    const order = id => { const i = config.codes.findIndex(c => c.id === id); return i < 0 ? 999 : i; };
    const cols = [...new Map(pe.map(e => [e.codeId, e.code])).entries()].sort((a, b) => order(a[0]) - order(b[0]));
    const players = [...new Map(pe.map(e => [e.playerId, e])).values()].sort((a, b) => (Number(a.num) || 999) - (Number(b.num) || 999));
    const cell = (list, m) => {
      if (!list.length) return '<td class="muted">·</td>';
      const p = pctOf(list);
      const n = per90 && m ? (Math.round(list.length / m * 90 * 10) / 10) : list.length;
      return `<td>${n}${p != null ? ` <span class="${p >= 70 ? 'ok' : p >= 50 ? 'warn' : 'bad'}">(${Math.round(p)}%)</span>` : ''}</td>`;
    };
    let html = '<thead><tr><th>Player</th><th>Min</th>' + cols.map(c => `<th>${esc(c[1])}</th>`).join('') + '<th>All</th></tr></thead><tbody>';
    players.forEach(p => {
      const l = pe.filter(e => e.playerId === p.playerId), m = mins[p.playerId];
      html += `<tr><td>${esc(playerLabel(p))}${p.name ? ' <span class="muted">' + esc(p.name) + '</span>' : ''}</td><td class="muted">${m != null ? m : ''}</td>` + cols.map(c => cell(l.filter(e => e.codeId === c[0]), m)).join('') + `<td><b>${per90 && m ? Math.round(l.length / m * 90 * 10) / 10 : l.length}</b></td></tr>`;
    });
    html += '<tr><td><b>Total</b></td><td></td>' + cols.map(c => cell(pe.filter(e => e.codeId === c[0]))).join('') + `<td><b>${pe.length}</b></td></tr></tbody>`;
    t.innerHTML = html;
  }
  if (per90 && !Object.keys(mins).length) $('#sumTable').insertAdjacentHTML('afterend', '');
  $('#kpiTable').innerHTML = config.kpis.length ? '<thead><tr><th>KPI</th><th>Target</th><th>Actual</th><th></th></tr></thead><tbody>' + config.kpis.map(k => {
    const v = kpiValue(k, events), ok = kpiPass(k, v);
    return `<tr><td>${esc(k.name)}</td><td>${esc(k.cmp)} ${esc(k.target)}${k.metric === 'pct' ? '%' : ''}</td><td>${v == null ? '—' : v + (k.metric === 'pct' ? '%' : '')}</td><td>${ok == null ? '' : ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'}</td></tr>`;
  }).join('') + '</tbody>' : '<tr><td class="muted">Add KPIs in Settings → KPIs.</td></tr>';
  const tf = teamFilter(events, team);
  const codesUsed = config.codes.filter(c => tf.some(e => e.codeId === c.id));
  $('#halfTable').innerHTML = codesUsed.length ? '<thead><tr><th>Code</th><th>1st half</th><th>2nd half</th></tr></thead><tbody>' + codesUsed.map(c => {
    const h = p => { const l = tf.filter(e => e.codeId === c.id && evPeriod(e) === p); const pc = pctOf(l); return `<td>${l.length}${pc != null ? ' <span class="muted">(' + Math.round(pc) + '%)</span>' : ''}</td>`; };
    return `<tr><td>${esc(c.name)}</td>${h('1')}${h('2')}</tr>`;
  }).join('') + '</tbody>' : '<tr><td class="muted">—</td></tr>';
  const dr = durationRows(tf);
  $('#durTable').innerHTML = dr.length
    ? '<thead><tr><th>Phase</th><th>Count</th><th>Total time</th><th>Average</th></tr></thead><tbody>' + dr.map(r => `<tr><td>${esc(r.code)}</td><td>${r.count}</td><td>${fmtTime(r.total)}</td><td>${fmtDur(r.total / r.count)}</td></tr>`).join('') + '</tbody>'
    : '<tr><td class="muted">No phases tagged yet (e.g. Build-up).</td></tr>';
}
function durationRows(list = events) {
  const map = new Map();
  list.filter(e => e.type === 'duration').forEach(e => {
    if (!map.has(e.code)) map.set(e.code, { code: e.code, count: 0, total: 0 });
    const r = map.get(e.code); r.count++; r.total += e.end - e.start;
  });
  return [...map.values()];
}
HOOKS.render.push(tab => { if (!tab || tab === 'summary') renderSummary(); });
$('#sumTeam').onchange = renderSummary;
$('#sumPer90').onchange = renderSummary;

/* ---------------------------------------------------------------- MAPS TAB */
function evColor(e) { return e.success === 1 ? '#2ecc71' : e.success === 0 ? '#ff5a5f' : ((VOC.codesById[e.codeId] || {}).color || '#f5b041'); }
function pitchMapSVG(list, mode, opts = {}) {
  let body = '';
  if (mode === 'heat') {
    const gx = 12, gy = 8, grid = Array.from({ length: gx * gy }, () => 0);
    list.forEach(e => { const i = Math.min(gx - 1, Math.floor(e.x / 100 * gx)), j = Math.min(gy - 1, Math.floor(e.y / 100 * gy)); grid[j * gx + i]++; });
    const max = Math.max(1, ...grid);
    grid.forEach((v, k) => { if (!v) return; const i = k % gx, j = Math.floor(k / gx); body += `<rect x="${(i * 105 / gx).toFixed(2)}" y="${(j * 68 / gy).toFixed(2)}" width="${(105 / gx).toFixed(2)}" height="${(68 / gy).toFixed(2)}" fill="#ff3b3b" opacity="${(0.12 + 0.68 * v / max).toFixed(2)}"><title>${v}</title></rect>`; });
  } else {
    list.forEach(e => {
      const c = evColor(e), ai = ARROW_IDX[c] != null ? ARROW_IDX[c] : 3;
      if (e.x2 != null) body += `<line x1="${PX(e.x)}" y1="${PY(e.y)}" x2="${PX(e.x2)}" y2="${PY(e.y2)}" stroke="${c}" stroke-width=".55" opacity=".9" marker-end="url(#ah${ai})"/>`;
      body += `<circle ${opts.clickable ? `data-mev="${e.id}"` : ''} cx="${PX(e.x)}" cy="${PY(e.y)}" r="${e.codeId === 'shot' ? 1.4 : 1.1}" fill="${c}" stroke="#000" stroke-width=".25" style="cursor:pointer"><title>${esc((matchClock(e.t) || fmtTime(e.t)) + ' ' + eventText(e))}</title></circle>`;
    });
  }
  return `<svg class="pitchsvg" viewBox="0 0 105 68" xmlns="http://www.w3.org/2000/svg">${arrowDefs()}${pitchLines()}${body}</svg>`;
}
function renderMaps() {
  const team = $('#mapTeam').value, pl = $('#mapPlayer').value, cd = $('#mapCode').value, per = $('#mapPeriod').value, mode = $('#mapMode').value;
  const list = teamFilter(events, team).filter(e => e.x != null && (!pl || e.playerId === pl) && (!cd || e.codeId === cd) && (!per || evPeriod(e) === per));
  $('#mapBox').innerHTML = pitchMapSVG(list, mode, { clickable: true });
  const noLoc = events.filter(e => e.x == null && e.type !== 'duration').length;
  $('#mapInfo').innerHTML = `${list.length} tag(s) shown. <span style="color:#2ecc71">●</span> success <span style="color:#ff5a5f">●</span> fail · arrows = start → end.` + (noLoc ? ` ${noLoc} tag(s) have no location yet (click the pitch in the Code tab after tagging).` : '');
}
HOOKS.render.push(tab => { if (tab === 'maps' || (!tab && !$('#tab-maps').classList.contains('hidden'))) renderMaps(); });
['#mapTeam', '#mapPlayer', '#mapCode', '#mapPeriod', '#mapMode'].forEach(s => $(s).onchange = renderMaps);
$('#mapBox').addEventListener('click', e => { const c = e.target.closest('[data-mev]'); if (!c) return; const ev = events.find(x => x.id === Number(c.dataset.mev)); if (ev) { selectEvent(ev.id); if (hasVideo()) video.currentTime = ev.start; renderAll(); } });

/* ---------------------------------------------------------------- PDF MATCH REPORT */
function buildReportHTML() {
  const H = config.general.homeName, A = match.info.opponent || config.general.awayName;
  const homeEv = teamFilter(events, 'Home'), awayEv = teamFilter(events, 'Away');
  const goals = list => list.filter(e => e.outcomeId === 'goal' || /goal/i.test(e.outcome || '') || e.codeId === 'goal').length;
  const mins = minutesPlayed() || {};
  const codesFor = list => config.codes.filter(c => list.some(e => e.codeId === c.id));
  const teamRows = codesFor(events).map(c => {
    const h = homeEv.filter(e => e.codeId === c.id), a = awayEv.filter(e => e.codeId === c.id && e.playerId);
    const h1 = h.filter(e => evPeriod(e) === '1'), h2 = h.filter(e => evPeriod(e) === '2');
    const f = l => l.length + (pctOf(l) != null ? ` <small>(${Math.round(pctOf(l))}%)</small>` : '');
    return `<tr><td>${esc(c.name)}</td><td>${f(h1)}</td><td>${f(h2)}</td><td><b>${f(h)}</b></td>${awayEv.length ? `<td>${f(a)}</td>` : ''}</tr>`;
  }).join('');
  const kpis = config.kpis.map(k => { const v = kpiValue(k, events), ok = kpiPass(k, v); return `<tr><td>${esc(k.name)}</td><td>${esc(k.cmp)} ${esc(k.target)}${k.metric === 'pct' ? '%' : ''}</td><td>${v == null ? '—' : v + (k.metric === 'pct' ? '%' : '')}</td><td class="${ok ? 'g' : ok === false ? 'r' : ''}">${ok == null ? '' : ok ? '✓ met' : '✗ missed'}</td></tr>`; }).join('');
  const pe = homeEv.filter(e => e.playerId);
  const pcols = codesFor(pe).slice(0, 9);
  const players = [...new Map(pe.map(e => [e.playerId, e])).values()].sort((a, b) => (Number(a.num) || 999) - (Number(b.num) || 999));
  const playerRows = players.map(p => {
    const l = pe.filter(e => e.playerId === p.playerId);
    return `<tr><td>${esc(playerLabel(p))}${p.name ? ' <small>' + esc(p.name) + '</small>' : ''}</td><td>${mins[p.playerId] != null ? mins[p.playerId] : ''}</td>${pcols.map(c => { const x = l.filter(e => e.codeId === c.id); return `<td>${x.length || ''}${x.length && pctOf(x) != null ? ` <small>(${Math.round(pctOf(x))}%)</small>` : ''}</td>`; }).join('')}<td><b>${l.length}</b></td><td>${pctOf(l) != null ? Math.round(pctOf(l)) + '%' : ''}</td></tr>`;
  }).join('');
  const shots = homeEv.filter(e => e.codeId === 'shot' && e.x != null);
  const passes = homeEv.filter(e => ['pass', 'cross', 'keypass'].includes(e.codeId) && e.x != null);
  const located = homeEv.filter(e => e.x != null);
  const phases = durationRows(homeEv);
  const notes = sortedEvents().filter(e => e.note);
  const subs = match.subs.slice().sort((a, b) => a.t - b.t);
  const date = match.info.date ? new Date(match.info.date + 'T12:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Match report</title><style>
  *{box-sizing:border-box} body{font-family:"Segoe UI",Arial,sans-serif;color:#1b2430;margin:0;font-size:11.5px}
  .hdr{background:#0e1621;color:#fff;padding:18px 22px;border-radius:8px;display:flex;align-items:center;gap:18px}
  .hdr h1{margin:0;font-size:22px} .hdr .score{font-size:30px;font-weight:800;margin-left:auto;letter-spacing:2px}
  .hdr .sub{color:#9fb3c8;font-size:12px;margin-top:4px}
  h2{font-size:14px;margin:18px 0 6px;border-bottom:2px solid #3ea6ff;padding-bottom:3px}
  table{border-collapse:collapse;width:100%} th,td{border-bottom:1px solid #dde3ea;padding:4px 6px;text-align:center} th{background:#f0f4f8;font-size:11px}
  td:first-child,th:first-child{text-align:left} small{color:#6b7c8f} .g{color:#1e9e57;font-weight:700} .r{color:#d63c41;font-weight:700}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px} .card{border:1px solid #dde3ea;border-radius:8px;padding:8px;break-inside:avoid;page-break-inside:avoid}
  .card h3{margin:0 0 6px;font-size:12.5px} svg{width:100%;display:block;border-radius:6px}
  .pitchsvg .grass{fill:#2a7d45}.pitchsvg .ln{fill:none;stroke:rgba(255,255,255,.85);stroke-width:.35}
  .note{border-left:3px solid #f5b041;padding:3px 8px;margin:4px 0;background:#fffaf0}
  .foot{margin-top:18px;color:#8a99aa;font-size:10px;text-align:center} .pb{page-break-before:always}
  </style></head><body>
  <div class="hdr"><div><h1>${esc(H)} vs ${esc(A)}</h1><div class="sub">${esc([date, match.info.competition, match.info.venue].filter(Boolean).join(' · '))}</div></div>
  <div class="score">${goals(homeEv)} – ${goals(awayEv)}</div></div>
  ${kpis ? `<h2>KPIs</h2><table><tr><th>KPI</th><th>Target</th><th>Actual</th><th>Result</th></tr>${kpis}</table>` : ''}
  <h2>Team statistics</h2>
  <table><tr><th>Code</th><th>1st half</th><th>2nd half</th><th>${esc(H)} total</th>${awayEv.length ? `<th>${esc(A)}</th>` : ''}</tr>${teamRows || '<tr><td colspan="5">No tags</td></tr>'}</table>
  ${phases.length ? `<h2>Phases</h2><table><tr><th>Phase</th><th>Count</th><th>Total time</th><th>Average</th></tr>${phases.map(r => `<tr><td>${esc(r.code)}</td><td>${r.count}</td><td>${fmtTime(r.total)}</td><td>${fmtDur(r.total / r.count)}</td></tr>`).join('')}</table>` : ''}
  ${located.length ? `<div class="grid" style="margin-top:14px">
    <div class="card"><h3>Shot map</h3>${pitchMapSVG(shots, 'events')}<small>${shots.length} shots with location · green = on target / goal</small></div>
    <div class="card"><h3>Passes &amp; crosses</h3>${pitchMapSVG(passes, 'events')}<small>${passes.length} with location · red = unsuccessful</small></div>
    <div class="card"><h3>All actions – heatmap</h3>${pitchMapSVG(located, 'heat')}</div>
    <div class="card"><h3>All actions</h3>${pitchMapSVG(located, 'events')}</div></div>` : ''}
  ${players.length ? `<h2 class="pb">Players – ${esc(H)}</h2><table><tr><th>Player</th><th>Min</th>${pcols.map(c => `<th>${esc(c.name)}</th>`).join('')}<th>Total</th><th>Success</th></tr>${playerRows}</table>` : ''}
  ${subs.length ? `<h2>Substitutions</h2><table><tr><th>Time</th><th>Off</th><th>On</th></tr>${subs.map(s => `<tr><td>${esc(matchClock(s.t) || fmtTime(s.t))}</td><td>${esc(playerLabel(VOC.playersById[s.offId]))}</td><td>${esc(playerLabel(VOC.playersById[s.onId]))}</td></tr>`).join('')}</table>` : ''}
  ${notes.length ? `<h2>Coaching notes</h2>${notes.map(e => `<div class="note"><b>${esc(matchClock(e.t) || fmtTime(e.t))} – ${esc(eventText(e))}</b><br>${esc(e.note)}</div>`).join('')}` : ''}
  ${match.info.notes ? `<h2>Notes</h2><p>${esc(match.info.notes)}</p>` : ''}
  <div class="foot">Generated by VoiceTag ${APP_VERSION} · ${new Date().toLocaleString('en-GB')}</div>
  </body></html>`;
}
$('#btnReport').onclick = async () => {
  if (!events.length) { toast('No tags yet', 'bad'); return; }
  const name = [config.general.homeName, 'vs', match.info.opponent || config.general.awayName, match.info.date].filter(Boolean).join(' ') + ' - report.pdf';
  const p = await api.exportPdf({ html: buildReportHTML(), defaultName: name.replace(/[\\/:*?"<>|]/g, '') });
  if (p) toast('Report saved', 'ok');
};

/* ---------------------------------------------------------------- SEASON DATABASE */
const Season = { list: [], data: {}, sel: new Set(), loaded: false };
function loadLibrary() { try { Season.list = JSON.parse(localStorage.getItem('vt_library') || '[]'); } catch (e) { Season.list = []; } }
function saveLibrary() { try { localStorage.setItem('vt_library', JSON.stringify(Season.list)); } catch (e) { /* ignore */ } }
function addToLibrary(path, proj, text) {
  loadLibrary();
  const entry = { path, name: String(path).split(/[\\/]/).pop(), date: proj.match && proj.match.info ? proj.match.info.date : '', opponent: proj.match && proj.match.info ? proj.match.info.opponent : '', competition: proj.match && proj.match.info ? proj.match.info.competition : '', tags: (proj.events || []).length, savedAt: new Date().toISOString() };
  if (!api.isDesktop) entry.text = text;   // browser test mode keeps a copy
  Season.list = Season.list.filter(x => x.path !== path).concat([entry]);
  saveLibrary();
  Season.data[path] = proj; Season.sel.add(path);
}
async function loadSeasonData() {
  loadLibrary();
  const need = Season.list.filter(x => !Season.data[x.path]);
  const local = need.filter(x => x.text), remote = need.filter(x => !x.text).map(x => x.path);
  local.forEach(x => { try { Season.data[x.path] = JSON.parse(x.text); } catch (e) { /* ignore */ } });
  if (remote.length) (await api.readTextFiles(remote)).forEach(r => { if (r.text) { try { Season.data[r.path] = JSON.parse(r.text); } catch (e) { /* ignore */ } } else Season.data[r.path] = { missing: true, events: [] }; });
  if (!Season.loaded) { Season.list.forEach(x => Season.sel.add(x.path)); Season.loaded = true; }
}
function seasonPlayerKey(e) { return (e.team || 'Home') + '|' + (e.num !== '' && e.num != null ? e.num : '') + '|' + (e.name || e.pos || ''); }
function seasonEvents() {
  const out = [];
  Season.list.filter(x => Season.sel.has(x.path)).forEach(x => {
    const p = Season.data[x.path]; if (!p || !p.events) return;
    const mins = p.match ? minutesPlayed(Object.assign(EMPTY_MATCH(), p.match), p.events) : null;
    p.events.forEach(e => out.push({ ...e, _m: x, _mins: mins ? mins[e.playerId] : null }));
  });
  return out;
}
function lineChartSVG(points, label) {
  if (!points.length) return '<p class="muted small">No data.</p>';
  const W = 520, H = 180, P = 32, max = Math.max(1, ...points.map(p => p.v || 0));
  const x = i => P + (points.length === 1 ? (W - 2 * P) / 2 : i * (W - 2 * P) / (points.length - 1)), y = v => H - P - (v || 0) / max * (H - 2 * P);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#0b0f14" rx="6"/>
    <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="#2b3440"/><text x="${P}" y="16" fill="#8b97a5" font-size="11">${esc(label)} (max ${Math.round(max * 10) / 10})</text>
    <path d="${path}" fill="none" stroke="#3ea6ff" stroke-width="2"/>
    ${points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3.5" fill="#3ea6ff"><title>${esc(p.l)}: ${p.v == null ? '—' : p.v}</title></circle><text x="${x(i).toFixed(1)}" y="${H - 12}" fill="#8b97a5" font-size="9" text-anchor="middle">${esc(p.l.slice(0, 12))}</text>`).join('')}</svg>`;
}
async function renderSeason() {
  await loadSeasonData();
  const el = $('#tab-season');
  const rows = Season.list.slice().sort((a, b) => String(a.date || a.savedAt).localeCompare(String(b.date || b.savedAt)));
  const evs = seasonEvents();
  const team = Season.team || 'Home';
  const tev = evs.filter(e => (e.team || (e.playerId ? 'Home' : '')) === team && e.playerId);
  const codes = [...new Set(tev.map(e => e.code))];
  const pkeys = [...new Map(tev.map(e => [seasonPlayerKey(e), e])).entries()].sort((a, b) => (Number(a[1].num) || 999) - (Number(b[1].num) || 999));
  const showCodes = codes.slice(0, 8);
  const agg = pkeys.map(([k, p]) => {
    const l = tev.filter(e => seasonPlayerKey(e) === k);
    const games = new Set(l.map(e => e._m.path)).size;
    const minsByMatch = new Map(); l.forEach(e => { if (e._mins != null) minsByMatch.set(e._m.path, e._mins); });
    const mins = [...minsByMatch.values()].reduce((s, v) => s + v, 0);
    return `<tr><td>${esc(playerLabel(p))}${p.name ? ' <span class="muted">' + esc(p.name) + '</span>' : ''}</td><td>${games}</td><td>${mins || ''}</td>${showCodes.map(c => { const x = l.filter(e => e.code === c); const pc = pctOf(x); return `<td>${x.length || '·'}${x.length && pc != null ? ' <span class="muted">(' + Math.round(pc) + '%)</span>' : ''}</td>`; }).join('')}<td><b>${l.length}</b></td></tr>`;
  }).join('');
  const tp = Season.trendPlayer || (pkeys[0] && pkeys[0][0]) || '', tc = Season.trendCode || codes[0] || '', tm = Season.trendMetric || 'count';
  const points = rows.filter(r => Season.sel.has(r.path)).map(r => {
    const l = tev.filter(e => e._m.path === r.path && seasonPlayerKey(e) === tp && e.code === tc);
    const minsE = tev.find(e => e._m.path === r.path && seasonPlayerKey(e) === tp && e._mins != null);
    const v = tm === 'pct' ? pctOf(l) : tm === 'p90' ? (minsE && minsE._mins ? Math.round(l.length / minsE._mins * 90 * 10) / 10 : null) : l.length;
    return { l: (r.date || '') + ' ' + (r.opponent || r.name), v };
  });
  const sc = Season.searchCode || '', sp = Season.searchPlayer || '', sl = Season.searchLabel || '';
  const results = (sc || sp || sl) ? evs.filter(e => (!sc || e.code === sc) && (!sp || seasonPlayerKey(e) === sp) && (!sl || Object.entries(e.labels || {}).some(([g, v]) => g + '|' + v === sl) || (!sl.includes('|') && e.outcome === sl))).slice(0, 200) : [];
  const labelOpts = [...new Set(evs.flatMap(e => Object.entries(e.labels || {}).map(([g, v]) => g + '|' + v)))];
  const outcomeOpts = [...new Set(evs.map(e => e.outcome).filter(Boolean))];
  el.innerHTML = `
    <div class="toolbar"><button class="small" id="seAdd">+ Add match files</button><button class="small" id="seReload">↻ Reload</button>
      <span class="muted small">Saved projects are added automatically.</span></div>
    <table class="sum"><thead><tr><th></th><th>Date</th><th>Opponent</th><th>Tags</th><th></th></tr></thead><tbody>
    ${rows.map(r => `<tr><td><input type="checkbox" data-sesel="${esc(r.path)}" ${Season.sel.has(r.path) ? 'checked' : ''}></td><td>${esc(r.date || '—')}</td><td style="text-align:left">${esc(r.opponent || r.name)}${Season.data[r.path] && Season.data[r.path].missing ? ' <span class="bad small">file missing</span>' : ''}</td><td>${(Season.data[r.path] && Season.data[r.path].events || []).length || r.tags || 0}</td><td><button class="small" data-seopen="${esc(r.path)}">Open</button> <button class="small danger" data-sedel="${esc(r.path)}">✕</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No matches yet. Save a project (File → Save project) or add files.</td></tr>'}
    </tbody></table>
    <h4>Season totals <select id="seTeam" class="small"><option value="Home" ${team === 'Home' ? 'selected' : ''}>${esc(config.general.homeName)}</option><option value="Away" ${team === 'Away' ? 'selected' : ''}>${esc(config.general.awayName)}</option></select></h4>
    <div style="overflow:auto"><table class="sum"><thead><tr><th>Player</th><th>Games</th><th>Min</th>${showCodes.map(c => `<th>${esc(c)}</th>`).join('')}<th>All</th></tr></thead><tbody>${agg || '<tr><td class="muted">—</td></tr>'}</tbody></table></div>
    <h4>Trend</h4>
    <div class="toolbar"><select id="seTP">${pkeys.map(([k, p]) => `<option value="${esc(k)}" ${k === tp ? 'selected' : ''}>${esc(playerLabel(p) + (p.name ? ' ' + p.name : ''))}</option>`).join('')}</select>
      <select id="seTC">${codes.map(c => `<option ${c === tc ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select id="seTM"><option value="count" ${tm === 'count' ? 'selected' : ''}>Count</option><option value="pct" ${tm === 'pct' ? 'selected' : ''}>Success %</option><option value="p90" ${tm === 'p90' ? 'selected' : ''}>Per 90</option></select></div>
    <div class="chart">${lineChartSVG(points, tc + ' – ' + (tm === 'pct' ? 'success %' : tm === 'p90' ? 'per 90' : 'count'))}</div>
    <h4>Find clips across matches</h4>
    <div class="toolbar"><select id="seSC"><option value="">Any code</option>${[...new Set(evs.map(e => e.code))].map(c => `<option ${c === sc ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select id="seSP"><option value="">Any player</option>${[...new Map(evs.filter(e => e.playerId).map(e => [seasonPlayerKey(e), e])).entries()].map(([k, p]) => `<option value="${esc(k)}" ${k === sp ? 'selected' : ''}>${esc(playerLabel(p) + (p.name ? ' ' + p.name : ''))}</option>`).join('')}</select>
      <select id="seSL"><option value="">Any label / outcome</option>${outcomeOpts.map(o => `<option value="${esc(o)}" ${o === sl ? 'selected' : ''}>${esc(o)}</option>`).join('')}${labelOpts.map(o => `<option value="${esc(o)}" ${o === sl ? 'selected' : ''}>${esc(o.replace('|', ': '))}</option>`).join('')}</select></div>
    ${(sc || sp || sl) ? `<p class="small muted">${results.length} clip(s)</p><table class="sum"><tbody>${results.map(e => `<tr><td style="text-align:left">${esc(e._m.date || '')} ${esc(e._m.opponent || e._m.name)}</td><td>${esc(fmtTime(e.t))}</td><td style="text-align:left">${esc(eventText(e))}</td><td><button class="small" data-seclip="${esc(e._m.path)}|${e.id}">Open</button></td></tr>`).join('')}</tbody></table>` : '<p class="small muted">Pick a code, player or label to list matching clips from every selected match.</p>'}`;
  el.querySelectorAll('[data-sesel]').forEach(c => c.onchange = () => { c.checked ? Season.sel.add(c.dataset.sesel) : Season.sel.delete(c.dataset.sesel); renderSeason(); });
  el.querySelectorAll('[data-sedel]').forEach(b => b.onclick = () => { if (!confirm('Remove this match from the season list? (The file is not deleted.)')) return; Season.list = Season.list.filter(x => x.path !== b.dataset.sedel); delete Season.data[b.dataset.sedel]; saveLibrary(); renderSeason(); });
  el.querySelectorAll('[data-seopen]').forEach(b => b.onclick = () => openProjectFromSeason(b.dataset.seopen));
  el.querySelectorAll('[data-seclip]').forEach(b => b.onclick = () => { const i = b.dataset.seclip.lastIndexOf('|'); openProjectFromSeason(b.dataset.seclip.slice(0, i), Number(b.dataset.seclip.slice(i + 1))); });
  const bindSel = (id, key) => { const s = el.querySelector(id); if (s) s.onchange = () => { Season[key] = s.value; renderSeason(); }; };
  bindSel('#seTeam', 'team'); bindSel('#seTP', 'trendPlayer'); bindSel('#seTC', 'trendCode'); bindSel('#seTM', 'trendMetric');
  bindSel('#seSC', 'searchCode'); bindSel('#seSP', 'searchPlayer'); bindSel('#seSL', 'searchLabel');
  el.querySelector('#seReload').onclick = () => { Season.data = {}; renderSeason(); };
  el.querySelector('#seAdd').onclick = async () => {
    const files = await api.openTextFiles({ filters: [{ name: 'VoiceTag project', extensions: ['vtproj', 'json'] }] });
    let n = 0;
    (files || []).forEach(f => { try { const p = JSON.parse(f.text); if (p.app === 'VoiceTag') { addToLibrary(f.path, p, f.text); n++; } } catch (e) { /* ignore */ } });
    toast(n + ' match(es) added', 'info'); renderSeason();
  };
}
async function openProjectFromSeason(path, eventId) {
  await loadSeasonData();
  const p = Season.data[path];
  if (!p || p.missing) { alert('This project file could not be read:\n' + path); return; }
  await openProjectData(p, path, false);
  if (eventId) { const ev = events.find(e => e.id === eventId); if (ev) { selectEvent(ev.id); if (hasVideo()) setTimeout(() => { video.currentTime = ev.start; video.play(); }, 600); renderAll(); } }
}
HOOKS.render.push(tab => { if (tab === 'season') renderSeason(); });
