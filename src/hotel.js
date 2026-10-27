const { transaction, createProperty } = require('./db');
const { queueRoomTypeResync, queuePropertyResync } = require('./queue');
const { roomTypesOf, plansOf, dependentRoomTypes } = require('./inventory');
const { today } = require('./dates');
const { badRequest, notFound, HttpError } = require('./errors');

const CODE_RE = /^[A-Z0-9]{2,10}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const MEAL_PLANS = ['EP', 'CP', 'MAP', 'AP', 'OTHER'];

// ---------- Properties ----------

function getProperty(db, id) {
  return db.prepare('SELECT id, name, currency, city, country FROM properties WHERE id = ?').get(id) || null;
}

function validateProperty({ name, currency, city, country }) {
  if (typeof name !== 'string' || !name.trim() || name.length > 120) throw badRequest('Enter the hotel name');
  const cur = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  if (!CURRENCY_RE.test(cur)) throw badRequest('Currency must be a 3-letter code such as INR or USD');
  const text = (v, label) => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || v.length > 80) throw badRequest(`${label} is too long`);
    return v.trim();
  };
  return { name: name.trim(), currency: cur, city: text(city, 'City'), country: text(country, 'Country') };
}

function addProperty(db, input) {
  const p = validateProperty(input);
  return getProperty(db, createProperty(db, p));
}

function updateProperty(db, id, input) {
  const before = getProperty(db, id);
  if (!before) throw notFound('Property not found');
  const p = validateProperty({ ...before, ...input });
  db.prepare('UPDATE properties SET name = ?, currency = ?, city = ?, country = ? WHERE id = ?')
    .run(p.name, p.currency, p.city, p.country, id);
  return getProperty(db, id);
}

// ---------- Room types ----------

function listRoomTypes(db, propertyId) {
  const upcoming = db.prepare(`
    SELECT COUNT(DISTINCT b.id) AS n FROM booking_lines l JOIN bookings b ON b.id = l.booking_id
    WHERE l.room_type_id = ? AND b.status = 'confirmed' AND l.check_out > ?`);
  return roomTypesOf(db, propertyId).map((rt) => ({
    ...rt,
    upcoming_bookings: upcoming.get(rt.id, today()).n,
    rate_plans: plansOf(db, rt.id).map((p) => ({ ...p, active: Boolean(p.active) })),
  }));
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
  for (const [key, label, max] of [['max_adults', 'Maximum adults', 20], ['max_children', 'Maximum children', 20]]) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== '') {
      const n = Number(input[key]);
      if (!Number.isInteger(n) || n < 0 || n > max || (key === 'max_adults' && n < 1)) throw badRequest(`${label} must be a whole number up to ${max}`);
      out[key] = n;
    }
  }
  return out;
}

/** Prefix the demo OTAs use for their room ids (e.g. "AGD"). */
function demoPrefix(db, channel) {
  const sample = db.prepare('SELECT external_room_id FROM channel_room_mappings WHERE channel_id = ? LIMIT 1').get(channel.id);
  return sample?.external_room_id.split('-')[0] || channel.code.toUpperCase();
}

/**
 * Add a room type. With a base_rate, a "Room only" plan is created too. The
 * demo OTAs pick it up straight away; a provider such as Channex needs it
 * mapped to one of its room types first.
 */
