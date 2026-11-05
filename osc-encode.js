'use strict';

const osc = require('osc');

// osc.js infers ordinary values, but raw Nil throws and non-byte typed views
// are not inferred as blobs. Annotate those at the transport boundary only.
function encodeArgument(value) {
  if (value === null) return { type: 'N', value: null };
  if (Array.isArray(value)) return value.map(encodeArgument);
  if (ArrayBuffer.isView(value) && !(value instanceof Uint8Array)) {
    return { type: 'b', value: new Uint8Array(value.buffer, value.byteOffset, value.byteLength) };
  }
  return value;
}

function encodeOsc(address, args) {
  return Buffer.from(osc.writePacket({ address, args: (args || []).map(encodeArgument) }));
}

module.exports = { encodeOsc };
