/* TACTIQ ANALYST – 2D analytics from tracking data (roadmap phase 0.7).
   Team shape (width, length, defensive line, lines, compactness), average positions, distance and speed
   estimates, confidence-weighted heat maps, ball movement, data-quality reporting, positional report & CSV.
   Everything is calculated from the stored tracks; every figure says how much data it rests on. */
'use strict';
const POS = { team: 'Home', when: 'all', code: '', range: 'all', dir: 'auto', heat: 'team', step: 0.5 };
const SPEED = { glitch: 12, hi: 5.5, sprint: 7.0, win: 0.5, dec: 0.4 };            // m/s: impossible jump, high intensity (19.8 km/h), sprint (25.2 km/h)

/* ---------------------------------------------------------------- helpers */
const otherTeam = tm => tm === 'Home' ? 'Away' : 'Home';
function isKeeper(tk) {
  const p = tk.playerId && VOC.playersById[tk.playerId];
  return /^gk$/i.test(tk.label || '') || !!(p && /goal ?keeper|^gk$/i.test(p.pos || ''));
}
function playerKey(tk) { return tk.playerId ? 'p:' + tk.playerId : 't:' + tk.id; }
function keyLabel(key) {
  if (key.startsWith('p:')) { const p = VOC.playersById[key.slice(2)]; return p ? playerLabel(p) + (p.name ? ' ' + p.name : '') : '?'; }
  const tk = TR.tracks.find(x => x.id === key.slice(2)); return tk ? trackLabel(tk) : '?';
}
function keyShort(key) {
  if (key.startsWith('p:')) { const p = VOC.playersById[key.slice(2)]; return p && p.num !== '' && p.num != null ? String(p.num) : '?'; }
  const tk = TR.tracks.find(x => x.id === key.slice(2)); return tk ? trackShort(tk) : '?';
}
function teamTracks(team) { return TR.tracks.filter(tk => tk.kind === 'player' && tk.team === team && tk.points.length); }
function trackedSpan() {
  let a = Infinity, b = -Infinity;
  TR.tracks.forEach(tk => { if (tk.kind === 'ball' || !tk.points.length) return; a = Math.min(a, tk.points[0].t); b = Math.max(b, tk.points[tk.points.length - 1].t); });
  if (!isFinite(a)) return null;
  if (POS.range === 'io' && clipIO.in != null && clipIO.out != null) { a = Math.max(a, clipIO.in); b = Math.min(b, clipIO.out); }
  return b > a ? [a, b] : null;
}
// which moments count, for the chosen team ("during build-up", "in possession", "2nd half" ...)
function makeMask(team) {
  const w = POS.when;
  if (w === 'p1' || w === 'p2') { const want = w.slice(1); return t => (periodOf(t) || '1') === want; }
  if (w === 'code') {
    const list = events.filter(e => e.codeId === POS.code && e.type === 'duration' && e.end > e.start);
    return t => list.some(e => t >= e.start && t <= e.end);
  }
  if (w === 'inpos' || w === 'outpos') {
    const pos = typeof possession === 'function' ? possession() : null;
    const segs = pos ? pos.segs : [];
    const own = w === 'inpos' ? team : otherTeam(team);
    return t => segs.some(s => s.team === own && t >= s.t0 && t < s.t1);
  }
  return () => true;
}
// attacking direction: the team whose players are on average nearer a goal defends that goal (works for
// low blocks too: the defending block sits between the attackers and its own goal). Can be overridden.
function dirInfo() { return Memo.get('dir|' + POS.dir + '|' + pitchDims().L, dirInfoCalc); }
function dirInfoCalc() {
  const { L } = pitchDims(), span = trackedSpan(), out = {};
  ['1', '2', '3', '4', '5'].forEach(per => {
    if (POS.dir !== 'auto') { const r = POS.dir === 'right'; out[per] = { Home: (per === '2' || per === '4') ? !r : r }; return; }
    const mean = team => { let s = 0, n = 0; if (!span) return null; teamTracks(team).forEach(tk => { for (let t = span[0]; t <= span[1]; t += 1) { if ((periodOf(t) || '1') !== per) continue; const q = posAt(tk, t); if (!q || q.kind === 'status') continue; const m = toPitch(t, q.x, q.y); if (m) { s += m[0]; n++; } } }); return n ? s / n : null; };
    const h = mean('Home'), a = mean('Away');
    let homeRight = null;                                            // true = Home attacks towards x = L
    const gk = TR.tracks.find(tk => tk.team === 'Home' && isKeeper(tk));
    if (gk && span) { let s = 0, n = 0; for (let t = span[0]; t <= span[1]; t += 1) { if ((periodOf(t) || '1') !== per) continue; const q = posAt(gk, t); if (!q || q.kind === 'status') continue; const m = toPitch(t, q.x, q.y); if (m) { s += m[0]; n++; } } if (n) homeRight = s / n < L / 2; }
    if (homeRight == null && h != null && a != null) homeRight = h < a;
    if (homeRight == null && h != null) homeRight = h < L / 2;
    out[per] = { Home: homeRight == null ? true : homeRight };
  });
  return out;
}
// pitch position normalised so that `team` always attacks to the right (x → 105), y mirrored with it
function normFor(team, dirs) {
  const { L, W } = pitchDims();
  return (t, m) => { const d = dirs[periodOf(t) || '1'] || dirs['1']; const right = team === 'Home' ? d.Home : !d.Home; return right ? [m[0], m[1]] : [L - m[0], W - m[1]]; };
}

