'use strict';
/* =====================================================================
   0.3: MANUAL TRACKING
   - tracks for players, ball, referees (positions clicked on the video)
   - keyframes, optional interpolation (clearly marked, never invented
     across long gaps or invisible periods), visibility status
   - pitch calibration (homography) per camera segment
   - live 2D pitch view with trails, tracking export, heatmaps
   Positions on the video are stored as 0-1 image coordinates of the
   player's feet; pitch positions (metres) come from the calibration.
   ===================================================================== */
const TR = {
  on: false, tracks: [], cals: [], sel: null, drag: null,
  settings: { step: '5f', autoAdvance: true, interp: true, maxGap: 3, trail: 6, showLines: true, showAll: true }
};
const VIS_NAME = { v: 'visible', occ: 'occluded', out: 'out of frame', unk: 'unknown' };
const pitchDims = () => ({ L: Number(config.general.pitchL) || 105, W: Number(config.general.pitchW) || 68 });
const qt = t => { const fd = frameDur(); return Math.round(Math.round(t / fd) * fd * 1000) / 1000; };
const trackView = $('#trackView');

/* ---------------------------------------------------------------- HOMOGRAPHY MATHS */
function mul3(A, B) { const C = new Array(9).fill(0); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) C[r * 3 + c] += A[r * 3 + k] * B[k * 3 + c]; return C; }
function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
function applyH(H, x, y) { const w = H[6] * x + H[7] * y + H[8]; if (Math.abs(w) < 1e-12) return null; return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w, w]; }
function normT(pts) {
  const n = pts.length, mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
  const d = pts.reduce((s, p) => s + Math.hypot(p[0] - mx, p[1] - my), 0) / n || 1, k = Math.SQRT2 / d;
  return [k, 0, -k * mx, 0, k, -k * my, 0, 0, 1];
}
function solveLinear(A, b) {   // Gaussian elimination with partial pivoting
  const n = b.length, M = A.map((r, i) => r.concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
// src: image points (0-1), dst: pitch points (metres). Least squares when more than 4 points.
function solveHomography(src, dst) {
  if (src.length < 4) return null;
  const T1 = normT(src), T2 = normT(dst);
  const s = src.map(p => applyH(T1, p[0], p[1])), d = dst.map(p => applyH(T2, p[0], p[1]));
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0)), Atb = new Array(8).fill(0);
  const addRow = (row, v) => { for (let i = 0; i < 8; i++) { Atb[i] += row[i] * v; for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j]; } };
  for (let i = 0; i < s.length; i++) {
    const [x, y] = s[i], [X, Y] = d[i];
    addRow([x, y, 1, 0, 0, 0, -X * x, -X * y], X);
    addRow([0, 0, 0, x, y, 1, -Y * x, -Y * y], Y);
  }
  const h = solveLinear(AtA, Atb);
  if (!h) return null;
  const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  const T2i = inv3(T2); if (!T2i) return null;
  const H = mul3(mul3(T2i, Hn), T1);
  return H.map(v => v / H[8]);
}
function calQuality(cal) {
  if (!cal || cal.type === 'none') return { label: 'none', cls: '', rmse: null };
  const pts = cal.points || [];
  if (pts.length < 4 || !cal.H) return { label: 'needs 4+ points', cls: 'poor', rmse: null };
  const errs = pts.map(p => { const r = applyH(cal.H, p.img[0], p.img[1]); return r ? Math.hypot(r[0] - p.pitch[0], r[1] - p.pitch[1]) : 99; });
  const rmse = Math.sqrt(avg(errs.map(e => e * e)));
  // a sane camera keeps the pitch in front of it: every image corner must map with the same sign of w
  const signs = [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]].map(c => Math.sign((applyH(cal.H, c[0], c[1]) || [0, 0, 0])[2]));
  if (new Set(signs).size > 1 && pts.length >= 4) return { label: 'poor (check points)', cls: 'poor', rmse };
  if (pts.length === 4) return { label: '4 points – add more to verify', cls: 'ok', rmse };
  if (rmse < 1) return { label: 'good (' + rmse.toFixed(2) + ' m)', cls: 'good', rmse };
  if (rmse < 2.5) return { label: 'fair (' + rmse.toFixed(1) + ' m)', cls: 'ok', rmse };
  return { label: 'poor (' + rmse.toFixed(1) + ' m error)', cls: 'poor', rmse };
}
const sortedCals = () => TR.cals.slice().sort((a, b) => a.t - b.t);
/* ---- camera movement (measured by the AI engine) carries a calibration through camera pans.
   TR.camera = [{ id, pts: [[t, x, y], ...] }]: one entry per camera shot (a cut starts a new one); x, y = how far
   the picture content has moved (fractions of the frame) since the start of that shot. */
function camAt(t) {
  const segs = TR.camera || [];
  for (let s = segs.length - 1; s >= 0; s--) {
    const p = segs[s].pts; if (!p.length || t < p[0][0] - 0.06 || t > p[p.length - 1][0] + 0.06) continue;
    let lo = 0, hi = p.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p[m][0] <= t) lo = m; else hi = m; }
    const a = p[lo], b = p[hi], w = b[0] > a[0] ? clamp((t - a[0]) / (b[0] - a[0]), 0, 1) : 0;
    return { seg: segs[s].id, x: a[1] + (b[1] - a[1]) * w, y: a[2] + (b[2] - a[2]) * w };
  }
  return null;
}
// image point now = image point at calibration time + d  ->  pitch = H(x - dx, y - dy)
const shiftH = (H, d) => [H[0], H[1], H[2] - H[0] * d[0] - H[1] * d[1], H[3], H[4], H[5] - H[3] * d[0] - H[4] * d[1], H[6], H[7], H[8] - H[6] * d[0] - H[7] * d[1]];
const normH = H => H.map(v => v / (H[8] || 1));
const mpwCache = new WeakMap();
// metres of pitch across the whole frame width at the picture centre (scales the error estimate)
function metresPerWidth(c) {
  if (mpwCache.has(c)) return mpwCache.get(c);
  const a = applyH(c.H, 0.45, 0.5), b = applyH(c.H, 0.55, 0.5);
  const v = a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) * 10 : 80; mpwCache.set(c, v); return v;
}
// error of a carried calibration, from the Spain v England test: about 20% of the distance the camera panned
const carryErr = (c, d) => 0.2 * Math.hypot(d[0], d[1] * 0.56) * metresPerWidth(c);
const CARRY_MAX_ERR = 4;   // metres – beyond this a carried calibration is not used
// calibration valid at time t (segment = from this calibration until the next one)
function calAt(t) {
  const cs = sortedCals();
  let i = -1;
  for (let k = 0; k < cs.length; k++) if (cs[k].t <= t + 1e-6) i = k;
  if (i < 0) {
    // before the first calibration: carry the first one backwards along the camera movement (same shot only)
    const f = cs[0];
    if (!f || f.type === 'none' || !f.H || TR.settings.followCam === false || !(TR.camera || []).length) return null;
    const ct = camAt(t), cf = camAt(f.t);
    if (!ct || !cf || ct.seg !== cf.seg) return null;
    const d = [ct.x - cf.x, ct.y - cf.y], err = carryErr(f, d) + 0.15;
    return err <= CARRY_MAX_ERR ? { H: normH(shiftH(f.H, d)), cal: f, carried: true, err } : null;
  }
  const c = cs[i];
  if (c.type === 'none' || !c.H) return null;
  const n = cs[i + 1];
  if (TR.settings.followCam !== false && TR.camera && TR.camera.length) {
    const ct = camAt(t);
    if (ct) {
      const ca = camAt(c.t), cb = n && n.type !== 'none' && n.H ? camAt(n.t) : null;
      const A = ca && ca.seg === ct.seg ? { d: [ct.x - ca.x, ct.y - ca.y] } : null;
      const B = cb && cb.seg === ct.seg ? { d: [ct.x - cb.x, ct.y - cb.y] } : null;
      if (A) { A.H = normH(shiftH(c.H, A.d)); A.err = carryErr(c, A.d); }
      if (B) { B.H = normH(shiftH(n.H, B.d)); B.err = carryErr(n, B.d); }
      if (A && B) {     // carried forward from this calibration and back from the next one, blended by time
        const w = clamp((t - c.t) / (n.t - c.t), 0, 1);
        const err = Math.min(A.err, B.err) * 0.6 + 0.15;
        return { H: A.H.map((v, k) => v * (1 - w) + B.H[k] * w), cal: c, carried: true, between: n, err };
      }
      if (A) return A.err <= CARRY_MAX_ERR ? { H: A.H, cal: c, carried: Math.hypot(A.d[0], A.d[1]) > 0.002, err: A.err + 0.15 } : null;
      if (B && B.err <= CARRY_MAX_ERR) return { H: B.H, cal: n, carried: true, err: B.err + 0.15 };
    }
  }
  if (c.blend && n && n.type !== 'none' && n.H && n.t > c.t) {
    const a = clamp((t - c.t) / (n.t - c.t), 0, 1);
    return { H: c.H.map((v, k) => v * (1 - a) + n.H[k] * a), cal: c, blended: true };
  }
  return { H: c.H, cal: c };
}
function toPitch(t, x, y) { const c = calAt(t); if (!c) return null; const r = applyH(c.H, x, y); if (!r || r[2] <= 0 && Math.sign(applyH(c.H, 0.5, 0.5)[2]) > 0) return null; return [r[0], r[1]]; }

