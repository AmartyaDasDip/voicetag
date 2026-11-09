'use strict';
/* =====================================================================
   VoiceTag core: helpers, settings model, voice-command matching
   ===================================================================== */
const APP_VERSION = '1.1.0';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const fmtTime = s => { s = Math.max(0, s || 0); const m = Math.floor(s / 60), x = Math.floor(s % 60); return String(m).padStart(2, '0') + ':' + String(x).padStart(2, '0'); };
const fmtDur = s => s >= 60 ? fmtTime(s) : (Math.round(s * 10) / 10) + 's';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const PALETTE = ['#3ea6ff', '#ff5a5f', '#2ecc71', '#f5b041', '#a66bff', '#1abc9c', '#e67e22', '#ff77c8', '#95a5a6', '#58d68d', '#5dade2', '#f4d03f', '#af7ac5', '#48c9b0', '#dc7633'];

/* ---------------------------------------------------------------- PLATFORM BRIDGE */
const api = window.api || (() => {
  const pick = (accept, multiple) => new Promise(res => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.multiple = !!multiple;
    i.onchange = () => res([...i.files]); i.click();
  });
  const dl = (name, data, binary) => {
    const blob = new Blob([data], { type: binary ? 'application/octet-stream' : 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    return name;
  };
  return {
    isDesktop: false,
    openVideo: async () => { const [f] = await pick('video/*'); return f ? { path: '', name: f.name, size: f.size, url: URL.createObjectURL(f) } : null; },
    registerMedia: async () => null, pathForFile: () => '', mediaUrl: p => p,
    saveFile: async ({ defaultName, data, encoding }) => dl(defaultName, data, encoding === 'binary'),
    openTextFile: async () => { const [f] = await pick('.json,.vtproj,.xml,.vttemplate,.txt,.csv'); return f ? { path: f.name, text: await f.text() } : null; },
    openTextFiles: async () => Promise.all((await pick('.vtproj,.json', true)).map(async f => ({ path: f.name, text: await f.text() }))),
    readTextFiles: async () => [],
    modelInfo: async () => ({ available: false }),
    ffmpegInfo: async () => ({ available: false }),
    showInFolder: async () => {},
    exportClips: async () => ({ ok: false, error: 'Video export only works in the installed desktop app.' }),
    cancelExport: async () => {}, onExportProgress: () => {},
    convertVideo: async () => ({ ok: false, error: 'Conversion only works in the installed desktop app.' }),
    cachedConversion: async () => null, cancelConvert: async () => {}, onConvertProgress: () => {},
    exportPdf: async ({ html }) => { const w = window.open('', '_blank'); if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 400); } return null; },
    openExternal: url => window.open(url, '_blank'),
    onClosing: () => {}
  };
})();

/* ---------------------------------------------------------------- SMALL DIALOGS */
const Dlg = {
  open(title, html, buttons = [{ label: 'Close' }], opts = {}) {
    $('#dlgTitle').textContent = title;
    $('#dlgBody').innerHTML = html;
    const foot = $('#dlgFoot'); foot.innerHTML = '';
    return new Promise(resolve => {
      const done = v => { $('#dlg').classList.add('hidden'); resolve(v); };
      buttons.forEach(b => {
        const el = document.createElement('button');
        el.textContent = b.label; if (b.primary) el.className = 'primary'; if (b.danger) el.className = 'danger';
        el.onclick = async () => { if (b.onClick) { const keep = await b.onClick(); if (keep === false) return; } done(b.value); };
        foot.appendChild(el);
      });
      $('#dlgX').onclick = () => done(undefined);
      $('#dlg').classList.remove('hidden');
      if (opts.onOpen) opts.onOpen($('#dlgBody'));
      const first = $('#dlgBody').querySelector('input,textarea,select');
      if (first && opts.focus !== false) first.focus();
    });
  },
  isOpen() { return !$('#dlg').classList.contains('hidden'); },
  async ask(title, label, value = '', multiline = false) {
    let v = null;
    const id = 'ask_' + uid();
    const field = multiline ? `<textarea id="${id}">${esc(value)}</textarea>` : `<input id="${id}" value="${esc(value)}" style="width:100%;padding:7px">`;
    const r = await Dlg.open(title, `<p class="muted">${esc(label)}</p>${field}`, [{ label: 'Cancel' }, { label: 'OK', primary: true, value: 'ok', onClick: () => { v = $('#' + id).value; } }], {
      onOpen: b => { const el = b.querySelector('#' + id); el.addEventListener('keydown', e => { if (e.key === 'Enter' && !multiline) { v = el.value; $('#dlgFoot .primary').click(); } }); }
    });
    return r === 'ok' ? v : null;
  }
};

