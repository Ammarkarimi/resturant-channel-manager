// Reports. Revenue is counted on the nights guests stay: a booking's total
// is spread evenly over its room-nights. Bookings without a total count as
// sold rooms but add no revenue (and are left out of the average rate).

const { Pricer } = require('./pricing');
const { channelUpdate } = require('./sync');
const { isValidDate, addDays, eachDate, today } = require('./dates');
const { badRequest } = require('./errors');

const MAX_RANGE = 731;
const round1 = (n) => Math.round(n * 10) / 10;
const money = (n) => Math.round(n * 100) / 100;

function parseRange(from, to, { defaultDays = 30 } = {}) {
  const start = from || today();
  const end = to || addDays(start, defaultDays - 1);
  if (!isValidDate(start) || !isValidDate(end)) throw badRequest('Dates must be YYYY-MM-DD');
  if (end < start) throw badRequest('"to" is before "from"');
  const dates = eachDate(start, end);
  if (dates.length > MAX_RANGE) throw badRequest('Reports cover at most two years at a time');
  return { from: start, to: end, dates };
}

/** The same calendar dates one year earlier (29 Feb becomes 28 Feb). */
function lastYear(date) {
  const [y, m, d] = date.split('-');
  const md = m === '02' && d === '29' ? '02-28' : `${m}-${d}`;
  return `${Number(y) - 1}-${md}`;
}

const sourceOf = (b) => (b.channel_kind === 'channex' ? b.source || 'Channex' : b.source || b.channel_name);

/**
 * Every booked room-night between `from` and `to` (inclusive), with its
 * share of revenue, for confirmed (or cancelled) bookings of a property.
 */
function stayNights(db, propertyId, from, to, status = 'confirmed') {
  const bookings = db.prepare(`
    SELECT b.id, b.total, b.source, b.created_at, c.name AS channel_name, c.kind AS channel_kind
    FROM bookings b JOIN channels c ON c.id = b.channel_id
    WHERE c.property_id = ? AND b.status = ? AND b.check_in <= ? AND b.check_out > ?
  `).all(propertyId, status, to, from);
  const lines = db.prepare('SELECT room_type_id, check_in, check_out, rooms FROM booking_lines WHERE booking_id = ?');
  const out = [];
  for (const b of bookings) {
    const ls = lines.all(b.id);
    const totalNights = ls.reduce((n, l) => n + l.rooms * (eachDate(l.check_in, l.check_out).length - 1), 0);
    const perNight = b.total != null && totalNights > 0 ? b.total / totalNights : null;
    for (const l of ls) {
      for (const d of eachDate(l.check_in, addDays(l.check_out, -1))) {
        if (d < from || d > to) continue;
        out.push({ booking_id: b.id, date: d, room_type_id: l.room_type_id, rooms: l.rooms, revenue: perNight == null ? null : perNight * l.rooms, source: sourceOf(b) });
      }
    }
  }
  return out;
}

function capacityPerNight(db, propertyId) {
  return db.prepare('SELECT COALESCE(SUM(total_rooms), 0) AS n FROM room_types WHERE property_id = ?').get(propertyId).n;
}

function kpis(nights, capacity, days) {
  const sold = nights.reduce((n, x) => n + x.rooms, 0);
  const priced = nights.filter((x) => x.revenue != null);
  const revenue = priced.reduce((n, x) => n + x.revenue, 0);
  const pricedRooms = priced.reduce((n, x) => n + x.rooms, 0);
  const available = capacity * days;
  return {
    rooms_available: available,
    room_nights: sold,
    occupancy_pct: available ? round1((sold / available) * 100) : 0,
    revenue: money(revenue),
    adr: pricedRooms ? money(revenue / pricedRooms) : null,
    revpar: available ? money(revenue / available) : null,
  };
}

const change = (now, before) => (before ? round1(((now - before) / before) * 100) : null);

/** Occupancy, revenue, ADR and RevPAR for a range, against the same dates last year. */
function summary(db, propertyId, from, to) {
  const range = parseRange(from, to);
  const capacity = capacityPerNight(db, propertyId);
  const current = kpis(stayNights(db, propertyId, range.from, range.to), capacity, range.dates.length);
  const ly = { from: lastYear(range.from), to: lastYear(range.to) };
  const previous = kpis(stayNights(db, propertyId, ly.from, ly.to), capacity, eachDate(ly.from, ly.to).length);
  return {
    from: range.from,
    to: range.to,
    current,
    last_year: { ...ly, ...previous },
    change_pct: {
      occupancy: change(current.occupancy_pct, previous.occupancy_pct),
      revenue: change(current.revenue, previous.revenue),
      adr: current.adr != null && previous.adr != null ? change(current.adr, previous.adr) : null,
      revpar: current.revpar != null && previous.revpar ? change(current.revpar, previous.revpar) : null,
    },
  };
}

