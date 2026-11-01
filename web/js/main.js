// BasicDAW - app wiring.
import { $, $$, h, bus, clamp, fmtTime, isTyping, paintRange, download, setSaveHandler, safeFileName, rgba, debounce } from './util.js';
import { Store, beatsPerBar, songEndBeats, playedNotes } from './store.js';
import { api } from './api.js';
import { settings } from './settings.js';
import { AudioEngine, volumeToGain } from './audio/engine.js';
import { setDecodeContext } from './audio/base.js';
import { getInstrument } from './audio/instruments.js';
import { preloadProjectMedia } from './audio/media.js';
import { Player } from './audio/player.js';
import { MidiHub, QwertyKeyboard } from './midi/hub.js';
import { projectToMidi } from './midi/smf.js';
import { Live } from './live.js';
import { Importer } from './importer.js';
import { Exporter, FORMATS } from './exporter.js';
import { projectFromTemplate } from './demo.js';
import { instrumentLabel, isDrumSpec } from './gm.js';
import { PianoRoll, SCALES } from './ui/pianoroll.js';
import { Arranger } from './ui/arranger.js';
import { TrackList } from './ui/tracklist.js';
import { InstrumentBrowser } from './ui/browser.js';
import { Inspector } from './ui/inspector.js';
import { MidinousPanel } from './ui/midinous-panel.js';
import { MidiPanel } from './ui/midi-panel.js';
import { ProjectManager } from './ui/projects.js';
import { modal, modalOpen, confirmDialog, choiceDialog, promptDialog, openMenu, toast } from './ui/dialogs.js';

window.addEventListener('error', (e) => { console.error(e.error || e.message); toast(`Error: ${e.message}`, { type: 'error' }); });
window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); toast(`Error: ${e.reason?.message || e.reason}`, { type: 'error' }); });

const store = new Store();
const engine = new AudioEngine();
engine.init();
setDecodeContext(engine.ctx);
const hub = new MidiHub(engine);
const player = new Player(engine, store, hub);
const live = new Live({ store, engine, player, hub });
const qwerty = new QwertyKeyboard(hub);

const app = { store, engine, hub, player, live, qwerty };
window.basicdaw = app; // handy for debugging from the console

// ------------------------------------------------------------------ previews

let phraseVoices = [];
app.preview = {
  inst(track) {
    if (!track || track.type === 'audio') return null;
    const inst = getInstrument(track.instrument);
    return inst?.state === 'ready' ? inst : null;
  },
  once(track, pitch, velocity = 100) {
    const inst = this.inst(track);
    if (!inst) return;
    const ctx = engine.resume();
    inst.play(engine.channel(track.id).input, pitch, velocity, ctx.currentTime + 0.005, 0.32);
  },
  start(track, pitch, velocity = 100) {
    const inst = this.inst(track);
    if (!inst) return null;
    const ctx = engine.resume();
    return inst.play(engine.channel(track.id).input, pitch, velocity, ctx.currentTime + 0.005, null);
  },
  async phrase(spec, channelId = '__preview') {
    const inst = getInstrument(spec);
    if (!inst) return;
    const ctx = engine.resume();
    if (inst.state !== 'ready') {
      const t = toast(`Loading ${instrumentLabel(spec)}…`, { type: 'progress', id: `pv-${inst.key}` });
      await inst.load();
      t.close();
      if (inst.state !== 'ready') { toast(`Could not load ${instrumentLabel(spec)}: ${inst.error?.message || ''}`, { type: 'error' }); return; }
    }
    for (const v of phraseVoices) v.kill(ctx.currentTime);
    phraseVoices = [];
    const dest = engine.channel(channelId).input;
    const t0 = ctx.currentTime + 0.05;
    const notes = isDrumSpec(spec)
      ? [[36, 0, 0.25], [42, 0, 0.25], [42, 0.25, 0.25], [38, 0.5, 0.25], [42, 0.5, 0.25], [42, 0.75, 0.25], [36, 0.875, 0.2], [36, 1, 0.25], [46, 1, 0.25], [38, 1.5, 0.25], [49, 2, 0.5]]
      : [[60, 0, 0.22], [64, 0.25, 0.22], [67, 0.5, 0.22], [72, 0.75, 0.5], [60, 1.25, 1], [64, 1.25, 1], [67, 1.25, 1]];
    const spb = 0.42;
    for (const [p, t, d] of notes) {
      const v = inst.play(dest, p, 100, t0 + t * spb * 2, d * spb * 2);
      if (v) phraseVoices.push(v);
    }
  },
};

// ------------------------------------------------------------------ UI components

