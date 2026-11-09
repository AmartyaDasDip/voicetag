'use strict';
/* =====================================================================
   VoiceTag app: video, tagging, voice, code window, events, timeline
   ===================================================================== */
const HOOKS = { render: [], afterTag: [], tick: [] };

/* ---------------------------------------------------------------- STATE */
let events = [];
let nextId = 1;
let seq = 0;
let open = {};               // running phase codes: codeId -> {t, seq, player, outcome, labels, source, heard}
let target = { kind: null, id: null, seq: 0 };
let undoStack = [];
let voiceLog = [];
let sessionKey = 'vt_session_default';
let videoInfo = { path: '', name: '', size: 0, playPath: '' };
let lastNewId = null;
let lastPlayerId = '';
let locAsk = null;            // {id, stage:'start'|'end'} while waiting for a pitch click
function EMPTY_MATCH() { return { info: { date: '', opponent: '', competition: '', venue: 'Home', notes: '' }, kickoffs: {}, ends: {}, squad: {}, subs: [] }; }
let match = EMPTY_MATCH();
const live = { on: false, running: false, base: 0, startedAt: 0 };

/* ---------------------------------------------------------------- TIME */
const video = $('#video');
const hasVideo = () => !!video.getAttribute('src');
function liveTime() { return live.base + (live.running ? (performance.now() - live.startedAt) / 1000 : 0); }
function curT() { return live.on && !hasVideo() ? liveTime() : (video.currentTime || 0); }
function videoSnap() {
  if (live.on && !hasVideo()) return { t: liveTime(), playing: live.running, rate: 1 };
  return { t: video.currentTime || 0, playing: !!(hasVideo() && !video.paused), rate: video.playbackRate || 1 };
}
const PERIODS = ['1', '2', 'ET1', 'ET2'];
const PERIOD_BASE = { '1': 0, '2': 45, ET1: 90, ET2: 105 };
const PERIOD_LEN = { '1': 45, '2': 45, ET1: 15, ET2: 15 };
const PERIOD_NAME = { '1': '1st', '2': '2nd', ET1: 'ET1', ET2: 'ET2' };
function periodOf(t) {
  let best = null;
  PERIODS.forEach(p => { const k = match.kickoffs[p]; if (k != null && k <= t + 0.001 && (best === null || k >= match.kickoffs[best])) best = p; });
  return best;
}
function evPeriod(ev) { return periodOf(ev.t) || ev.period || ''; }
// "23:14" or "45+02:10"
function matchClock(t) {
  const p = periodOf(t);
  if (!p) return '';
  const el = t - match.kickoffs[p], nominal = PERIOD_LEN[p] * 60, base = PERIOD_BASE[p] * 60;
  if (el <= nominal) return fmtTime(base + el);
  return fmtTime(base + nominal).replace(/:00$/, '') + '+' + fmtTime(el - nominal);
}
function matchMinute(t) {
  const p = periodOf(t);
  if (!p) return '';
  const el = t - match.kickoffs[p];
  const m = Math.floor(el / 60) + 1;
  return m > PERIOD_LEN[p] ? (PERIOD_BASE[p] + PERIOD_LEN[p]) + '+' + (m - PERIOD_LEN[p]) : String(PERIOD_BASE[p] + m);
}
function updateLiveClockUI() {
  const el = $('#liveClock');
  const show = live.on && !hasVideo();
  el.classList.toggle('hidden', !show);
  if (show) el.innerHTML = `${fmtTime(liveTime())}<small>${live.running ? 'LIVE – clock running (Space = pause)' : 'Clock paused – press Space or ▶ to start'}</small>`;
  $('#btnLive').classList.toggle('on', live.on);
}

/* ---------------------------------------------------------------- VIDEO LOADING */
let checkingVideo = false;
function canPlayCurrent(timeoutMs = 12000) {
  return new Promise(resolve => {
    let done = false;
    const finish = ok => { if (done) return; done = true; clearTimeout(tm); video.removeEventListener('loadedmetadata', onMeta); video.removeEventListener('error', onErr); resolve(ok); };
    const onMeta = () => finish(video.videoWidth > 0);
    const onErr = () => finish(false);
    const tm = setTimeout(() => finish(video.readyState >= 1 && video.videoWidth > 0), timeoutMs);
    if (video.readyState >= 1) return finish(video.videoWidth > 0);
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('error', onErr);
  });
}
async function loadVideo(info, keepTags) {
  if (!info) return;
  if (!api.isDesktop || !info.path) { setVideo(info, '', keepTags); return; }
  const cached = await api.cachedConversion(info.path);
  if (cached) { setVideo(info, cached, keepTags); return; }
  checkingVideo = true;
  setVideo(info, '', keepTags);
  const ok = await canPlayCurrent();
  checkingVideo = false;
  if (ok) return;
  video.removeAttribute('src'); video.load();
  $('#convBox').classList.remove('hidden');
  $('#convBar').style.width = '0%';
  $('#convText').textContent = 'Starting…';
  const r = await api.convertVideo(info.path);
  $('#convBox').classList.add('hidden');
  if (r.ok) {
    video.src = api.mediaUrl(r.path);
    videoInfo.playPath = r.path;
    $('#drop').classList.add('hidden');
    toast('Video ready' + (r.remuxed ? ' (quick re-wrap, no quality loss)' : ' (converted to MP4)'), 'ok', 3000);
  } else if (r.error === 'cancelled') toast('Conversion cancelled', 'info');
  else alert('This video could not be opened:\n\n' + r.error);
}
api.onConvertProgress(p => {
  $('#convBar').style.width = (p.percent || 0) + '%';
  $('#convText').textContent = p.duration ? `${p.percent}%  –  ${fmtTime(p.seconds || 0)} of ${fmtTime(p.duration)} converted` : 'Converting…';
});
$('#convCancel').onclick = () => api.cancelConvert();

function setVideo(info, playPath, keepTags) {
  if (!info) return;
  autosaveNow();
  video.src = info.url || api.mediaUrl(playPath || info.path);
  videoInfo = { path: info.path || '', name: info.name, size: info.size, playPath: playPath || '' };
  document.title = info.name + ' – VoiceTag';
  $('#drop').classList.add('hidden');
  if (keepTags) { renderAll(); return; }   // live session or project: keep the tags already loaded
  sessionKey = 'vt_session_' + (info.path || info.name) + '_' + info.size;
  events = []; undoStack = []; nextId = 1; open = {}; target = { kind: null, id: null, seq: 0 }; match = EMPTY_MATCH();
  try {
    const saved = JSON.parse(localStorage.getItem(sessionKey) || 'null');
    if (saved && saved.events && saved.events.length &&
        confirm('Found ' + saved.events.length + ' saved tags for "' + info.name + '".\n\nOK = restore them\nCancel = start a fresh session')) {
      events = saved.events; nextId = saved.nextId || (Math.max(0, ...events.map(e => e.id)) + 1);
      if (saved.match) match = Object.assign(EMPTY_MATCH(), saved.match);
    }
  } catch (e) { /* ignore */ }
  renderAll();
  toast('Loaded ' + info.name, 'info');
}
async function openVideo() {
  const r = await api.openVideo();
  if (!r) return;
  const keep = live.on && events.length && confirm('Keep the ' + events.length + ' live tags with this video?\n(Then use 📋 Match → Sync to line them up.)');
  if (keep) { live.on = false; live.running = false; updateLiveClockUI(); }
  loadVideo(r, keep);
}
$('#btnLoad').onclick = openVideo;
const wrapEl = $('#videoWrap');
wrapEl.addEventListener('dragover', e => { e.preventDefault(); $('#drop').classList.add('over'); });
wrapEl.addEventListener('dragleave', () => $('#drop').classList.remove('over'));
wrapEl.addEventListener('drop', async e => {
  e.preventDefault(); $('#drop').classList.remove('over');
  const f = [...e.dataTransfer.files][0];
  if (!f) return;
  if (api.isDesktop) { const r = await api.registerMedia(api.pathForFile(f)); if (r) loadVideo(r); }
  else setVideo({ path: '', name: f.name, size: f.size, url: URL.createObjectURL(f) });
});
video.addEventListener('error', () => { if (!checkingVideo && hasVideo()) toast('This video could not be played.', 'bad', 5000); });

