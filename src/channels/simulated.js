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
        (channel_id, external_room_id, date, available, rate, closed, min_stay, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (channel_id, external_room_id, date) DO UPDATE SET
        available = excluded.available, rate = excluded.rate, closed = excluded.closed,
        min_stay = excluded.min_stay, synced_at = excluded.synced_at
    `);
    for (const u of updates) {
      upsert.run(this.channel.id, u.external_room_id, u.date, u.available, u.rate,
        u.closed ? 1 : 0, u.min_stay, now);
    }
  }
}

module.exports = { SimulatedChannel };
