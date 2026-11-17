/* TACTIQ ANALYST – AI player detection & tracking (phase 0.4).
   The heavy work runs in a background process (engine/worker.js); this file is the user interface:
   choose a range → analyse → map the two kit colours to Home/Away → import as editable tracks. */
'use strict';
const AI = { running: false, progress: null, info: null, last: null };

const rgbHex = c => c ? '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('') : '#888';

async function aiInfo() { if (!AI.info && api.aiInfo) { try { AI.info = await api.aiInfo(); } catch (e) { AI.info = null; } } return AI.info; }

function renderAiBox() {
  const box = document.querySelector('#aiBox');
  if (!box) return;
  const nAi = TR.tracks.filter(t => t.ai).length;
  if (!api.aiAnalyse) { box.innerHTML = '<p class="small muted">🤖 AI detection is available in the installed Windows app.</p>'; return; }
  if (AI.running) {
    const p = AI.progress;
    const pct = p ? Math.round(p.done / Math.max(1, p.total) * 100) : 0;
    box.innerHTML = `<div class="exportbox" style="margin:0 0 10px"><b>🤖 AI is analysing the video…</b>
      <div class="aibar"><div style="width:${pct}%"></div></div>
      <div class="small muted">${p ? `${p.done} / ${p.total} frames · ${p.speed.toFixed(1)} frames/s · about ${aiDur(p.eta)} left` : 'Starting the AI engine…'}</div>
      <div class="toolbar"><button class="small danger" id="aiCancel">Cancel</button></div></div>`;
    box.querySelector('#aiCancel').onclick = () => api.aiCancel();
    return;
  }
  box.innerHTML = `<div class="toolbar"><button class="small primary" id="aiRun" title="Detect and follow every player automatically">🤖 Auto-detect players (AI)</button>
    ${nAi ? `<button class="small" id="aiLow" title="Jump to the next AI position the engine was unsure about">⚠ Next unsure point</button><button class="small danger" id="aiClear">Remove ${nAi} AI tracks</button>` : ''}
    ${selTrack() ? `<button class="small" id="tkJoin" title="Two tracks are the same person (e.g. after a collision): join them">⇄ Join selected with…</button><button class="small" id="tkSplit" title="The track jumps to another person from here: cut it into a new track">✂ Split selected here</button>` : ''}
    ${AI.last ? `<button class="small" id="aiAgain" title="Import the last analysis again with different team choices">↺ Re-import last run</button>` : ''}</div>`;
  box.querySelector('#aiRun').onclick = aiStartDialog;
  const c = box.querySelector('#aiClear'); if (c) c.onclick = aiClearTracks;
  const l = box.querySelector('#aiLow'); if (l) l.onclick = aiNextLow;
  const j = box.querySelector('#tkJoin'); if (j) j.onclick = joinTracksDialog;
  const sp = box.querySelector('#tkSplit'); if (sp) sp.onclick = splitTrackHere;
  const a = box.querySelector('#aiAgain'); if (a) a.onclick = () => aiResultDialog(AI.last.result, AI.last.opts);
}
function aiDur(s) { s = Math.max(0, Math.round(s || 0)); return s >= 3600 ? Math.floor(s / 3600) + ' h ' + Math.round(s % 3600 / 60) + ' min' : s >= 60 ? Math.floor(s / 60) + ' min ' + (s % 60) + ' s' : s + ' s'; }

