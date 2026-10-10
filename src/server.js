const path = require('node:path');
const fs = require('node:fs');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { clientFromEnv } = require('./providers/channex/client');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'channel-manager.db');

if (DB_FILE !== ':memory:') fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = openDb(DB_FILE);
const channexClient = clientFromEnv();
const { app, engine, channex } = createApp(db, {
  channexClient,
  channexWebhookSecret: process.env.CHANNEX_WEBHOOK_SECRET || null,
  channexPollMs: (Number(process.env.CHANNEX_POLL_SECONDS) || 60) * 1000,
  // Behind a reverse proxy that terminates HTTPS (nginx, Caddy, a PaaS), set
  // TRUST_PROXY=1 so secure cookies and client IPs work.
  trustProxy: process.env.TRUST_PROXY ? (Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY) : false,
});

engine.start();
channex.start();
app.listen(PORT, () => {
  console.log(`Channel manager running at http://localhost:${PORT}`);
  console.log(channexClient
    ? `Channex: ${channexClient.environment} (${channexClient.baseUrl})`
    : 'Channex: not configured (set CHANNEX_API_KEY to connect real OTAs)');
});
