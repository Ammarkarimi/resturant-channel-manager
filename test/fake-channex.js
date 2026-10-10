// A small stand-in for the Channex API, used by the tests (and handy for
// trying the dashboard without a Channex account: `node test/fake-channex.js`).
const assert = require('node:assert/strict');
const express = require('express');
const { today } = require('../src/dates');

const API_KEY = 'test-key';

function fakeChannex() {
  const state = {
    calls: [],              // every ARI call: { kind, values }
    failNext: [],           // statuses to answer the next ARI calls with
    warnNext: false,        // answer the next restrictions call with a warning
    revisions: [],          // { id, attributes, acked }
    failAckOnce: false,
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
  const rp = (id, title, roomTypeId, sellMode = 'per_room') => ({
    type: 'rate_plan', id,
    attributes: { id, title, sell_mode: sellMode, rate_mode: 'manual', currency: 'INR' },
    relationships: { room_type: { data: { id: roomTypeId, type: 'room_type' } } },
  });
  const roomTypes = [rt('rt-dlx', 'Deluxe', 10), rt('rt-exe', 'Executive', 6), rt('rt-ste', 'Suite', 2)];
  const ratePlans = [rp('rp-dlx', 'Deluxe BAR', 'rt-dlx'), rp('rp-exe', 'Exec BAR', 'rt-exe'),
    rp('rp-ste', 'Suite BAR', 'rt-ste'), rp('rp-ste-pp', 'Suite per person', 'rt-ste', 'per_person')];

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
      if (kind === 'restrictions' && state.warnNext) {
        state.warnNext = false;
        return res.json({ data: [], meta: { message: 'Success', warnings: [{ date: today(), warning: { rate: ['must be greater than 0'] } }] } });
      }
      return res.json({ data: [{ id: 'task', type: 'task' }], meta: { message: 'Success', warnings: [] } });
    });
  }
  app.get('/api/v1/booking_revisions/feed', (req, res) => {
    res.json({ data: state.revisions.filter((r) => !r.acked).slice(0, 10).map((r) => ({ type: 'booking_revision', id: r.id, attributes: r.attributes })) });
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
