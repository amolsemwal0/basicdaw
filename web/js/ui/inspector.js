// "Track" tab: settings of the selected track.
import { h, icon, paintRange, TRACK_COLORS, noteName } from '../util.js';
import { instrumentLabel, instrumentSub, LIBRARIES } from '../gm.js';
import { fmtDb } from '../audio/engine.js';
import { beatsPerBar, songEndBeats, trackLoop } from '../store.js';

export class Inspector {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.store = app.store;
    this.store.on('select', () => this.render());
    this.store.on('project', () => this.render());
    this.store.on('change', (e) => { if (e.kind !== 'transient' && e.kind !== 'mix') this.render(); });
    app.hub.on('status', () => { if (this.visible) this.render(); });
    this.render();
  }

  get visible() { return !this.el.classList.contains('hidden'); }

  slider(t, key, label, min, max, step, fmt) {
    const store = this.store;
    const input = h('input', { type: 'range', min, max, step, class: 'grow' });
    input.value = t[key];
    paintRange(input);
    const val = h('span', { class: 'hint', style: { width: '44px', textAlign: 'right', fontFamily: 'var(--mono)' } }, fmt(t[key]));
    let before = null;
    input.addEventListener('pointerdown', () => { before = store.snapshot(); });
    input.addEventListener('input', () => {
      t[key] = Number(input.value);
      paintRange(input);
      val.textContent = fmt(t[key]);
      this.app.engine.sync(store.project);
      store.transient();
    });
    input.addEventListener('change', () => { if (before) store.pushUndo(before, label); before = null; store.touch('mix'); });
    return h('div', { class: 'form-row' }, h('label', {}, label), input, val);
  }

  render() {
    const t = this.store.selectedTrack;
    const store = this.store;
    this.el.replaceChildren();
    if (!t) {
      this.el.append(h('div', { class: 'hint', style: { padding: '8px' } }, 'Select a track to see its settings.'));
      return;
    }
    const name = h('input', { class: 'input', value: t.name, spellcheck: 'false' });
    name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); });
    name.addEventListener('change', () => { const v = name.value.trim(); if (v) store.commit('Rename track', () => { t.name = v.slice(0, 60); }); });

    const colors = h('div', { class: 'color-row' }, TRACK_COLORS.map((c) => h('button', {
      class: c === t.color ? 'on' : '', style: { '--c': c }, title: c,
      onclick: () => store.commit('Track color', () => { t.color = c; }),
    })));

    const sections = [
      h('div', { class: 'section' },
        h('div', { class: 'section-title' }, h('span', {}, 'Track'), icon('sliders', 'sm')),
        h('div', { class: 'form-row' }, h('label', {}, 'Name'), h('div', { class: 'grow' }, name)),
        h('div', { class: 'form-row' }, h('label', {}, 'Color'), colors)),
    ];

    if (t.type !== 'audio') {
      const libSel = t.instrument?.kind === 'gm'
        ? h('select', { class: 'input' }, LIBRARIES.map((l) => h('option', { value: l.id, selected: l.id === t.instrument.library }, l.name)))
        : null;
      libSel?.addEventListener('change', () => this.app.assignInstrument({ ...t.instrument, library: libSel.value }));
      sections.push(h('div', { class: 'section' },
        h('div', { class: 'section-title' }, h('span', {}, 'Sound'), icon('piano', 'sm')),
        h('div', { class: 'card' },
          h('div', { style: { fontWeight: 700, fontSize: '13px' } }, instrumentLabel(t.instrument)),
          h('div', { class: 'hint' }, instrumentSub(t.instrument)),
          h('div', { style: { display: 'flex', gap: '6px', marginTop: '10px' } },
            h('button', { class: 'btn small', onclick: () => this.app.showInstrumentBrowser() }, icon('search', 'sm'), 'Change sound'),
            h('button', { class: 'btn small', onclick: () => this.app.preview.phrase(t.instrument, t.id) }, icon('play', 'sm'), 'Preview'))),
        libSel ? h('div', { class: 'form-row' }, h('label', {}, 'Soundfont'), h('div', { class: 'grow' }, libSel)) : null,
        this.switchRow('Play built-in sound', 'Turn off to only drive external MIDI gear', t.internal !== false, (v) => store.commit('Internal sound', () => { t.internal = v; }))));
    }

    sections.push(h('div', { class: 'section' },
      h('div', { class: 'section-title' }, h('span', {}, 'Mix'), icon('volume', 'sm')),
      this.slider(t, 'volume', 'Volume', 0, 1, 0.01, (v) => `${fmtDb(v)} dB`),
      this.slider(t, 'pan', 'Pan', -1, 1, 0.01, (v) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`)),
      this.slider(t, 'reverb', 'Reverb', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`)));

    if (t.type !== 'audio') {
      const outs = this.app.hub.outputs;
      const outSel = h('select', { class: 'input' },
        h('option', { value: '' }, 'None'),
        [...new Set([...outs, ...(t.midiOut ? [t.midiOut] : [])])].map((o) => h('option', { value: o, selected: o === t.midiOut }, o)));
      outSel.addEventListener('change', () => store.commit('MIDI out', () => { t.midiOut = outSel.value || null; }));
      const chSel = h('select', { class: 'input' }, Array.from({ length: 16 }, (_, i) => h('option', { value: i + 1, selected: i + 1 === (t.midiOutChannel || 1) }, `Ch ${i + 1}`)));
      chSel.addEventListener('change', () => store.commit('MIDI channel', () => { t.midiOutChannel = Number(chSel.value); }));
      const mnSel = h('select', { class: 'input' },
        h('option', { value: '' }, 'Not linked'),
        Array.from({ length: 16 }, (_, i) => h('option', { value: i + 1, selected: t.midinousChannel === i + 1 }, `Channel ${i + 1}`)),
        h('option', { value: 'drums', selected: t.midinousChannel === 'drums' }, 'Drum channels'));
      mnSel.addEventListener('change', () => store.commit('Midinous link', () => {
        const v = mnSel.value;
        for (const other of store.project.tracks) if (other !== t && String(other.midinousChannel) === v) other.midinousChannel = null;
        t.midinousChannel = v === '' ? null : v === 'drums' ? 'drums' : Number(v);
      }));
      sections.push(h('div', { class: 'section' },
        h('div', { class: 'section-title' }, h('span', {}, 'Routing'), icon('midi', 'sm')),
        h('div', { class: 'form-row' }, h('label', {}, 'MIDI out'), h('div', { class: 'grow' }, outSel)),
        h('div', { class: 'form-row' }, h('label', {}, 'Out channel'), h('div', { class: 'grow' }, chSel)),
        h('div', { class: 'form-row' }, h('label', {}, 'Midinous in'), h('div', { class: 'grow' }, mnSel)),
        h('div', { class: 'hint' }, 'MIDI out sends this track\'s notes to another app or device (e.g. "BasicDAW Out"). "Midinous in" plays and records the chosen Midinous channel on this track.')));

      const n = t.notes.length;
      let lo = 127, hi = 0, end = 0;
      for (const x of t.notes) { lo = Math.min(lo, x.pitch); hi = Math.max(hi, x.pitch); end = Math.max(end, x.start + x.duration); }
      const tr = (s) => store.commit('Transpose', () => t.notes.forEach((x) => { x.pitch = Math.max(0, Math.min(127, x.pitch + s)); }));
      const bpb = beatsPerBar(store.project);
      const lp = trackLoop(store.project, t);
      let loopInfo = null;
      if (lp) {
        const a = Math.round(lp.start / bpb) + 1, b = Math.round(lp.end / bpb);
        const last = Math.ceil(songEndBeats(store.project) / bpb - 1e-6);
        loopInfo = `${a === b ? `bar ${a}` : `bars ${a}-${b}`}, ${last > b ? `repeats through bar ${last}` : 'plays once (no longer track yet)'}`;
      }
      sections.push(h('div', { class: 'section' },
        h('div', { class: 'section-title' }, h('span', {}, 'Notes'), icon('music', 'sm')),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Notes'), h('dd', {}, String(n)),
          h('dt', {}, 'Range'), h('dd', {}, n ? `${noteName(lo)} - ${noteName(hi)}` : '-'),
          h('dt', {}, 'Length'), h('dd', {}, n ? `${(end / bpb).toFixed(1)} bars` : '-'),
          loopInfo ? [h('dt', {}, 'Loop'), h('dd', {}, loopInfo)] : null),
        this.switchRow('Loop until the song ends', 'Repeat these notes until the last non-looping track ends', !!t.loop,
          (v) => store.commit(v ? 'Loop on' : 'Loop off', () => { t.loop = v; })),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px' } },
          h('button', { class: 'btn tiny', disabled: !n, onclick: () => tr(-12) }, '-1 oct'),
          h('button', { class: 'btn tiny', disabled: !n, onclick: () => tr(-1) }, '-1 st'),
          h('button', { class: 'btn tiny', disabled: !n, onclick: () => tr(1) }, '+1 st'),
          h('button', { class: 'btn tiny', disabled: !n, onclick: () => tr(12) }, '+1 oct'),
          h('button', { class: 'btn tiny', disabled: !n, onclick: () => this.app.roll.quantize() }, 'Quantize'))));
    } else {
      sections.push(h('div', { class: 'section' },
        h('div', { class: 'section-title' }, h('span', {}, 'Clips'), icon('wave', 'sm')),
        t.clips.length ? t.clips.map((c) => h('div', { class: 'file-item' },
          icon('wave', 'sm'),
          h('div', { class: 'meta' }, h('b', {}, c.name || c.file), h('span', {}, `${c.duration.toFixed(1)} s · starts at bar ${(c.start / 4 + 1).toFixed(2)}`)),
          h('button', { class: 'icon-btn sm', title: 'Remove clip', onclick: () => store.commit('Remove clip', () => { t.clips = t.clips.filter((x) => x !== c); }) }, icon('trash', 'sm'))))
          : h('div', { class: 'hint' }, 'Drop an audio file onto the arranger to add a clip.'),
        h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Drag clips left/right in the arranger (hold Shift for fine steps).')));
    }

    sections.push(h('div', { style: { display: 'flex', gap: '6px' } },
      h('button', { class: 'btn small', onclick: () => store.duplicateTrack(t.id) }, icon('copy', 'sm'), 'Duplicate'),
      h('button', { class: 'btn small danger', onclick: () => this.app.deleteTrack(t) }, icon('trash', 'sm'), 'Delete')));
    this.el.append(...sections);
  }

  switchRow(label, sub, checked, onChange) {
    const input = h('input', { type: 'checkbox', checked });
    input.addEventListener('change', () => onChange(input.checked));
    return h('label', { class: 'switch' }, input, h('span', { class: 'knob' }), h('span', { class: 'txt' }, label, sub ? h('small', {}, sub) : null));
  }
}
