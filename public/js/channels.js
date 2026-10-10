// Channels page: Channex connection, channel cards, demo OTA listings, sync log.

function renderChannels() {
  const html = state.channels.map((c) => {
    let status;
    if (!c.enabled) status = '<span class="badge off">Disconnected</span>';
    else if (c.failed) status = `<span class="badge err">${c.failed} failed</span>`;
    else if (c.pending && c.last_error) status = `<span class="badge err">Retrying ${c.pending}…</span>`;
    else if (c.pending) status = `<span class="badge warn">Syncing ${c.pending}…</span>`;
    else status = '<span class="badge ok">In sync</span>';
    return `
      <div class="channel ${c.kind === 'channex' ? 'provider' : ''}" data-code="${c.code}">
        <div class="channel-head"><strong>${esc(c.name)}${c.kind === 'simulated' ? ' <span class="muted small">(demo)</span>' : ''}</strong>${status}</div>
        <div class="muted small">Last push: ${timeAgo(c.last_success_at)}</div>
        ${c.last_error && c.enabled ? `<div class="err small">${esc(c.last_error)}</div>` : ''}
        <label class="check"><input type="checkbox" data-act="enabled" ${c.enabled ? 'checked' : ''}> Connected</label>
        <label class="inline small">Price markup
          <input type="number" data-act="markup" value="${c.rate_markup_pct}" step="0.5" min="-50" max="100"> %</label>
        ${c.kind === 'channex'
          ? '<div class="muted small">Reaches every OTA connected to your property in Channex.</div>'
          : `<label class="check small"><input type="checkbox" data-act="outage" ${c.simulate_outage ? 'checked' : ''}> Simulate API outage</label>
        <button data-act="listing">View on ${esc(c.name)}</button>`}
      </div>`;
  }).join('') || '<p class="muted">No channels yet. Connect Channex above to reach the OTAs.</p>';
  // Don't redraw under the cursor while someone is typing a markup.
  if (!document.activeElement?.matches('#channels input[type=number]')) $('#channels').innerHTML = html;
}

$('#channels').addEventListener('change', async (e) => {
  const code = e.target.closest('.channel')?.dataset.code;
  const act = e.target.dataset.act;
  if (!code || !act) return;
  const body = {};
  if (act === 'enabled') body.enabled = e.target.checked;
  if (act === 'outage') body.simulate_outage = e.target.checked;
  if (act === 'markup') body.rate_markup_pct = Number(e.target.value);
  try { await api('PATCH', `/api/channels/${code}`, body); } catch (err) { alert(err.message); }
  refreshStatus().then(renderChannels);
});
$('#channels').addEventListener('click', (e) => {
  if (e.target.dataset.act !== 'listing') return;
  state.listingChannel = e.target.closest('.channel').dataset.code;
  loadListing();
});
$('#listing-close').addEventListener('click', () => { state.listingChannel = null; $('#listing').hidden = true; });
$('#retry-all').addEventListener('click', async () => {
  await api('POST', '/api/sync/retry', {});
  await refreshStatus();
  renderChannels();
});

async function loadListing() {
  if (!state.listingChannel) return;
  const data = await api('GET', `/api/channels/${state.listingChannel}/listings?start=${state.calStart}&days=14`);
  $('#listing').hidden = false;
  $('#listing-title').textContent = `${data.channel.name}: what guests see`;
  const head = `<thead><tr><th></th>${data.dates.map((d) => `<th>${dayLabel(d)}</th>`).join('')}</tr></thead>`;
  const body = data.rooms.map((r) => `<tr><th>${esc(r.room_type_name)}<div class="muted small">${esc(r.external_room_id)}</div></th>${
    r.cells.map((c) => {
      if (!c.shown) return '<td class="cell stale">not sent</td>';
      const s = c.shown;
      return `<td class="cell ${s.closed ? 'closed' : ''} ${c.in_sync ? '' : 'stale'}">${
        s.closed ? '<span class="tag">Closed</span>' : `${money(s.rate)}<div class="small">${s.available} left</div>`
      }<div class="small">${c.in_sync ? '✓' : '⟳ pending'}</div></td>`;
    }).join('')}</tr>`).join('');
  $('#listing-table').innerHTML = head + `<tbody>${body}</tbody>`;
}

async function loadSyncLog() {
  const rows = await api('GET', '/api/sync/log');
  $('#sync-log').innerHTML = rows.length === 0
    ? '<tr><td class="muted">Nothing sent yet.</td></tr>'
    : `<thead><tr><th>When</th><th>Channel</th><th>Updates</th><th>Result</th></tr></thead><tbody>${
      rows.slice(0, 15).map((l) => `<tr><td>${timeAgo(l.created_at)}</td><td>${esc(l.channel_name)}</td><td>${l.cells}</td>
        <td class="${l.ok ? 'ok' : 'err'}">${esc(l.message)}</td></tr>`).join('')}</tbody>`;
}

