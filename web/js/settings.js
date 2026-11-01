// Per-browser preferences (localStorage, best effort).
import { Emitter } from './util.js';

const KEY = 'basicdaw.settings.v1';
const OLD_KEY = 'nebula.settings.v1'; // from before the app was renamed
const DEFAULTS = {
  library: 'FluidR3_GM',         // GM soundfont for new tracks / imports
  defaultKit: 'gm-fluid',
  monitor: true,                 // play incoming MIDI through the target track
  midinousRouting: 'channels',   // 'channels' = one track per Midinous channel, 'selected' = armed/selected track
  midinousSync: 'off',           // 'off' | 'basicdaw' (BasicDAW sends Start/Stop + clock) | 'midinous' (follow Midinous)
  followTempo: true,             // adopt Midinous' clock tempo when following
  recordQuantize: false,
  midiInputs: null,              // null = automatic (Midinous ports)
  lastProject: null,
  splitter: null,
  panel: true,
  panelTab: 'instruments',
  exportFormat: 'wav',
  exportOptions: {},            // per format: bit depth / bitrate / quality
  exportRate: 44100,
  exportArtist: '',
};

class Settings extends Emitter {
  constructor() {
    super();
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || localStorage.getItem(OLD_KEY) || '{}'); } catch { /* private mode */ }
    if (saved.midinousSync === 'nebula') saved.midinousSync = 'basicdaw';
    this.values = { ...DEFAULTS, ...saved };
  }
  get(k) { return this.values[k]; }
  set(k, v) {
    this.values[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(this.values)); } catch { /* ignore */ }
    this.emit('change', { key: k, value: v });
  }
}

export const settings = new Settings();
