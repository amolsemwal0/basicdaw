// Web Audio graph: master bus with limiter + reverb, one channel strip per track.
import { bus } from '../util.js';
import { audibleTrackIds } from '../store.js';

export const volumeToGain = (v) => v * v * 1.25;
export const gainToDb = (g) => (g <= 0.00001 ? -Infinity : 20 * Math.log10(g));
export const fmtDb = (v) => { const db = gainToDb(volumeToGain(v)); return db === -Infinity ? '-∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`; };

function makeImpulse(ctx, seconds = 2.6, decay = 3.2) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const pre = Math.floor(rate * 0.012);
  const buf = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / (len - pre);
      lp += 0.55 * ((Math.random() * 2 - 1) - lp);  // soften the highs a little
      d[i] = lp * Math.pow(1 - t, decay) * (i < pre + 200 ? (i - pre) / 200 : 1);
    }
  }
  return buf;
}

export function buildMaster(ctx) {
  const input = ctx.createGain();
  const master = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 3;
  limiter.ratio.value = 16;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.2;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.78;
  input.connect(master).connect(limiter).connect(analyser).connect(ctx.destination);

  const reverbIn = ctx.createGain();
  const convolver = ctx.createConvolver();
  convolver.buffer = makeImpulse(ctx);
  const reverbOut = ctx.createGain();
  reverbOut.gain.value = 0.85;
  reverbIn.connect(convolver).connect(reverbOut).connect(input);
  return { ctx, input, master, limiter, analyser, reverbIn };
}

export function createChannel(graph) {
  const ctx = graph.ctx;
  const input = ctx.createGain();
  const volume = ctx.createGain();
  const pan = ctx.createStereoPanner();
  const send = ctx.createGain();
  send.gain.value = 0;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  input.connect(volume).connect(pan);
  pan.connect(graph.input);
  pan.connect(analyser);
  pan.connect(send).connect(graph.reverbIn);
  return { input, volume, pan, send, analyser, data: new Float32Array(256) };
}

export function applyChannel(ch, track, audible, ctx, immediate = false) {
  const g = audible ? volumeToGain(track.volume) : 0;
  if (immediate) {
    ch.volume.gain.value = g;
    ch.pan.pan.value = track.pan;
    ch.send.gain.value = track.reverb ?? 0;
    return;
  }
  const t = ctx.currentTime;
  ch.volume.gain.setTargetAtTime(g, t, 0.012);
  ch.pan.pan.setTargetAtTime(track.pan, t, 0.012);
  ch.send.gain.setTargetAtTime(track.reverb ?? 0, t, 0.012);
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.graph = null;
    this.channels = new Map();
  }

  /** Create the context (suspended until a user gesture) so instruments can decode early. */
  init() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.graph = buildMaster(this.ctx);
    bus.emit('audio-ready', this.ctx);
    return this.ctx;
  }

  resume() {
    this.init();
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  get now() { return this.ctx ? this.ctx.currentTime : 0; }
  get running() { return this.ctx?.state === 'running'; }
  /** seconds between scheduling a sound and hearing it */
  get latency() { return this.ctx ? (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0) : 0; }

  channel(trackId) {
    this.init();
    let ch = this.channels.get(trackId);
    if (!ch) {
      ch = createChannel(this.graph);
      if (trackId.startsWith('__')) applyChannel(ch, { volume: 0.8, pan: 0, reverb: 0.1 }, true, this.ctx, true);
      this.channels.set(trackId, ch);
    }
    return ch;
  }

  sync(project) {
    this.init();
    const audible = audibleTrackIds(project);
    const ids = new Set();
    for (const t of project.tracks) {
      ids.add(t.id);
      applyChannel(this.channel(t.id), t, audible.has(t.id), this.ctx);
    }
    for (const [id, ch] of this.channels) {
      if (!ids.has(id) && !id.startsWith('__')) {
        ch.volume.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
        setTimeout(() => { try { ch.pan.disconnect(); } catch { /* gone */ } }, 400);
        this.channels.delete(id);
      }
    }
    this.graph.master.gain.setTargetAtTime(volumeToGain(project.masterVolume ?? 0.85), this.ctx.currentTime, 0.02);
  }

  level(trackId) {
    const ch = this.channels.get(trackId);
    if (!ch) return 0;
    ch.analyser.getFloatTimeDomainData(ch.data);
    let peak = 0;
    for (let i = 0; i < ch.data.length; i++) { const v = Math.abs(ch.data[i]); if (v > peak) peak = v; }
    return peak;
  }
}
