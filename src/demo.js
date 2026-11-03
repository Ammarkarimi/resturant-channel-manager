// Showcase mode (DEMO_MODE=1): a ready-made hotel group with history, so
// every page has something to show the moment someone opens the link.
// Used for hosted demos where the database does not persist (e.g. Vercel):
// each fresh server instance starts from this same data.

const { transaction, seedDemo, createProperty } = require('./db');
const { createUser } = require('./auth');
const { receiveBooking, cancelBooking, createDirectBooking, quote } = require('./bookings');
const { bulkUpdate, setChannelBlocks } = require('./inventory');
const { createYieldRule } = require('./hotel');
const { logActivity } = require('./activity');
const { today, addDays } = require('./dates');

const DEMO_ACCOUNTS = [
  { name: 'Demo Owner', email: 'owner@demo.hotel', password: 'demo1234', role: 'admin', label: 'Owner (admin)' },
  { name: 'Demo Front Desk', email: 'desk@demo.hotel', password: 'demo1234', role: 'front_desk', label: 'Front desk' },
];

const GUESTS = ['Aarav Mehta', 'Priya Sharma', 'Rohan Iyer', 'Ananya Gupta', 'Vikram Rao', 'Sara Khan', 'Kabir Singh',
  'Meera Nair', 'Arjun Patel', 'Isha Kapoor', 'Daniel Brooks', 'Emma Wilson', 'Liam Chen', 'Sofia Rossi', 'Yuki Tanaka',
  'Fatima Ali', 'Noah Fischer', 'Zara Ahmed', 'Dev Malhotra', 'Nisha Reddy'];
const OTAS = [['booking_com', 'BDC'], ['agoda', 'AGD'], ['makemytrip', 'MMT'], ['expedia', 'EXP']];

/** Small deterministic random generator, so every instance builds the same demo. */
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function backdate(db, bookingId, createdAt) {
  db.prepare('UPDATE bookings SET created_at = ?, updated_at = ? WHERE id = ?').run(createdAt, createdAt, bookingId);
}

/** About `count` stays spread over [from, to], from OTAs and direct, some cancelled. */
function addBookings(db, propertyId, { from, to, count, seed, ratePlansByRoom }) {
  const rnd = prng(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const span = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));
  const rooms = db.prepare('SELECT id, code, total_rooms FROM room_types WHERE property_id = ? ORDER BY id').all(propertyId);
  const ota = db.prepare("SELECT code FROM channels WHERE property_id = ? AND kind = 'simulated'").all(propertyId).map((c) => c.code);
  let made = 0;
  for (let i = 0; made < count && i < count * 4; i += 1) {
    const checkIn = addDays(from, Math.floor(rnd() * span));
    const nights = 1 + Math.floor(rnd() * 3);
    const room = rnd() < 0.55 ? rooms[0] : rnd() < 0.7 ? rooms[1] : rooms[rooms.length - 1];
    const plan = pick(ratePlansByRoom[room.id]);
    const guest = pick(GUESTS);
    const lead = 1 + Math.floor(rnd() * 25);
    const createdAt = new Date(Math.min(Date.now() - 3_600_000, Date.parse(`${addDays(checkIn, -lead)}T10:00:00Z`) + Math.floor(rnd() * 8) * 3_600_000)).toISOString();
    try {
      const stay = { room_type_id: room.id, rate_plan_id: plan, check_in: checkIn, check_out: addDays(checkIn, nights), rooms: 1, adults: 2 };
      const q = quote(db, propertyId, stay);
      if (q.warnings.some((w) => w.startsWith('Only'))) continue; // sold out: try another stay
      const { total } = q;
      let booking;
      const channelCode = ota.length && rnd() < 0.72 ? pick(ota) : null;
      if (channelCode) {
        const prefix = OTAS.find(([c]) => c === channelCode)?.[1] || 'OTA';
        const markup = db.prepare('SELECT rate_markup_pct FROM channels WHERE property_id = ? AND code = ?').get(propertyId, channelCode).rate_markup_pct;
        const ref = `${prefix}-${String(4_000_000 + Math.floor(rnd() * 5_000_000))}`;
        booking = receiveBooking(db, propertyId, channelCode, {
          external_ref: ref, room_id: `${prefix}-${room.code}`, check_in: stay.check_in, check_out: stay.check_out,
          guest_name: guest, total: Math.round(total * (1 + markup / 100)),
        }).booking;
        if (rnd() < 0.12) booking = cancelBooking(db, propertyId, channelCode, ref).booking;
      } else {
        booking = createDirectBooking(db, propertyId, { ...stay, guest_name: guest, guest_phone: `+91 9${String(Math.floor(rnd() * 1e9)).padStart(9, '0')}` });
      }
      backdate(db, booking.id, createdAt);
      made += 1;
    } catch {
      // Sold out for that stay: try another.
    }
  }
  return made;
}

