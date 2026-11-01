// Conversions between BasicDAW tracks and Midinous (via the server's MidinousMCP engine).
import { GM_NAMES } from './gm.js';
import { songEndBeats, beatsPerBar, playedNotes } from './store.js';

const prettyInstrument = (key) => key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Server render result -> importable song (same shape as a parsed MIDI file). */
export function renderToSong(res) {
  const bps = res.tempo / 60;
  const groups = new Map();
  for (const n of res.notes) {
    const info = res.channels?.[String(n.ch)];
    const drum = info?.category === 'drums' || n.ch === 10 && !info;
    const key = drum ? 'drums' : n.ch;
    if (!groups.has(key)) {
      const program = drum ? 0 : info?.gm ?? 0;
      groups.set(key, {
        channel: key,
        midinousChannel: key,
        isDrum: drum,
        program,
        name: drum ? 'Midinous Drums' : `Midinous ${n.ch} · ${info?.instrument ? prettyInstrument(info.instrument) : GM_NAMES[program]}`,
        notes: [],
      });
    }
    const pitch = drum && info?.drumNote ? info.drumNote : n.note;
    groups.get(key).notes.push({ pitch, start: (n.t / 1000) * bps, duration: Math.max(1 / 64, (n.d / 1000) * bps), velocity: n.vel || 100 });
  }
  const parts = [...groups.values()].sort((a, b) => (a.isDrum - b.isDrum) || (a.channel - b.channel));
  let lengthBeats = 0;
  for (const p of parts) for (const n of p.notes) lengthBeats = Math.max(lengthBeats, n.start + n.duration);
  return { name: res.name, bpm: Math.round(res.tempo * 100) / 100, timeSig: [4, 4], parts, lengthBeats, source: 'midinous', stopReason: res.stopReason, warnings: res.warnings };
}

/** Assign Midinous channels: keep existing links, then fill free channels (drums prefer 10). */
export function assignChannels(tracks) {
  const used = new Set();
  const out = new Map();
  for (const t of tracks) {
    if (typeof t.midinousChannel === 'number' && !used.has(t.midinousChannel)) { out.set(t.id, t.midinousChannel); used.add(t.midinousChannel); }
  }
  for (const t of tracks) {
    if (out.has(t.id)) continue;
    const drum = t.instrument?.kind === 'drums';
    let ch = drum && !used.has(10) ? 10 : 1;
    while (used.has(ch) || (!drum && ch === 10 && used.size < 15)) ch++;
    if (ch > 16) ch = 16;
    out.set(t.id, ch);
    used.add(ch);
  }
  return out;
}

export function exportPayload(project, tracks, { name, loop, clockSource, overwrite }) {
  const channels = assignChannels(tracks);
  const bpb = beatsPerBar(project);
  const song = { ...project, tracks };
  const end = songEndBeats(song);
  return {
    channels,
    payload: {
      name, bpm: project.bpm, loop, clockSource, overwrite,
      lengthBeats: Math.max(bpb, Math.ceil(end / bpb - 1e-6) * bpb),
      tracks: tracks.map((t) => ({
        name: t.name, color: t.color, channel: channels.get(t.id),
        notes: playedNotes(song, t, end),
      })),
    },
  };
}
