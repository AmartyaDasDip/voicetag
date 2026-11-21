/* TACTIQ ANALYST – hybrid tracking editor (roadmap phase 0.6).
   Correct AI tracking without ever losing the original AI result:
   - corrected AI points keep their original value (point.orig), deleted AI points are kept in track.removed,
     every change is written to the corrections log (TR.log) and the raw AI run is saved in tracking_data/
   - track continuation suggestions, auto-link of broken tracks, swap identities from a moment, join / split
   - quick identity ("this is nine"), goalkeeper recognition, track timeline, next gap / next track end */
'use strict';

const isPlayerTrack = tk => tk.kind === 'player' || (tk.kind === 'other' && tk.role !== 'staff');   // people outside the pitch are never joined to players
const visPts = tk => tk.points.filter(p => p.vis === 'v' && p.x != null);

/* ---------------------------------------------------------------- merge / swap */
function mergeTracks(keep, other) {
  const fd = frameDur(), score = p => (p.src === 'manual' ? 2 : 0) + (p.conf == null ? 1 : p.conf);
  const pts = keep.points.slice();
  other.points.forEach(p => { const i = pts.findIndex(q => Math.abs(q.t - p.t) < fd * 0.51); if (i < 0) pts.push(p); else if (score(p) > score(pts[i])) pts[i] = p; });
  keep.points = pts.sort((a, b) => a.t - b.t);
  if (other.removed) keep.removed = (keep.removed || []).concat(other.removed);
  if (!keep.playerId && other.playerId) { keep.playerId = other.playerId; keep.team = other.team; }
  if ((keep.team === 'Neutral' || keep.kind === 'other') && (other.team === 'Home' || other.team === 'Away')) { keep.team = other.team; keep.kind = 'player'; }
  TR.tracks = TR.tracks.filter(x => x !== other);
  if (TR.sel === other.id) TR.sel = keep.id;
  logCorrection(keep, other.points.length ? other.points[0].t : 0, 'join', trackLabel(other));
  return keep;
}
// two players crossed and the AI swapped them: exchange everything from time t onwards
function swapTracksFrom(a, b, t) {
  const fd = frameDur() * 0.5;
  const aAfter = a.points.filter(p => p.t >= t - fd), bAfter = b.points.filter(p => p.t >= t - fd);
  a.points = a.points.filter(p => p.t < t - fd).concat(bAfter);
  b.points = b.points.filter(p => p.t < t - fd).concat(aAfter);
  logCorrection(a, t, 'swap', trackLabel(b));
}

