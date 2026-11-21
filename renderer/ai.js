/* TACTIQ ANALYST – AI player detection & tracking (phase 0.4).
   The heavy work runs in a background process (engine/worker.js); this file is the user interface:
   choose a range → analyse → map the two kit colours to Home/Away → import as editable tracks. */
'use strict';
const AI = { running: false, progress: null, info: null, last: null };

const rgbHex = c => c ? '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('') : '#888';

async function aiInfo() { if (!AI.info && api.aiInfo) { try { AI.info = await api.aiInfo(); } catch (e) { AI.info = null; } } return AI.info; }

function renderAiBox() {
  const box = document.querySelector('#aiBox');
  if (!box) return;
  const nAi = TR.tracks.filter(t => t.ai).length;
  if (!api.aiAnalyse) { box.innerHTML = '<p class="small muted">🤖 AI detection is available in the installed Windows app.</p>'; return; }
  if (AI.running) {
    const p = AI.progress;
    const pct = p ? Math.round(p.done / Math.max(1, p.total) * 100) : 0;
    box.innerHTML = `<div class="exportbox" style="margin:0 0 10px"><b>🤖 AI is analysing the video…</b>
      <div class="aibar"><div style="width:${pct}%"></div></div>
      <div class="small muted">${p && p.part ? `part ${p.part} · ` : ''}${p ? `${p.done} / ${p.total} frames · ${p.speed.toFixed(1)} frames/s · about ${aiDur(p.eta)} left` : 'Starting the AI engine…'}</div>
      <div class="toolbar"><button class="small danger" id="aiCancel">Cancel</button></div></div>`;
    box.querySelector('#aiCancel').onclick = () => api.aiCancel();
    return;
  }
  box.innerHTML = `<div class="toolbar"><button class="small primary" id="aiRun" title="Detect and follow every player automatically">🤖 Auto-detect players (AI)</button>
    ${nAi ? `<button class="small" id="aiLow" title="Jump to the next AI position the engine was unsure about">⚠ Next unsure point</button><button class="small danger" id="aiClear">Remove ${nAi} AI tracks</button>` : ''}
    ${AI.last ? `<button class="small" id="aiAgain" title="Import the last analysis again with different team choices">↺ Re-import last run</button>` : ''}</div>`;
  box.querySelector('#aiRun').onclick = aiStartDialog;
  const c = box.querySelector('#aiClear'); if (c) c.onclick = aiClearTracks;
  const l = box.querySelector('#aiLow'); if (l) l.onclick = aiNextLow;
  const a = box.querySelector('#aiAgain'); if (a) a.onclick = () => aiResultDialog(AI.last.result, AI.last.opts);
}
function aiDur(s) { s = Math.max(0, Math.round(s || 0)); return s >= 3600 ? Math.floor(s / 3600) + ' h ' + Math.round(s % 3600 / 60) + ' min' : s >= 60 ? Math.floor(s / 60) + ' min ' + (s % 60) + ' s' : s + ' s'; }

