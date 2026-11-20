/* TACTIQ ANALYST – broadcast footage support (roadmap phase 0.8): camera shots.
   A scan splits the video at camera cuts and recognises the type of every shot (wide, medium, close-up, other).
   You can mark replays. Only wide and medium shots are used for 2D tracking; close-ups, replays and other shots get
   no pitch calibration, the AI can skip them, and tracks never continue silently across a cut. */
'use strict';
const SHOT_TYPES = { wide: ['Wide', '#2ecc71'], medium: ['Medium', '#48c9b0'], close: ['Close-up', '#ff5a5f'], replay: ['Replay', '#a66bff'], other: ['Other', '#7f8c8d'] };
const trackableShot = sh => !sh || sh.type === 'wide' || sh.type === 'medium';
const SHOTS = { running: false, progress: null };

function sortedShots() { return (TR.shots || []).slice().sort((a, b) => a.t0 - b.t0); }
function shotAt(t) {
  const s = TR.shots || []; if (!s.length) return null;
  let lo = 0, hi = s.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (t < s[m].t0) hi = m - 1; else if (t >= s[m].t1) lo = m + 1; else return s[m]; }
  return null;
}
// every place where the picture cuts (from the shot scan and from AI runs)
let _cutCache = null;
function cutTimes() {
  const sh = TR.shots || [], cu = TR.cuts || [];
  if (_cutCache && _cutCache.sh === sh && _cutCache.cu === cu && _cutCache.n === sh.length + ':' + cu.length) return _cutCache.v;
  const c = new Set();
  sortedShots().forEach((s, i) => { if (i) c.add(Math.round(s.t0 * 100) / 100); });
  cu.forEach(t => c.add(Math.round(t * 100) / 100));
  const v = [...c].sort((a, b) => a - b);
  _cutCache = { sh, cu, n: sh.length + ':' + cu.length, v };
  return v;
}
// is there a camera cut after time a, up to and including time b (+ slack)?
const cutBetween = (a, b, slack = 0.05) => cutTimes().some(c => c > a + 0.01 && c <= b + slack);
// is time t in a shot that can be used for pitch positions? (true when no shot scan was made)
function usableAt(t) { if (!(TR.shots || []).length) return true; const sh = shotAt(t); return !sh || trackableShot(sh); }
// share of the scanned time in shots usable for tracking, and the number of cuts (for the report)
function shotSummary() {
  const s = sortedShots(), tot = s.reduce((a, x) => a + x.t1 - x.t0, 0) || 1;
  return { trackable: s.filter(trackableShot).reduce((a, x) => a + x.t1 - x.t0, 0) / tot, cuts: Math.max(0, s.length - 1), shots: s.length };
}

