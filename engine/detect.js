// TACTIQ ANALYST – AI engine: frame decoding (ffmpeg) + YOLO detection (ONNX Runtime)
'use strict';
const { spawn } = require('child_process');

const IN_W = 1280, IN_H = 736;   // model input (exported rectangular for 16:9 video)

/* Decode frames as raw RGB at analysis size. Yields {index, data(Buffer rgb24), w, h}. */
function frameReader({ ffmpeg, video, start, duration, stride, w, h }) {
  const vf = [`select='not(mod(n\\,${stride}))'`, `scale=${w}:${h}:flags=bilinear`].join(',');
  const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-i', video];
  if (duration) args.push('-t', String(duration));
  args.push('-vf', vf, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1');
  const proc = spawn(ffmpeg, args, { windowsHide: true });
  const size = w * h * 3;
  let buf = Buffer.alloc(0), ended = false, error = '';
  const queue = [], waiters = [];
  proc.stderr.on('data', d => { error += d.toString(); });
  proc.stdout.on('data', chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= size) { const f = buf.subarray(0, size); buf = buf.subarray(size); const item = Buffer.from(f); if (waiters.length) waiters.shift()(item); else queue.push(item); }
    if (queue.length > 6) proc.stdout.pause();
  });
  proc.on('close', () => { ended = true; while (waiters.length) waiters.shift()(null); });
  return {
    proc,
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

module.exports = { IN_W, IN_H, frameReader, toTensor, decode, iou, grassAround, shirtColour };