async function aiStartDialog() {
  if (!hasVideo() || !videoInfo || !videoInfo.path) { toast('Open a video first', 'bad'); return; }
  const info = await aiInfo();
  if (!info || !info.fast) { toast('The AI model files are missing from this installation', 'bad', 4000); return; }
  const dur = video.duration || 0, now = video.currentTime || 0;
  const hasIO = clipIO.in != null && clipIO.out != null;
  const def = info.recommended || 'fast';
  const cov = aiCalCoverage(now, Math.min(dur, now + 30));
  const html = `
    ${cov.ok ? `<p class="small" style="color:var(--ok)">✓ Pitch calibrated – only people inside the pitch will become players.</p>`
      : `<div class="warnbox"><b>Step 1: calibrate the pitch first.</b> The AI then tracks only the people <b>inside the pitch</b>: the referee is shown as REF,
        and the assistant referees, coaches and cameramen are left out. (You can also calibrate afterwards and re-import.)
        <div class="toolbar" style="margin-top:6px"><button class="small primary" id="aiCalNow">📐 Calibrate the pitch now</button></div></div>`}
    <p class="small muted">The AI finds every person on the pitch, follows them from frame to frame and splits them into two teams by shirt colour.
      The results become normal tracks you can correct, name and use in the 2D view, heat maps and exports. Works best on the wide (tactical / main) camera.</p>
    <h4>What to analyse</h4>
    <label class="blk"><input type="radio" name="aiRange" value="next" checked> From here (${fmtTime(now)}) for <input type="number" id="aiSecs" value="30" min="2" max="3600" style="width:70px"> seconds</label>
    ${hasIO ? `<label class="blk"><input type="radio" name="aiRange" value="io"> The clip IN–OUT marks (${fmtTime(clipIO.in)} – ${fmtTime(clipIO.out)})</label>` : '<p class="small muted">Tip: set clip IN <kbd>[</kbd> and OUT <kbd>]</kbd> to analyse exactly one phase.</p>'}
    <label class="blk"><input type="radio" name="aiRange" value="all"> The whole video (${fmtTime(dur)}) – this can take a long time</label>
    <h4>Settings</h4>
    <label class="blk">Model <select id="aiQ"><option value="fast" ${def === 'fast' ? 'selected' : ''}>Fast (smaller model – for 8 GB PCs)</option>
      ${info.accurate ? `<option value="accurate" ${def === 'accurate' ? 'selected' : ''}>Accurate (bigger model – finds far-away players better)</option>` : ''}</select></label>
    <label class="blk">Look at <select id="aiStride"><option value="1">every frame (slowest, smoothest)</option><option value="2" selected>every 2nd frame (recommended)</option><option value="3">every 3rd frame</option><option value="5">every 5th frame (fastest)</option></select></label>
    <label class="blk">Ball <select id="aiBallMode"><option value="zoom">Find the ball – zoom in for a second look (best, about 2× slower)</option><option value="normal">Find the ball – one look (faster)</option><option value="off">Players only</option></select></label>
    ${(TR.shots || []).length ? `<label class="blk"><input type="checkbox" id="aiWide" checked> Only wide / medium camera shots – skip close-ups, replays and other shots (from the 📺 shot list)</label>` : ''}
    <label class="blk"><input type="checkbox" id="aiCpu"> Use the processor only (tick this if the graphics card causes problems)</label>
    <p class="small muted">This PC: ${info.ramGB} GB RAM, ${info.cores} processor threads. ${info.gpu ? 'The graphics card is used automatically when possible (DirectX 12).' : ''} You can keep tagging while it runs.</p>`;
  let opts = null;
  const pr = Dlg.open('🤖 Auto-detect players', html, [{ label: 'Cancel' }, { label: 'Start', primary: true, value: 'go', onClick: () => {
    const b = $('#dlgBody'), mode = b.querySelector('input[name=aiRange]:checked').value;
    let start = now, d = Number(b.querySelector('#aiSecs').value) || 30;
    if (mode === 'io') { start = clipIO.in; d = clipIO.out - clipIO.in; }
    if (mode === 'all') { start = 0; d = dur; }
    d = Math.min(d, Math.max(0.5, dur - start));
    opts = { start: Math.round(start * 1000) / 1000, duration: Math.round(d * 1000) / 1000, quality: b.querySelector('#aiQ').value, stride: Number(b.querySelector('#aiStride').value), cpuOnly: b.querySelector('#aiCpu').checked, ball: b.querySelector('#aiBallMode').value, wideOnly: !!(b.querySelector('#aiWide') && b.querySelector('#aiWide').checked) };
  } }]);
  const cb = $('#dlgBody').querySelector('#aiCalNow');
  if (cb) cb.onclick = () => { $('#dlgX').click(); setTimeout(() => openCalibration(null), 300); toast('Click the pitch landmarks you can see – then start 🤖 Auto-detect players again', 'info', 6000); };
  const r = await pr;
  if (r !== 'go' || !opts) return;
  aiRun(opts);
}

