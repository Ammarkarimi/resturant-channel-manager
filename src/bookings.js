const crypto = require('node:crypto');
const { transaction } = require('./db');
const { queueSync } = require('./queue');
const { ensureRoomRows, roomCell } = require('./inventory');
const { Pricer, roundMoney } = require('./pricing');
const { isValidDate, addDays, eachDate, today } = require('./dates');
const { badRequest, notFound, HttpError } = require('./errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getChannelByCode(db, propertyId, code) {
  const channel = db.prepare('SELECT * FROM channels WHERE property_id = ? AND code = ?').get(propertyId, code);
  if (!channel) throw notFound(`Unknown channel "${code}"`);
  return channel;
}

const nightsOf = (line) => eachDate(line.check_in, addDays(line.check_out, -1));

const getLines = (db, bookingId) =>
  db.prepare(`SELECT room_type_id, rate_plan_id, check_in, check_out, rooms, adults, children
              FROM booking_lines WHERE booking_id = ? ORDER BY id`).all(bookingId);

/**
 * Record the latest state of a reservation and keep the shared room pool in
 * step with it. Works for new bookings, modifications and cancellations: the
 * rooms the previous version held are released, then the rooms the new
 * version holds are taken, and every affected night is queued for sync.
 *
 * @param {object} channel
 * @param {object} res { external_ref, status: 'confirmed'|'cancelled',
 *                       lines: [{room_type_id, rate_plan_id?, check_in, check_out, rooms, adults?, children?}],
 *                       check_in?, check_out?, source?, guest_name?, guest_email?, guest_phone?, total?,
 *                       currency?, needs_attention?, notes? }
 * @param {boolean} opts.stopSellCounts  treat stop-sell nights as full (true for OTA bookings;
 *                                       stop-sell only closes the OTAs, the hotel itself can still sell)
 */
