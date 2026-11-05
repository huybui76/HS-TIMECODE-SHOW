/* OSC parser: filter addresses before decoding args, including observe mode.
   Supports nested bundles/arrays; malformed leaves never reach consumers.
   parsePacket returns {messages, malformed, received, filtered, maxDepth}.
   onMessage(address, args, allowed, tags) avoids per-leaf message objects. */
'use strict';

const {
  DEFAULT_WHITELIST, DEFAULT_BLACKLIST, OSC_HARD_BLOCK_SEGMENTS,
  OSC_NOISY_SEGMENTS, OSC_FILTER_CACHE_SIZE, OSC_MAX_BUNDLE_DEPTH
} = require('./realtime-config');
const BUNDLE = Buffer.from('#bundle\0', 'ascii');
const HARD_BLOCKED = new Set(OSC_HARD_BLOCK_SEGMENTS);
const NOISY = new Set(OSC_NOISY_SEGMENTS);

function validAddress(address) {
  if (typeof address !== 'string' || address.length < 2 || address[0] !== '/' ||
      address.endsWith('/') || address.includes('//')) return false;
  for (let i = 1; i < address.length; i++) {
    const c = address.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
}

function trieNode() { return { children: new Map(), wildcard: null, terminal: false }; }

/* '*' matches exactly one nonempty segment. Exact keys bypass trie traversal. */
class SegmentMatcher {
  constructor(patterns, opts) {
    this.cache = new Map();
    this.maxCache = opts && Number.isInteger(opts.maxCache) && opts.maxCache >= 0
      ? opts.maxCache : OSC_FILTER_CACHE_SIZE;
    this.setPatterns(patterns);
  }

  setPatterns(patterns) {
    this.cache.clear();
    this.exact = new Set();
    this.root = trieNode();
    for (const pattern of Array.isArray(patterns) ? patterns : []) {
      if (!validAddress(pattern)) continue;
      const segments = pattern.slice(1).split('/');
      if (!segments.includes('*')) { this.exact.add(pattern); continue; }
      let node = this.root;
      for (const segment of segments) {
        if (segment === '*') {
          if (!node.wildcard) node.wildcard = trieNode();
          node = node.wildcard;
        } else {
          if (!node.children.has(segment)) node.children.set(segment, trieNode());
          node = node.children.get(segment);
        }
      }
      node.terminal = true;
    }
  }

  matches(address) {
    if (this.exact.has(address)) return true;
    if (this.cache.has(address)) return this.cache.get(address);
    if (!validAddress(address)) return false;
    const segments = address.slice(1).split('/');
    let nodes = [this.root];
    for (const segment of segments) {
      const next = [];
      for (const node of nodes) {
        const child = node.children.get(segment);
        if (child) next.push(child);
        if (node.wildcard) next.push(node.wildcard);
      }
      nodes = next;
      if (!nodes.length) break;
    }
    const hit = nodes.some((node) => node.terminal);
    if (this.maxCache > 0) {
      if (this.cache.size >= this.maxCache) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(address, hit);
    }
    return hit;
  }
}

class OscFilter {
  constructor(opts) {
    const o = opts || {};
    this.white = new SegmentMatcher(o.whitelist || DEFAULT_WHITELIST);
    this.black = new SegmentMatcher(o.blacklist || DEFAULT_BLACKLIST);
    this.learnAddresses = new Set();
    this.learning = false;
  }
  setWhitelist(list) { this.white.setPatterns(list || DEFAULT_WHITELIST); }
  setBlacklist(list) { this.black.setPatterns(list || DEFAULT_BLACKLIST); }
  setLearning(on) { this.learning = !!on; }
  setLearnAddresses(list) {
    this.learnAddresses = new Set((Array.isArray(list) ? list : [])
      .filter((address) => validAddress(address) && !address.includes('*')));
  }
  allows(address) {
    if (!validAddress(address)) return false;
    const segments = address.slice(1).split('/');
    if (segments.some((segment) => HARD_BLOCKED.has(segment))) return false;
    if (this.black.matches(address)) return false;
    if (this.white.exact.has(address) || this.learnAddresses.has(address)) return true;
    if (segments.some((segment) => NOISY.has(segment))) return false;
    return this.white.matches(address) || this.learning;
  }
  isSelected(address) {
    return typeof address === 'string' && address.toLowerCase().startsWith('/composition/selected');
  }
}

/* OSC strings are ASCII, NUL-terminated, with zero padding to four bytes. */
function readPaddedString(buf, offset, utf8 = false) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= buf.length) return null;
  let end = offset;
  while (end < buf.length && buf[end] !== 0) {
    if (!utf8 && buf[end] > 0x7f) return null;
    end++;
  }
  if (end >= buf.length) return null;
  const next = Math.ceil((end + 1) / 4) * 4;
  if (next > buf.length) return null;
  for (let p = end + 1; p < next; p++) if (buf[p] !== 0) return null;
  return { str: buf.toString(utf8 ? 'utf8' : 'ascii', offset, end), next };
}