/* ---------------------------------------------------------------- NUMBERS & TEXT */
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function numberWords(n) {
  n = Number(n);
  if (!Number.isInteger(n) || n < 0 || n > 99) return '';
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
}
const FILLERS = new Set(['and', 'the', 'a', 'an', 'uh', 'um', 'er', 'erm', 'ah', 'is', 'was', 'has', 'with', 'then', 'ok', 'okay', 'its', 'it', 'that', 'so', 'hes', 'unk']);
function normWord(s) { return String(s).toLowerCase().replace(/centre/g, 'center').replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
// Words with their original position. Digits become words ("11" -> "eleven"), so typed and spoken forms match.
function tokenize(text) {
  const out = [];
  String(text || '').trim().split(/\s+/).filter(Boolean).forEach((rw, i) => {
    const n = normWord(rw);
    if (!n) return;
    n.split(' ').forEach(p => {
      if (!p) return;
      if (/^\d+$/.test(p) && Number(p) <= 99) { numberWords(Number(p)).split(' ').forEach(w => out.push({ w, i })); return; }
      if (!FILLERS.has(p)) out.push({ w: p, i });
    });
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

/* ---------------------------------------------------------------- DEFAULT SETTINGS */
// "say" = exactly what you speak for this item (comma = alternatives)
function autoSay(p) {
  const list = [];
  if (p.pos) list.push(p.pos.toLowerCase());
  if (p.name) { list.push(p.name.toLowerCase()); const parts = p.name.trim().split(/\s+/); if (parts.length > 1) list.push(parts[parts.length - 1].toLowerCase()); }
  if (p.num !== '' && p.num != null && !isNaN(p.num)) { const w = numberWords(p.num); if (w) list.push('number ' + w, 'player ' + w); }
  return list.join(', ');
}
function DEFAULT_CODES() {
  const C = (id, name, type, hotkey, say, outcomes, def, color, endLoc) => ({
    id, name, type, hotkey, say, outcomes, def, color, endLoc: !!endLoc,
    lead: type === 'duration' ? 2 : 5, lag: type === 'duration' ? 2 : 5
  });
  return [
    C('pass', 'Pass', 'instant', 'P', 'pass, passes, past', ['succ', 'unsucc'], 'succ', '#3ea6ff', true),
    C('cross', 'Cross', 'instant', 'C', 'cross, crosses, cross ball', ['succ', 'unsucc'], 'succ', '#a66bff', true),
    C('shot', 'Shot', 'instant', 'S', 'shot, shoot, shots', ['ont', 'offt', 'goal', 'blocked'], '', '#ff5a5f'),
    C('gduel', 'Ground Duel', 'instant', 'G', 'ground duel, ground dual, ground jewel', ['won', 'lost'], '', '#f5b041'),
    C('aduel', 'Aerial Duel', 'instant', 'A', 'aerial duel, aerial dual, air duel, header duel', ['won', 'lost'], '', '#e67e22'),
    C('dribble', 'Dribble', 'instant', 'D', 'dribble, take on', ['succ', 'unsucc'], 'succ', '#1abc9c'),
    C('tackle', 'Tackle', 'instant', 'T', 'tackle, tackles', ['won', 'lost'], 'won', '#2ecc71'),
    C('intercept', 'Interception', 'instant', 'I', 'interception, intercept', [], '', '#17a589'),
    C('clear', 'Clearance', 'instant', 'L', 'clearance, clear', [], '', '#95a5a6'),
    C('recovery', 'Ball Recovery', 'instant', 'R', 'recovery, ball recovery', [], '', '#58d68d'),
    C('loss', 'Possession Lost', 'instant', 'O', 'possession lost, lost possession, turnover', [], '', '#c0392b'),
    C('foulc', 'Foul Committed', 'instant', 'F', 'foul, foul committed', [], '', '#d35400'),
    C('foulw', 'Foul Won', 'instant', 'W', 'foul won, won a foul', [], '', '#f39c12'),
    C('keypass', 'Key Pass', 'instant', 'K', 'key pass, chance created', [], '', '#5dade2', true),
    C('save', 'Save', 'instant', 'V', 'save, keeper save', [], '', '#af7ac5'),
    C('buildup', 'Build-up', 'duration', 'B', 'build up, buildup', [], '', '#00bcd4'),
    C('counter', 'Counter-attack', 'duration', 'X', 'counter attack, counter', [], '', '#ff4081'),
    C('setpiece', 'Set Piece', 'duration', 'E', 'set piece, set play', [], '', '#cddc39'),
    C('press', 'High Press', 'duration', 'H', 'high press, press, pressing', [], '', '#ff9800')
  ];
}
function DEFAULT_OUTCOMES() {
  return [
    { id: 'succ', name: 'Successful', say: 'successful, success, good, complete', type: 'pos', hotkey: '1' },
    { id: 'unsucc', name: 'Unsuccessful', say: 'unsuccessful, not successful, failed, bad, incomplete', type: 'neg', hotkey: '2' },
    { id: 'won', name: 'Won', say: 'won, win, one', type: 'pos', hotkey: '3' },
    { id: 'lost', name: 'Lost', say: 'lost, lose, loss', type: 'neg', hotkey: '4' },
    { id: 'ont', name: 'On Target', say: 'on target, on goal, saved', type: 'pos', hotkey: '5' },
    { id: 'offt', name: 'Off Target', say: 'off target, wide, over, missed', type: 'neg', hotkey: '6' },
    { id: 'goal', name: 'Goal', say: 'goal, scored', type: 'pos', hotkey: '7' },
    { id: 'blocked', name: 'Blocked', say: 'blocked, block', type: 'neg', hotkey: '8' }
  ];
}
function DEFAULT_LABELGROUPS() {
  const L = (id, name, say) => ({ id, name, say, hotkey: '' });
  return [
    { id: 'zone', name: 'Zone', labels: [L('z1', 'Defensive Third', 'defensive third'), L('z2', 'Middle Third', 'middle third'), L('z3', 'Final Third', 'final third')] },
    { id: 'side', name: 'Side', labels: [L('s1', 'Left Side', 'left side'), L('s2', 'Centre', 'centre, central'), L('s3', 'Right Side', 'right side')] }
  ];
}
function DEFAULT_PLAYERS() {
  const P = (num, pos) => { const p = { id: uid(), team: 'Home', num, name: '', pos, say: '', hotkey: '' }; p.say = autoSay(p); return p; };
  return [P(1, 'Goalkeeper'), P(2, 'Right Back'), P(3, 'Left Back'), P(4, 'Right Centre Back'), P(5, 'Left Centre Back'),
    P(6, 'Defensive Midfielder'), P(8, 'Right Midfielder'), P(10, 'Left Midfielder'), P(7, 'Right Winger'), P(11, 'Left Winger'), P(9, 'Striker')];
}
function DEFAULT_KPIS() {
  return [
    { id: uid(), name: 'Pass completion %', codeId: 'pass', metric: 'pct', cmp: '>=', target: 75, team: 'Home' },
    { id: uid(), name: 'Shots', codeId: 'shot', metric: 'count', cmp: '>=', target: 10, team: 'Home' },
    { id: uid(), name: 'Shots on target %', codeId: 'shot', metric: 'pct', cmp: '>=', target: 40, team: 'Home' },
    { id: uid(), name: 'Ground duels won %', codeId: 'gduel', metric: 'pct', cmp: '>=', target: 55, team: 'Home' },
    { id: uid(), name: 'Possession lost', codeId: 'loss', metric: 'count', cmp: '<=', target: 40, team: 'Home' }
  ];
}
function DEFAULT_CONFIG() {
  return {
    version: 3,
    general: {
      offset: 1, hotkeyOffset: 0, strictness: 0.72, beep: true, xmlCode: 'code',
      homeName: 'Home', awayName: 'Opposition', voiceControl: true, useGrammar: true,
      ptt: false, pttKey: 'ControlRight', samePlayerSay: 'same player, same, him',
      askLocation: true, autoZone: true, freezeDur: 3, titleDur: 2.5
    },
    codes: DEFAULT_CODES(), outcomes: DEFAULT_OUTCOMES(), labelGroups: DEFAULT_LABELGROUPS(),
    players: DEFAULT_PLAYERS(), customPhrases: [], kpis: DEFAULT_KPIS()
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
const SAME_PLAYER = { id: '__same', pos: 'same player', num: '' };

function migrate(c) {
  const d = DEFAULT_CONFIG();
  c.general = Object.assign(d.general, c.general || {});
  if (!Array.isArray(c.codes)) { c.codes = Array.isArray(c.actions) ? c.actions.map(a => Object.assign({ type: 'instant' }, a)) : d.codes; }
  delete c.actions;
  ['players', 'outcomes', 'labelGroups', 'customPhrases', 'kpis'].forEach(k => { if (!Array.isArray(c[k])) c[k] = d[k]; });
  const sayFrom = (name, aliases) => [String(name || '').toLowerCase(), ...splitAliases(aliases)].filter(Boolean).join(', ');
  c.codes.forEach(x => {
    if (x.lead == null) x.lead = x.type === 'duration' ? 2 : 5;
    if (x.lag == null) x.lag = x.type === 'duration' ? 2 : 5;
    if (!x.type) x.type = 'instant';
    if (x.hotkey == null) x.hotkey = '';
    if (!Array.isArray(x.outcomes)) x.outcomes = [];
    if (x.say == null) x.say = sayFrom(x.name, x.aliases);
    if (x.endLoc == null) x.endLoc = ['pass', 'cross', 'keypass'].includes(x.id);
    delete x.aliases;
  });
  c.players.forEach(p => {
    if (p.hotkey == null) p.hotkey = '';
    if (p.say == null) p.say = [autoSay(p), ...splitAliases(p.aliases)].filter(Boolean).join(', ');
    delete p.aliases;
  });
  c.outcomes.forEach(o => { if (o.hotkey == null) o.hotkey = ''; if (o.say == null) o.say = sayFrom(o.name, o.aliases); delete o.aliases; });
  c.labelGroups.forEach(g => g.labels.forEach(l => { if (l.hotkey == null) l.hotkey = ''; if (l.say == null) l.say = sayFrom(l.name, l.aliases); delete l.aliases; }));
  c.version = 3;
  return c;
}
function loadConfig() {
  for (const k of ['vt_config3', 'vt_config2']) {
    try { const raw = localStorage.getItem(k); if (raw) return migrate(JSON.parse(raw)); } catch (e) { console.warn(e); }
  }
  return DEFAULT_CONFIG();
}
let config = loadConfig();
function saveConfig() { try { localStorage.setItem('vt_config3', JSON.stringify(config)); } catch (e) { /* ignore */ } }

/* ---------------------------------------------------------------- VOCABULARY */
function playerSpokenList(p) { const l = splitAliases(p.say); return l.length ? l : splitAliases(autoSay(p)); }
function itemSay(x) { const l = splitAliases(x.say); return l.length ? l : [x.name]; }
function buildVocab(cfg) {
  const V = {
    outcomesById: Object.fromEntries(cfg.outcomes.map(o => [o.id, o])),
    codesById: Object.fromEntries(cfg.codes.map(c => [c.id, c])),
    playersById: Object.fromEntries(cfg.players.map(p => [p.id, p])),
    players: [], codes: [], outcomes: [], labels: [], custom: [],
    control: CONTROL_WORDS.map(c => ({ cmd: c.cmd, keys: makeKeys(c.aliases).map(k => k.key) })),
    hotkeys: {}
  };
  cfg.players.forEach(p => makeKeys(playerSpokenList(p)).forEach(k => V.players.push({ item: p, ...k })));
  makeKeys(splitAliases(cfg.general.samePlayerSay)).forEach(k => V.players.push({ item: SAME_PLAYER, ...k }));
  cfg.codes.forEach(c => makeKeys(itemSay(c)).forEach(k => V.codes.push({ item: c, ...k })));
  cfg.outcomes.forEach(o => makeKeys(itemSay(o)).forEach(k => V.outcomes.push({ item: o, ...k })));
  cfg.labelGroups.forEach(g => g.labels.forEach(l => makeKeys(itemSay(l)).forEach(k => V.labels.push({ item: { group: g, label: l }, ...k }))));
  cfg.customPhrases.forEach(cp => makeKeys(splitAliases(cp.phrase)).forEach(k => V.custom.push({ item: cp, ...k })));
  const hk = (key, v) => { key = String(key || '').trim().toUpperCase(); if (key && !RESERVED_KEYS.has(key) && !V.hotkeys[key]) V.hotkeys[key] = v; };
  cfg.codes.forEach(c => hk(c.hotkey, { kind: 'code', item: c }));
  cfg.outcomes.forEach(o => hk(o.hotkey, { kind: 'outcome', item: o }));
  cfg.players.forEach(p => hk(p.hotkey, { kind: 'player', item: p }));
  cfg.labelGroups.forEach(g => g.labels.forEach(l => hk(l.hotkey, { kind: 'label', item: { group: g, label: l } })));
  return V;
}
let VOC = buildVocab(config);
function grammarWords(V = VOC) {
  const words = new Set();
  const add = list => list.forEach(k => k.words.forEach(w => words.add(w)));
  add(V.players); add(V.codes); add(V.outcomes); add(V.labels); add(V.custom);
  CONTROL_WORDS.forEach(c => makeKeys(c.aliases).forEach(k => k.words.forEach(w => words.add(w))));
  [...START_W, ...STOP_W].forEach(w => words.add(w));
  ['number', 'player', 'and', 'the'].forEach(w => words.add(w));
  return [...words, '[unk]'];
}

/* ---------------------------------------------------------------- PARSER */
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
function customCmd(cp, V, tokStart, score, next) {
  const labels = String(cp.labels || '').split(',').filter(Boolean).map(id => {
    const [gid, lid] = id.split('|'); const g = config.labelGroups.find(x => x.id === gid); const l = g && g.labels.find(x => x.id === lid);
    return l ? { group: g, label: l } : null;
  }).filter(Boolean);
  return {
    custom: cp, player: cp.playerId ? (V.playersById[cp.playerId] || null) : null, code: cp.codeId ? (V.codesById[cp.codeId] || null) : null,
    outcome: cp.outcomeId ? (V.outcomesById[cp.outcomeId] || null) : null, outcomeSaid: !!cp.outcomeId, labels, mode: cp.mode || 'toggle',
    tokStart, next, score
  };
}
function parseAt(tokens, start, order, V, TH) {
  let i = start, player = null, code = null;
  const scores = [];
  for (const kind of order) {
    const m = matchSegment(tokens, i, kind === 'player' ? V.players : V.codes);
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
      const m = matchSegment(tokens, i, V.outcomes.filter(o => code.outcomes.includes(o.item.id)));
      if (m && m.score >= TH) { outcome = m.item; outcomeSaid = true; i += m.len; scores.push(m.score); continue; }
    }
    if (V.labels.length) {
      const m = matchSegment(tokens, i, V.labels);
      if (m && m.score >= TH) { labels.push(m.item); i += m.len; scores.push(m.score); continue; }
    }
    break;
  }
  if (!outcomeSaid && code.def) outcome = V.outcomesById[code.def] || null;
  return { player, code, outcome, outcomeSaid, labels, mode, tokStart: tokens[start].i, next: i, score: avg(scores) - (order.length === 1 ? 0.02 : 0) };
}
function parseLabelsOnly(tokens, V, TH) {
  const cands = V.outcomes.map(o => ({ ...o, item: { kind: 'outcome', v: o.item } }))
    .concat(V.players.filter(p => p.item !== SAME_PLAYER).map(p => ({ ...p, item: { kind: 'player', v: p.item } })))
    .concat(V.labels.map(l => ({ ...l, item: { kind: 'label', v: l.item } })));
  let i = 0;
  const out = [], scores = [];
  while (i < tokens.length) {
    const m = matchSegment(tokens, i, cands);
    if (!m || m.score < TH) return null;
    out.push(m.item); scores.push(m.score); i += m.len;
  }
  return out.length ? { items: out, score: avg(scores) } : null;
}
function parseUtterance(text, V = VOC, cfg = config) {
  const TH = Number(cfg.general.strictness) || 0.72;
  const tokens = tokenize(text);
  const res = { cmds: [], control: null, labelsOnly: null, leftover: [], score: 0, text };
  if (!tokens.length) return res;
  const joined = tokens.map(t => t.w).join('');
  if (cfg.general.voiceControl) {
    let best = null;
    for (const c of V.control) for (const k of c.keys) { const s = sim(k, joined); if (!best || s > best.s) best = { cmd: c.cmd, s }; }
    if (best && best.s >= 0.85) { res.control = best.cmd; res.score = best.s; return res; }
  }
  // 1) your own full phrases win when the whole thing matches
  if (V.custom.length) {
    let best = null;
    for (const c of V.custom) { const s = sim(c.key, joined); if (!best || s > best.s) best = { c, s }; }
    if (best && best.s >= Math.max(TH, 0.8)) { res.cmds.push(customCmd(best.c.item, V, tokens[0].i, best.s, tokens.length)); res.score = best.s; return res; }
  }
  // 2) build commands from player + code + outcome + labels (several in one breath are fine)
  let i = 0, skipped = 0;
  while (i < tokens.length) {
    let r = null;
    if (V.custom.length) {
      const m = matchSegment(tokens, i, V.custom);
      if (m && m.score >= Math.max(TH, 0.8)) r = customCmd(m.item, V, tokens[i].i, m.score, i + m.len);
    }
    r = r || parseAt(tokens, i, ['player', 'code'], V, TH) || parseAt(tokens, i, ['code', 'player'], V, TH) || parseAt(tokens, i, ['code'], V, TH);
    if (r) { res.cmds.push(r); i = r.next; continue; }
    if (tokens.length - i >= 2 && skipped < 2) { i++; skipped++; continue; }
    break;
  }
  res.leftover = tokens.slice(i).map(t => t.w);
  if (!res.cmds.length) {
    const lo = parseLabelsOnly(tokens, V, TH);
    if (lo) { res.labelsOnly = lo.items; res.score = lo.score; res.leftover = []; return res; }
  }
  res.score = res.cmds.length ? avg(res.cmds.map(c => c.score)) - 0.04 * (res.leftover.length + skipped) : 0;
  return res;
}
// Human readable explanation of a parse (used by the voice test box)
function describeParse(r) {
  if (r.control) return 'Control: ' + r.control;
  if (r.labelsOnly) return 'Adds to latest tag: ' + r.labelsOnly.map(x => x.kind === 'player' ? playerLabel(x.v) : x.kind === 'outcome' ? x.v.name : x.v.group.name + ': ' + x.v.label.name).join(', ');
  if (!r.cmds.length) return 'Not understood';
  return r.cmds.map(c => {
    const parts = [];
    if (c.custom) parts.push('[your phrase “' + c.custom.phrase + '”]');
    if (c.player) parts.push(c.player === SAME_PLAYER ? 'same player as last tag' : playerLabel(c.player));
    if (c.code) parts.push(c.code.name + (c.code.type === 'duration' ? ' (' + c.mode + ')' : ''));
    if (c.outcome) parts.push(c.outcome.name + (c.outcomeSaid ? '' : ' (default)'));
    c.labels.forEach(l => parts.push(l.group.name + ': ' + l.label.name));
    return parts.join(' – ');
  }).join('   |   ') + (r.leftover.length ? '   (ignored: ' + r.leftover.join(' ') + ')' : '');
}
