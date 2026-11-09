'use strict';
/* =====================================================================
   Match setup: info, periods, squad, substitutions, minutes played,
   syncing live tags to video, importing players.
   ===================================================================== */
const SQUAD_LABEL = { start: 'Starting XI', sub: 'Substitute', out: 'Not in squad' };
function squadSet(m = match) { return Object.values(m.squad || {}).some(v => v === 'start'); }
function playersOnPitch(t) {
  if (!squadSet()) return null;
  const on = new Set(Object.keys(match.squad).filter(id => match.squad[id] === 'start'));
  match.subs.slice().sort((a, b) => a.t - b.t).forEach(s => { if (s.t <= t) { if (s.offId) on.delete(s.offId); if (s.onId) on.add(s.onId); } });
  return on;
}
// Playing time in seconds from kick-off to video time t (breaks between periods are skipped)
function periodWindows(m = match, evs = events, vd = (hasVideo() ? (video.duration || 0) : 0)) {
  const list = PERIODS.filter(p => (m.kickoffs || {})[p] != null).map(p => ({ p, k: m.kickoffs[p], e: (m.ends || {})[p] })).sort((a, b) => a.k - b.k);
  list.forEach((w, i) => {
    if (w.e == null) w.e = list[i + 1] ? list[i + 1].k : Math.min(Math.max(w.k + PERIOD_LEN[w.p] * 60, ...evs.map(e => e.t)), Math.max(w.k + PERIOD_LEN[w.p] * 60, vd || 0));
  });
  return list;
}
function playedSeconds(t, m = match, evs = events) {
  const w = periodWindows(m, evs);
  if (!w.length) return Math.max(0, t);
  return w.reduce((s, x) => s + Math.max(0, Math.min(t, x.e) - x.k), 0);
}
function matchLengthSec(m = match, evs = events) {
  const w = periodWindows(m, evs);
  if (w.length) return w.reduce((s, x) => s + (x.e - x.k), 0);
  return 90 * 60;
}
// minutes played per player id (only when a starting XI is set)
function minutesPlayed(m = match, evs = events) {
  if (!squadSet(m)) return null;
  const total = matchLengthSec(m, evs), on = {}, mins = {};
  Object.keys(m.squad).forEach(id => { if (m.squad[id] === 'start') on[id] = 0; });
  (m.subs || []).slice().sort((a, b) => a.t - b.t).forEach(s => {
    const ps = playedSeconds(s.t, m, evs);
    if (s.offId && on[s.offId] != null) { mins[s.offId] = (mins[s.offId] || 0) + ps - on[s.offId]; delete on[s.offId]; }
    if (s.onId) on[s.onId] = ps;
  });
  Object.keys(on).forEach(id => { mins[id] = (mins[id] || 0) + total - on[id]; });
  Object.keys(mins).forEach(id => mins[id] = Math.round(mins[id] / 60));
  return mins;
}

