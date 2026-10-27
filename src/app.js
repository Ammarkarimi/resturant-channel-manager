const path = require('node:path');
const express = require('express');
const { SyncEngine } = require('./sync');
const { ChannexService } = require('./providers/channex');
const { ChannexError } = require('./providers/channex/client');
const { publicAuthRoutes, accountRoutes, userRoutes, requireUser } = require('./routes/auth');
const { hotelRoutes, propertyListRoutes } = require('./routes/hotel');
const { withProperty } = require('./permissions');
const { inventoryRoutes } = require('./routes/inventory');
const { channelRoutes } = require('./routes/channels');
const { bookingRoutes } = require('./routes/bookings');
const { channexRoutes, channexWebhook } = require('./routes/channex');
const { reportRoutes, groupRoutes } = require('./routes/reports');

// Sent by the dashboard on every change. Browsers won't let another site add
// a custom header without CORS permission, so this blocks cross-site
// request forgery on top of the SameSite session cookie.
const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'channel-manager';

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
      + "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  next();
}

function csrfCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.get(CSRF_HEADER) === CSRF_VALUE) return next();
  return res.status(403).json({ error: 'Missing request header' });
}

/**
 * @param {object} opts.channexClient        ChannexClient or null
 * @param {string} opts.channexWebhookSecret shared secret Channex sends in X-Channex-Webhook-Secret
 * @param {number} opts.channexPollMs        how often to check Channex for bookings
 * @param {*}      opts.trustProxy           Express "trust proxy" setting when behind a reverse proxy
 */
function createApp(db, {
  syncIntervalMs = 1000, channexClient = null, channexWebhookSecret = null, channexPollMs = 60_000, trustProxy = false,
} = {}) {
  const engine = new SyncEngine(db, { intervalMs: syncIntervalMs, providers: { channex: channexClient } });
  const channex = new ChannexService(db, channexClient, { onChange: () => engine.kick(), pollMs: channexPollMs });
  const ctx = { db, engine, channex, channexWebhookSecret };

  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', trustProxy);
  app.use(securityHeaders);
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', express.json({ limit: '1mb' }));

  // Public: health check, provider webhook, setup and login.
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.post('/api/providers/channex/webhook', channexWebhook(ctx));
  app.use('/api', csrfCheck);
  app.use('/api', publicAuthRoutes(ctx));

  // Everything else needs a logged-in user.
  app.use('/api', requireUser(ctx));
  for (const routes of [accountRoutes, userRoutes, propertyListRoutes, groupRoutes]) app.use('/api', routes(ctx));

  // From here on, requests are about one property (X-Property-Id header).
  app.use('/api', withProperty(db));
  for (const routes of [hotelRoutes, inventoryRoutes, channelRoutes, bookingRoutes, channexRoutes, reportRoutes]) {
    app.use('/api', routes(ctx));
  }

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    if (err instanceof ChannexError) return res.status(502).json({ error: err.message });
    if (!err.status) console.error(err);
    return res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
  });

  return { app, engine, channex };
}

module.exports = { createApp, CSRF_HEADER, CSRF_VALUE };
