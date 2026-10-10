const express = require('express');
const {
  receiveBooking, cancelBooking, cancelBookingById, createDirectBooking, markHandled, listBookings,
} = require('../bookings');
const { logActivity } = require('../activity');

function bookingRoutes({ db, engine }) {
  const r = express.Router();

  r.get('/bookings', (req, res) => {
    res.json(listBookings(db, { view: req.query.view || 'all', q: req.query.q || '' }));
  });

  // Phone / walk-in booking.
  r.post('/bookings', (req, res) => {
    const booking = createDirectBooking(db, req.body);
    logActivity(db, req.user, `Added direct booking ${booking.external_ref} for ${booking.guest_name}, ${booking.check_in} → ${booking.check_out}`);
    engine.kick();
    res.status(201).json(booking);
  });

  r.post('/bookings/:id/cancel', (req, res) => {
    const { booking, duplicate } = cancelBookingById(db, Number(req.params.id));
    if (!duplicate) logActivity(db, req.user, `Cancelled booking ${booking.external_ref} (${booking.guest_name || 'guest'})`);
    engine.kick();
    res.json(booking);
  });

  r.post('/bookings/:id/handled', (req, res) => {
    const booking = markHandled(db, Number(req.params.id));
    logActivity(db, req.user, `Marked booking ${booking.external_ref} as handled`);
    res.json(booking);
  });

  // Demo OTAs: what a direct OTA connection would post when a guest books or cancels.
  r.post('/channels/:code/bookings', (req, res) => {
    const result = receiveBooking(db, req.params.code, req.body);
    engine.kick();
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  r.post('/channels/:code/bookings/:ref/cancel', (req, res) => {
    const result = cancelBooking(db, req.params.code, req.params.ref);
    engine.kick();
    res.json(result);
  });

  return r;
}

module.exports = { bookingRoutes };