async function aiStartDialog() {
  if (!hasVideo() || !videoInfo || !videoInfo.path) { toast('Open a video first', 'bad'); return; }
  const info = await aiInfo();
  if (!info || !info.fast) { toast('The AI model files are missing from this installation', 'bad', 4000); return; }
  const dur = video.duration || 0, now = video.currentTime || 0;
  const hasIO = clipIO.in != null && clipIO.out != null;
  const def = info.recommended || 'fast';
  const html = `
    <p class="small muted">The AI finds every person on the pitch, follows them from frame to frame and splits them into two teams by shirt colour.
      The results become normal tracks you can correct, name and use in the 2D view, heat maps and exports. Works best on the wide (tactical / main) camera.</p>
    <h4>What to analyse</h4>
    <label class="blk"><input type="radio" name="aiRange" value="next" checked> From here (${fmtTime(now)}) for <input type="number" id="aiSecs" value="30" min="2" max="3600" style="width:70px"> seconds</label>
    ${hasIO ? `<label class="blk"><input type="radio" name="aiRange" value="io"> The clip IN–OUT marks (${fmtTime(clipIO.in)} – ${fmtTime(clipIO.out)})</label>` : '<p class="small muted">Tip: set clip IN <kbd>[</kbd> and OUT <kbd>]</kbd> to analyse exactly one phase.</p>'}
    <label class="blk"><input type="radio" name="aiRange" value="all"> The whole video (${fmtTime(dur)}) – this can take a long time</label>
    <h4>Settings</h4>
    <label class="blk">Model <select id="aiQ"><option value="fast" ${def === 'fast' ? 'selected' : ''}>Fast (smaller model – for 8 GB PCs)</option>
      ${info.accurate ? `<option value="accurate" ${def === 'accurate' ? 'selected' : ''}>Accurate (bigger model – finds far-away players better)</option>` : ''}</select></label>
    <label class="blk">Look at <select id="aiStride"><option value="1">every frame (slowest, smoothest)</option><option value="2" selected>every 2nd frame (recommended)</option><option value="3">every 3rd frame</option><option value="5">every 5th frame (fastest)</option></select></label>
    <label class="blk"><input type="checkbox" id="aiCpu"> Use the processor only (tick this if the graphics card causes problems)</label>
    <p class="small muted">This PC: ${info.ramGB} GB RAM, ${info.cores} processor threads. ${info.gpu ? 'The graphics card is used automatically when possible (DirectX 12).' : ''} You can keep tagging while it runs.</p>`;
  let opts = null;
  const r = await Dlg.open('🤖 Auto-detect players', html, [{ label: 'Cancel' }, { label: 'Start', primary: true, value: 'go', onClick: () => {
    const b = $('#dlgBody'), mode = b.querySelector('input[name=aiRange]:checked').value;
    let start = now, d = Number(b.querySelector('#aiSecs').value) || 30;
    if (mode === 'io') { start = clipIO.in; d = clipIO.out - clipIO.in; }
    if (mode === 'all') { start = 0; d = dur; }
    d = Math.min(d, Math.max(0.5, dur - start));
    opts = { start: Math.round(start * 1000) / 1000, duration: Math.round(d * 1000) / 1000, quality: b.querySelector('#aiQ').value, stride: Number(b.querySelector('#aiStride').value), cpuOnly: b.querySelector('#aiCpu').checked };
  } }]);
  if (r !== 'go' || !opts) return;
  aiRun(opts);
}

async function aiRun(opts) {
  AI.running = true; AI.progress = null; renderAiBox();
  api.onAiProgress(p => { AI.progress = p; renderAiBox(); });
  toast('AI analysis started – you can keep working', 'info', 2500);
  let res;
  try { res = await api.aiAnalyse(Object.assign({ video: videoInfo.playPath || videoInfo.path }, opts)); }
  catch (e) { res = { ok: false, error: String(e && e.message || e) }; }
  AI.running = false; AI.progress = null; renderTrackTab();
  if (!res || !res.ok) { if (res && res.error === 'cancelled') toast('AI analysis cancelled', 'info'); else Dlg.open('AI analysis failed', `<p>${esc(res && res.error || 'Unknown error')}</p><p class="small muted">Try “Use the processor only”, the Fast model, or a shorter range.</p>`); return; }
  AI.last = { result: res, opts };
  // keep the raw result with the project, so nothing is lost if the import is changed later
  if (project && project.dir && api.writeText) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    api.writeText({ file: project.dir + '/tracking_data/ai_run_' + stamp + '.json', text: JSON.stringify({ opts, result: res }) }).catch(() => {});
  }
  aiResultDialog(res, opts);
}

