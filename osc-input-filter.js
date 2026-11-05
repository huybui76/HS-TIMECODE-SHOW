'use strict';

const osc = require('osc');
const BUNDLE_HEADER = Buffer.from('#bundle\0', 'ascii');
const BLOCKED_SEGMENTS = new Set(['position', 'transport', 'tempocontroller', 'audio', 'dashboard']);
const MAX_BUNDLE_DEPTH = 32;

function isIndex(value) {
  if (!value || value.charCodeAt(0) < 49 || value.charCodeAt(0) > 57) return false;
  for (let i = 1; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

class OscInputFilter {
  constructor() {
    this.floatAddresses = new Set();
    // Packet counters, not leaf-message counters; no per-packet logging.
    this.stats = { received: 0, accepted: 0, dropped: 0, malformed: 0 };
  }

  setFloatAddresses(addresses) {
    this.floatAddresses = new Set(Array.isArray(addresses)
      ? addresses.filter((address) => typeof address === 'string' && address.startsWith('/'))
      : []);
  }

  allows(address) {
    const parts = address.split('/');
    for (const part of parts) {
      if (BLOCKED_SEGMENTS.has(part)) return false;
    }
    if (this.floatAddresses.has(address)) return true;
    if (parts[0] !== '' || parts[1] !== 'composition') return false;
    return (parts.length === 7 && parts[2] === 'layers' && isIndex(parts[3]) &&
      parts[4] === 'clips' && isIndex(parts[5]) && parts[6] === 'connect') ||
      (parts.length === 5 && parts[2] === 'columns' && isIndex(parts[3]) && parts[4] === 'connect');
  }

  filterPacket(data) {
    this.stats.received++;
    const visit = (packet, depth) => {
      if (depth > MAX_BUNDLE_DEPTH || packet.length < 4 || packet.length % 4 !== 0) {
        throw new Error('Invalid OSC packet size or bundle depth');
      }
      if (packet[0] === 47) {
        const end = packet.indexOf(0);
        if (end < 0) throw new Error('Unterminated OSC address');
        const paddedEnd = (end + 4) & ~3;
        if (paddedEnd > packet.length) throw new Error('Truncated OSC address');
        for (let i = 0; i < end; i++) {
          if (packet[i] < 32 || packet[i] > 126) throw new Error('Invalid OSC address');
        }
        for (let i = end; i < paddedEnd; i++) {
          if (packet[i] !== 0) throw new Error('Invalid OSC address padding');
        }
        // Only the address is read. Typetags, blobs and arguments remain opaque.
        return this.allows(packet.toString('ascii', 0, end)) ? packet : null;
      }
      if (packet.length < 16 || !packet.subarray(0, 8).equals(BUNDLE_HEADER)) {
        throw new Error('Invalid OSC bundle header');
      }
      const chunks = [packet.subarray(0, 16)];
      let changed = false;
      for (let offset = 16; offset < packet.length;) {
        if (offset + 4 > packet.length) throw new Error('Truncated OSC bundle size');
        const size = packet.readInt32BE(offset);
        const start = offset + 4;
        if (size < 4 || size % 4 !== 0 || size > packet.length - start) {
          throw new Error('Invalid OSC bundle element size');
        }
        const child = packet.subarray(start, start + size);
        const kept = visit(child, depth + 1);
        if (kept) {
          if (kept.length === size) chunks.push(packet.subarray(offset, start), kept);
          else {
            const prefix = Buffer.allocUnsafe(4);
            prefix.writeInt32BE(kept.length);
            chunks.push(prefix, kept);
          }
        }
        if (kept !== child) changed = true;
        offset = start + size;
      }
      if (chunks.length === 1) return null;
      return changed ? Buffer.concat(chunks) : packet;
    };

    try {
      const kept = visit(data, 0);
      if (kept) this.stats.accepted++;
      else this.stats.dropped++;
      return kept;
    } catch (_) {
      this.stats.malformed++;
      this.stats.dropped++;
      return null;
    }
  }
}

class FilteredUDPPort extends osc.UDPPort {
  constructor(options, inputFilter) {
    super(options);
    this.inputFilter = inputFilter;
  }

  decodeOSC(data, packetInfo) {
    const kept = this.inputFilter.filterPacket(data);
    if (kept) super.decodeOSC(kept, packetInfo);
  }
}

module.exports = { OscInputFilter, FilteredUDPPort };