/* ---------------------------------------------------------------- TRACK DATA */
function teamColor(team) { return team === 'Away' ? (config.general.awayColor || '#ff5a5f') : team === 'Neutral' ? '#bbbbbb' : (config.general.homeColor || '#3ea6ff'); }
function trackColor(tk) { return tk.color || (tk.kind === 'ball' ? '#ffd23b' : tk.kind === 'ref' ? '#111111' : teamColor(tk.team)); }
function trackLabel(tk) {
  if (tk.kind === 'ball') return 'Ball';
  const p = tk.playerId && VOC.playersById[tk.playerId];
  if (p) return playerLabel(p) + (p.name ? ' ' + p.name : '');
  return tk.label || (tk.kind === 'ref' ? 'Referee' : 'Player');
}
function trackShort(tk) {
  if (tk.kind === 'ball') return '●';
  const p = tk.playerId && VOC.playersById[tk.playerId];
  if (p && p.num !== '' && p.num != null) return String(p.num);
  return (tk.label || (tk.kind === 'ref' ? 'R' : '?')).slice(0, 3);
}
function newTrack(o) { const tk = Object.assign({ id: uid(), kind: 'player', team: 'Home', playerId: '', label: '', color: '', interp: true, points: [] }, o); TR.tracks.push(tk); return tk; }
function findIdx(pts, t) { let lo = 0, hi = pts.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (pts[m].t <= t + 1e-6) { r = m; lo = m + 1; } else hi = m - 1; } return r; }
// position of a track at time t: a keyframe, an interpolated point, a status, or null (unknown)
const isEstimate = q => !!q && q.kind === 'interp' && !(q.gap <= 0.3);   // true only for real gaps
function posAt(tk, t) {
  const pts = tk.points, fd = frameDur();
  if (!pts.length) return null;
  const i = findIdx(pts, t);
  const prev = pts[i], next = pts[i + 1];
  if (prev && Math.abs(prev.t - t) <= fd * 0.51) return prev.vis === 'v' ? Object.assign({ kind: 'key' }, prev) : { kind: 'status', vis: prev.vis, t: prev.t };
  if (next && Math.abs(next.t - t) <= fd * 0.51) return next.vis === 'v' ? Object.assign({ kind: 'key' }, next) : { kind: 'status', vis: next.vis, t: next.t };
  if (!prev) return null;
  if (prev.vis !== 'v') return { kind: 'status', vis: prev.vis, t: prev.t };
  if (next && next.vis === 'v' && TR.settings.interp && tk.interp !== false && next.t - prev.t <= Number(tk.maxGap || TR.settings.maxGap || 3)) {
    const a = (t - prev.t) / (next.t - prev.t);
    // gap = distance between the two known points: a few hundredths of a second (AI looking at every 2nd frame)
    // is as good as a keyframe; only longer gaps are real estimates
    return { kind: 'interp', x: prev.x + (next.x - prev.x) * a, y: prev.y + (next.y - prev.y) * a, t, src: 'interp', vis: 'v', gap: next.t - prev.t, conf: prev.conf != null && next.conf != null ? Math.min(prev.conf, next.conf) : undefined, fromAi: prev.src === 'ai' || next.src === 'ai' };
  }
  return null;
}
function setPoint(tk, t, data) {
  t = qt(t);
  const pts = tk.points, i = pts.findIndex(p => Math.abs(p.t - t) < frameDur() * 0.51);
  const pt = Object.assign({ t, x: null, y: null, src: 'manual', vis: 'v' }, data, { t });
  if (i >= 0) {
    const old = pts[i];
    // correcting an AI point: keep what the AI said so it can always be seen and restored
    if (pt.src === 'manual' && (old.src === 'ai' || old.orig)) {
      if (!old.orig) old.orig = { x: old.x, y: old.y, conf: old.conf, vis: old.vis };
      delete old.conf;
      if (!TR.drag) logCorrection(tk, t, pt.vis !== 'v' ? 'status' : 'move', pt.vis !== 'v' ? VIS_NAME[pt.vis] : '');
    }
    pts[i] = Object.assign(old, pt);
  } else { pts.push(pt); pts.sort((a, b) => a.t - b.t); if (pt.src === 'manual' && tk.ai && !TR.drag) logCorrection(tk, t, 'add'); }
  markDirty();
}
// corrections log (newest last) – what was changed by hand in AI tracking data
function logCorrection(tk, t, act, note) {
  if (!TR.log) TR.log = [];
  TR.log.push({ at: Date.now(), t: Math.round(t * 1000) / 1000, tk: tk.id, label: trackLabel(tk), act, note: note || '' });
  if (TR.log.length > 1000) TR.log.splice(0, TR.log.length - 1000);
}
function deletePoint(tk, t) {
  const i = tk.points.findIndex(p => Math.abs(p.t - t) < frameDur() * 0.51);
  if (i < 0) return false;
  const [p] = tk.points.splice(i, 1);
  // a deleted AI point is kept aside (tk.removed) so the original AI result is never lost
  if (p.src === 'ai' || p.orig) { if (!tk.removed) tk.removed = []; tk.removed.push(p.orig ? Object.assign({ t: p.t, src: 'ai' }, p.orig) : p); logCorrection(tk, p.t, 'delete'); }
  markDirty(); return true;
}
const selTrack = () => TR.tracks.find(x => x.id === TR.sel) || null;
function stepSeconds() { const s = TR.settings.step, fd = frameDur(); return s === '1f' ? fd : s === '5f' ? 5 * fd : s === '10f' ? 10 * fd : s === '0.5s' ? 0.5 : s === '1s' ? 1 : s === '2s' ? 2 : 5 * fd; }
function advance(dir = 1) { if (!hasVideo()) return; video.pause(); video.currentTime = clamp(qt(video.currentTime + dir * stepSeconds()) + frameDur() * 0.1, 0, video.duration || 1e9); }

