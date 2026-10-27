// Printable booking confirmation: voucher.html?id=<booking>&property=<property>
(async function voucher() {
  const params = new URLSearchParams(location.search);
  const root = document.getElementById('voucher');
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const date = (s) => new Date(`${s}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const money = (n, cur) => {
    if (n == null) return '–';
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'INR' }).format(n); } catch { return `${cur} ${n}`; }
  };
  const MEALS = { EP: 'Room only', CP: 'Breakfast included', MAP: 'Breakfast and dinner', AP: 'All meals', OTHER: '' };
  try {
    const res = await fetch(`/api/bookings/${encodeURIComponent(params.get('id'))}`, {
      headers: { 'x-property-id': params.get('property') || '', 'x-requested-with': 'channel-manager' },
    });
    const b = await res.json();
    if (!res.ok) throw new Error(b.error || 'Could not load the booking');
    const p = b.property;
    const cur = b.currency || p.currency;
    document.title = `Booking ${b.external_ref} · ${p.name}`;
    root.innerHTML = `
      <header>
        <div><h1>${esc(p.name)}</h1><div class="muted">${esc([p.city, p.country].filter(Boolean).join(', '))}</div></div>
        <div class="ref"><span class="muted small">Booking confirmation</span><strong>${esc(b.external_ref)}</strong>
          ${b.status === 'cancelled' ? '<span class="cancelled">CANCELLED</span>' : ''}</div>
      </header>
      <div class="facts">
        <div><span>Guest</span>${esc(b.guest_name || '–')}</div>
        <div><span>Check-in</span>${esc(date(b.check_in))}</div>
        <div><span>Check-out</span>${esc(date(b.check_out))}</div>
        <div><span>Nights</span>${b.nights}</div>
        ${b.guest_phone ? `<div><span>Phone</span>${esc(b.guest_phone)}</div>` : ''}
        ${b.guest_email ? `<div><span>Email</span>${esc(b.guest_email)}</div>` : ''}
        <div><span>Booked via</span>${esc(b.source || b.channel_name)}</div>
      </div>
      <h2>Rooms</h2>
      <table><thead><tr><th>Room</th><th>Plan</th><th>Rooms</th><th>Guests per room</th></tr></thead><tbody>
        ${b.lines.map((l) => `<tr><td>${esc(l.room_type_name)}</td>
          <td>${esc(l.rate_plan_name || '–')}${l.meal_plan && MEALS[l.meal_plan] ? `<div class="muted small">${esc(MEALS[l.meal_plan])}</div>` : ''}</td>
          <td>${l.rooms}</td><td>${l.adults ?? '–'} adult(s)${l.children ? `, ${l.children} child(ren)` : ''}</td></tr>`).join('')}
      </tbody></table>
      ${b.total != null ? `<p class="total">Total: <strong>${esc(money(b.total, cur))}</strong></p>` : ''}
      ${b.notes ? `<h2>Notes</h2><p>${esc(b.notes)}</p>` : ''}
      <div class="actions"><button type="button" id="print">Print</button></div>
      <footer>Issued ${esc(new Date().toLocaleString())}</footer>`;
    document.getElementById('print').addEventListener('click', () => window.print());
  } catch (err) {
    root.innerHTML = `<p>${esc(err.message)}</p><p class="muted small">Log in to the channel manager in this browser first.</p>`;
  }
}());
