/* TACTIQ ANALYST – annotations in the 3D view (3.2).
   Each annotation becomes a small set of 3D objects that are built once and then only moved and animated every frame:
   spotlight = light cone, pool of light, turning ring, ripples, a bobbing marker, and the player lit up;
   distance = an arc of light between two players with flowing dashes and the metres at its top;
   line / back line = a light wall standing on the line, ground rings and the gaps in metres;
   run = an arrow of moving chevrons on the grass to where the player arrives; zone = a lit floor with moving stripes,
   glowing edges and low light walls; offside line = a bright line across the pitch with a light curtain.
   Labels keep the same size on screen at any distance. Players and annotations can be clicked in 3D (annotate3dPointer). */
'use strict';

const A3 = { objs: new Map(), tex: null, hl: new Map(), hover: null };

/* ---------------------------------------------------------------- textures (white, tinted by the material colour) */
function a3Canvas(w, h, draw) { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); return c; }
function a3Textures() {
  if (A3.tex) return A3.tex;
  const T = V3.T, mk = (c, rep) => { const t = new T.CanvasTexture(c); if (rep) { t.wrapS = t.wrapT = T.RepeatWrapping; } t.__shared = true; return t; };
  A3.tex = {
    // soft round glow
    glow: mk(a3Canvas(128, 128, (x, w) => { const g = x.createRadialGradient(64, 64, 0, 64, 64, 64); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.45, 'rgba(255,255,255,.45)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, w, w); })),
    // light cone: bright at the bottom, fading upwards, with soft vertical streaks
    beam: mk(a3Canvas(128, 256, (x, w, h) => {
      for (let i = 0; i < w; i++) { const s = 0.55 + 0.45 * Math.pow(Math.sin(i / w * Math.PI * 6) * 0.5 + 0.5, 3); const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, `rgba(255,255,255,${0.25 * s})`); g.addColorStop(1, `rgba(255,255,255,${0.9 * s})`); x.fillStyle = g; x.fillRect(i, 0, 1, h); }
    })),
    // dashes along a tube / ribbon (u = along)
    dash: mk(a3Canvas(64, 8, (x) => { x.fillStyle = '#fff'; x.fillRect(4, 0, 30, 8); }), true),
    // chevrons pointing along u
    chev: mk(a3Canvas(64, 64, (x) => { x.fillStyle = 'rgba(255,255,255,.35)'; x.fillRect(0, 22, 64, 20); x.fillStyle = '#fff'; x.beginPath(); x.moveTo(10, 6); x.lineTo(40, 32); x.lineTo(10, 58); x.lineTo(24, 58); x.lineTo(54, 32); x.lineTo(24, 6); x.closePath(); x.fill(); }), true),
    // diagonal stripes for zone floors
    stripe: mk(a3Canvas(64, 64, (x) => { x.fillStyle = 'rgba(255,255,255,.35)'; x.fillRect(0, 0, 64, 64); x.strokeStyle = 'rgba(255,255,255,.95)'; x.lineWidth = 12; for (let k = -64; k < 128; k += 32) { x.beginPath(); x.moveTo(k, 64); x.lineTo(k + 64, 0); x.stroke(); } }), true),
    // light walls: bright at the bottom, gone at the top, a bright top edge
    wall: mk(a3Canvas(8, 128, (x, w, h) => { const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(255,255,255,.7)'); g.addColorStop(0.06, 'rgba(255,255,255,.08)'); g.addColorStop(0.5, 'rgba(255,255,255,.25)'); g.addColorStop(1, 'rgba(255,255,255,.85)'); x.fillStyle = g; x.fillRect(0, 0, w, h); })),
    // dashed ring (planar uv of a RingGeometry)
    dring: mk(a3Canvas(256, 256, (x) => { x.strokeStyle = '#fff'; x.lineWidth = 9; x.setLineDash([16, 12]); x.beginPath(); x.arc(128, 128, 122, 0, Math.PI * 2); x.stroke(); }))
  };
  return A3.tex;
}

/* ---------------------------------------------------------------- small builders */
function a3Mat(col, o = {}) {
  const T = V3.T, { ground, ...rest } = o;
  const m = new T.MeshBasicMaterial(Object.assign({ color: col, transparent: true, depthWrite: false, side: T.DoubleSide }, rest));
  if (ground) { m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2; }   // drawn on the grass without flicker
  return m;
}
function a3Flat(geo, mat, y) { const m = new V3.T.Mesh(geo, mat); m.rotation.x = -Math.PI / 2; m.position.y = y; return m; }
// a strip lying on the grass along world points [[x, z], …]; u runs along it (metres / rep), v across
function a3Ribbon(pts, width, y, rep = 1, closed = false) {
  const T = V3.T, P = closed ? pts.concat([pts[0]]) : pts, n = P.length, pos = new Float32Array(n * 6), uv = new Float32Array(n * 4), idx = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)]; let dx = b[0] - a[0], dz = b[1] - a[1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    if (i) acc += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    const nx = -dz * width / 2, nz = dx * width / 2;
    pos.set([P[i][0] + nx, y, P[i][1] + nz, P[i][0] - nx, y, P[i][1] - nz], i * 6); uv.set([acc / rep, 1, acc / rep, 0], i * 4);
    if (i) { const k = (i - 1) * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('uv', new T.BufferAttribute(uv, 2)); g.setIndex(idx);
  g.userData.len = acc; return g;
}
// vertical light wall standing on world points; v = 0 at the grass, 1 at the top
function a3Curtain(pts, h, closed = false) {
  const T = V3.T, P = closed ? pts.concat([pts[0]]) : pts, n = P.length, pos = new Float32Array(n * 6), uv = new Float32Array(n * 4), idx = [];
  let acc = 0;
  for (let i = 0; i < n; i++) { if (i) acc += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); pos.set([P[i][0], 0.02, P[i][1], P[i][0], h, P[i][1]], i * 6); uv.set([acc, 0, acc, 1], i * 4); if (i) { const k = (i - 1) * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); } }
  const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('uv', new T.BufferAttribute(uv, 2)); g.setIndex(idx); return g;
}
function a3SetGeo(mesh, geo) { if (mesh.geometry) mesh.geometry.dispose(); mesh.geometry = geo; }
// a label that always faces the camera and keeps its size on screen; redrawn only when its text changes
function a3Label(col, size = 0.032, dark = true) {
  const T = V3.T, c = document.createElement('canvas'); c.width = 512; c.height = 112;
  const tex = new T.CanvasTexture(c); tex.colorSpace = T.SRGBColorSpace;
  const sp = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false }));
  sp.renderOrder = 30; sp.center.set(0.5, 0);
  const L = { sp, text: null, col, set(text, colour) {
    if (text === L.text && colour === L.col) return; L.text = text; L.col = colour = colour || L.col;
    const x = c.getContext('2d'); x.clearRect(0, 0, c.width, c.height);
    let fsz = 60; x.font = `bold ${fsz}px Inter, "Segoe UI", sans-serif`;
    while (x.measureText(text).width + 56 > c.width - 12 && fsz > 28) { fsz -= 4; x.font = `bold ${fsz}px Inter, "Segoe UI", sans-serif`; }
    const w = Math.min(c.width - 12, x.measureText(text).width + 56), h = 88, x0 = (c.width - w) / 2, y0 = 12, r = h / 2;
    x.shadowColor = 'rgba(0,0,0,.55)'; x.shadowBlur = 10; x.shadowOffsetY = 3;
    x.beginPath(); x.moveTo(x0 + r, y0); x.arcTo(x0 + w, y0, x0 + w, y0 + h, r); x.arcTo(x0 + w, y0 + h, x0, y0 + h, r); x.arcTo(x0, y0 + h, x0, y0, r); x.arcTo(x0, y0, x0 + w, y0, r); x.closePath();
    x.fillStyle = dark ? 'rgba(10,14,20,.9)' : colour; x.fill(); x.shadowColor = 'transparent'; x.lineWidth = 6; x.strokeStyle = colour; x.stroke();
    x.fillStyle = dark ? colour : '#111'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, c.width / 2, y0 + h / 2 + 3);
    tex.needsUpdate = true; L.w = w;
  } };
  sp.scale.set(size * c.width / c.height, size, 1);
  return L;
}
const a3W = m => v3W(m[0], m[1]);

