// Bookings page: direct bookings with a live price, the booking list, the
// booking detail and voucher.

const bookingFilter = { view: 'upcoming', q: '' };

async function ensureRoomTypes() {
  state.roomTypes = await api('GET', '/api/room-types');
}

function fillDirectPlans() {
  const rt = state.roomTypes.find((r) => r.id === Number($('#direct-room').value));
  const plans = (rt?.rate_plans || []).filter((p) => p.active);
  const sel = $('#direct-plan');
  const prev = sel.value;
  sel.innerHTML = options(plans.map((p) => [p.id, `${p.name} (${p.meal_plan})`]), prev, { empty: 'No rate plan (enter total)' });
  if (!prev && plans.length) sel.value = plans[0].id;
}

function fillBookingForms() {
  const direct = $('#direct-room');
  const prev = direct.value;
  direct.innerHTML = state.roomTypes.length
    ? options(state.roomTypes.map((rt) => [rt.id, rt.name]), prev)
    : '<option value="">Add room types in Settings first</option>';
  fillDirectPlans();
  $('#direct-form').check_in.value ||= todayStr();

  const demo = state.channels.filter((c) => c.kind === 'simulated');
  $('#demo-booking').hidden = demo.length === 0 || state.roomTypes.length === 0;
  const sel = $('#bk-channel');
  const prevCh = sel.value;
  sel.innerHTML = options(demo.map((c) => [c.code, c.name]), prevCh);
  $('#bk-room').innerHTML = options(state.roomTypes.map((rt) => [rt.code, rt.name]), $('#bk-room').value);
  $('#booking-form').check_in.value ||= todayStr();
}

function directPayload(f) {
  return {
    room_type_id: Number(f.room_type_id),
    rate_plan_id: f.rate_plan_id ? Number(f.rate_plan_id) : null,
    check_in: f.check_in,
    check_out: f.check_in ? addDays(f.check_in, Number(f.nights || 1)) : '',
    rooms: Number(f.rooms || 1),
    adults: Number(f.adults || 2),
    children: Number(f.children || 0),
  };
}

let quoteTimer;
async function updateQuote() {
  const f = formData($('#direct-form'));
  const box = $('#quote');
  if (!f.room_type_id || !f.check_in) { box.textContent = ''; return; }
  try {
    const q = await api('POST', '/api/bookings/quote', directPayload(f));
    const price = q.total != null
      ? `<strong>${money(q.total, undefined, 2)}</strong> for ${q.nights} night(s)`
      : `${q.nights} night(s); choose a rate plan to price it`;
    box.innerHTML = `${price}${q.warnings.map((w) => `<br><span class="warn-text">⚠ ${esc(w)}</span>`).join('')}`;
    box.className = `quote ${q.warnings.length ? 'has-warning' : ''}`;
  } catch (err) {
    box.innerHTML = `<span class="err">${esc(err.message)}</span>`;
  }
}
$('#direct-form').addEventListener('input', (e) => {
  if (e.target.name === 'room_type_id') fillDirectPlans();
  if (['guest_name', 'guest_phone', 'guest_email', 'notes', 'total'].includes(e.target.name)) return;
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(updateQuote, 250);
});
$('#direct-form').addEventListener('change', (e) => { if (e.target.name === 'room_type_id') { fillDirectPlans(); updateQuote(); } });

$('#direct-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  try {
    const b = await api('POST', '/api/bookings', {
      ...directPayload(f),
      guest_name: f.guest_name, guest_phone: f.guest_phone, guest_email: f.guest_email,
      total: f.total === '' ? null : Number(f.total),
      notes: f.notes,
    });
    flash($('#direct-msg'), `Booked ${b.external_ref} for ${b.guest_name}${b.total != null ? ` (${money(b.total, b.currency)})` : ''}. Rooms taken off all channels.`);
    for (const k of ['guest_name', 'guest_phone', 'guest_email', 'total', 'notes']) e.target[k].value = '';
    await Promise.all([loadBookings(), refreshStatus(), updateQuote()]);
  } catch (err) {
    flash($('#direct-msg'), err.message, false);
  }
});

