// Online instruments: GM soundfonts (gleitz/midi-js-soundfonts) and drum kits
// (surikov/webaudiofontdata, Tone.js drum samples), fetched through the server's cache.
import { GM_SLUGS, GM_NAMES, drumKit, isSustained, releaseFor } from '../gm.js';
import { BaseInstrument, b64ToArrayBuffer, decode, fetchText, fetchArrayBuffer, peakOf, velocityGain } from './base.js';
import { SynthInstrument, SynthDrumKit } from './synth.js';
import { clamp } from '../util.js';

const registry = new Map();

export function specKey(spec) {
  if (!spec) return 'none';
  if (spec.kind === 'gm') return `gm:${spec.library}:${spec.program}`;
  if (spec.kind === 'drums') return `drums:${spec.kit}`;
  if (spec.kind === 'synth') return `synth:${spec.preset}`;
  return 'none';
}

/** Path of the main file in the server cache (used for the "downloaded" badges). */
export function cachePath(spec) {
  if (spec.kind === 'gm') return `gleitz/${spec.library}/${GM_SLUGS[spec.program]}-mp3.js`;
  if (spec.kind === 'drums') {
    const kit = drumKit(spec.kit);
    if (kit.source === 'surikov') return `surikov/12836_${kit.file}.js`;
    if (kit.source === 'tonejs') return `tonejs/${kit.dir}/kick.mp3`;
  }
  return null;
}

export function getInstrument(spec, { load = true } = {}) {
  if (!spec) return null;
  const key = specKey(spec);
  let inst = registry.get(key);
  if (!inst) {
    if (spec.kind === 'gm') inst = new SoundfontInstrument(spec);
    else if (spec.kind === 'drums') inst = drumKit(spec.kit).source === 'synth' ? new SynthDrumKit(spec) : new SampleDrumKit(spec);
    else if (spec.kind === 'synth') inst = new SynthInstrument(spec);
    else return null;
    inst.key = key;
    inst.label = spec.kind === 'gm' ? GM_NAMES[spec.program] : spec.kind === 'drums' ? drumKit(spec.kit).name : spec.preset;
    registry.set(key, inst);
  }
  if (load && inst.state === 'idle') inst.load();
  return inst;
}

export const peekInstrument = (spec) => registry.get(specKey(spec)) || null;

// ------------------------------------------------------------------ helpers