app.importer = new Importer(app);
app.exporter = new Exporter(app);
app.projects = new ProjectManager(app);
app.roll = new PianoRoll($('#roll-wrap'), app);
app.arranger = new Arranger($('#arr-wrap'), $('#track-list'), app);
app.tracks = new TrackList($('#track-list'), app);
app.browser = new InstrumentBrowser($('#tab-instruments'), app);
app.inspector = new Inspector($('#tab-track'), app);
app.midinous = new MidinousPanel($('#tab-midinous'), app);
app.midiPanel = new MidiPanel($('#tab-midi'), app);

// ------------------------------------------------------------------ track helpers

app.loadTrackInstruments = () => {
  for (const t of store.project.tracks) if (t.type !== 'audio') getInstrument(t.instrument);
};

app.addTrackFromSpec = (spec, opts = {}) => {
  const t = store.addTrack({ name: instrumentLabel(spec), instrument: spec, ...opts });
  getInstrument(spec);
  app.engine.sync(store.project);
  return t;
};

app.assignInstrument = (spec) => {
  const t = store.selectedTrack;
  if (!t || t.type === 'audio') {
    app.addTrackFromSpec(spec);
    app.preview.phrase(spec);
    return;
  }
  const oldLabel = instrumentLabel(t.instrument);
  store.commit('Change instrument', () => {
    if (t.name === oldLabel || /^Track( \d+)?$/.test(t.name)) t.name = instrumentLabel(spec);
    t.instrument = spec;
  });
  app.preview.phrase(spec, t.id);
};

app.deleteTrack = async (t) => {
  const has = t.notes.length || t.clips.length;
  if (has && !await confirmDialog({ title: `Delete "${t.name}"?`, message: 'The track and its notes are removed from the project. Ctrl+Z brings it back.', confirm: 'Delete track', danger: true })) return;
  store.removeTrack(t.id);
};

app.openAddTrackMenu = (anchor) => {
  const lib = settings.get('library');
  const fileInput = h('input', { type: 'file', accept: 'audio/*', multiple: true, style: { display: 'none' } });
  fileInput.addEventListener('change', () => app.importer.importAudio([...fileInput.files], null));
  document.body.append(fileInput);
  setTimeout(() => fileInput.remove(), 60000);
  openMenu(anchor, [
    { header: 'Add track' },
    { label: 'Grand Piano', icon: 'piano', onClick: () => app.addTrackFromSpec({ kind: 'gm', library: lib, program: 0 }) },
    { label: 'Drum Kit', icon: 'drum', onClick: () => app.addTrackFromSpec({ kind: 'drums', kit: settings.get('defaultKit') }) },
    { label: 'Bass', icon: 'music', onClick: () => app.addTrackFromSpec({ kind: 'gm', library: lib, program: 33 }) },
    { label: 'Strings', icon: 'music', onClick: () => app.addTrackFromSpec({ kind: 'gm', library: lib, program: 48 }) },
    { label: 'Synth Lead (offline)', icon: 'zap', onClick: () => app.addTrackFromSpec({ kind: 'synth', preset: 'saw-lead' }) },
    { label: 'Synth Pad (offline)', icon: 'sparkles', onClick: () => app.addTrackFromSpec({ kind: 'synth', preset: 'warm-pad' }) },
    '-',
    { label: 'Audio track from file…', icon: 'wave', onClick: () => fileInput.click() },
    { label: 'Browse all sounds…', icon: 'search', onClick: () => app.showInstrumentBrowser() },
  ]);
};

// ------------------------------------------------------------------ side panel

