/* TACTIQ ANALYST – dynamic annotations (3.1, redrawn and made interactive in 3.2).
   Telestration that is tied to the tracking data, so it moves with the players and stays on the grass while the
   camera pans:  🔦 spotlight · 🏷 name tag · ➜ run arrow · ↔ distance (live metres) · 〰 line through players · ▭ zone
   · 📏 offside line · 🛡 back line (both found automatically from a team's players, every frame).
   Each annotation lives from t0 to t1 (fades in and out) and is drawn on the video, on the 2D pitch, in the 3D view
   (annotate3d.js) and burnt into an MP4 with 🎬. Click one to select it: recolour, longer / shorter, delete, and
   drag a zone to move it or its corners to resize it.
   Stored in TR.anns: { id, type, tracks:[ids], team, t0, t1, color, text, zone:[x0,y0,x1,y1], fill } */
'use strict';

const ANN_TYPES = {
  spot: { name: 'Spotlight', icon: '🔦', picks: 1, hint: 'Click a player on the video – the spotlight follows them.' },
  label: { name: 'Name tag', icon: '🏷', picks: 1, hint: 'Click a player – a tag with the name follows them.' },
  run: { name: 'Run', icon: '➜', picks: 1, hint: 'Click a player – the arrow shows the run they make in the next seconds.' },
  link: { name: 'Distance', icon: '↔', picks: 2, hint: 'Click two players – the line shows their distance live, in metres.' },
  chain: { name: 'Line', icon: '〰', picks: 99, hint: 'Click the players of the line one after another, then Enter (or ✓).' },
  zone: { name: 'Zone', icon: '▭', picks: 0, hint: 'Drag a rectangle on the pitch – it stays on the grass when the camera moves.' },
  offside: { name: 'Offside line', icon: '📏', picks: 1, hint: 'Click any player of the DEFENDING team – the line follows their second-last player (needs the pitch calibration).' },
  backline: { name: 'Back line', icon: '🛡', picks: 1, hint: 'Click any player of a team – its last line (the 4 deepest outfield players) is connected automatically, with its height.' }
};
const Ann = { on: false, tool: null, color: '#ffd23b', picks: [], drag: null, raf: 0, exporting: null, sel: null, hover: null, hits: [], edit: null, cursor: null };
const ANN_SHOW = [];   // run when the palette opens
const annView = $('#annView');
const FADE = 0.35;
const ANN_TEAM_TYPES = new Set(['offside', 'backline']);

/* ---------------------------------------------------------------- timing */
// While the video stands still (making or checking annotations) they are shown complete; while it plays, in a
// 3D replay and in the saved video they fade in, draw themselves and fade out.
const annStill = () => !Ann.exporting && hasVideo() && video.paused && !(typeof V3 !== 'undefined' && V3.open && V3.mode === 'replay');
function annAlpha(a, t) {
  if (t < a.t0 - 1e-6 || t > a.t1 + 1e-6) return 0;
  if (annStill()) return 1;
  return clamp(Math.min((t - a.t0) / FADE + 0.15, (a.t1 - t) / FADE + 0.15, 1), 0, 1);
}
const annGrow = (a, t, s = 0.7) => annStill() ? 1 : clamp((t - a.t0) / s, 0, 1);
const annActive = t => (TR.anns || []).filter(a => annAlpha(a, t) > 0);
// clock for the moving effects: video time while playing / exporting (frame-exact), wall clock while paused
const annClock = t => Ann.exporting || !hasVideo() || !video.paused ? t : performance.now() / 1000;
const annTrack = id => TR.tracks.find(x => x.id === id);
const annTeamName = a => a.team ? teamName(a.team) : '?';
const annName = a => a.type === 'zone' ? (a.text || 'Zone') : ANN_TEAM_TYPES.has(a.type) ? `${ANN_TYPES[a.type].name} – ${annTeamName(a)}` : a.tracks.map(id => { const tk = annTrack(id); return tk ? trackLabel(tk) : '?'; }).join(' – ');

/* ---------------------------------------------------------------- geometry: image ↔ pitch */
// a calibration for time t with its inverse (pitch → image); null without calibration
function annGeo(t) {
  const c = calAt(t); if (!c) return null;
  if (!c._Hi) { try { Object.defineProperty(c, '_Hi', { value: inv3(c.H), enumerable: false }); } catch (e) { return { c, Hi: inv3(c.H) }; } }
  return c._Hi ? { c, Hi: c._Hi } : null;
}
function annImg(g, X, Y) {
  const r = applyH(g.Hi, X, Y); if (!r) return null;
  const s = applyH(g.Hi, 52.5, 34);
  if (s && Math.sign(r[2]) !== Math.sign(s[2])) return null;    // behind the camera
  return [r[0], r[1]];
}
// where a track is now: image point (0-1) and pitch point (metres, or null)
function annPos(tk, t) {
  if (!tk) return null;
  const q = posAt(tk, t); if (!q || q.kind === 'status' || q.x == null) return null;
  return { x: q.x, y: q.y, m: toPitch(t, q.x, q.y), est: isEstimate(q) };
}
// pixels per metre on the grass at an image point (for sizes in perspective); a fixed share of the picture without calibration
function annScale(g, p, W, H) {
  if (!g || !p.m) return W / 95;
  const a = annImg(g, p.m[0], p.m[1]), b = annImg(g, p.m[0] + 1, p.m[1]), c = annImg(g, p.m[0], p.m[1] + 1);
  if (!a || !b || !c) return W / 95;
  return clamp(Math.max(Math.hypot((b[0] - a[0]) * W, (b[1] - a[1]) * H), Math.hypot((c[0] - a[0]) * W, (c[1] - a[1]) * H)), W / 400, W / 25);
}
// circle of radius R metres around a pitch point, as a polygon on the picture
function annRing(g, p, R, W, H, n = 32) {
  if (g && p.m) {
    const out = [];
    for (let k = 0; k < n; k++) { const a = k / n * Math.PI * 2, q = annImg(g, p.m[0] + Math.cos(a) * R, p.m[1] + Math.sin(a) * R); if (!q) return null; out.push([q[0] * W, q[1] * H]); }
    return out;
  }
  const rx = R * W / 95, ry = rx * 0.38, out = [];
  for (let k = 0; k < n; k++) { const a = k / n * Math.PI * 2; out.push([p.x * W + Math.cos(a) * rx, p.y * H + Math.sin(a) * ry]); }
  return out;
}
const polyPath = (ctx, P, open) => { ctx.beginPath(); P.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); if (!open) ctx.closePath(); };
const hexA = (hex, a) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); const v = m ? parseInt(m[1], 16) : 0xffd23b; return `rgba(${v >> 16 & 255},${v >> 8 & 255},${v & 255},${a})`; };
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
// a label pill with a soft shadow; returns its box (for clicking)
function annPill(ctx, x, y, text, col, fs, dark = true) {
  ctx.save();
  ctx.font = `700 ${fs}px Inter, "Segoe UI", Arial, sans-serif`;
  const w = ctx.measureText(text).width + fs * 1.0, h = fs * 1.5;
  roundRect(ctx, x - w / 2, y - h / 2, w, h, h / 2);
  ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = fs * 0.6; ctx.shadowOffsetY = fs * 0.12;
  ctx.fillStyle = dark ? 'rgba(10,14,20,.88)' : col; ctx.fill();
  ctx.shadowColor = 'transparent'; ctx.lineWidth = Math.max(1.5, fs * 0.1); ctx.strokeStyle = col; ctx.stroke();
  ctx.fillStyle = dark ? col : '#111'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y + fs * 0.04);
  ctx.restore();
  return { x: x - w / 2, y: y - h / 2, w, h };
}
function annArrowHead(ctx, x1, y1, x2, y2, size, col) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath(); ctx.moveTo(x2 + Math.cos(a) * size * 0.35, y2 + Math.sin(a) * size * 0.35);
  ctx.lineTo(x2 - size * Math.cos(a - 0.5), y2 - size * Math.sin(a - 0.5)); ctx.lineTo(x2 - size * 0.55 * Math.cos(a), y2 - size * 0.55 * Math.sin(a));
  ctx.lineTo(x2 - size * Math.cos(a + 0.5), y2 - size * Math.sin(a + 0.5)); ctx.closePath(); ctx.fillStyle = col; ctx.fill();
}
const fmtM = d => (d < 10 ? d.toFixed(1) : Math.round(d)) + ' m';
// the run of a player from t0 to t1 on the pitch (metres) – or in the picture when there is no calibration
function annRunPath(a) {
  const tk = annTrack(a.tracks[0]); if (!tk) return null;
  const step = 0.1, pts = [];
  for (let s = a.t0; s <= a.t1 + 1e-6; s += step) { const p = annPos(tk, s); if (p) pts.push({ s, m: p.m, x: p.x, y: p.y }); }
  if (pts.length < 2) return null;
  // the tracked feet wobble from frame to frame: a smooth line (half-second average) reads like a drawn arrow
  const avg = (k, f) => { let n = 0, v = 0; for (let j = Math.max(0, k - 3); j <= Math.min(pts.length - 1, k + 3); j++) { const x = f(pts[j]); if (x != null) { v += x; n++; } } return n ? v / n : null; };
  return pts.map((q, k) => ({ s: q.s, x: avg(k, o => o.x), y: avg(k, o => o.y), m: q.m ? [avg(k, o => o.m && o.m[0]), avg(k, o => o.m && o.m[1])] : null }));
}
// points along a polyline (pixels) every `gap` px, with their direction – for chevrons and dashes
function annAlong(P, gap, offset) {
  const out = []; let acc = -((offset % gap) + gap) % gap;
  for (let k = 1; k < P.length; k++) {
    const [x0, y0] = P[k - 1], [x1, y1] = P[k], L = Math.hypot(x1 - x0, y1 - y0); if (L < 1e-6) continue;
    for (let d = gap - acc; d <= L; d += gap) out.push({ x: x0 + (x1 - x0) * d / L, y: y0 + (y1 - y0) * d / L, a: Math.atan2(y1 - y0, x1 - x0) });
    acc = (acc + L) % gap;
  }
  return out;
}

