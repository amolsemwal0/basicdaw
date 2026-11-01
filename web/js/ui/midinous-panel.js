// "Midinous" tab: live link (monitor / record / transport sync) and document import / export.
import { h, icon, relTime, fill } from '../util.js';
import { api } from '../api.js';
import { settings } from '../settings.js';
import { renderToSong, exportPayload } from '../midinous.js';
import { modal, toast, confirmDialog } from './dialogs.js';

export class MidinousPanel {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.status = null;
    this.files = { documents: [], presets: [], midi: [] };
    this.filter = 'documents';
    this.seconds = 32;
    app.hub.on('status', () => this.renderLive());
    this.build();
    this.refresh();
  }

  async refresh() {
    try {
      const [status, files] = await Promise.all([api.midinousStatus(), api.midinousFiles()]);
      this.status = status;
      this.files = files;
      this.app.live.setMidinousChannels(status.channels);
    } catch (err) {
      this.status = { error: err.message };
    }
    this.renderStatus();
    this.renderFiles();
    this.app.updatePills();
  }

  build() {
    this.statusEl = h('div', { class: 'card' });
    this.liveEl = h('div');
    this.filesEl = h('div');
    this.el.append(
      h('div', { class: 'section' },
        h('div', { class: 'section-title' }, h('span', {}, 'Midinous'), h('button', { class: 'icon-btn sm', title: 'Refresh', onclick: () => this.refresh() }, icon('refresh', 'sm'))),
        this.statusEl),
      h('div', { class: 'section' }, h('div', { class: 'section-title' }, h('span', {}, 'Live link'), icon('link', 'sm')), this.liveEl),
      h('div', { class: 'section' }, h('div', { class: 'section-title' }, h('span', {}, 'Import from Midinous'), icon('download', 'sm')), this.filesEl),
      h('div', { class: 'section' },
        h('div', { class: 'section-title' }, h('span', {}, 'Send to Midinous'), icon('send', 'sm')),
        h('div', { class: 'card' },
          h('p', { class: 'hint', style: { marginTop: 0 } }, 'Turn this project into a Midinous document: every track becomes looping lanes of note points on its own MIDI channel. Open it in Midinous with Ctrl+O.'),
          h('button', { class: 'btn small primary block', onclick: () => this.exportDialog() }, icon('send', 'sm'), 'Send project to Midinous…'))),
    );
    this.renderLive();
  }

  renderStatus() {
    const s = this.status || {};
    const hub = this.app.hub.status;
    const row = (ok, label, val, warn) => h('div', { class: 'status-row' }, h('span', { class: `led ${ok ? 'ok' : warn ? 'warn' : 'off'}` }), label, h('span', { class: 'val' }, val));
    fill(this.statusEl,
      row(hub.midinousRunning, 'Midinous app', hub.midinousRunning ? 'running · ports found' : 'not running', false),
      row(s.engine, 'Document engine', s.engine ? 'MidinousMCP loaded' : 'unavailable', !s.engine),
      row(s.userDirExists, 'User folder', s.userDirExists ? '~/.local/share/Midinous' : 'not found', !s.userDirExists),
      !s.engine && s.error ? h('div', { class: 'hint', style: { marginTop: '6px' } }, s.error) : null,
    );
  }

  renderLive() {
    if (!this.liveEl) return;
    this.renderStatus();
    const hub = this.app.hub.status;
    const ports = (hub.inputs || []).filter((p) => p.includes('Midinous'));
    const radio = (key, value, title, sub) => {
      const input = h('input', { type: 'radio', name: key, checked: settings.get(key) === value });
      const el = h('label', { class: `radio ${settings.get(key) === value ? 'active' : ''}` }, input, h('div', {}, h('b', {}, title), h('span', {}, sub)));
      input.addEventListener('change', () => { settings.set(key, value); this.renderLive(); });
      return el;
    };
    const sw = (key, label, sub) => {
      const input = h('input', { type: 'checkbox', checked: !!settings.get(key) });
      input.addEventListener('change', () => settings.set(key, input.checked));
      return h('label', { class: 'switch' }, input, h('span', { class: 'knob' }), h('span', { class: 'txt' }, label, h('small', {}, sub)));
    };
    fill(this.liveEl,
      h('div', { class: 'card' },
        ports.length
          ? ports.map((p) => h('div', { class: 'port-item' }, h('span', { class: `act ${(hub.open || []).includes(p) ? 'on' : ''}` }), h('span', { class: 'nm' }, p), h('span', { class: 'hint' }, (hub.open || []).includes(p) ? 'listening' : 'off')))
          : h('div', { class: 'hint' }, hub.available ? 'Start Midinous - its "Midinous Port" appears here automatically and BasicDAW starts listening.' : (hub.error || 'MIDI bridge unavailable')),
        sw('monitor', 'Play incoming notes', 'Hear Midinous through BasicDAW\'s instruments'),
      ),
      h('div', { class: 'hint', style: { margin: '10px 2px 6px' } }, 'Where Midinous notes go'),
      h('div', { class: 'radio-group' },
        radio('midinousRouting', 'channels', 'One track per channel', 'Tracks are created automatically (sound picked from Midinous\' instruments)'),
        radio('midinousRouting', 'selected', 'Armed / selected track', 'Everything plays on the armed tracks, or the selected one')),
      h('div', { class: 'hint', style: { margin: '12px 2px 6px' } }, 'Transport sync'),
      h('div', { class: 'radio-group' },
        radio('midinousSync', 'off', 'Off', 'Start and stop each app separately'),
        radio('midinousSync', 'basicdaw', 'BasicDAW leads', 'Play/Stop and tempo clock are sent to Midinous - set its document clock source to External'),
        radio('midinousSync', 'midinous', 'Midinous leads', 'BasicDAW starts/stops (and records) when Midinous does - clock source Internal')),
      settings.get('midinousSync') === 'midinous' ? sw('followTempo', 'Follow Midinous tempo', 'Adopt the BPM from its MIDI clock') : null,
      h('div', { class: 'hint', style: { marginTop: '10px' } },
        h('b', {}, 'Record Midinous: '), 'pick a routing, press ', h('kbd', {}, 'R'), ' (record) and ', h('kbd', {}, 'Space'),
        ' - or with "Midinous leads" just press play in Midinous.'),
    );
  }

  renderFiles() {
    const f = this.files;
    const lists = { documents: f.documents.filter((d) => !d.autosave), midi: f.midi, presets: f.presets, autosaves: f.documents.filter((d) => d.autosave) };
    const labels = { documents: 'Documents', midi: 'MIDI exports', presets: 'Presets', autosaves: 'Autosaves' };
    const chips = h('div', { class: 'chips' }, Object.keys(labels).filter((k) => k !== 'presets' || lists.presets.length).map((k) => h('button', {
      class: `chip ${this.filter === k ? 'active' : ''}`,
      onclick: () => { this.filter = k; this.renderFiles(); },
    }, labels[k], h('span', { style: { opacity: 0.7 } }, lists[k].length))));
    const secs = h('input', { class: 'input', type: 'number', min: 2, max: 600, value: this.seconds, style: { width: '80px' } });
    secs.addEventListener('change', () => { this.seconds = Math.max(2, Math.min(600, Number(secs.value) || 32)); });
    secs.addEventListener('keydown', (e) => e.stopPropagation());
    const items = lists[this.filter] || [];
    const isDoc = this.filter !== 'midi';
    fill(this.filesEl,
      chips,
      isDoc ? h('div', { class: 'form-row' }, h('span', { class: 'lbl' }, 'Play for'), secs, h('span', { class: 'hint' }, 'seconds (documents are played by the Midinous engine)')) : null,
      h('div', { class: 'file-list' },
        items.length ? items.map((it) => h('div', { class: 'file-item' },
          icon(isDoc ? 'zap' : 'file-music', 'sm'),
          h('div', { class: 'meta' }, h('b', {}, it.name.replace(/\.(json|mid)$/i, '')), h('span', {}, relTime(it.modified))),
          h('button', { class: 'btn tiny', onclick: () => this.importFile(it) }, 'Import')))
          : h('div', { class: 'hint', style: { padding: '8px 2px' } }, this.status?.userDirExists === false ? 'Midinous user folder not found.' : 'Nothing here yet.')),
    );
  }

  async importFile(it) {
    const t = toast(`Reading ${it.name}…`, { type: 'progress', id: 'mn-import' });
    try {
      if (it.source === 'midi' || it.source === 'export') {
        const buf = await api.midinousMidi(it.name, it.source);
        t.close();
        await this.app.importer.importMidiBuffer(buf, it.name, { midinous: true });
      } else {
        const res = await api.midinousRender({ name: it.name, source: it.source, seconds: this.seconds });
        t.close();
        if (!res.notes.length) { toast(`Midinous played nothing (${res.stopReason})`, { type: 'error' }); return; }
        await this.app.importer.importSong(renderToSong(res));
      }
    } catch (err) {
      t.update(err.message, 'error');
      t.autoClose(6000);
    }
  }

  exportDialog() {
    const p = this.app.store.project;
    const candidates = p.tracks.filter((t) => t.type !== 'audio' && t.notes.length);
    if (!candidates.length) { toast('Draw or import some notes first', { type: 'error' }); return; }
    const name = h('input', { class: 'input', value: p.name, spellcheck: 'false' });
    const checks = candidates.map((t) => {
      const c = h('input', { type: 'checkbox', checked: true });
      return { t, c, el: h('label', { class: 'import-track' }, c, h('span', { class: 'sw', style: { '--c': t.color } }), h('span', { class: 'nm' }, t.name), h('span', { class: 'ct' }, `${t.notes.length} notes`)) };
    });
    const loop = h('input', { type: 'checkbox', checked: true });
    const clock = h('select', { class: 'input' },
      h('option', { value: 'Internal' }, 'Internal - Midinous plays on its own'),
      h('option', { value: 'External', selected: settings.get('midinousSync') === 'basicdaw' }, 'External - started by BasicDAW (BasicDAW leads)'));
    const run = async (overwrite = false) => {
      const tracks = checks.filter((x) => x.c.checked).map((x) => x.t);
      if (!tracks.length) { toast('Pick at least one track', { type: 'error' }); return false; }
      const { payload, channels } = exportPayload(p, tracks, { name: name.value.trim() || p.name, loop: loop.checked, clockSource: clock.value, overwrite });
      try {
        const res = await api.midinousExport(payload);
        this.app.store.commit('Link Midinous channels', () => { for (const t of tracks) t.midinousChannel = channels.get(t.id); });
        toast(`Saved "${res.name}" for Midinous (${res.lanes} lanes, ${res.points} points). Open it in Midinous with Ctrl+O.`, { type: 'ok', timeout: 7000 });
        for (const w of res.warnings || []) toast(w, { type: 'info', timeout: 8000 });
        this.refresh();
        return true;
      } catch (err) {
        if (err.status === 409 && await confirmDialog({ title: 'Replace document?', message: `${err.message}. Replace it? (Midinous keeps a backup.)`, confirm: 'Replace', danger: true })) return run(true);
        if (err.status !== 409) toast(err.message, { type: 'error' });
        return false;
      }
    };
    modal({
      title: 'Send to Midinous',
      sub: 'Creates a document in ~/.local/share/Midinous/user/save',
      body: h('div', {},
        h('div', { class: 'form-row' }, h('label', {}, 'Document'), h('div', { class: 'grow' }, name)),
        h('div', { class: 'form-row' }, h('label', {}, 'Clock source'), h('div', { class: 'grow' }, clock)),
        h('label', { class: 'check' }, loop, 'Loop the song forever (otherwise it plays once)'),
        h('div', { class: 'import-tracks' }, checks.map((x) => x.el)),
        h('div', { class: 'hint' }, 'Each track gets its own MIDI channel, and the tracks are linked to those channels so Midinous can play straight back into them.')),
      actions: [
        { label: 'Cancel' },
        { label: 'Send to Midinous', primary: true, icon: 'send', onClick: async () => (await run()) || false },
      ],
    });
  }
}
