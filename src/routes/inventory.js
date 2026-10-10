const express = require('express');
const { getGrid, bulkUpdate } = require('../inventory');
const { listBookings } = require('../bookings');
const { logActivity, listActivity } = require('../activity');
const { today } = require('../dates');

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function describeBulk(db, body) {
  const set = body.set || {};
  const parts = [];
  if (set.rate !== undefined && set.rate !== null && set.rate !== '') parts.push(`rate ${set.rate}`);
  if (set.available !== undefined && set.available !== null && set.available !== '') parts.push(`${set.available} rooms available`);
  if (set.min_stay !== undefined && set.min_stay !== null && set.min_stay !== '') parts.push(`min stay ${set.min_stay}`);
  if (set.stop_sell === true) parts.push('stop sell');
  if (set.stop_sell === false) parts.push('open for sale');
  const names = body.room_type_ids
    .map((id) => db.prepare('SELECT name FROM room_types WHERE id = ?').get(id)?.name)
    .filter(Boolean).join(', ');
  const range = body.start_date === body.end_date ? body.start_date : `${body.start_date} → ${body.end_date}`;
  const days = body.weekdays?.length ? ` (${body.weekdays.map((d) => WEEKDAYS[d]).join(', ')})` : '';
  return `Set ${parts.join(', ')} on ${names} for ${range}${days}`;
}

/** The calendar, the one-click update, and what the dashboard shows around them. */
function inventoryRoutes({ db, engine, channex }) {
  const r = express.Router();

  r.get('/inventory', (req, res) => {
    const start = req.query.start || today();
    const days = req.query.days ? Number(req.query.days) : 14;
    res.json(getGrid(db, start, days));
  });

  r.post('/inventory/bulk', (req, res) => {
    const result = bulkUpdate(db, req.body);
    logActivity(db, req.user, describeBulk(db, req.body));
    engine.kick();
    res.json(result);
  });

  r.get('/activity', (req, res) => res.json(listActivity(db)));

  // Things someone should look at, shown as a banner on every page.
  r.get('/alerts', (req, res) => {
    const alerts = [];
    const attention = listBookings(db, { view: 'attention' });
    const over = attention.filter((b) => b.overbooked).length;
    const flagged = attention.filter((b) => b.needs_attention && !b.overbooked).length;
    if (over) alerts.push({ level: 'error', page: 'bookings', text: `${over} overbooked booking(s): find these guests another room` });
    if (flagged) alerts.push({ level: 'error', page: 'bookings', text: `${flagged} booking(s) need attention` });

    const sync = db.prepare(`
      SELECT c.name, SUM(q.status = 'failed') AS failed, SUM(q.status = 'pending' AND q.last_error IS NOT NULL) AS retrying
      FROM sync_queue q JOIN channels c ON c.id = q.channel_id AND c.enabled = 1
      GROUP BY c.id HAVING failed > 0 OR retrying > 0
    `).all();
    for (const s of sync) {
      alerts.push(s.failed
        ? { level: 'error', page: 'channels', text: `${s.name}: ${s.failed} update(s) failed to send` }
        : { level: 'warn', page: 'channels', text: `${s.name}: having trouble sending updates, retrying` });
    }

    const cx = channex.status();
    if (cx.connected) {
      if (cx.last_pull.ok === false) {
        alerts.push({ level: 'error', page: 'channels', text: `Couldn't fetch bookings from Channex: ${cx.last_pull.error}` });
      }
      const unmapped = db.prepare('SELECT COUNT(*) AS n FROM room_types').get().n - cx.mappings.length;
      if (unmapped > 0) alerts.push({ level: 'warn', page: 'channels', text: `${unmapped} room type(s) aren't mapped to Channex, so OTAs can't sell them` });
    }
    res.json(alerts);
  });

  return r;
}

module.exports = { inventoryRoutes };
