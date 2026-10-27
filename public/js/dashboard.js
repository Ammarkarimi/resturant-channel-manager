// Dashboard: today, the fortnight ahead, month to date, channel mix, latest bookings,
// and a line per property for groups.

function tile(label, value, sub = '') {
  return `<div class="tile"><span class="tile-label">${esc(label)}</span><strong class="tile-value">${value}</strong>${sub ? `<span class="tile-sub">${sub}</span>` : ''}</div>`;
}

function sourceCell(b) {
  return b.channel_kind === 'channex' ? `${esc(b.source)} <span class="muted small">via Channex</span>` : esc(b.source || b.channel_name);
}

let dashLoadedAt = 0;

async function loadDashboard() {
  dashLoadedAt = Date.now();
  const d = await api('GET', '/api/reports/dashboard');
  const empty = d.capacity === 0;
  $('#dash-empty').hidden = !empty;
  const m = d.month_to_date;
  $('#dash-tiles').innerHTML = [
    tile('Occupancy tonight', pct(d.occupancy_today_pct), `${d.in_house.rooms} of ${d.capacity} rooms`),
    tile('Arriving today', d.arrivals.bookings, `${d.arrivals.rooms} room(s)`),
    tile('Leaving today', d.departures.bookings, `${d.departures.rooms} room(s)`),
    tile('Next 7 days', pct(d.next_7_days_occupancy_pct), 'average occupancy'),
    tile('Revenue this month', money(m.current.revenue), change(m.change_pct.revenue)),
    tile('Average rate (ADR)', m.current.adr == null ? '–' : money(m.current.adr), change(m.change_pct.adr)),
    tile('RevPAR', m.current.revpar == null ? '–' : money(m.current.revpar), change(m.change_pct.revpar)),
    tile('Booked last 7 days', d.pickup_7_days.bookings, `${d.pickup_7_days.room_nights} room nights · ${money(d.pickup_7_days.value)}`),
  ].join('');

  columnChart($('#dash-occupancy'), {
    series: ['Occupancy'],
    max: 100,
    format: (v) => `${Math.round(v)}%`,
    labelEvery: 2,
    data: d.ahead.map((x) => ({
      label: shortDate(x.date),
      values: [x.occupancy_pct],
      tip: `<strong>${pct(x.occupancy_pct)}</strong> · ${x.room_nights} room(s) sold<br>${esc(longDate(x.date))}`,
    })),
  });

  const mix = d.channel_mix_30_days;
  $('#dash-mix').innerHTML = mix.length === 0
    ? '<tr><td class="muted">No stays in the last 30 days.</td></tr>'
    : `<thead><tr><th>Channel</th><th class="num">Room nights</th><th class="num">Revenue</th><th>Share</th></tr></thead><tbody>${
      mix.map((c) => `<tr><td>${esc(c.source)}</td><td class="num">${c.room_nights}</td><td class="num">${money(c.revenue)}</td>
        <td class="share"><span class="meter"><i data-w="${c.revenue_share_pct}"></i></span> ${pct(c.revenue_share_pct)}</td></tr>`).join('')}</tbody>`;
  applySizes($('#dash-mix'));

  $('#dash-recent').innerHTML = d.recent_bookings.length === 0
    ? '<tr><td class="muted">No bookings yet.</td></tr>'
    : `<tbody>${d.recent_bookings.map((b) => `<tr class="clickable" data-booking="${b.id}" tabindex="0">
        <td><strong>${esc(b.guest_name || '–')}</strong><div class="muted small">${sourceCell(b)} · ${timeAgo(b.created_at)}</div></td>
        <td class="nowrap">${shortDate(b.check_in)} → ${shortDate(b.check_out)}</td>
        <td class="num">${b.total != null ? money(b.total, b.currency || undefined) : ''}</td>
        <td>${b.status === 'cancelled' ? '<span class="badge off">Cancelled</span>' : '<span class="badge ok">Confirmed</span>'}</td></tr>`).join('')}</tbody>`;

  if (state.properties.length > 1) {
    const group = await api('GET', '/api/group/overview');
    $('#group-card').hidden = false;
    $('#group-table').innerHTML = `<thead><tr><th>Property</th><th class="num">Tonight</th><th class="num">Next 7 days</th><th class="num">Revenue this month</th><th></th></tr></thead><tbody>${
      group.map((p) => `<tr><td><strong>${esc(p.name)}</strong>${p.city ? `<div class="muted small">${esc(p.city)}</div>` : ''}</td>
        <td class="num">${pct(p.occupancy_today_pct)}</td><td class="num">${pct(p.next_7_days_occupancy_pct)}</td>
        <td class="num">${money(p.revenue_mtd, p.currency)}</td>
        <td class="nowrap">${p.issues ? `<span class="badge err">⚠ ${p.issues} issue(s)</span> ` : ''}${p.id === state.property.id
          ? '<span class="muted small">Current</span>' : `<button data-switch="${p.id}">Open</button>`}</td></tr>`).join('')}</tbody>`;
  } else {
    $('#group-card').hidden = true;
  }
}

$('#group-table').addEventListener('click', (e) => {
  const id = e.target.dataset.switch;
  if (id) switchProperty(Number(id));
});

for (const sel of ['#dash-recent']) {
  $(sel).addEventListener('click', (e) => {
    const row = e.target.closest('[data-booking]');
    if (row) openBooking(Number(row.dataset.booking));
  });
  $(sel).addEventListener('keydown', (e) => {
    const row = e.target.closest('[data-booking]');
    if (row && e.key === 'Enter') openBooking(Number(row.dataset.booking));
  });
}

// Reports are heavier than status checks, so refresh at most every 30 seconds.
Views.dashboard = { show: loadDashboard, poll: () => (Date.now() - dashLoadedAt > 30_000 ? loadDashboard() : null) };
