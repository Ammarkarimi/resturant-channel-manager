// Reports page: summary against last year, occupancy by night, channel
// performance, booking pace, rate parity; each downloadable as CSV.

const report = { tab: 'summary', from: null, to: null, planId: '' };

function presetRange(preset) {
  const t = todayStr();
  const first = `${t.slice(0, 8)}01`;
  switch (preset) {
    case 'this_month': {
      const d = new Date(`${first}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + 1);
      return [first, addDays(d.toISOString().slice(0, 10), -1)];
    }
    case 'last_month': {
      const d = new Date(`${first}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() - 1);
      return [d.toISOString().slice(0, 10), addDays(first, -1)];
    }
    case 'last30': return [addDays(t, -29), t];
    default: return [t, addDays(t, 29)];
  }
}

function setPreset(preset) {
  if (preset === 'custom') return;
  [report.from, report.to] = presetRange(preset);
  $('#report-from').value = report.from;
  $('#report-to').value = report.to;
}

function kpiTile(label, value, delta, ly) {
  return `<div class="tile"><span class="tile-label">${esc(label)}</span><strong class="tile-value">${value}</strong>
    <span class="tile-sub">${delta}</span>${ly ? `<span class="tile-sub muted">Last year: ${ly}</span>` : ''}</div>`;
}

function csvLink(type) {
  const a = $('#report-csv');
  a.hidden = !type;
  if (type) a.href = `/api/reports/export.csv?type=${type}&from=${report.from}&to=${report.to}&property=${state.property.id}`;
}

async function renderSummary(body) {
  const s = await api('GET', `/api/reports/summary?from=${report.from}&to=${report.to}`);
  const c = s.current;
  const l = s.last_year;
  body.innerHTML = `
    <div class="tiles">
      ${kpiTile('Occupancy', pct(c.occupancy_pct), change(s.change_pct.occupancy), pct(l.occupancy_pct))}
      ${kpiTile('Room revenue', money(c.revenue), change(s.change_pct.revenue), money(l.revenue))}
      ${kpiTile('Average daily rate (ADR)', c.adr == null ? '–' : money(c.adr), change(s.change_pct.adr), l.adr == null ? '–' : money(l.adr))}
      ${kpiTile('RevPAR', c.revpar == null ? '–' : money(c.revpar), change(s.change_pct.revpar), l.revpar == null ? '–' : money(l.revpar))}
      ${kpiTile('Room nights sold', c.room_nights.toLocaleString(), `of ${c.rooms_available.toLocaleString()} available`, l.room_nights.toLocaleString())}
    </div>
    <p class="muted small">Revenue is counted on the nights guests stay. Last year: ${esc(shortDate(l.from))} – ${esc(shortDate(l.to))}.
      Bookings without a total count as sold rooms but not in revenue or ADR.</p>`;
  csvLink('occupancy');
}

async function renderOccupancy(body) {
  const o = await api('GET', `/api/reports/occupancy?from=${report.from}&to=${report.to}`);
  body.innerHTML = `
    <section class="card"><h2>Occupancy by night</h2><div id="occ-chart" class="chart"></div></section>
    <section class="card"><div class="scroll"><table class="list"><thead><tr><th>Night</th><th class="num">Sold</th><th class="num">Occupancy</th>
      ${o.room_types.map((r) => `<th class="num">${esc(r.name)}</th>`).join('')}<th class="num">Revenue</th><th class="num">ADR</th><th class="num">RevPAR</th></tr></thead>
      <tbody>${o.days.map((d) => `<tr><td class="nowrap">${esc(longDate(d.date))}</td><td class="num">${d.room_nights} / ${d.rooms_available}</td>
        <td class="num">${pct(d.occupancy_pct)}</td>${o.room_types.map((r) => `<td class="num">${d.by_room_type[r.id].sold}</td>`).join('')}
        <td class="num">${money(d.revenue)}</td><td class="num">${d.adr == null ? '–' : money(d.adr)}</td><td class="num">${d.revpar == null ? '–' : money(d.revpar)}</td></tr>`).join('')}
      </tbody></table></div></section>`;
  columnChart($('#occ-chart'), {
    series: ['Occupancy'], max: 100, format: (v) => `${Math.round(v)}%`,
    labelEvery: Math.ceil(o.days.length / 12),
    data: o.days.map((d) => ({
      label: shortDate(d.date), values: [d.occupancy_pct],
      tip: `<strong>${pct(d.occupancy_pct)}</strong> · ${d.room_nights} of ${d.rooms_available} rooms · ${money(d.revenue)}<br>${esc(longDate(d.date))}`,
    })),
  });
  csvLink('occupancy');
}

