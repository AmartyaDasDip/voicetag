/* TACTIQ ANALYST – ball tracking tools (roadmap phase 0.5).
   Ball timeline (found / estimated / missing), jump to gaps, fast click-while-playing correction,
   possession estimate, ball position as tag location, ball heat map. Works with AI and manual ball points. */
'use strict';
const BALL_GAP = 1.0;          // estimate (interpolate) the ball over gaps up to 1 s, never longer

function ballTrack() { return TR.tracks.find(t => t.kind === 'ball' && t.points.length) || null; }
function ballSpan(tk) { tk = tk || ballTrack(); return tk ? [tk.points[0].t, tk.points[tk.points.length - 1].t] : null; }

// state of the ball at time t: {kind:'key'|'interp', x, y} or null (missing)
function ballAt(t, tk) {
  tk = tk || ballTrack(); if (!tk) return null;
  const q = posAt(tk, t);
  return q && q.kind !== 'status' ? q : null;
}

/* ---------------------------------------------------------------- possession estimate */
// Ball owner = the team of the nearest tracked player when that player is close enough (2 m on a calibrated
// pitch, otherwise ~3% of the picture width). Possession only changes after the other team has been in
// control for 0.4 s; while the ball travels between players it stays with the team that last had it.
function possession(t0, t1, step = 0.2) {
  const btk = ballTrack(); if (!btk) return null;
  const span = ballSpan(btk);
  t0 = Math.max(t0 != null ? t0 : span[0], span[0]); t1 = Math.min(t1 != null ? t1 : span[1], span[1]);
  if (!(t1 > t0)) return null;
  const players = TR.tracks.filter(t => t.kind === 'player' && (t.team === 'Home' || t.team === 'Away') && t.points.length);
  const res = { Home: 0, Away: 0, unknown: 0, seconds: 0, metres: 0, segs: [] };
  let owner = null, cand = null, candSince = 0, seg = null;
  for (let t = t0; t <= t1 + 1e-6; t += step) {
    res.seconds += step;
    const b = ballAt(t, btk);
    if (!b) { res.unknown += step; if (seg) { seg.t1 = t; seg = null; } owner = null; cand = null; continue; }
    const bm = toPitch(t, b.x, b.y);
    let best = null, bd = Infinity;
    for (const p of players) {
      const q = posAt(p, t); if (!q || q.kind === 'status') continue;
      let d;
      if (bm) { const pm = toPitch(t, q.x, q.y); if (!pm) continue; d = Math.hypot(pm[0] - bm[0], pm[1] - bm[1]) / 2.0; }
      else d = Math.hypot(q.x - b.x, (q.y - b.y) * 0.56) / 0.03;
      if (d < bd) { bd = d; best = p; }
    }
    if (bm) res.metres += step;
    const now = best && bd <= 1 ? best.team : null;
    if (now && now !== owner) {
      if (cand !== now) { cand = now; candSince = t; }
      if (!owner || t - candSince >= 0.4 - 1e-6) { owner = now; cand = null; }
    } else if (now === owner) cand = null;
    if (owner) {
      res[owner] += step;
      if (!seg || seg.team !== owner) { if (seg) seg.t1 = t; seg = { team: owner, t0: t, t1: t }; res.segs.push(seg); }
      seg.t1 = t + step;
    } else { res.unknown += step; if (seg) { seg.t1 = t; seg = null; } }
  }
  const known = res.Home + res.Away;
  res.pctHome = known ? Math.round(res.Home / known * 100) : null;
  res.pctAway = known ? 100 - res.pctHome : null;
  res.t0 = t0; res.t1 = t1;
  return res;
}

