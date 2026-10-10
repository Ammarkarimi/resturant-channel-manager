const { transaction } = require('./db');
const { queueSync } = require('./queue');
const { isValidDate, addDays, eachDate, weekday } = require('./dates');
const { badRequest, notFound } = require('./errors');

const MAX_RANGE_DAYS = 730;

function getRoomType(db, id) {
  return db.prepare('SELECT * FROM room_types WHERE id = ?').get(id);
}

/** One night of one room type, falling back to defaults when never edited. */
function getCell(db, roomTypeId, date) {
  const row = db.prepare(
    'SELECT available, rate, stop_sell, min_stay FROM inventory WHERE room_type_id = ? AND date = ?'
  ).get(roomTypeId, date);
  if (row) return { date, ...row, stop_sell: Boolean(row.stop_sell) };
  const rt = getRoomType(db, roomTypeId);
  return { date, available: rt.total_rooms, rate: rt.base_rate, stop_sell: false, min_stay: 1 };
}

/** Materialise default rows so they can be updated in place. */
function ensureRows(db, roomType, dates) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO inventory (room_type_id, date, available, rate, stop_sell, min_stay, updated_at)
    VALUES (?, ?, ?, ?, 0, 1, ?)
  `);
  const now = new Date().toISOString();
  for (const d of dates) stmt.run(roomType.id, d, roomType.total_rooms, roomType.base_rate, now);
}

function getGrid(db, start, days) {
  if (!isValidDate(start)) throw badRequest('start must be a YYYY-MM-DD date');
  if (!Number.isInteger(days) || days < 1 || days > 62) throw badRequest('days must be between 1 and 62');
  const dates = eachDate(start, addDays(start, days - 1));
  const roomTypes = db.prepare('SELECT * FROM room_types ORDER BY id').all();
  return {
    dates,
    room_types: roomTypes.map((rt) => ({
      ...rt,
      cells: dates.map((d) => getCell(db, rt.id, d)),
    })),
  };
}

function validateSet(set, roomTypes) {
  if (!set || typeof set !== 'object') throw badRequest('set is required');
  const out = {};
  if (set.rate !== undefined && set.rate !== null && set.rate !== '') {
    const rate = Number(set.rate);
    if (!Number.isFinite(rate) || rate <= 0) throw badRequest('rate must be a positive number');
    out.rate = rate;
  }
  if (set.available !== undefined && set.available !== null && set.available !== '') {
    const available = Number(set.available);
    if (!Number.isInteger(available) || available < 0) throw badRequest('available must be a whole number ≥ 0');
    const tooMany = roomTypes.find((rt) => available > rt.total_rooms);
    if (tooMany) throw badRequest(`${tooMany.name} only has ${tooMany.total_rooms} rooms`);
    out.available = available;
  }
  if (set.min_stay !== undefined && set.min_stay !== null && set.min_stay !== '') {
    const minStay = Number(set.min_stay);
    if (!Number.isInteger(minStay) || minStay < 1 || minStay > 30) throw badRequest('min_stay must be between 1 and 30');
    out.min_stay = minStay;
  }
  if (set.stop_sell !== undefined && set.stop_sell !== null) {
    if (typeof set.stop_sell !== 'boolean') throw badRequest('stop_sell must be true or false');
    out.stop_sell = set.stop_sell ? 1 : 0;
  }
  if (Object.keys(out).length === 0) throw badRequest('Nothing to change: give a rate, availability, min stay or stop sell');
  return out;
}

/**
 * The "one click" update: apply the same change to many room types and dates,
 * then queue it for every connected channel.
 */
function bulkUpdate(db, { room_type_ids, start_date, end_date, weekdays, set }) {
  if (!Array.isArray(room_type_ids) || room_type_ids.length === 0) throw badRequest('Pick at least one room type');
  if (!isValidDate(start_date) || !isValidDate(end_date)) throw badRequest('Dates must be YYYY-MM-DD');
  if (end_date < start_date) throw badRequest('end_date is before start_date');
  if (eachDate(start_date, end_date).length > MAX_RANGE_DAYS) throw badRequest(`Range is limited to ${MAX_RANGE_DAYS} days`);
  if (weekdays !== undefined && weekdays !== null) {
    if (!Array.isArray(weekdays) || weekdays.some((w) => !Number.isInteger(w) || w < 0 || w > 6)) {
      throw badRequest('weekdays must be a list of numbers 0 (Sun) to 6 (Sat)');
    }
  }

  const roomTypes = room_type_ids.map((id) => {
    const rt = getRoomType(db, id);
    if (!rt) throw notFound(`Room type ${id} not found`);
    return rt;
  });
  const changes = validateSet(set, roomTypes);
  const dates = eachDate(start_date, end_date)
    .filter((d) => !weekdays || weekdays.length === 0 || weekdays.includes(weekday(d)));
  if (dates.length === 0) throw badRequest('No dates in range match the selected weekdays');

  const cols = Object.keys(changes);
  const update = db.prepare(`
    UPDATE inventory SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ?
    WHERE room_type_id = ? AND date = ?
  `);

  return transaction(db, () => {
    const now = new Date().toISOString();
    for (const rt of roomTypes) {
      ensureRows(db, rt, dates);
      for (const d of dates) update.run(...cols.map((c) => changes[c]), now, rt.id, d);
      queueSync(db, rt.id, dates);
    }
    return { room_types: roomTypes.length, dates: dates.length, cells: roomTypes.length * dates.length };
  });
}

module.exports = { getCell, getGrid, ensureRows, bulkUpdate, getRoomType };
