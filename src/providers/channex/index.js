const { transaction } = require('../../db');
const { queueFullResync } = require('../../queue');
const { badRequest } = require('../../errors');
const { applyRevision, applyBookingState, recordFailure } = require('./revisions');
const { channelUpdate } = require('../../sync');
const { Pricer } = require('../../pricing');
const { addDays, today, eachDate } = require('../../dates');

const CODE = 'channex';
const MAX_FEED_PAGES = 50; // safety stop: 50 pages x 10 revisions per pull
// Channex re-sends an unacknowledged booking for about 30 minutes, then it
// leaves the feed for good. Warn well before that.
const FEED_WINDOW_MIN = 30;
const STALL_WARN_MIN = 10;

/**
 * Everything specific to running hotels through Channex: connecting each of
 * our properties to a Channex property, mapping its rooms and rate plans to
 * ours, and pulling bookings from it. Pushing rates/availability is done by the normal sync
 * engine through ChannexChannel.
 */
class ChannexService {
  /**
   * @param {object|null} client   ChannexClient, or null when not configured
   * @param {object} opts.onChange called after bookings changed our calendar
   * @param {number} opts.pollMs   how often to check for bookings (0 = never)
   */
  constructor(db, client, { onChange = () => {}, pollMs = 60_000 } = {}) {
    this.db = db;
    this.client = client;
    this.onChange = onChange;
    this.pollMs = pollMs;
    this.timer = null;
    this.running = new Map(); // channel id -> pull in progress
    this.lastPull = new Map(); // our property id -> result of the last pull
  }

  channel(propertyId) {
    return this.db.prepare('SELECT * FROM channels WHERE property_id = ? AND kind = ?').get(propertyId, CODE) || null;
  }

  requireClient() {
    if (!this.client) throw badRequest('Channex is not configured. Set CHANNEX_API_KEY and restart the server.');
    return this.client;
  }

  status(propertyId) {
    const channel = this.channel(propertyId);
    const config = channel ? JSON.parse(channel.config || '{}') : {};
    const titles = config.titles || {};
    const rooms = channel
      ? this.db.prepare(`
          SELECT m.room_type_id, r.name AS room_type_name, m.external_room_id AS channex_room_type_id
          FROM channel_room_mappings m JOIN room_types r ON r.id = m.room_type_id
          WHERE m.channel_id = ? ORDER BY r.position, r.id
        `).all(channel.id).map((m) => ({ ...m, channex_room_type_title: titles[m.channex_room_type_id] ?? null }))
      : [];
    const plans = channel
      ? this.db.prepare(`
          SELECT m.rate_plan_id, rp.name AS rate_plan_name, rp.room_type_id, m.external_rate_plan_id AS channex_rate_plan_id
          FROM channel_rate_plan_mappings m JOIN rate_plans rp ON rp.id = m.rate_plan_id
          WHERE m.channel_id = ? ORDER BY rp.room_type_id, rp.position, rp.id
        `).all(channel.id).map((m) => ({ ...m, channex_rate_plan_title: titles[m.channex_rate_plan_id] ?? null }))
      : [];
    return {
      configured: Boolean(this.client),
      environment: this.client?.environment ?? null,
      connected: Boolean(channel?.enabled && config.property_id),
      channel_code: channel?.code ?? null,
      property: config.property_id
        ? { id: config.property_id, title: config.property_title, currency: config.currency }
        : null,
      rooms,
      rate_plans: plans,
      last_pull: this.lastPull.get(propertyId) || { at: null, ok: null, processed: 0, error: null },
      last_pull_ok_at: channel?.last_pull_ok_at ?? null,
      failures: channel
        ? this.db.prepare(`SELECT revision_id, booking_ref, error, attempts, first_seen_at, last_seen_at
                           FROM provider_failures WHERE channel_id = ? ORDER BY first_seen_at`).all(channel.id)
        : [],
    };
  }

  async properties() {
    return this.requireClient().listProperties();
  }

  async propertyRooms(propertyId) {
    const client = this.requireClient();
    const [roomTypes, ratePlans] = await Promise.all([client.listRoomTypes(propertyId), client.listRatePlans(propertyId)]);
    return {
      room_types: roomTypes,
      rate_plans: ratePlans.map((rp) => ({
        ...rp,
        // We send one price per night, which needs a manually priced per-room plan.
        usable: rp.sell_mode === 'per_room' && rp.rate_mode === 'manual',
      })),
    };
  }