const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function nameToMidi(name) {
  const m = /^([A-G])([b#]?)(-?\d)$/.exec(name);
  if (!m) return null;
  return (Number(m[3]) + 1) * 12 + LETTER[m[1]] + (m[2] === 'b' ? -1 : m[2] === '#' ? 1 : 0);
}

function nearestKey(keys, pitch) {
  let best = keys[0], bestD = Infinity;
  for (const k of keys) {
    const d = Math.abs(k - pitch);
    if (d < bestD) { best = k; bestD = d; }
    if (k > pitch) break;
  }
  return best;
}

const loopCache = new WeakMap();
/** Loop region inside the sustained part of a sample, aligned on rising zero crossings. */
function loopPoints(buf) {
  if (loopCache.has(buf)) return loopCache.get(buf);
  const d = buf.getChannelData(0);
  const sr = buf.sampleRate;
  const zc = (i) => {
    for (let k = 0; k < 4000 && i + k + 1 < d.length; k++) if (d[i + k] <= 0 && d[i + k + 1] > 0) return i + k + 1;
    return i;
  };
  let res = null;
  const start = Math.floor(Math.min(1.0, buf.duration * 0.35) * sr);
  const end = Math.floor(buf.length - sr * 0.15);
  if (end - start > sr * 0.4) {
    const ls = zc(start), le = zc(end);
    if (le - ls > sr * 0.3) res = [ls / sr, le / sr];
  }
  loopCache.set(buf, res);
  return res;
}

function oneShotVoice(src, amp, when, end) {
  const voice = {
    end,
    stop() {},
    kill(t) {
      amp.gain.cancelScheduledValues(t);
      amp.gain.setTargetAtTime(0, t, 0.008);
      try { src.stop(t + 0.06); } catch { /* ok */ }
      voice.end = Math.min(voice.end, t + 0.06);
    },
  };
  return voice;
}

// ------------------------------------------------------------------ GM soundfonts

class SoundfontInstrument extends BaseInstrument {
  constructor(spec) {
    super(spec);
    this.samples = new Map();
    this.keys = [];
    this.norm = 1;
    this.sustained = isSustained(spec.program);
    this.release = releaseFor(spec.program);
  }

  async _load() {
    const { library, program } = this.spec;
    const slug = GM_SLUGS[program];
    if (!slug) throw new Error(`Unknown GM program ${program}`);
    const text = await fetchText(`/remote/gleitz/${library}/${slug}-mp3.js`, (p) => this.setProgress(p * 0.7));
    const re = /"([A-G]b?-?\d)"\s*:\s*"data:audio\/[^;]+;base64,([^"]+)"/g;
    const jobs = [];
    let m;
    while ((m = re.exec(text))) {
      const midi = nameToMidi(m[1]);
      if (midi == null) continue;
      const b64 = m[2];
      jobs.push(decode(b64ToArrayBuffer(b64)).then((buf) => this.samples.set(midi, buf), () => {}));
    }
    let done = 0;
    jobs.forEach((j) => j.then(() => this.setProgress(0.7 + 0.3 * (++done / jobs.length))));
    await Promise.all(jobs);
    if (!this.samples.size) throw new Error(`No samples could be decoded for ${GM_NAMES[program]}`);
    this.keys = [...this.samples.keys()].sort((a, b) => a - b);
    const probe = [48, 60, 72].map((p) => peakOf(this.samples.get(nearestKey(this.keys, p))));
    const peak = Math.max(...probe, 1e-4);
    this.norm = clamp(0.55 / peak, 0.5, 24); // the MIDI.js soundfonts are mastered very quietly
  }

  play(dest, pitch, velocity, when, duration) {
    if (this.state !== 'ready') return null;
    const ctx = dest.context;
    const key = nearestKey(this.keys, pitch);
    const buf = this.samples.get(key);
    const rate = 2 ** ((pitch - key) / 12);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const amp = ctx.createGain();
    const peak = velocityGain(velocity) * this.norm;
    amp.gain.setValueAtTime(0, when);
    amp.gain.linearRampToValueAtTime(peak, when + 0.004);
    src.connect(amp).connect(dest);

    const natural = buf.duration / rate;
    const live = duration == null || !Number.isFinite(duration);
    if (this.sustained && (live || duration > natural - 0.2)) {
      const lp = loopPoints(buf);
      if (lp) { src.loop = true; src.loopStart = lp[0]; src.loopEnd = lp[1]; }
    }
    src.start(when);
    const rel = this.release;
    const voice = {
      end: src.loop ? Infinity : when + natural,
      released: false,
      stop(t) {
        if (voice.released) return;
        voice.released = true;
        t = Math.max(t, when + 0.006);
        amp.gain.cancelScheduledValues(t);
        amp.gain.setTargetAtTime(0, t, rel / 4);
        const stopAt = t + rel * 2 + 0.05;
        try { src.stop(stopAt); } catch { /* ok */ }
        voice.end = Math.min(voice.end, stopAt);
      },
      kill(t) {
        voice.released = true;
        amp.gain.cancelScheduledValues(t);
        amp.gain.setTargetAtTime(0, t, 0.008);
        try { src.stop(t + 0.06); } catch { /* ok */ }
        voice.end = Math.min(voice.end, t + 0.06);
      },
    };
    if (!live) voice.stop(when + Math.max(0.02, duration));
    return voice;
  }
}

// ------------------------------------------------------------------ sampled drum kits

