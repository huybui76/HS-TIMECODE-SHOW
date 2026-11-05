#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const C = require('../renderer/curve-tools');
const config = require('../realtime-config');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
function near(actual, expected, tolerance = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}
const line = [
  { dt: 0, ms: 0, value: 0.4488, args: ['level', 0.4488, { blob: Buffer.from([1, 2]), nested: [3, null] }], numericIndex: 1, t: 10000, seq: 1 },
  { dt: 1000, ms: 1000, value: 0.6142, args: ['end', 0.6142, { blob: Buffer.from([4, 5]), nested: [6, null] }], numericIndex: 1, t: 11000, seq: 2 }
];

test('CommonJS and browser UMD expose identical API with central configuration', () => {
  const context = vm.createContext({ HSRealtime: { ...config, FLOAT_MAX_POINTS: 2, FLOAT_RDP_EPSILON: 0 } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/curve-tools.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.HSCurveTools).sort(), Object.keys(C).sort());
  assert.equal(context.HSCurveTools.valueAt([{ dt: 0, value: 0.4488 }, { dt: 10, value: 0.6142 }], 0), 0.4488);
  assert.throws(() => context.HSCurveTools.normalize([{ dt: 0, value: 0 }, { dt: 1, value: 1 }, { dt: 2, value: 0 }]), /maxPoints/);
});

test('normalize keeps exact nonzero endpoints, arbitrary values and cloned full payloads', () => {
  const result = C.normalize(line, { epsilon: 0 });
  assert.equal(result[0].value, 0.4488);
  assert.equal(result[1].value, 0.6142);
  assert.deepEqual(result, line);
  result[0].args[2].blob[0] = 99;
  result[0].args[2].nested[0] = 99;
  assert.equal(line[0].args[2].blob[0], 1);
  assert.equal(line[0].args[2].nested[0], 3);
  assert.deepEqual(C.normalize([{ dt: 0, value: -2 }, { dt: 1, value: 4 }]).map((p) => p.value), [-2, 4]);
});

test('normalize stable sorts, accepts relative ms, filters invalid and synchronizes time', () => {
  const points = [{ dt: 8, value: 3, seq: 'a' }, { ms: -2, value: 1 }, { dt: 8, ms: 999, value: 4, seq: 'b' }, null,
    { t: 10, value: 5 }, { dt: NaN, value: 6 }, { dt: 3, value: Infinity }];
  const snapshot = structuredClone(points);
  const result = C.normalize(points, { epsilon: 0 });
  assert.deepEqual(result.map((p) => [p.dt, p.ms, p.value, p.seq]), [[0, 0, 1, undefined], [8, 8, 3, 'a'], [8, 8, 4, 'b']]);
  assert.deepEqual(points, snapshot);
  assert.deepEqual(C.normalize(null), []);
});

test('valueAt linear/ease/step clamp and exact keyframes', () => {
  near(C.valueAt(line, 250), 0.4488 + (0.6142 - 0.4488) / 4);
  near(C.valueAt(line, 250, 'ease'), 0.4488 + (0.6142 - 0.4488) * 0.15625);
  assert.equal(C.valueAt(line, 999, 'step'), 0.4488);
  assert.equal(C.valueAt(line, 1000, 'step'), 0.6142);
  assert.equal(C.valueAt(line, -20), 0.4488);
  assert.equal(C.valueAt(line, 2000), 0.6142);
  assert.equal(C.valueAt([], 0), null);
  assert.equal(C.valueAt([{ dt: 12, value: 0.42 }], 900), 0.42);
  assert.throws(() => C.valueAt(line, NaN), RangeError);
  assert.throws(() => C.valueAt(line, 50, 'unknown'), RangeError);
});

test('duplicate times are deterministic and exact time selects last sample', () => {
  const points = [{ dt: 0, value: 0.2 }, { dt: 5, value: 0.4 }, { dt: 5, value: 0.6 }, { dt: 10, value: 0.8 }];
  assert.equal(C.valueAt(points, 5), 0.6);
  near(C.valueAt(points, 7.5), 0.7);
});

test('trim partial interval preserves interpolated values, full args and relative times', () => {
  const result = C.trim(line, 200, 800);
  assert.deepEqual(result.map((p) => [p.dt, p.ms]), [[0, 0], [600, 600]]);
  near(result[0].value, C.valueAt(line, 200));
  near(result[1].value, C.valueAt(line, 800));
  assert.equal(result[0].args[1], result[0].value);
  assert.equal(result[1].args[1], result[1].value);
  assert.equal(result[0].args[0], 'level');
  assert.deepEqual(result[0].args[2], line[0].args[2]);
  assert.ok(result.every((p) => !Object.hasOwn(p, 't')));
  assert.equal(result[0].seq, 1);
  result[0].args[2].blob[0] = 88;
  assert.equal(result[1].args[2].blob[0], 1);
  assert.equal(line[0].args[2].blob[0], 1);
});