/* ---------------------------------------------------------------- MATCH DIALOG */
function matchDialogHtml() {
  const i = match.info;
  const per = PERIODS.map(p => `<tr><td>${PERIOD_NAME[p]} ${p.startsWith('ET') ? '' : 'half'}</td>
    <td>${match.kickoffs[p] != null ? `<span class="tlink" data-mseek="${match.kickoffs[p]}">${fmtTime(match.kickoffs[p])}</span>` : '<span class="muted">—</span>'}</td>
    <td>${match.ends[p] != null ? `<span class="tlink" data-mseek="${match.ends[p]}">${fmtTime(match.ends[p])}</span>` : '<span class="muted">—</span>'}</td>
    <td><button class="small" data-setk="${p}">Kick-off = now</button> <button class="small" data-sete="${p}">End = now</button> <button class="small danger" data-clrp="${p}">Clear</button></td></tr>`).join('');
  const sel = p => `<select data-squad="${p.id}">${Object.entries(SQUAD_LABEL).map(([k, v]) => `<option value="${k}" ${(match.squad[p.id] || '') === k ? 'selected' : ''}>${v}</option>`).join('')}<option value="" ${!match.squad[p.id] ? 'selected' : ''}>—</option></select>`;
  const mins = minutesPlayed() || {};
  const team = t => config.players.filter(p => (p.team || 'Home') === t);
  const squadRows = list => list.map(p => `<tr><td>${esc(playerLabel(p))}</td><td class="muted">${esc(p.name)}</td><td>${sel(p)}</td><td class="muted">${mins[p.id] != null ? mins[p.id] + "'" : ''}</td></tr>`).join('');
  const subs = match.subs.slice().sort((a, b) => a.t - b.t).map(s => `<tr><td><span class="tlink" data-mseek="${s.t}">${esc(matchClock(s.t) || fmtTime(s.t))}</span></td><td>⬇ ${esc(playerLabel(VOC.playersById[s.offId]) || '—')}</td><td>⬆ ${esc(playerLabel(VOC.playersById[s.onId]) || '—')}</td><td><button class="small danger" data-delsub="${s.id}">✕</button></td></tr>`).join('');
  return `
  <h4 style="margin-top:0">Match info</h4>
  <div class="formgrid">
    <label>Date</label><input type="date" data-info="date" value="${esc(i.date)}">
    <label>Opponent</label><input data-info="opponent" value="${esc(i.opponent)}" placeholder="e.g. Watford U18">
    <label>Competition</label><input data-info="competition" value="${esc(i.competition)}" placeholder="e.g. PDL / EFL Youth Alliance">
    <label>Venue</label><select data-info="venue"><option ${i.venue === 'Home' ? 'selected' : ''}>Home</option><option ${i.venue === 'Away' ? 'selected' : ''}>Away</option><option ${i.venue === 'Neutral' ? 'selected' : ''}>Neutral</option></select>
  </div>
  <h4>Periods (video times)</h4>
  <table class="sq"><thead><tr><th>Period</th><th>Kick-off</th><th>End</th><th></th></tr></thead><tbody>${per}</tbody></table>
  <h4>Squad <span class="muted small">– Starting XI and substitutes give minutes played and per-90 stats</span></h4>
  <div class="toolbar"><button class="small" id="sqAllStart">First 11 home players = Starting XI, rest = subs</button></div>
  <table class="sq"><thead><tr><th>${esc(config.general.homeName)}</th><th></th><th></th><th>Mins</th></tr></thead><tbody>${squadRows(team('Home'))}</tbody></table>
  ${team('Away').length ? `<table class="sq" style="margin-top:8px"><thead><tr><th>${esc(config.general.awayName)}</th><th></th><th></th><th>Mins</th></tr></thead><tbody>${squadRows(team('Away'))}</tbody></table>` : ''}
  <h4>Substitutions</h4>
  <table class="sq"><thead><tr><th>Time</th><th>Off</th><th>On</th><th></th></tr></thead><tbody>${subs || '<tr><td colspan="4" class="muted">None yet – use ⇄ Sub in the Code window at the moment of the change.</td></tr>'}</tbody></table>
  <h4>Sync tags to video</h4>
  <p class="small muted">Tagged live (or the video was trimmed)? Pick a tag, move the video to where that moment really happens, then press Align – every tag, kick-off and sub moves by the same amount.</p>
  <div class="toolbar"><select id="syncEv" style="max-width:420px">${sortedEvents().map(e => `<option value="${e.id}">${fmtTime(e.t)} ${esc(eventText(e))}</option>`).join('')}</select>
    <button class="small" id="syncAlign">Align to current video time (${fmtTime(curT())})</button></div>
  <div class="toolbar"><span class="small">Or shift everything by</span><input type="number" id="syncSec" value="0" step="0.5" style="width:90px"><span class="small">seconds</span><button class="small" id="syncShift">Shift</button></div>`;
}
function shiftAll(d) {
  events.forEach(e => {
    e.t = Math.max(0, Math.round((e.t + d) * 100) / 100); e.start = Math.max(0, Math.round((e.start + d) * 100) / 100); e.end = Math.max(0.2, Math.round((e.end + d) * 100) / 100);
    (e.drawings || []).forEach(x => x.t = Math.max(0, Math.round((x.t + d) * 100) / 100));
  });
  PERIODS.forEach(p => { if (match.kickoffs[p] != null) match.kickoffs[p] = Math.max(0, match.kickoffs[p] + d); if (match.ends[p] != null) match.ends[p] = Math.max(0, match.ends[p] + d); });
  match.subs.forEach(s => s.t = Math.max(0, s.t + d));
  autosave(); renderAll();
}
function openMatchDialog() {
  const rerender = body => { body.innerHTML = matchDialogHtml(); bind(body); };
  const bind = body => {
    body.querySelectorAll('[data-info]').forEach(el => el.onchange = () => { match.info[el.dataset.info] = el.value; autosave(); });
    body.querySelectorAll('[data-squad]').forEach(el => el.onchange = () => { if (el.value) match.squad[el.dataset.squad] = el.value; else delete match.squad[el.dataset.squad]; autosave(); renderAll(); rerender(body); });
    body.querySelectorAll('[data-setk]').forEach(el => el.onclick = () => { match.kickoffs[el.dataset.setk] = Math.round(curT() * 100) / 100; autosave(); renderAll(); rerender(body); });
    body.querySelectorAll('[data-sete]').forEach(el => el.onclick = () => { match.ends[el.dataset.sete] = Math.round(curT() * 100) / 100; autosave(); renderAll(); rerender(body); });
    body.querySelectorAll('[data-clrp]').forEach(el => el.onclick = () => { delete match.kickoffs[el.dataset.clrp]; delete match.ends[el.dataset.clrp]; autosave(); renderAll(); rerender(body); });
    body.querySelectorAll('[data-delsub]').forEach(el => el.onclick = () => { match.subs = match.subs.filter(s => s.id !== el.dataset.delsub); autosave(); renderAll(); rerender(body); });
    body.querySelectorAll('[data-mseek]').forEach(el => el.onclick = () => { if (hasVideo()) video.currentTime = Number(el.dataset.mseek); });
    const all = body.querySelector('#sqAllStart');
    if (all) all.onclick = () => { config.players.filter(p => (p.team || 'Home') === 'Home').forEach((p, i) => match.squad[p.id] = i < 11 ? 'start' : 'sub'); autosave(); renderAll(); rerender(body); };
    body.querySelector('#syncAlign').onclick = () => {
      const ev = events.find(e => e.id === Number(body.querySelector('#syncEv').value));
      if (!ev) return;
      const d = curT() - ev.t;
      if (confirm(`Move every tag by ${d >= 0 ? '+' : ''}${d.toFixed(1)} s?`)) { shiftAll(d); toast('All tags shifted by ' + d.toFixed(1) + ' s', 'info'); rerender(body); }
    };
    body.querySelector('#syncShift').onclick = () => { const d = Number(body.querySelector('#syncSec').value) || 0; if (d) { shiftAll(d); toast('All tags shifted by ' + d + ' s', 'info'); rerender(body); } };
  };
  Dlg.open('📋 Match', matchDialogHtml(), [{ label: 'Done', primary: true }], { onOpen: bind, focus: false });
}
$('#btnMatch').onclick = openMatchDialog;

