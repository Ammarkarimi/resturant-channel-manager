const crypto = require('node:crypto');
const { transaction } = require('./db');
const { queueSync } = require('./queue');
const { ensureRows, getRoomType } = require('./inventory');
const { isValidDate, addDays, eachDate, today } = require('./dates');
const { badRequest, notFound, HttpError } = require('./errors');

function getChannelByCode(db, code) {
  const channel = db.prepare('SELECT * FROM channels WHERE code = ?').get(code);
  if (!channel) throw notFound(`Unknown channel "${code}"`);
  return channel;
}

const nightsOf = (line) => eachDate(line.check_in, addDays(line.check_out, -1));

const getLines = (db, bookingId) =>
  db.prepare('SELECT room_type_id, check_in, check_out, rooms FROM booking_lines WHERE booking_id = ? ORDER BY id')
    .all(bookingId);

/**
 * Record the latest state of a reservation and keep the shared room pool in
 * step with it. Works for new bookings, modifications and cancellations: the
 * rooms the previous version held are released, then the rooms the new
 * version holds are taken, and every affected night is queued for sync.
 *
 * @param {object} channel
 * @param {object} res { external_ref, status: 'confirmed'|'cancelled', lines: [{room_type_id, check_in, check_out, rooms}],
 *                       check_in?, check_out?, source?, guest_name?, total?, currency?, needs_attention?, notes? }
 * @param {boolean} opts.stopSellCounts  treat stop-sell nights as full (true for OTA bookings;
 *                                       stop-sell only closes the OTAs, the hotel itself can still sell)
 */