/* ---------------------------------------------------------------- OVERLAY ON THE VIDEO */
function frameRect() {
  const wrap = $('#videoWrap').getBoundingClientRect(), vb = video.getBoundingClientRect();
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9, s = Math.min(vb.width / vw, vb.height / vh), w = vw * s, h = vh * s;
  return { left: vb.left - wrap.left + (vb.width - w) / 2, top: vb.top - wrap.top + (vb.height - h) / 2, w, h };
}
function pitchSegments(L, W) {
  const cy = W / 2, seg = [], line = (a, b) => seg.push([a, b]);
  const rect = (x1, y1, x2, y2) => { line([x1, y1], [x2, y1]); line([x2, y1], [x2, y2]); line([x2, y2], [x1, y2]); line([x1, y2], [x1, y1]); };
  rect(0, 0, L, W); line([L / 2, 0], [L / 2, W]);
  rect(0, cy - 20.16, 16.5, cy + 20.16); rect(L - 16.5, cy - 20.16, L, cy + 20.16);
  rect(0, cy - 9.16, 5.5, cy + 9.16); rect(L - 5.5, cy - 9.16, L, cy + 9.16);
  const circ = (cx, cyy, r, a0, a1) => { const n = 40; for (let k = 0; k < n; k++) { const t0 = a0 + (a1 - a0) * k / n, t1 = a0 + (a1 - a0) * (k + 1) / n; line([cx + r * Math.cos(t0), cyy + r * Math.sin(t0)], [cx + r * Math.cos(t1), cyy + r * Math.sin(t1)]); } };
  circ(L / 2, cy, 9.15, 0, Math.PI * 2);
  const da = Math.acos(5.5 / 9.15); circ(11, cy, 9.15, -da, da); circ(L - 11, cy, 9.15, Math.PI - da, Math.PI + da);
  return seg;
}
function drawProjectedLines(ctx, H, W, Hh, color) {
  const Hi = inv3(H); if (!Hi) return;
  const { L, W: PW } = pitchDims();
  ctx.save(); ctx.strokeStyle = color || 'rgba(255,255,255,.55)'; ctx.lineWidth = Math.max(1, W / 900);
  pitchSegments(L, PW).forEach(([a, b]) => {
    const n = 8; ctx.beginPath(); let started = false;
    for (let k = 0; k <= n; k++) {
      const X = a[0] + (b[0] - a[0]) * k / n, Y = a[1] + (b[1] - a[1]) * k / n, r = applyH(Hi, X, Y);
      if (!r || r[2] <= 0 || r[0] < -1 || r[0] > 2 || r[1] < -1 || r[1] > 2) { started = false; continue; }
      if (!started) { ctx.moveTo(r[0] * W, r[1] * Hh); started = true; } else ctx.lineTo(r[0] * W, r[1] * Hh);
    }
    ctx.stroke();
  });
  ctx.restore();
}
function drawTrackingOverlay(ctx, W, H, forExport) {
  const t = hasVideo() ? video.currentTime : curT();
  if (TR.settings.showLines) { const c = calAt(t); if (c) drawProjectedLines(ctx, c.H, W, H); }
  const r = Math.max(6, W / 110);
  TR.tracks.forEach(tk => {
    if (!TR.settings.showAll && tk.id !== TR.sel) return;
    const p = posAt(tk, t);
    const sel = tk.id === TR.sel && !forExport;
    if (!p || p.kind === 'status') {
      if (sel && p) { ctx.save(); ctx.fillStyle = '#ffd23b'; ctx.font = `600 ${Math.round(r * 1.6)}px Segoe UI, Arial`; ctx.fillText(trackLabel(tk) + ': ' + VIS_NAME[p.vis], 12, H - 14); ctx.restore(); }
      return;
    }
    const x = p.x * W, y = p.y * H, col = trackColor(tk);
    ctx.save();
    if (isEstimate(p)) { ctx.globalAlpha = 0.65; ctx.setLineDash([4, 3]); }
    else if (p.src === 'ai' && p.conf != null && p.conf < 0.4) { ctx.globalAlpha = 0.7; ctx.setLineDash([2, 2]); }
    if (tk.kind === 'ball') {
      ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#000'; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.ellipse(x, y, r * 1.25, r * 0.55, 0, 0, Math.PI * 2); ctx.lineWidth = sel ? 4 : 2.5; ctx.strokeStyle = col; ctx.stroke();
      if (p.kind === 'key' && p.src === 'manual') { ctx.globalAlpha = 0.25; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1; }
      ctx.setLineDash([]); ctx.font = `700 ${Math.round(r * 1.25)}px Segoe UI, Arial`; ctx.textAlign = 'center';
      const lbl = trackShort(tk);
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.strokeText(lbl, x, y - r * 0.9); ctx.fillStyle = '#fff'; ctx.fillText(lbl, x, y - r * 0.9);
    }
    if (sel) { ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(x, y, r * 1.9, 0, Math.PI * 2); ctx.strokeStyle = '#2ecc71'; ctx.lineWidth = 2; ctx.stroke(); }
    // corrected AI point: show where the AI had it (hollow magenta ring + line)
    if (p.kind === 'key' && p.orig && p.orig.x != null && (sel || TR.settings.showOrig) && !forExport) {
      const ox = p.orig.x * W, oy = p.orig.y * H;
      ctx.setLineDash([3, 3]); ctx.globalAlpha = 0.9; ctx.strokeStyle = '#ff4fd8'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(x, y); ctx.stroke();
      ctx.setLineDash([]); ctx.beginPath(); ctx.arc(ox, oy, r * 0.7, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  });
}
function placeTrackView() {
  const r = frameRect(), c = trackView;
  c.style.left = r.left + 'px'; c.style.top = r.top + 'px'; c.style.width = r.w + 'px'; c.style.height = r.h + 'px';
  const w = Math.round(r.w * devicePixelRatio), h = Math.round(r.h * devicePixelRatio);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
}
let lastPaintT = -1;
function paintTracking(force) {
  const show = (TR.on || TR.settings.overlay) && hasVideo();
  trackView.classList.toggle('hidden', !show);
  trackView.style.pointerEvents = TR.on ? '' : 'none';   // view-only overlay when tracking mode is off
  if (!show) return;
  const t = video.currentTime;
  if (!force && t === lastPaintT && !TR.drag) return;
  lastPaintT = t;
  placeTrackView();
  const ctx = trackView.getContext('2d');
  ctx.clearRect(0, 0, trackView.width, trackView.height);
  drawTrackingOverlay(ctx, trackView.width, trackView.height, false);
  renderTrackBar();
}
function renderTrackBar() {
  const bar = $('#trackBar');
  bar.classList.toggle('hidden', !TR.on);
  if (!TR.on) return;
  const tk = selTrack(), t = hasVideo() ? video.currentTime : 0;
  const p = tk ? posAt(tk, t) : null;
  const c = calAt(t);
  bar.innerHTML = `<b style="color:var(--ok)">● TRACKING</b>
    <span>${tk ? `<span class="dot" style="background:${esc(trackColor(tk))}"></span>${esc(trackLabel(tk))}` : '<span class="warn">select a player / ball in the Track tab (Tab key)</span>'}</span>
    ${tk ? `<span class="muted small">${p ? (p.kind === 'key' ? '✓ keyframe' : p.kind === 'interp' ? '≈ interpolated' : VIS_NAME[p.vis]) : '— no position here'}</span>` : ''}
    <span class="muted small">· click = set position${TR.settings.autoAdvance ? ' & jump ' + TR.settings.step : ''} · right-click = delete · Enter/Backspace = step</span>
    <span class="small ${c ? '' : 'warn'}">${c ? 'pitch ✓' : 'no calibration here'}</span>`;
}

/* ---------------------------------------------------------------- MOUSE ON THE VIDEO */
function evPos(e) { const r = trackView.getBoundingClientRect(); return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1), r]; }
function hitTrack(x, y, r, only) {
  const t = video.currentTime; let best = null;
  TR.tracks.forEach(tk => {
    if (only && tk.id !== only) return;
    const p = posAt(tk, t); if (!p || p.kind === 'status') return;
    const d = Math.hypot((p.x - x) * r.width, (p.y - y) * r.height);
    if (d < 16 && (!best || d < best.d)) best = { tk, d, p };
  });
  return best;
}
trackView.addEventListener('contextmenu', e => {
  e.preventDefault();
  const tk = selTrack(); if (!tk) return;
  checkpoint();
  if (deletePoint(tk, video.currentTime)) { toast('Keyframe deleted', 'info', 900); autosave(); paintTracking(true); renderTrackTab(); } else History.past.pop();
});
trackView.addEventListener('mousedown', e => {
  if (e.button !== 0 || !TR.on) return;
  const [x, y, r] = evPos(e);
  const tk = selTrack();
  const hitSel = tk && video.paused && hitTrack(x, y, r, tk.id);   // while playing every click is a new point
  if (hitSel) { checkpoint(); TR.drag = { tk, moved: false }; return; }
  const hitAny = hitTrack(x, y, r);
  if (hitAny && (e.shiftKey || !tk) && video.paused) { TR.sel = hitAny.tk.id; renderTrackTab(); paintTracking(true); return; }
  if (!tk) { toast('Choose a player or the ball in the Track tab first (or press Tab)', 'bad', 2500); return; }
  checkpoint();
  setPoint(tk, video.currentTime, { x, y, src: 'manual', vis: 'v' });
  autosave(); paintTracking(true); renderTrackTab();
  if (TR.settings.autoAdvance && video.paused) setTimeout(() => advance(1), 60);   // while playing: just add the point
});
window.addEventListener('mousemove', e => {
  if (!TR.drag) return;
  const [x, y] = evPos(e);
  setPoint(TR.drag.tk, video.currentTime, { x, y, src: 'manual', vis: 'v' });
  TR.drag.moved = true; paintTracking(true);
});
window.addEventListener('mouseup', () => { if (TR.drag) { const d = TR.drag; TR.drag = null; if (!d.moved) History.past.pop(); else { const q = d.tk.points.find(p => Math.abs(p.t - video.currentTime) < frameDur() * 0.51); if (q && q.orig) logCorrection(d.tk, q.t, 'move'); } autosave(); renderTrackTab(); } });