/* ---------------------------------------------------------------- team lines (offside line, back line) */
// which goal a team defends at time t: where its goalkeeper is, otherwise from both teams' average positions
function annOwnGoal(team, t) {
  const { L } = pitchDims();
  const gk = TR.tracks.find(tk => tk.kind === 'player' && tk.team === team && isKeeper(tk) && annPos(tk, t) && annPos(tk, t).m);
  if (gk) return annPos(gk, t).m[0] < L / 2 ? 0 : L;
  const m = typeof teamSideMeans === 'function' ? teamSideMeans(t - 8, t + 8) : {};
  const other = team === 'Home' ? 'Away' : 'Home';
  if (m[team] != null && m[other] != null) return m[team] < m[other] ? 0 : L;
  if (m[team] != null) return m[team] < L / 2 ? 0 : L;
  return 0;
}
// the players of a team on the pitch at t, deepest (nearest their own goal) first
function annTeamDepth(team, t) {
  const goal = annOwnGoal(team, t), out = [];
  TR.tracks.forEach(tk => {
    if (tk.kind !== 'player' || tk.team !== team) return;
    const p = annPos(tk, t); if (!p || !p.m) return;
    out.push({ tk, p, gk: isKeeper(tk), depth: Math.abs(p.m[0] - goal) });
  });
  return { goal, list: out.sort((a, b) => a.depth - b.depth) };
}
// offside line: x of the second-last player of the defending team (the goalkeeper counts), never past halfway
function annOffside(a, t) {
  const { L } = pitchDims(), d = annTeamDepth(a.team, t);
  if (!d.list.length) return null;
  const hasGk = d.list.some(o => o.gk), k = hasGk ? 1 : 0, o = d.list[Math.min(k, d.list.length - 1)];
  let x = o.p.m[0];
  x = d.goal === 0 ? Math.min(x, L / 2) : Math.max(x, L / 2);
  return { x, by: o.tk, goal: d.goal, approx: !hasGk };
}
// back line: the 4 deepest outfield players, ordered across the pitch; height = distance of the line from its own goal
function annBackLine(a, t) {
  const d = annTeamDepth(a.team, t), four = d.list.filter(o => !o.gk).slice(0, 4);
  if (four.length < 2) return null;
  four.sort((u, v) => u.p.m[1] - v.p.m[1]);
  const height = four.reduce((s, o) => s + o.depth, 0) / four.length;
  return { nodes: four, height, goal: d.goal };
}

