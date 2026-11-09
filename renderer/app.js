'use strict';
/* =====================================================================
   VoiceTag – football match tagging with code window, hotkeys and
   offline voice commands.
   ===================================================================== */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const fmtTime = s => { s = Math.max(0, s || 0); const m = Math.floor(s / 60), x = Math.floor(s % 60); return String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0'); };
const fmtDur = s => s >= 60 ? fmtTime(s) : (Math.round(s * 10) / 10) + 's';

/* ---------------------------------------------------------------- PLATFORM BRIDGE
   In the installed app `window.api` comes from preload.js. When the page is opened
   in a normal browser (for testing) we fall back to browser features. */
const api = window.api || (() => {
  const pick = accept => new Promise(res => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = accept;
    i.onchange = () => res(i.files[0] || null); i.click();
  });
  const dl = (name, data, binary) => {
    const blob = new Blob([data], { type: binary ? 'application/octet-stream' : 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    return name;
  };
  return {
    isDesktop: false,
    openVideo: async () => { const f = await pick('video/*'); return f ? { path: '', name: f.name, size: f.size, url: URL.createObjectURL(f) } : null; },
    registerMedia: async () => null,
    pathForFile: () => '',
    mediaUrl: p => p,
    saveFile: async ({ defaultName, data, encoding }) => dl(defaultName, data, encoding === 'binary'),
    openTextFile: async () => { const f = await pick('.json,.vtproj'); return f ? { path: f.name, text: await f.text() } : null; },
    modelInfo: async () => ({ available: false }),
    ffmpegInfo: async () => ({ available: false }),
    showInFolder: async () => {},
    exportClips: async () => ({ ok: false, error: 'Video export only works in the installed desktop app.' }),
    cancelExport: async () => {},
    onExportProgress: () => {},
    onClosing: () => {}
  };
})();

/* ---------------------------------------------------------------- DEFAULTS */
function DEFAULT_CONFIG() {
  const P = (num, pos, aliases) => ({ id: uid(), team: 'Home', num, name: '', pos, aliases, hotkey: '' });
  const C = (id, name, type, hotkey, aliases, outcomes, def, color) => ({
    id, name, type, hotkey, aliases, outcomes, def, color,
    lead: type === 'duration' ? 2 : 5, lag: type === 'duration' ? 2 : 5
  });
  return {
    version: 2,
    general: {
      offset: 1, hotkeyOffset: 0, strictness: 0.72, beep: true, xmlCode: 'code',
      homeName: 'Home', awayName: 'Opposition', voiceControl: true, useGrammar: true
    },
    codes: [
      C('pass', 'Pass', 'instant', 'P', 'passes, past, passed', ['succ', 'unsucc'], 'succ', '#3ea6ff'),
      C('cross', 'Cross', 'instant', 'C', 'crosses, crossed, cross ball', ['succ', 'unsucc'], 'succ', '#a66bff'),
      C('shot', 'Shot', 'instant', 'S', 'shoot, shots, shut', ['ont', 'offt', 'goal', 'blocked'], '', '#ff5a5f'),
      C('gduel', 'Ground Duel', 'instant', 'G', 'ground dual, ground jewel, ground duels', ['won', 'lost'], '', '#f5b041'),
      C('aduel', 'Aerial Duel', 'instant', 'A', 'aerial dual, arial duel, air duel, header duel', ['won', 'lost'], '', '#e67e22'),
      C('dribble', 'Dribble', 'instant', 'D', 'dribbles, dribbled, take on', ['succ', 'unsucc'], 'succ', '#1abc9c'),
      C('tackle', 'Tackle', 'instant', 'T', 'tackles, tackled', ['won', 'lost'], 'won', '#2ecc71'),
      C('intercept', 'Interception', 'instant', 'I', 'intercept, intercepted', [], '', '#17a589'),
      C('clear', 'Clearance', 'instant', 'L', 'clear, cleared', [], '', '#95a5a6'),
      C('recovery', 'Ball Recovery', 'instant', 'R', 'recovery, recovered, regain', [], '', '#58d68d'),
      C('loss', 'Possession Lost', 'instant', 'O', 'loss of possession, lost possession, turnover', [], '', '#c0392b'),
      C('foulc', 'Foul Committed', 'instant', 'F', 'foul, fouled', [], '', '#d35400'),
      C('foulw', 'Foul Won', 'instant', 'W', 'won a foul, won foul', [], '', '#f39c12'),
      C('keypass', 'Key Pass', 'instant', 'K', 'key passes, chance created', [], '', '#5dade2'),
      C('save', 'Save', 'instant', 'V', 'saves, keeper save', [], '', '#af7ac5'),
      C('buildup', 'Build-up', 'duration', 'B', 'build up, buildup, build-up play', [], '', '#00bcd4'),
      C('counter', 'Counter-attack', 'duration', 'X', 'counter attack, counter, counterattack', [], '', '#ff4081'),
      C('setpiece', 'Set Piece', 'duration', 'E', 'set piece, set play', [], '', '#cddc39'),
      C('press', 'High Press', 'duration', 'H', 'press, pressing, high pressing', [], '', '#ff9800')
    ],
    outcomes: [
      { id: 'succ', name: 'Successful', aliases: 'success, complete, completed, good, accurate', type: 'pos', hotkey: '1' },
      { id: 'unsucc', name: 'Unsuccessful', aliases: 'not successful, unsuccessfully, failed, fail, incomplete, bad, inaccurate', type: 'neg', hotkey: '2' },
      { id: 'won', name: 'Won', aliases: 'win, one, wan, when', type: 'pos', hotkey: '3' },
      { id: 'lost', name: 'Lost', aliases: 'lose, loss, last', type: 'neg', hotkey: '4' },
      { id: 'ont', name: 'On Target', aliases: 'on targets, on goal, saved', type: 'pos', hotkey: '5' },
      { id: 'offt', name: 'Off Target', aliases: 'of target, wide, over, missed', type: 'neg', hotkey: '6' },
      { id: 'goal', name: 'Goal', aliases: 'scored, goals', type: 'pos', hotkey: '7' },
      { id: 'blocked', name: 'Blocked', aliases: 'block', type: 'neg', hotkey: '8' }
    ],
    labelGroups: [
      { id: 'zone', name: 'Zone', labels: [
        { id: uid(), name: 'Defensive Third', hotkey: '' }, { id: uid(), name: 'Middle Third', hotkey: '' }, { id: uid(), name: 'Final Third', hotkey: '' }] },
      { id: 'side', name: 'Side', labels: [
        { id: uid(), name: 'Left Side', hotkey: '' }, { id: uid(), name: 'Centre', hotkey: '' }, { id: uid(), name: 'Right Side', hotkey: '' }] }
    ],
    players: [
      P(1, 'Goalkeeper', 'keeper, goalie'),
      P(2, 'Right Back', 'write back, rightback'),
      P(3, 'Left Back', 'leftback'),
      P(4, 'Right Centre Back', 'right centre half'),
      P(5, 'Left Centre Back', 'left centre half'),
      P(6, 'Defensive Midfielder', 'holding midfielder'),
      P(8, 'Right Midfielder', 'right mid, right centre mid'),
      P(10, 'Left Midfielder', 'left mid, left centre mid'),
      P(7, 'Right Winger', 'right wing, right wide'),
      P(11, 'Left Winger', 'left wing, left wide'),
      P(9, 'Striker', 'centre forward, forward')
    ]
  };
}
const RESERVED_KEYS = new Set([' ', 'M', ',', '.', '/']);
const CONTROL_WORDS = [
  { cmd: 'undo', aliases: ['undo', 'undo that', 'undo last', 'delete last', 'delete that', 'remove last', 'scratch that', 'cancel that'] },
  { cmd: 'pause', aliases: ['pause', 'pause video', 'stop video'] },
  { cmd: 'play', aliases: ['play', 'play video', 'resume', 'continue'] },
  { cmd: 'rewind', aliases: ['rewind', 'go back', 'back five'] }
];
const START_W = new Set(['start', 'starts', 'started', 'begin', 'begins', 'on']);
const STOP_W = new Set(['stop', 'stops', 'stopped', 'end', 'ends', 'ended', 'finish', 'finished', 'off', 'over', 'done']);

/* ---------------------------------------------------------------- STATE */
let config = loadConfig();
let events = [];             // tagged instances
let nextId = 1;
let seq = 0;                 // increases with every new tag – used to know where labels go
let open = {};               // running duration codes: codeId -> {t, seq, player, outcome, labels, source, heard}
let target = { kind: null, id: null, seq: 0 };
let undoStack = [];
let voiceLog = [];
let sessionKey = 'vt_session_default';
let videoInfo = { path: '', name: '', size: 0 };
let VOC = null;
let lastNewId = null;

function migrate(c) {
  const d = DEFAULT_CONFIG();
  c.general = Object.assign(d.general, c.general || {});
  if (!Array.isArray(c.codes)) {
    // version-1 projects used "actions"
    c.codes = Array.isArray(c.actions) ? c.actions.map(a => Object.assign({ type: 'instant', hotkey: '', lead: 5, lag: 5 }, a)) : d.codes;
    delete c.actions;
  }
  ['players', 'outcomes', 'labelGroups'].forEach(k => { if (!Array.isArray(c[k])) c[k] = d[k]; });
  c.codes.forEach(x => { if (x.lead == null) x.lead = 5; if (x.lag == null) x.lag = 5; if (!x.type) x.type = 'instant'; if (x.hotkey == null) x.hotkey = ''; if (!Array.isArray(x.outcomes)) x.outcomes = []; });
  c.players.forEach(p => { if (p.hotkey == null) p.hotkey = ''; });
  c.outcomes.forEach(o => { if (o.hotkey == null) o.hotkey = ''; });
  c.version = 2;
  return c;
}
function loadConfig() {
  try { const raw = localStorage.getItem('vt_config2'); if (raw) return migrate(JSON.parse(raw)); } catch (e) { console.warn(e); }
  return DEFAULT_CONFIG();
}
function saveConfig() { try { localStorage.setItem('vt_config2', JSON.stringify(config)); } catch (e) { /* ignore */ } }

/* ---------------------------------------------------------------- TEXT MATCHING */
const FILLERS = new Set(['and', 'the', 'a', 'an', 'uh', 'um', 'er', 'erm', 'ah', 'is', 'was', 'has', 'with', 'then', 'ok', 'okay', 'its', 'it', 'that', 'so', 'hes', 'he', 'unk']);
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function numberWords(n) {
  n = Number(n);
  if (!Number.isInteger(n) || n < 0 || n > 99) return '';
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
}
function normWord(s) { return String(s).toLowerCase().replace(/centre/g, 'center').replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function tokenize(text) {
  const out = [];
  String(text || '').trim().split(/\s+/).filter(Boolean).forEach((rw, i) => {
    const n = normWord(rw);
    if (!n) return;
    n.split(' ').forEach(p => { if (p && !FILLERS.has(p)) out.push({ w: p, i }); });
  });
  return out;
}
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
function sim(a, b) { const L = Math.max(a.length, b.length); return L ? 1 - lev(a, b) / L : 1; }
function splitAliases(s) { return String(s || '').split(/[,;\n]/).map(x => x.trim()).filter(Boolean); }
function makeKeys(list) {
  const seen = new Set(), out = [];
  list.forEach(txt => {
    const words = tokenize(txt).map(t => t.w);
    if (!words.length) return;
    const key = words.join('');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ words, key, text: txt });
  });
  return out;
}
function playerLabel(p) {
  if (!p) return '';
  const n = (p.num !== '' && p.num != null) ? '#' + p.num + ' ' : '';
  return (n + (p.pos || p.name || 'Player')).trim();
}
function playerSpokenList(p) {
  const list = [];
  if (p.pos) list.push(p.pos);
  if (p.name) {
    list.push(p.name);
    const parts = p.name.trim().split(/\s+/);
    if (parts.length > 1) list.push(parts[parts.length - 1]);
  }
  if (p.num !== '' && p.num != null && !isNaN(p.num)) {
    const w = numberWords(p.num);
    list.push(String(p.num), 'number ' + p.num);
    if (w) list.push(w, 'number ' + w);
  }
  return list.concat(splitAliases(p.aliases));
}
function buildVocab() {
  VOC = {
    outcomesById: Object.fromEntries(config.outcomes.map(o => [o.id, o])),
    codesById: Object.fromEntries(config.codes.map(c => [c.id, c])),
    playersById: Object.fromEntries(config.players.map(p => [p.id, p])),
    players: [], codes: [], outcomes: [], labels: [],
    control: CONTROL_WORDS.map(c => ({ cmd: c.cmd, keys: makeKeys(c.aliases).map(k => k.key) })),
    hotkeys: {}
  };
  config.players.forEach(p => makeKeys(playerSpokenList(p)).forEach(k => VOC.players.push({ item: p, ...k })));
  config.codes.forEach(c => makeKeys([c.name, ...splitAliases(c.aliases)]).forEach(k => VOC.codes.push({ item: c, ...k })));
  config.outcomes.forEach(o => makeKeys([o.name, ...splitAliases(o.aliases)]).forEach(k => VOC.outcomes.push({ item: o, ...k })));
  config.labelGroups.forEach(g => g.labels.forEach(l => makeKeys([l.name, ...splitAliases(l.aliases)]).forEach(k => VOC.labels.push({ item: { group: g, label: l }, ...k }))));
  const hk = (key, v) => { key = String(key || '').trim().toUpperCase(); if (key && !RESERVED_KEYS.has(key) && !VOC.hotkeys[key]) VOC.hotkeys[key] = v; };
  config.codes.forEach(c => hk(c.hotkey, { kind: 'code', item: c }));
  config.outcomes.forEach(o => hk(o.hotkey, { kind: 'outcome', item: o }));
  config.players.forEach(p => hk(p.hotkey, { kind: 'player', item: p }));
  config.labelGroups.forEach(g => g.labels.forEach(l => hk(l.hotkey, { kind: 'label', item: { group: g, label: l } })));
}
function grammarWords() {
  const words = new Set();
  const add = list => list.forEach(k => k.words.forEach(w => { if (!/\d/.test(w)) words.add(w); }));
  add(VOC.players); add(VOC.codes); add(VOC.outcomes); add(VOC.labels);
  CONTROL_WORDS.forEach(c => makeKeys(c.aliases).forEach(k => k.words.forEach(w => words.add(w))));
  [...START_W, ...STOP_W].forEach(w => words.add(w));
  ['number', 'and', 'the'].forEach(w => words.add(w));
  return [...words, '[unk]'];
}
function matchSegment(tokens, start, cands) {
  const rem = tokens.length - start;
  if (rem <= 0) return null;
  let best = null;
  for (const c of cands) {
    const n = c.words.length;
    for (let len = Math.max(1, n - 1); len <= Math.min(rem, n + 1); len++) {
      let seg = '';
      for (let k = start; k < start + len; k++) seg += tokens[k].w;
      let s = sim(c.key, seg);
      if (len !== n) s -= 0.03;
      if (!best || s > best.score + 1e-9 || (Math.abs(s - best.score) < 1e-9 && len > best.len)) best = { item: c.item, len, score: s };
    }
  }
  return best;
}
const threshold = () => Number(config.general.strictness) || 0.72;
function parseAt(tokens, start, order) {
  const TH = threshold();
  let i = start, player = null, code = null;
  const scores = [];
  for (const kind of order) {
    const m = matchSegment(tokens, i, kind === 'player' ? VOC.players : VOC.codes);
    if (!m || m.score < TH) return null;
    if (kind === 'player') player = m.item; else code = m.item;
    scores.push(m.score); i += m.len;
  }
  let outcome = null, outcomeSaid = false, mode = 'toggle';
  const labels = [];
  for (let guard = 0; guard < 6 && i < tokens.length; guard++) {
    const w = tokens[i].w;
    if (code.type === 'duration' && START_W.has(w)) { mode = 'start'; i++; continue; }
    if (code.type === 'duration' && STOP_W.has(w)) { mode = 'stop'; i++; continue; }
    if (!outcomeSaid && code.outcomes && code.outcomes.length) {
      const cands = VOC.outcomes.filter(o => code.outcomes.includes(o.item.id));
      const m = matchSegment(tokens, i, cands);
      if (m && m.score >= TH) { outcome = m.item; outcomeSaid = true; i += m.len; scores.push(m.score); continue; }
    }
    if (VOC.labels.length) {
      const m = matchSegment(tokens, i, VOC.labels);
      if (m && m.score >= TH) { labels.push(m.item); i += m.len; scores.push(m.score); continue; }
    }
    break;
  }
  if (!outcomeSaid && code.def) outcome = VOC.outcomesById[code.def] || null;
  return { player, code, outcome, outcomeSaid, labels, mode, tokStart: tokens[start].i, next: i, score: avg(scores) - (order.length === 1 ? 0.02 : 0) };
}
function parseLabelsOnly(tokens) {
  // e.g. "unsuccessful", "left back", "final third" -> applied to the latest tag
  const TH = threshold(), out = [];
  const cands = VOC.outcomes.map(o => ({ ...o, item: { kind: 'outcome', v: o.item } }))
    .concat(VOC.players.map(p => ({ ...p, item: { kind: 'player', v: p.item } })))
    .concat(VOC.labels.map(l => ({ ...l, item: { kind: 'label', v: l.item } })));
  let i = 0;
  const scores = [];
  while (i < tokens.length) {
    const m = matchSegment(tokens, i, cands);
    if (!m || m.score < TH) return null;
    out.push(m.item); scores.push(m.score); i += m.len;
  }
  return out.length ? { items: out, score: avg(scores) } : null;
}
function parseUtterance(text) {
  const tokens = tokenize(text);
  const res = { cmds: [], control: null, labelsOnly: null, leftover: [], score: 0, text };
  if (!tokens.length) return res;
  const joined = tokens.map(t => t.w).join('');
  if (config.general.voiceControl) {
    let best = null;
    for (const c of VOC.control) for (const k of c.keys) { const s = sim(k, joined); if (!best || s > best.s) best = { cmd: c.cmd, s }; }
    if (best && best.s >= 0.85) { res.control = best.cmd; res.score = best.s; return res; }
  }
  let i = 0, skipped = 0;
  while (i < tokens.length) {
    const r = parseAt(tokens, i, ['player', 'code']) || parseAt(tokens, i, ['code', 'player']) || parseAt(tokens, i, ['code']);
    if (r) { res.cmds.push(r); i = r.next; continue; }
    if (tokens.length - i >= 2 && skipped < 2) { i++; skipped++; continue; }
    break;
  }
  res.leftover = tokens.slice(i).map(t => t.w);
  if (!res.cmds.length) {
    const lo = parseLabelsOnly(tokens);
    if (lo) { res.labelsOnly = lo.items; res.score = lo.score; res.leftover = []; return res; }
  }
  res.score = res.cmds.length ? avg(res.cmds.map(c => c.score)) - 0.04 * (res.leftover.length + skipped) : 0;
  return res;
}

/* ---------------------------------------------------------------- VIDEO */
const video = $('#video');
function setVideo(info) {
  if (!info) return;
  autosaveNow();
  video.src = info.url || api.mediaUrl(info.path);
  videoInfo = { path: info.path || '', name: info.name, size: info.size };
  document.title = info.name + ' – VoiceTag';
  $('#drop').classList.add('hidden');
  sessionKey = 'vt_session_' + (info.path || info.name) + '_' + info.size;
  events = []; undoStack = []; nextId = 1; open = {}; target = { kind: null, id: null, seq: 0 };
  try {
    const saved = JSON.parse(localStorage.getItem(sessionKey) || 'null');
    if (saved && saved.events && saved.events.length &&
        confirm('Found ' + saved.events.length + ' saved tags for "' + info.name + '".\n\nOK = restore them\nCancel = start a fresh session')) {
      events = saved.events; nextId = saved.nextId || (Math.max(0, ...events.map(e => e.id)) + 1);
    }
  } catch (e) { /* ignore */ }
  renderAll();
  toast('Loaded ' + info.name, 'info');
}
async function openVideo() { const r = await api.openVideo(); if (r) setVideo(r); }
$('#btnLoad').onclick = openVideo;
const wrap = $('#videoWrap');
wrap.addEventListener('dragover', e => { e.preventDefault(); $('#drop').classList.add('over'); });
wrap.addEventListener('dragleave', () => $('#drop').classList.remove('over'));
wrap.addEventListener('drop', async e => {
  e.preventDefault(); $('#drop').classList.remove('over');
  const f = [...e.dataTransfer.files][0];
  if (!f) return;
  if (api.isDesktop) { const r = await api.registerMedia(api.pathForFile(f)); if (r) setVideo(r); }
  else setVideo({ path: '', name: f.name, size: f.size, url: URL.createObjectURL(f) });
});
video.addEventListener('error', () => { if (video.getAttribute('src')) toast('This video could not be played. Try converting it to MP4 (H.264).', 'bad', 6000); });
function togglePlay() { if (!video.src) return; video.paused ? video.play() : video.pause(); }
function seek(d) { if (!video.src) return; video.currentTime = Math.max(0, Math.min((video.duration || 1e9), video.currentTime + d)); }
$('#btnPlay').onclick = togglePlay;
$('#btnBack5').onclick = () => seek(-5);
$('#btnFwd5').onclick = () => seek(5);
video.addEventListener('click', togglePlay);
$('#selSpeed').onchange = e => { video.playbackRate = Number(e.target.value); };
video.addEventListener('ratechange', () => { $('#selSpeed').value = String(video.playbackRate); });
video.addEventListener('play', () => $('#btnPlay').textContent = '⏸ Pause');
video.addEventListener('pause', () => $('#btnPlay').textContent = '▶ Play');
function trackGeom() {
  const tl = $('#timeline');
  const tr = tl.querySelector('.tr');
  const left = tr ? tr.offsetLeft : 120;
  const width = tr ? tr.clientWidth : Math.max(1, tl.clientWidth - 120);
  return { left, width };
}
function updateTime() {
  $('#timeDisp').textContent = fmtTime(video.currentTime) + ' / ' + fmtTime(video.duration || 0);
  const d = video.duration || 0, g = trackGeom();
  $('#tlHead').style.left = (g.left + (d ? video.currentTime / d * g.width : 0)) + 'px';
  if (Object.keys(open).length) renderCodeWindowTimers();
}
video.addEventListener('timeupdate', updateTime);
video.addEventListener('loadedmetadata', () => { updateTime(); renderTimeline(); });
window.addEventListener('resize', updateTime);
$('#timeline').addEventListener('click', e => {
  if (!video.duration) return;
  const r = $('#timeline').getBoundingClientRect(), g = trackGeom();
  const x = e.clientX - r.left - g.left;
  if (x < 0) return;
  video.currentTime = Math.min(1, x / g.width) * video.duration;
});
const videoSnap = () => ({ t: video.currentTime || 0, playing: !!(video.src && !video.paused), rate: video.playbackRate || 1 });

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
}
function setOutcome(ev, o) {
  ev.outcomeId = o ? o.id : ''; ev.outcome = o ? o.name : ''; ev.success = outcomeSuccess(o);
}
function setLabel(ev, group, label) {
  ev.labels = ev.labels || {};
  ev.labels[group.name] = label.name;
}
function makeInstance(code, t, start, end, opts) {
  const ev = {
    id: nextId++, codeId: code.id, code: code.name, type: code.type,
    t, start: Math.max(0, Math.round(start * 100) / 100), end: Math.round(end * 100) / 100,
    period: $('#selPeriod').value,
    playerId: '', team: '', num: '', name: '', pos: '',
    outcomeId: '', outcome: '', success: null, labels: {},
    source: opts.source || 'button', heard: opts.heard || ''
  };
  setPlayer(ev, opts.player);
  setOutcome(ev, opts.outcome || (code.def ? VOC.outcomesById[code.def] : null));
  (opts.labels || []).forEach(l => setLabel(ev, l.group, l.label));
  events.push(ev);
  seq++; target = { kind: 'event', id: ev.id, seq };
  lastNewId = ev.id;
  undoStack.push({ type: 'add', id: ev.id });
  return ev;
}
function tagInstant(code, t, opts = {}) {
  const ev = makeInstance(code, t, t - (Number(code.lead) || 0), t + (Number(code.lag) || 0), opts);
  renderAll(); autosave();
  flashCode(code.id);
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
  open[code.id] = { t, seq, player: opts.player || null, outcome: opts.outcome || null, labels: opts.labels || [], source: opts.source || 'button', heard: opts.heard || '' };
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
// item: {kind:'player'|'outcome'|'label', v}
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
      if (i >= 0) { const [ev] = events.splice(i, 1); renderAll(); autosave(); toast('Removed: ' + eventText(ev), 'info'); return; }
    }
  }
  toast('Nothing to undo', 'info');
}
$('#btnUndo').onclick = undo;
$('#btnClear').onclick = () => {
  if (!events.length) return;
  if (confirm('Delete ALL ' + events.length + ' tags? (Tip: save a project first.)')) { events = []; undoStack = []; open = {}; renderAll(); autosave(); }
};