// ---------- Connectivity provider (Channex) ----------

const provider = { status: null, editing: false, properties: null, rooms: null, propertyId: '' };

async function loadProvider() {
  const next = await api('GET', '/api/providers/channex');
  const changed = JSON.stringify(next) !== JSON.stringify(provider.status);
  provider.status = next;
  if (changed && !provider.editing) renderProvider();
}

function renderProvider() {
  const s = provider.status;
  const badge = $('#provider-badge');
  const body = $('#provider-body');
  if (!s.configured) {
    badge.className = 'badge off'; badge.textContent = 'Not set up';
    body.innerHTML = `
      <p>Channex is already approved by Booking.com, Agoda, MakeMyTrip, Expedia and many more. Connect once here and your
        rates and availability reach every OTA you switch on inside Channex, and their bookings come back here.</p>
      <ol class="steps">
        <li>Create an account at <strong>staging.channex.io</strong> (free sandbox) and add your property, room types and rate plans.</li>
        <li>In Channex, open your profile → <em>API Access</em> and create an API key.</li>
        <li>Put it in a <code>.env</code> file next to <code>package.json</code>: <code>CHANNEX_API_KEY=...</code></li>
        <li>Restart the server and come back here.</li>
      </ol>`;
    return;
  }
  const env = `<span class="badge ${s.environment === 'production' ? 'ok' : 'warn'}">${esc(s.environment)}</span>`;
  if (s.connected) {
    badge.className = 'badge ok'; badge.textContent = 'Connected';
    const pull = s.last_pull;
    const pullText = !pull.at ? 'not yet'
      : pull.ok ? `${timeAgo(pull.at)} · ${pull.processed} new` : `<span class="err">${timeAgo(pull.at)} failed: ${esc(pull.error)}</span>`;
    body.innerHTML = `
      <p><strong>${esc(s.property.title)}</strong> ${env} <span class="muted small">· ${esc(s.property.currency)}</span></p>
      <table class="list"><thead><tr><th>Your room type</th><th>Channex room type</th><th>Channex rate plan</th></tr></thead><tbody>
        ${s.mappings.map((m) => `<tr><td>${esc(m.room_type_name)}</td>
          <td>${esc(m.channex_room_type_title || m.channex_room_type_id)}</td>
          <td>${esc(m.channex_rate_plan_title || m.channex_rate_plan_id)}</td></tr>`).join('')}
      </tbody></table>
      <p class="muted small">Last booking check: ${pullText}</p>
      <div class="actions">
        <button id="pv-pull">Check for new bookings</button>
        <button id="pv-edit">Change mapping</button>
        <button id="pv-disconnect" class="danger">Disconnect</button>
        <span id="pv-msg" class="msg" role="status"></span>
      </div>`;
    return;
  }
  badge.className = 'badge warn'; badge.textContent = 'Ready to connect';
  body.innerHTML = `<p>Channex API key found ${env}. Choose your property and match its rooms to yours.</p>
    <div class="actions"><button id="pv-edit" class="primary">Set up connection</button></div>`;
}

async function openProviderEditor() {
  provider.editing = true;
  const body = $('#provider-body');
  body.innerHTML = '<p class="muted">Loading your Channex properties…</p>';
  try {
    await ensureRoomTypes();
    provider.properties = await api('GET', '/api/providers/channex/properties');
  } catch (err) {
    body.innerHTML = `<p class="err">${esc(err.message)}</p><div class="actions"><button id="pv-cancel">Back</button></div>`;
    return;
  }
  provider.propertyId = provider.status.property?.id || provider.properties[0]?.id || '';
  await renderProviderEditor();
}