  /**
   * Link one of our properties to a Channex property: our room types to
   * Channex room types, our rate plans to Channex rate plans. Rooms or plans
   * left out are not sent.
   * @param {{property_id: string, rooms: Array<{room_type_id, channex_room_type_id}>,
   *          rate_plans: Array<{rate_plan_id, channex_rate_plan_id}>}} body
   */
  async connect(ourPropertyId, body) {
    const client = this.requireClient();
    const { property_id: propertyId, rooms = [], rate_plans: plans = [] } = body || {};
    if (!propertyId) throw badRequest('Choose a Channex property');
    if (!Array.isArray(rooms) || rooms.length === 0) throw badRequest('Map at least one room type');
    if (!Array.isArray(plans) || plans.length === 0) throw badRequest('Map at least one rate plan');

    const taken = this.db.prepare("SELECT config FROM channels WHERE kind = 'channex' AND property_id != ?").all(ourPropertyId)
      .some((c) => JSON.parse(c.config || '{}').property_id === propertyId);
    if (taken) throw badRequest('That Channex property is already connected to another of your properties');

    const property = (await client.listProperties()).find((p) => p.id === propertyId);
    if (!property) throw badRequest('That property was not found in your Channex account');
    const { room_types: cxRooms, rate_plans: cxPlans } = await this.propertyRooms(propertyId);

    const ourRooms = new Map(this.db.prepare('SELECT * FROM room_types WHERE property_id = ?').all(ourPropertyId).map((r) => [r.id, r]));
    const roomMap = new Map(); // our room type id -> channex room type id
    for (const m of rooms) {
      if (!ourRooms.has(m.room_type_id)) throw badRequest(`Unknown room type ${m.room_type_id}`);
      if (roomMap.has(m.room_type_id)) throw badRequest('Each of your room types can be mapped only once');
      if (!cxRooms.some((rt) => rt.id === m.channex_room_type_id)) {
        throw badRequest(`Channex room type ${m.channex_room_type_id} is not in this property`);
      }
      if ([...roomMap.values()].includes(m.channex_room_type_id)) throw badRequest('Two room types are mapped to the same Channex room type');
      roomMap.set(m.room_type_id, m.channex_room_type_id);
    }
    const planMap = new Map();
    for (const m of plans) {
      const ours = this.db.prepare(`SELECT rp.* FROM rate_plans rp JOIN room_types rt ON rt.id = rp.room_type_id
                                    WHERE rp.id = ? AND rt.property_id = ?`).get(m.rate_plan_id, ourPropertyId);
      if (!ours) throw badRequest(`Unknown rate plan ${m.rate_plan_id}`);
      if (planMap.has(ours.id)) throw badRequest('Each of your rate plans can be mapped only once');
      if (!roomMap.has(ours.room_type_id)) throw badRequest(`Map the room type of "${ours.name}" first`);
      const theirs = cxPlans.find((rp) => rp.id === m.channex_rate_plan_id);
      if (!theirs) throw badRequest(`Channex rate plan ${m.channex_rate_plan_id} is not in this property`);
      if (theirs.room_type_id !== roomMap.get(ours.room_type_id)) throw badRequest(`Rate plan "${theirs.title}" belongs to a different room type`);
      if (!theirs.usable) {
        throw badRequest(`Rate plan "${theirs.title}" is ${theirs.sell_mode}/${theirs.rate_mode}; only manual per-room plans are supported`);
      }
      if ([...planMap.values()].includes(theirs.id)) throw badRequest('Two rate plans are mapped to the same Channex rate plan');
      planMap.set(ours.id, theirs.id);
    }

    const config = JSON.stringify({
      property_id: property.id,
      property_title: property.title,
      currency: property.currency,
      min_stay_type: property.min_stay_type,
      // Names to show in the dashboard; ids are what we send.
      titles: Object.fromEntries([...cxRooms, ...cxPlans].map((x) => [x.id, x.title])),
    });

    transaction(this.db, () => {
      const db = this.db;
      let channel = this.channel(ourPropertyId);
      if (channel) {
        db.prepare('UPDATE channels SET enabled = 1, config = ?, last_pull_ok_at = NULL WHERE id = ?').run(config, channel.id);
      } else {
        db.prepare(`INSERT INTO channels (property_id, code, name, kind, config, enabled, rate_markup_pct)
                    VALUES (?, ?, 'Channex', 'channex', ?, 1, 0)`).run(ourPropertyId, CODE, config);
        channel = this.channel(ourPropertyId);
      }
      for (const t of ['sync_queue', 'channel_room_mappings', 'channel_rate_plan_mappings']) {
        db.prepare(`DELETE FROM ${t} WHERE channel_id = ?`).run(channel.id);
      }
      const insRoom = db.prepare('INSERT INTO channel_room_mappings (channel_id, room_type_id, external_room_id) VALUES (?, ?, ?)');
      for (const [ours, theirs] of roomMap) insRoom.run(channel.id, ours, theirs);
      const insPlan = db.prepare('INSERT INTO channel_rate_plan_mappings (channel_id, rate_plan_id, external_rate_plan_id) VALUES (?, ?, ?)');
      for (const [ours, theirs] of planMap) insPlan.run(channel.id, ours, theirs);

      // The demo OTAs are stand-ins; once real OTAs are reached through
      // Channex they'd only add noise. They can be switched back on.
      db.prepare(`DELETE FROM sync_queue WHERE channel_id IN
                  (SELECT id FROM channels WHERE property_id = ? AND kind = 'simulated')`).run(ourPropertyId);
      db.prepare("UPDATE channels SET enabled = 0 WHERE property_id = ? AND kind = 'simulated'").run(ourPropertyId);

      queueFullResync(db, channel.id);
    });

    const warnings = [];
    const ourCurrency = this.db.prepare('SELECT currency FROM properties WHERE id = ?').get(ourPropertyId).currency;
    if (property.currency !== ourCurrency) {
      warnings.push(`Channex property uses ${property.currency} but this hotel uses ${ourCurrency}. Rates are sent as-is.`);
    }
    const unmappedRooms = ourRooms.size - roomMap.size;
    if (unmappedRooms > 0) warnings.push(`${unmappedRooms} room type(s) are not mapped and won't be sent to Channex.`);
    const ourPlanCount = this.db.prepare(`SELECT COUNT(*) AS n FROM rate_plans rp JOIN room_types rt ON rt.id = rp.room_type_id
                                          WHERE rt.property_id = ?`).get(ourPropertyId).n;
    if (ourPlanCount > planMap.size) warnings.push(`${ourPlanCount - planMap.size} rate plan(s) are not mapped and won't be sold through Channex.`);

    this.onChange();
    this.pull(ourPropertyId).catch(() => {});
    return { ...this.status(ourPropertyId), warnings };
  }