/* ---------------------------------------------------------------- drawing on the video */
// opts.hits (only for the live overlay): clickable areas of each annotation, for selecting and editing
function drawAnnotations(ctx, W, H, t, opts = {}) {
  const list = annActive(t); if (!list.length) return 0;
  const g = annGeo(t), clk = annClock(t), fs = Math.max(11, Math.round(H * 0.026)), lw = Math.max(2, W * 0.0028);
  const order = { zone: 0, offside: 1, chain: 2, backline: 2, link: 3, run: 4, spot: 5, label: 6 };
  list.slice().sort((a, b) => order[a.type] - order[b.type]).forEach(a => {
    const al = annAlpha(a, t), col = a.color || '#ffd23b', hit = opts.hits ? { id: a.id, shapes: [] } : null;
    ctx.save(); ctx.globalAlpha = al; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    try {
      const S = { ctx, a, g, W, H, t, clk, col, fs, lw, hit };
      if (a.type === 'zone') annZone2d(S);
      else if (a.type === 'run') annRun2d(S);
      else if (a.type === 'link' || a.type === 'chain') annLinks2d(S);
      else if (a.type === 'offside') annOffside2d(S);
      else if (a.type === 'backline') annBack2d(S);
      else { const tk = annTrack(a.tracks[0]), p = annPos(tk, t); if (p) { S.tk = tk; S.p = p; a.type === 'spot' ? annSpot2d(S) : annTag2d(S); } }
    } catch (e) { /* one broken annotation must not stop the others */ }
    ctx.restore();
    if (hit && hit.shapes.length) opts.hits.push(hit);
    if (opts.sel === a.id && hit) annSelOutline(ctx, hit, W, lw);
  });
  return list.length;
}
// the white dashed outline of the selected annotation, with handles on a zone
function annSelOutline(ctx, hit, W, lw) {
  ctx.save(); ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1.5, lw * 0.8); ctx.setLineDash([lw * 3, lw * 2]); ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 4;
  hit.shapes.forEach(s => {
    if (s.k === 'poly') { polyPath(ctx, s.P, s.open); ctx.stroke(); }
    else if (s.k === 'circle') { ctx.beginPath(); ctx.arc(s.x, s.y, s.r + lw * 2, 0, Math.PI * 2); ctx.stroke(); }
    else if (s.k === 'rect') { ctx.strokeRect(s.x - 3, s.y - 3, s.w + 6, s.h + 6); }
  });
  ctx.setLineDash([]);
  (hit.handles || []).forEach(([x, y]) => { ctx.fillStyle = '#fff'; ctx.fillRect(x - lw * 2.2, y - lw * 2.2, lw * 4.4, lw * 4.4); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.strokeRect(x - lw * 2.2, y - lw * 2.2, lw * 4.4, lw * 4.4); });
  ctx.restore();
}
// a glowing ground ring in perspective
function annGroundRing(S, p, R, width, alpha = 1) {
  const { ctx, g, W, H, col } = S, ring = annRing(g, p, R, W, H); if (!ring) return null;
  ctx.save(); polyPath(ctx, ring); ctx.globalAlpha *= alpha; ctx.lineWidth = width; ctx.strokeStyle = col; ctx.shadowColor = hexA(col, 0.9); ctx.shadowBlur = width * 2.5; ctx.stroke(); ctx.restore();
  return ring;
}
function annSpot2d(S) {
  const { ctx, a, g, W, H, t, clk, col, fs, lw, p, hit } = S;
  const ppm = annScale(g, p, W, H), body = ppm * 1.9, x = p.x * W, y = p.y * H, gr = annGrow(a, t, 0.5);
  const R = 1.15 * (0.6 + 0.4 * gr), ring = annRing(g, p, R, W, H); if (!ring) return;
  // light beam from above, with a few brighter streaks
  const bw = ppm * R * 1.5, top = y - body * 2.8;
  const lg = ctx.createLinearGradient(0, top, 0, y);
  lg.addColorStop(0, hexA(col, 0)); lg.addColorStop(0.55, hexA(col, 0.15)); lg.addColorStop(1, hexA(col, 0.4));
  ctx.beginPath(); ctx.moveTo(x - bw * 0.5, top); ctx.lineTo(x + bw * 0.5, top); ctx.lineTo(x + bw, y); ctx.lineTo(x - bw, y); ctx.closePath(); ctx.fillStyle = lg; ctx.fill();
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  [-0.55, 0, 0.5].forEach((f, i) => { const s = ctx.createLinearGradient(0, top, 0, y); s.addColorStop(0, hexA(col, 0)); s.addColorStop(1, hexA(col, 0.18 + 0.06 * Math.sin(clk * 2 + i))); ctx.beginPath(); ctx.moveTo(x + f * bw * 0.5, top); ctx.lineTo(x + f * bw, y); ctx.lineWidth = lw * 1.2; ctx.strokeStyle = s; ctx.stroke(); });
  ctx.restore();
  // pool of light on the grass
  const rg = ctx.createRadialGradient(x, y, 0, x, y, bw);
  rg.addColorStop(0, hexA(col, 0.6)); rg.addColorStop(0.65, hexA(col, 0.25)); rg.addColorStop(1, hexA(col, 0.06));
  polyPath(ctx, ring); ctx.fillStyle = rg; ctx.fill();
  annGroundRing(S, p, R, lw * 1.5);
  // turning dashed outer ring
  const outer = annRing(g, p, R * 1.45, W, H, 48);
  if (outer) { ctx.save(); polyPath(ctx, outer); ctx.setLineDash([lw * 3, lw * 2.2]); ctx.lineDashOffset = -clk * lw * 14; ctx.lineWidth = lw; ctx.strokeStyle = hexA(col, 0.85); ctx.stroke(); ctx.restore(); }
  for (let k = 0; k < 2; k++) {
    const ph = ((clk * 0.9) + k * 0.5) % 1, rp = annRing(g, p, R * (1 + ph * 1.2), W, H);
    if (rp) { polyPath(ctx, rp); ctx.lineWidth = lw * (1.2 - ph * 0.8); ctx.strokeStyle = hexA(col, (1 - ph) * 0.7); ctx.stroke(); }
  }
  // a little marker bobbing above the head
  const head = y - body - fs * 0.6 - Math.abs(Math.sin(clk * 3.2)) * fs * 0.45, cs = fs * 0.55;
  ctx.save(); ctx.beginPath(); ctx.moveTo(x - cs, head - cs * 1.1); ctx.lineTo(x + cs, head - cs * 1.1); ctx.lineTo(x, head); ctx.closePath();
  ctx.fillStyle = col; ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 4; ctx.fill(); ctx.restore();
  let box = null;
  if (a.text) box = annPill(ctx, x, head - cs * 1.1 - fs * 1.1, a.text, col, fs);
  if (hit) { hit.shapes.push({ k: 'poly', P: ring }); hit.shapes.push({ k: 'rect', x: x - bw * 0.6, y: top + (y - top) * 0.45, w: bw * 1.2, h: (y - top) * 0.55 }); if (box) hit.shapes.push(Object.assign({ k: 'rect' }, box)); }
}
function annTag2d(S) {
  const { ctx, a, g, W, H, t, col, fs, tk, p, hit } = S;
  const ppm = annScale(g, p, W, H), x = p.x * W, head = p.y * H - ppm * 1.95, gr = annGrow(a, t, 0.4);
  const text = (a.text || trackLabel(tk)), ty = head - fs * 1.7 - (1 - gr) * fs;
  ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.5, fs * 0.09); ctx.beginPath(); ctx.moveTo(x, head - fs * 0.1); ctx.lineTo(x, ty + fs * 0.8); ctx.stroke();
  ctx.beginPath(); ctx.arc(x, head - fs * 0.1, fs * 0.16, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); ctx.restore();
  const team = tk.kind === 'player' ? teamColor(tk.team) : '#888';
  ctx.save(); ctx.font = `700 ${fs}px Inter, "Segoe UI", Arial, sans-serif`;
  const w = ctx.measureText(text).width + fs * 1.5, h = fs * 1.65, bx = x - w / 2, by = ty - h / 2;
  roundRect(ctx, bx, by, w, h, fs * 0.3); ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = fs * 0.6; ctx.shadowOffsetY = fs * 0.12;
  ctx.fillStyle = 'rgba(10,14,20,.92)'; ctx.fill(); ctx.shadowColor = 'transparent';
  ctx.save(); roundRect(ctx, bx, by, w, h, fs * 0.3); ctx.clip(); ctx.fillStyle = team; ctx.fillRect(bx, by, fs * 0.38, h); ctx.restore();
  roundRect(ctx, bx, by, w, h, fs * 0.3); ctx.lineWidth = Math.max(1.5, fs * 0.09); ctx.strokeStyle = col; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + fs * 0.2, ty + fs * 0.05); ctx.restore();
  if (hit) hit.shapes.push({ k: 'rect', x: bx, y: by, w, h: head - by });
}
function annRun2d(S) {
  const { ctx, a, g, W, H, t, clk, col, lw, hit } = S;
  const path = annRunPath(a); if (!path) return;
  // the path is kept on the grass: pitch metres projected with the calibration of THIS frame
  const P = path.map(q => g && q.m ? annImg(g, q.m[0], q.m[1]) : [q.x, q.y]).filter(Boolean).map(q => [q[0] * W, q[1] * H]);
  if (P.length < 2) return;
  const gr = annGrow(a, t, Math.min(1, (a.t1 - a.t0) * 0.35)), n = Math.max(2, Math.ceil(P.length * gr));
  const done = clamp(Math.round((t - a.t0) / Math.max(0.01, a.t1 - a.t0) * (P.length - 1)), 0, P.length - 1);
  const draw = (pts, width, style, dash) => { if (pts.length < 2) return; polyPath(ctx, pts, true); ctx.lineWidth = width; ctx.strokeStyle = style; ctx.setLineDash(dash || []); ctx.stroke(); ctx.setLineDash([]); };
  const vis = P.slice(0, n), rest = vis.slice(done);
  draw(vis, lw * 3, 'rgba(0,0,0,.35)');
  draw(vis.slice(0, done + 1), lw * 1.5, hexA(col, 0.45), [lw * 2, lw * 2]);       // already run: dashed
  ctx.save(); ctx.shadowColor = hexA(col, 0.8); ctx.shadowBlur = lw * 3; draw(rest, lw * 2.2, hexA(col, 0.55)); ctx.restore();
  // chevrons moving along the run
  if (rest.length > 1) {
    ctx.save(); ctx.fillStyle = col;
    annAlong(rest, lw * 9, clk * lw * 22).forEach(c => { const s = lw * 2.2; ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.a); ctx.beginPath(); ctx.moveTo(s * 0.9, 0); ctx.lineTo(-s * 0.6, -s); ctx.lineTo(-s * 0.1, 0); ctx.lineTo(-s * 0.6, s); ctx.closePath(); ctx.fill(); ctx.restore(); });
    ctx.restore();
  }
  // arrow head in proportion to the run; a target ring where the run ends
  let len = 0; for (let k = 1; k < vis.length; k++) len += Math.hypot(vis[k][0] - vis[k - 1][0], vis[k][1] - vis[k - 1][1]);
  const e = vis[vis.length - 1]; let b = vis[vis.length - 1];
  for (let k = vis.length - 2; k >= 0; k--) { b = vis[k]; if (Math.hypot(e[0] - b[0], e[1] - b[1]) > lw * 3) break; }
  if (len > lw * 4 && Math.hypot(e[0] - b[0], e[1] - b[1]) > 1) annArrowHead(ctx, b[0], b[1], e[0], e[1], clamp(len * 0.25, lw * 2.5, lw * 5.5), col);
  else { ctx.beginPath(); ctx.arc(e[0], e[1], lw * 2.2, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); }
  const last = path[n - 1];
  if (gr >= 1 && last && last.m && g) { const ph = (clk * 0.8) % 1; annGroundRing(S, { m: last.m, x: last.x, y: last.y }, 0.7 + ph * 0.5, lw * 0.9, 1 - ph * 0.7); }
  if (hit) hit.shapes.push({ k: 'poly', P: vis, open: true, line: true });
}
function annLinks2d(S) {
  const { ctx, a, g, W, H, t, clk, col, fs, lw, hit } = S;
  const nodes = a.tracks.map(id => annPos(annTrack(id), t)).filter(Boolean).map(p => ({ p, x: p.x * W, y: p.y * H }));
  if (nodes.length < 2) return;
  annLines2d(S, nodes, a.type === 'chain' && a.fill, a.type === 'link' ? 'link' : 'chain');
}
// lines between players (distance, line, back line): glow, flowing dashes, ground rings, gaps in metres
function annLines2d(S, nodes, fill, style) {
  const { ctx, a, t, clk, col, fs, lw, hit } = S;
  const gr = annGrow(a, t, 0.6);
  if (fill && nodes.length >= 3) { polyPath(ctx, nodes.map(n => [n.x, n.y])); ctx.fillStyle = hexA(col, 0.17 * gr); ctx.fill(); }
  nodes.forEach(n => { if (n.p.m) annGroundRing(S, n.p, 0.75, lw * 1.1, 0.9); });
  const pills = [];
  for (let k = 0; k + 1 < nodes.length; k++) {
    const A = nodes[k], B = nodes[k + 1], ex = A.x + (B.x - A.x) * gr, ey = A.y + (B.y - A.y) * gr;
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(ex, ey); ctx.lineWidth = lw * 3.4; ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.stroke();
    ctx.save(); ctx.shadowColor = hexA(col, 0.9); ctx.shadowBlur = lw * 3;
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(ex, ey); ctx.lineWidth = lw * 1.9; ctx.strokeStyle = style === 'link' ? hexA(col, 0.45) : col; ctx.stroke(); ctx.restore();
    if (style === 'link') { ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(ex, ey); ctx.setLineDash([lw * 4, lw * 3]); ctx.lineDashOffset = -clk * lw * 18; ctx.lineWidth = lw * 1.9; ctx.strokeStyle = col; ctx.stroke(); ctx.setLineDash([]); }
    const d = A.p.m && B.p.m ? Math.hypot(A.p.m[0] - B.p.m[0], A.p.m[1] - B.p.m[1]) : null;
    if (d != null && gr > 0.95 && (style === 'link' || nodes.length <= 6)) pills.push([(A.x + B.x) / 2, (A.y + B.y) / 2, (style === 'link' ? '↔ ' : '') + fmtM(d), style === 'link' ? fs : fs * 0.8]);
    if (hit) hit.shapes.push({ k: 'poly', P: [[A.x, A.y], [B.x, B.y]], open: true, line: true });
  }
  nodes.forEach(n => { ctx.beginPath(); ctx.arc(n.x, n.y, lw * 2.4, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = lw * 0.8; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.stroke(); });
  pills.forEach(([x, y, s, f]) => { const b = annPill(ctx, x, y, s, col, f); if (hit) hit.shapes.push(Object.assign({ k: 'rect' }, b)); });
  if (hit && fill && nodes.length >= 3) hit.shapes.push({ k: 'poly', P: nodes.map(n => [n.x, n.y]) });
}
function annZoneCorners(a) { const [x0, y0, x1, y1] = a.zone; return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }
function annZone2d(S) {
  const { ctx, a, g, W, H, clk, col, fs, lw, hit } = S;
  let P = null, C = null;
  if (a.zone && g) {
    const pts = [], cs = annZoneCorners(a);
    // edges split into pieces, so the perspective bends them correctly
    for (let e = 0; e < 4; e++) { const [ax, ay] = cs[e], [bx, by] = cs[(e + 1) % 4]; for (let k = 0; k < 12; k++) pts.push([ax + (bx - ax) * k / 12, ay + (by - ay) * k / 12]); }
    P = pts.map(([x, y]) => annImg(g, x, y)); if (P.some(q => !q)) return;
    P = P.map(q => [q[0] * W, q[1] * H]); C = [0, 12, 24, 36].map(i => P[i]);
  } else if (a.img) { const [x0, y0, x1, y1] = a.img; P = [[x0 * W, y0 * H], [x1 * W, y0 * H], [x1 * W, y1 * H], [x0 * W, y1 * H]]; C = P; }
  if (!P) return;
  const xs = P.map(q => q[0]), ys = P.map(q => q[1]), minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const fg = ctx.createLinearGradient(0, minY, 0, maxY); fg.addColorStop(0, hexA(col, 0.12)); fg.addColorStop(1, hexA(col, 0.3));
  polyPath(ctx, P); ctx.fillStyle = fg; ctx.fill();
  // moving stripes
  ctx.save(); polyPath(ctx, P); ctx.clip();
  const gap = lw * 7, off = (clk * lw * 6) % gap;
  ctx.strokeStyle = hexA(col, 0.2); ctx.lineWidth = lw * 1.6;
  for (let x = minX - (maxY - minY) - gap + off; x < maxX; x += gap) { ctx.beginPath(); ctx.moveTo(x, maxY); ctx.lineTo(x + (maxY - minY), minY); ctx.stroke(); }
  ctx.restore();
  ctx.save(); ctx.shadowColor = hexA(col, 0.9); ctx.shadowBlur = lw * 3;
  polyPath(ctx, P); ctx.lineWidth = lw * 1.4; ctx.strokeStyle = col; ctx.setLineDash([lw * 5, lw * 3]); ctx.lineDashOffset = -clk * lw * 12; ctx.stroke(); ctx.setLineDash([]);
  // bright corner brackets
  ctx.lineWidth = lw * 2.4; ctx.strokeStyle = col;
  C.forEach((c, i) => { const prev = C[(i + 3) % 4], next = C[(i + 1) % 4], f = 0.18;
    ctx.beginPath(); ctx.moveTo(c[0] + (prev[0] - c[0]) * f, c[1] + (prev[1] - c[1]) * f); ctx.lineTo(c[0], c[1]); ctx.lineTo(c[0] + (next[0] - c[0]) * f, c[1] + (next[1] - c[1]) * f); ctx.stroke(); });
  ctx.restore();
  let box = null;
  if (a.text) box = annPill(ctx, xs.reduce((s, v) => s + v, 0) / xs.length, ys.reduce((s, v) => s + v, 0) / ys.length, a.text, col, fs, false);
  if (hit) { hit.shapes.push({ k: 'poly', P }); if (box) hit.shapes.push(Object.assign({ k: 'rect' }, box)); hit.handles = C; hit.zone = true; }
}
// a band across the pitch at x (perspective), with a light curtain standing on it
function annOffside2d(S) {
  const { ctx, a, g, W, H, t, clk, col, fs, lw, hit } = S;
  if (!g) return;
  const o = annOffside(a, t); if (!o) return;
  const { W: PW } = pitchDims(), gr = annGrow(a, t, 0.6), n = 24, ground = [], band = [[], []];
  for (let k = 0; k <= n; k++) {
    const y = PW * k / n * gr, q = annImg(g, o.x, y), q1 = annImg(g, o.x - 0.3, y), q2 = annImg(g, o.x + 0.3, y);
    if (!q || !q1 || !q2) continue;
    ground.push([q[0] * W, q[1] * H]); band[0].push([q1[0] * W, q1[1] * H]); band[1].push([q2[0] * W, q2[1] * H]);
  }
  if (ground.length < 2) return;
  // curtain: from the line up to about a player's height
  const top = ground.map(([x, y], i) => { const ppm = annScale(g, { m: [o.x, PW * i / n] }, W, H); return [x, y - ppm * 2.1]; });
  const cg = ctx.createLinearGradient(0, Math.min(...top.map(q => q[1])), 0, Math.max(...ground.map(q => q[1])));
  cg.addColorStop(0, hexA(col, 0)); cg.addColorStop(1, hexA(col, 0.26));
  ctx.beginPath(); ground.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); for (let i = top.length - 1; i >= 0; i--) ctx.lineTo(top[i][0], top[i][1]); ctx.closePath(); ctx.fillStyle = cg; ctx.fill();
  polyPath(ctx, band[0].concat(band[1].slice().reverse())); ctx.fillStyle = hexA(col, 0.45); ctx.fill();
  ctx.save(); ctx.shadowColor = hexA(col, 1); ctx.shadowBlur = lw * 4; polyPath(ctx, ground, true); ctx.lineWidth = lw * 1.3; ctx.strokeStyle = col; ctx.stroke(); ctx.restore();
  // a light running along the line
  const ph = (clk * 0.35) % 1, i = Math.floor(ph * (ground.length - 1));
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; const rg = ctx.createRadialGradient(ground[i][0], ground[i][1], 0, ground[i][0], ground[i][1], lw * 10); rg.addColorStop(0, hexA(col, 0.7)); rg.addColorStop(1, hexA(col, 0)); ctx.fillStyle = rg; ctx.fillRect(ground[i][0] - lw * 10, ground[i][1] - lw * 10, lw * 20, lw * 20); ctx.restore();
  const end = ground[ground.length - 1];
  const box = annPill(ctx, end[0], end[1] - fs * 1.4, a.text || (o.approx ? 'Offside line (no GK)' : 'Offside line'), col, fs * 0.9);
  if (hit) { hit.shapes.push({ k: 'poly', P: band[0].concat(band[1].slice().reverse()) }); hit.shapes.push(Object.assign({ k: 'rect' }, box)); }
}
function annBack2d(S) {
  const { ctx, a, t, W, H, col, fs, hit } = S;
  const b = annBackLine(a, t); if (!b) return;
  const nodes = b.nodes.map(o => ({ p: o.p, x: o.p.x * W, y: o.p.y * H }));
  annLines2d(S, nodes, false, 'chain');
  const top = nodes.reduce((m, n) => n.y < m.y ? n : m, nodes[0]), mid = nodes[Math.floor(nodes.length / 2)];
  const box = annPill(ctx, (top.x + mid.x) / 2, Math.min(...nodes.map(n => n.y)) - fs * 2.2, `${a.text || 'Back line'} · ${Math.round(b.height)} m from goal`, col, fs * 0.9, false);
  if (hit) hit.shapes.push(Object.assign({ k: 'rect' }, box));
}

