const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, OWNER } = require('./helpers');
const { today, addDays } = require('../src/dates');

const D0 = addDays(today(), 4);

async function withApp(fn, appOpts, startOpts) {
  const app = await startApp(appOpts, startOpts);
  try { await fn(app); } finally { await app.close(); }
}

// ---------- Setup & login ----------

test('first run: setup creates the hotel and owner, then can never run again', () => withApp(async ({ client }) => {
  const anon = client();
  assert.deepEqual((await anon('GET', '/api/session')).body, { needs_setup: true, user: null, property: null });
  assert.equal((await anon('GET', '/api/inventory')).status, 401);

  const weak = await anon('POST', '/api/setup', { hotel_name: 'Sea View', currency: 'inr', ...OWNER, password: 'short' });
  assert.equal(weak.status, 400);

  const ok = await anon('POST', '/api/setup', { hotel_name: 'Sea View', currency: 'inr', ...OWNER });
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.body.property, { name: 'Sea View', currency: 'INR' });
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(ok.headers.get('set-cookie'), /SameSite=Strict/i);

  // Logged in straight away, with an empty hotel (no demo data asked for).
  assert.deepEqual((await anon('GET', '/api/room-types')).body, []);

  const again = await client()('POST', '/api/setup', { hotel_name: 'Hijack', currency: 'USD', name: 'X', email: 'x@x.io', password: 'whatever123' });
  assert.equal(again.status, 409);
}, {}, { setup: false }));

test('login, logout and lockout after repeated wrong passwords', () => withApp(async ({ client }) => {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { email: OWNER.email, password: 'nope' })).status, 401);
  const ok = await c('POST', '/api/auth/login', { email: 'OWNER@example.com', password: OWNER.password });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.name, 'Owner');
  assert.equal((await c('GET', '/api/inventory')).status, 200);

  await c('POST', '/api/auth/logout');
  assert.equal((await c('GET', '/api/inventory')).status, 401);

  const attacker = client();
  for (let i = 0; i < 10; i += 1) await attacker('POST', '/api/auth/login', { email: 'victim@example.com', password: `guess${i}` });
  assert.equal((await attacker('POST', '/api/auth/login', { email: 'victim@example.com', password: 'x' })).status, 429);
}));

test('changes need the CSRF header; the Channex webhook does not need a login', () => withApp(async ({ api }) => {
  const noHeader = await api('POST', '/api/inventory/bulk', {}, { 'x-requested-with': '' });
  assert.equal(noHeader.status, 403);
  const hook = await api('POST', '/api/providers/channex/webhook', {}, { cookie: '' });
  assert.equal(hook.status, 403, 'disabled without a secret, but reachable');
  const health = await api('GET', '/api/health', undefined, { cookie: '' });
  assert.equal(health.status, 200);
  assert.match(health.headers.get('content-security-policy'), /default-src 'self'/);
}));

test('users: add, log in as them, change password, remove', () => withApp(async ({ api, client }) => {
  const add = await api('POST', '/api/users', { name: 'Front Desk', email: 'desk@example.com', password: 'desk-pass-1' });
  assert.equal(add.status, 201);
  assert.equal((await api('POST', '/api/users', { name: 'Dup', email: 'DESK@example.com', password: 'another-1' })).status, 400);

  const desk = client();
  assert.equal((await desk('POST', '/api/auth/login', { email: 'desk@example.com', password: 'desk-pass-1' })).status, 200);
  const other = client();
  await other('POST', '/api/auth/login', { email: 'desk@example.com', password: 'desk-pass-1' });

  assert.equal((await desk('POST', '/api/auth/password', { current_password: 'wrong', new_password: 'new-pass-22' })).status, 400);
  assert.equal((await desk('POST', '/api/auth/password', { current_password: 'desk-pass-1', new_password: 'new-pass-22' })).status, 200);
  assert.equal((await desk('GET', '/api/users')).status, 200, 'this session stays logged in');
  assert.equal((await other('GET', '/api/users')).status, 401, 'other sessions are logged out');

  const users = (await api('GET', '/api/users')).body;
  const owner = users.find((u) => u.email === OWNER.email);
  assert.equal((await api('DELETE', `/api/users/${owner.id}`)).status, 400, "can't remove yourself");
  assert.equal((await api('DELETE', `/api/users/${add.body.id}`)).status, 200);
  assert.equal((await desk('GET', '/api/users')).status, 401, 'removed user is logged out');
}));

// ---------- Hotel settings ----------