/* ---------------------------------------------------------------- ball panel in the Track tab */
function renderBallPanel() {
  const box = document.querySelector('#ballBox'); if (!box) return;
  const tk = ballTrack();
  if (!tk) { box.innerHTML = ''; return; }
  const [a, b] = ballSpan(tk);
  let det = 0, man = 0, est = 0, miss = 0;
  const fd = Math.max(frameDur(), 0.04);
  for (let t = a; t <= b; t += 0.2) { const q = ballAt(t, tk); if (!q) miss++; else if (isEstimate(q)) est++; else if (q.src === 'manual') man++; else det++; }
  const n = det + man + est + miss || 1, pc = v => Math.round(v / n * 100);
  const pos = possession(a, b);
  box.innerHTML = `<div class="ballpanel">
    <div class="toolbar"><b>⚽ Ball</b><span class="small muted">${fmtTime(a)} – ${fmtTime(b)}</span><div class="spacer"></div>
      <span class="small"><span class="lg" style="background:#2ecc71"></span>found ${pc(det + man)}% <span class="lg" style="background:#f5b041"></span>estimated ${pc(est)}% <span class="lg" style="background:#5b2a2a"></span>missing ${pc(miss)}%</span></div>
    <canvas id="ballStrip" height="30" title="Ball timeline – click to jump. Top: ball found / estimated / missing. Bottom: possession estimate."></canvas>
    <div class="toolbar">
      <button class="small" id="ballGap" title="Jump to the next moment where the ball position is missing">⏭ Next ball gap</button>
      <button class="small" id="ballFix" title="Select the ball, turn tracking on and slow the video down: press Space and click the ball while it plays">🎯 Fix ball by clicking</button>
      <label class="small" title="New tags get the ball's pitch position as their location (needs a calibration)"><input type="checkbox" id="ballLoc" ${TR.settings.ballLoc ? 'checked' : ''}> ball = tag location</label>
    </div>
    ${pos && pos.pctHome != null ? `<div class="small">Possession estimate: <b style="color:${teamColor('Home')}">${esc(teamName('Home'))} ${pos.pctHome}%</b> · <b style="color:${teamColor('Away')}">${esc(teamName('Away'))} ${pos.pctAway}%</b>
      <span class="muted">(${Math.round(pos.Home + pos.Away)} s with a known owner of ${Math.round(pos.seconds)} s)</span></div>` : '<div class="small muted">Possession estimate needs the ball and players tracked at the same time.</div>'}
  </div>`;
  drawBallStrip(tk, a, b, pos);
  box.querySelector('#ballGap').onclick = () => nextBallGap();
  box.querySelector('#ballFix').onclick = () => ballFixMode();
  box.querySelector('#ballLoc').onchange = e => { TR.settings.ballLoc = e.target.checked; markDirty(); autosave(); };
}
function drawBallStrip(tk, a, b, pos) {
  const cv = document.querySelector('#ballStrip'); if (!cv) return;
  const W = cv.clientWidth || 300; cv.width = W;
  const ctx = cv.getContext('2d'), span = Math.max(0.1, b - a);
  ctx.fillStyle = '#5b2a2a'; ctx.fillRect(0, 0, W, 16);
  for (let x = 0; x < W; x++) {
    const t = a + (x + 0.5) / W * span, q = ballAt(t, tk);
    if (!q) continue;
    ctx.fillStyle = isEstimate(q) ? '#f5b041' : '#2ecc71'; ctx.fillRect(x, 0, 1, 16);
  }
  ctx.fillStyle = '#222'; ctx.fillRect(0, 18, W, 12);
  if (pos) pos.segs.forEach(s => { ctx.fillStyle = teamColor(s.team); const x0 = (s.t0 - a) / span * W, x1 = (s.t1 - a) / span * W; ctx.fillRect(x0, 18, Math.max(1, x1 - x0), 12); });
  if (hasVideo() && video.currentTime >= a && video.currentTime <= b) { ctx.fillStyle = '#fff'; ctx.fillRect((video.currentTime - a) / span * W - 1, 0, 2, 30); }
  cv.onclick = e => { const r = cv.getBoundingClientRect(); if (hasVideo()) video.currentTime = a + (e.clientX - r.left) / r.width * span; };
}
function nextBallGap() {
  const tk = ballTrack(); if (!tk || !hasVideo()) return;
  const [, b] = ballSpan(tk);
  let t = video.currentTime + 0.1, inGap = !ballAt(t, tk);
  // skip the gap we are standing in
  while (inGap && t <= b) { t += 0.1; inGap = !ballAt(t, tk); }
  while (t <= b) { if (!ballAt(t, tk)) { video.pause(); video.currentTime = Math.max(0, t - 0.2); toast('Ball missing from ' + fmtTime(t) + ' – click the ball (tracking mode) to add it', 'info', 3000); return; } t += 0.1; }
  toast('No more ball gaps after this moment', 'ok');
}
function ballFixMode() {
  let tk = TR.tracks.find(t => t.kind === 'ball');
  if (!tk) { checkpoint(); tk = newTrack({ kind: 'ball', team: 'Neutral', label: 'Ball' }); tk.maxGap = BALL_GAP; }
  TR.sel = tk.id;
  if (!TR.on) setTracking(true);
  video.playbackRate = 0.5; const sp = document.querySelector('#selSpeed'); if (sp) sp.value = '0.5';
  renderTrackTab(); paintTracking(true);
  toast('Ball selected, speed 0.5×. Press Space to play and click the ball as it moves – every click adds a point at that moment. F8 when done.', 'info', 6000);
}

