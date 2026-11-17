// TACTIQ ANALYST – AI engine worker. Runs in a background process (Electron utilityProcess) or from the command line:
//   node engine/worker.js <video> <out.json> [start] [duration] [model] [stride]
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const { IN_W, IN_H, frameReader, toTensor, decode, grassAround, shirtColour } = require('./detect');
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
function ballPath(frames, stride) {
  if (!frames.length) return [];
  const cell = c => Math.round(c.x * 100) + ',' + Math.round(c.y * 100);
  const count = {};
  frames.forEach(f => { const seen = new Set(f.cands.map(cell)); seen.forEach(c => { count[c] = (count[c] || 0) + 1; }); });
  const staticLimit = Math.max(8, frames.length * 0.25);
  const unary = (f, c) => {
    let near = Infinity;
    for (const p of f.feet) near = Math.min(near, Math.hypot(p[0] - c.x, (p[1] - c.y) * 0.56));
    return c.conf + (near < 0.06 ? 0.25 : near < 0.15 ? 0.1 : -0.1) - (count[cell(c)] >= staticLimit ? 1 : 0);
  };
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
  for (let n = hist.length - 1; n >= 0; n--) { const st = hist[n][i]; if (st.c && unary(frames[n], st.c) > NONE) out.push({ k: frames[n].k, ...st.c }); i = st.back; }
  return out.reverse();
}

async function analyse(o, progress) {
  const ort = require('onnxruntime-node');
  const fps = o.fps || 25, stride = Math.max(1, o.stride || 1);
  const scale = Math.min(IN_W / o.srcW, IN_H / o.srcH);
  const w = Math.round(o.srcW * scale / 2) * 2, h = Math.round(o.srcH * scale / 2) * 2;
  let { session, provider } = await createSession(ort, o.model, o.prefer);
  const total = Math.max(1, Math.floor((o.duration || 1) * fps / stride));
  const reader = frameReader({ ffmpeg: o.ffmpeg, video: o.video, start: o.start || 0, duration: o.duration, stride, w, h });
  const tracker = new Tracker({ maxAge: Math.round(30 / stride), minHits: 3 });
  const tensorData = new Float32Array(3 * IN_W * IN_H);
  const ballFrames = [];
  let k = 0, t0 = Date.now(), dets = 0;
  try {
    for (;;) {
      if (cancelled) throw new Error('cancelled');
      const frame = await reader.next();
      if (!frame) break;
      toTensor(frame, w, h, tensorData);
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
      const cands = res.balls.filter(b => b.box[2] < 30 && b.box[3] < 30 && grassAround(frame, w, h, [b.box[0], b.box[1] - 4, b.box[2], b.box[3] + 4]) >= 0.25).slice(0, 4)
        .map(b => ({ x: (b.box[0] + b.box[2] / 2) / w, y: (b.box[1] + b.box[3] / 2) / h, conf: b.conf }));
      ballFrames.push({ k, cands, feet: people.map(d => [(d.box[0] + d.box[2] / 2) / w, (d.box[1] + d.box[3]) / h]) });
      k++;
      if (progress && (k % 3 === 0 || k === 1)) { const el = (Date.now() - t0) / 1000; progress({ done: k, total, speed: k / el, eta: (total - k) / (k / el) }); }
    }
  } finally { reader.kill(); }
  if (!k) throw new Error('No frames could be read from the video. ' + reader.error().slice(-300));
  const raw = tracker.all();
  const cl = teamClusters(raw);
  const tOf = f => Math.round(((o.start || 0) + f * stride / fps) * 1000) / 1000;
  const tracks = raw.map(t => {
    const team = assignTeam(t.colour, cl);
    return { id: t.id, team: team.team, colour: t.colour ? t.colour.map(Math.round) : null,
      points: t.points.map(p => ({ t: tOf(p.frame), x: Math.round((p.box[0] + p.box[2] / 2) / w * 10000) / 10000, y: Math.round((p.box[1] + p.box[3]) / h * 10000) / 10000,
        conf: Math.round(p.conf * 100) / 100, box: p.box.map((v, i) => Math.round(v / (i % 2 ? h : w) * 10000) / 10000) })) };
  }).filter(t => t.points.length >= 4);
  const balls = ballPath(ballFrames, stride);
  const el = (Date.now() - t0) / 1000;
  return { ok: true, tracks, ball: balls.map(b => ({ t: tOf(b.k), x: Math.round(b.x * 10000) / 10000, y: Math.round(b.y * 10000) / 10000, conf: Math.round(b.conf * 100) / 100 })),
    clusters: cl ? cl.centres.map(c => c.map(Math.round)) : null,
    meta: { model: path.basename(o.model), provider, frames: k, stride, fps, seconds: Math.round(el * 10) / 10, framesPerSecond: Math.round(k / el * 10) / 10, detections: dets, analysisSize: [w, h], start: o.start || 0, duration: o.duration } };
}

// Electron background process
if (process.parentPort) {
  process.parentPort.on('message', async e => {
    const m = e.data || {};
    if (m.cmd === 'cancel') { cancelled = true; return; }
    if (m.cmd === 'run') {
      cancelled = false;
      try { const r = await analyse(m.opts, p => process.parentPort.postMessage({ type: 'progress', ...p })); process.parentPort.postMessage({ type: 'result', result: r }); }
      catch (err) { process.parentPort.postMessage({ type: 'error', error: cancelled ? 'cancelled' : String(err && err.message || err) }); }
    }
  });
} else if (require.main === module) {
  // command line test
  const [video, out, start = '0', duration = '', model = path.join(__dirname, 'models', 'yolo11s.onnx'), stride = '1'] = process.argv.slice(2);
  const { execFileSync } = require('child_process');
  const ff = process.env.FFMPEG || 'ffmpeg';
  let info = '';
  try { execFileSync(ff, ['-hide_banner', '-i', video]); } catch (e) { info = String(e.stderr || ''); }
  const wh = /, (\d{2,5})x(\d{2,5})[ ,\[]/.exec(info), fpsm = /([\d.]+) fps/.exec(info), dm = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
  const dur = duration ? Number(duration) : (dm ? Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]) : 10);
  analyse({ ffmpeg: ff, video, start: Number(start), duration: dur, srcW: Number(wh[1]), srcH: Number(wh[2]), fps: Number(fpsm[1]), model, stride: Number(stride) },
    p => process.stderr.write(`\r${p.done}/${p.total} frames  ${p.speed.toFixed(1)} f/s  eta ${Math.round(p.eta)}s   `))
    .then(r => { fs.writeFileSync(out, JSON.stringify(r)); console.error('\n' + JSON.stringify(r.meta) + '\ntracks: ' + r.tracks.length + ' (A ' + r.tracks.filter(t => t.team === 'A').length + ', B ' + r.tracks.filter(t => t.team === 'B').length + ', other ' + r.tracks.filter(t => t.team === 'other').length + ') ball points: ' + r.ball.length + ' clusters ' + JSON.stringify(r.clusters)); })
    .catch(e => { console.error('FAILED', e); process.exit(1); });
}

module.exports = { analyse };
