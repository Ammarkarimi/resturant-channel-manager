// v2 -> v3: one property becomes "properties", room rates move into rate
// plans, and every table gets the v3 constraints (per-property unique codes,
// cascading deletes). Runs with foreign keys switched off, inside the
// caller's transaction; the caller checks foreign keys afterwards.

const { SCHEMA } = require('../schema');

const exists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

/** The CREATE TABLE statement for one table from the v3 schema. */
function tableDDL(name) {
  const m = SCHEMA.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`));
  if (!m) throw new Error(`No table ${name} in schema`);
  return m[0];
}

const TABLES = [...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)].map((m) => m[1]);

/**
 * Recreate `name` with its v3 definition and copy the rows across: columns
 * both versions share are copied as they are, `overrides` supplies SQL
 * expressions for the rest.
 */
function rebuild(db, name, overrides = {}) {
  db.exec(tableDDL(name).replace(`CREATE TABLE IF NOT EXISTS ${name} (`, `CREATE TABLE ${name}_new (`));
  const oldCols = new Set(columns(db, name));
  const target = columns(db, `${name}_new`).filter((c) => c in overrides || oldCols.has(c));
  const source = target.map((c) => (c in overrides ? overrides[c] : c));
  db.exec(`INSERT INTO ${name}_new (${target.join(', ')}) SELECT ${source.join(', ')} FROM ${name}`);
  db.exec(`DROP TABLE ${name}`);
  db.exec(`ALTER TABLE ${name}_new RENAME TO ${name}`);
}

function upgradeV2toV3(db) {
  const now = new Date().toISOString();

  // The single hotel becomes property 1.
  db.exec(tableDDL('properties'));
  const old = db.prepare('SELECT name, currency FROM property WHERE id = 1').get();
  db.prepare('INSERT INTO properties (id, name, currency, created_at) VALUES (1, ?, ?, ?)')
    .run(old?.name || 'My Hotel', old?.currency || 'INR', now);
  db.exec('DROP TABLE property');

  // Each room's base rate becomes a "Room only" plan; nightly rates and
  // minimum stays move to that plan's calendar.
  db.exec(tableDDL('rate_plans'));
  db.prepare(`INSERT INTO rate_plans (room_type_id, code, name, meal_plan, rate_double, position, created_at)
              SELECT id, 'EP', 'Room only', 'EP', base_rate, 0, ? FROM room_types`).run(now);
  db.exec(tableDDL('room_inventory'));
  db.exec(tableDDL('rate_calendar'));
  if (exists(db, 'inventory')) {
    db.exec(`
      INSERT INTO room_inventory (room_type_id, date, available, stop_sell, updated_at)
      SELECT room_type_id, date, available, stop_sell, updated_at FROM inventory;
      INSERT INTO rate_calendar (rate_plan_id, date, rate_double, min_stay, updated_at)
      SELECT rp.id, i.date, i.rate, i.min_stay, i.updated_at
      FROM inventory i JOIN rate_plans rp ON rp.room_type_id = i.room_type_id;
      DROP TABLE inventory;
    `);
  }

  // Channel rate-plan ids now live in their own table. The demo OTAs sell
  // the new plan under "<room id>-EP".
  db.exec(tableDDL('channel_rate_plan_mappings'));
  db.exec(`
    INSERT INTO channel_rate_plan_mappings (channel_id, rate_plan_id, external_rate_plan_id)
    SELECT m.channel_id, rp.id,
           CASE WHEN c.kind = 'simulated' THEN m.external_room_id || '-EP' ELSE m.external_rate_plan_id END
    FROM channel_room_mappings m
    JOIN channels c ON c.id = m.channel_id
    JOIN rate_plans rp ON rp.room_type_id = m.room_type_id
    WHERE c.kind = 'simulated' OR m.external_rate_plan_id IS NOT NULL;
  `);

  // The demo listing cache is rebuilt by the full resync after upgrade.
  db.exec('DROP TABLE IF EXISTS channel_listings');

  const overrides = {
    room_types: { property_id: '1', position: 'id' },
    channels: { property_id: '1' },
    activity: { property_id: '1' },
  };
  for (const name of TABLES) {
    if (['properties', 'rate_plans', 'room_inventory', 'rate_calendar', 'channel_rate_plan_mappings'].includes(name)) continue;
    if (exists(db, name)) rebuild(db, name, overrides[name]);
  }
}

module.exports = { upgradeV2toV3 };
