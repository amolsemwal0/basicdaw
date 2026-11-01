// Live MIDI: routing incoming notes to tracks, monitoring, recording, Midinous transport sync.
import { getInstrument } from './audio/instruments.js';
import { newNote } from './store.js';
import { settings } from './settings.js';
import { GM_NAMES } from './gm.js';
import { MIDINOUS_CLOCK } from './midi/hub.js';
import { Emitter } from './util.js';

export class Live extends Emitter {
  constructor({ store, engine, player, hub }) {
    super();
    this.store = store;
    this.engine = engine;
    this.player = player;
    this.hub = hub;
    this.voices = new Map();   // `${port}|${ch}|${pitch}` -> [{track, voice, rec}]
    this.held = new Set();     // `${trackId}:${pitch}` currently sounding (for keyboard highlight)
    this.midinousChannels = {};
    this.recBefore = null;

    hub.on('noteon', (e) => this.noteOn(e));
    hub.on('noteoff', (e) => this.noteOff(e));
    hub.on('allnotesoff', (e) => this.releasePort(e.port));
    hub.on('transport', (e) => this.onTransport(e));
    hub.on('clock', (e) => {
      if (settings.get('midinousSync') === 'midinous' && settings.get('followTempo') && e.port.includes('Midinous')) {
        const bpm = Math.round(e.bpm);
        if (bpm >= 20 && bpm <= 400 && Math.abs(bpm - store.project.bpm) >= 1) {
          store.project.bpm = bpm;
          store.touch('tempo');
        }
      }
    });

    player.on('state', (s) => {
      if (s === 'play') {
        if (player.recording && !this.recBefore) this.recBefore = store.snapshot();
        if (settings.get('midinousSync') === 'basicdaw' && !this.fromMidinous) this.sendMidinous('start');
      }
      if ((s === 'pause' || s === 'stop') && settings.get('midinousSync') === 'basicdaw' && !this.fromMidinous) this.sendMidinous('stop');
    });
    player.on('tempo', (bpm) => { if (settings.get('midinousSync') === 'basicdaw') this.sendMidinous('tempo', bpm); });
    player.on('halt', ({ restarting, beat }) => this.finishRecording(restarting, beat));
  }

  setMidinousChannels(channels) { this.midinousChannels = channels || {}; }

  sendMidinous(action, bpm = this.store.project.bpm) {
    const port = this.hub.findPort('Midinous Clock', this.hub.status.outputs || []) || null;
    if (!port) return;
    this.hub.clock(action, bpm, [port]);
  }

  onTransport({ port, action }) {
    if (settings.get('midinousSync') !== 'midinous' || !port.includes('Midinous')) return;
    this.fromMidinous = true;
    if (action === 'start') { this.player.stop(); this.player.seek(0); this.player.play(0); }
    else if (action === 'continue') this.player.play();
    else if (action === 'stop') this.player.pause();
    this.fromMidinous = false;
    this.emit('transport', action);
  }

  /** Tracks that should receive a note from this source. */
  route({ port, ch }) {
    const p = this.store.project;
    if (port.includes('Midinous') && !port.includes(MIDINOUS_CLOCK) && settings.get('midinousRouting') === 'channels') {
      const info = this.midinousChannels[String(ch)];
      const isDrum = info?.category === 'drums';
      const key = isDrum ? 'drums' : ch;
      let t = p.tracks.find((x) => x.midinousChannel === key);
      if (!t) {
        const spec = isDrum
          ? { kind: 'drums', kit: settings.get('defaultKit') }
          : { kind: 'gm', library: settings.get('library'), program: info?.gm ?? 0 };
        const pretty = info?.instrument ? info.instrument.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : GM_NAMES[spec.program];
        const name = isDrum ? 'Midinous Drums' : `Midinous ${ch} · ${pretty}`;
        t = this.store.addTrack({ name, instrument: spec, midinousChannel: key }, { select: false });
        this.emit('track-created', t);
      }
      return [{ track: t, pitchMap: isDrum && info?.drumNote ? () => info.drumNote : null }];
    }
    const armed = p.tracks.filter((t) => t.arm && t.type !== 'audio');
    const list = armed.length ? armed : [this.store.selectedTrack].filter((t) => t && t.type !== 'audio');
    return list.map((track) => ({ track, pitchMap: null }));
  }

