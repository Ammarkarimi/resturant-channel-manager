const { transaction } = require('./db');
const { queueRoomTypeResync } = require('./queue');
const { today } = require('./dates');
const { badRequest, notFound, HttpError } = require('./errors');

const CODE_RE = /^[A-Z0-9]{2,10}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

function getProperty(db) {
  return db.prepare('SELECT name, currency FROM property WHERE id = 1').get() || null;
}

function validateProperty({ name, currency }) {
  if (typeof name !== 'string' || !name.trim() || name.length > 120) throw badRequest('Enter the hotel name');
  const cur = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  if (!CURRENCY_RE.test(cur)) throw badRequest('Currency must be a 3-letter code such as INR or USD');
  return { name: name.trim(), currency: cur };
}

function saveProperty(db, input) {
  const { name, currency } = validateProperty(input);
  db.prepare(`INSERT INTO property (id, name, currency) VALUES (1, ?, ?)
              ON CONFLICT (id) DO UPDATE SET name = excluded.name, currency = excluded.currency`).run(name, currency);
  return getProperty(db);
}

function listRoomTypes(db) {
  return db.prepare(`
    SELECT r.*,
      (SELECT COUNT(*) FROM booking_lines l JOIN bookings b ON b.id = l.booking_id
        WHERE l.room_type_id = r.id AND b.status = 'confirmed' AND l.check_out > ?) AS upcoming_bookings
    FROM room_types r ORDER BY r.id
  `).all(today());
}

function validateRoomFields(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw badRequest('Enter a room type name');
    out.name = input.name.trim();
  }
  if (!partial || input.total_rooms !== undefined) {
    const n = Number(input.total_rooms);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw badRequest('Number of rooms must be a whole number from 1 to 1000');
    out.total_rooms = n;
  }
  if (!partial || input.base_rate !== undefined) {
    const r = Number(input.base_rate);
    if (!Number.isFinite(r) || r <= 0) throw badRequest('Base rate must be a positive number');
    out.base_rate = r;
  }
  return out;
}

/**
 * Add a room type. The demo OTAs pick it up straight away; a provider such as
 * Channex needs it mapped to one of its room types first.
 */
function createRoomType(db, input) {
  const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
  if (!CODE_RE.test(code)) throw badRequest('Code must be 2–10 letters or digits, e.g. DLX');
  const fields = validateRoomFields(input);
  return transaction(db, () => {
    if (db.prepare('SELECT 1 FROM room_types WHERE code = ?').get(code)) throw badRequest(`Code ${code} is already used`);
    const id = Number(db.prepare('INSERT INTO room_types (code, name, total_rooms, base_rate) VALUES (?, ?, ?, ?)')
      .run(code, fields.name, fields.total_rooms, fields.base_rate).lastInsertRowid);

    const demo = db.prepare("SELECT id, code FROM channels WHERE kind = 'simulated'").all();
    const sample = db.prepare('SELECT external_room_id FROM channel_room_mappings WHERE channel_id = ? LIMIT 1');
    const ins = db.prepare('INSERT OR IGNORE INTO channel_room_mappings (channel_id, room_type_id, external_room_id) VALUES (?, ?, ?)');
    for (const c of demo) {
      const prefix = sample.get(c.id)?.external_room_id.split('-')[0] || c.code.toUpperCase();
      ins.run(c.id, id, `${prefix}-${code}`);
    }
    queueRoomTypeResync(db, id);
    return db.prepare('SELECT * FROM room_types WHERE id = ?').get(id);
  });
}

/**
 * Change a room type. Adding or removing physical rooms shifts the rooms
 * left to sell on every future night by the same amount.
 */
function updateRoomType(db, id, input) {
  const rt = db.prepare('SELECT * FROM room_types WHERE id = ?').get(id);
  if (!rt) throw notFound('Room type not found');
  const fields = validateRoomFields(input, { partial: true });
  if (Object.keys(fields).length === 0) throw badRequest('Nothing to change');

  return transaction(db, () => {
    const delta = fields.total_rooms === undefined ? 0 : fields.total_rooms - rt.total_rooms;
    if (delta < 0) {
      const tight = db.prepare('SELECT MIN(available) AS m FROM inventory WHERE room_type_id = ? AND date >= ?').get(id, today()).m;
      if (tight != null && tight + delta < 0) {
        throw new HttpError(409, `Can't remove ${-delta} room(s): some upcoming nights only have ${tight} unsold`);
      }
    }
    const cols = Object.keys(fields);
    db.prepare(`UPDATE room_types SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map((c) => fields[c]), id);
    if (delta !== 0) {
      db.prepare('UPDATE inventory SET available = available + ?, updated_at = ? WHERE room_type_id = ? AND date >= ?')
        .run(delta, new Date().toISOString(), id, today());
    }
    // Room count and base rate are the defaults for nights never edited, so
    // every future night may now look different to the channels.
    if (delta !== 0 || (fields.base_rate !== undefined && fields.base_rate !== rt.base_rate)) queueRoomTypeResync(db, id);
    return db.prepare('SELECT * FROM room_types WHERE id = ?').get(id);
  });
}

function deleteRoomType(db, id) {
  const rt = db.prepare('SELECT * FROM room_types WHERE id = ?').get(id);
  if (!rt) throw notFound('Room type not found');
  if (db.prepare('SELECT 1 FROM booking_lines WHERE room_type_id = ? LIMIT 1').get(id)) {
    throw new HttpError(409, `${rt.name} has bookings, so it can't be deleted. Set it to stop sell instead.`);
  }
  transaction(db, () => {
    db.prepare(`DELETE FROM channel_listings WHERE (channel_id, external_room_id) IN
                (SELECT channel_id, external_room_id FROM channel_room_mappings WHERE room_type_id = ?)`).run(id);
    for (const t of ['sync_queue', 'channel_room_mappings', 'inventory']) {
      db.prepare(`DELETE FROM ${t} WHERE room_type_id = ?`).run(id);
    }
    db.prepare('DELETE FROM room_types WHERE id = ?').run(id);
  });
  return rt;
}

module.exports = {
  getProperty, saveProperty, validateProperty, listRoomTypes, createRoomType, updateRoomType, deleteRoomType,
};