function togglePlay() {
  if (live.on && !hasVideo()) {
    if (live.running) { live.base = liveTime(); live.running = false; } else { live.startedAt = performance.now(); live.running = true; }
    updateLiveClockUI(); return;
  }
  if (!hasVideo()) return;
  video.paused ? video.play() : video.pause();
}
function seek(d) {
  if (live.on && !hasVideo()) { live.base = Math.max(0, liveTime() + d); live.startedAt = performance.now(); updateLiveClockUI(); return; }
  if (!hasVideo()) return;
  video.currentTime = clamp(video.currentTime + d, 0, video.duration || 1e9);
}
$('#btnPlay').onclick = togglePlay;
$('#btnBack5').onclick = () => seek(-5);
$('#btnFwd5').onclick = () => seek(5);
video.addEventListener('click', togglePlay);
$('#selSpeed').onchange = e => { video.playbackRate = Number(e.target.value); };
video.addEventListener('ratechange', () => { $('#selSpeed').value = String(video.playbackRate); });
video.addEventListener('play', () => $('#btnPlay').textContent = '⏸ Pause');
video.addEventListener('pause', () => $('#btnPlay').textContent = '▶ Play');
video.addEventListener('loadedmetadata', () => { renderTimeline(); });
$('#btnLive').onclick = () => {
  if (hasVideo() && !live.on) { alert('Live mode is for tagging without a video (e.g. from the touchline).\nClose the video first, or just tag the video normally.'); return; }
  live.on = !live.on;
  if (live.on) { live.base = live.base || 0; live.running = false; $('#drop').classList.add('hidden'); toast('Live mode: press Space / ▶ to start the clock', 'info', 3500); }
  else { live.running = false; if (!hasVideo()) $('#drop').classList.remove('hidden'); }
  updateLiveClockUI(); renderAll();
};

/* ---------------------------------------------------------------- MATCH CLOCK BUTTONS */
$('#btnKickoff').onclick = () => {
  const p = $('#selPeriod').value, t = curT();
  match.kickoffs[p] = Math.round(t * 100) / 100;
  toast(`Kick-off ${PERIOD_NAME[p]} half marked at ${fmtTime(t)}`, 'info');
  autosave(); renderAll();
};
$('#btnEndPeriod').onclick = () => {
  const p = $('#selPeriod').value, t = curT();
  if (match.kickoffs[p] == null) { alert('Mark the kick-off of this period first.'); return; }
  match.ends[p] = Math.round(t * 100) / 100;
  toast(`End of ${PERIOD_NAME[p]} marked (${matchClock(t)})`, 'info');
  const next = PERIODS[PERIODS.indexOf(p) + 1];
  if (next && p !== '2') $('#selPeriod').value = next;
  if (p === '1') $('#selPeriod').value = '2';
  autosave(); renderAll();
};

/* ---------------------------------------------------------------- TOAST / BEEP */
let toastTimer = null;
function toast(msg, kind = 'ok', ms = 2200) {
  const el = $('#toast');
  el.textContent = msg; el.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = '', ms);
}
let actx = null;
function beep(ok) {
  if (!config.general.beep) return;
  try {
    actx = actx || new AudioContext();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = ok ? 880 : 220; g.gain.value = 0.05;
    o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.08);
  } catch (e) { /* ignore */ }
}

/* ---------------------------------------------------------------- TAGGING CORE */
const outcomeSuccess = o => !o ? null : o.type === 'pos' ? 1 : o.type === 'neg' ? 0 : null;
function timeFromSnap(snap, offset) {
  let t = snap.t;
  if (snap.playing) t -= (Number(offset) || 0) * snap.rate;
  return Math.max(0, Math.round(t * 100) / 100);
}
function setPlayer(ev, p) {
  if (!p) return;
  Object.assign(ev, { playerId: p.id, team: p.team || 'Home', num: p.num, name: p.name || '', pos: p.pos || '' });
  lastPlayerId = p.id;
}
function clearPlayer(ev) { Object.assign(ev, { playerId: '', team: '', num: '', name: '', pos: '' }); }
function setOutcome(ev, o) { ev.outcomeId = o ? o.id : ''; ev.outcome = o ? o.name : ''; ev.success = outcomeSuccess(o); }
function setLabel(ev, group, label) { ev.labels = ev.labels || {}; ev.labels[group.name] = label.name; }
function resolvePlayer(p) { return p === SAME_PLAYER ? (VOC.playersById[lastPlayerId] || null) : p; }
function makeInstance(code, t, start, end, opts) {
  const ev = {
    id: nextId++, codeId: code.id, code: code.name, type: code.type,
    t, start: Math.max(0, Math.round(start * 100) / 100), end: Math.round(end * 100) / 100,
    period: periodOf(t) || $('#selPeriod').value,
    playerId: '', team: '', num: '', name: '', pos: '',
    outcomeId: '', outcome: '', success: null, labels: {}, note: '',
    source: opts.source || 'button', heard: opts.heard || ''
  };
  setPlayer(ev, resolvePlayer(opts.player));
  setOutcome(ev, opts.outcome || (code.def ? VOC.outcomesById[code.def] : null));
  (opts.labels || []).forEach(l => setLabel(ev, l.group, l.label));
  events.push(ev);
  seq++; target = { kind: 'event', id: ev.id, seq };
  lastNewId = ev.id;
  undoStack.push({ type: 'add', id: ev.id });
  if (config.general.askLocation && ev.type !== 'duration') locAsk = { id: ev.id, stage: 'start' };
  HOOKS.afterTag.forEach(f => f(ev));
  return ev;
}
function tagInstant(code, t, opts = {}) {
  const ev = makeInstance(code, t, t - (Number(code.lead) || 0), t + (Number(code.lag) || 0), opts);
  renderAll(); autosave(); flashCode(code.id);
  return ev;
}
function toggleDuration(code, t, opts = {}, mode = 'toggle') {
  const running = open[code.id];
  if (running && mode !== 'start') {
    delete open[code.id];
    const start = Math.min(running.t, t), end = Math.max(running.t, t);
    const ev = makeInstance(code, start, start - (Number(code.lead) || 0), end + (Number(code.lag) || 0), {
      source: running.source, heard: running.heard,
      player: opts.player || running.player, outcome: opts.outcome || running.outcome,
      labels: (running.labels || []).concat(opts.labels || [])
    });
    undoStack = undoStack.filter(u => !(u.type === 'open' && u.codeId === code.id));
    renderAll(); autosave();
    return { ev, action: 'stopped' };
  }
  if (!running && mode === 'stop') return { action: 'not-running' };
  if (running && mode === 'start') return { action: 'already' };
  seq++;
  open[code.id] = { t, seq, player: resolvePlayer(opts.player) || null, outcome: opts.outcome || null, labels: opts.labels || [], source: opts.source || 'button', heard: opts.heard || '' };
  target = { kind: 'open', id: code.id, seq };
  undoStack.push({ type: 'open', codeId: code.id });
  renderAll();
  return { action: 'started' };
}
function pressCode(code, source = 'button') {
  const t = timeFromSnap(videoSnap(), config.general.hotkeyOffset);
  if (code.type === 'duration') {
    const r = toggleDuration(code, t, { source });
    toast((r.action === 'started' ? '⏺ ' : '⏹ ') + code.name + (r.action === 'started' ? ' started' : ' – ' + fmtDur(r.ev.end - r.ev.start)), 'info', 1500);
  } else {
    const ev = tagInstant(code, t, { source });
    toast('✓ ' + eventText(ev), 'ok', 1400);
  }
  beep(true);
}
function currentTarget() {
  if (target.kind === 'open' && open[target.id]) return { kind: 'open', ref: open[target.id], code: VOC.codesById[target.id] };
  if (target.kind === 'event') { const ev = events.find(e => e.id === target.id); if (ev) return { kind: 'event', ref: ev }; }
  return null;
}
function selectEvent(id) { seq++; target = { kind: 'event', id, seq }; }
function applyLabel(item, quiet) {
  const tg = currentTarget();
  if (!tg) { toast('Tag a code first – labels are added to the latest tag', 'bad'); return false; }
  if (tg.kind === 'open') {
    const o = tg.ref;
    if (item.kind === 'player') o.player = item.v;
    else if (item.kind === 'outcome') o.outcome = item.v;
    else { o.labels = (o.labels || []).filter(l => l.group.id !== item.v.group.id); o.labels.push(item.v); }
  } else {
    const ev = tg.ref;
    if (item.kind === 'player') setPlayer(ev, item.v);
    else if (item.kind === 'outcome') setOutcome(ev, item.v);
    else setLabel(ev, item.v.group, item.v.label);
    autosave();
  }
  renderAll();
  if (!quiet) toast('+ ' + labelItemText(item) + '  →  ' + targetText(), 'info', 1400);
  return true;
}
function labelItemText(item) { return item.kind === 'player' ? playerLabel(item.v) : item.kind === 'outcome' ? item.v.name : item.v.label.name; }
function eventText(ev) {
  const parts = [ev.code];
  if (ev.playerId) parts.unshift(playerLabel(ev));
  if (ev.outcome) parts.push(ev.outcome);
  const extra = Object.values(ev.labels || {});
  return parts.join(' – ') + (extra.length ? ' (' + extra.join(', ') + ')' : '');
}
function targetText() {
  const tg = currentTarget();
  if (!tg) return '—';
  if (tg.kind === 'open') return tg.code.name + ' (running)';
  return fmtTime(tg.ref.t) + ' ' + eventText(tg.ref);
}
function undo() {
  while (undoStack.length) {
    const u = undoStack.pop();
    if (u.type === 'open' && open[u.codeId]) { delete open[u.codeId]; renderAll(); toast('Cancelled running ' + (VOC.codesById[u.codeId] || {}).name, 'info'); return; }
    if (u.type === 'add') {
      const i = events.findIndex(e => e.id === u.id);
      if (i >= 0) { const [ev] = events.splice(i, 1); if (locAsk && locAsk.id === ev.id) locAsk = null; renderAll(); autosave(); toast('Removed: ' + eventText(ev), 'info'); return; }
    }
  }
  toast('Nothing to undo', 'info');
}
$('#btnUndo').onclick = undo;
$('#btnClear').onclick = () => {
  if (!events.length) return;
  if (confirm('Delete ALL ' + events.length + ' tags? (Tip: save a project first.)')) { events = []; undoStack = []; open = {}; locAsk = null; renderAll(); autosave(); }
};

