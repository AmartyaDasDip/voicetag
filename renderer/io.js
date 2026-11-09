'use strict';
/* =====================================================================
   Files: CSV / XML / Excel export, project save & open, Sportscode /
   Nacsport XML import, code-window templates.
   ===================================================================== */
const baseName = n => (n ? n.replace(/\.[^.]+$/, '') : 'match');
const teamName = key => key === 'Away' ? config.general.awayName : key === 'Home' ? config.general.homeName : (key || '');
function labelGroupNames() {
  const names = config.labelGroups.map(g => g.name);
  events.forEach(e => Object.keys(e.labels || {}).forEach(k => { if (!names.includes(k)) names.push(k); }));
  return names;
}
const numOrBlank = n => n === '' || n == null ? '' : (isNaN(n) ? n : Number(n));
function eventHead() {
  return ['ID', 'Period', 'Match time', 'Code', 'Type', 'Video time', 'Seconds', 'Clip start (s)', 'Clip end (s)', 'Duration (s)', 'Team', 'Number', 'Player name', 'Position',
    'Outcome', 'Success (1/0)', 'X (0-100)', 'Y (0-100)', 'End X', 'End Y', ...labelGroupNames(), 'Note', 'Drawings', 'Source', 'Heard'];
}
function eventRow(e) {
  const n = v => v == null ? '' : v;
  return [e.id, evPeriod(e), matchClock(e.t), e.code, e.type === 'duration' ? 'Phase' : 'Event', fmtTime(e.t), e.t, e.start, e.end, Math.round((e.end - e.start) * 100) / 100,
    e.playerId ? teamName(e.team) : '', numOrBlank(e.num), e.name, e.pos, e.outcome, e.success === 1 ? 1 : e.success === 0 ? 0 : '',
    n(e.x), n(e.y), n(e.x2), n(e.y2), ...labelGroupNames().map(g => (e.labels || {})[g] || ''), e.note || '', (e.drawings || []).length || '', e.source, e.heard];
}
function requireEvents() { if (!events.length) { toast('No tags to export yet', 'bad'); return false; } return true; }
async function saveText(name, data, ext, desc) {
  const p = await api.saveFile({ defaultName: name, filters: [{ name: desc, extensions: [ext] }], data });
  if (p) toast('Saved ' + String(p).split(/[\\/]/).pop(), 'info');
  return p;
}
const matchBase = () => baseName(videoInfo.name) || ([config.general.homeName, 'vs', match.info.opponent].join(' '));

