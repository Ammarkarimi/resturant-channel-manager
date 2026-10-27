const express = require('express');
const reports = require('../reports');
const { accessibleProperties, requirePermission } = require('../permissions');

/** Group overview across every property the user can see. Not tied to one property. */
function groupRoutes({ db }) {
  const r = express.Router();
  r.get('/group/overview', requirePermission('reports'), (req, res) => {
    res.json(reports.groupOverview(db, accessibleProperties(db, req.user)));
  });
  return r;
}

function reportRoutes({ db }) {
  const r = express.Router();
  r.use('/reports', requirePermission('reports'));
  const pid = (req) => req.property.id;

  r.get('/reports/dashboard', (req, res) => res.json(reports.dashboard(db, pid(req))));
  r.get('/reports/summary', (req, res) => res.json(reports.summary(db, pid(req), req.query.from, req.query.to)));
  r.get('/reports/occupancy', (req, res) => res.json(reports.occupancyByDate(db, pid(req), req.query.from, req.query.to)));
  r.get('/reports/channels', (req, res) => res.json(reports.channelPerformance(db, pid(req), req.query.from, req.query.to)));
  r.get('/reports/pace', (req, res) => res.json(reports.pace(db, pid(req), req.query.from, req.query.to)));
  r.get('/reports/parity', (req, res) => {
    res.json(reports.parity(db, pid(req), {
      start: req.query.start, days: req.query.days, rate_plan_id: req.query.rate_plan_id ? Number(req.query.rate_plan_id) : null,
    }));
  });

  r.get('/reports/export.csv', (req, res) => {
    const csv = reports.exportCsv(db, pid(req), req.query.type, req.query.from, req.query.to);
    const name = `${req.query.type}-${req.query.from || 'from'}-${req.query.to || 'to'}.csv`.replace(/[^\w.-]/g, '_');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
    // A byte-order mark so Excel opens UTF-8 (₹, accents) correctly.
    res.send(`﻿${csv}`);
  });

  return r;
}

module.exports = { reportRoutes, groupRoutes };
