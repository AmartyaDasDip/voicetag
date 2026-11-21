// VoiceTag – Electron main process
'use strict';
const { app, BrowserWindow, protocol, ipcMain, dialog, session, Menu, shell, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const exporter = require('./exporter');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

// 3D view: if Windows has no usable graphics driver for WebGL, fall back to software rendering.
// Safe here because the window only ever shows the app's own local pages (web links open in the browser).
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

const RENDERER_DIR = path.join(__dirname, 'renderer');
// keep settings, tags and season data from the VoiceTag versions
app.setName('TACTIQ ANALYST');
app.setPath('userData', path.join(app.getPath('appData'), 'VoiceTag'));
if (process.env.TACTIQ_USERDATA) app.setPath('userData', process.env.TACTIQ_USERDATA);   // tests run with their own settings folder

/* ------------------------------------------------------------------ LOG FILE
   Errors and important events go to <settings folder>/logs/tactiq-YYYY-MM-DD.log (kept 14 days, at most 10 MB a day).
   Help → Troubleshooting opens the folder or copies a diagnostic report. */
const logDir = () => path.join(app.getPath('userData'), 'logs');
let logFile = null;
function logLine(level, src, msg) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (!logFile || !logFile.includes(day)) {
      fs.mkdirSync(logDir(), { recursive: true }); logFile = path.join(logDir(), 'tactiq-' + day + '.log');
      fs.readdirSync(logDir()).filter(f => /^tactiq-.*\.log$/.test(f)).sort().slice(0, -14).forEach(f => { try { fs.rmSync(path.join(logDir(), f)); } catch (e) { /* in use */ } });
    }
    try { if (fs.statSync(logFile).size > 10 * 1048576) return; } catch (e) { /* new file */ }
    fs.appendFileSync(logFile, new Date().toISOString() + ' ' + String(level).toUpperCase().padEnd(5) + ' [' + src + '] ' + String(msg).replace(/\r?\n/g, ' ⏎ ').slice(0, 4000) + '\n');
  } catch (e) { /* logging must never break the app */ }
}
function readLogTail(n) {
  try { const files = fs.readdirSync(logDir()).filter(f => /^tactiq-.*\.log$/.test(f)).sort(); let lines = []; for (let i = files.length - 1; i >= 0 && lines.length < n; i--) lines = fs.readFileSync(path.join(logDir(), files[i]), 'utf8').split('\n').filter(Boolean).concat(lines); return lines.slice(-n); } catch (e) { return []; }
}
process.on('uncaughtException', err => logLine('error', 'main', 'uncaught: ' + (err && err.stack || err)));
process.on('unhandledRejection', err => logLine('error', 'main', 'unhandled promise: ' + (err && err.stack || err)));
// In the installed app the model sits in resources/model, during development in ./model
function modelFile() {
  const candidates = [
    path.join(process.resourcesPath || '', 'model', 'model.tar.gz'),
    path.join(__dirname, 'model', 'model.tar.gz')
  ];
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
}
function ffmpegPath() {
  try {
    let p = require('ffmpeg-static');
    if (p) p = p.replace('app.asar', 'app.asar.unpacked');
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* not installed */ }
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.gz': 'application/gzip', '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.ts': 'video/mp2t', '.mts': 'video/mp2t', '.m2ts': 'video/mp2t'
};
const mimeOf = p => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

const allowedMedia = new Set();

