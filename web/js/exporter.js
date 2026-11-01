// Mixdown export: WAV is written in the browser; FLAC, MP3, OGG, Opus and M4A are encoded by the server's ffmpeg,
// or by ffmpeg.wasm in the page where the server has none (the Android app).
import { h, icon, uid, download, safeFileName } from './util.js';
import { songEndBeats } from './store.js';
import { api } from './api.js';
import { settings } from './settings.js';
import { renderMix, encodeWav } from './audio/render.js';
import { wasmEncoderAvailable, wasmEncode } from './audio/wasm-encoder.js';
import { modal, toast } from './ui/dialogs.js';

const AAC_RATES = [['320', '320 kbps'], ['256', '256 kbps'], ['192', '192 kbps'], ['128', '128 kbps']];

// `args` are ffmpeg's output options for ffmpeg.wasm; they mirror Encoder._args in server.py.
export const FORMATS = {
  wav: {
    label: 'WAV', desc: 'Uncompressed', icon: 'wave', browser: true,
    options: { bits: { label: 'Bit depth', value: '16', choices: [['16', '16-bit PCM (CD quality)'], ['24', '24-bit PCM'], ['32', '32-bit float']] } },
  },
  flac: {
    label: 'FLAC', desc: 'Lossless, smaller', icon: 'wave', type: 'audio/flac',
    options: { bits: { label: 'Bit depth', value: '24', choices: [['16', '16-bit'], ['24', '24-bit']] } },
    args: (o) => ['-c:a', 'flac', '-compression_level', '8', ...(o.bits === '16' ? ['-sample_fmt', 's16'] : ['-sample_fmt', 's32', '-bits_per_raw_sample', '24'])],
  },
  mp3: {
    label: 'MP3', desc: 'Plays everywhere', icon: 'music', type: 'audio/mpeg',
    options: { bitrate: { label: 'Bitrate', value: '320', choices: AAC_RATES } },
    args: (o) => ['-c:a', 'libmp3lame', '-b:a', `${o.bitrate}k`, '-id3v2_version', '3'],
  },
  ogg: {
    label: 'OGG', desc: 'Vorbis, for games', icon: 'music', type: 'audio/ogg',
    options: { quality: { label: 'Quality', value: '8', choices: [['10', 'Maximum (q10, ~500 kbps)'], ['8', 'High (q8, ~256 kbps)'], ['6', 'Good (q6, ~192 kbps)'], ['4', 'Small (q4, ~128 kbps)']] } },
    args: (o) => ['-c:a', 'libvorbis', '-q:a', o.quality],
  },
  opus: {
    label: 'Opus', desc: 'Smallest files', icon: 'music', rate: 48000, type: 'audio/ogg',
    options: { bitrate: { label: 'Bitrate', value: '192', choices: [['256', '256 kbps'], ['192', '192 kbps'], ['160', '160 kbps'], ['128', '128 kbps'], ['96', '96 kbps']] } },
    args: (o) => ['-c:a', 'opus', '-strict', '-2', '-b:a', `${o.bitrate}k`], // ffmpeg.wasm's libopus crashes on stereo
  },
  m4a: {
    label: 'M4A', desc: 'AAC, for Apple', icon: 'music', type: 'audio/mp4',
    options: { bitrate: { label: 'Bitrate', value: '256', choices: AAC_RATES } },
    args: (o) => ['-c:a', 'aac', '-b:a', `${o.bitrate}k`, '-movflags', '+faststart'],
  },
};

const TAIL = 2.5; // seconds of release after the last note, as renderMix renders
const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const mb = (blob) => `${(blob.size / 1048576).toFixed(1)} MB`;

