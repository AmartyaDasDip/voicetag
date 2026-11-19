// TACTIQ ANALYST – AI engine: frame decoding (ffmpeg) + YOLO detection (ONNX Runtime)
'use strict';
const { spawn } = require('child_process');

const IN_W = 1280, IN_H = 736;   // model input (exported rectangular for 16:9 video)

/* Decode frames as raw RGB at analysis size. Yields {index, data(Buffer rgb24), w, h}. */
function frameReader({ ffmpeg, video, start, duration, stride, w, h }) {
  // showinfo reports each frame's real timestamp (videos often have a slightly variable frame rate)
  const vf = [`select='not(mod(n\\,${stride}))'`, 'showinfo', `scale=${w}:${h}:flags=bilinear`].join(',');
  const args = ['-hide_banner', '-loglevel', 'info', '-ss', String(start), '-i', video];
  if (duration) args.push('-t', String(duration));
  args.push('-vf', vf, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1');
  const proc = spawn(ffmpeg, args, { windowsHide: true });
  const size = w * h * 3;
  let buf = Buffer.alloc(0), ended = false, error = '', line = '';
  const queue = [], waiters = [], times = [];
  proc.stderr.on('data', d => {
    const lines = (line + d.toString()).split(/\r?\n/); line = lines.pop();
    for (const l of lines) {
      const m = /Parsed_showinfo.*\bpts_time:\s*(-?[\d.]+)/.exec(l);
      if (m) times.push(Number(m[1])); else if (!/Parsed_showinfo/.test(l)) error = (error + l + '\n').slice(-3000);
    }
  });
  proc.stdout.on('data', chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= size) { const f = buf.subarray(0, size); buf = buf.subarray(size); const item = Buffer.from(f); if (waiters.length) waiters.shift()(item); else queue.push(item); }
    if (queue.length > 6) proc.stdout.pause();
  });
  proc.on('close', () => { ended = true; while (waiters.length) waiters.shift()(null); });
  return {
    proc,
    times,          // times[k] = seconds since 'start' of the k-th frame delivered
    async next() {
      if (queue.length) { const f = queue.shift(); if (queue.length < 3) proc.stdout.resume(); return f; }
      if (ended) return null;
      proc.stdout.resume();
      return new Promise(res => waiters.push(res));
    },
    kill() { try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ } },
    error: () => error
  };
}

/* RGB frame (w x h, w<=IN_W, h<=IN_H) -> float32 CHW tensor padded to the model input */
function toTensor(rgb, w, h, out) {
  const plane = IN_W * IN_H;
  out.fill(114 / 255);
  for (let y = 0; y < h; y++) {
    let si = y * w * 3, di = y * IN_W;
    for (let x = 0; x < w; x++, si += 3, di++) {
      out[di] = rgb[si] / 255; out[plane + di] = rgb[si + 1] / 255; out[2 * plane + di] = rgb[si + 2] / 255;
    }
  }
  return out;
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1);
}
function nms(dets, thr) {
  dets.sort((a, b) => b.conf - a.conf);
  const keep = [];
  for (const d of dets) if (!keep.some(k => iou(k.box, d.box) > thr)) keep.push(d);
  return keep;
}
/* YOLO11 output [1, 84, N]: 4 box values then 80 class scores. Classes: 0 person, 32 sports ball */
function decode(output, n, { personConf = 0.2, ballConf = 0.12 } = {}) {
  const data = output.data, people = [], balls = [];
  for (let i = 0; i < n; i++) {
    const ps = data[4 * n + i], bs = data[(4 + 32) * n + i];
    if (ps < personConf && bs < ballConf) continue;
    const cx = data[i], cy = data[n + i], w = data[2 * n + i], h = data[3 * n + i];
    const box = [cx - w / 2, cy - h / 2, w, h];
    if (ps >= personConf) people.push({ box, conf: ps, cls: 'person' });
    if (bs >= ballConf) balls.push({ box, conf: bs, cls: 'ball' });
  }
  return { people: nms(people, 0.5), balls: nms(balls, 0.3) };
}

/* Grass mask helpers: a player stands on grass, the crowd does not */
function isGreen(r, g, b) { return g > 60 && g > r * 1.08 && g > b * 1.05; }
function grassAround(rgb, w, h, box) {
  const fx = box[0] + box[2] / 2, fy = box[1] + box[3];
  const x0 = Math.max(0, Math.round(fx - box[2] * 1.2)), x1 = Math.min(w - 1, Math.round(fx + box[2] * 1.2));
  const y0 = Math.max(0, Math.round(fy - box[3] * 0.15)), y1 = Math.min(h - 1, Math.round(fy + box[3] * 0.35));
  let g = 0, n = 0;
  for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) { const i = (y * w + x) * 3; n++; if (isGreen(rgb[i], rgb[i + 1], rgb[i + 2])) g++; }
  return n ? g / n : 0;
}
/* Average shirt colour (upper body, grass pixels ignored) in RGB 0-255 */
function shirtColour(rgb, w, h, box) {
  const x0 = Math.max(0, Math.round(box[0] + box[2] * 0.25)), x1 = Math.min(w - 1, Math.round(box[0] + box[2] * 0.75));
  const y0 = Math.max(0, Math.round(box[1] + box[3] * 0.15)), y1 = Math.min(h - 1, Math.round(box[1] + box[3] * 0.5));
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y * w + x) * 3, R = rgb[i], G = rgb[i + 1], B = rgb[i + 2];
    if (isGreen(R, G, B)) continue;
    r += R; g += G; b += B; n++;
  }
  return n >= 6 ? [r / n, g / n, b / n] : null;
}

