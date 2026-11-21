/* TACTIQ ANALYST – dynamic annotations (3.1).
   Telestration that is tied to the tracking data, so it moves with the players and stays on the grass while the
   camera pans:  🔦 spotlight · 🏷 name tag · ➜ run arrow · ↔ distance (live metres) · 〰 line through players · ▭ zone.
   Each annotation lives from t0 to t1 (fades in and out) and is drawn on the video, on the 2D pitch, in the 3D view,
   and burnt into an MP4 with 🎬.  Stored in TR.anns: { id, type, tracks:[ids], t0, t1, color, text, zone:[x0,y0,x1,y1] } */
'use strict';

const ANN_TYPES = {
  spot: { name: 'Spotlight', icon: '🔦', picks: 1, hint: 'Click a player on the video – the spotlight follows them.' },
  label: { name: 'Name tag', icon: '🏷', picks: 1, hint: 'Click a player – a tag with the name follows them.' },
  run: { name: 'Run', icon: '➜', picks: 1, hint: 'Click a player – the arrow shows the run they make in the next seconds.' },
  link: { name: 'Distance', icon: '↔', picks: 2, hint: 'Click two players – the line shows their distance live, in metres.' },
  chain: { name: 'Line', icon: '〰', picks: 99, hint: 'Click the players of the line one after another, then Enter (or ✓).' },
  zone: { name: 'Zone', icon: '▭', picks: 0, hint: 'Drag a rectangle on the pitch – it stays on the grass when the camera moves.' }
};
const Ann = { on: false, tool: null, color: '#ffd23b', picks: [], drag: null, raf: 0, exporting: null };
const annView = $('#annView');
const FADE = 0.35;

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
// clock for the pulsing effects: video time while playing / exporting (frame-exact), wall clock while paused
const annClock = t => Ann.exporting || !hasVideo() || !video.paused ? t : performance.now() / 1000;
const annTrack = id => TR.tracks.find(x => x.id === id);
const annName = a => a.type === 'zone' ? (a.text || 'Zone') : a.tracks.map(id => { const tk = annTrack(id); return tk ? trackLabel(tk) : '?'; }).join(' – ');

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
function annRing(g, p, R, W, H, n = 28) {
  if (g && p.m) {
    const out = [];
    for (let k = 0; k < n; k++) { const a = k / n * Math.PI * 2, q = annImg(g, p.m[0] + Math.cos(a) * R, p.m[1] + Math.sin(a) * R); if (!q) return null; out.push([q[0] * W, q[1] * H]); }
    return out;
  }
  const rx = R * W / 95, ry = rx * 0.38, out = [];
  for (let k = 0; k < n; k++) { const a = k / n * Math.PI * 2; out.push([p.x * W + Math.cos(a) * rx, p.y * H + Math.sin(a) * ry]); }
  return out;
}
const polyPath = (ctx, P) => { ctx.beginPath(); P.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); };
const hexA = (hex, a) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || '') ; const v = m ? parseInt(m[1], 16) : 0xffd23b; return `rgba(${v >> 16 & 255},${v >> 8 & 255},${v & 255},${a})`; };
function annPill(ctx, x, y, text, col, fs, dark = true) {
  ctx.font = `700 ${fs}px Inter, "Segoe UI", Arial, sans-serif`;
  const w = ctx.measureText(text).width + fs * 0.9, h = fs * 1.45, r = h / 2;
  ctx.beginPath(); ctx.moveTo(x - w / 2 + r, y - h / 2); ctx.arcTo(x + w / 2, y - h / 2, x + w / 2, y + h / 2, r); ctx.arcTo(x + w / 2, y + h / 2, x - w / 2, y + h / 2, r);
  ctx.arcTo(x - w / 2, y + h / 2, x - w / 2, y - h / 2, r); ctx.arcTo(x - w / 2, y - h / 2, x + w / 2, y - h / 2, r); ctx.closePath();
  ctx.fillStyle = dark ? 'rgba(8,12,16,.86)' : col; ctx.fill(); ctx.lineWidth = Math.max(1.5, fs * 0.1); ctx.strokeStyle = col; ctx.stroke();
  ctx.fillStyle = dark ? col : '#111'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y + fs * 0.04);
  return w;
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

