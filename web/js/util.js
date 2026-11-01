// Small DOM / math helpers shared by every module.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

let counter = 0;
export const uid = (prefix = '') =>
  prefix + Date.now().toString(36).slice(-5) + (counter++).toString(36) + Math.random().toString(36).slice(2, 6);

/** h('div', {class: 'x', onclick: fn, style: {color: 'red'}}, child, 'text', [more]) */
export function h(tag, attrs = {}, ...children) {
  const el = tag === 'svg' || tag === 'use' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val); else el.style[prop] = val;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Replace an element's children; arrays are flattened and null / false entries skipped. */
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `ic ${cls}`.trim());
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export class Emitter {
  constructor() { this._handlers = new Map(); }
  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }
  off(event, fn) { this._handlers.get(event)?.delete(fn); }
  emit(event, data) {
    for (const fn of [...(this._handlers.get(event) || [])]) {
      try { fn(data); } catch (err) { console.error(`[${event}]`, err); }
    }
  }
}

/** Global event bus for cross-module notifications (instrument loading etc.). */
export const bus = new Emitter();

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (p) => NOTE_NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);
export const isBlackKey = (p) => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);

export function fmtTime(sec) {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec * 1000) % 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export function relTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const d = (Date.now() - t) / 1000;
  if (d < 45) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 86400 * 7) return `${Math.round(d / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

let saveHandler = null;
/** Saves downloads another way, e.g. through the server in the Android app (a WebView can't download blobs). */
export const setSaveHandler = (fn) => { saveHandler = fn; };

/** Downloads (or saves) a file; resolves with where it was saved when that is known. */
export async function download(blob, filename) {
  if (saveHandler) return saveHandler(blob, filename);
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export const safeFileName = (s) => (s || 'untitled').replace(/[^\w\- .()[\]]+/g, '_').trim() || 'untitled';

export function hexToRgb(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [139, 92, 246];
}
export const rgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };
export function shade(hex, f) {
  const [r, g, b] = hexToRgb(hex).map((c) => clamp(Math.round(f > 0 ? c + (255 - c) * f : c * (1 + f)), 0, 255));
  return `rgb(${r},${g},${b})`;
}

/** Keep a range input's filled-track CSS variable in sync (WebKit only, harmless elsewhere). */
export function paintRange(input) {
  const p = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--p', `${p}%`);
}

export const TRACK_COLORS = ['#8b5cf6', '#22d3ee', '#f472b6', '#34d399', '#fbbf24', '#fb7185', '#60a5fa', '#a3e635', '#f97316', '#2dd4bf', '#e879f9', '#facc15'];

export function lowerBound(arr, value, key) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]) < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function roundRect(g, x, y, w, ht, r) {
  r = Math.max(0, Math.min(r, w / 2, ht / 2));
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + ht, r);
  g.arcTo(x + w, y + ht, x, y + ht, r);
  g.arcTo(x, y + ht, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Small circular "loop" arrow centered on (x, y), in the current stroke style. */
export function loopGlyph(g, x, y, r = 3.6) {
  const a = Math.PI * 1.7;
  const ex = x + r * Math.cos(a), ey = y + r * Math.sin(a);
  const tx = -Math.sin(a), ty = Math.cos(a), nx = Math.cos(a), ny = Math.sin(a);
  g.save();
  g.lineWidth = 1.4;
  g.beginPath();
  g.arc(x, y, r, Math.PI * 0.15, a);
  g.stroke();
  g.fillStyle = g.strokeStyle;
  g.beginPath();
  g.moveTo(ex + tx * 2.6, ey + ty * 2.6);
  g.lineTo(ex + nx * 2.4, ey + ny * 2.4);
  g.lineTo(ex - nx * 2.4, ey - ny * 2.4);
  g.closePath();
  g.fill();
  g.restore();
}

/** Canvas sized to its parent with device-pixel-ratio scaling. */
export function fitCanvas(canvas, w, ht) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(w * dpr));
  const H = Math.max(1, Math.round(ht * dpr));
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${ht}px`;
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

export const isTyping = () => {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};