const side = $('#side');
app.showTab = (name) => {
  for (const b of $$('#side-tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const id of ['instruments', 'track', 'midinous', 'midi']) $(`#tab-${id}`).classList.toggle('hidden', id !== name);
  settings.set('panelTab', name);
  if (name === 'track') app.inspector.render();
  if (name === 'midinous') app.midinous.refresh();
  setPanel(true);
};
function setPanel(open) {
  side.classList.toggle('collapsed', !open);
  $('#btn-panel').classList.toggle('on', open);
  settings.set('panel', open);
}
app.showInstrumentBrowser = () => app.showTab('instruments');
for (const b of $$('#side-tabs button')) b.addEventListener('click', () => app.showTab(b.dataset.tab));
$('#btn-panel').addEventListener('click', () => setPanel(side.classList.contains('collapsed')));

// ------------------------------------------------------------------ projects

function thumbnail() {
  const p = store.project;
  const W = 320, H = 112;
  const c = h('canvas', { width: W, height: H });
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#171a3d');
  grad.addColorStop(1, '#0b0f22');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  const end = Math.max(songEndBeats(p), 16);
  const tracks = p.tracks.slice(0, 8);
  const lh = (H - 16) / Math.max(1, tracks.length);
  tracks.forEach((t, i) => {
    const y = 8 + i * lh;
    if (t.type === 'audio') {
      g.fillStyle = rgba(t.color, 0.5);
      for (const cl of t.clips) g.fillRect((cl.start / end) * W, y + lh * 0.25, ((cl.duration / (60 / p.bpm)) / end) * W, lh * 0.5);
      return;
    }
    let lo = 127, hi = 0;
    for (const n of t.notes) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
    const range = Math.max(1, hi - lo + 1);
    g.fillStyle = t.color;
    g.shadowColor = t.color;
    g.shadowBlur = 6;
    for (const n of playedNotes(p, t)) {
      g.fillRect((n.start / end) * W, y + ((hi - n.pitch) / range) * (lh - 3), Math.max(1.5, (n.duration / end) * W), Math.max(1.5, Math.min(3, lh / range)));
    }
    g.shadowBlur = 0;
  });
  return c.toDataURL('image/png');
}

function serialize() {
  return { ...JSON.parse(JSON.stringify(store.project)), thumbnail: thumbnail() };
}

app.updateTitle = () => {
  $('#project-name').value = store.project.name;
  document.title = `${store.project.name} · BasicDAW`;
};

app.saveProject = async ({ quiet = false } = {}) => {
  try {
    const p = store.project;
    if (!p.id) {
      const res = await api.createProject(p.name, serialize());
      p.id = res.id;
    } else {
      await api.saveProject(p.id, serialize());
    }
    settings.set('lastProject', p.id);
    store.markSaved();
    if (!quiet) toast(`Saved "${p.name}"`, { type: 'ok' });
    return true;
  } catch (err) {
    toast(`Save failed: ${err.message}`, { type: 'error' });
    return false;
  }
};

app.saveAs = async () => {
  const name = await promptDialog({ title: 'Save as', label: 'New project name', value: `${store.project.name} copy`, confirm: 'Save copy' });
  if (!name) return;
  try {
    const data = serialize();
    data.name = name;
    const res = await api.createProject(name, data);
    await app.openProject(res.id, { force: true });
    toast(`Saved as "${name}"`, { type: 'ok' });
  } catch (err) { toast(err.message, { type: 'error' }); }
};

/** Ask what to do with unsaved changes. Resolves true when it is OK to continue. */
async function confirmLeave() {
  if (!store.dirty) return true;
  const choice = await choiceDialog({
    title: 'Save changes?',
    message: `"${store.project.name}" has unsaved changes.`,
    choices: [{ label: 'Cancel', value: 'cancel' }, { label: "Don't save", value: 'discard', danger: true }, { label: 'Save', value: 'save', primary: true }],
  });
  if (choice === 'save') return app.saveProject({ quiet: true });
  return choice === 'discard';
}
app.confirmLeave = confirmLeave; // the desktop app asks this before closing its window

function loadProject(project) {
  player.stop();
  player.position = 0;
  store.setProject(project);
  settings.set('lastProject', project.id);
  app.updateTitle();
  app.loadTrackInstruments();
  preloadProjectMedia(store.project);
  engine.sync(store.project);
  syncControls();
}

app.openProject = async (id, { force = false, quiet = false } = {}) => {
  if (!force && id !== store.project.id && !await confirmLeave()) return false;
  try {
    loadProject(await api.getProject(id));
    return true;
  } catch (err) {
    if (!quiet) toast(`Could not open project: ${err.message}`, { type: 'error' });
    return false;
  }
};

app.createProjectFrom = async (project, { confirm = true } = {}) => {
  if (confirm && !await confirmLeave()) return false;
  const res = await api.createProject(project.name, project);
  loadProject(res.project);
  store.markSaved();
  return true;
};

app.newProject = async (name, template = 'empty') => {
  const ok = await app.createProjectFrom(projectFromTemplate(template, name));
  if (ok) toast(`Created "${name}"`, { type: 'ok' });
};

app.afterCurrentDeleted = async () => {
  const list = await api.listProjects().catch(() => []);
  const next = list.find((p) => p.id !== store.project.id);
  store.markSaved();
  if (next) await app.openProject(next.id, { force: true });
  else await app.createProjectFrom(projectFromTemplate('empty', 'Untitled'), { confirm: false });
};

$('#btn-projects').addEventListener('click', (e) => openMenu(e.currentTarget, [
  { header: 'Project' },
  { label: 'Browse projects…', icon: 'grid', kbd: 'Ctrl+O', onClick: () => app.projects.open() },
  { label: 'New project…', icon: 'plus', kbd: 'Ctrl+Alt+N', onClick: () => app.projects.newProjectDialog() },
  '-',
  { label: 'Save', icon: 'save', kbd: 'Ctrl+S', onClick: () => app.saveProject() },
  { label: 'Save as…', icon: 'copy', kbd: 'Ctrl+Shift+S', onClick: () => app.saveAs() },
  { label: 'Rename…', icon: 'edit', onClick: async () => { const n = await promptDialog({ title: 'Rename project', value: store.project.name, confirm: 'Rename' }); if (n) { store.project.name = n; store.touch('rename'); app.updateTitle(); app.saveProject({ quiet: true }); } } },
  '-',
  { label: 'Import MIDI / audio / project…', icon: 'upload', onClick: () => pickFiles('.mid,.midi,.json,audio/*') },
  { label: 'Export…', icon: 'download', kbd: 'Ctrl+E', onClick: () => app.exporter.dialog() },
  '-',
  { label: 'Delete this project…', icon: 'trash', danger: true, onClick: deleteCurrent },
]));

async function deleteCurrent() {
  const p = store.project;
  if (!await confirmDialog({ title: `Delete "${p.name}"?`, message: 'The project is moved to projects/.trash on disk.', confirm: 'Delete project', danger: true })) return;
  try {
    if (p.id) await api.deleteProject(p.id);
    toast(`Deleted "${p.name}"`, { type: 'ok' });
    await app.afterCurrentDeleted();
  } catch (err) { toast(err.message, { type: 'error' }); }
}

function pickFiles(accept) {
  const input = h('input', { type: 'file', accept, multiple: true, style: { display: 'none' } });
  input.addEventListener('change', () => { app.importer.importFiles([...input.files]); input.remove(); });
  document.body.append(input);
  input.click();
}

const nameInput = $('#project-name');
nameInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') nameInput.blur(); });
nameInput.addEventListener('change', () => {
  const v = nameInput.value.trim();
  if (!v) { app.updateTitle(); return; }
  store.project.name = v.slice(0, 120);
  store.touch('rename');
  app.updateTitle();
});
store.on('dirty', (d) => $('#dirty-dot').classList.toggle('on', d));
$('#btn-save').addEventListener('click', () => app.saveProject());
$('#btn-undo').addEventListener('click', () => undo());
$('#btn-redo').addEventListener('click', () => redo());
const undo = () => { const l = store.undo(); if (l) toast(`Undo: ${l}`, { id: 'undo', timeout: 1200 }); };
const redo = () => { const l = store.redo(); if (l) toast(`Redo: ${l}`, { id: 'undo', timeout: 1200 }); };
store.on('history', () => {
  $('#btn-undo').disabled = !store.undoStack.length;
  $('#btn-redo').disabled = !store.redoStack.length;
});

window.addEventListener('beforeunload', (e) => { if (store.dirty) { e.preventDefault(); e.returnValue = ''; } });

// ------------------------------------------------------------------ export

const exportItem = (id) => ({ label: `${FORMATS[id].label} · ${FORMATS[id].desc}`, icon: FORMATS[id].icon, kbd: `.${id}`, onClick: () => app.exporter.dialog(id) });
$('#btn-export').addEventListener('click', (e) => openMenu(e.currentTarget, [
  { header: 'Audio mixdown' },
  ...Object.keys(FORMATS).map(exportItem),
  { header: 'Notes & project' },
  { label: 'MIDI file', icon: 'file-music', kbd: '.mid', onClick: exportMidi },
  { label: 'Project file', icon: 'save', kbd: '.json', onClick: exportProjectFile },
  '-',
  { label: 'Send to Midinous…', icon: 'send', onClick: () => app.midinous.exportDialog() },
]));

async function exportMidi() {
  if (!store.project.tracks.some((t) => t.notes.length)) { toast('There are no notes to export', { type: 'error' }); return; }
  const name = `${safeFileName(store.project.name)}.mid`;
  try {
    const where = await download(new Blob([projectToMidi(store.project)], { type: 'audio/midi' }), name);
    toast(where ? `Saved ${name} to ${where}` : 'MIDI file exported', { type: 'ok' });
  } catch (err) { toast(err.message, { type: 'error' }); }
}

async function exportProjectFile() {
  const data = JSON.stringify({ ...store.project, thumbnail: undefined }, null, 1);
  const name = `${safeFileName(store.project.name)}.basicdaw.json`;
  try {
    const where = await download(new Blob([data], { type: 'application/json' }), name);
    if (where) toast(`Saved ${name} to ${where}`, { type: 'ok' });
  } catch (err) { toast(err.message, { type: 'error' }); }
}

// ------------------------------------------------------------------ transport controls

const bpmInput = $('#bpm');
const sigSel = $('#timesig');
const masterVol = $('#master-vol');

function syncControls() {
  const p = store.project;
  if (document.activeElement !== bpmInput) bpmInput.value = Math.round(p.bpm * 100) / 100;
  sigSel.value = `${p.timeSig[0]}/${p.timeSig[1]}`;
  masterVol.value = p.masterVolume ?? 0.85;
  paintRange(masterVol);
  $('#btn-loop').classList.toggle('on', !!p.loop.enabled);
  $('#key-root').value = String(p.key?.root ?? 0);
  $('#key-scale').value = p.key?.scale || 'chromatic';
}
app.emitLoop = syncControls;

bpmInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') bpmInput.blur(); });
bpmInput.addEventListener('change', () => {
  const v = clamp(Number(bpmInput.value) || 120, 20, 400);
  store.commit('Tempo', (p) => { p.bpm = v; });
  bpmInput.value = v;
});
sigSel.addEventListener('change', () => {
  const [n, d] = sigSel.value.split('/').map(Number);
  store.commit('Time signature', (p) => { p.timeSig = [n, d]; });
});
masterVol.addEventListener('input', () => {
  store.project.masterVolume = Number(masterVol.value);
  paintRange(masterVol);
  engine.graph.master.gain.setTargetAtTime(volumeToGain(store.project.masterVolume), engine.now, 0.02);
  store.transient();
});

const togglePlay = () => { engine.resume(); player.toggle(); };
const toggleLoop = () => {
  store.commit('Loop', (p) => {
    p.loop.enabled = !p.loop.enabled;
    if (p.loop.enabled && p.loop.end - p.loop.start < 0.25) {
      const bpb = beatsPerBar(p);
      p.loop.start = Math.floor(player.currentBeat() / bpb) * bpb;
      p.loop.end = p.loop.start + bpb * 4;
    }
  });
  syncControls();
};
const toggleRecord = () => {
  player.recording = !player.recording;
  app.arranger.dirty = app.roll.dirty = true; // loops run open-ended while recording
  $('#btn-record').classList.toggle('on', player.recording);
  document.body.classList.toggle('recording', player.recording && player.playing);
  if (player.recording && player.playing && !live.recBefore) live.recBefore = store.snapshot();
  if (player.recording) {
    const armed = store.project.tracks.filter((t) => t.arm);
    toast(armed.length ? `Recording into ${armed.map((t) => t.name).join(', ')}` : `Recording into ${store.selectedTrack?.name || 'the selected track'} - arm tracks to choose`, { id: 'rec', timeout: 2500 });
  }
};
const toggleMetronome = () => {
  player.metronome = !player.metronome;
  $('#btn-metronome').classList.toggle('on', player.metronome);
};
app.setQwerty = (v) => {
  qwerty.enabled = v;
  if (!v) qwerty.releaseAll();
  $('#btn-keys').classList.toggle('on', v);
  app.midiPanel.render();
  toast(v ? `Computer keyboard on: A W S E D F T G… (octave ${qwerty.octave}, Z/X to change, Esc to turn off)` : 'Computer keyboard off', { id: 'qw', timeout: v ? 3500 : 1200 });
};
app.panic = () => {
  live.releaseAll();
  qwerty.releaseAll();
  for (const v of player.voices) v.kill(engine.now);
  hub.sentSinceFlush = true;
  hub.panic();
};

$('#btn-play').addEventListener('click', togglePlay);
$('#btn-stop').addEventListener('click', () => player.stop());
$('#btn-home').addEventListener('click', () => player.seek(0));
$('#btn-record').addEventListener('click', toggleRecord);
$('#btn-loop').addEventListener('click', toggleLoop);
$('#btn-metronome').addEventListener('click', toggleMetronome);
$('#btn-keys').addEventListener('click', () => app.setQwerty(!qwerty.enabled));
player.on('state', () => {
  document.body.classList.toggle('playing', player.playing);
  document.body.classList.toggle('recording', player.recording && player.playing);
});
hub.on('octave', (o) => toast(`Keyboard octave ${o}`, { id: 'oct', timeout: 900 }));
hub.on('error', (err) => toast(`MIDI: ${err.message}`, { type: 'error', id: 'midi-err' }));

// ------------------------------------------------------------------ editor toolbar

const SNAPS = [['1', 4], ['1/2', 2], ['1/4', 1], ['1/8', 0.5], ['1/16', 0.25], ['1/32', 0.125], ['1/4 T', 2 / 3], ['1/8 T', 1 / 3], ['1/16 T', 1 / 6]];
const snapSel = $('#snap');
snapSel.append(...SNAPS.map(([l, v]) => h('option', { value: v, selected: v === 0.25 }, `${l}`)));
snapSel.addEventListener('change', () => { app.roll.snap = Number(snapSel.value); app.roll.dirty = true; });
const lenSel = $('#note-len');
lenSel.append(h('option', { value: 'snap' }, 'Grid'), h('option', { value: 'last' }, 'Last used'), ...SNAPS.slice(0, 6).map(([l, v]) => h('option', { value: v }, l)));
lenSel.addEventListener('change', () => { app.roll.lenMode = lenSel.value; });
const NOTE_LABELS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
$('#key-root').append(...NOTE_LABELS.map((n, i) => h('option', { value: i }, n)));
$('#key-scale').append(...Object.keys(SCALES).map((s) => h('option', { value: s }, s[0].toUpperCase() + s.slice(1))));
$('#key-root').addEventListener('change', (e) => store.commit('Key', (p) => { p.key = { ...p.key, root: Number(e.target.value) }; }));
$('#key-scale').addEventListener('change', (e) => store.commit('Scale', (p) => { p.key = { ...p.key, scale: e.target.value }; }));
const velInput = $('#note-vel');
velInput.addEventListener('change', () => { app.roll.velocity = clamp(Number(velInput.value) || 100, 1, 127); velInput.value = app.roll.velocity; });
velInput.addEventListener('keydown', (e) => e.stopPropagation());

function setTool(t) {
  app.roll.setTool(t);
  for (const b of $$('#tool-seg button')) b.classList.toggle('active', b.dataset.tool === t);
}
for (const b of $$('#tool-seg button')) b.addEventListener('click', () => setTool(b.dataset.tool));
setTool('draw');
$('#btn-quantize').addEventListener('click', () => { const n = app.roll.quantize(); if (n) toast(`Quantized ${n} notes to the grid`, { id: 'q', timeout: 1500 }); });
$('#btn-ghost').addEventListener('click', (e) => { app.roll.ghost = !app.roll.ghost; e.currentTarget.classList.toggle('on', app.roll.ghost); app.roll.dirty = true; });
$('#btn-follow').addEventListener('click', (e) => { app.roll.follow = !app.roll.follow; e.currentTarget.classList.toggle('on', app.roll.follow); });
$('#btn-zoom-in').addEventListener('click', () => app.roll.zoom(1.25));
$('#btn-zoom-out').addEventListener('click', () => app.roll.zoom(0.8));
$('#btn-add-track').addEventListener('click', (e) => app.openAddTrackMenu(e.currentTarget));

function updateEditorTitle() {
  const t = store.selectedTrack;
  const el = $('#editor-title');
  el.style.setProperty('--c', t?.color || '#5c6185');
  el.querySelector('.name').textContent = t ? t.name : 'No track selected';
  el.querySelector('.sub').textContent = t ? (t.type === 'audio' ? 'Audio' : instrumentLabel(t.instrument)) : '';
}
store.on('select', updateEditorTitle);
store.on('change', (e) => { if (e.kind !== 'transient') updateEditorTitle(); });
store.on('project', updateEditorTitle);

const syncAudio = debounce(() => engine.sync(store.project), 30);
store.on('change', (e) => {
  syncAudio();
  if (e.kind !== 'transient') syncControls();
});

// ------------------------------------------------------------------ splitter

const arrEl = $('#arranger');
if (settings.get('splitter')) arrEl.style.height = `${settings.get('splitter')}px`;
$('#splitter').addEventListener('pointerdown', (e) => {
  const startY = e.clientY;
  const startH = arrEl.getBoundingClientRect().height;
  const move = (ev) => { arrEl.style.height = `${clamp(startH + ev.clientY - startY, 120, innerHeight - 320)}px`; };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    settings.set('splitter', Math.round(arrEl.getBoundingClientRect().height));
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

// ------------------------------------------------------------------ keyboard shortcuts

window.addEventListener('keydown', (e) => {
  if (modalOpen()) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.code === 'KeyS') { e.preventDefault(); if (e.shiftKey) app.saveAs(); else app.saveProject(); return; }
  if (mod && e.code === 'KeyO') { e.preventDefault(); app.projects.open(); return; }
  if (mod && e.code === 'KeyE') { e.preventDefault(); app.exporter.dialog(); return; }
  if (mod && e.altKey && e.code === 'KeyN') { e.preventDefault(); app.projects.newProjectDialog(); return; }
  if (isTyping()) return;
  if (qwerty.enabled && e.code === 'Escape') { app.setQwerty(false); return; }
  if (qwerty.keydown(e)) { e.preventDefault(); return; }
  const roll = app.roll;
  const handled = (() => {
    if (mod) {
      switch (e.code) {
        case 'KeyZ': if (e.shiftKey) redo(); else undo(); return true;
        case 'KeyY': redo(); return true;
        case 'KeyA': roll.selectAll(); return true;
        case 'KeyC': roll.copy(); return true;
        case 'KeyX': roll.cut(); return true;
        case 'KeyV': roll.paste(); return true;
        case 'KeyD': roll.duplicate(); return true;
        default: return false;
      }
    }
    switch (e.code) {
      case 'Space': togglePlay(); return true;
      case 'Enter': case 'NumpadEnter': player.stop(); return true;
      case 'Home': player.seek(0); return true;
      case 'KeyR': toggleRecord(); return true;
      case 'KeyL': toggleLoop(); return true;
      case 'KeyC': toggleMetronome(); return true;
      case 'KeyK': app.setQwerty(true); return true;
      case 'KeyB': setPanel(side.classList.contains('collapsed')); return true;
      case 'Digit1': case 'KeyD': setTool('draw'); return true;
      case 'Digit2': case 'KeyV': setTool('select'); return true;
      case 'Digit3': case 'KeyE': setTool('erase'); return true;
      case 'KeyQ': roll.quantize(); return true;
      case 'KeyM': { const t = store.selectedTrack; if (t) { store.commit('Mute', () => { t.mute = !t.mute; }); } return true; }
      case 'KeyS': { const t = store.selectedTrack; if (t) { store.commit('Solo', () => { t.solo = !t.solo; }); } return true; }
      case 'Delete': case 'Backspace': return roll.deleteSelection();
      case 'Escape': roll.selection.clear(); roll.dirty = true; return true;
      case 'ArrowUp': return roll.transpose(e.shiftKey ? 12 : 1);
      case 'ArrowDown': return roll.transpose(e.shiftKey ? -12 : -1);
      case 'ArrowLeft': return roll.nudge(-1);
      case 'ArrowRight': return roll.nudge(1);
      case 'Equal': case 'NumpadAdd': roll.zoom(1.25); return true;
      case 'Minus': case 'NumpadSubtract': roll.zoom(0.8); return true;
      default: return false;
    }
  })();
  if (handled) e.preventDefault();
});
window.addEventListener('keyup', (e) => { if (qwerty.keyup(e)) e.preventDefault(); });
window.addEventListener('blur', () => qwerty.releaseAll());

// ------------------------------------------------------------------ drag & drop files

const overlay = $('#drop-overlay');
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; overlay.classList.add('on'); });
window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) overlay.classList.remove('on'); });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  overlay.classList.remove('on');
  const files = [...e.dataTransfer.files];
  if (files.length) app.importer.importFiles(files, app.arranger.dropContext(e.clientX, e.clientY));
});