  noteOn(e) {
    if (e.port.includes(MIDINOUS_CLOCK)) return; // the clock port's note input is for editing Midinous points
    const key = `${e.port}|${e.ch}|${e.pitch}`;
    this.noteOffKey(key);
    const targets = this.route(e);
    const entries = [];
    const recording = this.player.playing && this.player.recording;
    for (const { track, pitchMap } of targets) {
      const pitch = pitchMap ? pitchMap(e.pitch) : e.pitch;
      let voice = null;
      if (settings.get('monitor') && track.internal !== false) {
        const inst = getInstrument(track.instrument);
        if (inst?.state === 'ready') {
          const ctx = this.engine.resume();
          voice = inst.play(this.engine.channel(track.id).input, pitch, e.velocity, ctx.currentTime + 0.005, null);
        }
      }
      if (track.midiOut) this.hub.sendNow(track.midiOut, [0x90 | ((track.midiOutChannel || 1) - 1), pitch, e.velocity]);
      const rec = recording ? { start: this.player.currentBeat(), velocity: e.velocity } : null;
      entries.push({ track, pitch, voice, rec });
      this.held.add(`${track.id}:${pitch}`);
    }
    this.voices.set(key, entries);
    this.emit('held');
  }

  noteOff(e) { this.noteOffKey(`${e.port}|${e.ch}|${e.pitch}`); }

  noteOffKey(key) {
    const entries = this.voices.get(key);
    if (!entries) return;
    this.voices.delete(key);
    const t = this.engine.now;
    for (const en of entries) {
      en.voice?.stop(t);
      if (en.track.midiOut) this.hub.sendNow(en.track.midiOut, [0x80 | ((en.track.midiOutChannel || 1) - 1), en.pitch, 0]);
      if (en.rec && this.player.playing) this.commitNote(en, this.player.currentBeat());
      this.held.delete(`${en.track.id}:${en.pitch}`);
    }
    this.emit('held');
  }

  commitNote(en, endBeat) {
    let { start } = en.rec;
    const L = this.store.project.loop;
    if (endBeat < start) endBeat = L.enabled ? L.end : start + 0.25; // wrapped around the loop
    let dur = Math.max(1 / 32, endBeat - start);
    if (settings.get('recordQuantize')) {
      const q = 0.25;
      start = Math.round(start / q) * q;
      dur = Math.max(q, Math.round(dur / q) * q);
    }
    if (!this.store.track(en.track.id)) return;
    const lp = this.player.loopOf(en.track);
    if (lp && start >= lp.start) { // overdub into the loop instead of stretching it
      start = lp.start + ((start - lp.start) % lp.length);
      if (start > lp.end - 1 / 32) start = lp.start;
      dur = Math.min(dur, lp.end - start);
    }
    en.track.notes.push(newNote(en.pitch, start, dur, en.rec.velocity));
    this.store.transient();
  }

  releasePort(port) {
    for (const key of [...this.voices.keys()]) if (key.startsWith(`${port}|`)) this.noteOffKey(key);
  }

  releaseAll() {
    for (const key of [...this.voices.keys()]) this.noteOffKey(key);
  }

  finishRecording(restarting, end) {
    for (const entries of this.voices.values()) {
      for (const en of entries) {
        if (en.rec) { this.commitNote(en, end); en.rec = null; }
      }
    }
    if (this.recBefore && !restarting) {
      this.store.pushUndo(this.recBefore, 'Record');
      this.store.touch('record');
      this.recBefore = null;
    }
  }
}
