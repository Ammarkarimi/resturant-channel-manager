// Rate plans, derived prices, restrictions, channel-only closures,
// occupancy-based pricing and quotes.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');
const { today, addDays } = require('../src/dates');

let api; let close; let sync;

beforeEach(async () => {
  ({ api, close, sync } = await startApp());
});

afterEach(() => close());

const D0 = addDays(today(), 5);
const listings = async (code, start = D0, days = 3) =>
  (await api('GET', `/api/channels/${code}/listings?start=${start}&days=${days}`)).body;
const plan = (view, suffix) => view.rate_plans.find((p) => p.external_rate_plan_id.endsWith(suffix)).cells;
const grid = async (start = D0, days = 3) => (await api('GET', `/api/inventory?start=${start}&days=${days}`)).body;
const gridPlan = (g, room, code) => g.room_types.find((r) => r.code === room).rate_plans.find((p) => p.code === code);

test('derived plans follow their parent: by amount and by percentage', async () => {
  await api('POST', '/api/inventory/bulk', { room_type_ids: [3], start_date: D0, end_date: D0, set: { rate: 10000 } });
  const g = await grid(D0, 1);
  assert.equal(gridPlan(g, 'STE', 'CP').cells[0].rate_double, 10000);
  assert.equal(gridPlan(g, 'STE', 'MAP').cells[0].rate_double, 11500, 'MAP = CP + 15%');
  assert.equal(gridPlan(g, 'STE', 'MAP').derived_from, 'With breakfast +15%');
  assert.equal(gridPlan(g, 'DLX', 'CP').cells[0].rate_double, 5100, 'DLX CP = EP 4500 + 600');
  assert.equal(gridPlan(g, 'DLX', 'CP').cells[0].rate_single, 4600, 'single price is derived too');

  // Changing the parent's default price moves the derived plan on every night.
  const plans = (await api('GET', '/api/room-types')).body[0].rate_plans;
  await api('PATCH', `/api/rate-plans/${plans[0].id}`, { rate_double: 5000 });
  assert.equal(gridPlan(await grid(addDays(D0, 1), 1), 'DLX', 'CP').cells[0].rate_double, 5600);

  // A derived plan alone can't be priced.
  const r = await api('POST', '/api/inventory/bulk', {
    room_type_ids: [1], rate_plan_ids: [plans[1].id], start_date: D0, end_date: D0, set: { rate: 1 },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /follow their parent/);
});

test('restrictions: close to arrival/departure, min and max stay reach every channel', async () => {
  const r = await api('POST', '/api/inventory/bulk', {
    room_type_ids: [1], start_date: D0, end_date: addDays(D0, 1), set: { cta: true, ctd: true, min_stay: 2, max_stay: 7 },
  });
  assert.equal(r.status, 200);
  await sync();
  for (const code of ['agoda', 'expedia']) {
    for (const suffix of ['DLX-EP', 'DLX-CP']) {
      const [c] = plan(await listings(code), suffix);
      assert.deepEqual(
        { cta: c.shown.cta, ctd: c.shown.ctd, min: c.shown.min_stay, max: c.shown.max_stay, sync: c.in_sync },
        { cta: true, ctd: true, min: 2, max: 7, sync: true }, `${code} ${suffix}`,
      );
    }
  }
  // 0 removes the maximum; false reopens.
  await api('POST', '/api/inventory/bulk', { room_type_ids: [1], start_date: D0, end_date: D0, set: { cta: false, max_stay: 0 } });
  const cell = gridPlan(await grid(D0, 1), 'DLX', 'EP').cells[0];
  assert.deepEqual([cell.cta, cell.ctd, cell.min_stay, cell.max_stay], [false, true, 2, null]);
});

test('closing one rate plan leaves the others open; reset_rates returns to the default price', async () => {
  const plans = (await api('GET', '/api/room-types')).body[0].rate_plans;
  await api('POST', '/api/inventory/bulk', {
    room_type_ids: [1], rate_plan_ids: [plans[0].id], start_date: D0, end_date: D0, set: { plan_stop_sell: true, rate: 7000 },
  });
  await sync();
  const view = await listings('booking_com', D0, 1);
  assert.equal(plan(view, 'DLX-EP')[0].shown.closed, true);
  assert.equal(plan(view, 'DLX-CP')[0].shown.closed, false);

  await api('POST', '/api/inventory/bulk', { room_type_ids: [1], rate_plan_ids: [plans[0].id], start_date: D0, end_date: D0, set: { reset_rates: true } });
  const cell = gridPlan(await grid(D0, 1), 'DLX', 'EP').cells[0];
  assert.equal(cell.rate_double, 4500);
  assert.equal(cell.own_price, false);
});

test('a room can be closed on chosen channels only, and reopened', async () => {
  const r = await api('POST', '/api/inventory/channel-blocks', {
    room_type_ids: [3], channel_codes: ['agoda', 'expedia'], start_date: D0, end_date: addDays(D0, 1), blocked: true,
  });
  assert.equal(r.status, 200);
  await sync();
  assert.deepEqual(plan(await listings('agoda'), 'STE-CP').map((c) => c.shown.closed), [true, true, false]);
  assert.deepEqual(plan(await listings('expedia'), 'STE-MAP').map((c) => c.shown.closed), [true, true, false]);
  assert.deepEqual(plan(await listings('booking_com'), 'STE-CP').map((c) => c.shown.closed), [false, false, false]);
  assert.deepEqual((await grid(D0, 1)).room_types[2].cells[0].blocked_channels.sort(), ['agoda', 'expedia']);

  await api('POST', '/api/inventory/channel-blocks', {
    room_type_ids: [3], channel_codes: ['agoda'], start_date: D0, end_date: D0, blocked: false,
  });
  await sync();
  assert.deepEqual(plan(await listings('agoda'), 'STE-CP').map((c) => c.shown.closed), [false, true, false]);
});

test('rate plans: create with occupancy prices, deactivate, protect parents', async () => {
  const add = await api('POST', '/api/rate-plans', {
    room_type_id: 1, code: 'nrf', name: 'Non-refundable', meal_plan: 'EP', rate_double: 4000, rate_single: 3600, extra_adult: 800,
  });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.equal(add.body.code, 'NRF');
  await sync();
  assert.equal(plan(await listings('agoda'), 'AGD-DLX-NRF')[0].shown.rate, 4600, '4000 + 15% Agoda markup');

  // Switching a plan off closes it on every channel without deleting it.
  await api('PATCH', `/api/rate-plans/${add.body.id}`, { active: false });
  await sync();
  assert.equal(plan(await listings('agoda'), 'AGD-DLX-NRF')[0].shown.closed, true);

  // Derived from a plan that would make a loop, or deleting a parent, is refused.
  const plans = (await api('GET', '/api/room-types')).body[0].rate_plans;
  const ep = plans.find((p) => p.code === 'EP');
  const cp = plans.find((p) => p.code === 'CP');
  assert.equal((await api('PATCH', `/api/rate-plans/${ep.id}`, { parent_id: cp.id, derive_type: 'amount', derive_value: 1 })).status, 400);
  assert.equal((await api('DELETE', `/api/rate-plans/${ep.id}`)).status, 409);
  assert.equal((await api('DELETE', `/api/rate-plans/${add.body.id}`)).status, 200);
  assert.equal((await api('POST', '/api/rate-plans', { room_type_id: 1, code: 'EP', name: 'Dup', rate_double: 1 })).status, 400);
});

test('occupancy-based pricing raises prices as a room type fills, and only on those nights', async () => {
  const rule = await api('POST', '/api/yield-rules', { room_type_id: 3, min_occupancy: 50, adjust_pct: 20 });
  assert.equal(rule.status, 201);
  await api('POST', '/api/yield-rules', { min_occupancy: 90, adjust_pct: 40 });

  // 1 of 2 suites booked on D0 = 50% occupancy.
  await api('POST', '/api/bookings', { room_type_id: 3, check_in: D0, check_out: addDays(D0, 1), guest_name: 'G' });
  const g = await grid(D0, 2);
  const cp = gridPlan(g, 'STE', 'CP');
  assert.deepEqual(cp.cells.map((c) => [c.rate_double, c.yield_pct]), [[14400, 20], [12000, 0]]);
  assert.equal(gridPlan(g, 'STE', 'MAP').cells[0].rate_double, 16560, 'MAP: 12000 +15% = 13800, then +20%');
  assert.equal(g.room_types[2].cells[0].occupancy_pct, 50);

  await sync();
  assert.equal(plan(await listings('booking_com', D0, 1), 'STE-CP')[0].shown.rate, 16560, '14400 + 15% markup');

  // Fully booked: the 90% hotel-wide rule (higher threshold) wins.
  await api('POST', '/api/bookings', { room_type_id: 3, check_in: D0, check_out: addDays(D0, 1), guest_name: 'H' });
  assert.equal(gridPlan(await grid(D0, 1), 'STE', 'CP').cells[0].yield_pct, 40);

  await api('DELETE', `/api/yield-rules/${rule.body.id}`);
  const rules = (await api('GET', '/api/yield-rules')).body;
  await api('PATCH', `/api/yield-rules/${rules[0].id}`, { active: false });
  assert.equal(gridPlan(await grid(D0, 1), 'STE', 'CP').cells[0].rate_double, 12000);
  assert.equal((await api('POST', '/api/yield-rules', { min_occupancy: 120, adjust_pct: 5 })).status, 400);
});

test('quotes price by guests and rate plan, and warn about restrictions', async () => {
  const plans = (await api('GET', '/api/room-types')).body[0].rate_plans;
  const ep = plans.find((p) => p.code === 'EP');
  const stay = { room_type_id: 1, rate_plan_id: ep.id, check_in: D0, check_out: addDays(D0, 2), rooms: 1 };
  const q = async (extra) => (await api('POST', '/api/bookings/quote', { ...stay, ...extra })).body;

  assert.equal((await q({ adults: 2 })).total, 9000);
  assert.equal((await q({ adults: 1 })).total, 8000, 'single price 4000');
  assert.equal((await q({ adults: 3 })).total, 10600, 'triple price 5300');
  assert.equal((await q({ adults: 2, children: 1 })).total, 10000, 'extra child 500');
  assert.equal((await q({ adults: 2, rooms: 2 })).total, 18000);

  await api('POST', '/api/inventory/bulk', { room_type_ids: [1], start_date: D0, end_date: D0, set: { min_stay: 3, cta: true } });
  const warned = await q({ adults: 2 });
  assert.ok(warned.warnings.some((w) => /Minimum stay/.test(w)));
  assert.ok(warned.warnings.some((w) => /closed to arrival/.test(w)));

  // Without a total, a direct booking is priced from its plan.
  const b = await api('POST', '/api/bookings', { ...stay, adults: 2, guest_name: 'Priced', guest_email: 'p@example.com', guest_phone: '+91 98' });
  assert.equal(b.status, 201);
  assert.equal(b.body.total, 9000);
  const detail = (await api('GET', `/api/bookings/${b.body.id}`)).body;
  assert.equal(detail.lines[0].rate_plan_name, 'Room only');
  assert.equal(detail.nights, 2);
  assert.equal(detail.property.name, 'Test Hotel');
  assert.equal((await api('POST', '/api/bookings', { ...stay, adults: 9, guest_name: 'X' })).status, 400, 'over max adults');
});