// ------------------------------------------------------------------ status pills / instrument toasts

app.updatePills = () => {
  const st = hub.status;
  const mp = $('#pill-midi');
  mp.classList.toggle('ok', !!(st.available && st.connected));
  mp.title = st.available ? `MIDI bridge connected · listening to ${(st.open || []).length} input(s)` : (st.error || 'MIDI bridge unavailable');
  const mn = $('#pill-midinous');
  mn.classList.toggle('ok', !!app.midinous.status?.engine);
  mn.classList.toggle('live', !!st.midinousRunning);
  mn.title = st.midinousRunning ? 'Midinous is running - its notes play through BasicDAW' : app.midinous.status?.engine ? 'Midinous engine ready (app not running)' : 'Midinous engine unavailable';
};
hub.on('status', app.updatePills);
$('#pill-midi').addEventListener('click', () => app.showTab('midi'));
$('#pill-midinous').addEventListener('click', () => app.showTab('midinous'));
let lastActivity = 0;
hub.on('activity', (port) => {
  const now = performance.now();
  if (now - lastActivity < 60) return;
  lastActivity = now;
  const pill = port.includes('Midinous') ? $('#pill-midinous') : $('#pill-midi');
  pill.classList.add('activity');
  setTimeout(() => pill.classList.remove('activity'), 90);
});