/* ---------------------------------------------------------------- ball as tag location */
HOOKS.afterTag.push(ev => {
  if (!TR.settings.ballLoc || ev.x != null || ev.type === 'duration') return;
  const b = ballAt(ev.t); if (!b) return;
  const m = toPitch(ev.t, b.x, b.y); if (!m) return;
  const { L, W } = pitchDims();
  ev.x = Math.round(clamp(m[0] / L * 100, 0, 100) * 10) / 10; ev.y = Math.round(clamp(m[1] / W * 100, 0, 100) * 10) / 10;
  ev.locSrc = 'ball';
  if (typeof autoZone === 'function') autoZone(ev);
  if (locAsk && locAsk.id === ev.id) { const code = VOC.codesById[ev.codeId]; locAsk = code && code.endLoc ? { id: ev.id, stage: 'end' } : null; }
});

/* ---------------------------------------------------------------- stats tab: possession */
HOOKS.render.push(tab => {
  if (tab && tab !== 'summary') return;
  const host = document.querySelector('#possBox'); if (!host) return;
  const pos = ballTrack() ? possession() : null;
  if (!pos || pos.pctHome == null) { host.innerHTML = '<p class="small muted">Track the ball (Track tab → 🤖 Auto-detect with the ball, or click it by hand) together with the players to get a possession estimate.</p>'; return; }
  host.innerHTML = `<div class="possbar"><div style="width:${pos.pctHome}%;background:${teamColor('Home')}">${esc(teamName('Home'))} ${pos.pctHome}%</div><div style="width:${pos.pctAway}%;background:${teamColor('Away')}">${esc(teamName('Away'))} ${pos.pctAway}%</div></div>
    <p class="small muted">Estimated from tracking between ${fmtTime(pos.t0)} and ${fmtTime(pos.t1)}: ${Math.round(pos.Home + pos.Away)} s with a known owner, ${Math.round(pos.unknown)} s unknown (ball missing or nobody close).
    ${pos.metres ? 'Distances in metres where the pitch is calibrated.' : 'No calibration: distances measured on the picture.'} An estimate – check it against the video.</p>`;
});

// keep the white "now" line on the ball timeline moving (a few times per second is enough)
let _ballTickAt = 0;
HOOKS.tick.push(() => {
  const now = performance.now(); if (now - _ballTickAt < 300) return; _ballTickAt = now;
  const cv = document.querySelector('#ballStrip'); if (!cv || !cv.offsetParent) return;
  const tk = ballTrack(); if (!tk) return;
  const [a, b] = ballSpan(tk);
  if (!_ballPosCache || _ballPosCache.n !== tk.points.length) _ballPosCache = { n: tk.points.length, pos: possession(a, b) };
  drawBallStrip(tk, a, b, _ballPosCache.pos);
});
let _ballPosCache = null;
