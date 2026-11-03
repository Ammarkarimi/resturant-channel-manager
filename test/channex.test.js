const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { ChannexClient } = require('../src/providers/channex/client');
const { today, addDays } = require('../src/dates');

const { fakeChannex, API_KEY } = require('./fake-channex');

const SECRET = 'hook-secret';

// ---------- Harness ----------

let fake; let fakeServer; let db; let engine; let api; let close;

const listen = (app) => new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });

beforeEach(async () => {
  fake = fakeChannex();
  fakeServer = await listen(fake.app);
  const client = new ChannexClient({
    apiKey: API_KEY, baseUrl: `http://127.0.0.1:${fakeServer.address().port}/api/v1`, minIntervalMs: 200,
  });
  ({ db, engine, api, close } = await startApp({ channexClient: client, channexWebhookSecret: SECRET, channexPollMs: 0 }));
});

afterEach(async () => {
  await close();
  await new Promise((r) => fakeServer.close(r));
});

// Demo hotel plans: 1 Deluxe EP, 2 Deluxe CP, 3 Executive EP, 4 Executive CP, 5 Suite CP, 6 Suite MAP.
const CONNECT = {
  property_id: 'prop-1',
  rooms: [
    { room_type_id: 1, channex_room_type_id: 'rt-dlx' },
    { room_type_id: 2, channex_room_type_id: 'rt-exe' },
    { room_type_id: 3, channex_room_type_id: 'rt-ste' },
  ],
  rate_plans: [
    { rate_plan_id: 1, channex_rate_plan_id: 'rp-dlx' },
    { rate_plan_id: 3, channex_rate_plan_id: 'rp-exe' },
    { rate_plan_id: 5, channex_rate_plan_id: 'rp-ste' },
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run sync passes until Channex has nothing pending (respecting the push interval). */
async function drain() {
  await engine.kick();
  for (let i = 0; i < 20; i += 1) {
    const pending = db.prepare(`SELECT COUNT(*) AS n FROM sync_queue q JOIN channels c ON c.id = q.channel_id
                                WHERE c.kind = 'channex' AND q.status = 'pending'`).get().n;
    if (pending === 0) return;
    await sleep(220);
    await engine.runOnce();
  }
  throw new Error('sync did not drain');
}

async function connect() {
  const r = await api('POST', '/api/providers/channex/connect', CONNECT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await drain();
  fake.state.calls.length = 0;
  await sleep(220); // let the push interval after the full sync pass
  return r.body;
}

const D0 = addDays(today(), 5);
const avail = (rtId, date) => db.prepare('SELECT available FROM room_inventory WHERE room_type_id = ? AND date = ?').get(rtId, date)?.available;

// ---------- Tests ----------

test('lists Channex properties and rooms (across pages), flagging unusable rate plans', async () => {
  const props = await api('GET', '/api/providers/channex/properties');
  assert.deepEqual(props.body.map((p) => p.id), ['prop-1']);
  const rooms = await api('GET', '/api/providers/channex/properties/prop-1/rooms');
  assert.equal(rooms.body.room_types.length, 3);
  assert.equal(rooms.body.rate_plans.length, 4);
  assert.equal(rooms.body.rate_plans.find((p) => p.id === 'rp-ste-pp').usable, false);
});

test('connecting sends one 500-day full sync in exactly two calls and turns off the demo OTAs', async () => {
  const r = await api('POST', '/api/providers/channex/connect', CONNECT);
  assert.equal(r.status, 200);
  assert.equal(r.body.connected, true);
  assert.equal(r.body.property.title, 'Test Hotel');
  await drain();

  assert.deepEqual(fake.state.calls.map((c) => c.kind), ['availability', 'restrictions']);
  const [av, rs] = fake.state.calls;
  assert.deepEqual(av.values.find((v) => v.room_type_id === 'rt-ste'), {
    property_id: 'prop-1', room_type_id: 'rt-ste', date_from: today(), date_to: addDays(today(), 499), availability: 2,
  });
  assert.equal(av.values.length, 3);
  assert.deepEqual(rs.values.find((v) => v.rate_plan_id === 'rp-dlx'), {
    property_id: 'prop-1', rate_plan_id: 'rp-dlx', date_from: today(), date_to: addDays(today(), 499),
    rate: '4500.00', stop_sell: false, closed_to_arrival: false, closed_to_departure: false, min_stay: 1, max_stay: 0,
  });
  assert.equal(rs.values.length, 3, 'only mapped rate plans are sent');

  const channels = (await api('GET', '/api/channels')).body;
  for (const c of channels.filter((x) => x.kind === 'simulated')) assert.equal(c.enabled, false, c.code);
});

test('a bulk change sends only the changed nights, merged into ranges, in one call per endpoint', async () => {
  await connect();
  await api('POST', '/api/inventory/bulk', {
    room_type_ids: [1], start_date: D0, end_date: addDays(D0, 2), set: { rate: 5000, stop_sell: true, min_stay: 2 },
  });
  await drain();
  assert.deepEqual(fake.state.calls.map((c) => c.kind), ['availability', 'restrictions']);
  assert.deepEqual(fake.state.calls[1].values, [{
    property_id: 'prop-1', rate_plan_id: 'rp-dlx', date_from: D0, date_to: addDays(D0, 2),
    rate: '5000.00', stop_sell: true, closed_to_arrival: false, closed_to_departure: false, min_stay: 2, max_stay: 0,
  }]);
});

test('edits made in quick succession are spaced out and combined', async () => {
  await connect();
  await api('POST', '/api/inventory/bulk', { room_type_ids: [1], start_date: D0, end_date: D0, set: { rate: 5000 } });
  await engine.kick();
  assert.equal(fake.state.calls.length, 2);

  // Within the push interval: nothing is sent yet.
  await api('POST', '/api/inventory/bulk', { room_type_ids: [2], start_date: D0, end_date: D0, set: { rate: 7000 } });
  await api('POST', '/api/inventory/bulk', { room_type_ids: [3], start_date: D0, end_date: D0, set: { rate: 13000 } });
  await engine.runOnce();
  assert.equal(fake.state.calls.length, 2);

  await drain();
  assert.equal(fake.state.calls.length, 4, 'both later edits went out together');
  assert.deepEqual(fake.state.calls[3].values.map((v) => [v.rate_plan_id, v.rate]).sort(),
    [['rp-exe', '7000.00'], ['rp-ste', '13000.00']]);
});

test('a 429 pauses Channex pushes, then they resume', async () => {
  await connect();
  fake.state.failNext.push(429);
  await api('POST', '/api/inventory/bulk', { room_type_ids: [1], start_date: D0, end_date: D0, set: { available: 3 } });
  await engine.kick();

  const ch = (await api('GET', '/api/channels')).body.find((c) => c.kind === 'channex');
  assert.equal(ch.pending, 1);
  assert.match(ch.last_error, /rate limit/);

  await sleep(250);
  await engine.runOnce();
  assert.equal(fake.state.calls.length, 0, 'still paused');

  // Fast-forward past the pause.
  engine.pausedUntil.clear();
  db.prepare("UPDATE sync_queue SET next_attempt_at = '2000-01-01'").run();
  await drain();
  assert.equal(fake.state.calls[0].values[0].availability, 3);
});

test('values Channex rejects (200 with warnings) are treated as failures', async () => {
  await connect();
  fake.state.warnNext = true;
  await api('POST', '/api/inventory/bulk', { room_type_ids: [1], start_date: D0, end_date: D0, set: { rate: 5000 } });
  await engine.kick();
  const ch = (await api('GET', '/api/channels')).body.find((c) => c.kind === 'channex');
  assert.equal(ch.pending, 1);
  assert.match(ch.last_error, /rejected 1 restrictions/);
});

test('bookings from Channex: new, modified and cancelled keep the calendar right, and each is acknowledged', async () => {
  await connect();
  const revision = (id, status, checkIn, checkOut) => ({
    id,
    acked: false,
    attributes: {
      booking_id: 'bk-1', status, ota_name: 'Booking.com', ota_reservation_code: '4455',
      arrival_date: checkIn, departure_date: checkOut, amount: '9000.00', currency: 'INR',
      customer: { name: 'Asha', surname: 'Rao' },
      rooms: [
        { room_type_id: 'rt-dlx', rate_plan_id: 'rp-dlx', checkin_date: checkIn, checkout_date: checkOut },
        { room_type_id: 'rt-dlx', rate_plan_id: 'rp-dlx', checkin_date: checkIn, checkout_date: checkOut },
      ],
    },
  });

  fake.state.revisions.push(revision('rev-1', 'new', D0, addDays(D0, 2)));
  let pulled = await api('POST', '/api/providers/channex/pull');
  assert.deepEqual(pulled.body, { processed: 1, failed: 0 });
  assert.equal(fake.state.revisions[0].acked, true);
  assert.deepEqual([avail(1, D0), avail(1, addDays(D0, 1)), avail(1, addDays(D0, 2))], [8, 8, undefined]);

  const list = (await api('GET', '/api/bookings')).body;
  const detail = (await api('GET', `/api/bookings/${list[0].id}`)).body;
  assert.deepEqual(detail.lines.map((l) => l.rate_plan_name), ['Room only', 'Room only'], 'Channex rate plan mapped back to ours');
  assert.equal(list[0].source, 'Booking.com');
  assert.equal(list[0].guest_name, 'Asha Rao');
  assert.equal(list[0].rooms_summary, 'Deluxe Room ×2');

  // The new availability goes back out to Channex (and from there to every OTA).
  await drain();
  const sent = fake.state.calls.find((c) => c.kind === 'availability').values;
  assert.deepEqual(sent, [{ property_id: 'prop-1', room_type_id: 'rt-dlx', date_from: D0, date_to: addDays(D0, 1), availability: 8 }]);

  // Guest moves the stay one night later.
  fake.state.revisions.push(revision('rev-2', 'modified', addDays(D0, 1), addDays(D0, 3)));
  await api('POST', '/api/providers/channex/pull');
  assert.deepEqual([avail(1, D0), avail(1, addDays(D0, 1)), avail(1, addDays(D0, 2))], [10, 8, 8]);

  // Cancelled; the ack fails the first time, so Channex serves it again.
  fake.state.failAckOnce = true;
  fake.state.revisions.push(revision('rev-3', 'cancelled', addDays(D0, 1), addDays(D0, 3)));
  pulled = await api('POST', '/api/providers/channex/pull');
  assert.equal(pulled.status, 502);
  pulled = await api('POST', '/api/providers/channex/pull');
  assert.deepEqual(pulled.body, { processed: 0, failed: 0 }, 'already applied, only acknowledged');
  assert.equal(fake.state.revisions[2].acked, true);
  assert.deepEqual([avail(1, D0), avail(1, addDays(D0, 1)), avail(1, addDays(D0, 2))], [10, 10, 10]);
  assert.equal((await api('GET', '/api/bookings')).body[0].status, 'cancelled');
});

test('a booking for a room we have not mapped is kept, flagged and acknowledged', async () => {
  await connect();
  fake.state.revisions.push({
    id: 'rev-x', acked: false,
    attributes: {
      booking_id: 'bk-x', status: 'new', ota_name: 'Agoda', arrival_date: D0, departure_date: addDays(D0, 1),
      rooms: [{ room_type_id: null, rate_plan_id: null, checkin_date: D0, checkout_date: addDays(D0, 1) }],
    },
  });
  await api('POST', '/api/providers/channex/pull');
  const [b] = (await api('GET', '/api/bookings')).body;
  assert.match(b.needs_attention, /not mapped/);
  assert.equal(fake.state.revisions[0].acked, true);
});

test('webhook needs the shared secret and then fetches bookings', async () => {
  await connect();
  assert.equal((await api('POST', '/api/providers/channex/webhook', {})).status, 401);
  assert.equal((await api('POST', '/api/providers/channex/webhook', {}, { 'x-channex-webhook-secret': 'nope' })).status, 401);

  fake.state.revisions.push({
    id: 'rev-w', acked: false,
    attributes: {
      booking_id: 'bk-w', status: 'new', ota_name: 'MakeMyTrip', arrival_date: D0, departure_date: addDays(D0, 1),
      rooms: [{ room_type_id: 'rt-ste', checkin_date: D0, checkout_date: addDays(D0, 1) }],
    },
  });
  const r = await api('POST', '/api/providers/channex/webhook', { event: 'booking' }, { 'x-channex-webhook-secret': SECRET });
  assert.equal(r.status, 200);
  for (let i = 0; i < 20 && !fake.state.revisions[0].acked; i += 1) await sleep(25);
  assert.equal(avail(3, D0), 1);
});

test('rejects mappings Channex could not price', async () => {
  const bad = async (body) => (await api('POST', '/api/providers/channex/connect', { ...CONNECT, ...body })).body.error;
  const ste = { rooms: [{ room_type_id: 3, channex_room_type_id: 'rt-ste' }] };
  assert.match(await bad({ ...ste, rate_plans: [{ rate_plan_id: 5, channex_rate_plan_id: 'rp-ste-pp' }] }), /per_person/);
  assert.match(await bad({ ...ste, rate_plans: [{ rate_plan_id: 5, channex_rate_plan_id: 'rp-dlx' }] }), /different room type/);
  assert.match(await bad({ ...ste, rate_plans: [{ rate_plan_id: 1, channex_rate_plan_id: 'rp-dlx' }] }), /Map the room type/);
  assert.match(await bad({
    rooms: [{ room_type_id: 1, channex_room_type_id: 'rt-dlx' }, { room_type_id: 2, channex_room_type_id: 'rt-dlx' }],
  }), /same Channex room type/);
  assert.match(await bad({ rate_plans: [{ rate_plan_id: 1, channex_rate_plan_id: 'rp-dlx' }, { rate_plan_id: 2, channex_rate_plan_id: 'rp-dlx' }] }),
    /same Channex rate plan/);
  assert.equal((await api('POST', '/api/providers/channex/connect', { ...CONNECT, property_id: 'nope' })).status, 400);
});

test('a wrong API key is reported clearly', async () => {
  const client = new ChannexClient({ apiKey: 'wrong', baseUrl: `http://127.0.0.1:${fakeServer.address().port}/api/v1` });
  await assert.rejects(client.listProperties(), /rejected the API key/);
});

// ---------- Robustness: failing revisions, recovery, stalls, health check ----------

const revision = (id, bookingId, attrs = {}) => ({
  id,
  acked: false,
  attributes: {
    booking_id: bookingId, status: 'new', ota_name: 'Booking.com', ota_reservation_code: `BDC-${bookingId}`,
    arrival_date: D0, departure_date: addDays(D0, 1), amount: '5000.00', currency: 'INR',
    customer: { name: 'Guest', surname: bookingId },
    rooms: [{ room_type_id: 'rt-dlx', rate_plan_id: 'rp-dlx', checkin_date: D0, checkout_date: addDays(D0, 1) }],
    ...attrs,
  },
});

test('a revision that cannot be saved does not hold up the others, even past one feed page', async () => {
  await connect();
  // 11 broken revisions first (more than a feed page), then a good one.
  for (let i = 0; i < 11; i += 1) fake.state.revisions.push(revision(`bad-${i}`, `b${i}`, { arrival_date: 'not-a-date' }));
  fake.state.revisions.push(revision('good-1', 'g1'));

  const r = await api('POST', '/api/providers/channex/pull');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { processed: 1, failed: 11 });
  assert.equal(fake.state.revisions.find((x) => x.id === 'good-1').acked, true);
  assert.ok(fake.state.revisions.filter((x) => x.id.startsWith('bad')).every((x) => !x.acked), 'failed ones stay in the feed');
  assert.equal(avail(1, D0), 9);

  const alerts = (await api('GET', '/api/alerts')).body;
  assert.ok(alerts.some((a) => a.level === 'error' && /11 booking update\(s\) from Channex could not be saved/.test(a.text)));

  // Fixed on the Channex side: it applies on the next pull and the alert goes.
  for (const x of fake.state.revisions) if (x.id.startsWith('bad')) x.attributes.arrival_date = D0;
  assert.deepEqual((await api('POST', '/api/providers/channex/pull')).body, { processed: 11, failed: 0 });
  assert.equal((await api('GET', '/api/providers/channex')).body.failures.length, 0);
  assert.ok(!(await api('GET', '/api/alerts')).body.some((a) => /could not be saved/.test(a.text)));
});

test('the OTA reservation number is kept, shown and searchable', async () => {
  await connect();
  fake.state.revisions.push(revision('rev-ota', 'bk-77', { ota_reservation_code: '4455667788' }));
  await api('POST', '/api/providers/channex/pull');
  const [b] = (await api('GET', '/api/bookings?q=44556677')).body;
  assert.equal(b.ota_reference, '4455667788');
  assert.equal((await api('GET', `/api/bookings/${b.id}`)).body.ota_reference, '4455667788');
  const csv = await api('GET', `/api/reports/export.csv?type=bookings&from=${D0}&to=${D0}`);
  assert.match(csv.body, /4455667788/);
});

test('recovery after an outage brings in missed bookings and cancellations, once', async () => {
  await connect();
  // One booking we already have, then the outage: a new booking and a cancellation never reached the feed.
  fake.state.revisions.push(revision('rev-a', 'bk-a'));
  await api('POST', '/api/providers/channex/pull');
  const since = new Date(Date.now() - 3600_000).toISOString();
  const later = new Date().toISOString();
  fake.state.bookings.push(
    { id: 'bk-a', inserted_at: later, attributes: { ...revision('x', 'bk-a').attributes, status: 'cancelled' } },
    { id: 'bk-b', inserted_at: later, attributes: revision('y', 'bk-b', { arrival_date: addDays(D0, 2), departure_date: addDays(D0, 3),
      rooms: [{ room_type_id: 'rt-ste', checkin_date: addDays(D0, 2), checkout_date: addDays(D0, 3) }] }).attributes },
    { id: 'bk-old', inserted_at: '2000-01-01T00:00:00Z', attributes: revision('z', 'bk-old').attributes },
  );

  const r = await api('POST', '/api/providers/channex/recover', { since });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { checked: 2, created: 1, updated: 1, unchanged: 0, failed: [] });
  assert.equal(avail(1, D0), 10, 'cancelled booking released');
  assert.equal(avail(3, addDays(D0, 2)), 1, 'missed booking taken');

  const again = await api('POST', '/api/providers/channex/recover', { since });
  assert.deepEqual(again.body, { checked: 2, created: 0, updated: 0, unchanged: 2, failed: [] });
  assert.equal((await api('POST', '/api/providers/channex/recover', { since: 'yesterday-ish' })).status, 400);
});

test('an alert appears when bookings have not been fetched for a while', async () => {
  await connect();
  await api('POST', '/api/providers/channex/pull');
  const set = (min) => db.prepare("UPDATE channels SET last_pull_ok_at = ? WHERE kind = 'channex'").run(new Date(Date.now() - min * 60_000).toISOString());
  set(2);
  assert.ok(!(await api('GET', '/api/alerts')).body.some((a) => /haven't been fetched/.test(a.text)));
  set(15);
  assert.ok((await api('GET', '/api/alerts')).body.some((a) => a.level === 'warn' && /15 min/.test(a.text)));
  set(45);
  assert.ok((await api('GET', '/api/alerts')).body.some((a) => a.level === 'error' && /may have been missed/.test(a.text)));
});

test('health check reads values back from Channex and spots differences', async () => {
  await connect();
  await api('POST', '/api/providers/channex/pull');
  let r = (await api('GET', '/api/providers/channex/doctor?days=7')).body;
  const byKey = Object.fromEntries(r.checks.map((c) => [c.key, c]));
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.equal(byKey.readback.status, 'ok');
  assert.match(byKey.readback.detail, /21 room-night\(s\) match/);
  assert.equal(byKey.mapping.status, 'warn', 'demo plans 2, 4 and 6 are not mapped');

  // Someone changed a price inside Channex.
  fake.state.restrictions['rp-dlx'][D0].rate = '1.00';
  delete fake.state.availability['rt-ste'][addDays(D0, 1)];
  r = (await api('GET', '/api/providers/channex/doctor?days=7')).body;
  assert.equal(r.ok, false);
  assert.deepEqual(r.mismatches.map((m) => m.what).sort(), ['Deluxe Room · Room only: price', 'Suite: rooms available']);
  assert.equal(r.mismatches.find((m) => m.what.endsWith('price')).theirs, '1.00');

  // Resend everything, and it matches again.
  assert.equal((await api('POST', '/api/providers/channex/resync')).status, 200);
  await sleep(220);
  await drain();
  r = (await api('GET', '/api/providers/channex/doctor?days=7')).body;
  assert.equal(r.ok, true, JSON.stringify(r.mismatches));
});
