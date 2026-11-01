// Transport + look-ahead scheduler (notes, audio clips, metronome, MIDI out).
import { Emitter } from '../util.js';
import { audibleTrackIds, beatsPerBar, songEndBeats, loopFillEnd, trackLoop, forEachPlayedNote } from '../store.js';
import { getInstrument } from './instruments.js';
import { mediaEntry } from './media.js';

const LOOKAHEAD = 0.12;  // seconds scheduled ahead of the audio clock
const INTERVAL = 25;     // ms between scheduler runs

export class Player extends Emitter {
  constructor(engine, store, midi) {
    super();
    this.engine = engine;
    this.store = store;
    this.midi = midi;
    this.playing = false;
    this.recording = false;
    this.metronome = false;
    this.position = 0;
    this.startPosition = 0;
    this.voices = new Set();
    this.clipSources = new Set();
    this.sorted = new Map();
    this.anchors = [];
    this.recLoops = null;  // loop windows frozen for the take being recorded
  }

  get project() { return this.store.project; }
  spb() { return 60 / this.project.bpm; }

  sortedNotes(track) {
    let c = this.sorted.get(track.id);
    if (!c || c.version !== this.store.version || c.ref !== track.notes) {
      c = { version: this.store.version, ref: track.notes, notes: [...track.notes].sort((a, b) => a.start - b.start) };
      this.sorted.set(track.id, c);
    }
    return c.notes;
  }

  /** Song end and loop windows, recomputed when the project changes. */
  layout() {
    let l = this._layout;
    if (!l || l.version !== this.store.version) {
      const p = this.project;
      const end = songEndBeats(p);
      l = this._layout = { version: this.store.version, end, fillEnd: loopFillEnd(p, end), loops: new Map(p.tracks.map((t) => [t.id, trackLoop(p, t)])) };
    }
    return l;
  }

  /** The loop a track plays with right now. Frozen while recording, so a take doesn't move it. */
  loopOf(track) {
    return (this.recLoops || this.layout().loops).get(track.id) ?? null;
  }

  /** Looping tracks repeat until here; while recording they keep going so you can play over them. */
  loopUntil() {
    return this.playing && (this.recording || this.keepRunning) ? Infinity : this.layout().fillEnd;
  }

  play(fromBeat = this.position) {
    if (this.playing) return;
    const ctx = this.engine.resume();
    this.engine.sync(this.project);
    const t0 = ctx.currentTime + 0.05;
    this.playing = true;
    this.startPosition = fromBeat;
    this.position = fromBeat;
    this.nextBeat = fromBeat;
    this.nextTime = t0;
    this.anchors = [{ time: t0, beat: fromBeat, spb: this.spb() }];
    this._startClipsAt(fromBeat, t0);
    this._tick();
    this.timer = setInterval(() => this._tick(), INTERVAL);
    this.emit('state', 'play');
  }

  toggle() { if (this.playing) this.pause(); else this.play(); }

  pause() {
    if (!this.playing) return;
    this.position = this.currentBeat();
    this._halt();
    this.emit('state', 'pause');
  }

  stop() {
    if (this.playing) {
      this._halt();
      this.position = this.startPosition;
    } else {
      this.position = 0;
    }
    this.emit('state', 'stop');
    this.emit('seek');
  }

  seek(beat) {
    beat = Math.max(0, beat);
    if (this.playing) {
      this._halt(true);
      this.play(beat);
    } else {
      this.position = beat;
    }
    this.emit('seek');
  }

  _halt(restarting = false) {
    const beat = this.currentBeat();
    clearInterval(this.timer);
    this.playing = false;
    if (!restarting) this.recLoops = null;
    const t = this.engine.now;
    for (const v of this.voices) v.kill(t);
    this.voices.clear();
    for (const s of this.clipSources) { try { s.stop(t + 0.02); } catch { /* ok */ } }
    this.clipSources.clear();
    this.midi?.panic();
    this.emit('halt', { restarting, beat });
  }

  /** Song position (beats) the listener hears right now. */
  currentBeat(compensate = true) {
    if (!this.playing) return this.position;
    const now = this.engine.now - (compensate ? this.engine.latency : 0);
    let a = this.anchors[0];
    if (!a) return this.position;
    if (now < a.time) return a.beat;
    for (const x of this.anchors) { if (x.time <= now) a = x; else break; }
    return Math.max(0, a.beat + (now - a.time) / a.spb);
  }

  currentSeconds() {
    return this.currentBeat() * this.spb();
  }