async function serveMedia(request, filePath) {
  if (!filePath || !allowedMedia.has(path.resolve(filePath))) return new Response('Not allowed', { status: 403 });
  let stat;
  try { stat = await fs.promises.stat(filePath); } catch (e) { return new Response('Not found', { status: 404 }); }
  const size = stat.size, type = mimeOf(filePath);
  const range = request.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (!m[1] && m[2]) { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    const stream = fs.createReadStream(filePath, { start, end });
    return new Response(Readable.toWeb(stream), {
      status: 206,
      headers: {
        'Content-Type': type, 'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes'
      }
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
    status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
  });
}

async function handleApp(request) {
  const url = new URL(request.url);
  if (url.pathname === '/__media') return serveMedia(request, url.searchParams.get('p'));
  let rel = decodeURIComponent(url.pathname);
  let file;
  if (rel.startsWith('/model/')) {
    file = modelFile();
    if (!file) return new Response('Voice model missing', { status: 404 });
  } else {
    if (rel === '/' || rel === '') rel = '/index.html';
    file = path.normalize(path.join(RENDERER_DIR, rel));
    if (!file.startsWith(RENDERER_DIR)) return new Response('Forbidden', { status: 403 });
  }
  try {
    const data = await fs.promises.readFile(file);
    return new Response(data, { status: 200, headers: { 'Content-Type': mimeOf(file) } });
  } catch (e) {
    return new Response('Not found', { status: 404 });
  }
}

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 950, minWidth: 1100, minHeight: 700,
    backgroundColor: '#0e1217', title: 'TACTIQ ANALYST',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.loadURL('app://voicetag/index.html');
  win.on('close', e => {
    // ask renderer to flush autosave before closing
    try { win.webContents.send('app-closing'); } catch (err) { /* ignore */ }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  // the window's process crashed: log it and reload – the app then offers the automatically saved work
  win.webContents.on('render-process-gone', (e, d) => {
    logLine('error', 'main', 'window process gone: ' + d.reason + ' (exit code ' + d.exitCode + ')');
    if (d.reason === 'clean-exit') return;
    startState.rendererCrashes++;
    if (startState.rendererCrashes <= 3) setTimeout(() => { try { win.webContents.reload(); } catch (err) { logLine('error', 'main', 'reload failed: ' + err.message); } }, 600);
  });
  win.on('unresponsive', () => logLine('warn', 'main', 'window not responding'));
  win.on('responsive', () => logLine('info', 'main', 'window responding again'));
}
app.on('child-process-gone', (e, d) => { if (d.reason !== 'clean-exit') logLine('warn', 'main', `${d.type} process gone: ${d.reason} (exit code ${d.exitCode})${d.name ? ' ' + d.name : ''}`); });

function buildMenu() {
  const template = [
    { label: 'File', submenu: [{ role: 'quit', label: 'Exit' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }] },
    { label: 'Help', submenu: [{ role: 'toggleDevTools', label: 'Developer tools (for troubleshooting)' }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// open .tactiq project files from Explorer (double-click), one window only
const fileArg = argv => (argv || []).find(x => /\.tactiq$/i.test(x));
let pendingFile = fileArg(process.argv);
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
// "running" marker: if it is still there at the next start, the app did not close properly (crash, power cut, killed)
const lockFile = () => path.join(app.getPath('userData'), 'running.lock');
const startState = { crashed: false, previous: null, rendererCrashes: 0 };
if (primaryInstance) {
  try { if (fs.existsSync(lockFile())) { startState.crashed = true; try { startState.previous = JSON.parse(fs.readFileSync(lockFile(), 'utf8')); } catch (e) { /* unreadable */ } } } catch (e) { /* ignore */ }
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, started: new Date().toISOString(), version: app.getVersion() })); } catch (e) { /* ignore */ }
  const os = require('os');
  logLine('info', 'main', `start ${app.getName()} ${app.getVersion()} · Electron ${process.versions.electron} · ${process.platform} ${os.release()} ${process.arch} · ${Math.round(os.totalmem() / 1073741824 * 10) / 10} GB RAM · ${os.cpus().length} threads ${(os.cpus()[0] || {}).model || ''}`);
  if (startState.crashed) logLine('warn', 'main', 'the previous session did not close properly' + (startState.previous ? ' (started ' + startState.previous.started + ', version ' + startState.previous.version + ')' : ''));
  app.on('will-quit', () => { logLine('info', 'main', 'closed normally'); try { fs.rmSync(lockFile(), { force: true }); } catch (e) { /* ignore */ } });
}
app.on('second-instance', (e, argv) => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); const f = fileArg(argv); if (f) win.webContents.send('open-file', f); }
});
ipcMain.handle('pending-file', async () => { const f = pendingFile; pendingFile = null; return f || null; });
app.whenReady().then(() => {
  protocol.handle('app', handleApp);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' || permission === 'clipboard-sanitized-write'));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media' || permission === 'clipboard-sanitized-write');
  buildMenu();
  createWindow();
  try { const g = app.getGPUFeatureStatus(); logLine('info', 'main', 'graphics: webgl ' + g.webgl + ', video decode ' + g.video_decode + ', 2d canvas ' + g['2d_canvas']); } catch (e) { /* ignore */ }
});
app.on('window-all-closed', () => app.quit());

/* ------------------------------------------------------------------ IPC */
const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'qt', 'webm', 'mkv', 'avi', 'wmv', 'asf', 'flv', 'f4v', 'mpg', 'mpeg', 'mpe', 'm2v', 'mp2', 'vob',
  'ts', 'mts', 'm2ts', 'tod', 'mod', '3gp', '3g2', 'ogv', 'ogg', 'mxf', 'dv', 'divx', 'xvid', 'rm', 'rmvb', 'y4m', 'hevc', 'h264', 'h265', '264', '265', 'insv', 'lrv'];
const VIDEO_FILTERS = [{ name: 'All video files', extensions: VIDEO_EXT }, { name: 'All files', extensions: ['*'] }];

