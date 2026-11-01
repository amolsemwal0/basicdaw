// Modals, confirmation/prompt dialogs, dropdown menus and toasts.
import { $, h, icon } from '../util.js';

let openModals = 0;
export const modalOpen = () => openModals > 0;

export function modal({ title, sub, body, actions = [], wide = false, onClose, footLeft } = {}) {
  const root = $('#modal-root');
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    openModals--;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.(result);
  };
  const foot = actions.length || footLeft
    ? h('div', { class: 'modal-foot' },
      footLeft ? h('div', { class: 'left' }, footLeft) : null,
      actions.map((a) => h('button', {
        class: `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`,
        disabled: a.disabled,
        onclick: async (e) => {
          if (a.onClick) {
            const r = await a.onClick(e);
            if (r === false) return;
          }
          if (a.close !== false) close(a.value);
        },
      }, a.icon ? icon(a.icon) : null, a.label)))
    : null;
  const box = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', tabindex: '-1' },
    h('div', { class: 'modal-head' },
      h('div', {}, h('h2', {}, title || ''), sub ? h('div', { class: 'sub' }, sub) : null),
      h('button', { class: 'icon-btn close', title: 'Close (Esc)', onclick: () => close() }, icon('x'))),
    h('div', { class: 'modal-body' }, body),
    foot);
  const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === backdrop) close(); } }, box);
  const onKey = (e) => {
    if (root.lastElementChild !== backdrop) return; // only the top-most dialog handles keys
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA') {
      const primary = box.querySelector('.modal-foot .btn.primary:not([disabled])');
      if (primary && (e.target.tagName === 'INPUT' || e.target === document.body || e.target === box)) { e.preventDefault(); e.stopPropagation(); primary.click(); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  openModals++;
  root.append(backdrop);
  // Take focus from whatever opened the dialog, so Enter / Space can't press that button again underneath.
  setTimeout(() => (box.querySelector('input[autofocus], input.input, .input') || box).focus(), 30);
  return { close, el: box, body: box.querySelector('.modal-body') };
}

export function confirmDialog({ title = 'Are you sure?', message = '', confirm = 'OK', danger = false, cancel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    modal({
      title,
      body: h('p', {}, message),
      actions: [
        { label: cancel, value: false },
        { label: confirm, primary: !danger, danger, value: true },
      ],
      onClose: (v) => resolve(v === true),
    });
  });
}

/** Three-way choice. Resolves with the chosen value or null. */
export function choiceDialog({ title, message, choices }) {
  return new Promise((resolve) => {
    modal({
      title,
      body: h('p', {}, message),
      actions: choices.map((c) => ({ ...c })),
      onClose: (v) => resolve(v ?? null),
    });
  });
}

export function promptDialog({ title, label = 'Name', value = '', confirm = 'OK', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', value, placeholder, autofocus: true, spellcheck: false });
    let result = null;
    modal({
      title,
      body: h('div', {}, h('div', { class: 'hint', style: { marginBottom: '6px' } }, label), input),
      actions: [
        { label: 'Cancel' },
        { label: confirm, primary: true, onClick: () => { result = input.value.trim(); if (!result) { input.focus(); return false; } } },
      ],
      onClose: () => resolve(result),
    });
    setTimeout(() => { input.focus(); input.select(); }, 40);
  });
}

// ------------------------------------------------------------------ menus

let currentMenu = null;
export function closeMenu() {
  currentMenu?.remove();
  currentMenu = null;
}
document.addEventListener('mousedown', (e) => { if (currentMenu && !currentMenu.contains(e.target)) closeMenu(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('blur', closeMenu);

/** items: [{label, icon, kbd, danger, onClick} | '-' | {header}] ; anchor: element or {x, y} */
export function openMenu(anchor, items) {
  closeMenu();
  const menu = h('div', { class: 'menu' }, items.map((it) => {
    if (it === '-') return h('hr');
    if (it.header) return h('div', { class: 'menu-label' }, it.header);
    return h('button', {
      class: it.danger ? 'danger' : '',
      disabled: it.disabled,
      onclick: () => { closeMenu(); it.onClick?.(); },
    }, it.icon ? icon(it.icon) : h('span', { style: { width: '18px' } }), it.label, it.kbd ? h('kbd', {}, it.kbd) : null);
  }));
  $('#menu-root').append(menu);
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y, top: anchor.y, right: anchor.x };
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let x = r.left, y = r.bottom + 6;
  if (x + mw > innerWidth - 8) x = Math.max(8, (anchor instanceof Element ? r.right : r.left) - mw);
  if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 6);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  currentMenu = menu;
  return menu;
}

// ------------------------------------------------------------------ toasts

const toastsById = new Map();
/** toast(message, {type: 'info'|'ok'|'error'|'progress', id, timeout}) */
export function toast(message, { type = 'info', id, timeout } = {}) {
  if (id && toastsById.has(id)) {
    const t = toastsById.get(id);
    t.update(message, type);
    if (timeout !== undefined || type !== 'progress') t.autoClose(timeout ?? 3200);
    return t;
  }
  const ic = { info: 'sparkles', ok: 'check', error: 'alert', progress: 'refresh' };
  const msg = h('div', { class: 'msg' }, message);
  const el = h('div', { class: `toast ${type}` }, icon(ic[type] || 'sparkles'), msg);
  $('#toasts').append(el);
  let timer;
  const api = {
    el,
    update(m, ty = type) {
      msg.textContent = m;
      el.className = `toast ${ty}`;
      el.querySelector('use').setAttribute('href', `#i-${ic[ty] || 'sparkles'}`);
    },
    close() {
      clearTimeout(timer);
      if (id) toastsById.delete(id);
      el.classList.add('out');
      setTimeout(() => el.remove(), 220);
    },
    autoClose(ms) { clearTimeout(timer); timer = setTimeout(api.close, ms); },
  };
  if (id) toastsById.set(id, api);
  if (type !== 'progress' || timeout) api.autoClose(timeout ?? (type === 'error' ? 6000 : 3200));
  return api;
}
