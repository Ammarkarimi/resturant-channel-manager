const { DatabaseSync } = require('node:sqlite');
const { SCHEMA, SCHEMA_VERSION } = require('./schema');
const { upgradeToV2 } = require('./migrations/legacy');
const { upgradeV2toV3 } = require('./migrations/v3');
const { queueFullResync } = require('./queue');

const tableExists = (db, name) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  // Foreign keys must be off while tables are rebuilt by an upgrade; they
  // are checked explicitly before committing.
  db.exec('PRAGMA foreign_keys = OFF;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  // Versions before 3 never set user_version; they are recognised by their
  // single-hotel "property" table.
  const upgrading = version < SCHEMA_VERSION && tableExists(db, 'property');
  transaction(db, () => {
    if (upgrading) {
      upgradeToV2(db);
      upgradeV2toV3(db);
    }
    db.exec(SCHEMA);
    const broken = db.prepare('PRAGMA foreign_key_check').all();
    if (broken.length) throw new Error(`Database upgrade left broken references: ${JSON.stringify(broken.slice(0, 5))}`);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    for (const { id } of db.prepare('SELECT id FROM properties').all()) ensureDirectChannel(db, id);
  });
  db.exec('PRAGMA foreign_keys = ON;');
  if (upgrading) {
    // The way rates are sent changed; give every channel a fresh copy.
    transaction(db, () => {
      for (const c of db.prepare("SELECT id FROM channels WHERE enabled = 1 AND kind != 'direct'").all()) queueFullResync(db, c.id);
    });
  }
  return db;
}

/** Bookings taken by phone or at the desk. Never pushed anywhere itself; it only takes rooms out of what the OTAs can sell. */
function ensureDirectChannel(db, propertyId) {
  db.prepare(`INSERT OR IGNORE INTO channels (property_id, code, name, kind, enabled)
              VALUES (?, 'direct', 'Direct / walk-in', 'direct', 1)`).run(propertyId);
}

function createProperty(db, { name, currency, city = null, country = null }) {
  const id = Number(db.prepare('INSERT INTO properties (name, currency, city, country, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, currency, city, country, new Date().toISOString()).lastInsertRowid);
  ensureDirectChannel(db, id);
  return id;
}

const SEED_ROOMS = [
  {
    code: 'DLX', name: 'Deluxe Room', total_rooms: 10, max_adults: 3,
    plans: [
      { code: 'EP', name: 'Room only', meal_plan: 'EP', rate_double: 4500, rate_single: 4000, rate_triple: 5300, extra_adult: 900, extra_child: 500 },
      { code: 'CP', name: 'With breakfast', meal_plan: 'CP', parent: 'EP', derive_type: 'amount', derive_value: 600 },
    ],
  },
  {
    code: 'EXE', name: 'Executive Room', total_rooms: 6, max_adults: 3,
    plans: [
      { code: 'EP', name: 'Room only', meal_plan: 'EP', rate_double: 6500, rate_single: 6000, extra_adult: 1100, extra_child: 600 },
      { code: 'CP', name: 'With breakfast', meal_plan: 'CP', parent: 'EP', derive_type: 'amount', derive_value: 700 },
    ],
  },
  {
    code: 'STE', name: 'Suite', total_rooms: 2, max_adults: 4,
    plans: [
      { code: 'CP', name: 'With breakfast', meal_plan: 'CP', rate_double: 12000, extra_adult: 1500, extra_child: 800 },
      { code: 'MAP', name: 'Breakfast and dinner', meal_plan: 'MAP', parent: 'CP', derive_type: 'percent', derive_value: 15 },
    ],
  },
];

const SEED_CHANNELS = [
  { code: 'booking_com', name: 'Booking.com', prefix: 'BDC', markup: 15 },
  { code: 'agoda', name: 'Agoda', prefix: 'AGD', markup: 15 },
  { code: 'makemytrip', name: 'MakeMyTrip', prefix: 'MMT', markup: 12 },
  { code: 'expedia', name: 'Expedia', prefix: 'EXP', markup: 18 },
];

/** Fill an empty property with sample rooms, rate plans and four simulated OTAs to try things out. */
function seedDemo(db, propertyId) {
  if (db.prepare('SELECT COUNT(*) AS n FROM room_types WHERE property_id = ?').get(propertyId).n > 0) return;
  const now = new Date().toISOString();
  const insRoom = db.prepare(`INSERT INTO room_types (property_id, code, name, total_rooms, max_adults, position)
                              VALUES (?, ?, ?, ?, ?, ?)`);
  const insPlan = db.prepare(`
    INSERT INTO rate_plans (room_type_id, code, name, meal_plan, rate_double, rate_single, rate_triple, extra_adult, extra_child,
                            parent_id, derive_type, derive_value, position, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const rooms = SEED_ROOMS.map((r, i) => {
    const id = Number(insRoom.run(propertyId, r.code, r.name, r.total_rooms, r.max_adults, i).lastInsertRowid);
    const planIds = {};
    r.plans.forEach((p, j) => {
      const parent = p.parent ? planIds[p.parent] : null;
      planIds[p.code] = Number(insPlan.run(id, p.code, p.name, p.meal_plan, p.rate_double ?? 0, p.rate_single ?? null,
        p.rate_triple ?? null, p.extra_adult ?? null, p.extra_child ?? null, parent, p.derive_type ?? null,
        p.derive_value ?? null, j, now).lastInsertRowid);
    });
    return { ...r, id, planIds };
  });

  const insChannel = db.prepare(`INSERT INTO channels (property_id, code, name, kind, rate_markup_pct)
                                 VALUES (?, ?, ?, 'simulated', ?)`);
  const insRoomMap = db.prepare('INSERT INTO channel_room_mappings (channel_id, room_type_id, external_room_id) VALUES (?, ?, ?)');
  const insPlanMap = db.prepare('INSERT INTO channel_rate_plan_mappings (channel_id, rate_plan_id, external_rate_plan_id) VALUES (?, ?, ?)');
  for (const c of SEED_CHANNELS) {
    if (db.prepare('SELECT 1 FROM channels WHERE property_id = ? AND code = ?').get(propertyId, c.code)) continue;
    const channelId = Number(insChannel.run(propertyId, c.code, c.name, c.markup).lastInsertRowid);
    for (const r of rooms) {
      insRoomMap.run(channelId, r.id, `${c.prefix}-${r.code}`);
      for (const [code, planId] of Object.entries(r.planIds)) insPlanMap.run(channelId, planId, `${c.prefix}-${r.code}-${code}`);
    }
    // Give every OTA the starting rates and availability.
    queueFullResync(db, channelId);
  }
}

const depth = new WeakMap();

// Run fn atomically. Nested calls join the outermost transaction.
function transaction(db, fn) {
  const level = depth.get(db) || 0;
  if (level > 0) return fn();
  db.exec('BEGIN');
  depth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth.set(db, 0);
  }
}

module.exports = { openDb, transaction, seedDemo, createProperty, ensureDirectChannel };
