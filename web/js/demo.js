// Project templates.
import { newProject, newTrack, newNote } from './store.js';
import { TRACK_COLORS } from './util.js';

function starter(name) {
  const p = newProject(name);
  p.bpm = 108;
  p.key = { root: 9, scale: 'minor' };
  p.loop = { enabled: false, start: 0, end: 32 };

  // Am - F - C - G, two times
  const roots = [33, 29, 36, 31];
  const chords = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]];

  const drums = [];
  for (let bar = 0; bar < 8; bar++) {
    const o = bar * 4;
    for (const k of [0, 1.5, 2, 2.75]) drums.push(newNote(36, o + k, 0.25, k === 0 ? 118 : 100));
    for (const s of [1, 3]) drums.push(newNote(38, o + s, 0.25, 110));
    for (let i = 0; i < 8; i++) drums.push(newNote(i === 7 ? 46 : 42, o + i * 0.5, 0.25, i % 2 ? 72 : 92));
    if (bar % 4 === 0) drums.push(newNote(49, o, 1, 100));
    if (bar === 7) for (const [t, n] of [[3, 45], [3.25, 45], [3.5, 43], [3.75, 41]]) drums.push(newNote(n, o + t, 0.25, 100));
  }

  const bass = [];
  for (let bar = 0; bar < 8; bar++) {
    const r = roots[bar % 4];
    const pat = [[0, 0, 0.45], [0.5, 0, 0.3], [0.75, 12, 0.2], [1.5, 0, 0.45], [2, 0, 0.45], [2.5, 7, 0.4], [3, 12, 0.45], [3.5, 10, 0.4]];
    for (const [t, iv, d] of pat) bass.push(newNote(r + iv, bar * 4 + t, d, t === 0 ? 112 : 96));
  }

  const pad = [];
  for (let bar = 0; bar < 8; bar++) for (const n of chords[bar % 4]) pad.push(newNote(n, bar * 4, 3.9, 78));

  const phrase = [
    [[76, 0, 0.5], [74, 0.5, 0.5], [72, 1, 0.5], [74, 1.5, 0.5], [76, 2, 1], [69, 3, 0.75]],
    [[77, 0, 0.5], [76, 0.5, 0.5], [74, 1, 0.5], [72, 1.5, 0.5], [74, 2, 1.5], [72, 3.5, 0.5]],
    [[72, 0, 0.5], [74, 0.5, 0.5], [76, 1, 1], [79, 2, 0.5], [76, 2.5, 0.5], [74, 3, 1]],
    [[74, 0, 0.5], [72, 0.5, 0.5], [71, 1, 0.5], [72, 1.5, 0.5], [74, 2, 2]],
  ];
  const ending = [[74, 0, 0.5], [76, 0.5, 0.5], [79, 1, 0.5], [81, 1.5, 2.5]];
  const lead = [];
  for (let bar = 0; bar < 8; bar++) {
    const ph = bar === 7 ? ending : phrase[bar % 4];
    for (const [n, t, d] of ph) lead.push(newNote(n, bar * 4 + t, d, 100));
  }

  p.tracks = [
    newTrack({ name: 'Drums', color: TRACK_COLORS[5], instrument: { kind: 'drums', kit: 'gm-fluid' }, notes: drums, volume: 0.82 }),
    newTrack({ name: 'Bass', color: TRACK_COLORS[1], instrument: { kind: 'gm', library: 'FluidR3_GM', program: 38 }, notes: bass, volume: 0.74, reverb: 0.04 }),
    newTrack({ name: 'Chords', color: TRACK_COLORS[0], instrument: { kind: 'gm', library: 'FluidR3_GM', program: 89 }, notes: pad, volume: 0.62, reverb: 0.3 }),
    newTrack({ name: 'Lead', color: TRACK_COLORS[2], instrument: { kind: 'synth', preset: 'saw-lead' }, notes: lead, volume: 0.6, reverb: 0.22, pan: 0.08 }),
  ];
  return p;
}

export function projectFromTemplate(template, name) {
  if (template === 'starter') return starter(name);
  const p = newProject(name);
  if (template === 'piano') {
    p.tracks = [newTrack({ name: 'Grand Piano', color: TRACK_COLORS[0], instrument: { kind: 'gm', library: 'FluidR3_GM', program: 0 } })];
  }
  return p;
}
