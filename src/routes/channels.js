const express = require('express');
const { transaction } = require('../db');
const { roomTypesOf } = require('../inventory');
const { eachDate, addDays, today } = require('../dates');
const { getChannelByCode } = require('../bookings');
const { retryFailed, channelUpdate } = require('../sync');
const { Pricer } = require('../pricing');
const { requirePermission } = require('../permissions');
const { queueFullResync } = require('../queue');
const { logActivity } = require('../activity');
const { badRequest } = require('../errors');

/** Channel connections, their sync state, and the sync queue. */
function channelRoutes({ db, engine }) {
  const r = express.Router();
  const manage = requirePermission('channels');

  r.get('/channels', (req, res) => {
    const channels = db.prepare(`
      SELECT c.id, c.code, c.name, c.kind, c.enabled, c.rate_markup_pct, c.simulate_outage,
        (SELECT COUNT(*) FROM sync_queue q WHERE q.channel_id = c.id AND q.status = 'pending') AS pending,
        (SELECT COUNT(*) FROM sync_queue q WHERE q.channel_id = c.id AND q.status = 'failed') AS failed,
        (SELECT MAX(created_at) FROM sync_log l WHERE l.channel_id = c.id AND l.ok = 1) AS last_success_at,
        (SELECT last_error FROM sync_queue q WHERE q.channel_id = c.id AND q.last_error IS NOT NULL LIMIT 1) AS last_error
      FROM channels c WHERE c.property_id = ? AND c.kind != 'direct' ORDER BY c.kind = 'simulated', c.id
    `).all(req.property.id);
    res.json(channels.map((c) => ({
      ...c, enabled: Boolean(c.enabled), simulate_outage: Boolean(c.simulate_outage),
    })));
  });

  r.patch('/channels/:code', manage, (req, res) => {
    const channel = getChannelByCode(db, req.property.id, req.params.code);
    if (channel.kind === 'direct') throw badRequest('Direct bookings are not a channel you can change');
    const { enabled, rate_markup_pct, simulate_outage } = req.body || {};
    const sets = {};
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') throw badRequest('enabled must be true or false');
      if (enabled && channel.kind === 'channex' && !JSON.parse(channel.config || '{}').property_id) {
        throw badRequest('Connect a Channex property first');
      }
      sets.enabled = enabled ? 1 : 0;
    }
    if (simulate_outage !== undefined) {
      if (typeof simulate_outage !== 'boolean') throw badRequest('simulate_outage must be true or false');
      sets.simulate_outage = simulate_outage ? 1 : 0;
    }
    if (rate_markup_pct !== undefined) {
      const pct = Number(rate_markup_pct);
      if (!Number.isFinite(pct) || pct < -50 || pct > 100) throw badRequest('rate_markup_pct must be between -50 and 100');
      sets.rate_markup_pct = pct;
    }
    if (Object.keys(sets).length === 0) throw badRequest('Nothing to change');

    transaction(db, () => {
      const cols = Object.keys(sets);
      db.prepare(`UPDATE channels SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...cols.map((c) => sets[c]), channel.id);
      if (sets.enabled === 0) {
        db.prepare('DELETE FROM sync_queue WHERE channel_id = ?').run(channel.id);
      }
      // Reconnecting or repricing a channel means everything it shows may be stale.
      const reconnected = sets.enabled === 1 && !channel.enabled;
      const repriced = sets.rate_markup_pct !== undefined && sets.rate_markup_pct !== channel.rate_markup_pct;
      if (reconnected || (repriced && (sets.enabled ?? channel.enabled))) {
        queueFullResync(db, channel.id);
      }
    });
    const what = [];
    if (sets.enabled !== undefined && sets.enabled !== channel.enabled) what.push(sets.enabled ? 'connected' : 'disconnected');
    if (sets.rate_markup_pct !== undefined && sets.rate_markup_pct !== channel.rate_markup_pct) what.push(`markup set to ${sets.rate_markup_pct}%`);
    if (sets.simulate_outage !== undefined && sets.simulate_outage !== channel.simulate_outage) what.push(`outage simulation ${sets.simulate_outage ? 'on' : 'off'}`);
    if (what.length) logActivity(db, req.user, `${channel.name}: ${what.join(', ')}`, req.property.id);
    engine.kick();
    res.json(db.prepare('SELECT * FROM channels WHERE id = ?').get(channel.id));
  });

  // What a (demo) OTA is currently showing vs. what it should be showing, per rate plan.
  r.get('/channels/:code/listings', (req, res) => {
    const channel = getChannelByCode(db, req.property.id, req.params.code);
    const start = req.query.start || today();
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 62);
    const dates = eachDate(start, addDays(start, days - 1));
    const pricer = new Pricer(db);
    const listing = db.prepare('SELECT * FROM channel_listings WHERE channel_id = ? AND external_rate_plan_id = ? AND date = ?');
    const rooms = roomTypesOf(db, req.property.id)
      .filter((rt) => db.prepare('SELECT 1 FROM channel_room_mappings WHERE channel_id = ? AND room_type_id = ?').get(channel.id, rt.id));
    const plans = [];
    const perDate = dates.map((d) => ({ d, updates: new Map(rooms.map((rt) => [rt.id, channelUpdate(db, pricer, channel, rt.id, d)])) }));
    for (const rt of rooms) {
      const first = perDate[0].updates.get(rt.id);
      for (const p of first.plans) {
        const plan = db.prepare('SELECT name FROM rate_plans WHERE id = ?').get(p.rate_plan_id);
        plans.push({
          room_type_name: rt.name,
          rate_plan_name: plan.name,
          external_room_id: first.external_room_id,
          external_rate_plan_id: p.external_rate_plan_id,
          cells: perDate.map(({ d, updates }) => {
            const u = updates.get(rt.id);
            const e = u.plans.find((x) => x.rate_plan_id === p.rate_plan_id);
            const expected = { available: u.available, rate: e.rate, closed: e.closed, cta: e.cta, ctd: e.ctd, min_stay: e.min_stay, max_stay: e.max_stay };
            const live = listing.get(channel.id, p.external_rate_plan_id, d);
            const shown = live && {
              available: live.available, rate: live.rate, closed: Boolean(live.closed), cta: Boolean(live.cta),
              ctd: Boolean(live.ctd), min_stay: live.min_stay, max_stay: live.max_stay,
            };
            const inSync = Boolean(shown) && Object.keys(expected).every((k) => shown[k] === expected[k]);
            return { date: d, expected, shown: shown || null, in_sync: inSync, blocked: u.blocked };
          }),
        });
      }
    }
    res.json({ channel: { code: channel.code, name: channel.name, kind: channel.kind }, dates, rate_plans: plans });
  });

  r.get('/sync/log', (req, res) => {
    res.json(db.prepare(`
      SELECT l.*, c.name AS channel_name FROM sync_log l JOIN channels c ON c.id = l.channel_id
      WHERE c.property_id = ? ORDER BY l.id DESC LIMIT 50
    `).all(req.property.id));
  });

  r.post('/sync/retry', manage, (req, res) => {
    const channelId = req.body?.channel ? getChannelByCode(db, req.property.id, req.body.channel).id : null;
    const requeued = retryFailed(db, req.property.id, channelId);
    engine.kick();
    res.json({ requeued });
  });

  r.post('/sync/run', manage, async (req, res) => {
    res.json({ results: await engine.kick() });
  });

  return r;
}

module.exports = { channelRoutes };
