// A small stand-in for the Channex API, used by the tests (and handy for
// trying the dashboard without a Channex account: `node test/fake-channex.js`).
const assert = require('node:assert/strict');
const express = require('express');
const { today, addDays, eachDate } = require('../src/dates');

const API_KEY = 'test-key';

function fakeChannex() {
  const state = {
    calls: [],              // every ARI call: { kind, values }
    failNext: [],           // statuses to answer the next ARI calls with
    warnNext: false,        // answer the next restrictions call with a warning
    revisions: [],          // { id, attributes, acked }
    failAckOnce: false,
    bookings: [],           // { id, inserted_at, attributes } for GET /bookings
    // What Channex now holds, as a real account would (filled by the ARI pushes).
    availability: {},       // room type id -> date -> count
    restrictions: {},       // rate plan id -> date -> { rate, stop_sell, ... }
  };
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => {
    if (req.get('user-api-key') !== API_KEY) return res.status(401).json({ errors: { code: 'unauthorized', title: 'Unauthorized' } });
    return next();
  });
  const page = (items, req) => {
    // Pages of 2 regardless of the requested limit, to exercise pagination.
    const p = Number(req.query.pagination?.page || 1);
    return { data: items.slice((p - 1) * 2, p * 2), meta: { page: p, limit: 2, total: items.length } };
  };
  const rt = (id, title, count) => ({ type: 'room_type', id, attributes: { id, title, count_of_rooms: count } });
  const rp = (id, title, roomTypeId, sellMode = 'per_room', rateMode = 'manual') => ({
    type: 'rate_plan', id,
    attributes: { id, title, sell_mode: sellMode, rate_mode: rateMode, currency: 'INR' },
    relationships: { room_type: { data: { id: roomTypeId, type: 'room_type' } } },
  });
  const roomTypes = [rt('rt-dlx', 'Deluxe', 10), rt('rt-exe', 'Executive', 6), rt('rt-ste', 'Suite', 2)];
  const ratePlans = [rp('rp-dlx', 'Deluxe BAR', 'rt-dlx'), rp('rp-exe', 'Exec BAR', 'rt-exe'),
    rp('rp-ste', 'Suite BAR', 'rt-ste'), rp('rp-ste-pp', 'Suite per person', 'rt-ste', 'per_person'),
    // Channex's own demo plans are per room with rate_mode "auto"; derived plans take a parent's price.
    rp('rp-ste-auto', 'Suite auto', 'rt-ste', 'per_room', 'auto'), rp('rp-ste-der', 'Suite derived', 'rt-ste', 'per_room', 'derived')];

  app.get('/api/v1/properties/options', (req, res) => res.json({
    data: [{ type: 'property', id: 'prop-1', attributes: { id: 'prop-1', title: 'Test Hotel', currency: 'INR', min_stay_type: 'arrival' } }],
  }));
  app.get('/api/v1/room_types', (req, res) => {
    assert.equal(req.query.filter.property_id, 'prop-1');
    res.json(page(roomTypes, req));
  });
  app.get('/api/v1/rate_plans', (req, res) => res.json(page(ratePlans, req)));
  for (const kind of ['availability', 'restrictions']) {
    app.post(`/api/v1/${kind}`, (req, res) => {
      const status = state.failNext.shift();
      if (status) return res.status(status).json({ errors: { code: 'x', title: 'Failure' } });
      state.calls.push({ kind, values: req.body.values });
      for (const v of req.body.values) {
        const dates = v.date ? [v.date] : eachDate(v.date_from, v.date_to);
        for (const d of dates) {
          if (kind === 'availability') {
            (state.availability[v.room_type_id] ||= {})[d] = v.availability;
          } else {
            const cell = ((state.restrictions[v.rate_plan_id] ||= {})[d] ||= {});
            // Channex applies partial updates; reads give rates as strings and
            // the property's min-stay type as min_stay_arrival.
            for (const [k, val] of Object.entries(v)) {
              if (['property_id', 'rate_plan_id', 'date', 'date_from', 'date_to'].includes(k)) continue;
              if (k === 'rate') cell.rate = Number(val).toFixed(2);
              else if (k === 'min_stay') cell.min_stay_arrival = val;
              else cell[k] = val;
            }
          }
        }
      }
      if (kind === 'restrictions' && state.warnNext) {
        state.warnNext = false;
        return res.json({ data: [], meta: { message: 'Success', warnings: [{ date: today(), warning: { rate: ['must be greater than 0'] } }] } });
      }
      return res.json({ data: [{ id: 'task', type: 'task' }], meta: { message: 'Success', warnings: [] } });
    });
  }
  app.get('/api/v1/availability', (req, res) => {
    const { gte, lte } = req.query.filter.date;
    const out = {};
    for (const [roomId, days] of Object.entries(state.availability)) {
      out[roomId] = Object.fromEntries(Object.entries(days).filter(([d]) => d >= gte && d <= lte));
    }
    res.json({ data: out });
  });
  app.get('/api/v1/restrictions', (req, res) => {
    if (!req.query.filter.restrictions) return res.status(400).json({ errors: { code: 'bad_request', title: 'Bad Request', details: ['restrictions is required'] } });
    const { gte, lte } = req.query.filter.date;
    const fields = req.query.filter.restrictions.split(',');
    const out = {};
    // Like the real Channex: what we set comes back as stop_sell_manual, while stop_sell is
    // computed and is also true on nights the room type has no availability left.
    const roomOf = Object.fromEntries(ratePlans.map((p) => [p.id, p.relationships.room_type.data.id]));
    const read = (planId, d, cell, f) => {
      if (f === 'stop_sell_manual') return cell.stop_sell ?? null;
      if (f === 'stop_sell') return Boolean(cell.stop_sell) || state.availability[roomOf[planId]]?.[d] === 0;
      return cell[f] ?? null;
    };
    for (const [planId, days] of Object.entries(state.restrictions)) {
      out[planId] = Object.fromEntries(Object.entries(days).filter(([d]) => d >= gte && d <= lte)
        .map(([d, cell]) => [d, Object.fromEntries(fields.map((f) => [f, read(planId, d, cell, f)]))]));
    }
    res.json({ data: out });
  });
  // Oldest first, 10 per page, unacknowledged only.
  app.get('/api/v1/booking_revisions/feed', (req, res) => {
    const p = Number(req.query.pagination?.page || 1);
    const open = state.revisions.filter((r) => !r.acked);
    res.json({
      data: open.slice((p - 1) * 10, p * 10).map((r) => ({ type: 'booking_revision', id: r.id, attributes: r.attributes })),
      meta: { page: p, limit: 10, total: open.length },
    });
  });
  app.get('/api/v1/bookings', (req, res) => {
    const since = req.query.filter.inserted_at.gte;
    const found = state.bookings.filter((b) => b.inserted_at >= since).map((b) => ({ type: 'booking', id: b.id, attributes: b.attributes }));
    res.json(page(found, req));
  });
  app.post('/api/v1/booking_revisions/:id/ack', (req, res) => {
    if (state.failAckOnce) {
      state.failAckOnce = false;
      return res.status(500).json({ errors: { title: 'oops' } });
    }
    const r = state.revisions.find((x) => x.id === req.params.id);
    r.acked = true;
    return res.json({ meta: { message: 'Success' } });
  });
  return { app, state };
}

module.exports = { fakeChannex, API_KEY };

if (require.main === module) {
  const { app, state } = fakeChannex();
  const port = Number(process.env.PORT) || 4010;
  app.post('/_test/revisions', (req, res) => { state.revisions.push({ ...req.body, acked: false }); res.json({ ok: true }); });
  app.get('/_test/calls', (req, res) => res.json(state.calls));
  app.listen(port, () => console.log(`Fake Channex on http://localhost:${port}/api/v1 (API key: ${API_KEY})`));
}