/* ---------------------------------------------------------------- one annotation = one cached object */
function a3Key(a) { return [a.type, a.color, (a.tracks || []).join(','), a.text || '', a.fill ? 1 : 0, a.team || '', (a.zone || []).join(','), a.t0, a.t1].join('|'); }
function a3Build(a) {
  const T = V3.T, X = a3Textures(), col = a.color || '#ffd23b', g = new T.Group(), o = { a, g, key: a3Key(a), parts: {}, mats: [] };
  const M = (opts) => { const m = a3Mat(col, opts); o.mats.push(m); return m; };
  const P = o.parts, add = (k, obj) => { P[k] = obj; obj.userData.annId = a.id; g.add(obj); return obj; };
  if (a.type === 'spot') {
    add('pool', a3Flat(new T.CircleGeometry(2.1, 48), M({ map: X.glow, blending: T.AdditiveBlending, ground: true }), 0.04));
    add('ring', a3Flat(new T.RingGeometry(1.22, 1.42, 64), M({ ground: true }), 0.05));
    const dr = X.dring.clone(); dr.needsUpdate = true; o.tex = [dr];
    add('dring', a3Flat(new T.RingGeometry(1.62, 1.86, 64), M({ map: dr, ground: true }), 0.05));
    add('rip1', a3Flat(new T.RingGeometry(1.3, 1.4, 64), M({ ground: true }), 0.045)); add('rip2', a3Flat(new T.RingGeometry(1.3, 1.4, 64), M({ ground: true }), 0.045));
    const beam = add('beam', new T.Mesh(new T.CylinderGeometry(0.55, 1.5, 11, 48, 1, true), M({ map: X.beam, blending: T.AdditiveBlending })));
    beam.position.y = 5.5;
    const core = add('core', new T.Mesh(new T.CylinderGeometry(0.18, 0.75, 11, 32, 1, true), M({ map: X.beam, blending: T.AdditiveBlending })));
    core.position.y = 5.5;
    const mk = add('marker', new T.Mesh(new T.ConeGeometry(0.32, 0.62, 4), M({ transparent: false })));
    mk.rotation.x = Math.PI; mk.material.depthWrite = true;
    if (a.text) { o.label = a3Label(col, 0.034); o.label.set(a.text, col); g.add(o.label.sp); }
  } else if (a.type === 'label') {
    o.label = a3Label(col, 0.036); g.add(o.label.sp);
    add('stem', new T.Mesh(new T.CylinderGeometry(0.03, 0.03, 1, 6), M({})));
    add('dot', a3Flat(new T.RingGeometry(0.45, 0.6, 32), M({ ground: true }), 0.05));
  } else if (a.type === 'link') {
    add('glow', new T.Mesh(new T.BufferGeometry(), M({ opacity: 0.25, blending: T.AdditiveBlending })));
    const d = X.dash.clone(); d.needsUpdate = true; o.tex = [d];
    add('core', new T.Mesh(new T.BufferGeometry(), M({ map: d })));
    add('shadow', new T.Mesh(new T.BufferGeometry(), M({ opacity: 0.35, map: d, ground: true })));
    add('endA', a3Flat(new T.RingGeometry(0.5, 0.68, 40), M({ ground: true }), 0.05)); add('endB', a3Flat(new T.RingGeometry(0.5, 0.68, 40), M({ ground: true }), 0.05));
    o.label = a3Label(col, 0.036); g.add(o.label.sp);
  } else if (a.type === 'chain' || a.type === 'backline') {
    add('wall', new T.Mesh(new T.BufferGeometry(), M({ map: X.wall, blending: T.AdditiveBlending, opacity: 0.8 })));
    add('line', new T.Mesh(new T.BufferGeometry(), M({ ground: true })));
    add('fill', new T.Mesh(new T.BufferGeometry(), M({ opacity: 0.16, ground: true })));
    o.rings = []; o.gaps = [];
    if (a.type === 'backline') { o.label = a3Label(col, 0.03, false); g.add(o.label.sp); }
  } else if (a.type === 'run') {
    const c = X.chev.clone(); c.needsUpdate = true; o.tex = [c];
    add('done', new T.Mesh(new T.BufferGeometry(), M({ opacity: 0.35, map: X.dash, ground: true })));
    add('path', new T.Mesh(new T.BufferGeometry(), M({ map: c, ground: true })));
    add('glow', new T.Mesh(new T.BufferGeometry(), M({ opacity: 0.25, blending: T.AdditiveBlending, ground: true })));
    const sh = new T.Shape(); sh.moveTo(0.95, 0); sh.lineTo(-0.55, 0.8); sh.lineTo(-0.2, 0); sh.lineTo(-0.55, -0.8); sh.closePath();
    add('head', a3Flat(new T.ShapeGeometry(sh), M({ ground: true }), 0.07));
    add('target', a3Flat(new T.RingGeometry(0.55, 0.7, 40), M({ ground: true }), 0.05));
  } else if (a.type === 'zone' && a.zone) {
    const [x0, y0, x1, y1] = a.zone, [ax, az] = a3W([x0, y0]), [bx, bz] = a3W([x1, y1]), w = Math.abs(bx - ax), d = Math.abs(bz - az);
    const st = X.stripe.clone(); st.needsUpdate = true; st.repeat.set(w / 3, d / 3); o.tex = [st];
    const fl = add('floor', a3Flat(new T.PlaneGeometry(w, d), M({ map: st, opacity: 0.55, ground: true }), 0.035)); fl.position.x = (ax + bx) / 2; fl.position.z = (az + bz) / 2;
    const corners = [[ax, az], [bx, az], [bx, bz], [ax, bz]];
    add('edge', new T.Mesh(a3Ribbon(corners, 0.35, 0.06, 1, true), M({ ground: true })));
    add('wall', new T.Mesh(a3Curtain(corners, 1.6, true), M({ map: X.wall, blending: T.AdditiveBlending, opacity: 0.75 })));
    corners.forEach(([x, z], i) => { const p = add('post' + i, new T.Mesh(new T.CylinderGeometry(0.06, 0.06, 2.2, 8), M({}))); p.position.set(x, 1.1, z); });
    if (a.text) { o.label = a3Label(col, 0.042, false); o.label.set(a.text, col); o.label.sp.position.set((ax + bx) / 2, 2.2, (az + bz) / 2); g.add(o.label.sp); }
  } else if (a.type === 'offside') {
    add('line', new T.Mesh(new T.BufferGeometry(), M({ ground: true })));
    add('band', new T.Mesh(new T.BufferGeometry(), M({ opacity: 0.35, ground: true })));
    add('wall', new T.Mesh(new T.BufferGeometry(), M({ map: X.wall, blending: T.AdditiveBlending, opacity: 0.9 })));
    add('spark', new T.Mesh(new T.SphereGeometry(0.28, 16, 10), M({ blending: T.AdditiveBlending })));
    o.label = a3Label(col, 0.032, false); g.add(o.label.sp);
  }
  V3.fx.add(g);
  return o;
}
function a3Dispose(o) {
  V3.fx.remove(o.g);
  o.g.traverse(c => { if (c.geometry && !c.isSprite) c.geometry.dispose(); });   // sprites share one geometry
  o.mats.forEach(m => m.dispose()); (o.tex || []).forEach(t => t.dispose());
  if (o.label) { o.label.sp.material.map.dispose(); o.label.sp.material.dispose(); }
  (o.rings || []).forEach(r => { r.geometry.dispose(); r.material.dispose(); }); (o.gaps || []).forEach(l => { l.sp.material.map.dispose(); l.sp.material.dispose(); });
}
const a3Opacity = (o, al) => o.mats.forEach(m => { if (m.userData.base == null) m.userData.base = m.opacity; m.opacity = m.userData.base * al; });