/* Bilinear resample of a region of an RGB frame.
   src (sw x sh) region [rx, ry, rw, rh] -> either an RGB buffer (ow x oh) or, with tensor=true,
   the model's CHW float tensor (IN_W x IN_H, padded). Used to shrink full-resolution frames for the main
   pass and to zoom into the area around the ball for the ball pass. */
function resample(src, sw, sh, rx, ry, rw, rh, ow, oh, out, tensor) {
  const plane = IN_W * IN_H;
  if (tensor) out.fill(114 / 255);
  const sx = rw / ow, sy = rh / oh;
  const x0s = new Int32Array(ow), x1s = new Int32Array(ow), fxs = new Float32Array(ow);
  for (let x = 0; x < ow; x++) {
    let fx = rx + (x + 0.5) * sx - 0.5; if (fx < 0) fx = 0; if (fx > sw - 1) fx = sw - 1;
    const i0 = Math.floor(fx); x0s[x] = i0 * 3; x1s[x] = Math.min(sw - 1, i0 + 1) * 3; fxs[x] = fx - i0;
  }
  for (let y = 0; y < oh; y++) {
    let fy = ry + (y + 0.5) * sy - 0.5; if (fy < 0) fy = 0; if (fy > sh - 1) fy = sh - 1;
    const j0 = Math.floor(fy), j1 = Math.min(sh - 1, j0 + 1), wy = fy - j0, r0 = j0 * sw * 3, r1 = j1 * sw * 3;
    for (let x = 0; x < ow; x++) {
      const a = x0s[x], b = x1s[x], wx = fxs[x];
      for (let c = 0; c < 3; c++) {
        const top = src[r0 + a + c] + (src[r0 + b + c] - src[r0 + a + c]) * wx;
        const bot = src[r1 + a + c] + (src[r1 + b + c] - src[r1 + a + c]) * wx;
        const v = top + (bot - top) * wy;
        if (tensor) out[c * plane + y * IN_W + x] = v / 255; else out[(y * ow + x) * 3 + c] = v;
      }
    }
  }
  return out;
}

/* Camera motion: how far the picture content moved between two frames (pixels of a 160x90 thumbnail).
   Coarse-to-fine block matching on grey thumbnails – good enough to tell a panning camera from a moving ball. */
const TW = 160, TH = 90;
function greyThumb(rgb, w, h) {
  const out = new Float32Array(TW * TH), sx = w / TW, sy = h / TH;
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
    let s = 0, n = 0;
    for (let yy = Math.floor(y * sy); yy < Math.floor((y + 1) * sy); yy += 2) for (let xx = Math.floor(x * sx); xx < Math.floor((x + 1) * sx); xx += 2) { const i = (yy * w + xx) * 3; s += rgb[i] * 0.3 + rgb[i + 1] * 0.59 + rgb[i + 2] * 0.11; n++; }
    out[y * TW + x] = n ? s / n : 0;
  }
  return out;
}
function half(a, tw, th) { const w2 = tw >> 1, h2 = th >> 1, o = new Float32Array(w2 * h2); for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) { const i = 2 * y * tw + 2 * x; o[y * w2 + x] = (a[i] + a[i + 1] + a[i + tw] + a[i + tw + 1]) / 4; } return o; }
function sad(a, b, tw, th, dx, dy, m) {
  let s = 0, n = 0;
  for (let y = m; y < th - m; y += 1) { const yb = y + dy; if (yb < 0 || yb >= th) continue; for (let x = m; x < tw - m; x++) { const xb = x + dx; if (xb < 0 || xb >= tw) continue; s += Math.abs(a[y * tw + x] - b[yb * tw + xb]); n++; } }
  return n ? s / n : 1e9;
}
function cameraShift(prev, cur) {
  if (!prev) return [0, 0];
  const pa = half(prev, TW, TH), ca = half(cur, TW, TH), w2 = TW >> 1, h2 = TH >> 1;
  let best = [0, 0], bv = Infinity;
  for (let dy = -6; dy <= 6; dy++) for (let dx = -12; dx <= 12; dx++) { const v = sad(pa, ca, w2, h2, dx, dy, 12); if (v < bv) { bv = v; best = [dx, dy]; } }
  const fb = [best[0] * 2, best[1] * 2];
  let fv = Infinity, out = fb;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const v = sad(prev, cur, TW, TH, fb[0] + dx, fb[1] + dy, 26); if (v < fv) { fv = v; out = [fb[0] + dx, fb[1] + dy]; } }
  // sub-pixel: fit a parabola through the neighbours of the best match
  const sub = (a, b, c) => { const d = a - 2 * b + c; return d > 1e-6 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * d))) : 0; };
  const v = (dx, dy) => sad(prev, cur, TW, TH, out[0] + dx, out[1] + dy, 26);
  return [out[0] + sub(v(-1, 0), fv, v(1, 0)), out[1] + sub(v(0, -1), fv, v(0, 1)), fv];   // content at (x,y) in prev is at (x+dx, y+dy) in cur
}

module.exports = { IN_W, IN_H, frameReader, toTensor, decode, iou, grassAround, shirtColour, resample, greyThumb, cameraShift, TW, TH };
