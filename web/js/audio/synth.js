// Built-in synthesizers (work offline): subtractive / FM presets and a synthesised drum kit.
import { BaseInstrument } from './base.js';

const noiseCache = new WeakMap();
function noiseBuffer(ctx) {
  let b = noiseCache.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, b);
  }
  return b;
}

const pulseCache = new WeakMap();
function pulseWave(ctx, duty = 0.25) {
  let w = pulseCache.get(ctx);
  if (!w) {
    const n = 48;
    const re = new Float32Array(n), im = new Float32Array(n);
    for (let k = 1; k < n; k++) {
      re[k] = Math.sin(2 * Math.PI * k * duty) / (k * Math.PI);
      im[k] = (1 - Math.cos(2 * Math.PI * k * duty)) / (k * Math.PI);
    }
    w = ctx.createPeriodicWave(re, im);
    pulseCache.set(ctx, w);
  }
  return w;
}

// osc: [type, detune cents, level]; filter: f (Hz), q, env (Hz added at peak), a/d (s); env: ADSR
export const SYNTH_PRESETS = {
  'saw-lead': { cat: 'Lead', osc: [['sawtooth', -7, 0.5], ['sawtooth', 7, 0.5]], filter: { f: 1600, q: 3, env: 3400, d: 0.32 }, env: { a: 0.004, d: 0.25, s: 0.72, r: 0.18 }, gain: 0.28, vibrato: { rate: 5.5, depth: 7, delay: 0.35 } },
  'square-lead': { cat: 'Lead', osc: [['square', 0, 0.55], ['square', 1203, 0.12]], filter: { f: 2400, q: 1, env: 1800, d: 0.2 }, env: { a: 0.003, d: 0.12, s: 0.8, r: 0.12 }, gain: 0.2 },
  'soft-lead': { cat: 'Lead', osc: [['triangle', 0, 0.8], ['sine', 1200, 0.15]], filter: { f: 4200, q: 0.5 }, env: { a: 0.025, d: 0.2, s: 0.85, r: 0.25 }, gain: 0.45, vibrato: { rate: 5.2, depth: 10, delay: 0.25 } },
  supersaw: { cat: 'Lead', osc: [-24, -15, -7, 0, 7, 15, 24].map((d) => ['sawtooth', d, 0.21]), filter: { f: 3800, q: 1, env: 2800, d: 0.5 }, env: { a: 0.012, d: 0.35, s: 0.8, r: 0.35 }, gain: 0.24, spread: true },
  chip: { cat: 'Lead', osc: [['pulse', 0, 0.6]], env: { a: 0.001, d: 0.06, s: 0.75, r: 0.04 }, gain: 0.2 },
  'warm-pad': { cat: 'Pad', osc: [['sawtooth', -11, 0.35], ['sawtooth', 11, 0.35], ['triangle', -1200, 0.4]], filter: { f: 650, q: 1.2, env: 1000, a: 0.9, d: 2.2 }, env: { a: 0.7, d: 1.2, s: 0.85, r: 1.4 }, gain: 0.3, spread: true },
  'glass-pad': { cat: 'Pad', osc: [['sine', 0, 0.5], ['triangle', 1200, 0.22], ['sine', 1902, 0.12], ['sine', 2400, 0.07]], env: { a: 0.45, d: 1.6, s: 0.7, r: 1.8 }, gain: 0.3, vibrato: { rate: 4.4, depth: 5, delay: 0.6 } },
  'sub-bass': { cat: 'Bass', osc: [['sine', 0, 0.9], ['triangle', 0, 0.22]], filter: { f: 420, q: 0.7 }, env: { a: 0.004, d: 0.3, s: 0.9, r: 0.1 }, gain: 0.62 },
  'reese-bass': { cat: 'Bass', osc: [['sawtooth', -14, 0.5], ['sawtooth', 14, 0.5], ['sine', -1200, 0.45]], filter: { f: 480, q: 3, env: 600, d: 0.4 }, env: { a: 0.008, d: 0.2, s: 0.9, r: 0.14 }, gain: 0.33 },
  acid: { cat: 'Bass', osc: [['sawtooth', 0, 0.85]], filter: { f: 240, q: 15, env: 3000, d: 0.17 }, env: { a: 0.002, d: 0.18, s: 0.55, r: 0.07 }, gain: 0.28 },
  pluck: { cat: 'Keys', osc: [['sawtooth', -6, 0.5], ['square', 6, 0.28]], filter: { f: 360, q: 2.5, env: 5400, d: 0.16 }, env: { a: 0.002, d: 0.45, s: 0, r: 0.25 }, gain: 0.34 },
  'fm-bell': { cat: 'Keys', fm: { ratio: 3.5, index: 5, end: 0.35, decay: 1.6 }, env: { a: 0.002, d: 2.4, s: 0, r: 1.2 }, gain: 0.3 },
  'fm-keys': { cat: 'Keys', fm: { ratio: 1, index: 2.4, end: 0.3, decay: 0.7, tine: 0.07 }, env: { a: 0.002, d: 1.8, s: 0.12, r: 0.35 }, gain: 0.36 },
  'synth-brass': { cat: 'Keys', osc: [['sawtooth', -6, 0.5], ['sawtooth', 6, 0.5]], filter: { f: 480, q: 1.4, env: 3600, a: 0.06, d: 0.45 }, env: { a: 0.03, d: 0.3, s: 0.78, r: 0.22 }, gain: 0.26 },
};

