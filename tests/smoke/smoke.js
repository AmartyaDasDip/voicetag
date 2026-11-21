// End-to-end smoke test of the BUILT app – run by the Windows build on the installed TACTIQ ANALYST before the
// installer is published. It drives the real program (window, ffmpeg, voice model, AI engine, 3D) with Playwright.
//   node tests/smoke/smoke.js "<path to TACTIQ ANALYST.exe>"
//   node tests/smoke/smoke.js node_modules/electron/dist/electron .      (from the source folder, for development)
'use strict';
const { _electron: electron } = require('playwright-core');
const path = require('path'), fs = require('fs'), os = require('os'), { execFileSync } = require('child_process');
const EXE = process.argv[2], APPDIR = process.argv[3] || null;
if (!EXE) { console.error('usage: node tests/smoke/smoke.js <exe> [app folder]'); process.exit(2); }
const REPO = path.resolve(__dirname, '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const WORK = path.join(os.tmpdir(), 'tactiq-smoke'), MEDIA = path.join(WORK, 'media'), OUT = path.join(WORK, 'out'), PROJ = path.join(WORK, 'projects'), UD = path.join(WORK, 'settings');
const VOICE = path.join(__dirname, 'voice.wav');
const FF = require('ffmpeg-static');
const GH = !!process.env.GITHUB_ACTIONS;
const results = [], timings = {};
const T0 = Date.now();
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info: String(info) });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  — ' + String(info).slice(0, 400) : ''));
  if (!ok && GH) console.log(`::error title=Smoke test::${name} — ${String(info).replace(/\r?\n/g, ' ').slice(0, 300)}`);
}
const note = (k, v) => { timings[k] = v; console.log('INFO ' + k + ': ' + (typeof v === 'string' ? v : JSON.stringify(v))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const probe = f => { try { execFileSync(FF, ['-hide_banner', '-i', f], { stdio: 'pipe' }); } catch (e) { const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(String(e.stderr)); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0; } return 0; };

// ---------------------------------------------------------------- test media made with the app's own ffmpeg
function makeMedia() {
  fs.rmSync(WORK, { recursive: true, force: true }); [MEDIA, OUT, PROJ, UD].forEach(d => fs.mkdirSync(d, { recursive: true }));
  const ff = args => execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(MEDIA, 'match.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=720x576:rate=25:duration=5', '-f', 'lavfi', '-i', 'sine=duration=5', '-c:v', 'mpeg2video', '-q:v', '4', '-c:a', 'mp2', '-f', 'mpegts', path.join(MEDIA, 'camcorder.mts')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=25:duration=5', '-f', 'lavfi', '-i', 'sine=duration=5', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'pcm_s16le', path.join(MEDIA, 'old.avi')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=5', '-c:v', 'libvpx', '-b:v', '600k', path.join(MEDIA, 'web.webm')]);
}

// ---------------------------------------------------------------- start the app
async function launch() {
  const args = [];
  if (process.platform === 'linux') args.push('--no-sandbox');
  args.push('--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + VOICE);
  if (APPDIR) args.push(path.resolve(APPDIR));
  const env = Object.assign({}, process.env, { TACTIQ_USERDATA: UD, ELECTRON_ENABLE_LOGGING: '1' });
  if (process.platform === 'linux') env.HOME = path.join(WORK, 'home');
  const t0 = Date.now();
  const app = await electron.launch({ executablePath: EXE, args, env, timeout: 120000 });
  await app.evaluate(({ dialog, shell }) => {
    shell.showItemInFolder = () => {}; shell.openPath = async () => ''; shell.openExternal = async () => {};
    global.__open = []; global.__save = [];
    dialog.showOpenDialog = async () => { const p = global.__open.shift(); return p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] }; };
    dialog.showSaveDialog = async () => { const p = global.__save.shift(); return p ? { canceled: false, filePath: p } : { canceled: true }; };
    dialog.showMessageBox = async () => ({ response: 0 });
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.waitForLoadState('domcontentloaded');
  const h = {
    app, page, errors, started: t0,
    open: p => app.evaluate((_, p) => global.__open.push(p), p),
    save: p => app.evaluate((_, p) => global.__save.push(p), p),
    ev: (fn, arg) => page.evaluate(fn, arg),
    wait: ms => page.waitForTimeout(ms),
    async waitFor(fn, ms = 20000, arg) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await page.evaluate(fn, arg)) return true; } catch (e) { /* busy */ } await page.waitForTimeout(250); } return false; },
    async shot(name) { const f = path.join(OUT, name + '.jpg'); await page.screenshot({ path: f, type: 'jpeg', quality: 35 }).catch(() => {}); if (GH && fs.existsSync(f)) console.log('SMOKE-SHOT ' + name + ' ' + fs.readFileSync(f).toString('base64')); },
    async close() { const pr = app.process(); const t = setTimeout(() => { try { pr.kill(); } catch (e) { /* gone */ } }, 10000); try { await app.close(); } catch (e) { /* ignore */ } clearTimeout(t); }
  };
  return h;
}
const step = async (name, fn) => { const t = Date.now(); try { await fn(); } catch (e) { check(name + ' (crashed)', false, e.stack || e.message); } note('time ' + name, ((Date.now() - t) / 1000).toFixed(1) + ' s'); };

