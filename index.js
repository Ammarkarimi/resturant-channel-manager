// Entry point for Vercel, which runs the Express app as a function.
//
// Vercel functions have no lasting disk, so this keeps the database in
// memory. With DEMO_MODE=1 (the hosted showcase) each new instance starts
// from the same ready-made demo hotel group. For a real hotel, run
// src/server.js (or the Docker image) on a server with a persistent disk.
require('express'); // lets Vercel recognise this file as an Express app
const { openDb } = require('./src/db');
const { createApp } = require('./src/app');
const { clientFromEnv } = require('./src/providers/channex/client');
const { seedShowcase, DEMO_ACCOUNTS } = require('./src/demo');

const demo = process.env.DEMO_MODE === '1';
const db = openDb(':memory:');
if (demo) seedShowcase(db);

const { app, engine } = createApp(db, {
  channexClient: clientFromEnv(),
  channexWebhookSecret: process.env.CHANNEX_WEBHOOK_SECRET || null,
  channexPollMs: 0,
  trustProxy: 1,
  demoAccounts: demo ? DEMO_ACCOUNTS : null,
  // Each Vercel instance has its own in-memory copy of the demo, so sessions must be checkable anywhere.
  sessionSecret: demo ? process.env.SESSION_SECRET || null : null,
});

engine.start();
engine.kick();

module.exports = app;