/* ---------------------------------------------------------------- the 2D pitch (SVG, metres) */
function annSvg(t) {
  const list = annActive(t); if (!list.length) return '';
  const clk = annClock(t), { L, W } = pitchDims(); let s = '';
  const lines = (pts, col, dash, labels) => {
    let seg = '';
    for (let k = 0; k + 1 < pts.length; k++) {
      const A = pts[k], B = pts[k + 1], d = Math.hypot(A[0] - B[0], A[1] - B[1]);
      seg += `<line x1="${A[0].toFixed(2)}" y1="${A[1].toFixed(2)}" x2="${B[0].toFixed(2)}" y2="${B[1].toFixed(2)}" stroke="${col}" stroke-width=".45" ${dash ? 'stroke-dasharray="1.2 .8"' : ''}/>`;
      if (labels) seg += `<text x="${((A[0] + B[0]) / 2).toFixed(2)}" y="${((A[1] + B[1]) / 2 - 0.8).toFixed(2)}" font-size="1.8" text-anchor="middle" fill="#fff" font-weight="700" stroke="#000" stroke-width=".3" paint-order="stroke">${fmtM(d)}</text>`;
    }
    return seg;
  };
  list.forEach(a => {
    const al = annAlpha(a, t).toFixed(2), col = esc(a.color || '#ffd23b');
    if (a.type === 'zone' && a.zone) {
      const [x0, y0, x1, y1] = a.zone;
      s += `<g opacity="${al}"><rect x="${Math.min(x0, x1)}" y="${Math.min(y0, y1)}" width="${Math.abs(x1 - x0)}" height="${Math.abs(y1 - y0)}" fill="${col}" fill-opacity=".2" stroke="${col}" stroke-width=".4" stroke-dasharray="1.4 .9"/>${a.text ? `<text x="${(x0 + x1) / 2}" y="${(y0 + y1) / 2 + 0.7}" font-size="2.2" text-anchor="middle" fill="#fff" font-weight="700">${esc(a.text)}</text>` : ''}</g>`;
      return;
    }
    if (a.type === 'offside') {
      const o = annOffside(a, t); if (!o) return;
      s += `<g opacity="${al}"><rect x="${(o.x - 0.35).toFixed(2)}" y="0" width=".7" height="${W}" fill="${col}" fill-opacity=".35"/><line x1="${o.x.toFixed(2)}" y1="0" x2="${o.x.toFixed(2)}" y2="${W}" stroke="${col}" stroke-width=".35"/><text x="${o.x.toFixed(2)}" y="${(W - 1).toFixed(2)}" font-size="1.9" text-anchor="middle" fill="${col}" font-weight="700" stroke="#000" stroke-width=".3" paint-order="stroke">offside</text></g>`;
      return;
    }
    if (a.type === 'backline') {
      const b = annBackLine(a, t); if (!b) return;
      const pts = b.nodes.map(o => o.p.m);
      s += `<g opacity="${al}">${lines(pts, col, false, true)}${pts.map(m => `<circle cx="${m[0].toFixed(2)}" cy="${m[1].toFixed(2)}" r="1.1" fill="none" stroke="${col}" stroke-width=".35"/>`).join('')}</g>`;
      return;
    }
    if (a.type === 'run') {
      const p = annRunPath(a); if (!p) return; const m = p.filter(q => q.m).map(q => q.m); if (m.length < 2) return;
      const e = m[m.length - 1], b = m[Math.max(0, m.length - 4)], ang = Math.atan2(e[1] - b[1], e[0] - b[0]);
      const hd = [[e[0] + Math.cos(ang) * 1.2, e[1] + Math.sin(ang) * 1.2], [e[0] + Math.cos(ang + 2.5) * 1.6, e[1] + Math.sin(ang + 2.5) * 1.6], [e[0] + Math.cos(ang - 2.5) * 1.6, e[1] + Math.sin(ang - 2.5) * 1.6]];
      s += `<g opacity="${al}"><path d="M${m.map(q => q[0].toFixed(2) + ',' + q[1].toFixed(2)).join('L')}" fill="none" stroke="${col}" stroke-width=".55" stroke-linecap="round"/><path d="M${hd.map(q => q[0].toFixed(2) + ',' + q[1].toFixed(2)).join('L')}Z" fill="${col}"/></g>`;
      return;
    }
    const ms = a.tracks.map(id => { const p = annPos(annTrack(id), t); return p && p.m ? p.m : null; });
    if (a.type === 'spot' || a.type === 'label') {
      const m = ms[0]; if (!m) return;
      const ph = (clk * 0.9) % 1;
      s += `<g opacity="${al}">${a.type === 'spot' ? `<circle cx="${m[0].toFixed(2)}" cy="${m[1].toFixed(2)}" r="3.2" fill="${col}" fill-opacity=".28" stroke="${col}" stroke-width=".45"/><circle cx="${m[0].toFixed(2)}" cy="${m[1].toFixed(2)}" r="${(3.2 + ph * 3).toFixed(2)}" fill="none" stroke="${col}" stroke-opacity="${(1 - ph).toFixed(2)}" stroke-width=".3"/>` : ''}
        ${a.type === 'label' || a.text ? `<text x="${m[0].toFixed(2)}" y="${(m[1] - 3.4).toFixed(2)}" font-size="2.1" text-anchor="middle" fill="${col}" font-weight="700" stroke="#000" stroke-width=".35" paint-order="stroke">${esc(a.text || trackLabel(annTrack(a.tracks[0])))}</text>` : ''}</g>`;
      return;
    }
    const pts = ms.filter(Boolean); if (pts.length < 2) return;
    const fill = a.type === 'chain' && a.fill && pts.length >= 3 ? `<polygon points="${pts.map(q => q[0].toFixed(2) + ',' + q[1].toFixed(2)).join(' ')}" fill="${col}" fill-opacity=".15"/>` : '';
    s += `<g opacity="${al}">${fill}${lines(pts, col, a.type === 'link', a.type === 'link' || pts.length <= 6)}</g>`;
  });
  return s;
}