/* ---------------------------------------------------------------- VOICE / TYPED COMMANDS */
function handleParsed(parsed, snapFor, source) {
  const heard = parsed.text;
  if (parsed.control) {
    logVoice(heard, 'Command: ' + parsed.control, 'ok');
    if (parsed.control === 'undo') undo();
    else if (parsed.control === 'pause') { video.pause(); toast('Paused', 'info'); }
    else if (parsed.control === 'play') { video.play(); toast('Playing', 'info'); }
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
    const opts = { player: c.player, outcome: c.outcomeSaid ? c.outcome : null, labels: c.labels, source, heard };
    if (c.code.type === 'duration') {
      const r = toggleDuration(c.code, t, opts, c.mode);
      msgs.push(r.action === 'started' ? '⏺ ' + c.code.name + ' started' : r.action === 'stopped' ? '⏹ ' + c.code.name + ' ' + fmtDur(r.ev.end - r.ev.start)
        : r.action === 'already' ? c.code.name + ' already running' : c.code.name + ' was not running');
    } else {
      if (!c.outcomeSaid) opts.outcome = c.outcome;
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
  const snap = { t: video.currentTime || 0, playing: false, rate: 1 };
  handleParsed(parseUtterance(txt), () => snap, 'typed');
  $('#cmdInput').value = '';
}
$('#btnType').onclick = runTyped;
$('#cmdInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runTyped(); } if (e.key === 'Escape') e.target.blur(); });

/* ---- offline speech recognition (Vosk) ---- */
const Voice = {
  model: null, rec: null, ctx: null, stream: null, src: null, node: null,
  fed: 0, sr: 48000, snaps: [], on: false, busy: false,
  async start() {
    if (this.on || this.busy) return;
    if (!window.Vosk) { alert('The voice engine is missing from this build.'); return; }
    this.busy = true; setMicUI('loading');
    try {
      if (!this.model) {
        const info = await api.modelInfo();
        if (!info.available) throw new Error('The voice model was not found. Run BUILD.bat again (it downloads the model) and reinstall.');
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
        this.snaps.push({ a: this.fed / this.sr, s: videoSnap() });
        if (this.snaps.length > 3000) this.snaps.splice(0, 1500);
        this.fed += e.inputBuffer.length;
        try { this.rec.acceptWaveform(e.inputBuffer); } catch (err) { /* ignore */ }
      };
      this.src.connect(this.node); this.node.connect(this.ctx.destination);
      this.on = true; setMicUI('on');
    } catch (err) {
      console.error(err);
      this.cleanup();
      setMicUI('off');
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
  b.classList.toggle('on', state === 'on');
  b.classList.toggle('loading', state === 'loading');
  b.innerHTML = state === 'on' ? '🔴 Voice: listening <kbd>M</kbd>' : state === 'loading' ? '⏳ Voice: starting…' : '🎤 Voice: off <kbd>M</kbd>';
  $('#micState').textContent = state === 'on' ? 'voice on (offline)' : state === 'loading' ? 'starting…' : 'voice off';
}
function toggleMic() { Voice.on ? Voice.stop() : Voice.start(); }
$('#btnMic').onclick = toggleMic;
function setHeard(txt, interim) {
  const el = $('#heardText');
  el.textContent = txt || '—';
  el.className = interim ? 'interim' : '';
}
function logVoice(heard, result, kind) {
  voiceLog.unshift({ at: fmtTime(video.currentTime), heard, result, kind });
  if (voiceLog.length > 300) voiceLog.pop();
  renderLog();
}
function renderLog() {
  $('#logList').innerHTML = voiceLog.length ? voiceLog.map(l =>
    `<div class="logrow"><span class="muted">${l.at}</span> &nbsp;<span class="h">“${esc(l.heard)}”</span><br><span class="${l.kind}">→ ${esc(l.result)}</span></div>`
  ).join('') : '<div class="muted empty">Nothing heard yet.</div>';
}
$('#btnClearLog').onclick = () => { voiceLog = []; renderLog(); };

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
  const codeBtn = c => `<button class="cbtn ${open[c.id] ? 'running' : ''}" style="--c:${esc(c.color)}" data-code="${esc(c.id)}">${esc(c.name)}${hk(c.hotkey)}<span class="ty" data-timer="${esc(c.id)}">${c.type === 'duration' ? (open[c.id] ? '● ' + fmtDur(Math.max(0, video.currentTime - open[c.id].t)) : '⏱ start / stop') : ''}</span></button>`;
  const inst = config.codes.filter(c => c.type !== 'duration'), dur = config.codes.filter(c => c.type === 'duration');
  let html = '';
  if (inst.length) html += `<div class="cwsec"><h4>Events</h4><div class="cwgrid">${inst.map(codeBtn).join('')}</div></div>`;
  if (dur.length) html += `<div class="cwsec"><h4>Phases (press to start, press again to stop)</h4><div class="cwgrid">${dur.map(codeBtn).join('')}</div></div>`;
  const lbtn = (kind, id, text, key, on) => `<button class="lbtn ${on ? 'on' : ''}" data-lkind="${kind}" data-lid="${esc(id)}">${esc(text)}${key ? `<span class="hk">${esc(String(key).toUpperCase())}</span>` : ''}</button>`;
  const home = config.players.filter(p => p.team !== 'Away'), away = config.players.filter(p => p.team === 'Away');
  html += `<div class="cwsec"><h4>Player – ${esc(config.general.homeName)}</h4><div class="lgrid">${home.map(p => lbtn('player', p.id, playerLabel(p), p.hotkey, cur.player === p.id)).join('')}</div></div>`;
  if (away.length) html += `<div class="cwsec"><h4>Player – ${esc(config.general.awayName)}</h4><div class="lgrid">${away.map(p => lbtn('player', p.id, playerLabel(p), p.hotkey, cur.player === p.id)).join('')}</div></div>`;
  html += `<div class="cwsec"><h4>Outcome</h4><div class="lgrid">${config.outcomes.map(o => lbtn('outcome', o.id, o.name, o.hotkey, cur.outcome === o.id)).join('')}</div></div>`;
  config.labelGroups.forEach(g => {
    html += `<div class="cwsec"><h4>${esc(g.name)}</h4><div class="lgrid">${g.labels.map(l => lbtn('label', g.id + '|' + l.id, l.name, l.hotkey, cur.labels[g.name] === l.name)).join('')}</div></div>`;
  });
  $('#codeWindow').innerHTML = html;
  $('#targetInfo').textContent = targetText();
}
function renderCodeWindowTimers() {
  Object.keys(open).forEach(id => {
    const el = document.querySelector(`[data-timer="${CSS.escape(id)}"]`);
    if (el) el.textContent = '● ' + fmtDur(Math.max(0, video.currentTime - open[id].t));
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
$('#btnEditCW').onclick = () => openSettings('codes');

/* ---------------------------------------------------------------- RENDER: EVENTS, TIMELINE, SUMMARY */
const sortedEvents = () => events.slice().sort((a, b) => a.t - b.t || a.id - b.id);
function renderFilters() {
  const keep = (sel, html) => { const v = sel.value; sel.innerHTML = html; sel.value = v; if (sel.value !== v) sel.value = ''; };
  const pOpts = config.players.map(p => `<option value="${p.id}">${esc(playerLabel(p))}</option>`).join('');
  keep($('#fCode'), '<option value="">All codes</option>' + config.codes.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join(''));
  keep($('#fPlayer'), '<option value="">All players</option>' + pOpts);
  keep($('#plPlayer'), '<option value="">Any player</option>' + pOpts);
  keep($('#plOutcome'), '<option value="">Any outcome</option>' + config.outcomes.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join(''));
}
function renderEvents() {
  const fc = $('#fCode').value, fp = $('#fPlayer').value;
  const list = sortedEvents().filter(e => (!fc || e.codeId === fc) && (!fp || e.playerId === fp));
  $('#evCount').textContent = events.length ? '(' + events.length + ')' : '';
  $('#evEmpty').classList.toggle('hidden', events.length > 0);
  $('#evEmpty').innerHTML = 'No tags yet. Open a video, then click a code button, press its key, type a command, or turn on Voice and say e.g. <code>right back pass</code>.';
  const pOpts = '<option value="">—</option>' + config.players.map(p => `<option value="${p.id}">${esc(playerLabel(p))}</option>`).join('');
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
    return `<tr data-id="${e.id}" class="${e.id === lastNewId ? 'new' : ''} ${sel ? 'sel' : ''}" title="${esc(e.heard ? 'Heard: ' + e.heard : 'Source: ' + e.source)}">
      <td><span class="tlink" data-seek="${e.start}"><span class="dot" style="background:${esc(code ? code.color : '#888')}"></span>${fmtTime(e.t)}</span></td>
      <td><select data-f="code">${cSel}</select></td>
      <td><select data-f="player">${pSel}</select></td>
      <td><select data-f="outcome" class="${cls}">${oOpts}</select></td>
      <td class="muted small">${esc(Object.values(e.labels || {}).join(', '))}</td>
      <td class="muted small">${fmtDur(e.end - e.start)}</td>
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
$('#evTable').addEventListener('click', e => {
  const s = e.target.closest('[data-seek]');
  if (s && video.src) { video.currentTime = Math.max(0, Number(s.dataset.seek)); }
  const d = e.target.closest('[data-del]');
  if (d) { const id = Number(d.dataset.del); events = events.filter(x => x.id !== id); renderAll(); autosave(); return; }
  const tr = e.target.closest('tr[data-id]');
  if (tr && !e.target.closest('select')) { seq++; target = { kind: 'event', id: Number(tr.dataset.id), seq }; renderEvents(); renderCodeWindow(); }
});
$('#evTable').addEventListener('change', e => {
  const tr = e.target.closest('tr[data-id]'); if (!tr) return;
  const ev = events.find(x => x.id === Number(tr.dataset.id)); if (!ev) return;
  const f = e.target.dataset.f, v = e.target.value;
  if (f === 'player') { if (!v) Object.assign(ev, { playerId: '', team: '', num: '', name: '', pos: '' }); else setPlayer(ev, VOC.playersById[v]); }
  if (f === 'outcome') setOutcome(ev, VOC.outcomesById[v] || null);
  if (f === 'code') {
    const c = VOC.codesById[v];
    if (c) {
      ev.codeId = c.id; ev.code = c.name; ev.type = c.type;
      if (ev.outcomeId && !c.outcomes.includes(ev.outcomeId)) setOutcome(ev, c.def ? VOC.outcomesById[c.def] : null);
    }
  }
  renderAll(); autosave();
});
$('#fCode').onchange = renderEvents;
$('#fPlayer').onchange = renderEvents;

function renderTimeline() {
  const d = video.duration || 0;
  const rows = config.codes.filter(c => events.some(e => e.codeId === c.id) || open[c.id]);
  const unknown = [...new Set(events.filter(e => !VOC.codesById[e.codeId]).map(e => e.code))];
  if (!rows.length && !unknown.length) { $('#tlRows').innerHTML = '<div class="tlempty">Your tags will appear here, one row per code.</div>'; updateTime(); return; }
  const bars = list => d ? list.map(e => `<div class="bar" style="left:${(e.start / d * 100).toFixed(3)}%;width:${(Math.max(0.2, e.end - e.start) / d * 100).toFixed(3)}%;background:var(--c)" title="${fmtTime(e.t)} ${esc(eventText(e))}"></div>`).join('') : '';
  let html = rows.map(c => {
    let b = bars(events.filter(e => e.codeId === c.id));
    if (open[c.id] && d) b += `<div class="bar" style="left:${(open[c.id].t / d * 100).toFixed(3)}%;width:${(Math.max(0.2, video.currentTime - open[c.id].t) / d * 100).toFixed(3)}%;background:var(--c);opacity:.5"></div>`;
    return `<div class="tlrow" style="--c:${esc(c.color)}"><div class="nm">${esc(c.name)}</div><div class="tr">${b}</div></div>`;
  }).join('');
  html += unknown.map(n => `<div class="tlrow" style="--c:#888"><div class="nm">${esc(n)}</div><div class="tr">${bars(events.filter(e => e.code === n && !VOC.codesById[e.codeId]))}</div></div>`).join('');
  $('#tlRows').innerHTML = html;
  updateTime();
}

function summaryRows() {
  const map = new Map();
  events.filter(e => e.playerId).forEach(e => {
    const k = e.playerId + '|' + e.codeId;
    if (!map.has(k)) map.set(k, { player: playerLabel(e), team: e.team, num: e.num, name: e.name, pos: e.pos, code: e.code, total: 0, succ: 0, fail: 0 });
    const r = map.get(k); r.total++; if (e.success === 1) r.succ++; if (e.success === 0) r.fail++;
  });
  return [...map.values()].sort((a, b) => (Number(a.num) || 999) - (Number(b.num) || 999) || a.player.localeCompare(b.player) || a.code.localeCompare(b.code));
}
function renderSummary() {
  const t = $('#sumTable');
  const pe = events.filter(e => e.playerId);
  if (!pe.length) t.innerHTML = '<tr><td class="muted">No player tags yet.</td></tr>';
  else {
    const cols = [...new Map(pe.map(e => [e.codeId, e.code])).entries()];
    const order = id => { const i = config.codes.findIndex(c => c.id === id); return i < 0 ? 999 : i; };
    cols.sort((a, b) => order(a[0]) - order(b[0]));
    const players = [...new Map(pe.map(e => [e.playerId, e])).values()].sort((a, b) => (Number(a.num) || 999) - (Number(b.num) || 999));
    const cell = list => {
      if (!list.length) return '<td class="muted">·</td>';
      const rated = list.filter(e => e.success === 0 || e.success === 1);
      const s = rated.filter(e => e.success === 1).length;
      const pct = rated.length ? ` <span class="${s / rated.length >= 0.7 ? 'ok' : s / rated.length >= 0.5 ? 'warn' : 'bad'}">(${Math.round(s / rated.length * 100)}%)</span>` : '';
      return `<td>${list.length}${pct}</td>`;
    };
    let html = '<thead><tr><th>Player</th>' + cols.map(c => `<th>${esc(c[1])}</th>`).join('') + '<th>All</th></tr></thead><tbody>';
    players.forEach(p => {
      const l = pe.filter(e => e.playerId === p.playerId);
      html += `<tr><td>${esc(playerLabel(p))}${p.name ? ' <span class="muted">' + esc(p.name) + '</span>' : ''}</td>` + cols.map(c => cell(l.filter(e => e.codeId === c[0]))).join('') + `<td><b>${l.length}</b></td></tr>`;
    });
    html += '<tr><td><b>Total</b></td>' + cols.map(c => cell(pe.filter(e => e.codeId === c[0]))).join('') + `<td><b>${pe.length}</b></td></tr></tbody>`;
    t.innerHTML = html;
  }
  const dr = durationRows();
  $('#durTable').innerHTML = dr.length
    ? '<thead><tr><th>Code</th><th>Count</th><th>Total time</th><th>Average</th></tr></thead><tbody>' + dr.map(r => `<tr><td>${esc(r.code)}</td><td>${r.count}</td><td>${fmtTime(r.total)}</td><td>${fmtDur(r.total / r.count)}</td></tr>`).join('') + '</tbody>'
    : '<tr><td class="muted">No phases tagged yet (e.g. Build-up).</td></tr>';
}
function durationRows() {
  const map = new Map();
  events.filter(e => e.type === 'duration').forEach(e => {
    if (!map.has(e.code)) map.set(e.code, { code: e.code, count: 0, total: 0 });
    const r = map.get(e.code); r.count++; r.total += e.end - e.start;
  });
  return [...map.values()];
}

function renderHelp() {
  const pills = arr => arr.map(x => `<span class="pill">${esc(x)}</span>`).join('');
  $('#tab-help').innerHTML = `
    <h3>Three ways to tag</h3>
    <ol>
      <li><b>Code window</b> – click a button or press its key. Event buttons (Pass, Shot…) make a clip around that moment. Phase buttons (Build-up…) start on the first press and stop on the second.</li>
      <li><b>Labels</b> – after a code, click a player / outcome / zone button (or press its key). It is added to the latest tag (shown at the top of the Code window). Click any row in Events to make it the target.</li>
      <li><b>Voice</b> (offline) – press <kbd>M</kbd> and say <code>right back pass</code>, <code>number nine shot goal</code>, <code>build up</code> … <code>build up stop</code>. Say just <code>unsuccessful</code> or <code>final third</code> to add a label to the latest tag.</li>
    </ol>
    <p>You can also type any voice command in the box under the video.</p>
    <h3>Playlist & video export</h3>
    <p>Open <b>Playlist</b>, pick codes (e.g. Build-up) and filters, then <b>Play selected</b> to watch them back-to-back, or export them as one joined video or separate clip files.</p>
    <h3>Players</h3><p>${pills(config.players.map(p => playerLabel(p) + (p.name ? ' · ' + p.name : '')))}</p>
    <h3>Codes</h3>${config.codes.map(c => `<p><b>${esc(c.name)}</b> <span class="muted">${c.hotkey ? '[' + esc(c.hotkey.toUpperCase()) + '] ' : ''}${c.type === 'duration' ? 'phase (start/stop)' : c.outcomes.length ? '→ ' + c.outcomes.map(id => VOC.outcomesById[id]?.name).filter(Boolean).join(', ') : ''}</span></p>`).join('')}
    <h3>Voice controls</h3><p>${pills(['undo', 'pause', 'play', 'rewind'])}</p>
    <h3>Voice tips</h3>
    <ul>
      <li>Use a headset mic and keep the match sound low.</li>
      <li>The offline voice engine knows common English words. Positions and shirt numbers work best; unusual surnames may not be recognised.</li>
      <li>Check the <b>Voice log</b>. If a word is often misheard, add the misheard word as an alias in Settings.</li>
      <li>Voice tags are placed ${esc(config.general.offset)} s before the moment you start speaking (reaction time). Change in Settings → General.</li>
    </ul>`;
}
function renderAll() { buildVocabIfNeeded(); renderFilters(); renderCodeWindow(); renderEvents(); renderTimeline(); renderSummary(); renderPlaylist(); renderHelp(); }
function buildVocabIfNeeded() { if (!VOC) buildVocab(); }

$$('#rightTabs button').forEach(b => b.onclick = () => {
  $$('#rightTabs button').forEach(x => x.classList.toggle('active', x === b));
  $$('#right .tabpane').forEach(p => p.classList.toggle('hidden', p.id !== 'tab-' + b.dataset.tab));
});

/* ---------------------------------------------------------------- PLAYLIST */
const PL = { codes: new Set(), excluded: new Set(), queue: [], idx: -1, active: false };
function playlistItems() {
  const pp = $('#plPlayer').value, po = $('#plOutcome').value;
  return sortedEvents().filter(e => (!PL.codes.size || PL.codes.has(e.codeId)) && (!pp || e.playerId === pp) && (!po || e.outcomeId === po));
}
function clipName(e) { return [e.code, e.playerId ? playerLabel(e) : '', e.outcome].filter(Boolean).join(' – '); }
function renderPlaylist() {
  const used = config.codes.filter(c => events.some(e => e.codeId === c.id));
  [...PL.codes].forEach(id => { if (!used.some(c => c.id === id)) PL.codes.delete(id); });
  $('#plCodes').innerHTML = used.length
    ? used.map(c => `<span class="chip ${PL.codes.has(c.id) ? 'on' : ''}" data-plc="${esc(c.id)}"><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)} <span class="muted">${events.filter(e => e.codeId === c.id).length}</span></span>`).join('')
    : '<span class="muted small">Tag something first. Then pick codes here (none picked = all).</span>';
  const items = playlistItems();
  const playing = PL.active ? PL.queue[PL.idx] : null;
  $('#plTable tbody').innerHTML = items.map(e => `<tr data-id="${e.id}" class="${playing && playing.id === e.id ? 'playing' : ''}">
    <td><input type="checkbox" data-plx="${e.id}" ${PL.excluded.has(e.id) ? '' : 'checked'}></td>
    <td><span class="tlink" data-plgo="${e.id}">${fmtTime(e.start)}</span></td>
    <td>${esc(clipName(e))}${Object.values(e.labels || {}).length ? ' <span class="muted small">' + esc(Object.values(e.labels).join(', ')) + '</span>' : ''}</td>
    <td class="muted small">${fmtDur(e.end - e.start)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No clips match.</td></tr>';
  const sel = items.filter(e => !PL.excluded.has(e.id));
  $('#plInfo').textContent = sel.length + ' clip(s), ' + fmtTime(sel.reduce((s, e) => s + e.end - e.start, 0)) + ' total';
}
$('#plCodes').addEventListener('click', e => {
  const c = e.target.closest('[data-plc]'); if (!c) return;
  const id = c.dataset.plc; PL.codes.has(id) ? PL.codes.delete(id) : PL.codes.add(id);
  renderPlaylist();
});
$('#plPlayer').onchange = renderPlaylist;
$('#plOutcome').onchange = renderPlaylist;
$('#plAll').onchange = e => { const items = playlistItems(); items.forEach(x => e.target.checked ? PL.excluded.delete(x.id) : PL.excluded.add(x.id)); renderPlaylist(); };
$('#plTable').addEventListener('change', e => { const x = e.target.closest('[data-plx]'); if (!x) return; const id = Number(x.dataset.plx); x.checked ? PL.excluded.delete(id) : PL.excluded.add(id); renderPlaylist(); });
$('#plTable').addEventListener('click', e => {
  const g = e.target.closest('[data-plgo]'); if (!g) return;
  const items = selectedClips(); const i = items.findIndex(x => x.id === Number(g.dataset.plgo));
  if (i >= 0) startPlaylist(items, i); else { const ev = events.find(x => x.id === Number(g.dataset.plgo)); if (ev) video.currentTime = ev.start; }
});
const selectedClips = () => playlistItems().filter(e => !PL.excluded.has(e.id));
function startPlaylist(items, from = 0) {
  if (!video.src) { toast('Open the video first', 'bad'); return; }
  if (!items.length) { toast('No clips selected', 'bad'); return; }
  PL.queue = items; PL.active = true; plGo(from);
  requestAnimationFrame(plTick);
}
function plGo(i) {
  if (i < 0 || i >= PL.queue.length) { plStop(); return; }
  PL.idx = i;
  const c = PL.queue[i];
  video.currentTime = c.start; video.play();
  $('#plBanner').classList.remove('hidden');
  $('#plBanner').textContent = `▶ ${i + 1}/${PL.queue.length}  ${clipName(c)}  ·  ${fmtTime(c.t)}`;
  renderPlaylist();
}
function plTick() {
  if (!PL.active) return;
  const c = PL.queue[PL.idx];
  if (c && !video.seeking && video.currentTime >= c.end) plGo(PL.idx + 1);
  if (PL.active) requestAnimationFrame(plTick);
}
function plStop() { PL.active = false; PL.idx = -1; video.pause(); $('#plBanner').classList.add('hidden'); renderPlaylist(); }
$('#plPlay').onclick = () => startPlaylist(selectedClips(), 0);
$('#plStop').onclick = plStop;
$('#plNext').onclick = () => { if (PL.active) plGo(PL.idx + 1); };
$('#plPrev').onclick = () => { if (PL.active) plGo(Math.max(0, PL.idx - 1)); };

async function exportVideo(mode) {
  const clips = selectedClips();
  if (!clips.length) { toast('No clips selected', 'bad'); return; }
  if (!api.isDesktop) { alert('Video export only works in the installed desktop app.'); return; }
  if (!videoInfo.path) { alert('Open the match video first (the original file is needed to cut the clips).'); return; }
  const ff = await api.ffmpegInfo();
  if (!ff.available) { alert('The video tool (ffmpeg) is missing. Re-run BUILD.bat to rebuild the app.'); return; }
  const codes = [...new Set(clips.map(c => c.code))].join('+');
  $('#plProgress').classList.remove('hidden'); $('#plBar').style.width = '0%'; $('#plProgText').textContent = 'Starting…';
  $('#plExportOne').disabled = $('#plExportSep').disabled = true;
  try {
    const r = await api.exportClips({
      videoPath: videoInfo.path, mode, quality: $('#plQuality').value,
      defaultName: baseName(videoInfo.name) + ' - ' + codes.replace(/[\\/:*?"<>|]/g, '') + '.mp4',
      clips: clips.map(c => ({ start: Math.max(0, c.start), end: c.end, name: clipName(c) }))
    });
    if (r.ok) { toast('Video export finished', 'ok', 3000); if (r.path) api.showInFolder(r.path); }
    else if (!r.canceled) alert('Export failed:\n\n' + r.error);
  } finally {
    $('#plProgress').classList.add('hidden');
    $('#plExportOne').disabled = $('#plExportSep').disabled = false;
  }
}
api.onExportProgress(p => {
  $('#plBar').style.width = p.percent + '%';
  $('#plProgText').textContent = p.stage === 'joining' ? 'Joining clips…' : `Clip ${Math.min(p.index + 1, p.count)} of ${p.count} – ${p.percent}%`;
});
$('#plExportOne').onclick = () => exportVideo('single');
$('#plExportSep').onclick = () => exportVideo('separate');
$('#plCancel').onclick = () => api.cancelExport();

/* ---------------------------------------------------------------- AUTOSAVE */
let autosaveTimer = null;
function autosave() { clearTimeout(autosaveTimer); autosaveTimer = setTimeout(autosaveNow, 400); }
function autosaveNow() {
  try {
    if (events.length) localStorage.setItem(sessionKey, JSON.stringify({ events, nextId, video: videoInfo, savedAt: new Date().toISOString() }));
    else localStorage.removeItem(sessionKey);
  } catch (e) { /* ignore */ }
}
window.addEventListener('beforeunload', autosaveNow);
api.onClosing(autosaveNow);

/* ---------------------------------------------------------------- EXPORTS: CSV / XML / EXCEL / PROJECT */
const baseName = n => (n ? n.replace(/\.[^.]+$/, '') : 'match');
const teamName = key => key === 'Away' ? config.general.awayName : key === 'Home' ? config.general.homeName : (key || '');
function labelGroupNames() {
  const names = config.labelGroups.map(g => g.name);
  events.forEach(e => Object.keys(e.labels || {}).forEach(k => { if (!names.includes(k)) names.push(k); }));
  return names;
}
function eventHead() { return ['ID', 'Period', 'Code', 'Type', 'Time', 'Seconds', 'Clip start (s)', 'Clip end (s)', 'Duration (s)', 'Team', 'Number', 'Player name', 'Position', 'Outcome', 'Success (1/0)', ...labelGroupNames(), 'Source', 'Heard']; }
function eventRow(e) {
  return [e.id, e.period, e.code, e.type === 'duration' ? 'Phase' : 'Event', fmtTime(e.t), e.t, e.start, e.end, Math.round((e.end - e.start) * 100) / 100,
    teamName(e.team), e.num === '' || e.num == null ? '' : (isNaN(e.num) ? e.num : Number(e.num)), e.name, e.pos, e.outcome,
    e.success === 1 ? 1 : e.success === 0 ? 0 : '', ...labelGroupNames().map(g => (e.labels || {})[g] || ''), e.source, e.heard];
}
function requireEvents() { if (!events.length) { toast('No tags to export yet', 'bad'); return false; } return true; }
async function saveText(name, data, ext, desc) {
  const p = await api.saveFile({ defaultName: name, filters: [{ name: desc, extensions: [ext] }], data });
  if (p) toast('Saved ' + (String(p).split(/[\\/]/).pop()), 'info');
}

$('#btnCsv').onclick = () => {
  if (!requireEvents()) return;
  const q = v => { v = String(v ?? ''); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const lines = [eventHead().map(q).join(',')].concat(sortedEvents().map(e => eventRow(e).map(q).join(',')));
  saveText(baseName(videoInfo.name) + ' tags.csv', '﻿' + lines.join('\r\n'), 'csv', 'CSV');
};

const xmlEsc = s => String(s ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
function hexToRGB16(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return [32768, 32768, 32768];
  const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => v * 257);
}
const PALETTE = ['#3ea6ff', '#ff5a5f', '#2ecc71', '#f5b041', '#a66bff', '#1abc9c', '#e67e22', '#ff77c8', '#95a5a6', '#58d68d', '#5dade2', '#f4d03f', '#af7ac5', '#48c9b0', '#dc7633'];
function buildXml() {
  const mode = config.general.xmlCode;
  const codeOf = e => mode === 'player' && e.playerId ? playerLabel(e) : mode === 'both' && e.playerId ? playerLabel(e) + ' - ' + e.code : e.code;
  const rows = new Map();
  let out = '<?xml version="1.0" encoding="utf-8"?>\n<file>\n  <ALL_INSTANCES>\n';
  sortedEvents().forEach(e => {
    const code = codeOf(e);
    if (!rows.has(code)) { const c = VOC.codesById[e.codeId]; rows.set(code, mode === 'code' && c ? c.color : PALETTE[rows.size % PALETTE.length]); }
    const labels = [['Player', e.playerId ? playerLabel(e) : ''], ['Player name', e.name], ['Team', e.playerId ? teamName(e.team) : ''], ['Position', e.pos],
      ['Code', mode !== 'code' ? e.code : ''], ['Outcome', e.outcome], ['Period', e.period], ...Object.entries(e.labels || {})];
    out += '    <instance>\n' +
      `      <ID>${e.id}</ID>\n      <start>${e.start.toFixed(2)}</start>\n      <end>${e.end.toFixed(2)}</end>\n      <code>${xmlEsc(code)}</code>\n` +
      labels.filter(l => l[1] !== '' && l[1] != null).map(l => `      <label>\n        <group>${xmlEsc(l[0])}</group>\n        <text>${xmlEsc(l[1])}</text>\n      </label>\n`).join('') +
      '    </instance>\n';
  });
  out += '  </ALL_INSTANCES>\n  <ROWS>\n';
  rows.forEach((color, code) => { const [r, g, b] = hexToRGB16(color); out += `    <row>\n      <code>${xmlEsc(code)}</code>\n      <R>${r}</R>\n      <G>${g}</G>\n      <B>${b}</B>\n    </row>\n`; });
  return out + '  </ROWS>\n</file>\n';
}
$('#btnXml').onclick = () => { if (requireEvents()) saveText(baseName(videoInfo.name) + ' timeline.xml', buildXml(), 'xml', 'XML timeline'); };

/* ---- minimal XLSX writer (no external libraries) ---- */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zipStore(files) {
  const enc = new TextEncoder(), d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [], central = [];
  let offset = 0;
  files.forEach(f => {
    const name = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  });
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(4, 0, true); end.setUint16(6, 0, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true); end.setUint16(20, 0, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const total = all.reduce((s, a) => s + a.length, 0), out = new Uint8Array(total);
  let p = 0; all.forEach(a => { out.set(a, p); p += a.length; });
  return out;
}
function colName(i) { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
function sheetXml(rows, widths) {
  let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
  if (widths) x += '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>';
  x += '<sheetData>';
  rows.forEach((row, r) => {
    x += `<row r="${r + 1}">`;
    row.forEach((v, c) => {
      if (v === '' || v == null) return;
      const ref = colName(c) + (r + 1), s = r === 0 ? ' s="1"' : '';
      if (typeof v === 'number' && isFinite(v)) x += `<c r="${ref}"${s}><v>${v}</v></c>`;
      else x += `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    });
    x += '</row>';
  });
  return x + '</sheetData></worksheet>';
}
function buildXlsx(sheets) {
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"><sheets>` + sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + `<Relationship Id="rId${sheets.length + 1}" Type="${R}/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3A5F"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' }
  ];
  sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows, s.widths) }));
  return zipStore(files);
}
function workbookSheets() {
  const head = eventHead();
  const evRows = [head].concat(sortedEvents().map(eventRow));
  const pct = (s, f) => (s + f) ? Math.round(s / (s + f) * 1000) / 10 : '';
  const numOrBlank = n => n === '' || n == null ? '' : (isNaN(n) ? n : Number(n));
  const sumRows = [['Team', 'Number', 'Player name', 'Position', 'Code', 'Total', 'Successful', 'Unsuccessful', 'Success %']].concat(
    summaryRows().map(r => [teamName(r.team), numOrBlank(r.num), r.name, r.pos, r.code, r.total, r.succ, r.fail, pct(r.succ, r.fail)]));
  const byPlayer = new Map();
  events.filter(e => e.playerId).forEach(e => {
    if (!byPlayer.has(e.playerId)) byPlayer.set(e.playerId, { e, total: 0, succ: 0, fail: 0 });
    const r = byPlayer.get(e.playerId); r.total++; if (e.success === 1) r.succ++; if (e.success === 0) r.fail++;
  });
  const plRows = [['Team', 'Number', 'Player name', 'Position', 'Total tags', 'Successful', 'Unsuccessful', 'Success %']].concat(
    [...byPlayer.values()].sort((a, b) => (Number(a.e.num) || 999) - (Number(b.e.num) || 999)).map(r =>
      [teamName(r.e.team), numOrBlank(r.e.num), r.e.name, r.e.pos, r.total, r.succ, r.fail, pct(r.succ, r.fail)]));
  const codeMap = new Map();
  events.forEach(e => {
    if (!codeMap.has(e.code)) codeMap.set(e.code, { type: e.type, n: 0, s: 0, f: 0, d: 0 });
    const r = codeMap.get(e.code); r.n++; if (e.success === 1) r.s++; if (e.success === 0) r.f++; r.d += e.end - e.start;
  });
  const codeRows = [['Code', 'Type', 'Count', 'Successful', 'Unsuccessful', 'Success %', 'Total time (s)', 'Average time (s)']].concat(
    [...codeMap.entries()].map(([k, r]) => [k, r.type === 'duration' ? 'Phase' : 'Event', r.n, r.s, r.f, pct(r.s, r.f), Math.round(r.d * 10) / 10, Math.round(r.d / r.n * 10) / 10]));
  return [
    { name: 'Events', rows: evRows, widths: head.map((h, i) => [6, 7, 16, 8, 8, 9, 11, 11, 11, 12, 8, 18, 22, 14, 12][i] || (h === 'Heard' ? 40 : 15)) },
    { name: 'Player x Code', rows: sumRows, widths: [12, 8, 18, 22, 18, 8, 11, 13, 10] },
    { name: 'Player totals', rows: plRows, widths: [12, 8, 18, 22, 11, 11, 13, 10] },
    { name: 'Code totals', rows: codeRows, widths: [20, 8, 8, 11, 13, 10, 14, 15] }
  ];
}
$('#btnXlsx').onclick = async () => {
  if (!requireEvents()) return;
  const p = await api.saveFile({ defaultName: baseName(videoInfo.name) + ' tags.xlsx', filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }], data: buildXlsx(workbookSheets()), encoding: 'binary' });
  if (p) toast('Saved Excel file', 'info');
};

$('#btnSaveProj').onclick = () => {
  const proj = { app: 'VoiceTag', version: 2, savedAt: new Date().toISOString(), video: videoInfo, config, events, nextId };
  saveText(baseName(videoInfo.name) + '.vtproj', JSON.stringify(proj, null, 1), 'vtproj', 'VoiceTag project');
};
$('#btnOpenProj').onclick = async () => {
  const f = await api.openTextFile({ filters: [{ name: 'VoiceTag project', extensions: ['vtproj', 'json'] }] });
  if (!f) return;
  try {
    const p = JSON.parse(f.text);
    if (p.app !== 'VoiceTag' || !Array.isArray(p.events)) throw new Error('This is not a VoiceTag project file.');
    if (events.length && !confirm('Replace the ' + events.length + ' current tags with the ' + p.events.length + ' tags from this project?')) return;
    if (p.config && confirm('Also load the buttons / players / settings saved in this project?')) { config = migrate(p.config); saveConfig(); buildVocab(); Voice.refreshVocabulary(); }
    // version-1 events → version-2 format
    const evs = p.events.map(e => Object.assign({ codeId: e.actionId || e.codeId, code: e.action || e.code, type: e.type || 'instant', labels: {} },
      e, { start: e.start != null ? e.start : Math.max(0, e.t - 5), end: e.end != null ? e.end : e.t + 5 }));
    let loaded = false;
    if (p.video && p.video.path && api.isDesktop) {
      const r = await api.registerMedia(p.video.path);
      if (r) { setVideo(r); loaded = true; }
      else alert('The video for this project was not found at:\n' + p.video.path + '\n\nOpen the video manually with "Open video".');
    }
    events = evs; nextId = p.nextId || (Math.max(0, ...evs.map(x => x.id)) + 1); undoStack = []; open = {};
    if (!loaded && p.video) videoInfo = Object.assign({}, p.video, { path: videoInfo.path || '' });
    renderAll(); autosave();
    toast('Opened project: ' + evs.length + ' tags', 'info', 3000);
  } catch (err) { alert('Could not open project: ' + err.message); }
};

/* ---------------------------------------------------------------- SETTINGS */
let draft = null, setTab = 'codes';
function openSettings(tab) {
  draft = JSON.parse(JSON.stringify(config));
  if (tab) setTab = tab;
  $$('#setTabs button').forEach(x => x.classList.toggle('active', x.dataset.st === setTab));
  $('#confirmMsg').textContent = '';
  renderSettings();
  $('#settings').classList.remove('hidden');
}
function closeSettings() { $('#settings').classList.add('hidden'); draft = null; }
$('#btnSettings').onclick = () => openSettings();
$('#setCancel').onclick = closeSettings;
$$('#setTabs button').forEach(b => b.onclick = () => {
  setTab = b.dataset.st;
  $$('#setTabs button').forEach(x => x.classList.toggle('active', x === b));
  renderSettings();
});
const hkInput = v => `<input class="hk" data-f="hotkey" maxlength="1" value="${esc(String(v || '').toUpperCase())}" title="One key (letter or number)">`;
function renderSettings() {
  const body = $('#setBody'), g = draft.general;
  if (setTab === 'codes') {
    body.innerHTML = `<p class="muted"><b>Event</b> codes make a clip around one moment (lead = seconds before, lag = seconds after). <b>Phase</b> codes (e.g. Build-up) start on the first press and stop on the second. The key is the keyboard shortcut. Voice aliases are other words you may say for this code.</p>
    <table><thead><tr><th style="width:150px">Code</th><th style="width:105px">Type</th><th style="width:56px">Key</th><th>Voice aliases</th><th>Possible outcomes</th><th style="width:120px">Default outcome</th><th style="width:56px">Lead</th><th style="width:56px">Lag</th><th style="width:50px">Colour</th><th style="width:66px"></th></tr></thead><tbody>
    ${draft.codes.map((c, i) => `<tr data-kind="codes" data-i="${i}">
      <td><input data-f="name" value="${esc(c.name)}"></td>
      <td><select data-f="type"><option value="instant" ${c.type !== 'duration' ? 'selected' : ''}>Event</option><option value="duration" ${c.type === 'duration' ? 'selected' : ''}>Phase</option></select></td>
      <td>${hkInput(c.hotkey)}</td>
      <td><input data-f="aliases" value="${esc(c.aliases)}"></td>
      <td>${draft.outcomes.map(o => `<label class="ocheck"><input type="checkbox" data-f="outcome" data-oid="${o.id}" ${c.outcomes.includes(o.id) ? 'checked' : ''}>${esc(o.name)}</label>`).join('')}</td>
      <td><select data-f="def"><option value="">— none —</option>${c.outcomes.map(id => draft.outcomes.find(o => o.id === id)).filter(Boolean).map(o => `<option value="${o.id}" ${c.def === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></td>
      <td><input class="num" type="number" min="0" step="1" data-f="lead" value="${esc(c.lead)}"></td>
      <td><input class="num" type="number" min="0" step="1" data-f="lag" value="${esc(c.lag)}"></td>
      <td><input type="color" data-f="color" value="${esc(c.color || '#888888')}" style="padding:0;height:28px"></td>
      <td><button class="small" data-move="-1" title="Move up">↑</button><button class="small danger" data-delrow title="Delete">✕</button></td></tr>`).join('')}
    </tbody></table>
    <div class="toolbar" style="margin-top:10px"><button data-add="codes">+ Add event code</button><button data-add="phase">+ Add phase code</button></div>`;
  } else if (setTab === 'players') {
    body.innerHTML = `<p class="muted">Say a player by <b>position</b>, <b>name</b>, <b>surname</b> or <b>number</b> (“number seven”). Extra aliases = other words you may say, or words the computer often mishears. The key is optional.</p>
    <table><thead><tr><th style="width:130px">Team</th><th style="width:66px">No.</th><th>Name</th><th>Position (spoken)</th><th>Extra voice aliases</th><th style="width:56px">Key</th><th style="width:66px"></th></tr></thead><tbody>
    ${draft.players.map((p, i) => `<tr data-kind="players" data-i="${i}">
      <td><select data-f="team"><option value="Home" ${p.team !== 'Away' ? 'selected' : ''}>${esc(g.homeName)}</option><option value="Away" ${p.team === 'Away' ? 'selected' : ''}>${esc(g.awayName)}</option></select></td>
      <td><input class="num" data-f="num" value="${esc(p.num)}"></td>
      <td><input data-f="name" value="${esc(p.name)}" placeholder="e.g. James Smith"></td>
      <td><input data-f="pos" value="${esc(p.pos)}" placeholder="e.g. Right Back"></td>
      <td><input data-f="aliases" value="${esc(p.aliases)}"></td>
      <td>${hkInput(p.hotkey)}</td>
      <td><button class="small" data-move="-1" title="Move up">↑</button><button class="small danger" data-delrow title="Delete">✕</button></td></tr>`).join('')}
    </tbody></table>
    <div class="toolbar" style="margin-top:10px"><button data-add="players">+ Add player</button><button data-add="opp">+ Add opposition player</button></div>`;
  } else if (setTab === 'outcomes') {
    body.innerHTML = `<p class="muted"><b>Positive</b> outcomes count as success (1), <b>Negative</b> as failure (0) in the exports and success %.</p>
    <table><thead><tr><th style="width:180px">Outcome</th><th>Voice aliases</th><th style="width:170px">Type</th><th style="width:56px">Key</th><th style="width:66px"></th></tr></thead><tbody>
    ${draft.outcomes.map((o, i) => `<tr data-kind="outcomes" data-i="${i}">
      <td><input data-f="name" value="${esc(o.name)}"></td>
      <td><input data-f="aliases" value="${esc(o.aliases)}"></td>
      <td><select data-f="type"><option value="pos" ${o.type === 'pos' ? 'selected' : ''}>Positive (success)</option><option value="neg" ${o.type === 'neg' ? 'selected' : ''}>Negative (fail)</option><option value="neu" ${o.type === 'neu' ? 'selected' : ''}>Neutral</option></select></td>
      <td>${hkInput(o.hotkey)}</td>
      <td><button class="small" data-move="-1" title="Move up">↑</button><button class="small danger" data-delrow title="Delete">✕</button></td></tr>`).join('')}
    </tbody></table>
    <div class="toolbar" style="margin-top:10px"><button data-add="outcomes">+ Add outcome</button></div>`;
  } else if (setTab === 'labels') {
    body.innerHTML = `<p class="muted">Label groups are extra keywords you can add to any tag (like Sportscode labels), e.g. <b>Zone</b>: Final Third, or <b>Phase of play</b>: Transition. One label per group per tag. Labels can also be spoken.</p>
    ${draft.labelGroups.map((gr, gi) => `<div class="groupbox">
      <div class="toolbar" data-group="${gi}"><b>Group</b><input data-gf="name" value="${esc(gr.name)}" style="width:220px"><div class="spacer"></div><button class="small danger" data-delgroup="${gi}">Delete group</button></div>
      <table><thead><tr><th>Label</th><th>Voice aliases</th><th style="width:56px">Key</th><th style="width:36px"></th></tr></thead><tbody>
      ${gr.labels.map((l, li) => `<tr data-kind="label" data-g="${gi}" data-i="${li}"><td><input data-f="name" value="${esc(l.name)}"></td><td><input data-f="aliases" value="${esc(l.aliases || '')}"></td><td>${hkInput(l.hotkey)}</td><td><button class="small danger" data-delrow>✕</button></td></tr>`).join('')}
      </tbody></table>
      <div class="toolbar" style="margin-top:6px"><button class="small" data-addlabel="${gi}">+ Add label</button></div></div>`).join('')}
    <button data-add="group">+ Add label group</button>`;
  } else {
    body.innerHTML = `<div class="grid2">
      <label>Voice reaction offset (seconds)</label><input type="number" step="0.5" min="0" max="10" data-g="offset" value="${esc(g.offset)}">
      <span class="hint">While the video plays, a voice tag is placed this many seconds before you start speaking. Not applied when the video is paused.</span>
      <label>Button / key offset (seconds)</label><input type="number" step="0.5" min="0" max="10" data-g="hotkeyOffset" value="${esc(g.hotkeyOffset)}">
      <label>Voice matching strictness</label><input type="range" min="0.55" max="0.95" step="0.01" data-g="strictness" value="${esc(g.strictness)}">
      <span class="hint">Current: <b id="strictVal">${Number(g.strictness).toFixed(2)}</b>. Lower = accepts more mis-heard words (but more wrong tags).</span>
      <label>Only listen for my words</label><input type="checkbox" data-g="useGrammar" ${g.useGrammar ? 'checked' : ''} style="justify-self:start">
      <span class="hint">Recommended. The voice engine only listens for your players, codes, outcomes and labels – much more accurate, ignores other chatter.</span>
      <label>Voice controls (undo / pause / play / rewind)</label><input type="checkbox" data-g="voiceControl" ${g.voiceControl ? 'checked' : ''} style="justify-self:start">
      <label>Beep when a tag is recorded</label><input type="checkbox" data-g="beep" ${g.beep ? 'checked' : ''} style="justify-self:start">
      <label>XML timeline rows</label><select data-g="xmlCode"><option value="code" ${g.xmlCode === 'code' ? 'selected' : ''}>One row per code</option><option value="player" ${g.xmlCode === 'player' ? 'selected' : ''}>One row per player</option><option value="both" ${g.xmlCode === 'both' ? 'selected' : ''}>Player + code</option></select>
      <label>Home team name</label><input data-g="homeName" value="${esc(g.homeName)}">
      <label>Opposition team name</label><input data-g="awayName" value="${esc(g.awayName)}">
    </div>`;
  }
}
$('#setBody').addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.g) {
    const k = t.dataset.g;
    draft.general[k] = t.type === 'checkbox' ? t.checked : (t.type === 'number' || t.type === 'range') ? Number(t.value) : t.value;
    if (k === 'strictness') $('#strictVal').textContent = Number(t.value).toFixed(2);
    return;
  }
  if (t.dataset.gf) { const gi = Number(t.closest('[data-group]').dataset.group); draft.labelGroups[gi].name = t.value; return; }
  const tr = t.closest('tr[data-kind]'); if (!tr) return;
  const kind = tr.dataset.kind, i = Number(tr.dataset.i);
  const obj = kind === 'label' ? draft.labelGroups[Number(tr.dataset.g)].labels[i] : draft[kind][i];
  const f = t.dataset.f;
  if (f === 'outcome') {
    const id = t.dataset.oid;
    obj.outcomes = obj.outcomes.filter(x => x !== id);
    if (t.checked) obj.outcomes.push(id);
    if (!obj.outcomes.includes(obj.def)) obj.def = '';
    renderSettings(); return;
  }
  if (f === 'hotkey') { t.value = t.value.toUpperCase(); obj.hotkey = t.value; return; }
  if (f === 'num') obj.num = t.value.trim() === '' ? '' : (isNaN(t.value) ? t.value.trim() : Number(t.value));
  else if (f === 'lead' || f === 'lag') obj[f] = Number(t.value) || 0;
  else obj[f] = t.value;
  if (f === 'type') { obj.lead = obj.type === 'duration' ? 2 : 5; obj.lag = obj.type === 'duration' ? 2 : 5; renderSettings(); }
});
$('#setBody').addEventListener('click', e => {
  const del = e.target.closest('[data-delrow]');
  if (del) {
    const tr = del.closest('tr[data-kind]'); const kind = tr.dataset.kind, i = Number(tr.dataset.i);
    if (kind === 'label') draft.labelGroups[Number(tr.dataset.g)].labels.splice(i, 1);
    else {
      const removed = draft[kind].splice(i, 1)[0];
      if (kind === 'outcomes') draft.codes.forEach(c => { c.outcomes = c.outcomes.filter(x => x !== removed.id); if (c.def === removed.id) c.def = ''; });
    }
    renderSettings(); return;
  }
  const mv = e.target.closest('[data-move]');
  if (mv) {
    const tr = mv.closest('tr[data-kind]'); const arr = draft[tr.dataset.kind], i = Number(tr.dataset.i);
    if (i > 0) { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; renderSettings(); }
    return;
  }
  const dg = e.target.closest('[data-delgroup]');
  if (dg) { if (confirm('Delete this label group?')) { draft.labelGroups.splice(Number(dg.dataset.delgroup), 1); renderSettings(); } return; }
  const al = e.target.closest('[data-addlabel]');
  if (al) { draft.labelGroups[Number(al.dataset.addlabel)].labels.push({ id: uid(), name: 'New label', hotkey: '', aliases: '' }); renderSettings(); return; }
  const add = e.target.closest('[data-add]');
  if (add) {
    const k = add.dataset.add;
    if (k === 'players') draft.players.push({ id: uid(), team: 'Home', num: '', name: '', pos: '', aliases: '', hotkey: '' });
    if (k === 'opp') draft.players.push({ id: uid(), team: 'Away', num: '', name: '', pos: 'Opposition', aliases: '', hotkey: '' });
    if (k === 'codes' || k === 'phase') {
      const dur = k === 'phase';
      draft.codes.push({ id: uid(), name: dur ? 'New phase' : 'New code', type: dur ? 'duration' : 'instant', hotkey: '', aliases: '', outcomes: [], def: '', color: PALETTE[draft.codes.length % PALETTE.length], lead: dur ? 2 : 5, lag: dur ? 2 : 5 });
    }
    if (k === 'outcomes') draft.outcomes.push({ id: uid(), name: 'New outcome', aliases: '', type: 'neu', hotkey: '' });
    if (k === 'group') draft.labelGroups.push({ id: uid(), name: 'New group', labels: [{ id: uid(), name: 'New label', hotkey: '', aliases: '' }] });
    renderSettings();
    const b = $('#setBody'); b.scrollTop = b.scrollHeight;
  }
});
function findProblems(cfg) {
  const warn = [];
  // hotkeys used twice / reserved
  const keys = new Map();
  const addKey = (k, what) => { k = String(k || '').trim().toUpperCase(); if (!k) return; if (RESERVED_KEYS.has(k)) warn.push(`Key "${k}" (${what}) is reserved for the video controls`); if (keys.has(k)) warn.push(`Key "${k}" is used by both ${keys.get(k)} and ${what}`); else keys.set(k, what); };
  cfg.codes.forEach(c => addKey(c.hotkey, c.name));
  cfg.outcomes.forEach(o => addKey(o.hotkey, o.name));
  cfg.players.forEach(p => addKey(p.hotkey, playerLabel(p)));
  cfg.labelGroups.forEach(g => g.labels.forEach(l => addKey(l.hotkey, g.name + ': ' + l.name)));
  // spoken names that sound almost the same
  const check = (list, getList, getName) => {
    const all = [];
    list.forEach(item => makeKeys(getList(item)).forEach(k => all.push({ item, k })));
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      if (all[i].item === all[j].item) continue;
      if (all[i].k.key.length < 3 && all[i].k.key !== all[j].k.key) continue;
      if (sim(all[i].k.key, all[j].k.key) >= 0.9) warn.push(`Spoken “${all[i].k.text}” (${getName(all[i].item)}) sounds like “${all[j].k.text}” (${getName(all[j].item)})`);
    }
  };
  check(cfg.players, playerSpokenList, playerLabel);
  check(cfg.codes, c => [c.name, ...splitAliases(c.aliases)], c => c.name);
  return [...new Set(warn)];
}
$('#setSave').onclick = () => {
  draft.players = draft.players.filter(p => String(p.num).trim() !== '' || String(p.name).trim() || String(p.pos).trim());
  draft.codes = draft.codes.filter(c => String(c.name).trim());
  draft.outcomes = draft.outcomes.filter(o => String(o.name).trim());
  draft.labelGroups = draft.labelGroups.filter(g => String(g.name).trim()).map(g => (g.labels = g.labels.filter(l => String(l.name).trim()), g));
  const probs = findProblems(draft);
  if (probs.length && !confirm('Please check:\n\n' + probs.slice(0, 14).join('\n') + '\n\nSave anyway?')) return;
  config = draft; saveConfig(); buildVocab(); closeSettings(); renderAll(); Voice.refreshVocabulary();
  toast('Settings saved', 'info');
};
$('#setReset').onclick = () => {
  if (confirm('Reset ALL codes, players, outcomes, labels and settings to the defaults? (Your tags are kept.)')) { draft = DEFAULT_CONFIG(); renderSettings(); $('#confirmMsg').textContent = 'Defaults loaded – click Save settings to apply.'; }
};

/* ---------------------------------------------------------------- KEYBOARD */
document.addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (!$('#settings').classList.contains('hidden')) { if (e.key === 'Escape') closeSettings(); return; }
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  if (e.altKey) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey) return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); return; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); seek(e.shiftKey ? -1 : -5); return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); seek(e.shiftKey ? 1 : 5); return; }
  if (e.key === ',' || e.key === '.') { e.preventDefault(); video.pause(); seek(e.key === ',' ? -0.04 : 0.04); return; }
  if (e.key === '/') { e.preventDefault(); $('#cmdInput').focus(); return; }
  if (e.key === 'Escape' && PL.active) { plStop(); return; }
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
// keep keyboard shortcuts working after clicking a button
document.addEventListener('click', e => { const b = e.target.closest('button'); if (b) b.blur(); });

/* ---------------------------------------------------------------- START */
buildVocab();
try {
  const saved = JSON.parse(localStorage.getItem(sessionKey) || 'null');
  if (saved && saved.events) { events = saved.events; nextId = saved.nextId || 1; }
} catch (e) { /* ignore */ }
renderAll(); renderLog(); setMicUI('off');
setInterval(() => { if (Object.keys(open).length) { renderCodeWindowTimers(); renderTimeline(); } }, 1000);