/* ---------------------------------------------------------------- KEYS */
HOOKS.key.push(e => {
  if (e.key === 'F8') { e.preventDefault(); setTracking(!TR.on); return true; }
  if (!TR.on || e.ctrlKey || e.altKey || e.metaKey) return false;
  if (e.key === 'Tab') {
    e.preventDefault();
    if (!TR.tracks.length) return true;
    const i = TR.tracks.findIndex(x => x.id === TR.sel);
    TR.sel = TR.tracks[(i + (e.shiftKey ? -1 : 1) + TR.tracks.length) % TR.tracks.length].id;
    renderTrackTab(); paintTracking(true); return true;
  }
  if (e.key === 'Enter') { e.preventDefault(); advance(1); return true; }
  if (e.key === 'Backspace') { e.preventDefault(); advance(-1); return true; }
  if (e.key === 'Delete') { e.preventDefault(); const tk = selTrack(); if (tk) { checkpoint(); if (deletePoint(tk, video.currentTime)) { autosave(); paintTracking(true); renderTrackTab(); } else History.past.pop(); } return true; }
  return false;
});
function setTracking(on) {
  if (on && !hasVideo()) { toast('Open a video first', 'bad'); return; }
  TR.on = on;
  if (on) { video.pause(); if (!TR.tracks.length) toast('Tracking mode: add players / ball in the Track tab', 'info', 3000); }
  paintTracking(true); renderTrackTab(); renderTrackBar();
}