ipcMain.handle('open-video', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open match video', properties: ['openFile'], filters: VIDEO_FILTERS });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = path.resolve(r.filePaths[0]);
  allowedMedia.add(p);
  const st = fs.statSync(p);
  return { path: p, name: path.basename(p), size: st.size };
});
ipcMain.handle('register-media', async (e, p) => {
  if (!p) return null;
  p = path.resolve(p);
  try { const st = fs.statSync(p); if (!st.isFile()) return null; allowedMedia.add(p); return { path: p, name: path.basename(p), size: st.size }; }
  catch (err) { return null; }
});
ipcMain.handle('save-file', async (e, { defaultName, filters, data, encoding }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters });
  if (r.canceled || !r.filePath) return null;
  const buf = encoding === 'binary' ? Buffer.from(data) : Buffer.from(String(data), 'utf8');
  await fs.promises.writeFile(r.filePath, buf);
  return r.filePath;
});
ipcMain.handle('open-text-files', async (e, { filters }) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(async p => ({ path: p, text: await fs.promises.readFile(p, 'utf8') })));
});
ipcMain.handle('read-text-files', async (e, paths) => {
  // only VoiceTag project files can be read this way
  return Promise.all((paths || []).filter(p => /\.(vtproj|json|tactiq)$/i.test(p)).map(async p => {
    try { return { path: p, text: await fs.promises.readFile(p, 'utf8') }; } catch (err) { return { path: p, error: String(err.message || err) }; }
  }));
});
ipcMain.handle('open-external', async (e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
ipcMain.handle('app-version', async () => app.getVersion());
ipcMain.handle('export-pdf', async (e, { html, defaultName }) => {
  const r = await dialog.showSaveDialog(win, { title: 'Save match report', defaultPath: defaultName || 'match report.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (r.canceled || !r.filePath) return null;
  const tmp = path.join(app.getPath('temp'), 'voicetag-report-' + Date.now() + '.html');
  await fs.promises.writeFile(tmp, html, 'utf8');
  const w = new BrowserWindow({ show: false, width: 1100, height: 1500, webPreferences: { sandbox: true, javascript: false } });
  try {
    await w.loadFile(tmp);
    const pdf = await w.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'custom', top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } });
    await fs.promises.writeFile(r.filePath, pdf);
    shell.openPath(r.filePath);
    return r.filePath;
  } finally {
    w.destroy();
    fs.promises.unlink(tmp).catch(() => {});
  }
});
ipcMain.handle('open-text-file', async (e, { filters, skipText }) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
  if (r.canceled || !r.filePaths[0]) return null;
  const f = r.filePaths[0];
  if (typeof skipText === 'string' && new RegExp(skipText, 'i').test(f)) return { path: f, text: null };   // a big project is read once, later
  return { path: f, text: await fs.promises.readFile(f, 'utf8') };
});
ipcMain.handle('model-info', async () => ({ available: !!modelFile(), url: 'app://voicetag/model/model.tar.gz' }));
ipcMain.handle('ffmpeg-info', async () => ({ available: !!ffmpegPath() }));
ipcMain.handle('show-in-folder', async (e, p) => { if (p) shell.showItemInFolder(p); });

