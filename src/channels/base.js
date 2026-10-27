/**
 * Every OTA connection implements this interface. The sync engine only ever
 * talks to channels through it, so adding a real Booking.com / Agoda /
 * MakeMyTrip connection means writing one class like this and registering it
 * in ./index.js.
 */
class ChannelAdapter {
  /**
   * @param {object} channel row from the `channels` table
   * @param {object} ctx     { db }
   */
  constructor(channel, ctx) {
    this.channel = channel;
    this.ctx = ctx;
  }

  /**
   * Push availability, prices and restrictions to the channel.
   * Must throw if the channel rejects the update; the nights will then be retried.
   *
   * @param {Array<{room_type_id: number, external_room_id: string, date: string, available: number,
   *                room_closed: boolean, plans: Array<{rate_plan_id: number, external_rate_plan_id: string,
   *                prices: object, rate: number, stop_sell: boolean, closed: boolean, cta: boolean,
   *                ctd: boolean, min_stay: number, max_stay: number|null}>}>} updates
   *        One entry per room type and night; see channelUpdate() in src/sync.js.
   */
  // eslint-disable-next-line no-unused-vars
  async pushUpdates(updates) {
    throw new Error(`${this.constructor.name} does not implement pushUpdates`);
  }
}

module.exports = { ChannelAdapter };
