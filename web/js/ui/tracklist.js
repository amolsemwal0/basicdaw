// Track headers next to the arranger lanes.
import { h, icon, bus, paintRange, TRACK_COLORS } from '../util.js';
import { instrumentLabel } from '../gm.js';
import { peekInstrument } from '../audio/instruments.js';
import { fmtDb } from '../audio/engine.js';
import { openMenu, confirmDialog } from './dialogs.js';

const TRACK_MIME = 'application/x-basicdaw-track';

export class TrackList {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.store = app.store;
    this.rows = new Map();
    this.store.on('change', (e) => { if (e.kind !== 'transient') this.render(); });
    this.store.on('project', () => this.render());
    this.store.on('select', () => this.updateSelection());
    bus.on('instrument-state', () => this.updateStates());
    this.render();
  }

  render() {
    const p = this.store.project;
    const scroll = this.el.scrollTop;
    this.el.replaceChildren();
    this.rows.clear();
    p.tracks.forEach((t) => this.el.append(this.row(t)));
    if (!p.tracks.length) {
      this.el.append(h('div', { class: 'empty-tracks' },
        h('div', {}, 'No tracks yet.'),
        h('div', { class: 'hint' }, 'Add one, drag a sound from the browser, or drop a MIDI file anywhere.'),
        h('div', { style: { marginTop: '10px' } },
          h('button', { class: 'btn small primary', onclick: (e) => this.app.openAddTrackMenu(e.currentTarget) }, icon('plus', 'sm'), 'Add track'))));
    }
    this.el.append(h('div', { class: 'spacer-end' }));
    this.el.scrollTop = scroll;
    this.updateSelection();
    this.updateStates();
  }

  row(t) {
    const store = this.store;
    const app = this.app;
    const commitToggle = (key, label) => (e) => {
      e.stopPropagation();
      store.commit(label, () => { t[key] = !t[key]; });
      app.engine.sync(store.project);
    };
    const name = h('div', { class: 'track-name', title: 'Double-click to rename' }, t.name);
    name.addEventListener('dblclick', (e) => { e.stopPropagation(); this.rename(t, name); });

    const vol = h('input', { type: 'range', class: 'vol', min: 0, max: 1, step: 0.01, title: 'Volume' });
    vol.value = t.volume;
    const pan = h('input', { type: 'range', class: 'pan', min: -1, max: 1, step: 0.01, title: 'Pan (double-click to center)' });
    pan.value = t.pan;
    const db = h('span', { class: 'db' }, fmtDb(t.volume));
    let before = null;
    const live = (input, key) => {
      input.addEventListener('pointerdown', (e) => { e.stopPropagation(); before = store.snapshot(); });
      input.addEventListener('input', () => {
        t[key] = Number(input.value);
        paintRange(input);
        if (key === 'volume') db.textContent = fmtDb(t.volume);
        app.engine.sync(store.project);
        store.transient();
      });
      input.addEventListener('change', () => {
        if (before) store.pushUndo(before, key === 'volume' ? 'Volume' : 'Pan');
        before = null;
        store.touch('mix');
      });
    };
    live(vol, 'volume');
    live(pan, 'pan');
    pan.addEventListener('dblclick', () => { store.commit('Pan', () => { t.pan = 0; }); app.engine.sync(store.project); });
    paintRange(vol);
    paintRange(pan);

    const chip = h('button', {
      class: 'inst-chip',
      title: t.type === 'audio' ? 'Audio track' : 'Change instrument',
      onclick: (e) => { e.stopPropagation(); store.select(t.id); if (t.type !== 'audio') app.showInstrumentBrowser(); },
    }, h('span', { class: 'state' }), icon(t.type === 'audio' ? 'wave' : t.instrument?.kind === 'drums' ? 'drum' : 'piano', 'xs'),
    h('span', {}, t.type === 'audio' ? `${t.clips.length} clip${t.clips.length === 1 ? '' : 's'}` : instrumentLabel(t.instrument)));

    const meter = h('i');
    const el = h('div', {
      class: 'track', draggable: true, dataset: { id: t.id }, style: { '--c': t.color },
      onclick: () => store.select(t.id),
    },
    h('div', { class: 'color' }),
    h('div', { class: 'track-row' },
      name,
      h('button', { class: `tbtn mute ${t.mute ? 'on' : ''}`, title: 'Mute (M)', onclick: commitToggle('mute', 'Mute') }, 'M'),
      h('button', { class: `tbtn solo ${t.solo ? 'on' : ''}`, title: 'Solo (S)', onclick: commitToggle('solo', 'Solo') }, 'S'),
      t.type === 'audio' ? null : h('button', { class: `tbtn loop ${t.loop ? 'on' : ''}`, title: 'Loop - repeat this track\'s notes until the song ends', onclick: commitToggle('loop', t.loop ? 'Loop off' : 'Loop on') }, icon('loop', 'xs')),
      t.type === 'audio' ? null : h('button', { class: `tbtn arm ${t.arm ? 'on' : ''}`, title: 'Arm for recording', onclick: commitToggle('arm', 'Arm') }, icon('record', 'xs')),
      h('button', { class: 'tbtn more', title: 'Track menu', onclick: (e) => { e.stopPropagation(); this.menu(t, e.currentTarget, name); } }, icon('dots', 'sm'))),
    h('div', { class: 'track-row' }, chip),
    h('div', { class: 'track-row track-mix' }, vol, pan, db),
    h('div', { class: 'meter' }, meter));

    el.addEventListener('dragstart', (e) => {
      if (e.target !== el) return;
      e.dataTransfer.setData(TRACK_MIME, t.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes(TRACK_MIME)) return;
      e.preventDefault();
      el.classList.add('drop-before');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before'));
    el.addEventListener('drop', (e) => {
      const id = e.dataTransfer.getData(TRACK_MIME);
      el.classList.remove('drop-before');
      if (!id || id === t.id) return;
      e.preventDefault();
      e.stopPropagation();
      store.moveTrack(id, store.project.tracks.indexOf(t));
    });
    // inputs must not start a track drag
    for (const input of [vol, pan]) input.addEventListener('mousedown', () => { el.draggable = false; });
    el.addEventListener('mouseup', () => { el.draggable = true; });

    this.rows.set(t.id, { el, meter, chip });
    return el;
  }

  rename(t, nameEl) {
    nameEl.contentEditable = 'true';
    nameEl.focus();
    document.getSelection().selectAllChildren(nameEl);
    const done = (save) => {
      nameEl.contentEditable = 'false';
      const v = nameEl.textContent.trim();
      if (save && v && v !== t.name) this.store.commit('Rename track', () => { t.name = v.slice(0, 60); });
      else nameEl.textContent = t.name;
    };
    nameEl.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
      if (e.key === 'Escape') { nameEl.textContent = t.name; nameEl.blur(); }
    };
    nameEl.onblur = () => done(true);
  }

  menu(t, anchor, nameEl) {
    const store = this.store;
    const idx = store.project.tracks.indexOf(t);
    openMenu(anchor, [
      { label: 'Rename', icon: 'edit', onClick: () => this.rename(t, nameEl) },
      { label: 'Color…', icon: 'sparkles', onClick: () => this.colorMenu(t, anchor) },
      { label: 'Duplicate', icon: 'copy', onClick: () => store.duplicateTrack(t.id) },
      t.type !== 'audio' ? { label: 'Track settings', icon: 'sliders', onClick: () => { store.select(t.id); this.app.showTab('track'); } } : null,
      '-',
      { label: 'Move up', icon: 'chevron', disabled: idx === 0, onClick: () => store.moveTrack(t.id, idx - 1) },
      { label: 'Move down', icon: 'chevron', disabled: idx === store.project.tracks.length - 1, onClick: () => store.moveTrack(t.id, idx + 2) },
      '-',
      t.type !== 'audio' ? { label: 'Clear notes', icon: 'eraser', onClick: async () => {
        if (t.notes.length && await confirmDialog({ title: 'Clear notes?', message: `Remove all ${t.notes.length} notes from "${t.name}"? (Undo is available.)`, confirm: 'Clear', danger: true })) store.commit('Clear notes', () => { t.notes = []; });
      } } : null,
      { label: 'Delete track', icon: 'trash', danger: true, onClick: () => this.app.deleteTrack(t) },
    ].filter(Boolean));
  }

  colorMenu(t, anchor) {
    const menu = openMenu(anchor, [{ header: 'Track color' }]);
    menu.append(h('div', { class: 'color-row', style: { padding: '4px 8px 8px' } },
      TRACK_COLORS.map((c) => h('button', {
        class: c === t.color ? 'on' : '', style: { '--c': c },
        onclick: () => { this.store.commit('Track color', () => { t.color = c; }); menu.remove(); },
      }))));
  }

  updateSelection() {
    for (const [id, r] of this.rows) r.el.classList.toggle('selected', id === this.store.selectedTrackId);
  }

  updateStates() {
    for (const t of this.store.project.tracks) {
      const r = this.rows.get(t.id);
      if (!r) continue;
      const dot = r.chip.querySelector('.state');
      const inst = t.type === 'audio' ? { state: 'ready' } : peekInstrument(t.instrument);
      dot.className = `state ${inst?.state || ''}`;
      dot.title = inst?.state === 'error' ? `Failed: ${inst.error?.message || ''} (click Sounds tab to retry)` : inst?.state || '';
    }
  }

  updateMeters() {
    for (const [id, r] of this.rows) {
      const lvl = this.app.engine.level(id);
      const pct = Math.min(100, Math.sqrt(lvl) * 100);
      r.lvl = Math.max(pct, (r.lvl || 0) * 0.86);
      r.meter.style.height = `${r.lvl}%`;
    }
  }
}
