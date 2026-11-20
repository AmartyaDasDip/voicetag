'use strict';
/* =====================================================================
   Projects: dashboard, project folders, save / autosave / backups,
   recent projects, system check.
   A project is a folder:  project.tactiq + videos/ clips/ tracking_data/
   calibration/ reports/ screenshots/ backups/
   ===================================================================== */
function EMPTY_PROJECT() {
  return { file: '', dir: '', info: { name: '', home: config.general.homeName, away: config.general.awayName, homeColor: config.general.homeColor || '#3ea6ff', awayColor: config.general.awayColor || '#ff5a5f',
    date: '', competition: '', venue: 'Home', matchType: 'League', season: '', duration: 90, periods: 2, videoSource: '', analyst: '', notes: '', pitchL: 105, pitchW: 68 } };
}
let project = EMPTY_PROJECT();
let lastBackupAt = 0;
let sysInfo = null;

function syncProjectToApp() {
  const i = project.info;
  config.general.homeName = i.home || 'Home'; config.general.awayName = i.away || 'Opposition';
  config.general.homeColor = i.homeColor || '#3ea6ff'; config.general.awayColor = i.awayColor || '#ff5a5f';
  config.general.pitchL = Number(i.pitchL) || 105; config.general.pitchW = Number(i.pitchW) || 68;
  saveConfig();
  match.info.date = i.date || match.info.date; match.info.competition = i.competition || match.info.competition;
  match.info.venue = i.venue || match.info.venue;
  match.info.opponent = (i.venue === 'Away' ? i.home : i.away) || match.info.opponent;
  updateProjectTitle();
}
function updateProjectTitle() {
  const t = $('#projTitle');
  t.textContent = project.info.name ? '📁 ' + project.info.name : 'Quick session (not saved as a project)';
  t.classList.toggle('dirty', !!dirty && !!project.file);
  document.title = (project.info.name || videoInfo.name || 'Quick session') + ' – TACTIQ ANALYST';
}
HOOKS.render.push(tab => { if (!tab) updateProjectTitle(); });

/* ---------------------------------------------------------------- RECENT PROJECTS */
function recentList() { try { return JSON.parse(localStorage.getItem('tq_recent') || '[]'); } catch (e) { return []; } }
function rememberRecent() {
  if (!project.file) return;
  const i = project.info;
  const list = recentList().filter(r => r.file !== project.file);
  list.unshift({ file: project.file, name: i.name, home: i.home, away: i.away, date: i.date, competition: i.competition, tags: events.length, opened: new Date().toISOString() });
  try { localStorage.setItem('tq_recent', JSON.stringify(list.slice(0, 40))); } catch (e) { /* ignore */ }
}