const loading = new Map(); // instrument key -> {timer, shown}
bus.on('instrument-state', (inst) => {
  const id = `ld-${inst.key}`;
  if (inst.state === 'loading') {
    const entry = { shown: false };
    entry.timer = setTimeout(() => {
      entry.shown = true;
      toast(`Downloading ${inst.label}… ${Math.round(inst.progress * 100)}%`, { type: 'progress', id });
    }, 450);
    loading.set(inst.key, entry);
    return;
  }
  const entry = loading.get(inst.key);
  loading.delete(inst.key);
  if (entry) clearTimeout(entry.timer);
  if (inst.state === 'error') toast(`${inst.label}: ${inst.error?.message || 'download failed'}`, { type: 'error', id });
  else if (entry?.shown) toast(`${inst.label} ready`, { type: 'ok', id, timeout: 1400 });
});
bus.on('instrument-progress', (inst) => {
  if (loading.get(inst.key)?.shown) toast(`Downloading ${inst.label}… ${Math.round(inst.progress * 100)}%`, { type: 'progress', id: `ld-${inst.key}` });
});
live.on('track-created', (t) => toast(`Midinous channel → new track "${t.name}"`, { id: `mc-${t.id}`, timeout: 2500 }));

// ------------------------------------------------------------------ render loop

