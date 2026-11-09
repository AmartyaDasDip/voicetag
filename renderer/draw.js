'use strict';
/* =====================================================================
   Telestration: draw arrows, spotlights, zones and text on the video.
   Drawings belong to a tag and freeze the video during playback/export.
   ===================================================================== */
function drawShapes(ctx, shapes, W, H) {
  const lw = Math.max(2, W * 0.0035);
  shapes.forEach(s => {
    ctx.save();
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = lw * 1.5;
    const X = v => v * W, Y = v => v * H;
    if (s.tool === 'arrow' || s.tool === 'line' || s.tool === 'dashed') {
      const x1 = X(s.x1), y1 = Y(s.y1), x2 = X(s.x2), y2 = Y(s.y2);
      if (s.tool === 'dashed') ctx.setLineDash([lw * 3, lw * 2.5]);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
      if (s.tool !== 'line') {
        const a = Math.atan2(y2 - y1, x2 - x1), h = lw * 5;
        ctx.beginPath(); ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - h * Math.cos(a - 0.45), y2 - h * Math.sin(a - 0.45));
        ctx.lineTo(x2 - h * Math.cos(a + 0.45), y2 - h * Math.sin(a + 0.45));
        ctx.closePath(); ctx.fill();
      }
    } else if (s.tool === 'circle') {
      const cx = X((s.x1 + s.x2) / 2), cy = Y((s.y1 + s.y2) / 2), rx = Math.abs(X(s.x2) - X(s.x1)) / 2, ry = Math.max(4, Math.abs(Y(s.y2) - Y(s.y1)) / 2);
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.globalAlpha = 0.22; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
    } else if (s.tool === 'rect') {
      const x = X(Math.min(s.x1, s.x2)), y = Y(Math.min(s.y1, s.y2)), w = Math.abs(X(s.x2) - X(s.x1)), h = Math.abs(Y(s.y2) - Y(s.y1));
      ctx.globalAlpha = 0.2; ctx.fillRect(x, y, w, h); ctx.globalAlpha = 1; ctx.strokeRect(x, y, w, h);
    } else if (s.tool === 'free' && s.pts && s.pts.length > 1) {
      ctx.beginPath(); ctx.moveTo(X(s.pts[0][0]), Y(s.pts[0][1]));
      s.pts.forEach(p => ctx.lineTo(X(p[0]), Y(p[1]))); ctx.stroke();
    } else if (s.tool === 'text' && s.text) {
      const fs = Math.max(14, H * 0.045);
      ctx.font = `700 ${fs}px "Segoe UI", Arial, sans-serif`; ctx.shadowBlur = 0;
      const w = ctx.measureText(s.text).width, pad = fs * 0.35;
      ctx.globalAlpha = 0.75; ctx.fillStyle = '#0b0f14'; ctx.fillRect(X(s.x1) - pad, Y(s.y1) - fs - pad * 0.4, w + pad * 2, fs + pad * 1.4);
      ctx.globalAlpha = 1; ctx.fillStyle = s.color; ctx.fillText(s.text, X(s.x1), Y(s.y1));
    }
    ctx.restore();
  });
}
function drawingPNG(shapes, W, H) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  drawShapes(c.getContext('2d'), shapes, W, H);
  return c.toDataURL('image/png');
}