/* ---------------------------------------------------------------- drawing on the video */
function drawAnnotations(ctx, W, H, t) {
  const list = annActive(t); if (!list.length) return 0;
  const g = annGeo(t), clk = annClock(t), fs = Math.max(11, Math.round(H * 0.026)), lw = Math.max(2, W * 0.0028);
  // zones first (under everything), then lines, then spotlights and tags on top
  const order = { zone: 0, chain: 1, link: 2, run: 3, spot: 4, label: 5 };
  list.slice().sort((a, b) => order[a.type] - order[b.type]).forEach(a => {
    const al = annAlpha(a, t), col = a.color || '#ffd23b';
    ctx.save(); ctx.globalAlpha = al; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    try {
      if (a.type === 'zone') annZone2d(ctx, a, g, W, H, clk, col, fs, lw);
      else if (a.type === 'run') annRun2d(ctx, a, g, W, H, t, col, lw);
      else if (a.type === 'link' || a.type === 'chain') annLinks2d(ctx, a, g, W, H, t, clk, col, fs, lw);
      else { const tk = annTrack(a.tracks[0]), p = annPos(tk, t); if (p) a.type === 'spot' ? annSpot2d(ctx, a, tk, p, g, W, H, t, clk, col, fs, lw) : annTag2d(ctx, a, tk, p, g, W, H, t, col, fs); }
    } catch (e) { /* one broken annotation must not stop the others */ }
    ctx.restore();
  });
  return list.length;
}
function annSpot2d(ctx, a, tk, p, g, W, H, t, clk, col, fs, lw) {
  const ppm = annScale(g, p, W, H), body = ppm * 1.9, x = p.x * W, y = p.y * H, gr = annGrow(a, t, 0.5);
  const R = 1.15 * (0.6 + 0.4 * gr), ring = annRing(g, p, R, W, H); if (!ring) return;
  // light beam from above
  const bw = ppm * R * 1.5, top = y - body * 2.6;
  const lg = ctx.createLinearGradient(0, top, 0, y);
  lg.addColorStop(0, hexA(col, 0)); lg.addColorStop(0.55, hexA(col, 0.16)); lg.addColorStop(1, hexA(col, 0.38));
  ctx.beginPath(); ctx.moveTo(x - bw * 0.55, top); ctx.lineTo(x + bw * 0.55, top); ctx.lineTo(x + bw, y); ctx.lineTo(x - bw, y); ctx.closePath();
  ctx.fillStyle = lg; ctx.fill();
  // glowing disc on the grass
  const rg = ctx.createRadialGradient(x, y, 0, x, y, bw);
  rg.addColorStop(0, hexA(col, 0.55)); rg.addColorStop(0.7, hexA(col, 0.25)); rg.addColorStop(1, hexA(col, 0.08));
  polyPath(ctx, ring); ctx.fillStyle = rg; ctx.fill();
  ctx.shadowColor = hexA(col, 0.9); ctx.shadowBlur = lw * 4; ctx.lineWidth = lw * 1.4; ctx.strokeStyle = col; ctx.stroke(); ctx.shadowBlur = 0;
  // ripples
  for (let k = 0; k < 2; k++) {
    const ph = ((clk * 0.9) + k * 0.5) % 1, rp = annRing(g, p, R * (1 + ph * 1.1), W, H);
    if (rp) { polyPath(ctx, rp); ctx.lineWidth = lw * (1.2 - ph * 0.8); ctx.strokeStyle = hexA(col, (1 - ph) * 0.8); ctx.stroke(); }
  }
  if (a.text) annPill(ctx, x, top + fs * 0.2, a.text, col, fs);
}
function annTag2d(ctx, a, tk, p, g, W, H, t, col, fs) {
  const ppm = annScale(g, p, W, H), x = p.x * W, head = p.y * H - ppm * 1.95, gr = annGrow(a, t, 0.4);
  const text = (a.text || trackLabel(tk)), ty = head - fs * 1.6 - (1 - gr) * fs;
  ctx.beginPath(); ctx.moveTo(x, head - fs * 0.15); ctx.lineTo(x - fs * 0.35, ty + fs * 0.6); ctx.lineTo(x + fs * 0.35, ty + fs * 0.6); ctx.closePath(); ctx.fillStyle = col; ctx.fill();
  const team = tk.kind === 'player' ? teamColor(tk.team) : '#888';
  ctx.font = `700 ${fs}px Inter, "Segoe UI", Arial, sans-serif`;
  const w = ctx.measureText(text).width + fs * 1.4, h = fs * 1.6;
  ctx.fillStyle = 'rgba(8,12,16,.9)'; ctx.fillRect(x - w / 2, ty - h / 2, w, h);
  ctx.fillStyle = team; ctx.fillRect(x - w / 2, ty - h / 2, fs * 0.35, h);
  ctx.lineWidth = Math.max(1.5, fs * 0.09); ctx.strokeStyle = col; ctx.strokeRect(x - w / 2, ty - h / 2, w, h);
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + fs * 0.18, ty + fs * 0.05);
}
function annRun2d(ctx, a, g, W, H, t, col, lw) {
  const path = annRunPath(a); if (!path) return;
  // the path is kept on the grass: pitch metres projected with the calibration of THIS frame
  const P = path.map(q => g && q.m ? annImg(g, q.m[0], q.m[1]) : [q.x, q.y]).filter(Boolean).map(q => [q[0] * W, q[1] * H]);
  if (P.length < 2) return;
  const gr = annGrow(a, t, Math.min(1, (a.t1 - a.t0) * 0.35)), n = Math.max(2, Math.ceil(P.length * gr));
  const done = clamp(Math.round((t - a.t0) / Math.max(0.01, a.t1 - a.t0) * (P.length - 1)), 0, P.length - 1);
  const draw = (pts, width, style, dash) => { ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.lineWidth = width; ctx.strokeStyle = style; ctx.setLineDash(dash || []); ctx.stroke(); ctx.setLineDash([]); };
  const vis = P.slice(0, n);
  draw(vis, lw * 3, 'rgba(0,0,0,.35)');
  draw(vis.slice(0, done + 1), lw * 1.6, hexA(col, 0.5), [lw * 2, lw * 2]);         // already run: dashed
  draw(vis.slice(done), lw * 1.9, col);                                               // still to run: solid
  // arrow head in proportion to the run (a short run gets a small head, a standing player a dot)
  let len = 0; for (let k = 1; k < vis.length; k++) len += Math.hypot(vis[k][0] - vis[k - 1][0], vis[k][1] - vis[k - 1][1]);
  const e = vis[vis.length - 1]; let b = vis[vis.length - 1];
  for (let k = vis.length - 2; k >= 0; k--) { b = vis[k]; if (Math.hypot(e[0] - b[0], e[1] - b[1]) > lw * 3) break; }
  if (len > lw * 4 && Math.hypot(e[0] - b[0], e[1] - b[1]) > 1) annArrowHead(ctx, b[0], b[1], e[0], e[1], clamp(len * 0.25, lw * 2.5, lw * 5.5), col);
  else { ctx.beginPath(); ctx.arc(e[0], e[1], lw * 2.2, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); }
}
function annLinks2d(ctx, a, g, W, H, t, clk, col, fs, lw) {
  const ps = a.tracks.map(id => annPos(annTrack(id), t));
  const nodes = ps.map((p, i) => p ? { p, x: p.x * W, y: p.y * H, i } : null).filter(Boolean);
  if (nodes.length < 2) return;
  const gr = annGrow(a, t, 0.6);
  if (a.type === 'chain' && a.fill && nodes.length >= 3) { polyPath(ctx, nodes.map(n => [n.x, n.y])); ctx.fillStyle = hexA(col, 0.16 * gr); ctx.fill(); }
  for (let k = 0; k + 1 < nodes.length; k++) {
    const A = nodes[k], B = nodes[k + 1], ex = A.x + (B.x - A.x) * gr, ey = A.y + (B.y - A.y) * gr;
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(ex, ey); ctx.lineWidth = lw * 3.6; ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(ex, ey); ctx.lineWidth = lw * 1.8; ctx.strokeStyle = col;
    if (a.type === 'link') { ctx.setLineDash([lw * 4, lw * 3]); ctx.lineDashOffset = -clk * lw * 18; }
    ctx.stroke(); ctx.setLineDash([]);
    const d = A.p.m && B.p.m ? Math.hypot(A.p.m[0] - B.p.m[0], A.p.m[1] - B.p.m[1]) : null;
    if (d != null && gr > 0.95 && (a.type === 'link' || a.dist !== false && nodes.length <= 6)) annPill(ctx, (A.x + B.x) / 2, (A.y + B.y) / 2, fmtM(d), col, a.type === 'link' ? fs : fs * 0.8);
  }
  nodes.forEach(n => { ctx.beginPath(); ctx.arc(n.x, n.y, lw * 2.6, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = lw * 0.8; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.stroke(); });
}
function annZone2d(ctx, a, g, W, H, clk, col, fs, lw) {
  let P = null;
  if (a.zone && g) {
    const [x0, y0, x1, y1] = a.zone, pts = [];
    // edges split into pieces, so the perspective bends them correctly
    const edge = (ax, ay, bx, by) => { for (let k = 0; k < 12; k++) pts.push([ax + (bx - ax) * k / 12, ay + (by - ay) * k / 12]); };
    edge(x0, y0, x1, y0); edge(x1, y0, x1, y1); edge(x1, y1, x0, y1); edge(x0, y1, x0, y0);
    P = pts.map(([x, y]) => annImg(g, x, y)); if (P.some(q => !q)) return;
    P = P.map(q => [q[0] * W, q[1] * H]);
  } else if (a.img) { const [x0, y0, x1, y1] = a.img; P = [[x0 * W, y0 * H], [x1 * W, y0 * H], [x1 * W, y1 * H], [x0 * W, y1 * H]]; }
  if (!P) return;
  polyPath(ctx, P); ctx.fillStyle = hexA(col, 0.2); ctx.fill();
  // stripes
  ctx.save(); polyPath(ctx, P); ctx.clip();
  const xs = P.map(q => q[0]), ys = P.map(q => q[1]), minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys), gap = lw * 7;
  ctx.strokeStyle = hexA(col, 0.18); ctx.lineWidth = lw * 1.6;
  for (let x = minX - (maxY - minY); x < maxX; x += gap) { ctx.beginPath(); ctx.moveTo(x, maxY); ctx.lineTo(x + (maxY - minY), minY); ctx.stroke(); }
  ctx.restore();
  polyPath(ctx, P); ctx.lineWidth = lw * 1.6; ctx.strokeStyle = col; ctx.setLineDash([lw * 5, lw * 3]); ctx.lineDashOffset = -clk * lw * 12; ctx.stroke(); ctx.setLineDash([]);
  if (a.text) annPill(ctx, xs.reduce((s, v) => s + v, 0) / xs.length, ys.reduce((s, v) => s + v, 0) / ys.length, a.text, col, fs, false);
}