(async () => {
  makeMedia();
  note('platform', `${process.platform} ${os.release()} · ${Math.round(os.totalmem() / 1073741824)} GB RAM · ${os.cpus().length} threads · ${(os.cpus()[0] || {}).model || ''}`);
  let h = await launch(); let page = h.page; let projFile = null;
  await step('start', async () => {
    const ok = await h.waitFor(() => !document.querySelector('#dash').classList.contains('hidden'), 60000);
    note('startup to dashboard', ((Date.now() - h.started) / 1000).toFixed(1) + ' s');
    check('app starts and shows the dashboard', ok);
    check('version ' + PKG.version, (await h.ev(() => document.querySelector('#dashVer').textContent)).includes(PKG.version), await h.ev(() => document.querySelector('#dashVer').textContent));
    const d = await h.app.evaluate(async ({ app }) => { const g = app.getGPUFeatureStatus(); let dev = ''; try { const i = await app.getGPUInfo('basic'); dev = (i.gpuDevice || []).map(x => x.deviceString || x.deviceId).join('; '); } catch (e) { /* ignore */ } return { webgl: g.webgl, video: g.video_decode, dev, userData: app.getPath('userData'), exe: process.execPath }; });
    note('graphics', d); check('settings in the test folder', path.resolve(d.userData) === path.resolve(UD), d.userData);
    await h.shot('01-dashboard');
  });
  await step('project', async () => {
    await page.click('#dNew'); await h.wait(400);
    await page.fill('#pfName', 'Smoke test'); await page.fill('#pfHome', 'Blue'); await page.fill('#pfAway', 'Red');
    await h.open(PROJ); await page.click('#pfDirBtn'); await h.wait(300);
    await h.open(path.join(MEDIA, 'match.mp4')); await page.click('#pfVidBtn'); await h.wait(300);
    const copy = await page.$('#pfCopy'); if (copy) await copy.check();
    await page.click('#dlgFoot .primary');
    const ok = await h.waitFor(() => typeof hasVideo === 'function' && hasVideo() && video.readyState >= 2 && project.file, 60000);
    check('new project with its video', ok);
    projFile = await h.ev(() => project.file);
    const dir = path.dirname(projFile || '');
    check('project folders', ['videos', 'clips', 'tracking_data', 'calibration', 'reports', 'screenshots', 'backups'].every(s => fs.existsSync(path.join(dir, s))), dir);
    await h.ev(() => { video.currentTime = 2; video.play(); }); await h.wait(1500);
    check('video plays', await h.ev(() => video.currentTime > 2.5 && !video.paused), await h.ev(() => video.currentTime));
    await h.ev(() => video.pause());
  });
  await step('tagging', async () => {
    await h.ev(() => { video.currentTime = 5; document.activeElement.blur(); }); await h.wait(300);
    await page.keyboard.press('p'); await h.wait(200);
    await h.ev(() => { video.currentTime = 8; }); await h.wait(300);
    await page.fill('#cmdInput', 'nine shot on target'); await page.press('#cmdInput', 'Enter'); await h.wait(300);
    await h.ev(() => { video.currentTime = 10; document.activeElement.blur(); }); await h.wait(300); await page.keyboard.press('b');
    await h.ev(() => { video.currentTime = 14; }); await h.wait(300); await page.keyboard.press('b'); await h.wait(300);
    const ev = await h.ev(() => events.map(e => [e.code, e.num, e.outcome, Math.round(e.t * 10) / 10]));
    check('tags by key, typed command and a phase', ev.length === 3 && ev.some(e => e[0] === 'Shot' && String(e[1]) === '9'), JSON.stringify(ev));
  });
  await step('voice', async () => {
    await h.ev(() => { video.muted = true; video.currentTime = 15; document.activeElement.blur(); });
    await page.keyboard.press('F9');
    const ready = await h.waitFor(() => { const t = document.querySelector('#btnMic').textContent; return /listening|on/i.test(t) && !/loading/i.test(t); }, 120000);
    check('voice engine starts (offline model)', ready, await h.ev(() => document.querySelector('#btnMic').textContent));
    await h.ev(() => video.play()); await h.wait(13000); await h.ev(() => video.pause());
    await page.keyboard.press('F9');
    const ev = await h.ev(() => events.filter(e => e.source === 'voice').map(e => [e.code, e.num, e.outcome]));
    const heard = await h.ev(() => voiceLog.slice(0, 6).map(l => l.heard + ' → ' + l.result));
    check('spoken “right back pass unsuccessful” → tag', ev.some(e => e[0] === 'Pass' && String(e[1]) === '2' && e[2] === 'Unsuccessful'), JSON.stringify(ev) + ' | ' + heard.join(' | '));
    check('spoken “nine shot on target” → tag', ev.some(e => e[0] === 'Shot' && String(e[1]) === '9' && e[2] === 'On Target'), JSON.stringify(ev));
    await h.shot('02-tagging');
  });
  await step('save', async () => {
    await page.keyboard.press('Control+s'); await h.wait(1500);
    const p = JSON.parse(fs.readFileSync(projFile, 'utf8'));
    check('project saved with its tags', p.events.length === await h.ev(() => events.length), p.events.length);
    await page.click('#btnShot'); await h.wait(1500);
    check('screenshot in the project', fs.readdirSync(path.join(path.dirname(projFile), 'screenshots')).length === 1);
  });
  await step('video export', async () => {
    await page.click('[data-tab=playlist]'); await h.wait(600);
    const f = path.join(OUT, 'highlights.mp4'); await h.save(f); await page.click('#plExportOne');
    const ok = await h.waitFor(() => document.querySelector('#plProgress').classList.contains('hidden') && !document.querySelector('#plExportOne').disabled, 300000);
    const d = fs.existsSync(f) ? probe(f) : 0;
    check('highlight video (title cards, clips) made with ffmpeg', ok && d > 10, d + ' s');
  });
  await step('report', async () => {
    const f = path.join(OUT, 'report.pdf'); await h.save(f); await h.ev(() => document.querySelector('#btnReport').click());
    let ok = false; for (let i = 0; i < 60 && !ok; i++) { await sleep(500); ok = fs.existsSync(f) && fs.statSync(f).size > 5000; }
    check('PDF match report', ok && fs.readFileSync(f).slice(0, 4).toString() === '%PDF', ok ? fs.statSync(f).size + ' bytes' : 'missing');
  });
  await step('ai', async () => {
    await page.click('[data-tab=track]'); await h.wait(600);
    await h.ev(() => { video.currentTime = 2; });
    await page.click('#aiRun'); await h.wait(800);
    await page.check('input[name=aiRange][value=next]'); await page.fill('#aiSecs', '4');
    await page.selectOption('#aiQ', 'fast'); await page.selectOption('#aiStride', '2');
    const t = Date.now();
    await page.click('#dlgFoot .primary');
    const done = await h.waitFor(() => AI.last || /failed/i.test(document.querySelector('#dlgTitle').textContent), 600000);
    const r = await h.ev(() => AI.last ? { ok: AI.last.result.ok, meta: AI.last.result.meta } : { error: document.querySelector('#dlgBody').innerText });
    note('ai', r);
    check('AI engine runs on this PC (model, ffmpeg frames, ' + (r.meta && r.meta.provider || '?') + ')', done && r.ok && r.meta && r.meta.frames > 0, JSON.stringify(r) + ' ' + ((Date.now() - t) / 1000).toFixed(1) + ' s');
    await page.keyboard.press('Escape'); await h.wait(400);
    await page.click('#shScan'); await h.wait(500); await page.click('#dlgFoot .primary');
    check('camera-shot scan', await h.waitFor(() => !SHOTS.running && (TR.shots || []).length >= 1, 300000), await h.ev(() => (TR.shots || []).length));
  });
  await step('3d', async () => {
    await page.click('#btn3D');
    const ok = await h.waitFor(() => V3.open && (V3.gl || V3.failed), 60000);
    const st = await h.ev(() => { const g = V3.gl && V3.gl.getContext(), e = g && g.getExtension('WEBGL_debug_renderer_info'); return { failed: V3.failed, renderer: g ? (e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)) : '' }; });
    note('3d renderer', st);
    check('3D view works (WebGL)', ok && !st.failed, JSON.stringify(st));
    await h.wait(1500); await h.shot('03-3d');
    const f = path.join(OUT, 'replay3d.mp4'); await h.save(f);
    await page.click('#p3replayBtn'); await h.wait(500);
    await page.check('input[name=v3r][value=custom]'); await page.fill('#v3rFrom', '00:02'); await page.fill('#v3rTo', '00:04');
    await page.click('#dlgFoot button:has-text("Save as MP4")'); await h.wait(500);
    await h.waitFor(() => !V3.exporting, 300000);
    const d = fs.existsSync(f) ? probe(f) : 0;
    check('3D replay saved as MP4', Math.abs(d - 2.03) < 0.15, d + ' s');
    await page.click('#p3close');
  });
  await step('annotations', async () => {
    // 3.1: AI result imported (who is who), an annotation that follows a player, burnt into an MP4 by ffmpeg
    // the test video has no real players: the import must work anyway, then a hand-made track is annotated
    const n = await h.ev(() => { if (!AI.last) return -1; aiImport(AI.last.result, { A: 'Home', B: 'Away', other: 'Neutral', min: 0.5, ball: true, keepOff: false, replace: true }); return TR.tracks.filter(t => t.kind === 'player').length; });
    check('AI result imported (who is who)', n >= 0, n);
    const a = await h.ev(() => { let tk = TR.tracks.find(t => t.kind === 'player' && t.points.length > 3);
      if (!tk) { tk = newTrack({ team: 'Home', label: 'H1' }); for (let k = 0; k <= 12; k++) tk.points.push({ t: 1 + k * 0.25, x: 0.3 + k * 0.03, y: 0.6, src: 'manual', vis: 'v' }); }
      const t0 = tk.points[0].t;
      // a simple pitch calibration, so the annotations have pitch positions (3D)
      if (!TR.cals.some(c => c.type !== 'none')) { const img = [[0.1, 0.3], [0.9, 0.3], [0.95, 0.95], [0.05, 0.95]], pit = [[20, 10], [85, 10], [85, 60], [20, 60]]; TR.cals.push({ id: 'smk', t: 0, type: 'hom', points: img.map((q, i) => ({ img: q, pitch: pit[i] })), H: solveHomography(img, pit) }); dataChanged(); }
      TR.anns = [{ id: 'sm1', type: 'spot', tracks: [tk.id], t0, t1: t0 + 2, color: '#ff4fd8', text: 'Smoke' }, { id: 'sm2', type: 'zone', tracks: [], zone: [40, 20, 60, 40], t0, t1: t0 + 2, color: '#ff4757', text: 'Zone' }]; video.pause(); video.currentTime = t0 + 0.5; return t0; });
    await h.wait(900);
    check('annotation drawn on the video', a != null && await h.ev(() => !document.querySelector('#annView').classList.contains('hidden') && annActive(video.currentTime).length === 2));
    await h.shot('04-annotations');
    const f = path.join(OUT, 'annotated.mp4'); await h.save(f);
    const r = a == null ? null : await h.ev(t0 => annRender(t0, t0 + 1.5, { tags: true, sound: true, size: 720 }).then(x => x && { ok: x.ok, error: x.error }), a);
    const d = fs.existsSync(f) ? probe(f) : 0;
    check('video with annotations saved as MP4', r && r.ok && Math.abs(d - 1.5) < 0.2, JSON.stringify(r) + ' ' + d + ' s');
    // 3.2: the same annotations as 3D objects (light beam, zone walls) in the 3D view
    if (a != null) {
      await h.ev(t0 => { video.currentTime = t0 + 0.5; }, a); await h.wait(500);
      await page.click('#btn3D'); await h.waitFor(() => V3.open && (V3.gl || V3.failed), 60000); await h.wait(1500);
      const n3 = await h.ev(() => typeof A3 !== 'undefined' ? [...A3.objs.values()].filter(o => o.g.visible).length : -1);
      check('annotations drawn in 3D', n3 >= 1, n3); await h.shot('05-annotations-3d');
      await page.click('#p3close');
      // 3.3: the annotations drawn into the playlist export (a transparent layer ffmpeg lays over the clip)
      const clip = await h.ev(() => { const e = events.slice().sort((x, y) => x.t - y.t)[0]; PL.excluded = new Set(events.filter(x => x !== e).map(x => x.id)); return { s: e.start, e: e.end }; });
      await page.click('[data-tab=playlist]'); await h.wait(500);
      await h.ev(() => { ['#plTitle', '#plCaption', '#plDraw'].forEach(s => { document.querySelector(s).checked = false; }); document.querySelector('#plAnn').checked = true; });
      const exp = async (file, ann) => {
        await h.ev(v => { document.querySelector('#plAnn').checked = v; }, ann); await h.save(file); await page.click('#plExportOne');
        await h.waitFor(() => document.querySelector('#plProgress').classList.contains('hidden') && !document.querySelector('#plExportOne').disabled, 300000);
        return fs.existsSync(file) ? probe(file) : 0;
      };
      const fa = path.join(OUT, 'clip-annotated.mp4'), fb = path.join(OUT, 'clip-plain.mp4');
      const da = await exp(fa, true), db = await exp(fb, false);
      const at = a + 0.5 - clip.s;
      const px = f => execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', f, '-frames:v', '1', '-vf', 'scale=320:180', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 });
      let changed = 0;
      if (da && db) { const A = px(fa), B = px(fb); for (let i = 0; i < Math.min(A.length, B.length); i += 3) if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 60) changed++; }
      check('playlist export with the annotations drawn in', da > 1 && Math.abs(da - db) < 0.2 && changed > 120, JSON.stringify({ da, db, clip, at: +at.toFixed(2), changed }));
      check('no temporary annotation layers left', !fs.readdirSync(os.tmpdir()).some(x => /^tactiq-ann-/.test(x)));
      await h.ev(() => { PL.excluded = new Set(); renderPlaylist(); });
    }
  });
  await step('memory', async () => {
    const mb = await h.app.evaluate(({ app }) => Math.round(app.getAppMetrics().reduce((s, p) => s + p.memory.workingSetSize, 0) / 1024));
    note('memory (all processes)', mb + ' MB'); check('memory use fits an 8 GB PC', mb < 2500, mb + ' MB');
    check('no errors in the window', !h.errors.length, h.errors.join(' | '));
  });
  await step('update check', async () => {
    const r = await h.ev(() => api.checkUpdate());
    note('update check', r);
    check('update check reaches GitHub', r && r.ok && /^\d+\.\d+\.\d+$/.test(r.latest || ''), JSON.stringify(r));
  });
  await step('close and reopen', async () => {
    await h.close(); await sleep(1500);
    check('closed cleanly (no crash marker)', !fs.existsSync(path.join(UD, 'running.lock')));
    h = await launch(); page = h.page;
    await h.waitFor(() => !document.querySelector('#dash').classList.contains('hidden'), 60000);
    check('no restore question after a clean close', await h.ev(() => document.querySelector('#dlg').classList.contains('hidden')));
    await h.open(projFile); await page.click('#dOpen');
    check('project reopens with tags and video', await h.waitFor(() => hasVideo() && video.readyState >= 2 && events.length >= 5, 60000), await h.ev(() => events.length));
  });
  await step('crash recovery', async () => {
    await h.ev(() => { video.currentTime = 20; }); await h.wait(300);
    await page.fill('#cmdInput', 'seven dribble'); await page.press('#cmdInput', 'Enter'); await h.wait(1500);
    const n = await h.ev(() => events.length);
    // a hard kill of the whole app (like a power cut or "End task" in Task Manager)
    const pid = h.app.process().pid;
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'pipe' }); } catch (e) { /* already gone */ } }
    else { try { h.app.process().kill('SIGKILL'); } catch (e) { /* gone */ } }
    for (let i = 0; i < 30; i++) { await sleep(500); if (process.platform !== 'win32') break; try { if (!/TACTIQ ANALYST\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq TACTIQ ANALYST.exe'], { stdio: 'pipe' }).toString())) break; } catch (e) { break; } }
    await sleep(1500);
    try { h = await launch(); } catch (e) { console.log('INFO relaunch failed once: ' + e.message.split('\n')[0]); await sleep(4000); h = await launch(); }
    page = h.page;
    const asked = await h.waitFor(() => !document.querySelector('#dlg').classList.contains('hidden') && /did not close properly/.test(document.querySelector('#dlgTitle').textContent), 60000);
    check('after the app was killed it offers to restore the work', asked);
    if (asked) { await page.click('#dlgFoot .primary'); check('unsaved tag restored', await h.waitFor(n => project.file && events.length === n, 60000, n), await h.ev(() => events.length)); }
    const logs = fs.existsSync(path.join(UD, 'logs')) ? fs.readdirSync(path.join(UD, 'logs')).map(f => fs.readFileSync(path.join(UD, 'logs', f), 'utf8')).join('') : '';
    check('log file written', /start TACTIQ ANALYST/.test(logs) && /did not close properly/.test(logs), logs.split('\n').slice(-4).join(' / '));
  });
  await step('formats', async () => {
    await h.ev(() => showDashboard()); await h.wait(300); await page.click('#dQuick'); await h.wait(300);
    for (const f of ['camcorder.mts', 'old.avi', 'web.webm']) {
      await h.open(path.join(MEDIA, f)); await page.click('#btnLoad');
      await h.wait(800); if (await h.ev(() => !document.querySelector('#dlg').classList.contains('hidden'))) await page.click('#dlgFoot .primary').catch(() => {});
      const ok = await h.waitFor(n => videoInfo && videoInfo.name === n && video.readyState >= 2 && video.duration > 4, 180000, f);
      let plays = false; if (ok) { await h.ev(() => { video.currentTime = 1; video.play(); }); await h.wait(1200); plays = await h.ev(() => video.currentTime > 1.3); await h.ev(() => video.pause()); }
      check('opens and plays ' + f, ok && plays, await h.ev(() => JSON.stringify({ name: videoInfo.name, d: video.duration, play: videoInfo.playPath })));
    }
  });
  await h.close();
  const failed = results.filter(r => !r.ok);
  const total = ((Date.now() - T0) / 1000).toFixed(0);
  console.log(`\n${results.length - failed.length}/${results.length} passed in ${total} s`);
  failed.forEach(r => console.log('  ✗ ' + r.name + ' — ' + r.info.slice(0, 300)));
  fs.writeFileSync(path.join(OUT, 'smoke-results.json'), JSON.stringify({ results, timings }, null, 1));
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Smoke test of the installed app: ${results.length - failed.length}/${results.length} passed (${total} s)\n\n| | Check | Details |\n|---|---|---|\n` +
      results.map(r => `| ${r.ok ? '✅' : '❌'} | ${r.name} | ${r.info.replace(/\|/g, '/').replace(/\r?\n/g, ' ').slice(0, 160)} |`).join('\n') + '\n\n' +
      Object.entries(timings).map(([k, v]) => `- **${k}**: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n') + '\n');
  }
  if (GH) console.log(`::notice title=Smoke test::${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
