const { ChannelAdapter } = require('./base');
const { addDays, today } = require('../dates');

/**
 * Collapse per-night updates into as few Channex values as possible: runs of
 * consecutive nights with identical values become one date_from/date_to range.
 */
function toRanges(updates, keyOf, valueOf) {
  const groups = new Map();
  for (const u of updates) {
    const key = keyOf(u);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(u);
  }
  const out = [];
  for (const [key, items] of groups) {
    items.sort((a, b) => (a.date < b.date ? -1 : 1));
    let run = null;
    for (const u of items) {
      const value = valueOf(u);
      const same = run && addDays(run.date_to, 1) === u.date && JSON.stringify(run.value) === JSON.stringify(value);
      if (same) {
        run.date_to = u.date;
      } else {
        if (run) out.push(run);
        run = { key, date_from: u.date, date_to: u.date, value };
      }
    }
    if (run) out.push(run);
  }
  return out;
}

const dates = (r) => (r.date_from === r.date_to ? { date: r.date_from } : { date_from: r.date_from, date_to: r.date_to });

/**
 * Sends our calendar to Channex, which passes it on to every OTA connected
 * to the property there (Booking.com, Agoda, MakeMyTrip, Expedia, ...).
 *
 * Availability is set per Channex room type; rate, stop-sell and minimum stay
 * per Channex rate plan.
 */
class ChannexChannel extends ChannelAdapter {
  constructor(channel, ctx) {
    super(channel, ctx);
    this.client = ctx.providers?.channex;
    this.config = JSON.parse(channel.config || '{}');
    this.minIntervalMs = this.client?.minIntervalMs ?? 7000;
    // A whole 500-day sync fits in one call (Channex accepts up to 10 MB).
    this.batchSize = 20_000;
  }

  buildPayloads(updates) {
    const propertyId = this.config.property_id;
    // Channex refuses changes to past dates.
    const current = updates.filter((u) => u.date >= today());

    const availability = toRanges(current, (u) => u.external_room_id, (u) => u.available)
      .map((r) => ({ property_id: propertyId, room_type_id: r.key, ...dates(r), availability: r.value }));

    // `min_stay` is translated by Channex according to the property's
    // min-stay type, but isn't accepted when that type is "both".
    const minStayField = this.config.min_stay_type === 'both' ? 'min_stay_arrival' : 'min_stay';
    const restrictions = toRanges(
      current.filter((u) => u.external_rate_plan_id),
      (u) => u.external_rate_plan_id,
      (u) => ({ rate: u.rate.toFixed(2), stop_sell: u.stop_sell, min_stay: u.min_stay }),
    ).map((r) => ({
      property_id: propertyId,
      rate_plan_id: r.key,
      ...dates(r),
      rate: r.value.rate,
      stop_sell: r.value.stop_sell,
      [minStayField]: r.value.min_stay,
    }));

    return { availability, restrictions };
  }

  async pushUpdates(updates) {
    if (!this.client) throw new Error('Channex is not configured (set CHANNEX_API_KEY and restart)');
    if (!this.config.property_id) throw new Error('Channex property is not selected');
    const { availability, restrictions } = this.buildPayloads(updates);
    await this.client.pushAri('availability', availability);
    await this.client.pushAri('restrictions', restrictions);
  }
}

module.exports = { ChannexChannel, toRanges };
