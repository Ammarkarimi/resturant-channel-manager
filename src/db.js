const { DatabaseSync } = require('node:sqlite');
const { queueFullResync } = require('./queue');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS property (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  currency TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_types (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  total_rooms INTEGER NOT NULL,
  base_rate REAL NOT NULL
);

-- One row per OTA the hotel is listed on.
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- OTAs charge commission, so hotels usually sell a little higher there.
  rate_markup_pct REAL NOT NULL DEFAULT 0,
  -- Demo switch: makes the simulated OTA reject pushes so retries can be seen.
  simulate_outage INTEGER NOT NULL DEFAULT 0
);

-- Which room on the OTA corresponds to which of our room types.
CREATE TABLE IF NOT EXISTS channel_room_mappings (
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  room_type_id INTEGER NOT NULL REFERENCES room_types(id),
  external_room_id TEXT NOT NULL,
  PRIMARY KEY (channel_id, room_type_id),
  UNIQUE (channel_id, external_room_id)
);

-- The single source of truth: what we sell, per room type per night.
-- Missing rows mean "default": all rooms free at the base rate.
CREATE TABLE IF NOT EXISTS inventory (
  room_type_id INTEGER NOT NULL REFERENCES room_types(id),
  date TEXT NOT NULL,
  available INTEGER NOT NULL,
  rate REAL NOT NULL,
  stop_sell INTEGER NOT NULL DEFAULT 0,
  min_stay INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_type_id, date)
);

-- Cells that still need pushing to a channel. The payload is read from
-- inventory at send time, so a channel always receives the latest values
-- and repeated edits to the same cell collapse into one push.
CREATE TABLE IF NOT EXISTS sync_queue (
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  room_type_id INTEGER NOT NULL REFERENCES room_types(id),
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  PRIMARY KEY (channel_id, room_type_id, date)
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  cells INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL
);

-- What each (simulated) OTA is currently showing to guests.
CREATE TABLE IF NOT EXISTS channel_listings (
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  external_room_id TEXT NOT NULL,
  date TEXT NOT NULL,
  available INTEGER NOT NULL,
  rate REAL NOT NULL,
  closed INTEGER NOT NULL,
  min_stay INTEGER NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, external_room_id, date)
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  external_ref TEXT NOT NULL,
  room_type_id INTEGER NOT NULL REFERENCES room_types(id),
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  rooms INTEGER NOT NULL,
  guest_name TEXT,
  total REAL,
  status TEXT NOT NULL DEFAULT 'confirmed',  -- confirmed | cancelled
  overbooked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (channel_id, external_ref)
);
`;

const SEED_ROOMS = [
  { code: 'DLX', name: 'Deluxe Room', total_rooms: 10, base_rate: 4500 },
  { code: 'EXE', name: 'Executive Room', total_rooms: 6, base_rate: 6500 },
  { code: 'STE', name: 'Suite', total_rooms: 2, base_rate: 12000 },
];

const SEED_CHANNELS = [
  { code: 'booking_com', name: 'Booking.com', prefix: 'BDC', markup: 15 },
  { code: 'agoda', name: 'Agoda', prefix: 'AGD', markup: 15 },
  { code: 'makemytrip', name: 'MakeMyTrip', prefix: 'MMT', markup: 12 },
  { code: 'expedia', name: 'Expedia', prefix: 'EXP', markup: 18 },
];

function seed(db) {
  const hasRooms = db.prepare('SELECT COUNT(*) AS n FROM room_types').get().n > 0;
  if (hasRooms) return;

  db.prepare('INSERT INTO property (id, name, currency) VALUES (1, ?, ?)').run('Demo Hotel', 'INR');
  const insRoom = db.prepare(
    'INSERT INTO room_types (code, name, total_rooms, base_rate) VALUES (?, ?, ?, ?)'
  );
  const insChannel = db.prepare(
    'INSERT INTO channels (code, name, rate_markup_pct) VALUES (?, ?, ?)'
  );
  const insMap = db.prepare(
    'INSERT INTO channel_room_mappings (channel_id, room_type_id, external_room_id) VALUES (?, ?, ?)'
  );

  const roomIds = SEED_ROOMS.map(
    (r) => ({ ...r, id: Number(insRoom.run(r.code, r.name, r.total_rooms, r.base_rate).lastInsertRowid) })
  );
  for (const c of SEED_CHANNELS) {
    const channelId = Number(insChannel.run(c.code, c.name, c.markup).lastInsertRowid);
    for (const r of roomIds) insMap.run(channelId, r.id, `${c.prefix}-${r.code}`);
  }
  // Give every OTA the starting rates and availability.
  for (const { id } of db.prepare('SELECT id FROM channels').all()) queueFullResync(db, id);
}

function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  transaction(db, () => seed(db));
  return db;
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, transaction };
