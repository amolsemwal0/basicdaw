// Arrangement timeline: one lane per track with a note overview / audio waveform,
// ruler for seeking and loop selection, drag regions and clips in time.
import { clamp, fitCanvas, rgba, shade, roundRect, loopGlyph, h } from '../util.js';
import { beatsPerBar, songEndBeats, trackBars, loopRepeats } from '../store.js';
import { mediaEntry } from '../audio/media.js';

const RULER_H = 30;
const SB_H = 10;
export const LANE_H = 76;
export const INSTRUMENT_MIME = 'application/x-basicdaw-instrument';

export class Arranger {
  constructor(wrap, list, app) {
    this.wrap = wrap;
    this.list = list;
    this.app = app;
    this.store = app.store;
    this.player = app.player;
    this.base = h('canvas');
    this.over = h('canvas', { class: 'over' });
    wrap.append(this.base, this.over);
    this.w = 0;
    this.h = 0;
    this.ppb = 20;
    this.scrollX = 0;
    this.dirty = true;
    this.drag = null;
    this.dropLane = null;

    new ResizeObserver(() => this.resize()).observe(wrap);
    list.addEventListener('scroll', () => { this.dirty = true; });
    const o = this.over;
    o.addEventListener('pointerdown', (e) => this.onDown(e));
    o.addEventListener('pointermove', (e) => this.onMove(e));
    o.addEventListener('pointerup', (e) => this.onUp(e));
    o.addEventListener('pointercancel', (e) => this.onUp(e));
    o.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    o.addEventListener('dblclick', (e) => this.onDbl(e));
    o.addEventListener('contextmenu', (e) => e.preventDefault());
    o.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes(INSTRUMENT_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.dropLane = this.laneAt(this.pos(e).y);
    });
    o.addEventListener('dragleave', () => { this.dropLane = null; });
    o.addEventListener('drop', (e) => {
      const raw = e.dataTransfer.getData(INSTRUMENT_MIME);
      this.dropLane = null;
      if (!raw) return;
      e.preventDefault();
      e.stopPropagation();
      app.addTrackFromSpec(JSON.parse(raw));
    });

