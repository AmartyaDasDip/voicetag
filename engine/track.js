// TACTIQ ANALYST – AI engine: multi-object tracker (ByteTrack-style, with simple camera-pan compensation)
'use strict';
const { iou } = require('./detect');

function colourDist(a, b) { if (!a || !b) return 0; return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

class Tracker {
  constructor(opts = {}) {
    this.high = opts.high || 0.45;      // confident detections start / continue tracks
    this.low = opts.low || 0.2;         // weak detections can only continue tracks
    this.maxAge = opts.maxAge || 30;    // frames a lost track is kept (analysed frames)
    this.minHits = opts.minHits || 3;
    this.colourGate = opts.colourGate || 95;
    this.tracks = []; this.nextId = 1; this.finished = [];
  }
  predict() {
    for (const t of this.tracks) {
      t.box = [t.box[0] + t.v[0], t.box[1] + t.v[1], t.box[2], t.box[3]];
      t.age++;
    }
  }
  // global camera pan: median offset between predicted tracks and nearest detections
  compensate(dets) {
    const live = this.tracks.filter(t => t.age === 1 && t.hits >= 2);
    if (live.length < 3 || !dets.length) return [0, 0];
    const dx = [], dy = [];
    for (const t of live) {
      const cx = t.box[0] + t.box[2] / 2, cy = t.box[1] + t.box[3] / 2;
      let best = null, bd = 1e9;
      for (const d of dets) { const ex = d.box[0] + d.box[2] / 2 - cx, ey = d.box[1] + d.box[3] / 2 - cy, dist = Math.hypot(ex, ey); if (dist < bd) { bd = dist; best = [ex, ey]; } }
      if (best && bd < Math.max(40, t.box[3] * 1.5)) { dx.push(best[0]); dy.push(best[1]); }
    }
    if (dx.length < 3) return [0, 0];
    const med = a => a.slice().sort((p, q) => p - q)[a.length >> 1];
    const sx = med(dx), sy = med(dy);
    for (const t of this.tracks) t.box = [t.box[0] + sx, t.box[1] + sy, t.box[2], t.box[3]];
    return [sx, sy];
  }
  associate(tracks, dets, minIou) {
    const pairs = [];
    for (let i = 0; i < tracks.length; i++) for (let j = 0; j < dets.length; j++) {
      const a = tracks[i].box, b = dets[j].box;
      // enlarge boxes a little: players are small and move between analysed frames
      const ea = [a[0] - a[2] * 0.25, a[1] - a[3] * 0.1, a[2] * 1.5, a[3] * 1.2], eb = [b[0] - b[2] * 0.25, b[1] - b[3] * 0.1, b[2] * 1.5, b[3] * 1.2];
      const s = iou(ea, eb);
      if (s < minIou) continue;
      if (colourDist(tracks[i].colour, dets[j].colour) > this.colourGate) continue;   // don't swap red and white players
      pairs.push([s, i, j]);
    }
    pairs.sort((p, q) => q[0] - p[0]);
    const ut = new Set(), ud = new Set(), matches = [];
    for (const [, i, j] of pairs) { if (ut.has(i) || ud.has(j)) continue; ut.add(i); ud.add(j); matches.push([i, j]); }
    return { matches, unT: tracks.map((_, i) => i).filter(i => !ut.has(i)), unD: dets.map((_, j) => j).filter(j => !ud.has(j)) };
  }
  update(dets, frame) {
    this.predict();
    this.compensate(dets.filter(d => d.conf >= this.high));
    const high = dets.filter(d => d.conf >= this.high), low = dets.filter(d => d.conf < this.high && d.conf >= this.low);
    const r1 = this.associate(this.tracks, high, 0.1);
    const apply = (t, d) => {
      const ncx = d.box[0] + d.box[2] / 2, ncy = d.box[1] + d.box[3] / 2, gap = Math.max(1, t.age);
      const vm = [(ncx - t.last[0]) / gap, (ncy - t.last[1]) / gap];
      t.v = [t.v[0] * 0.6 + vm[0] * 0.4, t.v[1] * 0.6 + vm[1] * 0.4]; t.last = [ncx, ncy];
      t.box = d.box.slice(); t.age = 0; t.hits++;
      if (d.colour) t.colour = t.colour ? t.colour.map((c, k) => c * 0.85 + d.colour[k] * 0.15) : d.colour.slice();
      t.points.push({ frame, box: d.box.slice(), conf: d.conf, colour: d.colour });
    };
    r1.matches.forEach(([i, j]) => apply(this.tracks[i], high[j]));
    const rest = r1.unT.map(i => this.tracks[i]);
    const r2 = this.associate(rest, low, 0.15);
    r2.matches.forEach(([i, j]) => apply(rest[i], low[j]));
    // new tracks from unmatched confident detections
    r1.unD.forEach(j => { const d = high[j]; this.tracks.push({ id: this.nextId++, box: d.box.slice(), v: [0, 0], last: [d.box[0] + d.box[2] / 2, d.box[1] + d.box[3] / 2], age: 0, hits: 1, colour: d.colour ? d.colour.slice() : null, points: [{ frame, box: d.box.slice(), conf: d.conf, colour: d.colour }] }); });
    // retire lost tracks
    const keep = [];
    for (const t of this.tracks) { if (t.age > this.maxAge) this.finished.push(t); else keep.push(t); }
    this.tracks = keep;
  }
  // camera cut: nobody can be followed across it – every live track ends here (and is marked as interrupted)
  interrupt() { for (const t of this.tracks) { t.cutAfter = true; this.finished.push(t); } this.tracks = []; }
  all() { return this.finished.concat(this.tracks).filter(t => t.hits >= this.minHits); }
}

/* Two-team colour clustering (k-means, k=2) over track colours; outliers = referees / keepers / staff */
// Find the two kits. k-means with up to 4 groups (two teams + referees/keepers/staff), weighted by how long
// each track lasted; the two heaviest groups are the teams, everything far from them is "other".
function teamClusters(tracks) {
  const items = tracks.filter(t => t.colour && t.points.length >= 5).map(t => ({ c: t.colour, w: t.points.length }));
  if (items.length < 4) return null;
  const K = Math.min(4, items.length);
  const c = [items.reduce((a, b) => (b.w > a.w ? b : a)).c];
  while (c.length < K) c.push(items.reduce((a, b) => (Math.min(...c.map(x => colourDist(b.c, x))) > Math.min(...c.map(x => colourDist(a.c, x))) ? b : a)).c);
  let lab = [];
  for (let it = 0; it < 25; it++) {
    lab = items.map(x => c.reduce((bi, y, j) => (colourDist(x.c, y) < colourDist(x.c, c[bi]) ? j : bi), 0));
    for (let j = 0; j < K; j++) {
      let sw = 0; const m = [0, 0, 0];
      items.forEach((x, i) => { if (lab[i] === j) { sw += x.w; m[0] += x.c[0] * x.w; m[1] += x.c[1] * x.w; m[2] += x.c[2] * x.w; } });
      if (sw) c[j] = m.map(v => v / sw);
    }
  }
  const weight = c.map((_, j) => items.reduce((s, x, i) => s + (lab[i] === j ? x.w : 0), 0));
  const order = c.map((_, j) => j).sort((a, b) => weight[b] - weight[a]).slice(0, 2);
  let centres = order.map(j => c[j]);
  // keep a stable order: lighter kit first
  if (centres[1] && centres[1][0] + centres[1][1] + centres[1][2] > centres[0][0] + centres[0][1] + centres[0][2]) centres = [centres[1], centres[0]];
  const cuts = centres.map(cc => {
    const d = items.filter(x => colourDist(x.c, cc) === Math.min(...centres.map(y => colourDist(x.c, y)))).map(x => colourDist(x.c, cc)).sort((a, b) => a - b);
    return Math.max(40, Math.min(90, (d[Math.floor(d.length * 0.7)] || 0) * 1.8));
  });
  return { centres, cut: Math.max(...cuts), cuts };
}
function assignTeam(colour, cl) {
  if (!cl || !colour) return { team: null, dist: null };
  const d0 = colourDist(colour, cl.centres[0]), d1 = colourDist(colour, cl.centres[1]);
  const k = d0 <= d1 ? 0 : 1, d = Math.min(d0, d1);
  if (d > (cl.cuts ? cl.cuts[k] : cl.cut)) return { team: 'other', dist: d };
  return { team: k ? 'B' : 'A', dist: d };
}

module.exports = { Tracker, teamClusters, assignTeam, colourDist };
