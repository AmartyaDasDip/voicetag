/* =====================================================================================================
   3D TACTICAL VIEW (roadmap phase 0.9)
   A 3D pitch with the players and the ball, animated from the 2D tracking data (pitch positions in metres).
   It follows the video, or replays a time range on its own – any camera, any speed – and exports it as MP4.
   It is an approximate visualisation: player height, body orientation and ball height are not measured,
   and players that are not tracked (or outside the picture) are simply not shown.
   three.js (MIT licence) is loaded only when the 3D view is opened, so it costs nothing otherwise.
   ===================================================================================================== */
const V3 = {
  T: null, loading: null, failed: '', gl: null, scene: null, camera: null, geo: null,
  open: false, size: 'm', cam: 'broadcast', quality: 'auto', memGB: 16,
  opts: { labels: true, trails: false, shape: false, lines: false, events: true },
  mode: 'video', t: -1, replay: null, exporting: null,
  figs: new Map(), evFx: new Map(), labelTex: new Map(), pitchKey: '', dirty: true, raf: 0, lastNow: 0, lastRender: 0,
  cpos: null, ctgt: null, cfov: 40, follow: null, playRaw: null, ballPos: null, selPos: null, orbit: null,
  info: { shown: 0, total: 0, est: 0, msg: '' }, fps: { n: 0, ms: 0 }
};
const V3_CAMS = [['broadcast', 'TV camera – follows play'], ['ann', 'Annotations – frames them'], ['tactical', 'Tactical – whole pitch'], ['top', 'Top-down'], ['goalL', 'Behind the left goal'], ['goalR', 'Behind the right goal'], ['player', 'Player view – selected track'], ['free', 'Free – drag to turn']];
const V3_NOTE = 'Approximate 3D from 2D tracking – heights, body turn and ball height are not measured';

/* ---------------------------------------------------------------- loading */
async function v3Load() {
  if (V3.T) return true;
  if (!V3.loading) V3.loading = import('./vendor/three.min.js').then(m => { V3.T = m; }).catch(e => { V3.failed = 'The 3D library could not be loaded: ' + (e && e.message || e); });
  await V3.loading;
  return !!V3.T;
}
function v3Light() {
  if (V3.quality === 'light') return true;
  if (V3.quality === 'high') return false;
  return V3.memGB <= 10 || (navigator.hardwareConcurrency || 4) <= 2;
}
function v3Init() {
  const T = V3.T, cv = $('#p3canvas');
  let gl;
  try { gl = new T.WebGLRenderer({ canvas: cv, antialias: !v3Light(), powerPreference: 'high-performance' }); }
  catch (e) { V3.failed = '3D needs graphics acceleration (WebGL), which is not available on this PC: ' + (e && e.message || e); return false; }
  V3.gl = gl;
  gl.setPixelRatio(v3Light() ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  const sc = V3.scene = new T.Scene();
  sc.background = new T.Color('#0d1218'); sc.fog = new T.Fog('#0d1218', 170, 340);
  sc.add(new T.HemisphereLight(0xe4ecff, 0x1d3322, 1.6));
  const sun = new T.DirectionalLight(0xffffff, 1.3); sun.position.set(-40, 80, 50); sc.add(sun);
  V3.camera = new T.PerspectiveCamera(40, 16 / 9, 0.2, 700);
  V3.world = new T.Group(); V3.dyn = new T.Group(); V3.fx = new T.Group();
  sc.add(V3.world, V3.dyn, V3.fx);
  V3.geo = {
    body: new T.CylinderGeometry(0.3, 0.25, 1.5, 14), head: new T.SphereGeometry(0.2, 14, 10),
    ring: new T.RingGeometry(0.42, 0.56, 28), shadow: new T.CircleGeometry(0.55, 20), ball: new T.SphereGeometry(0.22, 18, 12),
    pulse: new T.RingGeometry(0.8, 1.05, 32)
  };
  V3.cpos = new T.Vector3(0, 25, 70); V3.ctgt = new T.Vector3(0, 0, 0); V3.follow = new T.Vector3(0, 0, 0);
  v3BuildPitch();
  v3WireCanvas(cv);
  new ResizeObserver(() => v3Resize()).observe($('#p3wrap'));
  v3Resize();
  return true;
}
function v3Resize() {
  if (!V3.gl || V3.exporting) return;
  const w = $('#p3wrap'), cw = Math.max(50, w.clientWidth), ch = Math.max(30, w.clientHeight);
  V3.gl.setSize(cw, ch, false);
  V3.camera.aspect = cw / ch; V3.camera.updateProjectionMatrix();
  const hud = $('#p3hud'), dpr = Math.min(window.devicePixelRatio || 1, 2); hud.width = cw * dpr; hud.height = ch * dpr;
  V3.dirty = true;
}

/* ---------------------------------------------------------------- pitch, goals, surroundings */
const v3W = (x, y) => { const { L, W } = pitchDims(); return [x - L / 2, y - W / 2]; };   // pitch metres → world x / z
function v3Dispose(o) {
  o.traverse(c => { if (c.geometry && !Object.values(V3.geo || {}).includes(c.geometry)) c.geometry.dispose(); if (c.material) [].concat(c.material).forEach(m => { if (m.map && !m.map.__shared) m.map.dispose(); m.dispose(); }); });
}
function v3BuildPitch() {
  const T = V3.T, { L, W } = pitchDims(), key = L + 'x' + W;
  if (V3.pitchKey === key) return;
  V3.pitchKey = key;
  while (V3.world.children.length) { const c = V3.world.children[0]; V3.world.remove(c); v3Dispose(c); }
  const M = 4, cw = 2048, ch = Math.round(cw * (W + 2 * M) / (L + 2 * M)), s = cw / (L + 2 * M);
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const x = cv.getContext('2d');
  x.fillStyle = '#2a7a3b'; x.fillRect(0, 0, cw, ch);
  const n = 18; for (let i = 0; i < n; i++) { x.fillStyle = i % 2 ? '#2f8844' : '#2a7c3c'; x.fillRect((M + L * i / n) * s, M * s, L / n * s + 1, W * s); }
  x.strokeStyle = 'rgba(255,255,255,.93)'; x.fillStyle = 'rgba(255,255,255,.93)'; x.lineWidth = Math.max(2, 0.12 * s); x.lineCap = 'round';
  pitchSegments(L, W).forEach(([a, b]) => { x.beginPath(); x.moveTo((a[0] + M) * s, (a[1] + M) * s); x.lineTo((b[0] + M) * s, (b[1] + M) * s); x.stroke(); });
  [[L / 2, W / 2], [11, W / 2], [L - 11, W / 2]].forEach(([px, py]) => { x.beginPath(); x.arc((px + M) * s, (py + M) * s, 0.22 * s, 0, Math.PI * 2); x.fill(); });
  [[0, 0, 0], [L, 0, Math.PI / 2], [L, W, Math.PI], [0, W, -Math.PI / 2]].forEach(([px, py, a]) => { x.beginPath(); x.arc((px + M) * s, (py + M) * s, 1 * s, a, a + Math.PI / 2); x.stroke(); });
  const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = Math.min(8, V3.gl.capabilities.getMaxAnisotropy());
  const pitch = new T.Mesh(new T.PlaneGeometry(L + 2 * M, W + 2 * M), new T.MeshLambertMaterial({ map: tex }));
  pitch.rotation.x = -Math.PI / 2; V3.world.add(pitch);
  const around = new T.Mesh(new T.PlaneGeometry(L + 80, W + 70), new T.MeshLambertMaterial({ color: '#1d3a27' }));
  around.rotation.x = -Math.PI / 2; around.position.y = -0.03; V3.world.add(around);
  // advertising boards and a low stand outline, only for orientation
  const board = new T.MeshLambertMaterial({ color: '#27313d', side: T.DoubleSide });
  const addBoard = (w, px, pz, ry) => { const b = new T.Mesh(new T.PlaneGeometry(w, 0.9), board); b.position.set(px, 0.45, pz); b.rotation.y = ry; V3.world.add(b); };
  addBoard(L + 10, 0, -W / 2 - 5, 0); addBoard(L + 10, 0, W / 2 + 5, 0); addBoard(W + 10, -L / 2 - 5, 0, Math.PI / 2); addBoard(W + 10, L / 2 + 5, 0, Math.PI / 2);
  // simple stands, so the camera direction is easy to read
  const stand = new T.MeshLambertMaterial({ color: '#2b3744', side: T.DoubleSide });
  const addStand = (w, px, pz, ry) => { const st = new T.Mesh(new T.PlaneGeometry(w, 26), stand); st.position.set(px, 7.5, pz); st.rotation.order = 'YXZ'; st.rotation.y = ry; st.rotation.x = -0.6; V3.world.add(st); };
  addStand(L + 30, 0, -W / 2 - 18, 0); addStand(L + 30, 0, W / 2 + 18, Math.PI); addStand(W + 30, -L / 2 - 18, 0, Math.PI / 2); addStand(W + 30, L / 2 + 18, 0, -Math.PI / 2);
  v3Goal(0, -1); v3Goal(L, 1);
}
function v3Goal(px, dir) {
  const T = V3.T, { W } = pitchDims(), [gx] = v3W(px, 0), post = new T.MeshLambertMaterial({ color: '#ffffff' });
  const g = new T.Group(); g.position.x = gx;
  const pg = new T.CylinderGeometry(0.06, 0.06, 2.44, 10);
  [-3.66, 3.66].forEach(z => { const p = new T.Mesh(pg, post); p.position.set(0, 1.22, z); g.add(p); });
  const bar = new T.Mesh(new T.CylinderGeometry(0.06, 0.06, 7.44, 10), post); bar.rotation.x = Math.PI / 2; bar.position.set(0, 2.44, 0); g.add(bar);
  const net = new T.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.16, side: T.DoubleSide, depthWrite: false });
  const d = 1.8, back = new T.Mesh(new T.PlaneGeometry(7.32, 2.0), net); back.rotation.y = Math.PI / 2; back.position.set(dir * d, 1.0, 0); g.add(back);
  const roof = new T.Mesh(new T.PlaneGeometry(d, 7.32), net); roof.rotation.x = -Math.PI / 2; roof.rotation.z = 0; roof.position.set(dir * d / 2, 2.3, 0); g.add(roof);
  [-3.66, 3.66].forEach(z => { const sd = new T.Mesh(new T.PlaneGeometry(d, 2.3), net); sd.position.set(dir * d / 2, 1.15, z); g.add(sd); });
  V3.world.add(g);
}

