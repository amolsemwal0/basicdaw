// Project model, selection and undo/redo.
import { Emitter, TRACK_COLORS, uid, clamp, lowerBound } from './util.js';

export const PROJECT_FORMAT = 'basicdaw';

export function newProject(name = 'Untitled') {
  return {
    format: PROJECT_FORMAT,
    version: 1,
    id: null,
    name,
    bpm: 120,
    timeSig: [4, 4],
    key: { root: 0, scale: 'chromatic' },
    loop: { enabled: false, start: 0, end: 16 },
    masterVolume: 0.85,
    tracks: [],
  };
}

export function newTrack(opts = {}) {
  return {
    id: uid('t'),
    name: 'Track',
    type: 'instrument',          // 'instrument' | 'audio'
    color: TRACK_COLORS[0],
    instrument: { kind: 'gm', library: 'FluidR3_GM', program: 0 },
    volume: 0.8,
    pan: 0,
    reverb: 0.12,
    mute: false,
    solo: false,
    arm: false,
    loop: false,                 // repeat the notes until the song ends
    notes: [],
    clips: [],
    internal: true,              // play the built-in instrument
    midiOut: null,               // external MIDI port name
    midiOutChannel: 1,
    midinousChannel: null,       // Midinous channel routed to this track (live link)
    ...opts,
  };
}

export const newNote = (pitch, start, duration, velocity = 100) =>
  ({ id: uid('n'), pitch: clamp(Math.round(pitch), 0, 127), start: Math.max(0, start), duration: Math.max(1 / 64, duration), velocity: clamp(Math.round(velocity), 1, 127) });

/** Fill defaults so older / imported files load safely. */
export function normalizeProject(p) {
  const base = newProject(p?.name || 'Untitled');
  const out = { ...base, ...p, format: PROJECT_FORMAT };
  out.bpm = clamp(Number(out.bpm) || 120, 20, 400);
  if (!Array.isArray(out.timeSig) || out.timeSig.length !== 2) out.timeSig = [4, 4];
  out.key = { ...base.key, ...(p?.key || {}) };
  out.loop = { ...base.loop, ...(p?.loop || {}) };
  out.tracks = (Array.isArray(p?.tracks) ? p.tracks : []).map((t, i) => {
    const tr = newTrack({ color: TRACK_COLORS[i % TRACK_COLORS.length] });
    Object.assign(tr, t);
    tr.id = t.id || uid('t');
    tr.notes = (t.notes || []).filter((n) => Number.isFinite(n.pitch) && Number.isFinite(n.start)).map((n) => ({
      id: n.id || uid('n'), pitch: clamp(Math.round(n.pitch), 0, 127), start: Math.max(0, +n.start),
      duration: Math.max(1 / 128, +n.duration || 0.25), velocity: clamp(Math.round(n.velocity ?? 100), 1, 127),
    }));
    tr.clips = (t.clips || []).map((c) => ({ id: c.id || uid('c'), gain: 1, offset: 0, ...c }));
    if (tr.type === 'audio') tr.instrument = null;
    tr.loop = tr.type !== 'audio' && !!tr.loop;
    return tr;
  });
  return out;
}

export const beatsPerBar = (project) => project.timeSig[0] * (4 / project.timeSig[1]);

/** The whole bars a track's notes cover ({start, end} in beats), or null without notes. */
export function trackBars(project, track) {
  if (!track.notes.length) return null;
  const bpb = beatsPerBar(project);
  let lo = Infinity, hi = -Infinity;
  for (const n of track.notes) { if (n.start < lo) lo = n.start; if (n.start + n.duration > hi) hi = n.start + n.duration; }
  const start = Math.floor(lo / bpb + 1e-6) * bpb;
  return { start, end: Math.max(Math.ceil(hi / bpb - 1e-6) * bpb, start + bpb) };
}

/** A looping track repeats those bars: {start, end, length}, or null when it doesn't loop. */
export function trackLoop(project, track) {
  if (!track.loop || track.type === 'audio') return null;
  const r = trackBars(project, track);
  return r && { ...r, length: r.end - r.start };
}

/** Where the song ends. A looping track counts with its first pass; its repeats fill up to this point. */
export function songEndBeats(project) {
  let end = 0;
  const spb = 60 / project.bpm;
  for (const t of project.tracks) {
    const lp = trackLoop(project, t);
    if (lp) end = Math.max(end, lp.end);
    else for (const n of t.notes) end = Math.max(end, n.start + n.duration);
    for (const c of t.clips || []) end = Math.max(end, c.start + (c.duration || 0) / spb);
  }
  return end;
}

/** Looping tracks repeat up to here: the end of the song, or of the cycle region when that is later. */
export function loopFillEnd(project, end = songEndBeats(project)) {
  return project.loop.enabled ? Math.max(end, project.loop.end) : end;
}

/** Offsets (beats) of a loop's repeats after its first pass that overlap [from, to) and start before `until`. */
export function loopRepeats(loop, from, to, until) {
  const out = [];
  const hi = Math.min(to, until);
  for (let k = Math.max(1, Math.floor((from - loop.start) / loop.length)); loop.start + k * loop.length < hi; k++) out.push(k * loop.length);
  return out;
}

/**
 * Calls fn(note, beat) for every note a track plays with an onset in [from, to): its own notes and,
 * with a loop, the repeats that start before `until` (`to` or `until` must be finite).
 * `notes` must be sorted by start.
 */