test('room types: add, change room count and rate, delete', () => withApp(async ({ api, engine }) => {
  const add = await api('POST', '/api/room-types', { code: 'fam', name: 'Family Room', total_rooms: 4, base_rate: 8000 });
  assert.equal(add.status, 201);
  assert.equal(add.body.code, 'FAM');
  assert.equal((await api('POST', '/api/room-types', { code: 'FAM', name: 'Again', total_rooms: 1, base_rate: 1 })).status, 400);

  // The demo OTAs start selling it right away.
  await engine.kick();
  await engine.runOnce();
  const view = (await api('GET', `/api/channels/agoda/listings?start=${D0}&days=1`)).body;
  const fam = view.rooms.find((r) => r.room_type_name === 'Family Room');
  assert.equal(fam.external_room_id, 'AGD-FAM');
  assert.equal(fam.cells[0].shown.available, 4);

  // Two rooms sold, then the hotel adds a room: unsold goes 2 → 3.
  await api('POST', '/api/bookings', { room_type_id: add.body.id, check_in: D0, check_out: addDays(D0, 1), rooms: 2, guest_name: 'G' });
  await api('PATCH', `/api/room-types/${add.body.id}`, { total_rooms: 5, base_rate: 8500 });
  const grid = (await api('GET', `/api/inventory?start=${D0}&days=2`)).body;
  const row = grid.room_types.find((r) => r.code === 'FAM');
  assert.deepEqual(row.cells.map((c) => c.available), [3, 5]);
  assert.equal(row.cells[1].rate, 8500);

  // Can't drop below what's already sold.
  const tooFew = await api('PATCH', `/api/room-types/${add.body.id}`, { total_rooms: 1 });
  assert.equal(tooFew.status, 409);

  assert.equal((await api('DELETE', `/api/room-types/${add.body.id}`)).status, 409, 'has bookings');
  const spare = await api('POST', '/api/room-types', { code: 'TMP', name: 'Temp', total_rooms: 1, base_rate: 1 });
  assert.equal((await api('DELETE', `/api/room-types/${spare.body.id}`)).status, 200);
}));

test('hotel name and currency can be changed', () => withApp(async ({ api }) => {
  const r = await api('PATCH', '/api/property', { name: 'Hill Top', currency: 'usd' });
  assert.deepEqual(r.body, { name: 'Hill Top', currency: 'USD' });
  assert.equal((await api('PATCH', '/api/property', { currency: 'dollars' })).status, 400);
}));

// ---------- Direct bookings ----------

test('a direct booking takes rooms off every OTA, is refused when full, and can be cancelled', () => withApp(async ({ api, engine }) => {
  const b = await api('POST', '/api/bookings', {
    room_type_id: 3, check_in: D0, check_out: addDays(D0, 2), rooms: 2, guest_name: 'Walk In', total: 24000, notes: 'Late arrival',
  });
  assert.equal(b.status, 201);
  assert.match(b.body.external_ref, /^DIR-/);
  assert.equal(b.body.source, 'Direct');

  const full = await api('POST', '/api/bookings', { room_type_id: 3, check_in: addDays(D0, 1), check_out: addDays(D0, 2), guest_name: 'Late' });
  assert.equal(full.status, 409);
  assert.match(full.body.error, /Only 0 Suite left/);

  await engine.kick();
  await engine.runOnce();
  const suite = (await api('GET', `/api/channels/booking_com/listings?start=${D0}&days=2`)).body.rooms.find((r) => r.room_type_name === 'Suite');
  assert.deepEqual(suite.cells.map((c) => c.shown.closed), [true, true]);

  const list = (await api('GET', '/api/bookings?view=upcoming&q=walk')).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].notes, 'Late arrival');

  assert.equal((await api('POST', `/api/bookings/${b.body.id}/cancel`)).body.status, 'cancelled');
  assert.equal((await api('GET', '/api/bookings?view=cancelled')).body.length, 1);
}));

test('a direct booking is allowed on stop-sell nights (stop sell only closes the OTAs)', () => withApp(async ({ api }) => {
  await api('POST', '/api/inventory/bulk', { room_type_ids: [1], start_date: D0, end_date: D0, set: { stop_sell: true } });
  const b = await api('POST', '/api/bookings', { room_type_id: 1, check_in: D0, check_out: addDays(D0, 1), guest_name: 'VIP' });
  assert.equal(b.status, 201);
  assert.equal(b.body.overbooked, 0);
}));

// ---------- Alerts & activity ----------

test('overbookings raise an alert until marked handled', () => withApp(async ({ api }) => {
  await api('POST', '/api/channels/agoda/bookings', { external_ref: 'A1', room_id: 'AGD-STE', check_in: D0, check_out: addDays(D0, 1), rooms: 2 });
  const over = await api('POST', '/api/channels/expedia/bookings', { external_ref: 'E1', room_id: 'EXP-STE', check_in: D0, check_out: addDays(D0, 1) });
  assert.equal(over.body.booking.overbooked, 1);

  let alerts = (await api('GET', '/api/alerts')).body;
  assert.match(alerts[0].text, /1 overbooked/);
  assert.equal((await api('GET', '/api/bookings?view=attention')).body.length, 1);

  await api('POST', `/api/bookings/${over.body.booking.id}/handled`);
  alerts = (await api('GET', '/api/alerts')).body;
  assert.equal(alerts.length, 0);
}));

test('changes are recorded with who made them', () => withApp(async ({ api }) => {
  await api('POST', '/api/inventory/bulk', {
    room_type_ids: [1, 3], start_date: D0, end_date: addDays(D0, 6), weekdays: [5, 6], set: { rate: 9000, stop_sell: false },
  });
  const [latest] = (await api('GET', '/api/activity')).body;
  assert.equal(latest.user_name, 'Owner');
  assert.equal(latest.action, `Set rate 9000, open for sale on Deluxe Room, Suite for ${D0} → ${addDays(D0, 6)} (Fri, Sat)`);
}));
