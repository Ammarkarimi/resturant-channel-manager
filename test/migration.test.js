const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDb } = require('../src/db');
const { listBookings } = require('../src/bookings');

test('a database from the first version is upgraded without losing bookings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-migrate-'));
  const file = path.join(dir, 'v1.db');
  try {
    // The tables whose shape changed, as v1 created them.
    const v1 = new DatabaseSync(file);
    v1.exec(`
      CREATE TABLE property (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, currency TEXT NOT NULL);
      CREATE TABLE room_types (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        total_rooms INTEGER NOT NULL, base_rate REAL NOT NULL);
      CREATE TABLE channels (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, rate_markup_pct REAL NOT NULL DEFAULT 0,
        simulate_outage INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE channel_room_mappings (channel_id INTEGER NOT NULL, room_type_id INTEGER NOT NULL,
        external_room_id TEXT NOT NULL, PRIMARY KEY (channel_id, room_type_id), UNIQUE (channel_id, external_room_id));
      CREATE TABLE bookings (id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL, external_ref TEXT NOT NULL,
        room_type_id INTEGER NOT NULL, check_in TEXT NOT NULL, check_out TEXT NOT NULL, rooms INTEGER NOT NULL,
        guest_name TEXT, total REAL, status TEXT NOT NULL DEFAULT 'confirmed', overbooked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, UNIQUE (channel_id, external_ref));
      INSERT INTO property VALUES (1, 'Old Hotel', 'INR');
      INSERT INTO room_types VALUES (1, 'DLX', 'Deluxe Room', 10, 4500);
      INSERT INTO channels (id, code, name) VALUES (1, 'agoda', 'Agoda');
      INSERT INTO channel_room_mappings VALUES (1, 1, 'AGD-DLX');
      INSERT INTO bookings (channel_id, external_ref, room_type_id, check_in, check_out, rooms, guest_name, created_at)
        VALUES (1, 'AGD-1', 1, '2030-01-01', '2030-01-03', 2, 'Old Guest', '2026-01-01T00:00:00Z');
    `);
    v1.close();

    const db = openDb(file);
    const [b] = listBookings(db);
    assert.equal(b.external_ref, 'AGD-1');
    assert.equal(b.guest_name, 'Old Guest');
    assert.equal(b.rooms_summary, 'Deluxe Room ×2');
    assert.equal(db.prepare('SELECT kind FROM channels WHERE id = 1').get().kind, 'simulated');
    db.close();
    openDb(file).close(); // opening again is a no-op
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