/* ---------------------------------------------------------------- TRACK TAB */
function coverage(tk) {
  const pts = tk.points; if (!pts.length) return '0 keyframes';
  const vis = pts.filter(p => p.vis === 'v').length;
  return `${vis} keyframes · ${fmtTime(pts[0].t)}–${fmtTime(pts[pts.length - 1].t)}`;
}
function renderTrackTab() {
  const el = $('#tab-track');
  if (el.classList.contains('hidden') && !TR.on) return;
  const s = TR.settings, tk = selTrack(), t = hasVideo() ? video.currentTime : 0;
  const p = tk ? posAt(tk, t) : null;
  const groups = [['Home', teamName('Home')], ['Away', teamName('Away')], ['Neutral', 'Ball / referees / other']];
  const list = groups.map(([team, name]) => {
    const l = TR.tracks.filter(x => (x.kind === 'ball' || x.kind === 'ref' ? 'Neutral' : x.team) === team);
    if (!l.length) return '';
    return `<h4>${esc(name)}</h4>` + l.map(x => `<div class="trk ${x.id === TR.sel ? 'sel' : ''}" data-tk="${x.id}"><span class="dot" style="background:${esc(trackColor(x))}"></span>
      <span class="lb">${esc(trackLabel(x))}${x.ai ? ' <span class="badge aib">AI</span>' : ''}</span><span class="cov">${esc(coverage(x))}</span>
      <button class="small" data-tkedit="${x.id}" title="Edit">✎</button><button class="small danger" data-tkdel="${x.id}" title="Delete track">✕</button></div>`).join('');
  }).join('');
  const cals = sortedCals().map(c => { const q = calQuality(c); return `<div class="trk" data-cal="${c.id}"><span class="lb">${fmtTime(c.t)} ${c.type === 'none' ? '⛔ no calibration (cut / close-up)' : '🎯 ' + (c.points || []).length + ' points' + (c.blend ? ' · blends to next' : '')}</span>
    ${c.type === 'none' ? '' : `<span class="badge ${q.cls}">${esc(q.label)}</span>`}<button class="small" data-caledit="${c.id}">✎</button><button class="small danger" data-caldel="${c.id}">✕</button></div>`; }).join('');
  const needCal = TR.tracks.some(x => x.points.length) && !TR.cals.some(c => c.type !== 'none');
  el.innerHTML = `
    <div class="toolbar"><button id="tkToggle" class="${TR.on ? 'primary' : ''}">${TR.on ? '● Tracking ON' : '○ Tracking OFF'} <kbd>F8</kbd></button>
      <label class="small">Step <select id="tkStep">${['1f', '5f', '10f', '0.5s', '1s', '2s'].map(v => `<option ${s.step === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="small"><input type="checkbox" id="tkAuto" ${s.autoAdvance ? 'checked' : ''}> jump after click</label></div>
    <div class="toolbar small"><label><input type="checkbox" id="tkInterp" ${s.interp ? 'checked' : ''}> interpolate between keyframes</label>
      <label>max gap <input type="number" id="tkGap" value="${esc(s.maxGap)}" min="0.2" max="30" step="0.5" style="width:60px"> s</label>
      <label><input type="checkbox" id="tkLines" ${s.showLines ? 'checked' : ''}> pitch lines</label>
      <label><input type="checkbox" id="tkAll" ${s.showAll ? 'checked' : ''}> show all tracks</label>
      <label title="Show the tracks on the video while it plays, even when tracking mode is off"><input type="checkbox" id="tkOv" ${s.overlay ? 'checked' : ''}> tracks on video</label></div>
    ${tk ? `<div class="exportbox" style="margin:0 0 10px"><b>${esc(trackLabel(tk))}</b> at ${fmtTime(t)} (frame ${Math.round(t / frameDur())}): <span class="${p ? 'ok' : 'muted'}">${p ? (p.kind === 'key' ? 'keyframe' : p.kind === 'interp' ? 'interpolated' : VIS_NAME[p.vis]) : 'no position'}</span>
      <div class="toolbar" style="margin-top:6px"><button class="small" data-vis="occ">Occluded here</button><button class="small" data-vis="out">Out of frame here</button><button class="small" data-vis="unk">Unknown here</button>
      <button class="small" id="tkHold" title="Copy the last known position to this frame (player standing still)">⇢ Same as last</button><button class="small" id="tkDelPt">Delete point</button></div>
      <div class="toolbar"><button class="small" id="tkPrevK">◀ prev keyframe</button><button class="small" id="tkNextK">next keyframe ▶</button><button class="small" id="tkBack">− step</button><button class="small" id="tkFwd">+ step</button></div></div>` : ''}
    <div id="edBox"></div>
    <div id="aiBox"></div>
    <div id="ballBox"></div>
    <div class="toolbar"><button class="small" id="tkAddSquad">+ Players from squad</button><button class="small" id="tkAddH">+ Unknown ${esc(teamName('Home'))}</button><button class="small" id="tkAddA">+ Unknown ${esc(teamName('Away'))}</button><button class="small" id="tkAddBall">+ Ball</button><button class="small" id="tkAddRef">+ Referee</button></div>
    ${list || '<p class="muted small">No tracks yet. Add players or the ball, select one, turn tracking on, then click the player’s feet on the video.</p>'}
    <h4>Pitch calibration ${needCal ? '<span class="badge poor">needed for 2D / metres</span>' : ''}</h4>
    ${(() => { const c = hasVideo() ? calAt(t) : null; const camOk = (TR.camera || []).length > 0;
      const now = !c ? '<span class="badge poor">none at this moment</span>' : c.carried ? `<span class="badge ${c.err < 1.5 ? 'good' : 'ok'}">↔ follows the camera${c.between ? ' (between ' + fmtTime(c.cal.t) + ' and ' + fmtTime(c.between.t) + ')' : ' from ' + fmtTime(c.cal.t)} · ±${c.err.toFixed(1)} m</span>` : `<span class="badge good">🎯 ${c.blended ? 'blended' : 'set'} at ${fmtTime(c.cal.t)}</span>`;
      return `<div class="toolbar small">At ${fmtTime(t)}: ${now}
        <label title="The AI measures how the camera pans; a calibration is carried along with it (and blended between two calibrations). Run 🤖 Auto-detect over the part you want to use."><input type="checkbox" id="tkFollow" ${TR.settings.followCam !== false ? 'checked' : ''} ${camOk ? '' : 'disabled'}> calibration follows the camera ${camOk ? '' : '(after an AI run)'}</label></div>`; })()}
    <p class="small muted">Click 4+ known pitch points (corners, box, halfway line…) on a video frame. Each calibration is valid from its time until the next one. Add a new one when the camera moves or cuts; use ⛔ for close-ups or replays.</p>
    <div class="toolbar"><button class="small primary" id="tkCal">🎯 Calibrate at this frame</button><button class="small" id="tkNoCal">⛔ No calibration from here</button></div>
    ${cals || '<p class="muted small">No calibration yet.</p>'}
    <h4>Export</h4><div class="toolbar"><button class="small" id="tkCsv">Tracking CSV</button><button class="small" id="tkJson">Tracking JSON</button></div>`;
  const b = (id, fn) => { const x = el.querySelector(id); if (x) x.onclick = fn; };
  b('#tkToggle', () => setTracking(!TR.on));
  el.querySelector('#tkStep').onchange = e => { s.step = e.target.value; renderTrackBar(); };
  el.querySelector('#tkAuto').onchange = e => { s.autoAdvance = e.target.checked; renderTrackBar(); };
  el.querySelector('#tkInterp').onchange = e => { s.interp = e.target.checked; markDirty(); paintTracking(true); };
  el.querySelector('#tkGap').onchange = e => { s.maxGap = Number(e.target.value) || 3; markDirty(); paintTracking(true); };
  el.querySelector('#tkLines').onchange = e => { s.showLines = e.target.checked; paintTracking(true); };
  el.querySelector('#tkAll').onchange = e => { s.showAll = e.target.checked; paintTracking(true); };
  el.querySelector('#tkOv').onchange = e => { s.overlay = e.target.checked; paintTracking(true); };
  const fc = el.querySelector('#tkFollow'); if (fc) fc.onchange = e => { s.followCam = e.target.checked; markDirty(); autosave(); renderTrackTab(); paintTracking(true); render2D(true); };
  el.querySelectorAll('[data-vis]').forEach(x => x.onclick = () => { const k = selTrack(); if (!k) return; checkpoint(); setPoint(k, video.currentTime, { vis: x.dataset.vis, x: null, y: null, src: 'manual' }); autosave(); renderTrackTab(); paintTracking(true); if (TR.settings.autoAdvance) advance(1); });
  b('#tkHold', () => { const k = selTrack(); if (!k) return; const i = findIdx(k.points, video.currentTime - frameDur() * 0.6), last = k.points.slice(0, i + 1).reverse().find(q => q.vis === 'v'); if (!last) { toast('No earlier position', 'bad'); return; } checkpoint(); setPoint(k, video.currentTime, { x: last.x, y: last.y, src: 'manual', vis: 'v' }); autosave(); renderTrackTab(); paintTracking(true); if (TR.settings.autoAdvance) advance(1); });
  b('#tkDelPt', () => { const k = selTrack(); if (!k) return; checkpoint(); if (!deletePoint(k, video.currentTime)) History.past.pop(); autosave(); renderTrackTab(); paintTracking(true); });
  b('#tkPrevK', () => { const k = selTrack(); if (!k) return; const q = k.points.slice().reverse().find(x => x.t < video.currentTime - frameDur() * 0.6); if (q) video.currentTime = q.t + frameDur() * 0.1; });
  b('#tkNextK', () => { const k = selTrack(); if (!k) return; const q = k.points.find(x => x.t > video.currentTime + frameDur() * 0.6); if (q) video.currentTime = q.t + frameDur() * 0.1; });
  b('#tkBack', () => advance(-1)); b('#tkFwd', () => advance(1));
  b('#tkAddSquad', addSquadTracks);
  b('#tkAddH', () => { checkpoint(); TR.sel = newTrack({ team: 'Home', label: 'H' + (TR.tracks.filter(x => x.team === 'Home' && !x.playerId).length + 1) }).id; renderTrackTab(); });
  b('#tkAddA', () => { checkpoint(); TR.sel = newTrack({ team: 'Away', label: 'A' + (TR.tracks.filter(x => x.team === 'Away' && !x.playerId).length + 1) }).id; renderTrackTab(); });
  b('#tkAddBall', () => { checkpoint(); TR.sel = newTrack({ kind: 'ball', team: 'Neutral', label: 'Ball' }).id; renderTrackTab(); });
  b('#tkAddRef', () => { checkpoint(); TR.sel = newTrack({ kind: 'ref', team: 'Neutral', label: 'Referee' }).id; renderTrackTab(); });
  b('#tkCal', () => openCalibration(null));
  b('#tkNoCal', () => { if (!hasVideo()) return; checkpoint(); TR.cals.push({ id: uid(), t: Math.round(video.currentTime * 100) / 100, type: 'none', points: [], H: null }); markDirty(); autosave(); renderTrackTab(); paintTracking(true); toast('From here on: no pitch calibration (positions are kept on the video only)', 'info', 3500); });
  b('#tkCsv', exportTrackingCsv); b('#tkJson', exportTrackingJson);
  el.querySelectorAll('[data-tk]').forEach(x => x.onclick = ev => { if (ev.target.closest('button')) return; TR.sel = x.dataset.tk; renderTrackTab(); paintTracking(true); });
  el.querySelectorAll('[data-tkdel]').forEach(x => x.onclick = () => { const k = TR.tracks.find(q => q.id === x.dataset.tkdel); if (k && confirm('Delete the track "' + trackLabel(k) + '" with ' + k.points.length + ' points?')) { checkpoint(); TR.tracks = TR.tracks.filter(q => q !== k); if (TR.sel === k.id) TR.sel = null; autosave(); renderTrackTab(); paintTracking(true); } });
  el.querySelectorAll('[data-tkedit]').forEach(x => x.onclick = () => editTrack(x.dataset.tkedit));
  el.querySelectorAll('[data-caledit]').forEach(x => x.onclick = () => { const c = TR.cals.find(q => q.id === x.dataset.caledit); if (c && c.type !== 'none') { video.currentTime = c.t + 0.001; setTimeout(() => openCalibration(c), 250); } });
  el.querySelectorAll('[data-caldel]').forEach(x => x.onclick = () => { if (!confirm('Delete this calibration?')) return; checkpoint(); TR.cals = TR.cals.filter(q => q.id !== x.dataset.caldel); markDirty(); autosave(); renderTrackTab(); paintTracking(true); });
  el.querySelectorAll('[data-cal] .lb').forEach(x => x.onclick = () => { const c = TR.cals.find(q => q.id === x.parentElement.dataset.cal); if (c && hasVideo()) video.currentTime = c.t + 0.001; });
  if (typeof renderAiBox === 'function') renderAiBox();
  if (typeof renderBallPanel === 'function') renderBallPanel();
  if (typeof renderEditorBox === 'function') renderEditorBox();
}
function addSquadTracks() {
  const sq = Object.keys(match.squad || {}).length ? config.players.filter(p => match.squad[p.id] && match.squad[p.id] !== 'out') : config.players;
  const have = new Set(TR.tracks.map(x => x.playerId).filter(Boolean));
  const add = sq.filter(p => !have.has(p.id));
  if (!add.length) { toast('All squad players already have a track', 'info'); return; }
  checkpoint();
  add.forEach(p => newTrack({ team: p.team || 'Home', playerId: p.id }));
  if (!TR.sel) TR.sel = TR.tracks[0].id;
  autosave(); renderTrackTab(); toast(add.length + ' player tracks added', 'ok');
}
function editTrack(id) {
  const tk = TR.tracks.find(x => x.id === id); if (!tk) return;
  let v = null;
  Dlg.open('✎ Track: ' + trackLabel(tk), `<div class="formgrid">
    <label>Type</label><select id="teKind">${[['player', 'Player'], ['ball', 'Ball'], ['ref', 'Referee'], ['other', 'Other person']].map(([k, n]) => `<option value="${k}" ${tk.kind === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
    <label>Team</label><select id="teTeam">${TEAMS.map(x => `<option value="${x}" ${tk.team === x ? 'selected' : ''}>${esc(teamName(x))}</option>`).join('')}</select>
    <label>Player (identity)</label><select id="tePlayer"><option value="">— not identified —</option>${config.players.map(p => `<option value="${p.id}" ${tk.playerId === p.id ? 'selected' : ''}>${esc((p.team === 'Away' ? '(opp) ' : '') + playerLabel(p) + (p.name ? ' – ' + p.name : ''))}</option>`).join('')}</select>
    <label>Label (if not identified)</label><input id="teLabel" value="${esc(tk.label)}">
    <label>Colour</label><input type="color" id="teColor" value="${esc(trackColor(tk))}">
    <label>Interpolation</label><select id="teInterp"><option value="1" ${tk.interp !== false ? 'selected' : ''}>allowed</option><option value="0" ${tk.interp === false ? 'selected' : ''}>off for this track</option></select></div>
    <p class="small muted">${esc(coverage(tk))}. Changing the player here re-assigns the whole track (e.g. after an ID mix-up).</p>`,
  [{ label: 'Cancel' }, { label: 'Save', primary: true, value: 'ok', onClick: () => { v = { kind: $('#teKind').value, team: $('#teTeam').value, playerId: $('#tePlayer').value, label: $('#teLabel').value.trim(), color: $('#teColor').value, interp: $('#teInterp').value === '1' }; } }]).then(r => {
    if (r !== 'ok' || !v) return;
    checkpoint();
    const p = VOC.playersById[v.playerId];
    Object.assign(tk, v, { team: p ? (p.team || 'Home') : v.team, color: v.color === teamColor(p ? p.team : v.team) ? '' : v.color });
    markDirty(); autosave(); renderTrackTab(); paintTracking(true);
  });
}

/* ---------------------------------------------------------------- CALIBRATION TOOL */
function landmarks() {
  const { L, W } = pitchDims(), cy = W / 2, d = Math.sqrt(9.15 * 9.15 - 5.5 * 5.5);
  const side = (pre, X) => [
    [pre + ' corner (far)', X(0), 0], [pre + ' corner (near)', X(0), W],
    [pre + ' box – goal line far', X(0), cy - 20.16], [pre + ' box – goal line near', X(0), cy + 20.16],
    [pre + ' box – far corner', X(16.5), cy - 20.16], [pre + ' box – near corner', X(16.5), cy + 20.16],
    [pre + ' 6-yd – goal line far', X(0), cy - 9.16], [pre + ' 6-yd – goal line near', X(0), cy + 9.16],
    [pre + ' 6-yd – far corner', X(5.5), cy - 9.16], [pre + ' 6-yd – near corner', X(5.5), cy + 9.16],
    [pre + ' penalty spot', X(11), cy], [pre + ' D – far end', X(16.5), cy - d], [pre + ' D – near end', X(16.5), cy + d], [pre + ' D – tip', X(20.15), cy],
    [pre + ' post far', X(0), cy - 3.66], [pre + ' post near', X(0), cy + 3.66]];
  const list = side('Left', x => x).concat(side('Right', x => L - x)).concat([
    ['Halfway – far touchline', L / 2, 0], ['Halfway – near touchline', L / 2, W], ['Centre spot', L / 2, cy],
    ['Centre circle – far', L / 2, cy - 9.15], ['Centre circle – near', L / 2, cy + 9.15], ['Centre circle – left', L / 2 - 9.15, cy], ['Centre circle – right', L / 2 + 9.15, cy]]);
  return list.map(([name, X, Y], i) => ({ id: 'lm' + i, name, X: Math.round(X * 100) / 100, Y: Math.round(Y * 100) / 100 }));
}
function pitchSvgFull(L, W, inner, cls) {
  const segs = pitchSegments(L, W).map(([a, b]) => `M${a[0].toFixed(2)},${a[1].toFixed(2)}L${b[0].toFixed(2)},${b[1].toFixed(2)}`).join('');
  return `<svg class="pitchsvg ${cls || ''}" viewBox="-2 -2 ${L + 4} ${W + 4}" xmlns="http://www.w3.org/2000/svg"><rect class="grass" x="-2" y="-2" width="${L + 4}" height="${W + 4}"/><path class="ln" d="${segs}"/>${inner || ''}</svg>`;
}
function openCalibration(existing) {
  if (!hasVideo() || !video.videoWidth) { toast('Open a video first', 'bad'); return; }
  video.pause();
  const { L, W } = pitchDims(), LM = landmarks();
  const prevCal = sortedCals().filter(c => c.type !== 'none' && c.t <= video.currentTime && (!existing || c.id !== existing.id)).pop();
  const st = { points: existing ? JSON.parse(JSON.stringify(existing.points)) : [], active: null, blend: existing ? !!existing.blend : false, t: existing ? existing.t : Math.round(video.currentTime * 100) / 100, drag: null };
  const frame = document.createElement('canvas'); frame.width = video.videoWidth; frame.height = video.videoHeight; frame.getContext('2d').drawImage(video, 0, 0);
  // where the pitch landmarks should be, according to the calibration carried along with the camera
  const here = existing ? null : calAt(st.t), carriedHere = here && here.carried ? here : null;
  const predicted = () => { const Hi = inv3(carriedHere.H); if (!Hi) return []; return LM.map(l => { const r = applyH(Hi, l.X, l.Y); return r && r[2] > 0 && r[0] > 0.03 && r[0] < 0.97 && r[1] > 0.03 && r[1] < 0.97 ? { lm: l.id, img: [r[0], r[1]], pitch: [l.X, l.Y] } : null; }).filter(Boolean); };
  const html = `<div class="calwrap"><div><canvas id="calCv"></canvas><div class="small muted" id="calHint"></div></div>
    <div><div id="calPitch"></div><div class="lmlist" id="calList"></div>
      <div class="toolbar" style="margin-top:6px"><span id="calQ" class="badge"></span><span class="small muted" id="calN"></span></div>
      <div class="toolbar small"><label><input type="checkbox" id="calBlend" ${st.blend ? 'checked' : ''}> blend smoothly to the next calibration (slow camera pan)</label></div>
      <div class="toolbar">${carriedHere ? '<button class="small" id="calAuto">Place points from the camera movement</button>' : ''}${prevCal && !existing ? '<button class="small" id="calCopy">Start from previous calibration’s points</button>' : ''}<button class="small" id="calClear">Clear points</button></div>
      <p class="small muted">1. Pick a point on the pitch (list or dot). 2. Click that spot in the video frame. Drag points to adjust; right-click a point to remove it. 4 points minimum – 6+ spread across the visible pitch is best. Valid from <b>${fmtTime(st.t)}</b> until the next calibration.</p></div></div>`;
  let saved = false;
  Dlg.open('🎯 Pitch calibration at ' + fmtTime(st.t), html, [{ label: 'Cancel' }, { label: 'Save calibration', primary: true, value: 'ok', onClick: () => { if (st.points.length < 4) { alert('At least 4 points are needed.'); return false; } saved = true; } }], { wide: true, focus: false, onOpen: body => {
    const cv = body.querySelector('#calCv'); cv.width = frame.width; cv.height = frame.height;
    const H = () => solveHomography(st.points.map(p => p.img), st.points.map(p => p.pitch));
    const redraw = () => {
      const ctx = cv.getContext('2d'); ctx.drawImage(frame, 0, 0);
      const h = H();
      if (h) drawProjectedLines(ctx, h, cv.width, cv.height, 'rgba(255,230,0,.8)');
      const r = Math.max(6, cv.width / 160);
      st.points.forEach(p => { const x = p.img[0] * cv.width, y = p.img[1] * cv.height; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = p.lm === st.active ? '#2ecc71' : '#ff3b3b'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
        ctx.font = `600 ${Math.round(r * 1.8)}px Segoe UI`; ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 3; const lbl = (LM.find(l => l.id === p.lm) || { name: 'custom' }).name; ctx.strokeText(lbl, x + r * 1.4, y - r); ctx.fillText(lbl, x + r * 1.4, y - r); });
      const done = new Set(st.points.map(p => p.lm));
      body.querySelector('#calPitch').innerHTML = pitchSvgFull(L, W, LM.map(l => `<circle data-lm="${l.id}" cx="${l.X}" cy="${l.Y}" r="${l.id === st.active ? 1.6 : 1.1}" fill="${l.id === st.active ? '#ffd23b' : done.has(l.id) ? '#2ecc71' : '#ffffff'}" stroke="#000" stroke-width=".3" style="cursor:pointer"><title>${esc(l.name)}</title></circle>`).join(''));
      body.querySelector('#calList').innerHTML = LM.map(l => `<div data-lm="${l.id}" class="${l.id === st.active ? 'on' : ''} ${done.has(l.id) ? 'done' : ''}">${done.has(l.id) ? '✓' : '•'} ${esc(l.name)} <span class="muted">(${l.X}, ${l.Y})</span></div>`).join('');
      const q = calQuality({ points: st.points, H: h });
      body.querySelector('#calQ').className = 'badge ' + q.cls; body.querySelector('#calQ').textContent = q.label;
      body.querySelector('#calN').textContent = st.points.length + ' point(s)';
      body.querySelector('#calHint').textContent = st.active ? 'Now click “' + (LM.find(l => l.id === st.active) || {}).name + '” in the video frame.' : 'Pick a pitch point on the right first.';
    };
    const pick = id => { st.active = id; redraw(); };
    body.querySelector('#calPitch').onclick = e => { const c = e.target.closest('[data-lm]'); if (c) pick(c.dataset.lm); };
    body.querySelector('#calList').onclick = e => { const c = e.target.closest('[data-lm]'); if (c) pick(c.dataset.lm); };
    const pos = e => { const r = cv.getBoundingClientRect(); return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1), r]; };
    const near = (x, y, r) => st.points.find(p => Math.hypot((p.img[0] - x) * r.width, (p.img[1] - y) * r.height) < 12);
    cv.addEventListener('contextmenu', e => { e.preventDefault(); const [x, y, r] = pos(e); const p = near(x, y, r); if (p) { st.points = st.points.filter(q => q !== p); redraw(); } });
    cv.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      const [x, y, r] = pos(e); const p = near(x, y, r);
      if (p) { st.drag = p; st.active = p.lm; redraw(); return; }
      if (!st.active) { toast('Pick the pitch point first (right side)', 'bad'); return; }
      const lm = LM.find(l => l.id === st.active);
      st.points = st.points.filter(q => q.lm !== lm.id).concat([{ lm: lm.id, img: [x, y], pitch: [lm.X, lm.Y] }]);
      st.active = null; redraw();
    });
    cv.addEventListener('mousemove', e => { if (!st.drag) return; const [x, y] = pos(e); st.drag.img = [x, y]; redraw(); });
    window.addEventListener('mouseup', () => { st.drag = null; });
    body.querySelector('#calBlend').onchange = e => { st.blend = e.target.checked; };
    body.querySelector('#calClear').onclick = () => { st.points = []; redraw(); };
    const ca = body.querySelector('#calAuto');
    if (ca) { ca.onclick = () => { st.points = predicted(); redraw(); };
      if (!st.points.length) { st.points = predicted(); if (st.points.length) setTimeout(() => toast(`${st.points.length} points placed from the camera movement (±${carriedHere.err.toFixed(1)} m) – drag any that are off, then save`, 'info', 5000), 300); } }
    const cp = body.querySelector('#calCopy'); if (cp) cp.onclick = () => { st.points = JSON.parse(JSON.stringify(prevCal.points)); redraw(); toast('Previous points copied – drag them onto the right spots', 'info', 3000); };
    window.__calState = st; window.__calH = H;
    redraw();
  } }).then(() => {
    if (!saved) return;
    checkpoint();
    const Hm = solveHomography(st.points.map(p => p.img), st.points.map(p => p.pitch));
    if (existing) Object.assign(existing, { points: st.points, H: Hm, blend: st.blend, type: 'hom' });
    else TR.cals.push({ id: uid(), t: st.t, type: 'hom', points: st.points, H: Hm, blend: st.blend, w: frame.width, h: frame.height });
    markDirty(); autosave(); renderTrackTab(); paintTracking(true); render2D(true);
    toast('Calibration saved – ' + calQuality({ points: st.points, H: Hm }).label, 'ok', 3000);
  });
}

