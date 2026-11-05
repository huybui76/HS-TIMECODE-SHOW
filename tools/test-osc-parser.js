#!/usr/bin/env node
/* =====================================================================
   HS TIMECODE · Test OSC PARSER + FILTER + RING (thuần)
   Chạy: node tools/test-osc-parser.js
   ===================================================================== */
'use strict';

const path = require('path');
const P = require(path.join(__dirname, '..', 'osc-parser.js'));
const { OscRing } = require(path.join(__dirname, '..', 'osc-ring.js'));
const { SegmentMatcher, OscFilter, parsePacket } = P;
const CFG = require(path.join(__dirname, '..', 'realtime-config.js'));

/* ---------------------------- harness ---------------------------- */
let pass = 0, fail = 0;
const results = [];
function test(id, name, fn) {
  try { fn(); pass++; results.push({ id, name, ok: true }); }
  catch (e) { fail++; results.push({ id, name, ok: false, msg: e.message }); }
}
function ok(c, m) { if (!c) throw new Error(m || 'điều kiện sai'); }
function eq(a, b, m) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'eq'}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
}
function near(a, b, tol, m) { if (Math.abs(a - b) > tol) throw new Error(`${m || 'near'}: ${a} ≠ ${b}`); }

/* ---------------------- OSC packet builder ---------------------- */
function pad4(buf) {
  const rem = buf.length % 4;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem)]);
}
function oscString(s) { return pad4(Buffer.from(s + '\0', 'ascii')); }
function makeMessage(address, tags, values) {
  const parts = [oscString(address), oscString(',' + tags)];
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i], v = values[i];
    const b = Buffer.alloc(4);
    if (t === 'f') { b.writeFloatBE(v); parts.push(b); }
    else if (t === 'i') { b.writeInt32BE(v); parts.push(b); }
    else if (t === 'd') { const d = Buffer.alloc(8); d.writeDoubleBE(v); parts.push(d); }
    else if (t === 's') { parts.push(oscString(v)); }
    else if (t === 'b') {
      const len = Buffer.alloc(4); len.writeInt32BE(v.length);
      parts.push(len, pad4(v));
    }
  }
  return Buffer.concat(parts);
}
function makeBundle(...elems) {
  const head = Buffer.concat([
    Buffer.from('#bundle\0', 'ascii'),
    Buffer.from([0, 0, 0, 0, 0, 0, 0, 0])   // time tag
  ]);
  const parts = [head];
  for (const e of elems) {
    const len = Buffer.alloc(4); len.writeInt32BE(e.length);
    parts.push(len, e);
  }
  return Buffer.concat(parts);
}

const CONNECT = '/composition/layers/3/clips/1/connect';

/* ======================= 1. PARSER ======================= */
test('P1', 'float message', () => {
  const buf = makeMessage('/composition/layers/2/video/opacity', 'f', [0.4488]);
  const r = parsePacket(buf);
  eq(r.messages.length, 1);
  eq(r.messages[0].address, '/composition/layers/2/video/opacity');
  near(r.messages[0].args[0], 0.4488, 1e-4);
  eq(r.malformed, 0);
});

test('P2', 'int message', () => {
  const buf = makeMessage(CONNECT, 'i', [1]);
  const r = parsePacket(buf);
  eq(r.messages.length, 1);
  eq(r.messages[0].args[0], 1);
});

test('P3', 'string message', () => {
  const buf = makeMessage(CONNECT, 's', ['hello']);
  const r = parsePacket(buf);
  eq(r.messages[0].args[0], 'hello');
});

test('P20', 'UTF-8 string và char/MIDI/color giữ tương thích decoder cũ', () => {
  const text = 'Ti\u1ebfng Vi\u1ec7t';
  const strPacket = Buffer.concat([oscString(CONNECT), oscString(',s'), pad4(Buffer.from(text + '\0', 'utf8'))]);
  eq(parsePacket(strPacket).messages[0].args[0], text);
  const payload = Buffer.from([0, 0, 0, 65, 0, 144, 60, 127, 255, 64, 32, 128]);
  const full = Buffer.concat([oscString(CONNECT), oscString(',cmr'), payload]);
  const r = parsePacket(full);
  eq(r.malformed, 0);
  eq(r.messages[0].args[0], 'A');
  eq([...r.messages[0].args[1]], [0, 144, 60, 127]);
  eq(r.messages[0].args[2], { r: 255, g: 64, b: 32, a: 128 / 255 });
});

