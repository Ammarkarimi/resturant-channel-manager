const { ChannelAdapter } = require('./base');

/**
 * Stands in for a real OTA. Instead of calling a partner API it records what
 * the OTA would now be showing in `channel_listings`, so the dashboard can
 * prove every channel received the change.
 */
class SimulatedChannel extends ChannelAdapter {
  async pushUpdates(updates) {
    const { db } = this.ctx;
    const live = db.prepare('SELECT simulate_outage FROM channels WHERE id = ?').get(this.channel.id);
    if (live && live.simulate_outage) {
      throw new Error(`${this.channel.name} API unavailable (simulated outage)`);
    }

    const now = new Date().toISOString();
    const upsert = db.prepare(`
      INSERT INTO channel_listings
        (channel_id, external_room_id, external_rate_plan_id, date, available, rate, closed, cta, ctd, min_stay, max_stay, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (channel_id, external_rate_plan_id, date) DO UPDATE SET
        external_room_id = excluded.external_room_id, available = excluded.available, rate = excluded.rate,
        closed = excluded.closed, cta = excluded.cta, ctd = excluded.ctd, min_stay = excluded.min_stay,
        max_stay = excluded.max_stay, synced_at = excluded.synced_at
    `);
    for (const u of updates) {
      for (const p of u.plans) {
        upsert.run(this.channel.id, u.external_room_id, p.external_rate_plan_id, u.date, u.available, p.rate,
          p.closed ? 1 : 0, p.cta ? 1 : 0, p.ctd ? 1 : 0, p.min_stay, p.max_stay, now);
      }
    }
  }
}

module.exports = { SimulatedChannel };