$('#btnCsv').onclick = () => {
  if (!requireEvents()) return;
  const q = v => { v = String(v ?? ''); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const lines = [eventHead().map(q).join(',')].concat(sortedEvents().map(e => eventRow(e).map(q).join(',')));
  saveText(matchBase() + ' tags.csv', '﻿' + lines.join('\r\n'), 'csv', 'CSV');
};

/* ---- Sportscode / Hudl XML timeline ---- */
const xmlEsc = s => String(s ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
function hexToRGB16(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return [32768, 32768, 32768];
  const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => v * 257);
}
function buildXml() {
  const mode = config.general.xmlCode;
  const codeOf = e => mode === 'player' && e.playerId ? playerLabel(e) : mode === 'both' && e.playerId ? playerLabel(e) + ' - ' + e.code : e.code;
  const rows = new Map();
  let out = '<?xml version="1.0" encoding="utf-8"?>\n<file>\n  <ALL_INSTANCES>\n';
  sortedEvents().forEach(e => {
    const code = codeOf(e);
    if (!rows.has(code)) { const c = VOC.codesById[e.codeId]; rows.set(code, mode === 'code' && c ? c.color : PALETTE[rows.size % PALETTE.length]); }
    const labels = [['Player', e.playerId ? playerLabel(e) : ''], ['Player name', e.name], ['Team', e.playerId ? teamName(e.team) : ''], ['Position', e.pos],
      ['Code', mode !== 'code' ? e.code : ''], ['Outcome', e.outcome], ['Period', evPeriod(e)], ['Match time', matchClock(e.t)], ['Note', e.note], ...Object.entries(e.labels || {})];
    out += '    <instance>\n' +
      `      <ID>${e.id}</ID>\n      <start>${e.start.toFixed(2)}</start>\n      <end>${e.end.toFixed(2)}</end>\n      <code>${xmlEsc(code)}</code>\n` +
      labels.filter(l => l[1] !== '' && l[1] != null).map(l => `      <label>\n        <group>${xmlEsc(l[0])}</group>\n        <text>${xmlEsc(l[1])}</text>\n      </label>\n`).join('') +
      '    </instance>\n';
  });
  out += '  </ALL_INSTANCES>\n  <ROWS>\n';
  rows.forEach((color, code) => { const [r, g, b] = hexToRGB16(color); out += `    <row>\n      <code>${xmlEsc(code)}</code>\n      <R>${r}</R>\n      <G>${g}</G>\n      <B>${b}</B>\n    </row>\n`; });
  return out + '  </ROWS>\n</file>\n';
}
$('#btnXml').onclick = () => { if (requireEvents()) saveText(matchBase() + ' timeline.xml', buildXml(), 'xml', 'XML timeline'); };

/* ---- Excel (.xlsx) writer, no external libraries ---- */
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
  const out = new Uint8Array(all.reduce((s, a) => s + a.length, 0));
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
  const head = eventHead(), mins = minutesPlayed() || {};
  const pct = (s, f) => (s + f) ? Math.round(s / (s + f) * 1000) / 10 : '';
  const pmap = new Map(), byPlayer = new Map();
  events.filter(e => e.playerId).forEach(e => {
    const k = e.playerId + '|' + e.codeId;
    if (!pmap.has(k)) pmap.set(k, { e, total: 0, s: 0, f: 0 });
    const r = pmap.get(k); r.total++; if (e.success === 1) r.s++; if (e.success === 0) r.f++;
    if (!byPlayer.has(e.playerId)) byPlayer.set(e.playerId, { e, total: 0, s: 0, f: 0 });
    const b = byPlayer.get(e.playerId); b.total++; if (e.success === 1) b.s++; if (e.success === 0) b.f++;
  });
  const sortP = (a, b) => (teamOf(a.e) > teamOf(b.e) ? 1 : teamOf(a.e) < teamOf(b.e) ? -1 : 0) || (Number(a.e.num) || 999) - (Number(b.e.num) || 999);
  const per90 = (n, id) => mins[id] ? Math.round(n / mins[id] * 90 * 10) / 10 : '';
  const sumRows = [['Team', 'Number', 'Player name', 'Position', 'Code', 'Total', 'Per 90', 'Successful', 'Unsuccessful', 'Success %']].concat(
    [...pmap.values()].sort(sortP).map(r => [teamName(r.e.team), numOrBlank(r.e.num), r.e.name, r.e.pos, r.e.code, r.total, per90(r.total, r.e.playerId), r.s, r.f, pct(r.s, r.f)]));
  const plRows = [['Team', 'Number', 'Player name', 'Position', 'Minutes', 'Total tags', 'Per 90', 'Successful', 'Unsuccessful', 'Success %']].concat(
    [...byPlayer.values()].sort(sortP).map(r => [teamName(r.e.team), numOrBlank(r.e.num), r.e.name, r.e.pos, mins[r.e.playerId] != null ? mins[r.e.playerId] : '', r.total, per90(r.total, r.e.playerId), r.s, r.f, pct(r.s, r.f)]));
  const codeMap = new Map();
  events.forEach(e => {
    if (!codeMap.has(e.code)) codeMap.set(e.code, { type: e.type, n: 0, s: 0, f: 0, d: 0, h1: 0, h2: 0 });
    const r = codeMap.get(e.code); r.n++; if (e.success === 1) r.s++; if (e.success === 0) r.f++; r.d += e.end - e.start;
    const p = evPeriod(e); if (p === '1') r.h1++; if (p === '2') r.h2++;
  });
  const codeRows = [['Code', 'Type', 'Count', '1st half', '2nd half', 'Successful', 'Unsuccessful', 'Success %', 'Total time (s)', 'Average time (s)']].concat(
    [...codeMap.entries()].map(([k, r]) => [k, r.type === 'duration' ? 'Phase' : 'Event', r.n, r.h1, r.h2, r.s, r.f, pct(r.s, r.f), Math.round(r.d * 10) / 10, Math.round(r.d / r.n * 10) / 10]));
  const kpiRows = [['KPI', 'Team', 'Target', 'Actual', 'Met']].concat(config.kpis.map(k => { const v = kpiValue(k, events), ok = kpiPass(k, v); return [k.name, teamName(k.team), k.cmp + ' ' + k.target + (k.metric === 'pct' ? '%' : ''), v == null ? '' : v, ok == null ? '' : ok ? 'Yes' : 'No']; }));
  const subRows = [['Match time', 'Video time', 'Off', 'On']].concat(match.subs.slice().sort((a, b) => a.t - b.t).map(s => [matchClock(s.t), fmtTime(s.t), playerLabel(VOC.playersById[s.offId]), playerLabel(VOC.playersById[s.onId])]));
  const info = [['Field', 'Value'], ['Home', config.general.homeName], ['Opponent', match.info.opponent], ['Date', match.info.date], ['Competition', match.info.competition], ['Venue', match.info.venue], ['Video', videoInfo.name], ['Tags', events.length]];
  return [
    { name: 'Events', rows: [head].concat(sortedEvents().map(eventRow)), widths: head.map((h, i) => [6, 7, 10, 16, 8, 9, 9, 11, 11, 11, 12, 8, 18, 22, 14, 12, 9, 9, 9, 9][i] || (h === 'Heard' || h === 'Note' ? 36 : 15)) },
    { name: 'Player x Code', rows: sumRows, widths: [12, 8, 18, 22, 18, 8, 8, 11, 13, 10] },
    { name: 'Player totals', rows: plRows, widths: [12, 8, 18, 22, 9, 10, 8, 11, 13, 10] },
    { name: 'Code totals', rows: codeRows, widths: [20, 8, 8, 9, 9, 11, 13, 10, 14, 15] },
    { name: 'KPIs', rows: kpiRows, widths: [26, 12, 12, 10, 8] },
    { name: 'Substitutions', rows: subRows, widths: [12, 12, 26, 26] },
    { name: 'Match info', rows: info, widths: [14, 40] }
  ];
}
$('#btnXlsx').onclick = async () => {
  if (!requireEvents()) return;
  const p = await api.saveFile({ defaultName: matchBase() + ' tags.xlsx', filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }], data: buildXlsx(workbookSheets()), encoding: 'binary' });
  if (p) toast('Saved Excel file', 'info');
};

