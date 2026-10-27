// Channels page: Channex connection, channel cards, demo OTA listings, sync log.

function renderChannels() {
  const manage = can('channels');
  const html = state.channels.map((c) => {
    let status;
    if (!c.enabled) status = '<span class="badge off">Disconnected</span>';
    else if (c.failed) status = `<span class="badge err">⚠ ${c.failed} failed</span>`;
    else if (c.pending && c.last_error) status = `<span class="badge err">⚠ Retrying ${c.pending}…</span>`;
    else if (c.pending) status = `<span class="badge warn">Syncing ${c.pending}…</span>`;
    else status = '<span class="badge ok">✓ In sync</span>';
    return `
      <div class="channel ${c.kind === 'channex' ? 'provider' : ''}" data-code="${esc(c.code)}">
        <div class="channel-head"><strong>${esc(c.name)}${c.kind === 'simulated' ? ' <span class="muted small">(demo)</span>' : ''}</strong>${status}</div>
        <div class="muted small">Last push: ${timeAgo(c.last_success_at)}</div>
        ${c.last_error && c.enabled ? `<div class="err small">${esc(c.last_error)}</div>` : ''}
        <label class="check"><input type="checkbox" data-act="enabled" ${c.enabled ? 'checked' : ''} ${manage ? '' : 'disabled'}> Connected</label>
        <label class="inline small">Price markup
          <input type="number" data-act="markup" value="${c.rate_markup_pct}" step="0.5" min="-50" max="100" ${manage ? '' : 'disabled'}> %</label>
        ${c.kind === 'channex'
          ? '<div class="muted small">Reaches every OTA connected to your property in Channex.</div>'
          : `<label class="check small"><input type="checkbox" data-act="outage" ${c.simulate_outage ? 'checked' : ''} ${manage ? '' : 'disabled'}> Simulate API outage</label>
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
  await refreshStatus();
  renderChannels();
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
  const body = data.rate_plans.map((r) => `<tr><th>${esc(r.room_type_name)}<div class="muted small">${esc(r.rate_plan_name)} · ${esc(r.external_rate_plan_id)}</div></th>${
    r.cells.map((c) => {
      if (!c.shown) return '<td class="cell stale">not sent</td>';
      const s = c.shown;
      const tags = [s.cta && 'CTA', s.ctd && 'CTD', s.min_stay > 1 && `${s.min_stay}N+`].filter(Boolean)
        .map((t) => `<span class="tag">${t}</span>`).join('');
      return `<td class="cell ${s.closed ? 'closed' : ''} ${c.in_sync ? '' : 'stale'}">${
        s.closed ? '<span class="tag closed-tag">Closed</span>' : `${money(s.rate)}<div class="small">${s.available} left</div>`
      }${tags ? `<div class="tags">${tags}</div>` : ''}<div class="small">${c.in_sync ? '✓' : '⟳ pending'}</div></td>`;
    }).join('')}</tr>`).join('');
  $('#listing-table').innerHTML = head + `<tbody>${body}</tbody>`;
}

async function loadSyncLog() {
  const rows = await api('GET', '/api/sync/log');
  $('#sync-log').innerHTML = rows.length === 0
    ? '<tr><td class="muted">Nothing sent yet.</td></tr>'
    : `<thead><tr><th>When</th><th>Channel</th><th>Updates</th><th>Result</th></tr></thead><tbody>${
      rows.slice(0, 15).map((l) => `<tr><td>${timeAgo(l.created_at)}</td><td>${esc(l.channel_name)}</td><td>${l.cells}</td>
        <td class="${l.ok ? 'ok' : 'err'}">${l.ok ? '✓' : '⚠'} ${esc(l.message)}</td></tr>`).join('')}</tbody>`;
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
  const manage = can('channels');
  if (!s.configured) {
    badge.className = 'badge off'; badge.textContent = 'Not set up';
    body.innerHTML = `
      <p>Channex is already approved by Booking.com, Agoda, MakeMyTrip, Goibibo, Expedia, Airbnb and many more. Connect once here and your
        rates, availability and restrictions reach every OTA you switch on inside Channex, and their bookings come back here.</p>
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
    const plansFor = (rtId) => s.rate_plans.filter((p) => p.room_type_id === rtId)
      .map((p) => `${esc(p.rate_plan_name)} → ${esc(p.channex_rate_plan_title || p.channex_rate_plan_id)}`).join('<br>') || '<span class="muted">none</span>';
    body.innerHTML = `
      <p><strong>${esc(s.property.title)}</strong> ${env} <span class="muted small">· ${esc(s.property.currency)}</span></p>
      <div class="scroll"><table class="list"><thead><tr><th>Your room type</th><th>Channex room type</th><th>Rate plans</th></tr></thead><tbody>
        ${s.rooms.map((m) => `<tr><td>${esc(m.room_type_name)}</td>
          <td>${esc(m.channex_room_type_title || m.channex_room_type_id)}</td><td>${plansFor(m.room_type_id)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted small">Last booking check: ${pullText}</p>
      ${manage ? `<div class="actions">
        <button id="pv-pull">Check for new bookings</button>
        <button id="pv-edit">Change mapping</button>
        <button id="pv-disconnect" class="danger">Disconnect</button>
        <span id="pv-msg" class="msg" role="status"></span>
      </div>` : ''}`;
    return;
  }
  badge.className = 'badge warn'; badge.textContent = 'Ready to connect';
  body.innerHTML = `<p>Channex API key found ${env}. Choose your property and match its rooms and rate plans to yours.</p>
    ${manage ? '<div class="actions"><button id="pv-edit" class="primary">Set up connection</button></div>' : ''}`;
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
  const curRooms = Object.fromEntries((provider.status.rooms || []).map((m) => [m.room_type_id, m.channex_room_type_id]));
  const curPlans = Object.fromEntries((provider.status.rate_plans || []).map((m) => [m.rate_plan_id, m.channex_rate_plan_id]));
  const roomOpts = (sel) => options(provider.rooms.room_types.map((rt) => [rt.id, `${rt.title} (${rt.count_of_rooms} rooms)`]), sel, { empty: "Don't send" });
  body.innerHTML = `
    <form id="pv-form">
      <label>Channex property
        <select id="pv-property">${options(provider.properties.map((p) => [p.id, `${p.title} · ${p.currency}`]), provider.propertyId)}</select></label>
      ${state.roomTypes.map((rt) => `
        <fieldset class="map-room" data-rt="${rt.id}">
          <legend>${esc(rt.name)}</legend>
          <label>Channex room type <select class="pv-room">${roomOpts(curRooms[rt.id])}</select></label>
          <div class="map-plans">${rt.rate_plans.map((p) => `
            <label class="map-plan" data-plan="${p.id}" data-current="${esc(curPlans[p.id] || '')}">${esc(p.name)} <span class="muted small">${esc(p.meal_plan)}</span>
              <select class="pv-plan"></select></label>`).join('') || '<span class="muted small">No rate plans</span>'}</div>
        </fieldset>`).join('')}
      <p class="muted small">Only manually priced, per-room Channex rate plans can be used. Plans set to "Don't send" are not sold through Channex.
        Connecting sends your next 500 days to Channex and switches off the demo channels.</p>
      <div class="actions">
        <button type="submit" class="primary">Connect</button>
        <button type="button" id="pv-cancel">Cancel</button>
        <span id="pv-msg" class="msg" role="status"></span>
      </div>
    </form>`;
  for (const fs of $$('.map-room', body)) fillPlans(fs);
}

/** The Channex rate plans that belong to the Channex room picked for this room type. */
function fillPlans(fs) {
  const roomId = $('.pv-room', fs).value;
  const plans = provider.rooms.rate_plans.filter((p) => p.room_type_id === roomId);
  for (const lab of $$('.map-plan', fs)) {
    const cur = lab.dataset.current;
    $('.pv-plan', lab).innerHTML = options(plans.map((p) => [p.id, p.usable ? p.title : `${p.title} (${p.sell_mode}, ${p.rate_mode}: not supported)`, !p.usable]),
      plans.some((p) => p.id === cur && p.usable) ? cur : '', { empty: "Don't send" });
    $('.pv-plan', lab).disabled = !roomId;
  }
}

$('#provider-body').addEventListener('change', async (e) => {
  if (e.target.id === 'pv-property') {
    provider.propertyId = e.target.value;
    await renderProviderEditor();
  } else if (e.target.classList.contains('pv-room')) {
    fillPlans(e.target.closest('.map-room'));
  }
});

$('#provider-body').addEventListener('submit', async (e) => {
  e.preventDefault();
  const rooms = $$('.map-room', e.target)
    .map((fs) => ({ room_type_id: Number(fs.dataset.rt), channex_room_type_id: $('.pv-room', fs).value }))
    .filter((m) => m.channex_room_type_id);
  const plans = $$('.map-plan', e.target)
    .map((lab) => ({ rate_plan_id: Number(lab.dataset.plan), channex_rate_plan_id: $('.pv-plan', lab).value }))
    .filter((m) => m.channex_rate_plan_id);
  try {
    const r = await api('POST', '/api/providers/channex/connect', { property_id: provider.propertyId, rooms, rate_plans: plans });
    provider.editing = false;
    provider.status = r;
    renderProvider();
    if (r.warnings.length) flash($('#pv-msg'), r.warnings.join(' '), false);
    else flash($('#pv-msg'), 'Connected. Sending your calendar to Channex…');
    await refreshStatus();
    renderChannels();
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
    await loadProvider();
    await refreshStatus();
    renderChannels();
  }
  if (id === 'pv-pull') {
    e.target.disabled = true;
    try {
      const r = await api('POST', '/api/providers/channex/pull');
      await Promise.all([refreshStatus(), loadProvider()]);
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
    provider.editing = false;
    provider.status = null;
    renderChannels();
    await Promise.all([loadProvider(), loadSyncLog(), loadListing()]);
  },
  poll: async () => {
    renderChannels();
    await Promise.all([loadProvider(), loadSyncLog(), loadListing()]);
  },
};