test('trim preserves interior points and exact original boundary payloads', () => {
  const points = [line[0], { dt: 400, value: 0.55, args: ['middle', 0.55], t: 10400 }, line[1]];
  const result = C.trim(points, 400, 1000);
  assert.deepEqual(result.map((p) => [p.dt, p.value, p.args[0]]), [[0, 0.55, 'middle'], [600, 0.6142, 'end']]);
  const whole = C.trim(points, 0, 1000);
  assert.equal(whole.length, 3);
  assert.equal(whole[1].dt, 400);
});

test('trim single instant differs from partial duration and extends by hold, never stretch', () => {
  const instant = C.trim(line, 600, 600);
  assert.equal(instant.length, 1);
  assert.equal(instant[0].dt, 0);
  near(instant[0].value, C.valueAt(line, 600));
  const extended = C.trim(line, 0, 1500);
  assert.deepEqual(extended.map((p) => p.dt), [0, 1000, 1500]);
  assert.equal(extended[1].value, 0.6142);
  assert.equal(extended[2].value, 0.6142);
  assert.deepEqual(C.trim([], 0, 0), []);
  assert.throws(() => C.trim(line, 500, 200), RangeError);
  assert.throws(() => C.trim(line, -1, 100), RangeError);
});

test('boundary interpolation changes only numericIndex, preserving other numeric/blob/nested args', () => {
  const points = [
    { dt: 0, value: 0.2, args: [7, { value: 5 }, 0.2, new Uint8Array([1, 2]), [8]], numericIndex: 2 },
    { dt: 100, value: 0.8, args: [9, { value: 6 }, 0.8, new Uint8Array([3, 4]), [10]], numericIndex: 2 }
  ];
  const result = C.trim(points, 25, 75);
  near(result[0].args[2], 0.35);
  assert.equal(result[0].args[0], 7);
  assert.deepEqual(result[0].args[1], { value: 5 });
  assert.deepEqual(result[0].args[3], new Uint8Array([1, 2]));
  assert.deepEqual(result[0].args[4], [8]);
  const explicit = C.trim(points.map((p) => ({ ...p, numericIndex: undefined })), 25, 75, { numericIndex: 2 });
  near(explicit[0].args[2], 0.35);
  assert.equal(explicit[0].args[0], 7);
  const inferred = C.trim(line.map((p) => ({ ...p, numericIndex: undefined })), 200, 800);
  assert.equal(inferred[0].args[1], inferred[0].value);
});

test('split rebases right and has continuous independent full-payload endpoints', () => {
  const { left, right } = C.split(line, 400);
  assert.deepEqual(left.map((p) => p.dt), [0, 400]);
  assert.deepEqual(right.map((p) => p.dt), [0, 600]);
  assert.equal(left[left.length - 1].value, right[0].value);
  assert.deepEqual(left[left.length - 1].args, right[0].args);
  assert.equal(left[0].value, 0.4488);
  assert.equal(right[right.length - 1].value, 0.6142);
  assert.ok([...left, ...right].every((p) => p.dt === p.ms && !Object.hasOwn(p, 't')));
  left[left.length - 1].args[2].blob[0] = 66;
  assert.equal(right[0].args[2].blob[0], 1);
});

test('split endpoints/zero/empty and duration override are deterministic', () => {
  assert.equal(C.split(line, 0).left.length, 1);
  assert.equal(C.split(line, 2000).right.length, 1);
  assert.deepEqual(C.split([], 0), { left: [], right: [] });
  const result = C.split([{ dt: 0, value: 0.4 }], 0);
  assert.equal(result.left[0].value, result.right[0].value);
  assert.equal(C.split(line, 500, { durationMs: 1500 }).right.at(-1).dt, 1000);
});

test('step/ease boundary samples follow the requested interpolation', () => {
  const step = C.split(line, 400, { interpolation: 'step' });
  assert.equal(step.left.at(-1).value, 0.4488);
  assert.equal(step.right[0].value, 0.4488);
  const ease = C.trim(line, 250, 750, { interpolation: 'ease' });
  near(ease[0].value, C.valueAt(line, 250, 'ease'));
  near(ease.at(-1).value, C.valueAt(line, 750, 'ease'));
});