/** Night by night: rooms sold, occupancy, revenue, ADR, RevPAR; plus per room type. */
function occupancyByDate(db, propertyId, from, to) {
  const range = parseRange(from, to);
  const capacity = capacityPerNight(db, propertyId);
  const rooms = db.prepare('SELECT id, name, total_rooms FROM room_types WHERE property_id = ? ORDER BY position, id').all(propertyId);
  const nights = stayNights(db, propertyId, range.from, range.to);
  return {
    from: range.from,
    to: range.to,
    capacity,
    room_types: rooms.map((r) => ({ id: r.id, name: r.name })),
    days: range.dates.map((d) => {
      const day = nights.filter((n) => n.date === d);
      return {
        date: d,
        ...kpis(day, capacity, 1),
        by_room_type: Object.fromEntries(rooms.map((r) => {
          const sold = day.filter((n) => n.room_type_id === r.id).reduce((s, n) => s + n.rooms, 0);
          return [r.id, { sold, occupancy_pct: r.total_rooms ? round1((sold / r.total_rooms) * 100) : 0 }];
        })),
      };
    }),
  };
}

/** Per channel / OTA: bookings, room nights, revenue, ADR, share, cancellations. */
function channelPerformance(db, propertyId, from, to) {
  const range = parseRange(from, to);
  const nights = stayNights(db, propertyId, range.from, range.to);
  const cancelled = stayNights(db, propertyId, range.from, range.to, 'cancelled');
  const sources = new Map();
  const row = (name) => {
    if (!sources.has(name)) sources.set(name, { source: name, bookings: new Set(), room_nights: 0, revenue: 0, priced_rooms: 0, cancelled: new Set() });
    return sources.get(name);
  };
  for (const n of nights) {
    const r = row(n.source);
    r.bookings.add(n.booking_id);
    r.room_nights += n.rooms;
    if (n.revenue != null) { r.revenue += n.revenue; r.priced_rooms += n.rooms; }
  }
  for (const n of cancelled) row(n.source).cancelled.add(n.booking_id);
  const totalRevenue = nights.reduce((s, n) => s + (n.revenue ?? 0), 0);
  const totalNights = nights.reduce((s, n) => s + n.rooms, 0);
  const rows = [...sources.values()].map((r) => ({
    source: r.source,
    bookings: r.bookings.size,
    room_nights: r.room_nights,
    revenue: money(r.revenue),
    adr: r.priced_rooms ? money(r.revenue / r.priced_rooms) : null,
    revenue_share_pct: totalRevenue ? round1((r.revenue / totalRevenue) * 100) : 0,
    room_night_share_pct: totalNights ? round1((r.room_nights / totalNights) * 100) : 0,
    cancellations: r.cancelled.size,
    cancellation_rate_pct: r.bookings.size + r.cancelled.size ? round1((r.cancelled.size / (r.bookings.size + r.cancelled.size)) * 100) : 0,
  })).sort((a, b) => b.revenue - a.revenue || b.room_nights - a.room_nights);
  return { from: range.from, to: range.to, channels: rows, total_revenue: money(totalRevenue), total_room_nights: totalNights };
}

/** Bookings made per day (by booking date), against the same days last year. */
function pace(db, propertyId, from, to) {
  const range = parseRange(from || addDays(today(), -29), to || today());
  const made = (a, b) => db.prepare(`
    SELECT substr(b.created_at, 1, 10) AS day, COUNT(*) AS bookings, COALESCE(SUM(b.total), 0) AS value,
           SUM((SELECT SUM(l.rooms * (julianday(l.check_out) - julianday(l.check_in))) FROM booking_lines l WHERE l.booking_id = b.id)) AS room_nights
    FROM bookings b JOIN channels c ON c.id = b.channel_id
    WHERE c.property_id = ? AND substr(b.created_at, 1, 10) BETWEEN ? AND ?
    GROUP BY day`).all(propertyId, a, b);
  const now = new Map(made(range.from, range.to).map((r) => [r.day, r]));
  const before = new Map(made(lastYear(range.from), lastYear(range.to)).map((r) => [r.day, r]));
  const days = range.dates.map((d) => {
    const n = now.get(d);
    const p = before.get(lastYear(d));
    return {
      date: d,
      bookings: n?.bookings ?? 0,
      room_nights: Math.round(n?.room_nights ?? 0),
      value: money(n?.value ?? 0),
      last_year_bookings: p?.bookings ?? 0,
      last_year_room_nights: Math.round(p?.room_nights ?? 0),
    };
  });
  const sum = (k) => days.reduce((s, d) => s + d[k], 0);
  return {
    from: range.from,
    to: range.to,
    days,
    totals: {
      bookings: sum('bookings'), room_nights: sum('room_nights'), value: money(sum('value')),
      last_year_bookings: sum('last_year_bookings'), last_year_room_nights: sum('last_year_room_nights'),
    },
  };
}