// the selected range, cut into the usable (wide / medium) camera shots when asked
function aiPieces(opts) {
  const a = opts.start, b = opts.start + opts.duration;
  if (!opts.wideOnly || !(TR.shots || []).length) return [[a, b]];
  const out = [];
  sortedShots().forEach(sh => {
    if (!trackableShot(sh)) return;
    const s = Math.max(a, sh.t0), e = Math.min(b, sh.t1);
    if (e - s < 0.5) return;
    const last = out[out.length - 1];
    if (last && s - last[1] < 0.05) last[1] = e; else out.push([s, e]);
  });
  return out;
}
async function aiRunPieces(opts) {
  const pieces = aiPieces(opts), base = { video: videoInfo.playPath || videoInfo.path };
  if (!pieces.length) return { ok: false, error: 'There is no wide or medium camera shot in the selected range.' };
  if (pieces.length === 1 && !opts.wideOnly) return api.aiAnalyse(Object.assign(base, opts));
  const results = [];
  for (let i = 0; i < pieces.length; i++) {
    api.onAiProgress(p => { AI.progress = Object.assign({}, p, { part: (i + 1) + '/' + pieces.length }); renderAiBox(); });
    const r = await api.aiAnalyse(Object.assign({}, base, opts, { start: pieces[i][0], duration: pieces[i][1] - pieces[i][0] }));
    if (!r || !r.ok) return r;
    results.push(r);
  }
  // one combined result: track ids and camera shots kept apart per piece
  const first = results[0], m = first.meta;
  const comb = { ok: true, tracks: [], ball: [], camera: [], cutTimes: [], clusters: first.clusters, ballStats: Object.assign({}, first.ballStats, { found: 0, frames: 0, fromZoom: 0 }),
    meta: Object.assign({}, m, { start: opts.start, duration: opts.duration, frames: 0, seconds: 0, pieces: pieces.length }) };
  results.forEach((r, i) => {
    r.tracks.forEach(t => comb.tracks.push(Object.assign({}, t, { id: (i + 1) * 100000 + t.id })));
    comb.ball.push(...r.ball); comb.cutTimes.push(...(r.cutTimes || []));
    if (i) comb.cutTimes.push(pieces[i][0]);
    (r.camera || []).forEach(p => comb.camera.push([p[0], p[1], p[2], 'p' + i + '_' + (p[3] || 0)]));
    comb.meta.frames += r.meta.frames; comb.meta.seconds += r.meta.seconds;
    if (r.ballStats) { comb.ballStats.found += r.ballStats.found; comb.ballStats.frames += r.ballStats.frames; comb.ballStats.fromZoom += r.ballStats.fromZoom || 0; }
  });
  comb.meta.seconds = Math.round(comb.meta.seconds * 10) / 10;
  comb.meta.framesPerSecond = Math.round(comb.meta.frames / Math.max(0.1, comb.meta.seconds) * 10) / 10;
  comb.ballStats.coverage = Math.round(comb.ballStats.found / Math.max(1, comb.ballStats.frames) * 1000) / 10;
  return comb;
}
async function aiRun(opts) {
  AI.running = true; AI.progress = null; renderAiBox();
  api.onAiProgress(p => { AI.progress = p; renderAiBox(); });
  toast('AI analysis started – you can keep working', 'info', 2500);
  let res;
  try { res = await aiRunPieces(opts); }
  catch (e) { res = { ok: false, error: String(e && e.message || e) }; }
  AI.running = false; AI.progress = null; renderTrackTab();
  if (!res || !res.ok) { if (res && res.error === 'cancelled') toast('AI analysis cancelled', 'info'); else Dlg.open('AI analysis failed', `<p>${esc(res && res.error || 'Unknown error')}</p><p class="small muted">Try “Use the processor only”, the Fast model, or a shorter range.</p>`); return; }
  AI.last = { result: res, opts };
  // keep the raw result with the project, so nothing is lost if the import is changed later
  if (project && project.dir && api.writeText) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    api.writeText({ file: project.dir + '/tracking_data/ai_run_' + stamp + '.json', text: JSON.stringify({ opts, result: res }) }).catch(() => {});
  }
  aiResultDialog(res, opts);
}

function aiOffPitchShare(tr) {
  let n = 0, off = 0;
  const { L, W } = pitchDims();
  tr.points.forEach(p => { const q = toPitch(p.t, p.x, p.y); if (!q) return; n++; if (q[0] < -4 || q[0] > L + 4 || q[1] < -4 || q[1] > W + 4) off++; });
  return n >= 3 ? off / n : null;
}