let currentExport = null, pickedTarget = null;
async function askExportTarget(mode, defaultName) {
  if (mode === 'single') {
    const r = await dialog.showSaveDialog(win, { title: 'Save joined video', defaultPath: defaultName || 'clips.mp4', filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
    return r.canceled || !r.filePath ? null : r.filePath;
  }
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder for the clips', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}
// 3.3: with annotations the window first asks where to save, then draws the annotation layers, then exports
ipcMain.handle('export-target', async (e, { mode, defaultName } = {}) => {
  const target = await askExportTarget(mode, defaultName);
  pickedTarget = target ? { mode, target } : null;
  return target ? { ok: true } : { ok: false, canceled: true };
});
ipcMain.handle('export-clips', async (e, opts) => {
  const ff = ffmpegPath();
  const overlays = (opts.clips || []).map(c => c && c.overlay && c.overlay.path ? path.resolve(c.overlay.path) : null).filter(Boolean);
  try {
    if (!ff) return { ok: false, error: 'ffmpeg is missing. Re-run BUILD.bat to rebuild the app.' };
    if (!opts.videoPath || !fs.existsSync(opts.videoPath)) return { ok: false, error: 'The source video file was not found: ' + opts.videoPath };
    // only annotation layers this app run made itself are used
    (opts.clips || []).forEach(c => { if (c && c.overlay && !(c.overlay.path && annOverlays.has(path.resolve(c.overlay.path)))) delete c.overlay; });
    let target;
    if (opts.useTarget && pickedTarget && pickedTarget.mode === opts.mode) target = pickedTarget.target;
    else target = await askExportTarget(opts.mode, opts.defaultName);
    pickedTarget = null;
    if (!target) return { ok: false, canceled: true };
    return await runClipExport(e, ff, opts, target);
  } finally { dropOverlays(overlays.filter(p => annOverlays.has(p))); }
});
async function runClipExport(e, ff, opts, target) {
  currentExport = exporter.createJob();
  try {
    const out = await exporter.exportClips({
      ffmpeg: ff, videoPath: opts.videoPath, clips: opts.clips, mode: opts.mode, quality: opts.quality, target,
      tempRoot: app.getPath('temp'), job: currentExport,
      onProgress: p => { try { e.sender.send('export-progress', p); } catch (err) { /* window gone */ } }
    });
    return { ok: true, path: out };
  } catch (err) {
    if (!(currentExport && currentExport.cancelled)) logLine('error', 'export', 'video export failed: ' + (err.message || err));
    return { ok: false, error: currentExport && currentExport.cancelled ? 'Export cancelled' : String(err.message || err) };
  } finally { currentExport = null; }
}
/* ---- convert any format to a playable MP4 (cached, done once per file) ---- */
const crypto = require('crypto');
let currentConvert = null;
function convertedPathFor(p) {
  const st = fs.statSync(p);
  const key = crypto.createHash('sha1').update(path.resolve(p) + '|' + st.size + '|' + st.mtimeMs).digest('hex').slice(0, 16);
  const dir = path.join(app.getPath('userData'), 'converted');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, path.basename(p).replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '_').slice(0, 60) + '-' + key + '.mp4');
}
ipcMain.handle('cached-conversion', async (e, p) => {
  try { const out = convertedPathFor(p); if (fs.existsSync(out)) { allowedMedia.add(path.resolve(out)); return out; } } catch (err) { /* ignore */ }
  return null;
});
ipcMain.handle('convert-video', async (e, p) => {
  const ff = ffmpegPath();
  if (!ff) return { ok: false, error: 'ffmpeg is missing from this build.' };
  if (!p || !fs.existsSync(p)) return { ok: false, error: 'File not found: ' + p };
  const out = convertedPathFor(p);
  if (fs.existsSync(out)) { allowedMedia.add(path.resolve(out)); return { ok: true, path: out, cached: true }; }
  currentConvert = exporter.createJob();
  try {
    const r = await exporter.convertToMp4({
      ffmpeg: ff, input: p, output: out, job: currentConvert,
      onProgress: pr => { try { e.sender.send('convert-progress', pr); } catch (err) { /* ignore */ } }
    });
    allowedMedia.add(path.resolve(out));
    return { ok: true, path: out, remuxed: r.remuxed };
  } catch (err) {
    if (!(currentConvert && currentConvert.cancelled)) logLine('error', 'convert', path.basename(p) + ': ' + (err.message || err));
    return { ok: false, error: currentConvert && currentConvert.cancelled ? 'cancelled' : String(err.message || err) };
  } finally { currentConvert = null; }
});
ipcMain.handle('cancel-convert', async () => { if (currentConvert) exporter.cancel(currentConvert); return true; });

/* ------------------------------------------------------------------ 3D VIDEO (frames from the 3D view → MP4) */
let v3job = null;
const annOverlays = new Set();   // temp annotation layers made by this app run (the only overlay files export-clips accepts)
function dropOverlays(list) { (list || [...annOverlays]).forEach(p => { annOverlays.delete(p); try { fs.rmSync(p, { force: true }); } catch (e) { /* ignore */ } }); }
app.on('will-quit', () => dropOverlays());
ipcMain.handle('ann-overlays-drop', async () => { dropOverlays(); return true; });
function v3Abort() { if (!v3job) return; const j = v3job; v3job = null; try { j.proc.kill('SIGKILL'); } catch (e) { /* ignore */ } try { fs.rmSync(j.part, { force: true }); } catch (e) { /* ignore */ } }
// frames rendered in the window → MP4. Used by the 3D replay (JPEG frames) and by the annotated video (3.1): there the
// frames are transparent PNG overlays that ffmpeg lays over the original video (`under`), with its sound
ipcMain.handle('v3d-begin', async (e, { defaultName, fps, w, h, title, under, overlay }) => {
  const ff = ffmpegPath();
  if (!ff) return { ok: false, error: 'ffmpeg is missing from this build.' };
  v3Abort();
  if (under && (!under.path || !allowedMedia.has(path.resolve(under.path)))) return { ok: false, error: 'The video file is not available.' };
  let out, part;
  if (overlay) {   // 3.3: a transparent annotation layer for the clip / playlist export – a temp file, no dialog
    out = path.join(app.getPath('temp'), `tactiq-ann-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mov`); part = out + '.part.mov';
  } else {
    const r = await dialog.showSaveDialog(win, { title: title || 'Save 3D video', defaultPath: defaultName || '3D replay.mp4', filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
    if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
    out = /\.mp4$/i.test(r.filePath) ? r.filePath : r.filePath + '.mp4'; part = out + '.part.mp4';
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const fpsN = Math.max(10, Math.min(60, Number(fps) || 30));
  const W = Math.max(64, Math.round(Number(w) / 2) * 2 || 1280), H = Math.max(64, Math.round(Number(h) / 2) * 2 || 720);
  const args = overlay
    ? ['-hide_banner', '-y', '-f', 'image2pipe', '-framerate', String(fpsN), '-c:v', 'png', '-i', '-', '-vf', `scale=${W}:${H}`, '-c:v', 'qtrle', '-pix_fmt', 'argb', '-f', 'mov', part]
    : under
    ? ['-hide_banner', '-y', '-ss', String(Math.max(0, Number(under.t0) || 0)), '-t', String(Math.max(0.1, Number(under.dur) || 1)), '-i', under.path,
      '-f', 'image2pipe', '-framerate', String(fpsN), '-c:v', 'png', '-i', '-',
      '-filter_complex', `[0:v]scale=${W}:${H},setsar=1,fps=${fpsN}[b];[1:v]format=rgba,scale=${W}:${H}[o];[b][o]overlay=0:0:eof_action=pass:format=auto[v]`,
      '-map', '[v]'].concat(under.sound ? ['-map', '0:a?', '-c:a', 'aac', '-b:a', '160k'] : ['-an'])
      .concat(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-t', String(Math.max(0.1, Number(under.dur) || 1)), '-movflags', '+faststart', '-f', 'mp4', part])
    : ['-hide_banner', '-y', '-f', 'image2pipe', '-framerate', String(fpsN), '-c:v', 'mjpeg', '-i', '-',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(fpsN), '-movflags', '+faststart', '-f', 'mp4', part];
  const proc = require('child_process').spawn(ff, args, { windowsHide: true });
  const job = { proc, out, part, err: '', exited: false, overlay: !!overlay };
  job.done = new Promise(res => proc.on('close', code => { job.exited = true; res(code); }));
  proc.on('error', err => { job.err += String(err.message || err); });
  proc.stderr.on('data', d => { job.err = (job.err + d).slice(-3000); });
  proc.stdin.on('error', () => { /* reported through the exit code */ });
  v3job = job;
  return { ok: true, file: out };
});
ipcMain.handle('v3d-frame', async (e, bytes) => {
  const j = v3job; if (!j || j.exited) return false;
  if (!j.proc.stdin.write(Buffer.from(bytes))) await new Promise(res => { j.proc.stdin.once('drain', res); j.done.then(res); });
  return !j.exited;
});
ipcMain.handle('v3d-end', async (e, { cancel } = {}) => {
  const j = v3job; if (!j) return { ok: false, error: 'no 3D video in progress' };
  if (cancel) { v3Abort(); return { ok: false, cancelled: true }; }
  v3job = null;
  try { j.proc.stdin.end(); } catch (err) { /* ignore */ }
  const code = await j.done;
  if (code === 0 && fs.existsSync(j.part)) {
    fs.renameSync(j.part, j.out);
    if (j.overlay) annOverlays.add(path.resolve(j.out)); else allowedMedia.add(path.resolve(j.out));
    return { ok: true, file: j.out };
  }
  try { fs.rmSync(j.part, { force: true }); } catch (err) { /* ignore */ }
  const msg = (j.err || 'ffmpeg exit code ' + code).split('\n').filter(Boolean).slice(-3).join(' | ');
  logLine('error', '3d', 'video failed: ' + msg);
  return { ok: false, error: msg };
});

/* ------------------------------------------------------------------ LOG, DIAGNOSTICS, CRASH RECOVERY */
ipcMain.on('log', (e, o) => { if (o && o.msg) logLine(o.level === 'error' ? 'error' : o.level === 'warn' ? 'warn' : 'info', 'window', o.msg); });
ipcMain.handle('startup-info', async () => ({ crashed: startState.crashed, previous: startState.previous, rendererCrashes: startState.rendererCrashes, logDir: logDir(), userData: app.getPath('userData') }));
ipcMain.handle('crash-handled', async () => { startState.crashed = false; startState.rendererCrashes = 0; return true; });
ipcMain.handle('open-log-folder', async () => { fs.mkdirSync(logDir(), { recursive: true }); return shell.openPath(logDir()); });
ipcMain.handle('diagnostics', async () => {
  const os = require('os'); let gpu = {}, gpuInfo = null;
  try { gpu = app.getGPUFeatureStatus(); } catch (e) { /* ignore */ }
  try { const g = await app.getGPUInfo('basic'); gpuInfo = (g.gpuDevice || []).map(d => `${d.vendorString || d.vendorId} ${d.deviceString || d.deviceId}${d.active ? ' (active)' : ''}`).join('; '); } catch (e) { /* ignore */ }
  const mem = app.getAppMetrics().reduce((a, m) => a + m.memory.workingSetSize, 0) / 1024;
  return [
    `TACTIQ ANALYST ${app.getVersion()} (Electron ${process.versions.electron}, Chrome ${process.versions.chrome}, Node ${process.versions.node})`,
    `Windows/OS: ${process.platform} ${os.release()} ${process.arch} · ${Math.round(os.totalmem() / 1073741824 * 10) / 10} GB RAM (${Math.round(os.freemem() / 1073741824 * 10) / 10} GB free) · ${os.cpus().length} threads · ${(os.cpus()[0] || {}).model || ''}`,
    `Graphics: ${gpuInfo || 'unknown'} · WebGL ${gpu.webgl} · video decode ${gpu.video_decode}`,
    `App memory now: ${Math.round(mem)} MB · ffmpeg ${ffmpegPath() ? 'OK' : 'MISSING'} · voice model ${modelFile() ? 'OK' : 'MISSING'} · AI models ${aiModelPath('yolo11n.onnx') ? 'fast OK' : 'fast MISSING'}, ${aiModelPath('yolo11s.onnx') ? 'accurate OK' : 'accurate MISSING'}`,
    `Settings folder: ${app.getPath('userData')}`,
    `Previous session closed properly: ${startState.crashed ? 'NO' : 'yes'}`,
    '', '--- last log lines ---', ...readLogTail(80)
  ].join('\n');
});
// automatic crash copies of the work: <settings folder>/recovery/<key>.light.json (+ .tracks.json for tracking data)
const recDir = () => path.join(app.getPath('userData'), 'recovery');
const recBase = key => path.join(recDir(), require('crypto').createHash('sha1').update(String(key)).digest('hex').slice(0, 20));
const recQueue = new Map();
function recWriteFile(file, text) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
ipcMain.handle('recovery-write', async (e, { key, light, tracks }) => {
  const prev = recQueue.get(key) || Promise.resolve();
  const job = prev.then(async () => {
    fs.mkdirSync(recDir(), { recursive: true }); const b = recBase(key);
    if (tracks != null) { await fs.promises.writeFile(b + '.tracks.json.tmp', tracks); await fs.promises.rename(b + '.tracks.json.tmp', b + '.tracks.json'); }
    if (light != null) { await fs.promises.writeFile(b + '.light.json.tmp', light); await fs.promises.rename(b + '.light.json.tmp', b + '.light.json'); }
  }).catch(err => logLine('error', 'main', 'crash copy not written: ' + err.message));
  recQueue.set(key, job); await job; if (recQueue.get(key) === job) recQueue.delete(key);
  return true;
});
ipcMain.on('recovery-write-sync', (e, { key, light, tracks }) => {
  try { fs.mkdirSync(recDir(), { recursive: true }); const b = recBase(key); if (tracks != null) recWriteFile(b + '.tracks.json', tracks); if (light != null) recWriteFile(b + '.light.json', light); }
  catch (err) { logLine('error', 'main', 'crash copy not written: ' + err.message); }
  e.returnValue = true;
});
ipcMain.handle('recovery-read', async (e, key) => {
  const b = recBase(key), rd = f => fs.promises.readFile(f, 'utf8').catch(() => null);
  const [light, tracks] = await Promise.all([rd(b + '.light.json'), rd(b + '.tracks.json')]);
  return light ? { light, tracks } : null;
});
ipcMain.handle('recovery-clear', async (e, key) => { const b = recBase(key); [b + '.light.json', b + '.tracks.json'].forEach(f => { try { fs.rmSync(f, { force: true }); } catch (err) { /* ignore */ } }); return true; });
ipcMain.handle('recovery-list', async () => {
  let files = []; try { files = fs.readdirSync(recDir()).filter(f => f.endsWith('.light.json')); } catch (e) { return []; }
  return files.map(f => {
    try { const o = JSON.parse(fs.readFileSync(path.join(recDir(), f), 'utf8')); return { key: o.key, savedAt: o.savedAt, projectFile: o.projectFile || null, projectName: o.projectName || '', events: (o.events || []).length, video: o.video && o.video.name || '', points: o.points || 0 }; }
    catch (e) { return null; }
  }).filter(x => x && x.key).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
});

/* ------------------------------------------------------------------ UPDATE CHECK (GitHub releases of this app) */
ipcMain.handle('check-update', async () => {
  const url = process.env.TACTIQ_UPDATE_URL || 'https://api.github.com/repos/AmartyaDasDip/voicetag/releases/latest';
  try {
    const { net } = require('electron');
    const r = await net.fetch(url, { headers: { 'User-Agent': 'TACTIQ-ANALYST/' + app.getVersion(), Accept: 'application/vnd.github+json' } });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
    const j = await r.json();
    const asset = (j.assets || []).find(a => /TACTIQ-ANALYST-Setup-([\d.]+)\.exe$/i.test(a.name));
    const latest = asset ? /Setup-([\d.]+)\.exe$/i.exec(asset.name)[1] : null;
    const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
    const res = { ok: true, current: app.getVersion(), latest, newer: !!latest && cmp(latest, app.getVersion()) > 0, page: j.html_url || 'https://github.com/AmartyaDasDip/voicetag/releases/latest', published: j.published_at };
    logLine('info', 'main', `update check: latest ${latest || '?'}${res.newer ? ' (newer than this version)' : ''}`);
    return res;
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle('cancel-export', async () => { if (currentExport) exporter.cancel(currentExport); return true; });

/* ------------------------------------------------------------------ PROJECT FOLDERS */
const PROJECT_DIRS = ['videos', 'clips', 'tracking_data', 'calibration', 'reports', 'screenshots', 'backups'];
const safeDir = s => String(s || 'Match').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Match';
ipcMain.handle('choose-directory', async (e, title) => {
  const r = await dialog.showOpenDialog(win, { title: title || 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('default-projects-dir', async () => path.join(app.getPath('documents'), 'TACTIQ ANALYST Projects'));
ipcMain.handle('create-project', async (e, { parentDir, name }) => {
  let dir = path.join(parentDir, safeDir(name)), n = 2;
  while (fs.existsSync(dir)) dir = path.join(parentDir, safeDir(name) + ' (' + (n++) + ')');
  fs.mkdirSync(dir, { recursive: true });
  PROJECT_DIRS.forEach(d => fs.mkdirSync(path.join(dir, d), { recursive: true }));
  return { dir, file: path.join(dir, 'project.tactiq') };
});
ipcMain.handle('write-project', async (e, { file, text, backup }) => {
  const dir = path.dirname(file);
  PROJECT_DIRS.forEach(d => { try { fs.mkdirSync(path.join(dir, d), { recursive: true }); } catch (err) { /* ignore */ } });
  if (backup && fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const bdir = path.join(dir, 'backups');
    fs.copyFileSync(file, path.join(bdir, 'project-' + stamp + '.tactiq'));
    const old = fs.readdirSync(bdir).filter(f => f.endsWith('.tactiq')).sort();
    old.slice(0, Math.max(0, old.length - 20)).forEach(f => { try { fs.unlinkSync(path.join(bdir, f)); } catch (err) { /* ignore */ } });
  }
  const tmp = file + '.tmp';
  await fs.promises.writeFile(tmp, text, 'utf8');
  await fs.promises.rename(tmp, file);   // atomic: a crash never leaves a half-written project
  return file;
});
ipcMain.handle('read-project', async (e, file) => {
  try { return { path: file, text: await fs.promises.readFile(file, 'utf8') }; } catch (err) { return { path: file, error: String(err.message || err) }; }
});
ipcMain.handle('list-backups', async (e, file) => {
  const bdir = path.join(path.dirname(file), 'backups');
  try { return fs.readdirSync(bdir).filter(f => f.endsWith('.tactiq')).sort().reverse().map(f => path.join(bdir, f)); } catch (err) { return []; }
});
ipcMain.handle('path-exists', async (e, p) => { try { return !!p && fs.existsSync(p); } catch (err) { return false; } });
ipcMain.handle('write-binary', async (e, { file, base64 }) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, Buffer.from(base64, 'base64'));
  return file;
});
ipcMain.handle('write-text', async (e, { file, text }) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, text, 'utf8');
  return file;
});
ipcMain.handle('copy-into-project', async (e, { src, projectDir }) => {
  const dest = path.join(projectDir, 'videos', path.basename(src));
  if (path.resolve(src) !== path.resolve(dest)) await fs.promises.copyFile(src, dest);
  allowedMedia.add(path.resolve(dest));
  return dest;
});
ipcMain.handle('probe-video', async (e, p) => {
  const ff = ffmpegPath();
  if (!ff || !p) return null;
  const r = await exporter.probe(ff, p);
  const st = fs.statSync(p);
  const rot = /rotate\s*:\s*(-?\d+)/.exec(r.text) || /rotation of (-?[\d.]+)/.exec(r.text);
  return { duration: r.duration, width: r.width, height: r.height, fps: r.fps, vcodec: r.vcodec, acodec: r.acodec,
    rotation: rot ? Number(rot[1]) : 0, size: st.size, ok: !!r.vcodec, warning: /Invalid data|corrupt|moov atom not found|error while decoding/i.test(r.text) ? 'The file may be damaged or incomplete.' : '' };
});
// ---------- AI player detection & tracking (runs in a background process) ----------
function aiModelPath(name) {
  const c = [path.join(process.resourcesPath || '', 'ai-models', name), path.join(__dirname, 'engine', 'models', name)];
  return c.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
}
let aiProc = null;
ipcMain.handle('ai-info', async () => {
  const os = require('os');
  const ramGB = os.totalmem() / 1073741824;
  return { fast: !!aiModelPath('yolo11n.onnx'), accurate: !!aiModelPath('yolo11s.onnx'), ffmpeg: !!ffmpegPath(),
    recommended: ramGB < 12 ? 'fast' : 'accurate', ramGB: Math.round(ramGB * 10) / 10, cores: os.cpus().length, gpu: process.platform === 'win32' };
});
ipcMain.handle('ai-analyse', async (e, o) => {
  if (aiProc) return { ok: false, error: 'An analysis is already running.' };
  const ff = ffmpegPath();
  if (!ff) return { ok: false, error: 'Video tools (ffmpeg) are missing.' };
  if (!o || !o.video || !allowedMedia.has(path.resolve(o.video))) return { ok: false, error: 'Open the video first.' };
  const model = aiModelPath(o.quality === 'accurate' ? 'yolo11s.onnx' : 'yolo11n.onnx') || aiModelPath('yolo11n.onnx');
  if (!model) return { ok: false, error: 'The AI model files are missing from this installation.' };
  const pr = await exporter.probe(ff, o.video);
  if (!pr.width || !pr.height) return { ok: false, error: 'Could not read the video size.' };
  const start = Math.max(0, Number(o.start) || 0);
  const duration = Math.max(0.5, Math.min(Number(o.duration) || (o.scan ? 1e9 : 10), (pr.duration || 1e9) - start));
  const script = path.join(__dirname, 'engine', 'worker.js').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (done) return; done = true; try { aiProc && aiProc.kill(); } catch (er) { /* gone */ } aiProc = null;
      if (r && r.ok === false && !/cancel/i.test(r.error || '')) logLine('error', 'ai', (o.scan ? 'shot scan' : 'analysis') + ' failed: ' + r.error);
      else if (r && r.ok) logLine('info', 'ai', `${o.scan ? 'shot scan' : 'analysis'} ok · ${r.meta && r.meta.provider} · ${r.meta && r.meta.frames} frames in ${r.meta && r.meta.seconds} s`);
      resolve(r); };
    try { aiProc = utilityProcess.fork(script, [], { serviceName: 'TACTIQ AI engine', stdio: 'pipe' }); }
    catch (er) { aiProc = null; return resolve({ ok: false, error: 'Could not start the AI engine: ' + er.message }); }
    let errText = '';
    if (aiProc.stderr) aiProc.stderr.on('data', d => { errText = (errText + d).slice(-2000); });
    aiProc.on('message', m => {
      if (!m) return;
      if (m.type === 'progress') { try { e.sender.send('ai-progress', m); } catch (er) { /* window closed */ } }
      else if (m.type === 'result') finish(m.result);
      else if (m.type === 'error') finish({ ok: false, error: m.error });
    });
    aiProc.on('exit', code => finish({ ok: false, error: 'The AI engine stopped unexpectedly (code ' + code + '). ' + errText.slice(-400) }));
    aiProc.postMessage({ cmd: o.scan ? 'scan' : 'run', opts: { ffmpeg: ff, video: o.video, start, duration, srcW: pr.width, srcH: pr.height, fps: pr.fps || 25,
      model, stride: Math.max(1, Math.min(5, Number(o.stride) || 2)), prefer: o.cpuOnly ? 'cpu' : 'auto',
      ball: ['off', 'normal', 'zoom'].includes(o.ball) ? o.ball : 'normal', sampleEvery: Number(o.sampleEvery) || 2 } });
  });
});
ipcMain.handle('ai-cancel', async () => { if (aiProc) { try { aiProc.postMessage({ cmd: 'cancel' }); } catch (e) { /* gone */ } setTimeout(() => { try { aiProc && aiProc.kill(); } catch (e) { /* gone */ } }, 1500); } return true; });

ipcMain.handle('system-info', async () => {
  const os = require('os');
  return { platform: process.platform, release: os.release(), arch: process.arch, ramGB: Math.round(os.totalmem() / 1073741824 * 10) / 10,
    freeRamGB: Math.round(os.freemem() / 1073741824 * 10) / 10, cpu: (os.cpus()[0] || {}).model || '', cores: os.cpus().length };
});