const DEMO_PREFIX = { booking_com: 'BDC', agoda: 'AGD', makemytrip: 'MMT', expedia: 'EXP' };

$('#booking-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const channel = f.channel.value;
  const prefix = DEMO_PREFIX[channel] || channel.toUpperCase();
  try {
    const r = await api('POST', `/api/channels/${channel}/bookings`, {
      external_ref: `${prefix}-${Date.now().toString().slice(-7)}`,
      room_id: `${prefix}-${f.room.value}`,
      check_in: f.check_in.value,
      check_out: addDays(f.check_in.value, Number(f.nights.value)),
      rooms: Number(f.rooms.value),
      guest_name: f.guest_name.value || 'Demo Guest',
    });
    flash($('#booking-msg'), r.booking.overbooked
      ? 'Booking received, but those dates were already full: OVERBOOKED.'
      : 'Booking received. Availability reduced on all channels.', !r.booking.overbooked);
    await Promise.all([loadBookings(), refreshStatus()]);
  } catch (err) {
    flash($('#booking-msg'), err.message, false);
  }
});

function statusBadge(b) {
  if (b.status === 'cancelled') return '<span class="badge off">Cancelled</span>';
  const open = !b.handled_at;
  if (b.overbooked && open) return '<span class="badge err">⚠ Overbooked</span>';
  if (b.needs_attention && open) return '<span class="badge err">⚠ Needs attention</span>';
  if (b.check_out < todayStr()) return '<span class="badge off">Checked out</span>';
  if (b.check_in === todayStr()) return '<span class="badge warn">Arriving today</span>';
  if (b.check_in < todayStr()) return '<span class="badge ok">In house</span>';
  return '<span class="badge ok">Confirmed</span>';
}

const sourceLabel = (b) => (b.channel_kind === 'channex'
  ? `${esc(b.source || 'Channex')} <span class="muted small">via Channex</span>` : esc(b.source || b.channel_name));

async function loadBookings() {
  const rows = await api('GET', `/api/bookings?view=${bookingFilter.view}&q=${encodeURIComponent(bookingFilter.q)}`);
  if (rows.length === 0) {
    $('#bookings').innerHTML = `<tr><td class="muted">${bookingFilter.q ? 'No bookings match your search.' : 'No bookings here.'}</td></tr>`;
    return;
  }
  $('#bookings').innerHTML = `<thead><tr><th>Guest</th><th>From</th><th>Rooms</th><th>Stay</th><th class="num">Total</th><th>Status</th><th></th></tr></thead><tbody>${
    rows.map((b) => `<tr class="clickable" data-booking="${b.id}" tabindex="0">
        <td><strong>${esc(b.guest_name) || '<span class="muted">–</span>'}</strong>
          <div class="muted small">${esc(b.external_ref)}${b.guest_phone ? ` · ${esc(b.guest_phone)}` : ''}</div></td>
        <td>${sourceLabel(b)}</td>
        <td>${esc(b.rooms_summary) || '<span class="muted">–</span>'}${b.rooms > 1 ? ` <span class="muted small">(${b.rooms})</span>` : ''}</td>
        <td class="nowrap">${shortDate(b.check_in)} → ${shortDate(b.check_out)}</td>
        <td class="num">${b.total != null ? money(b.total, b.currency || undefined) : ''}</td>
        <td>${statusBadge(b)}</td>
        <td class="nowrap"><button data-open="${b.id}">Details</button></td>
      </tr>`).join('')}</tbody>`;
}

