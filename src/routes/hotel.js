const express = require('express');
const {
  getProperty, addProperty, updateProperty, MEAL_PLANS,
  listRoomTypes, createRoomType, updateRoomType, deleteRoomType,
  createRatePlan, updateRatePlan, deleteRatePlan, getPlanOrThrow,
  listYieldRules, createYieldRule, updateYieldRule, deleteYieldRule,
} = require('../hotel');
const { transaction } = require('../db');
const { requirePermission, accessibleProperties } = require('../permissions');
const { logActivity } = require('../activity');

/** Properties the user can reach, and adding new ones. Not tied to one property. */
function propertyListRoutes({ db }) {
  const r = express.Router();

  r.get('/properties', (req, res) => res.json(accessibleProperties(db, req.user)));

  r.post('/properties', requirePermission('users'), (req, res) => {
    const property = transaction(db, () => {
      const p = addProperty(db, req.body || {});
      // Someone who can only see some properties should also see the one they created.
      if (!req.user.all_properties) {
        db.prepare('INSERT OR IGNORE INTO user_properties (user_id, property_id) VALUES (?, ?)').run(req.user.id, p.id);
      }
      return p;
    });
    logActivity(db, req.user, `Added property ${property.name}`, property.id);
    res.status(201).json(property);
  });

  return r;
}

/** Settings of the current property: details, room types, rate plans, yield rules. */
function hotelRoutes({ db, engine }) {
  const r = express.Router();
  const setup = requirePermission('setup');
  const log = (req, text) => logActivity(db, req.user, text, req.property.id);

  r.get('/property', (req, res) => res.json({ ...getProperty(db, req.property.id), meal_plans: MEAL_PLANS }));

  r.patch('/property', setup, (req, res) => {
    const before = getProperty(db, req.property.id);
    const after = updateProperty(db, req.property.id, req.body || {});
    const changes = ['name', 'currency', 'city', 'country'].filter((k) => before[k] !== after[k])
      .map((k) => `${k} to "${after[k] ?? ''}"`);
    if (changes.length) log(req, `Changed hotel ${changes.join(', ')}`);
    res.json(after);
  });

  // ----- Room types -----

  r.get('/room-types', (req, res) => res.json(listRoomTypes(db, req.property.id)));

  r.post('/room-types', setup, (req, res) => {
    const rt = createRoomType(db, req.property.id, req.body || {});
    log(req, `Added room type ${rt.name} (${rt.code}): ${rt.total_rooms} rooms`);
    engine.kick();
    res.status(201).json(rt);
  });

  r.patch('/room-types/:id', setup, (req, res) => {
    const id = Number(req.params.id);
    const before = db.prepare('SELECT * FROM room_types WHERE id = ? AND property_id = ?').get(id, req.property.id);
    const rt = updateRoomType(db, req.property.id, id, req.body || {});
    const changes = ['name', 'total_rooms', 'max_adults', 'max_children']
      .filter((k) => before[k] !== rt[k])
      .map((k) => `${k.replace('_', ' ')} ${before[k]} → ${rt[k]}`);
    if (changes.length) log(req, `Changed ${rt.name}: ${changes.join(', ')}`);
    engine.kick();
    res.json(rt);
  });

  r.delete('/room-types/:id', setup, (req, res) => {
    const rt = deleteRoomType(db, req.property.id, Number(req.params.id));
    log(req, `Deleted room type ${rt.name} (${rt.code})`);
    res.json({ ok: true });
  });

  // ----- Rate plans -----

  r.post('/rate-plans', setup, (req, res) => {
    const plan = createRatePlan(db, req.property.id, req.body || {});
    log(req, `Added rate plan ${plan.name} (${plan.code}, ${plan.meal_plan})`);
    engine.kick();
    res.status(201).json(plan);
  });

  r.patch('/rate-plans/:id', setup, (req, res) => {
    const id = Number(req.params.id);
    const before = getPlanOrThrow(db, req.property.id, id);
    const plan = updateRatePlan(db, req.property.id, id, req.body || {});
    const changes = ['name', 'meal_plan', 'rate_double', 'rate_single', 'rate_triple', 'extra_adult', 'extra_child', 'derive_type', 'derive_value', 'active']
      .filter((k) => before[k] !== plan[k])
      .map((k) => `${k.replace('_', ' ')} ${before[k] ?? '–'} → ${plan[k] ?? '–'}`);
    if (changes.length) log(req, `Changed rate plan ${plan.name}: ${changes.join(', ')}`);
    engine.kick();
    res.json(plan);
  });

  r.delete('/rate-plans/:id', setup, (req, res) => {
    const plan = deleteRatePlan(db, req.property.id, Number(req.params.id));
    log(req, `Deleted rate plan ${plan.name} (${plan.code})`);
    engine.kick();
    res.json({ ok: true });
  });

  // ----- Occupancy-based pricing -----

  r.get('/yield-rules', (req, res) => res.json(listYieldRules(db, req.property.id)));

  const describeRule = (rule) => {
    const rt = rule.room_type_id ? db.prepare('SELECT name FROM room_types WHERE id = ?').get(rule.room_type_id)?.name : 'all rooms';
    return `${rt}: ${rule.adjust_pct > 0 ? '+' : ''}${rule.adjust_pct}% from ${rule.min_occupancy}% occupancy`;
  };

  r.post('/yield-rules', setup, (req, res) => {
    const rule = createYieldRule(db, req.property.id, req.body || {});
    log(req, `Added pricing rule ${describeRule(rule)}`);
    engine.kick();
    res.status(201).json(rule);
  });

  r.patch('/yield-rules/:id', setup, (req, res) => {
    const rule = updateYieldRule(db, req.property.id, Number(req.params.id), req.body || {});
    log(req, `Changed pricing rule ${describeRule(rule)}${rule.active ? '' : ' (off)'}`);
    engine.kick();
    res.json(rule);
  });

  r.delete('/yield-rules/:id', setup, (req, res) => {
    const rule = deleteYieldRule(db, req.property.id, Number(req.params.id));
    log(req, `Deleted pricing rule ${describeRule(rule)}`);
    engine.kick();
    res.json({ ok: true });
  });

  return r;
}

module.exports = { hotelRoutes, propertyListRoutes };