test('P4', 'nested bundle (3 cấp)', () => {
  const inner = makeBundle(makeMessage(CONNECT, 'i', [1]));
  const mid = makeBundle(inner, makeMessage('/composition/layers/2/video/opacity', 'f', [0.5]));
  const outer = makeBundle(mid);
  const r = parsePacket(outer);
  eq(r.messages.length, 2, 'đủ 2 message trong bundle lồng');
  ok(r.malformed === 0, 'không lỗi');
});

test('P5', 'gói cắt cụt → malformed, không throw', () => {
  const full = makeMessage(CONNECT, 'f', [0.5]);
  const cut = full.subarray(0, full.length - 6);
  const r = parsePacket(cut);
  ok(r.malformed > 0, 'phát hiện gói hỏng');
  eq(r.messages.length, 0);
});

test('P6', 'địa chỉ không có \\0 → malformed', () => {
  const buf = Buffer.from('/composition/layers/3/clips/1/connect', 'ascii'); // không \0
  const r = parsePacket(buf);
  ok(r.malformed > 0, 'báo lỗi');
});

test('P7', 'type tag lạ → bỏ qua an toàn', () => {
  const buf = makeMessage(CONNECT, 'x', []);
  const r = parsePacket(buf);
  ok(r.malformed >= 1, 'tag lạ bị loại');
  eq(r.messages.length, 0);
});

test('P8', 'nhiều type trong 1 message (ifs)', () => {
  const buf = makeMessage(CONNECT, 'ifs', [1, 0.5, 'x']);
  const r = parsePacket(buf);
  eq(r.messages[0].args, [1, 0.5, 'x']);
});

test('P9', 'bundle depth > MAX → bỏ, không crash', () => {
  let buf = makeMessage(CONNECT, 'i', [1]);
  for (let i = 0; i < 25; i++) buf = makeBundle(buf);
  const r = parsePacket(buf);
  ok(r.malformed > 0, 'phát hiện quá sâu');
});

test('P10', 'blob argument', () => {
  const buf = makeMessage(CONNECT, 'b', [Buffer.from([1, 2, 3, 4])]);
  const r = parsePacket(buf);
  eq(r.messages[0].args[0].length, 4);
});

/* ==================== 2. FILTER / WILDCARD ==================== */
test('F1', 'wildcard * khớp đúng 1 phân đoạn', () => {
  const m = new SegmentMatcher(['/composition/layers/*/clips/*/connect']);
  ok(m.matches('/composition/layers/3/clips/1/connect'), 'khớp');
  ok(!m.matches('/composition/layers/3/clips/1/connect/x'), 'không khớp quá dài');
  ok(!m.matches('/composition/layers/3/connect'), 'không khớp thiếu đoạn');
});

test('F2', 'wildcard không khớp xuyên nhiều phân đoạn', () => {
  const m = new SegmentMatcher(['/a/*/c']);
  ok(!m.matches('/a/b/x/c'), '* chỉ 1 đoạn');
});

test('F3', 'default chỉ connect/clear, float phải whitelist rõ ràng', () => {
  const f = new OscFilter();
  ok(f.allows('/composition/layers/3/clips/1/connect'), 'connect được giữ');
  ok(!f.allows('/composition/layers/2/video/opacity'), 'opacity không mặc định');
  f.setWhitelist([...CFG.DEFAULT_WHITELIST, '/composition/layers/2/video/opacity']);
  ok(f.allows('/composition/layers/2/video/opacity'), 'opacity được gán rõ ràng');
  ok(!f.allows('/composition/layers/1/video/position'), 'position bị blacklist');
  ok(!f.allows('/composition/tempocontroller/tempo'), 'tempo bị blacklist');
  ok(!f.allows('/sys/foo'), 'sys bị chặn');
});

test('F4', 'selectedlayer bị chặn (ưu tiên địa chỉ cụ thể)', () => {
  const f = new OscFilter();
  ok(!f.allows('/composition/selectedlayer/clips/1/connect'), 'selectedlayer bị chặn');
  ok(f.allows('/composition/layers/3/clips/1/connect'), 'layers cụ thể được giữ');
});