  _tick() {
    const ctx = this.engine.ctx;
    const p = this.project;
    const horizon = ctx.currentTime + LOOKAHEAD;
    if (!this.recording) this.recLoops = null;
    else if (!this.recLoops) this.recLoops = new Map(this.layout().loops);
    let guard = 0;
    while (this.nextTime < horizon && guard++ < 64) {
      const spb = this.spb();
      const last = this.anchors[this.anchors.length - 1];
      if (last && Math.abs(last.spb - spb) > 1e-9) {
        this.anchors.push({ time: this.nextTime, beat: this.nextBeat, spb });
        this.emit('tempo', p.bpm);
      }
      let endTime = horizon;
      let endBeat = this.nextBeat + (endTime - this.nextTime) / spb;
      const L = p.loop;
      const looping = L.enabled && L.end - L.start > 0.05 && this.nextBeat < L.end;
      let wrap = false;
      if (looping && endBeat >= L.end) {
        endBeat = L.end;
        endTime = this.nextTime + (L.end - this.nextBeat) * spb;
        wrap = true;
      }
      this._scheduleRange(this.nextBeat, endBeat, this.nextTime, spb);
      if (wrap) {
        for (const s of this.clipSources) { try { s.stop(endTime); } catch { /* ok */ } }
        this.clipSources.clear();
        this.nextBeat = L.start;
        this.nextTime = endTime;
        this.anchors.push({ time: endTime, beat: L.start, spb });
        this._startClipsAt(L.start, endTime);
        this.emit('wrap', { time: endTime, from: L.end, to: L.start });
      } else {
        this.nextBeat = endBeat;
        this.nextTime = endTime;
      }
    }
    const now = ctx.currentTime;
    while (this.anchors.length > 1 && this.anchors[1].time <= now - 1) this.anchors.shift();
    for (const v of this.voices) if (v.end < now) this.voices.delete(v);
    this.midi?.flush();

    if (!this.recording && !p.loop.enabled && !this.keepRunning) {
      const { end } = this.layout();
      if (end > 0 && this.currentBeat(false) > end + 0.5) this.stop();
    }
  }

  _scheduleRange(b0, b1, t0, spb) {
    const p = this.project;
    const audible = audibleTrackIds(p);
    const until = this.loopUntil();
    for (const track of p.tracks) {
      if (!audible.has(track.id)) continue;
      const ch = this.engine.channel(track.id);
      if (track.type === 'audio') {
        for (const c of track.clips) if (c.start >= b0 && c.start < b1) this._startClip(c, t0 + (c.start - b0) * spb, 0, ch);
        continue;
      }
      const inst = track.internal !== false ? getInstrument(track.instrument) : null;
      forEachPlayedNote(this.sortedNotes(track), this.loopOf(track), b0, b1, until, (n, start) => {
        const when = t0 + (start - b0) * spb;
        const dur = n.duration * spb;
        if (inst && inst.state === 'ready') {
          const v = inst.play(ch.input, n.pitch, n.velocity, when, dur);
          if (v) this.voices.add(v);
        }
        if (track.midiOut) this.midi?.queueNote(track.midiOut, track.midiOutChannel || 1, n.pitch, n.velocity, when, dur);
        this.emit('note', { trackId: track.id, pitch: n.pitch, when, end: when + dur });
      });
    }
    if (this.metronome) {
      const bpb = beatsPerBar(p);
      const step = 4 / p.timeSig[1];
      for (let k = Math.ceil(b0 / step - 1e-9) * step; k < b1 - 1e-9; k += step) {
        const bar = k / bpb;
        this._click(t0 + (k - b0) * spb, Math.abs(bar - Math.round(bar)) < 1e-6);
      }
    }
  }

  _click(when, accent) {
    const ctx = this.engine.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(accent ? 0.42 : 0.26, when + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.07);
    o.connect(g).connect(this.engine.graph.input);
    o.start(when);
    o.stop(when + 0.08);
  }

  _startClipsAt(beat, time) {
    const p = this.project;
    const audible = audibleTrackIds(p);
    const spb = this.spb();
    for (const track of p.tracks) {
      if (track.type !== 'audio' || !audible.has(track.id)) continue;
      for (const c of track.clips) {
        const len = c.duration / spb;
        if (c.start < beat - 1e-6 && beat < c.start + len - 1e-6) this._startClip(c, time, (beat - c.start) * spb, this.engine.channel(track.id));
      }
    }
  }

  _startClip(clip, when, offsetSec, ch) {
    const e = mediaEntry(this.project.id, clip.file);
    if (!e || e.state !== 'ready') return;
    const ctx = this.engine.ctx;
    const dur = clip.duration - offsetSec;
    if (dur <= 0.01) return;
    const src = ctx.createBufferSource();
    src.buffer = e.buffer;
    const g = ctx.createGain();
    g.gain.value = clip.gain ?? 1;
    src.connect(g).connect(ch.input);
    src.start(Math.max(when, ctx.currentTime), (clip.offset || 0) + offsetSec, dur);
    this.clipSources.add(src);
    src.onended = () => this.clipSources.delete(src);
  }
}