/** The home page: today, the week ahead, month to date, channel mix, recent bookings. */
function dashboard(db, propertyId) {
  const t = today();
  const count = (sql) => db.prepare(`
    SELECT COUNT(DISTINCT b.id) AS bookings, COALESCE(SUM(l.rooms), 0) AS rooms
    FROM bookings b JOIN channels c ON c.id = b.channel_id JOIN booking_lines l ON l.booking_id = b.id
    WHERE c.property_id = :property AND b.status = 'confirmed' AND ${sql}`).get({ property: propertyId, today: t });
  const capacity = capacityPerNight(db, propertyId);
  const monthStart = `${t.slice(0, 8)}01`;
  const ahead = occupancyByDate(db, propertyId, t, addDays(t, 13)).days.map((d) => ({ date: d.date, occupancy_pct: d.occupancy_pct, room_nights: d.room_nights }));
  const recent = db.prepare(`
    SELECT b.id, b.external_ref, b.guest_name, b.check_in, b.check_out, b.total, b.currency, b.status, b.source, b.created_at,
           c.name AS channel_name, c.kind AS channel_kind
    FROM bookings b JOIN channels c ON c.id = b.channel_id
    WHERE c.property_id = ? ORDER BY b.created_at DESC, b.id DESC LIMIT 6`).all(propertyId)
    .map((b) => ({ ...b, source: sourceOf(b) }));
  return {
    today: t,
    capacity,
    arrivals: count('l.check_in = :today'),
    departures: count('l.check_out = :today'),
    in_house: count('l.check_in <= :today AND l.check_out > :today'),
    occupancy_today_pct: ahead[0]?.occupancy_pct ?? 0,
    next_7_days_occupancy_pct: capacity ? round1(ahead.slice(0, 7).reduce((s, d) => s + d.room_nights, 0) / (capacity * 7) * 100) : 0,
    ahead,
    month_to_date: summary(db, propertyId, monthStart, t),
    channel_mix_30_days: channelPerformance(db, propertyId, addDays(t, -29), t).channels,
    pickup_7_days: pace(db, propertyId, addDays(t, -6), t).totals,
    recent_bookings: recent,
  };
}

/** One line per property the user can see, for group / chain managers. */
function groupOverview(db, properties) {
  const t = today();
  return properties.map((p) => {
    const cap = capacityPerNight(db, p.id);
    const week = kpis(stayNights(db, p.id, t, addDays(t, 6)), cap, 7);
    const mtd = summary(db, p.id, `${t.slice(0, 8)}01`, t);
    const attention = db.prepare(`
      SELECT COUNT(*) AS n FROM bookings b JOIN channels c ON c.id = b.channel_id
      WHERE c.property_id = ? AND b.status = 'confirmed' AND b.handled_at IS NULL AND b.check_out >= ?
        AND (b.overbooked = 1 OR b.needs_attention IS NOT NULL)`).get(p.id, t).n;
    const failed = db.prepare(`
      SELECT COUNT(*) AS n FROM sync_queue q JOIN channels c ON c.id = q.channel_id
      WHERE c.property_id = ? AND c.enabled = 1 AND q.status = 'failed'`).get(p.id).n;
    return {
      ...p,
      rooms: cap,
      occupancy_today_pct: kpis(stayNights(db, p.id, t, t), cap, 1).occupancy_pct,
      next_7_days_occupancy_pct: week.occupancy_pct,
      revenue_mtd: mtd.current.revenue,
      adr_mtd: mtd.current.adr,
      revenue_mtd_change_pct: mtd.change_pct.revenue,
      issues: attention + failed,
    };
  });
}

/**
 * Rate parity: for each rate plan and night, the hotel's own (direct) price
 * next to the price each channel is sent. A channel cheaper than direct is a
 * parity problem; one with updates still pending or failed is out of sync.
 */
