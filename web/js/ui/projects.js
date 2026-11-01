// Project manager: browse, create, open, rename, duplicate and delete projects.
import { h, icon, relTime, fill } from '../util.js';
import { api } from '../api.js';
import { modal, confirmDialog, promptDialog, toast } from './dialogs.js';

export const TEMPLATES = [
  { id: 'empty', icon: 'plus', name: 'Empty', desc: 'A blank canvas' },
  { id: 'starter', icon: 'sparkles', name: 'Starter beat', desc: 'Drums, bass, chords & lead' },
  { id: 'piano', icon: 'piano', name: 'Piano sketch', desc: 'One grand piano track' },
];

export class ProjectManager {
  constructor(app) {
    this.app = app;
    this.query = '';
  }

  async open() {
    let list = [];
    const grid = h('div', { class: 'proj-grid' }, h('div', { class: 'proj-empty' }, 'Loading projects…'));
    const search = h('input', { placeholder: 'Search projects…', spellcheck: 'false', value: this.query });
    const fileInput = h('input', { type: 'file', accept: '.mid,.midi,.json,audio/*', multiple: true, style: { display: 'none' } });
    fileInput.addEventListener('change', () => { m.close(); this.app.importer.importFiles([...fileInput.files]); });
    const render = () => {
      const q = this.query.toLowerCase();
      const items = list.filter((p) => !q || p.name.toLowerCase().includes(q));
      fill(grid,
        h('div', { class: 'proj-card proj-new', onclick: () => { m.close(); this.newProjectDialog(); } },
          h('div', { class: 'inner' }, icon('plus', 'lg'), 'New project', h('span', { class: 'hint' }, 'Start fresh or from a template'))),
        items.map((p) => this.card(p, m, refresh)),
      );
      if (!items.length && list.length) grid.append(h('div', { class: 'proj-empty' }, 'No projects match your search.'));
    };
    const refresh = async () => {
      try { list = await api.listProjects(); } catch (err) { toast(err.message, { type: 'error' }); }
      render();
    };
    search.addEventListener('input', () => { this.query = search.value; render(); });
    const m = modal({
      title: 'Projects',
      sub: 'Saved in basicdaw/projects on this computer',
      wide: true,
      body: h('div', {},
        h('div', { class: 'proj-toolbar' },
          h('div', { class: 'search' }, icon('search', 'sm'), search),
          h('button', { class: 'btn', onclick: () => fileInput.click() }, icon('upload', 'sm'), 'Import file…'),
          h('button', { class: 'btn primary', onclick: () => { m.close(); this.newProjectDialog(); } }, icon('plus', 'sm'), 'New project'),
          fileInput),
        grid),
    });
    await refresh();
  }

  card(p, m, refresh) {
    const current = p.id === this.app.store.project.id;
    const thumb = p.thumbnail
      ? h('img', { src: p.thumbnail, alt: '' })
      : h('div', { class: 'bars' }, (p.trackInfo || []).slice(0, 6).map((t, i) => h('i', { style: { '--c': t.color, width: `${40 + ((i * 37) % 55)}%`, marginLeft: `${(i * 13) % 30}%` } })));
    const act = (ic, title, fn, cls = '') => h('button', { class: cls, title, onclick: (e) => { e.stopPropagation(); fn(); } }, icon(ic, 'sm'));
    return h('div', { class: `proj-card ${current ? 'current' : ''}`, onclick: async () => { m.close(); await this.app.openProject(p.id); } },
      h('div', { class: 'proj-thumb' }, thumb, current ? h('span', { class: 'badge-current' }, 'OPEN') : null),
      h('div', { class: 'proj-actions' },
        act('edit', 'Rename', async () => {
          const name = await promptDialog({ title: 'Rename project', value: p.name, confirm: 'Rename' });
          if (!name) return;
          try {
            await api.renameProject(p.id, name);
            if (current) { this.app.store.project.name = name; this.app.updateTitle(); }
            refresh();
          } catch (err) { toast(err.message, { type: 'error' }); }
        }),
        act('copy', 'Duplicate', async () => {
          try { await api.duplicateProject(p.id, `${p.name} copy`); toast(`Duplicated "${p.name}"`, { type: 'ok' }); refresh(); } catch (err) { toast(err.message, { type: 'error' }); }
        }),
        act('trash', 'Delete', async () => {
          if (!await confirmDialog({ title: `Delete "${p.name}"?`, message: 'The project is moved to projects/.trash on disk, so it can still be recovered by hand.', confirm: 'Delete project', danger: true })) return;
          try {
            await api.deleteProject(p.id);
            toast(`Deleted "${p.name}"`, { type: 'ok' });
            if (current) await this.app.afterCurrentDeleted();
            refresh();
          } catch (err) { toast(err.message, { type: 'error' }); }
        }, 'del')),
      h('div', { class: 'proj-info' },
        h('b', {}, p.name),
        h('span', {}, `${relTime(p.modified)} · ${p.tracks} track${p.tracks === 1 ? '' : 's'} · ${p.notes} notes · ${Math.round(p.bpm)} BPM`)));
  }

  newProjectDialog() {
    let template = 'starter';
    const name = h('input', { class: 'input', value: 'Untitled', spellcheck: 'false', autofocus: true });
    const tiles = TEMPLATES.map((t) => {
      const el = h('div', { class: `template ${t.id === template ? 'active' : ''}`, onclick: () => { template = t.id; tiles.forEach((x) => x.classList.toggle('active', x === el)); } },
        icon(t.icon), h('b', {}, t.name), h('span', {}, t.desc));
      return el;
    });
    modal({
      title: 'New project',
      body: h('div', {},
        h('div', { class: 'form-row' }, h('label', {}, 'Name'), h('div', { class: 'grow' }, name)),
        h('div', { class: 'templates' }, tiles)),
      actions: [
        { label: 'Cancel' },
        { label: 'Create', primary: true, icon: 'plus', onClick: async () => { await this.app.newProject(name.value.trim() || 'Untitled', template); } },
      ],
    });
    setTimeout(() => { name.focus(); name.select(); }, 40);
  }
}
