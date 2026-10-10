// Calendar page: one-click bulk update, the calendar grid, recent changes.

let bulkBuiltFor = '';

function buildBulkForm() {
  const key = state.roomTypes.map((rt) => `${rt.id}:${rt.name}:${rt.total_rooms}`).join('|');
  if (key === bulkBuiltFor) return;
  bulkBuiltFor = key;
  $('#bulk-rooms').innerHTML = state.roomTypes.map((rt) => `
    <label class="check"><input type="checkbox" name="room" value="${rt.id}" checked> ${esc(rt.name)}
      <span class="muted small">(${rt.total_rooms} rooms)</span></label>`).join('');
  if (!$('#bulk-weekdays').children.length) {
    $('#bulk-weekdays').innerHTML = WEEKDAYS.map((d, i) => `
      <label class="day"><input type="checkbox" name="weekday" value="${i}"><span>${d}</span></label>`).join('');
    const form = $('#bulk-form');
    form.start_date.value = todayStr();
    form.end_date.value = addDays(todayStr(), 6);
  }
}

function readBulkTarget() {
  const form = $('#bulk-form');
  return {
    room_type_ids: $$('input[name=room]:checked', form).map((i) => Number(i.value)),
    start_date: form.start_date.value,
    end_date: form.end_date.value,
    weekdays: $$('input[name=weekday]:checked', form).map((i) => Number(i.value)),
  };
}

async function submitBulk(set) {
  const msg = $('#bulk-msg');
  try {
    const r = await api('POST', '/api/inventory/bulk', { ...readBulkTarget(), set });
    const n = state.channels.filter((c) => c.enabled).length;
    flash(msg, `Updated ${r.cells} room-night(s).${n ? ` Sending to ${n} channel(s)…` : ''}`);
    await Promise.all([loadCalendar(), loadActivity(), refreshStatus()]);
  } catch (err) {
    flash(msg, err.message, false);
  }
}

$('#bulk-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const set = {};
  if (f.rate.value) set.rate = Number(f.rate.value);
  if (f.available.value) set.available = Number(f.available.value);
  if (f.min_stay.value) set.min_stay = Number(f.min_stay.value);
  if (f.stop_sell.value) set.stop_sell = f.stop_sell.value === 'true';
  submitBulk(set);
});
$('#close-out').addEventListener('click', () => submitBulk({ stop_sell: true }));
$('#reopen').addEventListener('click', () => submitBulk({ stop_sell: false }));

async function loadCalendar() {
  const grid = await api('GET', `/api/inventory?start=${state.calStart}&days=14`);
  state.roomTypes = grid.room_types;
  const empty = grid.room_types.length === 0;
  $('#no-rooms').hidden = !empty;
  $('#bulk').hidden = empty;
  $('#calendar-card').hidden = empty;
  if (empty) return;
  buildBulkForm();
  $('#cal-start').value = state.calStart;
  const head = `<thead><tr><th></th>${grid.dates.map((d) => `<th class="${d === todayStr() ? 'today' : ''}">${dayLabel(d)}</th>`).join('')}</tr></thead>`;
  const body = grid.room_types.map((rt) => `
    <tr class="rt-head"><th colspan="${grid.dates.length + 1}">${esc(rt.name)} <span class="muted small">· ${rt.total_rooms} rooms</span></th></tr>
    <tr><th class="sub">Available</th>${rt.cells.map((c) => cellHtml(rt, c, 'available')).join('')}</tr>
    <tr><th class="sub">Rate</th>${rt.cells.map((c) => cellHtml(rt, c, 'rate')).join('')}</tr>`).join('');
  $('#calendar').innerHTML = head + `<tbody>${body}</tbody>`;
}

function cellHtml(rt, c, field) {
  const closed = c.stop_sell || c.available <= 0;
  const cls = ['cell', closed ? 'closed' : '', c.available < 0 ? 'over' : ''].join(' ');
  let text;
  if (field === 'available') {
    text = c.stop_sell ? `<span class="tag">Closed</span> ${c.available}` : c.available;
    if (c.min_stay > 1) text += ` <span class="tag" title="Minimum stay">${c.min_stay}N</span>`;
  } else {
    text = money(c.rate);
  }
  return `<td class="${cls}" data-rt="${rt.id}" data-date="${c.date}" tabindex="0">${text}</td>`;
}

function openCellEditor(rtId, date) {
  const rt = state.roomTypes.find((r) => r.id === rtId);
  const cell = rt.cells.find((c) => c.date === date);
  const form = $('#cell-form');
  $('#cell-title').innerHTML = `${esc(rt.name)} · ${dayLabel(date)}`;
  form.rate.value = cell.rate;
  form.available.value = Math.max(0, cell.available);
  form.available.max = rt.total_rooms;
  form.min_stay.value = cell.min_stay;
  form.stop_sell.checked = cell.stop_sell;
  const dlg = $('#cell-dialog');
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'save') return;
    try {
      await api('POST', '/api/inventory/bulk', {
        room_type_ids: [rtId], start_date: date, end_date: date,
        set: {
          rate: Number(form.rate.value), available: Number(form.available.value),
          min_stay: Number(form.min_stay.value), stop_sell: form.stop_sell.checked,
        },
      });
      await Promise.all([loadCalendar(), loadActivity(), refreshStatus()]);
    } catch (err) {
      alert(err.message);
    }
  };
  dlg.returnValue = '';
  dlg.showModal();
}

$('#calendar').addEventListener('click', (e) => {
  const td = e.target.closest('td[data-rt]');
  if (td) openCellEditor(Number(td.dataset.rt), td.dataset.date);
});
$('#calendar').addEventListener('keydown', (e) => {
  const td = e.target.closest('td[data-rt]');
  if (td && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openCellEditor(Number(td.dataset.rt), td.dataset.date); }
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
