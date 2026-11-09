'use strict';
/* =====================================================================
   Playlist: watch selected clips back-to-back and export them
   (one video, separate clips, or one folder per player) with title
   cards, captions and freeze-frame drawings.
   ===================================================================== */
const PL = { codes: new Set(), excluded: new Set(), queue: [], idx: -1, active: false };
function playlistItems() {
  const pp = $('#plPlayer').value, po = $('#plOutcome').value, pl = $('#plLabel').value;
  const [lg, ll] = pl ? pl.split('|') : [];
  return sortedEvents().filter(e => (!PL.codes.size || PL.codes.has(e.codeId)) && (!pp || e.playerId === pp) && (!po || e.outcomeId === po) && (!pl || (e.labels || {})[lg] === ll));
}
function clipName(e) { return [e.playerId ? playerLabel(e) : '', e.code, e.outcome].filter(Boolean).join(' – '); }
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
    <td><span class="tlink" data-plgo="${e.id}">${esc(matchClock(e.t) || fmtTime(e.start))}</span></td>
    <td>${esc(clipName(e))}${(e.drawings || []).length ? ' ✏' : ''}${e.note ? ' 📝' : ''}${Object.values(e.labels || {}).length ? ' <span class="muted small">' + esc(Object.values(e.labels).join(', ')) + '</span>' : ''}</td>
    <td class="muted small">${fmtDur(e.end - e.start)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No clips match.</td></tr>';
  const sel = items.filter(e => !PL.excluded.has(e.id));
  $('#plInfo').textContent = sel.length + ' clip(s), ' + fmtTime(sel.reduce((s, e) => s + e.end - e.start, 0)) + ' total';
}
HOOKS.render.push(tab => { if (!tab || tab === 'playlist') renderPlaylist(); });
$('#plCodes').addEventListener('click', e => {
  const c = e.target.closest('[data-plc]'); if (!c) return;
  const id = c.dataset.plc; PL.codes.has(id) ? PL.codes.delete(id) : PL.codes.add(id);
  renderPlaylist();
});
['#plPlayer', '#plOutcome', '#plLabel'].forEach(s => $(s).onchange = renderPlaylist);
$('#plAll').onchange = e => { playlistItems().forEach(x => e.target.checked ? PL.excluded.delete(x.id) : PL.excluded.add(x.id)); renderPlaylist(); };
$('#plTable').addEventListener('change', e => { const x = e.target.closest('[data-plx]'); if (!x) return; const id = Number(x.dataset.plx); x.checked ? PL.excluded.delete(id) : PL.excluded.add(id); renderPlaylist(); });
$('#plTable').addEventListener('click', e => {
  const g = e.target.closest('[data-plgo]'); if (!g) return;
  const items = selectedClips(); const i = items.findIndex(x => x.id === Number(g.dataset.plgo));
  if (i >= 0) startPlaylist(items, i); else { const ev = events.find(x => x.id === Number(g.dataset.plgo)); if (ev && hasVideo()) video.currentTime = ev.start; }
});
const selectedClips = () => playlistItems().filter(e => !PL.excluded.has(e.id));
function startPlaylist(items, from = 0) {
  if (!hasVideo()) { toast('Open the video first', 'bad'); return; }
  if (!items.length) { toast('No clips selected', 'bad'); return; }
  PL.queue = items; PL.active = true; plGo(from);
}
function plGo(i) {
  if (i < 0 || i >= PL.queue.length) { plStop(); return; }
  PL.idx = i;
  const c = PL.queue[i];
  Draw.hideShow();
  video.currentTime = c.start; Draw.prevT = c.start; video.play();
  $('#plBanner').classList.remove('hidden');
  $('#plBanner').textContent = `▶ ${i + 1}/${PL.queue.length}  ${clipName(c)}  ·  ${matchClock(c.t) || fmtTime(c.t)}`;
  renderPlaylist();
}
HOOKS.tick.push(() => {
  if (!PL.active) return;
  const c = PL.queue[PL.idx];
  if (c && !video.seeking && !Draw.showing && video.currentTime >= c.end) plGo(PL.idx + 1);
});
function plStop() { PL.active = false; PL.idx = -1; Draw.hideShow(); video.pause(); $('#plBanner').classList.add('hidden'); renderPlaylist(); }
$('#plPlay').onclick = () => startPlaylist(selectedClips(), 0);
$('#plStop').onclick = plStop;
$('#plNext').onclick = () => { if (PL.active) plGo(PL.idx + 1); };
$('#plPrev').onclick = () => { if (PL.active) plGo(Math.max(0, PL.idx - 1)); };

