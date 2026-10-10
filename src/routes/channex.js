const crypto = require('node:crypto');
const express = require('express');
const { logActivity } = require('../activity');

// Express 4 doesn't forward rejected promises to the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Channex calls this when a booking changes. It is not behind login; it is
 * checked against a shared secret instead. The payload only says "something
 * changed": the bookings themselves are fetched from Channex with our API
 * key, so a forged call can't inject a booking.
 */
function channexWebhook({ channex, channexWebhookSecret }) {
  return (req, res) => {
    if (!channexWebhookSecret) {
      return res.status(403).json({ error: 'Webhook disabled: set CHANNEX_WEBHOOK_SECRET' });
    }
    if (!safeEqual(req.get('x-channex-webhook-secret') || '', channexWebhookSecret)) {
      return res.status(401).json({ error: 'Bad webhook secret' });
    }
    channex.pull().catch((err) => console.error('Channex booking pull failed:', err.message));
    return res.json({ ok: true });
  };
}

function channexRoutes({ db, channex }) {
  const r = express.Router();

  r.get('/providers/channex', (req, res) => res.json(channex.status()));

  r.get('/providers/channex/properties', wrap(async (req, res) => {
    res.json(await channex.properties());
  }));

  r.get('/providers/channex/properties/:id/rooms', wrap(async (req, res) => {
    res.json(await channex.propertyRooms(req.params.id));
  }));

  r.post('/providers/channex/connect', wrap(async (req, res) => {
    const result = await channex.connect(req.body);
    logActivity(db, req.user, `Connected Channex property "${result.property.title}" (${result.mappings.length} room type(s) mapped)`);
    res.json(result);
  }));

  r.post('/providers/channex/disconnect', (req, res) => {
    const result = channex.disconnect();
    logActivity(db, req.user, 'Disconnected Channex');
    res.json(result);
  });

  // Check for new bookings now (also runs on a timer).
  r.post('/providers/channex/pull', wrap(async (req, res) => {
    res.json(await channex.pull());
  }));

  return r;
}

module.exports = { channexRoutes, channexWebhook };