  disconnect(propertyId) {
    const channel = this.channel(propertyId);
    if (!channel) return this.status(propertyId);
    transaction(this.db, () => {
      this.db.prepare('UPDATE channels SET enabled = 0 WHERE id = ?').run(channel.id);
      this.db.prepare('DELETE FROM sync_queue WHERE channel_id = ?').run(channel.id);
    });
    return this.status(propertyId);
  }

  /**
   * Fetch and apply new booking revisions for one property, or for every
   * connected property. Concurrent calls for the same property share one run.
   */
  async pull(propertyId = null) {
    const channels = this.db.prepare("SELECT * FROM channels WHERE kind = 'channex' AND enabled = 1 AND (? IS NULL OR property_id = ?)")
      .all(propertyId, propertyId);
    let processed = 0;
    let failed = 0;
    for (const channel of channels) {
      if (!this.running.has(channel.id)) {
        this.running.set(channel.id, this.pullOnce(channel).finally(() => this.running.delete(channel.id)));
      }
      const r = await this.running.get(channel.id);
      processed += r.processed;
      failed += r.failed || 0;
    }
    return { processed, failed };
  }

  async pullOnce(channel) {
    const config = JSON.parse(channel.config || '{}');
    if (!this.client || !config.property_id) return { processed: 0, skipped: true };

    let processed = 0;
    const failedIds = new Set();
    try {
      // Revisions come oldest first. One that can't be applied stays in the
      // feed (unacknowledged, so Channex sends it again), but must not hold
      // up the ones behind it: when a whole page made no progress, move on
      // to the next page.
      let page = 1;
      for (let i = 0; i < MAX_FEED_PAGES; i += 1) {
        const revisions = await this.client.bookingFeed(config.property_id, page);
        if (revisions.length === 0) break;
        let acked = 0;
        for (const r of revisions) {
          if (failedIds.has(r.id)) continue; // already tried in this pull
          try {
            if (applyRevision(this.db, channel, r.id, r.attributes || {})) processed += 1;
          } catch (err) {
            failedIds.add(r.id);
            recordFailure(this.db, channel, r.id, r.attributes, err);
            console.error(`Channex booking revision ${r.id} could not be applied: ${err.message}`);
            continue;
          }
          // Acknowledge only after it is safely stored; if this fails, the
          // revision comes back next time and is skipped as already applied.
          await this.client.ackRevision(r.id);
          acked += 1;
        }
        if (acked === 0) page += 1;
      }
      const now = new Date().toISOString();
      this.db.prepare('UPDATE channels SET last_pull_ok_at = ? WHERE id = ?').run(now, channel.id);
      this.lastPull.set(channel.property_id, { at: now, ok: true, processed, failed: failedIds.size, error: null });
    } catch (err) {
      this.lastPull.set(channel.property_id, { at: new Date().toISOString(), ok: false, processed, failed: failedIds.size, error: err.message });
      throw err;
    } finally {
      if (processed > 0) this.onChange();
    }
    return { processed, failed: failedIds.size };
  }