export class Exporter {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.busy = false;
  }

  /** Formats the server's ffmpeg writes, and whether ffmpeg.wasm can write the rest. */
  async capabilities() {
    const wasm = await wasmEncoderAvailable();
    try {
      return { ...await api.exportFormats(), wasm };
    } catch (err) {
      return { available: false, formats: [], error: err.message, wasm };
    }
  }

  async dialog(format = settings.get('exportFormat')) {
    const p = this.store.project;
    if (songEndBeats(p) <= 0) { toast('The project is empty - draw some notes first', { type: 'error' }); return; }
    const caps = this.caps = await this.capabilities();
    const usable = (id) => !!FORMATS[id] && (FORMATS[id].browser || caps.wasm || caps.formats.includes(id));
    const saved = settings.get('exportOptions') || {};
    const values = Object.fromEntries(Object.entries(FORMATS).map(([id, f]) => [id, {
      ...Object.fromEntries(Object.entries(f.options).map(([k, o]) => [k, o.value])),
      ...saved[id],
    }]));
    const seconds = songEndBeats(p) * 60 / p.bpm + TAIL;
    let fmt = usable(format) ? format : 'wav';

    const title = h('input', { class: 'input', value: p.name, spellcheck: 'false' });
    const artist = h('input', { class: 'input', value: settings.get('exportArtist') || '', placeholder: 'Optional', spellcheck: 'false' });
    const rate = h('select', { class: 'input' }, [44100, 48000].map((r) => h('option', { value: r, selected: r === settings.get('exportRate') }, `${r / 1000} kHz`)));
    const row = (label, control) => h('div', { class: 'form-row' }, h('label', {}, label), h('div', { class: 'grow' }, control));
    const opts = h('div', { class: 'export-opts' });
    const file = h('div', { class: 'export-file' });

    const cards = Object.entries(FORMATS).map(([id, f]) => [id, h('button', {
      class: 'template export-fmt', disabled: !usable(id), title: usable(id) ? '' : 'Needs ffmpeg', onclick: () => pick(id),
    }, icon(f.icon), h('b', {}, f.label), h('span', {}, f.desc))]);

    const pick = (id) => {
      fmt = id;
      const f = FORMATS[id];
      for (const [k, el] of cards) el.classList.toggle('active', k === id);
      const selects = Object.entries(f.options).map(([key, o]) => {
        if (!o.choices.some(([v]) => v === values[id][key])) values[id][key] = o.value;
        const sel = h('select', { class: 'input', onchange: () => { values[id][key] = sel.value; } },
          o.choices.map(([v, l]) => h('option', { value: v, selected: v === values[id][key] }, l)));
        return row(o.label, sel);
      });
      opts.replaceChildren(
        ...selects,
        row('Sample rate', f.rate ? h('div', { class: 'hint' }, `${f.rate / 1000} kHz - Opus always uses it`) : rate),
        ...(f.browser ? [] : [row('Title', title), row('Artist', artist)]));
      file.replaceChildren(icon('file-music', 'sm'), h('b', {}, `${safeFileName(p.name)}.${id}`), h('span', {}, `about ${clock(seconds)}`));
    };

    const missing = Object.keys(FORMATS).filter((id) => !usable(id)).map((id) => FORMATS[id].label);
    pick(fmt);
    modal({
      title: 'Export',
      sub: 'Renders the mixdown of every audible track',
      body: h('div', {},
        h('div', { class: 'export-fmts' }, cards.map(([, el]) => el)),
        opts,
        missing.length ? h('div', { class: 'hint export-note' }, icon('alert', 'sm'), h('span', {}, ffmpegNote(caps, missing))) : null),
      footLeft: file,
      actions: [
        { label: 'Cancel' },
        {
          label: 'Export', primary: true, icon: 'download', onClick: () => {
            settings.set('exportFormat', fmt);
            settings.set('exportOptions', values);
            settings.set('exportRate', Number(rate.value));
            settings.set('exportArtist', artist.value.trim());
            this.export(fmt, { ...values[fmt], rate: Number(rate.value), title: title.value.trim() || p.name, artist: artist.value.trim() });
          },
        },
      ],
    });
  }

  async export(fmt, opts) {
    if (this.busy) { toast('An export is already running', { type: 'error' }); return; }
    this.busy = true;
    const f = FORMATS[fmt];
    const p = this.store.project;
    const name = `${safeFileName(p.name)}.${fmt}`;
    const t = toast('Rendering mixdown…', { type: 'progress', id: 'render' });
    try {
      const buffer = await renderMix(p, { sampleRate: f.rate || opts.rate, tail: TAIL, onStatus: (s) => t.update(s, 'progress') });
      const blob = f.browser ? encodeWav(buffer, Number(opts.bits)) : await this.encode(fmt, opts, buffer, t);
      const where = await download(blob, name);
      t.update(where ? `Saved ${name} to ${where} (${mb(blob)})` : `Exported ${name} (${mb(blob)})`, 'ok');
      t.autoClose(4000);
    } catch (err) {
      t.update(err.message, 'error');
      t.autoClose(6000);
    } finally {
      this.busy = false;
    }
  }

  async encode(fmt, opts, buffer, t) {
    const f = FORMATS[fmt];
    if (!this.caps?.formats.includes(fmt)) return this.encodeInPage(fmt, opts, buffer, t);
    const job = uid('x');
    const params = { format: fmt, job, duration: buffer.duration.toFixed(3), title: opts.title, artist: opts.artist };
    for (const key of Object.keys(f.options)) params[key] = opts[key];
    t.update(`Encoding ${f.label}…`, 'progress');
    let done = false;
    const poll = setInterval(async () => {
      const v = await api.exportProgress(job).catch(() => null);
      if (!done && v != null) t.update(`Encoding ${f.label}… ${Math.round(v * 100)}%`, 'progress');
    }, 500);
    try {
      return await api.encode(params, encodeWav(buffer, 32));
    } finally {
      done = true;
      clearInterval(poll);
    }
  }

  async encodeInPage(fmt, opts, buffer, t) {
    const f = FORMATS[fmt];
    const tags = [['title', opts.title], ['artist', opts.artist], ['comment', 'Made with BasicDAW']]
      .filter(([, v]) => v).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
    t.update(`Encoding ${f.label}…`, 'progress');
    const data = await wasmEncode(encodeWav(buffer, 32), [...tags, ...f.args(opts)], fmt, {
      onStatus: (s) => t.update(s, 'progress'),
      onProgress: (v) => t.update(`Encoding ${f.label}… ${Math.round(v * 100)}%`, 'progress'),
    });
    return new Blob([data], { type: f.type });
  }
}

function ffmpegNote(caps, missing) {
  const list = missing.join(', ');
  if (caps.available) return `${list}: the installed ffmpeg has no encoder for ${missing.length > 1 ? 'these' : 'it'}.`;
  if (caps.error === 'ffmpeg is not installed') return [`${list} need ffmpeg, which is not installed. Install it (e.g. `, h('code', {}, 'sudo pacman -S ffmpeg'), '), then reopen this dialog.'];
  return `${list} are unavailable: ${caps.error}`;
}

