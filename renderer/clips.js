'use strict';
/* =====================================================================
   0.2: full event editor (edit / duplicate / delete) and a clip
   library built with In / Out points.
   ===================================================================== */
let clips = [];
const clipIO = { in: null, out: null };

/* ---------------------------------------------------------------- EVENT EDITOR */
function secInput(id, v) { return `<input id="${id}" type="number" step="0.04" min="0" value="${Math.round((v || 0) * 100) / 100}" style="width:110px"> <button class="small" data-now="${id}" title="Use current video time">⏱ now</button>`; }
function openEventEditor(id) {
  const ev = events.find(e => e.id === id);
  if (!ev) return;
  const code = VOC.codesById[ev.codeId];
  const outs = code ? code.outcomes : [];
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`;
  const labelRows = config.labelGroups.map(g => `<label>${esc(g.name)}</label><select data-lg="${esc(g.name)}">${opt('', '—', '')}${g.labels.map(l => opt(l.name, l.name, (ev.labels || {})[g.name])).join('')}</select>`).join('');
  const html = `<div class="formgrid" style="max-width:none;grid-template-columns:130px 1fr 130px 1fr">
    <label>Code</label><select id="eeCode">${config.codes.map(c => opt(c.id, c.name, ev.codeId)).join('')}${!code ? opt(ev.codeId, ev.code, ev.codeId) : ''}</select>
    <label>Team</label><select id="eeTeam">${TEAMS.map(t => opt(t, teamName(t), ev.team || 'Home')).join('')}</select>
    <label>Player</label><select id="eePlayer">${opt('', '—', ev.playerId)}${config.players.map(p => opt(p.id, (p.team === 'Away' ? '(opp) ' : '') + playerLabel(p) + (p.name ? ' – ' + p.name : ''), ev.playerId)).join('')}</select>
    <label>Outcome</label><select id="eeOut">${opt('', '—', ev.outcomeId)}${config.outcomes.map(o => opt(o.id, o.name + (outs.includes(o.id) ? '' : ' (not usual for this code)'), ev.outcomeId)).join('')}</select>
    <label>Event time (s)</label><div>${secInput('eeT', ev.t)}</div>
    <label>Period</label><select id="eePer">${opt('', 'auto from kick-offs', '')}${PERIODS.map(p => opt(p, PERIOD_NAME[p], match.kickoffs[p] != null ? '' : ev.period)).join('')}</select>
    <label>Clip start (s)</label><div>${secInput('eeS', ev.start)}</div>
    <label>Clip end (s)</label><div>${secInput('eeE', ev.end)}</div>
    <label>Location X / Y</label><div><input id="eeX" type="number" step="0.1" min="0" max="100" value="${ev.x != null ? ev.x : ''}" style="width:70px"> <input id="eeY" type="number" step="0.1" min="0" max="100" value="${ev.y != null ? ev.y : ''}" style="width:70px"> <span class="muted small">0-100</span></div>
    <label>End X / Y</label><div><input id="eeX2" type="number" step="0.1" min="0" max="100" value="${ev.x2 != null ? ev.x2 : ''}" style="width:70px"> <input id="eeY2" type="number" step="0.1" min="0" max="100" value="${ev.y2 != null ? ev.y2 : ''}" style="width:70px"></div>
    ${labelRows}
    <label>Description / note</label><textarea id="eeNote" style="grid-column:span 3;min-height:70px">${esc(ev.note || '')}</textarea>
  </div><p class="small muted">Match time: ${esc(matchClock(ev.t) || '—')} · source: ${esc(ev.source)}${ev.heard ? ' · heard “' + esc(ev.heard) + '”' : ''}</p>`;
  const read = () => {
    const g = id => $('#' + id).value, num = id => { const v = $('#' + id).value; return v === '' ? null : Number(v); };
    return { codeId: g('eeCode'), team: g('eeTeam'), playerId: g('eePlayer'), outcomeId: g('eeOut'), t: num('eeT'), start: num('eeS'), end: num('eeE'), period: g('eePer'),
      x: num('eeX'), y: num('eeY'), x2: num('eeX2'), y2: num('eeY2'), note: g('eeNote'),
      labels: Object.fromEntries([...document.querySelectorAll('#dlgBody [data-lg]')].map(s => [s.dataset.lg, s.value]).filter(x => x[1])) };
  };
  const apply = (target, v) => {
    const c = VOC.codesById[v.codeId];
    if (c) { target.codeId = c.id; target.code = c.name; target.type = c.type; }
    if (v.playerId) setPlayer(target, VOC.playersById[v.playerId]); else clearPlayer(target);
    target.team = v.playerId && VOC.playersById[v.playerId] ? (VOC.playersById[v.playerId].team || 'Home') : v.team;
    setOutcome(target, VOC.outcomesById[v.outcomeId] || null);
    if (v.t != null) target.t = Math.max(0, v.t);
    if (v.start != null) target.start = Math.max(0, v.start);
    if (v.end != null) target.end = Math.max(target.start + 0.2, v.end);
    if (v.period) target.period = v.period;
    ['x', 'y', 'x2', 'y2'].forEach(k => { if (v[k] == null) delete target[k]; else target[k] = clamp(v[k], 0, 100); });
    target.note = v.note.trim(); target.labels = v.labels;
  };
  let action = null;
  Dlg.open('✎ Edit event #' + ev.id, html, [
    { label: '🗑 Delete', danger: true, value: 'del', onClick: () => { if (!confirm('Delete this event?')) return false; action = 'del'; } },
    { label: '⧉ Duplicate', value: 'dup', onClick: () => { action = 'dup'; window.__ee = read(); } },
    { label: 'Cancel' },
    { label: 'Save', primary: true, value: 'ok', onClick: () => { action = 'ok'; window.__ee = read(); } }
  ], { onOpen: b => b.querySelectorAll('[data-now]').forEach(btn => btn.onclick = () => { b.querySelector('#' + btn.dataset.now).value = Math.round(curT() * 100) / 100; }) }).then(() => {
    if (!action) return;
    checkpoint();
    if (action === 'del') { events = events.filter(e => e.id !== ev.id); toast('Event deleted', 'info'); }
    else if (action === 'ok') { apply(ev, window.__ee); toast('Event updated', 'ok'); }
    else if (action === 'dup') {
      const copy = JSON.parse(JSON.stringify(ev)); copy.id = nextId++; copy.source = 'duplicate';
      apply(copy, window.__ee); events.push(copy); selectEvent(copy.id); lastNewId = copy.id; toast('Event duplicated', 'ok');
    }
    renderAll(); autosave();
  });
}

/* ---------------------------------------------------------------- CLIP IN / OUT */
function setClipIn() { clipIO.in = Math.round(curT() * 100) / 100; if (clipIO.out != null && clipIO.out <= clipIO.in) clipIO.out = null; toast('Clip IN ' + fmtTime(clipIO.in), 'info', 1200); renderTimeline(); }
function setClipOut() { clipIO.out = Math.round(curT() * 100) / 100; if (clipIO.in != null && clipIO.out <= clipIO.in) { toast('OUT must be after IN', 'bad'); clipIO.out = null; } else toast('Clip OUT ' + fmtTime(clipIO.out), 'info', 1200); renderTimeline(); }
async function makeClip() {
  if (clipIO.in == null || clipIO.out == null) { toast('Set IN ( [ ) and OUT ( ] ) first', 'bad', 2500); return; }
  const near = sortedEvents().filter(e => e.t >= clipIO.in - 2 && e.t <= clipIO.out + 2);
  let data = null;
  await Dlg.open('✂ New clip ' + fmtTime(clipIO.in) + ' – ' + fmtTime(clipIO.out), `<div class="formgrid">
    <label>Clip name</label><input id="ckName" value="${esc(near[0] ? eventText(near[0]) : 'Clip ' + (clips.length + 1))}">
    <label>Team</label><select id="ckTeam">${TEAMS.map(t => `<option value="${t}" ${t === curTeam ? 'selected' : ''}>${esc(teamName(t))}</option>`).join('')}</select>
    <label>Player</label><select id="ckPlayer"><option value="">—</option>${config.players.map(p => `<option value="${p.id}">${esc(playerLabel(p) + (p.name ? ' – ' + p.name : ''))}</option>`).join('')}</select>
    <label>Linked event</label><select id="ckEv"><option value="">—</option>${near.map(e => `<option value="${e.id}">${fmtTime(e.t)} ${esc(eventText(e))}</option>`).join('')}</select>
    <label>Description</label><textarea id="ckDesc" style="min-height:60px"></textarea></div>`,
  [{ label: 'Cancel' }, { label: 'Save clip', primary: true, value: 'ok', onClick: () => { data = { name: $('#ckName').value.trim() || 'Clip', team: $('#ckTeam').value, playerId: $('#ckPlayer').value, eventId: Number($('#ckEv').value) || null, desc: $('#ckDesc').value.trim() }; } }]);
  if (!data) return;
  checkpoint();
  const p = VOC.playersById[data.playerId];
  clips.push({ id: uid(), name: data.name, start: clipIO.in, end: clipIO.out, team: p ? p.team : data.team, playerId: p ? p.id : '', num: p ? p.num : '', pname: p ? p.name : '', pos: p ? p.pos : '', eventId: data.eventId, desc: data.desc, created: new Date().toISOString() });
  clipIO.in = clipIO.out = null;
  renderAll(); autosave(); toast('✂ Clip saved – see Playlist → Saved clips', 'ok', 2500);
}
$('#btnClipIn').onclick = setClipIn;
$('#btnClipOut').onclick = setClipOut;
$('#btnClipMake').onclick = makeClip;
HOOKS.key.push(e => {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  if (e.key === '[') { e.preventDefault(); setClipIn(); return true; }
  if (e.key === ']') { e.preventDefault(); setClipOut(); return true; }
  return false;
});
// saved clips appear in the playlist as items shaped like events
function clipItems() {
  return clips.slice().sort((a, b) => a.start - b.start).map(c => ({
    id: 'c_' + c.id, clipId: c.id, codeId: '__clip', code: c.name, type: 'clip', t: c.start, start: c.start, end: c.end,
    team: c.team, playerId: c.playerId, num: c.num, name: c.pname, pos: c.pos, outcome: '', outcomeId: '', labels: {}, note: c.desc, drawings: []
  }));
}
const plSource = () => (document.querySelector('input[name=plSrc]:checked') || {}).value || 'events';
$$('input[name=plSrc]').forEach(r => r.onchange = () => { PL.excluded.clear(); renderPlaylist(); });
HOOKS.render.push(() => { const c = $('#clipCount'); if (c) c.textContent = clips.length ? '(' + clips.length + ')' : ''; });