    this.store.on('change', () => { this.dirty = true; });
    this.store.on('project', () => { this.scrollX = 0; this.dirty = true; });
    this.store.on('select', () => { this.dirty = true; });
    this.player.on('state', () => { this.dirty = true; });
  }

  get project() { return this.store.project; }
  get scrollY() { return this.list.scrollTop; }
  get viewW() { return this.w; }
  beatToX(b) { return b * this.ppb - this.scrollX; }
  xToBeat(x) { return (x + this.scrollX) / this.ppb; }
  laneY(i) { return RULER_H + i * LANE_H - this.scrollY; }
  laneAt(y) { return Math.floor((y - RULER_H + this.scrollY) / LANE_H); }

  contentBeats() {
    const bpb = beatsPerBar(this.project);
    return Math.max(songEndBeats(this.project) + bpb * 16, bpb * 64);
  }

  resize() {
    const r = this.wrap.getBoundingClientRect();
    this.w = Math.floor(r.width);
    this.h = Math.floor(r.height);
    this.dirty = true;
  }

  zoom(factor, anchorX = this.w / 2) {
    const b = this.xToBeat(anchorX);
    this.ppb = clamp(this.ppb * factor, 2, 160);
    this.scrollX = Math.max(0, b * this.ppb - anchorX);
    this.dirty = true;
  }

  frame() {
    if (!this.w || !this.h) return;
    if (this.player.playing && !this.drag && this.app.roll.follow) {
      const x = this.beatToX(this.player.currentBeat());
      if (x > this.w * 0.92 || x < 0) { this.scrollX = Math.max(0, this.scrollX + x - this.w * 0.08); this.dirty = true; }
    }
    if (this.dirty) { this.draw(); this.dirty = false; }
    this.drawOverlay();
  }

  draw() {
    const g = fitCanvas(this.base, this.w, this.h);
    const p = this.project;
    const { w } = this;
    const lanesBottom = this.h - SB_H;
    g.fillStyle = '#0c0e1d';
    g.fillRect(0, 0, w, this.h);

    const bpb = beatsPerBar(p);
    const b0 = this.xToBeat(0), b1 = this.xToBeat(w);
    const spb = 60 / p.bpm;

    // lanes background
    g.save();
    g.beginPath();
    g.rect(0, RULER_H, w, lanesBottom - RULER_H);
    g.clip();
    p.tracks.forEach((t, i) => {
      const y = this.laneY(i);
      if (y > lanesBottom || y + LANE_H < RULER_H) return;
      g.fillStyle = t.id === this.store.selectedTrackId ? 'rgba(139,92,246,0.07)' : i % 2 ? 'rgba(255,255,255,0.012)' : 'rgba(0,0,0,0)';
      g.fillRect(0, y, w, LANE_H);
      g.fillStyle = 'rgba(255,255,255,0.05)';
      g.fillRect(0, y + LANE_H - 1, w, 1);
    });

    // grid
    const barPx = bpb * this.ppb;
    for (let bar = Math.max(0, Math.floor(b0 / bpb)); bar * bpb <= b1; bar++) {
      const x = Math.round(this.beatToX(bar * bpb)) + 0.5;
      g.fillStyle = bar % 4 === 0 ? 'rgba(255,255,255,0.11)' : barPx > 12 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0)';
      g.fillRect(x - 0.5, RULER_H, 1, lanesBottom - RULER_H);
      if (this.ppb > 30) {
        for (let k = 1; k < bpb; k++) {
          g.fillStyle = 'rgba(255,255,255,0.025)';
          g.fillRect(Math.round(this.beatToX(bar * bpb + k)), RULER_H, 1, lanesBottom - RULER_H);
        }
      }
    }
    if (p.loop.enabled) {
      const lx0 = this.beatToX(p.loop.start), lx1 = this.beatToX(p.loop.end);
      g.fillStyle = 'rgba(34,211,238,0.04)';
      g.fillRect(lx0, RULER_H, lx1 - lx0, lanesBottom - RULER_H);
    }

    // content
    g.font = '700 10px Inter, system-ui, sans-serif';
    g.textBaseline = 'middle';
    p.tracks.forEach((t, i) => {
      const y = this.laneY(i);
      if (y > lanesBottom || y + LANE_H < RULER_H) return;
      if (t.type === 'audio') this.drawClips(g, t, y, spb);
      else this.drawRegion(g, t, y);
    });
    if (!p.tracks.length) {
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.font = '600 13px Inter, system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('Add a track, drag an instrument here, or drop a MIDI / audio file', w / 2, RULER_H + 60);
      g.textAlign = 'left';
    }
    g.restore();

    this.drawRuler(g, bpb, b0, b1);
    this.drawScrollbar(g);
  }

  drawRegion(g, t, y) {
    const r = trackBars(this.project, t);
    if (!r) return;
    const top = y + 5, ht = LANE_H - 10;
    const sel = t.id === this.store.selectedTrackId;
    let lo = 127, hi = 0;
    for (const n of t.notes) { if (n.pitch < lo) lo = n.pitch; if (n.pitch > hi) hi = n.pitch; }
    lo -= 1; hi += 1;
    const innerTop = top + 18, innerH = ht - 22;
    const range = hi - lo + 1;
    const nh = Math.max(1.5, Math.min(5, innerH / range));
    const drawNotes = (off, until) => {
      for (const n of t.notes) {
        if (n.start + off >= until) continue;
        const nx = this.beatToX(n.start + off);
        const nw = Math.max(1.5, n.duration * this.ppb - 0.5);
        if (nx > this.w + 2 || nx + nw < -2) continue;
        g.fillRect(nx, innerTop + ((hi - n.pitch) / range) * innerH, nw, nh);
      }
    };

    // a looping track's repeats: lighter copies up to the end of the song
    const lp = this.player.loopOf(t);
    if (lp) {
      const until = this.player.loopUntil();
      for (const off of loopRepeats(lp, this.xToBeat(0), this.xToBeat(this.w), until)) {
        const x0 = this.beatToX(lp.start + off), x1 = this.beatToX(Math.min(lp.end + off, until));
        roundRect(g, x0 + 1, top, x1 - x0 - 2, ht, 7);
        g.fillStyle = rgba(t.color, sel ? 0.09 : 0.06);
        g.fill();
        g.lineWidth = 1;
        g.setLineDash([4, 3]);
        g.strokeStyle = rgba(t.color, sel ? 0.55 : 0.32);
        g.stroke();
        g.setLineDash([]);
        g.save();
        roundRect(g, x0 + 1, top, x1 - x0 - 2, ht, 7);
        g.clip();
        g.strokeStyle = rgba(t.color, 0.6);
        if (x1 - x0 > 22) loopGlyph(g, x0 + 11, top + 8.5);
        g.globalAlpha = 0.45;
        g.fillStyle = shade(t.color, 0.25);
        drawNotes(off, until);
        g.restore();
      }
    }

    const x0 = this.beatToX(r.start), x1 = this.beatToX(r.end);
    if (x1 < 0 || x0 > this.w) return;
    roundRect(g, x0 + 1, top, x1 - x0 - 2, ht, 7);
    g.fillStyle = rgba(t.color, sel ? 0.2 : 0.13);
    g.fill();
    g.lineWidth = 1;
    g.strokeStyle = rgba(t.color, sel ? 0.8 : 0.45);
    g.stroke();
    // title strip
    g.save();
    roundRect(g, x0 + 1, top, x1 - x0 - 2, ht, 7);
    g.clip();
    g.fillStyle = rgba(t.color, sel ? 0.35 : 0.22);
    g.fillRect(x0, top, x1 - x0, 15);
    g.fillStyle = shade(t.color, 0.6);
    let tx = Math.max(x0, 0) + 7;
    if (lp) {
      g.strokeStyle = shade(t.color, 0.6);
      loopGlyph(g, tx + 4, top + 8.5);
      tx += 13;
    }
    g.fillText(t.name, tx, top + 8);
    g.fillStyle = shade(t.color, 0.25);
    drawNotes(0, Infinity);
    g.restore();
  }

  drawClips(g, t, y, spb) {
    const pid = this.project.id;
    for (const c of t.clips) {
      const x0 = this.beatToX(c.start);
      const wpx = (c.duration / spb) * this.ppb;
      if (x0 > this.w || x0 + wpx < 0) continue;
      const top = y + 5, ht = LANE_H - 10;
      const sel = this.drag?.clip === c;
      roundRect(g, x0 + 1, top, wpx - 2, ht, 7);
      g.fillStyle = rgba(t.color, 0.16);
      g.fill();
      g.strokeStyle = rgba(t.color, sel ? 0.95 : 0.55);
      g.stroke();
      g.save();
      roundRect(g, x0 + 1, top, wpx - 2, ht, 7);
      g.clip();
      g.fillStyle = rgba(t.color, 0.28);
      g.fillRect(x0, top, wpx, 15);
      g.fillStyle = shade(t.color, 0.6);
      g.fillText(c.name || c.file, Math.max(x0, 0) + 7, top + 8);
      const e = mediaEntry(pid, c.file);
      const mid = top + 15 + (ht - 15) / 2;
      const amp = (ht - 19) / 2;
      if (e?.state === 'ready') {
        const { data, perSecond } = e.peaks;
        g.fillStyle = shade(t.color, 0.15);
        const from = Math.max(0, Math.floor(x0)), to = Math.min(this.w, Math.ceil(x0 + wpx));
        for (let px = from; px < to; px++) {
          const s0 = ((px - x0) / this.ppb) * spb + (c.offset || 0);
          const s1 = ((px + 1 - x0) / this.ppb) * spb + (c.offset || 0);
          let lo = 0, hi = 0;
          for (let k = Math.floor(s0 * perSecond); k <= Math.floor(s1 * perSecond) && k * 2 + 1 < data.length; k++) {
            if (data[k * 2] < lo) lo = data[k * 2];
            if (data[k * 2 + 1] > hi) hi = data[k * 2 + 1];
          }
          g.fillRect(px, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
        }
      } else {
        g.fillStyle = 'rgba(255,255,255,0.4)';
        g.fillText(e?.state === 'error' ? 'missing audio file' : 'loading…', Math.max(x0, 0) + 7, mid);
      }
      g.restore();
    }
  }

  drawRuler(g, bpb, b0, b1) {
    const p = this.project;
    g.fillStyle = '#12152c';
    g.fillRect(0, 0, this.w, RULER_H);
    g.fillStyle = 'rgba(255,255,255,0.07)';
    g.fillRect(0, RULER_H - 1, this.w, 1);
    if (p.loop.end > p.loop.start) {
      const x0 = this.beatToX(p.loop.start), x1 = this.beatToX(p.loop.end);
      g.fillStyle = p.loop.enabled ? 'rgba(34,211,238,0.28)' : 'rgba(255,255,255,0.07)';
      roundRect(g, x0, 3, x1 - x0, 9, 3);
      g.fill();
      if (p.loop.enabled) {
        g.fillStyle = '#22d3ee';
        g.fillRect(x0, 3, 2, 9);
        g.fillRect(x1 - 2, 3, 2, 9);
      }
    }
    g.font = '700 10px "JetBrains Mono", monospace';
    g.textBaseline = 'middle';
    const barPx = bpb * this.ppb;
    const every = barPx >= 34 ? 1 : barPx >= 17 ? 2 : barPx >= 8 ? 4 : 8;
    for (let bar = Math.max(0, Math.floor(b0 / bpb)); bar * bpb <= b1; bar++) {
      if (bar % every) continue;
      const x = Math.round(this.beatToX(bar * bpb)) + 0.5;
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.fillRect(x - 0.5, 15, 1, RULER_H - 15);
      g.fillStyle = '#9aa0c4';
      g.fillText(String(bar + 1), x + 4, 21);
    }
  }

  drawScrollbar(g) {
    const y = this.h - SB_H;
    g.fillStyle = '#0a0c19';
    g.fillRect(0, y, this.w, SB_H);
    const total = Math.max(this.contentBeats() * this.ppb, this.scrollX + this.w);
    const tw = Math.max(30, (this.w / total) * this.w);
    const tx = (this.scrollX / Math.max(1, total - this.w)) * (this.w - tw);
    this.sb = { x: tx, w: tw, total };
    roundRect(g, tx, y + 2, tw, SB_H - 4, 3);
    g.fillStyle = this.drag?.type === 'scroll' ? 'rgba(139,92,246,0.7)' : 'rgba(255,255,255,0.14)';
    g.fill();
  }

  drawOverlay() {
    const g = fitCanvas(this.over, this.w, this.h);
    g.clearRect(0, 0, this.w, this.h);
    if (this.dropLane != null) {
      const i = Math.min(this.dropLane, this.project.tracks.length);
      const y = this.laneY(i);
      g.fillStyle = 'rgba(34,211,238,0.12)';
      g.fillRect(0, y, this.w, LANE_H);
      g.fillStyle = '#22d3ee';
      g.fillRect(0, y, this.w, 2);
    }
    if (this.drag?.type === 'loop') {
      const L = this.project.loop;
      g.fillStyle = 'rgba(34,211,238,0.08)';
      g.fillRect(this.beatToX(L.start), RULER_H, (L.end - L.start) * this.ppb, this.h);
    }
    const x = Math.round(this.beatToX(this.player.currentBeat())) + 0.5;
    if (x >= 0 && x <= this.w) {
      g.fillStyle = '#22d3ee';
      g.shadowColor = '#22d3ee';
      g.shadowBlur = 8;
      g.fillRect(x - 0.5, RULER_H - 8, 1.5, this.h - RULER_H + 8 - SB_H);
      g.shadowBlur = 0;
      g.beginPath();
      g.moveTo(x - 6, RULER_H - 10);
      g.lineTo(x + 6, RULER_H - 10);
      g.lineTo(x, RULER_H - 2);
      g.closePath();
      g.fill();
    }
  }

  // ------------------------------------------------------------------ interaction

  pos(e) {
    const r = this.over.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  clipAt(t, x, y) {
    if (t.type !== 'audio') return null;
    const spb = 60 / this.project.bpm;
    for (let k = t.clips.length - 1; k >= 0; k--) {
      const c = t.clips[k];
      const x0 = this.beatToX(c.start), x1 = x0 + (c.duration / spb) * this.ppb;
      if (x >= x0 && x <= x1) return c;
    }
    return null;
  }

  onDown(e) {
    const { x, y } = this.pos(e);
    try { this.over.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    this.app.engine.resume();
    const p = this.project;
    const bpb = beatsPerBar(p);
    if (y >= this.h - SB_H) {
      const sb = this.sb;
      if (sb && (x < sb.x || x > sb.x + sb.w)) this.scrollX = Math.max(0, ((x - sb.w / 2) / (this.w - sb.w)) * (sb.total - this.w));
      this.drag = { type: 'scroll', x0: x, s0: this.scrollX };
      this.dirty = true;
      return;
    }
    if (y < RULER_H) {
      this.drag = { type: 'ruler', x0: x, b0: this.xToBeat(x), before: this.store.snapshot(), moved: false };
      return;
    }
    const i = this.laneAt(y);
    const t = p.tracks[i];
    if (!t) return;
    this.store.select(t.id);
    const before = this.store.snapshot();
    const clip = this.clipAt(t, x, y);
    if (clip) {
      this.drag = { type: 'clip', clip, x0: x, start0: clip.start, before };
      return;
    }
    const r = t.type !== 'audio' && trackBars(p, t);
    if (r && x >= this.beatToX(r.start) && x <= this.beatToX(r.end)) {
      this.drag = { type: 'region', track: t, x0: x, orig: t.notes.map((n) => n.start), min: r.start, before };
      this.over.style.cursor = 'grabbing';
    }
  }

  onMove(e) {
    const { x, y } = this.pos(e);
    const d = this.drag;
    const p = this.project;
    const bpb = beatsPerBar(p);
    if (!d) {
      let cursor = 'default';
      if (y < RULER_H) cursor = 'col-resize';
      else {
        const t = p.tracks[this.laneAt(y)];
        if (t) {
          if (this.clipAt(t, x, y)) cursor = 'grab';
          else if (t.type !== 'audio') {
            const r = trackBars(p, t);
            if (r && x >= this.beatToX(r.start) && x <= this.beatToX(r.end)) cursor = 'grab';
          }
        }
      }
      this.over.style.cursor = cursor;
      return;
    }
    const unit = e.shiftKey ? 1 : bpb;
    if (d.type === 'scroll') {
      const sb = this.sb;
      this.scrollX = Math.max(0, d.s0 + ((x - d.x0) / Math.max(1, this.w - sb.w)) * (sb.total - this.w));
      this.dirty = true;
    } else if (d.type === 'ruler') {
      if (Math.abs(x - d.x0) > 4) d.moved = true;
      if (d.moved) {
        d.type = 'loop';
      }
    }
    if (d.type === 'loop') {
      const a = Math.round(d.b0 / unit) * unit;
      const b = Math.round(this.xToBeat(x) / unit) * unit;
      p.loop.start = Math.max(0, Math.min(a, b));
      p.loop.end = Math.max(a, b);
      p.loop.enabled = p.loop.end > p.loop.start;
      this.store.transient();
    } else if (d.type === 'clip') {
      const db = Math.round((this.xToBeat(x) - this.xToBeat(d.x0)) / (e.shiftKey ? 0.25 : 1)) * (e.shiftKey ? 0.25 : 1);
      d.clip.start = Math.max(0, d.start0 + db);
      d.moved = true;
      this.store.transient();
    } else if (d.type === 'region') {
      let db = Math.round((this.xToBeat(x) - this.xToBeat(d.x0)) / unit) * unit;
      db = Math.max(db, -d.min);
      d.track.notes.forEach((n, k) => { n.start = d.orig[k] + db; });
      d.moved = db !== 0;
      this.store.transient();
    }
  }

  onUp(e) {
    const d = this.drag;
    this.drag = null;
    try { this.over.releasePointerCapture(e.pointerId); } catch { /* ok */ }
    this.over.style.cursor = 'default';
    if (!d) return;
    if (d.type === 'ruler') {
      this.player.seek(Math.max(0, Math.round(this.xToBeat(d.x0))));
    } else if (d.type === 'loop') {
      this.store.pushUndo(d.before, 'Loop region');
      this.store.touch('loop');
      this.app.emitLoop?.();
    } else if ((d.type === 'clip' || d.type === 'region') && d.moved) {
      this.store.pushUndo(d.before, d.type === 'clip' ? 'Move clip' : 'Move region');
      this.store.touch('move');
    }
    this.dirty = true;
  }

  onDbl(e) {
    const { x, y } = this.pos(e);
    if (y < RULER_H) return;
    const t = this.project.tracks[this.laneAt(y)];
    if (!t) { this.app.openAddTrackMenu({ x: e.clientX, y: e.clientY }); return; }
    if (t.type !== 'audio') {
      this.store.select(t.id);
      this.app.roll.scrollToBeat(Math.floor(this.xToBeat(x) / beatsPerBar(this.project)) * beatsPerBar(this.project));
    }
  }

  onWheel(e) {
    e.preventDefault();
    const { x } = this.pos(e);
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * k, dy = e.deltaY * k;
    const d = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
    if (e.ctrlKey || e.metaKey) { if (d) this.zoom(d < 0 ? 1.15 : 1 / 1.15, x); }
    else if (e.shiftKey) this.scrollX = Math.max(0, this.scrollX + (dy || dx));
    else {
      this.scrollX = Math.max(0, this.scrollX + dx);
      this.list.scrollTop += dy;
    }
    this.dirty = true;
  }

  /** For file drops: which lane / beat is under the pointer. */
  dropContext(clientX, clientY) {
    const r = this.over.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
    const x = clientX - r.left, y = clientY - r.top;
    return { lane: this.laneAt(y), beat: Math.max(0, Math.round(this.xToBeat(x))) };
  }
}
