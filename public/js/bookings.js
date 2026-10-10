// Bookings page: add direct bookings, list and filter all bookings.

const bookingFilter = { view: 'upcoming', q: '' };
const DEMO_PREFIX = { booking_com: 'BDC', agoda: 'AGD', makemytrip: 'MMT', expedia: 'EXP' };

async function ensureRoomTypes() {
  state.roomTypes = await api('GET', '/api/room-types');
}

function fillBookingForms() {
  const opts = state.roomTypes.map((rt) => `<option value="${rt.id}">${esc(rt.name)}</option>`).join('');
  const direct = $('#direct-room');
  const prev = direct.value;
  direct.innerHTML = opts || '<option value="">Add room types in Settings first</option>';
  if (prev) direct.value = prev;
  $('#direct-form').check_in.value ||= todayStr();

  const demo = state.channels.filter((c) => c.kind === 'simulated');
  $('#demo-booking').hidden = demo.length === 0 || state.roomTypes.length === 0;
  const sel = $('#bk-channel');
  const prevCh = sel.value;
  sel.innerHTML = demo.map((c) => `<option value="${c.code}">${esc(c.name)}</option>`).join('');
  if (prevCh) sel.value = prevCh;
  $('#bk-room').innerHTML = state.roomTypes.map((rt) => `<option value="${rt.code}">${esc(rt.name)}</option>`).join('');
  $('#booking-form').check_in.value ||= todayStr();
}

$('#direct-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = formData(e.target);
  try {
    const b = await api('POST', '/api/bookings', {
      room_type_id: Number(f.room_type_id),
      check_in: f.check_in,
      check_out: addDays(f.check_in, Number(f.nights)),
      rooms: Number(f.rooms),
      guest_name: f.guest_name,
      total: f.total === '' ? null : Number(f.total),
      notes: f.notes,
    });
    flash($('#direct-msg'), `Booked ${b.external_ref} for ${b.guest_name}. Availability reduced on all channels.`);
    e.target.guest_name.value = '';
    e.target.total.value = '';
    e.target.notes.value = '';
    await Promise.all([loadBookings(), refreshStatus()]);
  } catch (err) {
    flash($('#direct-msg'), err.message, false);
  }
});

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
  if (b.overbooked && open) return '<span class="badge err">Overbooked</span>';
  if (b.needs_attention && open) return '<span class="badge err">Needs attention</span>';
  if (b.check_out < todayStr()) return '<span class="badge off">Checked out</span>';
  if (b.check_in === todayStr()) return '<span class="badge warn">Arriving today</span>';
  return '<span class="badge ok">Confirmed</span>';
}

async function loadBookings() {
  const rows = await api('GET', `/api/bookings?view=${bookingFilter.view}&q=${encodeURIComponent(bookingFilter.q)}`);
  if (rows.length === 0) {
    $('#bookings').innerHTML = `<tr><td class="muted">${bookingFilter.q ? 'No bookings match your search.' : 'No bookings here.'}</td></tr>`;
    return;
  }
  $('#bookings').innerHTML = `<thead><tr><th>Ref</th><th>From</th><th>Guest</th><th>Rooms</th><th>Stay</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>${
    rows.map((b) => {
      const flagged = b.status === 'confirmed' && !b.handled_at && (b.overbooked || b.needs_attention);
      const canCancel = b.status === 'confirmed' && b.channel_kind !== 'channex';
      return `<tr>
        <td class="nowrap">${esc(b.external_ref)}</td>
        <td>${b.source && b.channel_kind === 'channex' ? `${esc(b.source)} <span class="muted small">via Channex</span>`
          : esc(b.source || b.channel_name)}</td>
        <td>${esc(b.guest_name) || '<span class="muted">–</span>'}${b.notes ? `<div class="muted small">${esc(b.notes)}</div>` : ''}</td>
        <td>${esc(b.rooms_summary) || '<span class="muted">–</span>'}${b.rooms > 1 ? ` <span class="muted small">(${b.rooms})</span>` : ''}</td>
        <td class="nowrap">${shortDate(b.check_in)} → ${shortDate(b.check_out)}</td>
        <td class="nowrap">${b.total != null ? money(b.total, b.currency || undefined) : ''}</td>
        <td>${statusBadge(b)}${flagged && b.needs_attention ? `<div class="err small">${esc(b.needs_attention)}</div>` : ''}</td>
        <td class="nowrap">
          ${flagged ? `<button data-handled="${b.id}">Mark handled</button>` : ''}
          ${canCancel ? `<button data-cancel="${b.id}" class="danger">Cancel</button>` : ''}
        </td>
      </tr>`;
    }).join('')}</tbody>`;
}

$('#bookings').addEventListener('click', async (e) => {
  const { cancel, handled } = e.target.dataset;
  try {
    if (cancel) {
      if (!confirm('Cancel this booking? Its rooms go back on sale on every channel.')) return;
      await api('POST', `/api/bookings/${cancel}/cancel`);
    } else if (handled) {
      await api('POST', `/api/bookings/${handled}/handled`);
    } else {
      return;
    }
    await Promise.all([loadBookings(), refreshStatus()]);
  } catch (err) {
    alert(err.message);
  }
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
    await loadBookings();
  },
  poll: () => loadBookings(),
};
