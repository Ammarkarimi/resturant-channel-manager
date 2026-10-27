const express = require('express');
const {
  receiveBooking, cancelBooking, cancelBookingById, createDirectBooking, markHandled, listBookings, getBooking, quote,
} = require('../bookings');
const { getProperty } = require('../hotel');
const { logActivity } = require('../activity');
const { requirePermission } = require('../permissions');

function bookingRoutes({ db, engine }) {
  const r = express.Router();
  const manage = requirePermission('bookings');
  const log = (req, text) => logActivity(db, req.user, text, req.property.id);

  r.get('/bookings', (req, res) => {
    res.json(listBookings(db, req.property.id, { view: req.query.view || 'all', q: req.query.q || '' }));
  });

  // Price and checks for a stay, before booking it.
  r.post('/bookings/quote', (req, res) => res.json(quote(db, req.property.id, req.body || {})));

  // One booking with its rooms, for the detail view and the printable voucher.
  r.get('/bookings/:id', (req, res) => {
    res.json({ ...getBooking(db, req.property.id, Number(req.params.id)), property: getProperty(db, req.property.id) });
  });

  // Phone / walk-in booking.
  r.post('/bookings', manage, (req, res) => {
    const booking = createDirectBooking(db, req.property.id, req.body || {});
    log(req, `Added direct booking ${booking.external_ref} for ${booking.guest_name}, ${booking.check_in} → ${booking.check_out}`);
    engine.kick();
    res.status(201).json(booking);
  });

  r.post('/bookings/:id/cancel', manage, (req, res) => {
    const { booking, duplicate } = cancelBookingById(db, req.property.id, Number(req.params.id));
    if (!duplicate) log(req, `Cancelled booking ${booking.external_ref} (${booking.guest_name || 'guest'})`);
    engine.kick();
    res.json(booking);
  });

  r.post('/bookings/:id/handled', manage, (req, res) => {
    const booking = markHandled(db, req.property.id, Number(req.params.id));
    log(req, `Marked booking ${booking.external_ref} as handled`);
    res.json(booking);
  });

  // Demo OTAs: what a direct OTA connection would post when a guest books or cancels.
  r.post('/channels/:code/bookings', manage, (req, res) => {
    const result = receiveBooking(db, req.property.id, req.params.code, req.body);
    engine.kick();
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  r.post('/channels/:code/bookings/:ref/cancel', manage, (req, res) => {
    const result = cancelBooking(db, req.property.id, req.params.code, req.params.ref);
    engine.kick();
    res.json(result);
  });

  return r;
}

module.exports = { bookingRoutes };
