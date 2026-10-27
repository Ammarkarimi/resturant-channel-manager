const { transaction } = require('./db');
const { queueSync } = require('./queue');
const { Pricer, PRICE_FIELDS } = require('./pricing');
const { isValidDate, addDays, eachDate, weekday } = require('./dates');
const { badRequest, notFound } = require('./errors');

const MAX_RANGE_DAYS = 730;

function getRoomType(db, propertyId, id) {
  return db.prepare('SELECT * FROM room_types WHERE id = ? AND property_id = ?').get(id, propertyId);
}

function roomTypesOf(db, propertyId) {
  return db.prepare('SELECT * FROM room_types WHERE property_id = ? ORDER BY position, id').all(propertyId);
}

function plansOf(db, roomTypeId) {
  return db.prepare('SELECT * FROM rate_plans WHERE room_type_id = ? ORDER BY position, id').all(roomTypeId);
}

/** Rooms left and room-level close for one night; defaults when never edited. */
function roomCell(db, roomType, date) {
  const row = db.prepare('SELECT available, stop_sell FROM room_inventory WHERE room_type_id = ? AND date = ?')
    .get(roomType.id, date);
  return { available: row ? row.available : roomType.total_rooms, stop_sell: Boolean(row?.stop_sell) };
}

/** Materialise default rows so they can be updated in place. */
function ensureRoomRows(db, roomType, dates) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO room_inventory (room_type_id, date, available, stop_sell, updated_at)
                           VALUES (?, ?, ?, 0, ?)`);
  const now = new Date().toISOString();
  for (const d of dates) stmt.run(roomType.id, d, roomType.total_rooms, now);
}

function ensurePlanRows(db, planId, dates) {
  const stmt = db.prepare('INSERT OR IGNORE INTO rate_calendar (rate_plan_id, date, updated_at) VALUES (?, ?, ?)');
  const now = new Date().toISOString();
  for (const d of dates) stmt.run(planId, d, now);
}

/** Room types whose plans (directly or through derived plans) depend on any of these plans. */
function dependentRoomTypes(db, planIds) {
  const seen = new Set(planIds);
  const rooms = new Set();
  let frontier = [...planIds];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      const plan = db.prepare('SELECT room_type_id FROM rate_plans WHERE id = ?').get(id);
      if (plan) rooms.add(plan.room_type_id);
      for (const child of db.prepare('SELECT id FROM rate_plans WHERE parent_id = ?').all(id)) {
        if (!seen.has(child.id)) { seen.add(child.id); next.push(child.id); }
      }
    }
    frontier = next;
  }
  return [...rooms];
}

function describeDerivation(db, plan) {
  if (!plan.parent_id) return null;
  const parent = db.prepare('SELECT name, code FROM rate_plans WHERE id = ?').get(plan.parent_id);
  const v = plan.derive_value;
  const amount = plan.derive_type === 'percent' ? `${v >= 0 ? '+' : ''}${v}%` : `${v >= 0 ? '+' : ''}${v}`;
  return `${parent?.name ?? 'parent'} ${amount}`;
}

/** The calendar: per room type, rooms left; per rate plan, prices and restrictions. */
function getGrid(db, propertyId, start, days) {
  if (!isValidDate(start)) throw badRequest('start must be a YYYY-MM-DD date');
  if (!Number.isInteger(days) || days < 1 || days > 62) throw badRequest('days must be between 1 and 62');
  const dates = eachDate(start, addDays(start, days - 1));
  const pricer = new Pricer(db);
  const channels = db.prepare(`SELECT id, code, name FROM channels WHERE property_id = ? AND kind != 'direct' ORDER BY id`).all(propertyId);
  const blocked = db.prepare(`
    SELECT c.code FROM channel_blocks b JOIN channels c ON c.id = b.channel_id WHERE b.room_type_id = ? AND b.date = ?`);

  return {
    dates,
    channels,
    room_types: roomTypesOf(db, propertyId).map((rt) => ({
      ...rt,
      cells: dates.map((d) => {
        const occ = pricer.occupancy(rt.id, rt.total_rooms, d);
        return {
          date: d,
          ...roomCell(db, rt, d),
          sold: occ.sold,
          occupancy_pct: occ.pct,
          blocked_channels: blocked.all(rt.id, d).map((b) => b.code),
        };
      }),
      rate_plans: plansOf(db, rt.id).map((plan) => {
        const full = pricer.plan(plan.id);
        return {
          id: plan.id,
          code: plan.code,
          name: plan.name,
          meal_plan: plan.meal_plan,
          active: Boolean(plan.active),
          derived: Boolean(plan.parent_id),
          derived_from: describeDerivation(db, plan),
          cells: dates.map((d) => ({
            date: d,
            ...pricer.prices(full, d),
            own_price: !plan.parent_id && pricer.hasOwnPrice(plan.id, d),
            ...pricer.restrictions(plan.id, d),
          })),
        };
      }),
    })),
  };
}

const present = (v) => v !== undefined && v !== null && v !== '';

function num(v, name, { min = 0, integer = false, max = Infinity, exclusiveMin = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n > max || (exclusiveMin ? n <= min : n < min)) {
    throw badRequest(`${name} must be ${integer ? 'a whole number' : 'a number'}${exclusiveMin ? ` above ${min}` : ` of at least ${min}`}${max < Infinity ? ` and at most ${max}` : ''}`);
  }
  return n;
}

function bool(v, name) {
  if (typeof v !== 'boolean') throw badRequest(`${name} must be true or false`);
  return v ? 1 : 0;
}

/** Split `set` into room-level and plan-level changes, validated. */
function validateSet(set, roomTypes) {
  if (!set || typeof set !== 'object') throw badRequest('set is required');
  const room = {};
  const plan = {};
  if (present(set.available)) {
    room.available = num(set.available, 'Rooms available', { integer: true });
    const tooMany = roomTypes.find((rt) => room.available > rt.total_rooms);
    if (tooMany) throw badRequest(`${tooMany.name} only has ${tooMany.total_rooms} rooms`);
  }
  if (set.stop_sell !== undefined && set.stop_sell !== null) room.stop_sell = bool(set.stop_sell, 'stop_sell');

  // `rate` is the main (double occupancy) price, kept for convenience.
  const prices = { ...set, rate_double: present(set.rate_double) ? set.rate_double : set.rate };
  for (const f of PRICE_FIELDS) {
    if (present(prices[f])) plan[f] = num(prices[f], f.replace('_', ' '), { exclusiveMin: !f.startsWith('extra') });
  }
  if (set.reset_rates === true) for (const f of PRICE_FIELDS) plan[f] = null;
  if (set.plan_stop_sell !== undefined && set.plan_stop_sell !== null) plan.stop_sell = bool(set.plan_stop_sell, 'plan_stop_sell');
  if (set.cta !== undefined && set.cta !== null) plan.cta = bool(set.cta, 'cta');
  if (set.ctd !== undefined && set.ctd !== null) plan.ctd = bool(set.ctd, 'ctd');
  if (present(set.min_stay)) plan.min_stay = num(set.min_stay, 'Minimum stay', { min: 1, max: 30, integer: true });
  if (present(set.max_stay)) {
    // 0 removes the maximum.
    const m = num(set.max_stay, 'Maximum stay', { min: 0, max: 90, integer: true });
    plan.max_stay = m === 0 ? null : m;
  }
  if (plan.min_stay && plan.max_stay && plan.max_stay < plan.min_stay) throw badRequest('Maximum stay is shorter than minimum stay');
  if (Object.keys(room).length === 0 && Object.keys(plan).length === 0) {
    throw badRequest('Nothing to change: give a rate, availability, a restriction or stop sell');
  }
  return { room, plan };
}

function validateRange({ start_date: start, end_date: end, weekdays }) {
  if (!isValidDate(start) || !isValidDate(end)) throw badRequest('Dates must be YYYY-MM-DD');
  if (end < start) throw badRequest('end_date is before start_date');
  if (eachDate(start, end).length > MAX_RANGE_DAYS) throw badRequest(`Range is limited to ${MAX_RANGE_DAYS} days`);
  if (weekdays !== undefined && weekdays !== null) {
    if (!Array.isArray(weekdays) || weekdays.some((w) => !Number.isInteger(w) || w < 0 || w > 6)) {
      throw badRequest('weekdays must be a list of numbers 0 (Sun) to 6 (Sat)');
    }
  }
  const dates = eachDate(start, end).filter((d) => !weekdays || weekdays.length === 0 || weekdays.includes(weekday(d)));
  if (dates.length === 0) throw badRequest('No dates in range match the selected weekdays');
  return dates;
}

function selectRoomTypes(db, propertyId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw badRequest('Pick at least one room type');
  return ids.map((id) => {
    const rt = getRoomType(db, propertyId, id);
    if (!rt) throw notFound(`Room type ${id} not found`);
    return rt;
  });
}

/**
 * The "one click" update: apply the same change to many room types, rate
 * plans and dates, then queue it for every connected channel.
 *
 * Room-level fields (available, stop_sell) go to the room types; price and
 * restriction fields go to the chosen rate plans (default: all plans of the
 * chosen room types). Derived plans follow their parent's prices, so they
 * only take restrictions.
 */
function bulkUpdate(db, propertyId, body) {
  const roomTypes = selectRoomTypes(db, propertyId, body.room_type_ids);
  const dates = validateRange(body);
  const { room, plan } = validateSet(body.set, roomTypes);

  let plans = roomTypes.flatMap((rt) => plansOf(db, rt.id));
  if (Array.isArray(body.rate_plan_ids) && body.rate_plan_ids.length) {
    const wanted = new Set(body.rate_plan_ids.map(Number));
    const all = db.prepare(`SELECT rp.* FROM rate_plans rp JOIN room_types rt ON rt.id = rp.room_type_id WHERE rt.property_id = ?`).all(propertyId);
    for (const id of wanted) if (!all.some((p) => p.id === id)) throw notFound(`Rate plan ${id} not found`);
    plans = all.filter((p) => wanted.has(p.id));
  }
  const priceChange = PRICE_FIELDS.some((f) => f in plan);
  if (priceChange && plans.length && plans.every((p) => p.parent_id)) {
    throw badRequest("Derived rate plans follow their parent's prices; change the parent plan instead");
  }
  if (Object.keys(plan).length && plans.length === 0) throw badRequest('The chosen room types have no rate plans yet');

  return transaction(db, () => {
    const now = new Date().toISOString();
    const roomCols = Object.keys(room);
    if (roomCols.length) {
      const upd = db.prepare(`UPDATE room_inventory SET ${roomCols.map((c) => `${c} = ?`).join(', ')}, updated_at = ?
                              WHERE room_type_id = ? AND date = ?`);
      for (const rt of roomTypes) {
        ensureRoomRows(db, rt, dates);
        for (const d of dates) upd.run(...roomCols.map((c) => room[c]), now, rt.id, d);
      }
    }
    let planCells = 0;
    const touchedPlans = [];
    for (const p of plans) {
      const cols = Object.keys(plan).filter((c) => !(p.parent_id && PRICE_FIELDS.includes(c)));
      if (cols.length === 0) continue;
      const upd = db.prepare(`UPDATE rate_calendar SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ?
                              WHERE rate_plan_id = ? AND date = ?`);
      ensurePlanRows(db, p.id, dates);
      for (const d of dates) upd.run(...cols.map((c) => plan[c]), now, p.id, d);
      planCells += dates.length;
      touchedPlans.push(p.id);
    }
    const rooms = new Set([...roomTypes.map((rt) => rt.id), ...dependentRoomTypes(db, touchedPlans)]);
    for (const id of rooms) queueSync(db, id, dates);
    return {
      room_types: roomTypes.length,
      rate_plans: touchedPlans.length,
      dates: dates.length,
      cells: roomCols.length ? roomTypes.length * dates.length + planCells : planCells,
    };
  });
}

/** Close (or reopen) rooms on selected channels only, e.g. stop selling Suites on Agoda this weekend. */
function setChannelBlocks(db, propertyId, body) {
  const roomTypes = selectRoomTypes(db, propertyId, body.room_type_ids);
  const dates = validateRange(body);
  if (!Array.isArray(body.channel_codes) || body.channel_codes.length === 0) throw badRequest('Pick at least one channel');
  const channels = body.channel_codes.map((code) => {
    const c = db.prepare("SELECT * FROM channels WHERE property_id = ? AND code = ? AND kind != 'direct'").get(propertyId, code);
    if (!c) throw notFound(`Channel ${code} not found`);
    return c;
  });
  const blocked = bool(body.blocked, 'blocked');
  return transaction(db, () => {
    const ins = db.prepare('INSERT OR IGNORE INTO channel_blocks (channel_id, room_type_id, date) VALUES (?, ?, ?)');
    const del = db.prepare('DELETE FROM channel_blocks WHERE channel_id = ? AND room_type_id = ? AND date = ?');
    for (const c of channels) {
      for (const rt of roomTypes) {
        for (const d of dates) (blocked ? ins : del).run(c.id, rt.id, d);
        queueSync(db, rt.id, dates, c.id);
      }
    }
    return { channels: channels.map((c) => c.name), room_types: roomTypes.length, dates: dates.length };
  });
}

module.exports = {
  getRoomType, roomTypesOf, plansOf, roomCell, ensureRoomRows, ensurePlanRows, dependentRoomTypes,
  getGrid, bulkUpdate, setChannelBlocks, validateRange,
};