/* ---------------------------------------------------------------- PROJECTS */
function projectObject() { return { app: 'VoiceTag', version: 3, savedAt: new Date().toISOString(), video: { path: videoInfo.path, name: videoInfo.name, size: videoInfo.size }, match, config, events, nextId }; }
$('#btnSaveProj').onclick = async () => {
  const proj = projectObject(), text = JSON.stringify(proj, null, 1);
  const name = (match.info.date ? match.info.date + ' ' : '') + (match.info.opponent ? 'vs ' + match.info.opponent : matchBase());
  const p = await saveText(name.replace(/[\\/:*?"<>|]/g, '') + '.vtproj', text, 'vtproj', 'VoiceTag project');
  if (p) addToLibrary(p, proj, text);
};
function normaliseEvents(list) {
  return list.map(e => Object.assign({ codeId: e.actionId || e.codeId, code: e.action || e.code, type: e.type || 'instant', labels: {}, note: '' },
    e, { start: e.start != null ? e.start : Math.max(0, e.t - 5), end: e.end != null ? e.end : e.t + 5 }));
}
async function openProjectData(p, path, askConfig = true) {
  if (p.app !== 'VoiceTag' || !Array.isArray(p.events)) throw new Error('This is not a VoiceTag project file.');
  if (p.config && (!askConfig || confirm('Also load the buttons / players / settings saved in this project?\n(Cancel = keep your current settings)'))) {
    config = migrate(JSON.parse(JSON.stringify(p.config))); saveConfig(); VOC = buildVocab(config); Voice.refreshVocabulary();
  }
  const evs = normaliseEvents(p.events);
  const m = Object.assign(EMPTY_MATCH(), p.match || {});
  autosaveNow();
  events = evs; nextId = p.nextId || (Math.max(0, ...evs.map(x => x.id)) + 1); undoStack = []; open = {}; match = m; locAsk = null;
  target = { kind: null, id: null, seq: 0 };
  live.on = false; live.running = false;
  let loaded = false;
  if (p.video && p.video.path && api.isDesktop) {
    const r = await api.registerMedia(p.video.path);
    if (r) { await loadVideo(r, true); loaded = true; sessionKey = 'vt_session_' + r.path + '_' + r.size; }
    else alert('The video for this project was not found at:\n' + p.video.path + '\n\nOpen it with "Open video" – choose "keep tags" is automatic for projects.');
  }
  if (!loaded) { videoInfo = Object.assign({ path: '', name: '', size: 0, playPath: '' }, p.video || {}); sessionKey = 'vt_session_project_' + (path || uid()); }
  renderAll(); autosave();
  toast('Opened project: ' + evs.length + ' tags', 'info', 3000);
}
$('#btnOpenProj').onclick = async () => {
  const f = await api.openTextFile({ filters: [{ name: 'VoiceTag project', extensions: ['vtproj', 'json'] }] });
  if (!f) return;
  try {
    const p = JSON.parse(f.text);
    if (events.length && !confirm('Replace the ' + events.length + ' current tags with the ' + (p.events || []).length + ' tags from this project?')) return;
    await openProjectData(p, f.path, true);
    if (f.path) addToLibrary(f.path, p, f.text);
  } catch (err) { alert('Could not open project: ' + err.message); }
};

/* ---------------------------------------------------------------- IMPORT SPORTSCODE / NACSPORT XML */
function parseTimelineXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('The file is not valid XML.');
  const inst = [...doc.getElementsByTagName('instance')];
  if (!inst.length) throw new Error('No <instance> entries found. Export the timeline as "XML Edit List" / "Sportscode XML".');
  const txt = (el, tag) => { const x = el.getElementsByTagName(tag)[0]; return x ? x.textContent.trim() : ''; };
  return inst.map(el => ({
    code: txt(el, 'code'), start: Number(txt(el, 'start')) || 0, end: Number(txt(el, 'end')) || 0,
    labels: [...el.getElementsByTagName('label')].map(l => ({ group: txt(l, 'group') || 'Label', text: txt(l, 'text') })).filter(l => l.text)
  })).filter(x => x.code);
}
$('#btnImportXml').onclick = async () => {
  const f = await api.openTextFile({ filters: [{ name: 'XML timeline', extensions: ['xml'] }] });
  if (!f) return;
  let list;
  try { list = parseTimelineXml(f.text); } catch (err) { alert('Could not import: ' + err.message); return; }
  const replace = events.length ? confirm(`Found ${list.length} clips.\n\nOK = replace the current ${events.length} tags\nCancel = add them to the current tags`) : true;
  if (replace) { events = []; nextId = 1; undoStack = []; }
  let newCodes = 0;
  const findPlayer = t => { const s = t.toLowerCase(); return config.players.find(p => playerLabel(p).toLowerCase() === s || (p.name && p.name.toLowerCase() === s) || (p.pos && p.pos.toLowerCase() === s)); };
  list.forEach(x => {
    let code = config.codes.find(c => c.name.toLowerCase() === x.code.toLowerCase());
    if (!code) {
      const dur = x.end - x.start > 20;
      code = { id: uid(), name: x.code, type: dur ? 'duration' : 'instant', hotkey: '', say: x.code.toLowerCase(), outcomes: [], def: '', color: PALETTE[config.codes.length % PALETTE.length], endLoc: false, lead: 0, lag: 0 };
      config.codes.push(code); newCodes++;
    }
    const ev = { id: nextId++, codeId: code.id, code: code.name, type: code.type, t: code.type === 'duration' ? x.start : Math.round((x.start + x.end) / 2 * 100) / 100,
      start: x.start, end: Math.max(x.end, x.start + 0.2), period: '', playerId: '', team: '', num: '', name: '', pos: '', outcomeId: '', outcome: '', success: null, labels: {}, note: '', source: 'import', heard: '' };
    x.labels.forEach(l => {
      if (/^player$/i.test(l.group)) { const p = findPlayer(l.text); if (p) { setPlayer(ev, p); return; } }
      if (/^(outcome|result)$/i.test(l.group)) { const o = config.outcomes.find(o => o.name.toLowerCase() === l.text.toLowerCase()); if (o) { setOutcome(ev, o); return; } }
      if (/^note$/i.test(l.group)) { ev.note = l.text; return; }
      if (/^(team|position|player name|period|match time|code)$/i.test(l.group)) return;
      ev.labels[l.group] = l.text;
    });
    events.push(ev);
  });
  saveConfig(); VOC = buildVocab(config); Voice.refreshVocabulary();
  renderAll(); autosave();
  toast(`Imported ${list.length} clips` + (newCodes ? `, ${newCodes} new code button(s)` : ''), 'ok', 3500);
};

/* ---------------------------------------------------------------- TEMPLATES */
function builtInTemplates() {
  const C = (name, type, hotkey, say, color, outcomes = [], def = '') => ({ id: uid(), name, type, hotkey, say, outcomes, def, color, endLoc: false, lead: type === 'duration' ? 2 : 5, lag: type === 'duration' ? 2 : 5 });
  const L = (name, say) => ({ id: uid(), name, say: say || name.toLowerCase(), hotkey: '' });
  return [
    { builtIn: true, name: 'Own team – match (default)', codes: DEFAULT_CODES(), outcomes: DEFAULT_OUTCOMES(), labelGroups: DEFAULT_LABELGROUPS(), customPhrases: [], kpis: DEFAULT_KPIS() },
    { builtIn: true, name: 'Opposition analysis', outcomes: DEFAULT_OUTCOMES(), customPhrases: [], kpis: [],
      codes: [C('Opp Build-up', 'duration', 'B', 'opposition build up, their build up', '#00bcd4'), C('Opp Attack', 'duration', 'A', 'opposition attack, their attack', '#ff5a5f'),
        C('Opp Press', 'duration', 'P', 'opposition press, their press', '#ff9800'), C('Opp Transition', 'duration', 'T', 'opposition transition, their transition', '#a66bff'),
        C('Opp Set Piece', 'duration', 'S', 'opposition set piece, their set piece', '#cddc39'), C('Opp Chance', 'instant', 'C', 'opposition chance, their chance', '#e67e22'),
        C('Opp Goal', 'instant', 'G', 'opposition goal, they scored', '#c0392b'), C('Our Goal', 'instant', 'O', 'our goal, we scored', '#2ecc71')],
      labelGroups: [DEFAULT_LABELGROUPS()[0], { id: uid(), name: 'Pattern', labels: [L('Long ball'), L('Play through'), L('Switch of play', 'switch'), L('Wide overload', 'overload'), L('Counter press', 'counter press')] }] },
    { builtIn: true, name: 'Training session', outcomes: DEFAULT_OUTCOMES().slice(0, 2), customPhrases: [], kpis: [],
      codes: [C('Warm-up', 'duration', 'W', 'warm up', '#95a5a6'), C('Rondo', 'duration', 'R', 'rondo', '#3ea6ff'), C('Small-sided game', 'duration', 'S', 'small sided game, game', '#2ecc71'),
        C('Phase of play', 'duration', 'P', 'phase of play, phase', '#a66bff'), C('Finishing', 'duration', 'F', 'finishing', '#ff5a5f'),
        C('Good action', 'instant', 'G', 'good action, good', '#58d68d', ['succ', 'unsucc'], 'succ'), C('Coaching point', 'instant', 'C', 'coaching point', '#f5b041'), C('Mistake', 'instant', 'M', 'mistake, error', '#c0392b')].map(c => (c.hotkey === 'M' ? Object.assign(c, { hotkey: 'K' }) : c)),
      labelGroups: [{ id: uid(), name: 'Theme', labels: [L('Pressing'), L('Possession'), L('Transition'), L('Finishing'), L('Defending')] }] }
  ];
}
function userTemplates() { try { return JSON.parse(localStorage.getItem('vt_templates') || '[]'); } catch (e) { return []; } }
function saveUserTemplates(list) { try { localStorage.setItem('vt_templates', JSON.stringify(list)); } catch (e) { /* ignore */ } }
function templateFrom(cfg, name, withPlayers) {
  const t = { name, codes: cfg.codes, outcomes: cfg.outcomes, labelGroups: cfg.labelGroups, customPhrases: cfg.customPhrases, kpis: cfg.kpis, savedAt: new Date().toISOString() };
  if (withPlayers) t.players = cfg.players;
  return JSON.parse(JSON.stringify(t));
}
function applyTemplate(cfg, tpl, withPlayers) {
  const t = JSON.parse(JSON.stringify(tpl));
  ['codes', 'outcomes', 'labelGroups', 'customPhrases', 'kpis'].forEach(k => { if (Array.isArray(t[k])) cfg[k] = t[k]; });
  if (withPlayers && Array.isArray(t.players)) cfg.players = t.players;
  return migrate(cfg);
}
$('#btnTemplates').onclick = () => openSettings('templates');