test('stretch is explicit, preserves values and ms precision including fps conversion', () => {
  const points = [line[0], { dt: 1000 / 30, value: 0.5 }, line[1]];
  const result = C.stretch(points, 2000);
  assert.deepEqual(result.map((p) => p.value), points.map((p) => p.value));
  assert.equal(result[1].dt, 2000 / 30);
  assert.equal(result.at(-1).dt, 2000);
  for (const fps of [24, 25, 30]) {
    const dt = 17 * 1000 / fps;
    const moved = C.movePoint([{ dt: 0, value: 0.4 }, { dt, value: 0.5 }, { dt: 1000, value: 0.6 }], 1, { dt }, 1000);
    assert.equal(moved[1].dt, dt);
    near(moved[1].dt * fps / 1000, 17);
  }
  assert.equal(C.trim(points, 0, 2000)[1].dt, 1000 / 30);
});

test('stretch zero/single sample/explicit source duration do not divide by zero', () => {
  assert.deepEqual(C.stretch([], 500), []);
  assert.deepEqual(C.stretch([{ dt: 0, value: 0.4 }], 500).map((p) => [p.dt, p.value]), [[0, 0.4], [500, 0.4]]);
  assert.equal(C.stretch(line, 0).length, 1);
  assert.equal(C.stretch(line, 0)[0].value, 0.4488);
  assert.equal(C.stretch(line, 3000, { durationMs: 1500 })[1].dt, 2000);
});

test('iterative RDP guarantees vertical epsilon at every irregular original sample', () => {
  let time = 0;
  const points = Array.from({ length: 5000 }, (_, i) => {
    time += 0.1 + (i * 17 % 101);
    return { dt: time, value: 0.4488 + Math.sin(i / 17) * 0.1 + Math.cos(i / 3) * 0.002 };
  });
  points.at(-1).value = 0.6142;
  const result = C.simplify(points, 0.004);
  assert.deepEqual(result[0], { ...points[0], ms: points[0].dt });
  assert.deepEqual(result.at(-1), { ...points.at(-1), ms: points.at(-1).dt });
  assert.ok(result.length < points.length);
  for (const point of points) near(C.valueAt(result, point.dt), point.value, 0.004 + 1e-12);
});

test('iterative RDP handles 5000 alternating worst-case samples without recursion', () => {
  const points = Array.from({ length: 5000 }, (_, i) => ({ dt: i * 0.1, value: i % 2 ? 0.4488 : 0.6142 }));
  const result = C.simplify(points, 0);
  assert.equal(result.length, 5000);
  assert.equal(result[0].value, 0.6142);
  assert.equal(result.at(-1).value, 0.4488);
});

test('normalization cap never silently violates requested RDP tolerance or endpoints', () => {
  const points = [{ dt: 0, value: 0.4488 }, { dt: 10, value: 0.9 }, { dt: 20, value: 0.6142 }];
  assert.throws(() => C.normalize(points, { epsilon: 0.004, maxPoints: 2 }), /maxPoints/);
  assert.equal(C.normalize(points, { epsilon: 1, maxPoints: 2 }).length, 2);
  assert.throws(() => C.normalize(points, { maxPoints: 1 }), RangeError);
  assert.throws(() => C.simplify(points, -1), RangeError);
});

test('cloneCueMetadata preserves nested metadata, Buffer, typed arrays, offsets and DataView', () => {
  const backing = new Uint8Array([9, 1, 2, 8]).buffer;
  const metadata = { kind: 'float', args: [Buffer.from([3]), new Uint16Array([4, 5]), new DataView(backing, 1, 2), backing],
    extras: [{ args: [new Uint8Array(backing, 1, 2), { nested: ['full', null, true] }] }], keyframes: line };
  const result = C.cloneCueMetadata(metadata);
  assert.equal(result.kind, 'float');
  assert.ok(Buffer.isBuffer(result.args[0]));
  assert.ok(result.args[1] instanceof Uint16Array);
  assert.ok(result.args[2] instanceof DataView);
  assert.deepEqual([...new Uint8Array(result.args[2].buffer)], [1, 2]);
  assert.deepEqual([...result.extras[0].args[0]], [1, 2]);
  result.args[0][0] = 99;
  result.args[1][0] = 99;
  result.args[2].setUint8(0, 99);
  result.extras[0].args[0][0] = 99;
  assert.equal(metadata.args[0][0], 3);
  assert.equal(metadata.args[1][0], 4);
  assert.equal(new Uint8Array(backing)[1], 1);
  assert.ok(result.keyframes.every((p) => !Object.hasOwn(p, 't') && p.ms === p.dt));
  assert.equal(result.keyframes[0].seq, 1);
  assert.equal(C.cloneCueMetadata(null), null);
});

