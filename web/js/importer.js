// Drag & drop / file imports: MIDI songs, audio files, BasicDAW projects, Midinous documents.
import { h, icon, uid, TRACK_COLORS } from './util.js';
import { parseMidi, midiToSong } from './midi/smf.js';
import { newNote, newProject, newTrack, PROJECT_FORMAT } from './store.js';
import { GM_NAMES } from './gm.js';
import { settings } from './settings.js';
import { api } from './api.js';
import { decode } from './audio/base.js';
import { putMedia } from './audio/media.js';
import { renderToSong } from './midinous.js';
import { modal, toast } from './ui/dialogs.js';

const AUDIO_EXT = /\.(mp3|wav|ogg|oga|flac|m4a|aac|webm|opus)$/i;

export class Importer {
  constructor(app) {
    this.app = app;
    this.store = app.store;
  }

  async importFiles(files, ctx = null) {
    const audio = files.filter((f) => AUDIO_EXT.test(f.name) || (f.type.startsWith('audio/') && !/midi/.test(f.type)));
    for (const f of files) {
      if (audio.includes(f)) continue;
      try {
        if (/\.(mid|midi|kar)$/i.test(f.name) || /midi/.test(f.type)) await this.importMidiBuffer(await f.arrayBuffer(), f.name);
        else if (/\.json$/i.test(f.name)) await this.importJson(await f.text(), f.name);
        else toast(`${f.name}: unsupported file type`, { type: 'error' });
      } catch (err) {
        toast(`${f.name}: ${err.message}`, { type: 'error' });
      }
    }
    if (audio.length) await this.importAudio(audio, ctx);
  }

  async importMidiBuffer(buf, name, { midinous = false } = {}) {
    const song = midiToSong(parseMidi(buf), name);
    if (!song.parts.length) throw new Error('The MIDI file has no notes');
    if (midinous) {
      song.source = 'midinous';
      for (const p of song.parts) p.midinousChannel = p.isDrum ? 10 : p.channel + 1;
    }
    return this.importSong(song);
  }