/* ---------------------------------------------------------------- the live overlay on the video */
function annPlace() {
  const r = frameRect(), c = annView;
  c.style.left = r.left + 'px'; c.style.top = r.top + 'px'; c.style.width = r.w + 'px'; c.style.height = r.h + 'px';
  const w = Math.round(r.w * devicePixelRatio), h = Math.round(r.h * devicePixelRatio);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
}
function paintAnnotations() {
  if (!hasVideo()) { annView.classList.add('hidden'); return; }
  const t = video.currentTime, any = Ann.on || annActive(t).length;
  annView.classList.toggle('hidden', !any);
  if (!any) return;
  // palette open but tracking mode on and no tool chosen: the clicks belong to the tracking layer underneath
  annView.classList.toggle('live', Ann.on && !(typeof TR !== 'undefined' && TR.on && !Ann.tool));
  annPlace();
  const ctx = annView.getContext('2d'), W = annView.width, H = annView.height; ctx.clearRect(0, 0, W, H);
  Ann.hits = [];
  drawAnnotations(ctx, W, H, t, { hits: Ann.hits, sel: Ann.sel });
  if (!Ann.on) return;
  const fs = Math.max(11, Math.round(H * 0.022));
  // authoring: the player under the mouse, the players picked so far and the zone being dragged
  const ring = (id, label, dashed) => { const p = annPos(annTrack(id), t); if (!p) return; ctx.save(); ctx.strokeStyle = Ann.color; ctx.lineWidth = 3; if (dashed) ctx.setLineDash([5, 4]); ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 4; ctx.beginPath(); ctx.arc(p.x * W, p.y * H - W * 0.006, Math.max(14, W / 70), 0, Math.PI * 2); ctx.stroke(); ctx.restore(); if (label) annPill(ctx, p.x * W, p.y * H - Math.max(30, W / 36), label, Ann.color, fs, !dashed); };
  if (Ann.tool && Ann.tool !== 'zone' && Ann.hover && !Ann.picks.includes(Ann.hover)) { const tk = annTrack(Ann.hover); if (tk) ring(Ann.hover, (ANN_TEAM_TYPES.has(Ann.tool) ? teamName(tk.team) + ' · ' : '') + trackLabel(tk), false); }
  Ann.picks.forEach((id, i) => ring(id, String(i + 1), true));
  if (Ann.drag) { const d = Ann.drag; ctx.save(); ctx.strokeStyle = Ann.color; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.fillStyle = hexA(Ann.color, 0.12); ctx.fillRect(d.x0 * W, d.y0 * H, (d.x1 - d.x0) * W, (d.y1 - d.y0) * H); ctx.strokeRect(d.x0 * W, d.y0 * H, (d.x1 - d.x0) * W, (d.y1 - d.y0) * H); ctx.restore(); }
}
// keep the effects moving while the video is paused
function annLoop() {
  Ann.raf = 0;
  if (!hasVideo() || !video.paused || Ann.exporting) return;
  if (!Ann.on && !annActive(video.currentTime).length) return;
  paintAnnotations();
  if (!$('#pitch2d').classList.contains('hidden')) render2D(true);
  Ann.raf = requestAnimationFrame(() => setTimeout(annLoop, 33));
}
function annKick() { if (!Ann.raf) Ann.raf = requestAnimationFrame(annLoop); }

/* ---------------------------------------------------------------- authoring */
function annSetTool(tool) {
  Ann.tool = Ann.tool === tool ? null : tool; Ann.picks = []; Ann.drag = null;
  if (Ann.tool) annSelect(null);
  $$('#annBar [data-ann]').forEach(b => b.classList.toggle('on', b.dataset.ann === Ann.tool));
  $('#annDone').classList.toggle('hidden', Ann.tool !== 'chain');
  annView.classList.toggle('edit', !!Ann.tool);
  $('#annHint').textContent = Ann.tool ? ANN_TYPES[Ann.tool].hint : 'Choose what to add, then click the players on the video (or in the 3D view) – or say / type it: “spotlight 9”, “distance 9 and 4”, “offside line away”. Click an annotation to select it: colour, longer / shorter, delete – drag a zone or its corners.';
  if (Ann.tool && hasVideo()) video.pause();
  paintAnnotations(); if (typeof V3 !== 'undefined') V3.dirty = true;
}
function annOpen() {
  if (!hasVideo()) { toast('Open a video first', 'bad'); return; }
  if (!TR.tracks.some(tk => tk.kind === 'player' && tk.points.length)) toast('Annotations follow tracked players – track players first (🤖 Auto-detect or by hand). Zones work anyway.', 'info', 5000);
  if (typeof Draw !== 'undefined' && Draw.editing) Draw.close();
  Ann.on = true; $('#annBar').classList.remove('hidden'); $('#annInfo').classList.remove('hidden'); $('#btnAnn').classList.add('on'); annView.classList.add('live');
  annSetTool(null); annCount(); paintAnnotations(); annKick();
  ANN_SHOW.forEach(f => f());
}
function annClose() { Ann.on = false; Ann.tool = null; Ann.picks = []; Ann.drag = null; Ann.hover = null; annSelect(null); $('#annBar').classList.add('hidden'); $('#annInfo').classList.add('hidden'); $('#annPop').classList.add('hidden'); $('#btnAnn').classList.remove('on'); annView.classList.remove('edit', 'live'); paintAnnotations(); }
function annCount() { $('#annN').textContent = (TR.anns || []).length; }
function annEnd(t0) {
  const v = $('#annDur').value;
  if (v === 'out' && clipIO.out != null && clipIO.out > t0 + 0.3) return clipIO.out;
  return Math.min(video.duration || t0 + 4, t0 + (Number(v) || 4));
}
function annChanged() { markDirty(); autosave(); annCount(); paintAnnotations(); if (typeof render2D === 'function') render2D(true); if (typeof V3 !== 'undefined') V3.dirty = true; annKick(); annSelBar(); }
function annAdd(a) {
  checkpoint();
  TR.anns = TR.anns || [];
  const t0 = Math.round(video.currentTime * 1000) / 1000;
  const x = Object.assign({ id: uid(), t0, t1: Math.round(annEnd(t0) * 1000) / 1000, color: Ann.color, text: '' }, a);
  TR.anns.push(x);
  annChanged();
  toast(`${ANN_TYPES[x.type].icon} ${ANN_TYPES[x.type].name} added: ${annName(x)} · ${fmtTime(x.t0)}–${fmtTime(x.t1)}`, 'ok', 2500);
  return x;
}
// a player was picked (on the video or in the 3D view)
async function annPickTrack(tk) {
  if (!Ann.on || !Ann.tool || Ann.tool === 'zone' || !tk) return false;
  const T = ANN_TYPES[Ann.tool];
  if (ANN_TEAM_TYPES.has(Ann.tool)) {
    if (tk.kind !== 'player' || (tk.team !== 'Home' && tk.team !== 'Away')) { toast('Click a player of one of the two teams', 'bad', 2000); return true; }
    if (Ann.tool === 'offside' && !TR.cals.some(c => c.type !== 'none')) { toast('The offside line needs the pitch calibration', 'bad', 3000); return true; }
    annAdd({ type: Ann.tool, tracks: [tk.id], team: tk.team, text: '' });
    return true;
  }
  if (Ann.picks.includes(tk.id)) { Ann.picks = Ann.picks.filter(id => id !== tk.id); paintAnnotations(); return true; }
  Ann.picks.push(tk.id); paintAnnotations(); if (typeof V3 !== 'undefined') V3.dirty = true;
  if (Ann.picks.length >= T.picks) {
    const tracks = Ann.picks.slice(); Ann.picks = [];
    let text = '';
    if (Ann.tool === 'label') { text = await Dlg.ask('Name tag', 'Text on the tag (leave as it is for the player’s name):', trackLabel(tk)); if (text == null) { paintAnnotations(); return true; } if (text === trackLabel(tk)) text = ''; }
    annAdd({ type: Ann.tool, tracks, text });
  } else $('#annHint').textContent = `${T.hint}  (${Ann.picks.length} picked)`;
  return true;
}
// a zone dragged as a box (pitch metres, or picture coordinates without calibration)
async function annAddZone(box, img) {
  const text = await Dlg.ask('Zone', 'Text in the zone (optional), e.g. “Space” or “Overload”:', '');
  if (text == null) { paintAnnotations(); return null; }
  return img ? annAdd({ type: 'zone', tracks: [], img: box, text }) : annAdd({ type: 'zone', tracks: [], zone: box, text });
}
function annPitchBox(xs, ys) { const { L, W } = pitchDims(); return [clamp(Math.min(...xs), -3, L + 3), clamp(Math.min(...ys), -3, W + 3), clamp(Math.max(...xs), -3, L + 3), clamp(Math.max(...ys), -3, W + 3)].map(v => Math.round(v * 10) / 10); }
function annMouse(e) { const r = annView.getBoundingClientRect(); return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1), px: (e.clientX - r.left) * annView.width / r.width, py: (e.clientY - r.top) * annView.height / r.height, r }; }
function annHit(e) {
  const m = annMouse(e), r = m.r, t = video.currentTime;
  let best = null;
  TR.tracks.forEach(tk => {
    if (tk.kind === 'ball' || !trackDrawn(tk)) return;
    const p = annPos(tk, t); if (!p) return;
    // the feet point, or anywhere on the body above it (up to 6 % of the picture height)
    const px = (m.x - p.x) * r.width, py = (m.y - p.y) * r.height, d = Math.hypot(px, py > 0 ? py : Math.max(0, -py - r.height * 0.06));
    if (d < Math.max(22, r.width / 45) && (!best || d < best.d)) best = { tk, d };
  });
  return { x: m.x, y: m.y, tk: best && best.tk };
}
// which annotation is under the mouse (topmost first), from the shapes recorded while drawing
function annHitAnn(e) {
  const m = annMouse(e), tol = Math.max(8, annView.width / 160);
  const inPoly = (P, x, y) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) if ((P[i][1] > y) !== (P[j][1] > y) && x < (P[j][0] - P[i][0]) * (y - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) c = !c; return c; };
  const segD = (x, y, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy, u = l ? clamp(((x - a[0]) * dx + (y - a[1]) * dy) / l, 0, 1) : 0; return Math.hypot(x - a[0] - u * dx, y - a[1] - u * dy); };
  for (let i = Ann.hits.length - 1; i >= 0; i--) {
    const h = Ann.hits[i];
    for (const s of h.shapes) {
      if (s.k === 'rect' && m.px >= s.x - 3 && m.px <= s.x + s.w + 3 && m.py >= s.y - 3 && m.py <= s.y + s.h + 3) return { h, m };
      if (s.k === 'poly' && s.line) { for (let k = 1; k < s.P.length; k++) if (segD(m.px, m.py, s.P[k - 1], s.P[k]) < tol) return { h, m }; }
      else if (s.k === 'poly' && inPoly(s.P, m.px, m.py)) return { h, m };
      if (s.k === 'circle' && Math.hypot(m.px - s.x, m.py - s.y) < s.r + tol) return { h, m };
    }
  }
  return null;
}
const annById = id => (TR.anns || []).find(a => a.id === id);