function plansByRoom(db, propertyId) {
  const out = {};
  for (const p of db.prepare(`SELECT rp.id, rp.room_type_id FROM rate_plans rp JOIN room_types rt ON rt.id = rp.room_type_id
                              WHERE rt.property_id = ? ORDER BY rp.id`).all(propertyId)) {
    (out[p.room_type_id] ||= []).push(p.id);
  }
  return out;
}

/** Build the showcase. Does nothing if the database already has users. */
function seedShowcase(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;
  transaction(db, () => {
    const t = today();
    const lake = createProperty(db, { name: 'Lakeview Residency', currency: 'INR', city: 'Udaipur', country: 'India' });
    const hill = createProperty(db, { name: 'Hill Lodge', currency: 'INR', city: 'Ooty', country: 'India' });
    const users = DEMO_ACCOUNTS.map((a) => createUser(db, { ...a, all_properties: true }));
    seedDemo(db, lake);
    seedDemo(db, hill);
    db.prepare('UPDATE room_types SET total_rooms = 5 WHERE property_id = ? AND code = ?').run(hill, 'DLX');

    // Last year's stays first (for "vs last year"), then this year's.
    const lastYear = (d) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
    // Roughly 55-70% occupancy: about one booking per two rooms per night.
    for (const [pid, n, seed] of [[lake, 380, 7], [hill, 200, 11]]) {
      const byRoom = plansByRoom(db, pid);
      addBookings(db, pid, { from: lastYear(addDays(t, -40)), to: lastYear(addDays(t, 30)), count: Math.round(n * 0.85), seed: seed + 100, ratePlansByRoom: byRoom });
      addBookings(db, pid, { from: addDays(t, -40), to: addDays(t, 30), count: n, seed, ratePlansByRoom: byRoom });
    }
    // One OTA booking arriving for a sold-out night, to show the overbooking alert.
    const full = db.prepare(`SELECT date FROM room_inventory WHERE room_type_id = 3 AND date > ? AND available <= 0 ORDER BY date LIMIT 1`).get(addDays(t, 2));
    if (full) {
      receiveBooking(db, lake, 'agoda', { external_ref: 'AGD-9000001', room_id: 'AGD-STE', check_in: full.date, check_out: addDays(full.date, 1), guest_name: 'Rahul Verma', total: 13800 });
    }

    // Some pricing and restrictions to look at in the calendar.
    const owner = users[0];
    createYieldRule(db, lake, { min_occupancy: 60, adjust_pct: 15 });
    const weekend = [5, 6];
    bulkUpdate(db, lake, { room_type_ids: [1, 2, 3], start_date: t, end_date: addDays(t, 27), weekdays: weekend, set: { rate: 5200, min_stay: 2 } });
    bulkUpdate(db, lake, { room_type_ids: [3], rate_plan_ids: [5], start_date: addDays(t, 9), end_date: addDays(t, 10), set: { cta: true } });
    setChannelBlocks(db, lake, { room_type_ids: [3], channel_codes: ['expedia'], start_date: addDays(t, 3), end_date: addDays(t, 5), blocked: true });
    // MakeMyTrip undercuts direct, so the parity report has something to flag.
    db.prepare("UPDATE channels SET rate_markup_pct = -3 WHERE property_id = ? AND code = 'makemytrip'").run(lake);

    logActivity(db, owner, 'Set rate 5200, min stay 2 on all room types for weekends (showcase)', lake);
    logActivity(db, owner, 'Added pricing rule all rooms: +15% from 60% occupancy (showcase)', lake);
    logActivity(db, owner, 'Closed Suite on Expedia for three nights (showcase)', lake);
  });
}

module.exports = { seedShowcase, DEMO_ACCOUNTS };