function parity(db, propertyId, { start, days = 14, rate_plan_id: planId } = {}) {
  const range = parseRange(start, addDays(start || today(), Math.min(Math.max(Number(days) || 14, 1), 31) - 1));
  const pricer = new Pricer(db);
  const channels = db.prepare("SELECT * FROM channels WHERE property_id = ? AND enabled = 1 AND kind NOT IN ('direct') ORDER BY id").all(propertyId);
  const plans = db.prepare(`
    SELECT rp.*, rt.name AS room_type_name FROM rate_plans rp JOIN room_types rt ON rt.id = rp.room_type_id
    WHERE rt.property_id = ? AND rp.active = 1 AND (? IS NULL OR rp.id = ?) ORDER BY rt.position, rt.id, rp.position, rp.id
  `).all(propertyId, planId ?? null, planId ?? null);
  const queued = db.prepare('SELECT status FROM sync_queue WHERE channel_id = ? AND room_type_id = ? AND date = ?');
  const listing = db.prepare('SELECT rate, closed FROM channel_listings WHERE channel_id = ? AND external_rate_plan_id = ? AND date = ?');
  const updates = new Map();
  const updateFor = (c, roomTypeId, d) => {
    const key = `${c.id}|${roomTypeId}|${d}`;
    if (!updates.has(key)) updates.set(key, channelUpdate(db, pricer, c, roomTypeId, d));
    return updates.get(key);
  };

  let below = 0;
  let outOfSync = 0;
  const rows = plans.map((plan) => ({
    rate_plan_id: plan.id,
    name: `${plan.room_type_name} · ${plan.name}`,
    channels: channels
      .filter((c) => db.prepare('SELECT 1 FROM channel_rate_plan_mappings WHERE channel_id = ? AND rate_plan_id = ?').get(c.id, plan.id))
      .map((c) => ({ code: c.code, name: c.name, markup_pct: c.rate_markup_pct })),
    days: range.dates.map((d) => {
      const direct = pricer.prices(plan.id, d).rate_double;
      const cells = {};
      for (const c of channels) {
        const u = updateFor(c, plan.room_type_id, d);
        const p = u.plans.find((x) => x.rate_plan_id === plan.id);
        if (!p) continue;
        const q = queued.get(c.id, plan.room_type_id, d);
        const shown = c.kind === 'simulated' ? listing.get(c.id, p.external_rate_plan_id, d) : null;
        const diff = direct ? round1(((p.rate - direct) / direct) * 100) : 0;
        const status = q?.status === 'failed' ? 'failed' : q ? 'pending' : shown && shown.rate !== p.rate ? 'mismatch' : 'in_sync';
        if (diff < 0 && !p.closed) below += 1;
        if (status !== 'in_sync') outOfSync += 1;
        cells[c.code] = { rate: p.rate, diff_pct: diff, closed: p.closed, status, shown_rate: shown?.rate ?? null };
      }
      return { date: d, direct, channels: cells };
    }),
  }));
  return {
    from: range.from,
    to: range.to,
    rate_plans: rows,
    summary: { below_direct: below, out_of_sync: outOfSync, channels: channels.length },
  };
}

// ---------- CSV ----------

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // Neutralise spreadsheet formulas in guest-supplied text.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

function exportCsv(db, propertyId, type, from, to) {
  if (type === 'bookings') {
    const range = parseRange(from, to);
    const rows = db.prepare(`
      SELECT b.*, c.name AS channel_name, c.kind AS channel_kind,
             (SELECT GROUP_CONCAT(rt.name || ' x' || l.rooms, '; ') FROM booking_lines l JOIN room_types rt ON rt.id = l.room_type_id WHERE l.booking_id = b.id) AS rooms
      FROM bookings b JOIN channels c ON c.id = b.channel_id
      WHERE c.property_id = ? AND b.check_in BETWEEN ? AND ? ORDER BY b.check_in, b.id`).all(propertyId, range.from, range.to);
    return toCsv(['Reference', 'Source', 'Status', 'Guest', 'Email', 'Phone', 'Check-in', 'Check-out', 'Rooms', 'Total', 'Currency', 'Overbooked', 'Booked at', 'Notes'],
      rows.map((b) => [b.external_ref, sourceOf(b), b.status, b.guest_name, b.guest_email, b.guest_phone, b.check_in, b.check_out, b.rooms,
        b.total, b.currency, b.overbooked ? 'yes' : '', b.created_at, b.notes]));
  }
  if (type === 'occupancy') {
    const o = occupancyByDate(db, propertyId, from, to);
    return toCsv(['Date', 'Rooms available', 'Room nights sold', 'Occupancy %', 'Revenue', 'ADR', 'RevPAR', ...o.room_types.map((r) => `${r.name} sold`)],
      o.days.map((d) => [d.date, d.rooms_available, d.room_nights, d.occupancy_pct, d.revenue, d.adr, d.revpar,
        ...o.room_types.map((r) => d.by_room_type[r.id].sold)]));
  }
  if (type === 'channels') {
    const c = channelPerformance(db, propertyId, from, to);
    return toCsv(['Channel', 'Bookings', 'Room nights', 'Revenue', 'ADR', 'Revenue share %', 'Cancellations', 'Cancellation rate %'],
      c.channels.map((r) => [r.source, r.bookings, r.room_nights, r.revenue, r.adr, r.revenue_share_pct, r.cancellations, r.cancellation_rate_pct]));
  }
  throw badRequest('type must be bookings, occupancy or channels');
}

module.exports = {
  summary, occupancyByDate, channelPerformance, pace, dashboard, groupOverview, parity, exportCsv, lastYear, parseRange,
};
