// Current database layout (version 3): several properties, each with room
// types; each room type sold through one or more rate plans.
//
//   property ─┬─ room type ─┬─ rate plan (meal plan, occupancy prices, restrictions)
//             │             └─ inventory (rooms left per night)
//             └─ channel (an OTA, a provider such as Channex, or "direct")

const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  city TEXT,
  country TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_types (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  total_rooms INTEGER NOT NULL,
  max_adults INTEGER NOT NULL DEFAULT 2,
  max_children INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (property_id, code)
);

-- How a room is sold: e.g. "Room only (EP)", "With breakfast (CP)".
-- Prices here are the defaults for nights not priced individually. A
-- derived plan takes its prices from a parent plan, adjusted by a
-- percentage or an amount, so changing the parent moves both.
CREATE TABLE IF NOT EXISTS rate_plans (
  id INTEGER PRIMARY KEY,
  room_type_id INTEGER NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  meal_plan TEXT NOT NULL DEFAULT 'EP',      -- EP room only | CP breakfast | MAP half board | AP full board | OTHER
  rate_double REAL NOT NULL,                 -- the main price (2 adults)
  rate_single REAL,
  rate_triple REAL,
  extra_adult REAL,
  extra_child REAL,
  parent_id INTEGER REFERENCES rate_plans(id),
  derive_type TEXT,                          -- percent | amount
  derive_value REAL,
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (room_type_id, code)
);

-- Rooms left to sell per room type per night. Missing rows mean every room
-- is free. stop_sell closes the room on every plan and channel.
CREATE TABLE IF NOT EXISTS room_inventory (
  room_type_id INTEGER NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  available INTEGER NOT NULL,
  stop_sell INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_type_id, date)
);

-- Per-night prices and restrictions of a rate plan. A NULL price means "use
-- the plan's default". Missing rows mean defaults and no restrictions.
CREATE TABLE IF NOT EXISTS rate_calendar (
  rate_plan_id INTEGER NOT NULL REFERENCES rate_plans(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  rate_double REAL,
  rate_single REAL,
  rate_triple REAL,
  extra_adult REAL,
  extra_child REAL,
  stop_sell INTEGER NOT NULL DEFAULT 0,
  cta INTEGER NOT NULL DEFAULT 0,            -- closed to arrival
  ctd INTEGER NOT NULL DEFAULT 0,            -- closed to departure
  min_stay INTEGER NOT NULL DEFAULT 1,
  max_stay INTEGER,                          -- NULL = no maximum
  updated_at TEXT NOT NULL,
  PRIMARY KEY (rate_plan_id, date)
);

-- Automatic price changes as a room type fills up, e.g. +10% at 70% occupancy.
CREATE TABLE IF NOT EXISTS yield_rules (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  room_type_id INTEGER REFERENCES room_types(id) ON DELETE CASCADE,  -- NULL = all room types
  min_occupancy REAL NOT NULL,              -- percent, 0-100
  adjust_pct REAL NOT NULL,                 -- e.g. 10 = +10%, -5 = -5%
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- One row per connection: a single OTA (simulated in the demo), a provider
-- such as Channex that fans out to every OTA, or 'direct' for bookings taken
-- by phone or at the desk (never pushed anywhere).
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'simulated',   -- simulated | channex | direct
  config TEXT,                               -- JSON, provider settings
  enabled INTEGER NOT NULL DEFAULT 1,
  -- OTAs charge commission, so hotels usually sell a little higher there.
  rate_markup_pct REAL NOT NULL DEFAULT 0,
  -- Demo switch: makes the simulated OTA reject pushes so retries can be seen.
  simulate_outage INTEGER NOT NULL DEFAULT 0,
  UNIQUE (property_id, code)
);

-- Which room on the channel corresponds to which of our room types.
CREATE TABLE IF NOT EXISTS channel_room_mappings (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  room_type_id INTEGER NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
  external_room_id TEXT NOT NULL,
  PRIMARY KEY (channel_id, room_type_id),
  UNIQUE (channel_id, external_room_id)
);

-- Which of our rate plans the channel sells, and under which id.
CREATE TABLE IF NOT EXISTS channel_rate_plan_mappings (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  rate_plan_id INTEGER NOT NULL REFERENCES rate_plans(id) ON DELETE CASCADE,
  external_rate_plan_id TEXT NOT NULL,
  PRIMARY KEY (channel_id, rate_plan_id),
  UNIQUE (channel_id, external_rate_plan_id)
);

-- A room closed on one channel only (e.g. stop selling Suites on Agoda).
CREATE TABLE IF NOT EXISTS channel_blocks (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  room_type_id INTEGER NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  PRIMARY KEY (channel_id, room_type_id, date)
);

-- Room-nights that still need pushing to a channel. The payload (the room's
-- availability and all its rate plans) is read at send time, so a channel
-- always receives the latest values and repeated edits collapse into one push.
CREATE TABLE IF NOT EXISTS sync_queue (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  room_type_id INTEGER NOT NULL REFERENCES room_types(id) ON DELETE CASCADE,
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
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  cells INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL
);

-- What each (simulated) OTA is currently showing to guests, per rate plan.
CREATE TABLE IF NOT EXISTS channel_listings (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  external_room_id TEXT NOT NULL,
  external_rate_plan_id TEXT NOT NULL,
  date TEXT NOT NULL,
  available INTEGER NOT NULL,
  rate REAL NOT NULL,
  closed INTEGER NOT NULL,
  cta INTEGER NOT NULL DEFAULT 0,
  ctd INTEGER NOT NULL DEFAULT 0,
  min_stay INTEGER NOT NULL,
  max_stay INTEGER,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, external_rate_plan_id, date)
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id),
  external_ref TEXT NOT NULL,
  source TEXT,                               -- OTA name when it came through a provider
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  guest_name TEXT,
  guest_email TEXT,
  guest_phone TEXT,
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
  rate_plan_id INTEGER REFERENCES rate_plans(id) ON DELETE SET NULL,
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  rooms INTEGER NOT NULL,
  adults INTEGER,
  children INTEGER
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',        -- admin | manager | front_desk | viewer
  all_properties INTEGER NOT NULL DEFAULT 1, -- 0 = only those in user_properties
  totp_secret TEXT,                          -- set while 2FA is being set up or is on
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_properties (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, property_id)
);

-- Only a hash of the session token is stored, so a leaked database can't be
-- used to log in.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Password accepted, waiting for the two-factor code.
CREATE TABLE IF NOT EXISTS login_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL
);

-- Who changed what, for the "Recent changes" list.
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name TEXT,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Provider booking revisions already applied, so a re-delivered one is not
-- counted twice (e.g. when the acknowledgement to Channex failed).
CREATE TABLE IF NOT EXISTS provider_revisions (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, revision_id)
);

CREATE INDEX IF NOT EXISTS booking_lines_room ON booking_lines (room_type_id, check_in, check_out);
CREATE INDEX IF NOT EXISTS bookings_channel ON bookings (channel_id, status, check_out);
CREATE INDEX IF NOT EXISTS activity_property ON activity (property_id, id);
`;

module.exports = { SCHEMA, SCHEMA_VERSION };
