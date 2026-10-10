const path = require('node:path');
const fs = require('node:fs');
const { openDb } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'channel-manager.db');

if (DB_FILE !== ':memory:') fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = openDb(DB_FILE);
const { app, engine } = createApp(db);

engine.start();
app.listen(PORT, () => {
  console.log(`Channel manager running at http://localhost:${PORT}`);
});