test('F5', 'filter chặn TRƯỚC khi decode tham số', () => {
  // gói có args hỏng nhưng address bị blacklist → không malformed (không đọc args)
  const buf = Buffer.concat([
    oscString('/composition/layers/1/video/position'),
    oscString(',f'),
    Buffer.from([0xff, 0xff])         // args cắt cụt
  ]);
  const f = new OscFilter();
  const r = parsePacket(buf, f);
  eq(r.messages.length, 0, 'bị lọc');
  eq(r.malformed, 0, 'không đọc args → không báo malformed');
});

test('F6', 'custom whitelist thay đổi runtime', () => {
  const f = new OscFilter();
  f.setWhitelist(['/custom/*']);
  ok(f.allows('/custom/anything'), 'whitelist mới');
  ok(!f.allows('/composition/layers/3/clips/1/connect'), 'whitelist cũ bị thay');
});

const POSITION_FEEDBACK = [
  '/composition/selectedclip/transport/position',
  '/composition/layers/1/clips/1/transport/position',
  '/composition/selectedlayer/position',
  '/composition/layers/1/position',
  '/composition/layers/2/clips/1/transport/position',
  '/composition/layers/2/position',
  '/composition/layers/1/video/position/x'
];

test('F7', 'position bị chặn cả khi Monitor observe và whitelist cho phép', () => {
  const f = new OscFilter({ whitelist: POSITION_FEEDBACK, blacklist: [] });
  for (const address of POSITION_FEEDBACK) {
    ok(!f.allows(address), 'không whitelist position: ' + address);
    // Address hợp lệ nhưng thiếu typetag/args: phải bỏ trước khi decode.
    const r = parsePacket(oscString(address), f, { observe: true });
    eq(r.messages.length, 0, 'không đưa position tới UI');
    eq(r.malformed, 0, 'không đọc typetag/args');
  }
});

test('F8', 'bundle lồng lọc position, giữ connect 1/0 và float đúng thứ tự', () => {
  const f = new OscFilter({ whitelist: [...CFG.DEFAULT_WHITELIST, '/composition/layers/2/video/opacity'] });
  const buf = makeBundle(
    makeMessage(POSITION_FEEDBACK[0], 'f', [0.1]),
    makeMessage(CONNECT, 'i', [1]),
    makeBundle(
      makeMessage(POSITION_FEEDBACK[3], 'f', [0.2]),
      makeMessage('/composition/layers/2/video/opacity', 'f', [0.5]),
      makeMessage(CONNECT, 'i', [0])
    )
  );
  const r = parsePacket(buf, f, { observe: true });
  eq(r.messages.map((m) => [m.address, m.args[0]]), [
    [CONNECT, 1], ['/composition/layers/2/video/opacity', 0.5], [CONNECT, 0]
  ]);
  eq(r.malformed, 0);
});

test('F9', '100000 position khi observe không decode và không sinh message', () => {
  const f = new OscFilter();
  const buf = oscString(POSITION_FEEDBACK[1]);
  for (let i = 0; i < 100000; i++) {
    const r = parsePacket(buf, f, { observe: true });
    if (r.messages.length || r.malformed) throw new Error('position lọt hoặc bị decode');
  }
});

test('F10', 'chặn đúng phân đoạn position, không chặn param có tên gần giống', () => {
  const address = '/composition/layers/1/video/effects/test/positionoffset';
  const f = new OscFilter({ whitelist: [address], blacklist: [] });
  const r = parsePacket(makeMessage(address, 'f', [0.5]), f, { observe: true });
  eq(r.messages.length, 1);
  eq(r.messages[0].args, [0.5]);
});

const TEXT_GENERATOR_FEEDBACK = [
  '/composition/layers/3/clips/1/video/source/textgenerator',
  '/composition/layers/3/clips/1/video/source/textgenerator/color/phase',
  '/composition/layers/3/clips/1/video/source/textgenerator/color/palette/color',
  '/composition/layers/3/clips/1/video/source/textgenerator/opacity',
  '/composition/selectedclip/video/source/textgenerator/opacity'
];

test('F11', 'textgenerator bị chặn trước decode cả khi observe hoặc whitelist', () => {
  const f = new OscFilter({ whitelist: TEXT_GENERATOR_FEEDBACK, blacklist: [] });
  for (const address of TEXT_GENERATOR_FEEDBACK) {
    ok(!f.allows(address), 'không whitelist textgenerator: ' + address);
    for (const observe of [false, true]) {
      const r = parsePacket(oscString(address), f, { observe });
      eq(r.messages.length, 0);
      eq(r.malformed, 0, 'không đọc typetag/args');
    }
  }
});