/* ---------------------------------------------------------------- SAVE / OPEN */
async function writeProjectFile(silent) {
  const proj = projectObject(), text = JSON.stringify(proj);
  const backup = Date.now() - lastBackupAt > 10 * 60 * 1000;
  await api.writeProject({ file: project.file, text, backup });
  if (backup) lastBackupAt = Date.now();
  dirty = false; updateProjectTitle(); rememberRecent();
  if (typeof addToLibrary === 'function') addToLibrary(project.file, proj, text);
  if (!silent) toast('💾 Project saved', 'ok', 1500);
}
async function saveProject(saveAs) {
  if (!api.writeProject) {   // browser test mode: download a file
    const proj = projectObject();
    await saveText((project.info.name || 'match') + '.tactiq', JSON.stringify(proj), 'tactiq', 'TACTIQ project');
    dirty = false; updateProjectTitle(); return;
  }
  if (!project.file || saveAs) {
    const ok = await openProjectForm(project.file ? 'saveas' : 'save');
    if (!ok) return;
  }
  try { await writeProjectFile(false); } catch (err) { alert('Could not save the project:\n' + err.message); }
}
async function openProjectFile(file) {
  if (dirty && project.file && !confirm('Your current project has unsaved changes. Save them first?\n\nOK = save, Cancel = discard')) { /* discard */ }
  else if (dirty && project.file) await writeProjectFile(true);
  const r = await api.readProject(file);
  if (r.error) { alert('Could not open the project:\n' + r.error); return false; }
  try {
    const p = JSON.parse(r.text);
    await openProjectData(p, file, false);
    project = Object.assign(EMPTY_PROJECT(), { file, dir: file.replace(/[\\/][^\\/]+$/, '') });
    if (p.project && p.project.info) project.info = Object.assign(EMPTY_PROJECT().info, p.project.info);
    else project.info.name = file.split(/[\\/]/).slice(-2, -1)[0] || 'Match';
    syncProjectToApp(); dirty = false; History.clear(); rememberRecent(); renderAll(); hideDashboard();
    return true;
  } catch (err) { alert('Could not open the project:\n' + err.message); return false; }
}
async function openProjectDialog() {
  const f = await api.openTextFile({ filters: [{ name: 'TACTIQ / VoiceTag project', extensions: ['tactiq', 'vtproj', 'json'] }] });
  if (!f) return;
  if (/\.tactiq$/i.test(f.path) && api.readProject) { await openProjectFile(f.path); return; }
  try {
    const p = JSON.parse(f.text);
    await openProjectData(p, f.path, true);
    project = EMPTY_PROJECT();
    if (p.project && p.project.info) project.info = Object.assign(project.info, p.project.info);
    project.info.name = project.info.name || (f.path.split(/[\\/]/).pop() || '').replace(/\.[^.]+$/, '');
    syncProjectToApp(); History.clear(); renderAll(); hideDashboard();
    toast('Opened. Use File → Save project to turn it into a project folder.', 'info', 4000);
  } catch (err) { alert('Could not open: ' + err.message); }
}
$('#btnSaveProj').onclick = () => saveProject(false);
$('#btnSaveAs').onclick = () => saveProject(true);
$('#btnOpenProj').onclick = openProjectDialog;
$('#btnNewProj').onclick = () => openProjectForm('new');
$('#btnBackups').onclick = async () => {
  if (!project.file || !api.listBackups) { alert('Backups exist for saved projects. Save this session as a project first.'); return; }
  const list = await api.listBackups(project.file);
  if (!list.length) { alert('No backups yet. A backup is made automatically every 10 minutes while you work.'); return; }
  let pick = null;
  await Dlg.open('⟲ Restore a backup', `<p class="small muted">Backups of <b>${esc(project.info.name)}</b> (newest first). Restoring replaces the current tags; your current state is backed up first.</p>
    <select id="bkSel" size="12" style="width:100%">${list.map((f, i) => `<option value="${esc(f)}" ${i === 0 ? 'selected' : ''}>${esc(f.split(/[\\/]/).pop().replace('project-', '').replace('.tactiq', '').replace('T', '  '))}</option>`).join('')}</select>`,
  [{ label: 'Cancel' }, { label: 'Restore', primary: true, value: 'ok', onClick: () => { pick = $('#bkSel').value; if (!pick) return false; } }]).then(async r => {
    if (r !== 'ok' || !pick) return;
    await writeProjectFile(true);
    const b = await api.readProject(pick);
    if (b.error) { alert(b.error); return; }
    const keepFile = project.file, keepDir = project.dir, p = JSON.parse(b.text);
    await openProjectData(p, keepFile, false);
    project.file = keepFile; project.dir = keepDir;
    if (p.project && p.project.info) project.info = Object.assign(EMPTY_PROJECT().info, p.project.info);
    syncProjectToApp(); markDirty(); renderAll(); toast('Backup restored – press Ctrl+S to keep it', 'ok', 4000);
  });
};
// autosave every minute while a project is open
setInterval(() => { if (dirty && project.file && api.writeProject) writeProjectFile(true).catch(err => console.error(err)); }, 60 * 1000);
window.addEventListener('beforeunload', () => { /* project autosave is async; session autosave (localStorage) still runs */ });

