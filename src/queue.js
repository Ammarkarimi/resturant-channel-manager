const { addDays, eachDate, today } = require('./dates');

const RESYNC_HORIZON_DAYS = 180;
// Channex expects a full sync to cover 500 days.
const HORIZON_BY_KIND = { channex: 500 };

/**
 * Mark room-nights as needing a push to every enabled channel that sells the
 * room type (or only `channelId` when given). Bumping `version` lets the
 * worker tell whether a night changed again while its push was in flight.
 */
function queueSync(db, roomTypeId, dates, channelId = null) {
  const stmt = db.prepare(`
    INSERT INTO sync_queue (channel_id, room_type_id, date, next_attempt_at)
    SELECT c.id, m.room_type_id, ?, ?
    FROM channels c
    JOIN channel_room_mappings m ON m.channel_id = c.id AND m.room_type_id = ?
    WHERE c.enabled = 1 AND (? IS NULL OR c.id = ?)
    ON CONFLICT (channel_id, room_type_id, date) DO UPDATE SET
      status = 'pending', attempts = 0, last_error = NULL,
      next_attempt_at = excluded.next_attempt_at,
      version = sync_queue.version + 1
  `);
  const now = new Date().toISOString();
  for (const date of dates) stmt.run(date, now, roomTypeId, channelId, channelId);
}

function horizonDates(kind) {
  const days = HORIZON_BY_KIND[kind] || RESYNC_HORIZON_DAYS;
  return eachDate(today(), addDays(today(), days - 1));
}

/** Push the next N days of every room type to one channel (used when a channel is (re)connected or its pricing changes). */
function queueFullResync(db, channelId) {
  const channel = db.prepare('SELECT kind, property_id FROM channels WHERE id = ?').get(channelId);
  const dates = horizonDates(channel.kind);
  for (const { id } of db.prepare('SELECT id FROM room_types WHERE property_id = ?').all(channel.property_id)) {
    queueSync(db, id, dates, channelId);
  }
}

/** Push the next N days of one room type to every channel that sells it (e.g. its room count or default prices changed). */
function queueRoomTypeResync(db, roomTypeId, { from = today(), to = null } = {}) {
  const channels = db.prepare(`
    SELECT c.id, c.kind FROM channels c
    JOIN channel_room_mappings m ON m.channel_id = c.id AND m.room_type_id = ?
    WHERE c.enabled = 1
  `).all(roomTypeId);
  for (const c of channels) {
    const dates = horizonDates(c.kind).filter((d) => d >= from && (!to || d <= to));
    queueSync(db, roomTypeId, dates, c.id);
  }
}

/** Every room type of a property, e.g. after its yield rules changed. */
function queuePropertyResync(db, propertyId) {
  for (const { id } of db.prepare('SELECT id FROM room_types WHERE property_id = ?').all(propertyId)) queueRoomTypeResync(db, id);
}

module.exports = { queueSync, queueFullResync, queueRoomTypeResync, queuePropertyResync, RESYNC_HORIZON_DAYS };
