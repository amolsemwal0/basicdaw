// Offline mixdown of the project to an AudioBuffer, and WAV encoding (16 / 24-bit PCM or 32-bit float).
import { buildMaster, createChannel, applyChannel, volumeToGain } from './engine.js';
import { audibleTrackIds, songEndBeats, playedNotes } from '../store.js';
import { getInstrument } from './instruments.js';
import { mediaEntry } from './media.js';

export async function renderMix(project, { sampleRate = 44100, tail = 2.5, onStatus } = {}) {
  const spb = 60 / project.bpm;
  const end = songEndBeats(project);
  if (end <= 0) throw new Error('The project is empty - draw some notes first');
  const notes = new Map(project.tracks.map((t) => [t.id, playedNotes(project, t, end)]));
  let last = end; // the last repeat of a loop may ring past the end
  for (const list of notes.values()) for (const n of list) last = Math.max(last, n.start + n.duration);
  const seconds = last * spb + tail;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  const graph = buildMaster(ctx);
  graph.master.gain.value = volumeToGain(project.masterVolume ?? 0.85);
  const audible = audibleTrackIds(project);

  onStatus?.('Loading instruments…');
  const instruments = new Map();
  for (const t of project.tracks) {
    if (t.type === 'audio' || !audible.has(t.id) || t.internal === false) continue;
    const inst = getInstrument(t.instrument);
    if (inst) { await inst.load(); instruments.set(t.id, inst); }
  }

  onStatus?.('Scheduling…');
  for (const t of project.tracks) {
    if (!audible.has(t.id)) continue;
    const ch = createChannel(graph);
    applyChannel(ch, t, true, ctx, true);
    if (t.type === 'audio') {
      for (const c of t.clips) {
        const e = mediaEntry(project.id, c.file);
        if (!e || e.state !== 'ready') continue;
        const src = ctx.createBufferSource();
        src.buffer = e.buffer;
        const g = ctx.createGain();
        g.gain.value = c.gain ?? 1;
        src.connect(g).connect(ch.input);
        src.start(c.start * spb, c.offset || 0, c.duration);
      }
      continue;
    }
    const inst = instruments.get(t.id);
    if (!inst || inst.state !== 'ready') continue;
    for (const n of notes.get(t.id)) inst.play(ch.input, n.pitch, n.velocity, n.start * spb, n.duration * spb);
  }

  onStatus?.('Rendering…');
  return ctx.startRendering();
}

export function encodeWav(buffer, bits = 16) {
  const ch = Math.min(2, buffer.numberOfChannels);
  const len = buffer.length;
  const float = bits === 32;
  const bytes = bits / 8;
  const size = len * ch * bytes;
  const head = float ? 58 : 44; // float data needs the fmt extension and a fact chunk
  const data = new DataView(new ArrayBuffer(head + size));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  data.setUint32(4, head - 8 + size, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  data.setUint32(16, float ? 18 : 16, true);
  data.setUint16(20, float ? 3 : 1, true);
  data.setUint16(22, ch, true);
  data.setUint32(24, buffer.sampleRate, true);
  data.setUint32(28, buffer.sampleRate * ch * bytes, true);
  data.setUint16(32, ch * bytes, true);
  data.setUint16(34, bits, true);
  if (float) {
    data.setUint16(36, 0, true);
    str(38, 'fact');
    data.setUint32(42, 4, true);
    data.setUint32(46, len, true);
  }
  str(head - 8, 'data');
  data.setUint32(head - 4, size, true);
  const chans = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
  let o = head;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      if (float) { data.setFloat32(o, chans[c][i], true); o += 4; continue; }
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      if (bits === 16) data.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      else {
        const v = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        data.setUint8(o, v & 0xff);
        data.setUint8(o + 1, (v >> 8) & 0xff);
        data.setUint8(o + 2, (v >> 16) & 0xff);
      }
      o += bytes;
    }
  }
  return new Blob([data.buffer], { type: 'audio/wav' });
}