async function renderChannelsReport(body) {
  const c = await api('GET', `/api/reports/channels?from=${report.from}&to=${report.to}`);
  body.innerHTML = `<section class="card"><h2>Performance by channel</h2>
    <p class="muted small">Guests staying ${esc(shortDate(c.from))} – ${esc(shortDate(c.to))}. Total ${money(c.total_revenue)} from ${c.total_room_nights} room nights.</p>
    ${c.channels.length === 0 ? '<p class="muted">No stays in this period.</p>' : `
    <div class="scroll"><table class="list"><thead><tr><th>Channel</th><th class="num">Bookings</th><th class="num">Room nights</th><th class="num">Revenue</th>
      <th>Revenue share</th><th class="num">ADR</th><th class="num">Cancelled</th></tr></thead><tbody>
      ${c.channels.map((r) => `<tr><td><strong>${esc(r.source)}</strong></td><td class="num">${r.bookings}</td><td class="num">${r.room_nights}</td>
        <td class="num">${money(r.revenue)}</td><td class="share"><span class="meter"><i data-w="${r.revenue_share_pct}"></i></span> ${pct(r.revenue_share_pct)}</td>
        <td class="num">${r.adr == null ? '–' : money(r.adr)}</td><td class="num">${r.cancellations} <span class="muted small">(${pct(r.cancellation_rate_pct)})</span></td></tr>`).join('')}
    </tbody></table></div>`}</section>`;
  applySizes(body);
  csvLink('channels');
}

async function renderPace(body) {
  const p = await api('GET', `/api/reports/pace?from=${report.from}&to=${report.to}`);
  const t = p.totals;
  body.innerHTML = `
    <div class="tiles">
      ${kpiTile('Bookings made', t.bookings, t.last_year_bookings ? change(Math.round(((t.bookings - t.last_year_bookings) / t.last_year_bookings) * 1000) / 10) : change(null), String(t.last_year_bookings))}
      ${kpiTile('Room nights booked', t.room_nights, '', String(t.last_year_room_nights))}
      ${kpiTile('Value booked', money(t.value), '')}
    </div>
    <section class="card"><h2>Bookings made per day</h2>
      <p class="muted small">By the date the booking was made, against the same days last year.</p>
      <div id="pace-chart" class="chart"></div></section>`;
  columnChart($('#pace-chart'), {
    series: ['This year', 'Last year'],
    format: (v) => String(Math.round(v)),
    labelEvery: Math.ceil(p.days.length / 12),
    data: p.days.map((d) => ({
      label: shortDate(d.date), values: [d.bookings, d.last_year_bookings],
      tip: `<strong>${d.bookings}</strong> booking(s), ${d.room_nights} room night(s) · last year <strong>${d.last_year_bookings}</strong><br>${esc(longDate(d.date))}`,
    })),
  });
  csvLink(null);
}