/* ---------------------------------------------------------------- 2D PITCH VIEW */
let p2last = -1;
function render2D(force) {
  const box = $('#pitch2d');
  if (box.classList.contains('hidden')) return;
  const t = curT();
  if (!force && Math.abs(t - p2last) < 0.04) return;
  p2last = t;
  const { L, W } = pitchDims();
  const c = calAt(t);
  let inner = '', shown = 0, total = 0;
  const trails = $('#p2trails').checked, trailSec = Number(TR.settings.trail) || 6, show = $('#p2show') ? $('#p2show').value : 'all';
  TR.tracks.forEach(tk => {
    if (!tk.points.length) return;
    if (show === 'ball' ? tk.kind !== 'ball' : show === 'sel' ? tk.id !== TR.sel : show !== 'all' ? (tk.kind === 'ball' ? false : tk.team !== show) : false) return;
    total++;
    if (trails) {
      const pts = [];
      for (let s = Math.max(0, t - trailSec); s <= t + 1e-6; s += 0.2) { const p = posAt(tk, s); if (p && p.kind !== 'status') { const m = toPitch(s, p.x, p.y); if (m) pts.push(m); else pts.push(null); } else pts.push(null); }
      let d = '', pen = false; pts.forEach(m => { if (!m) { pen = false; return; } d += (pen ? 'L' : 'M') + m[0].toFixed(2) + ',' + m[1].toFixed(2); pen = true; });
      if (d) inner += `<path d="${d}" fill="none" stroke="${esc(trackColor(tk))}" stroke-width="${tk.kind === 'ball' ? 0.35 : 0.5}" opacity=".55"/>`;
    }
    const p = posAt(tk, t);
    if (!p || p.kind === 'status') return;
    const m = toPitch(t, p.x, p.y); if (!m) return;
    shown++;
    const interp = isEstimate(p), col = trackColor(tk);
    if (tk.kind === 'ball') inner += `<circle cx="${m[0].toFixed(2)}" cy="${m[1].toFixed(2)}" r=".9" fill="${esc(col)}" stroke="#000" stroke-width=".25" opacity="${interp ? .6 : 1}"/>`;
    else inner += `<g opacity="${interp ? .6 : 1}"><circle cx="${m[0].toFixed(2)}" cy="${m[1].toFixed(2)}" r="1.7" fill="${esc(col)}" stroke="${tk.id === TR.sel ? '#2ecc71' : '#000'}" stroke-width="${tk.id === TR.sel ? .6 : .25}" ${interp ? 'stroke-dasharray=".6 .4"' : ''}/>
      <text x="${m[0].toFixed(2)}" y="${(m[1] + 0.75).toFixed(2)}" font-size="2" text-anchor="middle" fill="#fff" font-weight="700">${esc(trackShort(tk))}</text></g>`;
  });
  $('#p2svg').innerHTML = pitchSvgFull(L, W, inner) + (c ? '' : `<div class="small warn" style="margin-top:3px">No pitch calibration at ${fmtTime(t)} – positions can’t be placed on the pitch.</div>`);
  $('#p2info').textContent = total ? `${shown}/${total} placed · ${fmtTime(t)}` : 'no tracks yet';
}
$('#btn2D').onclick = () => { const b = $('#pitch2d'); b.classList.toggle('hidden'); render2D(true); };
$('#p2close').onclick = () => $('#pitch2d').classList.add('hidden');
$('#p2size').onchange = e => { const b = $('#pitch2d'); b.classList.remove('s', 'm', 'l'); b.classList.add(e.target.value); };
$('#p2trails').onchange = () => render2D(true);
$('#p2show').onchange = () => render2D(true);
$('#p2trail').onchange = e => { TR.settings.trail = Number(e.target.value); render2D(true); };

