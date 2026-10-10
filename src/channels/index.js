const { SimulatedChannel } = require('./simulated');
const { ChannexChannel } = require('./channex');

// Adapters by channel kind. A connectivity provider (Channex) is one channel
// that reaches every OTA; `simulated` stands in for an OTA in the demo.
const BY_KIND = {
  channex: ChannexChannel,
  simulated: SimulatedChannel,
};

// Per-channel-code overrides, e.g. a direct OTA connection or a test double.
const ADAPTERS = {};

function getAdapter(channel, ctx) {
  const Adapter = ADAPTERS[channel.code] || BY_KIND[channel.kind] || SimulatedChannel;
  return new Adapter(channel, ctx);
}

module.exports = { getAdapter, ADAPTERS };
