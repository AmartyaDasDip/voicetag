// TACTIQ ANALYST – AI engine worker. Runs in a background process (Electron utilityProcess) or from the command line:
//   node engine/worker.js <video> <out.json> [start] [duration] [model] [stride]
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const { IN_W, IN_H, frameReader, toTensor, decode, grassAround, shirtColour, resample, greyThumb, cameraShift, TW, TH } = require('./detect');
const { Tracker, teamClusters, assignTeam } = require('./track');

let cancelled = false;

async function createSession(ort, model, prefer) {
  const tries = prefer === 'cpu' ? [['cpu']] : process.platform === 'win32' ? [['dml'], ['cpu']] : [['cpu']];
  let lastErr = null;
  for (const providers of tries) {
    try {
      const so = { executionProviders: providers, graphOptimizationLevel: 'all', intraOpNumThreads: Math.max(1, os.cpus().length - 1) };
      if (providers[0] === 'dml') Object.assign(so, { enableMemPattern: false, executionMode: 'sequential' });   // DirectML requirements
      const s = await ort.InferenceSession.create(model, so);
      return { session: s, provider: providers[0] };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// Ball (experimental): pick one consistent path through the per-frame candidates (Viterbi).
// Rewards confidence and being near a player; punishes impossible jumps and objects that sit still in the
// image for a long time (spare balls by the touchline, logos).
// Where the play is: the player with most team-mates within ~12% of the frame width; centre of that group.
function playCentre(feet) {
  if (!feet.length) return null;
  let best = null, bn = -1;
  for (const p of feet) { const near = feet.filter(q => Math.hypot(q[0] - p[0], (q[1] - p[1]) * 0.56) < 0.12); if (near.length > bn) { bn = near.length; best = near; } }
  return [best.reduce((s, q) => s + q[0], 0) / best.length, best.reduce((s, q) => s + q[1], 0) / best.length - 0.02];
}

function ballPath(frames, stride, fps) {
  if (!frames.length) return [];
  // "world" position = image position minus the camera pan; an object that stays put in the world for a long
  // time while no player is near it is a spare ball / logo, not the match ball
  const nearOf = (f, c) => { let near = Infinity; for (const p of f.feet) near = Math.min(near, Math.hypot(p[0] - c.x, (p[1] - c.y) * 0.56)); return near; };
  frames.forEach(f => f.cands.forEach(c => { c.wx = c.x - (f.cam ? f.cam[0] : 0); c.wy = c.y - (f.cam ? f.cam[1] : 0); c.near = nearOf(f, c); }));
  const longFrames = Math.max(6, Math.round(2 * (fps || 25) / stride)), win = longFrames * 3;
  frames.forEach((f, i) => f.cands.forEach(c => {
    let n = 0, lonely = 0;
    for (let j = Math.max(0, i - win); j < Math.min(frames.length, i + win + 1); j++)
      for (const q of frames[j].cands) if (Math.hypot(q.wx - c.wx, (q.wy - c.wy) * 0.56) < 0.012) { n++; if (q.near > 0.07) lonely++; }
    c.still = n >= longFrames && lonely >= n * 0.7;
  }));
  // carry the "still object" flag to the same object in neighbouring frames (camera estimate can jump on fast swings)
  const spread = (from, to) => { for (const c of frames[to].cands) if (!c.still && c.near > 0.07 && frames[from].cands.some(q => q.still && Math.hypot(q.x - c.x, (q.y - c.y) * 0.56) < 0.015)) c.still = true; };
  for (let i = 1; i < frames.length; i++) spread(i - 1, i);
  for (let i = frames.length - 2; i >= 0; i--) spread(i + 1, i);
  const unary = (f, c) => c.conf + (c.near < 0.06 ? 0.25 : c.near < 0.15 ? 0.1 : -0.1) - (c.still ? 1 : 0);
  const NONE = 0.2, maxStep = 0.03 * stride;
  let prev = [{ s: 0, back: -1, c: null }];
  const hist = [];
  for (const f of frames) {
    const states = [null, ...f.cands];
    const cur = states.map(c => {
      const u = c ? unary(f, c) : NONE;
      let best = -Infinity, bi = 0;
      prev.forEach((p, i) => {
        let tr = 0;
        if (c && p.c) { const d = Math.hypot(c.x - p.c.x, (c.y - p.c.y) * 0.56); tr = d > maxStep ? -Math.min(1.5, (d - maxStep) * 8) : 0.05; }
        if (p.s + tr > best) { best = p.s + tr; bi = i; }
      });
      return { s: best + u, back: bi, c };
    });
    hist.push(cur); prev = cur;
  }
  let i = prev.reduce((bi, p, j) => p.s > prev[bi].s ? j : bi, 0);
  const out = [];
  for (let n = hist.length - 1; n >= 0; n--) { const st = hist[n][i]; if (st.c && unary(frames[n], st.c) > NONE) out.push({ k: frames[n].k, x: st.c.x, y: st.c.y, conf: st.c.conf, z: st.c.z }); i = st.back; }
  return out.reverse();
}

async function analyse(o, progress) {
  const ort = require('onnxruntime-node');
  const fps = o.fps || 25, stride = Math.max(1, o.stride || 1);
  const scale = Math.min(IN_W / o.srcW, IN_H / o.srcH);
  const w = Math.round(o.srcW * scale / 2) * 2, h = Math.round(o.srcH * scale / 2) * 2;
  let { session, provider } = await createSession(ort, o.model, o.prefer);
  const total = Math.max(1, Math.floor((o.duration || 1) * fps / stride));
  const ballMode = o.ball || 'normal';                       // off | normal | zoom
  // zoom mode reads sharper frames (up to 1920 wide) so the ball pass can look closer
  let rw = w, rh = h;
  if (ballMode === 'zoom' && o.srcW > w * 1.05) { rw = Math.min(o.srcW, 1920) & ~1; rh = Math.round(rw * o.srcH / o.srcW / 2) * 2; }
  const native = rw !== w;
  const reader = frameReader({ ffmpeg: o.ffmpeg, video: o.video, start: o.start || 0, duration: o.duration, stride, w: rw, h: rh });
  const small = native ? Buffer.alloc(w * h * 3) : null;
  const ZOOM = 2.2, zcw = w / ZOOM, zch = h / ZOOM;            // ball-pass window in analysis pixels
  const zow = IN_W, zoh = Math.min(IN_H, Math.round(IN_W * zch / zcw));
  const zTensor = ballMode === 'zoom' ? new Float32Array(3 * IN_W * IN_H) : null;
  let est = null, zoomHits = 0, zoomOnly = 0, refThumb = null, refCam = [0, 0], camX = 0, camY = 0, prevThumb = null, camSeg = 0, cuts = 0, lastStep = [0, 0];
  const cutFrames = [];
  const tracker = new Tracker({ maxAge: Math.round(30 / stride), minHits: 3 });
  const tensorData = new Float32Array(3 * IN_W * IN_H);
  const ballFrames = [], camera = [];
  let k = 0, t0 = Date.now(), dets = 0;
  try {
    for (;;) {
      if (cancelled) throw new Error('cancelled');
      const big = await reader.next();
      if (!big) break;
      const frame = native ? resample(big, rw, rh, 0, 0, rw, rh, w, h, small, false) : big;
      toTensor(frame, w, h, tensorData);
      // camera position (cumulative pan) so the ball path can tell a still object from a moving camera
      const thumb = greyThumb(frame, w, h);   // always: the app uses the camera movement to carry calibrations
      if (thumb) {
        // a camera cut (the picture no longer matches the previous frame) starts a new camera segment
        // (similar wide shots can match fairly well, but the picture then 'jumps' – a pan never does that)
        if (prevThumb) {
          const cs = cameraShift(prevThumb, thumb), jump = Math.abs(cs[0] - lastStep[0]) + Math.abs(cs[1] - lastStep[1]);
          if (cs[2] > 12 || (cs[2] > 6 && jump > 8)) { camSeg++; cuts++; cutFrames.push(k); refThumb = null; refCam = [0, 0]; lastStep = [0, 0]; tracker.interrupt(); }
          else lastStep = [cs[0], cs[1]];
        }
        prevThumb = thumb;
        // measured against a reference frame (not the previous one) so small pans do not get lost in rounding
        const sh = cameraShift(refThumb, thumb);
        camX = refCam[0] + sh[0] / TW; camY = refCam[1] + sh[1] / TH;
        if (!refThumb || Math.abs(sh[0]) > 14 || Math.abs(sh[1]) > 7 || sh[2] > 18) { refThumb = thumb; refCam = [camX, camY]; }
      }
      const feeds = () => ({ [session.inputNames[0]]: new ort.Tensor('float32', tensorData, [1, 3, IN_H, IN_W]) });
      let out;
      try { out = await session.run(feeds()); }
      catch (err) {
        if (provider === 'cpu' || k > 0) throw err;
        ({ session, provider } = await createSession(ort, o.model, 'cpu'));   // graphics card failed: fall back to the processor
        out = await session.run(feeds());
      }
      const o0 = out[session.outputNames[0]];
      const res = decode(o0, o0.dims[2], { personConf: o.personConf || 0.2, ballConf: o.ballConf || 0.12 });
      const people = res.people.filter(d => d.box[3] >= 8 && d.box[3] < h * 0.5 && d.box[1] + d.box[3] <= h + 2 && grassAround(frame, w, h, d.box) >= 0.3);
      people.forEach(d => { d.colour = shirtColour(frame, w, h, d.box); });
      dets += people.length;
      tracker.update(people, k);
      const okBall = b => b.box[2] < 30 && b.box[3] < 30 && b.box[2] > 1.2 && grassAround(frame, w, h, [b.box[0], b.box[1] - 4, b.box[2], b.box[3] + 4]) >= 0.25;
      let cands = ballMode === 'off' ? [] : res.balls.filter(okBall).slice(0, 4)
        .map(b => ({ x: (b.box[0] + b.box[2] / 2) / w, y: (b.box[1] + b.box[3] / 2) / h, conf: b.conf, z: 0 }));
      const feet = people.map(d => [(d.box[0] + d.box[2] / 2) / w, (d.box[1] + d.box[3]) / h]);
      if (ballMode === 'zoom') {
        // second look, zoomed in where the ball should be (predicted) or where most players are
        const pred = est && k - est.k <= Math.ceil(12 / stride) ? [est.x + est.vx * (k - est.k), est.y + est.vy * (k - est.k)] : playCentre(feet);
        if (pred) {
          const zx = Math.max(0, Math.min(w - zcw, pred[0] * w - zcw / 2)), zy = Math.max(0, Math.min(h - zch, pred[1] * h - zch / 2));
          const sc = rw / w;
          resample(big, rw, rh, zx * sc, zy * sc, zcw * sc, zch * sc, zow, zoh, zTensor, true);
          const zo = (await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', zTensor, [1, 3, IN_H, IN_W]) }))[session.outputNames[0]];
          const zr = decode(zo, zo.dims[2], { personConf: 2, ballConf: 0.08 });
          const f = zcw / zow;
          zr.balls.map(b => ({ box: [zx + b.box[0] * f, zy + b.box[1] * f, b.box[2] * f, b.box[3] * f], conf: b.conf })).filter(okBall).slice(0, 4).forEach(b => {
            const c = { x: (b.box[0] + b.box[2] / 2) / w, y: (b.box[1] + b.box[3] / 2) / h, conf: b.conf, z: 1 };
            zoomHits++;
            const dup = cands.find(q => Math.hypot(q.x - c.x, (q.y - c.y) * 0.56) < 0.008);
            if (dup) { dup.conf = Math.min(1, Math.max(dup.conf, c.conf) + 0.05); dup.z = 2; } else { cands.push(c); zoomOnly++; }
          });
        }
      }
      cands = cands.sort((a, b) => b.conf - a.conf).slice(0, 6);
      // simple online estimate of where the ball is going (only used to aim the zoom)
      if (ballMode === 'zoom') {
        let pick = null;
        if (est && k - est.k <= Math.ceil(12 / stride)) {
          const px = est.x + est.vx * (k - est.k), py = est.y + est.vy * (k - est.k);
          pick = cands.filter(c => Math.hypot(c.x - px, (c.y - py) * 0.56) < 0.06 * Math.max(1, (k - est.k) * 0.6)).sort((a, b) => b.conf - a.conf)[0];
        }
        if (!pick) pick = cands.find(c => c.conf >= 0.3);
        if (pick) {
          const dk = est ? Math.max(1, k - est.k) : 1;
          const vx = est ? (pick.x - est.x) / dk : 0, vy = est ? (pick.y - est.y) / dk : 0;
          est = { x: pick.x, y: pick.y, vx: est ? est.vx * 0.5 + vx * 0.5 : 0, vy: est ? est.vy * 0.5 + vy * 0.5 : 0, k };
        }
      }
      ballFrames.push({ k, cands, feet, cam: [camX, camY] });
      camera.push([camX, camY, camSeg]);
      k++;
      if (progress && (k % 3 === 0 || k === 1)) { const el = (Date.now() - t0) / 1000; progress({ done: k, total, speed: k / el, eta: (total - k) / (k / el) }); }
    }
  } finally { reader.kill(); }
  if (!k) throw new Error('No frames could be read from the video. ' + reader.error().slice(-300));
  const raw = tracker.all();
  const cl = teamClusters(raw);
  // real frame times when ffmpeg reported them (variable frame rate safe), otherwise frame count / fps
  const tOf = f => Math.round(((o.start || 0) + (reader.times.length > f ? reader.times[f] : f * stride / fps)) * 1000) / 1000;
  const tracks = raw.map(t => {
    const team = assignTeam(t.colour, cl);
    const f0 = t.points[0].frame;
    return { id: t.id, team: team.team, colour: t.colour ? t.colour.map(Math.round) : null,
      interrupted: !!t.cutAfter, afterCut: cutFrames.some(c => f0 >= c && f0 - c <= Math.ceil(fps / stride)),
      points: t.points.map(p => ({ t: tOf(p.frame), x: Math.round((p.box[0] + p.box[2] / 2) / w * 10000) / 10000, y: Math.round((p.box[1] + p.box[3]) / h * 10000) / 10000,
        conf: Math.round(p.conf * 100) / 100, box: p.box.map((v, i) => Math.round(v / (i % 2 ? h : w) * 10000) / 10000) })) };
  }).filter(t => t.points.length >= 4);
  // the ball is judged against real players only (teams A/B), not stewards or camera operators by the touchline
  const playerFeet = new Map();
  raw.forEach(t => { if (assignTeam(t.colour, cl).team === 'other') return; t.points.forEach(p => { if (!playerFeet.has(p.frame)) playerFeet.set(p.frame, []); playerFeet.get(p.frame).push([(p.box[0] + p.box[2] / 2) / w, (p.box[1] + p.box[3]) / h]); }); });
  ballFrames.forEach(f => { f.feet = playerFeet.get(f.k) || []; });
  const balls = ballPath(ballFrames, stride, fps);
  if (process.env.BALLDEBUG) fs.writeFileSync(process.env.BALLDEBUG, JSON.stringify(ballFrames.map(f => ({ k: f.k, cam: f.cam, c: f.cands.map(c => [c.x, c.y, c.conf, c.wx, c.wy, c.near, c.still ? 1 : 0].map(v => Math.round(v * 1000) / 1000)) }))));
  const el = (Date.now() - t0) / 1000;
  return { ok: true, tracks, ball: balls.map(b => ({ t: tOf(b.k), x: Math.round(b.x * 10000) / 10000, y: Math.round(b.y * 10000) / 10000, conf: Math.round(b.conf * 100) / 100 })),
    // camera movement per analysed frame (picture content shift, in fractions of the frame), for carrying calibrations
    camera: camera.map((c, f) => [tOf(f), Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5, c[2]]),
    cameraCuts: cuts, cutTimes: cutFrames.map(tOf),
    clusters: cl ? cl.centres.map(c => c.map(Math.round)) : null,
    ballStats: { mode: ballMode, frames: k, found: balls.length, coverage: Math.round(balls.length / Math.max(1, k) * 1000) / 10, zoomHits, zoomOnly, fromZoom: balls.filter(b => b.z === 1).length, readSize: [rw, rh] },
    meta: { timing: reader.times.length >= k ? 'frame timestamps' : 'frame rate', model: path.basename(o.model), provider, frames: k, stride, fps, seconds: Math.round(el * 10) / 10, framesPerSecond: Math.round(k / el * 10) / 10, detections: dets, analysisSize: [w, h], start: o.start || 0, duration: o.duration } };
}

/* ---------------------------------------------------------------- SHOT SCAN (phase 0.8)
   One fast pass over the video at low resolution: camera cuts, camera movement per shot, and the type of every
   shot from a few looks with the detector – wide (many small players, lots of grass), medium, close-up (few big
   people) or other (crowd, bench, graphics). Close-ups and other shots cannot be used for 2D tracking. */
function shotType(sample) {
  const { n, medH, maxH, green } = sample;
  if (green < 0.18) return 'other';
  if (maxH >= 0.42 || (n >= 1 && medH >= 0.24)) return 'close';
  if (n >= 4 && medH < 0.13) return 'wide';
  if (n === 0) return green > 0.5 ? 'wide' : 'other';
  return 'medium';
}
async function scan(o, progress) {
  const ort = require('onnxruntime-node');
  const fps = o.fps || 25, stride = Math.max(1, o.stride || 2), every = Math.max(0.5, o.sampleEvery || 2);
  const w = 640, h = Math.round(640 * o.srcH / o.srcW / 2) * 2;
  let { session, provider } = await createSession(ort, o.model, o.prefer);
  const reader = frameReader({ ffmpeg: o.ffmpeg, video: o.video, start: o.start || 0, duration: o.duration, stride, w, h });
  const total = Math.max(1, Math.floor((o.duration || 1) * fps / stride));
  const tensor = new Float32Array(3 * IN_W * IN_H), up = IN_W / w, uh = Math.round(h * up);
  const camera = [], cutFrames = [0], samples = [];
  let k = 0, refThumb = null, refCam = [0, 0], prevThumb = null, lastStep = [0, 0], seg = 0, lastSample = -1e9, segStart = 0, t0 = Date.now();
  const tAt = f => (o.start || 0) + (reader.times.length > f ? reader.times[f] : f * stride / fps);
  try {
    for (;;) {
      if (cancelled) throw new Error('cancelled');
      const frame = await reader.next();
      if (!frame) break;
      const thumb = greyThumb(frame, w, h);
      if (prevThumb) {
        const cs = cameraShift(prevThumb, thumb), jump = Math.abs(cs[0] - lastStep[0]) + Math.abs(cs[1] - lastStep[1]);
        if (cs[2] > 12 || (cs[2] > 6 && jump > 8)) { seg++; cutFrames.push(k); refThumb = null; refCam = [0, 0]; lastStep = [0, 0]; segStart = k; }
        else lastStep = [cs[0], cs[1]];
      }
      prevThumb = thumb;
      const sh = cameraShift(refThumb, thumb);
      const cx = refCam[0] + sh[0] / TW, cy = refCam[1] + sh[1] / TH;
      if (!refThumb || Math.abs(sh[0]) > 14 || Math.abs(sh[1]) > 7 || sh[2] > 18) { refThumb = thumb; refCam = [cx, cy]; }
      camera.push([cx, cy, seg]);
      // look at the picture: just after a cut, then every `every` seconds
      const sinceCut = k - segStart, tk = k * stride / fps;
      if (sinceCut === 2 || tk - lastSample >= every) {
        lastSample = tk;
        resample(frame, w, h, 0, 0, w, h, IN_W, uh, tensor, true);
        const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, IN_H, IN_W]) });
        const o0 = out[session.outputNames[0]];
        const people = decode(o0, o0.dims[2], { personConf: 0.35, ballConf: 2 }).people;
        const hs = people.map(d => d.box[3] / uh).sort((a, b) => a - b);
        let g = 0, n = 0; for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) { const i = (y * w + x) * 3; n++; if (frame[i + 1] > 60 && frame[i + 1] > frame[i] * 1.08 && frame[i + 1] > frame[i + 2] * 1.05) g++; }
        const smp = { k, seg, n: hs.length, medH: hs.length ? hs[hs.length >> 1] : 0, maxH: hs.length ? hs[hs.length - 1] : 0, green: g / n };
        smp.type = shotType(smp); samples.push(smp);
      }
      k++;
      if (progress && (k % 15 === 0 || k === 1)) { const el = (Date.now() - t0) / 1000; progress({ done: k, total, speed: k / el, eta: (total - k) / (k / el) }); }
    }
  } finally { reader.kill(); }
  if (!k) throw new Error('No frames could be read from the video. ' + reader.error().slice(-300));
  cutFrames.push(k);
  const segments = [];
  for (let i = 0; i < cutFrames.length - 1; i++) {
    const a = cutFrames[i], b = cutFrames[i + 1], sm = samples.filter(x => x.seg === i);
    const votes = {}; sm.forEach(x => { votes[x.type] = (votes[x.type] || 0) + 1; });
    const type = Object.keys(votes).sort((p, q) => votes[q] - votes[p])[0] || 'other';
    segments.push({ seg: i, t0: Math.round(tAt(a) * 1000) / 1000, t1: Math.round((b < k ? tAt(b) : tAt(k - 1) + stride / fps) * 1000) / 1000, type,
      looks: sm.map(x => ({ t: Math.round(tAt(x.k) * 100) / 100, type: x.type, n: x.n, medH: Math.round(x.medH * 1000) / 1000, maxH: Math.round(x.maxH * 1000) / 1000, green: Math.round(x.green * 100) / 100 })) });
  }
  const el = (Date.now() - t0) / 1000;
  return { ok: true, kind: 'scan', segments,
    camera: camera.map((c, f) => [Math.round(tAt(f) * 1000) / 1000, Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5, c[2]]),
    meta: { frames: k, stride, fps, seconds: Math.round(el * 10) / 10, framesPerSecond: Math.round(k / el * 10) / 10, provider, start: o.start || 0, duration: o.duration, looks: samples.length } };
}