/* ---------------------------------------------------------------- every frame */
function v3Anns(t) {
  const T = V3.T; if (!T || !V3.fx) return;
  // older objects of the 3.1 renderer
  (V3.fx.userData.ann || []).forEach(o => { V3.fx.remove(o); v3Dispose(o); }); V3.fx.userData.ann = [];
  const live = new Set(), active = annActive(t), clk = annClock(t), spot = new Map();
  V3.annAnim = active.length > 0;
  active.forEach(a => {
    live.add(a.id);
    let o = A3.objs.get(a.id);
    if (o && o.key !== a3Key(a)) { a3Dispose(o); o = null; }
    if (!o) { o = a3Build(a); A3.objs.set(a.id, o); }
    const al = annAlpha(a, t), sel = Ann.sel === a.id;
    o.g.visible = true;
    try { a3Update(o, a, t, clk, al, spot); } catch (e) { o.g.visible = false; }
    a3Opacity(o, al);
    if (o.label) o.label.sp.material.opacity = al;
    (o.gaps || []).forEach(l => { l.sp.material.opacity = al; });
    // the selected annotation pulses brighter
    if (sel) o.mats.forEach(m => { m.opacity = Math.min(1, m.opacity * (1.25 + 0.25 * Math.sin(clk * 6))); });
  });
  A3.objs.forEach((o, id) => {
    if (live.has(id)) return;
    if (!annById(id)) { a3Dispose(o); A3.objs.delete(id); } else o.g.visible = false;
  });
  // light up spotlighted players (and turn the light off again)
  V3.figs.forEach((f, id) => {
    const c = spot.get(id) || null, body = f.g.children.find(ch => ch.geometry === V3.geo.body);
    if (!body || !body.material.emissive) return;
    const key = c ? c.col + c.k.toFixed(2) : '';
    if ((body.material.userData.hl || '') === key) return; body.material.userData.hl = key;
    if (c) body.material.emissive.set(c.col).multiplyScalar(c.k); else body.material.emissive.setRGB(0, 0, 0);
  });
}
function a3Pos(id, t) { const p = annPos(annTrack(id), t); return p && p.m ? p : null; }
function a3Update(o, a, t, clk, al, spot) {
  const T = V3.T, P = o.parts, col = a.color || '#ffd23b';
  if (a.type === 'spot' || a.type === 'label') {
    const p = a3Pos(a.tracks[0], t); if (!p) { o.g.visible = false; return; }
    const [x, z] = a3W(p.m); o.g.position.set(x, 0, z);
    if (a.type === 'spot') {
      const gr = annGrow(a, t, 0.5);
      P.ring.scale.setScalar(0.6 + 0.4 * gr); P.pool.scale.setScalar(0.6 + 0.4 * gr);
      P.dring.rotation.z = clk * 0.9;
      [P.rip1, P.rip2].forEach((r, k) => { const ph = ((clk * 0.9) + k * 0.5) % 1; r.scale.setScalar(1 + ph * 1.3); r.material.userData.base = (1 - ph) * 0.8; });
      P.beam.material.userData.base = 0.55 + 0.1 * Math.sin(clk * 2.3); P.core.material.userData.base = 0.45;
      P.beam.rotation.y = clk * 0.25; P.core.rotation.y = -clk * 0.4;
      P.marker.position.y = 2.75 + Math.abs(Math.sin(clk * 3.2)) * 0.35; P.marker.rotation.y = clk * 2;
      if (o.label) o.label.sp.position.set(0, 3.5, 0);
      spot.set(a.tracks[0], { col, k: 0.45 * al });
    } else {
      o.label.set(a.text || trackLabel(annTrack(a.tracks[0])), col);
      const gr = annGrow(a, t, 0.4), h = 2.5 + 0.9 * gr;
      o.label.sp.position.set(0, h, 0); P.stem.scale.y = h - 1.9; P.stem.position.y = 1.9 + (h - 1.9) / 2;
    }
    return;
  }
  if (a.type === 'link') {
    const A = a3Pos(a.tracks[0], t), B = a3Pos(a.tracks[1], t); if (!A || !B) { o.g.visible = false; return; }
    const [ax, az] = a3W(A.m), [bx, bz] = a3W(B.m), d = Math.hypot(A.m[0] - B.m[0], A.m[1] - B.m[1]), gr = annGrow(a, t, 0.6);
    const h = clamp(d * 0.16, 0.9, 5), mid = new T.Vector3((ax + bx) / 2, h * 2, (az + bz) / 2);
    const curve = new T.QuadraticBezierCurve3(new T.Vector3(ax, 0.25, az), mid, new T.Vector3(ax + (bx - ax) * gr, 0.25 + (1 - gr) * h, az + (bz - az) * gr));
    a3SetGeo(P.core, new T.TubeGeometry(curve, 48, 0.075, 8)); a3SetGeo(P.glow, new T.TubeGeometry(curve, 48, 0.26, 10));
    a3SetGeo(P.shadow, a3Ribbon([[ax, az], [bx, bz]], 0.18, 0.05, 2));
    o.tex[0].repeat.set(Math.max(1, d / 1.4), 1); o.tex[0].offset.x = -clk * 0.9;
    P.endA.position.set(ax, 0.05, az); P.endB.position.set(bx, 0.05, bz);
    o.label.set('↔ ' + fmtM(d), col); o.label.sp.position.set((ax + bx) / 2, h + 0.35, (az + bz) / 2); o.label.sp.visible = gr > 0.95;
    return;
  }
  if (a.type === 'chain' || a.type === 'backline') {
    let pts;
    if (a.type === 'backline') { const b = annBackLine(a, t); if (!b) { o.g.visible = false; return; } pts = b.nodes.map(n => n.p.m); o.label.set(`${a.text || 'Back line'} · ${Math.round(b.height)} m`, col); }
    else { pts = a.tracks.map(id => a3Pos(id, t)).filter(Boolean).map(p => p.m); }
    if (pts.length < 2) { o.g.visible = false; return; }
    const gr = annGrow(a, t, 0.6), W3 = pts.map(a3W), n = W3.length;
    // grow along the line
    const total = W3.reduce((s, q, i) => i ? s + Math.hypot(q[0] - W3[i - 1][0], q[1] - W3[i - 1][1]) : 0, 0); let left = total * gr; const vis = [W3[0]];
    for (let i = 1; i < n && left > 0; i++) { const s = Math.hypot(W3[i][0] - W3[i - 1][0], W3[i][1] - W3[i - 1][1]), f = Math.min(1, left / (s || 1)); vis.push([W3[i - 1][0] + (W3[i][0] - W3[i - 1][0]) * f, W3[i - 1][1] + (W3[i][1] - W3[i - 1][1]) * f]); left -= s; }
    if (vis.length < 2) vis.push(W3[0]);
    a3SetGeo(P.line, a3Ribbon(vis, 0.22, 0.06)); a3SetGeo(P.wall, a3Curtain(vis, 1.5));
    if (a.fill && n >= 3) { const sh = new T.Shape(); W3.forEach(([x, z], i) => i ? sh.lineTo(x, -z) : sh.moveTo(x, -z)); const fg = new T.ShapeGeometry(sh); fg.rotateX(-Math.PI / 2); fg.translate(0, 0.04, 0); a3SetGeo(P.fill, fg); P.fill.material.userData.base = 0.16 * gr; }
    // rings at the players and the gaps in metres
    while (o.rings.length < n) { const r = a3Flat(new T.RingGeometry(0.55, 0.75, 36), a3Mat(col, { ground: true }), 0.05); r.userData.annId = a.id; o.g.add(r); o.rings.push(r); }
    o.rings.forEach((r, i) => { r.visible = i < n; if (i < n) r.position.set(W3[i][0], 0.05, W3[i][1]); r.material.opacity = (Ann.sel === a.id ? 1 : 0.95) * al; });
    const labels = n <= 6 && gr > 0.95;
    while (o.gaps.length < n - 1) { const l = a3Label(col, 0.026); o.g.add(l.sp); o.gaps.push(l); }
    o.gaps.forEach((l, i) => { const on = labels && i < n - 1; l.sp.visible = on; if (!on) return; const A = pts[i], B = pts[i + 1]; l.set(fmtM(Math.hypot(A[0] - B[0], A[1] - B[1])), col); l.sp.position.set((W3[i][0] + W3[i + 1][0]) / 2, 1.6, (W3[i][1] + W3[i + 1][1]) / 2); });
    if (o.label) { const top = W3.reduce((s, q) => [s[0] + q[0] / n, s[1] + q[1] / n], [0, 0]); o.label.sp.position.set(top[0], 2.6, top[1]); }
    return;
  }
  if (a.type === 'run') {
    const path = annRunPath(a); if (!path) { o.g.visible = false; return; }
    const W3 = path.filter(q => q.m).map(q => a3W(q.m)); if (W3.length < 2) { o.g.visible = false; return; }
    const gr = annGrow(a, t, Math.min(1, (a.t1 - a.t0) * 0.35)), n = Math.max(2, Math.ceil(W3.length * gr));
    const done = clamp(Math.round((t - a.t0) / Math.max(0.01, a.t1 - a.t0) * (W3.length - 1)), 0, W3.length - 1);
    const vis = W3.slice(0, n), rest = vis.slice(Math.min(done, vis.length - 2));
    a3SetGeo(P.done, a3Ribbon(vis.slice(0, done + 1).length > 1 ? vis.slice(0, done + 1) : [vis[0], vis[0]], 0.22, 0.05, 1.2));
    a3SetGeo(P.path, a3Ribbon(rest, 0.95, 0.065, 1.1)); a3SetGeo(P.glow, a3Ribbon(rest, 1.6, 0.06, 1));
    o.tex[0].offset.x = -clk * 1.4;
    const e = vis[vis.length - 1]; let b = vis[Math.max(0, vis.length - 2)];
    for (let k = vis.length - 2; k >= 0; k--) { b = vis[k]; if (Math.hypot(e[0] - b[0], e[1] - b[1]) > 0.8) break; }
    P.head.position.set(e[0], 0.07, e[1]); P.head.rotation.z = Math.atan2(-(e[1] - b[1]), e[0] - b[0]);
    const ph = (clk * 0.8) % 1, last = W3[W3.length - 1];
    P.target.visible = gr >= 1; P.target.position.set(last[0], 0.05, last[1]); P.target.scale.setScalar(1 + ph * 0.8); P.target.material.userData.base = 1 - ph * 0.7;
    return;
  }
  if (a.type === 'zone') {
    if (o.tex && o.tex[0]) o.tex[0].offset.x = -clk * 0.15;
    P.wall.material.userData.base = 0.6 + 0.15 * Math.sin(clk * 2.5);
    return;
  }
  if (a.type === 'offside') {
    const off = annOffside(a, t); if (!off) { o.g.visible = false; return; }
    const { W } = pitchDims(), gr = annGrow(a, t, 0.6), [x] = a3W([off.x, 0]), z0 = -W / 2, z1 = z0 + W * gr;
    a3SetGeo(P.line, a3Ribbon([[x, z0], [x, z1]], 0.16, 0.07)); a3SetGeo(P.band, a3Ribbon([[x, z0], [x, z1]], 0.7, 0.06));
    a3SetGeo(P.wall, a3Curtain([[x, z0], [x, z1]], 2.2));
    const ph = (clk * 0.35) % 1; P.spark.position.set(x, 0.3, z0 + W * ph * gr);
    o.label.set(a.text || (off.approx ? 'Offside line (no GK)' : 'Offside line'), col); o.label.sp.position.set(x, 2.5, z1 - 2);
  }
}