export class SynthInstrument extends BaseInstrument {
  constructor(spec) {
    super(spec);
    this.preset = SYNTH_PRESETS[spec.preset] || SYNTH_PRESETS['saw-lead'];
  }

  async _load() {}

  play(dest, pitch, velocity, when, duration) {
    const ctx = dest.context;
    const P = this.preset;
    const f0 = 440 * 2 ** ((pitch - 69) / 12);
    const vel = velocity / 127;
    const peak = P.gain * (0.25 + 0.75 * vel * vel);
    const { a, d, s, r } = P.env;

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, when);
    amp.gain.linearRampToValueAtTime(peak, when + a);
    amp.gain.setTargetAtTime(peak * s, when + a, d / 3 + 0.001);
    amp.connect(dest);

    let head = amp;
    if (P.filter) {
      const F = P.filter;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = F.q ?? 1;
      const track = Math.sqrt(f0 / 261.6);
      const base = Math.min(16000, F.f * track);
      const top = Math.min(18000, base + (F.env || 0) * (0.35 + 0.65 * vel));
      filter.frequency.setValueAtTime(base, when);
      if (F.env) {
        filter.frequency.linearRampToValueAtTime(top, when + (F.a || 0.004));
        filter.frequency.setTargetAtTime(base, when + (F.a || 0.004), (F.d || 0.3) / 3);
      }
      filter.connect(amp);
      head = filter;
    }

    const sources = [];
    if (P.fm) {
      const car = ctx.createOscillator();
      car.frequency.value = f0;
      const mod = ctx.createOscillator();
      mod.frequency.value = f0 * P.fm.ratio;
      const mg = ctx.createGain();
      const depth = f0 * P.fm.ratio * P.fm.index * (0.4 + 0.6 * vel);
      mg.gain.setValueAtTime(depth, when);
      mg.gain.setTargetAtTime(depth * P.fm.end, when, P.fm.decay / 3);
      mod.connect(mg).connect(car.frequency);
      car.connect(head);
      sources.push(car, mod);
      if (P.fm.tine) {
        const tine = ctx.createOscillator();
        tine.frequency.value = f0 * 14;
        const tg = ctx.createGain();
        tg.gain.setValueAtTime(P.fm.tine * vel, when);
        tg.gain.setTargetAtTime(0, when, 0.03);
        tine.connect(tg).connect(head);
        sources.push(tine);
      }
    } else {
      P.osc.forEach(([type, det, lvl], i) => {
        const o = ctx.createOscillator();
        if (type === 'pulse') o.setPeriodicWave(pulseWave(ctx)); else o.type = type;
        o.frequency.value = f0;
        o.detune.value = det;
        const g = ctx.createGain();
        g.gain.value = lvl;
        o.connect(g);
        if (P.spread && P.osc.length > 1) {
          const pn = ctx.createStereoPanner();
          pn.pan.value = (i / (P.osc.length - 1)) * 1.4 - 0.7;
          g.connect(pn).connect(head);
        } else {
          g.connect(head);
        }
        sources.push(o);
      });
    }

    if (P.vibrato) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = P.vibrato.rate;
      const lg = ctx.createGain();
      lg.gain.setValueAtTime(0, when);
      lg.gain.linearRampToValueAtTime(P.vibrato.depth, when + P.vibrato.delay + 0.4);
      lfo.connect(lg);
      for (const o of sources) if (o.detune) lg.connect(o.detune);
      sources.push(lfo);
    }

    sources.forEach((o) => o.start(when));
    const voice = {
      end: Infinity,
      released: false,
      stop(t) {
        if (voice.released) return;
        voice.released = true;
        t = Math.max(t, when + 0.01);
        amp.gain.cancelScheduledValues(t);
        amp.gain.setTargetAtTime(0, t, r / 3 + 0.002);
        const stopAt = t + r * 2.5 + 0.05;
        sources.forEach((o) => { try { o.stop(stopAt); } catch { /* already stopped */ } });
        voice.end = stopAt;
      },
      kill(t) {
        voice.released = true;
        amp.gain.cancelScheduledValues(t);
        amp.gain.setTargetAtTime(0, t, 0.008);
        sources.forEach((o) => { try { o.stop(t + 0.06); } catch { /* already stopped */ } });
        voice.end = t + 0.06;
      },
    };
    if (duration != null && Number.isFinite(duration)) voice.stop(when + Math.max(0.02, duration));
    return voice;
  }
}