async function renderParity(body) {
  const rooms = await api('GET', '/api/room-types');
  const plans = rooms.flatMap((rt) => rt.rate_plans.filter((p) => p.active).map((p) => [p.id, `${rt.name} · ${p.name}`]));
  const sel = $('#parity-plan');
  sel.innerHTML = options(plans, report.planId, { empty: 'All rate plans' });
  const days = Math.min(14, Math.max(1, Math.round((new Date(report.to) - new Date(report.from)) / 864e5) + 1));
  const q = `start=${report.from}&days=${days}${report.planId ? `&rate_plan_id=${report.planId}` : ''}`;
  const r = await api('GET', `/api/reports/parity?${q}`);
  const s = r.summary;
  const flag = (cell) => {
    if (cell.closed) return '<span class="muted small">closed</span>';
    const parts = [`${money(cell.rate)}`];
    if (cell.diff_pct < 0) parts.push(`<span class="status critical">▼ ${Math.abs(cell.diff_pct)}% below direct</span>`);
    else if (cell.diff_pct > 0) parts.push(`<span class="muted small">+${cell.diff_pct}%</span>`);
    if (cell.status === 'failed') parts.push('<span class="status critical">⚠ not sent</span>');
    else if (cell.status === 'pending') parts.push('<span class="status warning">⟳ sending</span>');
    else if (cell.status === 'mismatch') parts.push(`<span class="status warning">⚠ OTA shows ${money(cell.shown_rate)}</span>`);
    return parts.join('<br>');
  };
  body.innerHTML = `
    <div class="tiles">
      <div class="tile"><span class="tile-label">Nights below your direct price</span><strong class="tile-value">${s.below_direct}</strong>
        <span class="tile-sub">${s.below_direct ? '<span class="status critical">▼ an OTA is cheaper than you</span>' : '<span class="status good">✓ none</span>'}</span></div>
      <div class="tile"><span class="tile-label">Prices not yet on the OTA</span><strong class="tile-value">${s.out_of_sync}</strong>
        <span class="tile-sub">${s.out_of_sync ? '<span class="status warning">⟳ waiting or failed</span>' : '<span class="status good">✓ all sent</span>'}</span></div>
      <div class="tile"><span class="tile-label">Channels compared</span><strong class="tile-value">${s.channels}</strong>
        <span class="tile-sub">first ${days} night(s) of the range</span></div>
    </div>
    <p class="muted small">Direct = your own price for 2 adults, after occupancy pricing. Each OTA gets that plus its markup.
      A channel cheaper than direct breaks rate parity; one still sending is out of sync.</p>
    ${r.rate_plans.map((p) => `<section class="card"><h3>${esc(p.name)}</h3><div class="scroll"><table class="grid parity">
      <thead><tr><th></th>${p.days.map((d) => `<th>${dayLabel(d.date)}</th>`).join('')}</tr></thead><tbody>
      <tr><th>Direct</th>${p.days.map((d) => `<td>${money(d.direct)}</td>`).join('')}</tr>
      ${p.channels.map((c) => `<tr><th>${esc(c.name)}<div class="muted small">${c.markup_pct > 0 ? '+' : ''}${c.markup_pct}% markup</div></th>
        ${p.days.map((d) => `<td>${d.channels[c.code] ? flag(d.channels[c.code]) : '–'}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div></section>`).join('') || '<p class="muted">No connected channels sell these rate plans.</p>'}`;
  csvLink(null);
}

const RENDER = { summary: renderSummary, occupancy: renderOccupancy, channels: renderChannelsReport, pace: renderPace, parity: renderParity };

async function loadReport() {
  $('#parity-plan').hidden = report.tab !== 'parity';
  const body = $('#report-body');
  try {
    await RENDER[report.tab](body);
  } catch (err) {
    body.innerHTML = `<section class="card"><p class="err">${esc(err.message)}</p></section>`;
  }
}

$('#report-tabs').addEventListener('click', (e) => {
  const tab = e.target.dataset.report;
  if (!tab) return;
  report.tab = tab;
  for (const b of $$('#report-tabs button')) b.classList.toggle('active', b.dataset.report === tab);
  // Pace looks back at bookings made; the others look at stays.
  const preset = tab === 'pace' ? 'last30' : (tab === 'parity' ? 'next30' : $('#report-preset').value);
  $('#report-preset').value = preset;
  setPreset(preset);
  loadReport();
});
$('#report-preset').addEventListener('change', (e) => { setPreset(e.target.value); loadReport(); });
for (const id of ['#report-from', '#report-to']) {
  $(id).addEventListener('change', () => {
    $('#report-preset').value = 'custom';
    report.from = $('#report-from').value;
    report.to = $('#report-to').value;
    if (report.from && report.to) loadReport();
  });
}
$('#parity-plan').addEventListener('change', (e) => { report.planId = e.target.value; loadReport(); });

Views.reports = {
  show: () => {
    if (!report.from) setPreset($('#report-preset').value);
    return loadReport();
  },
};