  async importJson(text, name) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('Not valid JSON'); }
    if (data.format === PROJECT_FORMAT || (Array.isArray(data.tracks) && data.bpm)) {
      const res = await api.createProject(data.name || name.replace(/\.json$/i, ''), { ...data, id: null });
      const opened = await this.app.openProject(res.id, { force: false });
      toast(opened ? `Imported project "${res.project.name}"` : `Added "${res.project.name}" to your projects`, { type: 'ok' });
      return;
    }
    if (data._note_points || data._performance_data) {
      const seconds = 32;
      const t = toast(`Playing "${name}" through the Midinous engine…`, { type: 'progress', id: 'mn-doc' });
      const res = await api.midinousRender({ document: data, name: name.replace(/\.json$/i, ''), seconds });
      t.close();
      if (!res.notes.length) throw new Error(`Midinous played nothing (${res.stopReason})`);
      return this.importSong(renderToSong(res));
    }
    throw new Error('Unknown JSON file (expected a BasicDAW project or a Midinous document)');
  }

  /** Show the import dialog for a parsed song and apply the user's choice. */
  importSong(song) {
    const p = this.store.project;
    const emptyProject = !p.tracks.some((t) => t.notes.length || t.clips.length);
    let mode = emptyProject ? 'current' : 'new';
    const rows = song.parts.map((pt) => {
      const c = h('input', { type: 'checkbox', checked: true });
      const inst = pt.isDrum ? 'Drums' : GM_NAMES[pt.program];
      return { pt, c, el: h('label', { class: 'import-track' }, c, icon(pt.isDrum ? 'drum' : 'piano', 'sm'), h('span', { class: 'nm' }, pt.name), h('span', { class: 'ct' }, `${inst} · ${pt.notes.length} notes`)) };
    });
    const tempo = h('input', { type: 'checkbox', checked: emptyProject });
    const modeBtns = [
      ['new', 'Open as a new project'],
      ['current', `Add to "${p.name}"`],
    ].map(([id, label]) => {
      const input = h('input', { type: 'radio', name: 'imp-mode', checked: mode === id });
      const el = h('label', { class: `radio ${mode === id ? 'active' : ''}` }, input, h('div', {}, h('b', {}, label)));
      input.addEventListener('change', () => { mode = id; modeBtns.forEach((b) => b.classList.toggle('active', b === el)); tempoRow.style.display = mode === 'current' ? '' : 'none'; });
      return el;
    });
    const tempoRow = h('label', { class: 'check', style: { display: mode === 'current' ? '' : 'none' } }, tempo, `Use the song's tempo (${song.bpm} BPM)`);
    const bars = Math.ceil(song.lengthBeats / 4);
    return new Promise((resolve) => {
      modal({
        title: `Import "${song.name}"`,
        sub: `${song.parts.length} part${song.parts.length === 1 ? '' : 's'} · ${song.bpm} BPM · ${bars} bars${song.tempoChanges ? ' · tempo changes are flattened' : ''}${song.source === 'midinous' ? ' · from Midinous' : ''}`,
        body: h('div', {},
          h('div', { class: 'radio-group' }, modeBtns),
          tempoRow,
          h('div', { class: 'import-tracks' }, rows.map((r) => r.el)),
          h('div', { class: 'hint' }, 'Instruments are matched from the file\'s General MIDI programs; drum channels use your default drum kit. You can change any sound afterwards.')),
        actions: [
          { label: 'Cancel', value: false },
          {
            label: 'Import', primary: true, icon: 'download', value: true,
            onClick: async () => {
              const parts = rows.filter((r) => r.c.checked).map((r) => r.pt);
              if (!parts.length) { toast('Select at least one part', { type: 'error' }); return false; }
              if (!await this.applySong(song, parts, { mode, adoptTempo: tempo.checked })) return false;
            },
          },
        ],
        onClose: (v) => resolve(!!v),
      });
    });
  }

  partToTrack(pt) {
    return {
      name: pt.name,
      instrument: pt.isDrum ? { kind: 'drums', kit: settings.get('defaultKit') } : { kind: 'gm', library: settings.get('library'), program: pt.program },
      notes: pt.notes.map((n) => newNote(n.pitch, n.start, n.duration, n.velocity)),
      midinousChannel: pt.midinousChannel ?? null,
    };
  }

  async applySong(song, parts, { mode, adoptTempo }) {
    if (mode === 'new') {
      const project = newProject(song.name);
      project.bpm = song.bpm;
      project.timeSig = song.timeSig;
      project.tracks = parts.map((pt, i) => newTrack({ ...this.partToTrack(pt), color: TRACK_COLORS[i % TRACK_COLORS.length] }));
      if (!await this.app.createProjectFrom(project)) return false; // the user kept the current project
    } else {
      let first = null;
      this.store.commit(`Import ${song.name}`, (p) => {
        if (adoptTempo) { p.bpm = song.bpm; p.timeSig = song.timeSig; }
        for (const pt of parts) {
          const t = newTrack({ ...this.partToTrack(pt), color: this.store.nextColor() });
          p.tracks.push(t);
          first ??= t;
        }
      });
      if (first) this.store.select(first.id);
      this.app.loadTrackInstruments();
    }
    const notes = parts.reduce((s, pt) => s + pt.notes.length, 0);
    toast(`Imported ${parts.length} track${parts.length === 1 ? '' : 's'} · ${notes} notes`, { type: 'ok' });
    return true;
  }

  async importAudio(files, ctx) {
    const app = this.app;
    if (!this.store.project.id) await app.saveProject({ quiet: true });
    const pid = this.store.project.id;
    for (const file of files) {
      const t = toast(`Importing ${file.name}…`, { type: 'progress', id: `aud-${file.name}` });
      try {
        const buffer = await decode(await file.arrayBuffer());
        const saved = await api.uploadAudio(pid, file);
        putMedia(pid, saved.file, buffer);
        const target = ctx && ctx.lane >= 0 ? this.store.project.tracks[ctx.lane] : null;
        const clip = { id: uid('c'), file: saved.file, name: file.name.replace(AUDIO_EXT, ''), start: ctx?.beat ?? 0, offset: 0, duration: buffer.duration, gain: 1 };
        if (target?.type === 'audio') {
          this.store.commit('Add clip', () => target.clips.push(clip));
          this.store.select(target.id);
        } else {
          this.store.addTrack({ name: clip.name, type: 'audio', instrument: null, clips: [clip], reverb: 0 });
        }
        t.update(`Added audio "${clip.name}" (${buffer.duration.toFixed(1)} s)`, 'ok');
        t.autoClose(3000);
      } catch (err) {
        t.update(`${file.name}: ${err.message || 'could not decode audio'}`, 'error');
        t.autoClose(6000);
      }
    }
  }
}
