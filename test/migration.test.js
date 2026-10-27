const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDb } = require('../src/db');
const { listBookings } = require('../src/bookings');
const { upgradeToV2 } = require('../src/migrations/legacy');

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
    const [b] = listBookings(db, 1);
    assert.equal(b.external_ref, 'AGD-1');
    assert.equal(b.guest_name, 'Old Guest');
    assert.equal(b.rooms_summary, 'Deluxe Room ×2');
    assert.equal(db.prepare('SELECT kind FROM channels WHERE id = 1').get().kind, 'simulated');
    assert.equal(db.prepare('SELECT name FROM properties WHERE id = 1').get().name, 'Old Hotel');
    db.close();
    openDb(file).close(); // opening again is a no-op
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a single-hotel database (v2) becomes property 1 with rate plans, keeping rates, bookings and users', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-migrate-'));
  const file = path.join(dir, 'v2.db');
  const d = '2030-05-01';
  try {
    const v2 = new DatabaseSync(file);
    upgradeToV2(v2); // the v2 tables, empty
    v2.exec(`
      INSERT INTO property VALUES (1, 'Old Hotel', 'INR');
      INSERT INTO room_types (id, code, name, total_rooms, base_rate) VALUES (1, 'DLX', 'Deluxe', 10, 4500), (2, 'STE', 'Suite', 2, 9000);
      INSERT INTO channels (id, code, name, kind) VALUES (1, 'direct', 'Direct', 'direct'), (2, 'agoda', 'Agoda', 'simulated');
      INSERT INTO channels (id, code, name, kind, config) VALUES (3, 'channex', 'Channex', 'channex', '{"property_id":"cx-1"}');
      INSERT INTO channel_room_mappings VALUES (2, 1, 'AGD-DLX', NULL), (3, 1, 'cx-room', 'cx-plan');
      INSERT INTO inventory VALUES (1, '${d}', 7, 5555, 1, 2, 'now');
      INSERT INTO bookings (id, channel_id, external_ref, check_in, check_out, guest_name, status, created_at, updated_at)
        VALUES (1, 2, 'A-1', '${d}', '2030-05-03', 'Guest', 'confirmed', 'now', 'now');
      INSERT INTO booking_lines (booking_id, room_type_id, check_in, check_out, rooms) VALUES (1, 1, '${d}', '2030-05-03', 3);
      INSERT INTO users (email, name, password_hash, created_at) VALUES ('o@x.io', 'Owner', 'x', 'now');
      INSERT INTO activity (user_name, action, created_at) VALUES ('Owner', 'old change', 'now');
    `);
    v2.close();

    const db = openDb(file);
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    assert.equal(one('PRAGMA user_version').user_version, 3);
    assert.deepEqual({ ...one('SELECT property_id, code, total_rooms FROM room_types WHERE id = 1') }, { property_id: 1, code: 'DLX', total_rooms: 10 });
    assert.deepEqual(db.prepare('SELECT room_type_id, code, rate_double FROM rate_plans ORDER BY id').all().map((r) => ({ ...r })),
      [{ room_type_id: 1, code: 'EP', rate_double: 4500 }, { room_type_id: 2, code: 'EP', rate_double: 9000 }]);
    assert.deepEqual({ ...one('SELECT available, stop_sell FROM room_inventory WHERE room_type_id = 1 AND date = ?', d) }, { available: 7, stop_sell: 1 });
    assert.deepEqual({ ...one('SELECT rate_double, min_stay FROM rate_calendar WHERE rate_plan_id = 1 AND date = ?', d) }, { rate_double: 5555, min_stay: 2 });
    assert.equal(one("SELECT external_rate_plan_id AS x FROM channel_rate_plan_mappings WHERE channel_id = 2").x, 'AGD-DLX-EP');
    assert.equal(one("SELECT external_rate_plan_id AS x FROM channel_rate_plan_mappings WHERE channel_id = 3").x, 'cx-plan');
    assert.equal(listBookings(db, 1)[0].rooms_summary, 'Deluxe ×3');
    assert.deepEqual({ ...one('SELECT role, all_properties FROM users') }, { role: 'admin', all_properties: 1 });
    assert.equal(one('SELECT property_id FROM activity').property_id, 1);
    assert.ok(one("SELECT COUNT(*) AS n FROM sync_queue WHERE channel_id = 2").n > 0, 'channels get a fresh full sync');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
