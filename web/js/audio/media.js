// Audio files used by audio tracks: decoded buffers + waveform peaks for drawing.
import { api } from '../api.js';
import { decode } from './base.js';
import { bus } from '../util.js';

const entries = new Map(); // `${projectId}/${file}` -> {state, buffer, peaks, promise}

const keyOf = (pid, file) => `${pid}/${file}`;

function computePeaks(buffer, perSecond = 200) {
  const step = Math.max(1, Math.floor(buffer.sampleRate / perSecond));
  const n = Math.ceil(buffer.length / step);
  const peaks = new Float32Array(n * 2);
  const chans = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let lo = 0, hi = 0;
    const end = Math.min(buffer.length, (i + 1) * step);
    for (let j = i * step; j < end; j += 4) {
      for (const d of chans) { const v = d[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    peaks[i * 2] = lo;
    peaks[i * 2 + 1] = hi;
  }
  return { data: peaks, perSecond: buffer.sampleRate / step };
}

export function mediaEntry(pid, file) {
  return entries.get(keyOf(pid, file)) || null;
}

export function loadMedia(pid, file) {
  const key = keyOf(pid, file);
  let e = entries.get(key);
  if (e) return e.promise;
  e = { state: 'loading', buffer: null, peaks: null };
  entries.set(key, e);
  e.promise = (async () => {
    try {
      const res = await fetch(api.audioUrl(pid, file));
      if (!res.ok) throw new Error(`Audio file ${file} is missing`);
      e.buffer = await decode(await res.arrayBuffer());
      e.peaks = computePeaks(e.buffer);
      e.state = 'ready';
    } catch (err) {
      e.state = 'error';
      e.error = err;
    }
    bus.emit('media', e);
    return e;
  })();
  return e.promise;
}

/** Register an already-decoded buffer (fresh upload) so it shows immediately. */
export function putMedia(pid, file, buffer) {
  const e = { state: 'ready', buffer, peaks: computePeaks(buffer) };
  e.promise = Promise.resolve(e);
  entries.set(keyOf(pid, file), e);
  bus.emit('media', e);
  return e;
}

export function preloadProjectMedia(project) {
  if (!project.id) return;
  for (const t of project.tracks) for (const c of t.clips || []) loadMedia(project.id, c.file);
}