test('F12', 'bundle lồng bỏ textgenerator, giữ connect và opacity ngoài source', () => {
  const buf = makeBundle(
    makeMessage(CONNECT, 'i', [1]),
    makeBundle(
      ...TEXT_GENERATOR_FEEDBACK.map((address) => makeMessage(address, 'f', [0.5])),
      makeMessage('/composition/layers/3/video/opacity', 'f', [0.5])
    ),
    makeMessage(CONNECT, 'i', [0])
  );
  const f = new OscFilter({ whitelist: [...CFG.DEFAULT_WHITELIST, '/composition/layers/3/video/opacity'] });
  const r = parsePacket(buf, f, { observe: true });
  eq(r.messages.map((m) => [m.address, m.args[0]]), [
    [CONNECT, 1], ['/composition/layers/3/video/opacity', 0.5], [CONNECT, 0]
  ]);
  eq(r.malformed, 0);
});

test('F13', '100000 textgenerator không sinh message; khớp đúng phân đoạn', () => {
  const f = new OscFilter();
  const buf = oscString(TEXT_GENERATOR_FEEDBACK[1]);
  for (let i = 0; i < 100000; i++) {
    const r = parsePacket(buf, f, { observe: true });
    if (r.messages.length || r.malformed) throw new Error('textgenerator lọt hoặc bị decode');
  }
  const address = '/composition/layers/3/video/effects/test/textgeneratoroffset';
  f.setWhitelist([address]);
  eq(parsePacket(makeMessage(address, 'f', [0.5]), f, { observe: true }).messages.length, 1);
});

test('F14', 'observe không bypass whitelist/blacklist, args hỏng không được đọc', () => {
  const f = new OscFilter();
  for (const address of ['/custom', '/sys/status']) {
    const buf = Buffer.concat([oscString(address), oscString(',f'), Buffer.from([1, 2])]);
    for (const observe of [false, true]) {
      const r = parsePacket(buf, f, { observe });
      eq([r.received, r.filtered, r.malformed, r.messages.length], [1, 1, 0, 0]);
    }
  }
});

test('F15', 'learn rõ ràng cho discovery, không cho noisy/hard-block/blacklist', () => {
  const f = new OscFilter();
  ok(!f.allows('/custom'), 'unknown bị chặn bình thường');
  f.setLearning(true);
  ok(f.allows('/custom'), 'learn cho phép địa chỉ một đoạn');
  ok(f.allows('/composition/layers/1/video/opacity'), 'learn khám phá float');
  for (const address of [
    '/composition/layers/1/audio/volume', '/composition/layers/1/clips/1/transport/play',
    '/custom/position', '/custom/textgenerator/opacity', '/custom/tempocontroller/tempo',
    '/custom/dashboard/value', '/sys/status'
  ]) ok(!f.allows(address), 'learn vẫn chặn ' + address);
  f.setLearning(false);
  ok(!f.allows('/custom'), 'tắt learn khôi phục policy');
});

test('F16', 'noisy chỉ mở exact whitelist hoặc exact learn address', () => {
  const audio = '/composition/layers/1/audio/volume';
  const transport = '/composition/layers/1/clips/1/transport/play';
  const f = new OscFilter({ whitelist: ['/composition/layers/*/audio/*', '/composition/layers/*/clips/*/transport/*'] });
  f.setLearning(true);
  ok(!f.allows(audio) && !f.allows(transport), 'wildcard và learn không mở noisy');
  f.setWhitelist([audio, transport]);
  ok(f.allows(audio) && f.allows(transport), 'exact assigned mở noisy');
  ok(!f.allows('/composition/layers/2/audio/volume'), 'không mở địa chỉ lân cận');
  f.setWhitelist([]);
  f.setLearnAddresses([audio, transport, '/composition/layers/*/audio/pan']);
  ok(f.allows(audio) && f.allows(transport), 'exact learning mở noisy');
  ok(!f.allows('/composition/layers/1/audio/pan'), 'learning list không wildcard');
  f.setLearnAddresses([]);
  ok(!f.allows(audio), 'xóa exact learning');
});

