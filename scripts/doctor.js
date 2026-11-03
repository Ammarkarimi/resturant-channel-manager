// Channex health check from the command line, e.g. from cron or CI:
//   npm run doctor            (exits 1 if any check fails)
const path = require('node:path');
const { openDb } = require('../src/db');
const { clientFromEnv } = require('../src/providers/channex/client');
const { ChannexService } = require('../src/providers/channex');

(async () => {
  const db = openDb(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'channel-manager.db'));
  const service = new ChannexService(db, clientFromEnv(), { pollMs: 0 });
  const props = db.prepare(`SELECT p.id, p.name FROM properties p JOIN channels c ON c.property_id = p.id
                            WHERE c.kind = 'channex' AND c.enabled = 1 ORDER BY p.id`).all();
  if (props.length === 0) {
    console.log('No property is connected to Channex.');
    process.exit(service.client ? 0 : 1);
  }
  let failed = false;
  for (const p of props) {
    const r = await service.doctor(p.id);
    console.log(`\n${p.name}`);
    for (const c of r.checks) console.log(`  ${c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗'} ${c.label}: ${c.detail}`);
    for (const m of r.mismatches.slice(0, 20)) console.log(`      ${m.date} ${m.what}: ours ${m.ours}, Channex ${m.theirs}`);
    if (!r.ok) failed = true;
  }
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err.message); process.exit(1); });
