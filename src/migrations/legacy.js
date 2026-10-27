// The schema as it was before multi-property and rate plans (version 2),
// plus the steps that brought version-1 databases up to it. Kept unchanged
// so any older database can be walked forward: v1 -> v2 here, then v2 -> v3
// in ./v3.js.

const SCHEMA_V2 = `
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

-- One row per connection: either a single OTA, or a connectivity provider
-- (kind = 'channex') that fans out to every OTA connected inside it.
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'simulated',   -- simulated | channex | direct
  config TEXT,                               -- JSON, provider settings
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
  -- Providers like Channex price per rate plan rather than per room.
  external_rate_plan_id TEXT,
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
  source TEXT,                               -- OTA name when it came through a provider
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  guest_name TEXT,
  total REAL,
  currency TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',  -- confirmed | cancelled
  overbooked INTEGER NOT NULL DEFAULT 0,
  needs_attention TEXT,                      -- e.g. a room we couldn't map
  notes TEXT,
  handled_at TEXT,                           -- staff dealt with the overbooking / attention flag
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (channel_id, external_ref)
);

-- The rooms a booking holds. A booking can span several room types.
CREATE TABLE IF NOT EXISTS booking_lines (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  room_type_id INTEGER NOT NULL REFERENCES room_types(id),
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  rooms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Only a hash of the session token is stored, so a leaked database can't be
-- used to log in.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Who changed what, for the "Recent changes" list.
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name TEXT,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Provider booking revisions already applied, so a re-delivered one is not
-- counted twice (e.g. when the acknowledgement to Channex failed).
CREATE TABLE IF NOT EXISTS provider_revisions (
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  revision_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, revision_id)
);
`;

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

// Bring a database created by an earlier version up to the current schema.
function migrateBefore(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  // v1 stored one room type per booking; move it aside and copy it into lines below.
  if (tables.includes('bookings') && columns(db, 'bookings').includes('room_type_id')) {
    db.exec('ALTER TABLE bookings RENAME TO bookings_v1');
  }
}

function migrateAfter(db) {
  const addColumn = (table, name, def) => {
    if (!columns(db, table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
  };
  addColumn('channels', 'kind', "TEXT NOT NULL DEFAULT 'simulated'");
  addColumn('channels', 'config', 'TEXT');
  addColumn('channel_room_mappings', 'external_rate_plan_id', 'TEXT');
  addColumn('bookings', 'notes', 'TEXT');
  addColumn('bookings', 'handled_at', 'TEXT');

  const hasV1 = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bookings_v1'").get();
  if (hasV1) {
    db.exec(`
      INSERT INTO bookings (id, channel_id, external_ref, check_in, check_out, guest_name, total,
                            status, overbooked, created_at, updated_at)
      SELECT id, channel_id, external_ref, check_in, check_out, guest_name, total,
             status, overbooked, created_at, created_at FROM bookings_v1;
      INSERT INTO booking_lines (booking_id, room_type_id, check_in, check_out, rooms)
      SELECT id, room_type_id, check_in, check_out, rooms FROM bookings_v1;
      DROP TABLE bookings_v1;
    `);
  }
}

/** Bring a v1 or v2 database to the v2 layout. */
function upgradeToV2(db) {
  migrateBefore(db);
  db.exec(SCHEMA_V2);
  migrateAfter(db);
}

module.exports = { upgradeToV2 };
