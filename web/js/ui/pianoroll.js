// Piano roll editor: draw / select / erase notes, resize lengths, edit velocities.
import { clamp, fitCanvas, noteName, isBlackKey, rgba, shade, roundRect, loopGlyph, h } from '../util.js';
import { newNote, beatsPerBar, songEndBeats, loopRepeats } from '../store.js';
import { DRUM_NAMES } from '../gm.js';

export const SCALES = {
  chromatic: null,
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  'harmonic minor': [0, 2, 3, 5, 7, 8, 11],
  'pentatonic major': [0, 2, 4, 7, 9],
  'pentatonic minor': [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
};

const KB_W = 78;
const RULER_H = 26;
const VEL_H = 76;
const SB_H = 10;
const FONT = '600 9.5px Inter, system-ui, sans-serif';

let clipboard = [];
const minOf = (arr, f) => { let m = Infinity; for (const x of arr) { const v = f(x); if (v < m) m = v; } return m; };
const maxOf = (arr, f) => { let m = -Infinity; for (const x of arr) { const v = f(x); if (v > m) m = v; } return m; };

export class PianoRoll {
  constructor(wrap, app) {
    this.wrap = wrap;
    this.app = app;
    this.store = app.store;
    this.player = app.player;
    this.base = h('canvas');
    this.over = h('canvas', { class: 'over' });
    wrap.append(this.base, this.over);
    this.w = 0;
    this.h = 0;
    this.rowH = 15;
    this.ppb = 96;
    this.scrollX = 0;
    this.scrollY = (127 - 84) * this.rowH;
    this.tool = 'draw';
    this.snap = 0.25;
    this.lenMode = 'snap';
    this.lastLen = 0.25;
    this.velocity = 100;
    this.ghost = true;
    this.follow = true;
    this.selection = new Set();
    this.drag = null;
    this.hover = null;
    this.dirty = true;
    this.scheduled = [];

    new ResizeObserver(() => this.resize()).observe(wrap);
    const o = this.over;
    o.addEventListener('pointerdown', (e) => this.onDown(e));
    o.addEventListener('pointermove', (e) => this.onMove(e));
    o.addEventListener('pointerup', (e) => this.onUp(e));
    o.addEventListener('pointercancel', (e) => this.onUp(e));
    o.addEventListener('pointerleave', () => { if (!this.drag) this.hover = null; });
    o.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    o.addEventListener('dblclick', (e) => this.onDbl(e));
    o.addEventListener('contextmenu', (e) => e.preventDefault());

    this.store.on('change', () => { this.dirty = true; });
    this.store.on('select', () => { this.selection.clear(); this.focusTrack(); this.dirty = true; });
    this.store.on('restore', () => { this.selection.clear(); this.dirty = true; });
    this.store.on('project', () => { this.selection.clear(); this.scrollX = 0; this.focusTrack(); });
    this.player.on('note', (n) => { if (n.trackId === this.store.selectedTrackId) this.scheduled.push(n); });
    this.player.on('state', () => { this.dirty = true; });
  }

  get track() { return this.store.selectedTrack; }
  get project() { return this.store.project; }
  get gridW() { return Math.max(1, this.w - KB_W); }
  get gridH() { return Math.max(1, this.h - RULER_H - VEL_H - SB_H); }
  get velTop() { return RULER_H + this.gridH; }
  get isDrum() { return this.track?.instrument?.kind === 'drums'; }

  beatToX(b) { return KB_W + b * this.ppb - this.scrollX; }
  xToBeat(x) { return (x - KB_W + this.scrollX) / this.ppb; }
  pitchToY(p) { return RULER_H + (127 - p) * this.rowH - this.scrollY; }
  yToPitch(y) { return clamp(127 - Math.floor((y - RULER_H + this.scrollY) / this.rowH), 0, 127); }

  contentBeats() {
    const bpb = beatsPerBar(this.project);
    return Math.max(songEndBeats(this.project) + bpb * 8, bpb * 32, this.xToBeat(this.w) + bpb);
  }

  resize() {
    const r = this.wrap.getBoundingClientRect();
    this.w = Math.floor(r.width);
    this.h = Math.floor(r.height);
    this.clampScroll();
    this.dirty = true;
  }

  clampScroll() {
    this.scrollY = clamp(this.scrollY, 0, Math.max(0, 128 * this.rowH - this.gridH));
    this.scrollX = Math.max(0, this.scrollX);
  }

  snapFloor(b) { return Math.floor(b / this.snap + 1e-6) * this.snap; }
  snapRound(b) { return Math.round(b / this.snap) * this.snap; }

  defaultLength() {
    if (this.lenMode === 'snap') return this.snap;
    if (this.lenMode === 'last') return this.lastLen;
    return Number(this.lenMode);
  }

  inScale(pitch) {
    const sc = SCALES[this.project.key?.scale];
    if (!sc) return true;
    return sc.includes((((pitch - (this.project.key.root || 0)) % 12) + 12) % 12);
  }

  focusTrack() {
    const t = this.track;
    if (!t || !this.h) return;
    let center = this.isDrum ? 42 : 60;
    if (t.notes.length) {
      const ps = t.notes.map((n) => n.pitch).sort((a, b) => a - b);
      center = ps[Math.floor(ps.length / 2)];
      const first = minOf(t.notes, (n) => n.start);
      const vis0 = this.xToBeat(KB_W), vis1 = this.xToBeat(this.w);
      if (first < vis0 || first > vis1) this.scrollX = Math.max(0, this.snapFloor(first) * this.ppb - 20);
    }
    this.scrollY = (127 - center) * this.rowH - this.gridH / 2;
    this.clampScroll();
    this.dirty = true;
  }

  scrollToBeat(beat) {
    this.scrollX = Math.max(0, beat * this.ppb - 30);
    this.dirty = true;
  }

  zoom(factor, anchorX = KB_W + this.gridW / 2) {
    const b = this.xToBeat(anchorX);
    this.ppb = clamp(this.ppb * factor, 10, 900);
    this.scrollX = Math.max(0, b * this.ppb - (anchorX - KB_W));
    this.dirty = true;
  }

  /** Taller / shorter rows, keeping the pitch under anchorY in place. */
  zoomRows(step, anchorY = RULER_H + this.gridH / 2) {
    const pitch = this.yToPitch(anchorY);
    const off = anchorY - this.pitchToY(pitch);
    this.rowH = clamp(this.rowH + step, 7, 34);
    this.scrollY = (127 - pitch) * this.rowH - (anchorY - RULER_H) + off;
    this.clampScroll();
    this.dirty = true;
  }

  // ------------------------------------------------------------------ drawing

  frame() {
    if (!this.w || !this.h) return;
    if (this.follow && this.player.playing && !this.drag) {
      const x = this.beatToX(this.player.currentBeat());
      if (x > KB_W + this.gridW * 0.88 || x < KB_W) { this.scrollX = Math.max(0, this.scrollX + (x - KB_W) - this.gridW * 0.12); this.dirty = true; }
    }
    if (this.dirty) { this.draw(); this.dirty = false; }
    this.drawOverlay();
  }

  draw() {
    const g = fitCanvas(this.base, this.w, this.h);
    const { w } = this;
    const p = this.project;
    const t = this.track;
    const gx = KB_W, gy = RULER_H, gw = this.gridW, gh = this.gridH;
    g.fillStyle = '#0c0e1d';
    g.fillRect(0, 0, w, this.h);

    // rows
    g.save();
    g.beginPath();
    g.rect(gx, gy, gw, gh);
    g.clip();
    const pTop = this.yToPitch(gy), pBot = this.yToPitch(gy + gh);
    const scaled = !!SCALES[p.key?.scale];
    for (let pitch = pBot; pitch <= pTop; pitch++) {
      const y = this.pitchToY(pitch);
      let c;
      if (this.isDrum) c = DRUM_NAMES[pitch] ? (pitch % 2 ? '#121530' : '#151936') : '#0d0f20';
      else if (scaled) c = this.inScale(pitch) ? ((pitch - p.key.root) % 12 === 0 ? '#1d1f48' : '#161a39') : '#0d0f20';
      else c = isBlackKey(pitch) ? '#0f1125' : '#151834';
      g.fillStyle = c;
      g.fillRect(gx, y, gw, this.rowH);
      g.fillStyle = pitch % 12 === 0 ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.025)';
      g.fillRect(gx, y + this.rowH - 1, gw, 1);
    }

    // vertical grid
    const bpb = beatsPerBar(p);
    const b0 = this.xToBeat(gx), b1 = this.xToBeat(gx + gw);
    let step = this.snap;
    while (step * this.ppb < 7) step *= 2;
    for (let b = Math.floor(b0 / step) * step; b <= b1; b += step) {
      const x = Math.round(this.beatToX(b)) + 0.5;
      const bar = Math.abs(b / bpb - Math.round(b / bpb)) < 1e-6;
      const beat = Math.abs(b - Math.round(b)) < 1e-6;
      g.fillStyle = bar ? 'rgba(255,255,255,0.16)' : beat ? 'rgba(255,255,255,0.075)' : 'rgba(255,255,255,0.03)';
      g.fillRect(x - 0.5, gy, 1, gh);
    }

    // loop region
    if (p.loop.enabled) {
      const lx0 = this.beatToX(p.loop.start), lx1 = this.beatToX(p.loop.end);
      g.fillStyle = 'rgba(34,211,238,0.035)';
      g.fillRect(lx0, gy, lx1 - lx0, gh);
    }

    // ghost notes from other tracks, with the repeats of looping ones
    const until = this.player.loopUntil();
    if (this.ghost && !this.isDrum) {
      for (const other of p.tracks) {
        if (other === t || other.type === 'audio' || other.instrument?.kind === 'drums' || !other.notes.length) continue;
        const olp = this.player.loopOf(other);
        g.fillStyle = rgba(other.color, 0.13);
        for (const off of olp ? [0, ...loopRepeats(olp, b0, b1, until)] : [0]) {
          for (const n of other.notes) {
            if (off && n.start + off >= until) continue;
            const x = this.beatToX(n.start + off);
            const nw = n.duration * this.ppb;
            if (x > gx + gw || x + nw < gx || n.pitch < pBot || n.pitch > pTop) continue;
            g.fillRect(x, this.pitchToY(n.pitch) + 2, Math.max(2, nw - 1), this.rowH - 4);
          }
        }
      }
    }

    // the selected track's loop: outlined repeats, and a line where each pass starts (dashed at the loop point)
    const lp = t && this.player.loopOf(t);
    if (lp) {
      const reps = loopRepeats(lp, b0, b1, until);
      g.lineWidth = 1;
      g.fillStyle = rgba(t.color, 0.12);
      g.strokeStyle = rgba(t.color, 0.5);
      for (const off of reps) {
        for (const n of t.notes) {
          if (n.start + off >= until) continue;
          const x = this.beatToX(n.start + off);
          const nw = Math.max(3, n.duration * this.ppb - 1);
          if (x > gx + gw || x + nw < gx || n.pitch < pBot || n.pitch > pTop) continue;
          roundRect(g, x + 0.5, this.pitchToY(n.pitch) + 1.5, nw - 0.5, this.rowH - 3, Math.min(4, (this.rowH - 3) / 3));
          g.fill();
          g.stroke();
        }
      }
      for (const off of reps) {
        const x = Math.round(this.beatToX(lp.start + off)) + 0.5;
        const loopPoint = off === lp.length;
        g.strokeStyle = rgba(t.color, loopPoint ? 0.85 : 0.3);
        g.setLineDash(loopPoint ? [5, 4] : []);
        g.beginPath();
        g.moveTo(x, gy);
        g.lineTo(x, gy + gh);
        g.stroke();
      }
      g.setLineDash([]);
    }

    // notes
    if (t && t.type !== 'audio') {
      g.font = FONT;
      g.textBaseline = 'middle';
      const color = t.color;
      for (const n of t.notes) {
        const x = this.beatToX(n.start);
        const nw = Math.max(3, n.duration * this.ppb - 1);
        if (x > gx + gw || x + nw < gx || n.pitch < pBot || n.pitch > pTop) continue;
        const y = this.pitchToY(n.pitch) + 1;
        const nh = this.rowH - 2;
        const sel = this.selection.has(n);
        const v = n.velocity / 127;
        roundRect(g, x + 0.5, y, nw, nh, Math.min(4, nh / 3));
        g.fillStyle = sel ? shade(color, 0.42) : rgba(color, 0.5 + 0.5 * v);
        g.fill();
        g.lineWidth = sel ? 1.5 : 1;
        g.strokeStyle = sel ? '#ffffff' : shade(color, -0.45);
        g.stroke();
        g.fillStyle = 'rgba(255,255,255,0.28)';
        g.fillRect(x + 2, y + 1, Math.max(0, nw - 3), 1);
        if (nw > 24 && nh >= 10) {
          g.fillStyle = sel ? '#1a1033' : 'rgba(8,8,20,0.85)';
          const label = this.isDrum ? (DRUM_NAMES[n.pitch] || noteName(n.pitch)) : noteName(n.pitch);
          g.save();
          g.beginPath();
          g.rect(x, y, nw - 2, nh);
          g.clip();
          g.fillText(label, x + 4, y + nh / 2 + 0.5);
          g.restore();
        }
      }
    }
    if (!t || t.type === 'audio') {
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.font = '600 13px Inter, system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(t ? 'Audio track - its clip lives in the arranger above' : 'Add or select a track to start drawing notes', gx + gw / 2, gy + gh / 2);
      g.textAlign = 'left';
    }
    g.restore();

    this.drawKeyboard(g);
    this.drawRuler(g);
    this.drawVelocity(g);
    this.drawScrollbar(g);
  }

  drawKeyboard(g) {
    const gy = RULER_H, gh = this.gridH;
    g.save();
    g.beginPath();
    g.rect(0, gy, KB_W, gh);
    g.clip();
    const pTop = this.yToPitch(gy), pBot = this.yToPitch(gy + gh);
    if (this.isDrum) {
      g.fillStyle = '#14172e';
      g.fillRect(0, gy, KB_W, gh);
      g.font = '600 10px Inter, system-ui, sans-serif';
      g.textBaseline = 'middle';
      for (let pitch = pBot; pitch <= pTop; pitch++) {
        const y = this.pitchToY(pitch);
        g.fillStyle = 'rgba(255,255,255,0.05)';
        g.fillRect(0, y + this.rowH - 1, KB_W, 1);
        const name = DRUM_NAMES[pitch];
        if (name && this.rowH >= 9) {
          g.fillStyle = '#b6bbdc';
          g.fillText(name, 8, y + this.rowH / 2);
        }
      }
    } else {
      g.fillStyle = '#dfe2ef';
      g.fillRect(0, gy, KB_W, gh);
      g.font = '700 9px Inter, system-ui, sans-serif';
      g.textBaseline = 'middle';
      for (let pitch = pBot; pitch <= pTop; pitch++) {
        const y = this.pitchToY(pitch);
        const pc = pitch % 12;
        if (pc === 0 || pc === 5) { g.fillStyle = '#9da2bd'; g.fillRect(0, y + this.rowH - 0.5, KB_W, 1); }
        if (isBlackKey(pitch)) {
          g.fillStyle = '#1a1c2e';
          roundRect(g, 0, y + 0.5, KB_W * 0.6, this.rowH - 1, 2);
          g.fill();
        }
        if (pc === 0 && this.rowH >= 8) {
          g.fillStyle = '#5b6080';
          g.fillText(noteName(pitch), KB_W - 22, y + this.rowH / 2);
        }
      }
    }
    g.restore();
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.fillRect(KB_W - 1, gy, 1, gh);
  }

  drawRuler(g) {
    const p = this.project;
    g.fillStyle = '#12152c';
    g.fillRect(0, 0, this.w, RULER_H);
    g.fillStyle = 'rgba(255,255,255,0.07)';
    g.fillRect(0, RULER_H - 1, this.w, 1);
    const bpb = beatsPerBar(p);
    const b0 = this.xToBeat(KB_W), b1 = this.xToBeat(this.w);
    if (p.loop.end > p.loop.start) {
      const x0 = Math.max(KB_W, this.beatToX(p.loop.start)), x1 = this.beatToX(p.loop.end);
      if (x1 > KB_W) {
        g.fillStyle = p.loop.enabled ? 'rgba(34,211,238,0.22)' : 'rgba(255,255,255,0.06)';
        g.fillRect(x0, 3, x1 - x0, 6);
      }
    }
    g.font = '700 10px "JetBrains Mono", monospace';
    g.textBaseline = 'middle';
    const barPx = bpb * this.ppb;
    const every = barPx < 28 ? Math.ceil(28 / barPx) * (barPx < 14 ? 2 : 1) : 1;
    for (let bar = Math.max(0, Math.floor(b0 / bpb)); bar * bpb <= b1; bar++) {
      const x = Math.round(this.beatToX(bar * bpb)) + 0.5;
      if (x < KB_W) continue;
      g.fillStyle = 'rgba(255,255,255,0.22)';
      g.fillRect(x - 0.5, 12, 1, RULER_H - 12);
      if (bar % every === 0) {
        g.fillStyle = '#9aa0c4';
        g.fillText(String(bar + 1), x + 4, 17);
      }
      if (this.ppb >= 20) {
        for (let k = 1; k < bpb; k++) {
          const bx = Math.round(this.beatToX(bar * bpb + k)) + 0.5;
          g.fillStyle = 'rgba(255,255,255,0.1)';
          g.fillRect(bx - 0.5, RULER_H - 6, 1, 6);
        }
      }
    }
    // a looping track: its pattern as a solid strip, the repeats lighter
    const t = this.track;
    const lp = t && this.player.loopOf(t);
    if (lp) {
      const strip = (a, b, alpha) => {
        const x0 = Math.max(KB_W, this.beatToX(a) + 1), x1 = Math.min(this.w, this.beatToX(b) - 1);
        if (x1 > x0) { g.fillStyle = rgba(t.color, alpha); g.fillRect(x0, RULER_H - 3, x1 - x0, 2); }
      };
      const until = this.player.loopUntil();
      strip(lp.start, lp.end, 0.95);
      for (const off of loopRepeats(lp, b0, b1, until)) strip(lp.start + off, Math.min(lp.end + off, until), 0.4);
      const lx = this.beatToX(lp.end);
      if (barPx >= 40 && lx - 16 > KB_W && lx < this.w) {
        g.strokeStyle = t.color;
        loopGlyph(g, lx - 9, 17);
      }
    }
    g.fillStyle = '#12152c';
    g.fillRect(0, 0, KB_W, RULER_H);
    g.fillStyle = '#5c6185';
    g.font = '800 9px Inter, system-ui, sans-serif';
    g.fillText(this.isDrum ? 'DRUMS' : 'NOTES', 10, RULER_H / 2);
  }

  drawVelocity(g) {
    const top = this.velTop;
    g.fillStyle = '#0e1023';
    g.fillRect(0, top, this.w, VEL_H);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(0, top, this.w, 1);
    g.fillStyle = '#5c6185';
    g.font = '800 9px Inter, system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.fillText('VELOCITY', 10, top + 14);
    const t = this.track;
    if (!t || t.type === 'audio') return;
    g.save();
    g.beginPath();
    g.rect(KB_W, top + 1, this.gridW, VEL_H - 1);
    g.clip();
    const base = top + VEL_H - 6;
    const span = VEL_H - 16;
    for (const n of t.notes) {
      const x = this.beatToX(n.start) + 1.5;
      if (x < KB_W - 4 || x > this.w + 4) continue;
      const sel = this.selection.has(n);
      const y = base - (n.velocity / 127) * span;
      g.fillStyle = sel ? '#ffffff' : rgba(t.color, 0.85);
      g.fillRect(x - 1, y, 2, base - y);
      g.beginPath();
      g.arc(x, y, sel ? 4 : 3.2, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  drawScrollbar(g) {
    const y = this.h - SB_H;
    g.fillStyle = '#0a0c19';
    g.fillRect(0, y, this.w, SB_H);
    const total = this.contentBeats() * this.ppb;
    const tw = Math.max(30, (this.gridW / total) * this.gridW);
    const tx = KB_W + (this.scrollX / Math.max(1, total - this.gridW)) * (this.gridW - tw);
    this.sb = { x: tx, w: tw, total };
    roundRect(g, clamp(tx, KB_W, this.w - tw), y + 2, tw, SB_H - 4, 3);
    g.fillStyle = this.drag?.type === 'scroll' ? 'rgba(139,92,246,0.7)' : 'rgba(255,255,255,0.14)';
    g.fill();
  }

  drawOverlay() {
    const g = fitCanvas(this.over, this.w, this.h);
    g.clearRect(0, 0, this.w, this.h);
    const t = this.track;
    const now = this.app.engine.now;
    this.scheduled = this.scheduled.filter((n) => n.end > now - 0.05);

    // sounding keys
    const sounding = new Set();
    for (const n of this.scheduled) if (n.when <= now && n.end > now) sounding.add(n.pitch);
    if (t) for (const k of this.app.live.held) { const [id, pitch] = k.split(':'); if (id === t.id) sounding.add(Number(pitch)); }
    if (this.keyDown != null) sounding.add(this.keyDown);
    for (const pitch of sounding) {
      const y = this.pitchToY(pitch);
      if (y < RULER_H - this.rowH || y > this.velTop) continue;
      g.save();
      g.beginPath();
      g.rect(0, RULER_H, this.w, this.gridH);
      g.clip();
      g.fillStyle = 'rgba(34,211,238,0.85)';
      g.fillRect(0, y, isBlackKey(pitch) && !this.isDrum ? KB_W * 0.6 : KB_W, this.rowH);
      g.fillStyle = 'rgba(34,211,238,0.07)';
      g.fillRect(KB_W, y, this.gridW, this.rowH);
      g.restore();
    }

    // hover row + draw preview
    if (this.hover && !this.drag && t && t.type !== 'audio') {
      const { x, y, region } = this.hover;
      if (region === 'grid' || region === 'keys') {
        const pitch = this.yToPitch(y);
        const py = this.pitchToY(pitch);
        g.fillStyle = 'rgba(255,255,255,0.035)';
        g.fillRect(KB_W, py, this.gridW, this.rowH);
        g.fillStyle = 'rgba(139,92,246,0.35)';
        g.fillRect(0, py, 3, this.rowH);
        if (region === 'grid' && this.tool === 'draw' && !this.noteAt(x, y)) {
          const b = this.snapFloor(this.xToBeat(x));
          roundRect(g, this.beatToX(b) + 0.5, py + 1, Math.max(3, this.defaultLength() * this.ppb - 1), this.rowH - 2, 3);
          g.strokeStyle = rgba(t.color, 0.7);
          g.setLineDash([3, 3]);
          g.stroke();
          g.setLineDash([]);
        }
      }
    }

    // rubber band
    if (this.drag?.type === 'rubber') {
      const { x0, y0, x1, y1 } = this.drag;
      g.fillStyle = 'rgba(139,92,246,0.12)';
      g.strokeStyle = 'rgba(167,139,250,0.9)';
      g.lineWidth = 1;
      g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      g.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    }

    // playhead
    const x = Math.round(this.beatToX(this.player.currentBeat())) + 0.5;
    if (x >= KB_W && x <= this.w) {
      g.fillStyle = '#22d3ee';
      g.shadowColor = '#22d3ee';
      g.shadowBlur = 8;
      g.fillRect(x - 0.5, RULER_H, 1.5, this.gridH + VEL_H);
      g.shadowBlur = 0;
      g.beginPath();
      g.moveTo(x - 6, RULER_H - 9);
      g.lineTo(x + 6, RULER_H - 9);
      g.lineTo(x, RULER_H);
      g.closePath();
      g.fill();
    }
  }

  // ------------------------------------------------------------------ hit testing

  pos(e) {
    const r = this.over.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  regionAt(x, y) {
    if (y >= this.h - SB_H) return 'scroll';
    if (y < RULER_H) return x < KB_W ? 'corner' : 'ruler';
    if (y >= this.velTop) return x < KB_W ? 'corner' : 'vel';
    return x < KB_W ? 'keys' : 'grid';
  }

  noteAt(x, y) {
    const t = this.track;
    if (!t || t.type === 'audio') return null;
    const pitch = this.yToPitch(y);
    for (let i = t.notes.length - 1; i >= 0; i--) {
      const n = t.notes[i];
      if (n.pitch !== pitch) continue;
      const x0 = this.beatToX(n.start), x1 = x0 + Math.max(3, n.duration * this.ppb);
      if (x >= x0 && x <= x1) return n;
    }
    return null;
  }

  edgeOf(n, x) {
    const x0 = this.beatToX(n.start), x1 = x0 + Math.max(3, n.duration * this.ppb);
    const w = x1 - x0;
    if (x >= x1 - Math.min(8, w / 3)) return 'right';
    if (x <= x0 + Math.min(5, w / 4)) return 'left';
    return 'body';
  }

  // ------------------------------------------------------------------ pointer

  onDown(e) {
    const { x, y } = this.pos(e);
    const region = this.regionAt(x, y);
    this.app.engine.resume();
    try { this.over.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    const t = this.track;

    if (region === 'scroll') {
      const sb = this.sb;
      if (sb && (x < sb.x || x > sb.x + sb.w)) this.scrollX = Math.max(0, ((x - KB_W - sb.w / 2) / (this.gridW - sb.w)) * (sb.total - this.gridW));
      this.drag = { type: 'scroll', x0: x, s0: this.scrollX };
      this.dirty = true;
      return;
    }
    if (region === 'ruler') {
      if (e.shiftKey) {
        const b = this.snapRound(this.xToBeat(x));
        this.drag = { type: 'loop', b0: b, before: this.store.snapshot() };
      } else {
        this.drag = { type: 'scrub' };
        this.player.seek(Math.max(0, this.snapRound(this.xToBeat(x))));
      }
      return;
    }
    if (!t || t.type === 'audio') return;
    if (region === 'keys') {
      const pitch = this.yToPitch(y);
      this.drag = { type: 'keys', pitch };
      this.keyDown = pitch;
      this.previewVoice = this.app.preview.start(t, pitch, this.velocity);
      return;
    }
    if (region === 'vel') {
      this.drag = { type: 'vel', before: this.store.snapshot() };
      this.velAt(x, y);
      return;
    }
    if (region !== 'grid') return;

    const n = this.noteAt(x, y);
    if (e.button === 2 || this.tool === 'erase') {
      this.drag = { type: 'erase', before: this.store.snapshot() };
      if (n) this.removeNotes([n]);
      return;
    }
    if (n) {
      const edge = this.edgeOf(n, x);
      if (e.shiftKey && this.selection.has(n)) { this.selection.delete(n); this.dirty = true; this.drag = null; return; }
      if (!this.selection.has(n)) {
        if (!e.shiftKey) this.selection.clear();
        this.selection.add(n);
      }
      const before = this.store.snapshot();
      if ((e.ctrlKey || e.metaKey) && edge === 'body') {
        const clones = [...this.selection].map((s) => newNote(s.pitch, s.start, s.duration, s.velocity));
        t.notes.push(...clones);
        const primaryIdx = [...this.selection].indexOf(n);
        this.selection = new Set(clones);
        return this.beginNoteDrag('move', clones[primaryIdx], x, y, before);
      }
      this.beginNoteDrag(edge === 'body' ? 'move' : edge === 'right' ? 'resize-r' : 'resize-l', n, x, y, before);
      this.app.preview.once(t, n.pitch, n.velocity);
      return;
    }
    if (this.tool === 'draw') {
      const before = this.store.snapshot();
      const start = Math.max(0, this.snapFloor(this.xToBeat(x)));
      const note = newNote(this.yToPitch(y), start, this.defaultLength(), this.velocity);
      t.notes.push(note);
      if (!e.shiftKey) this.selection.clear();
      this.selection.add(note);
      this.drag = { type: 'create', note, before, x0: x, start, moved: false };
      this.app.preview.once(t, note.pitch, note.velocity);
      this.store.transient();
      return;
    }
    // select tool on empty space: rubber band
    if (!e.shiftKey) this.selection.clear();
    this.drag = { type: 'rubber', x0: x, y0: y, x1: x, y1: y, base: new Set(this.selection) };
    this.dirty = true;
  }

  beginNoteDrag(type, primary, x, y, before) {
    this.drag = {
      type, primary, before,
      beat0: this.xToBeat(x),
      pitch0: this.yToPitch(y),
      orig: new Map([...this.selection].map((n) => [n, { start: n.start, pitch: n.pitch, duration: n.duration }])),
      lastPitch: primary.pitch,
      moved: false,
    };
    this.dirty = true;
  }

  onMove(e) {
    const { x, y } = this.pos(e);
    const d = this.drag;
    if (!d) {
      const region = this.regionAt(x, y);
      this.hover = { x, y, region };
      let cursor = 'default';
      if (region === 'grid') {
        const n = this.noteAt(x, y);
        if (this.tool === 'erase') cursor = 'crosshair';
        else if (n) cursor = this.edgeOf(n, x) === 'body' ? 'grab' : 'ew-resize';
        else cursor = this.tool === 'draw' ? 'crosshair' : 'default';
      } else if (region === 'ruler') cursor = 'pointer';
      else if (region === 'keys') cursor = 'pointer';
      else if (region === 'vel') cursor = 'ns-resize';
      this.over.style.cursor = cursor;
      return;
    }
    const t = this.track;
    const free = e.altKey;
    switch (d.type) {
      case 'scroll': {
        const sb = this.sb;
        this.scrollX = Math.max(0, d.s0 + ((x - d.x0) / Math.max(1, this.gridW - sb.w)) * (sb.total - this.gridW));
        this.dirty = true;
        break;
      }
      case 'scrub':
        this.player.seek(Math.max(0, this.snapRound(this.xToBeat(x))));
        break;
      case 'loop': {
        const b = this.snapRound(this.xToBeat(x));
        const L = this.project.loop;
        L.start = Math.max(0, Math.min(d.b0, b));
        L.end = Math.max(d.b0, b);
        L.enabled = L.end - L.start > 0;
        this.store.transient();
        break;
      }
      case 'keys': {
        const pitch = this.yToPitch(y);
        if (pitch !== d.pitch) {
          this.previewVoice?.stop(this.app.engine.now);
          d.pitch = pitch;
          this.keyDown = pitch;
          this.previewVoice = this.app.preview.start(t, pitch, this.velocity);
        }
        break;
      }
      case 'vel':
        this.velAt(x, y);
        break;
      case 'erase': {
        const n = this.noteAt(x, y);
        if (n) this.removeNotes([n]);
        break;
      }
      case 'create': {
        if (Math.abs(x - d.x0) > 3) d.moved = true;
        if (d.moved) {
          const endB = free ? this.xToBeat(x) : this.snapRound(this.xToBeat(x));
          d.note.duration = Math.max(free ? 1 / 64 : this.snap, endB - d.start);
          this.store.transient();
        }
        break;
      }
      case 'move': {
        const raw = this.xToBeat(x) - d.beat0;
        const o = d.orig.get(d.primary);
        let dBeat = free ? raw : this.snapRound(o.start + raw) - o.start;
        let dPitch = this.yToPitch(y) - d.pitch0;
        let minStart = Infinity, minP = 127, maxP = 0;
        for (const v of d.orig.values()) { minStart = Math.min(minStart, v.start); minP = Math.min(minP, v.pitch); maxP = Math.max(maxP, v.pitch); }
        dBeat = Math.max(dBeat, -minStart);
        dPitch = clamp(dPitch, -minP, 127 - maxP);
        if (dBeat !== 0 || dPitch !== 0) d.moved = true;
        for (const [n, v] of d.orig) { n.start = v.start + dBeat; n.pitch = v.pitch + dPitch; }
        if (d.primary.pitch !== d.lastPitch) {
          d.lastPitch = d.primary.pitch;
          this.app.preview.once(t, d.primary.pitch, d.primary.velocity);
        }
        this.over.style.cursor = 'grabbing';
        this.store.transient();
        break;
      }
      case 'resize-r': {
        const o = d.orig.get(d.primary);
        const target = free ? this.xToBeat(x) : this.snapRound(this.xToBeat(x));
        const delta = target - (o.start + o.duration);
        const min = free ? 1 / 64 : this.snap;
        for (const [n, v] of d.orig) n.duration = Math.max(min, v.duration + delta);
        d.moved = true;
        this.store.transient();
        break;
      }
      case 'resize-l': {
        const o = d.orig.get(d.primary);
        const target = free ? this.xToBeat(x) : this.snapRound(this.xToBeat(x));
        const delta = target - o.start;
        const min = free ? 1 / 64 : this.snap;
        for (const [n, v] of d.orig) {
          const end = v.start + v.duration;
          const s = clamp(v.start + delta, 0, end - min);
          n.start = s;
          n.duration = end - s;
        }
        d.moved = true;
        this.store.transient();
        break;
      }
      case 'rubber': {
        d.x1 = x;
        d.y1 = y;
        const b0 = this.xToBeat(Math.min(d.x0, x)), b1 = this.xToBeat(Math.max(d.x0, x));
        const pHi = this.yToPitch(Math.min(d.y0, y)), pLo = this.yToPitch(Math.max(d.y0, y));
        this.selection = new Set(d.base);
        for (const n of t.notes) {
          if (n.pitch >= pLo && n.pitch <= pHi && n.start < b1 && n.start + n.duration > b0) this.selection.add(n);
        }
        this.dirty = true;
        break;
      }
      default:
    }
  }

  onUp(e) {
    const d = this.drag;
    this.drag = null;
    try { this.over.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (!d) return;
    if (d.type === 'keys') {
      this.previewVoice?.stop(this.app.engine.now);
      this.previewVoice = null;
      this.keyDown = null;
    }
    const labels = { create: 'Draw note', move: 'Move notes', 'resize-r': 'Resize notes', 'resize-l': 'Resize notes', erase: 'Erase notes', vel: 'Velocity', loop: 'Loop region' };
    if (d.before && labels[d.type]) {
      if (d.type === 'create' && d.moved) this.lastLen = d.note.duration;
      if ((d.type === 'resize-r' || d.type === 'resize-l') && d.primary) this.lastLen = d.primary.duration;
      this.store.pushUndo(d.before, labels[d.type]);
      this.store.touch(labels[d.type]);
    }
    this.dirty = true;
  }

  onDbl(e) {
    const { x, y } = this.pos(e);
    if (this.regionAt(x, y) !== 'grid') return;
    const n = this.noteAt(x, y);
    const t = this.track;
    if (!t || t.type === 'audio') return;
    if (n) {
      this.store.commit('Delete note', () => { t.notes.splice(t.notes.indexOf(n), 1); });
      this.selection.delete(n);
    } else if (this.tool === 'select') {
      const note = newNote(this.yToPitch(y), Math.max(0, this.snapFloor(this.xToBeat(x))), this.defaultLength(), this.velocity);
      this.store.commit('Draw note', () => t.notes.push(note));
      this.selection = new Set([note]);
    }
  }

  onWheel(e) {
    e.preventDefault();
    const { x, y } = this.pos(e);
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * k, dy = e.deltaY * k;
    // Zoom by whichever axis moved: Qt (the desktop app) turns Alt+wheel into a horizontal scroll.
    const d = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
    if (e.ctrlKey || e.metaKey) {
      if (d) this.zoom(d < 0 ? 1.15 : 1 / 1.15, Math.max(KB_W, x));
    } else if (e.altKey) {
      if (d) this.zoomRows(d < 0 ? 1 : -1, y);
    } else if (e.shiftKey) {
      this.scrollX += dy || dx;
    } else {
      this.scrollX += dx;
      this.scrollY += dy;
    }
    this.clampScroll();
    this.dirty = true;
  }

  velAt(x, y) {
    const t = this.track;
    const base = this.velTop + VEL_H - 6;
    const vel = clamp(Math.round(((base - y) / (VEL_H - 16)) * 127), 1, 127);
    const hits = t.notes.filter((n) => Math.abs(this.beatToX(n.start) + 1.5 - x) <= 4);
    if (!hits.length) return;
    const sel = hits.filter((n) => this.selection.has(n));
    const targets = sel.length ? [...this.selection] : hits;
    if (sel.length) {
      const ref = sel[0].velocity;
      for (const n of targets) n.velocity = clamp(n.velocity + (vel - ref), 1, 127);
    } else {
      for (const n of targets) n.velocity = vel;
    }
    this.store.transient();
  }

  // ------------------------------------------------------------------ editing commands

  removeNotes(list) {
    const t = this.track;
    const kill = new Set(list);
    t.notes = t.notes.filter((n) => !kill.has(n));
    for (const n of list) this.selection.delete(n);
    this.store.transient();
  }

  setTool(tool) { this.tool = tool; this.dirty = true; }

  selectAll() {
    const t = this.track;
    if (!t) return;
    this.selection = new Set(t.notes);
    this.dirty = true;
  }

  deleteSelection() {
    const t = this.track;
    if (!t || !this.selection.size) return false;
    const kill = this.selection;
    this.store.commit('Delete notes', () => { t.notes = t.notes.filter((n) => !kill.has(n)); });
    this.selection = new Set();
    return true;
  }

  copy() {
    if (!this.selection.size) return false;
    const notes = [...this.selection];
    const min = minOf(notes, (n) => n.start);
    clipboard = notes.map((n) => ({ pitch: n.pitch, start: n.start - min, duration: n.duration, velocity: n.velocity }));
    return true;
  }

  cut() {
    if (!this.copy()) return false;
    this.deleteSelection();
    return true;
  }

  paste() {
    const t = this.track;
    if (!t || t.type === 'audio' || !clipboard.length) return false;
    const at = this.snapFloor(this.player.currentBeat());
    const added = clipboard.map((c) => newNote(c.pitch, at + c.start, c.duration, c.velocity));
    this.store.commit('Paste', () => t.notes.push(...added));
    this.selection = new Set(added);
    return true;
  }

  duplicate() {
    const t = this.track;
    if (!t || !this.selection.size) return false;
    const notes = [...this.selection];
    const min = minOf(notes, (n) => n.start);
    const max = maxOf(notes, (n) => n.start + n.duration);
    const span = Math.max(this.snap, Math.ceil((max - min) / this.snap - 1e-6) * this.snap);
    const added = notes.map((n) => newNote(n.pitch, n.start + span, n.duration, n.velocity));
    this.store.commit('Duplicate', () => t.notes.push(...added));
    this.selection = new Set(added);
    return true;
  }

  transpose(semi) {
    if (!this.selection.size) return false;
    const notes = [...this.selection];
    const lo = minOf(notes, (n) => n.pitch), hi = maxOf(notes, (n) => n.pitch);
    const s = clamp(semi, -lo, 127 - hi);
    if (!s) return true;
    this.store.commit('Transpose', () => notes.forEach((n) => { n.pitch += s; }));
    if (notes.length === 1) this.app.preview.once(this.track, notes[0].pitch, notes[0].velocity);
    return true;
  }

  nudge(dir) {
    if (!this.selection.size) return false;
    const notes = [...this.selection];
    const min = minOf(notes, (n) => n.start);
    const d = Math.max(dir * this.snap, -min);
    this.store.commit('Move notes', () => notes.forEach((n) => { n.start += d; }));
    return true;
  }

  quantize() {
    const t = this.track;
    if (!t || t.type === 'audio') return 0;
    const notes = this.selection.size ? [...this.selection] : t.notes;
    const q = this.snap;
    this.store.commit('Quantize', () => notes.forEach((n) => {
      n.start = Math.max(0, Math.round(n.start / q) * q);
      n.duration = Math.max(q, Math.round(n.duration / q) * q);
    }));
    return notes.length;
  }
}