/* ---------------------------------------------------------------- NEW PROJECT / PROJECT DETAILS FORM */
async function openProjectForm(mode) {   // mode: 'new' | 'edit' | 'save' | 'saveas'
  const i = mode === 'new' ? EMPTY_PROJECT().info : Object.assign({}, project.info);
  if (mode === 'new') { i.home = config.general.homeName; i.away = ''; i.date = new Date().toISOString().slice(0, 10); }
  if (!i.name && mode !== 'new') i.name = [i.home, 'vs', i.away || match.info.opponent, i.date || match.info.date].filter(Boolean).join(' ');
  const needsFolder = mode !== 'edit';
  let dir = needsFolder && api.defaultProjectsDir ? await api.defaultProjectsDir() : '';
  let videoPick = null, copyAsked = false;
  const sel = (id, opts, v) => `<select id="${id}">${opts.map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  const html = `<div class="formgrid" style="max-width:none;grid-template-columns:150px 1fr 150px 1fr">
    <label>Project name</label><input id="pfName" value="${esc(i.name)}" placeholder="auto: Home vs Away date" style="grid-column:span 3">
    <label>Home team</label><input id="pfHome" value="${esc(i.home)}"><label>Colour</label><input type="color" id="pfHomeC" value="${esc(i.homeColor)}">
    <label>Away team</label><input id="pfAway" value="${esc(i.away)}"><label>Colour</label><input type="color" id="pfAwayC" value="${esc(i.awayColor)}">
    <label>Match date</label><input type="date" id="pfDate" value="${esc(i.date)}"><label>Season</label><input id="pfSeason" value="${esc(i.season)}" placeholder="2026/27">
    <label>Competition</label><input id="pfComp" value="${esc(i.competition)}"><label>Match type</label>${sel('pfType', ['League', 'Cup', 'Friendly', 'Tournament', 'Training', 'Other'], i.matchType)}
    <label>Venue</label>${sel('pfVenue', ['Home', 'Away', 'Neutral'], i.venue)}<label>Video source</label>${sel('pfSource', ['', 'Veo', 'Broadcast / TV', 'Tactical camera', 'Spectator', 'Smartphone', 'Professional camera', 'Drone', 'Other'], i.videoSource)}
    <label>Match length (min)</label><input type="number" id="pfDur" value="${esc(i.duration)}" min="10" max="150"><label>Periods</label><input type="number" id="pfPer" value="${esc(i.periods)}" min="1" max="4">
    <label>Pitch length (m)</label><input type="number" id="pfPL" value="${esc(i.pitchL)}" min="40" max="130"><label>Pitch width (m)</label><input type="number" id="pfPW" value="${esc(i.pitchW)}" min="20" max="100">
    <label>Analyst</label><input id="pfAnalyst" value="${esc(i.analyst)}" style="grid-column:span 3">
    <label>Notes</label><textarea id="pfNotes" style="grid-column:span 3;min-height:60px">${esc(i.notes)}</textarea>
    ${needsFolder ? `<label>Save in</label><div style="grid-column:span 3;display:flex;gap:6px"><input id="pfDir" value="${esc(dir)}" readonly style="flex:1"><button class="small" id="pfDirBtn">Change…</button></div>` : ''}
    ${mode === 'new' ? `<label>Match video</label><div style="grid-column:span 3;display:flex;gap:6px;align-items:center"><span id="pfVid" class="muted small" style="flex:1">${hasVideo() && videoInfo.path ? 'Use the open video: ' + esc(videoInfo.name) : 'none yet – you can add it later'}</span><button class="small" id="pfVidBtn">Choose video…</button><label class="small"><input type="checkbox" id="pfCopy"> copy video into the project folder</label></div>` : ''}
  </div>
  ${mode === 'new' && events.length ? `<p class="small warn">The ${events.length} tags of the current quick session will be moved into the new project.</p>` : ''}`;
  const title = mode === 'new' ? '✚ New project' : mode === 'edit' ? '📁 Project details' : '💾 Save as a project folder';
  let ok = false;
  await Dlg.open(title, html, [{ label: 'Cancel' }, { label: mode === 'new' ? 'Create project' : mode === 'edit' ? 'Save details' : 'Save project', primary: true, value: 'ok', onClick: () => {
    const v = id => ($('#' + id) || {}).value;
    Object.assign(i, { name: v('pfName').trim(), home: v('pfHome').trim() || 'Home', away: v('pfAway').trim() || 'Opposition', homeColor: v('pfHomeC'), awayColor: v('pfAwayC'),
      date: v('pfDate'), season: v('pfSeason'), competition: v('pfComp'), matchType: v('pfType'), venue: v('pfVenue'), videoSource: v('pfSource'),
      duration: Number(v('pfDur')) || 90, periods: Number(v('pfPer')) || 2, pitchL: Number(v('pfPL')) || 105, pitchW: Number(v('pfPW')) || 68, analyst: v('pfAnalyst'), notes: v('pfNotes') });
    if (!i.name) i.name = [i.home, 'vs', i.away, i.date].filter(Boolean).join(' ');
    if (needsFolder && api.createProject && !dir) { alert('Choose where to save the project.'); return false; }
    copyAsked = !!($('#pfCopy') && $('#pfCopy').checked);
    ok = true;
  } }], { onOpen: b => {
    const db = b.querySelector('#pfDirBtn'); if (db) db.onclick = async () => { const d = await api.chooseDirectory('Where should the project folder be created?'); if (d) { dir = d; b.querySelector('#pfDir').value = d; } };
    const vb = b.querySelector('#pfVidBtn'); if (vb) vb.onclick = async () => { const r = await api.openVideo(); if (r) { videoPick = r; b.querySelector('#pfVid').textContent = r.name; } };
  } });
  if (!ok) return false;
  if (mode === 'edit') { checkpoint(); project.info = i; syncProjectToApp(); markDirty(); renderAll(); return true; }
  if (mode === 'new') {
    const keepTags = events.length && true;
    if (!keepTags) { events = []; nextId = 1; open = {}; match = EMPTY_MATCH(); TR.tracks = []; TR.cals = []; TR.camera = []; TR.log = []; clips = []; }
    History.clear();
  }
  project.info = i;
  if (api.createProject) {
    const r = await api.createProject({ parentDir: dir, name: i.name });
    project.file = r.file; project.dir = r.dir;
  }
  syncProjectToApp();
  if (mode === 'new' && videoPick) await loadVideo(videoPick, true);
  if (mode === 'new' && copyAsked && project.dir && videoInfo.path && api.copyIntoProject) {
    toast('Copying the video into the project folder…', 'info', 6000);
    try {
      const dest = await api.copyIntoProject({ src: videoInfo.path, projectDir: project.dir });
      videoInfo.path = dest;
    } catch (err) { alert('Could not copy the video: ' + err.message); }
  }
  sessionKey = 'vt_session_project_' + (project.file || project.info.name);
  markDirty(); renderAll(); hideDashboard();
  if (project.file) await writeProjectFile(true);
  toast(mode === 'new' ? 'Project created: ' + i.name : 'Saved as project: ' + i.name, 'ok', 3000);
  return true;
}
/* ---------------------------------------------------------------- DASHBOARD */
function renderDashboard() {
  const q = ($('#dSearch').value || '').toLowerCase();
  const list = recentList().filter(r => !q || [r.name, r.home, r.away, r.date, r.competition].join(' ').toLowerCase().includes(q));
  $('#dRecent').innerHTML = list.map(r => `<div class="reccard" data-rec="${esc(r.file)}"><div><div class="t">${esc(r.name || r.file.split(/[\\/]/).slice(-2, -1)[0])}</div>
    <div class="m">${esc([r.date, r.home && r.away ? r.home + ' vs ' + r.away : '', r.competition, (r.tags || 0) + ' tags'].filter(Boolean).join(' · '))}</div>
    <div class="m">${esc(r.file)}</div></div><button class="small danger x" data-recdel="${esc(r.file)}" title="Remove from list (the files stay)">✕</button></div>`).join('')
    || `<p class="muted">${q ? 'No project matches your search.' : 'No projects yet. Create your first project – or start a quick session to tag straight away.'}</p>`;
  $('#dashVer').textContent = 'Version ' + APP_VERSION + ' · video analysis, voice tagging, AI tracking & 2D analytics';
  // quick-session button: back to the open project / continue the last session without a project
  const ls = window.__lastSession, busy = events.length || (typeof TR !== 'undefined' && TR.tracks.length);
  $('#dQuick').textContent = project.file ? '↩ Back to ' + (project.info.name || 'project') : busy ? '↩ Back to the quick session' : '⚡ Quick session (no project)';
  const cont = $('#dCont');
  if (cont) { const show = !project.file && !busy && ls; cont.classList.toggle('hidden', !show); if (show) cont.textContent = `↻ Continue last session (${(ls.events || []).length} tags${ls.video && ls.video.name ? ', ' + ls.video.name : ''})`; }
  if (sysInfo) {
    const mode = sysInfo.ramGB >= 12 ? 'Standard' : 'Light';
    $('#sysInfo').innerHTML = `Windows ${esc(sysInfo.release)} · ${esc(sysInfo.arch)} · ${sysInfo.ramGB} GB RAM · ${sysInfo.cores} CPU threads<br>Performance mode: <b>${mode}</b>${mode === 'Light' ? ' (works fine – AI features will run slower)' : ''}`;
    if (sysInfo.platform === 'win32' && /^6\./.test(sysInfo.release)) $('#sysInfo').innerHTML += '<br><span class="bad">This Windows version is not supported (Windows 10 or 11 needed).</span>';
  }
}
function showDashboard() { renderDashboard(); $('#dash').classList.remove('hidden'); }
function hideDashboard() { $('#dash').classList.add('hidden'); }
$('#btnHome').onclick = showDashboard;
$('#dNew').onclick = () => openProjectForm('new');
$('#dOpen').onclick = openProjectDialog;
$('#dQuick').onclick = hideDashboard;
$('#dCont').onclick = async () => {
  const s = window.__lastSession; window.__lastSession = null; hideDashboard(); if (!s) return;
  if (s.video && s.video.path && api.registerMedia) { const r = await api.registerMedia(s.video.path).catch(() => null); if (r) await loadVideo(r, true); else toast('The video of that session was not found: ' + s.video.name, 'bad', 4000); }
  events = s.events || []; nextId = s.nextId || (Math.max(0, ...events.map(e => e.id)) + 1); if (s.match) match = Object.assign(EMPTY_MATCH(), s.match);
  if (typeof TR !== 'undefined') { TR.tracks = s.tracks || []; TR.cals = s.cals || []; TR.log = s.trlog || []; TR.camera = s.camera || []; }
  if (typeof clips !== 'undefined') clips = s.clips || [];
  History.clear(); renderAll(); toast('Session restored', 'ok');
};
$('#dSettings').onclick = () => { hideDashboard(); openSettings(); };
$('#dSearch').oninput = renderDashboard;
$('#dRecent').addEventListener('click', async e => {
  const del = e.target.closest('[data-recdel]');
  if (del) { e.stopPropagation(); try { localStorage.setItem('tq_recent', JSON.stringify(recentList().filter(r => r.file !== del.dataset.recdel))); } catch (err) { /* ignore */ } renderDashboard(); return; }
  const c = e.target.closest('[data-rec]');
  if (!c) return;
  const f = c.dataset.rec;
  if (api.pathExists && !(await api.pathExists(f))) { if (confirm('This project was not found:\n' + f + '\n\nRemove it from the list?')) { localStorage.setItem('tq_recent', JSON.stringify(recentList().filter(r => r.file !== f))); renderDashboard(); } return; }
  openProjectFile(f);
});
window.addEventListener('DOMContentLoaded', async () => {
  if (api.systemInfo) { try { sysInfo = await api.systemInfo(); } catch (e) { /* ignore */ } }
  updateProjectTitle();
  const f = api.pendingFile ? await api.pendingFile() : null;
  if (f) { openProjectFile(f); return; }
  showDashboard();
});
if (api.onOpenFile) api.onOpenFile(f => openProjectFile(f));
