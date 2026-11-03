const { transaction } = require('../../db');
const { applyReservation } = require('../../bookings');
const { isValidDate } = require('../../dates');

/**
 * Apply the current state of a Channex booking to our calendar. Used for
 * booking revisions from the feed and for bookings fetched when recovering
 * after an outage. `attrs` has the shape Channex uses for both: status,
 * arrival/departure, customer, rooms[], ota_name, ota_reservation_code, ...
 * Each call replaces whatever we held for that booking before.
 */
function applyBookingState(db, channel, bookingId, attrs) {
  const mapping = db.prepare(
    'SELECT room_type_id FROM channel_room_mappings WHERE channel_id = ? AND external_room_id = ?'
  );
  const planMapping = db.prepare(
    'SELECT rate_plan_id FROM channel_rate_plan_mappings WHERE channel_id = ? AND external_rate_plan_id = ?'
  );
  const lines = [];
  const problems = [];
  for (const room of attrs.rooms || []) {
    const m = room.room_type_id && mapping.get(channel.id, room.room_type_id);
    const checkIn = room.checkin_date || attrs.arrival_date;
    const checkOut = room.checkout_date || attrs.departure_date;
    if (!m) {
      problems.push(`room type ${room.room_type_id || '(unmapped on the OTA)'} is not mapped here`);
    } else if (!isValidDate(checkIn) || !isValidDate(checkOut) || checkOut <= checkIn) {
      problems.push(`invalid dates ${checkIn} → ${checkOut}`);
    } else {
      const plan = room.rate_plan_id ? planMapping.get(channel.id, room.rate_plan_id) : null;
      const occ = room.occupancy || {};
      lines.push({
        room_type_id: m.room_type_id,
        rate_plan_id: plan?.rate_plan_id ?? null,
        check_in: checkIn,
        check_out: checkOut,
        rooms: 1,
        adults: Number.isInteger(occ.adults) ? occ.adults : null,
        children: Number.isInteger(occ.children) ? occ.children : null,
      });
    }
  }
  if ((attrs.rooms || []).length === 0) problems.push('no rooms in booking');
  if (!isValidDate(attrs.arrival_date) || !isValidDate(attrs.departure_date)) {
    throw new Error(`Booking ${bookingId} has no valid arrival/departure dates`);
  }

  const customer = attrs.customer || {};
  const guest = [customer.name, customer.surname].filter(Boolean).join(' ') || null;

  return applyReservation(db, channel, {
    external_ref: bookingId,
    status: attrs.status === 'cancelled' ? 'cancelled' : 'confirmed',
    source: attrs.ota_name || null,
    ota_reference: attrs.ota_reservation_code || null,
    check_in: attrs.arrival_date,
    check_out: attrs.departure_date,
    guest_name: guest,
    guest_email: customer.mail || null,
    guest_phone: customer.phone || null,
    total: attrs.amount == null ? null : Number(attrs.amount),
    currency: attrs.currency || null,
    lines,
    needs_attention: problems.length && attrs.status !== 'cancelled'
      ? `Check this booking in Channex: ${problems.join('; ')}`
      : null,
  });
}

/**
 * Apply one Channex booking revision (new / modified / cancelled). Returns
 * false when this revision was already applied. Throws if it can't be
 * applied; the caller leaves it unacknowledged so Channex sends it again.
 */
function applyRevision(db, channel, revisionId, rev) {
  const seen = db.prepare('SELECT 1 FROM provider_revisions WHERE channel_id = ? AND revision_id = ?')
    .get(channel.id, revisionId);
  if (seen) return false;
  transaction(db, () => {
    applyBookingState(db, channel, rev.booking_id || revisionId, rev);
    db.prepare('INSERT INTO provider_revisions (channel_id, revision_id, processed_at) VALUES (?, ?, ?)')
      .run(channel.id, revisionId, new Date().toISOString());
    db.prepare('DELETE FROM provider_failures WHERE channel_id = ? AND revision_id = ?').run(channel.id, revisionId);
  });
  return true;
}

/** Remember a revision that failed, for the alert banner. */
function recordFailure(db, channel, revisionId, rev, error) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO provider_failures (channel_id, revision_id, booking_ref, error, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (channel_id, revision_id) DO UPDATE SET
      error = excluded.error, attempts = provider_failures.attempts + 1, last_seen_at = excluded.last_seen_at
  `).run(channel.id, revisionId, rev?.ota_reservation_code || rev?.booking_id || null, String(error.message || error).slice(0, 500), now, now);
}

module.exports = { applyRevision, applyBookingState, recordFailure };
