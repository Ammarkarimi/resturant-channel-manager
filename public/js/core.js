// Shared helpers, state and the page router. Loaded first.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SAR', 'QAR', 'SGD', 'THB', 'MYR', 'IDR', 'LKR', 'NPR', 'BDT',
  'MVR', 'AUD', 'NZD', 'CAD', 'JPY', 'CNY', 'HKD', 'ZAR', 'KES', 'CHF'];

const state = {
  user: null,
  property: null,
  roomTypes: [],
  channels: [],
  calStart: todayStr(),
  listingChannel: null,
  view: null,
};

function todayStr() { return new Date().toISOString().slice(0, 10); }
function addDays(s, n) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(n, currency = state.property?.currency || 'INR') {
  if (n == null || n === '') return '';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${currency} ${Math.round(n)}`;
  }
}
function dayLabel(s) {
  const d = new Date(`${s}T00:00:00Z`);
  return `<span class="dow">${WEEKDAYS[d.getUTCDay()]}</span>${d.getUTCDate()} ${d.toLocaleString(undefined, { month: 'short', timeZone: 'UTC' })}`;
}
function shortDate(s) {
  return new Date(`${s}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
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

/** Show a message next to a form. */
function flash(el, text, ok = true) {
  if (!el) return;
  el.textContent = text;
  el.className = `msg ${ok ? 'ok' : 'err'}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ''; }, 7000);
}

/** Called when the session has expired; set by main.js. */
let onLoggedOut = () => {};

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'x-requested-with': 'channel-manager', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/') && !path.startsWith('/api/setup')) {
    onLoggedOut();
  }
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

// ---------- Router ----------
// Each page registers { show, poll } in Views. show() runs when the page
// opens; poll() runs every few seconds while it is open.

const Views = {};

function currentRoute() {
  const name = location.hash.replace(/^#\/?/, '').split('?')[0];
  return Views[name] ? name : 'calendar';
}

async function showView() {
  const name = currentRoute();
  state.view = name;
  for (const el of $$('.view')) el.hidden = el.dataset.view !== name;
  for (const a of $$('[data-nav]')) a.classList.toggle('active', a.dataset.nav === name);
  try {
    await Views[name].show?.();
  } catch (err) {
    if (err.status !== 401) console.error(err);
  }
}

window.addEventListener('hashchange', showView);
