// Standard MIDI File reading (format 0/1/2) and writing (format 1).
import { GM_NAMES } from '../gm.js';
import { songEndBeats, playedNotes } from '../store.js';

export function parseMidi(arrayBuffer) {
  const d = new DataView(arrayBuffer);
  let p = 0;
  const str = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(d.getUint8(p + i)); p += n; return s; };
  const u8 = () => d.getUint8(p++);
  const u16 = () => { const v = d.getUint16(p); p += 2; return v; };
  const u32 = () => { const v = d.getUint32(p); p += 4; return v; };
  const vlq = () => { let v = 0, b; do { b = u8(); v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };

  if (arrayBuffer.byteLength < 14 || str(4) !== 'MThd') throw new Error('Not a MIDI file');
  const hlen = u32();
  const format = u16();
  const ntrks = u16();
  const division = u16();
  p = 8 + hlen;

  const tracks = [];
  const tempos = [];
  const timeSigs = [];
  for (let t = 0; t < ntrks && p + 8 <= d.byteLength; t++) {
    let id = str(4);
    let len = u32();
    while (id !== 'MTrk' && p + len + 8 <= d.byteLength) { p += len; id = str(4); len = u32(); }
    if (id !== 'MTrk') break;
    const end = Math.min(d.byteLength, p + len);
    const track = { name: '', instrument: '', events: [] };
    let tick = 0;
    let running = 0;
    try {
      while (p < end) {
        tick += vlq();
        let status = d.getUint8(p);
        if (status >= 0x80) { p++; if (status < 0xf0) running = status; } else {
          if (!running) throw new Error('Running status without a status byte');
          status = running;
        }
        if (status === 0xff) {
          const type = u8();
          const l = vlq();
          const at = p;
          p += l;
          if (type === 0x51 && l === 3) {
            const us = (d.getUint8(at) << 16) | (d.getUint8(at + 1) << 8) | d.getUint8(at + 2);
            tempos.push({ tick, bpm: 60000000 / us });
          } else if (type === 0x58 && l >= 2) {
            timeSigs.push({ tick, num: d.getUint8(at), den: 2 ** d.getUint8(at + 1) });
          } else if (type === 0x03 || type === 0x04) {
            let s = '';
            for (let i = 0; i < l; i++) s += String.fromCharCode(d.getUint8(at + i));
            if (type === 0x03 && !track.name) track.name = s.trim();
            if (type === 0x04 && !track.instrument) track.instrument = s.trim();
          } else if (type === 0x2f) {
            break;
          }
        } else if (status === 0xf0 || status === 0xf7) {
          p += vlq();
        } else {
          const hi = status & 0xf0;
          const ch = status & 0x0f;
          const d1 = u8();
          const d2 = hi === 0xc0 || hi === 0xd0 ? 0 : u8();
          track.events.push({ tick, hi, ch, d1, d2 });
        }
      }
    } catch (err) {
      if (!(err instanceof RangeError)) throw err; // truncated file: keep what we have
    }
    p = end;
    tracks.push(track);
  }
  return { format, division, tracks, tempos: tempos.sort((a, b) => a.tick - b.tick), timeSigs };
}

/**
 * Convert parsed MIDI into BasicDAW track data: one part per (MIDI track, channel).
 * Positions are in beats (quarter notes).
 */
