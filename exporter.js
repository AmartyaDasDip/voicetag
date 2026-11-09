// VoiceTag – video clip exporter (uses ffmpeg)
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

function safeName(s) { return String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'clip'; }
function mmss(t) { t = Math.max(0, t); return String(Math.floor(t / 60)).padStart(2, '0') + '-' + String(Math.floor(t % 60)).padStart(2, '0'); }

function clipArgs(videoPath, clip, out, quality) {
  const start = Math.max(0, clip.start), dur = Math.max(0.1, clip.end - clip.start);
  if (quality === 'fast') {
    // stream copy: very quick, cut points snap to nearest keyframe
    return ['-hide_banner', '-y', '-ss', start.toFixed(3), '-i', videoPath, '-t', dur.toFixed(3),
      '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', out];
  }
  return ['-hide_banner', '-y', '-ss', start.toFixed(3), '-i', videoPath, '-t', dur.toFixed(3),
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', out];
}

/**
 * opts: { ffmpeg, videoPath, clips:[{start,end,name}], mode:'single'|'separate', quality:'accurate'|'fast',
 *         target (file for single, folder for separate), tempRoot, job, onProgress }
 */
async function exportClips(opts) {
  const { ffmpeg, videoPath, clips, mode, quality, target, job, onProgress } = opts;
  if (!clips || !clips.length) throw new Error('No clips selected');
  const total = clips.reduce((s, c) => s + Math.max(0.1, c.end - c.start), 0);
  let done = 0;
  const report = (i, cur) => onProgress && onProgress({ index: i, count: clips.length, percent: Math.min(100, Math.round((done + cur) / total * 100)) });

  const ext = quality === 'fast' ? path.extname(videoPath) || '.mp4' : '.mp4';
  let workDir, files = [];
  if (mode === 'single') {
    workDir = fs.mkdtempSync(path.join(opts.tempRoot, 'voicetag-'));
  } else {
    workDir = target;
  }
  try {
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const name = mode === 'single'
        ? 'part' + String(i).padStart(4, '0') + ext
        : String(i + 1).padStart(3, '0') + ' ' + safeName(c.name) + ' ' + mmss(c.start) + ext;
      const out = path.join(workDir, name);
      await runFfmpeg(ffmpeg, clipArgs(videoPath, c, out, quality), job, s => report(i, Math.min(s, c.end - c.start)));
      done += Math.max(0.1, c.end - c.start);
      report(i, 0);
      files.push(out);
    }
    if (mode === 'single') {
      const list = path.join(workDir, 'list.txt');
      fs.writeFileSync(list, files.map(f => "file '" + f.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'").join('\n'), 'utf8');
      onProgress && onProgress({ index: clips.length, count: clips.length, percent: 100, stage: 'joining' });
      await runFfmpeg(ffmpeg, ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', target], job);
      return target;
    }
    return files[0] || target;
  } finally {
    if (mode === 'single' && workDir) { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  }
}

module.exports = { createJob, cancel, exportClips, clipArgs };