function createRoomType(db, propertyId, input) {
  const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
  if (!CODE_RE.test(code)) throw badRequest('Code must be 2–10 letters or digits, e.g. DLX');
  const fields = validateRoomFields(input);
  const baseRate = input.base_rate === undefined || input.base_rate === null || input.base_rate === '' ? null : Number(input.base_rate);
  if (baseRate !== null && (!Number.isFinite(baseRate) || baseRate <= 0)) throw badRequest('Base rate must be a positive number');

  return transaction(db, () => {
    if (db.prepare('SELECT 1 FROM room_types WHERE property_id = ? AND code = ?').get(propertyId, code)) {
      throw badRequest(`Code ${code} is already used`);
    }
    const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM room_types WHERE property_id = ?').get(propertyId).p;
    const id = Number(db.prepare(`
      INSERT INTO room_types (property_id, code, name, total_rooms, max_adults, max_children, position)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(propertyId, code, fields.name, fields.total_rooms,
      fields.max_adults ?? 2, fields.max_children ?? 1, position).lastInsertRowid);

    const ins = db.prepare('INSERT OR IGNORE INTO channel_room_mappings (channel_id, room_type_id, external_room_id) VALUES (?, ?, ?)');
    for (const c of db.prepare("SELECT * FROM channels WHERE property_id = ? AND kind = 'simulated'").all(propertyId)) {
      ins.run(c.id, id, `${demoPrefix(db, c)}-${code}`);
    }
    if (baseRate !== null) {
      createRatePlan(db, propertyId, { room_type_id: id, code: 'EP', name: 'Room only', meal_plan: 'EP', rate_double: baseRate });
    }
    return db.prepare('SELECT * FROM room_types WHERE id = ?').get(id);
  });
}

function getRoomTypeOrThrow(db, propertyId, id) {
  const rt = db.prepare('SELECT * FROM room_types WHERE id = ? AND property_id = ?').get(id, propertyId);
  if (!rt) throw notFound('Room type not found');
  return rt;
}

/**
 * Change a room type. Adding or removing physical rooms shifts the rooms
 * left to sell on every future night by the same amount.
 */
function updateRoomType(db, propertyId, id, input) {
  const rt = getRoomTypeOrThrow(db, propertyId, id);
  const fields = validateRoomFields(input, { partial: true });
  if (Object.keys(fields).length === 0) throw badRequest('Nothing to change');

  return transaction(db, () => {
    const delta = fields.total_rooms === undefined ? 0 : fields.total_rooms - rt.total_rooms;
    if (delta < 0) {
      const tight = db.prepare('SELECT MIN(available) AS m FROM room_inventory WHERE room_type_id = ? AND date >= ?').get(id, today()).m;
      if (tight != null && tight + delta < 0) {
        throw new HttpError(409, `Can't remove ${-delta} room(s): some upcoming nights only have ${tight} unsold`);
      }
    }
    const cols = Object.keys(fields);
    db.prepare(`UPDATE room_types SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map((c) => fields[c]), id);
    if (delta !== 0) {
      db.prepare('UPDATE room_inventory SET available = available + ?, updated_at = ? WHERE room_type_id = ? AND date >= ?')
        .run(delta, new Date().toISOString(), id, today());
      // The room count is the default for nights never edited, and the
      // occupancy used by yield rules changes too.
      queueRoomTypeResync(db, id);
    }
    return db.prepare('SELECT * FROM room_types WHERE id = ?').get(id);
  });
}

function deleteRoomType(db, propertyId, id) {
  const rt = getRoomTypeOrThrow(db, propertyId, id);
  if (db.prepare('SELECT 1 FROM booking_lines WHERE room_type_id = ? LIMIT 1').get(id)) {
    throw new HttpError(409, `${rt.name} has bookings, so it can't be deleted. Set it to stop sell instead.`);
  }
  const outsideParent = db.prepare(`
    SELECT child.name FROM rate_plans child JOIN rate_plans parent ON parent.id = child.parent_id
    WHERE parent.room_type_id = ? AND child.room_type_id != ? LIMIT 1`).get(id, id);
  if (outsideParent) throw new HttpError(409, `Rate plan "${outsideParent.name}" of another room is derived from this room's plans`);
  transaction(db, () => {
    db.prepare(`DELETE FROM channel_listings WHERE (channel_id, external_room_id) IN
                (SELECT channel_id, external_room_id FROM channel_room_mappings WHERE room_type_id = ?)`).run(id);
    // Derived plans first, so no plan points at a deleted parent.
    db.prepare('UPDATE rate_plans SET parent_id = NULL WHERE room_type_id = ?').run(id);
    db.prepare('DELETE FROM room_types WHERE id = ?').run(id);
  });
  return rt;
}

// ---------- Rate plans ----------

function validatePlan(db, propertyId, input, existing = null) {
  const out = {};
  if (!existing || input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw badRequest('Enter a rate plan name');
    out.name = input.name.trim();
  }
  if (!existing || input.meal_plan !== undefined) {
    const meal = String(input.meal_plan || 'EP').toUpperCase();
    if (!MEAL_PLANS.includes(meal)) throw badRequest(`Meal plan must be one of ${MEAL_PLANS.join(', ')}`);
    out.meal_plan = meal;
  }
  if (input.active !== undefined) {
    if (typeof input.active !== 'boolean') throw badRequest('active must be true or false');
    out.active = input.active ? 1 : 0;
  }

  const parentId = input.parent_id === undefined ? existing?.parent_id ?? null : input.parent_id || null;
  if (parentId) {
    const parent = db.prepare(`SELECT rp.* FROM rate_plans rp JOIN room_types rt ON rt.id = rp.room_type_id
                               WHERE rp.id = ? AND rt.property_id = ?`).get(Number(parentId), propertyId);
    if (!parent) throw badRequest('Parent rate plan not found');
    // No loops: the parent must not be (derived from) this plan.
    for (let p = parent, depth = 0; p; p = p.parent_id ? db.prepare('SELECT * FROM rate_plans WHERE id = ?').get(p.parent_id) : null, depth += 1) {
      if (existing && p.id === existing.id) throw badRequest("A plan can't be derived from itself");
      if (depth > 4) throw badRequest('Derived plans can be nested at most 5 deep');
    }
    const type = input.derive_type ?? existing?.derive_type;
    if (!['percent', 'amount'].includes(type)) throw badRequest('derive_type must be "percent" or "amount"');
    const value = Number(input.derive_value ?? existing?.derive_value);
    if (!Number.isFinite(value) || (type === 'percent' && value <= -100)) throw badRequest('Enter how much to adjust the parent price by');
    Object.assign(out, { parent_id: parent.id, derive_type: type, derive_value: value });
    if (!existing) out.rate_double = 0; // unused for derived plans
  } else {
    if (existing?.parent_id && input.parent_id !== undefined) {
      Object.assign(out, { parent_id: null, derive_type: null, derive_value: null });
    }
    const needsPrice = !existing || existing.parent_id;
    for (const f of ['rate_double', 'rate_single', 'rate_triple', 'extra_adult', 'extra_child']) {
      const v = input[f];
      if (v === undefined) continue;
      if (v === null || v === '') {
        if (f === 'rate_double') throw badRequest('The double-occupancy price is required');
        out[f] = null;
        continue;
      }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || (!f.startsWith('extra') && n === 0)) throw badRequest(`${f.replace('_', ' ')} must be a positive number`);
      out[f] = n;
    }
    if (needsPrice && out.rate_double === undefined) throw badRequest('Enter the price for two adults (double occupancy)');
  }
  return out;
}

function getPlanOrThrow(db, propertyId, id) {
  const plan = db.prepare(`SELECT rp.* FROM rate_plans rp JOIN room_types rt ON rt.id = rp.room_type_id
                           WHERE rp.id = ? AND rt.property_id = ?`).get(id, propertyId);
  if (!plan) throw notFound('Rate plan not found');
  return plan;
}

/** Add a rate plan to a room type. The demo OTAs start selling it straight away. */
function createRatePlan(db, propertyId, input) {
  const rt = getRoomTypeOrThrow(db, propertyId, Number(input.room_type_id));
  const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
  if (!CODE_RE.test(code)) throw badRequest('Rate plan code must be 2–10 letters or digits, e.g. EP');
  const fields = validatePlan(db, propertyId, input);
  return transaction(db, () => {
    if (db.prepare('SELECT 1 FROM rate_plans WHERE room_type_id = ? AND code = ?').get(rt.id, code)) {
      throw badRequest(`${rt.name} already has a plan with code ${code}`);
    }
    const position = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM rate_plans WHERE room_type_id = ?').get(rt.id).p;
    const cols = ['room_type_id', 'code', 'position', 'created_at', ...Object.keys(fields)];
    const vals = [rt.id, code, position, new Date().toISOString(), ...Object.values(fields)];
    const id = Number(db.prepare(`INSERT INTO rate_plans (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...vals).lastInsertRowid);

    const ins = db.prepare('INSERT OR IGNORE INTO channel_rate_plan_mappings (channel_id, rate_plan_id, external_rate_plan_id) VALUES (?, ?, ?)');
    for (const c of db.prepare("SELECT * FROM channels WHERE property_id = ? AND kind = 'simulated'").all(propertyId)) {
      ins.run(c.id, id, `${demoPrefix(db, c)}-${rt.code}-${code}`);
    }
    queueRoomTypeResync(db, rt.id);
    return db.prepare('SELECT * FROM rate_plans WHERE id = ?').get(id);
  });
}

function updateRatePlan(db, propertyId, id, input) {
  const plan = getPlanOrThrow(db, propertyId, id);
  const fields = validatePlan(db, propertyId, input, plan);
  if (Object.keys(fields).length === 0) throw badRequest('Nothing to change');
  return transaction(db, () => {
    const cols = Object.keys(fields);
    db.prepare(`UPDATE rate_plans SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(fields), id);
    // Default prices and derivations reach every night this plan (and plans
    // derived from it) haven't priced individually.
    for (const rtId of dependentRoomTypes(db, [id])) queueRoomTypeResync(db, rtId);
    return db.prepare('SELECT * FROM rate_plans WHERE id = ?').get(id);
  });
}

function deleteRatePlan(db, propertyId, id) {
  const plan = getPlanOrThrow(db, propertyId, id);
  const child = db.prepare('SELECT name FROM rate_plans WHERE parent_id = ? LIMIT 1').get(id);
  if (child) throw new HttpError(409, `"${child.name}" is derived from this plan. Delete or change it first.`);
  transaction(db, () => {
    db.prepare(`DELETE FROM channel_listings WHERE (channel_id, external_rate_plan_id) IN
                (SELECT channel_id, external_rate_plan_id FROM channel_rate_plan_mappings WHERE rate_plan_id = ?)`).run(id);
    db.prepare('DELETE FROM rate_plans WHERE id = ?').run(id);
    queueRoomTypeResync(db, plan.room_type_id);
  });
  return plan;
}

// ---------- Yield rules (occupancy-based pricing) ----------

function listYieldRules(db, propertyId) {
  return db.prepare(`
    SELECT y.*, rt.name AS room_type_name FROM yield_rules y LEFT JOIN room_types rt ON rt.id = y.room_type_id
    WHERE y.property_id = ? ORDER BY y.room_type_id IS NOT NULL, rt.position, y.min_occupancy`).all(propertyId)
    .map((r) => ({ ...r, active: Boolean(r.active) }));
}

function validateYield(db, propertyId, input, existing = null) {
  const out = {};
  if (!existing || input.room_type_id !== undefined) {
    const rtId = input.room_type_id === null || input.room_type_id === '' || input.room_type_id === undefined ? null : Number(input.room_type_id);
    if (rtId !== null) getRoomTypeOrThrow(db, propertyId, rtId);
    out.room_type_id = rtId;
  }
  if (!existing || input.min_occupancy !== undefined) {
    const n = Number(input.min_occupancy);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw badRequest('Occupancy threshold must be between 0 and 100%');
    out.min_occupancy = n;
  }
  if (!existing || input.adjust_pct !== undefined) {
    const n = Number(input.adjust_pct);
    if (!Number.isFinite(n) || n < -90 || n > 300 || n === 0) throw badRequest('Price change must be a non-zero percentage between -90 and 300');
    out.adjust_pct = n;
  }
  if (input.active !== undefined) {
    if (typeof input.active !== 'boolean') throw badRequest('active must be true or false');
    out.active = input.active ? 1 : 0;
  }
  return out;
}

function createYieldRule(db, propertyId, input) {
  const f = validateYield(db, propertyId, input);
  return transaction(db, () => {
    const id = db.prepare(`INSERT INTO yield_rules (property_id, room_type_id, min_occupancy, adjust_pct, active, created_at)
                           VALUES (?, ?, ?, ?, ?, ?)`)
      .run(propertyId, f.room_type_id, f.min_occupancy, f.adjust_pct, f.active ?? 1, new Date().toISOString()).lastInsertRowid;
    queuePropertyResync(db, propertyId);
    return db.prepare('SELECT * FROM yield_rules WHERE id = ?').get(id);
  });
}

function getYieldOrThrow(db, propertyId, id) {
  const rule = db.prepare('SELECT * FROM yield_rules WHERE id = ? AND property_id = ?').get(id, propertyId);
  if (!rule) throw notFound('Rule not found');
  return rule;
}

function updateYieldRule(db, propertyId, id, input) {
  getYieldOrThrow(db, propertyId, id);
  const f = validateYield(db, propertyId, input, true);
  if (Object.keys(f).length === 0) throw badRequest('Nothing to change');
  return transaction(db, () => {
    db.prepare(`UPDATE yield_rules SET ${Object.keys(f).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(f), id);
    queuePropertyResync(db, propertyId);
    return db.prepare('SELECT * FROM yield_rules WHERE id = ?').get(id);
  });
}

function deleteYieldRule(db, propertyId, id) {
  const rule = getYieldOrThrow(db, propertyId, id);
  transaction(db, () => {
    db.prepare('DELETE FROM yield_rules WHERE id = ?').run(id);
    queuePropertyResync(db, propertyId);
  });
  return rule;
}

module.exports = {
  MEAL_PLANS,
  getProperty, addProperty, updateProperty, validateProperty,
  listRoomTypes, createRoomType, updateRoomType, deleteRoomType,
  createRatePlan, updateRatePlan, deleteRatePlan, getPlanOrThrow,
  listYieldRules, createYieldRule, updateYieldRule, deleteYieldRule,
};
