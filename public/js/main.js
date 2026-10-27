// Start-up: setup, login (with two-factor), the property switcher, live status.

const POLL_MS = 4000;
const PROPERTY_KEY = 'cm.property';
let pollTimer = null;
let loginChallenge = null;

/** Channel sync status for the header pill, plus the alerts banner. Every page uses it. */
async function refreshStatus() {
  const [channels, alerts] = await Promise.all([api('GET', '/api/channels'), api('GET', '/api/alerts')]);
  state.channels = channels;

  const on = channels.filter((c) => c.enabled);
  const pending = on.reduce((n, c) => n + c.pending, 0);
  const failed = on.reduce((n, c) => n + c.failed, 0);
  const pill = $('#sync-pill');
  if (on.length === 0) { pill.textContent = 'No channels connected'; pill.className = 'pill off'; }
  else if (failed) { pill.textContent = `⚠ ${failed} update(s) failed`; pill.className = 'pill err'; }
  else if (pending) { pill.textContent = `⟳ Syncing ${pending}…`; pill.className = 'pill warn'; }
  else { pill.textContent = '✓ All channels in sync'; pill.className = 'pill ok'; }

  const box = $('#alerts');
  box.hidden = alerts.length === 0;
  box.innerHTML = alerts.map((a) => `<a class="alert ${a.level}" href="#/${a.page}">⚠ ${esc(a.text)}</a>`).join('');
  $('#nav-attention').hidden = !alerts.some((a) => a.page === 'bookings');
}

function showScreen(name) {
  $('#screen-loading').hidden = true;
  $('#screen-auth').hidden = name !== 'auth';
  $('#screen-app').hidden = name !== 'app';
}

function showAuthForm(id) {
  showScreen('auth');
  for (const f of ['#setup-form', '#login-form', '#code-form']) $(f).hidden = f !== id;
  $(id).querySelector('input')?.focus();
}

function showSetup() {
  $('#setup-currency').innerHTML = currencyOptions('INR');
  showAuthForm('#setup-form');
}

function showLogin() {
  stopPolling();
  loginChallenge = null;
  showAuthForm('#login-form');
}

$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('POST', '/api/setup', { ...formData(e.target), demo: e.target.demo.checked });
    await startApp(r.user, r.properties);
  } catch (err) {
    flash($('.msg', e.target), err.message, false);
  }
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('POST', '/api/auth/login', formData(e.target));
    e.target.password.value = '';
    if (r.two_factor_required) {
      loginChallenge = r.challenge;
      $('#code-form').code.value = '';
      showAuthForm('#code-form');
      return;
    }
    await startApp(r.user, r.properties);
  } catch (err) {
    flash($('.msg', e.target), err.message, false);
  }
});

$('#code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('POST', '/api/auth/login/verify', { challenge: loginChallenge, code: e.target.code.value });
    await startApp(r.user, r.properties);
  } catch (err) {
    flash($('.msg', e.target), err.message, false);
    if (/expired/.test(err.message)) setTimeout(showLogin, 1500);
  }
});
$('#code-back').addEventListener('click', showLogin);

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout').catch(() => {});
  state.user = null;
  showLogin();
});

onLoggedOut = () => {
  if (state.user) {
    state.user = null;
    showLogin();
    flash($('.msg', $('#login-form')), 'Your session ended. Please log in again.', false);
  }
};

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function renderPropertySwitch() {
  const sel = $('#property-switch');
  sel.innerHTML = options(state.properties.map((p) => [p.id, p.name]), state.property?.id);
  sel.hidden = state.properties.length < 2;
  $('#property-name').hidden = state.properties.length >= 2;
  $('#property-name').textContent = state.property?.name || '';
  document.title = `${state.property?.name || 'Hotel'} · Channel Manager`;
}

/** Work on another property; every page reloads its data for it. */
async function switchProperty(id, hash) {
  const p = state.properties.find((x) => x.id === id);
  if (!p) return;
  state.property = p;
  try { localStorage.setItem(PROPERTY_KEY, String(id)); } catch { /* private mode */ }
  state.listingChannel = null;
  $('#listing').hidden = true;
  bulkBuiltFor = '';
  renderPropertySwitch();
  await refreshStatus();
  if (hash && location.hash !== hash) location.hash = hash;
  else await showView();
}
$('#property-switch').addEventListener('change', (e) => switchProperty(Number(e.target.value)));

async function startApp(user, properties) {
  state.user = user;
  state.properties = properties;
  if (properties.length === 0) {
    showScreen('auth');
    flash($('.msg', $('#login-form')), 'Your account has no properties yet. Ask an admin to give you access.', false);
    showAuthForm('#login-form');
    return;
  }
  let saved = null;
  try { saved = Number(localStorage.getItem(PROPERTY_KEY)); } catch { /* private mode */ }
  // The property used last on this device, else the oldest one (usually the main hotel).
  state.property = properties.find((p) => p.id === saved) || [...properties].sort((a, b) => a.id - b.id)[0];
  $('#user-name').textContent = user.name;
  $('#user-role').textContent = ROLE_NAMES[user.role] || user.role;
  renderPropertySwitch();
  applyPermissions();
  showScreen('app');
  await refreshStatus();
  // A brand-new hotel has no rooms yet: start in Settings.
  if (!location.hash) {
    const rooms = await api('GET', '/api/room-types');
    history.replaceState(null, '', rooms.length ? '#/dashboard' : '#/settings');
  }
  await showView();
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.hidden || !state.user || $('dialog[open]')) return;
    Promise.all([refreshStatus(), Views[state.view]?.poll?.()]).catch(() => {});
  }, POLL_MS);
}

(async function boot() {
  try {
    const s = await api('GET', '/api/session');
    state.roles = s.roles || {};
    if (s.needs_setup) showSetup();
    else if (!s.user) showLogin();
    else await startApp(s.user, s.properties);
  } catch (err) {
    $('#screen-loading').textContent = `Couldn't reach the server: ${err.message}`;
  }
})();

// Installable on phones; works as an app shell when the network drops.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
