// Calendar page: one-click bulk update of rates, availability and
// restrictions; closing rooms on chosen channels; the grid; recent changes.

let bulkBuiltFor = '';
let grid = null;

// ---------- Bulk form ----------

function buildBulkForm() {
  const key = JSON.stringify(state.roomTypes.map((rt) => [rt.id, rt.name, rt.total_rooms, rt.rate_plans.map((p) => [p.id, p.name])]));
  if (key === bulkBuiltFor) return;
  bulkBuiltFor = key;
  $('#bulk-rooms').innerHTML = state.roomTypes.map((rt) => `
    <div class="tree-room">
      <label class="check"><input type="checkbox" name="room" value="${rt.id}" checked> <strong>${esc(rt.name)}</strong>
        <span class="muted small">(${rt.total_rooms} rooms)</span></label>
      <div class="tree-plans">${rt.rate_plans.map((p) => `
        <label class="check small"><input type="checkbox" name="plan" value="${p.id}" data-room="${rt.id}" checked>
          ${esc(p.name)} <span class="muted">${esc(p.meal_plan)}${p.derived ? ' · derived' : ''}</span></label>`).join('')
        || '<span class="muted small">No rate plans yet</span>'}</div>
    </div>`).join('');
  if (!$('#bulk-weekdays').children.length) {
    $('#bulk-weekdays').innerHTML = WEEKDAYS.map((d, i) => `
      <label class="day"><input type="checkbox" name="weekday" value="${i}"><span>${d}</span></label>`).join('');
    const form = $('#bulk-form');
    form.start_date.value = todayStr();
    form.end_date.value = addDays(todayStr(), 6);
  }
}

// A room's tick switches all its plans; ticking a plan ticks its room.
$('#bulk-rooms').addEventListener('change', (e) => {
  if (e.target.name === 'room') {
    for (const p of $$(`input[name=plan][data-room="${e.target.value}"]`)) p.checked = e.target.checked;
  } else if (e.target.name === 'plan' && e.target.checked) {
    $(`input[name=room][value="${e.target.dataset.room}"]`).checked = true;
  }
});

function readBulkTarget() {
  const form = $('#bulk-form');
  const rooms = $$('input[name=room]:checked', form).map((i) => Number(i.value));
  return {
    room_type_ids: rooms,
    rate_plan_ids: $$('input[name=plan]:checked', form).filter((i) => rooms.includes(Number(i.dataset.room))).map((i) => Number(i.value)),
    start_date: form.start_date.value,
    end_date: form.end_date.value,
    weekdays: $$('input[name=weekday]:checked', form).map((i) => Number(i.value)),
  };
}

async function submitBulk(set, msgEl = $('#bulk-msg')) {
  try {
    const target = readBulkTarget();
    if (target.rate_plan_ids.length === 0) delete target.rate_plan_ids;
    const r = await api('POST', '/api/inventory/bulk', { ...target, set });
    const n = state.channels.filter((c) => c.enabled).length;
    flash(msgEl, `Updated ${r.cells} cell(s) across ${r.dates} night(s).${n ? ` Sending to ${n} channel(s)…` : ''}`);
    await Promise.all([loadCalendar(), loadActivity(), refreshStatus()]);
    return true;
  } catch (err) {
    flash(msgEl, err.message, false);
    return false;
  }
}

function bulkSet(f) {
  const set = {};
  for (const k of ['available', 'rate_double', 'rate_single', 'rate_triple', 'extra_adult', 'extra_child', 'min_stay', 'max_stay']) {
    if (f[k].value !== '') set[k] = Number(f[k].value);
  }
  for (const k of ['stop_sell', 'plan_stop_sell', 'cta', 'ctd']) if (f[k].value) set[k] = f[k].value === 'true';
  if (f.reset_rates.checked) set.reset_rates = true;
  return set;
}

$('#bulk-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await submitBulk(bulkSet(e.target))) {
    for (const el of $$('input[type=number], select', $('#bulk-form'))) el.value = '';
    $('#bulk-form').reset_rates.checked = false;
  }
});
$('#close-out').addEventListener('click', () => submitBulk({ stop_sell: true }));
$('#reopen').addEventListener('click', () => submitBulk({ stop_sell: false }));

