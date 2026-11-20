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

const RENDERER_DIR = path.join(__dirname, 'renderer');
// keep settings, tags and season data from the VoiceTag versions
app.setName('TACTIQ ANALYST');
app.setPath('userData', path.join(app.getPath('appData'), 'VoiceTag'));
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
}

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
if (!app.requestSingleInstanceLock()) app.quit();
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
ipcMain.handle('open-text-file', async (e, { filters }) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
  if (r.canceled || !r.filePaths[0]) return null;
  return { path: r.filePaths[0], text: await fs.promises.readFile(r.filePaths[0], 'utf8') };
});
ipcMain.handle('model-info', async () => ({ available: !!modelFile(), url: 'app://voicetag/model/model.tar.gz' }));
ipcMain.handle('ffmpeg-info', async () => ({ available: !!ffmpegPath() }));
ipcMain.handle('show-in-folder', async (e, p) => { if (p) shell.showItemInFolder(p); });

let currentExport = null;
ipcMain.handle('export-clips', async (e, opts) => {
  const ff = ffmpegPath();
  if (!ff) return { ok: false, error: 'ffmpeg is missing. Re-run BUILD.bat to rebuild the app.' };
  if (!opts.videoPath || !fs.existsSync(opts.videoPath)) return { ok: false, error: 'The source video file was not found: ' + opts.videoPath };
  let target;
  if (opts.mode === 'single') {
    const r = await dialog.showSaveDialog(win, { title: 'Save joined video', defaultPath: opts.defaultName || 'clips.mp4', filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    target = r.filePath;
  } else {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a folder for the clips', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    target = r.filePaths[0];
  }
  currentExport = exporter.createJob();
  try {
    const out = await exporter.exportClips({
      ffmpeg: ff, videoPath: opts.videoPath, clips: opts.clips, mode: opts.mode, quality: opts.quality, target,
      tempRoot: app.getPath('temp'), job: currentExport,
      onProgress: p => { try { e.sender.send('export-progress', p); } catch (err) { /* window gone */ } }
    });
    return { ok: true, path: out };
  } catch (err) {
    return { ok: false, error: currentExport && currentExport.cancelled ? 'Export cancelled' : String(err.message || err) };
  } finally { currentExport = null; }
});
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
    return { ok: false, error: currentConvert && currentConvert.cancelled ? 'cancelled' : String(err.message || err) };
  } finally { currentConvert = null; }
});
ipcMain.handle('cancel-convert', async () => { if (currentConvert) exporter.cancel(currentConvert); return true; });
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
    const finish = r => { if (done) return; done = true; try { aiProc && aiProc.kill(); } catch (er) { /* gone */ } aiProc = null; resolve(r); };
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
