// Shared helpers, state, permissions, dialog and the page router. Loaded first.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MEAL_PLANS = { EP: 'Room only (EP)', CP: 'Breakfast (CP)', MAP: 'Half board (MAP)', AP: 'Full board (AP)', OTHER: 'Other' };
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SAR', 'QAR', 'OMR', 'SGD', 'THB', 'MYR', 'IDR', 'LKR', 'NPR', 'BDT',
  'MVR', 'AUD', 'NZD', 'CAD', 'JPY', 'CNY', 'HKD', 'ZAR', 'KES', 'CHF'];
// Must match src/permissions.js. The server enforces these; the UI just hides what can't be used.
const ROLE_PERMISSIONS = {
  admin: ['view', 'reports', 'bookings', 'rates', 'channels', 'setup', 'users'],
  manager: ['view', 'reports', 'bookings', 'rates', 'channels', 'setup'],
  front_desk: ['view', 'reports', 'bookings'],
  viewer: ['view', 'reports'],
};
const ROLE_NAMES = { admin: 'Admin', manager: 'Revenue manager', front_desk: 'Front desk', viewer: 'Viewer' };

const state = {
  user: null,
  properties: [],
  property: null,
  roomTypes: [],
  channels: [],
  calStart: todayStr(),
  listingChannel: null,
  view: null,
  roles: {},
};

const can = (permission) => Boolean(state.user && ROLE_PERMISSIONS[state.user.role]?.includes(permission));

function todayStr() { return new Date().toISOString().slice(0, 10); }
function addDays(s, n) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(n, currency = state.property?.currency || 'INR', digits = 0) {
  if (n == null || n === '') return '';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: digits }).format(n);
  } catch {
    return `${currency} ${Math.round(n)}`;
  }
}
const pct = (n) => (n == null ? '–' : `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`);
function change(n) {
  if (n == null) return '<span class="muted small">no data last year</span>';
  const cls = n > 0 ? 'up' : n < 0 ? 'down' : '';
  return `<span class="delta ${cls}">${n > 0 ? '▲' : n < 0 ? '▼' : '•'} ${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 1 })}% vs last year</span>`;
}
function dayLabel(s) {
  const d = new Date(`${s}T00:00:00Z`);
  return `<span class="dow">${WEEKDAYS[d.getUTCDay()]}</span>${d.getUTCDate()} ${d.toLocaleString(undefined, { month: 'short', timeZone: 'UTC' })}`;
}
function shortDate(s) {
  return new Date(`${s}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
function longDate(s) {
  return new Date(`${s}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleString();
}
function currencyOptions(selected) {
  const list = CURRENCIES.includes(selected) || !selected ? CURRENCIES : [selected, ...CURRENCIES];
  return list.map((c) => `<option ${c === selected ? 'selected' : ''}>${c}</option>`).join('');
}
function options(list, selected, { empty } = {}) {
  return (empty !== undefined ? `<option value="">${esc(empty)}</option>` : '')
    + list.map(([value, label, disabled]) => `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${esc(label)}</option>`).join('');
}

/** Show a message next to a form. */
function flash(el, text, ok = true) {
  if (!el) return;
  el.textContent = text;
  el.className = `msg ${ok ? 'ok' : 'err'}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ''; }, 8000);
}

/** Called when the session has expired; set by main.js. */
let onLoggedOut = () => {};

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'x-requested-with': 'channel-manager',
      ...(state.property ? { 'x-property-id': String(state.property.id) } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/') && !path.startsWith('/api/setup')) onLoggedOut();
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Read a form into an object of trimmed strings. */
function formData(form) {
  return Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
}
const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

/** Hide controls the user's role can't use (elements with data-requires="permission"). */
function applyPermissions(root = document) {
  for (const el of $$('[data-requires]', root)) el.classList.toggle('denied', !can(el.dataset.requires));
}

// ---------- Dialog ----------

/**
 * Open the shared dialog. onSave(form) runs on Save; the dialog stays open
 * (showing the error) if it throws, and closes when it succeeds.
 */
function openDialog({ title, body, saveLabel = 'Save', onSave, onOpen, wide = false, cancelLabel = 'Cancel' }) {
  const dlg = $('#dialog');
  const form = $('#dialog-form');
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = body;
  $('#dialog-msg').textContent = '';
  $('#dialog-save').textContent = saveLabel;
  $('#dialog-save').hidden = !onSave;
  $('#dialog-actions button[value=cancel]').textContent = onSave ? cancelLabel : 'Close';
  dlg.classList.toggle('wide', wide);
  form.onsubmit = async (e) => {
    if (e.submitter?.value !== 'save' || !onSave) return;
    e.preventDefault();
    const btn = $('#dialog-save');
    btn.disabled = true;
    try {
      const keepOpen = await onSave(form);
      if (!keepOpen) dlg.close();
    } catch (err) {
      flash($('#dialog-msg'), err.message, false);
    } finally {
      btn.disabled = false;
    }
  };
  dlg.returnValue = '';
  dlg.showModal();
  onOpen?.(form);
}

// ---------- Tooltip (charts and calendar) ----------

function showTooltip(target, html) {
  const tip = $('#tooltip');
  tip.innerHTML = html;
  tip.hidden = false;
  const r = target.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - t.width - 8));
  const top = r.top - t.height - 8 < 8 ? r.bottom + 8 : r.top - t.height - 8;
  tip.style.left = `${left + window.scrollX}px`;
  tip.style.top = `${top + window.scrollY}px`;
}
function hideTooltip() { $('#tooltip').hidden = true; }

/** Elements with data-tip show it on hover and keyboard focus. */
for (const type of ['pointerover', 'focusin']) {
  document.addEventListener(type, (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el) showTooltip(el, el.dataset.tip);
  });
}
for (const type of ['pointerout', 'focusout']) {
  document.addEventListener(type, (e) => { if (e.target.closest?.('[data-tip]')) hideTooltip(); });
}

// ---------- Router ----------
// Each page registers { show, poll } in Views. show() runs when the page
// opens; poll() runs every few seconds while it is open.

const Views = {};

function currentRoute() {
  const name = location.hash.replace(/^#\/?/, '').split('?')[0];
  return Views[name] ? name : 'dashboard';
}

async function showView() {
  const name = currentRoute();
  state.view = name;
  for (const el of $$('.view')) el.hidden = el.dataset.view !== name;
  for (const a of $$('[data-nav]')) a.classList.toggle('active', a.dataset.nav === name);
  hideTooltip();
  try {
    await Views[name].show?.();
  } catch (err) {
    if (err.status !== 401) console.error(err);
  }
  applyPermissions();
}

window.addEventListener('hashchange', showView);