  /**
   * After an outage longer than the feed's 30-minute window: fetch every
   * booking Channex received since `since` and apply any we are missing or
   * hold differently (status or dates). One-off and time-scoped on purpose;
   * the feed stays the normal path.
   */
  async recover(propertyId, since) {
    const client = this.requireClient();
    const channel = this.channel(propertyId);
    const config = channel ? JSON.parse(channel.config || '{}') : {};
    if (!channel?.enabled || !config.property_id) throw badRequest('Connect Channex first');
    const t = Date.parse(since);
    if (!since || Number.isNaN(t)) throw badRequest('Give the time to recover from, e.g. 2026-11-01T08:00');
    if (t > Date.now()) throw badRequest('That time is in the future');
    if (Date.now() - t > 90 * 86_400_000) throw badRequest('Recovery covers at most the last 90 days');
    const from = new Date(t).toISOString();

    const items = await client.listBookings(config.property_id, from);
    const local = this.db.prepare('SELECT status, check_in, check_out FROM bookings WHERE channel_id = ? AND external_ref = ?');
    const result = { checked: items.length, created: 0, updated: 0, unchanged: 0, failed: [] };
    for (const item of items) {
      const attrs = item.attributes || {};
      const bookingId = attrs.booking_id || attrs.id || item.id;
      const ours = local.get(channel.id, bookingId);
      const status = attrs.status === 'cancelled' ? 'cancelled' : 'confirmed';
      if (ours && ours.status === status && ours.check_in === attrs.arrival_date && ours.check_out === attrs.departure_date) {
        result.unchanged += 1;
        continue;
      }
      try {
        transaction(this.db, () => applyBookingState(this.db, channel, bookingId, attrs));
        if (ours) result.updated += 1; else result.created += 1;
      } catch (err) {
        result.failed.push({ booking: attrs.ota_reservation_code || bookingId, error: err.message });
      }
    }
    if (result.created || result.updated) this.onChange();
    await this.pull(propertyId).catch(() => {});
    return result;
  }

  /** Alerts for the banner: revisions stuck unapplied, or the feed not checked for a while. */
  alerts(propertyId) {
    const s = this.status(propertyId);
    if (!s.connected) return [];
    const out = [];
    const minutes = (iso) => Math.round((Date.now() - Date.parse(iso)) / 60_000);
    if (s.failures.length) {
      const oldest = minutes(s.failures[0].first_seen_at);
      out.push({
        level: 'error',
        page: 'channels',
        text: oldest >= FEED_WINDOW_MIN
          ? `${s.failures.length} booking update(s) from Channex could not be saved for ${oldest} min and may have left the feed: fix the cause, then use "Recover bookings". Last error: ${s.failures.at(-1).error}`
          : `${s.failures.length} booking update(s) from Channex could not be saved (${s.failures.at(-1).error}). Channex re-sends them for about ${FEED_WINDOW_MIN - oldest} more min.`,
      });
    }
    if (s.last_pull_ok_at) {
      const gap = minutes(s.last_pull_ok_at);
      if (gap >= FEED_WINDOW_MIN) {
        out.push({ level: 'error', page: 'channels', text: `Bookings haven't been fetched from Channex for ${gap} min; some may have been missed. Use "Recover bookings" from ${new Date(s.last_pull_ok_at).toLocaleString()}.` });
      } else if (gap >= STALL_WARN_MIN) {
        out.push({ level: 'warn', page: 'channels', text: `Bookings haven't been fetched from Channex for ${gap} min.` });
      }
    }
    return out;
  }