/* ---------------------------------------------------------------- COMMANDS (voice + typed) */
function handleParsed(parsed, snapFor, source) {
  const heard = parsed.text;
  if (parsed.control) {
    logVoice(heard, 'Command: ' + parsed.control, 'ok');
    if (parsed.control === 'undo') undo();
    else if (parsed.control === 'pause') { if (hasVideo()) video.pause(); else if (live.running) togglePlay(); toast('Paused', 'info'); }
    else if (parsed.control === 'play') { if (hasVideo()) video.play(); else if (live.on && !live.running) togglePlay(); toast('Playing', 'info'); }
    else if (parsed.control === 'rewind') { seek(-5); toast('Back 5 s', 'info'); }
    return;
  }
  if (parsed.labelsOnly) {
    const ok = parsed.labelsOnly.map(it => applyLabel(it, true)).every(Boolean);
    const txt = parsed.labelsOnly.map(labelItemText).join(', ');
    logVoice(heard, ok ? 'Added ' + txt + ' to ' + targetText() : 'No tag to add labels to', ok ? 'ok' : 'bad');
    if (ok) toast('+ ' + txt + '  →  ' + targetText(), 'info', 1800);
    beep(ok);
    return;
  }
  if (!parsed.cmds.length) {
    logVoice(heard, 'Not understood', 'bad');
    toast('Didn’t catch: “' + heard + '”', 'bad', 3000);
    beep(false);
    return;
  }
  const msgs = [];
  parsed.cmds.forEach(c => {
    const t = timeFromSnap(snapFor(c.tokStart), source === 'voice' ? config.general.offset : 0);
    if (!c.code) {   // a custom phrase without a code only adds player/outcome/labels to the latest tag
      const items = [];
      if (c.player) items.push({ kind: 'player', v: resolvePlayer(c.player) });
      if (c.outcome) items.push({ kind: 'outcome', v: c.outcome });
      c.labels.forEach(l => items.push({ kind: 'label', v: l }));
      const ok = items.filter(x => x.v).map(it => applyLabel(it, true)).every(Boolean);
      msgs.push(ok ? '+ ' + items.map(labelItemText).join(', ') : 'nothing to add to');
      return;
    }
    const opts = { player: c.player, outcome: c.outcome, labels: c.labels, source, heard };
    if (c.code.type === 'duration') {
      if (!c.outcomeSaid) opts.outcome = null;
      const r = toggleDuration(c.code, t, opts, c.mode);
      msgs.push(r.action === 'started' ? '⏺ ' + c.code.name + ' started' : r.action === 'stopped' ? '⏹ ' + c.code.name + ' ' + fmtDur(r.ev.end - r.ev.start)
        : r.action === 'already' ? c.code.name + ' already running' : c.code.name + ' was not running');
    } else {
      msgs.push(eventText(tagInstant(c.code, t, opts)));
    }
  });
  const extra = parsed.leftover.length ? '  (ignored: “' + parsed.leftover.join(' ') + '”)' : '';
  logVoice(heard, msgs.join('  |  ') + extra, parsed.leftover.length ? 'warn' : 'ok');
  toast('✓ ' + msgs.join('  |  '), 'ok');
  beep(true);
}
function runTyped() {
  const txt = $('#cmdInput').value.trim();
  if (!txt) return;
  const snap = { t: curT(), playing: false, rate: 1 };
  handleParsed(parseUtterance(txt), () => snap, 'typed');
  $('#cmdInput').value = '';
}
$('#btnType').onclick = runTyped;
$('#cmdInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runTyped(); } if (e.key === 'Escape') e.target.blur(); });

/* ---------------------------------------------------------------- OFFLINE VOICE (Vosk) */
const Voice = {
  model: null, rec: null, ctx: null, stream: null, src: null, node: null,
  fed: 0, sr: 48000, snaps: [], on: false, busy: false, held: false,
  async start() {
    if (this.on || this.busy) return;
    if (!window.Vosk) { alert('The voice engine is missing from this build.'); return; }
    this.busy = true; setMicUI('loading');
    try {
      if (!this.model) {
        const info = await api.modelInfo();
        if (!info.available) throw new Error('The voice model was not found in this installation.');
        $('#micState').textContent = 'loading voice model… (first time can take ~20 s)';
        this.model = await Vosk.createModel(info.url);
      }
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      this.ctx = new AudioContext();
      this.sr = this.ctx.sampleRate;
      this.newRecognizer();
      this.src = this.ctx.createMediaStreamSource(this.stream);
      this.node = this.ctx.createScriptProcessor(4096, 1, 1);
      this.node.onaudioprocess = e => {
        if (!this.rec) return;
        if (config.general.ptt && !this.held) return;     // push-to-talk: only listen while the key is held
        this.snaps.push({ a: this.fed / this.sr, s: videoSnap() });
        if (this.snaps.length > 3000) this.snaps.splice(0, 1500);
        this.fed += e.inputBuffer.length;
        try { this.rec.acceptWaveform(e.inputBuffer); } catch (err) { /* ignore */ }
      };
      this.src.connect(this.node); this.node.connect(this.ctx.destination);
      this.on = true; setMicUI('on');
    } catch (err) {
      console.error(err);
      this.cleanup(); setMicUI('off');
      alert('Could not start voice tagging:\n\n' + (err && err.message ? err.message : err) +
        (err && err.name === 'NotAllowedError' ? '\n\nCheck Windows Settings → Privacy → Microphone → "Let desktop apps access your microphone".' : ''));
    } finally { this.busy = false; }
  },
  newRecognizer() {
    if (this.rec) { try { this.rec.remove(); } catch (e) { /* ignore */ } }
    this.fed = 0; this.snaps = [];
    const g = config.general.useGrammar ? JSON.stringify(grammarWords()) : undefined;
    this.rec = g ? new this.model.KaldiRecognizer(this.sr, g) : new this.model.KaldiRecognizer(this.sr);
    this.rec.setWords(true);
    this.rec.on('result', m => onVoiceResult(m.result));
    this.rec.on('partialresult', m => { const p = (m.result.partial || '').replace(/\[unk\]/g, '').trim(); if (p) setHeard(p, true); });
  },
  setHeld(v) {
    if (this.held === v) return;
    this.held = v;
    if (!v && this.rec) { try { this.rec.retrieveFinalResult(); } catch (e) { /* ignore */ } }
    setMicUI(this.on ? 'on' : 'off');
  },
  snapAt(sec) {
    let best = null;
    for (let k = this.snaps.length - 1; k >= 0; k--) if (this.snaps[k].a <= sec) { best = this.snaps[k]; break; }
    if (!best) return videoSnap();
    const s = best.s;
    return { t: s.t + (s.playing ? (sec - best.a) * s.rate : 0), playing: s.playing, rate: s.rate };
  },
  cleanup() {
    try { this.node && this.node.disconnect(); } catch (e) { /* ignore */ }
    try { this.src && this.src.disconnect(); } catch (e) { /* ignore */ }
    try { this.stream && this.stream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
    try { this.ctx && this.ctx.close(); } catch (e) { /* ignore */ }
    try { this.rec && this.rec.remove(); } catch (e) { /* ignore */ }
    this.node = this.src = this.stream = this.ctx = this.rec = null;
  },
  stop() { this.cleanup(); this.on = false; setMicUI('off'); },
  refreshVocabulary() { if (this.on && this.model) this.newRecognizer(); }
};
function onVoiceResult(result) {
  const text = (result.text || '').trim();
  const words = result.result || [];
  if (!text || !text.replace(/\[unk\]/g, '').trim()) return;
  const parsed = parseUtterance(text);
  setHeard(text.replace(/\[unk\]/g, '…'), false);
  handleParsed(parsed, idx => {
    const w = words[Math.min(idx, words.length - 1)];
    return w ? Voice.snapAt(w.start) : videoSnap();
  }, 'voice');
}
function setMicUI(state) {
  const b = $('#btnMic');
  const ptt = config.general.ptt;
  b.classList.toggle('on', state === 'on' && (!ptt || Voice.held));
  b.classList.toggle('loading', state === 'loading');
  b.innerHTML = state === 'on' ? (ptt ? (Voice.held ? '🔴 Listening…' : '🎤 Voice: hold ' + pttKeyName()) : '🔴 Voice: listening') + ' <kbd>M</kbd>'
    : state === 'loading' ? '⏳ Voice: starting…' : '🎤 Voice: off <kbd>M</kbd>';
  $('#micState').textContent = state === 'on' ? (ptt ? (Voice.held ? 'listening (push-to-talk)' : 'push-to-talk ready') : 'voice on (offline)') : state === 'loading' ? 'starting…' : 'voice off';
}
const PTT_KEYS = { ControlRight: 'Right Ctrl', ShiftRight: 'Right Shift', AltRight: 'Right Alt', Backquote: '` key', Insert: 'Insert', F2: 'F2', F4: 'F4', Pause: 'Pause' };
const pttKeyName = () => PTT_KEYS[config.general.pttKey] || config.general.pttKey;
function toggleMic() { Voice.on ? Voice.stop() : Voice.start(); }
$('#btnMic').onclick = toggleMic;
function setHeard(txt, interim) { const el = $('#heardText'); el.textContent = txt || '—'; el.className = interim ? 'interim' : ''; }
function logVoice(heard, result, kind) {
  voiceLog.unshift({ at: fmtTime(curT()), heard, result, kind });
  if (voiceLog.length > 300) voiceLog.pop();
  renderLog();
}
function renderLog() {
  $('#logList').innerHTML = voiceLog.length ? voiceLog.map(l =>
    `<div class="logrow"><span class="muted">${l.at}</span> &nbsp;<span class="h">“${esc(l.heard)}”</span><br><span class="${l.kind}">→ ${esc(l.result)}</span></div>`
  ).join('') : '<div class="muted empty">Nothing heard yet.</div>';
}
$('#btnClearLog').onclick = () => { voiceLog = []; renderLog(); };

/* ---------------------------------------------------------------- PITCH (shared drawing helpers) */
// Pitch is 105 x 68. Locations are stored as 0-100 (x: own goal → opponent goal, y: top → bottom).
function pitchLines() {
  return `<rect class="grass" x="0" y="0" width="105" height="68"/>
  <g class="ln"><rect x="0.5" y="0.5" width="104" height="67"/><line x1="52.5" y1="0.5" x2="52.5" y2="67.5"/><circle cx="52.5" cy="34" r="9.15"/>
  <rect x="0.5" y="13.84" width="16.5" height="40.32"/><rect x="88" y="13.84" width="16.5" height="40.32"/>
  <rect x="0.5" y="24.84" width="5.5" height="18.32"/><rect x="99" y="24.84" width="5.5" height="18.32"/>
  <path d="M17 26.7 A9.15 9.15 0 0 1 17 41.3"/><path d="M88 26.7 A9.15 9.15 0 0 0 88 41.3"/>
  <line x1="35" y1="0.5" x2="35" y2="67.5" stroke-dasharray="1 1" opacity=".4"/><line x1="70" y1="0.5" x2="70" y2="67.5" stroke-dasharray="1 1" opacity=".4"/></g>
  <circle cx="52.5" cy="34" r=".5" fill="#fff"/><circle cx="11" cy="34" r=".4" fill="#fff"/><circle cx="94" cy="34" r=".4" fill="#fff"/>`;
}
const PX = x => (x / 100 * 105).toFixed(2), PY = y => (y / 100 * 68).toFixed(2);
function arrowDefs() {
  return `<defs>${['#3ea6ff', '#2ecc71', '#ff5a5f', '#f5b041', '#ffffff', '#cccccc'].map((c, i) => `<marker id="ah${i}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`).join('')}</defs>`;
}
const ARROW_IDX = { '#3ea6ff': 0, '#2ecc71': 1, '#ff5a5f': 2, '#f5b041': 3, '#ffffff': 4, '#cccccc': 5 };
function renderPitchInput() {
  const tg = currentTarget();
  const ev = tg && tg.kind === 'event' ? tg.ref : null;
  let marks = '';
  if (ev && ev.x != null) {
    marks += `<circle cx="${PX(ev.x)}" cy="${PY(ev.y)}" r="1.6" fill="#ffd23b" stroke="#000" stroke-width=".3"/>`;
    if (ev.x2 != null) marks += `<line x1="${PX(ev.x)}" y1="${PY(ev.y)}" x2="${PX(ev.x2)}" y2="${PY(ev.y2)}" stroke="#ffffff" stroke-width=".6" marker-end="url(#ah4)"/>`;
  }
  $('#pitchIn').innerHTML = `<svg class="pitchsvg" viewBox="0 0 105 68">${arrowDefs()}${pitchLines()}${marks}</svg>
    <div class="small muted" style="margin-top:2px">→ attacking direction of ${esc(config.general.homeName)}</div>`;
  const hint = $('#pitchHint');
  const waiting = locAsk && events.some(e => e.id === locAsk.id);
  hint.classList.toggle('ask', !!waiting);
  hint.textContent = waiting ? (locAsk.stage === 'end' ? '📍 Now click where it ended (or keep tagging to skip)' : '📍 Click where it happened (or keep tagging to skip)')
    : '📍 Click the pitch to set the location of the selected tag (Shift+click = end point)';
}
function autoZone(ev) {
  if (!config.general.autoZone || ev.x == null) return;
  const zone = config.labelGroups.find(g => g.id === 'zone'), side = config.labelGroups.find(g => g.id === 'side');
  const pick = (g, ids, v) => { if (!g) return; const l = g.labels.find(x => x.id === ids[v < 33.34 ? 0 : v < 66.67 ? 1 : 2]); if (l) setLabel(ev, g, l); };
  pick(zone, ['z1', 'z2', 'z3'], ev.x);
  pick(side, ['s1', 's2', 's3'], ev.y);
}
$('#pitchIn').addEventListener('click', e => {
  const svg = e.target.closest('svg'); if (!svg) return;
  const r = svg.getBoundingClientRect();
  const x = clamp((e.clientX - r.left) / r.width * 100, 0, 100), y = clamp((e.clientY - r.top) / r.height * 100, 0, 100);
  let ev = null, stage = e.shiftKey ? 'end' : 'start';
  if (locAsk && events.some(x => x.id === locAsk.id)) { ev = events.find(x => x.id === locAsk.id); stage = e.shiftKey ? 'end' : locAsk.stage; }
  else { const tg = currentTarget(); if (tg && tg.kind === 'event') ev = tg.ref; }
  if (!ev) { toast('Tag something first, then click its location', 'bad'); return; }
  const rx = Math.round(x * 10) / 10, ry = Math.round(y * 10) / 10;
  if (stage === 'end') { ev.x2 = rx; ev.y2 = ry; if (ev.x == null) { ev.x = rx; ev.y = ry; } locAsk = null; }
  else {
    ev.x = rx; ev.y = ry; autoZone(ev);
    const code = VOC.codesById[ev.codeId];
    locAsk = code && code.endLoc ? { id: ev.id, stage: 'end' } : null;
  }
  autosave(); renderAll();
});

/* ---------------------------------------------------------------- CODE WINDOW */
function renderCodeWindow() {
  const tg = currentTarget();
  const cur = { player: '', outcome: '', labels: {} };
  if (tg && tg.kind === 'event') { cur.player = tg.ref.playerId; cur.outcome = tg.ref.outcomeId; cur.labels = tg.ref.labels || {}; }
  if (tg && tg.kind === 'open') {
    cur.player = tg.ref.player ? tg.ref.player.id : ''; cur.outcome = tg.ref.outcome ? tg.ref.outcome.id : '';
    (tg.ref.labels || []).forEach(l => cur.labels[l.group.name] = l.label.name);
  }
  const hk = k => k ? `<span class="hk">${esc(String(k).toUpperCase())}</span>` : '';
  const codeBtn = c => `<button class="cbtn ${open[c.id] ? 'running' : ''}" style="--c:${esc(c.color)}" data-code="${esc(c.id)}">${esc(c.name)}${hk(c.hotkey)}<span class="ty" data-timer="${esc(c.id)}">${c.type === 'duration' ? (open[c.id] ? '● ' + fmtDur(Math.max(0, curT() - open[c.id].t)) : '⏱ start / stop') : ''}</span></button>`;
  const inst = config.codes.filter(c => c.type !== 'duration'), dur = config.codes.filter(c => c.type === 'duration');
  let html = '';
  if (inst.length) html += `<div class="cwsec"><h4>Events</h4><div class="cwgrid">${inst.map(codeBtn).join('')}</div></div>`;
  if (dur.length) html += `<div class="cwsec"><h4>Phases (press to start, press again to stop)</h4><div class="cwgrid">${dur.map(codeBtn).join('')}</div></div>`;
  const lbtn = (kind, id, text, key, on) => `<button class="lbtn ${on ? 'on' : ''}" data-lkind="${kind}" data-lid="${esc(id)}">${esc(text)}${key ? `<span class="hk">${esc(String(key).toUpperCase())}</span>` : ''}</button>`;
  const onPitch = typeof playersOnPitch === 'function' ? playersOnPitch(curT()) : null;
  const home = config.players.filter(p => p.team !== 'Away' && match.squad[p.id] !== 'out'), away = config.players.filter(p => p.team === 'Away' && match.squad[p.id] !== 'out');
  const pbtn = p => lbtn('player', p.id, playerLabel(p) + (onPitch && onPitch.has(p.id) === false && match.squad[p.id] ? ' ·bench' : ''), p.hotkey, cur.player === p.id);
  html += `<div class="cwsec"><h4>Player – ${esc(config.general.homeName)}</h4><div class="lgrid">${home.map(pbtn).join('')}</div></div>`;
  if (away.length) html += `<div class="cwsec"><h4>Player – ${esc(config.general.awayName)}</h4><div class="lgrid">${away.map(pbtn).join('')}</div></div>`;
  html += `<div class="cwsec"><h4>Outcome</h4><div class="lgrid">${config.outcomes.map(o => lbtn('outcome', o.id, o.name, o.hotkey, cur.outcome === o.id)).join('')}</div></div>`;
  config.labelGroups.forEach(g => {
    html += `<div class="cwsec"><h4>${esc(g.name)}</h4><div class="lgrid">${g.labels.map(l => lbtn('label', g.id + '|' + l.id, l.name, l.hotkey, cur.labels[g.name] === l.name)).join('')}</div></div>`;
  });
  $('#codeWindow').innerHTML = html;
  $('#targetInfo').textContent = targetText();
  renderPitchInput();
}
function renderCodeWindowTimers() {
  Object.keys(open).forEach(id => {
    const el = document.querySelector(`[data-timer="${CSS.escape(id)}"]`);
    if (el) el.textContent = '● ' + fmtDur(Math.max(0, curT() - open[id].t));
  });
}
function flashCode(id) {
  const b = document.querySelector(`.cbtn[data-code="${CSS.escape(id)}"]`);
  if (b) { b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 250); }
}
function labelItemFromIds(kind, id) {
  if (kind === 'player') return VOC.playersById[id] ? { kind, v: VOC.playersById[id] } : null;
  if (kind === 'outcome') return VOC.outcomesById[id] ? { kind, v: VOC.outcomesById[id] } : null;
  const [gid, lid] = id.split('|');
  const g = config.labelGroups.find(x => x.id === gid), l = g && g.labels.find(x => x.id === lid);
  return l ? { kind: 'label', v: { group: g, label: l } } : null;
}
$('#codeWindow').addEventListener('click', e => {
  const cb = e.target.closest('[data-code]');
  if (cb) { const c = VOC.codesById[cb.dataset.code]; if (c) pressCode(c, 'button'); return; }
  const lb = e.target.closest('[data-lkind]');
  if (lb) { const it = labelItemFromIds(lb.dataset.lkind, lb.dataset.lid); if (it) applyLabel(it); }
});

/* ---------------------------------------------------------------- EVENTS TABLE */
const sortedEvents = () => events.slice().sort((a, b) => a.t - b.t || a.id - b.id);
function playerOptions(includeBlank) {
  return (includeBlank ? '<option value="">—</option>' : '') + config.players.map(p => `<option value="${p.id}">${esc((p.team === 'Away' ? '(opp) ' : '') + playerLabel(p))}</option>`).join('');
}
function renderFilters() {
  const keep = (sel, html) => { if (!sel) return; const v = sel.value; sel.innerHTML = html; sel.value = v; if (sel.value !== v) sel.value = ''; };
  const pOpts = playerOptions(false);
  keep($('#fCode'), '<option value="">All codes</option>' + config.codes.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join(''));
  keep($('#fPlayer'), '<option value="">All players</option>' + pOpts);
  keep($('#plPlayer'), '<option value="">Any player</option>' + pOpts);
  keep($('#plOutcome'), '<option value="">Any outcome</option>' + config.outcomes.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join(''));
  keep($('#plLabel'), '<option value="">Any label</option>' + config.labelGroups.map(g => g.labels.map(l => `<option value="${esc(g.name + '|' + l.name)}">${esc(g.name + ': ' + l.name)}</option>`).join('')).join(''));
  keep($('#mapPlayer'), '<option value="">All players</option>' + pOpts);
  keep($('#mapCode'), '<option value="">All codes</option>' + config.codes.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join(''));
  const sumTeam = $('#sumTeam'); if (sumTeam) { sumTeam.options[0].textContent = config.general.homeName; sumTeam.options[1].textContent = config.general.awayName; }
  const mapTeam = $('#mapTeam'); if (mapTeam) { mapTeam.options[0].textContent = config.general.homeName; mapTeam.options[1].textContent = config.general.awayName; }
}
function renderEvents() {
  const fc = $('#fCode').value, fp = $('#fPlayer').value;
  const list = sortedEvents().filter(e => (!fc || e.codeId === fc) && (!fp || e.playerId === fp));
  $('#evCount').textContent = events.length ? '(' + events.length + ')' : '';
  $('#evEmpty').classList.toggle('hidden', events.length > 0);
  $('#evEmpty').innerHTML = 'No tags yet. Click a code button, press its key, type a command, or turn on Voice and say e.g. <code>right back pass</code>.';
  const pOpts = playerOptions(true);
  const cOpts = config.codes.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  const tb = $('#evTable tbody');
  tb.innerHTML = list.map(e => {
    const code = VOC.codesById[e.codeId];
    const outs = code ? code.outcomes : [];
    let oOpts = '<option value="">—</option>' + config.outcomes.filter(o => outs.includes(o.id) || o.id === e.outcomeId).map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
    if (e.outcomeId && !VOC.outcomesById[e.outcomeId]) oOpts += `<option value="${esc(e.outcomeId)}">${esc(e.outcome)}</option>`;
    const pSel = (e.playerId && !VOC.playersById[e.playerId] ? `<option value="${esc(e.playerId)}">${esc(playerLabel(e))}</option>` : '') + pOpts;
    const cSel = (!code ? `<option value="${esc(e.codeId)}">${esc(e.code)}</option>` : '') + cOpts;
    const cls = e.success === 1 ? 'ok' : e.success === 0 ? 'bad' : '';
    const sel = target.kind === 'event' && target.id === e.id;
    const labels = Object.entries(e.labels || {}).map(([g, l]) => g + ': ' + l).join(', ');
    const nd = (e.drawings || []).length;
    return `<tr data-id="${e.id}" class="${e.id === lastNewId ? 'new' : ''} ${sel ? 'sel' : ''}" title="${esc([labels, e.note ? 'Note: ' + e.note : '', e.heard ? 'Heard: ' + e.heard : ''].filter(Boolean).join('\n'))}">
      <td><span class="tlink" data-seek="${e.start}"><span class="dot" style="background:${esc(code ? code.color : '#888')}"></span>${fmtTime(e.t)}</span></td>
      <td class="small">${esc(matchClock(e.t) || '')}</td>
      <td><select data-f="code">${cSel}</select></td>
      <td><select data-f="player">${pSel}</select></td>
      <td><select data-f="outcome" class="${cls}">${oOpts}</select></td>
      <td class="evicons"><span class="${e.x != null ? '' : 'off'}" data-loc="${e.id}" title="${e.x != null ? 'Location set – click to clear' : 'No location'}">📍</span><span class="${e.note ? '' : 'off'}" data-note="${e.id}" title="${esc(e.note || 'Add a note')}">📝</span><span class="${nd ? '' : 'off'}" data-dr="${e.id}" title="${nd ? nd + ' drawing(s) – click to remove' : 'No drawings'}">✏${nd ? nd : ''}</span></td>
      <td><button class="small danger" data-del="${e.id}" title="Delete">✕</button></td></tr>`;
  }).join('');
  list.forEach(e => {
    const tr = tb.querySelector(`tr[data-id="${e.id}"]`);
    tr.querySelector('[data-f=code]').value = e.codeId;
    tr.querySelector('[data-f=player]').value = e.playerId || '';
    tr.querySelector('[data-f=outcome]').value = e.outcomeId || '';
  });
  if (lastNewId) { const tr = tb.querySelector(`tr[data-id="${lastNewId}"]`); if (tr) tr.scrollIntoView({ block: 'nearest' }); lastNewId = null; }
}
$('#evTable').addEventListener('click', async e => {
  const s = e.target.closest('[data-seek]');
  if (s) { if (hasVideo()) video.currentTime = Math.max(0, Number(s.dataset.seek)); }
  const d = e.target.closest('[data-del]');
  if (d) { const id = Number(d.dataset.del); events = events.filter(x => x.id !== id); renderAll(); autosave(); return; }
  const n = e.target.closest('[data-note]');
  if (n) {
    const ev = events.find(x => x.id === Number(n.dataset.note)); if (!ev) return;
    const v = await Dlg.ask('Note for ' + eventText(ev), 'Coaching point / comment. It appears in reports and on exported title cards.', ev.note || '', true);
    if (v !== null) { ev.note = v.trim(); autosave(); renderAll(); }
    return;
  }
  const lc = e.target.closest('[data-loc]');
  if (lc) { const ev = events.find(x => x.id === Number(lc.dataset.loc)); if (ev && ev.x != null && confirm('Clear the location of this tag?')) { delete ev.x; delete ev.y; delete ev.x2; delete ev.y2; autosave(); renderAll(); } else if (ev) { selectEvent(ev.id); locAsk = { id: ev.id, stage: 'start' }; renderAll(); $$('#rightTabs button')[0].click(); } return; }
  const dr = e.target.closest('[data-dr]');
  if (dr) { const ev = events.find(x => x.id === Number(dr.dataset.dr)); if (ev && (ev.drawings || []).length && confirm('Remove the drawings from this tag?')) { ev.drawings = []; autosave(); renderAll(); } return; }
  const tr = e.target.closest('tr[data-id]');
  if (tr && !e.target.closest('select')) { selectEvent(Number(tr.dataset.id)); renderEvents(); renderCodeWindow(); renderTimeline(); }
});
$('#evTable').addEventListener('change', e => {
  const tr = e.target.closest('tr[data-id]'); if (!tr) return;
  const ev = events.find(x => x.id === Number(tr.dataset.id)); if (!ev) return;
  const f = e.target.dataset.f, v = e.target.value;
  if (f === 'player') { if (!v) clearPlayer(ev); else setPlayer(ev, VOC.playersById[v]); }
  if (f === 'outcome') setOutcome(ev, VOC.outcomesById[v] || null);
  if (f === 'code') {
    const c = VOC.codesById[v];
    if (c) { ev.codeId = c.id; ev.code = c.name; ev.type = c.type; if (ev.outcomeId && !c.outcomes.includes(ev.outcomeId)) setOutcome(ev, c.def ? VOC.outcomesById[c.def] : null); }
  }
  renderAll(); autosave();
});
$('#fCode').onchange = renderEvents;
$('#fPlayer').onchange = renderEvents;

/* ---------------------------------------------------------------- TIMELINE (zoom + drag to edit) */
const TL_NAME = 120;
function tlDuration() {
  const d = hasVideo() ? (video.duration || 0) : 0;
  const maxT = Math.max(0, ...events.map(e => e.end), ...Object.values(open).map(o => o.t), live.on ? liveTime() : 0);
  return Math.max(d, maxT + 30, 60);
}
function tlPps() {
  const w = Math.max(100, $('#timeline').clientWidth - TL_NAME - 4);
  return w / tlDuration() * Number($('#tlZoom').value || 1);
}
function renderTimeline() {
  const D = tlDuration(), pps = tlPps();
  const rows = config.codes.filter(c => events.some(e => e.codeId === c.id) || open[c.id]);
  const unknown = [...new Set(events.filter(e => !VOC.codesById[e.codeId]).map(e => e.code))];
  $('#tlInner').style.width = (TL_NAME + D * pps + 4) + 'px';
  $('#tlHead').style.display = (rows.length || unknown.length) ? '' : 'none';
  if (!rows.length && !unknown.length) { $('#tlRows').innerHTML = '<div class="tlempty">Your tags will appear here, one row per code. Drag a selected bar’s edges to change its start / end.</div>'; updateTime(); return; }
  const selId = target.kind === 'event' ? target.id : null;
  const bar = e => `<div class="bar ${e.id === selId ? 'sel' : ''}" data-bar="${e.id}" style="left:${(e.start * pps).toFixed(1)}px;width:${Math.max(3, (e.end - e.start) * pps).toFixed(1)}px;background:var(--c)" title="${fmtTime(e.t)} ${esc(eventText(e))}"></div>`;
  let html = rows.map(c => {
    let b = events.filter(e => e.codeId === c.id).map(bar).join('');
    if (open[c.id]) b += `<div class="bar" style="left:${(open[c.id].t * pps).toFixed(1)}px;width:${Math.max(3, (curT() - open[c.id].t) * pps).toFixed(1)}px;background:var(--c);opacity:.45"></div>`;
    return `<div class="tlrow" style="--c:${esc(c.color)}"><div class="nm">${esc(c.name)}</div><div class="tr">${b}</div></div>`;
  }).join('');
  html += unknown.map(n => `<div class="tlrow" style="--c:#888"><div class="nm">${esc(n)}</div><div class="tr">${events.filter(e => e.code === n && !VOC.codesById[e.codeId]).map(bar).join('')}</div></div>`).join('');
  $('#tlRows').innerHTML = html;
  updateTime();
}
function updateTime() {
  const t = curT();
  $('#timeDisp').textContent = fmtTime(t) + ' / ' + (hasVideo() ? fmtTime(video.duration || 0) : live.on ? 'LIVE' : '00:00');
  const mc = matchClock(t);
  $('#matchDisp').textContent = mc ? `Match ${mc} (${PERIOD_NAME[periodOf(t)]})` : 'Match —';
  $('#matchDisp').classList.toggle('on', !!mc);
  const head = $('#tlHead'), x = TL_NAME + t * tlPps();
  head.style.left = x + 'px';
  const tl = $('#timeline');
  if (Number($('#tlZoom').value) > 1 && !tlDrag && (x < tl.scrollLeft + TL_NAME || x > tl.scrollLeft + tl.clientWidth - 20)) tl.scrollLeft = Math.max(0, x - TL_NAME - 40);
  if (Object.keys(open).length) renderCodeWindowTimers();
  if (live.on) updateLiveClockUI();
}
video.addEventListener('timeupdate', updateTime);
window.addEventListener('resize', renderTimeline);
$('#tlZoom').addEventListener('input', renderTimeline);
let tlDrag = null;
$('#timeline').addEventListener('mousedown', e => {
  const tl = $('#timeline'), r = $('#tlInner').getBoundingClientRect();
  const b = e.target.closest('[data-bar]');
  if (b) {
    const ev = events.find(x => x.id === Number(b.dataset.bar)); if (!ev) return;
    const br = b.getBoundingClientRect(), ox = e.clientX - br.left;
    const wasSel = target.kind === 'event' && target.id === ev.id;
    const mode = wasSel && ox < 7 ? 'start' : wasSel && ox > br.width - 7 ? 'end' : 'move';
    tlDrag = { ev, mode, x0: e.clientX, s0: ev.start, e0: ev.end, t0: ev.t, moved: false, wasSel };
    selectEvent(ev.id);
    e.preventDefault();
    return;
  }
  if (e.target.closest('.nm')) return;
  const x = e.clientX - r.left - TL_NAME;
  if (x >= 0) { const t = x / tlPps(); if (hasVideo()) video.currentTime = clamp(t, 0, video.duration || t); else if (live.on) { live.base = t; live.startedAt = performance.now(); } updateTime(); }
  void tl;
});
document.addEventListener('mousemove', e => {
  if (!tlDrag) return;
  const dx = (e.clientX - tlDrag.x0) / tlPps();
  if (Math.abs(e.clientX - tlDrag.x0) > 3) tlDrag.moved = true;
  if (!tlDrag.moved) return;
  const ev = tlDrag.ev;
  if (tlDrag.mode === 'start') ev.start = Math.round(clamp(tlDrag.s0 + dx, 0, ev.end - 0.2) * 100) / 100;
  else if (tlDrag.mode === 'end') ev.end = Math.round(Math.max(ev.start + 0.2, tlDrag.e0 + dx) * 100) / 100;
  else { const d = Math.max(-tlDrag.s0, dx); ev.start = Math.round((tlDrag.s0 + d) * 100) / 100; ev.end = Math.round((tlDrag.e0 + d) * 100) / 100; ev.t = Math.round((tlDrag.t0 + d) * 100) / 100; }
  const b = document.querySelector(`[data-bar="${ev.id}"]`), pps = tlPps();
  if (b) { b.style.left = (ev.start * pps) + 'px'; b.style.width = Math.max(3, (ev.end - ev.start) * pps) + 'px'; }
  if (hasVideo()) video.currentTime = tlDrag.mode === 'end' ? ev.end : ev.start;
});
document.addEventListener('mouseup', () => {
  if (!tlDrag) return;
  const d = tlDrag; tlDrag = null;
  if (d.moved) { autosave(); toast(`${d.ev.code}: ${fmtTime(d.ev.start)} → ${fmtTime(d.ev.end)} (${fmtDur(d.ev.end - d.ev.start)})`, 'info', 1500); }
  else if (hasVideo()) video.currentTime = d.ev.start;
  renderAll();
});

/* ---------------------------------------------------------------- HELP */
function renderHelp() {
  const pills = arr => arr.map(x => `<span class="pill">${esc(x)}</span>`).join('');
  $('#tab-help').innerHTML = `
    <p class="muted">VoiceTag ${APP_VERSION} · <a href="#" id="lnkUpdates">check for a newer version</a></p>
    <h3>Ways to tag</h3>
    <ol>
      <li><b>Code window</b> – click a button or press its key. Event buttons make a clip around that moment. Phase buttons (Build-up…) start on the first press and stop on the second.</li>
      <li><b>Labels</b> – after a code, click a player / outcome / zone button (or its key). It goes to the latest tag. Click a row in Events (or a bar in the timeline) to choose another tag.</li>
      <li><b>Location</b> – after tagging, click the pitch where it happened (passes/crosses: click the start, then the end).</li>
      <li><b>Voice</b> (offline) – press <kbd>M</kbd>. Say exactly what is written in Settings → <b>Voice commands</b>. Say <code>same player cross</code> to reuse the last player.</li>
      <li><b>Live</b> – no video? Press 🔴 Live, start the clock and tag from the touchline. Later open the video and use 📋 Match → Sync.</li>
    </ol>
    <h3>Match clock</h3><p>Choose the period, go to the kick-off in the video and press <b>⏱ Kick-off</b>. Press <b>⏹ End period</b> at half-time / full-time. Tags then show the match minute, and minutes played are calculated from the squad and substitutions (📋 Match).</p>
    <h3>Timeline</h3><p>Zoom with 🔍. Click a bar to select it, then drag its edges to change start / end, or drag the middle to move it.</p>
    <h3>Players</h3><p>${pills(config.players.map(p => playerLabel(p) + ' → “' + (splitAliases(p.say)[0] || '') + '”'))}</p>
    <h3>Codes</h3>${config.codes.map(c => `<p><b>${esc(c.name)}</b> <span class="muted">${c.hotkey ? '[' + esc(c.hotkey.toUpperCase()) + '] ' : ''}say “${esc(splitAliases(c.say)[0] || c.name)}”${c.type === 'duration' ? ' (phase)' : c.outcomes.length ? ' → ' + c.outcomes.map(id => VOC.outcomesById[id]?.name).filter(Boolean).join(', ') : ''}</span></p>`).join('')}
    ${config.customPhrases.length ? '<h3>Your phrases</h3>' + config.customPhrases.map(cp => `<p><code>${esc(cp.phrase)}</code></p>`).join('') : ''}
    <h3>Voice controls</h3><p>${pills(['undo', 'pause', 'play', 'rewind'])}</p>
    <h3>Voice tips</h3>
    <ul>
      <li>The offline engine understands English words. Write commands with normal English words (numbers can be typed as 11 or eleven).</li>
      <li>Use a headset mic. Turn on push-to-talk (Settings → General) if people talk around you.</li>
      <li>Check the <b>Voice log</b>. If a word is often misheard, add the misheard word to that item’s “Say” box.</li>
    </ul>`;
  const l = $('#lnkUpdates'); if (l) l.onclick = e => { e.preventDefault(); api.openExternal('https://github.com/AmartyaDasDip/voicetag/releases'); };
}

/* ---------------------------------------------------------------- RENDER ALL */
function renderAll() {
  renderFilters(); renderCodeWindow(); renderEvents(); renderTimeline();
  HOOKS.render.forEach(f => { try { f(); } catch (err) { console.error(err); } });
  renderHelp(); updateLiveClockUI();
}
$$('#rightTabs button').forEach(b => b.onclick = () => {
  $$('#rightTabs button').forEach(x => x.classList.toggle('active', x === b));
  $$('#right .tabpane').forEach(p => p.classList.toggle('hidden', p.id !== 'tab-' + b.dataset.tab));
  HOOKS.render.forEach(f => { try { f(b.dataset.tab); } catch (err) { console.error(err); } });
});
// header drop-down menus
$$('.menu .menubtn').forEach(b => b.onclick = e => { e.stopPropagation(); const m = b.parentElement; const was = m.classList.contains('open'); $$('.menu').forEach(x => x.classList.remove('open')); if (!was) m.classList.add('open'); });
document.addEventListener('click', () => $$('.menu').forEach(x => x.classList.remove('open')));

/* ---------------------------------------------------------------- AUTOSAVE */
let autosaveTimer = null;
function autosave() { clearTimeout(autosaveTimer); autosaveTimer = setTimeout(autosaveNow, 400); }
function autosaveNow() {
  try {
    if (events.length || Object.keys(match.kickoffs).length) localStorage.setItem(sessionKey, JSON.stringify({ events, nextId, match, video: videoInfo, savedAt: new Date().toISOString() }));
    else localStorage.removeItem(sessionKey);
  } catch (e) { /* ignore */ }
}
window.addEventListener('beforeunload', autosaveNow);
api.onClosing(autosaveNow);

/* ---------------------------------------------------------------- KEYBOARD */
const modalOpen = () => !$('#settings').classList.contains('hidden') || Dlg.isOpen() || (typeof Draw !== 'undefined' && Draw.editing);
document.addEventListener('keydown', e => {
  if (config.general.ptt && e.code === config.general.pttKey && Voice.on) { e.preventDefault(); Voice.setHeld(true); return; }
  const tag = (e.target.tagName || '').toLowerCase();
  if (modalOpen()) { if (e.key === 'Escape') { if (!$('#settings').classList.contains('hidden')) closeSettings(); else if (Dlg.isOpen()) $('#dlgX').click(); else Draw.close(); } return; }
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  if (e.altKey) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); $('#btnSaveProj').click(); return; }
  if (e.ctrlKey || e.metaKey) return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); return; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); seek(e.shiftKey ? -1 : -5); return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); seek(e.shiftKey ? 1 : 5); return; }
  if (e.key === ',' || e.key === '.') { e.preventDefault(); if (hasVideo()) { video.pause(); seek(e.key === ',' ? -0.04 : 0.04); } return; }
  if (e.key === '/') { e.preventDefault(); $('#cmdInput').focus(); return; }
  if (e.key === 'Escape') { if (typeof PL !== 'undefined' && PL.active) plStop(); locAsk = null; renderCodeWindow(); return; }
  if (e.key.length !== 1) return;
  const k = e.key.toUpperCase();
  if (k === 'M') { e.preventDefault(); toggleMic(); return; }
  if (e.repeat) return;
  const h = VOC.hotkeys[k];
  if (!h) return;
  e.preventDefault();
  if (h.kind === 'code') pressCode(h.item, 'key');
  else applyLabel({ kind: h.kind, v: h.item });
});
document.addEventListener('keyup', e => { if (config.general.ptt && e.code === config.general.pttKey) Voice.setHeld(false); });
window.addEventListener('blur', () => { if (Voice.held) Voice.setHeld(false); });
document.addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.closest('.menu')) b.blur(); });

/* ---------------------------------------------------------------- START */
window.addEventListener('DOMContentLoaded', () => {
  $('#appVer').textContent = 'v' + APP_VERSION;
  try {
    const saved = JSON.parse(localStorage.getItem(sessionKey) || 'null');
    if (saved && saved.events) { events = saved.events; nextId = saved.nextId || 1; if (saved.match) match = Object.assign(EMPTY_MATCH(), saved.match); }
  } catch (e) { /* ignore */ }
  renderAll(); renderLog(); setMicUI('off');
  setInterval(() => {
    if (live.on && !hasVideo()) updateTime();
    if (Object.keys(open).length) { renderCodeWindowTimers(); if (!tlDrag) renderTimeline(); }
  }, 500);
  const tick = () => { HOOKS.tick.forEach(f => { try { f(); } catch (err) { console.error(err); } }); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
