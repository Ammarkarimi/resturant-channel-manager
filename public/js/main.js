// Start-up: decide between setup, login and the app; keep status live.

const POLL_MS = 3000;
let pollTimer = null;

/** Channel sync status for the header pill, plus the alerts banner. Every page uses it. */
async function refreshStatus() {
  const [channels, alerts] = await Promise.all([api('GET', '/api/channels'), api('GET', '/api/alerts')]);
  state.channels = channels;

  const on = channels.filter((c) => c.enabled);
  const pending = on.reduce((n, c) => n + c.pending, 0);
  const failed = on.reduce((n, c) => n + c.failed, 0);
  const pill = $('#sync-pill');
  if (on.length === 0) { pill.textContent = 'No channels connected'; pill.className = 'pill off'; }
  else if (failed) { pill.textContent = `${failed} update(s) failed`; pill.className = 'pill err'; }
  else if (pending) { pill.textContent = `Syncing ${pending}…`; pill.className = 'pill warn'; }
  else { pill.textContent = 'All channels in sync'; pill.className = 'pill ok'; }

  const box = $('#alerts');
  box.hidden = alerts.length === 0;
  box.innerHTML = alerts.map((a) => `<a class="alert ${a.level}" href="#/${a.page}">${esc(a.text)}</a>`).join('');
  const attention = alerts.filter((a) => a.page === 'bookings').length;
  $('#nav-attention').hidden = attention === 0;
  $('#nav-attention').textContent = '!';
}

function showScreen(name) {
  $('#screen-loading').hidden = true;
  $('#screen-auth').hidden = name !== 'auth';
  $('#screen-app').hidden = name !== 'app';
}

function showSetup() {
  showScreen('auth');
  $('#login-form').hidden = true;
  $('#setup-form').hidden = false;
  $('#setup-currency').innerHTML = currencyOptions('INR');
  $('#setup-form').hotel_name.focus();
}

function showLogin() {
  stopPolling();
  showScreen('auth');
  $('#setup-form').hidden = true;
  $('#login-form').hidden = false;
  $('#login-form').email.focus();
}

$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  try {
    const r = await api('POST', '/api/setup', { ...f, demo: e.target.demo.checked });
    startApp(r.user, r.property);
  } catch (err) {
    flash($('.msg', e.target), err.message, false);
  }
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('POST', '/api/auth/login', formData(e.target));
    e.target.password.value = '';
    startApp(r.user, r.property);
  } catch (err) {
    flash($('.msg', e.target), err.message, false);
  }
});

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

async function startApp(user, property) {
  state.user = user;
  state.property = property;
  $('#property-name').textContent = property.name;
  $('#user-name').textContent = user.name;
  document.title = `${property.name} · Channel Manager`;
  showScreen('app');
  await refreshStatus();
  // A brand-new hotel has no rooms yet: start in Settings.
  if (!location.hash) {
    const rooms = await api('GET', '/api/room-types');
    history.replaceState(null, '', rooms.length ? '#/calendar' : '#/settings');
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
    if (s.needs_setup) showSetup();
    else if (!s.user) showLogin();
    else await startApp(s.user, s.property);
  } catch (err) {
    $('#screen-loading').textContent = `Couldn't reach the server: ${err.message}`;
  }
})();
