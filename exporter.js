// VoiceTag – video tools (uses ffmpeg): clip export with extras, and import conversion
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function createJob() { return { cancelled: false, proc: null }; }
function cancel(job) { job.cancelled = true; if (job.proc) { try { job.proc.kill('SIGKILL'); } catch (e) { /* ignore */ } } }

function runFfmpeg(ffmpeg, args, job, onSeconds) {
  return new Promise((resolve, reject) => {
    if (job.cancelled) return reject(new Error('cancelled'));
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    job.proc = proc;
    let tail = '';
    proc.stderr.on('data', d => {
      const s = d.toString();
      tail = (tail + s).slice(-4000);
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
      if (m && onSeconds) onSeconds(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    });
    proc.on('error', reject);
    proc.on('close', code => {
      job.proc = null;
      if (job.cancelled) return reject(new Error('cancelled'));
      if (code === 0) resolve();
      else reject(new Error('ffmpeg failed (code ' + code + '):\n' + tail.split('\n').slice(-6).join('\n')));
    });
  });
}

function safeName(s) { return String(s || '').replace(/#/g, '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'clip'; }
function mmss(t) { t = Math.max(0, t); return String(Math.floor(t / 60)).padStart(2, '0') + '-' + String(Math.floor(t % 60)).padStart(2, '0'); }

function probe(ffmpeg, file) {
  return new Promise(resolve => {
    const p = spawn(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', () => resolve({ text: '' }));
    p.on('close', () => {
      const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
      const v = /Stream #[^\n]*Video:\s*([a-z0-9_]+)([^\n]*)/i.exec(err);
      const a = /Stream #[^\n]*Audio:\s*([a-z0-9_]+)/i.exec(err);
      const wh = v ? /[ ,](\d{2,5})x(\d{2,5})[ ,\[]/.exec(v[2]) : null;
      const fps = v ? /([\d.]+) fps/.exec(v[2]) || /([\d.]+) tbr/.exec(v[2]) : null;
      resolve({
        text: err,
        duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
        vcodec: v ? v[1].toLowerCase() : '', vinfo: v ? v[2] : '', acodec: a ? a[1].toLowerCase() : '',
        width: wh ? Number(wh[1]) : 0, height: wh ? Number(wh[2]) : 0, fps: fps ? Number(fps[1]) : 0
      });
    });
  });
}

/* ------------------------------------------------------------------ simple clips (no extras) */
function clipArgs(videoPath, clip, out, quality) {
  const start = Math.max(0, clip.start), dur = Math.max(0.1, clip.end - clip.start);
  if (quality === 'fast') {
    return ['-hide_banner', '-y', '-ss', start.toFixed(3), '-i', videoPath, '-t', dur.toFixed(3),
      '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', out];
  }
  return ['-hide_banner', '-y', '-ss', start.toFixed(3), '-i', videoPath, '-t', dur.toFixed(3),
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', out];
}
function outFileFor(target, c, i, ext) {
  const dir = c.folder ? path.join(target, safeName(c.folder)) : target;
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, String(i + 1).padStart(3, '0') + ' ' + safeName(c.name) + ' ' + mmss(c.start) + ext);
}
async function concatFiles(ffmpeg, files, out, workDir, job) {
  const list = path.join(workDir, 'list-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.txt');
  fs.writeFileSync(list, files.map(f => "file '" + f.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'").join('\n'), 'utf8');
  await runFfmpeg(ffmpeg, ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out], job);
}

/* ------------------------------------------------------------------ clips with title cards / captions / drawings */
function writePng(dataUrl, file) {
  fs.writeFileSync(file, Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64'));
  return file;
}
function encArgs(fmt) {
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-video_track_timescale', '90000',
    ...(fmt.audio ? ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2'] : ['-an'])];
}
// the annotation layer (3.3, a transparent .mov drawn in the window from ov.t0 to ov.t1) for the part s–e of the video:
// seek into it when it began earlier, or delay it when it begins later
function annLayer(ov, s, e) {
  if (!ov || !ov.path || !(ov.t1 > s + 0.02) || !(ov.t0 < e - 0.02)) return null;
  const seek = Math.max(0, s - ov.t0), delay = Math.max(0, ov.t0 - s);
  return { args: [...(seek > 0.001 ? ['-ss', seek.toFixed(3)] : []), '-i', ov.path], delay };
}
function videoSegArgs(src, s, e, caption, out, fmt, ov) {
  const { W, H, F } = fmt;
  const ins = ['-ss', s.toFixed(3), '-i', src], chain = [`[0:v]scale=${W}:${H},setsar=1,fps=${F}[v0]`];
  let cur = 'v0', k = 1;
  const lay = annLayer(ov, s, e);
  if (lay) {   // the annotations under the caption
    ins.push(...lay.args);
    chain.push(`[${k}:v]format=rgba,scale=${W}:${H},setpts=PTS-STARTPTS+${lay.delay.toFixed(3)}/TB[a${k}]`, `[${cur}][a${k}]overlay=0:0:eof_action=pass:format=auto[v${k}]`);
    cur = 'v' + k; k++;
  }
  if (caption) { ins.push('-i', caption); chain.push(`[${k}:v]scale=${W}:${H}[c]`, `[${cur}][c]overlay=0:0[v${k}]`); cur = 'v' + k; k++; }
  chain.push(`[${cur}]format=yuv420p[v]`);
  return ['-hide_banner', '-y', ...ins, '-t', Math.max(0.05, e - s).toFixed(3),
    '-filter_complex', chain.join(';'), '-map', '[v]', ...(fmt.audio ? ['-map', '0:a:0'] : []), ...encArgs(fmt), out];
}
// one still picture of the video at t (with the annotations of that moment when there is a layer)
function frameArgs(src, t, ov, out, fmt) {
  const lay = ov && ov.path && t >= ov.t0 - 0.001 && t < ov.t1 ? Math.max(0, t - ov.t0) : null;
  if (lay == null) return ['-hide_banner', '-y', '-ss', t.toFixed(3), '-i', src, '-frames:v', '1', '-vf', `scale=${fmt.W}:${fmt.H}`, out];
  // both from 0, so the first picture of the video meets the first picture of the layer
  return ['-hide_banner', '-y', '-ss', t.toFixed(3), '-i', src, '-ss', lay.toFixed(3), '-i', ov.path,
    '-filter_complex', `[0:v]scale=${fmt.W}:${fmt.H},setsar=1,setpts=PTS-STARTPTS[b];[1:v]format=rgba,scale=${fmt.W}:${fmt.H},setpts=PTS-STARTPTS[a];[b][a]overlay=0:0:format=auto[v]`, '-map', '[v]', '-frames:v', '1', out];
}
function stillSegArgs(basePng, overPng, dur, out, fmt) {
  const { W, H, F } = fmt;
  const ins = ['-loop', '1', '-framerate', String(F), '-t', dur.toFixed(3), '-i', basePng];
  if (overPng) ins.push('-loop', '1', '-framerate', String(F), '-t', dur.toFixed(3), '-i', overPng);
  const aIdx = overPng ? 2 : 1;
  if (fmt.audio) ins.push('-f', 'lavfi', '-t', dur.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo');
  const filter = overPng
    ? `[0:v]scale=${W}:${H},setsar=1[b];[1:v]scale=${W}:${H}[o];[b][o]overlay=0:0,fps=${F},format=yuv420p[v]`
    : `[0:v]scale=${W}:${H},setsar=1,fps=${F},format=yuv420p[v]`;
  return ['-hide_banner', '-y', ...ins, '-filter_complex', filter, '-map', '[v]', ...(fmt.audio ? ['-map', aIdx + ':a'] : []),
    '-t', dur.toFixed(3), ...encArgs(fmt), out];
}

async function exportWithExtras(opts) {
  const { ffmpeg, videoPath, clips, mode, target, job, onProgress } = opts;
  const titleDur = Number(opts.titleDur) || 2.5;
  const info = await probe(ffmpeg, videoPath);
  const even = n => Math.max(2, Math.round(n / 2) * 2);
  const fmt = { W: even(info.width || 1280), H: even(info.height || 720), F: info.fps && info.fps < 121 ? Math.round(info.fps * 1000) / 1000 : 25, audio: !!info.acodec };
  const work = fs.mkdtempSync(path.join(opts.tempRoot, 'voicetag-'));
  // plan all segments first so progress is accurate
  const plan = clips.map((c, i) => {
    const segs = [];
    if (c.title) segs.push({ kind: 'still', dur: titleDur, base: writePng(c.title, path.join(work, `t${i}.png`)) });
    const cap = c.caption ? writePng(c.caption, path.join(work, `c${i}.png`)) : null;
    let cur = Math.max(0, c.start);
    const ov = c.overlay && c.overlay.path ? { path: c.overlay.path, t0: Number(c.overlay.t0) || 0, t1: Number(c.overlay.t1) || 0 } : null;
    (c.drawings || []).filter(d => d.t >= c.start && d.t <= c.end).sort((a, b) => a.t - b.t).forEach((d, k) => {
      if (d.t - cur > 0.04) segs.push({ kind: 'video', s: cur, e: d.t, cap, ov });
      segs.push({ kind: 'freeze', t: d.t, dur: Math.max(0.5, Number(d.dur) || 3), over: writePng(d.png, path.join(work, `d${i}_${k}.png`)), ov });
      cur = d.t;
    });
    if (c.end - cur > 0.04) segs.push({ kind: 'video', s: cur, e: c.end, cap, ov });
    return { c, segs };
  });
  const total = plan.reduce((s, p) => s + p.segs.reduce((a, g) => a + (g.kind === 'video' ? g.e - g.s : g.dur), 0), 0) || 1;
  let done = 0, n = 0;
  const report = (i, cur) => onProgress && onProgress({ index: i, count: clips.length, percent: Math.min(99, Math.round((done + cur) / total * 100)) });
  const allSegs = [], outputs = [];
  try {
    for (let i = 0; i < plan.length; i++) {
      const files = [];
      for (const g of plan[i].segs) {
        const out = path.join(work, `seg${String(n++).padStart(5, '0')}.mp4`);
        const len = g.kind === 'video' ? g.e - g.s : g.dur;
        if (g.kind === 'video') await runFfmpeg(ffmpeg, videoSegArgs(videoPath, g.s, g.e, g.cap, out, fmt, g.ov), job, s => report(i, Math.min(s, len)));
        else if (g.kind === 'still') await runFfmpeg(ffmpeg, stillSegArgs(g.base, null, g.dur, out, fmt), job);
        else {
          const frame = path.join(work, `f${n}.png`);
          await runFfmpeg(ffmpeg, frameArgs(videoPath, g.t, g.ov, frame, fmt), job);
          await runFfmpeg(ffmpeg, stillSegArgs(frame, g.over, g.dur, out, fmt), job);
        }
        done += len; report(i, 0);
        files.push(out);
      }
      if (mode === 'single') allSegs.push(...files);
      else if (files.length) {
        const out = outFileFor(target, plan[i].c, i, '.mp4');
        if (files.length === 1) fs.copyFileSync(files[0], out); else await concatFiles(ffmpeg, files, out, work, job);
        outputs.push(out);
      }
    }
    if (mode === 'single') {
      onProgress && onProgress({ index: clips.length, count: clips.length, percent: 99, stage: 'joining' });
      await concatFiles(ffmpeg, allSegs, target, work, job);
      return target;
    }
    return outputs[0] || target;
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

/**
 * opts: { ffmpeg, videoPath, clips:[{start,end,name,folder,title,caption,drawings,overlay:{path,t0,t1}}], mode:'single'|'separate',
 *         quality:'accurate'|'fast', target, tempRoot, job, onProgress, titleDur }
 */
async function exportClips(opts) {
  const { ffmpeg, videoPath, clips, mode, quality, target, job, onProgress } = opts;
  if (!clips || !clips.length) throw new Error('No clips selected');
  const extras = quality !== 'fast' && clips.some(c => c.title || c.caption || (c.drawings && c.drawings.length) || c.overlay);
  if (extras) return exportWithExtras(opts);
  const total = clips.reduce((s, c) => s + Math.max(0.1, c.end - c.start), 0);
  let done = 0;
  const report = (i, cur) => onProgress && onProgress({ index: i, count: clips.length, percent: Math.min(100, Math.round((done + cur) / total * 100)) });
  const ext = quality === 'fast' ? path.extname(videoPath) || '.mp4' : '.mp4';
  const workDir = mode === 'single' ? fs.mkdtempSync(path.join(opts.tempRoot, 'voicetag-')) : null;
  const files = [];
  try {
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const out = mode === 'single' ? path.join(workDir, 'part' + String(i).padStart(4, '0') + ext) : outFileFor(target, c, i, ext);
      await runFfmpeg(ffmpeg, clipArgs(videoPath, c, out, quality), job, s => report(i, Math.min(s, c.end - c.start)));
      done += Math.max(0.1, c.end - c.start);
      report(i, 0);
      files.push(out);
    }
    if (mode === 'single') {
      onProgress && onProgress({ index: clips.length, count: clips.length, percent: 100, stage: 'joining' });
      await concatFiles(ffmpeg, files, target, workDir, job);
      return target;
    }
    return files[0] || target;
  } finally {
    if (workDir) { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  }
}

/* ------------------------------------------------------------------ IMPORT CONVERSION */
async function convertToMp4({ ffmpeg, input, output, job, onProgress }) {
  const info = await probe(ffmpeg, input);
  if (!info.vcodec) throw new Error('No video stream found in this file (or the format is not supported).\n' + info.text.split('\n').slice(-4).join('\n'));
  const tenBit = /p10|p12|10le|12le/.test(info.vinfo);
  const canCopyVideo = info.vcodec === 'h264' && !tenBit;
  const part = output + '.part.mp4';
  const report = s => onProgress && onProgress({ percent: info.duration ? Math.min(99, Math.round(s / info.duration * 100)) : 0, seconds: s, duration: info.duration });
  const audioArgs = info.acodec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k', '-ac', '2'];
  const encodeArgs = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p'];
  const build = videoArgs => ['-hide_banner', '-y', '-fflags', '+genpts', '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
    ...videoArgs, ...audioArgs, '-movflags', '+faststart', '-f', 'mp4', part];
  try {
    if (canCopyVideo) {
      try { await runFfmpeg(ffmpeg, build(['-c:v', 'copy']), job, report); }
      catch (e) { if (job.cancelled) throw e; await runFfmpeg(ffmpeg, build(encodeArgs), job, report); }
    } else {
      await runFfmpeg(ffmpeg, build(encodeArgs), job, report);
    }
    fs.renameSync(part, output);
    onProgress && onProgress({ percent: 100, duration: info.duration });
    return { output, remuxed: canCopyVideo, vcodec: info.vcodec };
  } catch (e) {
    try { fs.rmSync(part, { force: true }); } catch (err) { /* ignore */ }
    throw e;
  }
}

module.exports = { createJob, cancel, exportClips, clipArgs, probe, convertToMp4 };