/* ---------------------------------------------------------------- SUBSTITUTION */
function openSubDialog() {
  const t = curT();
  const on = playersOnPitch(t);
  const homeAway = p => (p.team || 'Home');
  const offList = config.players.filter(p => !on || on.has(p.id));
  const onList = config.players.filter(p => !on || (!on.has(p.id) && match.squad[p.id] !== 'out'));
  const opts = list => '<option value="">—</option>' + list.map(p => `<option value="${p.id}">${esc((homeAway(p) === 'Away' ? '(opp) ' : '') + playerLabel(p) + (p.name ? ' – ' + p.name : ''))}</option>`).join('');
  let off = '', onId = '';
  Dlg.open('⇄ Substitution at ' + (matchClock(t) || fmtTime(t)), `
    ${on ? '' : '<p class="small warn">Tip: set the Starting XI in 📋 Match so VoiceTag knows who is on the pitch and can count minutes played.</p>'}
    <div class="formgrid"><label>Player OFF ⬇</label><select id="subOff">${opts(offList)}</select><label>Player ON ⬆</label><select id="subOn">${opts(onList)}</select></div>`,
  [{ label: 'Cancel' }, { label: 'Save substitution', primary: true, value: 'ok', onClick: () => { off = $('#subOff').value; onId = $('#subOn').value; if (!off && !onId) { alert('Choose at least one player.'); return false; } } }]).then(r => {
    if (r !== 'ok') return;
    match.subs.push({ id: uid(), t: Math.round(t * 100) / 100, offId: off, onId });
    if (onId && !match.squad[onId]) match.squad[onId] = 'sub';
    autosave(); renderAll();
    toast('⇄ ' + (off ? playerLabel(VOC.playersById[off]) + ' off' : '') + (off && onId ? ', ' : '') + (onId ? playerLabel(VOC.playersById[onId]) + ' on' : ''), 'info');
  });
}
$('#btnSub').onclick = openSubDialog;