// does the range have a pitch calibration? (each wide / medium camera shot needs its own)
function aiCalCoverage(t0, t1) {
  const cals = TR.cals.filter(c => c.type !== 'none' && c.H);
  if (!cals.length) return { ok: false, shots: 0, done: 0 };
  if ((TR.shots || []).length) {
    const sh = sortedShots().filter(x => trackableShot(x) && x.t1 > t0 + 0.2 && x.t0 < t1 - 0.2);
    const done = sh.filter(x => cals.some(c => c.t >= x.t0 - 0.01 && c.t < x.t1)).length;
    return { ok: done > 0, shots: sh.length, done };
  }
  const before = sortedCals().filter(c => c.t <= t0 + 1e-6).pop();
  return { ok: !!(before && before.type !== 'none') || cals.some(c => c.t > t0 && c.t < t1), shots: 0, done: 0 };
}

// camera cuts, shot boundaries and camera movement of a run go into the project first: the calibration follows
// the camera with them, and the "who is who" decision needs the calibration at every moment of the run
function aiApplyCamera(res, run) {
  const m = res.meta, t0 = m.start, t1 = m.start + m.duration;
  if (res.cutTimes && res.cutTimes.length) TR.cuts = [...new Set((TR.cuts || []).filter(c => c < t0 - 0.01 || c > t1 + 0.01).concat(res.cutTimes.map(c => Math.round(c * 1000) / 1000)))].sort((a, b) => a - b);
  // the AI looks at the cut frame by frame: move the shot boundaries of the (coarser) shot scan onto it
  if (res.cutTimes && res.cutTimes.length && (TR.shots || []).length) {
    const s = sortedShots();
    res.cutTimes.forEach(c => { for (let i = 1; i < s.length; i++) if (c < s[i].t0 && s[i].t0 - c < 0.2 && c > s[i - 1].t0 + 0.2) { s[i - 1].t1 = c; s[i].t0 = c; } });
    TR.shots = s;
  }
  if (res.camera && res.camera.length) {
    if (!TR.camera) TR.camera = [];
    TR.camera = TR.camera.map(sg => ({ id: sg.id, pts: sg.pts.filter(p => p[0] < t0 - 0.01 || p[0] > t1 + 0.01) })).filter(sg => sg.pts.length > 1);
    const bySeg = new Map(); res.camera.forEach(p => { const k = run + ':' + (p[3] || 0); if (!bySeg.has(k)) bySeg.set(k, []); bySeg.get(k).push([p[0], p[1], p[2]]); });
    bySeg.forEach((pts, id) => { if (pts.length > 1) TR.camera.push({ id, pts }); });
  }
}
// who is who, without changing the project yet (for the result dialog)
function aiPreviewRoles(res) {
  const saved = { cuts: TR.cuts, shots: TR.shots, camera: TR.camera };
  try {
    TR.cuts = (TR.cuts || []).slice(); TR.shots = (TR.shots || []).map(x => Object.assign({}, x)); TR.camera = (TR.camera || []).map(sg => ({ id: sg.id, pts: sg.pts }));
    aiApplyCamera(res, 'preview');
    return classifyAiTracks(res);
  } finally { TR.cuts = saved.cuts; TR.shots = saved.shots; TR.camera = saved.camera; }
}
const aiRoleCount = (roles, role, team) => [...roles.values()].filter(r => r.role === role && (team === undefined || r.team === team)).length;

