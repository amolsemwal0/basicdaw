// MIDI input/output hub: the server's ALSA bridge (SSE), optional Web MIDI, computer keyboard.
import { Emitter } from '../util.js';
import { api } from '../api.js';

export const MIDINOUS_DATA = 'Midinous Port';
export const MIDINOUS_CLOCK = 'Midinous Clock Port';

export class MidiHub extends Emitter {
  constructor(engine) {
    super();
    this.engine = engine;
    this.status = { available: false, inputs: [], outputs: [], open: [], midinousRunning: false, connected: false };
    this.webAccess = null;
    this.outQueue = new Map();
    this.sentSinceFlush = false;
    this.activity = new Map(); // port -> last message time (ms)
  }

  connect() {
    if (this.es) this.es.close();
    const es = new EventSource('/api/midi/stream');
    this.es = es;
    es.onopen = () => { this.status.connected = true; this.emit('status', this.status); };
    es.onmessage = (e) => {
      let ev;
      try { ev = JSON.parse(e.data); } catch { return; }
      if (ev.type === 'ports') {
        this.status = { ...ev, connected: true };
        this.emit('status', this.status);
      } else if (ev.type === 'midi') {
        this.handle(ev.port, ev.data);
      } else if (ev.type === 'clock') {
        this.emit('clock', ev);
      }
    };
    es.onerror = () => {
      if (this.status.connected) { this.status = { ...this.status, connected: false }; this.emit('status', this.status); }
    };
  }

  /** Raw MIDI bytes from any source. */
  handle(port, data) {
    const st = data[0];
    this.activity.set(port, performance.now());
    this.emit('activity', port);
    if (st >= 0xf0) {
      if (st === 0xfa) this.emit('transport', { port, action: 'start' });
      else if (st === 0xfb) this.emit('transport', { port, action: 'continue' });
      else if (st === 0xfc) this.emit('transport', { port, action: 'stop' });
      return;
    }
    const hi = st & 0xf0;
    const ch = (st & 0x0f) + 1;
    if (hi === 0x90 && data[2] > 0) this.emit('noteon', { port, ch, pitch: data[1], velocity: data[2] });
    else if (hi === 0x80 || hi === 0x90) this.emit('noteoff', { port, ch, pitch: data[1] });
    else if (hi === 0xb0) {
      if (data[1] === 123 || data[1] === 120) this.emit('allnotesoff', { port, ch });
      else this.emit('cc', { port, ch, cc: data[1], value: data[2] });
    }
  }

  get inputs() {
    const web = this.webAccess ? [...this.webAccess.inputs.values()].map((i) => `web:${i.name}`) : [];
    return [...(this.status.inputs || []), ...web];
  }

  get outputs() {
    const web = this.webAccess ? [...this.webAccess.outputs.values()].map((o) => `web:${o.name}`) : [];
    return [...(this.status.outputs || []), ...web];
  }

  findPort(fragment, list = this.status.inputs || []) {
    return list.find((p) => p.includes(fragment)) || null;
  }

  async setWanted(wanted) {
    this.status = { ...this.status, ...(await api.midiInputs(wanted)), connected: this.status.connected };
    this.emit('status', this.status);
  }

  async enableWebMidi() {
    if (!navigator.requestMIDIAccess) throw new Error('This browser has no Web MIDI support - the server bridge still works');
    this.webAccess = await navigator.requestMIDIAccess({ sysex: false });
    const bind = () => {
      for (const input of this.webAccess.inputs.values()) {
        input.onmidimessage = (e) => this.handle(`web:${input.name}`, [...e.data]);
      }
      this.emit('status', this.status);
    };
    this.webAccess.onstatechange = bind;
    bind();
  }

  // -------------------------------------------------------------- output

  /** Queue a note for an external port; `when` is AudioContext time. */
  queueNote(port, channel, pitch, velocity, when, dur) {
    const ctx = this.engine.ctx;
    const lead = when - ctx.currentTime + this.engine.latency;
    const ch = (Math.max(1, Math.min(16, channel)) - 1) & 15;
    if (!this.outQueue.has(port)) this.outQueue.set(port, []);
    const q = this.outQueue.get(port);
    q.push({ delay: Math.max(0, lead), data: [0x90 | ch, pitch, velocity] });
    q.push({ delay: Math.max(0, lead + Math.max(0.01, dur - 0.002)), data: [0x80 | ch, pitch, 0] });
  }

  sendNow(port, data) {
    if (!this.outQueue.has(port)) this.outQueue.set(port, []);
    this.outQueue.get(port).push({ delay: 0, data });
    this.flush();
  }

  flush() {
    for (const [port, events] of this.outQueue) {
      if (!events.length) continue;
      this.sentSinceFlush = true;
      if (port.startsWith('web:')) {
        const out = this.webAccess && [...this.webAccess.outputs.values()].find((o) => `web:${o.name}` === port);
        const now = performance.now();
        if (out) for (const e of events) out.send(e.data, now + e.delay * 1000);
      } else {
        api.midiSend(port, events).catch((err) => this.emit('error', err));
      }
    }
    this.outQueue.clear();
  }

  panic() {
    this.outQueue.clear();
    if (!this.sentSinceFlush) return;
    this.sentSinceFlush = false;
    api.midiFlush().catch(() => {});
    if (this.webAccess) {
      for (const o of this.webAccess.outputs.values()) {
        for (let ch = 0; ch < 16; ch++) o.send([0xb0 | ch, 123, 0]);
      }
    }
  }

  // -------------------------------------------------------------- transport sync (BasicDAW leads)

  clock(action, bpm, ports) {
    return api.midiClock(action, bpm, ports).catch((err) => this.emit('error', err));
  }
}

// -------------------------------------------------------------- computer keyboard piano

const KEYMAP = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16 };

export class QwertyKeyboard {
  constructor(hub) {
    this.hub = hub;
    this.enabled = false;
    this.octave = 4;
    this.velocity = 100;
    this.down = new Map();
  }

  /** Returns true if the key event was consumed. */
  keydown(e) {
    if (!this.enabled || e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.code === 'KeyZ' || e.code === 'KeyX') {
      if (!e.repeat) {
        this.octave = Math.max(0, Math.min(8, this.octave + (e.code === 'KeyX' ? 1 : -1)));
        this.hub.emit('octave', this.octave);
      }
      return true;
    }
    if (e.code === 'KeyC' || e.code === 'KeyV') {
      this.velocity = Math.max(10, Math.min(127, this.velocity + (e.code === 'KeyV' ? 15 : -15)));
      this.hub.emit('qwerty-velocity', this.velocity);
      return true;
    }
    const off = KEYMAP[e.code];
    if (off === undefined) return false;
    if (!e.repeat && !this.down.has(e.code)) {
      const pitch = Math.min(127, (this.octave + 1) * 12 + off);
      this.down.set(e.code, pitch);
      this.hub.handle('Computer keyboard', [0x90, pitch, this.velocity]);
    }
    return true;
  }

  keyup(e) {
    const pitch = this.down.get(e.code);
    if (pitch === undefined) return false;
    this.down.delete(e.code);
    this.hub.handle('Computer keyboard', [0x80, pitch, 0]);
    return true;
  }

  releaseAll() {
    for (const pitch of this.down.values()) this.hub.handle('Computer keyboard', [0x80, pitch, 0]);
    this.down.clear();
  }
}