/* ---------------------------------------------------------------- the 2D pitch (SVG, metres) */
function annSvg(t) {
  const list = annActive(t); if (!list.length) return '';
  const clk = annClock(t); let s = '';
  list.forEach(a => {
    const al = annAlpha(a, t).toFixed(2), col = esc(a.color || '#ffd23b');
    if (a.type === 'zone' && a.zone) {
      const [x0, y0, x1, y1] = a.zone;
      s += `<g opacity="${al}"><rect x="${Math.min(x0, x1)}" y="${Math.min(y0, y1)}" width="${Math.abs(x1 - x0)}" height="${Math.abs(y1 - y0)}" fill="${col}" fill-opacity=".2" stroke="${col}" stroke-width=".4" stroke-dasharray="1.4 .9"/>${a.text ? `<text x="${(x0 + x1) / 2}" y="${(y0 + y1) / 2 + 0.7}" font-size="2.2" text-anchor="middle" fill="#fff" font-weight="700">${esc(a.text)}</text>` : ''}</g>`;
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
    let seg = '';
    for (let k = 0; k + 1 < pts.length; k++) {
      const A = pts[k], B = pts[k + 1], d = Math.hypot(A[0] - B[0], A[1] - B[1]);
      seg += `<line x1="${A[0].toFixed(2)}" y1="${A[1].toFixed(2)}" x2="${B[0].toFixed(2)}" y2="${B[1].toFixed(2)}" stroke="${col}" stroke-width=".45" ${a.type === 'link' ? 'stroke-dasharray="1.2 .8"' : ''}/>`;
      if (a.type === 'link' || pts.length <= 6) seg += `<text x="${((A[0] + B[0]) / 2).toFixed(2)}" y="${((A[1] + B[1]) / 2 - 0.8).toFixed(2)}" font-size="1.8" text-anchor="middle" fill="#fff" font-weight="700" stroke="#000" stroke-width=".3" paint-order="stroke">${fmtM(d)}</text>`;
    }
    const fill = a.type === 'chain' && a.fill && pts.length >= 3 ? `<polygon points="${pts.map(q => q[0].toFixed(2) + ',' + q[1].toFixed(2)).join(' ')}" fill="${col}" fill-opacity=".15"/>` : '';
    s += `<g opacity="${al}">${fill}${seg}</g>`;
  });
  return s;
}

/* ---------------------------------------------------------------- the 3D view */
const annTex = new Map();
function annTexFor(text, col) {
  const key = text + '|' + col; if (annTex.has(key)) return annTex.get(key);
  const T = V3.T, c = document.createElement('canvas'), x = c.getContext('2d'), fs = 40;
  x.font = `bold ${fs}px Inter, "Segoe UI", sans-serif`;
  const w = Math.ceil(x.measureText(text).width + fs * 1.1); c.width = Math.max(64, w + 8); c.height = 64;
  x.font = `bold ${fs}px Inter, "Segoe UI", sans-serif`;
  x.fillStyle = 'rgba(8,12,16,.88)'; x.strokeStyle = col; x.lineWidth = 5;
  const r = 26; x.beginPath(); x.moveTo(4 + r, 4); x.arcTo(c.width - 4, 4, c.width - 4, 60, r); x.arcTo(c.width - 4, 60, 4, 60, r); x.arcTo(4, 60, 4, 4, r); x.arcTo(4, 4, c.width - 4, 4, r); x.closePath(); x.fill(); x.stroke();
  x.fillStyle = col; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, c.width / 2, 34);
  const tex = new T.CanvasTexture(c); tex.colorSpace = T.SRGBColorSpace; tex.__w = c.width / 64;
  annTex.set(key, tex); return tex;
}
function v3Anns(t) {
  const T = V3.T, fx = V3.fx; if (!T || !fx) return;
  const old = fx.userData.ann || []; old.forEach(o => { fx.remove(o); v3Dispose(o); }); fx.userData.ann = [];
  if (annTex.size > 120) { annTex.forEach(x => x.dispose()); annTex.clear(); }
  const list = annActive(t); V3.annAnim = list.some(a => a.type === 'spot' || a.type === 'link' || a.type === 'zone');
  if (!list.length) return;
  const add = o => { fx.add(o); fx.userData.ann.push(o); return o; };
  const mat = (col, op, extra) => new T.MeshBasicMaterial(Object.assign({ color: col, transparent: true, opacity: op, depthWrite: false, side: T.DoubleSide }, extra || {}));
  const flat = (geo, col, op, y, extra) => { const m = new T.Mesh(geo, mat(col, op, extra)); m.rotation.x = -Math.PI / 2; m.position.y = y; return add(m); };
  const sprite = (text, col, x, y, z, h = 0.75) => { const tx = annTexFor(text, col), sp = new T.Sprite(new T.SpriteMaterial({ map: tx, depthTest: false, transparent: true })); sp.position.set(x, y, z); sp.scale.set(h * tx.__w, h, 1); sp.renderOrder = 12; return add(sp); };
  const tube = (pts, r, col, op) => { if (pts.length < 2) return null; const curve = new T.CatmullRomCurve3(pts.map(p => new T.Vector3(p[0], p[1], p[2])), false, 'centripetal'); const m = new T.Mesh(new T.TubeGeometry(curve, Math.max(8, pts.length * 3), r, 8, false), mat(col, op)); m.renderOrder = 5; return add(m); };
  const w3 = m => { const [x, z] = v3W(m[0], m[1]); return [x, z]; };
  const clk = annClock(t);
  list.forEach(a => {
    const al = annAlpha(a, t), col = a.color || '#ffd23b';
    if (a.type === 'zone' && a.zone) {
      const [x0, y0, x1, y1] = a.zone, [ax, az] = w3([x0, y0]), [bx, bz] = w3([x1, y1]);
      const g = new T.PlaneGeometry(Math.abs(bx - ax), Math.abs(bz - az)), m = flat(g, col, 0.24 * al, 0.035); m.position.x = (ax + bx) / 2; m.position.z = (az + bz) / 2;
      const ph = 0.6 + 0.4 * Math.sin(clk * 4);
      const e = [[ax, az], [bx, az], [bx, bz], [ax, bz], [ax, az]].flatMap(([x, z]) => [x, 0.06, z]);
      const lg = new T.BufferGeometry(); lg.setAttribute('position', new T.BufferAttribute(new Float32Array(e), 3));
      add(new T.Line(lg, new T.LineBasicMaterial({ color: col, transparent: true, opacity: al * ph })));
      if (a.text) sprite(a.text, col, (ax + bx) / 2, 1.6, (az + bz) / 2, 2.2).material.opacity = al;
      return;
    }
    if (a.type === 'run') {
      const p = annRunPath(a); if (!p) return; const m = p.filter(q => q.m).map(q => q.m); if (m.length < 2) return;
      const n = Math.max(2, Math.ceil(m.length * annGrow(a, t, Math.min(1, (a.t1 - a.t0) * 0.35))));
      const pts = m.slice(0, n).map(q => { const [x, z] = w3(q); return [x, 0.12, z]; });
      tube(pts, 0.16, col, 0.9 * al);
      const e = pts[pts.length - 1], b = pts[Math.max(0, pts.length - 4)], ang = Math.atan2(e[2] - b[2], e[0] - b[0]);
      const cone = add(new T.Mesh(new T.ConeGeometry(0.55, 1.3, 16), mat(col, al)));
      cone.position.set(e[0], 0.25, e[2]); cone.rotation.z = -Math.PI / 2; cone.rotation.y = -ang; cone.rotation.order = 'YZX';
      return;
    }
    const ps = a.tracks.map(id => { const q = annPos(annTrack(id), t); return q && q.m ? q.m : null; });
    if (a.type === 'spot' || a.type === 'label') {
      const m = ps[0]; if (!m) return; const [x, z] = w3(m);
      if (a.type === 'spot') {
        const disc = flat(new T.CircleGeometry(1.35, 40), col, 0.38 * al, 0.03); disc.position.x = x; disc.position.z = z;
        const ring = flat(new T.RingGeometry(1.25, 1.5, 48), col, 0.95 * al, 0.04); ring.position.x = x; ring.position.z = z;
        for (let k = 0; k < 2; k++) { const ph = ((clk * 0.9) + k * 0.5) % 1, rp = flat(new T.RingGeometry(1.3, 1.42, 48), col, (1 - ph) * 0.8 * al, 0.045); rp.position.x = x; rp.position.z = z; rp.scale.setScalar(1 + ph * 1.2); }
        const beam = add(new T.Mesh(new T.CylinderGeometry(0.45, 1.35, 9, 32, 1, true), mat(col, 0.16 * al, { blending: T.AdditiveBlending })));
        beam.position.set(x, 4.5, z);
      }
      if (a.type === 'label' || a.text) sprite(a.text || trackLabel(annTrack(a.tracks[0])), col, x, 3.7, z, 1.3).material.opacity = al;
      return;
    }
    const pts = ps.filter(Boolean).map(m => { const [x, z] = w3(m); return [x, 0.15, z, m]; });
    if (pts.length < 2) return;
    const gr = annGrow(a, t, 0.6);
    if (a.type === 'chain' && a.fill && pts.length >= 3) {
      const sh = new T.Shape(); pts.forEach(([x, , z], i) => i ? sh.lineTo(x, -z) : sh.moveTo(x, -z));
      flat(new T.ShapeGeometry(sh), col, 0.18 * al * gr, 0.04);
    }
    for (let k = 0; k + 1 < pts.length; k++) {
      const A = pts[k], B = pts[k + 1], E = [A[0] + (B[0] - A[0]) * gr, 0.15, A[2] + (B[2] - A[2]) * gr];
      tube([[A[0], 0.15, A[2]], E], a.type === 'link' ? 0.07 : 0.1, col, 0.95 * al);
      const d = Math.hypot(A[3][0] - B[3][0], A[3][1] - B[3][1]);
      if (gr > 0.95 && (a.type === 'link' || pts.length <= 6)) sprite(fmtM(d), col, (A[0] + B[0]) / 2, a.type === 'link' ? 1.5 : 1.1, (A[2] + B[2]) / 2, a.type === 'link' ? 1.5 : 1.15).material.opacity = al;
    }
    pts.forEach(([x, , z]) => { const d = flat(new T.CircleGeometry(0.42, 20), col, al, 0.05); d.position.x = x; d.position.z = z; });
  });
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
  annPlace();
  const ctx = annView.getContext('2d'); ctx.clearRect(0, 0, annView.width, annView.height);
  drawAnnotations(ctx, annView.width, annView.height, t);
  // authoring: highlight the players picked so far and the zone being dragged
  if (Ann.on) {
    const W = annView.width, H = annView.height;
    Ann.picks.forEach((id, i) => { const p = annPos(annTrack(id), t); if (!p) return; ctx.save(); ctx.strokeStyle = Ann.color; ctx.lineWidth = 3; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.arc(p.x * W, p.y * H, Math.max(14, W / 70), 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); annPill(ctx, p.x * W, p.y * H - Math.max(26, W / 40), String(i + 1), Ann.color, Math.max(12, H * 0.022), false); ctx.restore(); });
    if (Ann.drag) { const d = Ann.drag; ctx.save(); ctx.strokeStyle = Ann.color; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.strokeRect(d.x0 * W, d.y0 * H, (d.x1 - d.x0) * W, (d.y1 - d.y0) * H); ctx.restore(); }
  }
}
// keep the pulses moving while the video is paused
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
  $$('#annBar [data-ann]').forEach(b => b.classList.toggle('on', b.dataset.ann === Ann.tool));
  $('#annDone').classList.toggle('hidden', Ann.tool !== 'chain');
  annView.classList.toggle('edit', !!Ann.tool);
  $('#annHint').textContent = Ann.tool ? ANN_TYPES[Ann.tool].hint : 'Choose what to add, then click the players on the video. The annotation starts at the current moment.';
  if (Ann.tool && hasVideo()) video.pause();
  paintAnnotations();
}
function annOpen() {
  if (!hasVideo()) { toast('Open a video first', 'bad'); return; }
  if (!TR.tracks.some(tk => tk.kind === 'player' && tk.points.length)) toast('Annotations follow tracked players – track players first (🤖 Auto-detect or by hand). Zones work anyway.', 'info', 5000);
  if (typeof Draw !== 'undefined' && Draw.editing) Draw.close();
  Ann.on = true; $('#annBar').classList.remove('hidden'); $('#btnAnn').classList.add('on');
  TR.settings.overlay = TR.settings.overlay !== false;
  annSetTool(null); annCount(); paintAnnotations(); annKick();
}
function annClose() { Ann.on = false; Ann.tool = null; Ann.picks = []; Ann.drag = null; $('#annBar').classList.add('hidden'); $('#annPop').classList.add('hidden'); $('#btnAnn').classList.remove('on'); annView.classList.remove('edit'); paintAnnotations(); }
function annCount() { $('#annN').textContent = (TR.anns || []).length; }
function annEnd(t0) {
  const v = $('#annDur').value;
  if (v === 'out' && clipIO.out != null && clipIO.out > t0 + 0.3) return clipIO.out;
  return Math.min(video.duration || t0 + 4, t0 + (Number(v) || 4));
}
function annAdd(a) {
  checkpoint();
  TR.anns = TR.anns || [];
  const t0 = Math.round(video.currentTime * 1000) / 1000;
  const x = Object.assign({ id: uid(), t0, t1: Math.round(annEnd(t0) * 1000) / 1000, color: Ann.color, text: '' }, a);
  TR.anns.push(x);
  markDirty(); autosave(); annCount(); paintAnnotations(); if (typeof render2D === 'function') render2D(true); if (typeof V3 !== 'undefined') V3.dirty = true;
  toast(`${ANN_TYPES[x.type].icon} ${ANN_TYPES[x.type].name} added: ${annName(x)} · ${fmtTime(x.t0)}–${fmtTime(x.t1)}`, 'ok', 2500);
  annKick();
  return x;
}
function annHit(e) {
  const r = annView.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height, t = video.currentTime;
  let best = null;
  TR.tracks.forEach(tk => {
    if (tk.kind === 'ball' || !trackDrawn(tk)) return;
    const p = annPos(tk, t); if (!p) return;
    // the feet point, or anywhere on the body above it (up to 6 % of the picture height)
    const px = (x - p.x) * r.width, py = (y - p.y) * r.height, d = Math.hypot(px, py > 0 ? py : Math.max(0, -py - r.height * 0.06));
    if (d < Math.max(22, r.width / 45) && (!best || d < best.d)) best = { tk, d };
  });
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1), tk: best && best.tk };
}
annView.addEventListener('mousedown', async e => {
  if (!Ann.on || !Ann.tool || e.button !== 0) return;
  e.preventDefault();
  const h = annHit(e), T = ANN_TYPES[Ann.tool];
  if (Ann.tool === 'zone') { Ann.drag = { x0: h.x, y0: h.y, x1: h.x, y1: h.y }; return; }
  if (!h.tk) { toast('Click a tracked player (their marker on the video)', 'bad', 1800); return; }
  if (Ann.picks.includes(h.tk.id)) { Ann.picks = Ann.picks.filter(id => id !== h.tk.id); paintAnnotations(); return; }
  Ann.picks.push(h.tk.id); paintAnnotations();
  if (Ann.picks.length >= T.picks) {
    const tracks = Ann.picks.slice(); Ann.picks = [];
    let text = '';
    if (Ann.tool === 'label') { text = await Dlg.ask('Name tag', 'Text on the tag (leave as it is for the player’s name):', trackLabel(h.tk)); if (text == null) { paintAnnotations(); return; } if (text === trackLabel(h.tk)) text = ''; }
    annAdd({ type: Ann.tool, tracks, text });
  } else $('#annHint').textContent = `${T.hint}  (${Ann.picks.length} picked)`;
});
window.addEventListener('mousemove', e => {
  if (!Ann.drag) return;
  const r = annView.getBoundingClientRect();
  Ann.drag.x1 = clamp((e.clientX - r.left) / r.width, 0, 1); Ann.drag.y1 = clamp((e.clientY - r.top) / r.height, 0, 1);
  paintAnnotations();
});
window.addEventListener('mouseup', async () => {
  if (!Ann.drag) return;
  const d = Ann.drag; Ann.drag = null;
  if (Math.abs(d.x1 - d.x0) < 0.01 || Math.abs(d.y1 - d.y0) < 0.01) { paintAnnotations(); return; }
  const t = video.currentTime, a = toPitch(t, d.x0, d.y0), b = toPitch(t, d.x1, d.y1), c2 = toPitch(t, d.x1, d.y0), d2 = toPitch(t, d.x0, d.y1);
  const text = await Dlg.ask('Zone', 'Text in the zone (optional), e.g. “Space” or “Overload”:', '');
  if (text == null) { paintAnnotations(); return; }
  const { L, W } = pitchDims();
  if (a && b && c2 && d2) {
    const xs = [a[0], b[0], c2[0], d2[0]], ys = [a[1], b[1], c2[1], d2[1]];
    // the dragged box, as a rectangle on the pitch (the part inside the lines)
    const z = [clamp(Math.min(...xs), -3, L + 3), clamp(Math.min(...ys), -3, W + 3), clamp(Math.max(...xs), -3, L + 3), clamp(Math.max(...ys), -3, W + 3)].map(v => Math.round(v * 10) / 10);
    annAdd({ type: 'zone', tracks: [], zone: z, text });
  } else annAdd({ type: 'zone', tracks: [], img: [Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.max(d.x0, d.x1), Math.max(d.y0, d.y1)], text });
});
function annFinishChain() {
  if (Ann.tool !== 'chain') return;
  if (Ann.picks.length < 2) { toast('Pick at least two players for a line', 'bad'); return; }
  const tracks = Ann.picks.slice(); Ann.picks = [];
  annAdd({ type: 'chain', tracks, fill: tracks.length >= 3 && confirm('Shade the area between these ' + tracks.length + ' players?\n\nOK = line with shaded area\nCancel = just the line') });
  $('#annHint').textContent = ANN_TYPES.chain.hint;
}
function annListPop() {
  const pop = $('#annPop');
  if (!pop.classList.contains('hidden')) { pop.classList.add('hidden'); return; }
  const list = (TR.anns || []).slice().sort((a, b) => a.t0 - b.t0);
  pop.innerHTML = list.length ? list.map(a => `<div class="arow"><span class="chip" style="background:${esc(a.color)}"></span><span>${ANN_TYPES[a.type].icon}</span>
      <span class="grow" title="${esc(annName(a))}">${esc(annName(a))}</span><span class="muted">${fmtTime(a.t0)}–${fmtTime(a.t1)}</span>
      <button class="small" data-ajump="${a.id}" title="Go there">▶</button><button class="small" data-alen="${a.id}" title="Longer (+1 s)">+</button><button class="small" data-ashort="${a.id}" title="Shorter (−1 s)">−</button><button class="small danger" data-adel="${a.id}" title="Delete">✕</button></div>`).join('')
    : '<p class="small muted" style="margin:4px">No annotations yet.</p>';
  pop.classList.remove('hidden');
  const find = id => (TR.anns || []).find(a => a.id === id);
  pop.querySelectorAll('[data-ajump]').forEach(b => b.onclick = () => { const a = find(b.dataset.ajump); if (a) { video.pause(); video.currentTime = Math.min(a.t1, a.t0 + 0.6); } });
  const len = (id, d) => { const a = find(id); if (!a) return; checkpoint(); a.t1 = Math.max(a.t0 + 0.5, Math.round((a.t1 + d) * 1000) / 1000); markDirty(); autosave(); pop.classList.add('hidden'); annListPop(); paintAnnotations(); };
  pop.querySelectorAll('[data-alen]').forEach(b => b.onclick = () => len(b.dataset.alen, 1));
  pop.querySelectorAll('[data-ashort]').forEach(b => b.onclick = () => len(b.dataset.ashort, -1));
  pop.querySelectorAll('[data-adel]').forEach(b => b.onclick = () => { checkpoint(); TR.anns = TR.anns.filter(a => a.id !== b.dataset.adel); markDirty(); autosave(); annCount(); pop.classList.add('hidden'); annListPop(); paintAnnotations(); render2D(true); if (typeof V3 !== 'undefined') V3.dirty = true; });
}