// ------------------------------------------------------------------ synth drums

const TOM_FREQ = { 41: 82, 43: 98, 45: 110, 47: 131, 48: 147, 50: 175, 60: 400, 61: 300, 62: 330, 63: 280, 64: 220, 65: 360, 66: 260 };

export class SynthDrumKit extends BaseInstrument {
  async _load() {}

  play(dest, pitch, velocity, when) {
    const ctx = dest.context;
    const v = velocity / 127;
    const out = ctx.createGain();
    out.gain.value = 0.85 * (0.25 + 0.75 * v);
    out.connect(dest);
    const nodes = [];
    let len = 0.4;

    const env = (g, peak, decay, at = when) => {
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(peak, at + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    };
    const noise = (type, freq, q = 0.8) => {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx);
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      src.connect(f).connect(g).connect(out);
      nodes.push(src);
      return g;
    };
    const tone = (type, f1, f2, decay, peak = 1, sweep = 0.1) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f1, when);
      if (f2 !== f1) o.frequency.exponentialRampToValueAtTime(f2, when + sweep);
      const g = ctx.createGain();
      env(g, peak, decay);
      o.connect(g).connect(out);
      nodes.push(o);
    };

    if (pitch === 35 || pitch === 36) {
      tone('sine', 165, 44, 0.5, 1.2, 0.11);
      env(noise('highpass', 3000), 0.25, 0.012);
      len = 0.55;
    } else if (pitch === 38 || pitch === 40) {
      env(noise('highpass', 1400), 0.75, 0.2);
      tone('triangle', 200, 165, 0.12, 0.7, 0.05);
      len = 0.25;
    } else if (pitch === 37) {
      tone('square', 1750, 1750, 0.03, 0.4);
      len = 0.05;
    } else if (pitch === 39) {
      const g = noise('bandpass', 1250, 1.1);
      g.gain.setValueAtTime(0.0001, when);
      for (const [dt, p] of [[0, 0.9], [0.011, 0.75], [0.023, 0.85]]) {
        g.gain.exponentialRampToValueAtTime(p, when + dt + 0.001);
        g.gain.exponentialRampToValueAtTime(0.08, when + dt + 0.009);
      }
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.2);
      len = 0.22;
    } else if (pitch === 42 || pitch === 44) {
      env(noise('highpass', 7600, 0.6), 0.55, 0.05);
      len = 0.06;
    } else if (pitch === 46) {
      env(noise('highpass', 7000, 0.6), 0.5, 0.38);
      len = 0.4;
    } else if ([49, 52, 55, 57].includes(pitch)) {
      env(noise('highpass', 5200, 0.4), 0.45, 1.3);
      len = 1.35;
    } else if ([51, 53, 59].includes(pitch)) {
      env(noise('bandpass', 7800, 0.7), 0.35, 0.7);
      tone('square', 620, 620, 0.5, 0.05);
      len = 0.75;
    } else if (pitch === 56) {
      tone('square', 545, 545, 0.28, 0.25);
      tone('square', 815, 815, 0.28, 0.25);
      len = 0.3;
    } else if ([54, 69, 70, 73, 74].includes(pitch)) {
      env(noise('highpass', 9000, 0.7), 0.4, pitch === 54 ? 0.16 : 0.07);
      len = 0.18;
    } else if ([75, 76, 77].includes(pitch)) {
      tone('sine', pitch === 75 ? 2500 : pitch === 76 ? 1900 : 1500, pitch === 75 ? 2500 : 1300, 0.06, 0.7, 0.03);
      len = 0.08;
    } else if ([80, 81].includes(pitch)) {
      tone('sine', 4200, 4200, pitch === 81 ? 1 : 0.15, 0.25);
      len = pitch === 81 ? 1 : 0.16;
    } else {
      const f = TOM_FREQ[pitch] || 100 + (pitch - 40) * 8;
      tone('sine', f * 1.35, f, pitch >= 60 ? 0.18 : 0.38, 1, 0.08);
      len = 0.4;
    }

    nodes.forEach((n) => { n.start(when); try { n.stop(when + len + 0.05); } catch { /* ok */ } });
    const voice = {
      end: when + len + 0.05,
      stop() {},
      kill(t) {
        out.gain.cancelScheduledValues(t);
        out.gain.setTargetAtTime(0, t, 0.006);
        nodes.forEach((n) => { try { n.stop(t + 0.05); } catch { /* ok */ } });
        voice.end = t + 0.05;
      },
    };
    return voice;
  }
}