/* ---------------------------------------------------------------- camera that frames the annotations */
function annWorldBox(t) {
  const pts = [];
  annActive(t).forEach(a => {
    if (a.type === 'zone' && a.zone) { pts.push(a3W([a.zone[0], a.zone[1]]), a3W([a.zone[2], a.zone[3]])); return; }
    if (a.type === 'offside') { const o = annOffside(a, t); if (o) { const [x] = a3W([o.x, 0]); pts.push([x, -10], [x, 10]); } return; }
    if (a.type === 'backline') { const b = annBackLine(a, t); if (b) b.nodes.forEach(n => pts.push(a3W(n.p.m))); return; }
    if (a.type === 'run') { const p = annRunPath(a); if (p) p.filter(q => q.m).forEach(q => pts.push(a3W(q.m))); return; }
    a.tracks.forEach(id => { const p = a3Pos(id, t); if (p) pts.push(a3W(p.m)); });
  });
  if (!pts.length) return null;
  const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]), cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  return { cx, cz, r: Math.max(8, Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) / 2) };
}

/* ---------------------------------------------------------------- clicking in 3D */
function a3Ray(e, cv) {
  const T = V3.T, r = cv.getBoundingClientRect(), v = new T.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  const rc = new T.Raycaster(); rc.setFromCamera(v, V3.camera); return rc;
}
// the player figure under the mouse
function a3PickTrack(e, cv) {
  const rc = a3Ray(e, cv), groups = []; V3.figs.forEach(f => { if (f.g.visible && f.tk.kind !== 'ball') groups.push(f.g); });
  const hit = rc.intersectObjects(groups, true).find(h => h.object.geometry === V3.geo.body || h.object.geometry === V3.geo.head || h.object.geometry === V3.geo.ring);
  if (hit) { let o = hit.object; while (o && !o.userData.tkId) o = o.parent; return o ? annTrack(o.userData.tkId) : null; }
  // near the feet on the grass, for far-away figures
  const g = a3Ground(rc); if (!g) return null;
  let best = null; V3.figs.forEach(f => { if (!f.g.visible || f.tk.kind === 'ball') return; const d = Math.hypot(f.g.position.x - g.x, f.g.position.z - g.z); if (d < 1.6 && (!best || d < best.d)) best = { d, tk: f.tk }; });
  return best && best.tk;
}
function a3PickAnn(e, cv) {
  const rc = a3Ray(e, cv), objs = []; A3.objs.forEach(o => { if (o.g.visible) objs.push(o.g); });
  const hit = rc.intersectObjects(objs, true).find(h => h.object.userData.annId); return hit ? hit.object.userData.annId : null;
}
function a3Ground(rc) { const T = V3.T, p = new T.Vector3(); return rc.ray.intersectPlane(new T.Plane(new T.Vector3(0, 1, 0), 0), p) ? p : null; }
// called by the 3D canvas before it turns / moves the camera: true = the click was used here
function annotate3dPointer(type, e, cv) {
  if (V3.exporting) return false;
  if (type === 'move') {
    const tk = a3PickTrack(e, cv), id = tk ? tk.id : null;
    let ann = null; if (!tk && Ann.on && !Ann.tool) ann = a3PickAnn(e, cv);
    if (id !== (A3.hover && A3.hover.id) || ann !== A3.hoverAnn) { A3.hover = tk ? { id, x: e.clientX, y: e.clientY } : null; A3.hoverAnn = ann; V3.dirty = true; }
    if (A3.hover) { A3.hover.x = e.clientX; A3.hover.y = e.clientY; V3.dirty = true; }
    if (Ann.on && Ann.tool && Ann.tool !== 'zone') { Ann.hover = id; }
    cv.style.cursor = Ann.on && Ann.tool === 'zone' ? 'crosshair' : tk || ann ? 'pointer' : 'grab';
    return false;
  }
  if (type === 'down') {
    if (e.button !== 0) return false;
    if (Ann.on && Ann.tool === 'zone') { const g = a3Ground(a3Ray(e, cv)); if (!g) return false; A3.zoneDrag = { a: g, b: g.clone() }; return true; }
    if (Ann.on && Ann.tool) { const tk = a3PickTrack(e, cv); if (tk) { annPickTrack(tk); V3.dirty = true; return true; } toast('Click a player figure', 'bad', 1500); return true; }
    return false;
  }
  if (type === 'drag' && A3.zoneDrag) { const g = a3Ground(a3Ray(e, cv)); if (g) { A3.zoneDrag.b = g; V3.dirty = true; } return true; }
  if (type === 'up' && A3.zoneDrag) {
    const d = A3.zoneDrag; A3.zoneDrag = null; const { L, W } = pitchDims();
    const xs = [d.a.x, d.b.x].map(v => v + L / 2), ys = [d.a.z, d.b.z].map(v => v + W / 2);
    if (Math.abs(xs[0] - xs[1]) > 1 && Math.abs(ys[0] - ys[1]) > 1) annAddZone(annPitchBox(xs, ys));
    V3.dirty = true; return true;
  }
  // a click (no drag): select an annotation, or the player
  if (type === 'click') {
    if (Ann.on && !Ann.tool) { const id = a3PickAnn(e, cv); if (id) { annSelect(id); return true; } }
    const tk = a3PickTrack(e, cv);
    if (tk) { TR.sel = tk.id; if (typeof renderTrackTab === 'function') renderTrackTab(); paintTracking(true); V3.dirty = true; return true; }
    if (Ann.on && Ann.sel) { annSelect(null); return true; }
  }
  return false;
}
// the dragged zone and the name of the player under the mouse, drawn on the 3D picture
function annotate3dHud(x, w, h) {
  const cv = $('#p3canvas'), r = cv.getBoundingClientRect(), sx = w / Math.max(1, r.width), sy = h / Math.max(1, r.height);
  if (A3.zoneDrag) {
    const T = V3.T, pr = v => { const q = v.clone().project(V3.camera); return [(q.x + 1) / 2 * w, (1 - q.y) / 2 * h]; };
    const a = A3.zoneDrag.a, b = A3.zoneDrag.b, C = [new T.Vector3(a.x, 0, a.z), new T.Vector3(b.x, 0, a.z), new T.Vector3(b.x, 0, b.z), new T.Vector3(a.x, 0, b.z)].map(pr);
    x.save(); x.beginPath(); C.forEach(([px, py], i) => i ? x.lineTo(px, py) : x.moveTo(px, py)); x.closePath(); x.fillStyle = hexA(Ann.color, 0.2); x.fill(); x.setLineDash([8, 5]); x.lineWidth = 2; x.strokeStyle = Ann.color; x.stroke(); x.restore();
  }
  if (A3.hover) {
    const tk = annTrack(A3.hover.id); if (!tk) return;
    const fs = Math.max(12, Math.round(h / 40)), px = (A3.hover.x - r.left) * sx, py = (A3.hover.y - r.top) * sy - fs * 1.6;
    const tx = trackLabel(tk) + (tk.kind === 'player' ? ' · ' + teamName(tk.team) : '') + (Ann.on && Ann.tool && Ann.tool !== 'zone' ? '  – click to pick' : '  – click to select');
    x.save(); x.font = `600 ${fs}px Inter, Segoe UI, sans-serif`; const tw = x.measureText(tx).width;
    x.fillStyle = 'rgba(10,14,20,.88)'; x.fillRect(px - tw / 2 - fs * 0.6, py - fs * 0.9, tw + fs * 1.2, fs * 1.7);
    x.fillStyle = tk.kind === 'player' ? teamColor(tk.team) : '#ffd23b'; x.fillRect(px - tw / 2 - fs * 0.6, py - fs * 0.9, fs * 0.25, fs * 1.7);
    x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(tx, px, py); x.restore();
  }
}
