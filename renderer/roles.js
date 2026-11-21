/* TACTIQ ANALYST – who is who on the pitch (3.1).
   The AI finds every person in the picture: 22 players, but also the referee, the two assistant referees on the
   touchlines, coaches, substitutes, ball boys and cameramen. With a pitch calibration we decide per track:
     player   – a team kit, standing inside the pitch
     gk       – a third kit that stays in / near one penalty area (becomes a player of the team defending that goal)
     ref      – the referee: a non-team kit moving freely inside the pitch
     ar       – an assistant referee: a non-team kit that stays on one touchline
     staff    – anybody who is mostly outside the pitch (coaches, subs, ball boys, cameramen)
     unknown  – inside the pitch, but neither a team kit nor clearly an official
   Only players (and the goalkeepers) are drawn as players in the video overlay, the 2D pitch and the 3D view. */
'use strict';

const ROLE_NAME = { player: 'Player', gk: 'Goalkeeper', ref: 'Referee', ar: 'Assistant referee', staff: 'Staff / off the pitch', unknown: 'Unknown person' };

// shirt colours: compare the hue part (r, g, b divided by their sum) – shade and floodlights change the brightness, not the hue
const kitChroma = c => { const s = Math.max(1, c[0] + c[1] + c[2]); return [c[0] / s, c[1] / s, c[2] / s]; };
const kitBright = c => (c[0] + c[1] + c[2]) / 3;
const kitDist = (a, b) => a && b ? Math.hypot(...kitChroma(a).map((v, i) => v - kitChroma(b)[i])) : 9;
// colour → 'A' | 'B' | null (null = not clearly one of the two team kits)
function kitTeam(c, cl, tight) {
  if (!c || !cl || cl.length < 2) return null;
  const d = [kitDist(c, cl[0]), kitDist(c, cl[1])], i = d[0] <= d[1] ? 0 : 1;
  const br = kitBright(c) / Math.max(1, kitBright(cl[i]));
  const lim = tight ? 0.045 : 0.065;
  return d[i] <= lim && d[i] < d[1 - i] * 0.5 && br >= (tight ? 0.7 : 0.62) && br <= 1.6 ? ['A', 'B'][i] : null;
}

// metres the pitch moves for 1 % of the picture height at an image point: far away (top of the picture) this is
// several metres, so the margins grow there – a calibration error of a few pixels is many metres on the far side
function pitchTolAt(c, x, y) {
  const a = applyH(c.H, x, y), b = applyH(c.H, x, Math.min(1, y + 0.01));
  return a && b ? Math.min(6, Math.hypot(a[0] - b[0], a[1] - b[1])) : 2;
}

// where one AI track (engine output: points in image coordinates) was on the calibrated pitch
function trackPlaces(tr) {
  const { L, W } = pitchDims();
  const s = { n: 0, inside: 0, off: 0, band: 0, deep: 0, boxL: 0, boxR: 0, goalD: 0, xs: 0, ys: 0, yMin: 1e9, yMax: -1e9, xMin: 1e9, xMax: -1e9, side: [0, 0] };
  const step = Math.max(1, Math.floor(tr.points.length / 60));
  for (let k = 0; k < tr.points.length; k += step) {
    const p = tr.points[k], c = calAt(p.t); if (!c) continue;
    const r = applyH(c.H, p.x, p.y); if (!r || (r[2] <= 0 && Math.sign(applyH(c.H, 0.5, 0.5)[2]) > 0)) continue;
    const x = r[0], y = r[1];
    if (!isFinite(x) || !isFinite(y) || Math.abs(x) > 1000 || Math.abs(y) > 1000) continue;
    const tol = 1.2 + 0.6 * pitchTolAt(c, p.x, p.y) + (c.err || 0) * 0.5;
    s.n++; s.xs += x; s.ys += y;
    s.yMin = Math.min(s.yMin, y); s.yMax = Math.max(s.yMax, y); s.xMin = Math.min(s.xMin, x); s.xMax = Math.max(s.xMax, x);
    const inside = x >= -tol && x <= L + tol && y >= -tol && y <= W + tol;
    if (inside) s.inside++; else s.off++;
    // touchline band: on or just outside a touchline (where the assistant referees run)
    const nearTop = y <= 1.5 + tol && y >= -9, nearBot = y >= W - 1.5 - tol && y <= W + 9;
    if ((nearTop || nearBot) && x >= -tol && x <= L + tol) { s.band++; s.side[nearTop ? 0 : 1]++; }
    if (y > 8 && y < W - 8) s.deep++;
    if (Math.abs(y - W / 2) <= 23 + tol) { if (x <= 20 + tol && x >= -tol) s.boxL++; else if (x >= L - 20 - tol && x <= L + tol) s.boxR++; }
    s.goalD += Math.min(Math.abs(x), Math.abs(L - x));
  }
  if (s.n) { s.mx = s.xs / s.n; s.my = s.ys / s.n; s.goalD /= s.n; }
  return s;
}