test('F17', 'hard-block không thể mở bằng assigned hoặc learning exact', () => {
  for (const segment of CFG.OSC_HARD_BLOCK_SEGMENTS) {
    const address = '/custom/' + segment + '/value';
    const f = new OscFilter({ whitelist: [address], blacklist: [] });
    f.setLearning(true);
    f.setLearnAddresses([address]);
    ok(!f.allows(address), 'hard-block ' + segment);
    const r = parsePacket(oscString(address), f, { observe: true });
    eq([r.received, r.filtered, r.malformed], [1, 1, 0]);
  }
});

test('F18', 'trie exact/wildcard overlap, cache bị chặn kích thước và reset', () => {
  const m = new SegmentMatcher(['/a/b/c', '/a/*/d', '/*/b/e', '/a/*'], { maxCache: 3 });
  for (const address of ['/a/b/c', '/a/x/d', '/a/b/e', '/z/b/e', '/a/b']) ok(m.matches(address), address);
  for (const address of ['/a/b/c/d', '/x/a', '/z/b/d']) ok(!m.matches(address), address);
  for (let i = 0; i < 100; i++) m.matches('/a/' + i + '/d');
  ok(m.cache.size <= 3, 'bounded cache');
  ok(m.exact.has('/a/b/c'), 'exact Set');
  m.setPatterns(['/replacement']);
  eq(m.cache.size, 0);
  ok(!m.matches('/a/x/d') && m.matches('/replacement'), 'reset trie/exact');
  const uncached = new SegmentMatcher(['/a/*'], { maxCache: 0 });
  ok(uncached.matches('/a/b'));
  eq(uncached.cache.size, 0);
});

test('F19', 'whitelist constructor/setter không khôi phục broad float mặc định', () => {
  const f = new OscFilter({ whitelist: [], blacklist: [] });
  ok(!f.allows(CONNECT), 'empty whitelist');
  f.setWhitelist();
  ok(f.allows(CONNECT), 'reset defaults');
  ok(!f.allows('/composition/master') && !f.allows('/composition/layers/1/video/opacity'));
  for (const address of [
    '/composition/columns/1/connect', '/composition/layers/1/clear',
    '/composition/groups/1/columns/2/connect',
    '/composition/groups/1/layers/2/clips/3/connect', '/composition/groups/1/layers/2/clear'
  ]) ok(f.allows(address), address);
});

test('P11', 'callback nhận thứ tự/tags, đếm tất cả leaf kể cả filtered và malformed', () => {
  const f = new OscFilter();
  const buf = makeBundle(
    oscString('/custom/position'),
    makeMessage(CONNECT, 'i', [1]),
    makeBundle(oscString('/custom'), makeMessage(CONNECT, 'i', [0])),
    makeMessage(CONNECT, 'x', [])
  );
  const got = [];
  const r = parsePacket(buf, f, { onMessage: (address, args, allowed, tags) => got.push([address, args, allowed, tags]) });
  eq(got, [[CONNECT, [1], true, ',i'], [CONNECT, [0], true, ',i']]);
  eq(r.messages, [], 'callback không sinh message object array');
  eq([r.received, r.filtered, r.malformed, r.maxDepth], [5, 2, 1, 2]);
  const array = parsePacket(buf, f);
  eq(array.messages.map((m) => [m.address, m.args, m.allowed]), got.map((m) => m.slice(0, 3)));
  eq([array.received, array.filtered, array.malformed, array.maxDepth], [5, 2, 1, 2]);
});

test('P12', 'address padding/NUL/ASCII và alias slash phải hợp lệ trước lọc', () => {
  const f = new OscFilter({ whitelist: ['/custom', '/custom/*'], blacklist: [] });
  eq(parsePacket(makeMessage('/custom', 'i', [1]), f).messages.length, 1);
  const badPadding = makeMessage('/a', 'i', [1]);
  badPadding[3] = 1;
  const highAscii = makeMessage('/custom', 'i', [1]);
  highAscii[2] = 0xf5;
  for (const buf of [
    badPadding, highAscii, Buffer.from('/custom', 'ascii'),
    makeMessage('/custom//value', 'i', [1]), makeMessage('/custom/', 'i', [1]),
    makeMessage('/custom value', 'i', [1]), makeMessage('/custom\0alias', 'i', [1])
  ]) {
    const r = parsePacket(buf, f);
    eq(r.messages.length, 0);
    eq(r.malformed, 1, 'invalid address không alias thành filtered/accepted');
  }
});

