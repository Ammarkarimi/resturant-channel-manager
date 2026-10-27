// Accounts, roles, properties, settings, direct bookings, alerts, activity, reports.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, OWNER } = require('./helpers');
const { totp } = require('../src/totp');
const { today, addDays } = require('../src/dates');

const D0 = addDays(today(), 4);

async function withApp(fn, appOpts, startOpts) {
  const app = await startApp(appOpts, startOpts);
  try { await fn(app); } finally { await app.close(); }
}

// ---------- Setup & login ----------

test('first run: setup creates the property and owner, then can never run again', () => withApp(async ({ client }) => {
  const anon = client();
  const s = (await anon('GET', '/api/session')).body;
  assert.equal(s.needs_setup, true);
  assert.equal(s.user, null);
  assert.equal((await anon('GET', '/api/inventory')).status, 401);

  const weak = await anon('POST', '/api/setup', { hotel_name: 'Sea View', currency: 'inr', ...OWNER, password: 'short' });
  assert.equal(weak.status, 400);

  const ok = await anon('POST', '/api/setup', { hotel_name: 'Sea View', currency: 'inr', city: 'Goa', ...OWNER });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.user.role, 'admin');
  assert.deepEqual(ok.body.properties.map((p) => [p.name, p.currency, p.city]), [['Sea View', 'INR', 'Goa']]);
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(ok.headers.get('set-cookie'), /SameSite=Strict/i);
  assert.deepEqual((await anon('GET', '/api/room-types')).body, [], 'no demo data unless asked');

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

test('two-factor login with an authenticator app', () => withApp(async ({ api, client }) => {
  const setup = await api('POST', '/api/auth/2fa/setup');
  assert.equal(setup.status, 200);
  assert.match(setup.body.otpauth_url, /^otpauth:\/\/totp\//);
  assert.match(setup.body.qr, /^data:image\/svg\+xml;base64,/);
  assert.equal((await api('POST', '/api/auth/2fa/enable', { code: '000000' })).status, 400);
  const on = await api('POST', '/api/auth/2fa/enable', { code: totp(setup.body.secret) });
  assert.equal(on.body.totp_enabled, true);

  const c = client();
  const step1 = await c('POST', '/api/auth/login', { email: OWNER.email, password: OWNER.password });
  assert.equal(step1.body.two_factor_required, true);
  assert.equal(step1.headers.get('set-cookie'), null, 'no session before the code');
  assert.equal((await c('GET', '/api/inventory')).status, 401);
  assert.equal((await c('POST', '/api/auth/login/verify', { challenge: step1.body.challenge, code: '123456' })).status, 401);
  const step2 = await c('POST', '/api/auth/login/verify', { challenge: step1.body.challenge, code: totp(setup.body.secret) });
  assert.equal(step2.status, 200);
  assert.equal((await c('GET', '/api/inventory')).status, 200);
  assert.equal((await c('POST', '/api/auth/login/verify', { challenge: step1.body.challenge, code: totp(setup.body.secret) })).status, 401, 'one use only');

  // Turning it off needs the password.
  assert.equal((await api('POST', '/api/auth/2fa/disable', { password: 'wrong' })).status, 400);
  assert.equal((await api('POST', '/api/auth/2fa/disable', { password: OWNER.password })).body.totp_enabled, false);
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

// ---------- Properties & roles ----------

test('several properties: separate rooms, bookings and channels; switch with X-Property-Id', () => withApp(async ({ api }) => {
  const first = api.property;
  const second = await api('POST', '/api/properties', { name: 'Hill Lodge', currency: 'INR', city: 'Ooty' });
  assert.equal(second.status, 201);
  assert.deepEqual((await api('GET', '/api/properties')).body.map((p) => p.name).sort(), ['Hill Lodge', 'Test Hotel']);

  api.property = second.body.id;
  assert.deepEqual((await api('GET', '/api/room-types')).body, []);
  const rt = await api('POST', '/api/room-types', { code: 'COT', name: 'Cottage', total_rooms: 3, base_rate: 3000 });
  assert.equal(rt.status, 201);
  assert.equal((await api('GET', '/api/channels')).body.length, 0, 'demo OTAs belong to the first property only');
  // Same room code is fine in another property; another property's room is not reachable.
  await api('POST', '/api/room-types', { code: 'DLX', name: 'Deluxe', total_rooms: 1, base_rate: 1 });
  assert.equal((await api('PATCH', '/api/room-types/1', { total_rooms: 9 })).status, 404);
  assert.equal((await api('POST', '/api/bookings', { room_type_id: 1, check_in: D0, check_out: addDays(D0, 1), guest_name: 'X' })).status, 400);

  api.property = first;
  assert.equal((await api('GET', '/api/room-types')).body.length, 3);
  assert.equal((await api('GET', '/api/inventory', undefined, { 'x-property-id': '999' })).status, 404);

  const group = (await api('GET', '/api/group/overview')).body;
  assert.deepEqual(group.map((g) => [g.name, g.rooms]).sort(), [['Hill Lodge', 4], ['Test Hotel', 18]]);
}));

test('roles: front desk takes bookings but cannot change rates; viewer only looks; access per property', () => withApp(async ({ api, client }) => {
  const other = await api('POST', '/api/properties', { name: 'Other', currency: 'INR' });
  const desk = await api('POST', '/api/users', {
    name: 'Desk', email: 'desk@example.com', password: 'desk-pass-1', role: 'front_desk', all_properties: false, property_ids: [api.property],
  });
  assert.equal(desk.status, 201);
  await api('POST', '/api/users', { name: 'View', email: 'view@example.com', password: 'view-pass-1', role: 'viewer' });

  const d = client();
  const login = await d.login('desk@example.com', 'desk-pass-1');
  assert.deepEqual(login.body.properties.map((p) => p.name), ['Test Hotel']);
  assert.equal((await d('GET', '/api/inventory')).status, 200);
  assert.equal((await d('POST', '/api/inventory/bulk', { room_type_ids: [1], start_date: D0, end_date: D0, set: { rate: 1 } })).status, 403);
  assert.equal((await d('POST', '/api/bookings', { room_type_id: 1, check_in: D0, check_out: addDays(D0, 1), guest_name: 'Walk in' })).status, 201);
  assert.equal((await d('POST', '/api/room-types', { code: 'X1', name: 'X', total_rooms: 1 })).status, 403);
  assert.equal((await d('GET', '/api/users')).status, 403);
  assert.equal((await d('GET', '/api/inventory', undefined, { 'x-property-id': String(other.body.id) })).status, 404, 'not their property');

  const v = client();
  await v.login('view@example.com', 'view-pass-1');
  assert.equal((await v('GET', '/api/bookings')).status, 200);
  assert.equal((await v('GET', '/api/reports/dashboard')).status, 200);
  assert.equal((await v('POST', '/api/bookings', { room_type_id: 1, check_in: D0, check_out: addDays(D0, 1), guest_name: 'X' })).status, 403);
  assert.equal((await v('PATCH', '/api/channels/agoda', { rate_markup_pct: 1 })).status, 403);

  // Promote, and the last admin can't be demoted.
  const users = (await api('GET', '/api/users')).body;
  const owner = users.find((u) => u.email === OWNER.email);
  assert.equal((await api('PATCH', `/api/users/${owner.id}`, { role: 'manager' })).status, 400);
  const promoted = await api('PATCH', `/api/users/${desk.body.id}`, { role: 'manager', all_properties: true });
  assert.equal(promoted.body.role, 'manager');
  d.property = api.property;
  assert.equal((await d('POST', '/api/inventory/bulk', { room_type_ids: [1], start_date: D0, end_date: D0, set: { rate: 5000 } })).status, 200);
}));

test('users: add, change password, reset two-factor, remove', () => withApp(async ({ api, client }) => {
  const add = await api('POST', '/api/users', { name: 'Front Desk', email: 'desk@example.com', password: 'desk-pass-1' });
  assert.equal(add.status, 201);
  assert.equal((await api('POST', '/api/users', { name: 'Dup', email: 'DESK@example.com', password: 'another-1' })).status, 400);

  const desk = client();
  await desk.login('desk@example.com', 'desk-pass-1');
  const other = client();
  await other.login('desk@example.com', 'desk-pass-1');

  assert.equal((await desk('POST', '/api/auth/password', { current_password: 'wrong', new_password: 'new-pass-22' })).status, 400);
  assert.equal((await desk('POST', '/api/auth/password', { current_password: 'desk-pass-1', new_password: 'new-pass-22' })).status, 200);
  assert.equal((await desk('GET', '/api/properties')).status, 200, 'this session stays logged in');
  assert.equal((await other('GET', '/api/properties')).status, 401, 'other sessions are logged out');

  const s = await desk('POST', '/api/auth/2fa/setup');
  await desk('POST', '/api/auth/2fa/enable', { code: totp(s.body.secret) });
  const reset = await api('POST', `/api/users/${add.body.id}/reset-2fa`);
  assert.equal(reset.body.totp_enabled, false);
  assert.equal((await desk('GET', '/api/properties')).status, 401, 'reset logs them out');

  const owner = (await api('GET', '/api/users')).body.find((u) => u.email === OWNER.email);
  assert.equal((await api('DELETE', `/api/users/${owner.id}`)).status, 400, "can't remove yourself");
  assert.equal((await api('DELETE', `/api/users/${add.body.id}`)).status, 200);
}));

// ---------- Hotel settings ----------

test('room types: add (with a starting rate plan), change room count, delete', () => withApp(async ({ api, sync }) => {
  const add = await api('POST', '/api/room-types', { code: 'fam', name: 'Family Room', total_rooms: 4, base_rate: 8000, max_adults: 4 });
  assert.equal(add.status, 201);
  assert.equal(add.body.code, 'FAM');
  assert.equal((await api('POST', '/api/room-types', { code: 'FAM', name: 'Again', total_rooms: 1 })).status, 400);
  const fam = (await api('GET', '/api/room-types')).body.find((r) => r.code === 'FAM');
  assert.deepEqual(fam.rate_plans.map((p) => [p.code, p.rate_double]), [['EP', 8000]]);

  // The demo OTAs start selling it right away.
  await sync();
  const view = (await api('GET', `/api/channels/agoda/listings?start=${D0}&days=1`)).body;
  const famPlan = view.rate_plans.find((p) => p.external_rate_plan_id === 'AGD-FAM-EP');
  assert.equal(famPlan.cells[0].shown.available, 4);

  // Two rooms sold, then the hotel adds a room: unsold goes 2 → 3.
  await api('POST', '/api/bookings', { room_type_id: add.body.id, check_in: D0, check_out: addDays(D0, 1), rooms: 2, guest_name: 'G' });
  await api('PATCH', `/api/room-types/${add.body.id}`, { total_rooms: 5 });
  const grid = (await api('GET', `/api/inventory?start=${D0}&days=2`)).body;
  assert.deepEqual(grid.room_types.find((r) => r.code === 'FAM').cells.map((c) => c.available), [3, 5]);

  assert.equal((await api('PATCH', `/api/room-types/${add.body.id}`, { total_rooms: 1 })).status, 409, "can't drop below sold");
  assert.equal((await api('DELETE', `/api/room-types/${add.body.id}`)).status, 409, 'has bookings');
  const spare = await api('POST', '/api/room-types', { code: 'TMP', name: 'Temp', total_rooms: 1, base_rate: 1 });
  assert.equal((await api('DELETE', `/api/room-types/${spare.body.id}`)).status, 200);
}));

test('hotel details can be changed', () => withApp(async ({ api }) => {
  const r = await api('PATCH', '/api/property', { name: 'Hill Top', currency: 'usd', country: 'India' });
  assert.equal(r.body.name, 'Hill Top');
  assert.equal(r.body.currency, 'USD');
  assert.equal(r.body.country, 'India');
  assert.equal((await api('PATCH', '/api/property', { currency: 'dollars' })).status, 400);
}));

// ---------- Direct bookings, alerts, activity ----------

test('a direct booking takes rooms off every OTA, is refused when full, and can be cancelled', () => withApp(async ({ api, sync }) => {
  const b = await api('POST', '/api/bookings', {
    room_type_id: 3, check_in: D0, check_out: addDays(D0, 2), rooms: 2, guest_name: 'Walk In', total: 24000, notes: 'Late arrival',
  });
  assert.equal(b.status, 201);
  assert.match(b.body.external_ref, /^DIR-/);

  const full = await api('POST', '/api/bookings', { room_type_id: 3, check_in: addDays(D0, 1), check_out: addDays(D0, 2), guest_name: 'Late' });
  assert.equal(full.status, 409);
  assert.match(full.body.error, /Only 0 Suite left/);

  await sync();
  const suite = (await api('GET', `/api/channels/booking_com/listings?start=${D0}&days=2`)).body.rate_plans.find((p) => p.external_rate_plan_id === 'BDC-STE-CP');
  assert.deepEqual(suite.cells.map((c) => c.shown.closed), [true, true]);

  const list = (await api('GET', '/api/bookings?view=upcoming&q=walk')).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].notes, 'Late arrival');
  assert.equal((await api('POST', `/api/bookings/${b.body.id}/cancel`)).body.status, 'cancelled');
  assert.equal((await api('GET', '/api/bookings?view=cancelled')).body.length, 1);
}));

test('overbookings raise an alert until marked handled', () => withApp(async ({ api }) => {
  await api('POST', '/api/channels/agoda/bookings', { external_ref: 'A1', room_id: 'AGD-STE', check_in: D0, check_out: addDays(D0, 1), rooms: 2 });
  const over = await api('POST', '/api/channels/expedia/bookings', { external_ref: 'E1', room_id: 'EXP-STE', check_in: D0, check_out: addDays(D0, 1) });
  assert.equal(over.body.booking.overbooked, 1);
  assert.match((await api('GET', '/api/alerts')).body[0].text, /1 overbooked/);
  await api('POST', `/api/bookings/${over.body.booking.id}/handled`);
  assert.equal((await api('GET', '/api/alerts')).body.length, 0);
}));

test('changes are recorded with who made them, per property', () => withApp(async ({ api }) => {
  await api('POST', '/api/inventory/bulk', {
    room_type_ids: [1, 3], start_date: D0, end_date: addDays(D0, 6), weekdays: [5, 6], set: { rate: 9000, cta: true },
  });
  const [latest] = (await api('GET', '/api/activity')).body;
  assert.equal(latest.user_name, 'Owner');
  assert.equal(latest.action, `Set rate 9000, closed to arrival on Deluxe Room, Suite for ${D0} → ${addDays(D0, 6)} (Fri, Sat)`);

  const other = await api('POST', '/api/properties', { name: 'Other', currency: 'INR' });
  const otherLog = (await api('GET', '/api/activity', undefined, { 'x-property-id': String(other.body.id) })).body;
  assert.ok(!otherLog.some((a) => a.action.startsWith('Set rate')));
}));

// ---------- Reports ----------

test('reports: KPIs, channel performance, pace, parity and CSV export', () => withApp(async ({ api, db, sync }) => {
  const t = today();
  // Two direct bookings and one demo-OTA booking staying tonight / tomorrow.
  await api('POST', '/api/bookings', { room_type_id: 1, check_in: t, check_out: addDays(t, 2), rooms: 2, guest_name: '=HYPERLINK("x")', total: 20000 });
  await api('POST', '/api/bookings', { room_type_id: 3, check_in: t, check_out: addDays(t, 1), guest_name: 'B', total: 12000 });
  const ota = await api('POST', '/api/channels/agoda/bookings', { external_ref: 'AG-1', room_id: 'AGD-DLX', check_in: t, check_out: addDays(t, 1), total: 5000 });
  await api('POST', '/api/channels/agoda/bookings', { external_ref: 'AG-2', room_id: 'AGD-DLX', check_in: t, check_out: addDays(t, 1), total: 5000 });
  await api('POST', '/api/channels/agoda/bookings/AG-2/cancel');
  assert.equal(ota.status, 201);

  const s = (await api('GET', `/api/reports/summary?from=${t}&to=${addDays(t, 1)}`)).body;
  // 18 rooms x 2 nights = 36 available; sold: 2+2 (deluxe) + 1 (suite) + 1 (agoda) = 6.
  assert.equal(s.current.rooms_available, 36);
  assert.equal(s.current.room_nights, 6);
  assert.equal(s.current.occupancy_pct, 16.7);
  assert.equal(s.current.revenue, 37000);
  assert.equal(s.current.adr, 6166.67);
  assert.equal(s.current.revpar, 1027.78);

  const ch = (await api('GET', `/api/reports/channels?from=${t}&to=${addDays(t, 1)}`)).body;
  const direct = ch.channels.find((c) => c.source === 'Direct');
  const agoda = ch.channels.find((c) => c.source === 'Agoda');
  assert.deepEqual([direct.bookings, direct.room_nights, direct.revenue], [2, 5, 32000]);
  assert.deepEqual([agoda.bookings, agoda.cancellations, agoda.cancellation_rate_pct], [1, 1, 50]);

  const pace = (await api('GET', `/api/reports/pace?from=${t}&to=${t}`)).body;
  assert.equal(pace.totals.bookings, 4);

  const dash = (await api('GET', '/api/reports/dashboard')).body;
  assert.equal(dash.arrivals.bookings, 3);
  assert.equal(dash.in_house.rooms, 4);
  assert.equal(dash.recent_bookings.length, 4);

  // Parity: OTAs with a markup are above direct; one with a discount is below.
  await api('PATCH', '/api/channels/makemytrip', { rate_markup_pct: -5 });
  await sync();
  const parity = (await api('GET', `/api/reports/parity?start=${addDays(t, 3)}&days=2&rate_plan_id=1`)).body;
  const night = parity.rate_plans[0].days[0];
  assert.equal(night.direct, 4500);
  assert.equal(night.channels.agoda.diff_pct, 15);
  assert.equal(night.channels.makemytrip.diff_pct, -5);
  assert.equal(night.channels.agoda.status, 'in_sync');
  assert.equal(parity.summary.below_direct, 2, 'MakeMyTrip undercuts direct on both nights');

  const csv = await api('GET', `/api/reports/export.csv?type=bookings&from=${t}&to=${t}`);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.body, /'=HYPERLINK\(""x""\)/, 'formulas neutralised');
  const occ = await api('GET', `/api/reports/export.csv?type=occupancy&from=${t}&to=${t}`);
  assert.match(occ.body, /Deluxe Room sold/);
  assert.equal((await api('GET', '/api/reports/export.csv?type=nope')).status, 400);
  assert.ok(db);
}));