function buildBlockChannels() {
  const chans = state.channels.filter((c) => c.kind !== 'direct');
  $('#block-panel').hidden = chans.length === 0;
  const checked = new Set($$('#block-channels input:checked').map((i) => i.value));
  $('#block-channels').innerHTML = chans.map((c) => `<label class="check"><input type="checkbox" value="${esc(c.code)}" ${checked.has(c.code) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('');
}

async function submitBlock(blocked) {
  const msg = $('#block-msg');
  try {
    const t = readBulkTarget();
    const r = await api('POST', '/api/inventory/channel-blocks', {
      room_type_ids: t.room_type_ids, start_date: t.start_date, end_date: t.end_date, weekdays: t.weekdays,
      channel_codes: $$('#block-channels input:checked').map((i) => i.value), blocked,
    });
    flash(msg, `${blocked ? 'Closed' : 'Reopened'} on ${r.channels.join(', ')} for ${r.dates} night(s).`);
    await Promise.all([loadCalendar(), loadActivity(), refreshStatus()]);
  } catch (err) {
    flash(msg, err.message, false);
  }
}
$('#block-close').addEventListener('click', () => submitBlock(true));
$('#block-open').addEventListener('click', () => submitBlock(false));

// ---------- Grid ----------

async function loadCalendar() {
  grid = await api('GET', `/api/inventory?start=${state.calStart}&days=14`);
  state.roomTypes = grid.room_types;
  const empty = grid.room_types.length === 0;
  $('#no-rooms').hidden = !empty;
  $('#bulk').hidden = empty;
  $('#calendar-card').hidden = empty;
  if (empty) return;
  buildBulkForm();
  buildBlockChannels();
  $('#cal-start').value = state.calStart;
  const editable = can('rates');
  const head = `<thead><tr><th></th>${grid.dates.map((d) => `<th class="${d === todayStr() ? 'today' : ''}">${dayLabel(d)}</th>`).join('')}</tr></thead>`;
  const body = grid.room_types.map((rt) => `
    <tr class="rt-head"><th colspan="${grid.dates.length + 1}">${esc(rt.name)} <span class="muted small">· ${rt.total_rooms} rooms</span></th></tr>
    <tr><th class="sub">Rooms left</th>${rt.cells.map((c) => roomCellHtml(rt, c, editable)).join('')}</tr>
    ${rt.rate_plans.map((p) => `<tr><th class="sub plan-name">${esc(p.name)} <span class="muted">${esc(p.meal_plan)}</span>
        ${p.derived ? `<div class="muted small">${esc(p.derived_from)}</div>` : ''}${p.active ? '' : '<div class="tag closed-tag">Off</div>'}</th>
      ${p.cells.map((c) => planCellHtml(rt, p, c, editable)).join('')}</tr>`).join('')}`).join('');
  $('#calendar').innerHTML = head + `<tbody>${body}</tbody>`;
}

function roomCellHtml(rt, c, editable) {
  const closed = c.stop_sell || c.available <= 0;
  const cls = ['cell', 'room-cell', closed ? 'closed' : '', c.available < 0 ? 'over' : '', editable ? 'editable' : ''].join(' ');
  const blocked = c.blocked_channels.length;
  const blockedNames = state.channels.filter((ch) => c.blocked_channels.includes(ch.code)).map((ch) => ch.name).join(', ');
  const tip = `<strong>${c.available} of ${rt.total_rooms} left</strong> · ${c.sold} sold (${pct(c.occupancy_pct)})${c.stop_sell ? '<br>Closed on all channels' : ''}${blocked ? `<br>Closed on ${esc(blockedNames)}` : ''}`;
  return `<td class="${cls}" data-room="${rt.id}" data-date="${c.date}" ${editable ? 'tabindex="0"' : ''} data-tip="${esc(tip)}">
    ${c.stop_sell ? '<span class="tag closed-tag">Closed</span>' : ''}<span class="avail">${c.available}</span>
    ${blocked ? `<span class="tag block">✕${blocked}</span>` : ''}</td>`;
}

function planCellHtml(rt, p, c, editable) {
  const tags = [];
  if (c.stop_sell) tags.push('<span class="tag closed-tag">Closed</span>');
  if (c.cta) tags.push('<span class="tag">CTA</span>');
  if (c.ctd) tags.push('<span class="tag">CTD</span>');
  if (c.min_stay > 1) tags.push(`<span class="tag">${c.min_stay}N+</span>`);
  if (c.max_stay) tags.push(`<span class="tag">≤${c.max_stay}N</span>`);
  if (c.yield_pct) tags.push(`<span class="tag up">${c.yield_pct > 0 ? '↑' : '↓'}${Math.abs(c.yield_pct)}%</span>`);
  const tip = [
    `<strong>${money(c.rate_double, undefined, 2)}</strong> for 2 adults`,
    c.rate_single != null ? `1 adult ${money(c.rate_single, undefined, 2)}` : '',
    c.rate_triple != null ? `3 adults ${money(c.rate_triple, undefined, 2)}` : '',
    c.extra_adult != null ? `extra adult ${money(c.extra_adult)}` : '',
    c.extra_child != null ? `extra child ${money(c.extra_child)}` : '',
    c.yield_pct ? `includes ${c.yield_pct > 0 ? '+' : ''}${c.yield_pct}% occupancy pricing (before: ${money(c.base_double)})` : '',
    p.derived ? `derived: ${esc(p.derived_from)}` : c.own_price ? 'priced for this night' : 'default price',
  ].filter(Boolean).join('<br>');
  const cls = ['cell', 'plan-cell', c.stop_sell ? 'closed' : '', c.own_price ? 'own' : '', editable ? 'editable' : ''].join(' ');
  return `<td class="${cls}" data-plan="${p.id}" data-room="${rt.id}" data-date="${c.date}" ${editable ? 'tabindex="0"' : ''} data-tip="${esc(tip)}">
    <span class="price">${money(c.rate_double)}</span>${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}</td>`;
}

function findPlanCell(planId, date) {
  for (const rt of grid.room_types) {
    const p = rt.rate_plans.find((x) => x.id === planId);
    if (p) return { rt, p, c: p.cells.find((x) => x.date === date) };
  }
  return null;
}

function editRoomNight(rtId, date) {
  const rt = grid.room_types.find((r) => r.id === rtId);
  const c = rt.cells.find((x) => x.date === date);
  const chans = state.channels.filter((ch) => ch.kind !== 'direct');
  openDialog({
    title: `${rt.name} · ${longDate(date)}`,
    body: `
      <label>Rooms available <input type="number" name="available" min="0" max="${rt.total_rooms}" value="${Math.max(0, c.available)}" required></label>
      <p class="muted small">${c.sold} sold · ${pct(c.occupancy_pct)} occupancy</p>
      <label class="check"><input type="checkbox" name="stop_sell" ${c.stop_sell ? 'checked' : ''}> Close on all channels</label>
      ${chans.length ? `<fieldset><legend>Closed on these channels only</legend>${chans.map((ch) => `
        <label class="check"><input type="checkbox" name="block" value="${esc(ch.code)}" ${c.blocked_channels.includes(ch.code) ? 'checked' : ''}> ${esc(ch.name)}</label>`).join('')}</fieldset>` : ''}`,
    saveLabel: 'Save & sync',
    onSave: async (form) => {
      // Only what changed, so the change history stays meaningful.
      const set = {};
      if (Number(form.available.value) !== Math.max(0, c.available)) set.available = Number(form.available.value);
      if (form.stop_sell.checked !== c.stop_sell) set.stop_sell = form.stop_sell.checked;
      if (Object.keys(set).length) {
        await api('POST', '/api/inventory/bulk', { room_type_ids: [rtId], start_date: date, end_date: date, set });
      }
      const want = new Set($$('input[name=block]:checked', form).map((i) => i.value));
      const close = chans.filter((ch) => want.has(ch.code) && !c.blocked_channels.includes(ch.code)).map((ch) => ch.code);
      const open = chans.filter((ch) => !want.has(ch.code) && c.blocked_channels.includes(ch.code)).map((ch) => ch.code);
      for (const [codes, blocked] of [[close, true], [open, false]]) {
        if (codes.length) await api('POST', '/api/inventory/channel-blocks', { room_type_ids: [rtId], start_date: date, end_date: date, channel_codes: codes, blocked });
      }
      await Promise.all([loadCalendar(), loadActivity(), refreshStatus()]);
    },
  });
}

function editPlanNight(planId, date) {
  const { rt, p, c } = findPlanCell(planId, date);
  const priceInput = (name, label, value, required = false) => `<label>${label}
    <input type="number" name="${name}" min="${name.startsWith('extra') ? 0 : 1}" step="0.01" value="${value ?? ''}" ${required ? 'required' : ''} ${p.derived ? 'disabled' : ''}></label>`;
  const base = c.yield_pct ? (n) => (n == null ? null : Math.round((n / (1 + c.yield_pct / 100)) * 100) / 100) : (n) => n;
  openDialog({
    title: `${rt.name} · ${p.name} · ${longDate(date)}`,
    body: `
      ${p.derived ? `<p class="muted small">Prices follow ${esc(p.derived_from)}. Change the parent plan's price instead.</p>`
        : c.yield_pct ? `<p class="muted small">Prices below are before the ${c.yield_pct > 0 ? '+' : ''}${c.yield_pct}% occupancy adjustment.</p>` : ''}
      <div class="row two">
        ${priceInput('rate_double', '2 adults', base(c.rate_double), true)}
        ${priceInput('rate_single', '1 adult', base(c.rate_single))}
        ${priceInput('rate_triple', '3 adults', base(c.rate_triple))}
        ${priceInput('extra_adult', 'Extra adult', c.extra_adult)}
        ${priceInput('extra_child', 'Extra child', c.extra_child)}
      </div>
      ${!p.derived && c.own_price ? '<label class="check"><input type="checkbox" name="reset_rates"> Go back to the default prices</label>' : ''}
      <div class="row two">
        <label>Min stay <input type="number" name="min_stay" min="1" max="30" value="${c.min_stay}" required></label>
        <label>Max stay <input type="number" name="max_stay" min="0" max="90" value="${c.max_stay ?? 0}"> </label>
      </div>
      <p class="muted small">Max stay 0 = no maximum.</p>
      <label class="check"><input type="checkbox" name="plan_stop_sell" ${c.stop_sell ? 'checked' : ''}> Stop sell this rate plan</label>
      <label class="check"><input type="checkbox" name="cta" ${c.cta ? 'checked' : ''}> Closed to arrival</label>
      <label class="check"><input type="checkbox" name="ctd" ${c.ctd ? 'checked' : ''}> Closed to departure</label>`,
    saveLabel: 'Save & sync',
    onSave: async (form) => {
      // Only what changed, so the change history stays meaningful.
      const set = {};
      if (Number(form.min_stay.value) !== c.min_stay) set.min_stay = Number(form.min_stay.value);
      if (Number(form.max_stay.value || 0) !== (c.max_stay ?? 0)) set.max_stay = Number(form.max_stay.value || 0);
      if (form.plan_stop_sell.checked !== c.stop_sell) set.plan_stop_sell = form.plan_stop_sell.checked;
      if (form.cta.checked !== c.cta) set.cta = form.cta.checked;
      if (form.ctd.checked !== c.ctd) set.ctd = form.ctd.checked;
      if (!p.derived) {
        if (form.reset_rates?.checked) {
          set.reset_rates = true;
        } else {
          const changed = (name, current) => form[name].value !== '' && Number(form[name].value) !== current;
          for (const [k, cur] of [['rate_double', base(c.rate_double)], ['rate_single', base(c.rate_single)], ['rate_triple', base(c.rate_triple)],
            ['extra_adult', c.extra_adult], ['extra_child', c.extra_child]]) {
            if (changed(k, cur)) set[k] = Number(form[k].value);
          }
        }
      }
      if (Object.keys(set).length === 0) return;
      await api('POST', '/api/inventory/bulk', { room_type_ids: [rt.id], rate_plan_ids: [p.id], start_date: date, end_date: date, set });
      await Promise.all([loadCalendar(), loadActivity(), refreshStatus()]);
    },
  });
}

function openCell(td) {
  if (!can('rates')) return;
  if (td.dataset.plan) editPlanNight(Number(td.dataset.plan), td.dataset.date);
  else editRoomNight(Number(td.dataset.room), td.dataset.date);
}

$('#calendar').addEventListener('click', (e) => {
  const td = e.target.closest('td[data-room]');
  if (td) { hideTooltip(); openCell(td); }
});
$('#calendar').addEventListener('keydown', (e) => {
  const td = e.target.closest('td[data-room]');
  if (td && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); hideTooltip(); openCell(td); }
});
$('#cal-prev').addEventListener('click', () => { state.calStart = addDays(state.calStart, -14); loadCalendar(); });
$('#cal-next').addEventListener('click', () => { state.calStart = addDays(state.calStart, 14); loadCalendar(); });
$('#cal-today').addEventListener('click', () => { state.calStart = todayStr(); loadCalendar(); });
$('#cal-start').addEventListener('change', (e) => { if (e.target.value) { state.calStart = e.target.value; loadCalendar(); } });

async function loadActivity() {
  const rows = await api('GET', '/api/activity');
  $('#activity').innerHTML = rows.length === 0
    ? '<tr><td class="muted">No changes yet.</td></tr>'
    : `<thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>${
      rows.slice(0, 20).map((a) => `<tr><td class="nowrap">${timeAgo(a.created_at)}</td><td>${esc(a.user_name)}</td>
        <td>${esc(a.action)}</td></tr>`).join('')}</tbody>`;
}

Views.calendar = {
  show: () => Promise.all([loadCalendar(), loadActivity()]),
  poll: () => loadActivity(),
};