/* ---------------------------------------------------------------- players and ball */
function v3Shade(hex, f) {
  const c = new V3.T.Color(hex); const k = f > 0 ? f : 0;
  return new V3.T.Color(c.r + (1 - c.r) * k, c.g + (1 - c.g) * k, c.b + (1 - c.b) * k);
}
const v3Lum = hex => { const c = new V3.T.Color(hex); return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b; };
function v3LabelTex(text, col, sel) {
  const key = text + '|' + col + '|' + (sel ? 1 : 0);
  if (V3.labelTex.has(key)) return V3.labelTex.get(key);
  // drawn at twice the size it is shown, so names stay sharp when the camera comes close (3.2)
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const x = c.getContext('2d'), r = 28;
  x.fillStyle = col; x.strokeStyle = sel ? '#2ecc71' : 'rgba(0,0,0,.65)'; x.lineWidth = sel ? 16 : 8;
  x.beginPath(); x.moveTo(r + 8, 8); x.arcTo(248, 8, 248, 120, r); x.arcTo(248, 120, 8, 120, r); x.arcTo(8, 120, 8, 8, r); x.arcTo(8, 8, 248, 8, r); x.closePath(); x.fill(); x.stroke();
  x.fillStyle = v3Lum(col) > 0.6 ? '#111' : '#fff'; x.font = 'bold 80px Inter, Segoe UI, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, 128, 68);
  const t = new V3.T.CanvasTexture(c); t.colorSpace = V3.T.SRGBColorSpace; t.__shared = true; t.anisotropy = 4;
  V3.labelTex.set(key, t);
  return t;
}
function v3Fig(tk) {
  const T = V3.T, sel = tk.id === TR.sel, col = trackColor(tk), lab = tk.kind === 'ball' ? '' : trackShort(tk);
  const key = col + '|' + lab + '|' + tk.kind + '|' + sel;
  let f = V3.figs.get(tk.id);
  if (f && f.key === key) return f;
  if (f) { V3.dyn.remove(f.g); v3Dispose(f.g); }
  const g = new T.Group(), mats = []; g.userData.tkId = tk.id;
  const lam = c => { const m = new T.MeshLambertMaterial({ color: c, transparent: true }); mats.push(m); return m; };
  const shadow = new T.Mesh(V3.geo.shadow, new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.02; mats.push(shadow.material); g.add(shadow);
  f = { g, key, mats, tk, label: null, trail: null };
  if (tk.kind === 'ball') {
    const b = new T.Mesh(V3.geo.ball, lam(col === '#ffd23b' ? '#fff6c9' : col)); b.position.y = 0.22; g.add(b); shadow.scale.setScalar(0.42);
  } else {
    // officials: a black figure with a yellow ring and a yellow REF tag; other people grey
    const off = tk.kind === 'ref', other = tk.kind === 'other', bodyCol = off ? '#1b1b1b' : other ? '#8a8a8a' : col, tagCol = off ? '#f4d03f' : other ? '#9a9a9a' : col;
    const body = new T.Mesh(V3.geo.body, lam(bodyCol)); body.position.y = 0.95; if (off || other) body.scale.set(0.85, 0.94, 0.85); g.add(body);
    const head = new T.Mesh(V3.geo.head, lam(off ? '#f4d03f' : v3Shade(bodyCol, 0.45))); head.position.y = off || other ? 1.77 : 1.86; g.add(head);
    const ring = new T.Mesh(V3.geo.ring, new T.MeshBasicMaterial({ color: sel ? '#2ecc71' : tagCol, transparent: true, side: T.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; if (sel) ring.scale.setScalar(1.35); mats.push(ring.material); g.add(ring);
    if (lab) {
      const sm = new T.SpriteMaterial({ map: v3LabelTex(lab, tagCol, sel), depthTest: false, transparent: true });
      const sp = new T.Sprite(sm); sp.position.y = 2.6; sp.scale.set(1.3, 0.65, 1); sp.renderOrder = 10; mats.push(sm); g.add(sp); f.label = sp;
    }
  }
  V3.dyn.add(g); V3.figs.set(tk.id, f);
  return f;
}
function v3SetOpacity(f, o) { if (f.op === o) return; f.op = o; f.mats.forEach(m => { m.opacity = m.type === 'MeshBasicMaterial' && m.color && m.color.getHex() === 0 ? 0.32 * o : o; }); }
// pitch position of an image point with a known calibration (same rule as toPitch, without looking the calibration up again)
function v3ToPitch(c, x, y) {
  const r = applyH(c.H, x, y);
  if (!r || (r[2] <= 0 && Math.sign(applyH(c.H, 0.5, 0.5)[2]) > 0)) return null;
  const { L, W } = pitchDims();
  return r[0] < -8 || r[0] > L + 8 || r[1] < -8 || r[1] > W + 8 ? null : [r[0], r[1]];
}
const v3Shown = tk => tk.points.length && trackDrawn(tk);

/* ---------------------------------------------------------------- one moment */
function v3Update(t) {
  const T = V3.T, c = calAt(t), seen = new Set();
  let shown = 0, total = 0, est = 0, sx = 0, sz = 0, sn = 0;
  V3.ballPos = null; V3.selPos = null;
  const placed = [];
  TR.tracks.forEach(tk => {
    if (!v3Shown(tk)) return;
    if (tk.kind === 'player') { const a = tk.points[0].t, b = tk.points[tk.points.length - 1].t; if (t >= a - 0.5 && t <= b + 0.5) total++; }
    const p = posAt(tk, t); if (!p || p.kind === 'status' || !c) return;
    const m = v3ToPitch(c, p.x, p.y); if (!m) return;
    const f = v3Fig(tk), [wx, wz] = v3W(m[0], m[1]), e = isEstimate(p);
    f.g.position.set(wx, 0, wz); f.g.visible = !(V3.cam === 'player' && tk.id === TR.sel); seen.add(tk.id);
    v3SetOpacity(f, e ? 0.45 : 1);
    if (tk.kind === 'ball') { V3.ballPos = new T.Vector3(wx, 0, wz); return; }
    if (tk.kind === 'player') { shown++; if (e) est++; }
    if (tk.kind === 'player') { sx += wx; sz += wz; sn++; placed.push({ tk, m, e }); }
    if (tk.id === TR.sel) V3.selPos = new T.Vector3(wx, 0, wz);
  });
  V3.figs.forEach((f, id) => {
    if (!TR.tracks.includes(f.tk)) { V3.dyn.remove(f.g); v3Dispose(f.g); if (f.trail) { V3.fx.remove(f.trail); v3Dispose(f.trail); } V3.figs.delete(id); return; }
    if (!seen.has(id)) { f.g.visible = false; if (f.trail) f.trail.visible = false; }
  });
  V3.playRaw = V3.ballPos ? V3.ballPos.clone() : sn ? new T.Vector3(sx / sn, 0, sz / sn) : null;
  const sh = typeof shotAt === 'function' && (TR.shots || []).length ? shotAt(t) : null;
  V3.info = { shown, total, est, msg: c ? '' : sh && !trackableShot(sh) ? `${SHOT_TYPES[sh.type] ? SHOT_TYPES[sh.type][0] : sh.type} shot – no positions here` : TR.tracks.some(v3Shown) ? 'No pitch calibration at this moment – no positions' : 'No tracking yet – track players (manually or with 🤖 AI) and calibrate the pitch' };
  v3Trails(t, seen);
  v3Overlays(t, placed, c);
  v3Events(t);
  if (typeof v3Anns === 'function') v3Anns(t);
}
function v3Trails(t, seen) {
  const T = V3.T, on = V3.opts.trails, sec = Number(TR.settings.trail) || 6, step = 0.2, n = Math.round(sec / step) + 1;
  if (!on) { V3.figs.forEach(f => { if (f.trail) f.trail.visible = false; }); return; }
  const cals = []; for (let k = 0; k < n; k++) { const s = t - sec + k * step; cals.push([s, s >= 0 ? calAt(s) : null]); }
  V3.figs.forEach((f, id) => {
    if (!seen.has(id)) return;
    if (!f.trail) {
      const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.BufferAttribute(new Float32Array(n * 3 + 3), 3));
      f.trail = new T.Line(geo, new T.LineBasicMaterial({ color: trackColor(f.tk), transparent: true, opacity: 0.7 })); V3.fx.add(f.trail);
    }
    const a = f.trail.geometry.attributes.position, arr = a.array; let k2 = 0;
    for (const [s, c] of cals) {
      if (!c) continue;
      const p = posAt(f.tk, s); if (!p || p.kind === 'status') continue;
      const m = v3ToPitch(c, p.x, p.y); if (!m) continue;
      const [wx, wz] = v3W(m[0], m[1]); arr[k2 * 3] = wx; arr[k2 * 3 + 1] = 0.06; arr[k2 * 3 + 2] = wz; k2++;
      if (k2 * 3 + 3 > arr.length) break;
    }
    a.needsUpdate = true; f.trail.geometry.setDrawRange(0, k2); f.trail.geometry.computeBoundingSphere(); f.trail.visible = k2 > 1;
  });
}
// team outline and the three lines (defence, midfield, attack) of each team at this moment
function v3Overlays(t, placed, c) {
  const T = V3.T;
  while (V3.fx.userData.over && V3.fx.userData.over.length) { const o = V3.fx.userData.over.pop(); V3.fx.remove(o); v3Dispose(o); }
  V3.fx.userData.over = [];
  if (!c || (!V3.opts.shape && !V3.opts.lines)) return;
  ['Home', 'Away'].forEach(team => {
    const pts = placed.filter(q => q.tk.team === team && !(typeof isKeeper === 'function' && isKeeper(q.tk)) && !(q.tk.ai && q.tk.ai.gk)).map(q => ({ x: q.m[0], y: q.m[1] }));
    const o = typeof outfield === 'function' ? outfield(pts) : pts; if (o.length < 4) return;
    const col = teamColor(team);
    if (V3.opts.shape) {
      const hull = convexHull(o.map(p => [p.x, p.y])); if (hull.length < 3) return;
      const sh = new T.Shape(), [hx, hz] = v3W(hull[0][0], hull[0][1]);
      sh.moveTo(hx, -hz);
      hull.slice(1).forEach(([px, py]) => { const [wx, wz] = v3W(px, py); sh.lineTo(wx, -wz); });
      const mesh = new T.Mesh(new T.ShapeGeometry(sh), new T.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.2, side: T.DoubleSide, depthWrite: false }));
      mesh.rotation.x = -Math.PI / 2; mesh.position.y = 0.04; V3.fx.add(mesh); V3.fx.userData.over.push(mesh);
      const lp = hull.concat([hull[0]]).flatMap(([px, py]) => { const [wx, wz] = v3W(px, py); return [wx, 0.07, wz]; });
      const lg = new T.BufferGeometry(); lg.setAttribute('position', new T.BufferAttribute(new Float32Array(lp), 3));
      const line = new T.Line(lg, new T.LineBasicMaterial({ color: col })); V3.fx.add(line); V3.fx.userData.over.push(line);
    }
    if (V3.opts.lines) {
      const ls = threeLines(o.map(p => p.x)); if (!ls) return;
      const y0 = Math.min(...o.map(p => p.y)) - 2, y1 = Math.max(...o.map(p => p.y)) + 2;
      ls.forEach((lx, i) => {                      // a coloured band across the team's width: defence, midfield, attack
        const [ax, az] = v3W(lx, y0), [, bz] = v3W(lx, y1);
        const band = new T.Mesh(new T.PlaneGeometry(i === 0 ? 0.4 : 0.25, bz - az), new T.MeshBasicMaterial({ color: col, transparent: true, opacity: i === 0 ? 0.75 : 0.45, side: T.DoubleSide, depthWrite: false }));
        band.rotation.x = -Math.PI / 2; band.position.set(ax, 0.06, (az + bz) / 2); V3.fx.add(band); V3.fx.userData.over.push(band);
      });
    }
  });
}
// tagged events: a ring at their pitch location, a label, and an arc to the end point (pass, shot …)
function v3EventList(t, before, after) { return (typeof events !== 'undefined' ? events : []).filter(ev => ev.type !== 'duration' && ev.t >= t - before && ev.t <= t + after); }
function v3Events(t) {
  const T = V3.T, live = new Set(), { L, W } = pitchDims();
  if (V3.opts.events) v3EventList(t, 2.6, 0.15).filter(ev => ev.x != null).forEach(ev => {
    live.add(ev.id);
    let fx = V3.evFx.get(ev.id);
    const code = VOC.codesById[ev.codeId], col = (code && code.color) || '#ffd23b';
    if (!fx) {
      const g = new T.Group(), [wx, wz] = v3W(ev.x / 100 * L, ev.y / 100 * W);
      const ring = new T.Mesh(V3.geo.pulse, new T.MeshBasicMaterial({ color: col, transparent: true, side: T.DoubleSide, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(wx, 0.09, wz); g.add(ring);
      const sp = new T.Sprite(new T.SpriteMaterial({ map: v3LabelTex(v3EvText(ev, true), col, false), depthTest: false, transparent: true }));
      sp.position.set(wx, 3.6, wz); sp.scale.set(3.2, 1.6, 1); sp.renderOrder = 11; g.add(sp);
      let tube = null;
      if (ev.x2 != null) {
        const [ex, ez] = v3W(ev.x2 / 100 * L, ev.y2 / 100 * W), d = Math.hypot(ex - wx, ez - wz);
        const curve = new T.QuadraticBezierCurve3(new T.Vector3(wx, 0.15, wz), new T.Vector3((wx + ex) / 2, Math.min(7, 0.5 + d * 0.12), (wz + ez) / 2), new T.Vector3(ex, 0.15, ez));
        tube = new T.Mesh(new T.TubeGeometry(curve, 40, 0.09, 6, false), new T.MeshBasicMaterial({ color: col, transparent: true }));
        g.add(tube);
      }
      fx = { g, ring, sp, tube }; V3.fx.add(g); V3.evFx.set(ev.id, fx);
    }
    const age = t - ev.t, k = Math.max(0, Math.min(1, age / 0.8));
    fx.ring.scale.setScalar(0.6 + 1.4 * k); fx.ring.material.opacity = age < 0 ? 0.4 : Math.max(0, 1 - age / 2.6);
    fx.sp.material.opacity = Math.max(0, Math.min(1, 1.3 - age / 2.6 * 1.3));
    if (fx.tube) { const idx = fx.tube.geometry.index; fx.tube.geometry.setDrawRange(0, Math.max(0, Math.round(idx.count * Math.min(1, Math.max(0, age) / 0.8) / 36) * 36)); fx.tube.material.opacity = Math.max(0.25, 1 - Math.max(0, age - 1.2) / 1.4); }
  });
  V3.evFx.forEach((fx, id) => { if (!live.has(id)) { V3.fx.remove(fx.g); v3Dispose(fx.g); V3.evFx.delete(id); } });
}
function v3EvText(ev, short) {
  const ok = ev.success === true ? ' ✓' : ev.success === false ? ' ✗' : '';
  return short ? (ev.num !== '' && ev.num != null ? ev.num + ' ' : '') + (ev.code || '').slice(0, 10) + ok : `${ev.code || ''}${ok}${ev.num !== '' && ev.num != null ? ' – ' + ev.num : ''}${ev.name ? ' ' + ev.name : ''}`;
}

/* ---------------------------------------------------------------- cameras */
function v3Desired() {
  const { L, W } = pitchDims(), f = V3.follow;
  switch (V3.cam) {
    case 'ann': {      // frames the annotations of this moment from a raised side view (falls back to the TV camera)
      const b = typeof annWorldBox === 'function' ? annWorldBox(V3.t < 0 ? curT() : V3.t) : null;
      if (b) { const r = Math.min(60, b.r); return { pos: [b.cx - r * 0.25, 9 + r * 0.9, b.cz + 14 + r * 1.35], tgt: [b.cx, 0, b.cz], fov: 42 }; }
      const tx = Math.max(-L / 2 + 14, Math.min(L / 2 - 14, f.x)); return { pos: [tx * 0.82, 17, W / 2 + 21], tgt: [tx, 0, Math.max(-10, Math.min(10, f.z * 0.55)) + 1], fov: 36 };
    }
    case 'tactical': return { pos: [0, 60, W / 2 + 44], tgt: [0, 0, -1], fov: 44 };
    case 'top': return { pos: [0, 100, 0.5], tgt: [0, 0, 0], fov: 44 };
    case 'goalL': return { pos: [-L / 2 - 17, 12, f.z * 0.3], tgt: [-L / 2 + 34, 0, f.z * 0.5], fov: 50 };
    case 'goalR': return { pos: [L / 2 + 17, 12, f.z * 0.3], tgt: [L / 2 - 34, 0, f.z * 0.5], fov: 50 };
    case 'player': {
      const p = V3.selPos;
      if (p) {
        const look = V3.ballPos || V3.playRaw || new V3.T.Vector3(0, 0, 0);
        let dx = look.x - p.x, dz = look.z - p.z; const d = Math.hypot(dx, dz);
        if (d < 1.5) { dx = p.x < 0 ? 1 : -1; dz = 0; } else { dx /= d; dz /= d; }
        return { pos: [p.x - dx * 0.4, 1.75, p.z - dz * 0.4], tgt: [p.x + dx * 20, 0.9, p.z + dz * 20], fov: 62 };
      }
    } // falls through to the TV camera when no track is selected
    default: { const tx = Math.max(-L / 2 + 14, Math.min(L / 2 - 14, f.x)); return { pos: [tx * 0.82, 17, W / 2 + 21], tgt: [tx, 0, Math.max(-10, Math.min(10, f.z * 0.55)) + 1], fov: 36 }; }
  }
}
function v3CamStep(dt, snap) {
  const T = V3.T, cam = V3.camera;
  if (V3.playRaw) { const a = snap ? 1 : 1 - Math.exp(-dt * 2.2); V3.follow.lerp(V3.playRaw, a); }
  let pos, tgt, fov;
  if (V3.cam === 'free' && V3.orbit) {
    const o = V3.orbit; tgt = o.tgt.clone();
    pos = new T.Vector3(tgt.x + o.r * Math.cos(o.phi) * Math.sin(o.theta), tgt.y + o.r * Math.sin(o.phi), tgt.z + o.r * Math.cos(o.phi) * Math.cos(o.theta));
    fov = V3.cfov; snap = true;
  } else { const d = v3Desired(); pos = new T.Vector3(...d.pos); tgt = new T.Vector3(...d.tgt); fov = d.fov; }
  const k = V3.cam === 'player' ? 5 : 3.2, a = snap ? 1 : 1 - Math.exp(-dt * k);
  const before = V3.cpos.distanceTo(pos) + V3.ctgt.distanceTo(tgt) + Math.abs(V3.cfov - fov);
  V3.cpos.lerp(pos, a); V3.ctgt.lerp(tgt, a); V3.cfov += (fov - V3.cfov) * a;
  cam.position.copy(V3.cpos); cam.fov = V3.cfov; cam.updateProjectionMatrix(); cam.lookAt(V3.ctgt);
  return before > 0.03;                      // still moving → keep rendering
}
function v3SetCam(name, keepView) {
  V3.cam = name;
  if (name === 'free') {
    const T = V3.T, d = V3.cpos.clone().sub(V3.ctgt), r = Math.max(4, d.length());
    V3.orbit = { tgt: V3.ctgt.clone(), r, phi: Math.asin(Math.max(-1, Math.min(1, d.y / r))), theta: Math.atan2(d.x, d.z) };
    if (!keepView) { V3.orbit.tgt = new T.Vector3(0, 0, 0); V3.orbit.r = 95; V3.orbit.phi = 0.62; V3.orbit.theta = 0; }
  }
  const s = $('#p3cam'); if (s && s.value !== name) s.value = name;
  if (name === 'player' && !TR.sel) toast('Select a track first (Track tab or click it) – showing the TV camera', 'bad', 3200);
  V3.dirty = true;
}
function v3WireCanvas(cv) {
  // a short click selects a player or an annotation, a drag turns / moves the camera, a double-click centres there;
  // with the annotation bar open, clicks pick players and a drag draws a zone on the grass (annotate3d.js)
  let drag = null;
  const ann = (type, e) => typeof annotate3dPointer === 'function' && annotate3dPointer(type, e, cv);
  cv.addEventListener('pointerdown', e => {
    if (V3.exporting) return;
    cv.setPointerCapture(e.pointerId);
    if (ann('down', e)) { drag = { ann: true }; return; }
    drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, pan: e.button === 2 || e.shiftKey, button: e.button, moved: false };
  });
  cv.addEventListener('pointermove', e => {
    if (!drag) { ann('move', e); return; }
    if (drag.ann) { ann('drag', e); return; }
    if (!drag.moved) { if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return; drag.moved = true; if (V3.cam !== 'free') v3SetCam('free', true); cv.style.cursor = 'grabbing'; }
    if (!V3.orbit) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y, o = V3.orbit; drag.x = e.clientX; drag.y = e.clientY;
    if (drag.pan) {
      const s = o.r * 0.0016, rx = Math.cos(o.theta), rz = -Math.sin(o.theta), fx = -Math.sin(o.theta), fz = -Math.cos(o.theta);
      o.tgt.x += (-dx * rx + dy * fx) * s; o.tgt.z += (-dx * rz + dy * fz) * s;
    } else { o.theta -= dx * 0.006; o.phi = Math.max(0.06, Math.min(1.53, o.phi + dy * 0.005)); }
    V3.dirty = true;
  });
  const end = e => {
    const d = drag; drag = null; cv.style.cursor = '';
    if (!d) return;
    if (d.ann) { ann('up', e); return; }
    if (!d.moved && d.button === 0) ann('click', e);
  };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', () => { drag = null; });
  cv.addEventListener('pointerleave', () => { if (typeof A3 !== 'undefined' && A3.hover) { A3.hover = null; V3.dirty = true; } });
  cv.addEventListener('dblclick', e => {
    if (V3.exporting || typeof a3Ray !== 'function') return;
    const g = a3Ground(a3Ray(e, cv)); if (!g) return;
    if (V3.cam !== 'free') v3SetCam('free', true);
    V3.orbit.tgt.set(g.x, 0, g.z); V3.orbit.r = Math.min(V3.orbit.r, 38); V3.dirty = true;
  });
  cv.addEventListener('wheel', e => { e.preventDefault(); if (V3.exporting) return; if (V3.cam !== 'free') v3SetCam('free', true); V3.orbit.r = Math.max(4, Math.min(230, V3.orbit.r * Math.pow(1.0012, e.deltaY))); V3.dirty = true; }, { passive: false });
  cv.addEventListener('contextmenu', e => e.preventDefault());
}

/* ---------------------------------------------------------------- drawing */
function v3Render() {
  const cam = V3.camera;
  V3.figs.forEach(f => { if (f.label && f.g.visible) { const d = cam.position.distanceTo(f.g.position), s = Math.max(1, Math.min(4, d / 26)); f.label.scale.set(1.5 * s, 0.75 * s, 1); f.label.position.y = 2.2 + 0.42 * s; f.label.visible = V3.opts.labels; } });
  V3.evFx.forEach(fx => { const d = cam.position.distanceTo(fx.sp.position), s = Math.max(1, Math.min(3, d / 40)); fx.sp.scale.set(3.2 * s, 1.6 * s, 1); });
  const t0 = performance.now();
  V3.gl.render(V3.scene, cam);
  V3.fps.n++; V3.fps.ms += performance.now() - t0;
}
// time, match clock, recent tags, messages – drawn on a 2D canvas over the 3D (and into exported frames)
function v3DrawHud(x, w, h, t, forExport) {
  const fs = Math.max(11, Math.round(h / 34)), pad = Math.round(fs * 0.7);
  x.save(); x.textBaseline = 'top'; x.font = `600 ${fs}px Inter, Segoe UI, sans-serif`;
  const box = (tx, bx, by, align, bg = 'rgba(10,14,20,.72)', fg = '#fff') => {
    const tw = x.measureText(tx).width, bw = tw + pad * 1.4, bh = fs * 1.55, X = align === 'right' ? bx - bw : bx;
    x.fillStyle = bg; x.fillRect(X, by, bw, bh); x.fillStyle = fg; x.fillText(tx, X + pad * 0.7, by + fs * 0.28); return bh;
  };
  const mc = matchClock(t);
  let y = pad;
  if (forExport) { const ti = `${config.general.homeName || 'Home'} v ${config.general.awayName || 'Away'}`; y += box(ti, pad, y) + 4; }
  box(`${mc ? mc + '  ·  ' : ''}video ${fmtTime(t)}${V3.mode === 'replay' && V3.replay && V3.replay.speed !== 1 ? '  ·  ' + V3.replay.speed + '×' : ''}`, pad, y);
  let ry = pad;
  v3EventList(t, 2.6, 0.05).slice(-4).forEach(ev => { const code = VOC.codesById[ev.codeId]; x.fillStyle = (code && code.color) || '#ffd23b'; const tx = v3EvText(ev, false), tw = x.measureText(tx).width; x.fillRect(w - pad - tw - pad * 1.4 - 6, ry, 6, fs * 1.55); ry += box(tx, w - pad, ry, 'right') + 4; });
  if (V3.info.msg) { x.font = `600 ${Math.round(fs * 1.1)}px Inter, Segoe UI, sans-serif`; const tw = x.measureText(V3.info.msg).width; x.fillStyle = 'rgba(10,14,20,.8)'; x.fillRect((w - tw) / 2 - pad, h / 2 - fs, tw + pad * 2, fs * 2.2); x.fillStyle = '#ffd36b'; x.fillText(V3.info.msg, (w - tw) / 2, h / 2 - fs * 0.45); }
  x.font = `${Math.round(fs * 0.72)}px Inter, Segoe UI, sans-serif`; x.textBaseline = 'bottom'; x.fillStyle = 'rgba(255,255,255,.72)';
  x.fillText((forExport ? 'TACTIQ ANALYST · ' : '') + V3_NOTE, pad, h - pad * 0.6);
  x.restore();
}
function v3PaintHud() {
  const c = $('#p3hud'), x = c.getContext('2d'); x.clearRect(0, 0, c.width, c.height);
  v3DrawHud(x, c.width, c.height, V3.t, false);
  if (typeof annotate3dHud === 'function') annotate3dHud(x, c.width, c.height);
  const i = V3.info;
  $('#p3info').textContent = `${i.shown}/${i.total} players placed${i.est ? ` (${i.est} estimated – faded)` : ''} · ${fmtTime(V3.t)}${V3.mode === 'replay' ? ' · replay' : ''}`;
}

/* ---------------------------------------------------------------- loop */
function v3Loop(now) {
  if (!V3.open) { V3.raf = 0; return; }
  V3.raf = requestAnimationFrame(v3Loop);
  if (V3.exporting) return;
  if (v3Light() && now - V3.lastRender < 31) return;                     // 30 frames a second is plenty on a light PC
  const dt = Math.min(0.1, (now - (V3.lastNow || now)) / 1000); V3.lastNow = now;
  let t;
  if (V3.mode === 'replay' && V3.replay) {
    const r = V3.replay;
    if (r.playing) { r.t += dt * r.speed; if (r.t >= r.t1) { if (r.loop) r.t = r.t0; else { r.t = r.t1; r.playing = false; } } v3ReplayUi(); }
    t = r.t;
  } else t = curT();
  // annotations keep moving even when the video stands still – at most 30 frames a second for that alone
  const changed = V3.dirty || (V3.annAnim && now - V3.lastRender >= 33) || Math.abs(t - V3.t) > 1e-4;
  if (changed) { V3.t = t; v3Update(t); }
  const moving = v3CamStep(dt, false);
  if (changed || moving) { v3Render(); V3.lastRender = now; }
  if (changed) v3PaintHud();
  V3.dirty = false;
}
function v3Tick() { V3.dirty = true; }

/* ---------------------------------------------------------------- open / close */
async function v3Open() {
  const box = $('#p3d');
  box.classList.remove('hidden'); V3.open = true;
  if (!V3.gl && !V3.failed) {
    $('#p3msg').textContent = 'Loading 3D …'; $('#p3msg').classList.remove('hidden');
    try { const si = await api.systemInfo(); if (si && si.ramGB) V3.memGB = si.ramGB; } catch (e) { /* browser preview */ }
    if (await v3Load()) v3Init();
  }
  if (V3.failed) { $('#p3msg').textContent = V3.failed; $('#p3msg').classList.remove('hidden'); return false; }
  $('#p3msg').classList.add('hidden');
  v3BuildPitch(); v3Resize();
  V3.t = -1; V3.dirty = true;
  if (V3.mode === 'video') { v3Update(curT()); v3CamStep(0, true); }
  if (!V3.raf) V3.raf = requestAnimationFrame(v3Loop);
  return true;
}
function v3Close() {
  V3.open = false; $('#p3d').classList.add('hidden');
  if (V3.mode === 'replay') v3EndReplay(false);
}
function v3SetSize(s) { const b = $('#p3d'); b.classList.remove('s', 'm', 'l', 'full'); b.classList.add(s); V3.size = s; setTimeout(v3Resize, 30); }

/* ---------------------------------------------------------------- replay of a time range */
function v3StartReplay(o) {
  if (hasVideo() && !video.paused) video.pause();
  V3.mode = 'replay';
  V3.replay = { t0: o.t0, t1: o.t1, t: o.t0, speed: o.speed || 1, playing: o.play !== false, loop: !!o.loop };
  if (o.cam) v3SetCam(o.cam);
  $('#p3replay').classList.remove('hidden');
  const sl = $('#p3rSlider'); sl.min = o.t0; sl.max = o.t1; sl.step = 0.04; $('#p3rSpeed').value = String(V3.replay.speed);
  v3Update(o.t0); v3CamStep(0, true); V3.t = o.t0; v3Render(); v3PaintHud(); v3ReplayUi();
}
function v3ReplayUi() {
  const r = V3.replay; if (!r) return;
  $('#p3rPlay').textContent = r.playing ? '⏸' : '▶';
  $('#p3rSlider').value = r.t;
  $('#p3rTime').textContent = `${fmtTime(r.t)} / ${fmtTime(r.t1)}`;
}
function v3EndReplay(seekVideo) {
  const r = V3.replay;
  V3.mode = 'video'; V3.replay = null; $('#p3replay').classList.add('hidden');
  if (seekVideo && r && hasVideo()) video.currentTime = r.t;
  V3.dirty = true;
}
const v3ParseTime = s => { s = String(s || '').trim(); if (!s) return NaN; const p = s.split(':').map(Number); return p.some(isNaN) ? NaN : p.length === 1 ? p[0] : p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2]; };
function v3RangeFromTag(ev) {
  if (!ev) return null;
  const a = ev.type === 'duration' ? ev.start : Math.min(ev.start, ev.t), b = ev.type === 'duration' ? ev.end : Math.max(ev.end, ev.t);
  return [Math.max(0, a - 1), b + 1];
}
async function v3ReplayDialog(preset) {
  const tg = currentTarget(), ev = tg && tg.kind === 'event' ? tg.ref : null, now = curT();
  const span = typeof trackedSpan === 'function' ? trackedSpan() : null;
  const tagRange = preset || v3RangeFromTag(ev);
  const def = tagRange ? 'tag' : 'last';
  const html = `<p class="muted">Plays a part of the match in 3D from the tracking data – from any camera and at any speed – and can save it as an MP4 video. ${esc(V3_NOTE)}.</p>
    <div class="grid2">
      <label class="blk"><input type="radio" name="v3r" value="tag" ${def === 'tag' ? 'checked' : ''} ${tagRange ? '' : 'disabled'}> ${tagRange ? `${preset ? 'This tag' : 'Selected tag'}${ev && !preset ? ` (${esc(ev.code)} at ${fmtTime(ev.t)})` : ''}: ${fmtTime(tagRange[0])}–${fmtTime(tagRange[1])}` : 'Selected tag (select a tag first)'}</label>
      <label class="blk"><input type="radio" name="v3r" value="last" ${def === 'last' ? 'checked' : ''}> The <input id="v3rLast" type="number" min="2" max="600" value="10" style="width:60px"> seconds up to ${fmtTime(now)}</label>
      <label class="blk"><input type="radio" name="v3r" value="custom"> From <input id="v3rFrom" value="${fmtTime(Math.max(0, now - 10))}" style="width:70px"> to <input id="v3rTo" value="${fmtTime(now)}" style="width:70px"></label>
      ${span ? `<label class="blk"><input type="radio" name="v3r" value="all"> All tracked time (${fmtTime(span[0])}–${fmtTime(span[1])})</label>` : ''}
    </div>
    <div class="grid2" style="margin-top:8px">
      <label class="blk">Camera <select id="v3rCam">${V3_CAMS.map(([k, n]) => `<option value="${k}" ${k === (V3.cam === 'free' ? 'broadcast' : V3.cam) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="blk">Speed <select id="v3rSpeedD"><option value="0.25">¼× (slow motion)</option><option value="0.5">½×</option><option value="1" selected>1× (real time)</option><option value="2">2×</option></select></label>
      <label class="blk">Video size <select id="v3rRes"><option value="1280x720">1280 × 720</option><option value="1920x1080">1920 × 1080</option></select></label>
      <label class="blk">Frames a second <select id="v3rFps"><option value="25">25</option><option value="30" selected>30</option></select></label>
    </div>
    <div class="small muted" style="margin-top:6px">Shown in the video as in the 3D window now: names ${V3.opts.labels ? 'on' : 'off'}, trails ${V3.opts.trails ? 'on' : 'off'}, team shape ${V3.opts.shape ? 'on' : 'off'}, lines ${V3.opts.lines ? 'on' : 'off'}, tags ${V3.opts.events ? 'on' : 'off'}.</div>`;
  let choice = null;
  const read = () => {
    const r = ($('input[name=v3r]:checked') || {}).value;
    let rg = r === 'tag' ? tagRange : r === 'last' ? [Math.max(0, now - (Number($('#v3rLast').value) || 10)), now] : r === 'all' ? span : [v3ParseTime($('#v3rFrom').value), v3ParseTime($('#v3rTo').value)];
    if (!rg || !(rg[1] > rg[0]) || isNaN(rg[0])) { toast('Choose a time range (from must be before to)', 'bad'); return false; }
    const [w, h] = $('#v3rRes').value.split('x').map(Number);
    choice = { t0: rg[0], t1: rg[1], cam: $('#v3rCam').value, speed: Number($('#v3rSpeedD').value), w, h, fps: Number($('#v3rFps').value) };
    return true;
  };
  const r = await Dlg.open('🎬 3D replay', html, [{ label: 'Cancel' }, { label: '🎬 Save as MP4 video', value: 'export', onClick: read }, { label: '▶ Play in 3D', primary: true, value: 'play', onClick: read }]);
  if (!r || !choice) return null;
  if (!V3.open && !(await v3Open())) return null;
  if (r === 'play') v3StartReplay(choice);
  else await v3Export(choice);
  return choice;
}

/* ---------------------------------------------------------------- pictures and video */
function v3Frame(w, h, t, dt, snap) {
  const gl = V3.gl;
  gl.setPixelRatio(1); gl.setSize(w, h, false); V3.camera.aspect = w / h;
  v3Update(t); v3CamStep(dt, snap); V3.t = t; v3Render();
  const c2 = V3.comp || (V3.comp = document.createElement('canvas'));
  if (c2.width !== w || c2.height !== h) { c2.width = w; c2.height = h; }
  const x = c2.getContext('2d'); x.drawImage(gl.domElement, 0, 0, w, h);
  v3DrawHud(x, w, h, t, true);
  return c2;
}
function v3Restore() { V3.gl.setPixelRatio(v3Light() ? 1 : Math.min(window.devicePixelRatio || 1, 2)); v3Resize(); V3.dirty = true; }
async function v3Snapshot() {
  if (!V3.gl) return null;
  const c = v3Frame(1920, 1080, V3.t < 0 ? curT() : V3.t, 0, false), data = c.toDataURL('image/png');
  v3Restore();
  const name = `${(project.info && project.info.name) || 'match'} 3D ${fmtTime(V3.t).replace(':', '-')}.png`.replace(/[\\/:*?"<>|]/g, '');
  if (project.dir && api.writeBinary) { const f = await api.writeBinary({ file: project.dir + '/screenshots/' + name, base64: data.split(',')[1] }); toast('📷 Saved to screenshots: ' + name, 'ok'); return f; }
  const bin = Uint8Array.from(atob(data.split(',')[1]), ch => ch.charCodeAt(0));
  const p = await api.saveFile({ defaultName: name, filters: [{ name: 'PNG image', extensions: ['png'] }], data: bin, encoding: 'binary' });
  if (p) toast('📷 3D picture saved', 'ok');
  return p;
}
async function v3Export(o) {
  if (!api.v3dBegin) { toast('Saving 3D video works in the installed desktop app', 'bad'); return null; }
  const base = `${(project.info && project.info.name) || 'match'} 3D ${fmtTime(o.t0).replace(':', '-')}-${fmtTime(o.t1).replace(':', '-')}.mp4`.replace(/[\\/:*?"<>|]/g, '');
  const b = await api.v3dBegin({ defaultName: project.dir ? project.dir + '/clips/' + base : base, fps: o.fps, w: o.w, h: o.h });
  if (!b || !b.ok) { if (b && b.error) toast('Could not start the video: ' + b.error, 'bad', 5000); return null; }
  if (V3.mode === 'replay') v3EndReplay(false);
  const prevCam = V3.cam; if (o.cam) v3SetCam(o.cam);
  const n = Math.max(1, Math.ceil((o.t1 - o.t0) / o.speed * o.fps)), job = V3.exporting = { cancel: false, done: 0, n };
  const ov = $('#p3export'); ov.classList.remove('hidden');
  $('#p3expCancel').onclick = () => { job.cancel = true; };
  let res = null;
  try {
    for (let k = 0; k <= n && !job.cancel; k++) {
      const t = Math.min(o.t1, o.t0 + k * o.speed / o.fps);
      const c = v3Frame(o.w, o.h, t, 1 / o.fps, k === 0);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
      const ok = await api.v3dFrame(new Uint8Array(await blob.arrayBuffer()));
      if (!ok) { job.cancel = true; break; }
      job.done = k + 1;
      if (k % 5 === 0) $('#p3expTxt').textContent = `Saving 3D video … ${Math.round(k / n * 100)}% (${k}/${n} frames)`;
    }
    res = await api.v3dEnd({ cancel: job.cancel });
  } catch (e) { res = await api.v3dEnd({ cancel: true }); res = { ok: false, error: String(e && e.message || e) }; }
  V3.exporting = null; ov.classList.add('hidden'); v3SetCam(prevCam); v3Restore();
  if (res && res.ok) {
    toast('🎬 3D video saved: ' + res.file.split(/[\\/]/).pop(), 'ok', 4000);
    if (api.showInFolder && project.dir && res.file.startsWith(project.dir)) { /* it is in the project's clips folder */ }
  } else if (res && res.cancelled) toast('3D video cancelled', 'bad');
  else toast('3D video failed: ' + (res && res.error || 'unknown error'), 'bad', 6000);
  return res;
}

/* ---------------------------------------------------------------- wiring */
(function v3Wire() {
  const sel = $('#p3cam'); sel.innerHTML = V3_CAMS.map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
  sel.onchange = () => v3SetCam(sel.value, false);
  $('#btn3D').onclick = () => { if (V3.open) v3Close(); else v3Open(); };
  $('#p3close').onclick = v3Close;
  $('#p3size').onchange = e => v3SetSize(e.target.value);
  ['labels', 'trails', 'shape', 'lines', 'events'].forEach(k => { const c = $('#p3o_' + k); c.checked = V3.opts[k]; c.onchange = () => { V3.opts[k] = c.checked; V3.dirty = true; }; });
  $('#p3quality').onchange = e => { V3.quality = e.target.value; if (V3.gl) { V3.gl.setPixelRatio(v3Light() ? 1 : Math.min(window.devicePixelRatio || 1, 2)); v3Resize(); } };
  $('#p3replayBtn').onclick = () => v3ReplayDialog();
  $('#p3shot').onclick = v3Snapshot;
  $('#p3rPlay').onclick = () => { const r = V3.replay; if (!r) return; if (!r.playing && r.t >= r.t1 - 0.01) r.t = r.t0; r.playing = !r.playing; V3.lastNow = performance.now(); v3ReplayUi(); };
  $('#p3rSlider').oninput = e => { const r = V3.replay; if (!r) return; r.t = Number(e.target.value); r.playing = false; V3.dirty = true; v3ReplayUi(); };
  $('#p3rSpeed').onchange = e => { if (V3.replay) V3.replay.speed = Number(e.target.value); V3.dirty = true; };
  $('#p3rLoop').onchange = e => { if (V3.replay) V3.replay.loop = e.target.checked; };
  $('#p3rBack').onclick = () => v3EndReplay(true);
  // redraw when tracks, tags or calibrations change, or a track is selected
  HOOKS.render.push(() => { if (V3.open) V3.dirty = true; });
  HOOKS.key.push(e => {
    if (!V3.open || V3.mode !== 'replay' || e.ctrlKey || e.metaKey) return false;
    if (e.code === 'Space') { $('#p3rPlay').click(); e.preventDefault(); return true; }
    if (e.key === 'Escape') { v3EndReplay(true); return true; }
    return false;
  });
})();