// Tone.js kits only have six sounds: map every GM drum note onto them. [sample, rate, gain]
const TONEJS_MAP = {
  35: ['kick', 0.9], 36: ['kick', 1], 37: ['snare', 1.55, 0.55], 38: ['snare', 1], 39: ['snare', 1.2, 0.9], 40: ['snare', 1.08],
  41: ['tom3', 0.88], 42: ['hihat', 1], 43: ['tom3', 1], 44: ['hihat', 0.94, 0.7], 45: ['tom2', 0.94], 46: ['hihat', 0.82, 1.05],
  47: ['tom2', 1.06], 48: ['tom1', 0.94], 49: ['hihat', 0.55, 1.1], 50: ['tom1', 1.08], 51: ['hihat', 0.7, 0.55], 52: ['hihat', 0.5, 0.9],
  53: ['hihat', 0.9, 0.6], 54: ['hihat', 1.35, 0.6], 55: ['hihat', 0.62, 0.8], 56: ['tom1', 1.7, 0.6], 57: ['hihat', 0.58, 1.1],
  58: ['snare', 1.8, 0.4], 59: ['hihat', 0.74, 0.55], 60: ['tom1', 1.45, 0.7], 61: ['tom1', 1.25, 0.7], 62: ['tom2', 1.5, 0.6],
  63: ['tom2', 1.35, 0.7], 64: ['tom3', 1.3, 0.7], 65: ['tom1', 1.6, 0.6], 66: ['tom2', 1.6, 0.6], 67: ['tom1', 2, 0.5],
  68: ['tom1', 1.8, 0.5], 69: ['hihat', 1.2, 0.5], 70: ['hihat', 1.5, 0.45], 71: ['hihat', 1.7, 0.35], 72: ['hihat', 1.5, 0.35],
  73: ['hihat', 1.6, 0.4], 74: ['hihat', 1.3, 0.4], 75: ['snare', 2, 0.4], 76: ['tom1', 2.2, 0.5], 77: ['tom1', 1.9, 0.5],
  78: ['tom2', 1.9, 0.5], 79: ['tom2', 1.7, 0.5], 80: ['hihat', 1.8, 0.4], 81: ['hihat', 1.6, 0.5],
};

const hatChoke = new WeakMap(); // destination node -> open hi-hat voice

class SampleDrumKit extends BaseInstrument {
  constructor(spec) {
    super(spec);
    this.samples = new Map();
    this.keys = [];
    this.norm = 1;
  }

  async _load() {
    const kit = drumKit(this.spec.kit);
    if (kit.source === 'surikov') {
      const notes = Array.from({ length: 47 }, (_, i) => 35 + i);
      let done = 0;
      await Promise.all(notes.map(async (n) => {
        try {
          const text = await fetchText(`/remote/surikov/128${n}_${kit.file}.js`);
          const m = /file\s*:\s*'([^']+)'/.exec(text);
          if (m) this.samples.set(n, { buf: await decode(b64ToArrayBuffer(m[1])), rate: 1, gain: 1 });
        } catch (err) {
          console.warn(`drum ${n}`, err);
        } finally {
          this.setProgress(++done / notes.length);
        }
      }));
    } else {
      const names = ['kick', 'snare', 'hihat', 'tom1', 'tom2', 'tom3'];
      const bufs = {};
      let done = 0;
      await Promise.all(names.map(async (f) => {
        try { bufs[f] = await decode(await fetchArrayBuffer(`/remote/tonejs/${kit.dir}/${f}.mp3`)); } catch (err) { console.warn(f, err); }
        this.setProgress(++done / names.length);
      }));
      for (const [note, [f, rate, gain]] of Object.entries(TONEJS_MAP)) {
        if (bufs[f]) this.samples.set(Number(note), { buf: bufs[f], rate, gain: gain ?? 1 });
      }
    }
    if (!this.samples.size) throw new Error(`Could not download the ${kit.name} drum kit`);
    this.keys = [...this.samples.keys()].sort((a, b) => a - b);
    const ref = [36, 38].map((n) => this.samples.get(n)).filter(Boolean).map((s) => peakOf(s.buf) * s.gain);
    this.norm = clamp(0.75 / Math.max(...ref, 1e-4), 0.5, 5);
  }

  play(dest, pitch, velocity, when) {
    if (this.state !== 'ready') return null;
    const s = this.samples.get(pitch) || this.samples.get(nearestKey(this.keys, pitch));
    const ctx = dest.context;
    const src = ctx.createBufferSource();
    src.buffer = s.buf;
    src.playbackRate.value = s.rate;
    const amp = ctx.createGain();
    amp.gain.value = velocityGain(velocity) * s.gain * this.norm;
    src.connect(amp).connect(dest);
    src.start(when);
    const voice = oneShotVoice(src, amp, when, when + s.buf.duration / s.rate);
    if (pitch === 42 || pitch === 44) {
      const open = hatChoke.get(dest);
      if (open && open.end > when) open.kill(when);
    } else if (pitch === 46) {
      hatChoke.set(dest, voice);
    }
    return voice;
  }
}
