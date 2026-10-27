const { transaction } = require('../../db');
const { queueFullResync } = require('../../queue');
const { badRequest } = require('../../errors');
const { applyRevision } = require('./revisions');

const CODE = 'channex';
const MAX_FEED_PAGES = 50; // safety stop: 50 pages x 10 revisions per pull

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
        db.prepare('UPDATE channels SET enabled = 1, config = ? WHERE id = ?').run(config, channel.id);
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
    for (const channel of channels) {
      if (!this.running.has(channel.id)) {
        this.running.set(channel.id, this.pullOnce(channel).finally(() => this.running.delete(channel.id)));
      }
      processed += (await this.running.get(channel.id)).processed;
    }
    return { processed };
  }

  async pullOnce(channel) {
    const config = JSON.parse(channel.config || '{}');
    if (!this.client || !config.property_id) return { processed: 0, skipped: true };

    let processed = 0;
    try {
      for (let page = 0; page < MAX_FEED_PAGES; page += 1) {
        const revisions = await this.client.bookingFeed(config.property_id);
        if (revisions.length === 0) break;
        for (const r of revisions) {
          if (applyRevision(this.db, channel, r.id, r.attributes || {})) processed += 1;
          // Acknowledge only after it is safely stored; if this fails, the
          // revision comes back next time and is skipped as already applied.
          await this.client.ackRevision(r.id);
        }
      }
      this.lastPull.set(channel.property_id, { at: new Date().toISOString(), ok: true, processed, error: null });
    } catch (err) {
      this.lastPull.set(channel.property_id, { at: new Date().toISOString(), ok: false, processed, error: err.message });
      throw err;
    } finally {
      if (processed > 0) this.onChange();
    }
    return { processed };
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