/* ---------------------------------------------------------------- scanning */
async function shotScanDialog() {
  if (!hasVideo() || !videoInfo || !videoInfo.path) { toast('Open a video first', 'bad'); return; }
  if (!api.aiScan) { toast('The shot scan works in the installed Windows app', 'bad'); return; }
  const dur = video.duration || 0, hasIO = clipIO.in != null && clipIO.out != null;
  let o = null;
  const r = await Dlg.open('📺 Scan camera shots', `
    <p class="small muted">Finds every camera cut and recognises each shot: <b>wide</b> (the tactical / main camera – usable for 2D tracking), <b>medium</b>, <b>close-up</b> and <b>other</b> (crowd, bench, graphics).
      You can then mark replays yourself. Close-ups, replays and other shots get no pitch calibration and can be skipped by the AI.</p>
    <label class="blk"><input type="radio" name="scR" value="all" checked> Whole video (${fmtTime(dur)})</label>
    ${hasIO ? `<label class="blk"><input type="radio" name="scR" value="io"> Clip IN–OUT (${fmtTime(clipIO.in)} – ${fmtTime(clipIO.out)})</label>` : ''}
    <label class="blk">Look at the picture every <select id="scEvery"><option value="2" selected>2 s (recommended)</option><option value="5">5 s (faster)</option><option value="1">1 s (most careful)</option></select></label>
    <p class="small muted">Roughly 1–3 minutes per 10 minutes of video on an ordinary PC; faster with a graphics card. You can keep working.</p>`,
  [{ label: 'Cancel' }, { label: 'Scan', primary: true, value: 'go', onClick: () => { const b = $('#dlgBody'), io = b.querySelector('input[name=scR]:checked').value === 'io'; o = { start: io ? clipIO.in : 0, duration: io ? clipIO.out - clipIO.in : dur, sampleEvery: Number(b.querySelector('#scEvery').value), stride: 2 }; } }]);
  if (r !== 'go' || !o) return;
  if (typeof AI !== 'undefined' && AI.running) { toast('The AI is busy – wait for it to finish', 'bad'); return; }
  SHOTS.running = true; SHOTS.progress = null; if (typeof AI !== 'undefined') AI.running = true; renderTrackTab();
  api.onAiProgress(p => { SHOTS.progress = p; renderShotsBox(); });
  let res;
  try { res = await api.aiScan(Object.assign({ video: videoInfo.playPath || videoInfo.path }, o)); } catch (e) { res = { ok: false, error: String(e.message || e) }; }
  SHOTS.running = false; if (typeof AI !== 'undefined') AI.running = false;
  if (!res || !res.ok) { renderTrackTab(); if (res && res.error !== 'cancelled') alert('The shot scan failed:\n\n' + (res && res.error)); return; }
  importShots(res, o);
}
function importShots(res, o) {
  checkpoint();
  const t0 = o.start, t1 = o.start + o.duration;
  // keep shots outside the scanned range, and your own replay marks where a new shot covers the same time
  const old = TR.shots || [];
  const fresh = res.segments.map(s => ({ id: uid(), t0: s.t0, t1: s.t1, type: s.type, auto: s.type, looks: s.looks }));
  fresh.forEach(s => { const prev = old.find(p => p.type === 'replay' && Math.abs(p.t0 - s.t0) < 0.3 && Math.abs(p.t1 - s.t1) < 0.3); if (prev) s.type = 'replay'; });
  TR.shots = old.filter(s => s.t1 <= t0 + 0.01 || s.t0 >= t1 - 0.01).concat(fresh).sort((a, b) => a.t0 - b.t0);
  // the camera movement of the whole scan lets calibrations follow the camera everywhere
  if (res.camera && res.camera.length) {
    const scanId = 'scan' + Date.now().toString(36);
    TR.camera = (TR.camera || []).map(sg => ({ id: sg.id, pts: sg.pts.filter(p => p[0] < t0 - 0.01 || p[0] > t1 + 0.01) })).filter(sg => sg.pts.length > 1);
    const by = new Map(); res.camera.forEach(p => { const k = scanId + ':' + (p[3] || 0); if (!by.has(k)) by.set(k, []); by.get(k).push([p[0], p[1], p[2]]); });
    // scan segments go first: later AI runs (more precise) take priority where they overlap
    TR.camera = [...by.entries()].filter(([, pts]) => pts.length > 1).map(([id, pts]) => ({ id, pts })).concat(TR.camera);
  }
  markDirty(); autosave(); renderTrackTab(); paintTracking(true); render2D(true);
  const n = TR.shots.length, wide = TR.shots.filter(trackableShot).length;
  toast(`${n} shots found – ${wide} usable for tracking (${res.meta.seconds} s)`, 'ok', 4000);
}