/* ---------------------------------------------------------------- MP4 with the annotations burnt in */
// The annotations are drawn frame by frame (exactly, from the tracking data) on a transparent picture; ffmpeg lays
// them over the original video – no slow frame-by-frame seeking in the player.
async function annExport() {
  if (!api.v3dBegin) { toast('Saving the video works in the installed desktop app', 'bad'); return; }
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

/* ---------------------------------------------------------------- wiring */
$('#btnAnn').onclick = () => Ann.on ? annClose() : annOpen();
$('#annClose').onclick = annClose;
$('#annDone').onclick = annFinishChain;
$('#annList').onclick = annListPop;
$('#annExport').onclick = annExport;
$$('#annBar [data-ann]').forEach(b => b.onclick = () => annSetTool(b.dataset.ann));
$$('#annBar [data-acolor]').forEach(b => b.onclick = () => { Ann.color = b.dataset.acolor; $$('#annBar [data-acolor]').forEach(x => x.classList.toggle('on', x === b)); paintAnnotations(); });
HOOKS.tick.push(() => { if (Ann.on || (TR.anns || []).length) paintAnnotations(); });
HOOKS.render.push(tab => { if (!tab || tab === 'resize') { annCount(); paintAnnotations(); } });
HOOKS.key.push(e => {
  if (!Ann.on || e.ctrlKey || e.altKey || e.metaKey) return false;
  if (e.key === 'Enter' && Ann.tool === 'chain') { e.preventDefault(); annFinishChain(); return true; }
  if (e.key === 'Escape') { if (Ann.tool) annSetTool(null); else annClose(); return true; }
  return false;
});
video.addEventListener('pause', annKick);
video.addEventListener('seeked', () => { paintAnnotations(); annKick(); });
window.addEventListener('resize', () => paintAnnotations());
