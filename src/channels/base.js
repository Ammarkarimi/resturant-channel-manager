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
   * Push rate / availability / restriction changes to the OTA.
   * Must throw if the OTA rejects the update; the cells will then be retried.
   *
   * @param {Array<{external_room_id: string, date: string, available: number,
   *                rate: number, closed: boolean, min_stay: number}>} updates
   */
  // eslint-disable-next-line no-unused-vars
  async pushUpdates(updates) {
    throw new Error(`${this.constructor.name} does not implement pushUpdates`);
  }
}

module.exports = { ChannelAdapter };
