// Shared instrument plumbing: load state, decoding, downloads with progress.
import { bus } from '../util.js';

let decodeCtx = null;
export function setDecodeContext(ctx) { decodeCtx = ctx; }

export const velocityGain = (v) => 0.06 + 0.94 * Math.pow(v / 127, 1.6);

export class BaseInstrument {
  constructor(spec) {
    this.spec = spec;
    this.state = 'idle';     // idle | loading | ready | error
    this.ready = null;
    this.error = null;
    this.progress = 0;
  }

  load() {
    if (!this.ready) {
      this.state = 'loading';
      bus.emit('instrument-state', this);
      this.ready = this._load().then(
        () => { this.state = 'ready'; this.progress = 1; bus.emit('instrument-state', this); },
        (err) => { this.state = 'error'; this.error = err; bus.emit('instrument-state', this); console.warn('instrument load failed', err); },
      );
    }
    return this.ready;
  }

  retry() {
    if (this.state !== 'error') return this.ready;
    this.ready = null;
    this.state = 'idle';
    return this.load();
  }

  setProgress(p) {
    this.progress = p;
    bus.emit('instrument-progress', this);
  }

  async _load() {}
}

export function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function decode(arrayBuffer) {
  if (!decodeCtx) throw new Error('Audio is not initialised');
  return decodeCtx.decodeAudioData(arrayBuffer);
}

async function fetchChecked(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return res;
}

/** Download with byte progress (the server always sends Content-Length). */
export async function fetchBytes(url, onProgress) {
  const res = await fetchChecked(url);
  const total = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body || !total || !onProgress) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const out = new Uint8Array(total);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > out.length) { // length mismatch: fall back to growing
      const bigger = new Uint8Array(Math.max(out.length * 2, got + value.length));
      bigger.set(out.subarray(0, got));
      return finishGrow(reader, bigger, got, value, onProgress, total);
    }
    out.set(value, got);
    got += value.length;
    onProgress(Math.min(1, got / total));
  }
  return out.subarray(0, got);
}

async function finishGrow(reader, buf, got, first, onProgress, total) {
  let out = buf;
  const push = (v) => {
    if (got + v.length > out.length) { const b = new Uint8Array((got + v.length) * 2); b.set(out.subarray(0, got)); out = b; }
    out.set(v, got);
    got += v.length;
  };
  push(first);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    push(value);
    onProgress(Math.min(1, got / total));
  }
  return out.subarray(0, got);
}

export async function fetchText(url, onProgress) {
  return new TextDecoder().decode(await fetchBytes(url, onProgress));
}

export async function fetchArrayBuffer(url) {
  const bytes = await fetchBytes(url);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export function peakOf(buffer) {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i += 2) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
  }
  return peak;
}