const lcdPos = $('#lcd-pos');
const lcdTime = $('#lcd-time');
const viz = $('#viz');
const vg = viz.getContext('2d');
const freq = new Uint8Array(engine.graph.analyser.frequencyBinCount);
let frameN = 0;

function drawViz() {
  const W = viz.width, H = viz.height;
  vg.clearRect(0, 0, W, H);
  engine.graph.analyser.getByteFrequencyData(freq);
  const bars = 36;
  const bw = W / bars;
  const grad = vg.createLinearGradient(0, H, W, 0);
  grad.addColorStop(0, '#8b5cf6');
  grad.addColorStop(0.5, '#6366f1');
  grad.addColorStop(1, '#22d3ee');
  vg.fillStyle = grad;
  for (let i = 0; i < bars; i++) {
    const lo = Math.floor(Math.pow(i / bars, 2) * 380) + 1;
    const hi = Math.floor(Math.pow((i + 1) / bars, 2) * 380) + 2;
    let m = 0;
    for (let k = lo; k < hi; k++) m = Math.max(m, freq[k]);
    const bh = Math.max(1.5, (m / 255) * (H - 6));
    vg.globalAlpha = 0.35 + 0.65 * (m / 255);
    vg.fillRect(i * bw + 1.5, H - 3 - bh, bw - 3, bh);
  }
  vg.globalAlpha = 1;
}

