const { transaction } = require('../../db');
const { applyReservation } = require('../../bookings');
const { isValidDate } = require('../../dates');

/**
 * Apply one Channex booking revision (new / modified / cancelled) to our
 * calendar. Each revision carries the full current state of the booking, so
 * it simply replaces whatever we held for that booking before.
 *
 * Returns false when this revision was already applied.
 */
function applyRevision(db, channel, revisionId, rev) {
  const seen = db.prepare('SELECT 1 FROM provider_revisions WHERE channel_id = ? AND revision_id = ?')
    .get(channel.id, revisionId);
  if (seen) return false;

  const mapping = db.prepare(
    'SELECT room_type_id FROM channel_room_mappings WHERE channel_id = ? AND external_room_id = ?'
  );
  const planMapping = db.prepare(
    'SELECT rate_plan_id FROM channel_rate_plan_mappings WHERE channel_id = ? AND external_rate_plan_id = ?'
  );
  const lines = [];
  const problems = [];
  for (const room of rev.rooms || []) {
    const m = room.room_type_id && mapping.get(channel.id, room.room_type_id);
    const checkIn = room.checkin_date || rev.arrival_date;
    const checkOut = room.checkout_date || rev.departure_date;
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
  if ((rev.rooms || []).length === 0) problems.push('no rooms in booking');

  const customer = rev.customer || {};
  const guest = [customer.name, customer.surname].filter(Boolean).join(' ') || null;

  transaction(db, () => {
    applyReservation(db, channel, {
      external_ref: rev.booking_id || revisionId,
      status: rev.status === 'cancelled' ? 'cancelled' : 'confirmed',
      source: rev.ota_name || null,
      check_in: rev.arrival_date,
      check_out: rev.departure_date,
      guest_name: guest,
      guest_email: customer.mail || null,
      guest_phone: customer.phone || null,
      total: rev.amount == null ? null : Number(rev.amount),
      currency: rev.currency || null,
      lines,
      needs_attention: problems.length && rev.status !== 'cancelled'
        ? `Check this booking in Channex: ${problems.join('; ')}`
        : null,
    });
    db.prepare('INSERT INTO provider_revisions (channel_id, revision_id, processed_at) VALUES (?, ?, ?)')
      .run(channel.id, revisionId, new Date().toISOString());
  });
  return true;
}

module.exports = { applyRevision };