/* ---------------------------------------------------------------- selecting and editing */
function annSelect(id) {
  Ann.sel = id && annById(id) ? id : null;
  annSelBar(); paintAnnotations(); if (typeof V3 !== 'undefined') V3.dirty = true;
}
function annSelBar() {
  const box = $('#annSel'); if (!box) return;
  const a = Ann.sel ? annById(Ann.sel) : null;
  box.classList.toggle('hidden', !a);
  if (!a) return;
  box.innerHTML = `<span class="chip" style="background:${esc(a.color)}"></span><b>${ANN_TYPES[a.type].icon} ${esc(annName(a))}</b><span class="muted">${fmtTime(a.t0)}–${fmtTime(a.t1)}</span>
    <button class="small" id="annSelStart" title="Let it start at the current moment">⇤ start here</button><button class="small" id="annSelEnd" title="Let it end at the current moment">end here ⇥</button>
    <button class="small" id="annSelShort" title="Shorter (−1 s)">−1 s</button><button class="small" id="annSelLong" title="Longer (+1 s)">+1 s</button>
    ${a.type !== 'run' ? `<button class="small" id="annSelText" title="Text">✎ text</button>` : ''}
    <button class="small danger" id="annSelDel" title="Delete (Delete key)">🗑</button><button class="small" id="annSelX" title="Deselect (Esc)">✕</button>
    <span class="muted small">· click a colour to recolour it</span>`;
  const len = d => { checkpoint(); a.t1 = Math.max(a.t0 + 0.5, Math.round((a.t1 + d) * 1000) / 1000); annChanged(); };
  box.querySelector('#annSelShort').onclick = () => len(-1);
  const now = () => Math.round(video.currentTime * 1000) / 1000;
  box.querySelector('#annSelStart').onclick = () => { const t = now(); if (t >= a.t1 - 0.3) { toast('The start must be before the end (' + fmtTime(a.t1) + ')', 'bad'); return; } checkpoint(); a.t0 = t; annChanged(); };
  box.querySelector('#annSelEnd').onclick = () => { const t = now(); if (t <= a.t0 + 0.3) { toast('The end must be after the start (' + fmtTime(a.t0) + ')', 'bad'); return; } checkpoint(); a.t1 = t; annChanged(); };
  box.querySelector('#annSelLong').onclick = () => len(1);
  box.querySelector('#annSelDel').onclick = () => annDelete(a.id);
  box.querySelector('#annSelX').onclick = () => annSelect(null);
  const tb = box.querySelector('#annSelText'); if (tb) tb.onclick = async () => { const v = await Dlg.ask('Text', 'Text shown with this annotation (empty = default):', a.text || ''); if (v == null) return; checkpoint(); a.text = v.trim(); annChanged(); };
}
function annDelete(id) {
  checkpoint(); TR.anns = (TR.anns || []).filter(a => a.id !== id); if (Ann.sel === id) Ann.sel = null; annChanged();
  toast('Annotation deleted (Ctrl+Z brings it back)', 'info', 2000);
}
function annSetColour(col) {
  Ann.color = col; $$('#annBar [data-acolor]').forEach(x => x.classList.toggle('on', x.dataset.acolor === col));
  const a = Ann.sel && annById(Ann.sel);
  if (a && a.color !== col) { checkpoint(); a.color = col; annChanged(); }
  paintAnnotations();
}
// dragging a selected zone (inside = move, near a corner = resize); works in pitch metres
function annZoneDragStart(a, h, m) {
  const t = video.currentTime;
  if (a.zone) {
    const g = annGeo(t); if (!g) return null;
    const corner = (h.handles || []).findIndex(([x, y]) => Math.hypot(x - m.px, y - m.py) < Math.max(10, annView.width / 110));
    const p0 = toPitch(t, m.x, m.y); if (!p0) return null;
    return { a, corner, p0, z0: a.zone.slice(), moved: false };
  }
  if (a.img) return { a, corner: -1, p0: [m.x, m.y], z0: a.img.slice(), img: true, moved: false };
  return null;
}
function annZoneDragMove(e) {
  const d = Ann.edit, m = annMouse(e), t = video.currentTime;
  const p = d.img ? [m.x, m.y] : toPitch(t, m.x, m.y); if (!p) return;
  if (!d.moved) { checkpoint(); d.moved = true; }
  const z = d.z0.slice(), dx = p[0] - d.p0[0], dy = p[1] - d.p0[1];
  if (d.corner < 0) { z[0] += dx; z[2] += dx; z[1] += dy; z[3] += dy; }
  else { const xi = d.corner === 0 || d.corner === 3 ? 0 : 2, yi = d.corner < 2 ? 1 : 3; z[xi] = p[0]; z[yi] = p[1]; }
  const nz = [Math.min(z[0], z[2]), Math.min(z[1], z[3]), Math.max(z[0], z[2]), Math.max(z[1], z[3])].map(v => Math.round(v * (d.img ? 1000 : 10)) / (d.img ? 1000 : 10));
  if (d.img) d.a.img = nz; else d.a.zone = nz;
  paintAnnotations(); if (typeof render2D === 'function') render2D(true); if (typeof V3 !== 'undefined') V3.dirty = true;
}

/* ---------------------------------------------------------------- mouse on the video */
annView.addEventListener('mousedown', async e => {
  if (!Ann.on || e.button !== 0) return;
  e.preventDefault();
  if (Ann.tool === 'zone') { const h = annHit(e); Ann.drag = { x0: h.x, y0: h.y, x1: h.x, y1: h.y }; return; }
  if (Ann.tool) { const h = annHit(e); if (!h.tk) { toast('Click a tracked player (their marker on the video)', 'bad', 1800); return; } annPickTrack(h.tk); return; }
  // no tool: the corner handles of the selected zone first (they sit on its edge), then select / drag an annotation
  if (Ann.sel) {
    const a = annById(Ann.sel), h = Ann.hits.find(x => x.id === Ann.sel), m = annMouse(e);
    if (a && a.type === 'zone' && h && (h.handles || []).some(([x, y]) => Math.hypot(x - m.px, y - m.py) < Math.max(10, annView.width / 110))) { Ann.edit = annZoneDragStart(a, h, m); return; }
  }
  const hit = annHitAnn(e);
  if (!hit) { annSelect(null); return; }
  if (Ann.sel !== hit.h.id) annSelect(hit.h.id);
  const a = annById(hit.h.id);
  if (a && a.type === 'zone') Ann.edit = annZoneDragStart(a, hit.h, hit.m);
});
annView.addEventListener('mousemove', e => {
  if (!Ann.on || Ann.drag || Ann.edit) return;
  let cur = 'default';
  if (Ann.tool && Ann.tool !== 'zone') { const h = annHit(e), id = h.tk ? h.tk.id : null; if (id !== Ann.hover) { Ann.hover = id; paintAnnotations(); } cur = id ? 'pointer' : 'crosshair'; }
  else if (Ann.tool === 'zone') cur = 'crosshair';
  else if (Ann.sel && (() => { const a = annById(Ann.sel), h = Ann.hits.find(x => x.id === Ann.sel), m = annMouse(e); return a && a.type === 'zone' && h && (h.handles || []).some(([x, y]) => Math.hypot(x - m.px, y - m.py) < Math.max(10, annView.width / 110)); })()) cur = 'nwse-resize';
  else { const hit = annHitAnn(e); if (hit) { const a = annById(hit.h.id), corner = a && a.type === 'zone' && Ann.sel === a.id && (hit.h.handles || []).some(([x, y]) => Math.hypot(x - hit.m.px, y - hit.m.py) < Math.max(10, annView.width / 110)); cur = corner ? 'nwse-resize' : a && a.type === 'zone' && Ann.sel === a.id ? 'move' : 'pointer'; } }
  if (Ann.cursor !== cur) { annView.style.cursor = cur; Ann.cursor = cur; }
});
annView.addEventListener('mouseleave', () => { if (Ann.hover) { Ann.hover = null; paintAnnotations(); } });
window.addEventListener('mousemove', e => {
  if (Ann.edit) { annZoneDragMove(e); return; }
  if (!Ann.drag) return;
  const r = annView.getBoundingClientRect();
  Ann.drag.x1 = clamp((e.clientX - r.left) / r.width, 0, 1); Ann.drag.y1 = clamp((e.clientY - r.top) / r.height, 0, 1);
  paintAnnotations();
});
window.addEventListener('mouseup', async () => {
  if (Ann.edit) { const d = Ann.edit; Ann.edit = null; if (d.moved) annChanged(); return; }
  if (!Ann.drag) return;
  const d = Ann.drag; Ann.drag = null;
  if (Math.abs(d.x1 - d.x0) < 0.01 || Math.abs(d.y1 - d.y0) < 0.01) { paintAnnotations(); return; }
  const t = video.currentTime, c = [[d.x0, d.y0], [d.x1, d.y1], [d.x1, d.y0], [d.x0, d.y1]].map(([x, y]) => toPitch(t, x, y));
  if (c.every(Boolean)) await annAddZone(annPitchBox(c.map(q => q[0]), c.map(q => q[1])));
  else await annAddZone([Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.max(d.x0, d.x1), Math.max(d.y0, d.y1)], true);
});
function annFinishChain() {
  if (Ann.tool !== 'chain') return;
  if (Ann.picks.length < 2) { toast('Pick at least two players for a line', 'bad'); return; }
  const tracks = Ann.picks.slice(); Ann.picks = [];
  annAdd({ type: 'chain', tracks, fill: tracks.length >= 3 && confirm('Shade the area between these ' + tracks.length + ' players?\n\nOK = line with shaded area\nCancel = just the line') });
  $('#annHint').textContent = ANN_TYPES.chain.hint;
}
// step through the annotations like slides (for a team talk): jump to the next / previous one, paused, selected
function annStep(dir) {
  const list = (TR.anns || []).slice().sort((a, b) => a.t0 - b.t0); if (!list.length) { toast('No annotations yet', 'info'); return; }
  const cur = Ann.sel ? list.findIndex(a => a.id === Ann.sel) : -1, now = video.currentTime;
  let k;
  if (cur >= 0) k = cur + dir;                                   // from the selected one to its neighbour
  else if (dir > 0) k = list.findIndex(a => a.t0 >= now - 0.05);  // from the current moment
  else { k = -1; list.forEach((a, i) => { if (a.t0 < now - 0.05) k = i; }); }
  if (k < 0 || k >= list.length) { toast(dir > 0 ? 'That was the last annotation' : 'That was the first annotation', 'info', 1500); return; }
  const next = list[k];
  video.pause(); video.currentTime = Math.min(next.t1, next.t0 + 0.6); annSelect(next.id);
  toast(`${ANN_TYPES[next.type].icon} ${k + 1} / ${list.length}: ${annName(next)}`, 'info', 1800);
}
function annListPop() {
  const pop = $('#annPop');
  if (!pop.classList.contains('hidden')) { pop.classList.add('hidden'); return; }
  const list = (TR.anns || []).slice().sort((a, b) => a.t0 - b.t0);
  pop.innerHTML = list.length ? list.map(a => `<div class="arow ${a.id === Ann.sel ? 'on' : ''}"><span class="chip" style="background:${esc(a.color)}"></span><span>${ANN_TYPES[a.type].icon}</span>
      <span class="grow" title="${esc(annName(a))}">${esc(annName(a))}</span><span class="muted">${fmtTime(a.t0)}–${fmtTime(a.t1)}</span>
      <button class="small" data-ajump="${a.id}" title="Go there and select it">▶</button><button class="small" data-alen="${a.id}" title="Longer (+1 s)">+</button><button class="small" data-ashort="${a.id}" title="Shorter (−1 s)">−</button><button class="small danger" data-adel="${a.id}" title="Delete">✕</button></div>`).join('')
    : '<p class="small muted" style="margin:4px">No annotations yet.</p>';
  const br = $('#annBar').getBoundingClientRect();
  pop.style.left = Math.round(br.right + 8) + 'px'; pop.style.top = Math.round(Math.max(8, Math.min(br.top, window.innerHeight - 320))) + 'px';
  pop.classList.remove('hidden');
  // the palette was moved to the right: the list opens on its left side
  const pw = pop.getBoundingClientRect().width; if (br.right + 8 + pw > window.innerWidth - 4) pop.style.left = Math.round(Math.max(4, br.left - 8 - pw)) + 'px';
  const find = id => (TR.anns || []).find(a => a.id === id);
  pop.querySelectorAll('[data-ajump]').forEach(b => b.onclick = () => { const a = find(b.dataset.ajump); if (a) { video.pause(); video.currentTime = Math.min(a.t1, a.t0 + 0.6); annSelect(a.id); } });
  const len = (id, d) => { const a = find(id); if (!a) return; checkpoint(); a.t1 = Math.max(a.t0 + 0.5, Math.round((a.t1 + d) * 1000) / 1000); annChanged(); pop.classList.add('hidden'); annListPop(); };
  pop.querySelectorAll('[data-alen]').forEach(b => b.onclick = () => len(b.dataset.alen, 1));
  pop.querySelectorAll('[data-ashort]').forEach(b => b.onclick = () => len(b.dataset.ashort, -1));
  pop.querySelectorAll('[data-adel]').forEach(b => b.onclick = () => { annDelete(b.dataset.adel); pop.classList.add('hidden'); annListPop(); });
}