/* ---------------------------------------------------------------- EXPORT */
function trackRows(hz) {
  const rows = [], fd = frameDur();
  TR.tracks.forEach(tk => {
    if (!tk.points.length) return;
    const p = tk.playerId && VOC.playersById[tk.playerId];
    const base = [tk.id, tk.kind, teamName(tk.kind === 'ball' ? 'Neutral' : tk.team), p ? p.num : '', p ? (p.name || p.pos) : (tk.label || ''), trackLabel(tk)];
    const add = (t, q) => {
      const m = q && q.kind !== 'status' ? toPitch(t, q.x, q.y) : null, c = calAt(t);
      rows.push(base.concat([Math.round(t / fd), Math.round(t * 1000) / 1000, matchClock(t), periodOf(t) || '',
        q && q.kind !== 'status' ? Math.round(q.x * 10000) / 10000 : '', q && q.kind !== 'status' ? Math.round(q.y * 10000) / 10000 : '',
        m ? Math.round(m[0] * 100) / 100 : '', m ? Math.round(m[1] * 100) / 100 : '',
        q ? (q.kind === 'interp' ? 'interpolated' : q.src || 'manual') : '', q ? VIS_NAME[q.vis || 'v'] : 'unknown', c ? c.cal.id : '', q && q.conf != null ? q.conf : '']));
    };
    if (!hz) tk.points.forEach(q => add(q.t, posAt(tk, q.t)));
    else { const a = tk.points[0].t, b = tk.points[tk.points.length - 1].t; for (let t = a; t <= b + 1e-6; t += 1 / hz) { const q = posAt(tk, t); if (q) add(t, q); } }
  });
  return rows;
}
const TRACK_HEAD = ['track_id', 'kind', 'team', 'number', 'name', 'label', 'frame', 'time_s', 'match_time', 'period', 'img_x', 'img_y', 'pitch_x_m', 'pitch_y_m', 'source', 'visibility', 'calibration_id', 'ai_confidence'];
async function exportTrackingCsv() {
  if (!TR.tracks.some(t => t.points.length)) { toast('No tracking data yet', 'bad'); return; }
  let hz = null;
  const r = await Dlg.open('Tracking CSV', `<p>Which rows?</p><select id="tkHz"><option value="0">Keyframes only (exactly what you clicked)</option><option value="5">5 rows per second (with interpolation)</option><option value="10">10 rows per second</option><option value="25">25 rows per second</option></select>
    <p class="small muted">Pitch positions are in metres (x along the pitch 0–${pitchDims().L}, y across 0–${pitchDims().W}). Rows without a calibration have no pitch position. “interpolated” rows were not clicked.</p>`,
  [{ label: 'Cancel' }, { label: 'Export', primary: true, value: 'ok', onClick: () => { hz = Number($('#tkHz').value); } }]);
  if (r !== 'ok') return;
  const q = v => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const csv = [TRACK_HEAD.join(',')].concat(trackRows(hz).map(r2 => r2.map(q).join(','))).join('\r\n');
  const name = (project.info.name || 'match') + ' tracking' + (hz ? ' ' + hz + 'Hz' : ' keyframes') + '.csv';
  await api.saveFile({ defaultName: project.dir ? project.dir + '/tracking_data/' + name : name, filters: [{ name: 'CSV', extensions: ['csv'] }], data: '﻿' + csv });
}
async function exportTrackingJson() {
  const data = { product: 'TACTIQ ANALYST', version: APP_VERSION, pitch: pitchDims(), fps: 1 / frameDur(), video: videoInfo.name,
    tracks: TR.tracks.map(tk => ({ id: tk.id, kind: tk.kind, team: tk.team, playerId: tk.playerId, label: trackLabel(tk), points: tk.points.map(p => { const m = p.vis === 'v' ? toPitch(p.t, p.x, p.y) : null; return Object.assign({}, p, { pitch: m ? [Math.round(m[0] * 100) / 100, Math.round(m[1] * 100) / 100] : null }); }) })),
    calibrations: TR.cals, note: 'Points are keyframes only. img = 0-1 image coordinates of the feet. pitch = metres, null when no calibration or not visible.' };
  const name = (project.info.name || 'match') + ' tracking.json';
  await api.saveFile({ defaultName: project.dir ? project.dir + '/tracking_data/' + name : name, filters: [{ name: 'JSON', extensions: ['json'] }], data: JSON.stringify(data, null, 1) });
}
$('#btnTrackCsv').onclick = exportTrackingCsv;
$('#btnTrackJson').onclick = exportTrackingJson;