// Electron background process
if (process.parentPort) {
  process.parentPort.on('message', async e => {
    const m = e.data || {};
    if (m.cmd === 'cancel') { cancelled = true; return; }
    if (m.cmd === 'scan') {
      cancelled = false;
      try { const r = await scan(m.opts, p => process.parentPort.postMessage({ type: 'progress', ...p })); process.parentPort.postMessage({ type: 'result', result: r }); }
      catch (err) { process.parentPort.postMessage({ type: 'error', error: cancelled ? 'cancelled' : String(err && err.message || err) }); }
      return;
    }
    if (m.cmd === 'run') {
      cancelled = false;
      try { const r = await analyse(m.opts, p => process.parentPort.postMessage({ type: 'progress', ...p })); process.parentPort.postMessage({ type: 'result', result: r }); }
      catch (err) { process.parentPort.postMessage({ type: 'error', error: cancelled ? 'cancelled' : String(err && err.message || err) }); }
    }
  });
} else if (require.main === module) {
  // command line test
  const [video, out, start = '0', duration = '', model = path.join(__dirname, 'models', 'yolo11s.onnx'), stride = '1', ball = 'normal'] = process.argv.slice(2);
  const { execFileSync } = require('child_process');
  const ff = process.env.FFMPEG || 'ffmpeg';
  let info = '';
  try { execFileSync(ff, ['-hide_banner', '-i', video]); } catch (e) { info = String(e.stderr || ''); }
  const wh = /, (\d{2,5})x(\d{2,5})[ ,\[]/.exec(info), fpsm = /([\d.]+) fps/.exec(info), dm = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
  const dur = duration ? Number(duration) : (dm ? Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]) : 10);
  if (process.env.SCAN) {
    scan({ ffmpeg: ff, video, start: Number(start), duration: dur, srcW: Number(wh[1]), srcH: Number(wh[2]), fps: Number(fpsm[1]), model, stride: Number(stride) },
      p => process.stderr.write(`\r${p.done}/${p.total} frames  ${p.speed.toFixed(1)} f/s   `))
      .then(r => { fs.writeFileSync(out, JSON.stringify(r)); console.error('\n' + JSON.stringify(r.meta)); r.segments.forEach(sg => console.error(`${sg.t0.toFixed(2)}–${sg.t1.toFixed(2)} ${sg.type}  ` + sg.looks.map(l => `${l.type}(n${l.n} med${l.medH} max${l.maxH} g${l.green})`).join(' '))); })
      .catch(e => { console.error('FAILED', e); process.exit(1); });
  } else
  analyse({ ffmpeg: ff, video, start: Number(start), duration: dur, srcW: Number(wh[1]), srcH: Number(wh[2]), fps: Number(fpsm[1]), model, stride: Number(stride), ball },
    p => process.stderr.write(`\r${p.done}/${p.total} frames  ${p.speed.toFixed(1)} f/s  eta ${Math.round(p.eta)}s   `))
    .then(r => { fs.writeFileSync(out, JSON.stringify(r)); console.error('\n' + JSON.stringify(r.meta) + '\ntracks: ' + r.tracks.length + ' (A ' + r.tracks.filter(t => t.team === 'A').length + ', B ' + r.tracks.filter(t => t.team === 'B').length + ', other ' + r.tracks.filter(t => t.team === 'other').length + ') ball points: ' + r.ball.length + ' clusters ' + JSON.stringify(r.clusters) + '\nball ' + JSON.stringify(r.ballStats)); })
    .catch(e => { console.error('FAILED', e); process.exit(1); });
}

module.exports = { analyse, scan, shotType };
