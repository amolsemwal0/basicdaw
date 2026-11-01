// "Sounds" tab: browse online GM instruments, drum kits and built-in synths.
import { h, icon, bus, debounce, fill } from '../util.js';
import { GM_NAMES, GM_FAMILIES, LIBRARIES, DRUM_KITS, SYNTH_NAMES, instrumentLabel } from '../gm.js';
import { SYNTH_PRESETS } from '../audio/synth.js';
import { cachePath, specKey, peekInstrument } from '../audio/instruments.js';
import { INSTRUMENT_MIME } from './arranger.js';
import { api } from '../api.js';
import { settings } from '../settings.js';
import { confirmDialog, toast } from './dialogs.js';

export class InstrumentBrowser {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.store = app.store;
    this.query = '';
    this.open = new Set(['Piano']);
    this.cached = new Set();
    this.cacheBytes = 0;
    this.build();
    this.refreshCache();
    const refresh = debounce(() => this.refreshCache(), 600);
    bus.on('instrument-state', (inst) => { if (inst.state === 'ready') refresh(); this.updateCurrent(); });
    bus.on('instrument-progress', () => this.updateCurrent());
    this.store.on('select', () => this.updateCurrent());
    this.store.on('change', (e) => { if (e.kind !== 'transient') this.updateCurrent(); });
  }

  async refreshCache() {
    try {
      const info = await api.cache();
      this.cached = new Set(info.files);
      this.cacheBytes = info.bytes;
      this.renderList();
    } catch { /* server offline */ }
  }

  build() {
    const search = h('input', { placeholder: 'Search 160+ instruments…', spellcheck: 'false' });
    search.addEventListener('input', () => { this.query = search.value.trim().toLowerCase(); this.renderList(); });
    search.addEventListener('keydown', (e) => e.stopPropagation());
    const lib = h('select', { class: 'input lib-select', title: 'Soundfont used for General MIDI instruments' },
      LIBRARIES.map((l) => h('option', { value: l.id, selected: l.id === settings.get('library') }, `${l.name} - ${l.desc}`)));
    lib.addEventListener('change', () => { settings.set('library', lib.value); this.renderList(); });
    this.target = h('div', { class: 'hint', style: { margin: '2px 2px 10px' } });
    this.listEl = h('div');
    this.footer = h('div', { class: 'hint', style: { marginTop: '14px' } });
    this.el.append(
      h('div', { class: 'search' }, icon('search', 'sm'), search),
      h('div', { class: 'form-row' }, h('span', { class: 'lbl' }, 'Soundfont'), h('div', { class: 'grow' }, lib)),
      this.target,
      this.listEl,
      this.footer,
    );
    this.renderList();
  }

  groups() {
    const lib = settings.get('library');
    const out = GM_FAMILIES.map((f, fi) => ({
      name: f.name, color: f.color,
      items: Array.from({ length: 8 }, (_, k) => {
        const program = fi * 8 + k;
        return { name: GM_NAMES[program], spec: { kind: 'gm', library: lib, program }, sub: `GM ${program + 1}` };
      }),
    }));
    out.unshift({
      name: 'Drum Kits', color: '#fb7185',
      items: DRUM_KITS.map((k) => ({ name: k.name, sub: k.desc, spec: { kind: 'drums', kit: k.id } })),
    });
    out.splice(1, 0, {
      name: 'BasicDAW Synths', color: '#22d3ee',
      items: Object.entries(SYNTH_PRESETS).map(([id, p]) => ({ name: SYNTH_NAMES[id] || id, sub: `${p.cat} · offline`, spec: { kind: 'synth', preset: id } })),
    });
    return out;
  }

  renderList() {
    const q = this.query;
    const groups = this.groups();
    this.listEl.replaceChildren();
    if (q) {
      const hits = groups.flatMap((g) => g.items.map((it) => ({ ...it, color: g.color, group: g.name })))
        .filter((it) => `${it.name} ${it.group} ${it.sub}`.toLowerCase().includes(q));
      if (!hits.length) this.listEl.append(h('div', { class: 'hint', style: { padding: '12px 4px' } }, 'No instruments match.'));
      this.listEl.append(h('div', {}, hits.map((it) => this.item(it, it.color))));
    } else {
      for (const g of groups) {
        const isOpen = this.open.has(g.name);
        const cat = h('div', { class: `cat ${isOpen ? 'open' : ''}` },
          h('button', {
            class: 'cat-head',
            onclick: () => { if (this.open.has(g.name)) this.open.delete(g.name); else this.open.add(g.name); cat.classList.toggle('open'); },
          }, h('span', { class: 'dot', style: { '--c': g.color } }), g.name, h('span', { class: 'count' }, g.items.length), icon('chevron', 'sm chev')),
          h('div', { class: 'cat-items' }, g.items.map((it) => this.item(it, g.color))));
        this.listEl.append(cat);
      }
    }
    const mb = (this.cacheBytes / 1048576).toFixed(1);
    fill(this.footer,
      h('div', {}, 'Instruments are downloaded once from free online libraries (gleitz MIDI.js soundfonts, surikov WebAudioFont, Tone.js samples) and cached on disk.'),
      h('div', { style: { marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px' } },
        icon('cloud', 'sm'), `${mb} MB cached`,
        h('button', { class: 'btn tiny', style: { marginLeft: 'auto' }, onclick: () => this.clearCache() }, 'Clear cache')),
    );
    this.updateCurrent();
  }

  item(it, color) {
    const path = cachePath(it.spec);
    const cached = it.spec.kind === 'synth' || (it.spec.kind === 'drums' && it.spec.kit === 'synth-808') || (path && this.cached.has(path));
    const el = h('div', {
      class: 'inst', draggable: true, title: `${it.name} - click to use on the selected track, drag onto the arranger for a new track`,
      dataset: { key: specKey(it.spec) },
      onclick: () => this.app.assignInstrument(it.spec),
    },
    h('span', { class: 'dot', style: { width: '6px', height: '6px', borderRadius: '2px', background: color, flex: 'none' } }),
    h('span', { class: 'nm' }, it.name),
    h('span', { class: `badge ${cached ? 'cached' : ''}`, title: cached ? 'Downloaded' : 'Downloads on first use' }, icon(cached ? 'check' : 'cloud', 'xs')),
    h('button', {
      class: 'icon-btn sm prev', title: 'Preview',
      onclick: (e) => { e.stopPropagation(); this.app.preview.phrase(it.spec); },
    }, icon('play', 'xs')));
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(INSTRUMENT_MIME, JSON.stringify(it.spec));
      e.dataTransfer.setData('text/plain', it.name);
      e.dataTransfer.effectAllowed = 'copy';
    });
    return el;
  }

  updateCurrent() {
    const t = this.store.selectedTrack;
    const key = t && t.type !== 'audio' ? specKey(t.instrument) : null;
    for (const el of this.listEl.querySelectorAll('.inst')) el.classList.toggle('current', el.dataset.key === key);
    if (t && t.type !== 'audio') {
      const inst = peekInstrument(t.instrument);
      const state = inst?.state === 'loading' ? ` · downloading ${Math.round((inst.progress || 0) * 100)}%` : inst?.state === 'error' ? ' · failed to load' : '';
      this.target.replaceChildren('Click a sound to use it on ', h('b', {}, t.name), ` (now: ${instrumentLabel(t.instrument)}${state}). Drag onto the arranger to add a new track.`);
      if (inst?.state === 'error') {
        this.target.append(' ', h('button', { class: 'btn tiny', onclick: () => inst.retry() }, 'Retry'));
      }
    } else {
      this.target.textContent = 'Click a sound to add a new track with it, or drag it onto the arranger.';
    }
  }

  async clearCache() {
    if (!await confirmDialog({ title: 'Clear the instrument cache?', message: 'Downloaded instruments are deleted from disk and downloaded again the next time they are used. Instruments already loaded stay usable until you reload the page.', confirm: 'Clear cache', danger: true })) return;
    try {
      const r = await api.clearCache();
      toast(`Removed ${r.removed} cached files`, { type: 'ok' });
      this.refreshCache();
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  }
}