function readArgs(buf, offset, tags, out) {
  let p = offset;
  let current = out;
  const stack = [];
  for (let i = 1; i < tags.length; i++) {
    const t = tags[i];
    switch (t) {
      case 'i': {
        if (p + 4 > buf.length) throw new Error('trunc int');
        current.push(buf.readInt32BE(p)); p += 4; break;
      }
      case 'f': case 'd': {
        const size = t === 'f' ? 4 : 8;
        if (p + size > buf.length) throw new Error('trunc number');
        const value = t === 'f' ? buf.readFloatBE(p) : buf.readDoubleBE(p);
        if (!Number.isFinite(value)) throw new Error('nonfinite number');
        current.push(value); p += size; break;
      }
      case 'h': case 't': {
        if (p + 8 > buf.length) throw new Error('trunc int64');
        current.push(Number(buf.readBigInt64BE(p))); p += 8; break;
      }
      case 's': case 'S': {
        const r = readPaddedString(buf, p, true);
        if (!r) throw new Error('invalid string');
        current.push(r.str); p = r.next; break;
      }
      case 'b': {
        if (p + 4 > buf.length) throw new Error('trunc blob');
        const len = buf.readInt32BE(p);
        p += 4;
        const next = p + Math.ceil(len / 4) * 4;
        if (len < 0 || next > buf.length) throw new Error('blob size');
        for (let j = p + len; j < next; j++) if (buf[j] !== 0) throw new Error('blob padding');
        current.push(buf.subarray(p, p + len)); p = next; break;
      }
      case 'T': current.push(true); break;
      case 'F': current.push(false); break;
      case 'N': current.push(null); break;
      case 'I': current.push(Infinity); break;
      case 'c':
        if (p + 4 > buf.length) throw new Error('trunc char');
        current.push(String.fromCharCode(buf.readUInt32BE(p))); p += 4; break;
      case 'm':
        if (p + 4 > buf.length) throw new Error('trunc MIDI');
        current.push(new Uint8Array(buf.subarray(p, p + 4))); p += 4; break;
      case 'r':
        if (p + 4 > buf.length) throw new Error('trunc color');
        current.push({ r: buf[p], g: buf[p + 1], b: buf[p + 2], a: buf[p + 3] / 255 });
        p += 4; break;
      case '[': {
        const nested = [];
        current.push(nested); stack.push(current); current = nested; break;
      }
      case ']':
        if (!stack.length) throw new Error('unexpected array end');
        current = stack.pop(); break;
      default: throw new Error('unknown tag ' + t);
    }
  }
  if (stack.length) throw new Error('unterminated array');
  if (p !== buf.length) throw new Error('trailing args');
  return out;
}

/* -2 is an early filtered leaf; all accepted messages consume the full buffer.
   Observe is intentionally not a permission to decode denied addresses. */
function parseMessage(buf, offset, filter, out, opts) {
  if (buf[offset] !== 0x2f) return -1;
  const a = readPaddedString(buf, offset);
  if (!a || !validAddress(a.str)) throw new Error('invalid address');
  const address = a.str;
  if (address.slice(1).split('/').some((segment) => HARD_BLOCKED.has(segment)) ||
      (filter && !filter.allows(address))) return -2;
  if (buf.length % 4 !== 0) throw new Error('unaligned message');
  const tagRes = readPaddedString(buf, a.next);
  if (!tagRes || tagRes.str[0] !== ',') throw new Error('invalid typetag');
  const args = readArgs(buf, tagRes.next, tagRes.str, []);
  if (opts && typeof opts.onMessage === 'function') opts.onMessage(address, args, true, tagRes.str);
  else out.push({ address, args, allowed: true });
  return buf.length;
}

function parsePacket(buf, filter, opts) {
  const messages = [];
  let malformed = 0, received = 0, filtered = 0, maxDepth = 0;
  const walk = (data, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    if (depth > OSC_MAX_BUNDLE_DEPTH) { malformed++; return; }
    if (data.length < 4) { malformed++; return; }
    if (data[0] === 0x2f) {
      received++;
      try {
        const end = parseMessage(data, 0, filter, messages, opts);
        if (end === -2) filtered++;
        else if (end === -1) malformed++;
      } catch (_) { malformed++; }
      return;
    }
    if (data.length < 16 || !data.subarray(0, 8).equals(BUNDLE)) { malformed++; return; }
    let off = 16;
    while (off < data.length) {
      if (off + 4 > data.length) { malformed++; return; }
      const size = data.readInt32BE(off);
      off += 4;
      if (size <= 0 || size % 4 !== 0 || off + size > data.length) { malformed++; return; }
      walk(data.subarray(off, off + size), depth + 1);
      off += size;
    }
  };
  if (!Buffer.isBuffer(buf)) malformed++;
  else walk(buf, 0);
  return { messages, malformed, received, filtered, maxDepth };
}

module.exports = {
  SegmentMatcher, OscFilter, parsePacket, parseMessage, readPaddedString,
  DEFAULT_WHITELIST, DEFAULT_BLACKLIST
};