test('P13', 'blob padding thiếu/corrupt và size âm bị loại', () => {
  const full = makeMessage(CONNECT, 'b', [Buffer.from([1])]);
  eq(parsePacket(full).messages[0].args[0].length, 1);
  const corrupt = Buffer.from(full); corrupt[corrupt.length - 1] = 1;
  const negative = Buffer.from(full); negative.writeInt32BE(-1, oscString(CONNECT).length + 4);
  for (const buf of [full.subarray(0, full.length - 1), corrupt, negative]) {
    const r = parsePacket(buf);
    eq([r.messages.length, r.malformed], [0, 1]);
  }
});

test('P14', 'array tags giữ nesting, array thiếu/thừa dấu bị loại', () => {
  const good = makeMessage(CONNECT, 'i[f[TF]s]N', [1, null, 0.5, null, null, null, null, 'hello']);
  eq(parsePacket(good).messages[0].args, [1, [0.5, [true, false], 'hello'], null]);
  for (const tags of ['[i', 'i]', '][', '[[i]']) {
    const r = parsePacket(makeMessage(CONNECT, tags, [1, 1, 1]));
    eq([r.messages.length, r.malformed], [0, 1]);
  }
});

test('P15', 'float/double NaN/Infinity bị loại, finite vẫn hợp lệ', () => {
  for (const tag of ['f', 'd']) {
    for (const value of [NaN, Infinity, -Infinity]) {
      const r = parsePacket(makeMessage(CONNECT, tag, [value]));
      eq([r.messages.length, r.malformed], [0, 1]);
    }
    eq(parsePacket(makeMessage(CONNECT, tag, [-0.25])).messages[0].args, [-0.25]);
  }
});

test('P16', 'message trailing bytes/bad typetag/arg padding không được chấp nhận', () => {
  const string = makeMessage(CONNECT, 's', ['x']);
  const badString = Buffer.from(string); badString[badString.length - 1] = 1;
  const badTag = makeMessage(CONNECT, 'i', [1]); badTag[oscString(CONNECT).length] = 0x69;
  for (const buf of [
    Buffer.concat([makeMessage(CONNECT, 'i', [1]), Buffer.alloc(4)]),
    Buffer.concat([makeMessage(CONNECT, 'i', [1]), Buffer.alloc(1)]),
    badString, badTag
  ]) eq(parsePacket(buf).malformed, 1);
});

test('P17', 'bundle element size >0, aligned, bounded và không bỏ qua tail', () => {
  const leaf = makeMessage(CONNECT, 'i', [1]);
  const bundle = makeBundle(leaf);
  for (const size of [0, -1, leaf.length - 1, leaf.length + 4]) {
    const buf = Buffer.from(bundle); buf.writeInt32BE(size, 16);
    const r = parsePacket(buf);
    eq([r.messages.length, r.malformed], [0, 1], 'bad size ' + size);
  }
  for (const tail of [Buffer.from([1]), Buffer.from([1, 2, 3]), Buffer.alloc(4)]) {
    const r = parsePacket(Buffer.concat([bundle, tail]));
    eq([r.messages.length, r.received, r.malformed], [1, 1, 1]);
  }
  eq(parsePacket(bundle.subarray(0, 15)).malformed, 1, 'truncated bundle header');
});

test('P18', 'bundle depth cap đúng boundary và thống kê maxDepth', () => {
  let buf = makeMessage(CONNECT, 'i', [1]);
  for (let i = 0; i < CFG.OSC_MAX_BUNDLE_DEPTH; i++) buf = makeBundle(buf);
  const atLimit = parsePacket(buf);
  eq([atLimit.messages.length, atLimit.maxDepth, atLimit.malformed], [1, CFG.OSC_MAX_BUNDLE_DEPTH, 0]);
  const tooDeep = parsePacket(makeBundle(buf));
  eq([tooDeep.messages.length, tooDeep.maxDepth, tooDeep.malformed], [0, CFG.OSC_MAX_BUNDLE_DEPTH + 1, 1]);
});

test('P19', 'wrong packet types/empty packets không throw', () => {
  for (const value of [null, undefined, 'osc', {}, new Uint8Array(4), Buffer.alloc(0), Buffer.alloc(4)]) {
    const r = parsePacket(value);
    eq([r.messages.length, r.malformed], [0, 1]);
  }
});

/* ==================== 3. RING BUFFER ==================== */
test('R1', 'ghi và đọc trong cửa sổ thời gian', () => {
  const ring = new OscRing({ capacity: 64, minIntervalMs: 0 });
  ring.push('/a', 1, 100);
  ring.push('/a', 2, 200);
  ring.push('/b', 3, 300);
  const got = [];
  ring.forEachInWindow(150, 350, (id, v) => got.push(v));
  eq(got, [2, 3]);
});