/** The booking detail: rooms, guest, money, flags, and what can be done with it. */
async function openBooking(id) {
  const b = await api('GET', `/api/bookings/${id}`);
  const flagged = b.status === 'confirmed' && !b.handled_at && (b.overbooked || b.needs_attention);
  const canCancel = can('bookings') && b.status === 'confirmed' && b.channel_kind !== 'channex';
  openDialog({
    title: `${b.guest_name || 'Booking'} · ${b.external_ref}`,
    wide: true,
    body: `
      <div class="detail">
        <div><span class="muted small">Status</span>${statusBadge(b)}</div>
        <div><span class="muted small">From</span>${sourceLabel(b)}</div>
        <div><span class="muted small">Stay</span>${esc(longDate(b.check_in))} → ${esc(longDate(b.check_out))} · ${b.nights} night(s)</div>
        <div><span class="muted small">Total</span>${b.total != null ? money(b.total, b.currency || undefined, 2) : '–'}</div>
        <div><span class="muted small">Phone</span>${esc(b.guest_phone) || '–'}</div>
        <div><span class="muted small">Email</span>${esc(b.guest_email) || '–'}</div>
      </div>
      <table class="list"><thead><tr><th>Room</th><th>Rate plan</th><th>Rooms</th><th>Guests</th><th>Dates</th></tr></thead><tbody>
        ${b.lines.map((l) => `<tr><td>${esc(l.room_type_name)}</td><td>${esc(l.rate_plan_name || '–')}${l.meal_plan ? ` <span class="muted small">${esc(l.meal_plan)}</span>` : ''}</td>
          <td>${l.rooms}</td><td>${l.adults ?? '–'} adult(s)${l.children ? `, ${l.children} child(ren)` : ''}</td>
          <td class="nowrap">${shortDate(l.check_in)} → ${shortDate(l.check_out)}</td></tr>`).join('')}
      </tbody></table>
      ${b.notes ? `<p><span class="muted small">Notes</span><br>${esc(b.notes)}</p>` : ''}
      ${flagged ? `<p class="err">⚠ ${b.overbooked ? 'This booking came in when the room was already full. Find the guest another room.' : esc(b.needs_attention)}</p>` : ''}
      <div class="actions">
        <a class="button" href="voucher.html?id=${b.id}&property=${state.property.id}" target="_blank" rel="noopener">Print voucher</a>
        ${flagged && can('bookings') ? `<button type="button" data-handled="${b.id}">Mark handled</button>` : ''}
        ${canCancel ? `<button type="button" class="danger" data-cancel="${b.id}">Cancel booking</button>` : ''}
        ${b.channel_kind === 'channex' && b.status === 'confirmed' ? `<span class="muted small">Cancel it on ${esc(b.source || 'the OTA')}; the cancellation comes through automatically.</span>` : ''}
      </div>`,
    onOpen: () => {
      const body = $('#dialog-body');
      body.onclick = async (e) => {
        const { cancel, handled } = e.target.dataset;
        if (!cancel && !handled) return;
        try {
          if (cancel) {
            if (!confirm('Cancel this booking? Its rooms go back on sale on every channel.')) return;
            await api('POST', `/api/bookings/${cancel}/cancel`);
          } else {
            await api('POST', `/api/bookings/${handled}/handled`);
          }
          $('#dialog').close();
          await Promise.all([state.view === 'bookings' ? loadBookings() : Views[state.view]?.show?.(), refreshStatus()]);
        } catch (err) {
          flash($('#dialog-msg'), err.message, false);
        }
      };
    },
  });
}

$('#bookings').addEventListener('click', (e) => {
  const row = e.target.closest('[data-booking]');
  if (row) openBooking(Number(row.dataset.booking));
});
$('#bookings').addEventListener('keydown', (e) => {
  const row = e.target.closest('[data-booking]');
  if (row && e.key === 'Enter') openBooking(Number(row.dataset.booking));
});

$('#booking-tabs').addEventListener('click', (e) => {
  const view = e.target.dataset.view;
  if (!view) return;
  bookingFilter.view = view;
  for (const b of $$('#booking-tabs button')) b.classList.toggle('active', b.dataset.view === view);
  loadBookings();
});

let searchTimer;
$('#booking-search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { bookingFilter.q = e.target.value.trim(); loadBookings(); }, 250);
});

Views.bookings = {
  show: async () => {
    await ensureRoomTypes();
    fillBookingForms();
    await Promise.all([loadBookings(), updateQuote()]);
  },
  poll: () => loadBookings(),
};