// decide the role of every track of an AI result. Needs the calibration (and the camera movement of the run).
function classifyAiTracks(res) {
  const cl = res.clusters || [], out = new Map(), minN = 3;
  const rows = res.tracks.map(tr => ({ tr, pl: trackPlaces(tr), kit: kitTeam(tr.colour, cl),
    dEng: tr.team === 'A' || tr.team === 'B' ? kitDist(tr.colour, cl[tr.team === 'A' ? 0 : 1]) : 9 }));
  const set = (r, role, team, why) => out.set(r.tr.id, { role, team: team || null, why, n: r.pl.n });
  const cands = [], touch = [], outside = [];
  rows.forEach(r => {
    const s = r.pl;
    // the engine's team is kept only when the shirt really has that team's colour (a dark or blue kit next to
    // the red team must not become a red player just because red was the nearer of the two)
    const team = ((r.tr.team === 'A' || r.tr.team === 'B') && r.dEng <= 0.085 ? r.tr.team : null) || r.kit;
    const sure = team && kitTeam(r.tr.colour, cl, true) === team;
    if (s.n < minN) { set(r, team ? 'player' : 'unknown', team, 'no pitch calibration for this track'); return; }
    if (s.off / s.n >= 0.6) { outside.push(r); return; }                                   // coaches, subs, cameramen …
    if (sure) { set(r, 'player', team, 'team kit inside the pitch'); return; }
    if (s.band / s.n >= 0.7 && s.deep / s.n <= 0.1) { touch.push(r); return; }             // on one touchline all the time
    if (team) { set(r, 'player', team, 'team kit (in shade) inside the pitch'); return; }
    cands.push(r);                                                                          // goalkeeper, referee or unknown
  });
  // the assistant referees wear the referee's kit: a person inside the pitch with the colour of somebody on the
  // touchline is the referee, never a goalkeeper
  const lineCols = touch.map(r => r.tr.colour);
  const officialKit = c => lineCols.some(a => kitDist(c, a) <= 0.11);
  // goalkeepers: at most one per goal – the one nearest the goal line among those who stay in that penalty area
  const gk = { L: null, R: null };
  cands.forEach(r => {
    const s = r.pl, side = s.boxL >= s.boxR ? 'L' : 'R';
    if (Math.max(s.boxL, s.boxR) / s.n < 0.6 || officialKit(r.tr.colour)) return;
    if (!gk[side] || s.goalD < gk[side].pl.goalD) gk[side] = r;
  });
  // the referee: of the rest, the one seen the longest (preferring the officials' kit)
  const rest = cands.filter(r => r !== gk.L && r !== gk.R);
  const ref = rest.slice().sort((a, b) => (officialKit(b.tr.colour) - officialKit(a.tr.colour)) || (b.pl.n - a.pl.n))[0];
  ['L', 'R'].forEach(side => { if (gk[side]) set(gk[side], 'gk', null, 'stays in the ' + (side === 'L' ? 'left' : 'right') + ' penalty area'); });
  if (ref) set(ref, 'ref', null, 'not a team kit, moving inside the pitch');
  const refCol = ref ? ref.tr.colour : null;
  const refKit = c => !!refCol && kitDist(c, refCol) <= 0.12;
  rest.forEach(r => { if (r !== ref) set(r, refKit(r.tr.colour) ? 'ref' : 'unknown', null, refKit(r.tr.colour) ? 'referee kit' : 'not a team kit and not an official'); });
  // on the touchline line itself all the time: an assistant referee (far away the kit colour is often spoilt by
  // the advertising boards, so the colour is not required). Outside the lines: an assistant referee only with the
  // referee's kit along one touchline – everybody else there is staff (coaches, substitutes, cameramen …)
  // one assistant referee per touchline: the referee's kit first, then somebody right on the line, then the one
  // seen the longest. Coaches in the technical area and cameramen are staff.
  const arPick = [null, null], oneSide = r => Math.max(r.pl.side[0], r.pl.side[1]) / r.pl.n;
  const score = r => (refKit(r.tr.colour) ? 4 : 0) + (touch.includes(r) ? 2 : 0) + r.pl.n / 1000;
  touch.concat(outside.filter(r => oneSide(r) >= 0.6 && (refKit(r.tr.colour) || r.pl.xMax - r.pl.xMin >= 4))).forEach(r => {
    const k = r.pl.side[0] >= r.pl.side[1] ? 0 : 1;
    if (!arPick[k] || score(r) > score(arPick[k])) arPick[k] = r;
  });
  touch.forEach(r => set(r, arPick.includes(r) ? 'ar' : 'staff', null, 'stays on the touchline'));
  outside.forEach(r => set(r, arPick.includes(r) ? 'ar' : 'staff', null, 'outside the pitch ' + Math.round(r.pl.off / r.pl.n * 100) + '% of the time'));
  return out;
}