/* ---------------------------------------------------------------- the panel */
function shotCalStatus(sh) { return Memo.get('shcal|' + sh.id + '|' + sh.t0 + '|' + sh.t1 + '|' + sh.type, () => shotCalStatusCalc(sh)); }
function shotCalStatusCalc(sh) {
  if (!trackableShot(sh)) return { cls: '', txt: 'not used for 2D' };
  let n = 0, ok = 0, err = 0, carried = 0;
  for (let t = sh.t0 + 0.05; t < sh.t1; t += 0.5) { n++; const c = calAt(t); if (c) { ok++; if (c.carried) { carried++; err += c.err; } } }
  if (!ok) return { cls: 'poor', txt: 'needs a calibration' };
  const pct = Math.round(ok / n * 100);
  return { cls: pct >= 90 ? 'good' : 'ok', txt: `${pct}% calibrated` + (carried ? ` (±${(err / carried).toFixed(1)} m)` : '') };
}
function renderShotsBox() {
  const box = document.querySelector('#shotBox'); if (!box) return;
  const shots = sortedShots();
  if (SHOTS.running) {
    const p = SHOTS.progress, pct = p ? Math.round(p.done / Math.max(1, p.total) * 100) : 0;
    box.innerHTML = `<div class="exportbox" style="margin:0 0 10px"><b>📺 Scanning camera shots…</b><div class="aibar"><div style="width:${pct}%"></div></div>
      <div class="small muted">${p ? `${pct}% · ${Math.round(p.speed * 2)} video frames/s · about ${Math.round(p.eta)} s left` : 'Starting…'}</div>
      <div class="toolbar"><button class="small danger" id="shCancel">Cancel</button></div></div>`;
    box.querySelector('#shCancel').onclick = () => api.aiCancel();
    return;
  }
  if (!shots.length) {
    box.innerHTML = `<div class="toolbar"><button class="small" id="shScan" title="Find camera cuts, close-ups and replays (broadcast footage)">📺 Scan camera shots</button><span class="small muted">for broadcast / TV footage: finds cuts, close-ups and replays</span></div>`;
    box.querySelector('#shScan').onclick = shotScanDialog; return;
  }
  const tot = shots.reduce((s, x) => s + (x.t1 - x.t0), 0) || 1;
  const byType = Object.keys(SHOT_TYPES).map(k => [k, shots.filter(s => s.type === k).reduce((a, s) => a + s.t1 - s.t0, 0)]).filter(x => x[1] > 0);
  const st = shots.map(sh => ({ sh, cal: shotCalStatus(sh) }));
  const need = st.filter(x => x.cal.cls === 'poor').length;
  const cur = hasVideo() ? shotAt(video.currentTime) : null;
  const open = TR.settings.shotsOpen !== false;
  box.innerHTML = `<div class="ballpanel">
    <div class="toolbar"><b>📺 Camera shots</b><span class="small muted">${shots.length} shots · ${byType.map(([k, s]) => `<span class="lg" style="background:${SHOT_TYPES[k][1]}"></span>${SHOT_TYPES[k][0]} ${Math.round(s / tot * 100)}%`).join(' ')}</span><div class="spacer"></div>
      <button class="small" id="shToggle">${open ? 'hide list' : 'show list'}</button></div>
    <canvas id="shotStrip" height="22" title="Camera shots – click to jump. Green = wide, teal = medium, red = close-up, purple = replay, grey = other. The thin bar underneath: calibrated (white) or not."></canvas>
    <div class="toolbar">${need ? `<button class="small primary" id="shNextCal" title="Jump to the next wide shot that has no calibration and open the calibration">🎯 Calibrate next shot (${need} left)</button>` : '<span class="small ok">✓ every wide / medium shot is calibrated</span>'}
      <button class="small" id="shRescan">↻ Rescan</button>
      ${cur ? `<span class="small">Now: <b style="color:${SHOT_TYPES[cur.type][1]}">${SHOT_TYPES[cur.type][0]}</b></span>` : ''}</div>
    ${open ? `<div class="shotlist">${st.map(({ sh, cal }, i) => `<div class="shotrow ${cur === sh ? 'sel' : ''}" data-sh="${sh.id}">
      <span class="lg" style="background:${SHOT_TYPES[sh.type][1]}"></span><a data-shgo="${sh.id}">${fmtTime(sh.t0)}–${fmtTime(sh.t1)}</a>
      <select data-shtype="${sh.id}">${Object.entries(SHOT_TYPES).map(([k, [n]]) => `<option value="${k}" ${sh.type === k ? 'selected' : ''}>${n}${sh.auto === k ? ' (found)' : ''}</option>`).join('')}</select>
      <span class="badge ${cal.cls}">${cal.txt}</span>${trackableShot(sh) ? `<button class="small" data-shcal="${sh.id}" title="Calibrate this shot">🎯</button>` : ''}${i ? `<button class="small" data-shjoin="${sh.id}" title="Not a real cut – join with the previous shot">⤒ join</button>` : ''}</div>`).join('')}</div>` : ''}
  </div>`;
  drawShotStrip(shots);
  box.querySelector('#shToggle').onclick = () => { TR.settings.shotsOpen = !open; renderShotsBox(); };
  box.querySelector('#shRescan').onclick = shotScanDialog;
  const nc = box.querySelector('#shNextCal'); if (nc) nc.onclick = () => { const x = st.find(y => y.cal.cls === 'poor' && y.sh.t1 > (video.currentTime || 0) - 0.01) || st.find(y => y.cal.cls === 'poor'); if (x) calibrateShot(x.sh); };
  box.querySelectorAll('[data-shgo]').forEach(a => a.onclick = () => { const sh = shots.find(s => s.id === a.dataset.shgo); if (sh && hasVideo()) { video.pause(); video.currentTime = sh.t0 + 0.05; } });
  box.querySelectorAll('[data-shcal]').forEach(b => b.onclick = () => { const sh = shots.find(s => s.id === b.dataset.shcal); if (sh) calibrateShot(sh); });
  box.querySelectorAll('[data-shjoin]').forEach(b => b.onclick = () => joinShot(b.dataset.shjoin));
  box.querySelectorAll('[data-shtype]').forEach(sel => sel.onchange = () => { const sh = shots.find(s => s.id === sel.dataset.shtype); if (!sh) return; checkpoint(); sh.type = sel.value; markDirty(); autosave(); renderTrackTab(); paintTracking(true); render2D(true); });
}
// a wrongly found cut: the shot is joined to the one before it (and the cut is forgotten)
function joinShot(id) {
  const s = sortedShots(), i = s.findIndex(x => x.id === id); if (i < 1) return;
  checkpoint();
  const prev = s[i - 1], sh = s[i];
  if (!trackableShot(prev) && trackableShot(sh) && sh.t1 - sh.t0 > prev.t1 - prev.t0) prev.type = sh.type;   // the longer part decides the type
  prev.t1 = sh.t1;
  TR.shots = s.filter(x => x !== sh);
  TR.cuts = (TR.cuts || []).filter(c => Math.abs(c - sh.t0) > 0.2);
  markDirty(); autosave(); renderTrackTab(); paintTracking(true); render2D(true);
  toast('Shots joined – that cut is ignored now', 'ok');
}
function calibrateShot(sh) {
  if (!hasVideo()) return;
  video.pause();
  // the first calibrated moment of a shot: shortly after the cut (calibrations follow the camera from there)
  video.currentTime = Math.min(sh.t1 - 0.05, sh.t0 + Math.min(0.5, (sh.t1 - sh.t0) / 2));
  setTimeout(() => openCalibration(null), 350);
}
function drawShotStrip(shots) {
  const cv = document.querySelector('#shotStrip'); if (!cv) return;
  const W = cv.clientWidth || 300; cv.width = W;
  const ctx = cv.getContext('2d'), a = shots[0].t0, b = shots[shots.length - 1].t1, span = Math.max(0.1, b - a), X = t => (t - a) / span * W;
  ctx.clearRect(0, 0, W, 22);
  shots.forEach(sh => { ctx.fillStyle = SHOT_TYPES[sh.type][1]; ctx.fillRect(X(sh.t0), 0, Math.max(1, X(sh.t1) - X(sh.t0) - 1), 15); });
  for (let x = 0; x < W; x += 2) { const t = a + (x + 1) / W * span; ctx.fillStyle = calAt(t) ? '#e8eef5' : '#3a2a2a'; ctx.fillRect(x, 17, 2, 4); }
  if (hasVideo() && video.currentTime >= a && video.currentTime <= b) { ctx.fillStyle = '#fff'; ctx.fillRect(X(video.currentTime) - 1, 0, 2, 22); }
  cv.onclick = e => { const r = cv.getBoundingClientRect(); if (hasVideo()) { video.pause(); video.currentTime = a + (e.clientX - r.left) / r.width * span; } };
}
let _shTick = 0;
HOOKS.tick.push(() => {
  const now = performance.now(); if (now - _shTick < 400) return; _shTick = now;
  const cv = document.querySelector('#shotStrip'); if (cv && cv.offsetParent && (TR.shots || []).length) drawShotStrip(sortedShots());
});