/* ---------------------------------------------------------------- IMPORT PLAYERS (paste from Excel) */
function parsePlayerRows(text) {
  return String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
    const cells = line.split(/\t|;|,/).map(c => c.trim()).filter(c => c !== '');
    if (!cells.length) return null;
    let num = '', rest = cells;
    const ni = cells.findIndex(c => /^#?\d{1,3}$/.test(c));
    if (ni >= 0) { num = Number(cells[ni].replace('#', '')); rest = cells.filter((c, i) => i !== ni); }
    if (/^(no|number|#|name|player|position|pos)$/i.test(rest[0] || '') && !num) return null;   // header row
    return { num, name: rest[0] || '', pos: rest[1] || '' };
  }).filter(r => r && (r.num !== '' || r.name));
}
function openImportPlayers() {
  let txt = '', team = 'Home', mode = 'add';
  Dlg.open('⬆ Import players', `
    <p class="small muted">Copy the cells from Excel (or a team sheet) and paste them below. One player per line: <b>number, name, position</b> (any order of number; tab, comma or semicolon separated). The position is what you will say by voice; leave it out to use the name.</p>
    <textarea id="impText" placeholder="2\tJames Smith\tRight Back&#10;5\tLeo King\tCentre Back&#10;9, Sam Adu, Striker"></textarea>
    <div class="toolbar" style="margin-top:8px"><label>Team</label><select id="impTeam"><option value="Home">${esc(config.general.homeName)}</option><option value="Away">${esc(config.general.awayName)}</option></select>
    <label>Mode</label><select id="impMode"><option value="add">Add to the list</option><option value="replace">Replace this team’s players</option></select></div>
    <div id="impPrev" class="small muted"></div>`,
  [{ label: 'Cancel' }, { label: 'Import', primary: true, value: 'ok', onClick: () => { txt = $('#impText').value; team = $('#impTeam').value; mode = $('#impMode').value; if (!parsePlayerRows(txt).length) { alert('No players found in the pasted text.'); return false; } } }],
  { onOpen: b => { const ta = b.querySelector('#impText'); ta.oninput = () => { const r = parsePlayerRows(ta.value); b.querySelector('#impPrev').textContent = r.length + ' player(s): ' + r.slice(0, 6).map(x => (x.num !== '' ? '#' + x.num + ' ' : '') + (x.name || x.pos)).join(', ') + (r.length > 6 ? '…' : ''); }; } }).then(r => {
    if (r !== 'ok') return;
    const rows = parsePlayerRows(txt);
    if (mode === 'replace') config.players = config.players.filter(p => (p.team || 'Home') !== team);
    rows.forEach(x => {
      const p = { id: uid(), team, num: x.num, name: x.name, pos: x.pos || '', say: '', hotkey: '' };
      // opposition players: say "opposition seven" so they never clash with your own players
      p.say = team === 'Away' ? ['opposition ' + (numberWords(p.num) || ''), p.name ? 'opposition ' + p.name.split(/\s+/).pop().toLowerCase() : ''].filter(s => s.trim() !== 'opposition').join(', ') : autoSay(p);
      config.players.push(p);
    });
    saveConfig(); VOC = buildVocab(config); Voice.refreshVocabulary(); renderAll();
    toast('Imported ' + rows.length + ' players', 'ok');
  });
}
$('#btnImportPlayers').onclick = openImportPlayers;