async function renderProviderEditor() {
  const body = $('#provider-body');
  if (provider.properties.length === 0) {
    body.innerHTML = `<p>No properties found in this Channex account. Create one in Channex first.</p>
      <div class="actions"><button id="pv-cancel">Back</button></div>`;
    return;
  }
  provider.rooms = provider.propertyId ? await api('GET', `/api/providers/channex/properties/${provider.propertyId}/rooms`) : null;
  const current = Object.fromEntries((provider.status.mappings || []).map((m) => [m.room_type_id, m]));
  const roomOpts = (sel) => `<option value="">Don't send</option>${provider.rooms.room_types.map((rt) =>
    `<option value="${esc(rt.id)}" ${rt.id === sel ? 'selected' : ''}>${esc(rt.title)} (${rt.count_of_rooms} rooms)</option>`).join('')}`;
  body.innerHTML = `
    <form id="pv-form">
      <label>Channex property
        <select id="pv-property">${provider.properties.map((p) =>
          `<option value="${esc(p.id)}" ${p.id === provider.propertyId ? 'selected' : ''}>${esc(p.title)} · ${esc(p.currency)}</option>`).join('')}
        </select></label>
      <div class="scroll"><table class="list mapping"><thead><tr><th>Your room type</th><th>Channex room type</th><th>Channex rate plan</th></tr></thead><tbody>
        ${state.roomTypes.map((rt) => `<tr data-rt="${rt.id}">
          <td>${esc(rt.name)}</td>
          <td><select class="pv-room">${roomOpts(current[rt.id]?.channex_room_type_id)}</select></td>
          <td><select class="pv-plan"></select></td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted small">Only manually priced, per-room rate plans can be used. Connecting sends your next 500 days to Channex
        and switches off the demo channels.</p>
      <div class="actions">
        <button type="submit" class="primary">Connect</button>
        <button type="button" id="pv-cancel">Cancel</button>
        <span id="pv-msg" class="msg" role="status"></span>
      </div>
    </form>`;
  for (const tr of body.querySelectorAll('tr[data-rt]')) fillPlans(tr, current[tr.dataset.rt]?.channex_rate_plan_id);
}

function fillPlans(tr, selected) {
  const roomId = tr.querySelector('.pv-room').value;
  const plans = provider.rooms.rate_plans.filter((p) => p.room_type_id === roomId);
  const usable = plans.filter((p) => p.usable);
  const pick = selected && usable.some((p) => p.id === selected) ? selected : usable[0]?.id;
  tr.querySelector('.pv-plan').innerHTML = !roomId ? '<option value="">–</option>'
    : plans.length === 0 ? '<option value="">No rate plans</option>'
    : plans.map((p) => `<option value="${esc(p.id)}" ${p.usable ? '' : 'disabled'} ${p.id === pick ? 'selected' : ''}>${esc(p.title)}${
      p.usable ? '' : ` (${esc(p.sell_mode)}, ${esc(p.rate_mode)}: not supported)`}</option>`).join('');
}

$('#provider-body').addEventListener('change', async (e) => {
  if (e.target.id === 'pv-property') {
    provider.propertyId = e.target.value;
    await renderProviderEditor();
  } else if (e.target.classList.contains('pv-room')) {
    fillPlans(e.target.closest('tr'));
  }
});

$('#provider-body').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mappings = [...e.target.querySelectorAll('tr[data-rt]')]
    .map((tr) => ({
      room_type_id: Number(tr.dataset.rt),
      channex_room_type_id: tr.querySelector('.pv-room').value,
      channex_rate_plan_id: tr.querySelector('.pv-plan').value,
    }))
    .filter((m) => m.channex_room_type_id);
  try {
    const r = await api('POST', '/api/providers/channex/connect', { property_id: provider.propertyId, mappings });
    provider.editing = false;
    provider.status = r;
    renderProvider();
    if (r.warnings.length) flash($('#pv-msg'), r.warnings.join(' '), false);
    else flash($('#pv-msg'), 'Connected. Sending your calendar to Channex…');
    refreshStatus().then(renderChannels);
  } catch (err) {
    flash($('#pv-msg'), err.message, false);
  }
});

$('#provider-body').addEventListener('click', async (e) => {
  const id = e.target.id;
  if (id === 'pv-edit') openProviderEditor();
  if (id === 'pv-cancel') { provider.editing = false; renderProvider(); }
  if (id === 'pv-disconnect') {
    if (!confirm('Stop sending rates and availability to Channex?')) return;
    await api('POST', '/api/providers/channex/disconnect');
    refreshStatus().then(renderChannels);
  }
  if (id === 'pv-pull') {
    e.target.disabled = true;
    try {
      const r = await api('POST', '/api/providers/channex/pull');
      await refreshStatus().then(renderChannels);
      flash($('#pv-msg'), r.processed ? `${r.processed} booking update(s) received.` : 'No new bookings.');
    } catch (err) {
      await loadProvider();
      flash($('#pv-msg'), err.message, false);
    } finally {
      e.target.disabled = false;
    }
  }
});

Views.channels = {
  show: async () => {
    renderChannels();
    await Promise.all([loadProvider(), loadSyncLog(), loadListing()]);
  },
  poll: async () => {
    renderChannels();
    await Promise.all([loadProvider(), loadSyncLog(), loadListing()]);
  },
};
