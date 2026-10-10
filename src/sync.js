const { getAdapter } = require('./channels');
const { getCell } = require('./inventory');

const MAX_ATTEMPTS = 5;
const DEFAULT_BATCH_SIZE = 200;

const backoffMs = (attempts) => Math.min(1000 * 2 ** attempts, 60_000);
const roundMoney = (n) => Math.round(n * 100) / 100;

/** Translate our inventory into what a given channel should display. */
function channelView(cell, channel) {
  return {
    available: Math.max(0, cell.available),
    rate: roundMoney(cell.rate * (1 + channel.rate_markup_pct / 100)),
    closed: Boolean(cell.stop_sell) || cell.available <= 0,
    stop_sell: Boolean(cell.stop_sell),
    min_stay: cell.min_stay,
  };
}

class SyncEngine {
  /**
   * @param {object} opts.providers  clients for connectivity providers, e.g. { channex }
   */
  constructor(db, { intervalMs = 1000, providers = {} } = {}) {
    this.db = db;
    this.intervalMs = intervalMs;
    this.providers = providers;
    this.timer = null;
    this.current = null;
    // Per channel: when we last called it and when we may call it again.
    this.lastPushAt = new Map();
    this.pausedUntil = new Map();
  }

  start() {
    if (!this.timer) this.timer = setInterval(() => this.kick(), this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Run a pass now unless one is already running; never rejects. */
  kick() {
    if (!this.current) {
      this.current = this.runOnce()
        .catch((err) => console.error('sync pass failed', err))
        .finally(() => { this.current = null; });
    }
    return this.current;
  }

  /** Push every due cell, grouped per channel. Returns per-channel results. */
  async runOnce() {
    const { db } = this;
    const now = new Date().toISOString();
    const due = db.prepare(`
      SELECT q.channel_id, q.room_type_id, q.date, q.attempts, q.version,
             m.external_room_id, m.external_rate_plan_id
      FROM sync_queue q
      JOIN channels c ON c.id = q.channel_id AND c.enabled = 1
      JOIN channel_room_mappings m ON m.channel_id = q.channel_id AND m.room_type_id = q.room_type_id
      WHERE q.status = 'pending' AND q.next_attempt_at <= ?
      ORDER BY q.channel_id, q.date
    `).all(now);

    const byChannel = new Map();
    for (const row of due) {
      if (!byChannel.has(row.channel_id)) byChannel.set(row.channel_id, []);
      byChannel.get(row.channel_id).push(row);
    }

    const results = await Promise.all([...byChannel].map(async ([channelId, rows]) => {
      const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
      const adapter = getAdapter(channel, { db, providers: this.providers });
      const batchSize = adapter.batchSize || DEFAULT_BATCH_SIZE;
      // Rate-limited channels (e.g. Channex: 10 calls/min) get at most one
      // call per pass, spaced at least minIntervalMs apart. Anything left
      // stays queued and goes out together on a later pass.
      const minInterval = adapter.minIntervalMs || 0;
      const nowMs = Date.now();
      if ((this.pausedUntil.get(channelId) || 0) > nowMs
        || (this.lastPushAt.get(channelId) || 0) + minInterval > nowMs) {
        return { channel: channel.code, pushed: 0, failed: 0, deferred: rows.length };
      }
      const maxBatches = minInterval ? 1 : Infinity;
      let pushed = 0;
      let failed = 0;
      for (let i = 0, n = 0; i < rows.length && n < maxBatches; i += batchSize, n += 1) {
        const batch = rows.slice(i, i + batchSize);
        this.lastPushAt.set(channelId, Date.now());
        const ok = await this.pushBatch(channel, adapter, batch);
        if (ok) pushed += batch.length; else failed += batch.length;
      }
      return { channel: channel.code, pushed, failed, deferred: rows.length - pushed - failed };
    }));
    return results;
  }

  async pushBatch(channel, adapter, batch) {
    const { db } = this;
    const updates = batch.map((row) => ({
      room_type_id: row.room_type_id,
      external_room_id: row.external_room_id,
      external_rate_plan_id: row.external_rate_plan_id,
      date: row.date,
      ...channelView(getCell(db, row.room_type_id, row.date), channel),
    }));

    let error = null;
    try {
      await adapter.pushUpdates(updates);
    } catch (err) {
      error = err;
    }

    const log = db.prepare(
      'INSERT INTO sync_log (channel_id, cells, ok, message, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const now = new Date();
    if (!error) {
      const del = db.prepare(`
        DELETE FROM sync_queue
        WHERE channel_id = ? AND room_type_id = ? AND date = ? AND version = ?
      `);
      for (const r of batch) del.run(r.channel_id, r.room_type_id, r.date, r.version);
      log.run(channel.id, batch.length, 1, `Pushed ${batch.length} update(s)`, now.toISOString());
      return true;
    }

    const fail = db.prepare(`
      UPDATE sync_queue
      SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?,
          status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
      WHERE channel_id = ? AND room_type_id = ? AND date = ? AND version = ?
    `);
    // A provider can ask us to back off (rate limit, server trouble); hold
    // every call to that channel until then, not just this batch.
    const retryAfter = error.retryAfterMs || 0;
    if (retryAfter) this.pausedUntil.set(channel.id, now.getTime() + retryAfter);
    for (const r of batch) {
      const next = new Date(now.getTime() + Math.max(retryAfter, backoffMs(r.attempts))).toISOString();
      fail.run(error.message, next, MAX_ATTEMPTS, r.channel_id, r.room_type_id, r.date, r.version);
    }
    log.run(channel.id, batch.length, 0, error.message, now.toISOString());
    return false;
  }
}

/** Give failed cells another round of attempts. */
function retryFailed(db, channelId = null) {
  return db.prepare(`
    UPDATE sync_queue SET status = 'pending', attempts = 0, next_attempt_at = ?
    WHERE status = 'failed' AND (? IS NULL OR channel_id = ?)
  `).run(new Date().toISOString(), channelId, channelId).changes;
}

module.exports = {
  SyncEngine, retryFailed, channelView, MAX_ATTEMPTS,
};