export function forEachPlayedNote(notes, loop, from, to, until, fn) {
  if (!loop) {
    for (let i = lowerBound(notes, from, (n) => n.start); i < notes.length && notes[i].start < to; i++) fn(notes[i], notes[i].start);
    return;
  }
  const hi = Math.min(to, until);
  for (let k = Math.max(0, Math.floor((from - loop.start) / loop.length)); loop.start + k * loop.length < hi; k++) {
    const off = k * loop.length;
    const b = Math.min(loop.end, hi - off);
    for (let i = lowerBound(notes, Math.max(loop.start, from - off), (n) => n.start); i < notes.length && notes[i].start < b; i++) fn(notes[i], notes[i].start + off);
  }
}

/** A track's notes as they sound, with a looping track's repeats written out up to `until`. */
export function playedNotes(project, track, until = songEndBeats(project)) {
  const out = [];
  const notes = [...track.notes].sort((a, b) => a.start - b.start);
  forEachPlayedNote(notes, trackLoop(project, track), 0, Infinity, until, (n, start) => {
    out.push({ pitch: n.pitch, start, duration: n.duration, velocity: n.velocity });
  });
  return out;
}

/** Which tracks are audible given mute / solo. */
export function audibleTrackIds(project) {
  const anySolo = project.tracks.some((t) => t.solo);
  return new Set(project.tracks.filter((t) => (anySolo ? t.solo : !t.mute)).map((t) => t.id));
}

const UNDO_KEYS = ['name', 'bpm', 'timeSig', 'key', 'loop', 'tracks'];

export class Store extends Emitter {
  constructor() {
    super();
    this.project = newProject();
    this.selectedTrackId = null;
    this.dirty = false;
    this.undoStack = [];
    this.redoStack = [];
    this.version = 0;
  }

  setProject(project, { dirty = false } = {}) {
    this.project = normalizeProject(project);
    this.selectedTrackId = this.project.tracks[0]?.id ?? null;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = dirty;
    this.version++;
    this.emit('project');
    this.emit('select');
    this.emit('dirty', this.dirty);
  }

  snapshot() {
    const p = this.project;
    return JSON.stringify(Object.fromEntries(UNDO_KEYS.map((k) => [k, p[k]])));
  }

  /** Apply a change as one undo step. */
  commit(label, fn) {
    const before = this.snapshot();
    fn?.(this.project);
    this.pushUndo(before, label);
    this.touch(label);
  }

  /** Register an undo step for a change already applied (e.g. after a drag). */
  pushUndo(before, label = 'Edit') {
    if (before === this.snapshot()) return;
    this.undoStack.push({ before, label });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.emit('history');
  }

  touch(kind = 'edit') {
    this.version++;
    if (!this.dirty) { this.dirty = true; this.emit('dirty', true); }
    this.emit('change', { kind });
  }

  /** Cheap notification during drags (no undo, no structural re-render). */
  transient() {
    this.version++;
    if (!this.dirty) { this.dirty = true; this.emit('dirty', true); }
    this.emit('change', { kind: 'transient' });
  }

  markSaved() {
    this.dirty = false;
    this.emit('dirty', false);
  }

  _restore(json) {
    Object.assign(this.project, JSON.parse(json));
    if (!this.project.tracks.some((t) => t.id === this.selectedTrackId)) {
      this.selectedTrackId = this.project.tracks[0]?.id ?? null;
      this.emit('select');
    }
    this.touch('undo');
    this.emit('restore');
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push({ before: this.snapshot(), label: e.label });
    this._restore(e.before);
    this.emit('history');
    return e.label;
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push({ before: this.snapshot(), label: e.label });
    this._restore(e.before);
    this.emit('history');
    return e.label;
  }

  track(id) { return this.project.tracks.find((t) => t.id === id) || null; }
  get selectedTrack() { return this.track(this.selectedTrackId); }

  select(id) {
    if (this.selectedTrackId === id) return;
    this.selectedTrackId = id;
    this.emit('select');
  }

  nextColor() {
    const used = this.project.tracks.map((t) => t.color);
    return TRACK_COLORS.find((c) => !used.includes(c)) || TRACK_COLORS[this.project.tracks.length % TRACK_COLORS.length];
  }

  addTrack(opts, { select = true, index } = {}) {
    const t = newTrack({ color: this.nextColor(), ...opts });
    this.commit('Add track', (p) => {
      if (index == null || index >= p.tracks.length) p.tracks.push(t); else p.tracks.splice(Math.max(0, index), 0, t);
    });
    if (select) this.select(t.id);
    return t;
  }

  removeTrack(id) {
    const idx = this.project.tracks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.commit('Delete track', (p) => p.tracks.splice(idx, 1));
    if (this.selectedTrackId === id) this.select(this.project.tracks[Math.min(idx, this.project.tracks.length - 1)]?.id ?? null);
  }

  moveTrack(id, toIndex) {
    const p = this.project;
    const from = p.tracks.findIndex((t) => t.id === id);
    if (from < 0) return;
    this.commit('Move track', () => {
      const [t] = p.tracks.splice(from, 1);
      p.tracks.splice(clamp(toIndex > from ? toIndex - 1 : toIndex, 0, p.tracks.length), 0, t);
    });
  }

  duplicateTrack(id) {
    const src = this.track(id);
    if (!src) return null;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = uid('t');
    copy.name = `${src.name} copy`;
    copy.notes.forEach((n) => { n.id = uid('n'); });
    copy.clips.forEach((c) => { c.id = uid('c'); });
    copy.solo = false;
    copy.arm = false;
    const idx = this.project.tracks.indexOf(src);
    this.commit('Duplicate track', (p) => p.tracks.splice(idx + 1, 0, copy));
    this.select(copy.id);
    return copy;
  }
}