function aiOffPitchShare(tr) {
  let n = 0, off = 0;
  const { L, W } = pitchDims();
  tr.points.forEach(p => { const q = toPitch(p.t, p.x, p.y); if (!q) return; n++; if (q[0] < -4 || q[0] > L + 4 || q[1] < -4 || q[1] > W + 4) off++; });
  return n >= 3 ? off / n : null;
}

async function aiResultDialog(res, opts) {
  const m = res.meta, tracks = res.tracks;
  const cnt = k => tracks.filter(t => t.team === k).length;
  const cl = res.clusters || [];
  const hasCal = TR.cals.some(c => c.type !== 'none');
  const prevAi = TR.tracks.filter(t => t.ai).length;
  const hexRgb = h => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); return m ? [0, 2, 4].map(i => parseInt(m[1].substr(i, 2), 16)) : null; };
  const d = (a, b) => a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : 0;
  const hc = hexRgb(config.general.homeColor), ac = hexRgb(config.general.awayColor);
  const swap = cl.length === 2 && hc && ac && d(cl[0], hc) + d(cl[1], ac) > d(cl[0], ac) + d(cl[1], hc);
  const html = `
    <p>Analysed <b>${fmtTime(m.start)} – ${fmtTime(m.start + m.duration)}</b>: ${m.frames} frames in ${aiDur(m.seconds)} (${m.framesPerSecond} frames/s, ${m.provider === 'dml' ? 'graphics card' : 'processor'}, ${esc(m.model)}).</p>
    <p>Found <b>${tracks.length}</b> tracks${res.ball.length ? ` and the ball in ${res.ball.length} frames` : ''}.</p>
    <h4>Which team is which?</h4>
    <table class="aimap"><tr><th>Kit colour</th><th>Tracks</th><th>Import as</th></tr>
      ${['A', 'B'].map((k, i) => `<tr><td><span class="swatch" style="background:${rgbHex(cl[i])}"></span> Group ${k}</td><td>${cnt(k)}</td>
        <td><select id="aiMap${k}"><option value="Home" ${(i === 0) !== swap ? 'selected' : ''}>${esc(teamName('Home'))}</option><option value="Away" ${(i === 1) !== swap ? 'selected' : ''}>${esc(teamName('Away'))}</option><option value="skip">don’t import</option></select></td></tr>`).join('')}
      <tr><td><span class="swatch" style="background:#bbb"></span> Other (referees, keepers, staff)</td><td>${cnt('other')}</td>
        <td><select id="aiMapO"><option value="Neutral">Neutral / other</option><option value="skip">don’t import</option></select></td></tr></table>
    <p class="small muted">Tip: set each team’s kit colour in Match / project details and the right team is picked for you next time.
      The goalkeepers usually wear a different colour, so they land in “Other” – change them to the right team with ✎ after importing.</p>
    <h4>Options</h4>
    <label class="blk">Ignore tracks shorter than <input type="number" id="aiMin" value="1" min="0" max="30" step="0.5" style="width:60px"> seconds</label>
    <label class="blk"><input type="checkbox" id="aiBall" ${res.ball.length ? 'checked' : 'disabled'}> Import the ball (experimental – check it)</label>
    <label class="blk"><input type="checkbox" id="aiOff" ${hasCal ? 'checked' : 'disabled'}> Drop people standing off the pitch ${hasCal ? '' : '<span class="muted">(needs a pitch calibration)</span>'}</label>
    ${prevAi ? `<label class="blk"><input type="checkbox" id="aiReplace" checked> Replace the ${prevAi} AI tracks already in this range</label>` : ''}`;
  let choice = null;
  const r = await Dlg.open('🤖 AI results', html, [{ label: 'Discard' }, { label: 'Import tracks', primary: true, value: 'imp', onClick: () => {
    const b = $('#dlgBody');
    choice = { A: b.querySelector('#aiMapA').value, B: b.querySelector('#aiMapB').value, other: b.querySelector('#aiMapO').value,
      min: Number(b.querySelector('#aiMin').value) || 0, ball: b.querySelector('#aiBall').checked, off: b.querySelector('#aiOff').checked,
      replace: !!(b.querySelector('#aiReplace') && b.querySelector('#aiReplace').checked) };
  } }]);
  if (r !== 'imp' || !choice) return;
  aiImport(res, choice);
}

