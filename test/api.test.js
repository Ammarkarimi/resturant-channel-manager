const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { today, addDays } = require('../src/dates');

let db; let engine; let api; let close;

beforeEach(async () => {
  ({ db, engine, api, close } = await startApp());
});

afterEach(() => close());

const D0 = addDays(today(), 3);

async function sync() {
  // Wait for any in-flight pass, then run one that sees everything queued.
  await engine.kick();
  return engine.runOnce();
}

const listings = async (code, start = D0, days = 7) =>
  (await api('GET', `/api/channels/${code}/listings?start=${start}&days=${days}`)).body;

test('one bulk update reaches every channel, with each channel\'s markup', async () => {
  const r = await api('POST', '/api/inventory/bulk', {
    room_type_ids: [1], start_date: D0, end_date: addDays(D0, 2), set: { rate: 5000, available: 4 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.cells, 3);
  await sync();

  const channels = (await api('GET', '/api/channels')).body;
  assert.equal(channels.length, 4);
  for (const c of channels) {
    const view = await listings(c.code, D0, 3);
    const dlx = view.rooms.find((room) => room.room_type_name === 'Deluxe Room');
    for (const cell of dlx.cells) {
      assert.equal(cell.in_sync, true, `${c.code} ${cell.date}`);
      assert.equal(cell.shown.available, 4);
      assert.equal(cell.shown.rate, Math.round(5000 * (1 + c.rate_markup_pct / 100) * 100) / 100);
    }
    assert.equal(c.pending, 0);
  }
});

test('weekday filter only touches matching dates', async () => {
  const start = D0;
  const end = addDays(D0, 13);
  await api('POST', '/api/inventory/bulk', {
    room_type_ids: [2], start_date: start, end_date: end, weekdays: [5, 6], set: { rate: 9999 },
  });
  const grid = (await api('GET', `/api/inventory?start=${start}&days=14`)).body;
  for (const cell of grid.room_types[1].cells) {
    const dow = new Date(`${cell.date}T00:00:00Z`).getUTCDay();
    assert.equal(cell.rate, dow === 5 || dow === 6 ? 9999 : 6500, cell.date);
  }
});

test('stop sell closes the room on every OTA', async () => {
  await api('POST', '/api/inventory/bulk', {
    room_type_ids: [1, 2, 3], start_date: D0, end_date: D0, set: { stop_sell: true },
  });
  await sync();
  for (const code of ['booking_com', 'agoda', 'makemytrip', 'expedia']) {
    for (const room of (await listings(code, D0, 1)).rooms) assert.equal(room.cells[0].shown.closed, true);
  }
});

test('a booking on one OTA lowers availability on all of them; cancelling restores it', async () => {
  await sync();
  const booking = {
    external_ref: 'BDC-1001', room_id: 'BDC-STE', check_in: D0, check_out: addDays(D0, 2), rooms: 2,
    guest_name: 'Test Guest',
  };
  const r = await api('POST', '/api/channels/booking_com/bookings', booking);
  assert.equal(r.status, 201);
  assert.equal(r.body.booking.overbooked, 0);

  // Same webhook delivered twice must not double-count.
  const again = await api('POST', '/api/channels/booking_com/bookings', booking);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);

  await sync();
  for (const code of ['booking_com', 'agoda', 'makemytrip', 'expedia']) {
    const suite = (await listings(code, D0, 3)).rooms.find((room) => room.room_type_name === 'Suite');
    assert.deepEqual(suite.cells.map((c) => c.shown.available), [0, 0, 2], code);
    assert.deepEqual(suite.cells.map((c) => c.shown.closed), [true, true, false], code);
  }

  // Suite is sold out, so another booking for that night is flagged as overbooked.
  const over = await api('POST', '/api/channels/agoda/bookings', {
    external_ref: 'AGD-77', room_id: 'AGD-STE', check_in: D0, check_out: addDays(D0, 1),
  });
  assert.equal(over.body.booking.overbooked, 1);

  const cancel = await api('POST', '/api/channels/booking_com/bookings/BDC-1001/cancel');
  assert.equal(cancel.body.booking.status, 'cancelled');
  await sync();
  const suite = (await listings('makemytrip', D0, 3)).rooms.find((room) => room.room_type_name === 'Suite');
  assert.deepEqual(suite.cells.map((c) => c.shown.available), [1, 2, 2]);
});

test('a channel outage is retried and catches up once the OTA is back', async () => {
  await api('PATCH', '/api/channels/agoda', { simulate_outage: true });
  await api('POST', '/api/inventory/bulk', {
    room_type_ids: [1], start_date: D0, end_date: D0, set: { available: 1 },
  });
  await sync();

  let agoda = (await api('GET', '/api/channels')).body.find((c) => c.code === 'agoda');
  assert.ok(agoda.pending > 0);
  assert.match(agoda.last_error, /unavailable/);
  const bdc = (await listings('booking_com', D0, 1)).rooms[0].cells[0];
  assert.equal(bdc.shown.available, 1, 'other channels are not held up by one failing OTA');

  await api('PATCH', '/api/channels/agoda', { simulate_outage: false });
  db.prepare("UPDATE sync_queue SET next_attempt_at = '2000-01-01'").run(); // skip the backoff wait
  await sync();
  agoda = (await api('GET', '/api/channels')).body.find((c) => c.code === 'agoda');
  assert.equal(agoda.pending, 0);
  assert.equal((await listings('agoda', D0, 1)).rooms[0].cells[0].shown.available, 1);
});

test('an edit made while a push is in flight is not lost', async () => {
  const { ADAPTERS } = require('../src/channels');
  const { SimulatedChannel } = require('../src/channels/simulated');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  class Slow extends SimulatedChannel {
    async pushUpdates(updates) { await gate; return super.pushUpdates(updates); }
  }
  ADAPTERS.expedia = Slow;
  try {
    await api('POST', '/api/inventory/bulk', { room_type_ids: [1], start_date: D0, end_date: D0, set: { rate: 5000 } });
    const pass = engine.kick();
    await new Promise((r) => setImmediate(r));
    await api('POST', '/api/inventory/bulk', { room_type_ids: [1], start_date: D0, end_date: D0, set: { rate: 6000 } });
    release();
    await pass;
    await sync();
    const cell = (await listings('expedia', D0, 1)).rooms[0].cells[0];
    assert.equal(cell.in_sync, true);
    assert.equal(cell.shown.rate, 7080); // 6000 + Expedia's 18% markup
  } finally {
    delete ADAPTERS.expedia;
  }
});

test('changing a channel markup re-pushes its prices', async () => {
  await sync();
  await api('PATCH', '/api/channels/makemytrip', { rate_markup_pct: 0 });
  await sync();
  const cell = (await listings('makemytrip', today(), 1)).rooms[0].cells[0];
  assert.equal(cell.shown.rate, 4500);
});

test('rejects bad input', async () => {
  const cases = [
    { room_type_ids: [], start_date: D0, end_date: D0, set: { rate: 1 } },
    { room_type_ids: [1], start_date: D0, end_date: addDays(D0, -1), set: { rate: 1 } },
    { room_type_ids: [1], start_date: D0, end_date: D0, set: {} },
    { room_type_ids: [1], start_date: D0, end_date: D0, set: { rate: -5 } },
    { room_type_ids: [3], start_date: D0, end_date: D0, set: { available: 5 } }, // only 2 suites
  ];
  for (const body of cases) {
    const r = await api('POST', '/api/inventory/bulk', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const unknownRoom = await api('POST', '/api/channels/agoda/bookings', {
    external_ref: 'X', room_id: 'BDC-DLX', check_in: D0, check_out: addDays(D0, 1),
  });
  assert.equal(unknownRoom.status, 400);
  assert.equal((await api('POST', '/api/channels/nope/bookings', {})).status, 404);
});