function applyReservation(db, channel, res, { stopSellCounts = true } = {}) {
  const existing = db.prepare('SELECT * FROM bookings WHERE channel_id = ? AND external_ref = ?')
    .get(channel.id, res.external_ref);

  return transaction(db, () => {
    const now = new Date().toISOString();
    const adjust = db.prepare(`
      UPDATE inventory SET available = available + ?, updated_at = ?
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
        SELECT COUNT(*) AS n FROM inventory
        WHERE room_type_id = ? AND date >= ? AND date < ? AND (available < ? OR (stop_sell = 1 AND ?))
      `);
      for (const line of res.lines) {
        const nights = nightsOf(line);
        ensureRows(db, getRoomType(db, line.room_type_id), nights);
        // The OTA has already confirmed the guest, so we can't refuse. Record
        // it and flag it so the hotel can relocate the guest.
        if (short.get(line.room_type_id, line.check_in, line.check_out, line.rooms, stopSellCounts ? 1 : 0).n > 0) overbooked = 1;
        adjust.run(-line.rooms, now, line.room_type_id, line.check_in, line.check_out);
        queueSync(db, line.room_type_id, nights);
      }
    }

    const checkIn = res.check_in || res.lines.map((l) => l.check_in).sort()[0];
    const checkOut = res.check_out || res.lines.map((l) => l.check_out).sort().at(-1);
    const fields = [res.source ?? null, checkIn, checkOut, res.guest_name ?? null,
      res.total == null || Number.isNaN(res.total) ? null : Number(res.total), res.currency ?? null,
      res.status, overbooked, res.needs_attention ?? null, res.notes ?? null, now];

    let id;
    if (existing) {
      id = existing.id;
      db.prepare(`
        UPDATE bookings SET source = ?, check_in = ?, check_out = ?, guest_name = ?, total = ?, currency = ?,
          status = ?, overbooked = ?, needs_attention = ?, notes = ?, updated_at = ?
        WHERE id = ?
      `).run(...fields, id);
      db.prepare('DELETE FROM booking_lines WHERE booking_id = ?').run(id);
    } else {
      id = db.prepare(`
        INSERT INTO bookings (source, check_in, check_out, guest_name, total, currency, status, overbooked,
                              needs_attention, notes, updated_at, channel_id, external_ref, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...fields, channel.id, res.external_ref, now).lastInsertRowid;
    }
    const insLine = db.prepare(
      'INSERT INTO booking_lines (booking_id, room_type_id, check_in, check_out, rooms) VALUES (?, ?, ?, ?, ?)'
    );
    for (const l of res.lines) insLine.run(id, l.room_type_id, l.check_in, l.check_out, l.rooms);

    return { booking: db.prepare('SELECT * FROM bookings WHERE id = ?').get(id), created: !existing };
  });
}

/**
 * A booking arrived directly from an OTA. Take the rooms out of the shared
 * pool and push the new availability to every channel so nobody else can
 * sell them. Re-sending the same booking reference is a no-op.
 */
function receiveBooking(db, channelCode, body) {
  const channel = getChannelByCode(db, channelCode);
  const { external_ref, room_id, check_in, check_out, guest_name, total } = body || {};
  const rooms = body?.rooms === undefined ? 1 : Number(body.rooms);

  if (!external_ref || typeof external_ref !== 'string') throw badRequest('external_ref is required');
  if (!isValidDate(check_in) || !isValidDate(check_out)) throw badRequest('check_in and check_out must be YYYY-MM-DD');
  if (check_out <= check_in) throw badRequest('check_out must be after check_in');
  if (!Number.isInteger(rooms) || rooms < 1) throw badRequest('rooms must be a whole number ≥ 1');

  const mapping = db.prepare(
    'SELECT room_type_id FROM channel_room_mappings WHERE channel_id = ? AND external_room_id = ?'
  ).get(channel.id, room_id);
  if (!mapping) throw badRequest(`Room "${room_id}" is not mapped for ${channel.name}`);

  const existing = db.prepare('SELECT * FROM bookings WHERE channel_id = ? AND external_ref = ?')
    .get(channel.id, external_ref);
  if (existing) return { booking: existing, duplicate: true };

  const { booking } = applyReservation(db, channel, {
    external_ref, status: 'confirmed', guest_name, total: total == null ? null : Number(total),
    lines: [{ room_type_id: mapping.room_type_id, check_in, check_out, rooms }],
  });
  return { booking, duplicate: false };
}

/** Put the rooms of a cancelled booking back on sale everywhere. */
function cancelBooking(db, channelCode, externalRef) {
  const channel = getChannelByCode(db, channelCode);
  const booking = db.prepare('SELECT * FROM bookings WHERE channel_id = ? AND external_ref = ?')
    .get(channel.id, externalRef);
  if (!booking) throw notFound(`Booking ${externalRef} not found on ${channel.name}`);
  if (booking.status === 'cancelled') return { booking, duplicate: true };

  const result = applyReservation(db, channel, {
    ...booking, status: 'cancelled', lines: getLines(db, booking.id),
  });
  return { booking: result.booking, duplicate: false };
}

/**
 * A booking taken by phone or at the front desk. Unlike an OTA booking the
 * hotel can still say no, so it is refused when the rooms aren't free.
 */
function createDirectBooking(db, body) {
  const channel = getChannelByCode(db, 'direct');
  const { room_type_id: roomTypeId, check_in: checkIn, check_out: checkOut, guest_name: guest, notes } = body || {};
  const rooms = body?.rooms === undefined ? 1 : Number(body.rooms);
  const roomType = getRoomType(db, Number(roomTypeId));
  if (!roomType) throw badRequest('Choose a room type');
  if (!isValidDate(checkIn) || !isValidDate(checkOut)) throw badRequest('Enter check-in and check-out dates');
  if (checkOut <= checkIn) throw badRequest('Check-out must be after check-in');
  if (eachDate(checkIn, checkOut).length > 366) throw badRequest('Stays are limited to a year');
  if (!Number.isInteger(rooms) || rooms < 1) throw badRequest('Rooms must be a whole number ≥ 1');
  if (typeof guest !== 'string' || !guest.trim()) throw badRequest('Enter the guest name');
  const total = body.total === undefined || body.total === null || body.total === '' ? null : Number(body.total);
  if (total !== null && (!Number.isFinite(total) || total < 0)) throw badRequest('Total must be a positive number');

  return transaction(db, () => {
    ensureRows(db, roomType, nightsOf({ check_in: checkIn, check_out: checkOut }));
    const full = db.prepare(`
      SELECT date, available FROM inventory WHERE room_type_id = ? AND date >= ? AND date < ? AND available < ?
      ORDER BY date LIMIT 1
    `).get(roomType.id, checkIn, checkOut, rooms);
    if (full) {
      throw new HttpError(409, `Only ${Math.max(0, full.available)} ${roomType.name} left on ${full.date}`);
    }
    const { currency } = db.prepare('SELECT currency FROM property WHERE id = 1').get() || {};
    return applyReservation(db, channel, {
      external_ref: `DIR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
      status: 'confirmed',
      source: 'Direct',
      guest_name: guest.trim(),
      total,
      currency,
      notes: typeof notes === 'string' && notes.trim() ? notes.trim().slice(0, 1000) : null,
      lines: [{ room_type_id: roomType.id, check_in: checkIn, check_out: checkOut, rooms }],
    }, { stopSellCounts: false }).booking;
  });
}

