// How the price of a rate plan on a night is worked out:
//
//   1. the plan's own price for that night, or its default price;
//      a derived plan instead takes its parent's price (step 1 for the
//      parent) adjusted by a percentage or an amount;
//   2. occupancy-based pricing (yield rules) for the plan's room type;
//   3. the channel's markup, when sending to a channel.

const PRICE_FIELDS = ['rate_double', 'rate_single', 'rate_triple', 'extra_adult', 'extra_child'];
// Derivation adjusts the room prices; extra-guest charges are inherited as they are.
const DERIVED_FIELDS = ['rate_double', 'rate_single', 'rate_triple'];
const MAX_DERIVE_DEPTH = 5;

const roundMoney = (n) => (n == null ? null : Math.round(n * 100) / 100);

function applyDerivation(value, type, amount) {
  if (value == null) return null;
  return type === 'percent' ? value * (1 + amount / 100) : value + amount;
}

/** Applies a markup or yield percentage to every price. */
function adjustPrices(prices, pct, fields = PRICE_FIELDS) {
  const out = { ...prices };
  for (const f of fields) out[f] = roundMoney(out[f] == null ? null : out[f] * (1 + pct / 100));
  return out;
}

/**
 * Works out prices and restrictions, remembering what it has looked up.
 * Make one per request or sync batch; it does not notice later changes.
 */
class Pricer {
  constructor(db) {
    this.db = db;
    this.plans = new Map();
    this.rows = new Map();
    this.occ = new Map();
    this.rules = new Map();
  }

  plan(id) {
    if (!this.plans.has(id)) {
      this.plans.set(id, this.db.prepare(`
        SELECT rp.*, rt.property_id, rt.total_rooms FROM rate_plans rp JOIN room_types rt ON rt.id = rp.room_type_id
        WHERE rp.id = ?`).get(id) || null);
    }
    return this.plans.get(id);
  }

  row(planId, date) {
    const key = `${planId}|${date}`;
    if (!this.rows.has(key)) {
      this.rows.set(key, this.db.prepare('SELECT * FROM rate_calendar WHERE rate_plan_id = ? AND date = ?').get(planId, date) || null);
    }
    return this.rows.get(key);
  }

  /** Rooms booked for a night, from confirmed bookings (not from manual availability changes). */
  occupancy(roomTypeId, totalRooms, date) {
    const key = `${roomTypeId}|${date}`;
    if (!this.occ.has(key)) {
      const sold = this.db.prepare(`
        SELECT COALESCE(SUM(l.rooms), 0) AS n FROM booking_lines l JOIN bookings b ON b.id = l.booking_id
        WHERE l.room_type_id = ? AND l.check_in <= ? AND l.check_out > ? AND b.status = 'confirmed'
      `).get(roomTypeId, date, date).n;
      this.occ.set(key, { sold, total: totalRooms, pct: totalRooms ? Math.round((sold / totalRooms) * 1000) / 10 : 0 });
    }
    return this.occ.get(key);
  }

  /** The yield adjustment for a room type at a given occupancy: the rule with the highest threshold reached wins. */
  yieldPct(propertyId, roomTypeId, occPct) {
    if (!this.rules.has(propertyId)) {
      this.rules.set(propertyId, this.db.prepare(
        'SELECT * FROM yield_rules WHERE property_id = ? AND active = 1 ORDER BY min_occupancy DESC, room_type_id IS NULL'
      ).all(propertyId));
    }
    const rule = this.rules.get(propertyId)
      .find((r) => (r.room_type_id == null || r.room_type_id === roomTypeId) && occPct >= r.min_occupancy);
    return rule ? rule.adjust_pct : 0;
  }

  /** Step 1: own or derived price, before yield. */
  basePrices(plan, date, depth = 0) {
    if (plan.parent_id) {
      const parent = this.plan(plan.parent_id);
      if (!parent || depth >= MAX_DERIVE_DEPTH) throw new Error(`Rate plan ${plan.name}: parent plan missing or nested too deep`);
      const p = this.basePrices(parent, date, depth + 1);
      const out = { ...p };
      for (const f of DERIVED_FIELDS) out[f] = roundMoney(applyDerivation(p[f], plan.derive_type, plan.derive_value));
      return out;
    }
    const row = this.row(plan.id, date);
    const out = {};
    for (const f of PRICE_FIELDS) out[f] = roundMoney(row?.[f] ?? plan[f]);
    return out;
  }

  /** Steps 1 and 2: what the hotel sells the plan for that night. */
  prices(planOrId, date) {
    const plan = typeof planOrId === 'object' ? planOrId : this.plan(planOrId);
    const base = this.basePrices(plan, date);
    const occ = this.occupancy(plan.room_type_id, plan.total_rooms, date);
    const yieldPct = this.yieldPct(plan.property_id, plan.room_type_id, occ.pct);
    return { ...adjustPrices(base, yieldPct, DERIVED_FIELDS), yield_pct: yieldPct, base_double: base.rate_double };
  }

  restrictions(planId, date) {
    const row = this.row(planId, date);
    return {
      stop_sell: Boolean(row?.stop_sell),
      cta: Boolean(row?.cta),
      ctd: Boolean(row?.ctd),
      min_stay: row?.min_stay ?? 1,
      max_stay: row?.max_stay ?? null,
    };
  }

  /** Does this plan have its own price for the night (rather than its default)? */
  hasOwnPrice(planId, date) {
    const row = this.row(planId, date);
    return Boolean(row) && PRICE_FIELDS.some((f) => row[f] != null);
  }
}

module.exports = { Pricer, adjustPrices, roundMoney, PRICE_FIELDS, DERIVED_FIELDS };