function applyReservation(db, channel, res, { stopSellCounts = true } = {}) {
  const existing = db.prepare('SELECT * FROM bookings WHERE channel_id = ? AND external_ref = ?')
    .get(channel.id, res.external_ref);

  return transaction(db, () => {
    const now = new Date().toISOString();
    const adjust = db.prepare(`
      UPDATE room_inventory SET available = available + ?, updated_at = ?
      WHERE room_type_id = ? AND date >= ? AND date < ?
    `);

    if (existing && existing.status === 'confirmed') {
      for (const line of getLines(db, existing.id)) {
        adjust.run(line.rooms, now, line.room_type_id, line.check_in, line.check_out);
        queueSync(db, line.room_type_id, nightsOf(line));
      }
    }

    let overbooked = 0;
    if (res.status === 'confirmed') {
      const short = db.prepare(`
        SELECT COUNT(*) AS n FROM room_inventory
        WHERE room_type_id = ? AND date >= ? AND date < ? AND (available < ? OR (stop_sell = 1 AND ?))
      `);
      for (const line of res.lines) {
        const nights = nightsOf(line);
        ensureRoomRows(db, db.prepare('SELECT * FROM room_types WHERE id = ?').get(line.room_type_id), nights);
        // The OTA has already confirmed the guest, so we can't refuse. Record
        // it and flag it so the hotel can relocate the guest.
        if (short.get(line.room_type_id, line.check_in, line.check_out, line.rooms, stopSellCounts ? 1 : 0).n > 0) overbooked = 1;
        adjust.run(-line.rooms, now, line.room_type_id, line.check_in, line.check_out);
        queueSync(db, line.room_type_id, nights);
      }
    }

    const checkIn = res.check_in || res.lines.map((l) => l.check_in).sort()[0];
    const checkOut = res.check_out || res.lines.map((l) => l.check_out).sort().at(-1);
    const values = {
      source: res.source ?? null,
      check_in: checkIn,
      check_out: checkOut,
      guest_name: res.guest_name ?? null,
      guest_email: res.guest_email ?? null,
      guest_phone: res.guest_phone ?? null,
      total: res.total == null || Number.isNaN(res.total) ? null : Number(res.total),
      currency: res.currency ?? null,
      status: res.status,
      overbooked,
      needs_attention: res.needs_attention ?? null,
      notes: res.notes ?? null,
      updated_at: now,
    };

    let id;
    if (existing) {
      id = existing.id;
      db.prepare(`UPDATE bookings SET ${Object.keys(values).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...Object.values(values), id);
      db.prepare('DELETE FROM booking_lines WHERE booking_id = ?').run(id);
    } else {
      const all = { ...values, channel_id: channel.id, external_ref: res.external_ref, created_at: now };
      id = db.prepare(`INSERT INTO bookings (${Object.keys(all).join(', ')}) VALUES (${Object.keys(all).map(() => '?').join(', ')})`)
        .run(...Object.values(all)).lastInsertRowid;
    }
    const insLine = db.prepare(`INSERT INTO booking_lines (booking_id, room_type_id, rate_plan_id, check_in, check_out, rooms, adults, children)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const l of res.lines) {
      insLine.run(id, l.room_type_id, l.rate_plan_id ?? null, l.check_in, l.check_out, l.rooms, l.adults ?? null, l.children ?? null);
    }

    return { booking: db.prepare('SELECT * FROM bookings WHERE id = ?').get(id), created: !existing };
  });
}

/**
 * A booking arrived directly from a (demo) OTA. Take the rooms out of the
 * shared pool and push the new availability to every channel so nobody else
 * can sell them. Re-sending the same booking reference is a no-op.
 */
function receiveBooking(db, propertyId, channelCode, body) {
  const channel = getChannelByCode(db, propertyId, channelCode);
  const { external_ref, room_id, rate_plan_id: extPlan, check_in, check_out, guest_name, total } = body || {};
  const rooms = body?.rooms === undefined ? 1 : Number(body.rooms);

  if (!external_ref || typeof external_ref !== 'string') throw badRequest('external_ref is required');
  if (!isValidDate(check_in) || !isValidDate(check_out)) throw badRequest('check_in and check_out must be YYYY-MM-DD');
  if (check_out <= check_in) throw badRequest('check_out must be after check_in');
  if (!Number.isInteger(rooms) || rooms < 1) throw badRequest('rooms must be a whole number ≥ 1');

  const mapping = db.prepare(
    'SELECT room_type_id FROM channel_room_mappings WHERE channel_id = ? AND external_room_id = ?'
  ).get(channel.id, room_id);
  if (!mapping) throw badRequest(`Room "${room_id}" is not mapped for ${channel.name}`);
  const plan = extPlan
    ? db.prepare(`SELECT rp.id FROM channel_rate_plan_mappings m JOIN rate_plans rp ON rp.id = m.rate_plan_id
                  WHERE m.channel_id = ? AND m.external_rate_plan_id = ? AND rp.room_type_id = ?`).get(channel.id, extPlan, mapping.room_type_id)
    : null;
  if (extPlan && !plan) throw badRequest(`Rate plan "${extPlan}" is not mapped for ${channel.name}`);

  const existing = db.prepare('SELECT * FROM bookings WHERE channel_id = ? AND external_ref = ?')
    .get(channel.id, external_ref);
  if (existing) return { booking: existing, duplicate: true };

  const { booking } = applyReservation(db, channel, {
    external_ref, status: 'confirmed', guest_name, total: total == null ? null : Number(total),
    source: channel.name,
    lines: [{ room_type_id: mapping.room_type_id, rate_plan_id: plan?.id ?? null, check_in, check_out, rooms }],
  });
  return { booking, duplicate: false };
}

/** Put the rooms of a cancelled booking back on sale everywhere. */
function cancelBooking(db, propertyId, channelCode, externalRef) {
  const channel = getChannelByCode(db, propertyId, channelCode);
  const booking = db.prepare('SELECT * FROM bookings WHERE channel_id = ? AND external_ref = ?')
    .get(channel.id, externalRef);
  if (!booking) throw notFound(`Booking ${externalRef} not found on ${channel.name}`);
  if (booking.status === 'cancelled') return { booking, duplicate: true };

  const result = applyReservation(db, channel, {
    ...booking, status: 'cancelled', lines: getLines(db, booking.id),
  });
  return { booking: result.booking, duplicate: false };
}

/** Price of one room for one night with this many guests. */
function priceForGuests(p, adults, children) {
  let price;
  if (adults <= 1) price = p.rate_single ?? p.rate_double;
  else if (adults === 2) price = p.rate_double;
  else if (adults === 3 && p.rate_triple != null) price = p.rate_triple;
  else {
    const base = p.rate_triple != null && adults > 3 ? p.rate_triple : p.rate_double;
    const included = p.rate_triple != null && adults > 3 ? 3 : 2;
    price = base + (adults - included) * (p.extra_adult ?? 0);
  }
  return price + children * (p.extra_child ?? 0);
}

function parseStay(db, propertyId, body) {
  const roomType = db.prepare('SELECT * FROM room_types WHERE id = ? AND property_id = ?').get(Number(body.room_type_id), propertyId);
  if (!roomType) throw badRequest('Choose a room type');
  const checkIn = body.check_in;
  const checkOut = body.check_out;
  if (!isValidDate(checkIn) || !isValidDate(checkOut)) throw badRequest('Enter check-in and check-out dates');
  if (checkOut <= checkIn) throw badRequest('Check-out must be after check-in');
  if (eachDate(checkIn, checkOut).length > 366) throw badRequest('Stays are limited to a year');
  const rooms = body.rooms === undefined || body.rooms === '' ? 1 : Number(body.rooms);
  if (!Number.isInteger(rooms) || rooms < 1) throw badRequest('Rooms must be a whole number ≥ 1');
  const adults = body.adults === undefined || body.adults === '' ? 2 : Number(body.adults);
  const children = body.children === undefined || body.children === '' ? 0 : Number(body.children);
  if (!Number.isInteger(adults) || adults < 1) throw badRequest('Adults per room must be at least 1');
  if (!Number.isInteger(children) || children < 0) throw badRequest('Children must be 0 or more');
  if (adults > roomType.max_adults) throw badRequest(`${roomType.name} takes at most ${roomType.max_adults} adults per room`);
  if (children > roomType.max_children) throw badRequest(`${roomType.name} takes at most ${roomType.max_children} children per room`);
  let plan = null;
  if (body.rate_plan_id !== undefined && body.rate_plan_id !== null && body.rate_plan_id !== '') {
    plan = db.prepare('SELECT * FROM rate_plans WHERE id = ? AND room_type_id = ?').get(Number(body.rate_plan_id), roomType.id);
    if (!plan) throw badRequest('That rate plan does not belong to this room type');
  }
  return { roomType, plan, checkIn, checkOut, rooms, adults, children };
}

/** What a stay would cost, and anything that would normally stop it being sold. */
function quote(db, propertyId, body) {
  const s = parseStay(db, propertyId, body);
  const nights = nightsOf({ check_in: s.checkIn, check_out: s.checkOut });
  const warnings = [];
  const minAvail = Math.min(...nights.map((d) => roomCell(db, s.roomType, d).available));
  if (minAvail < s.rooms) warnings.push(`Only ${Math.max(0, minAvail)} ${s.roomType.name} left on some nights`);
  if (!s.plan) return { nights: nights.length, total: null, per_night: [], warnings };

  const pricer = new Pricer(db);
  const perNight = nights.map((d) => ({ date: d, price: roundMoney(priceForGuests(pricer.prices(s.plan.id, d), s.adults, s.children)) }));
  const first = pricer.restrictions(s.plan.id, s.checkIn);
  if (nights.some((d) => pricer.restrictions(s.plan.id, d).stop_sell)) warnings.push(`${s.plan.name} is on stop sell for some nights`);
  if (first.cta) warnings.push(`${s.plan.name} is closed to arrival on ${s.checkIn}`);
  if (pricer.restrictions(s.plan.id, s.checkOut).ctd) warnings.push(`${s.plan.name} is closed to departure on ${s.checkOut}`);
  if (nights.length < first.min_stay) warnings.push(`Minimum stay from ${s.checkIn} is ${first.min_stay} nights`);
  if (first.max_stay && nights.length > first.max_stay) warnings.push(`Maximum stay from ${s.checkIn} is ${first.max_stay} nights`);
  const total = roundMoney(perNight.reduce((sum, n) => sum + n.price, 0) * s.rooms);
  return { nights: nights.length, total, per_night: perNight, warnings };
}

/**
 * A booking taken by phone or at the front desk. Unlike an OTA booking the
 * hotel can still say no, so it is refused when the rooms aren't free.
 * Without a total, the rate plan's price is used.
 */
function createDirectBooking(db, propertyId, body) {
  const channel = getChannelByCode(db, propertyId, 'direct');
  const s = parseStay(db, propertyId, body || {});
  const guest = body.guest_name;
  if (typeof guest !== 'string' || !guest.trim()) throw badRequest('Enter the guest name');
  const email = typeof body.guest_email === 'string' && body.guest_email.trim() ? body.guest_email.trim() : null;
  if (email && !EMAIL_RE.test(email)) throw badRequest('Guest email is not valid');
  const phone = typeof body.guest_phone === 'string' && body.guest_phone.trim() ? body.guest_phone.trim().slice(0, 40) : null;
  let total = body.total === undefined || body.total === null || body.total === '' ? null : Number(body.total);
  if (total !== null && (!Number.isFinite(total) || total < 0)) throw badRequest('Total must be a positive number');
  if (total === null && s.plan) total = quote(db, propertyId, body).total;

  return transaction(db, () => {
    ensureRoomRows(db, s.roomType, nightsOf({ check_in: s.checkIn, check_out: s.checkOut }));
    const full = db.prepare(`
      SELECT date, available FROM room_inventory WHERE room_type_id = ? AND date >= ? AND date < ? AND available < ?
      ORDER BY date LIMIT 1
    `).get(s.roomType.id, s.checkIn, s.checkOut, s.rooms);
    if (full) throw new HttpError(409, `Only ${Math.max(0, full.available)} ${s.roomType.name} left on ${full.date}`);
    const { currency } = db.prepare('SELECT currency FROM properties WHERE id = ?').get(propertyId);
    return applyReservation(db, channel, {
      external_ref: `DIR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      status: 'confirmed',
      source: 'Direct',
      guest_name: guest.trim(),
      guest_email: email,
      guest_phone: phone,
      total,
      currency,
      notes: typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim().slice(0, 1000) : null,
      lines: [{
        room_type_id: s.roomType.id, rate_plan_id: s.plan?.id ?? null, check_in: s.checkIn, check_out: s.checkOut,
        rooms: s.rooms, adults: s.adults, children: s.children,
      }],
    }, { stopSellCounts: false }).booking;
  });
}

/** A booking with its rooms, plans and channel, for the detail view and voucher. */
function getBooking(db, propertyId, id) {
  const booking = db.prepare(`
    SELECT b.*, c.code AS channel_code, c.kind AS channel_kind, c.name AS channel_name
    FROM bookings b JOIN channels c ON c.id = b.channel_id
    WHERE b.id = ? AND c.property_id = ?
  `).get(id, propertyId);
  if (!booking) throw notFound('Booking not found');
  booking.lines = db.prepare(`
    SELECT l.*, rt.name AS room_type_name, rp.name AS rate_plan_name, rp.meal_plan
    FROM booking_lines l JOIN room_types rt ON rt.id = l.room_type_id LEFT JOIN rate_plans rp ON rp.id = l.rate_plan_id
    WHERE l.booking_id = ? ORDER BY l.id`).all(id);
  booking.nights = eachDate(booking.check_in, booking.check_out).length - 1;
  return booking;
}

/** Cancel a booking from the dashboard. OTA bookings must be cancelled on the OTA, which then tells us. */
function cancelBookingById(db, propertyId, id) {
  const booking = getBooking(db, propertyId, id);
  if (booking.channel_kind === 'channex') {
    throw badRequest(`Cancel this booking on ${booking.source || 'the OTA'}; the cancellation will come through automatically`);
  }
  return cancelBooking(db, propertyId, booking.channel_code, booking.external_ref);
}

/** Staff have dealt with an overbooking / attention flag. */
function markHandled(db, propertyId, id) {
  getBooking(db, propertyId, id);
  db.prepare('UPDATE bookings SET handled_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  return getBooking(db, propertyId, id);
}

const VIEWS = {
  upcoming: "b.status = 'confirmed' AND b.check_out >= :today",
  arrivals: "b.status = 'confirmed' AND b.check_in = :today",
  departures: "b.status = 'confirmed' AND b.check_out = :today",
  inhouse: "b.status = 'confirmed' AND b.check_in <= :today AND b.check_out > :today",
  past: "b.status = 'confirmed' AND b.check_out < :today",
  cancelled: "b.status = 'cancelled'",
  attention: "b.status = 'confirmed' AND b.handled_at IS NULL AND (b.overbooked = 1 OR b.needs_attention IS NOT NULL) AND b.check_out >= :today",
  all: '1 = 1',
};

function listBookings(db, propertyId, { view = 'all', q = '', limit = 200 } = {}) {
  const where = VIEWS[view];
  if (!where) throw badRequest(`view must be one of ${Object.keys(VIEWS).join(', ')}`);
  const search = String(q || '').trim().toLowerCase();
  const rows = db.prepare(`
    SELECT b.*, c.name AS channel_name, c.code AS channel_code, c.kind AS channel_kind
    FROM bookings b JOIN channels c ON c.id = b.channel_id
    WHERE c.property_id = :property AND ${where}
      AND (:q = '' OR lower(coalesce(b.guest_name, '')) LIKE :like OR lower(b.external_ref) LIKE :like
           OR lower(coalesce(b.source, '')) LIKE :like OR lower(coalesce(b.guest_phone, '')) LIKE :like
           OR lower(coalesce(b.guest_email, '')) LIKE :like)
    ORDER BY ${['upcoming', 'arrivals', 'inhouse', 'departures'].includes(view) ? 'b.check_in ASC, b.id ASC' : 'b.updated_at DESC, b.id DESC'}
    LIMIT :limit
  `).all({ property: propertyId, ...(where.includes(':today') ? { today: today() } : {}), q: search, like: `%${search}%`, limit });
  const lines = db.prepare(`
    SELECT r.name, SUM(l.rooms) AS rooms FROM booking_lines l JOIN room_types r ON r.id = l.room_type_id
    WHERE l.booking_id = ? GROUP BY r.id ORDER BY r.id
  `);
  return rows.map((b) => {
    const rooms = lines.all(b.id);
    return {
      ...b,
      rooms: rooms.reduce((n, r) => n + r.rooms, 0),
      rooms_summary: rooms.map((r) => (r.rooms > 1 ? `${r.name} ×${r.rooms}` : r.name)).join(', '),
    };
  });
}

module.exports = {
  applyReservation, receiveBooking, cancelBooking, cancelBookingById, createDirectBooking, markHandled,
  listBookings, getBooking, getChannelByCode, quote, priceForGuests,
};
