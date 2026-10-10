const { SimulatedChannel } = require('./simulated');

// Map a channel code to its adapter. Channels without a real connection yet
// fall back to the simulator. Example once a live integration exists:
//   booking_com: BookingComChannel,
const ADAPTERS = {};

function getAdapter(channel, ctx) {
  const Adapter = ADAPTERS[channel.code] || SimulatedChannel;
  return new Adapter(channel, ctx);
}

module.exports = { getAdapter, ADAPTERS };