/* ---------------------------------------------------------------- team shape */
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]); if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
const polyArea = h => { let s = 0; for (let i = 0; i < h.length; i++) { const a = h[i], b = h[(i + 1) % h.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; };
// three lines (defence, midfield, attack) by 1-D k-means on the depth of the outfield players
function threeLines(xs) {
  if (xs.length < 6) return null;
  const s = xs.slice().sort((a, b) => a - b);
  let c = [s[Math.floor(s.length * 0.15)], s[Math.floor(s.length * 0.5)], s[Math.floor(s.length * 0.85)]];
  let lab = [];
  for (let it = 0; it < 12; it++) {
    lab = s.map(x => c.reduce((bi, v, j) => Math.abs(x - v) < Math.abs(x - c[bi]) ? j : bi, 0));
    c = c.map((v, j) => { const g = s.filter((_, i) => lab[i] === j); return g.length ? g.reduce((a, b) => a + b, 0) / g.length : v; });
  }
  if (c.some((v, j) => !lab.includes(j))) return null;
  return c;
}
function outfield(pts) {
  let o = pts.filter(p => !p.gk);
  if (o.length >= 8) { const s = o.slice().sort((a, b) => a.x - b.x); if (s[1].x - s[0].x > 12) o = o.filter(p => p !== s[0]); }   // unlabelled keeper far behind
  return o;
}
function shapeFrame(pts) {
  const o = outfield(pts); if (o.length < 7) return null;
  const xs = o.map(p => p.x), ys = o.map(p => p.y);
  const s = xs.slice().sort((a, b) => a - b), nDef = o.length >= 9 ? 4 : 3;
  const hull = convexHull(o.map(p => [p.x, p.y]));
  const cx = xs.reduce((a, b) => a + b, 0) / o.length, cy = ys.reduce((a, b) => a + b, 0) / o.length;
  const lines = threeLines(xs);
  return { n: o.length, width: Math.max(...ys) - Math.min(...ys), length: s[s.length - 1] - s[0], defLine: s.slice(0, nDef).reduce((a, b) => a + b, 0) / nDef,
    area: polyArea(hull), spread: o.reduce((a, p) => a + Math.hypot(p.x - cx, p.y - cy), 0) / o.length, cx, cy,
    gapDM: lines ? lines[1] - lines[0] : null, gapMA: lines ? lines[2] - lines[1] : null };
}
// sample the chosen team every `step` seconds inside the mask
// long matches are sampled more coarsely (at most ~3000 moments): averages stay the same, the tab stays quick
function posStep() { const sp = trackedSpan(); return sp ? Math.max(POS.step, Math.round((sp[1] - sp[0]) / 3000 * 10) / 10) : POS.step; }
const posKey = team => [team, POS.when, POS.code, POS.range, POS.dir, POS.team].join('|');
function sampleTeam(team, step) { return Memo.get('st|' + posKey(team) + '|' + step, () => sampleTeamCalc(team, step)); }
function sampleTeamCalc(team, step) {
  const span = trackedSpan(); if (!span) return null;
  const mask = makeMask(team), dirs = dirInfo(), norm = normFor(team, dirs), tracks = teamTracks(team);
  const frames = []; let considered = 0, calibrated = 0, carried = 0, errSum = 0, viewSum = 0, viewN = 0, skipped = 0;
  for (let t = span[0]; t <= span[1] + 1e-6; t += step) {
    if (!mask(t)) continue;
    // close-ups, replays and other shots are left out (they show no usable pitch positions)
    if (!usableAt(t)) { skipped++; continue; }
    considered++;
    const ca = calAt(t);
    if (!ca) { frames.push({ t, pts: [], nocal: true }); continue; }
    calibrated++; if (ca.carried) { carried++; errSum += ca.err; }
    const vw = viewOf(ca.H, 5); if (vw) { viewSum += vw.frac; viewN++; }
    const pts = []; let edge = false;
    tracks.forEach(tk => {
      const q = posAt(tk, t); if (!q || q.kind === 'status') return;
      const m = toPitch(t, q.x, q.y); if (!m) return;
      const n = norm(t, m);
      if (!isEstimate(q) && atPictureEdge(q)) edge = true;
      const est = isEstimate(q), ai = q.src === 'ai' || q.fromAi;
      pts.push({ key: playerKey(tk), tk, x: n[0], y: n[1], w: est ? 0.5 : ai && q.conf != null ? Math.max(0.2, Math.min(1, q.conf * 1.5)) : 1, gk: isKeeper(tk), low: ai && q.conf != null && q.conf < 0.4, interp: est });
    });
    frames.push({ t, pts, edge, view: vw ? vw.frac : null });
  }
  return { span, frames, considered, calibrated, carried, carriedErr: carried ? errSum / carried : 0, step, dirs, viewAvg: viewN ? viewSum / viewN : null, skipped };
}
function teamShape(team) { return Memo.get('shape|' + posKey(team), () => teamShapeCalc(team)); }
function teamShapeCalc(team) {
  const S = sampleTeam(team, posStep()); if (!S) return null;
  const shapes = S.frames.map(f => f.pts.length ? Object.assign({ t: f.t, edge: f.edge }, shapeFrame(f.pts)) : null).filter(s => s && s.n);
  const avgOf = k => { const v = shapes.map(s => s[k]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const players = new Map();
  S.frames.forEach(f => f.pts.forEach(p => { if (!players.has(p.key)) players.set(p.key, { key: p.key, gk: p.gk, sx: 0, sy: 0, sw: 0, n: 0, low: 0 }); const o = players.get(p.key); o.sx += p.x * p.w; o.sy += p.y * p.w; o.sw += p.w; o.n++; if (p.low) o.low++; }));
  const avgPos = [...players.values()].filter(o => o.sw > 0).map(o => ({ key: o.key, gk: o.gk, x: o.sx / o.sw, y: o.sy / o.sw, n: o.n, sec: o.n * S.step, low: o.low / o.n }));
  const located = S.frames.filter(f => f.pts.length);
  return { S, shapes, avgPos,
    avg: { width: avgOf('width'), length: avgOf('length'), defLine: avgOf('defLine'), area: avgOf('area'), spread: avgOf('spread'), gapDM: avgOf('gapDM'), gapMA: avgOf('gapMA'), n: avgOf('n'), cx: avgOf('cx') },
    cover: { considered: S.considered, calibrated: S.calibrated, carried: S.carried, carriedErr: S.carriedErr, shapeFrames: shapes.length,
      viewAvg: S.viewAvg, skipped: S.skipped, edgeShare: shapes.length ? shapes.filter(s => s.edge).length / shapes.length : 0, avgPlayers: located.length ? located.reduce((a, f) => a + f.pts.length, 0) / located.length : 0,
      lowShare: (() => { let n = 0, l = 0; located.forEach(f => f.pts.forEach(p => { n++; if (p.low) l++; })); return n ? l / n : 0; })(),
      interpShare: (() => { let n = 0, l = 0; located.forEach(f => f.pts.forEach(p => { n++; if (p.interp) l++; })); return n ? l / n : 0; })() } };
}

/* ---------------------------------------------------------------- distance & speed */
function calSeg(t) { const c = calAt(t); return c ? c.cal.id : null; }
function movement(tk, mask) {
  // keyframes only (no interpolation), placed on the pitch; split where the data has gaps or the calibration changes
  const pts = tk.points.filter(p => p.vis === 'v' && p.x != null).map(p => { const m = toPitch(p.t, p.x, p.y); return m ? { t: p.t, x: m[0], y: m[1], seg: calSeg(p.t), low: p.src === 'ai' && p.conf != null && p.conf < 0.4 } : null; });
  const segs = []; let cur = [];
  pts.forEach(p => {
    if (!p) { if (cur.length) segs.push(cur); cur = []; return; }
    const last = cur[cur.length - 1];
    if (last && (p.t - last.t > 1.1 || p.seg !== last.seg)) { segs.push(cur); cur = []; }
    cur.push(p);
  });
  if (cur.length) segs.push(cur);
  let dist = 0, time = 0, hi = 0, glitches = 0, maxV = 0, sprints = 0, lowN = 0, nPts = 0, sprintTime = 0;
  segs.forEach(sg => {
    if (sg.length < 3) return;
    // smooth (mean over ±0.5 s) and measure every 0.4 s: the jitter of a detector box would otherwise add
    // metres of fake distance to a player who is standing still
    // the window is kept symmetric near the ends of a segment, so the path is not pulled short
    const t0 = sg[0].t, t1 = sg[sg.length - 1].t;
    const sm0 = sg.map((p, i) => { const w = Math.max(0.08, Math.min(SPEED.win, p.t - t0, t1 - p.t)); let sx = 0, sy = 0, n = 0; for (let j = i; j >= 0 && p.t - sg[j].t <= w; j--) { sx += sg[j].x; sy += sg[j].y; n++; } for (let j = i + 1; j < sg.length && sg[j].t - p.t <= w; j++) { sx += sg[j].x; sy += sg[j].y; n++; } return { t: p.t, x: sx / n, y: sy / n }; });
    const sm = []; sm0.forEach((p, i) => { if (!sm.length || p.t - sm[sm.length - 1].t >= SPEED.dec - 1e-6 || i === sm0.length - 1) sm.push(p); });
    const steps = [];
    for (let i = 1; i < sm.length; i++) {
      const dt = sm[i].t - sm[i - 1].t; if (dt <= 0) continue;
      const d = Math.hypot(sm[i].x - sm[i - 1].x, sm[i].y - sm[i - 1].y), v = d / dt, tm = (sm[i].t + sm[i - 1].t) / 2;
      if (!mask(tm)) continue;
      if (v > SPEED.glitch) { glitches++; continue; }
      steps.push({ t: tm, dt, d, v });
      dist += d; time += dt;
    }
    // speed over ~1 s windows for max speed, high intensity and sprints
    let j = 0, sumD = 0, sumT = 0, inSprint = 0;
    for (let i = 0; i < steps.length; i++) {
      sumD += steps[i].d; sumT += steps[i].dt;
      while (sumT - steps[j].dt >= 1.0 && j < i) { sumD -= steps[j].d; sumT -= steps[j].dt; j++; }
      if (sumT >= 0.9) {
        const v = sumD / sumT; maxV = Math.max(maxV, v);
        if (v >= SPEED.hi) hi += steps[i].d;
        if (v >= SPEED.sprint) { inSprint += steps[i].dt; sprintTime += steps[i].dt; if (inSprint >= 1 && inSprint - steps[i].dt < 1) sprints++; } else inSprint = 0;
      }
    }
    sg.forEach(p => { nPts++; if (p.low) lowN++; });
  });
  const cal = (() => { const ids = new Set(pts.filter(Boolean).map(p => p.seg)); const q = [...ids].map(id => TR.cals.find(c => c.id === id)).filter(Boolean).map(c => calQuality(c).rmse).filter(x => x != null); return q.length ? Math.max(...q) : null; })();
  return { dist, time, hi, glitches, maxV, sprints, sprintTime, lowShare: nPts ? lowN / nPts : 0, calErr: cal };
}
function teamMovement(team) { return Memo.get('move|' + posKey(team), () => teamMovementCalc(team)); }
function teamMovementCalc(team) {
  const span = trackedSpan(); if (!span) return [];
  const mask = makeMask(team);
  let maskTime = 0; for (let t = span[0]; t <= span[1]; t += 0.5) if (mask(t) && usableAt(t)) maskTime += 0.5;
  const by = new Map();
  teamTracks(team).forEach(tk => {
    const m = movement(tk, mask), k = playerKey(tk);
    const o = by.get(k) || { key: k, dist: 0, time: 0, hi: 0, glitches: 0, maxV: 0, sprints: 0, lowW: 0, calErr: null, gk: isKeeper(tk) };
    o.dist += m.dist; o.hi += m.hi; o.glitches += m.glitches; o.maxV = Math.max(o.maxV, m.maxV); o.sprints += m.sprints; o.lowW += m.lowShare * m.time; o.time += m.time;
    if (m.calErr != null) o.calErr = Math.max(o.calErr || 0, m.calErr);
    by.set(k, o);
  });
  return [...by.values()].filter(o => o.time > 0).map(o => {
    const cover = maskTime ? Math.min(1, o.time / maskTime) : 0, low = o.time ? o.lowW / o.time : 0;
    const q = cover >= 0.6 && low < 0.2 && (o.calErr == null || o.calErr < 0.6) && o.glitches < 5 ? 'good' : cover >= 0.3 && low < 0.4 ? 'fair' : 'poor';
    return Object.assign(o, { cover, low, quality: q, perMin: o.dist / (o.time / 60), maskTime });
  }).sort((a, b) => b.time - a.time);
}

/* ---------------------------------------------------------------- drawing (pitch drawn as 105 x 68) */
const SX = x => x * 105 / pitchDims().L, SY = y => y * 68 / pitchDims().W;
function pitchBase(inner, extra = '') {
  return `<svg class="pitchsvg" viewBox="-2 -2 109 72" xmlns="http://www.w3.org/2000/svg">${pitchLines()}${inner}
    <text x="52.5" y="70.6" font-size="2.2" text-anchor="middle" fill="#cfd8e3">attacking →</text>${extra}</svg>`;
}
function shapeSVG(sh, team) {
  if (!sh || !sh.avgPos.length) return '<p class="small muted">No calibrated positions for this selection.</p>';
  const col = teamColor(team), ap = sh.avgPos.map(p => Object.assign({}, p, { x: SX(p.x), y: SY(p.y) })), out = ap.filter(p => !p.gk);
  const hull = convexHull(out.map(p => [p.x, p.y]));
  let s = hull.length >= 3 ? `<polygon points="${hull.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')}" fill="${col}" fill-opacity=".15" stroke="${col}" stroke-width=".35" stroke-dasharray="1 .7"/>` : '';
  const a = sh.avg;
  if (a.defLine != null) { const dl = SX(a.defLine); s += `<line x1="${dl.toFixed(1)}" y1="0" x2="${dl.toFixed(1)}" y2="68" stroke="#ffd23b" stroke-width=".35" stroke-dasharray="1.2 .8"/><text x="${(dl + 0.6).toFixed(1)}" y="2.6" font-size="2" fill="#ffd23b">def. line ${a.defLine.toFixed(0)} m</text>`; }
  ap.forEach(p => {
    const op = p.sec < 5 ? 0.45 : 1;
    s += `<g opacity="${op}"><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="${col}" stroke="${p.low > 0.3 ? '#f5b041' : '#000'}" stroke-width="${p.low > 0.3 ? .5 : .25}"><title>${esc(keyLabel(p.key))} – ${p.sec.toFixed(0)} s of data${p.low > 0.3 ? ', many unsure AI points' : ''}</title></circle>
      <text x="${p.x.toFixed(1)}" y="${(p.y + 0.9).toFixed(1)}" font-size="2.5" text-anchor="middle" fill="#fff" font-weight="700">${esc(keyShort(p.key))}</text></g>`;
  });
  return pitchBase(s);
}
function heatSVG(samples, col) {
  if (!samples.length) return '<p class="small muted">No calibrated positions for this selection.</p>';
  samples = samples.map(p => ({ x: SX(p.x), y: SY(p.y), w: p.w }));
  const cs = 2.5, gx = Math.ceil(105 / cs), gy = Math.ceil(68 / cs), g = new Float32Array(gx * gy);
  // gaussian splat (σ ≈ 3 m), weighted by confidence
  samples.forEach(p => { const ci = p.x / cs, cj = p.y / cs; for (let j = Math.max(0, Math.floor(cj - 3)); j <= Math.min(gy - 1, Math.ceil(cj + 3)); j++) for (let i = Math.max(0, Math.floor(ci - 3)); i <= Math.min(gx - 1, Math.ceil(ci + 3)); i++) { const d2 = (i + 0.5 - ci) ** 2 + (j + 0.5 - cj) ** 2; g[j * gx + i] += p.w * Math.exp(-d2 / 2.9); } });
  const max = Math.max(...g) || 1; let s = '';
  for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) { const v = g[j * gx + i] / max; if (v < 0.04) continue; s += `<rect x="${i * cs}" y="${j * cs}" width="${cs + 0.05}" height="${cs + 0.05}" fill="${v > 0.66 ? '#ff2d2d' : v > 0.33 ? '#ff8c1a' : col}" opacity="${(0.15 + 0.6 * v).toFixed(2)}"/>`; }
  return pitchBase(s);
}
function seriesSVG(shapes, keys) {
  if (shapes.length < 3) return '';
  const a = shapes[0].t, b = shapes[shapes.length - 1].t, span = Math.max(1, b - a);
  // 1-second buckets
  const buckets = new Map(); shapes.forEach(s => { const k = Math.floor(s.t); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(s); });
  const rows = [...buckets.entries()].sort((x, y) => x[0] - y[0]).map(([k, l]) => { const o = { t: k + 0.5 }; keys.forEach(([key]) => { const v = l.map(s => s[key]).filter(x => x != null); o[key] = v.length ? v.reduce((p, q) => p + q, 0) / v.length : null; }); return o; });
  const max = Math.max(10, ...rows.flatMap(r => keys.map(([k]) => r[k] || 0))) * 1.08, Wd = 300, Hd = 90;
  const X = t => 28 + (t - a) / span * (Wd - 34), Y = v => Hd - 14 - v / max * (Hd - 22);
  let s = `<svg viewBox="0 0 ${Wd} ${Hd}" class="series">`;
  [0, 0.5, 1].forEach(f => { const v = max * f; s += `<line x1="28" x2="${Wd - 4}" y1="${Y(v)}" y2="${Y(v)}" stroke="rgba(255,255,255,.12)"/><text x="24" y="${Y(v) + 3}" font-size="8" text-anchor="end" fill="#9aa5b5">${v.toFixed(0)}</text>`; });
  keys.forEach(([k, name, col]) => {
    let d = '', pen = false; rows.forEach(r => { if (r[k] == null) { pen = false; return; } d += (pen ? 'L' : 'M') + X(r.t).toFixed(1) + ',' + Y(r[k]).toFixed(1); pen = true; });
    s += `<path d="${d}" fill="none" stroke="${col}" stroke-width="1.6"/>`;
  });
  s += `<text x="28" y="${Hd - 2}" font-size="8" fill="#9aa5b5">${fmtTime(a)}</text><text x="${Wd - 4}" y="${Hd - 2}" font-size="8" text-anchor="end" fill="#9aa5b5">${fmtTime(b)}</text>`;
  s += keys.map(([, name, col], i) => `<text x="${34 + i * 80}" y="9" font-size="8.5" fill="${col}">■ ${name} (m)</text>`).join('');
  return s + '</svg>';
}
function ballInfo(team) { return Memo.get('ball|' + posKey(team), () => ballInfoCalc(team)); }
function ballInfoCalc(team) {
  const btk = typeof ballTrack === 'function' ? ballTrack() : null, span = trackedSpan();
  if (!btk || !span) return null;
  const mask = makeMask(team), norm = normFor(team, dirInfo());
  const pts = []; let n = 0;
  for (let t = Math.max(span[0], btk.points[0].t); t <= Math.min(span[1], btk.points[btk.points.length - 1].t); t += 0.2) {
    if (!mask(t)) continue; n++;
    const q = ballAt(t, btk); if (!q) { pts.push(null); continue; }
    const m = toPitch(t, q.x, q.y); if (!m) { pts.push(null); continue; }
    const p = norm(t, m); pts.push({ t, x: p[0], y: p[1], w: isEstimate(q) ? 0.5 : 1 });
  }
  const ok = pts.filter(Boolean), thirds = [0, 0, 0], L = pitchDims().L;
  ok.forEach(p => thirds[p.x < L / 3 ? 0 : p.x < 2 * L / 3 ? 1 : 2]++);
  return { pts, ok, n, thirds: thirds.map(v => ok.length ? Math.round(v / ok.length * 100) : 0) };
}
function ballPathSVG(bi) {
  if (!bi || !bi.ok.length) return '<p class="small muted">No calibrated ball positions for this selection.</p>';
  let s = '', seg = [];
  const flush = () => { if (seg.length > 1) s += `<polyline points="${seg.map(p => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ')}" fill="none" stroke="#ffd23b" stroke-width=".45" opacity=".85"/>`; seg = []; };
  bi.pts.forEach(p => { if (!p) flush(); else seg.push({ x: SX(p.x), y: SY(p.y) }); }); flush();
  const lp = bi.ok[bi.ok.length - 1], last = { x: SX(lp.x), y: SY(lp.y) }; s += `<circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="1" fill="#ffd23b" stroke="#000" stroke-width=".25"/>`;
  [35, 70].forEach(x => { s += `<line x1="${x}" y1="0" x2="${x}" y2="68" stroke="#fff" stroke-width=".2" stroke-dasharray=".8 .8" opacity=".6"/>`; });
  return pitchBase(s);
}

/* ---------------------------------------------------------------- the Positions tab */
const f0 = v => v == null ? '—' : v.toFixed(0), f1 = v => v == null ? '—' : v.toFixed(1);
const pctTxt = v => Math.round(v * 100) + '%';
function qualityBadge(q) { return `<span class="badge ${q === 'good' ? 'good' : q === 'fair' ? 'fair' : 'poor'}">${q}</span>`; }
function renderPositions() {
  const el = $('#tab-pos'); if (!el || el.classList.contains('hidden')) return;
  const durCodes = config.codes.filter(c => c.type === 'duration' && events.some(e => e.codeId === c.id));
  const hasIO = clipIO.in != null && clipIO.out != null;
  const team = POS.team;
  const controls = `<div class="toolbar">
    <select id="psTeam">${['Home', 'Away'].map(t => `<option value="${t}" ${POS.team === t ? 'selected' : ''}>${esc(teamName(t))}</option>`).join('')}</select>
    <select id="psWhen" title="Which moments to include">
      <option value="all" ${POS.when === 'all' ? 'selected' : ''}>All tracked time</option><option value="p1" ${POS.when === 'p1' ? 'selected' : ''}>1st half</option><option value="p2" ${POS.when === 'p2' ? 'selected' : ''}>2nd half</option>
      <option value="inpos" ${POS.when === 'inpos' ? 'selected' : ''}>In possession (estimate)</option><option value="outpos" ${POS.when === 'outpos' ? 'selected' : ''}>Out of possession (estimate)</option>
      ${durCodes.length ? `<option value="code" ${POS.when === 'code' ? 'selected' : ''}>During tags of…</option>` : ''}</select>
    ${POS.when === 'code' ? `<select id="psCode">${durCodes.map(c => `<option value="${c.id}" ${POS.code === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>` : ''}
    <select id="psRange"><option value="all">Whole video</option>${hasIO ? `<option value="io" ${POS.range === 'io' ? 'selected' : ''}>Clip IN–OUT</option>` : ''}</select>
    <select id="psDir" title="Which way the home team attacks in the 1st half"><option value="auto" ${POS.dir === 'auto' ? 'selected' : ''}>Direction: auto</option><option value="right" ${POS.dir === 'right' ? 'selected' : ''}>${esc(teamName('Home'))} attacks → (1st half)</option><option value="left" ${POS.dir === 'left' ? 'selected' : ''}>${esc(teamName('Home'))} attacks ← (1st half)</option></select>
    <div class="spacer"></div><button class="small" id="psCsv">Positional CSV</button></div>`;
  if (POS.when === 'code' && !durCodes.some(c => c.id === POS.code)) POS.code = durCodes.length ? durCodes[0].id : '';
  const span = trackedSpan();
  if (!span || !teamTracks(team).length) { el.innerHTML = controls + '<p class="muted">No tracking data for this team yet. Track players by hand or with 🤖 Auto-detect (Track tab), and calibrate the pitch.</p>'; wirePos(el); return; }
  const sh = teamShape(team), mv = teamMovement(team), bi = ballInfo(team), c = sh.cover;
  const calPct = c.considered ? c.calibrated / c.considered : 0, shapePct = c.considered ? c.shapeFrames / c.considered : 0;
  const warn = [];
  if (calPct < 0.5) warn.push(`only ${pctTxt(calPct)} of the selected time is calibrated`);
  if (shapePct < 0.3) warn.push(`team shape needs 7+ outfield players at once – that was true for only ${pctTxt(shapePct)} of the time`);
  if (c.lowShare > 0.25) warn.push(`${pctTxt(c.lowShare)} of the positions are unsure AI detections`);
  if (POS.when === 'inpos' || POS.when === 'outpos') warn.push('possession is itself an estimate from ball tracking');
  if (c.viewAvg != null && c.viewAvg < 0.6) warn.push(`the camera showed on average only ${pctTxt(c.viewAvg)} of the pitch – players outside the picture are missing`);
  if (c.shapeFrames && c.edgeShare > 0.3) warn.push(`in ${pctTxt(c.edgeShare)} of the team-shape moments players were at the edge of the picture, so width and length are probably underestimated`);
  const a = sh.avg;
  const rows = mv.map(o => `<tr><td>${esc(keyLabel(o.key))}${o.gk ? ' <small>(GK)</small>' : ''}</td><td>${f0(o.time)} s <small>(${pctTxt(o.cover)})</small></td><td>${f0(o.dist)}</td><td>${f0(o.perMin)}</td><td>${f1(o.maxV * 3.6)}</td><td>${f0(o.hi)}</td><td>${o.sprints}</td><td>${qualityBadge(o.quality)}</td></tr>`).join('');
  const heatSel = POS.heat;
  const heatSamples = []; sh.S.frames.forEach(f => f.pts.forEach(p => { if (heatSel === 'team' || p.key === heatSel) heatSamples.push(p); }));
  el.innerHTML = controls + `
    <div class="exportbox ${warn.length ? 'warnbox' : ''}"><b>Data behind these figures</b> · ${fmtTime(span[0])}–${fmtTime(span[1])} · ${f0(c.considered * sh.S.step)} s selected${c.skipped ? ` (${f0(c.skipped * sh.S.step)} s of close-ups, replays and other shots left out)` : ''}, ${pctTxt(calPct)} calibrated ·
      ${c.carried ? `(${pctTxt(c.carried / Math.max(1, c.calibrated))} of it by calibrations following the camera, ±${f1(c.carriedErr)} m) ` : ''}·
      ${c.viewAvg != null ? `on average ${pctTxt(c.viewAvg)} of the pitch in the picture · ` : ''}on average ${f1(c.avgPlayers)} ${esc(teamName(team))} players located · ${pctTxt(c.interpShare)} estimated between points · ${pctTxt(c.lowShare)} unsure AI
      ${warn.length ? `<div class="warn small">⚠ ${warn.join('; ')}.</div>` : ''}<div class="small muted">Video-derived estimates, not GPS. Team shape uses outfield players only.</div></div>
    <h4>Team shape ${c.shapeFrames ? `<small class="muted">(${c.shapeFrames} moments, ${f1(a.n)} outfield players on average)</small>` : ''}</h4>
    ${c.shapeFrames ? `<div style="overflow:auto"><table class="sum"><tr><th>Width</th><th>Length</th><th>Defensive line</th><th>Def → mid line</th><th>Mid → att line</th><th>Area (compactness)</th><th>Avg distance to centre</th></tr>
      <tr><td>${f0(a.width)} m</td><td>${f0(a.length)} m</td><td>${f0(a.defLine)} m from own goal</td><td>${f0(a.gapDM)} m</td><td>${f0(a.gapMA)} m</td><td>${f0(a.area)} m²</td><td>${f1(a.spread)} m</td></tr></table></div>
      ${seriesSVG(sh.shapes, [['width', 'width', '#3ea6ff'], ['length', 'length', '#2ecc71'], ['defLine', 'def. line', '#ffd23b']])}` : '<p class="small muted">Not enough players located at the same time (7+ outfield players needed).</p>'}
    <div class="grid2">
      <div><h4>Average positions</h4>${shapeSVG(sh, team)}<div class="small muted">Shaded: outline of the outfield players. Faded dots: less than 5 s of data; orange ring: many unsure AI points.</div></div>
      <div><h4>Heat map <select id="psHeat" class="small"><option value="team">whole team</option>${sh.avgPos.map(p => `<option value="${esc(p.key)}" ${heatSel === p.key ? 'selected' : ''}>${esc(keyLabel(p.key))}</option>`).join('')}</select></h4>${heatSVG(heatSamples, teamColor(team))}<div class="small muted">Weighted by confidence: unsure AI and estimated positions count less.</div></div>
    </div>
    <h4>Distance and speed <small class="muted">(video-derived estimates)</small></h4>
    ${mv.length ? `<div style="overflow:auto"><table class="sum"><tr><th>Player</th><th>Tracked</th><th>Distance m</th><th>m/min</th><th>Max km/h</th><th>High-intensity m</th><th>Sprints</th><th>Quality</th></tr>${rows}</table></div>
      <div class="small muted">Only clicked or detected positions are used (no straight-line estimates), smoothed over 1 s and measured every 0.4 s; impossible jumps (&gt; ${SPEED.glitch} m/s) are dropped. High intensity ≥ ${(SPEED.hi * 3.6).toFixed(1)} km/h, sprint ≥ ${(SPEED.sprint * 3.6).toFixed(1)} km/h for 1 s+. Quality: share of the selected time tracked, unsure AI points and calibration error.</div>` : '<p class="small muted">No calibrated movement data.</p>'}
    <h4>Ball</h4>
    ${bi ? `<div class="grid2"><div>${ballPathSVG(bi)}</div><div class="small">
      <p>Ball located in ${bi.n ? pctTxt(bi.ok.length / bi.n) : '0%'} of the selected time.</p>
      ${bi.ok.length ? `<p>Where the ball was (seen from ${esc(teamName(team))}):</p><table class="sum"><tr><th>Own third</th><th>Middle third</th><th>Final third</th></tr><tr><td>${bi.thirds[0]}%</td><td>${bi.thirds[1]}%</td><td>${bi.thirds[2]}%</td></tr></table>` : ''}
      ${typeof possession === 'function' && possession() && possession().pctHome != null ? `<p>Possession estimate: ${esc(teamName('Home'))} ${possession().pctHome}% · ${esc(teamName('Away'))} ${possession().pctAway}%</p>` : ''}</div></div>` : '<p class="small muted">No ball tracking yet.</p>'}`;
  wirePos(el);
}
function wirePos(el) {
  const on = (id, fn) => { const x = el.querySelector(id); if (x) x.onchange = e => { fn(e.target.value); renderPositions(); }; };
  on('#psTeam', v => { POS.team = v; POS.heat = 'team'; }); on('#psWhen', v => { POS.when = v; }); on('#psCode', v => { POS.code = v; });
  on('#psRange', v => { POS.range = v; }); on('#psDir', v => { POS.dir = v; }); on('#psHeat', v => { POS.heat = v; });
  const c = el.querySelector('#psCsv'); if (c) c.onclick = exportPositionalCsv;
}
HOOKS.render.push(tab => { if (tab === 'pos' || (!tab && $('#tab-pos') && !$('#tab-pos').classList.contains('hidden'))) renderPositions(); });

/* ---------------------------------------------------------------- export & report */
function exportPositionalCsv() {
  const lines = [['team', 'player', 'tracked_s', 'share_of_selected_time', 'distance_m', 'm_per_min', 'max_kmh', 'high_intensity_m', 'sprints', 'unsure_ai_share', 'quality', 'avg_x_m', 'avg_y_m']];
  const shapeLines = [['team', 'moments', 'avg_outfield_players', 'width_m', 'length_m', 'def_line_m', 'def_mid_m', 'mid_att_m', 'area_m2', 'spread_m', 'calibrated_share']];
  ['Home', 'Away'].forEach(team => {
    if (!teamTracks(team).length) return;
    const sh = teamShape(team), mv = teamMovement(team); if (!sh) return;
    const ap = new Map(sh.avgPos.map(p => [p.key, p]));
    mv.forEach(o => { const p = ap.get(o.key); lines.push([teamName(team), keyLabel(o.key), o.time.toFixed(1), o.cover.toFixed(2), o.dist.toFixed(0), o.perMin.toFixed(0), (o.maxV * 3.6).toFixed(1), o.hi.toFixed(0), o.sprints, o.low.toFixed(2), o.quality, p ? p.x.toFixed(1) : '', p ? p.y.toFixed(1) : '']); });
    const a = sh.avg, c = sh.cover;
    shapeLines.push([teamName(team), c.shapeFrames, f1(a.n), f1(a.width), f1(a.length), f1(a.defLine), f1(a.gapDM), f1(a.gapMA), f0(a.area), f1(a.spread), c.considered ? (c.calibrated / c.considered).toFixed(2) : '0']);
  });
  const csv = lines.concat([[]], shapeLines).map(r => r.map(v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v).join(',')).join('\n');
  api.saveFile({ defaultName: 'positional analysis.csv', filters: [{ name: 'CSV', extensions: ['csv'] }], data: '﻿' + csv }).then(p => { if (p) toast('Positional CSV saved', 'ok'); });
}
function hasPositionalData() { return TR.tracks.some(tk => tk.kind === 'player' && tk.points.length) && TR.cals.some(c => c.type !== 'none'); }
// extra pages for the PDF match report
function positionalReportHTML() {
  if (!hasPositionalData()) return '';
  const keep = Object.assign({}, POS); POS.when = 'all'; POS.range = 'all';
  let html = '<h2 class="pb">Positional analysis (from tracking)</h2>';
  ['Home', 'Away'].forEach(team => {
    if (!teamTracks(team).length) return;
    POS.team = team;
    const sh = teamShape(team), mv = teamMovement(team); if (!sh) return;
    const a = sh.avg, c = sh.cover;
    html += `<h3 style="margin:10px 0 4px">${esc(teamName(team))}</h3>
      <p><small>${f0(c.considered * sh.S.step)} s of tracking, ${pctTxt(c.considered ? c.calibrated / c.considered : 0)} calibrated, ${c.viewAvg != null ? pctTxt(c.viewAvg) + ' of the pitch in the picture on average, ' : ''}${f1(c.avgPlayers)} players located on average, ${pctTxt(c.lowShare)} unsure AI positions. Video-derived estimates, not GPS.</small></p>
      ${(c.viewAvg != null && c.viewAvg < 0.6) || (c.shapeFrames && c.edgeShare > 0.3) ? `<p><small><b>Limitation:</b> the camera did not show the whole pitch${c.viewAvg != null ? ` (on average ${pctTxt(c.viewAvg)} of it)` : ''}. Players outside the picture are not included${c.shapeFrames ? `; in ${pctTxt(c.edgeShare)} of the team-shape moments players were at the edge of the picture, so width and length are probably underestimated` : ''}.</small></p>` : ''}
      ${c.shapeFrames ? `<table><tr><th>Width</th><th>Length</th><th>Def. line</th><th>Def→mid</th><th>Mid→att</th><th>Area</th></tr><tr><td>${f0(a.width)} m</td><td>${f0(a.length)} m</td><td>${f0(a.defLine)} m</td><td>${f0(a.gapDM)} m</td><td>${f0(a.gapMA)} m</td><td>${f0(a.area)} m²</td></tr></table>` : '<p><small>Team shape: not enough players located at once.</small></p>'}
      <div class="grid" style="margin-top:8px"><div class="card"><h3>Average positions</h3>${shapeSVG(sh, team)}</div>
      <div class="card"><h3>Heat map (team)</h3>${heatSVG(sh.S.frames.flatMap(f => f.pts), teamColor(team))}</div></div>
      ${mv.length ? `<table style="margin-top:8px"><tr><th>Player</th><th>Tracked</th><th>Distance m</th><th>m/min</th><th>Max km/h</th><th>HI m</th><th>Sprints</th><th>Quality</th></tr>
        ${mv.map(o => `<tr><td>${esc(keyLabel(o.key))}</td><td>${f0(o.time)} s</td><td>${f0(o.dist)}</td><td>${f0(o.perMin)}</td><td>${f1(o.maxV * 3.6)}</td><td>${f0(o.hi)}</td><td>${o.sprints}</td><td>${o.quality}</td></tr>`).join('')}</table>` : ''}`;
  });
  if (TR.shots && TR.shots.length && typeof shotSummary === 'function') { const s = shotSummary(); html += `<p><small><b>Camera:</b> ${pctTxt(s.trackable)} of the video is wide or medium shots (used for positions); ${pctTxt(1 - s.trackable)} is close-ups, replays and other shots, which are left out. ${s.cuts} camera cuts.</small></p>`; }
  const pos = typeof possession === 'function' ? possession() : null;
  if (pos && pos.pctHome != null) html += `<p><b>Possession estimate (ball tracking):</b> ${esc(teamName('Home'))} ${pos.pctHome}% · ${esc(teamName('Away'))} ${pos.pctAway}% <small>(${Math.round(pos.Home + pos.Away)} s with a known owner)</small></p>`;
  Object.assign(POS, keep);
  return html;
}