/* ---------------------------------------------------------------- MP4 with the annotations burnt in */
// The annotations are drawn frame by frame (exactly, from the tracking data) on a transparent picture; ffmpeg lays
// them over the original video – no slow frame-by-frame seeking in the player.
async function annExport() {
  if (!api.v3dBegin) { toast('Saving the video works in the installed desktop app', 'bad'); return; }
  if (Ann.exporting || (typeof PL !== 'undefined' && PL.job) || (typeof V3 !== 'undefined' && V3.exporting)) { toast('Another video is being saved – wait until it is finished', 'bad', 3000); return; }
  const anns = TR.anns || [];
  let t0, t1;
  if (clipIO.in != null && clipIO.out != null && clipIO.out > clipIO.in) { t0 = clipIO.in; t1 = clipIO.out; }
  else if (anns.length) { t0 = Math.max(0, Math.min(...anns.map(a => a.t0)) - 1); t1 = Math.min(video.duration || 1e9, Math.max(...anns.map(a => a.t1)) + 1); }
  else { toast('Add an annotation (or set clip IN and OUT) first', 'bad'); return; }
  let opt = null;
  const r = await Dlg.open('🎬 Video with annotations', `<p>From <b>${fmtTime(t0)}</b> to <b>${fmtTime(t1)}</b> (${(t1 - t0).toFixed(1)} s)${clipIO.in != null && clipIO.out != null ? ' – the clip IN–OUT marks' : ' – around your annotations (set clip IN / OUT to choose)'}.</p>
    <label class="blk"><input type="checkbox" id="aeTags"> Also show the tracking markers of all players</label>
    <label class="blk"><input type="checkbox" id="aeSound" checked> Keep the sound</label>
    <label class="blk">Size <select id="aeSize"><option value="1080">1080p</option><option value="720" selected>720p (faster)</option></select></label>`,
  [{ label: 'Cancel' }, { label: 'Save MP4', primary: true, value: 'go', onClick: () => { opt = { tags: $('#aeTags').checked, sound: $('#aeSound').checked, size: Number($('#aeSize').value) }; } }]);
  if (r !== 'go' || !opt) return null;
  return annRender(t0, t1, opt);
}
async function annRender(t0, t1, opt) {
  const vw = video.videoWidth || 1920, vh = video.videoHeight || 1080, hh = Math.min(opt.size || 720, vh), ww = Math.round(vw * hh / vh / 2) * 2;
  const fps = clamp(Math.round(1 / frameDur()), 10, 60);
  const base = `${(project.info && project.info.name) || 'match'} annotated ${fmtTime(t0).replace(':', '-')}-${fmtTime(t1).replace(':', '-')}.mp4`.replace(/[\\/:*?"<>|]/g, '');
  const b = await api.v3dBegin({ defaultName: project.dir ? project.dir + '/clips/' + base : base, fps, w: ww, h: hh, title: 'Save video with annotations',
    under: { path: videoInfo.playPath || videoInfo.path, t0, dur: t1 - t0, sound: !!opt.sound } });
  if (!b || !b.ok) { if (b && b.error) toast('Could not start the video: ' + b.error, 'bad', 5000); return null; }
  video.pause();
  const c = document.createElement('canvas'); c.width = ww; c.height = hh;
  const ctx = c.getContext('2d'), n = Math.max(1, Math.round((t1 - t0) * fps));
  const job = Ann.exporting = { cancel: false };
  const bar = document.createElement('div'); bar.className = 'exportbox'; bar.style.cssText = 'position:absolute;left:50%;top:40%;transform:translate(-50%,-50%);z-index:20;min-width:280px;text-align:center';
  bar.innerHTML = '<b>🎬 Saving the video with annotations…</b><div class="aibar"><div style="width:0%"></div></div><div class="small muted" id="aeTxt"></div><button class="small danger">Cancel</button>';
  $('#videoWrap').appendChild(bar); bar.querySelector('button').onclick = () => { job.cancel = true; };
  const realNow = video.currentTime;
  let res = null;
  try {
    for (let k = 0; k < n && !job.cancel; k++) {
      const t = t0 + k / fps;
      ctx.clearRect(0, 0, ww, hh);
      if (opt.tags) drawTrackingOverlay(ctx, ww, hh, true, t);
      drawAnnotations(ctx, ww, hh, t);
      const blob = await new Promise(rs => c.toBlob(rs, 'image/png'));
      if (!(await api.v3dFrame(new Uint8Array(await blob.arrayBuffer())))) { job.cancel = true; break; }
      if (k % 4 === 0) { bar.querySelector('.aibar div').style.width = Math.round(k / n * 100) + '%'; bar.querySelector('#aeTxt').textContent = `${k} / ${n} frames`; }
    }
    res = await api.v3dEnd({ cancel: job.cancel });
  } catch (e) { await api.v3dEnd({ cancel: true }); res = { ok: false, error: String(e && e.message || e) }; }
  Ann.exporting = null; bar.remove(); video.currentTime = realNow;
  if (res && res.ok) toast('🎬 Saved: ' + res.file.split(/[\\/]/).pop(), 'ok', 4500);
  else if (res && res.cancelled) toast('Video cancelled', 'bad');
  else toast('Saving failed: ' + (res && res.error || 'unknown error'), 'bad', 6000);
  return res;
}

/* ---------------------------------------------------------------- annotations of tracks that change (3.3) */
// annotations that follow players whose track was deleted are removed with it (undo brings both back); returns how many
function annPrune() {
  if (!(TR.anns || []).length) return 0;
  const ids = new Set(TR.tracks.map(tk => tk.id)), n0 = TR.anns.length;
  TR.anns = TR.anns.filter(a => ANN_TEAM_TYPES.has(a.type) || a.type === 'zone' || (a.tracks || []).every(id => ids.has(id)));
  const n = n0 - TR.anns.length;
  if (n) { if (Ann.sel && !annById(Ann.sel)) Ann.sel = null; annCount(); annSelBar(); paintAnnotations(); if (typeof V3 !== 'undefined') V3.dirty = true; }
  return n;
}
const annPruneNote = n => n ? ` · ${n} annotation${n > 1 ? 's' : ''} of removed tracks removed too` : '';
// a track joined into another one, or split at t: the annotations follow the player
function annRetarget(fromId, toId, fromT = -Infinity) {
  (TR.anns || []).forEach(a => { if (a.t0 >= fromT - 0.01 && (a.tracks || []).includes(fromId)) a.tracks = a.tracks.map(id => id === fromId ? toId : id); });
}

/* ---------------------------------------------------------------- voice and typed commands (3.3) */
// "spotlight nine", "spotlight away ten", "name tag seven", "run arrow eleven", "distance nine and four",
// "offside line away", "back line home", "next annotation", "previous annotation", "delete annotation"
const ANN_SAY = [
  { re: /^(?:spotlight|spot light|highlight)\s+(.+)$/, type: 'spot' },
  { re: /^(?:name tag|nametag)\s+(.+)$/, type: 'label' },
  { re: /^run(?: arrow)?\s+(.+)$/, type: 'run' },
  { re: /^distance(?: between)?\s+(.+?)\s+(?:and|to|with)\s+(.+)$/, type: 'link' },
  { re: /^offside line\s+(.+)$/, type: 'offside' },
  { re: /^(?:back line|backline|defensive line|back four)\s+(.+)$/, type: 'backline' }
];
const annNorm = s => String(s || '').toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ').trim();
// "home …", "away …", "opposition …" or a team's own name in front of the words → [team, rest]
function annTeamPrefix(s) {
  const pre = [['home', 'Home'], ['us', 'Home'], ['away', 'Away'], ['opposition', 'Away'], ['them', 'Away'], ['opponents', 'Away'],
    [annNorm(teamName('Home')), 'Home'], [annNorm(teamName('Away')), 'Away']].filter(x => x[0]).sort((a, b) => b[0].length - a[0].length);
  for (const [w, team] of pre) { if (s === w) return [team, '']; if (s.startsWith(w + ' ')) return [team, s.slice(w.length + 1).trim()]; }
  return [null, s];
}
// a tracked player from spoken words: "nine", "away ten", "home number four", "this" (the selected track)
function annTrackFromText(text, t = video.currentTime) {
  const here = tk => !!(tk && tk.kind !== 'ball' && trackDrawn(tk) && annPos(tk, t));
  const s0 = annNorm(text);
  if (/^(this|that|selected|him|this one|this player|the selected player)$/.test(s0)) { const tk = selTrack(); return here(tk) ? { tk } : { err: 'Select a player first (Track tab, or click one in tracking mode)' }; }
  const [team, s] = annTeamPrefix(s0);
  if (!s) return { err: 'Say which player, e.g. “spotlight nine”' };
  const teams = team ? [team] : ['Home', 'Away'];
  let named = null;
  for (const tm of teams) {   // a squad player of that team with a track at this moment
    const p = playerFromText(s, tm); if (!p || p.team !== tm) continue;
    named = named || p;
    const tk = TR.tracks.find(k => k.playerId === p.id && here(k)); if (tk) return { tk };
  }
  // tracks without a squad player: by their label ("Home 9", "H9") or shirt number
  const num = wordsToNum(s);
  const byLabel = TR.tracks.filter(k => here(k) && (!team || k.team === team) && !k.playerId && (annNorm(trackLabel(k)) === s || (num && new RegExp('(^|\\D)' + num + '$').test(String(k.label || '')))));
  if (byLabel.length === 1) return { tk: byLabel[0] };
  if (byLabel.length > 1) return { err: `More than one track matches “${text}” – say the team (home / away)` };
  return { err: named ? `${playerLabel(named)} has no track at ${fmtTime(t)}` : `No tracked player matches “${text}”` };
}
// returns null when the words are not an annotation command, otherwise { ok, msg }. at = when the words began
function annCommand(text, at) {
  const s = annNorm(text);
  if (!s || !hasVideo()) return null;
  const t = Number.isFinite(at) ? clamp(at, 0, video.duration || at) : video.currentTime;
  const goTo = () => { video.pause(); if (Math.abs(video.currentTime - t) > 0.02) video.currentTime = t; };
  if (/^(next|previous|last) annotation$/.test(s)) {
    if (!(TR.anns || []).length) return { ok: false, msg: 'No annotations yet' };
    if (!Ann.on) annOpen();
    annStep(s.startsWith('next') ? 1 : -1); return { ok: true, msg: 'Annotation ' + (s.startsWith('next') ? 'forward' : 'back') };
  }
  if (Ann.on && /^(delete|remove) (the |this )?annotation$/.test(s)) {
    if (!Ann.sel) return { ok: false, msg: 'No annotation selected' };
    annDelete(Ann.sel); return { ok: true, msg: 'Annotation deleted' };
  }
  let hit = null;
  for (const c of ANN_SAY) { const m = c.re.exec(s); if (m) { hit = { c, m }; break; } }
  if (!hit) return null;
  // with the palette closed, words that are a code in your code window keep tagging ("run nine" can be a tag)
  if (!Ann.on) { const first = s.split(' ')[0]; if (VOC.codes.some(k => k.words && k.words[0] === first)) return null; }
  const type = hit.c.type, T = ANN_TYPES[type];
  if (ANN_TEAM_TYPES.has(type)) {
    const [team] = annTeamPrefix(hit.m[1]);
    if (!team) return { ok: false, msg: `Say which team: “${T.name.toLowerCase()} home” or “… away”` };
    if (type === 'offside' && !TR.cals.some(c => c.type !== 'none')) return { ok: false, msg: 'The offside line needs the pitch calibration' };
    if (!Ann.on) annOpen();
    goTo();
    const a = annAdd({ type, tracks: [], team, text: '' });
    return { ok: true, msg: `${T.icon} ${annName(a)}` };
  }
  const picks = (type === 'link' ? [hit.m[1], hit.m[2]] : [hit.m[1]]).map(w => annTrackFromText(w, t));
  const bad = picks.find(x => x.err); if (bad) return { ok: false, msg: bad.err };
  if (type === 'link' && picks[0].tk === picks[1].tk) return { ok: false, msg: 'Two different players, please' };
  if (!Ann.on) annOpen();
  goTo();
  const a = annAdd({ type, tracks: picks.map(x => x.tk.id), text: '' });
  annSelect(a.id);
  return { ok: true, msg: `${T.icon} ${T.name}: ${annName(a)}` };
}
const ANN_GRAMMAR = ['spotlight', 'highlight', 'name', 'tag', 'run', 'arrow', 'distance', 'between', 'and', 'to', 'offside', 'line', 'back', 'four', 'defensive',
  'home', 'away', 'opposition', 'next', 'previous', 'last', 'annotation', 'delete', 'remove', 'this', 'that', 'selected'];

/* ---------------------------------------------------------------- annotation layers for the clip / playlist export (3.3) */
// the part of s–e in which any annotation is visible, or null
function annSpan(s, e) {
  const on = (TR.anns || []).filter(a => a.t1 > s + 0.02 && a.t0 < e - 0.02);
  if (!on.length) return null;
  return [Math.max(s, Math.min(...on.map(a => a.t0))), Math.min(e, Math.max(...on.map(a => a.t1)))];
}
// draws the annotations from t0 to t1 frame by frame on a transparent picture → a temp video layer the export lays over
// the clip ({ path, t0, t1 }); null when cancelled
async function annOverlayFile(t0, t1, w, h, onFrame, job) {
  const fps = clamp(Math.round(1 / frameDur()), 10, 60), n = Math.max(1, Math.round((t1 - t0) * fps));
  const b = await api.v3dBegin({ overlay: true, fps, w, h });
  if (!b || !b.ok) throw new Error((b && b.error) || 'the annotation layer could not be started');
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'), was = Ann.exporting;
  Ann.exporting = job || { cancel: false };
  try {
    for (let k = 0; k < n; k++) {
      if (job && job.cancel) { await api.v3dEnd({ cancel: true }); return null; }
      ctx.clearRect(0, 0, w, h);
      drawAnnotations(ctx, w, h, t0 + k / fps);
      const blob = await new Promise(rs => c.toBlob(rs, 'image/png'));
      if (!(await api.v3dFrame(new Uint8Array(await blob.arrayBuffer())))) break;
      if (onFrame && (k % 3 === 0 || k === n - 1)) onFrame(k + 1, n);
    }
  } catch (e) { await api.v3dEnd({ cancel: true }); throw e; } finally { Ann.exporting = was; }
  const r = await api.v3dEnd({});
  if (!r || !r.ok) throw new Error((r && r.error) || 'the annotation layer failed');
  return { path: r.file, t0, t1: t0 + n / fps };
}

/* ---------------------------------------------------------------- the palette can be moved by its title */
(function annPaletteDrag() {
  const bar = $('#annBar'), title = bar.querySelector('.atitle'); let d = null;
  const place = (x, y) => { const wrap = $('#videoWrap').getBoundingClientRect(), r = bar.getBoundingClientRect(); x = clamp(x, 0, wrap.width - r.width); y = clamp(y, 0, wrap.height - r.height); bar.style.left = x + 'px'; bar.style.top = y + 'px'; bar.style.transform = 'none'; return [x, y]; };
  try { const p = JSON.parse(localStorage.getItem('tq_annbar') || 'null'); if (p) requestAnimationFrame(() => place(p[0], p[1])); } catch (e) { /* default place */ }
  title.title = 'Drag to move the palette (double-click: back to the left side)';
  title.addEventListener('mousedown', e => { const r = bar.getBoundingClientRect(), wrap = $('#videoWrap').getBoundingClientRect(); d = { dx: e.clientX - r.left, dy: e.clientY - r.top, wl: wrap.left, wt: wrap.top }; e.preventDefault(); });
  window.addEventListener('mousemove', e => { if (d) place(e.clientX - d.wl - d.dx, e.clientY - d.wt - d.dy); });
  window.addEventListener('mouseup', () => { if (!d) return; d = null; try { localStorage.setItem('tq_annbar', JSON.stringify([parseFloat(bar.style.left), parseFloat(bar.style.top)])); } catch (e) { /* ignore */ } });
  title.addEventListener('dblclick', () => { bar.style.left = ''; bar.style.top = ''; bar.style.transform = ''; try { localStorage.removeItem('tq_annbar'); } catch (e) { /* ignore */ } });
  // a smaller window (or the side panel opening) must not leave the palette outside the video
  window.addEventListener('resize', () => { if (bar.style.left && !bar.classList.contains('hidden')) place(parseFloat(bar.style.left), parseFloat(bar.style.top)); });
  ANN_SHOW.push(() => { if (bar.style.left) requestAnimationFrame(() => place(parseFloat(bar.style.left), parseFloat(bar.style.top))); });
})();

/* ---------------------------------------------------------------- wiring */
$('#btnAnn').onclick = () => Ann.on ? annClose() : annOpen();
$('#annClose').onclick = annClose;
$('#annDone').onclick = annFinishChain;
$('#annList').onclick = annListPop;
$('#annExport').onclick = annExport;
$('#annPrev').onclick = () => annStep(-1);
$('#annNext').onclick = () => annStep(1);
$$('#annBar [data-ann]').forEach(b => b.onclick = () => annSetTool(b.dataset.ann));
$$('#annBar [data-acolor]').forEach(b => b.onclick = () => annSetColour(b.dataset.acolor));
HOOKS.tick.push(() => { if (Ann.on || (TR.anns || []).length) paintAnnotations(); });
HOOKS.render.push(tab => { if (!tab || tab === 'resize') { annCount(); if (Ann.sel && !annById(Ann.sel)) Ann.sel = null; annSelBar(); paintAnnotations(); } });
HOOKS.key.push(e => {
  if (!Ann.on || e.ctrlKey || e.altKey || e.metaKey) return false;
  if (e.key === 'Enter' && Ann.tool === 'chain') { e.preventDefault(); annFinishChain(); return true; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && Ann.sel && !Ann.tool && !TR.on) { e.preventDefault(); annDelete(Ann.sel); return true; }
  if (e.key === 'Escape') { if (Ann.tool) annSetTool(null); else if (Ann.sel) annSelect(null); else annClose(); return true; }
  return false;
});
video.addEventListener('pause', annKick);
video.addEventListener('seeked', () => { paintAnnotations(); annKick(); });
window.addEventListener('resize', () => paintAnnotations());