  /**
   * Health check. Doesn't trust "200 OK": reads availability, prices and
   * restrictions back from Channex for the next `days` nights and compares
   * them with what this app would send. Nights still queued for sending are
   * skipped (they are expected to differ).
   */
  async doctor(propertyId, { days = 14 } = {}) {
    const checks = [];
    const add = (key, label, status, detail) => checks.push({ key, label, status, detail });
    const mismatches = [];
    const finish = () => ({ ok: !checks.some((c) => c.status === 'fail'), checked_at: new Date().toISOString(), checks, mismatches });

    if (!this.client) { add('key', 'API key', 'fail', 'CHANNEX_API_KEY is not set'); return finish(); }
    add('key', 'API key', 'ok', `${this.client.environment} (${this.client.baseUrl})`);
    const channel = this.channel(propertyId);
    const config = channel ? JSON.parse(channel.config || '{}') : {};
    if (!channel?.enabled || !config.property_id) { add('connected', 'Connection', 'fail', 'This property is not connected to Channex'); return finish(); }

    try {
      const props = await this.client.listProperties();
      if (props.some((p) => p.id === config.property_id)) add('reach', 'Channex reachable', 'ok', `Property "${config.property_title}" found`);
      else { add('reach', 'Channex reachable', 'fail', 'The connected Channex property no longer exists in this account'); return finish(); }
    } catch (err) {
      add('reach', 'Channex reachable', 'fail', err.message);
      return finish();
    }

    const db = this.db;
    const unmappedRooms = db.prepare(`SELECT name FROM room_types WHERE property_id = ? AND id NOT IN
      (SELECT room_type_id FROM channel_room_mappings WHERE channel_id = ?)`).all(propertyId, channel.id);
    const unmappedPlans = db.prepare(`SELECT rt.name || ' · ' || rp.name AS name FROM rate_plans rp JOIN room_types rt ON rt.id = rp.room_type_id
      WHERE rt.property_id = ? AND rp.active = 1 AND rp.id NOT IN (SELECT rate_plan_id FROM channel_rate_plan_mappings WHERE channel_id = ?)`).all(propertyId, channel.id);
    add('mapping', 'Mapping', unmappedRooms.length || unmappedPlans.length ? 'warn' : 'ok',
      unmappedRooms.length || unmappedPlans.length
        ? `Not sent to Channex: ${[...unmappedRooms, ...unmappedPlans].map((r) => r.name).join(', ')}`
        : 'Every room type and active rate plan is mapped');

    const q = db.prepare(`SELECT SUM(status = 'pending') AS pending, SUM(status = 'failed') AS failed FROM sync_queue WHERE channel_id = ?`).get(channel.id);
    add('queue', 'Updates waiting to send', q.failed ? 'fail' : q.pending ? 'warn' : 'ok',
      q.failed ? `${q.failed} night(s) failed to send; use Retry failed` : q.pending ? `${q.pending} night(s) still being sent` : 'Nothing waiting');

    try {
      const feed = await this.client.bookingFeed(config.property_id);
      const failures = this.status(propertyId).failures;
      add('feed', 'Booking feed', failures.length ? 'fail' : 'ok',
        failures.length ? `${failures.length} booking update(s) could not be saved: ${failures.at(-1).error}`
          : `${feed.length ? `${feed.length} new booking update(s) waiting to be fetched` : 'No booking updates waiting'}`);
    } catch (err) {
      add('feed', 'Booking feed', 'fail', err.message);
    }
    const gap = channel.last_pull_ok_at ? Math.round((Date.now() - Date.parse(channel.last_pull_ok_at)) / 60_000) : null;
    add('pulled', 'Last booking check', gap == null ? 'warn' : gap >= FEED_WINDOW_MIN ? 'fail' : gap >= STALL_WARN_MIN ? 'warn' : 'ok',
      gap == null ? 'Not checked yet' : `${gap} min ago`);

    // Readback.
    const from = today();
    const to = addDays(from, Math.min(Math.max(days, 1), 60) - 1);
    const rooms = db.prepare('SELECT room_type_id, external_room_id FROM channel_room_mappings WHERE channel_id = ?').all(channel.id);
    const minField = config.min_stay_type === 'through' ? 'min_stay_through' : 'min_stay_arrival';
    try {
      const [avail, restr] = await Promise.all([
        this.client.getAvailability(config.property_id, from, to),
        this.client.getRestrictions(config.property_id, from, to, ['rate', 'stop_sell', 'closed_to_arrival', 'closed_to_departure', minField, 'max_stay']),
      ]);
      const pricer = new Pricer(db);
      const queued = db.prepare('SELECT 1 FROM sync_queue WHERE channel_id = ? AND room_type_id = ? AND date = ?');
      let compared = 0;
      let skipped = 0;
      const differ = (what, date, ours, theirs) => { if (mismatches.length < 100) mismatches.push({ what, date, ours, theirs }); };
      for (const r of rooms) {
        for (const d of eachDate(from, to)) {
          if (queued.get(channel.id, r.room_type_id, d)) { skipped += 1; continue; }
          const u = channelUpdate(db, pricer, channel, r.room_type_id, d);
          compared += 1;
          const theirsAvail = avail[r.external_room_id]?.[d];
          const label = db.prepare('SELECT name FROM room_types WHERE id = ?').get(r.room_type_id).name;
          if (Number(theirsAvail) !== u.available) differ(`${label}: rooms available`, d, u.available, theirsAvail ?? 'missing');
          for (const p of u.plans) {
            const t = restr[p.external_rate_plan_id]?.[d];
            const planName = `${label} · ${db.prepare('SELECT name FROM rate_plans WHERE id = ?').get(p.rate_plan_id).name}`;
            if (!t) { differ(`${planName}: everything`, d, 'values', 'missing'); continue; }
            if (Math.abs(Number(t.rate) - p.rate) > 0.005) differ(`${planName}: price`, d, p.rate, t.rate);
            if (Boolean(t.stop_sell) !== p.stop_sell) differ(`${planName}: stop sell`, d, p.stop_sell, Boolean(t.stop_sell));
            if (Boolean(t.closed_to_arrival) !== p.cta) differ(`${planName}: closed to arrival`, d, p.cta, Boolean(t.closed_to_arrival));
            if (Boolean(t.closed_to_departure) !== p.ctd) differ(`${planName}: closed to departure`, d, p.ctd, Boolean(t.closed_to_departure));
            if (t[minField] != null && Number(t[minField]) !== p.min_stay) differ(`${planName}: min stay`, d, p.min_stay, t[minField]);
            if (t.max_stay != null && Number(t.max_stay) !== (p.max_stay ?? 0)) differ(`${planName}: max stay`, d, p.max_stay ?? 0, t.max_stay);
          }
        }
      }
      add('readback', `Channex holds what we sent (next ${eachDate(from, to).length} nights)`, mismatches.length ? 'fail' : 'ok',
        mismatches.length
          ? `${mismatches.length} difference(s). Use "Resend everything" on the Channex card, then check again.`
          : `${compared} room-night(s) match${skipped ? `; ${skipped} still being sent were skipped` : ''}`);
    } catch (err) {
      add('readback', 'Channex holds what we sent', 'fail', `Could not read values back: ${err.message}`);
    }
    return finish();
  }

  /** Queue a full resync of one property to Channex (e.g. after the health check found differences). */
  resync(propertyId) {
    const channel = this.channel(propertyId);
    if (!channel?.enabled) throw badRequest('Connect Channex first');
    transaction(this.db, () => queueFullResync(this.db, channel.id));
    this.onChange();
  }

  start() {
    if (this.pollMs > 0 && !this.timer) {
      this.timer = setInterval(() => this.pull().catch((err) => console.error('Channex booking pull failed:', err.message)), this.pollMs);
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { ChannexService };
