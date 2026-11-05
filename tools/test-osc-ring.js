#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { OscRing } = require('../osc-ring');
const { OSC_RING_CAPACITY, OSC_PER_ADDRESS_MAX_HZ, OSC_MAX_ADDRESSES } = require('../realtime-config');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (err) { failed++; console.error('FAIL ' + name + '\n' + err.stack); }
}
function records(ring, t0 = -Infinity, t1 = Infinity) {
  const rows = [];
  ring.forEachInWindow(t0, t1, (id, value, ts, kind, seq) => rows.push({ id, value, ts, kind, seq }));
  return rows;
}
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`); }

test('shared defaults and positive integer capacity validation', () => {
  const ring = new OscRing();
  assert.equal(ring.cap, OSC_RING_CAPACITY);
  assert.equal(ring.minIntervalMs, 1000 / OSC_PER_ADDRESS_MAX_HZ);
  for (const capacity of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => new OscRing({ capacity }), RangeError);
  }
  for (const minIntervalMs of [-1, NaN, Infinity]) {
    assert.throws(() => new OscRing({ minIntervalMs }), RangeError);
  }
});

test('endpoint survives a burst ending inside the rate window', () => {
  const ring = new OscRing({ minIntervalMs: 10 });
  assert.equal(ring.push('/a', 0.2, 0), true);
  assert.equal(ring.push('/a', 0.7, 1), false);
  assert.equal(ring.flushPending(9), 0);
  assert.equal(ring.flushPending(20), 1);
  assert.equal(ring.flushPending(30), 0);
  const rows = records(ring);
  assert.deepEqual(rows.map(r => r.ts), [0, 1]);
  near(rows[0].value, 0.2);
  near(rows[1].value, 0.7);
});

test('continuous burst keeps first and latest pending value, reusing state', () => {
  const ring = new OscRing({ minIntervalMs: 10 });
  ring.push('/a', 0.1, 0);
  const state = ring.lastVal.get(ring.ids.get('/a'));
  ring.push('/a', 0.3, 1);
  ring.push('/a', 0.8, 2);
  assert.equal(ring.flushPending(3, true), 1);
  assert.equal(ring.lastVal.get(ring.ids.get('/a')), state);
  assert.equal(records(ring).length, 2);
  near(records(ring)[1].value, 0.8);
  assert.equal(ring.dropped, 2);
});

test('new eligible input supersedes pending rather than writing a stale point', () => {
  const ring = new OscRing({ minIntervalMs: 10 });
  ring.push('/a', 0.1, 0);
  ring.push('/a', 0.3, 1);
  assert.equal(ring.push('/a', 0.9, 20), true);
  assert.equal(ring.flushPending(30), 0);
  assert.deepEqual(records(ring).map(r => r.ts), [0, 20]);
});

test('reversal to last stored value invalidates stale pending', () => {
  const ring = new OscRing({ minIntervalMs: 10 });
  ring.push('/a', 0.2, 0);
  ring.push('/a', 0.7, 1);
  ring.push('/a', 0.2, 2);
  assert.equal(ring.flushPending(20, true), 0);
  assert.equal(records(ring).length, 1);
});

test('discrete connect repeats and 1/0/1 bypass both suppression rules', () => {
  const ring = new OscRing({ minIntervalMs: 1000 });
  const values = [1, 1, 0, 1, 1];
  values.forEach((v, i) => assert.equal(ring.push('/connect', v, i, 1), true));
  assert.deepEqual(records(ring).map(r => [r.value, r.kind]), values.map(v => [v, 1]));
  assert.equal(ring.dropped, 0);
  assert.equal(ring.flushPending(2000), 0);
});

test('minIntervalMs zero is honored while continuous duplicate values are dropped', () => {
  const ring = new OscRing({ minIntervalMs: 0 });
  assert.equal(ring.minIntervalMs, 0);
  [0.2, 0.3, 0.4].forEach(v => assert.equal(ring.push('/a', v, 0), true));
  assert.equal(ring.push('/a', 0.4, 1), false);
  assert.equal(ring.count, 3);
  assert.equal(ring.flushPending(100), 0);
});

test('pending flush is timestamp ordered across addresses and window scans do not early-break', () => {
  const ring = new OscRing({ minIntervalMs: 10 });
  ring.push('/a', 0, 0);
  ring.push('/b', 0, 0);
  ring.push('/a', 1, 4);
  ring.push('/b', 1, 2);
  ring.push('/c', 1, 50);
  assert.equal(ring.flushPending(60), 2);
  assert.deepEqual(records(ring).map(r => r.ts), [0, 0, 50, 2, 4]);
  assert.deepEqual(records(ring, 1, 4).map(r => r.ts), [2, 4]);
  assert.equal(ring.latestById(1, 4).size, 2);
  ring.trim(3);
  assert.deepEqual(records(ring).map(r => r.ts), [50, 4]);
  ring.push('/d', 1, 60);
  assert.deepEqual(records(ring).map(r => r.ts), [50, 4, 60]);
});

test('FIFO wrap, partial trim and push remain correct for arbitrary capacities', () => {
  for (const capacity of [1, 3, 8, 17]) {
    const ring = new OscRing({ capacity, minIntervalMs: 0 });
    const arrays = [ring.ts, ring.val, ring.addrId, ring.kind, ring.seq, ring.used];
    let expected = [];
    let overflows = 0;
    for (let i = 0; i < 200; i++) {
      if (i % 7 === 0) {
        ring.trim(i - 3);
        expected = expected.filter(t => t >= i - 3);
      }
      if (expected.length === capacity) { expected.shift(); overflows++; }
      expected.push(i);
      ring.push('/a', i, i, 1);
      assert.deepEqual(records(ring).map(r => r.ts), expected);
      assert.equal(ring.count, expected.length);
      assert.equal(ring.overflow, overflows);
      assert.equal(ring.used.reduce((sum, v) => sum + v, 0), expected.length);
    }
    [ring.ts, ring.val, ring.addrId, ring.kind, ring.seq, ring.used].forEach((array, i) => assert.equal(array, arrays[i]));
    ring.trim(Infinity);
    assert.equal(ring.count, 0);
    ring.push('/a', 201, 201);
    assert.deepEqual(records(ring).map(r => r.ts), [201]);
  }
});

test('latestById chooses timestamp, not delayed insertion order', () => {
  const ring = new OscRing({ minIntervalMs: 0 });
  ring.push('/a', 1, 100);
  ring.push('/a', 2, 200);
  ring.push('/a', 3, 150);
  assert.equal(ring.count, 3);
  assert.deepEqual(ring.latestById(0, 300).get(ring.ids.get('/a')), { value: 2, ts: 200 });
});

test('trim expires retained records, pending endpoints and stale dedupe state', () => {
  const ring = new OscRing({ minIntervalMs: 10 });
  ring.push('/old', 0.2, 0);
  ring.push('/old', 0.7, 1);
  ring.push('/recent', 0.2, 10);
  ring.push('/recent', 0.7, 11);
  ring.trim(5);
  assert.equal(ring.lastVal.has(ring.ids.get('/old')), false);
  assert.equal(ring.flushPending(30, true), 1);
  assert.deepEqual(records(ring).map(r => r.ts), [10, 11]);
  ring.trim(20);
  assert.equal(ring.count, 0);
  assert.equal(ring.lastVal.size, 0);
});

test('pending newer than cutoff survives expiry of its first point', () => {
  const ring = new OscRing({ minIntervalMs: 10 });
  ring.push('/a', 0.2, 0);
  ring.push('/a', 0.7, 8);
  ring.trim(5);
  assert.equal(ring.flushPending(20), 1);
  assert.deepEqual(records(ring).map(r => r.ts), [8]);
});

test('intern table and dedupe state are capped without recycling retained ids', () => {
  const ring = new OscRing({ capacity: OSC_MAX_ADDRESSES + 1, minIntervalMs: 0 });
  for (let i = 0; i < OSC_MAX_ADDRESSES; i++) assert.equal(ring.push('/' + i, i, i), true);
  const firstId = ring.ids.get('/0');
  assert.equal(ring.push('/overflow', 1, OSC_MAX_ADDRESSES), false);
  assert.equal(ring.intern('/overflow-again'), 0);
  assert.equal(ring.addressOverflow, 2);
  assert.equal(ring.ids.size, OSC_MAX_ADDRESSES);
  assert.equal(ring.lastVal.size, OSC_MAX_ADDRESSES);
  assert.equal(ring.names.length, OSC_MAX_ADDRESSES + 1);
  assert.equal(ring.addressOf(firstId), '/0');
  assert.equal(records(ring)[0].id, firstId);
  assert.equal(ring.push('/0', -1, OSC_MAX_ADDRESSES + 1), true);
  ring.trim(Infinity);
  ring.clear();
  assert.equal(ring.intern('/0'), firstId);
  assert.equal(ring.push('/still-overflow', 1, 0), false);
  assert.equal(ring.lastVal.size, 0);
  assert.equal(ring.ids.size, OSC_MAX_ADDRESSES);
});

test('clear discards pending, resets counters and keeps ownership sequences unique', () => {
  const ring = new OscRing({ capacity: 2, minIntervalMs: 10 });
  ring.push('/a', 0.2, 0);
  ring.push('/a', 0.7, 1);
  ring.push('/b', 1, 2, 1);
  ring.push('/b', 1, 3, 1);
  const before = records(ring).map(r => r.seq);
  assert.equal(ring.overflow, 1);
  ring.clear();
  assert.equal(ring.count, 0);
  assert.equal(ring.head, 0);
  assert.equal(ring.lastVal.size, 0);
  assert.equal(ring.flushPending(100, true), 0);
  assert.equal(ring.dropped, 0);
  assert.equal(ring.overflow, 0);
  assert.equal(ring.addressOverflow, 0);
  assert.equal(ring.used.some(Boolean), false);
  ring.push('/a', 0.7, 101);
  assert.ok(records(ring)[0].seq > Math.max(...before));
});

test('stored sequences are unique through writes, pending flush, trim and wrap', () => {
  const ring = new OscRing({ capacity: 7, minIntervalMs: 10 });
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    ring.push('/a', i, i * 20);
    ring.push('/a', i + 0.5, i * 20 + 1);
    ring.flushPending(i * 20 + 15);
    if (i % 3 === 0) ring.trim(i * 20 - 20);
    for (const row of records(ring, i * 20, i * 20 + 1)) {
      assert.ok(Number.isSafeInteger(row.seq) && row.seq > 0);
      assert.ok(!seen.has(row.seq));
      seen.add(row.seq);
    }
  }
  assert.equal(seen.size, 200);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