test('insert clamps dt, updates numeric arg, replaces collisions and obeys central editing cap', () => {
  const inserted = C.insertPoint(line, { dt: 300, value: 0.5, args: ['x', 0.1], numericIndex: 1 }, 1000);
  assert.deepEqual(inserted.map((p) => p.dt), [0, 300, 1000]);
  assert.equal(inserted[1].args[1], 0.5);
  const clamped = C.insertPoint(line, { dt: -30, value: 0.49 }, 1000);
  assert.equal(clamped[0].dt, 0);
  assert.equal(clamped[0].value, 0.49);
  assert.equal(C.insertPoint(line, { dt: 2000, value: 0.7 }, 1000).at(-1).value, 0.7);
  assert.equal(C.insertPoint(line, { dt: 300, value: 0.5 }, 1000, { maxPoints: 2 }).length, 2);
  assert.deepEqual(C.insertPoint([], { dt: 300, value: 0.5 }, 1000).map((p) => p.dt), [0, 300, 1000]);
});

test('move stable sorts and clamps without stretching; endpoints cannot move away', () => {
  const points = [line[0], { dt: 300, value: 0.5, args: ['a', 0.5], seq: 3 }, { dt: 600, value: 0.57, seq: 4 }, line[1]];
  const moved = C.movePoint(points, 1, { dt: 750, value: 0.56 }, 1000);
  assert.deepEqual(moved.map((p) => p.dt), [0, 600, 750, 1000]);
  assert.equal(moved[2].args[1], 0.56);
  const tied = C.movePoint(points, 1, { dt: 600 }, 1000);
  assert.deepEqual(tied.slice(1, 3).map((p) => p.seq), [3, 4]);
  assert.equal(C.movePoint(points, 1, { dt: -100 }, 1000)[1].dt, 0);
  assert.equal(C.movePoint(points, 1, { dt: 5000 }, 1000).at(-1).dt, 1000);
  assert.equal(C.movePoint(points, 0, { dt: 300, value: 0.49 }, 1000)[0].dt, 0);
  assert.equal(C.movePoint(points, 3, { dt: 800 }, 1000).at(-1).dt, 1000);
  assert.deepEqual(points.map((p) => p.dt), [0, 300, 600, 1000]);
});

test('delete protects endpoints/minimum pair and handles instant/empty curves', () => {
  const points = [line[0], { dt: 300, value: 0.5 }, line[1]];
  assert.deepEqual(C.deletePoint(points, 1, 1000).map((p) => p.value), [0.4488, 0.6142]);
  assert.equal(C.deletePoint(points, 0, 1000).length, 3);
  assert.equal(C.deletePoint(points, 2, 1000).length, 3);
  assert.equal(C.deletePoint(line, 1, 1000).length, 2);
  assert.equal(C.deletePoint(line, 0, 0).length, 1);
  assert.deepEqual(C.deletePoint([], 0, 0), []);
});

test('editing preserves redundant points and stable caller indices without implicit simplification or snapping', () => {
  const points = [
    { dt: 0, value: 0.4, seq: 0 }, { dt: 250, value: 0.45, seq: 1 },
    { dt: 500, value: 0.5, seq: 2 }, { dt: 1000, value: 0.6, seq: 3 }
  ];
  const moved = C.movePoint(points, 2, { dt: 501.2345, value: 0.52 }, 1000);
  assert.deepEqual(moved.map((p) => p.seq), [0, 1, 2, 3]);
  assert.equal(moved[2].dt, 501.2345);
  assert.equal(moved[2].value, 0.52);
  assert.equal(C.insertPoint(points, { dt: 750, value: 0.55 }, 1000).length, 5);
  assert.deepEqual(C.deletePoint(points, 2, 1000).map((p) => p.seq), [0, 1, 3]);
  const tied = C.movePoint(points, 1, { dt: 0 }, 1000);
  assert.deepEqual(C.deletePoint(tied, 1, 1000).map((p) => p.seq), [0, 2, 3]);
  const endTied = C.movePoint(points, 2, { dt: 2000 }, 1000);
  assert.deepEqual(C.deletePoint(endTied, 2, 1000).map((p) => p.seq), [0, 1, 3]);
});

test('all operations leave source arrays and full nested payloads unchanged', () => {
  const source = C.cloneCueMetadata({ keyframes: line }).keyframes;
  const snapshot = C.cloneCueMetadata(source);
  C.normalize(source); C.simplify(source); C.valueAt(source, 400);
  C.trim(source, 100, 900); C.split(source, 300); C.stretch(source, 2000);
  C.insertPoint(source, { dt: 400, value: 0.5 }, 1000);
  C.movePoint(source, 0, { value: 0.5 }, 1000); C.deletePoint(source, 0, 1000);
  assert.deepEqual(source, snapshot);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
