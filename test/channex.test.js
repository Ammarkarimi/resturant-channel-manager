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

const MAPPINGS = [
  { room_type_id: 1, channex_room_type_id: 'rt-dlx', channex_rate_plan_id: 'rp-dlx' },
  { room_type_id: 2, channex_room_type_id: 'rt-exe', channex_rate_plan_id: 'rp-exe' },
  { room_type_id: 3, channex_room_type_id: 'rt-ste', channex_rate_plan_id: 'rp-ste' },
];

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
  const r = await api('POST', '/api/providers/channex/connect', { property_id: 'prop-1', mappings: MAPPINGS });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await drain();
  fake.state.calls.length = 0;
  await sleep(220); // let the push interval after the full sync pass
  return r.body;
}

const D0 = addDays(today(), 5);
const avail = (rtId, date) => db.prepare('SELECT available FROM inventory WHERE room_type_id = ? AND date = ?').get(rtId, date)?.available;

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
  const r = await api('POST', '/api/providers/channex/connect', { property_id: 'prop-1', mappings: MAPPINGS });
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
    rate: '4500.00', stop_sell: false, min_stay: 1,
  });

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
    rate: '5000.00', stop_sell: true, min_stay: 2,
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
  assert.deepEqual(pulled.body, { processed: 1 });
  assert.equal(fake.state.revisions[0].acked, true);
  assert.deepEqual([avail(1, D0), avail(1, addDays(D0, 1)), avail(1, addDays(D0, 2))], [8, 8, undefined]);

  const list = (await api('GET', '/api/bookings')).body;
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
  assert.deepEqual(pulled.body, { processed: 0 }, 'already applied, only acknowledged');
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
  const bad = async (mappings) => (await api('POST', '/api/providers/channex/connect', { property_id: 'prop-1', mappings })).body.error;
  assert.match(await bad([{ room_type_id: 3, channex_room_type_id: 'rt-ste', channex_rate_plan_id: 'rp-ste-pp' }]), /per_person/);
  assert.match(await bad([{ room_type_id: 3, channex_room_type_id: 'rt-ste', channex_rate_plan_id: 'rp-dlx' }]), /different room type/);
  assert.match(await bad([
    { room_type_id: 1, channex_room_type_id: 'rt-dlx', channex_rate_plan_id: 'rp-dlx' },
    { room_type_id: 2, channex_room_type_id: 'rt-dlx', channex_rate_plan_id: 'rp-dlx' },
  ]), /same Channex room type/);
  assert.equal((await api('POST', '/api/providers/channex/connect', { property_id: 'nope', mappings: MAPPINGS })).status, 400);
});

test('a wrong API key is reported clearly', async () => {
  const client = new ChannexClient({ apiKey: 'wrong', baseUrl: `http://127.0.0.1:${fakeServer.address().port}/api/v1` });
  await assert.rejects(client.listProperties(), /rejected the API key/);
});