function updateLCD() {
  const p = store.project;
  const beat = player.currentBeat();
  const bpb = beatsPerBar(p);
  const bar = Math.floor(beat / bpb + 1e-9) + 1;
  const inBar = beat - (bar - 1) * bpb;
  const b = Math.floor(inBar + 1e-9) + 1;
  const six = Math.floor((inBar % 1) * 4 + 1e-9) + 1;
  lcdPos.textContent = `${bar}.${b}.${six}`;
  lcdTime.textContent = fmtTime(beat * (60 / p.bpm));
}

function frame() {
  frameN++;
  try {
    app.arranger.frame();
    app.roll.frame();
    updateLCD();
    if (frameN % 2 === 0) { app.tracks.updateMeters(); drawViz(); }
  } catch (err) {
    console.error(err);
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ boot

async function boot() {
  syncControls();
  requestAnimationFrame(frame);
  const panelOpen = settings.get('panel') !== false;
  app.showTab(settings.get('panelTab') || 'instruments');
  setPanel(panelOpen);
  // Resume audio on the first interaction (browsers start it suspended).
  const unlock = () => { engine.resume(); };
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });

  hub.connect();
  if (settings.get('midiInputs') !== null) hub.setWanted(settings.get('midiInputs')).catch(() => {});

  let opened = false;
  try {
    const health = await api.health();
    if (health.saveExports) setSaveHandler((blob, name) => api.saveExport(blob, name));
    const last = settings.get('lastProject');
    if (last) opened = await app.openProject(last, { force: true, quiet: true });
    if (!opened) {
      const list = await api.listProjects();
      if (list.length) opened = await app.openProject(list[0].id, { force: true });
    }
    if (!opened) {
      opened = await app.createProjectFrom(projectFromTemplate('starter', 'Welcome to BasicDAW'), { confirm: false });
      setTimeout(showWelcome, 400);
    }
  } catch (err) {
    toast(err.message, { type: 'error', timeout: 15000 });
    loadProject(projectFromTemplate('starter', 'Offline sketch'));
  }
  syncControls();
}

function showWelcome() {
  const k = (keys, what) => [h('kbd', {}, keys), h('span', {}, what)];
  modal({
    title: 'Welcome to BasicDAW',
    sub: 'A starter song is loaded - press Space to hear it',
    body: h('div', {},
      h('p', {}, 'Pick a track on the left, then draw notes in the piano roll: click to add, drag to set the length, right-click to delete. Drop any MIDI or audio file onto the window to import it.'),
      h('div', { class: 'welcome-keys' },
        k('Space', 'Play / pause'), k('1 2 3', 'Draw · Select · Erase'), k('Ctrl+S', 'Save project'), k('Ctrl+O', 'Projects'),
        k('Ctrl+wheel', 'Zoom the piano roll'), k('Alt+drag', 'Move / resize without snapping'), k('K', 'Play with your computer keyboard'), k('R', 'Record armed tracks'))),
    actions: [{ label: 'Let\'s go', primary: true, icon: 'sparkles' }],
  });
}

boot();
