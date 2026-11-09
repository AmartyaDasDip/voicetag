'use strict';
/* =====================================================================
   Settings window: codes, players, outcomes, labels, voice commands,
   KPIs, templates, general.
   ===================================================================== */
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
$('#btnEditCW').onclick = () => openSettings('codes');
$('#setCancel').onclick = closeSettings;
$$('#setTabs button').forEach(b => b.onclick = () => { setTab = b.dataset.st; $$('#setTabs button').forEach(x => x.classList.toggle('active', x === b)); renderSettings(); });
const hkInput = v => `<input class="hk" data-f="hotkey" maxlength="1" value="${esc(String(v || '').toUpperCase())}" title="One key (letter or number)">`;
const rowBtns = '<button class="small" data-move="-1" title="Move up">↑</button><button class="small danger" data-delrow title="Delete">✕</button>';
const sayHint = '<span class="muted small">exactly what you say – commas separate alternatives</span>';

function renderSettings() {
  const body = $('#setBody'), g = draft.general;
  if (setTab === 'codes') {
    body.innerHTML = `<p class="muted"><b>Event</b> codes make a clip around one moment (lead = seconds before, lag = seconds after). <b>Phase</b> codes (e.g. Build-up) start on the first press and stop on the second. <b>📍end</b> = ask for an end point on the pitch (passes, crosses).</p>
    <table><thead><tr><th style="width:140px">Code</th><th style="width:96px">Type</th><th style="width:52px">Key</th><th>Say ${sayHint}</th><th>Possible outcomes</th><th style="width:118px">Default outcome</th><th style="width:50px">Lead</th><th style="width:50px">Lag</th><th style="width:40px">📍end</th><th style="width:46px">Colour</th><th style="width:62px"></th></tr></thead><tbody>
    ${draft.codes.map((c, i) => `<tr data-kind="codes" data-i="${i}">
      <td><input data-f="name" value="${esc(c.name)}"></td>
      <td><select data-f="type"><option value="instant" ${c.type !== 'duration' ? 'selected' : ''}>Event</option><option value="duration" ${c.type === 'duration' ? 'selected' : ''}>Phase</option></select></td>
      <td>${hkInput(c.hotkey)}</td>
      <td><input data-f="say" value="${esc(c.say)}"></td>
      <td>${draft.outcomes.map(o => `<label class="ocheck"><input type="checkbox" data-f="outcome" data-oid="${o.id}" ${c.outcomes.includes(o.id) ? 'checked' : ''}>${esc(o.name)}</label>`).join('')}</td>
      <td><select data-f="def"><option value="">— none —</option>${c.outcomes.map(id => draft.outcomes.find(o => o.id === id)).filter(Boolean).map(o => `<option value="${o.id}" ${c.def === o.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></td>
      <td><input class="num" type="number" min="0" step="1" data-f="lead" value="${esc(c.lead)}"></td>
      <td><input class="num" type="number" min="0" step="1" data-f="lag" value="${esc(c.lag)}"></td>
      <td><input type="checkbox" data-f="endLoc" ${c.endLoc ? 'checked' : ''} style="width:auto"></td>
      <td><input type="color" data-f="color" value="${esc(c.color || '#888888')}" style="padding:0;height:28px"></td>
      <td>${rowBtns}</td></tr>`).join('')}
    </tbody></table>
    <div class="toolbar" style="margin-top:10px"><button data-add="codes">+ Add event code</button><button data-add="phase">+ Add phase code</button></div>`;
  } else if (setTab === 'players') {
    body.innerHTML = `<p class="muted">The <b>Say</b> box is exactly what you will say for this player – e.g. <code>player eleven</code>, <code>nine</code>, <code>right back</code> or a nickname. Separate alternatives with commas. Numbers can be typed as digits (11) or words (eleven).</p>
    <div class="toolbar"><button class="small" id="sayFromPos">Fill “Say” from positions + numbers</button><button class="small" id="sayFromNum">Fill “Say” as “player + number”</button><button class="small" id="sayFromName">Fill “Say” from surnames</button><button class="small" data-act="importPlayers">⬆ Paste players from Excel</button></div>
    <table><thead><tr><th style="width:125px">Team</th><th style="width:60px">No.</th><th>Name</th><th>Position</th><th>Say ${sayHint}</th><th style="width:52px">Key</th><th style="width:62px"></th></tr></thead><tbody>
    ${draft.players.map((p, i) => `<tr data-kind="players" data-i="${i}">
      <td><select data-f="team"><option value="Home" ${p.team !== 'Away' ? 'selected' : ''}>${esc(g.homeName)}</option><option value="Away" ${p.team === 'Away' ? 'selected' : ''}>${esc(g.awayName)}</option></select></td>
      <td><input class="num" data-f="num" value="${esc(p.num)}"></td>
      <td><input data-f="name" value="${esc(p.name)}" placeholder="e.g. James Smith"></td>
      <td><input data-f="pos" value="${esc(p.pos)}" placeholder="e.g. Right Back"></td>
      <td><input data-f="say" value="${esc(p.say)}"></td>
      <td>${hkInput(p.hotkey)}</td>
      <td>${rowBtns}</td></tr>`).join('')}
    </tbody></table>
    <div class="toolbar" style="margin-top:10px"><button data-add="players">+ Add player</button><button data-add="opp">+ Add opposition player</button></div>`;
  } else if (setTab === 'outcomes') {
    body.innerHTML = `<p class="muted"><b>Positive</b> outcomes count as success (1), <b>Negative</b> as failure (0) in the exports and success %.</p>
    <table><thead><tr><th style="width:170px">Outcome</th><th>Say ${sayHint}</th><th style="width:170px">Type</th><th style="width:52px">Key</th><th style="width:62px"></th></tr></thead><tbody>
    ${draft.outcomes.map((o, i) => `<tr data-kind="outcomes" data-i="${i}">
      <td><input data-f="name" value="${esc(o.name)}"></td>
      <td><input data-f="say" value="${esc(o.say)}"></td>
      <td><select data-f="type"><option value="pos" ${o.type === 'pos' ? 'selected' : ''}>Positive (success)</option><option value="neg" ${o.type === 'neg' ? 'selected' : ''}>Negative (fail)</option><option value="neu" ${o.type === 'neu' ? 'selected' : ''}>Neutral</option></select></td>
      <td>${hkInput(o.hotkey)}</td><td>${rowBtns}</td></tr>`).join('')}
    </tbody></table>
    <div class="toolbar" style="margin-top:10px"><button data-add="outcomes">+ Add outcome</button></div>`;
  } else if (setTab === 'labels') {
    body.innerHTML = `<p class="muted">Label groups are extra keywords for any tag (like Sportscode labels). One label per group per tag. The groups <b>Zone</b> and <b>Side</b> are also filled automatically from the pitch location (General → auto zone).</p>
    ${draft.labelGroups.map((gr, gi) => `<div class="groupbox">
      <div class="toolbar" data-group="${gi}"><b>Group</b><input data-gf="name" value="${esc(gr.name)}" style="width:220px"><div class="spacer"></div><button class="small danger" data-delgroup="${gi}">Delete group</button></div>
      <table><thead><tr><th>Label</th><th>Say ${sayHint}</th><th style="width:52px">Key</th><th style="width:36px"></th></tr></thead><tbody>
      ${gr.labels.map((l, li) => `<tr data-kind="label" data-g="${gi}" data-i="${li}"><td><input data-f="name" value="${esc(l.name)}"></td><td><input data-f="say" value="${esc(l.say || '')}"></td><td>${hkInput(l.hotkey)}</td><td><button class="small danger" data-delrow>✕</button></td></tr>`).join('')}
      </tbody></table>
      <div class="toolbar" style="margin-top:6px"><button class="small" data-addlabel="${gi}">+ Add label</button></div></div>`).join('')}
    <button data-add="group">+ Add label group</button>`;
  } else if (setTab === 'voice') {
    const pOpts = '<option value="">— no player —</option>' + draft.players.map(p => `<option value="${p.id}">${esc((p.team === 'Away' ? '(opp) ' : '') + playerLabel(p))}</option>`).join('');
    const cOpts = '<option value="">— no code (only adds to latest tag) —</option>' + draft.codes.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    const oOpts = '<option value="">— default —</option>' + draft.outcomes.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
    const lOpts = '<option value="">—</option>' + draft.labelGroups.map(gr => gr.labels.map(l => `<option value="${gr.id}|${l.id}">${esc(gr.name + ': ' + l.name)}</option>`).join('')).join('');
    body.innerHTML = `
    <div class="voicetest"><b>🧪 Test a command</b> <span class="muted small">– type what you would say and see exactly what it will tag</span>
      <input id="vtTest" placeholder="e.g.  player eleven pass successful"><div id="vtTestOut" class="small" style="margin-top:6px">—</div></div>
    <p><b>Two ways to set your voice commands</b></p>
    <ol class="small">
      <li><b>Build from parts</b> – every player, code, outcome and label has a <b>Say</b> box (in their tabs). You say them in a row: <code>[player] [code] [outcome] [label]</code>, e.g. <code>right back pass unsuccessful final third</code>.</li>
      <li><b>Your own full phrases</b> (below) – type a whole sentence and choose what it should tag. Saying that sentence does exactly that. Use this for anything special, e.g. <code>nine pass good</code> → #9 · Pass · Successful.</li>
    </ol>
    <p class="small warn">The offline engine understands English words. Type your commands with English words (nicknames that sound like English words work best).</p>
    <h4>Your full phrases</h4>
    <table><thead><tr><th>Phrase you say <span class="muted small">(commas = alternatives)</span></th><th>Player</th><th>Code</th><th>Outcome</th><th>Label</th><th>Label 2</th><th style="width:36px"></th></tr></thead><tbody>
    ${draft.customPhrases.map((cp, i) => { const ls = String(cp.labels || '').split(',').filter(Boolean); return `<tr data-kind="customPhrases" data-i="${i}">
      <td><input data-f="phrase" value="${esc(cp.phrase)}" placeholder="e.g. nine pass good"></td>
      <td><select data-f="playerId">${pOpts.replace(`value="${cp.playerId}"`, `value="${cp.playerId}" selected`)}</select></td>
      <td><select data-f="codeId">${cOpts.replace(`value="${cp.codeId}"`, `value="${cp.codeId}" selected`)}</select></td>
      <td><select data-f="outcomeId">${oOpts.replace(`value="${cp.outcomeId}"`, `value="${cp.outcomeId}" selected`)}</select></td>
      <td><select data-f="label0">${lOpts.replace(`value="${ls[0]}"`, `value="${ls[0]}" selected`)}</select></td>
      <td><select data-f="label1">${lOpts.replace(`value="${ls[1]}"`, `value="${ls[1]}" selected`)}</select></td>
      <td><button class="small danger" data-delrow>✕</button></td></tr>`; }).join('') || '<tr><td colspan="7" class="muted">No phrases yet.</td></tr>'}
    </tbody></table>
    <div class="toolbar" style="margin-top:8px"><button data-add="phrase">+ Add phrase</button></div>
    <h4>Other voice words</h4>
    <div class="grid2"><label>“Same player as the last tag”</label><input data-g="samePlayerSay" value="${esc(g.samePlayerSay)}">
      <span class="hint">e.g. say <code>same player cross</code> right after <code>right back pass</code>.</span></div>
    <h4>What you can say right now</h4>
    <div class="small">${draft.players.map(p => `<span class="pill">${esc(playerLabel(p))}: ${esc(splitAliases(p.say).join(' / ') || '—')}</span>`).join('')}</div>
    <div class="small" style="margin-top:6px">${draft.codes.map(c => `<span class="pill">${esc(c.name)}: ${esc(splitAliases(c.say).join(' / ') || c.name)}</span>`).join('')}</div>
    <div class="small" style="margin-top:6px">${draft.outcomes.map(o => `<span class="pill">${esc(o.name)}: ${esc(splitAliases(o.say).join(' / ') || o.name)}</span>`).join('')}</div>`;
    const inp = body.querySelector('#vtTest');
    inp.oninput = () => {
      if (!inp.value.trim()) { body.querySelector('#vtTestOut').textContent = '—'; return; }
      const V = buildVocab(draft);
      const saved = config; config = draft;   // custom label lookup uses the draft while testing
      try { body.querySelector('#vtTestOut').textContent = '→ ' + describeParse(parseUtterance(inp.value, V, draft)); } finally { config = saved; }
    };
  } else if (setTab === 'kpis') {
    const cOpts = draft.codes.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    body.innerHTML = `<p class="muted">Targets for each match. They appear in Stats, the Excel file and the PDF report with ✓ / ✗.</p>
    <table><thead><tr><th>KPI name</th><th style="width:150px">Team</th><th style="width:170px">Code</th><th style="width:150px">Measure</th><th style="width:70px"></th><th style="width:90px">Target</th><th style="width:36px"></th></tr></thead><tbody>
    ${draft.kpis.map((k, i) => `<tr data-kind="kpis" data-i="${i}">
      <td><input data-f="name" value="${esc(k.name)}"></td>
      <td><select data-f="team"><option value="Home" ${k.team !== 'Away' ? 'selected' : ''}>${esc(g.homeName)}</option><option value="Away" ${k.team === 'Away' ? 'selected' : ''}>${esc(g.awayName)}</option></select></td>
      <td><select data-f="codeId">${cOpts.replace(`value="${k.codeId}"`, `value="${k.codeId}" selected`)}</select></td>
      <td><select data-f="metric"><option value="count" ${k.metric !== 'pct' ? 'selected' : ''}>Count</option><option value="pct" ${k.metric === 'pct' ? 'selected' : ''}>Success %</option></select></td>
      <td><select data-f="cmp"><option ${k.cmp !== '<=' ? 'selected' : ''}>&gt;=</option><option ${k.cmp === '<=' ? 'selected' : ''}>&lt;=</option></select></td>
      <td><input class="num" type="number" data-f="target" value="${esc(k.target)}"></td>
      <td><button class="small danger" data-delrow>✕</button></td></tr>`).join('')}
    </tbody></table>
    <div class="toolbar" style="margin-top:10px"><button data-add="kpi">+ Add KPI</button></div>`;
  } else if (setTab === 'templates') {
    const ut = userTemplates();
    const card = (t, i, builtIn) => `<div class="tplcard"><b>${esc(t.name)}</b><span class="muted small">${(t.codes || []).length} codes${t.players ? ', ' + t.players.length + ' players' : ''}</span>
      <button class="small" data-tload="${builtIn ? 'b' : 'u'}${i}">Load</button>${builtIn ? '' : `<button class="small" data-texp="${i}">Export</button><button class="small danger" data-tdel="${i}">✕</button>`}</div>`;
    body.innerHTML = `<p class="muted">A template is a ready-made code window: codes, outcomes, labels, your voice phrases and KPIs (players optional). Load one, then press <b>Save settings</b>.</p>
    <label class="small"><input type="checkbox" id="tplPlayers"> Include players when saving / loading</label>
    <h4>Built-in</h4>${builtInTemplates().map((t, i) => card(t, i, true)).join('')}
    <h4>Yours</h4>${ut.map((t, i) => card(t, i, false)).join('') || '<p class="muted small">None yet.</p>'}
    <div class="toolbar" style="margin-top:10px"><button id="tplSave">💾 Save current settings as template</button><button id="tplImport">⬆ Import template file</button></div>`;
  } else {
    body.innerHTML = `<div class="grid2">
      <label>Voice reaction offset (seconds)</label><input type="number" step="0.5" min="0" max="10" data-g="offset" value="${esc(g.offset)}">
      <span class="hint">While the video plays, a voice tag is placed this many seconds before you start speaking.</span>
      <label>Button / key offset (seconds)</label><input type="number" step="0.5" min="0" max="10" data-g="hotkeyOffset" value="${esc(g.hotkeyOffset)}">
      <label>Push-to-talk</label><input type="checkbox" data-g="ptt" ${g.ptt ? 'checked' : ''} style="justify-self:start">
      <span class="hint">Voice only listens while you hold the key below – nothing is tagged from people talking around you.</span>
      <label>Push-to-talk key</label><select data-g="pttKey">${Object.entries(PTT_KEYS).map(([k, v]) => `<option value="${k}" ${g.pttKey === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <label>Voice matching strictness</label><input type="range" min="0.55" max="0.95" step="0.01" data-g="strictness" value="${esc(g.strictness)}">
      <span class="hint">Current: <b id="strictVal">${Number(g.strictness).toFixed(2)}</b>. Lower = accepts more mis-heard words (but more wrong tags).</span>
      <label>Only listen for my words</label><input type="checkbox" data-g="useGrammar" ${g.useGrammar ? 'checked' : ''} style="justify-self:start">
      <span class="hint">Recommended – the engine only listens for your commands, much more accurate.</span>
      <label>Voice controls (undo / pause / play / rewind)</label><input type="checkbox" data-g="voiceControl" ${g.voiceControl ? 'checked' : ''} style="justify-self:start">
      <label>Beep when a tag is recorded</label><input type="checkbox" data-g="beep" ${g.beep ? 'checked' : ''} style="justify-self:start">
      <label>Ask for the location after each tag</label><input type="checkbox" data-g="askLocation" ${g.askLocation ? 'checked' : ''} style="justify-self:start">
      <label>Auto-fill Zone / Side from location</label><input type="checkbox" data-g="autoZone" ${g.autoZone ? 'checked' : ''} style="justify-self:start">
      <label>Drawing freeze time (seconds)</label><input type="number" step="0.5" min="0.5" max="20" data-g="freezeDur" value="${esc(g.freezeDur)}">
      <label>Title card length (seconds)</label><input type="number" step="0.5" min="0.5" max="10" data-g="titleDur" value="${esc(g.titleDur)}">
      <label>XML timeline rows</label><select data-g="xmlCode"><option value="code" ${g.xmlCode === 'code' ? 'selected' : ''}>One row per code</option><option value="player" ${g.xmlCode === 'player' ? 'selected' : ''}>One row per player</option><option value="both" ${g.xmlCode === 'both' ? 'selected' : ''}>Player + code</option></select>
      <label>Home team name</label><input data-g="homeName" value="${esc(g.homeName)}">
      <label>Opposition team name</label><input data-g="awayName" value="${esc(g.awayName)}">
    </div>`;
  }
}
$('#setBody').addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'vtTest' || t.id === 'tplPlayers') return;
  if (t.dataset.g) {
    const k = t.dataset.g;
    draft.general[k] = t.type === 'checkbox' ? t.checked : (t.type === 'number' || t.type === 'range') ? Number(t.value) : t.value;
    if (k === 'strictness') $('#strictVal').textContent = Number(t.value).toFixed(2);
    return;
  }
  if (t.dataset.gf) { draft.labelGroups[Number(t.closest('[data-group]').dataset.group)].name = t.value; return; }
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
  if (f === 'label0' || f === 'label1') {
    const ls = String(obj.labels || '').split(',').filter(Boolean); ls[f === 'label0' ? 0 : 1] = t.value;
    obj.labels = ls.filter(Boolean).join(','); return;
  }
  if (f === 'endLoc') { obj.endLoc = t.checked; return; }
  if (f === 'num') obj.num = t.value.trim() === '' ? '' : (isNaN(t.value) ? t.value.trim() : Number(t.value));
  else if (f === 'lead' || f === 'lag' || f === 'target') obj[f] = Number(t.value) || 0;
  else obj[f] = t.value;
  if (f === 'type' && kind === 'codes') { obj.lead = obj.type === 'duration' ? 2 : 5; obj.lag = obj.type === 'duration' ? 2 : 5; renderSettings(); }
});
$('#setBody').addEventListener('click', async e => {
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
  if (mv) { const tr = mv.closest('tr[data-kind]'); const arr = draft[tr.dataset.kind], i = Number(tr.dataset.i); if (i > 0) { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; renderSettings(); } return; }
  const dg = e.target.closest('[data-delgroup]');
  if (dg) { if (confirm('Delete this label group?')) { draft.labelGroups.splice(Number(dg.dataset.delgroup), 1); renderSettings(); } return; }
  const al = e.target.closest('[data-addlabel]');
  if (al) { draft.labelGroups[Number(al.dataset.addlabel)].labels.push({ id: uid(), name: 'New label', say: '', hotkey: '' }); renderSettings(); return; }
  if (e.target.closest('[data-act="importPlayers"]')) { closeSettings(); openImportPlayers(); return; }
  if (e.target.id === 'sayFromPos') { draft.players.forEach(p => { p.say = autoSay(Object.assign({}, p, { name: '' })); }); renderSettings(); return; }
  if (e.target.id === 'sayFromNum') { draft.players.forEach(p => { const w = numberWords(p.num); p.say = w ? (p.team === 'Away' ? 'opposition ' : 'player ') + w : p.say; }); renderSettings(); return; }
  if (e.target.id === 'sayFromName') { draft.players.forEach(p => { if (p.name) p.say = p.name.trim().split(/\s+/).pop().toLowerCase(); }); renderSettings(); return; }
  const tl = e.target.closest('[data-tload]');
  if (tl) {
    const k = tl.dataset.tload, tpl = k[0] === 'b' ? builtInTemplates()[Number(k.slice(1))] : userTemplates()[Number(k.slice(1))];
    if (tpl && confirm('Load template "' + tpl.name + '"? This replaces your codes, outcomes, labels, phrases and KPIs (after you press Save settings).')) {
      draft = applyTemplate(draft, tpl, $('#tplPlayers').checked); $('#confirmMsg').textContent = 'Template loaded – press Save settings to use it.'; setTab = 'codes';
      $$('#setTabs button').forEach(x => x.classList.toggle('active', x.dataset.st === 'codes')); renderSettings();
    }
    return;
  }
  const te = e.target.closest('[data-texp]');
  if (te) { const t = userTemplates()[Number(te.dataset.texp)]; if (t) api.saveFile({ defaultName: t.name + '.vttemplate', filters: [{ name: 'VoiceTag template', extensions: ['vttemplate'] }], data: JSON.stringify(Object.assign({ app: 'VoiceTag-template' }, t), null, 1) }); return; }
  const td = e.target.closest('[data-tdel]');
  if (td) { if (confirm('Delete this template?')) { const l = userTemplates(); l.splice(Number(td.dataset.tdel), 1); saveUserTemplates(l); renderSettings(); } return; }
  if (e.target.id === 'tplSave') {
    const name = await Dlg.ask('Save template', 'Template name (e.g. "U18 match", "Opposition – 4-4-2"):', '');
    if (name) { const l = userTemplates().filter(t => t.name !== name); l.push(templateFrom(draft, name, $('#tplPlayers') && $('#tplPlayers').checked)); saveUserTemplates(l); renderSettings(); toast('Template saved', 'info'); }
    return;
  }
  if (e.target.id === 'tplImport') {
    const f = await api.openTextFile({ filters: [{ name: 'VoiceTag template', extensions: ['vttemplate', 'json'] }] });
    if (!f) return;
    try { const t = JSON.parse(f.text); if (!Array.isArray(t.codes)) throw new Error('Not a template file'); delete t.app; const l = userTemplates().filter(x => x.name !== t.name); l.push(t); saveUserTemplates(l); renderSettings(); toast('Template imported', 'info'); }
    catch (err) { alert('Could not import: ' + err.message); }
    return;
  }
  const add = e.target.closest('[data-add]');
  if (add) {
    const k = add.dataset.add;
    if (k === 'players') draft.players.push({ id: uid(), team: 'Home', num: '', name: '', pos: '', say: '', hotkey: '' });
    if (k === 'opp') draft.players.push({ id: uid(), team: 'Away', num: '', name: '', pos: 'Opposition', say: '', hotkey: '' });
    if (k === 'codes' || k === 'phase') {
      const dur = k === 'phase';
      draft.codes.push({ id: uid(), name: dur ? 'New phase' : 'New code', type: dur ? 'duration' : 'instant', hotkey: '', say: '', outcomes: [], def: '', color: PALETTE[draft.codes.length % PALETTE.length], endLoc: false, lead: dur ? 2 : 5, lag: dur ? 2 : 5 });
    }
    if (k === 'outcomes') draft.outcomes.push({ id: uid(), name: 'New outcome', say: '', type: 'neu', hotkey: '' });
    if (k === 'group') draft.labelGroups.push({ id: uid(), name: 'New group', labels: [{ id: uid(), name: 'New label', say: '', hotkey: '' }] });
    if (k === 'phrase') draft.customPhrases.push({ id: uid(), phrase: '', playerId: '', codeId: '', outcomeId: '', labels: '' });
    if (k === 'kpi') draft.kpis.push({ id: uid(), name: 'New KPI', codeId: draft.codes[0] ? draft.codes[0].id : '', metric: 'count', cmp: '>=', target: 0, team: 'Home' });
    renderSettings();
    const b = $('#setBody'); b.scrollTop = b.scrollHeight;
  }
});
function findProblems(cfg) {
  const warn = [];
  const keys = new Map();
  const addKey = (k, what) => { k = String(k || '').trim().toUpperCase(); if (!k) return; if (RESERVED_KEYS.has(k)) warn.push(`Key "${k}" (${what}) is reserved for the video controls`); if (keys.has(k)) warn.push(`Key "${k}" is used by both ${keys.get(k)} and ${what}`); else keys.set(k, what); };
  cfg.codes.forEach(c => addKey(c.hotkey, c.name));
  cfg.outcomes.forEach(o => addKey(o.hotkey, o.name));
  cfg.players.forEach(p => addKey(p.hotkey, playerLabel(p)));
  cfg.labelGroups.forEach(g => g.labels.forEach(l => addKey(l.hotkey, g.name + ': ' + l.name)));
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
  check(cfg.codes, itemSay, c => c.name);
  cfg.customPhrases.forEach(cp => { if (!String(cp.phrase).trim()) warn.push('A voice phrase is empty – it will be ignored'); else if (!cp.codeId && !cp.playerId && !cp.outcomeId && !cp.labels) warn.push(`Phrase “${cp.phrase}” does nothing yet (choose a player, code, outcome or label)`); });
  return [...new Set(warn)];
}
$('#setSave').onclick = () => {
  draft.players = draft.players.filter(p => String(p.num).trim() !== '' || String(p.name).trim() || String(p.pos).trim());
  draft.codes = draft.codes.filter(c => String(c.name).trim());
  draft.outcomes = draft.outcomes.filter(o => String(o.name).trim());
  draft.labelGroups = draft.labelGroups.filter(g => String(g.name).trim()).map(g => (g.labels = g.labels.filter(l => String(l.name).trim()), g));
  draft.customPhrases = draft.customPhrases.filter(cp => String(cp.phrase).trim());
  const probs = findProblems(draft);
  if (probs.length && !confirm('Please check:\n\n' + probs.slice(0, 14).join('\n') + '\n\nSave anyway?')) return;
  config = migrate(draft); saveConfig(); VOC = buildVocab(config); closeSettings(); renderAll(); Voice.refreshVocabulary(); setMicUI(Voice.on ? 'on' : 'off');
  toast('Settings saved', 'info');
};
$('#setReset').onclick = () => {
  if (confirm('Reset ALL codes, players, outcomes, labels, phrases, KPIs and settings to the defaults? (Your tags are kept.)')) { draft = DEFAULT_CONFIG(); renderSettings(); $('#confirmMsg').textContent = 'Defaults loaded – click Save settings to apply.'; }
};