/* ---------------------------------------------------------------- SAMPLES FOR MAPS (heatmap / average positions) */
function trackingSamples(filter = {}) {
  const { L, W } = pitchDims(), out = [];
  TR.tracks.forEach(tk => {
    if (!tk.points.length || tk.kind === 'ref') return;
    if (filter.kind && tk.kind !== filter.kind) return;
    if (filter.notKind && tk.kind === filter.notKind) return;
    if (filter.team && (tk.kind === 'ball' ? 'Neutral' : tk.team) !== filter.team) return;
    if (filter.playerId && tk.playerId !== filter.playerId) return;
    const a = tk.points[0].t, b = tk.points[tk.points.length - 1].t;
    for (let t = a; t <= b + 1e-6; t += 0.5) {
      if (filter.period && (periodOf(t) || '') !== filter.period) continue;
      const q = posAt(tk, t); if (!q || q.kind === 'status') continue;
      const m = toPitch(t, q.x, q.y); if (!m) continue;
      out.push({ tk, t, x: clamp(m[0] / L * 100, 0, 100), y: clamp(m[1] / W * 100, 0, 100) });
    }
  });
  return out;
}

/* ---------------------------------------------------------------- WIRING */
HOOKS.tick.push(() => {
  if (TR.on || TR.settings.overlay) paintTracking(false);
  render2D(false);
});
HOOKS.render.push(tab => {
  if (tab === 'track' || (!tab && !$('#tab-track').classList.contains('hidden'))) renderTrackTab();
  if (tab === 'resize') { paintTracking(true); render2D(true); }
  if (!tab) { paintTracking(true); render2D(true); }
});
window.addEventListener('resize', () => { paintTracking(true); });
video.addEventListener('seeked', () => { if (TR.on) { paintTracking(true); if (!$('#tab-track').classList.contains('hidden')) renderTrackTab(); } });