function aiImport(res, ch) {
  checkpoint();
  const m = res.meta, t0 = m.start, t1 = m.start + m.duration, run = 'ai' + Date.now().toString(36);
  if (ch.replace) TR.tracks.forEach(tk => { if (tk.ai) tk.points = tk.points.filter(p => p.src !== 'ai' || p.t < t0 - 0.01 || p.t > t1 + 0.01); });
  TR.tracks = TR.tracks.filter(tk => !tk.ai || tk.points.length);
  const counters = {};
  let added = 0, dropped = 0;
  const label = team => { counters[team] = (counters[team] || 0) + 1; return (team === 'Home' ? 'H' : team === 'Away' ? 'A' : 'X') + counters[team]; };
  res.tracks.forEach(tr => {
    const team = ch[tr.team] || ch.other;
    if (team === 'skip') return;
    if (tr.points[tr.points.length - 1].t - tr.points[0].t < ch.min) { dropped++; return; }
    if (ch.off) { const s = aiOffPitchShare(tr); if (s != null && s > 0.6) { dropped++; return; } }
    const tk = newTrack({ team: team === 'Neutral' ? 'Neutral' : team, kind: team === 'Neutral' ? 'other' : 'player', label: label(team),
      ai: { run, id: tr.id, colour: tr.colour } });
    if (team === 'Neutral') tk.color = rgbHex(tr.colour);
    tk.points = tr.points.map(p => ({ t: qt(p.t), x: p.x, y: p.y, src: 'ai', vis: 'v', conf: p.conf }));
    added++;
  });
  if (ch.ball && res.ball.length) {
    let tk = TR.tracks.find(x => x.kind === 'ball');
    if (!tk) tk = newTrack({ kind: 'ball', team: 'Neutral', label: 'Ball' });
    tk.ai = tk.ai || { run };
    const keep = tk.points.filter(p => p.src !== 'ai' && (p.t < t0 - 0.01 || p.t > t1 + 0.01) || p.src === 'manual');
    const fd = frameDur();
    const add = res.ball.map(b => ({ t: qt(b.t), x: b.x, y: b.y, src: 'ai', vis: 'v', conf: b.conf })).filter(p => !keep.some(q => Math.abs(q.t - p.t) < fd * 0.51));
    tk.points = keep.concat(add).sort((a, b) => a.t - b.t);
  }
  TR.settings.showAll = true; TR.settings.overlay = true;
  if (Number(TR.settings.maxGap) < 1) TR.settings.maxGap = 1;
  markDirty(); autosave(); renderTrackTab(); paintTracking(true);
  toast(`Imported ${added} AI tracks` + (dropped ? ` (${dropped} short/off-pitch skipped)` : ''), 'ok', 3500);
}

function aiClearTracks() {
  const n = TR.tracks.filter(t => t.ai).length;
  if (!n || !confirm(`Remove all ${n} AI tracks? (Tracks you made yourself are kept. Points you corrected by hand inside AI tracks are removed too.)`)) return;
  checkpoint();
  TR.tracks = TR.tracks.filter(t => !t.ai || t.kind === 'ball' && (t.points = t.points.filter(p => p.src !== 'ai')).length);
  if (TR.sel && !TR.tracks.some(t => t.id === TR.sel)) TR.sel = null;
  markDirty(); autosave(); renderTrackTab(); paintTracking(true);
}

// review: jump to the next AI point whose confidence is low and select its track
function aiNextLow() {
  const t = (video.currentTime || 0) + frameDur() * 0.6;
  let best = null;
  TR.tracks.forEach(tk => tk.points.forEach(p => { if (p.src === 'ai' && p.conf != null && p.conf < 0.4 && p.t > t && (!best || p.t < best.p.t)) best = { tk, p }; }));
  if (!best) { toast('No more unsure AI points after this moment', 'info'); return; }
  TR.sel = best.tk.id; TR.settings.showAll = true;
  video.pause(); video.currentTime = best.p.t + frameDur() * 0.1;
  if (!TR.on) setTracking(true);
  renderTrackTab(); paintTracking(true);
  toast(`${trackLabel(best.tk)}: the AI was only ${Math.round(best.p.conf * 100)}% sure – click the right spot to correct it`, 'info', 3500);
}