const Draw = {
  editing: false, showing: null, shapes: [], tool: 'arrow', color: '#ff3b3b', cur: null, prevT: 0, resumeTimer: null,
  canvas: $('#drawView'),
  frameRect() {
    const wrap = $('#videoWrap').getBoundingClientRect(), vb = video.getBoundingClientRect();
    const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
    const s = Math.min(vb.width / vw, vb.height / vh);
    const w = vw * s, h = vh * s;
    return { left: vb.left - wrap.left + (vb.width - w) / 2, top: vb.top - wrap.top + (vb.height - h) / 2, w, h };
  },
  place() {
    const r = this.frameRect(), c = this.canvas;
    c.style.left = r.left + 'px'; c.style.top = r.top + 'px'; c.style.width = r.w + 'px'; c.style.height = r.h + 'px';
    c.width = Math.round(r.w * devicePixelRatio); c.height = Math.round(r.h * devicePixelRatio);
  },
  paint(extra) {
    const c = this.canvas, ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    drawShapes(ctx, extra ? this.shapes.concat([extra]) : this.shapes, c.width, c.height);
  },
  open() {
    if (!hasVideo()) { toast('Open a video first', 'bad'); return; }
    const tg = currentTarget();
    if (!tg || tg.kind !== 'event') { toast('Select (or create) the tag this drawing belongs to first', 'bad', 3000); return; }
    this.hideShow();
    video.pause();
    this.editing = true; this.shapes = [];
    this.place(); this.paint();
    this.canvas.classList.remove('hidden'); this.canvas.classList.add('edit');
    $('#drawBar').classList.remove('hidden');
    toast('Drawing on ' + fmtTime(video.currentTime) + ' for: ' + eventText(tg.ref), 'info', 2500);
  },
  close() {
    this.editing = false; this.cur = null;
    this.canvas.classList.add('hidden'); this.canvas.classList.remove('edit');
    $('#drawBar').classList.add('hidden');
  },
  pos(e) { const r = this.canvas.getBoundingClientRect(); return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)]; },
  async save() {
    const tg = currentTarget();
    if (!tg || tg.kind !== 'event') { toast('No tag selected', 'bad'); return; }
    if (!this.shapes.length) { toast('Nothing drawn yet', 'bad'); return; }
    const ev = tg.ref;
    ev.drawings = ev.drawings || [];
    const t = Math.round(video.currentTime * 100) / 100;
    ev.drawings.push({ id: uid(), t, shapes: this.shapes.slice(), dur: Number(config.general.freezeDur) || 3 });
    if (t < ev.start || t > ev.end) { ev.start = Math.min(ev.start, t - 1); ev.end = Math.max(ev.end, t + 1); }
    autosave(); this.close(); renderAll();
    toast('Drawing saved to ' + eventText(ev), 'ok');
  },
  // during playback: freeze on a drawing for a few seconds
  showDrawing(d) {
    this.showing = d; video.pause();
    this.place(); this.shapes = d.shapes; this.paint(); this.shapes = [];
    this.canvas.classList.remove('hidden');
    clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => { if (this.showing === d) { this.hideShow(); video.play(); } }, (d.dur || 3) * 1000);
  },
  hideShow() { if (this.showing) { this.showing = null; clearTimeout(this.resumeTimer); if (!this.editing) this.canvas.classList.add('hidden'); } },
  tick() {
    if (!hasVideo()) return;
    const cur = video.currentTime;
    if (!this.editing && !this.showing && !video.paused && cur > this.prevT && cur - this.prevT < 1) {
      for (const ev of events) for (const d of (ev.drawings || [])) {
        if (d.t > this.prevT && d.t <= cur) { video.currentTime = d.t; this.showDrawing(d); this.prevT = d.t; return; }
      }
    }
    if (this.showing && !video.paused) this.hideShow();
    this.prevT = cur;
  }
};
HOOKS.tick.push(() => Draw.tick());
$('#btnDraw').onclick = () => Draw.editing ? Draw.close() : Draw.open();
$('#drawClose').onclick = () => Draw.close();
$('#drawUndo').onclick = () => { Draw.shapes.pop(); Draw.paint(); };
$('#drawClear').onclick = () => { Draw.shapes = []; Draw.paint(); };
$('#drawSave').onclick = () => Draw.save();
$$('#drawBar [data-tool]').forEach(b => b.onclick = () => { Draw.tool = b.dataset.tool; $$('#drawBar [data-tool]').forEach(x => x.classList.toggle('on', x === b)); });
$$('#drawBar [data-color]').forEach(b => b.onclick = () => { Draw.color = b.dataset.color; $$('#drawBar [data-color]').forEach(x => x.classList.toggle('on', x === b)); });
Draw.canvas.addEventListener('mousedown', async e => {
  if (!Draw.editing) return;
  const [x, y] = Draw.pos(e);
  if (Draw.tool === 'text') {
    const txt = await Dlg.ask('Text on video', 'Type the text to show:', '');
    if (txt) { Draw.shapes.push({ tool: 'text', color: Draw.color, x1: x, y1: y, text: txt }); Draw.paint(); }
    return;
  }
  Draw.cur = { tool: Draw.tool, color: Draw.color, x1: x, y1: y, x2: x, y2: y, pts: [[x, y]] };
});
Draw.canvas.addEventListener('mousemove', e => {
  if (!Draw.editing || !Draw.cur) return;
  const [x, y] = Draw.pos(e);
  Draw.cur.x2 = x; Draw.cur.y2 = y;
  if (Draw.cur.tool === 'free') Draw.cur.pts.push([x, y]);
  Draw.paint(Draw.cur);
});
window.addEventListener('mouseup', () => {
  if (!Draw.editing || !Draw.cur) return;
  const s = Draw.cur; Draw.cur = null;
  const big = Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > 0.01 || (s.tool === 'free' && s.pts.length > 2);
  if (big) { if (s.tool !== 'free') delete s.pts; Draw.shapes.push(s); }
  Draw.paint();
});
window.addEventListener('resize', () => { if (Draw.editing || Draw.showing) { const keep = Draw.showing ? Draw.showing.shapes : null; Draw.place(); if (keep) { Draw.shapes = keep; Draw.paint(); Draw.shapes = []; } else Draw.paint(); } });
video.addEventListener('seeked', () => { Draw.prevT = video.currentTime; });