// the team defending each goal at time range [a, b]: mean x of each team's players
function teamSideMeans(a, b) {
  const sum = { Home: [0, 0], Away: [0, 0] };
  TR.tracks.forEach(tk => {
    if (tk.kind !== 'player' || !sum[tk.team] || isKeeper(tk)) return;
    const pa = Math.max(a, tk.points.length ? tk.points[0].t : a), pb = Math.min(b, tk.points.length ? tk.points[tk.points.length - 1].t : b);
    for (let t = pa; t <= pb; t += 1) { const q = posAt(tk, t); if (!q || q.kind === 'status') continue; const m = toPitch(t, q.x, q.y); if (m) { sum[tk.team][0] += m[0]; sum[tk.team][1]++; } }
  });
  return { Home: sum.Home[1] ? sum.Home[0] / sum.Home[1] : null, Away: sum.Away[1] ? sum.Away[0] / sum.Away[1] : null };
}

// role of a track in the project (older projects have no role: derive it from kind / label)
function trackRole(tk) {
  if (tk.kind === 'ball') return 'ball';
  if (tk.kind === 'ref') return tk.role === 'ar' ? 'ar' : 'ref';
  if (tk.kind === 'other') return tk.role === 'staff' ? 'staff' : 'unknown';
  return isKeeper(tk) ? 'gk' : 'player';
}
// is the track drawn on the video / 2D / 3D? Players and the ball always; the referee as an official (setting);
// assistant referees, staff and unknown people only when asked for (or when selected in the Track tab)
function trackDrawn(tk, forExport) {
  if (tk.kind === 'player' || tk.kind === 'ball') return true;
  const r = trackRole(tk), s = TR.settings;
  if (!forExport && tk.id === TR.sel) return true;
  if (r === 'ref') return s.showRef !== false;
  return !!s.showOthers;
}

