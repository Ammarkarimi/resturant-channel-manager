const { transaction } = require('../../db');
const { queueFullResync } = require('../../queue');
const { badRequest } = require('../../errors');
const { applyRevision } = require('./revisions');

const CODE = 'channex';
const MAX_FEED_PAGES = 50; // safety stop: 50 pages x 10 revisions per pull

/**
 * Everything specific to running the hotel through Channex: connecting a
 * Channex property, mapping its rooms and rate plans to ours, and pulling
 * bookings from it. Pushing rates/availability is done by the normal sync
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
    this.current = null;
    this.lastPull = { at: null, ok: null, processed: 0, error: null };
  }

  channel() {
    return this.db.prepare('SELECT * FROM channels WHERE kind = ?').get(CODE) || null;
  }

  requireClient() {
    if (!this.client) throw badRequest('Channex is not configured. Set CHANNEX_API_KEY and restart the server.');
    return this.client;
  }

  status() {
    const channel = this.channel();
    const config = channel ? JSON.parse(channel.config || '{}') : {};
    const mappings = channel
      ? this.db.prepare(`
          SELECT m.room_type_id, r.name AS room_type_name, m.external_room_id AS channex_room_type_id,
                 m.external_rate_plan_id AS channex_rate_plan_id
          FROM channel_room_mappings m JOIN room_types r ON r.id = m.room_type_id
          WHERE m.channel_id = ? ORDER BY r.id
        `).all(channel.id)
      : [];
    const titles = config.titles || {};
    for (const m of mappings) {
      m.channex_room_type_title = titles[m.channex_room_type_id] ?? null;
      m.channex_rate_plan_title = titles[m.channex_rate_plan_id] ?? null;
    }
    return {
      configured: Boolean(this.client),
      environment: this.client?.environment ?? null,
      connected: Boolean(channel?.enabled && config.property_id),
      channel_code: channel?.code ?? null,
      property: config.property_id
        ? { id: config.property_id, title: config.property_title, currency: config.currency }
        : null,
      mappings,
      last_pull: this.lastPull,
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
   * Link our hotel to a Channex property.
   * @param {{property_id: string, mappings: Array<{room_type_id: number, channex_room_type_id: string, channex_rate_plan_id: string}>}} body
   */
  async connect(body) {
    const client = this.requireClient();
    const { property_id: propertyId, mappings } = body || {};
    if (!propertyId) throw badRequest('Choose a Channex property');
    if (!Array.isArray(mappings) || mappings.length === 0) throw badRequest('Map at least one room type');

    const property = (await client.listProperties()).find((p) => p.id === propertyId);
    if (!property) throw badRequest('That property was not found in your Channex account');
    const { room_types: roomTypes, rate_plans: ratePlans } = await this.propertyRooms(propertyId);

    const ours = new Set(this.db.prepare('SELECT id FROM room_types').all().map((r) => r.id));
    const seenOurs = new Set();
    const seenTheirs = new Set();
    for (const m of mappings) {
      if (!ours.has(m.room_type_id)) throw badRequest(`Unknown room type ${m.room_type_id}`);
      if (seenOurs.has(m.room_type_id)) throw badRequest('Each of your room types can be mapped only once');
      if (!roomTypes.some((rt) => rt.id === m.channex_room_type_id)) {
        throw badRequest(`Channex room type ${m.channex_room_type_id} is not in this property`);
      }
      if (seenTheirs.has(m.channex_room_type_id)) throw badRequest('Two room types are mapped to the same Channex room type');
      const plan = ratePlans.find((rp) => rp.id === m.channex_rate_plan_id);
      if (!plan) throw badRequest('Choose a Channex rate plan for every mapped room type');
      if (plan.room_type_id !== m.channex_room_type_id) throw badRequest(`Rate plan "${plan.title}" belongs to a different room type`);
      if (!plan.usable) {
        throw badRequest(`Rate plan "${plan.title}" is ${plan.sell_mode}/${plan.rate_mode}; only manual per-room plans are supported`);
      }
      seenOurs.add(m.room_type_id);
      seenTheirs.add(m.channex_room_type_id);
    }

    const config = JSON.stringify({
      property_id: property.id,
      property_title: property.title,
      currency: property.currency,
      min_stay_type: property.min_stay_type,
      // Names to show in the dashboard; ids are what we send.
      titles: Object.fromEntries([...roomTypes, ...ratePlans].map((x) => [x.id, x.title])),
    });

    transaction(this.db, () => {
      const db = this.db;
      let channel = this.channel();
      if (channel) {
        db.prepare('UPDATE channels SET enabled = 1, config = ? WHERE id = ?').run(config, channel.id);
      } else {
        db.prepare(`INSERT INTO channels (code, name, kind, config, enabled, rate_markup_pct)
                    VALUES (?, 'Channex', 'channex', ?, 1, 0)`).run(CODE, config);
        channel = this.channel();
      }
      db.prepare('DELETE FROM sync_queue WHERE channel_id = ?').run(channel.id);
      db.prepare('DELETE FROM channel_room_mappings WHERE channel_id = ?').run(channel.id);
      const ins = db.prepare(`INSERT INTO channel_room_mappings (channel_id, room_type_id, external_room_id, external_rate_plan_id)
                              VALUES (?, ?, ?, ?)`);
      for (const m of mappings) ins.run(channel.id, m.room_type_id, m.channex_room_type_id, m.channex_rate_plan_id);

      // The demo OTAs are stand-ins; once real OTAs are reached through
      // Channex they'd only add noise. They can be switched back on.
      db.prepare("DELETE FROM sync_queue WHERE channel_id IN (SELECT id FROM channels WHERE kind = 'simulated')").run();
      db.prepare("UPDATE channels SET enabled = 0 WHERE kind = 'simulated'").run();

      queueFullResync(db, channel.id);
    });

    const warnings = [];
    const ourCurrency = this.db.prepare('SELECT currency FROM property WHERE id = 1').get().currency;
    if (property.currency !== ourCurrency) {
      warnings.push(`Channex property uses ${property.currency} but this hotel uses ${ourCurrency}. Rates are sent as-is.`);
    }
    const unmapped = this.db.prepare('SELECT name FROM room_types').all().length - mappings.length;
    if (unmapped > 0) warnings.push(`${unmapped} room type(s) are not mapped and won't be sent to Channex.`);

    this.onChange();
    this.pull().catch(() => {});
    return { ...this.status(), warnings };
  }

  disconnect() {
    const channel = this.channel();
    if (!channel) return this.status();
    transaction(this.db, () => {
      this.db.prepare('UPDATE channels SET enabled = 0 WHERE id = ?').run(channel.id);
      this.db.prepare('DELETE FROM sync_queue WHERE channel_id = ?').run(channel.id);
    });
    return this.status();
  }

  /** Fetch and apply new booking revisions. Concurrent calls share one run. */
  pull() {
    if (!this.current) {
      this.current = this.pullOnce().finally(() => { this.current = null; });
    }
    return this.current;
  }

  async pullOnce() {
    const channel = this.channel();
    const config = channel ? JSON.parse(channel.config || '{}') : {};
    if (!this.client || !channel?.enabled || !config.property_id) return { processed: 0, skipped: true };

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
      this.lastPull = { at: new Date().toISOString(), ok: true, processed, error: null };
    } catch (err) {
      this.lastPull = { at: new Date().toISOString(), ok: false, processed, error: err.message };
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
