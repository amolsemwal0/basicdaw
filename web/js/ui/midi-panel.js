// "MIDI" tab: inputs, outputs, virtual ports, computer keyboard, defaults.
import { h, icon, fill } from '../util.js';
import { settings } from '../settings.js';
import { DRUM_KITS } from '../gm.js';
import { toast } from './dialogs.js';

export class MidiPanel {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.hub = app.hub;
    this.hub.on('status', () => this.render());
    this.hub.on('octave', () => this.render());
    this.render();
    setInterval(() => this.pulse(), 120);
  }

  pulse() {
    if (this.el.classList.contains('hidden')) return;
    const now = performance.now();
    for (const led of this.el.querySelectorAll('[data-port]')) {
      const t = this.hub.activity.get(led.dataset.port) || 0;
      led.classList.toggle('on', now - t < 160 || led.dataset.open === '1');
      led.style.boxShadow = now - t < 160 ? '0 0 12px #fff' : '';
    }
  }

  async toggleInput(port, on) {
    const st = this.hub.status;
    const current = new Set(st.auto ? (st.open || []) : (st.wanted || []));
    if (on) current.add(port); else current.delete(port);
    const wanted = [...current];
    settings.set('midiInputs', wanted);
    try { await this.hub.setWanted(wanted); } catch (err) { toast(err.message, { type: 'error' }); }
  }

  async setAuto(auto) {
    const wanted = auto ? null : (this.hub.status.open || []);
    settings.set('midiInputs', wanted);
    try { await this.hub.setWanted(wanted); } catch (err) { toast(err.message, { type: 'error' }); }
  }

  render() {
    const st = this.hub.status;
    const sw = (checked, label, sub, onChange) => {
      const input = h('input', { type: 'checkbox', checked });
      input.addEventListener('change', () => onChange(input.checked));
      return h('label', { class: 'switch' }, input, h('span', { class: 'knob' }), h('span', { class: 'txt' }, label, sub ? h('small', {}, sub) : null));
    };
    const inputs = st.inputs || [];
    const webIns = this.hub.inputs.filter((p) => p.startsWith('web:'));
    const kit = h('select', { class: 'input' }, DRUM_KITS.map((k) => h('option', { value: k.id, selected: k.id === settings.get('defaultKit') }, k.name)));
    kit.addEventListener('change', () => settings.set('defaultKit', kit.value));
    const q = this.app.qwerty;

    fill(this.el,
      h('div', { class: 'section' },
        h('div', { class: 'section-title' }, h('span', {}, 'MIDI bridge'), icon('midi', 'sm')),
        h('div', { class: 'card' },
          h('div', { class: 'status-row' }, h('span', { class: `led ${st.available ? 'ok' : 'warn'}` }), 'System MIDI', h('span', { class: 'val' }, st.available ? (st.connected ? 'connected' : 'reconnecting…') : 'unavailable')),
          !st.available ? h('div', { class: 'hint' }, st.error || '')
            : st.virtualIn !== null ? h('div', { class: 'hint' }, 'Other apps can connect to ', h('code', {}, st.virtualIn || 'BasicDAW In'), ' and ', h('code', {}, st.virtualOut || 'BasicDAW Out'), '.')
              : h('div', { class: 'hint' }, 'This system has no virtual MIDI ports: to connect other apps, create a loopback port (e.g. loopMIDI on Windows).'))),
      h('div', { class: 'section' },
        h('div', { class: 'section-title' }, h('span', {}, 'Inputs'), icon('download', 'sm')),
        sw(!!st.auto, 'Automatic', 'Listen to Midinous ports as soon as they appear', (v) => this.setAuto(v)),
        inputs.length || webIns.length
          ? [...inputs.map((p) => {
            const open = (st.open || []).includes(p);
            const c = h('input', { type: 'checkbox', checked: open });
            c.addEventListener('change', () => this.toggleInput(p, c.checked));
            return h('label', { class: 'port-item', style: { cursor: 'pointer' } }, h('span', { class: `act ${open ? 'on' : ''}`, dataset: { port: p, open: open ? '1' : '0' } }), h('span', { class: 'nm', title: p }, p), c);
          }), ...webIns.map((p) => h('div', { class: 'port-item' }, h('span', { class: 'act on', dataset: { port: p, open: '1' } }), h('span', { class: 'nm' }, p), h('span', { class: 'hint' }, 'Web MIDI')))]
          : h('div', { class: 'hint' }, 'No MIDI inputs found.'),
        st.virtualIn !== null ? h('div', { class: 'port-item' }, h('span', { class: 'act on', dataset: { port: st.virtualIn || 'BasicDAW In', open: '1' } }), h('span', { class: 'nm' }, `${st.virtualIn || 'BasicDAW In'} (virtual)`)) : null,
        h('button', {
          class: 'btn tiny', style: { marginTop: '6px' },
          onclick: async () => { try { await this.hub.enableWebMidi(); toast('Web MIDI enabled', { type: 'ok' }); this.render(); } catch (err) { toast(err.message, { type: 'error' }); } },
        }, 'Also use browser Web MIDI')),
      h('div', { class: 'section' },
        h('div', { class: 'section-title' }, h('span', {}, 'Outputs'), icon('upload', 'sm')),
        (this.hub.outputs.length ? this.hub.outputs : ['-']).map((p) => h('div', { class: 'port-item' }, h('span', { class: 'act' }), h('span', { class: 'nm', title: p }, p))),
        h('div', { class: 'hint', style: { marginTop: '4px' } }, 'Pick an output per track in the Track tab.')),
      h('div', { class: 'section' },
        h('div', { class: 'section-title' }, h('span', {}, 'Playing & recording'), icon('keyboard', 'sm')),
        sw(q.enabled, 'Computer keyboard piano', `A W S E D F T G Y H U J K · Z/X octave (now ${q.octave}) · C/V velocity`, (v) => this.app.setQwerty(v)),
        sw(!!settings.get('monitor'), 'Monitor MIDI input', 'Play incoming notes through the target track', (v) => settings.set('monitor', v)),
        sw(!!settings.get('recordQuantize'), 'Quantize recording', 'Snap recorded notes to 1/16', (v) => settings.set('recordQuantize', v)),
        h('button', { class: 'btn tiny', style: { marginTop: '6px' }, onclick: () => { this.app.panic(); toast('All notes off', { type: 'ok' }); } }, icon('x', 'xs'), 'Panic (all notes off)')),
      h('div', { class: 'section' },
        h('div', { class: 'section-title' }, h('span', {}, 'Defaults'), icon('settings', 'sm')),
        h('div', { class: 'form-row' }, h('label', {}, 'Drum kit'), h('div', { class: 'grow' }, kit)),
        h('div', { class: 'hint' }, 'Used for imported MIDI drum channels and new drum tracks. The GM soundfont is chosen in the Sounds tab.')),
    );
  }
}