// the same decision for AI tracks already in the project (e.g. imported with 3.0, or after calibrating later).
// Tracks you identified (linked to a squad player) or typed by hand are left alone.
function sortOutRoles() {
  const med = a => { if (!a.length) return null; const s = [0, 1, 2].map(i => a.map(c => c[i]).sort((x, y) => x - y)); return s.map(v => v[v.length >> 1]); };
  const own = tk => tk.ai && tk.ai.colour && tk.kind !== 'ball' && !tk.playerId && !tk.ai.userKind;
  const list = TR.tracks.filter(own);
  if (!list.length) { toast('No AI tracks to sort out', 'info'); return; }
  if (!TR.cals.some(c => c.type !== 'none')) { toast('Calibrate the pitch first – who is who is decided by where people stand on the pitch', 'bad', 4500); return; }
  const cl = [med(list.filter(t => t.kind === 'player' && t.team === 'Home').map(t => t.ai.colour)), med(list.filter(t => t.kind === 'player' && t.team === 'Away').map(t => t.ai.colour))];
  if (!cl[0] || !cl[1]) { toast('Needs AI players of both teams', 'bad'); return; }
  const res = { clusters: cl, tracks: list.map(tk => ({ id: tk.id, colour: tk.ai.colour, team: tk.kind === 'player' && !isKeeper(tk) ? (tk.team === 'Home' ? 'A' : tk.team === 'Away' ? 'B' : 'other') : 'other',
    points: tk.points.filter(p => p.vis === 'v' && p.x != null) })).filter(t => t.points.length) };
  const roles = classifyAiTracks(res);
  checkpoint();
  const n = { player: 0, gk: 0, ref: 0, ar: 0, staff: 0, unknown: 0 }, changed = [];
  const gks = [];
  res.tracks.forEach(t => {
    const tk = TR.tracks.find(x => x.id === t.id), ro = roles.get(t.id); if (!tk || !ro) return;
    const before = trackRole(tk) + ':' + tk.team;
    n[ro.role]++;
    tk.ai.role = ro.role; tk.ai.why = ro.why;
    if (ro.role === 'player') { tk.kind = 'player'; tk.team = ro.team === 'A' ? 'Home' : 'Away'; tk.role = ''; if (/^(X\d+|Referee|AR|Staff|GK\??)$/.test(tk.label || '')) tk.label = ''; tk.color = ''; }
    else if (ro.role === 'gk') { tk.kind = 'other'; tk.role = 'gk'; tk.label = 'GK'; tk.team = 'Neutral'; gks.push(tk); }
    else if (ro.role === 'ref') { tk.kind = 'ref'; tk.role = ''; tk.label = 'Referee'; tk.team = 'Neutral'; tk.color = ''; }
    else if (ro.role === 'ar') { tk.kind = 'ref'; tk.role = 'ar'; tk.label = 'AR'; tk.team = 'Neutral'; tk.color = ''; }
    else { tk.kind = 'other'; tk.role = ro.role === 'staff' ? 'staff' : 'unknown'; tk.team = 'Neutral'; if (ro.role === 'staff') tk.label = 'Staff'; }
    if (trackRole(tk) + ':' + tk.team !== before) changed.push(tk);
  });
  // players that lost their label get the next free H/A number
  ['Home', 'Away'].forEach(team => {
    const used = new Set(TR.tracks.filter(x => x.team === team && x.label).map(x => x.label)); let k = 1;
    TR.tracks.filter(x => x.kind === 'player' && x.team === team && !x.label && !x.playerId).forEach(x => { const pre = team === 'Home' ? 'H' : 'A'; while (used.has(pre + k)) k++; x.label = pre + k; used.add(x.label); });
  });
  const span = TR.tracks.reduce((a, x) => x.points.length ? [Math.min(a[0], x.points[0].t), Math.max(a[1], x.points[x.points.length - 1].t)] : a, [1e9, -1e9]);
  const means = teamSideMeans(span[0], span[1]), { L } = pitchDims();
  gks.forEach(tk => {
    const s = trackPlaces({ points: tk.points.filter(p => p.vis === 'v' && p.x != null) }), left = s.n ? s.mx < L / 2 : null;
    if (left != null && means.Home != null && means.Away != null) { tk.kind = 'player'; tk.team = left === (means.Home < means.Away) ? 'Home' : 'Away'; tk.role = ''; tk.color = ''; tk.ai.gk = true; }
    else tk.label = 'GK?';
  });
  changed.forEach(tk => logCorrection(tk, tk.points.length ? tk.points[0].t : 0, 'assign', 'who is who: ' + trackRole(tk)));
  markDirty(); autosave(); renderTrackTab(); paintTracking(true); render2D(true);
  toast(`Who is who: ${n.player + n.gk} player tracks${n.gk ? ` (${n.gk} goalkeeper)` : ''}, ${n.ref ? 'referee' : 'no referee'}, ${n.ar} assistant referee(s), ${n.staff} outside the pitch${n.unknown ? `, ${n.unknown} unsure` : ''} – ${changed.length} changed (Ctrl+Z undoes)`, 'ok', 6000);
  return { n, changed: changed.length };
}
