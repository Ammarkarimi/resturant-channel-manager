const { transaction } = require('./db');
const { queueSync } = require('./queue');
const { ensureRows, getRoomType } = require('./inventory');
const { isValidDate, addDays, eachDate } = require('./dates');
const { badRequest, notFound } = require('./errors');

function getChannelByCode(db, code) {
  const channel = db.prepare('SELECT * FROM channels WHERE code = ?').get(code);
  if (!channel) throw notFound(`Unknown channel "${code}"`);
  return channel;
}

const nightsOf = (b) => eachDate(b.check_in, addDays(b.check_out, -1));

/**
 * A booking arrived from an OTA. Take the rooms out of the shared pool and
 * push the new availability to every channel so nobody else can sell them.
 * Re-sending the same booking reference is a no-op.
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

  const roomType = getRoomType(db, mapping.room_type_id);
  const nights = nightsOf({ check_in, check_out });

  return transaction(db, () => {
    ensureRows(db, roomType, nights);
    // The OTA has already confirmed the guest, so we can't refuse. Record it
    // and flag it so the hotel can relocate the guest.
    const short = db.prepare(`
      SELECT COUNT(*) AS n FROM inventory
      WHERE room_type_id = ? AND date >= ? AND date < ? AND (available < ? OR stop_sell = 1)
    `).get(roomType.id, check_in, check_out, rooms).n;

    db.prepare(`
      UPDATE inventory SET available = available - ?, updated_at = ?
      WHERE room_type_id = ? AND date >= ? AND date < ?
    `).run(rooms, new Date().toISOString(), roomType.id, check_in, check_out);

    const id = db.prepare(`
      INSERT INTO bookings (channel_id, external_ref, room_type_id, check_in, check_out, rooms,
                            guest_name, total, overbooked, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(channel.id, external_ref, roomType.id, check_in, check_out, rooms,
      guest_name ?? null, total == null ? null : Number(total), short > 0 ? 1 : 0,
      new Date().toISOString()).lastInsertRowid;

    queueSync(db, roomType.id, nights);
    return { booking: db.prepare('SELECT * FROM bookings WHERE id = ?').get(id), duplicate: false };
  });
}

/** Put the rooms of a cancelled booking back on sale everywhere. */
function cancelBooking(db, channelCode, externalRef) {
  const channel = getChannelByCode(db, channelCode);
  const booking = db.prepare('SELECT * FROM bookings WHERE channel_id = ? AND external_ref = ?')
    .get(channel.id, externalRef);
  if (!booking) throw notFound(`Booking ${externalRef} not found on ${channel.name}`);
  if (booking.status === 'cancelled') return { booking, duplicate: true };

  return transaction(db, () => {
    db.prepare(`
      UPDATE inventory SET available = available + ?, updated_at = ?
      WHERE room_type_id = ? AND date >= ? AND date < ?
    `).run(booking.rooms, new Date().toISOString(), booking.room_type_id, booking.check_in, booking.check_out);
    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(booking.id);
    queueSync(db, booking.room_type_id, nightsOf(booking));
    return { booking: db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id), duplicate: false };
  });
}

function listBookings(db, limit = 50) {
  return db.prepare(`
    SELECT b.*, c.name AS channel_name, c.code AS channel_code, r.name AS room_type_name
    FROM bookings b JOIN channels c ON c.id = b.channel_id JOIN room_types r ON r.id = b.room_type_id
    ORDER BY b.id DESC LIMIT ?
  `).all(limit);
}

module.exports = { receiveBooking, cancelBooking, listBookings, getChannelByCode };