/* ---- images for title cards and captions (made here, burned in by ffmpeg) ---- */
function wrapText(ctx, text, maxW) {
  const words = String(text).split(/\s+/), lines = []; let line = '';
  words.forEach(w => { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; });
  if (line) lines.push(line);
  return lines;
}
function titleCardPNG(e, W, H) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#0e1621'); g.addColorStop(1, '#16283c');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const code = VOC.codesById[e.codeId];
  ctx.fillStyle = code ? code.color : '#3ea6ff'; ctx.fillRect(W * 0.08, H * 0.3, W * 0.012, H * 0.4);
  const x = W * 0.11; let y = H * 0.38;
  ctx.fillStyle = '#ffffff'; ctx.font = `700 ${Math.round(H * 0.085)}px "Segoe UI", Arial`; ctx.fillText(e.code + (e.outcome ? ' – ' + e.outcome : ''), x, y);
  y += H * 0.09;
  ctx.fillStyle = '#cfe3ff'; ctx.font = `600 ${Math.round(H * 0.055)}px "Segoe UI", Arial`;
  if (e.playerId) { ctx.fillText(playerLabel(e) + (e.name ? '  ·  ' + e.name : ''), x, y); y += H * 0.07; }
  ctx.fillStyle = '#8fa3b8'; ctx.font = `400 ${Math.round(H * 0.04)}px "Segoe UI", Arial`;
  const meta = [matchClock(e.t) ? "Match " + matchClock(e.t) : fmtTime(e.t), match.info.opponent ? 'vs ' + match.info.opponent : '', match.info.date].filter(Boolean).join('   ·   ');
  ctx.fillText(meta, x, y); y += H * 0.08;
  if (e.note) {
    ctx.fillStyle = '#ffd23b'; ctx.font = `italic 500 ${Math.round(H * 0.045)}px "Segoe UI", Arial`;
    wrapText(ctx, '“' + e.note + '”', W * 0.8).slice(0, 4).forEach(l => { ctx.fillText(l, x, y); y += H * 0.06; });
  }
  return c.toDataURL('image/png');
}
function captionPNG(e, W, H) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const bh = H * 0.075, by = H - bh - H * 0.04, fs = Math.round(bh * 0.5);
  ctx.font = `600 ${fs}px "Segoe UI", Arial`;
  const txt = clipName(e) + (matchClock(e.t) ? '   ' + matchClock(e.t) : '');
  const w = ctx.measureText(txt).width + bh * 1.2;
  ctx.globalAlpha = 0.82; ctx.fillStyle = '#0b0f14'; ctx.fillRect(W * 0.03, by, w, bh);
  ctx.globalAlpha = 1; const code = VOC.codesById[e.codeId]; ctx.fillStyle = code ? code.color : '#3ea6ff'; ctx.fillRect(W * 0.03, by, bh * 0.15, bh);
  ctx.fillStyle = '#fff'; ctx.fillText(txt, W * 0.03 + bh * 0.45, by + bh * 0.66);
  return c.toDataURL('image/png');
}

async function exportVideo(mode) {
  const clips = selectedClips();
  if (!clips.length) { toast('No clips selected', 'bad'); return; }
  if (!api.isDesktop) { alert('Video export only works in the installed desktop app.'); return; }
  if (!videoInfo.path) { alert('Open the match video first (the original file is needed to cut the clips).'); return; }
  const ff = await api.ffmpegInfo();
  if (!ff.available) { alert('The video tool (ffmpeg) is missing from this installation.'); return; }
  const fast = $('#plQuality').value === 'fast';
  const wantTitle = !fast && $('#plTitle').checked, wantCap = !fast && $('#plCaption').checked, wantDraw = !fast && $('#plDraw').checked;
  const W = video.videoWidth || 1280, H = video.videoHeight || 720;
  $('#plProgress').classList.remove('hidden'); $('#plBar').style.width = '0%'; $('#plProgText').textContent = 'Preparing…';
  const btns = ['#plExportOne', '#plExportSep', '#plExportPlayer'].map(s => $(s)); btns.forEach(b => b.disabled = true);
  try {
    const payload = clips.map(c => ({
      start: Math.max(0, c.start), end: c.end, name: clipName(c),
      folder: mode === 'player' ? (c.playerId ? playerLabel(c) + (c.name ? ' ' + c.name : '') : 'No player') : '',
      title: wantTitle ? titleCardPNG(c, W, H) : null,
      caption: wantCap ? captionPNG(c, W, H) : null,
      drawings: wantDraw ? (c.drawings || []).filter(d => d.t >= c.start && d.t <= c.end).map(d => ({ t: d.t, dur: d.dur || 3, png: drawingPNG(d.shapes, W, H) })) : []
    }));
    const codes = [...new Set(clips.map(c => c.code))].join('+');
    const r = await api.exportClips({
      videoPath: videoInfo.playPath || videoInfo.path, mode: mode === 'player' ? 'separate' : mode, quality: fast ? 'fast' : 'accurate',
      titleDur: Number(config.general.titleDur) || 2.5,
      defaultName: (videoInfo.name || 'match').replace(/\.[^.]+$/, '') + ' - ' + codes.replace(/[\\/:*?"<>|]/g, '') + '.mp4',
      clips: payload
    });
    if (r.ok) { toast('Video export finished', 'ok', 3000); if (r.path) api.showInFolder(r.path); }
    else if (!r.canceled) alert('Export failed:\n\n' + r.error);
  } finally {
    $('#plProgress').classList.add('hidden');
    btns.forEach(b => b.disabled = false);
  }
}
api.onExportProgress(p => {
  $('#plBar').style.width = p.percent + '%';
  $('#plProgText').textContent = p.stage === 'joining' ? 'Joining clips…' : `Clip ${Math.min(p.index + 1, p.count)} of ${p.count} – ${p.percent}%`;
});
$('#plExportOne').onclick = () => exportVideo('single');
$('#plExportSep').onclick = () => exportVideo('separate');
$('#plExportPlayer').onclick = () => exportVideo('player');
$('#plCancel').onclick = () => api.cancelExport();
