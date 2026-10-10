const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { transaction } = require('./db');
const { getGrid, bulkUpdate } = require('./inventory');
const { receiveBooking, cancelBooking, listBookings, getChannelByCode } = require('./bookings');
const { SyncEngine, retryFailed, channelView } = require('./sync');
const { queueFullResync } = require('./queue');
const { badRequest } = require('./errors');
const { ChannexService } = require('./providers/channex');
const { ChannexError } = require('./providers/channex/client');
const { today } = require('./dates');

// Express 4 doesn't forward rejected promises to the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * @param {object} opts.channexClient        ChannexClient or null
 * @param {string} opts.channexWebhookSecret shared secret Channex sends in X-Channex-Webhook-Secret
 * @param {number} opts.channexPollMs        how often to check Channex for bookings
 */
function createApp(db, {
  syncIntervalMs = 1000, channexClient = null, channexWebhookSecret = null, channexPollMs = 60_000,
} = {}) {
  const engine = new SyncEngine(db, { intervalMs: syncIntervalMs, providers: { channex: channexClient } });
  const channex = new ChannexService(db, channexClient, { onChange: () => engine.kick(), pollMs: channexPollMs });
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/property', (req, res) => {
    res.json(db.prepare('SELECT name, currency FROM property WHERE id = 1').get());
  });

  // ---- Inventory: the single place rates and availability are edited ----

  app.get('/api/inventory', (req, res) => {
    const start = req.query.start || today();
    const days = req.query.days ? Number(req.query.days) : 14;
    res.json(getGrid(db, start, days));
  });

  app.post('/api/inventory/bulk', (req, res) => {
    const result = bulkUpdate(db, req.body);
    engine.kick();
    res.json(result);
  });

  // ---- Channels (OTAs) ----

  app.get('/api/channels', (req, res) => {
    const channels = db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM sync_queue q WHERE q.channel_id = c.id AND q.status = 'pending') AS pending,
        (SELECT COUNT(*) FROM sync_queue q WHERE q.channel_id = c.id AND q.status = 'failed') AS failed,
        (SELECT MAX(created_at) FROM sync_log l WHERE l.channel_id = c.id AND l.ok = 1) AS last_success_at,
        (SELECT last_error FROM sync_queue q WHERE q.channel_id = c.id AND q.last_error IS NOT NULL LIMIT 1) AS last_error
      FROM channels c ORDER BY c.id
    `).all();
    res.json(channels.map((c) => ({
      ...c, enabled: Boolean(c.enabled), simulate_outage: Boolean(c.simulate_outage),
    })));
  });

  app.patch('/api/channels/:code', (req, res) => {
    const channel = getChannelByCode(db, req.params.code);
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
    engine.kick();
    res.json(db.prepare('SELECT * FROM channels WHERE id = ?').get(channel.id));
  });

  // What the OTA is currently showing vs. what it should be showing.
  app.get('/api/channels/:code/listings', (req, res) => {
    const channel = getChannelByCode(db, req.params.code);
    const start = req.query.start || today();
    const days = req.query.days ? Number(req.query.days) : 14;
    const grid = getGrid(db, start, days);
    const listing = db.prepare(
      'SELECT * FROM channel_listings WHERE channel_id = ? AND external_room_id = ? AND date = ?'
    );
    const mappings = db.prepare('SELECT * FROM channel_room_mappings WHERE channel_id = ?').all(channel.id);
    res.json({
      channel: { code: channel.code, name: channel.name },
      dates: grid.dates,
      rooms: mappings.map((m) => {
        const rt = grid.room_types.find((r) => r.id === m.room_type_id);
        return {
          external_room_id: m.external_room_id,
          room_type_name: rt.name,
          cells: rt.cells.map((cell) => {
            const expected = channelView(cell, channel);
            const live = listing.get(channel.id, m.external_room_id, cell.date);
            const shown = live && {
              available: live.available, rate: live.rate, closed: Boolean(live.closed), min_stay: live.min_stay,
            };
            const inSync = Boolean(shown) && shown.available === expected.available
              && shown.rate === expected.rate && shown.closed === expected.closed
              && shown.min_stay === expected.min_stay;
            return { date: cell.date, expected, shown: shown || null, in_sync: inSync };
          }),
        };
      }),
    });
  });

  // ---- Bookings: OTAs call this when a guest books or cancels ----

  app.post('/api/channels/:code/bookings', (req, res) => {
    const result = receiveBooking(db, req.params.code, req.body);
    engine.kick();
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  app.post('/api/channels/:code/bookings/:ref/cancel', (req, res) => {
    const result = cancelBooking(db, req.params.code, req.params.ref);
    engine.kick();
    res.json(result);
  });

  app.get('/api/bookings', (req, res) => res.json(listBookings(db)));

  // ---- Connectivity provider: Channex ----

  app.get('/api/providers/channex', (req, res) => res.json(channex.status()));

  app.get('/api/providers/channex/properties', wrap(async (req, res) => {
    res.json(await channex.properties());
  }));

  app.get('/api/providers/channex/properties/:id/rooms', wrap(async (req, res) => {
    res.json(await channex.propertyRooms(req.params.id));
  }));

  app.post('/api/providers/channex/connect', wrap(async (req, res) => {
    res.json(await channex.connect(req.body));
  }));

  app.post('/api/providers/channex/disconnect', (req, res) => res.json(channex.disconnect()));

  // Check for new bookings now (also runs on a timer).
  app.post('/api/providers/channex/pull', wrap(async (req, res) => {
    res.json(await channex.pull());
  }));

  // Channex calls this when a booking changes. The payload only says
  // "something changed"; the bookings themselves are fetched from Channex
  // with our API key, so a forged call can't inject a booking.
  app.post('/api/providers/channex/webhook', (req, res) => {
    if (!channexWebhookSecret) {
      return res.status(403).json({ error: 'Webhook disabled: set CHANNEX_WEBHOOK_SECRET' });
    }
    if (!safeEqual(req.get('x-channex-webhook-secret') || '', channexWebhookSecret)) {
      return res.status(401).json({ error: 'Bad webhook secret' });
    }
    channex.pull().catch((err) => console.error('Channex booking pull failed:', err.message));
    return res.json({ ok: true });
  });

  // ---- Sync ----

  app.get('/api/sync/log', (req, res) => {
    res.json(db.prepare(`
      SELECT l.*, c.name AS channel_name FROM sync_log l JOIN channels c ON c.id = l.channel_id
      ORDER BY l.id DESC LIMIT 50
    `).all());
  });

  app.post('/api/sync/retry', (req, res) => {
    const channelId = req.body?.channel ? getChannelByCode(db, req.body.channel).id : null;
    const requeued = retryFailed(db, channelId);
    engine.kick();
    res.json({ requeued });
  });

  app.post('/api/sync/run', async (req, res) => {
    res.json({ results: await engine.kick() });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (err instanceof ChannexError) return res.status(502).json({ error: err.message });
    if (!err.status) console.error(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
  });

  return { app, engine, channex };
}

module.exports = { createApp };