/* ---------------------------------------------------------------- continuation */
function endInfo(tk) {
  const v = visPts(tk); if (v.length < 1) return null;
  const e = v[v.length - 1], back = v.filter(p => p.t >= e.t - 0.6 && p.t < e.t - 0.05);
  let vx = 0, vy = 0;
  if (back.length) { const s = back[0], dt = e.t - s.t; if (dt > 0.05) { vx = (e.x - s.x) / dt; vy = (e.y - s.y) / dt; } }
  return { p: e, vx, vy };
}
// candidates that could be the same person carrying on after this track ends
function continuations(tk, maxScore = 1.5) {
  if (!isPlayerTrack(tk)) return [];
  const end = endInfo(tk); if (!end) return [];
  const t1 = end.p.t, out = [];
  TR.tracks.forEach(c => {
    if (c === tk || !isPlayerTrack(c)) return;
    const v = visPts(c); if (!v.length) return;
    const s = v[0], gap = s.t - t1;
    // across a camera cut the same player can reappear much later – only offered with pitch positions, never auto-joined
    const acrossCut = typeof cutBetween === 'function' && gap > -0.3 && cutBetween(t1, s.t);
    if (gap < -0.3 || gap > (acrossCut ? 20 : 3)) return;
    if ((tk.team === 'Home' || tk.team === 'Away') && (c.team === 'Home' || c.team === 'Away') && tk.team !== c.team) return;
    if (tk.playerId && c.playerId && tk.playerId !== c.playerId) return;
    const g = Math.max(0, gap), px = end.p.x + end.vx * g, py = end.p.y + end.vy * g;
    let dist, tol, unit;
    const a = toPitch(t1, px, py), b = toPitch(s.t, s.x, s.y);
    if (acrossCut) {
      const la = toPitch(t1, end.p.x, end.p.y);           // last known pitch position (no extrapolation across a cut)
      if (!la || !b) return;
      dist = Math.hypot(la[0] - b[0], la[1] - b[1]); tol = 3 + 6 * Math.min(g, 10); unit = 'm';
    } else if (a && b) { dist = Math.hypot(a[0] - b[0], a[1] - b[1]); tol = 2 + 4 * g; unit = 'm'; }
    else { dist = Math.hypot(px - s.x, (py - s.y) * 0.56); tol = 0.02 + 0.04 * g; unit = 'img'; }
    let score = dist / tol + (acrossCut ? 0.5 : 0);
    if (tk.ai && c.ai && tk.ai.colour && c.ai.colour) score += colourGap(tk.ai.colour, c.ai.colour) / 150;
    if (tk.team !== c.team) score += 0.4;
    if (score <= maxScore) out.push({ tk: c, gap, dist, unit, score, acrossCut });
  });
  return out.sort((x, y) => x.score - y.score).slice(0, 5);
}
// a track that begins just after a camera cut (its identity is uncertain until someone confirms it)
function afterCutTrack(tk) {
  if (tk.playerId || !isPlayerTrack(tk)) return false;
  const v = visPts(tk); if (!v.length) return false;
  if (tk.ai && tk.ai.afterCut) return true;
  return typeof cutTimes === 'function' && cutTimes().some(c => v[0].t >= c - 0.05 && v[0].t - c <= 1.5);
}
// tracks that ended before a cut and could be this one
function predecessors(tk) {
  return TR.tracks.filter(o => o !== tk && isPlayerTrack(o)).map(o => ({ o, c: continuations(o, 2).find(c => c.tk === tk && c.acrossCut) })).filter(x => x.c).sort((a, b) => a.c.score - b.c.score).slice(0, 4);
}
function colourGap(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
// join every broken track whose best continuation is clear and mutual
function autoLinkPlan(maxScore = 0.7) {
  const plan = [], used = new Set();
  TR.tracks.filter(isPlayerTrack).map(tk => ({ tk, e: endInfo(tk) })).filter(x => x.e).sort((a, b) => a.e.p.t - b.e.p.t).forEach(({ tk }) => {
    if (used.has(tk.id)) return;
    const c = continuations(tk, maxScore).filter(x => !x.acrossCut)[0];      // never across a camera cut
    if (!c || used.has(c.tk.id)) return;
    // mutual check: no other ending track fits this start clearly better
    const rivals = TR.tracks.filter(o => o !== tk && o !== c.tk && isPlayerTrack(o) && !used.has(o.id)).map(o => continuations(o, maxScore).find(q => q.tk === c.tk && !q.acrossCut)).filter(Boolean);
    if (rivals.some(r => r.score < c.score)) return;
    plan.push([tk, c.tk, c]); used.add(c.tk.id);
  });
  return plan;
}
function autoLink() {
  let plan = autoLinkPlan();
  if (!plan.length) { toast('No broken tracks with a clear continuation found', 'info'); return; }
  if (!confirm(`Join ${plan.length} pairs of tracks that clearly belong to the same person? (You can undo with Ctrl+Z.)`)) return;
  checkpoint();
  let n = 0;
  // chains (A→B→C) are joined step by step: B may already have been merged into A
  for (let round = 0; round < 5 && plan.length; round++) {
    plan.forEach(([a, b]) => { const A = TR.tracks.includes(a) ? a : null, B = TR.tracks.includes(b) ? b : null; if (A && B) { mergeTracks(A, B); n++; } });
    plan = autoLinkPlan();
  }
  autosave(); renderTrackTab(); paintTracking(true);
  toast(`Joined ${n} broken tracks`, 'ok');
}
function nextTrackEnd() {
  if (!hasVideo()) return;
  const all = TR.tracks.flatMap(t => t.points.map(p => p.t)); if (!all.length) return;
  const dataEnd = Math.max(...all), now = video.currentTime + 0.15;
  let best = null;
  TR.tracks.filter(isPlayerTrack).forEach(tk => { const e = endInfo(tk); if (e && e.p.t > now && e.p.t < dataEnd - 0.5 && (!best || e.p.t < best.t)) best = { tk, t: e.p.t }; });
  if (!best) { toast('No more track ends after this moment', 'ok'); return; }
  TR.sel = best.tk.id; TR.settings.showAll = true; video.pause(); video.currentTime = best.t + frameDur() * 0.1;
  renderTrackTab(); paintTracking(true);
  const c = continuations(best.tk);
  toast(`${trackLabel(best.tk)} ends here` + (c.length ? ` – ${c.length} possible continuation(s) in the Track tab` : ' – no obvious continuation'), 'info', 3500);
}
function nextGapOf(tk) {
  if (!tk || !hasVideo() || !tk.points.length) return;
  const b = tk.points[tk.points.length - 1].t;
  let t = Math.max(video.currentTime + 0.1, tk.points[0].t), inGap = !posAt(tk, t);
  while (inGap && t <= b) { t += 0.1; inGap = !posAt(tk, t); }
  while (t <= b) { const q = posAt(tk, t); if (!q) { video.pause(); video.currentTime = Math.max(0, t - 0.1); toast(trackLabel(tk) + ': no position from ' + fmtTime(t) + ' – click the player (tracking mode) to fill it', 'info', 3000); return; } t += 0.1; }
  toast('No more gaps in ' + trackLabel(tk) + ' after this moment', 'ok');
}

/* ---------------------------------------------------------------- identity */
const NUM_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
function wordsToNum(text) {
  const d = (String(text).match(/\d+/) || [])[0]; if (d) return d;
  let n = null;
  String(text).toLowerCase().split(/[\s-]+/).forEach(w => { if (NUM_WORDS[w] != null) n = (n != null && n >= 20 && NUM_WORDS[w] < 10 ? n : 0) + NUM_WORDS[w]; });
  return n != null ? String(n) : null;
}
function playerFromText(text, team) {
  const cand = [];
  for (const variant of [text, 'number ' + text, 'player ' + text]) {
    const r = parseUtterance(variant);
    if (r.labelsOnly) r.labelsOnly.forEach(x => { if (x.kind === 'player') cand.push(x.v); });
    r.cmds.forEach(c => { if (c.player && c.player !== SAME_PLAYER && !c.code) cand.push(c.player); });
    if (cand.length) break;
  }
  const num = wordsToNum(text);
  if (!cand.length && num) { const q = config.players.find(x => String(x.num) === num && (!team || x.team === team)) || config.players.find(x => String(x.num) === num); if (q) cand.push(q); }
  let p = cand[0] || null;
  // numbers exist in both teams: prefer the track's team
  if (p && team && p.team !== team) { const same = config.players.find(q => q.team === team && String(q.num) === String(p.num) && p.num !== ''); p = same || null; }
  if (!p) { const low = text.toLowerCase().trim(); p = config.players.find(q => q.name && q.name.toLowerCase() === low) || null; }
  return p;
}
function assignIdentity(tk, p) {
  checkpoint();
  tk.playerId = p.id; tk.team = p.team || tk.team; if (tk.kind === 'other') tk.kind = 'player';
  logCorrection(tk, hasVideo() ? video.currentTime : 0, 'assign', playerLabel(p));
  autosave(); renderTrackTab(); paintTracking(true); render2D(true);
  const clash = TR.tracks.filter(o => o !== tk && o.playerId === p.id && overlapSec(o, tk) > 0.5);
  toast(`${trackLabel(tk)} assigned` + (clash.length ? ` – note: ${clash.length} other track(s) are also ${playerLabel(p)} at the same time` : ''), clash.length ? 'bad' : 'ok', 3500);
}
function overlapSec(a, b) {
  if (!a.points.length || !b.points.length) return 0;
  return Math.max(0, Math.min(a.points[a.points.length - 1].t, b.points[b.points.length - 1].t) - Math.max(a.points[0].t, b.points[0].t));
}
// voice or typed: "this is nine", "that is right back", "track is eleven"
function trackIdentityCommand(text) {
  const m = /^\s*(?:this|that|track)\s+(?:is|was)\s+(?:player\s+|number\s+)?(.+)$/i.exec(text || '');
  if (!m) return false;
  const tk = selTrack();
  if (!tk || tk.kind === 'ball') { toast('Select a track first (Track tab, or Tab in tracking mode)', 'bad'); return true; }
  const p = playerFromText(m[1], tk.team === 'Neutral' ? '' : tk.team);
  if (!p) { toast('No ' + (tk.team === 'Neutral' ? '' : teamName(tk.team) + ' ') + 'squad player matches “' + m[1] + '” (add players in Settings → Players)', 'bad', 3500); return true; }
  assignIdentity(tk, p);
  return true;
}

/* ---------------------------------------------------------------- restore AI */
function restoreAiPoint(tk, t) {
  const p = tk.points.find(q => Math.abs(q.t - t) < frameDur() * 0.51 && q.orig);
  if (!p) return false;
  checkpoint();
  Object.assign(p, { x: p.orig.x, y: p.orig.y, vis: p.orig.vis || 'v', conf: p.orig.conf, src: 'ai' }); delete p.orig;
  logCorrection(tk, p.t, 'restore');
  autosave(); paintTracking(true); renderTrackTab(); return true;
}
function restoreAiTrack(tk) {
  const corrected = tk.points.filter(p => p.orig).length, removed = (tk.removed || []).length, manual = tk.points.filter(p => p.src === 'manual' && !p.orig).length;
  if (!corrected && !removed) { toast('Nothing to restore in this track', 'info'); return; }
  if (!confirm(`Restore the AI result for ${trackLabel(tk)}: ${corrected} corrected point(s) back to the AI position and ${removed} deleted AI point(s) back?` + (manual ? ` (${manual} point(s) you added yourself are kept.)` : ''))) return;
  checkpoint();
  tk.points.forEach(p => { if (p.orig) { Object.assign(p, { x: p.orig.x, y: p.orig.y, vis: p.orig.vis || 'v', conf: p.orig.conf, src: 'ai' }); delete p.orig; } });
  const fd = frameDur() * 0.51;
  (tk.removed || []).forEach(r => { if (!tk.points.some(q => Math.abs(q.t - r.t) < fd)) tk.points.push(Object.assign({}, r, { src: 'ai', vis: r.vis || 'v' })); });
  tk.points.sort((a, b) => a.t - b.t); tk.removed = [];
  logCorrection(tk, tk.points.length ? tk.points[0].t : 0, 'restore', 'whole track');
  autosave(); renderTrackTab(); paintTracking(true);
}

/* ---------------------------------------------------------------- goalkeepers */
// someone outside both kit colours who stays in a penalty area is a goalkeeper; the team is the one whose
// players are, on average, nearer that goal
function findGoalkeepers() {
  const { L, W } = pitchDims(), out = [];
  const meanX = (team, a, b) => { let s = 0, n = 0; TR.tracks.forEach(tk => { if (tk.team !== team || tk.kind !== 'player') return; for (let t = a; t <= b; t += 1) { const q = posAt(tk, t); if (!q || q.kind === 'status') continue; const m = toPitch(t, q.x, q.y); if (m) { s += m[0]; n++; } } }); return n ? s / n : null; };
  TR.tracks.forEach(tk => {
    if (tk.kind === 'ball' || tk.kind === 'ref' || tk.playerId || tk.role === 'staff' || !(tk.kind === 'other' || tk.team === 'Neutral')) return;
    const v = visPts(tk); if (v.length < 5) return;
    const a = v[0].t, b = v[v.length - 1].t;
    let n = 0, inL = 0, inR = 0;
    for (let t = a; t <= b; t += 0.5) { const q = posAt(tk, t); if (!q || q.kind === 'status') continue; const m = toPitch(t, q.x, q.y); if (!m) continue; n++; if (Math.abs(m[1] - W / 2) <= 22) { if (m[0] <= 18) inL++; else if (m[0] >= L - 18) inR++; } }
    if (n < 4) return;
    const side = inL / n >= 0.7 ? 'left' : inR / n >= 0.7 ? 'right' : null; if (!side) return;
    const h = meanX('Home', a, b), aw = meanX('Away', a, b);
    let team = null;
    if (h != null && aw != null) team = (side === 'left') === (h < aw) ? 'Home' : 'Away';
    out.push({ tk, side, team });
  });
  return out;
}
function applyGoalkeepers(list, quiet) {
  list = list.filter(g => g.team);
  if (!list.length) { if (!quiet) toast('No goalkeeper found (needs a calibration and both teams tracked)', 'info', 3000); return 0; }
  if (!quiet) checkpoint();
  list.forEach(g => { g.tk.kind = 'player'; g.tk.team = g.team; g.tk.label = 'GK'; g.tk.color = ''; g.tk.role = ''; logCorrection(g.tk, g.tk.points[0].t, 'assign', 'goalkeeper ' + teamName(g.team)); });
  if (!quiet) { autosave(); renderTrackTab(); paintTracking(true); toast(list.map(g => 'GK ' + teamName(g.team) + ' (' + g.side + ' goal)').join(', '), 'ok', 3500); }
  return list.length;
}

/* ---------------------------------------------------------------- UI: selected-track tools + global tools */
function renderEditorBox() {
  const box = document.querySelector('#edBox'); if (!box) return;
  const tk = selTrack(), t = hasVideo() ? video.currentTime : 0;
  const nCorr = TR.tracks.reduce((s, x) => s + x.points.filter(p => p.orig).length + (x.removed || []).length, 0);
  let html = '';
  if (tk && tk.kind !== 'ball') {
    const here = tk.points.find(q => Math.abs(q.t - t) < frameDur() * 0.51);
    const cont = continuations(tk);
    const corr = tk.points.filter(p => p.orig).length + (tk.removed || []).length;
    const pred = afterCutTrack(tk) ? predecessors(tk) : [];
    html += `<div class="edbox">
      <div class="toolbar"><b>Who is ${esc(trackLabel(tk))}?</b><input id="edWho" placeholder="number or name, e.g. 9" style="width:150px"><button class="small primary" id="edWhoGo">Assign</button>
        <span class="small muted">or say / type “this is nine”</span></div>
      ${cont.length ? `<div class="small">Continues as: ${cont.map(c => `<button class="small chip ${c.acrossCut ? 'cutchip' : ''}" data-cont="${c.tk.id}" title="score ${c.score.toFixed(2)} – lower is better${c.acrossCut ? ' – after a camera cut: check before joining' : ''}">${c.acrossCut ? '⚠ after cut · ' : ''}${esc(trackLabel(c.tk))} · ${c.gap <= 0 ? 'overlaps' : '+' + c.gap.toFixed(1) + ' s'} · ${c.unit === 'm' ? c.dist.toFixed(1) + ' m' : Math.round(c.dist * 100) + '% wide'}</button>`).join(' ')}</div>` : ''}
      ${pred.length ? `<div class="small"><span class="badge cut">after a camera cut</span> identity uncertain – before the cut this may be: ${pred.map(x => `<button class="small chip cutchip" data-pred="${x.o.id}" title="${x.c.dist.toFixed(1)} m from where that player was last seen">${esc(trackLabel(x.o))} · ${x.c.dist.toFixed(1)} m · ${x.c.gap.toFixed(1)} s</button>`).join(' ')}</div>` : ''}
      <div class="toolbar">
        <button class="small" id="tkJoin" title="Two tracks are the same person: join them">⇄ Join with…</button>
        <button class="small" id="tkSplit" title="The track jumps to another person from here: cut it into a new track">✂ Split here</button>
        <button class="small" id="edSwap" title="Two players crossed and the AI swapped them: exchange both tracks from this moment">⇆ Swap with… from here</button>
        <button class="small" id="edGap" title="Jump to the next moment this track has no position">⏭ Next gap</button>
        ${here && here.orig ? '<button class="small" id="edRestore1" title="Put this point back where the AI had it">↺ AI position here</button>' : ''}
        ${corr ? `<button class="small" id="edRestoreAll" title="Undo all your corrections in this track and go back to the AI result">↺ Restore AI track (${corr})</button>` : ''}
      </div></div>`;
  }
  html += `<div class="toolbar">
    <button class="small" id="edEnd" title="Jump to the next place where a player's track stops – check how it continues">⏭ Next track end</button>
    <button class="small" id="edLink" title="Join broken tracks that clearly belong to the same person">🔗 Auto-link broken tracks</button>
    <button class="small" id="edRoles" title="With the pitch calibration: players only inside the pitch; referee, assistant referees, goalkeepers and people outside the pitch recognised">🧭 Who is who</button>
    <button class="small" id="edGK" title="Find goalkeepers among the 'other' tracks (needs a calibration)">🧤 Find goalkeepers</button>
    <button class="small" id="edLog" title="Every change made by hand to AI data">📝 Corrections (${(TR.log || []).length})</button>
    <label class="small" title="Show where the AI had every corrected point"><input type="checkbox" id="edOrig" ${TR.settings.showOrig ? 'checked' : ''}> show AI originals (${nCorr})</label>
    <label class="small"><input type="checkbox" id="edTl" ${TR.settings.timeline !== false ? 'checked' : ''}> track timeline</label></div>
    ${TR.settings.timeline !== false && TR.tracks.some(x => x.points.length) ? '<canvas id="trkTimeline" title="Track timeline – click a row to select the track and jump there. Green AI, orange unsure AI, blue by hand, magenta tick = corrected, grey = estimated between points, empty = no position."></canvas>' : ''}`;
  box.innerHTML = html;
  const b = (id, fn) => { const x = box.querySelector(id); if (x) x.onclick = fn; };
  const who = () => { const p = playerFromText(box.querySelector('#edWho').value, tk.team === 'Neutral' ? '' : tk.team); if (!p) { toast('No squad player matches that', 'bad'); return; } assignIdentity(tk, p); };
  b('#edWhoGo', who);
  const wi = box.querySelector('#edWho'); if (wi) wi.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') who(); };
  box.querySelectorAll('[data-pred]').forEach(x => x.onclick = () => { const o = TR.tracks.find(q => q.id === x.dataset.pred); if (!o) return; checkpoint(); mergeTracks(o, tk); TR.sel = o.id; autosave(); renderTrackTab(); paintTracking(true); toast('Joined across the cut: ' + trackLabel(o), 'ok'); });
  box.querySelectorAll('[data-cont]').forEach(x => x.onclick = () => { const o = TR.tracks.find(q => q.id === x.dataset.cont); if (!o) return; checkpoint(); mergeTracks(tk, o); autosave(); renderTrackTab(); paintTracking(true); toast('Joined', 'ok'); });
  b('#tkJoin', () => joinTracksDialog()); b('#tkSplit', () => splitTrackHere());
  b('#edSwap', () => swapDialog(tk)); b('#edGap', () => nextGapOf(tk));
  b('#edRestore1', () => restoreAiPoint(tk, t)); b('#edRestoreAll', () => restoreAiTrack(tk));
  b('#edEnd', nextTrackEnd); b('#edLink', autoLink); b('#edGK', () => applyGoalkeepers(findGoalkeepers())); b('#edRoles', sortOutRoles);
  b('#edLog', showCorrectionLog);
  const o = box.querySelector('#edOrig'); if (o) o.onchange = e => { TR.settings.showOrig = e.target.checked; paintTracking(true); };
  const tl = box.querySelector('#edTl'); if (tl) tl.onchange = e => { TR.settings.timeline = e.target.checked; renderTrackTab(); };
  drawTrackTimeline();
}
async function swapDialog(tk) {
  if (!hasVideo()) return;
  const t = video.currentTime;
  const others = TR.tracks.filter(x => x !== tk && isPlayerTrack(x) && x.points.some(p => p.t >= t - 0.5));
  if (!others.length) { toast('No other track continues after this moment', 'bad'); return; }
  const here = posAt(tk, t);
  others.sort((a, b) => { const d = x => { const q = posAt(x, t); return q && here && q.x != null && here.x != null ? Math.hypot(q.x - here.x, q.y - here.y) : 9; }; return d(a) - d(b); });
  let id = null;
  const r = await Dlg.open('⇆ Swap “' + trackLabel(tk) + '” from ' + fmtTime(t), `<p class="small muted">Everything from this moment on is exchanged between the two tracks. Nearest tracks first.</p>
    <select id="swSel" size="10" style="width:100%">${others.map((o, i) => `<option value="${o.id}" ${i === 0 ? 'selected' : ''}>${esc(trackLabel(o))} · ${esc(teamName(o.team))}</option>`).join('')}</select>`,
  [{ label: 'Cancel' }, { label: 'Swap', primary: true, value: 'ok', onClick: () => { id = $('#swSel').value; } }]);
  if (r !== 'ok') return;
  const o = TR.tracks.find(x => x.id === id); if (!o) return;
  checkpoint(); swapTracksFrom(tk, o, t); autosave(); renderTrackTab(); paintTracking(true);
  toast('Swapped from ' + fmtTime(t), 'ok');
}
function showCorrectionLog() {
  const log = (TR.log || []).slice().reverse();
  const names = { move: 'moved', add: 'added point', delete: 'deleted AI point', status: 'marked', join: 'joined with', split: 'split', swap: 'swapped with', assign: 'identified as', restore: 'restored AI', link: 'linked' };
  Dlg.open('📝 Corrections to AI tracking', log.length ? `<p class="small muted">${log.length} change(s), newest first. The original AI values are kept on every corrected point and the raw AI runs are saved in the project’s tracking_data folder. Click a row to jump there.</p>
    <div style="max-height:55vh;overflow:auto"><table class="sum"><thead><tr><th>Video time</th><th>Track</th><th>Change</th><th>When</th></tr></thead><tbody>
    ${log.slice(0, 400).map(l => `<tr data-lt="${l.t}" data-ltk="${esc(l.tk)}" style="cursor:pointer"><td>${fmtTime(l.t)}</td><td>${esc(l.label)}</td><td>${esc(names[l.act] || l.act)} ${esc(l.note)}</td><td class="muted">${new Date(l.at).toLocaleString()}</td></tr>`).join('')}</tbody></table></div>` : '<p>No corrections yet.</p>', [{ label: 'Close' }]);
  setTimeout(() => document.querySelectorAll('[data-lt]').forEach(r => r.onclick = () => { if (hasVideo()) { video.pause(); video.currentTime = Number(r.dataset.lt) + frameDur() * 0.1; } if (TR.tracks.some(x => x.id === r.dataset.ltk)) TR.sel = r.dataset.ltk; renderTrackTab(); paintTracking(true); }), 50);
}

/* ---------------------------------------------------------------- track timeline */
function timelineRows() {
  const order = { Home: 0, Away: 1, Neutral: 2 };
  return TR.tracks.filter(x => x.points.length).sort((a, b) => (a.kind === 'ball') - (b.kind === 'ball') || (order[a.team] || 0) - (order[b.team] || 0) || trackLabel(a).localeCompare(trackLabel(b), undefined, { numeric: true }));
}
// the bars are drawn once per data change into a hidden canvas (a full match has over a million points);
// a redraw only copies that picture and moves the white "now" line
const _tlImg = { key: '', cv: null, a: 0, b: 1 };
function drawTrackTimeline() {
  const cv = document.querySelector('#trkTimeline'); if (!cv) return;
  const rows = timelineRows(); if (!rows.length) return;
  const RH = 9, LW = 58, H = rows.length * RH + 4, W = cv.clientWidth || 320, dpr = devicePixelRatio || 1;
  const key = [Memo.rev, W, dpr, TR.sel, TR.settings.maxGap, rows.map(r => r.id).join(',')].join('|');
  if (_tlImg.key !== key) {
    const off = _tlImg.cv || document.createElement('canvas'); off.width = W * dpr; off.height = H * dpr;
    const ctx = off.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let a = Infinity, b = -Infinity; rows.forEach(r => { a = Math.min(a, r.points[0].t); b = Math.max(b, r.points[r.points.length - 1].t); });
    const span = Math.max(0.5, b - a), X = t => LW + (t - a) / span * (W - LW - 2);
    ctx.clearRect(0, 0, W, H); ctx.font = '8px Segoe UI, Arial'; ctx.textBaseline = 'middle';
    rows.forEach((tk, i) => {
      const y = i * RH + 2;
      if (tk.id === TR.sel) { ctx.fillStyle = 'rgba(46,204,113,.18)'; ctx.fillRect(0, y - 1, W, RH); }
      ctx.fillStyle = trackColor(tk); ctx.fillRect(1, y + 2, 4, RH - 5);
      ctx.fillStyle = '#ccc'; ctx.fillText(trackLabel(tk).slice(0, 10), 8, y + RH / 2 - 0.5);
      const gapMax = Number(tk.maxGap || TR.settings.maxGap || 3), pts = tk.points;
      // neighbouring pieces of the same colour are merged, so only a few hundred rectangles are drawn per track
      let run = null;
      const flush = () => { if (!run) return; ctx.globalAlpha = run.al; ctx.fillStyle = run.col; ctx.fillRect(run.x0, y + 1, Math.max(run.w0, run.x1 - run.x0), RH - 3); run = null; };
      const add = (x0, x1, col, al, w0) => { if (run && run.col === col && run.al === al && x0 <= run.x1 + 0.6) { if (x1 > run.x1) run.x1 = x1; return; } flush(); run = { x0, x1, col, al, w0 }; };
      const marks = [];
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k], n = pts[k + 1];
        const col = p.vis !== 'v' ? '#777' : p.src === 'manual' ? (p.orig ? '#ff4fd8' : '#4da3ff') : p.conf != null && p.conf < 0.4 ? '#f5b041' : '#2ecc71';
        const x0 = X(p.t);
        if (n && p.vis === 'v' && n.vis === 'v' && n.t - p.t <= gapMax) { const dense = n.t - p.t <= 0.35; add(x0, X(n.t), dense ? col : '#9aa5b5', dense ? 0.95 : 0.35, 1); }
        else add(x0, x0 + 1.5, col, 1, 1.5);
        if (p.orig) marks.push(x0);
      }
      flush();
      ctx.globalAlpha = 1; ctx.fillStyle = '#ff4fd8'; marks.forEach(x0 => ctx.fillRect(x0, y - 1, 1.5, RH));
      (tk.removed || []).forEach(r => { ctx.fillStyle = '#ff5a5f'; ctx.fillRect(X(r.t), y + RH - 3, 1.5, 2); });
      ctx.globalAlpha = 1;
    });
    Object.assign(_tlImg, { key, cv: off, a, b });
  }
  const { a, b } = _tlImg, span = Math.max(0.5, b - a), X = t => LW + (t - a) / span * (W - LW - 2);
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px'; }
  const ctx = cv.getContext('2d'); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); ctx.drawImage(_tlImg.cv, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (hasVideo() && video.currentTime >= a && video.currentTime <= b) { ctx.fillStyle = '#fff'; ctx.fillRect(X(video.currentTime) - 0.5, 0, 1, H); }
  cv.onclick = e => {
    const r = cv.getBoundingClientRect(), i = Math.floor((e.clientY - r.top - 2) / RH), row = rows[i];
    if (row) TR.sel = row.id;
    if (e.clientX - r.left > LW && hasVideo()) { video.pause(); video.currentTime = a + (e.clientX - r.left - LW) / (W - LW - 2) * span; }
    renderTrackTab(); paintTracking(true);
  };
}
let _tlTickAt = 0;
HOOKS.tick.push(() => {
  const now = performance.now(); if (now - _tlTickAt < 250) return; _tlTickAt = now;
  const cv = document.querySelector('#trkTimeline'); if (cv && cv.offsetParent) drawTrackTimeline();
});