/* ---------- correcting tracks: join two tracks of the same person, split an ID switch ---------- */
async function joinTracksDialog() {
  const tk = selTrack(); if (!tk) return;
  const span = x => x.points.length ? [x.points[0].t, x.points[x.points.length - 1].t] : [0, 0];
  const [a0, a1] = span(tk);
  const others = TR.tracks.filter(x => x !== tk && x.kind !== 'ball' && x.points.length).map(x => {
    const [b0, b1] = span(x), overlap = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
    const gap = b0 > a1 ? b0 - a1 : a0 > b1 ? a0 - b1 : 0;
    return { x, overlap, gap, b0, b1 };
  }).sort((p, q) => (p.overlap - q.overlap) || (p.gap - q.gap));
  if (!others.length) { toast('No other tracks to join with', 'bad'); return; }
  let id = null;
  const r = await Dlg.open('⇄ Join “' + trackLabel(tk) + '” with…', `<p class="small muted">Pick the track that is the same person. Tracks that don’t overlap in time are listed first.
    Where both have a position at the same moment, the hand-made or more confident one is kept.</p>
    <select id="jnSel" size="12" style="width:100%">${others.map((o, i) => `<option value="${o.x.id}" ${i === 0 ? 'selected' : ''}>${esc(trackLabel(o.x))} · ${esc(teamName(o.x.team))} · ${fmtTime(o.b0)}–${fmtTime(o.b1)}${o.overlap ? ' · overlaps ' + o.overlap.toFixed(1) + ' s' : o.gap ? ' · gap ' + o.gap.toFixed(1) + ' s' : ''}</option>`).join('')}</select>`,
  [{ label: 'Cancel' }, { label: 'Join', primary: true, value: 'ok', onClick: () => { id = $('#jnSel').value; } }]);
  if (r !== 'ok' || !id) return;
  const other = TR.tracks.find(x => x.id === id); if (!other) return;
  checkpoint();
  const fd = frameDur(), score = p => (p.src === 'manual' ? 2 : 0) + (p.conf == null ? 1 : p.conf);
  const pts = tk.points.slice();
  other.points.forEach(p => { const i = pts.findIndex(q => Math.abs(q.t - p.t) < fd * 0.51); if (i < 0) pts.push(p); else if (score(p) > score(pts[i])) pts[i] = p; });
  tk.points = pts.sort((a, b) => a.t - b.t);
  if (!tk.playerId && other.playerId) tk.playerId = other.playerId;
  TR.tracks = TR.tracks.filter(x => x !== other);
  markDirty(); autosave(); renderTrackTab(); paintTracking(true);
  toast('Joined – ' + trackLabel(tk) + ' now has ' + tk.points.length + ' points', 'ok');
}
function splitTrackHere() {
  const tk = selTrack(); if (!tk || !hasVideo()) return;
  const t = video.currentTime - frameDur() * 0.5;
  const after = tk.points.filter(p => p.t >= t);
  if (!after.length || after.length === tk.points.length) { toast('Move the video to the moment the track jumps to another person', 'bad', 3000); return; }
  checkpoint();
  tk.points = tk.points.filter(p => p.t < t);
  const nk = newTrack({ team: tk.team, kind: tk.kind, label: (tk.label || 'P') + '′', ai: tk.ai ? Object.assign({}, tk.ai) : undefined });
  nk.points = after;
  TR.sel = nk.id;
  markDirty(); autosave(); renderTrackTab(); paintTracking(true);
  toast('Split: the part from ' + fmtTime(t) + ' is now “' + trackLabel(nk) + '” – use ✎ to say who it is', 'ok', 3500);
}