async function aiResultDialog(res, opts) {
  const m = res.meta, tracks = res.tracks;
  const cl = res.clusters || [];
  const cov = aiCalCoverage(m.start, m.start + m.duration);
  const roles = cov.ok ? aiPreviewRoles(res) : null;
  const cnt = k => roles ? aiRoleCount(roles, 'player', k) : tracks.filter(t => t.team === k).length;
  const prevAi = TR.tracks.filter(t => t.ai).length;
  const hexRgb = h => { const x = /^#?([0-9a-f]{6})$/i.exec(h || ''); return x ? [0, 2, 4].map(i => parseInt(x[1].substr(i, 2), 16)) : null; };
  const d = (a, b) => a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : 0;
  const hc = hexRgb(config.general.homeColor), ac = hexRgb(config.general.awayColor);
  const swap = cl.length === 2 && hc && ac && d(cl[0], hc) + d(cl[1], ac) > d(cl[0], ac) + d(cl[1], hc);
  const rc = r => roles ? aiRoleCount(roles, r) : 0;
  const roleRows = roles ? `
    <table class="aimap"><tr><th>Who</th><th>Tracks</th><th></th></tr>
      <tr><td>🧤 Goalkeepers</td><td>${rc('gk')}</td><td class="small muted">a third kit that stays in a penalty area → player of the team defending that goal</td></tr>
      <tr><td>⬛ Referee</td><td>${rc('ref')}</td><td class="small muted">shown as REF, never as a player</td></tr>
      <tr><td>🚩 Assistant referees</td><td>${rc('ar')}</td><td class="small muted">on the touchlines – not players</td></tr>
      <tr><td>🚫 Outside the pitch</td><td>${rc('staff')}</td><td class="small muted">coaches, substitutes, ball boys, cameramen – not players</td></tr>
      ${rc('unknown') ? `<tr><td>❔ Not sure</td><td>${rc('unknown')}</td><td class="small muted">inside the pitch, but neither team kit – imported hidden; give them a team with ✎</td></tr>` : ''}
      ${rc('nocal') ? `<tr><td>📐 No pitch position</td><td>${rc('nocal')}</td><td class="small muted">seen only where the pitch is not calibrated and not a team kit – imported hidden; calibrate that moment and use 🧭 Who is who</td></tr>` : ''}
    </table>` : '';
  const html = `
    <p>Analysed <b>${fmtTime(m.start)} – ${fmtTime(m.start + m.duration)}</b>: ${m.frames} frames in ${aiDur(m.seconds)} (${m.framesPerSecond} frames/s, ${m.provider === 'dml' ? 'graphics card' : 'processor'}, ${esc(m.model)}).</p>
    <p>Found <b>${tracks.length}</b> people${res.ball.length ? ` and the ball in ${res.ball.length} of ${m.frames} frames (${res.ballStats ? res.ballStats.coverage : Math.round(res.ball.length / m.frames * 100)}%)` : ''}.
      ${res.ballStats && res.ballStats.mode === 'zoom' ? `<span class="small muted">${res.ballStats.fromZoom != null ? `${res.ballStats.fromZoom} of these were found only by the zoomed second look.` : ''}</span>` : ''}</p>
    ${roles ? `<p class="small" style="color:var(--ok)">✓ The pitch is calibrated: only people <b>inside the pitch</b> become players. Referee, assistant referees and everybody outside the lines are recognised and kept apart.</p>`
      : `<div class="warnbox"><b>⚠ The pitch is not calibrated for this part of the video.</b><br>Without the pitch the AI cannot tell players from the referee, the assistant referees on the touchline, coaches or cameramen – they would all be counted.
        <b>Calibrate the pitch first</b>, then press <b>↺ Re-import last run</b> (the analysis is kept – no need to run it again).
        <div class="toolbar" style="margin-top:6px"><button class="small primary" id="aiCalFirst">📐 Calibrate the pitch first</button></div></div>`}
    <h4>Which team is which?</h4>
    <table class="aimap"><tr><th>Kit colour</th><th>Players</th><th>Import as</th></tr>
      ${['A', 'B'].map((k, i) => `<tr><td><span class="swatch" style="background:${rgbHex(cl[i])}"></span> Group ${k}</td><td>${cnt(k)}</td>
        <td><select id="aiMap${k}"><option value="Home" ${(i === 0) !== swap ? 'selected' : ''}>${esc(teamName('Home'))}</option><option value="Away" ${(i === 1) !== swap ? 'selected' : ''}>${esc(teamName('Away'))}</option><option value="skip">don’t import</option></select></td></tr>`).join('')}
      ${roles ? '' : `<tr><td><span class="swatch" style="background:#bbb"></span> Other kits (referees, keepers, staff)</td><td>${tracks.filter(t => t.team === 'other').length}</td>
        <td><select id="aiMapO"><option value="Neutral">hidden “other” tracks</option><option value="skip">don’t import</option></select></td></tr>`}</table>
    ${roleRows}
    <p class="small muted">Tip: set each team’s kit colour in Match / project details and the right team is picked for you next time.</p>
    <h4>Options</h4>
    <label class="blk">Ignore tracks shorter than <input type="number" id="aiMin" value="1" min="0" max="30" step="0.5" style="width:60px"> seconds</label>
    <label class="blk"><input type="checkbox" id="aiBall" ${res.ball.length ? 'checked' : 'disabled'}> Import the ball (gaps up to 1 s are estimated; check it with ⏭ Next ball gap)</label>
    ${roles ? `<label class="blk"><input type="checkbox" id="aiKeepOff"> Also keep the assistant referees and the people outside the pitch (as hidden tracks)</label>` : ''}
    ${prevAi ? `<label class="blk"><input type="checkbox" id="aiReplace" checked> Replace the ${prevAi} AI tracks already in this range</label>` : ''}`;
  let choice = null;
  const p = Dlg.open('🤖 AI results', html, [{ label: 'Discard' }, { label: 'Import tracks', primary: true, value: 'imp', onClick: () => {
    const b = $('#dlgBody'), o = b.querySelector('#aiMapO');
    choice = { A: b.querySelector('#aiMapA').value, B: b.querySelector('#aiMapB').value, other: o ? o.value : 'Neutral',
      min: Number(b.querySelector('#aiMin').value) || 0, ball: b.querySelector('#aiBall').checked,
      keepOff: !!(b.querySelector('#aiKeepOff') && b.querySelector('#aiKeepOff').checked),
      replace: !!(b.querySelector('#aiReplace') && b.querySelector('#aiReplace').checked) };
  } }]);
  const cf = $('#dlgBody') && $('#dlgBody').querySelector('#aiCalFirst');
  if (cf) cf.onclick = () => {
    $('#dlgX').click();
    video.pause(); video.currentTime = m.start + Math.min(1, m.duration / 2);
    toast('Click the pitch landmarks you can see. Afterwards: Track tab → ↺ Re-import last run', 'info', 6000);
    setTimeout(() => openCalibration(null), 400);
  };
  const r = await p;
  if (r !== 'imp' || !choice) return;
  aiImport(res, choice);
}

function aiImport(res, ch) {
  checkpoint();
  const m = res.meta, t0 = m.start, t1 = m.start + m.duration, run = 'ai' + Date.now().toString(36);
  if (ch.replace) TR.tracks.forEach(tk => { if (tk.ai) tk.points = tk.points.filter(p => p.src !== 'ai' || p.t < t0 - 0.01 || p.t > t1 + 0.01); });
  TR.tracks = TR.tracks.filter(tk => !tk.ai || tk.points.length);
  // camera first: cuts, shot boundaries and camera movement (the calibration follows the camera with them)
  aiApplyCamera(res, run);
  const roles = aiCalCoverage(t0, t1).ok ? classifyAiTracks(res) : null;
  const counters = {}, n = { player: 0, gk: 0, ref: 0, ar: 0, staff: 0, unknown: 0, short: 0, left: 0 };
  const label = team => { counters[team] = (counters[team] || 0) + 1; return (team === 'Home' ? 'H' : team === 'Away' ? 'A' : 'X') + counters[team]; };
  const gks = [];
  res.tracks.forEach(tr => {
    if (tr.points[tr.points.length - 1].t - tr.points[0].t < ch.min) { n.short++; return; }
    const ro = roles ? roles.get(tr.id) : { role: tr.team === 'A' || tr.team === 'B' ? 'player' : 'unknown', team: tr.team === 'other' ? null : tr.team };
    const role = ro ? (ro.role === 'nocal' ? 'unknown' : ro.role) : 'unknown';
    const ai = { run, id: tr.id, colour: tr.colour, interrupted: !!tr.interrupted, afterCut: !!tr.afterCut, role, why: ro && ro.why };
    let tk = null;
    if (role === 'player') {
      const team = ch[ro.team]; if (!team || team === 'skip') { n.left++; return; }
      tk = newTrack({ team, kind: 'player', label: label(team), ai });
    } else if (role === 'gk') {
      tk = newTrack({ team: 'Neutral', kind: 'other', role: 'gk', label: 'GK', ai }); gks.push(tk);
    } else if (role === 'ref') {
      tk = newTrack({ team: 'Neutral', kind: 'ref', label: 'Referee', ai });
    } else if (role === 'ar' || role === 'staff') {
      if (!ch.keepOff) { n[role]++; return; }
      tk = role === 'ar' ? newTrack({ team: 'Neutral', kind: 'ref', role: 'ar', label: 'AR', ai }) : newTrack({ team: 'Neutral', kind: 'other', role: 'staff', label: 'Staff', ai });
    } else {
      if (!roles && ch.other === 'skip') { n.left++; return; }
      tk = newTrack({ team: 'Neutral', kind: 'other', role: 'unknown', label: label('Neutral'), ai }); tk.color = rgbHex(tr.colour);
    }
    tk.points = tr.points.map(p => ({ t: qt(p.t), x: p.x, y: p.y, src: 'ai', vis: 'v', conf: p.conf }));
    n[role === 'gk' ? 'gk' : role]++;
  });
  if (ch.ball && res.ball.length) {
    let tk = TR.tracks.find(x => x.kind === 'ball');
    if (!tk) tk = newTrack({ kind: 'ball', team: 'Neutral', label: 'Ball' });
    tk.ai = tk.ai || { run };
    if (!tk.maxGap) tk.maxGap = typeof BALL_GAP !== 'undefined' ? BALL_GAP : 1;
    const keep = tk.points.filter(p => p.src === 'manual' || p.t < t0 - 0.01 || p.t > t1 + 0.01);
    const fd = frameDur();
    const add = res.ball.map(b => ({ t: qt(b.t), x: b.x, y: b.y, src: 'ai', vis: 'v', conf: b.conf })).filter(p => !keep.some(q => Math.abs(q.t - p.t) < fd * 0.51));
    tk.points = keep.concat(add).sort((a, b) => a.t - b.t);
  }
  // goalkeepers: the team whose outfield players are, on average, nearer the other goal defends this one
  const means = teamSideMeans(t0, t1), { L } = pitchDims();
  gks.forEach(tk => {
    const s = trackPlaces({ points: tk.points }), left = s.n ? s.mx < L / 2 : null;
    let team = null;
    if (left != null && means.Home != null && means.Away != null) team = left === (means.Home < means.Away) ? 'Home' : 'Away';
    else if (left != null && (means.Home != null || means.Away != null)) { const k = means.Home != null ? 'Home' : 'Away', o = k === 'Home' ? 'Away' : 'Home'; team = left === (means[k] < L / 2) ? k : o; }
    if (team) { tk.kind = 'player'; tk.team = team; tk.role = ''; tk.ai.gk = true; logCorrection(tk, tk.points[0].t, 'assign', 'goalkeeper ' + teamName(team)); }
    else tk.label = 'GK?';
  });
  TR.settings.showAll = true; TR.settings.overlay = true;
  if (Number(TR.settings.maxGap) < 1) TR.settings.maxGap = 1;
  markDirty(); autosave(); renderTrackTab(); paintTracking(true);
  const parts = [`${n.player + n.gk} player tracks` + (n.gk ? ` (${n.gk} goalkeeper${n.gk > 1 ? 's' : ''})` : '')];
  if (n.ref) parts.push('the referee');
  const left = [];
  if (n.ar && !ch.keepOff) left.push(`${n.ar} assistant referee${n.ar > 1 ? 's' : ''}`);
  if (n.staff && !ch.keepOff) left.push(`${n.staff} people outside the pitch`);
  if (n.short) left.push(`${n.short} short tracks`);
  const pruned = typeof annPrune === 'function' ? annPrune() : 0;   // annotations of AI tracks that were replaced
  toast(`Imported ${parts.join(' and ')}` + (left.length ? ` – left out ${left.join(', ')}` : '') + (n.unknown ? ` · ${n.unknown} unsure (hidden)` : '') + (roles ? '' : ' · no pitch calibration: calibrate and re-import to sort out referees and staff') + annPruneNote(pruned), roles ? 'ok' : 'info', 5000);
  return n;
}

function aiClearTracks() {
  const n = TR.tracks.filter(t => t.ai).length;
  if (!n || !confirm(`Remove all ${n} AI tracks? (Tracks you made yourself are kept. Points you corrected by hand inside AI tracks are removed too.)`)) return;
  checkpoint();
  TR.tracks = TR.tracks.filter(t => !t.ai || t.kind === 'ball' && (t.points = t.points.filter(p => p.src !== 'ai')).length);
  if (TR.sel && !TR.tracks.some(t => t.id === TR.sel)) TR.sel = null;
  const pruned = typeof annPrune === 'function' ? annPrune() : 0;
  if (pruned) toast(`${pruned} annotation${pruned > 1 ? 's' : ''} of the removed tracks removed too (Ctrl+Z brings them back)`, 'info', 3500);
  markDirty(); autosave(); renderTrackTab(); paintTracking(true);
}

// review: jump to the next AI point whose confidence is low and select its track
function aiNextLow() {
  const t = (video.currentTime || 0) + frameDur() * 0.6;
  let best = null;
  TR.tracks.forEach(tk => tk.points.forEach(p => { if (p.src === 'ai' && p.conf != null && p.conf < 0.4 && p.t > t && (!best || p.t < best.p.t)) best = { tk, p }; }));
  if (!best) { toast('No more unsure AI points after this moment', 'info'); return; }
  TR.sel = best.tk.id; TR.settings.showAll = true;
  video.pause(); video.currentTime = best.p.t + frameDur() * 0.1;
  if (!TR.on) setTracking(true);
  renderTrackTab(); paintTracking(true);
  toast(`${trackLabel(best.tk)}: the AI was only ${Math.round(best.p.conf * 100)}% sure – click the right spot to correct it`, 'info', 3500);
}

/* ---------- correcting tracks: join two tracks of the same person, split an ID switch ---------- */
async function joinTracksDialog() {
  const tk = selTrack(); if (!tk) return;
  const span = x => x.points.length ? [x.points[0].t, x.points[x.points.length - 1].t] : [0, 0];
  const [a0, a1] = span(tk);
  const others = TR.tracks.filter(x => x !== tk && x.kind !== 'ball' && x.points.length).map(x => {
    const [b0, b1] = span(x), overlap = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
    const gap = b0 > a1 ? b0 - a1 : a0 > b1 ? a0 - b1 : 0;
    return { x, overlap, gap, b0, b1 };
  }).sort((p, q) => (p.overlap - q.overlap) || (p.gap - q.gap));
  if (!others.length) { toast('No other tracks to join with', 'bad'); return; }
  let id = null;
  const r = await Dlg.open('⇄ Join “' + trackLabel(tk) + '” with…', `<p class="small muted">Pick the track that is the same person. Tracks that don’t overlap in time are listed first.
    Where both have a position at the same moment, the hand-made or more confident one is kept.</p>
    <select id="jnSel" size="12" style="width:100%">${others.map((o, i) => `<option value="${o.x.id}" ${i === 0 ? 'selected' : ''}>${esc(trackLabel(o.x))} · ${esc(teamName(o.x.team))} · ${fmtTime(o.b0)}–${fmtTime(o.b1)}${o.overlap ? ' · overlaps ' + o.overlap.toFixed(1) + ' s' : o.gap ? ' · gap ' + o.gap.toFixed(1) + ' s' : ''}</option>`).join('')}</select>`,
  [{ label: 'Cancel' }, { label: 'Join', primary: true, value: 'ok', onClick: () => { id = $('#jnSel').value; } }]);
  if (r !== 'ok' || !id) return;
  const other = TR.tracks.find(x => x.id === id); if (!other) return;
  checkpoint();
  mergeTracks(tk, other);
  markDirty(); autosave(); renderTrackTab(); paintTracking(true);
  toast('Joined – ' + trackLabel(tk) + ' now has ' + tk.points.length + ' points', 'ok');
}
function splitTrackHere() {
  const tk = selTrack(); if (!tk || !hasVideo()) return;
  const t = video.currentTime - frameDur() * 0.5;
  const after = tk.points.filter(p => p.t >= t);
  if (!after.length || after.length === tk.points.length) { toast('Move the video to the moment the track jumps to another person', 'bad', 3000); return; }
  checkpoint();
  tk.points = tk.points.filter(p => p.t < t);
  const nk = newTrack({ team: tk.team, kind: tk.kind, label: (tk.label || 'P') + '′', ai: tk.ai ? Object.assign({}, tk.ai) : undefined });
  nk.points = after; if (tk.removed) { nk.removed = tk.removed.filter(r => r.t >= t); tk.removed = tk.removed.filter(r => r.t < t); }
  logCorrection(tk, t, 'split', trackLabel(nk));
  if (typeof annRetarget === 'function') annRetarget(tk.id, nk.id, t);   // annotations from the split on follow the new part
  TR.sel = nk.id;
  markDirty(); autosave(); renderTrackTab(); paintTracking(true);
  toast('Split: the part from ' + fmtTime(t) + ' is now “' + trackLabel(nk) + '” – use ✎ to say who it is', 'ok', 3500);
}