export function midiToSong(parsed, fileName = 'MIDI') {
  let ppq = parsed.division;
  let tickToBeat;
  const firstTempo = parsed.tempos.find((t) => t.tick === 0) || parsed.tempos[0];
  const bpm = firstTempo ? Math.round(firstTempo.bpm * 100) / 100 : 120;
  if (ppq & 0x8000) { // SMPTE timing: ticks are real time
    const fps = 256 - (ppq >> 8);
    const sub = ppq & 0xff;
    tickToBeat = (tick) => (tick / (fps * sub)) * (bpm / 60);
  } else {
    ppq = ppq || 480;
    tickToBeat = (tick) => tick / ppq;
  }
  const ts = parsed.timeSigs[0];
  const parts = [];
  parsed.tracks.forEach((trk, ti) => {
    const byCh = new Map();
    const programs = new Map();
    const open = new Map();
    let lastTick = 0;
    const part = (ch) => {
      if (!byCh.has(ch)) byCh.set(ch, { trackIndex: ti, channel: ch, program: null, notes: [] });
      return byCh.get(ch);
    };
    for (const ev of trk.events) {
      lastTick = Math.max(lastTick, ev.tick);
      if (ev.hi === 0xc0) {
        programs.set(ev.ch, ev.d1);
        const pt = byCh.get(ev.ch);
        if (pt && pt.program == null) pt.program = ev.d1;
      } else if (ev.hi === 0x90 && ev.d2 > 0) {
        const key = ev.ch * 128 + ev.d1;
        if (!open.has(key)) open.set(key, []);
        open.get(key).push({ tick: ev.tick, vel: ev.d2 });
        const pt = part(ev.ch);
        if (pt.program == null && programs.has(ev.ch)) pt.program = programs.get(ev.ch);
      } else if (ev.hi === 0x80 || (ev.hi === 0x90 && ev.d2 === 0)) {
        const key = ev.ch * 128 + ev.d1;
        const stack = open.get(key);
        if (stack?.length) {
          const on = stack.shift();
          const start = tickToBeat(on.tick);
          part(ev.ch).notes.push({ pitch: ev.d1, start, duration: Math.max(1 / 64, tickToBeat(ev.tick) - start), velocity: on.vel });
        }
      }
    }
    for (const [key, stack] of open) {
      for (const on of stack) {
        const start = tickToBeat(on.tick);
        part(Math.floor(key / 128)).notes.push({ pitch: key % 128, start, duration: Math.max(0.25, tickToBeat(lastTick) - start), velocity: on.vel });
      }
    }
    for (const pt of byCh.values()) {
      if (!pt.notes.length) continue;
      pt.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
      pt.isDrum = pt.channel === 9;
      pt.program = pt.program ?? 0;
      const base = trk.name || trk.instrument;
      pt.name = pt.isDrum ? (base && !/^track\s*\d*$/i.test(base) ? base : 'Drums') : (base || GM_NAMES[pt.program]);
      if (byCh.size > 1 && base && !pt.isDrum) pt.name = `${base} · ${GM_NAMES[pt.program]}`;
      parts.push(pt);
    }
  });
  let lengthBeats = 0;
  for (const pt of parts) for (const n of pt.notes) lengthBeats = Math.max(lengthBeats, n.start + n.duration);
  return {
    name: fileName.replace(/\.(mid|midi)$/i, ''),
    bpm: Math.min(400, Math.max(20, bpm)),
    tempoChanges: new Set(parsed.tempos.map((t) => Math.round(t.bpm * 10))).size > 1,
    timeSig: ts ? [ts.num, ts.den] : [4, 4],
    parts,
    lengthBeats,
  };
}

// ------------------------------------------------------------------ writing

function vlqBytes(v) {
  const bytes = [v & 0x7f];
  while ((v >>= 7)) bytes.unshift((v & 0x7f) | 0x80);
  return bytes;
}

function textMeta(type, s) {
  const b = [...new TextEncoder().encode(s)].slice(0, 120);
  return [0xff, type, ...vlqBytes(b.length), ...b];
}

function chunk(events) {
  // events: [{tick, order, bytes}]
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const out = [];
  let last = 0;
  for (const e of events) {
    out.push(...vlqBytes(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  out.push(0, 0xff, 0x2f, 0);
  const len = out.length;
  return [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...out];
}

export function projectToMidi(project, ppq = 480) {
  const usPerBeat = Math.round(60000000 / project.bpm);
  const [num, den] = project.timeSig;
  const tempoTrack = chunk([
    { tick: 0, order: 0, bytes: textMeta(0x03, project.name || 'BasicDAW') },
    { tick: 0, order: 1, bytes: [0xff, 0x51, 3, (usPerBeat >> 16) & 255, (usPerBeat >> 8) & 255, usPerBeat & 255] },
    { tick: 0, order: 2, bytes: [0xff, 0x58, 4, num, Math.round(Math.log2(den)), 24, 8] },
  ]);
  const tracks = [tempoTrack];
  const end = songEndBeats(project);
  let nextCh = 0;
  for (const t of project.tracks) {
    if (t.type === 'audio' || !t.notes.length) continue;
    const drum = t.instrument?.kind === 'drums';
    let ch = 9;
    if (!drum) { ch = nextCh++ % 15; if (ch >= 9) ch++; }
    const evs = [{ tick: 0, order: 0, bytes: textMeta(0x03, t.name) }];
    if (!drum) evs.push({ tick: 0, order: 1, bytes: [0xc0 | ch, t.instrument?.kind === 'gm' ? t.instrument.program : 80] });
    evs.push({ tick: 0, order: 2, bytes: [0xb0 | ch, 7, Math.round(Math.min(1, t.volume) * 127)] });
    evs.push({ tick: 0, order: 3, bytes: [0xb0 | ch, 10, Math.round((t.pan + 1) * 63.5)] });
    for (const n of playedNotes(project, t, end)) {
      const on = Math.round(n.start * ppq);
      const off = Math.max(on + 1, Math.round((n.start + n.duration) * ppq));
      evs.push({ tick: on, order: 5, bytes: [0x90 | ch, n.pitch, n.velocity] });
      evs.push({ tick: off, order: 4, bytes: [0x80 | ch, n.pitch, 0] });
    }
    tracks.push(chunk(evs));
  }
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (tracks.length >> 8) & 255, tracks.length & 255, (ppq >> 8) & 255, ppq & 255];
  return new Uint8Array([...header, ...tracks.flat()]);
}
