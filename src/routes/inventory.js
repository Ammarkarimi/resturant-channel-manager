const express = require('express');
const { getGrid, bulkUpdate, setChannelBlocks } = require('../inventory');
const { listBookings } = require('../bookings');
const { logActivity, listActivity } = require('../activity');
const { requirePermission } = require('../permissions');
const { today } = require('../dates');

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const present = (v) => v !== undefined && v !== null && v !== '';

function describeTarget(db, body) {
  const names = (body.room_type_ids || [])
    .map((id) => db.prepare('SELECT name FROM room_types WHERE id = ?').get(id)?.name)
    .filter(Boolean).join(', ');
  const plans = Array.isArray(body.rate_plan_ids) && body.rate_plan_ids.length
    ? ` (${body.rate_plan_ids.map((id) => db.prepare('SELECT name FROM rate_plans WHERE id = ?').get(id)?.name).filter(Boolean).join(', ')})`
    : '';
  const range = body.start_date === body.end_date ? body.start_date : `${body.start_date} → ${body.end_date}`;
  const days = body.weekdays?.length ? ` (${body.weekdays.map((d) => WEEKDAYS[d]).join(', ')})` : '';
  return `${names}${plans} for ${range}${days}`;
}

function describeBulk(db, body) {
  const set = body.set || {};
  const parts = [];
  const rate = present(set.rate_double) ? set.rate_double : set.rate;
  if (present(rate)) parts.push(`rate ${rate}`);
  if (present(set.rate_single)) parts.push(`single ${set.rate_single}`);
  if (present(set.rate_triple)) parts.push(`triple ${set.rate_triple}`);
  if (present(set.extra_adult)) parts.push(`extra adult ${set.extra_adult}`);
  if (present(set.extra_child)) parts.push(`extra child ${set.extra_child}`);
  if (set.reset_rates === true) parts.push('rates back to default');
  if (present(set.available)) parts.push(`${set.available} rooms available`);
  if (present(set.min_stay)) parts.push(`min stay ${set.min_stay}`);
  if (present(set.max_stay)) parts.push(Number(set.max_stay) === 0 ? 'no max stay' : `max stay ${set.max_stay}`);
  if (set.stop_sell === true) parts.push('room closed');
  if (set.stop_sell === false) parts.push('room open');
  if (set.plan_stop_sell === true) parts.push('rate plan closed');
  if (set.plan_stop_sell === false) parts.push('rate plan open');
  if (set.cta === true) parts.push('closed to arrival');
  if (set.cta === false) parts.push('open to arrival');
  if (set.ctd === true) parts.push('closed to departure');
  if (set.ctd === false) parts.push('open to departure');
  return `Set ${parts.join(', ')} on ${describeTarget(db, body)}`;
}

/** The calendar, the one-click update, and what the dashboard shows around them. */
function inventoryRoutes({ db, engine, channex }) {
  const r = express.Router();
  const rates = requirePermission('rates');

  r.get('/inventory', (req, res) => {
    const start = req.query.start || today();
    const days = req.query.days ? Number(req.query.days) : 14;
    res.json(getGrid(db, req.property.id, start, days));
  });

  r.post('/inventory/bulk', rates, (req, res) => {
    const result = bulkUpdate(db, req.property.id, req.body || {});
    logActivity(db, req.user, describeBulk(db, req.body), req.property.id);
    engine.kick();
    res.json(result);
  });

  // Close or reopen rooms on selected channels only.
  r.post('/inventory/channel-blocks', rates, (req, res) => {
    const result = setChannelBlocks(db, req.property.id, req.body || {});
    logActivity(db, req.user, `${req.body.blocked ? 'Closed' : 'Reopened'} ${describeTarget(db, req.body)} on ${result.channels.join(', ')}`, req.property.id);
    engine.kick();
    res.json(result);
  });

  r.get('/activity', (req, res) => res.json(listActivity(db, req.property.id)));

  // Things someone should look at, shown as a banner on every page.
  r.get('/alerts', (req, res) => {
    const alerts = [];
    const attention = listBookings(db, req.property.id, { view: 'attention' });
    const over = attention.filter((b) => b.overbooked).length;
    const flagged = attention.filter((b) => b.needs_attention && !b.overbooked).length;
    if (over) alerts.push({ level: 'error', page: 'bookings', text: `${over} overbooked booking(s): find these guests another room` });
    if (flagged) alerts.push({ level: 'error', page: 'bookings', text: `${flagged} booking(s) need attention` });

    const sync = db.prepare(`
      SELECT c.name, SUM(q.status = 'failed') AS failed, SUM(q.status = 'pending' AND q.last_error IS NOT NULL) AS retrying
      FROM sync_queue q JOIN channels c ON c.id = q.channel_id AND c.enabled = 1 AND c.property_id = ?
      GROUP BY c.id HAVING failed > 0 OR retrying > 0
    `).all(req.property.id);
    for (const s of sync) {
      alerts.push(s.failed
        ? { level: 'error', page: 'channels', text: `${s.name}: ${s.failed} update(s) failed to send` }
        : { level: 'warn', page: 'channels', text: `${s.name}: having trouble sending updates, retrying` });
    }

    const cx = channex.status(req.property.id);
    if (cx.connected) {
      if (cx.last_pull.ok === false) {
        alerts.push({ level: 'error', page: 'channels', text: `Couldn't fetch bookings from Channex: ${cx.last_pull.error}` });
      }
      const rooms = db.prepare('SELECT COUNT(*) AS n FROM room_types WHERE property_id = ?').get(req.property.id).n;
      if (rooms > cx.rooms.length) alerts.push({ level: 'warn', page: 'channels', text: `${rooms - cx.rooms.length} room type(s) aren't mapped to Channex, so OTAs can't sell them` });
    }
    res.json(alerts);
  });

  return r;
}

module.exports = { inventoryRoutes };