function getBooking(db, id) {
  const booking = db.prepare(`
    SELECT b.*, c.code AS channel_code, c.kind AS channel_kind FROM bookings b JOIN channels c ON c.id = b.channel_id
    WHERE b.id = ?
  `).get(id);
  if (!booking) throw notFound('Booking not found');
  return booking;
}

/** Cancel a booking from the dashboard. OTA bookings must be cancelled on the OTA, which then tells us. */
function cancelBookingById(db, id) {
  const booking = getBooking(db, id);
  if (booking.channel_kind === 'channex') {
    throw badRequest(`Cancel this booking on ${booking.source || 'the OTA'}; the cancellation will come through automatically`);
  }
  return cancelBooking(db, booking.channel_code, booking.external_ref);
}

/** Staff have dealt with an overbooking / attention flag. */
function markHandled(db, id) {
  getBooking(db, id);
  db.prepare('UPDATE bookings SET handled_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  return getBooking(db, id);
}

const VIEWS = {
  upcoming: "b.status = 'confirmed' AND b.check_out >= :today",
  arrivals: "b.status = 'confirmed' AND b.check_in = :today",
  past: "b.status = 'confirmed' AND b.check_out < :today",
  cancelled: "b.status = 'cancelled'",
  attention: "b.status = 'confirmed' AND b.handled_at IS NULL AND (b.overbooked = 1 OR b.needs_attention IS NOT NULL) AND b.check_out >= :today",
  all: '1 = 1',
};

function listBookings(db, { view = 'all', q = '', limit = 200 } = {}) {
  const where = VIEWS[view];
  if (!where) throw badRequest(`view must be one of ${Object.keys(VIEWS).join(', ')}`);
  const search = String(q || '').trim().toLowerCase();
  const rows = db.prepare(`
    SELECT b.*, c.name AS channel_name, c.code AS channel_code, c.kind AS channel_kind
    FROM bookings b JOIN channels c ON c.id = b.channel_id
    WHERE ${where}
      AND (:q = '' OR lower(coalesce(b.guest_name, '')) LIKE :like OR lower(b.external_ref) LIKE :like
           OR lower(coalesce(b.source, '')) LIKE :like)
    ORDER BY ${view === 'upcoming' || view === 'arrivals' ? 'b.check_in ASC, b.id ASC' : 'b.updated_at DESC, b.id DESC'}
    LIMIT :limit
  `).all({ ...(where.includes(':today') ? { today: today() } : {}), q: search, like: `%${search}%`, limit });
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
  listBookings, getChannelByCode,
};