test('R2', 'dedupe giá trị trùng', () => {
  const ring = new OscRing({ capacity: 64, minIntervalMs: 0 });
  ok(ring.push('/a', 0.5, 100), 'lần 1 ghi');
  ok(!ring.push('/a', 0.5, 200), 'trùng giá trị → bỏ');
  eq(ring.dropped, 1);
});

test('R3', 'rate limit 60Hz, vẫn giữ giá trị cuối', () => {
  const ring = new OscRing({ capacity: 64, minIntervalMs: 16.67 });
  ok(ring.push('/a', 0.1, 0), 'ghi đầu');
  ok(!ring.push('/a', 0.2, 5), 'trong 16ms → bỏ');
  ok(!ring.push('/a', 0.3, 10), 'vẫn trong → bỏ');
  ok(ring.push('/a', 0.4, 20), 'qua 16ms → ghi');
  const vals = [];
  ring.forEachInWindow(0, 100, (id, v) => vals.push(v));
  eq(vals.length, 2, 'đúng 2 điểm');
  near(vals[0], 0.1, 1e-6, 'điểm đầu');
  near(vals[1], 0.4, 1e-6, 'điểm cuối');
});

test('R4', 'ring overflow ghi đè slot cũ (không phình bộ nhớ)', () => {
  const ring = new OscRing({ capacity: 8, minIntervalMs: 0 });
  for (let i = 0; i < 100; i++) ring.push('/a', i, i * 10);
  eq(ring.count, 8, 'count bị chặn ở capacity');
  ok(ring.ts.length === 8, 'typed array cấp phát cố định');
});

test('R5', 'address intern: 1 id cho nhiều message cùng địa chỉ', () => {
  const ring = new OscRing({ capacity: 64, minIntervalMs: 0 });
  ring.push('/same', 1, 0);
  ring.push('/same', 2, 10);
  const ids = new Set();
  ring.forEachInWindow(0, 100, (id) => ids.add(id));
  eq(ids.size, 1, 'chỉ 1 id');
});

test('R6', 'latestById trả giá trị mới nhất', () => {
  const ring = new OscRing({ capacity: 64, minIntervalMs: 0 });
  ring.push('/a', 1, 100);
  ring.push('/a', 2, 200);
  ring.push('/b', 3, 150);
  const m = ring.latestById(0, 300);
  eq(m.size, 2);
  eq([...m.values()].find(v => v.value === 2) ? true : false, true);
});

/* ==================== 4. TIMESTAMP ==================== */
test('T1', 'timestamp bảo toàn chính xác qua ring', () => {
  const ring = new OscRing({ capacity: 16, minIntervalMs: 0 });
  ring.push('/a', 1, 123456.789);
  let ts = null;
  ring.forEachInWindow(0, 1e9, (id, v, t) => { ts = t; });
  near(ts, 123456.789, 1e-6);
});

test('T2', 'nowEpoch = timeOrigin + now (công thức dùng chung 2 process)', () => {
  const t1 = performance.timeOrigin + performance.now();
  const t2 = performance.timeOrigin + performance.now();
  ok(t2 >= t1, 'đơn điệu tăng');
  ok(Math.abs(t2 - t1) < 1000, 'cùng mốc epoch');
});

/* ---------------------------- report ---------------------------- */
const pad = (s, n) => String(s).padEnd(n);
console.log('\n══════════════════════════════════════════════════════════════════════════');
console.log(' HS TIMECODE · OSC PARSER / FILTER / RING TEST SUITE');
console.log('══════════════════════════════════════════════════════════════════════════');
console.log(pad('ID', 7) + pad('KẾT QUẢ', 10) + 'TÊN');
console.log('──────────────────────────────────────────────────────────────────────────');
for (const r of results) {
  console.log(pad(r.id, 7) + pad(r.ok ? 'PASS' : 'FAIL', 10) + r.name + (r.ok ? '' : '\n         ↳ ' + r.msg));
}
console.log('──────────────────────────────────────────────────────────────────────────');
console.log(`TỔNG: ${pass} pass · ${fail} fail · ${results.length} test`);
console.log('══════════════════════════════════════════════════════════════════════════\n');
process.exit(fail ? 1 : 0);
