#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Editor = require('../renderer/curve-editor');
const tools = require('../renderer/curve-tools');
const config = require('../realtime-config');

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { if (this.listeners.has(type)) this.listeners.get(type).delete(fn); }
  dispatch(type, data = {}) {
    const event = { type, target: this, button: 0, pointerId: 1, ...data,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; } };
    for (let node = this; node; node = node.parentNode) {
      event.currentTarget = node;
      for (const fn of [...(node.listeners.get(type) || [])]) fn(event);
      if (event.stopped) break;
    }
    return event;
  }
  count() { return [...this.listeners.values()].reduce((total, set) => total + set.size, 0); }
}
class Element extends Target {
  constructor(tag, doc) {
    super();
    this.tagName = tag;
    this.ownerDocument = doc;
    this.children = [];
    this.style = {};
    this.attributes = {};
    this.value = '';
    this.disabled = false;
    this.captures = new Set();
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
  get lastChild() { return this.children.at(-1); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { left: 10, top: 20, width: 480, height: 180 }; }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); this.dispatch('lostpointercapture', { pointerId: id }); }
}
class Document extends Target {
  constructor() { super(); this.defaultView = new Target(); this.activeElement = null; }
  createElement(tag) { return new Element(tag, this); }
  createElementNS(namespace, tag) {
    assert.equal(namespace, 'http://www.w3.org/2000/svg');
    return new Element(tag, this);
  }
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`); }
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
function find(node, predicate) { return descendants(node).find(predicate); }
function cls(node, value) { return find(node, (item) => item.getAttribute('class') === value); }
function input(node, label) { return find(node, (item) => item.getAttribute('aria-label') === label); }
const line = [
  { dt: 0, value: 0.4488, args: ['level', 0.4488, { bytes: new Uint8Array([1, 2]), nested: [4] }], numericIndex: 1, t: 1000 },
  { dt: 1000, value: 0.6142, args: ['end', 0.6142], numericIndex: 1, t: 2000 }
];
function setup(options = {}, module = Editor) {
  const doc = new Document(), container = doc.createElement('div'), calls = [];
  container.parentNode = doc;
  const editor = module.mount(container, { points: line, durationMs: 1000, onChange: (points, metadata) => calls.push({ points, ...metadata }), ...options });
  return { doc, container, editor, calls, chart: cls(container, 'hs-curve-chart'),
    handles: () => cls(container, 'hs-curve-handles').children };
}
function choose(env, index) {
  const select = input(env.container, 'Point');
  select.value = String(index);
  select.dispatch('change');
}
function change(env, name, value) {
  const control = input(env.container, name);
  control.value = String(value);
  control.dispatch('change');
}
function drag(env, index, data = {}) {
  env.handles()[index].dispatch('pointerdown');
  env.doc.dispatch('pointermove', { clientX: 250, clientY: 60, ...data });
}

test('CommonJS and browser UMD mount without a global DOM or external dependencies', () => {
  const context = vm.createContext({ HSCurveTools: tools, HSRealtime: config });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/curve-editor.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.HSCurveEditor), Object.keys(Editor));
  const env = setup({}, context.HSCurveEditor);
  assert.equal(env.handles().length, 2);
  env.editor.destroy();
});

test('mount is silent, preserves exact endpoints/full payloads and isolates caller/getState', () => {
  const source = tools.cloneCueMetadata(line);
  const env = setup({ points: source });
  assert.equal(env.calls.length, 0);
  const state = env.editor.getState();
  assert.deepEqual(state.points.map((p) => p.value), [0.4488, 0.6142]);
  assert.ok(state.points.every((p) => p.dt === p.ms && !Object.hasOwn(p, 't')));
  state.points[0].args[2].bytes[0] = 99;
  source[0].args[2].nested[0] = 99;
  assert.equal(env.editor.getState().points[0].args[2].bytes[0], 1);
  assert.equal(env.editor.getState().points[0].args[2].nested[0], 4);
  assert.equal(state.valueMin, 0);
  assert.equal(state.valueMax, 1);
  env.editor.destroy();
});

test('chart is bounded, uses existing theme vars, accessible controls and 128 samples', () => {
  const env = setup();
  const curve = cls(env.container, 'hs-curve-line');
  assert.equal(curve.getAttribute('points').split(' ').length, 128);
  assert.ok(env.chart.getAttribute('aria-label').includes('Arrow keys'));
  assert.equal(env.handles()[0].getAttribute('tabindex'), '0');
  assert.equal(env.handles()[1].getAttribute('tabindex'), '-1');
  assert.ok(cls(env.container, 'hs-curve-editor').style.background.includes('var(--panel'));
  for (const label of ['Time (ms)', 'Value', 'Value slider', 'Point', 'Interpolation']) assert.ok(input(env.container, label));
  assert.ok(!curve.getAttribute('points').includes('NaN'));
  env.editor.destroy();
});

test('double click inserts interpolated point, not pointer y, preserving full args', () => {
  const env = setup({ interpolation: 'ease' });
  env.chart.dispatch('dblclick', { clientX: 138, clientY: 20 });
  const state = env.editor.getState();
  assert.equal(state.points.length, 3);
  assert.equal(state.points[1].dt, 250);
  near(state.points[1].value, tools.valueAt(line, 250, 'ease'));
  assert.equal(state.points[1].args[1], state.points[1].value);
  assert.equal(state.points[1].args[0], 'level');
  assert.deepEqual([...state.points[1].args[2].bytes], [1, 2]);
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].interpolation, 'ease');
  assert.equal(env.calls[0].commit, true);
  env.chart.dispatch('dblclick', { clientX: 138, clientY: 120 });
  assert.equal(env.calls.length, 1);
  env.editor.destroy();
});

test('Add/Delete buttons work without dragging and protect both endpoints', () => {
  const env = setup();
  assert.equal(cls(env.container, 'hs-curve-delete').disabled, true);
  cls(env.container, 'hs-curve-add').dispatch('click');
  assert.equal(env.editor.getState().points[1].dt, 500);
  assert.equal(cls(env.container, 'hs-curve-delete').disabled, false);
  cls(env.container, 'hs-curve-delete').dispatch('click');
  assert.equal(env.editor.getState().points.length, 2);
  env.chart.dispatch('keydown', { key: 'Delete' });
  choose(env, 0);
  env.chart.dispatch('keydown', { key: 'Backspace' });
  assert.equal(env.editor.getState().points.length, 2);
  assert.equal(env.calls.length, 2);
  env.editor.destroy();
});

test('drag previews many times but commits exactly once on pointerup', () => {
  const env = setup();
  cls(env.container, 'hs-curve-add').dispatch('click');
  env.calls.length = 0;
  drag(env, 1);
  env.doc.dispatch('pointermove', { clientX: 350, clientY: 80 });
  assert.equal(env.calls.length, 2);
  assert.ok(env.calls.every((call) => call.commit === false));
  const beforeRelease = env.editor.getState().points;
  env.doc.dispatch('pointerup');
  assert.equal(env.calls.length, 3);
  assert.equal(env.calls[2].commit, true);
  assert.deepEqual(env.calls[2].points, beforeRelease);
  assert.equal(env.doc.count(), 0);
  assert.equal(env.doc.defaultView.count(), 0);
  assert.equal(env.chart.hasPointerCapture(1), false);
  env.doc.dispatch('pointerup');
  assert.equal(env.calls.length, 3);
  env.editor.destroy();
});

test('drag selection follows crossing points, updates args, clamps time/value', () => {
  const points = [line[0], { dt: 250, value: 0.5, args: ['mid', 0.5], numericIndex: 1 }, { dt: 600, value: 0.7 }, line[1]];
  const env = setup({ points });
  drag(env, 1, { clientX: 400, clientY: -100 });
  let state = env.editor.getState();
  assert.equal(state.selectedIndex, 2);
  near(state.points[2].dt, 1000 * (390 - 16) / 448);
  assert.equal(state.points[2].value, 1);
  assert.equal(state.points[2].args[1], 1);
  env.doc.dispatch('pointermove', { clientX: -50, clientY: 500 });
  state = env.editor.getState();
  assert.equal(state.selectedIndex, 1);
  assert.equal(state.points[1].dt, 0);
  assert.equal(state.points[1].value, 0);
  env.doc.dispatch('pointerup');
  assert.deepEqual(points.map((p) => p.dt), [0, 250, 600, 1000]);
  env.editor.destroy();
});

test('endpoint drags change value only, click without movement does not commit', () => {
  const env = setup();
  env.handles()[0].dispatch('pointerdown');
  env.doc.dispatch('pointerup');
  assert.equal(env.calls.length, 0);
  drag(env, 0, { clientX: 450, clientY: 36 });
  env.doc.dispatch('pointerup');
  assert.equal(env.editor.getState().points[0].dt, 0);
  assert.equal(env.editor.getState().points[0].value, 1);
  assert.equal(env.calls.filter((call) => call.commit).length, 1);
  env.editor.destroy();
});

test('pointercancel, lost capture and window blur restore preview without commit', () => {
  for (const cancel of ['pointercancel', 'lostpointercapture', 'blur']) {
    const env = setup();
    const original = env.editor.getState().points;
    drag(env, 0);
    const target = cancel === 'blur' ? env.doc.defaultView : (cancel === 'lostpointercapture' ? env.chart : env.doc);
    target.dispatch(cancel);
    assert.deepEqual(env.editor.getState().points, original);
    assert.equal(env.calls.length, 2);
    assert.ok(env.calls.every((call) => call.commit === false));
    assert.deepEqual(env.calls[1].points, original);
    assert.equal(env.doc.count(), 0);
    assert.equal(env.doc.defaultView.count(), 0);
    env.editor.destroy();
  }
});

test('other pointer IDs cannot modify or finish the active drag', () => {
  const env = setup();
  env.handles()[0].dispatch('pointerdown', { pointerId: 3 });
  env.doc.dispatch('pointermove', { pointerId: 4, clientX: 50, clientY: 50 });
  env.doc.dispatch('pointerup', { pointerId: 4 });
  assert.equal(env.calls.length, 0);
  assert.ok(env.doc.count() > 0);
  env.doc.dispatch('pointerup', { pointerId: 3 });
  assert.equal(env.doc.count(), 0);
  env.editor.destroy();
});

test('drag ignores overlapping keyboard edits, Escape restores the original curve', () => {
  const env = setup();
  cls(env.container, 'hs-curve-add').dispatch('click');
  env.calls.length = 0;
  const original = env.editor.getState().points;
  drag(env, 1);
  for (const key of ['Delete', 'Enter', 'ArrowUp']) env.chart.dispatch('keydown', { key });
  assert.equal(env.calls.length, 1);
  assert.equal(env.editor.getState().points.length, 3);
  env.chart.dispatch('keydown', { key: 'Escape' });
  assert.deepEqual(env.editor.getState().points, original);
  assert.ok(env.calls.every((call) => call.commit === false));
  assert.equal(env.doc.count(), 0);
  env.editor.destroy();
});

test('keyboard edits are local, one frame at configured fps, Shift accelerates', () => {
  for (const fps of [24, 25, 30, 60]) {
    const env = setup({ fps });
    cls(env.container, 'hs-curve-add').dispatch('click');
    const key = env.handles()[1].dispatch('keydown', { key: 'ArrowRight' });
    near(env.editor.getState().points[1].dt, 500 + 1000 / fps);
    assert.equal(key.stopped, true);
    assert.equal(key.defaultPrevented, true);
    env.chart.dispatch('keydown', { key: 'ArrowLeft', shiftKey: true });
    near(env.editor.getState().points[1].dt, 500 - 9 * 1000 / fps);
    const value = env.editor.getState().points[1].value;
    env.chart.dispatch('keydown', { key: 'ArrowUp', shiftKey: true });
    near(env.editor.getState().points[1].value, value + 0.1);
    assert.ok(env.calls.every((call) => call.commit === true));
    assert.equal(env.doc.count(), 0);
    env.doc.dispatch('keydown', { key: 'Delete' });
    assert.equal(env.editor.getState().points.length, 3);
    const count = env.calls.length;
    env.chart.dispatch('keydown', { key: 'ArrowRight', metaKey: true });
    assert.equal(env.calls.length, count);
    env.editor.destroy();
  }
});

test('number fields clamp to valid time/value range, allow endpoint values, reject invalid', () => {
  const env = setup({ valueMin: -10, valueMax: 20 });
  change(env, 'Value', -5.125);
  assert.equal(env.editor.getState().points[0].value, -5.125);
  assert.equal(input(env.container, 'Time (ms)').disabled, true);
  cls(env.container, 'hs-curve-add').dispatch('click');
  change(env, 'Time (ms)', 9999);
  assert.equal(env.editor.getState().points[1].dt, 1000);
  change(env, 'Value', 999);
  assert.equal(env.editor.getState().points[1].value, 20);
  const count = env.calls.length;
  for (const invalid of ['', 'NaN', 'Infinity']) change(env, 'Value', invalid);
  assert.equal(env.calls.length, count);
  assert.equal(input(env.container, 'Value').value, '20');
  assert.equal(env.calls.at(-1).points[1].args[1], 20);
  env.editor.destroy();
});

test('range derives arbitrary actual min/max, normalized unit range, and constant/one-sided ranges', () => {
  for (const [values, options, range] of [
    [[-2, 4], {}, [-2, 4]], [[0.4488, 0.6142], {}, [0, 1]],
    [[4, 4], {}, [3, 4]], [[0.2, 0.8], { valueMin: 5 }, [5, 6]],
    [[0.2, 0.8], { valueMax: -5 }, [-6, -5]]
  ]) {
    const env = setup({ points: values.map((value, i) => ({ dt: i * 1000, value })), ...options });
    assert.deepEqual([env.editor.getState().valueMin, env.editor.getState().valueMax], range);
    assert.ok(!cls(env.container, 'hs-curve-line').getAttribute('points').includes('NaN'));
    env.editor.destroy();
  }
});

test('slider previews then commits once across change/blur and supports rollback', () => {
  const env = setup();
  const slider = input(env.container, 'Value slider');
  slider.value = '0.7'; slider.dispatch('input');
  slider.value = '0.8'; slider.dispatch('input');
  assert.deepEqual(env.calls.map((call) => call.commit), [false, false]);
  slider.dispatch('change'); slider.dispatch('blur');
  assert.deepEqual(env.calls.map((call) => call.commit), [false, false, true]);
  assert.equal(env.editor.getState().points[0].value, 0.8);
  slider.value = '0.2'; slider.dispatch('input'); slider.dispatch('pointercancel');
  assert.equal(env.editor.getState().points[0].value, 0.8);
  assert.equal(env.calls.at(-1).commit, false);
  env.editor.destroy();
});

test('interpolation select emits one commit, step sampling and insertion hold left value', () => {
  const env = setup();
  change(env, 'Interpolation', 'step');
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].interpolation, 'step');
  assert.equal(env.calls[0].commit, true);
  const vertices = cls(env.container, 'hs-curve-line').getAttribute('points').split(' ');
  assert.equal(vertices.length, 255);
  assert.equal(vertices[0].split(',')[1], vertices[100].split(',')[1]);
  cls(env.container, 'hs-curve-add').dispatch('click');
  assert.equal(env.editor.getState().points[1].value, 0.4488);
  env.editor.destroy();
});

test('set and setPoints inject state silently, keep redundant points, trim without stretching', () => {
  const env = setup();
  const newPoints = [{ dt: 0, value: -2 }, { dt: 250.125, value: 0 }, { dt: 500, value: 2 }, { dt: 1000, value: 4 }];
  env.editor.set({ points: newPoints, durationMs: 500, interpolation: 'ease', fps: 25 });
  let state = env.editor.getState();
  assert.deepEqual(state.points.map((p) => p.dt), [0, 250.125, 500]);
  assert.deepEqual(state.points.map((p) => p.value), [-2, 0, 2]);
  assert.equal(state.interpolation, 'ease');
  assert.equal(state.fps, 25);
  env.editor.setPoints([{ ms: 0, value: 3 }, { ms: 500, value: 7 }]);
  state = env.editor.getState();
  assert.deepEqual(state.points.map((p) => [p.dt, p.ms, p.value]), [[0, 0, 3], [500, 500, 7]]);
  assert.equal(env.calls.length, 0);
  env.editor.set({ valueMin: -20, valueMax: 20 });
  env.editor.set({ valueMin: undefined, valueMax: undefined });
  assert.equal(env.editor.getState().valueMin, 3);
  assert.equal(env.editor.getState().valueMax, 7);
  env.editor.destroy();
});

test('state injection cancels pending gesture and never emits stale commits', () => {
  const env = setup();
  drag(env, 0);
  env.editor.setPoints([{ dt: 0, value: 0.1 }, { dt: 1000, value: 0.9 }]);
  env.doc.dispatch('pointerup');
  assert.equal(env.doc.count(), 0);
  assert.equal(env.calls.length, 1);
  assert.equal(env.editor.getState().points[0].value, 0.1);
  const slider = input(env.container, 'Value slider');
  slider.value = '0.4'; slider.dispatch('input');
  env.editor.set({ fps: 24 });
  slider.dispatch('change');
  assert.equal(env.editor.getState().points[0].value, 0.1);
  assert.equal(env.calls.length, 2);
  env.editor.destroy();
});

test('callback payload mutations do not alter editor state or source data', () => {
  const env = setup({ onChange(points) { points[0].args[2].nested[0] = 99; points[0].value = 99; } });
  change(env, 'Value', 0.5);
  assert.equal(env.editor.getState().points[0].value, 0.5);
  assert.equal(env.editor.getState().points[0].args[2].nested[0], 4);
  assert.equal(line[0].args[2].nested[0], 4);
  env.editor.destroy();
});

test('empty/invalid/single/zero-duration input yields editable nonempty safe curves', () => {
  for (const points of [[], null, [{ value: Infinity, dt: 0 }], [{ ms: 200, value: 0.3 }]]) {
    const env = setup({ points });
    assert.ok(env.editor.getState().points.length >= 2);
    assert.equal(env.editor.getState().points[0].dt, 0);
    assert.equal(env.editor.getState().points.at(-1).dt, 1000);
    env.editor.set({ durationMs: 0 });
    assert.equal(env.editor.getState().points.length, 1);
    assert.equal(cls(env.container, 'hs-curve-add').disabled, true);
    env.chart.dispatch('keydown', { key: 'Delete' });
    assert.equal(env.editor.getState().points.length, 1);
    change(env, 'Value', 0.4);
    assert.equal(env.editor.getState().points[0].value, 0.4);
    assert.ok(!cls(env.container, 'hs-curve-line').getAttribute('points').includes('NaN'));
    env.editor.destroy();
  }
});

test('central point/sample caps are honored without implicit simplification', () => {
  const context = vm.createContext({ HSRealtime: { ...config, FLOAT_MAX_POINTS: 3, UI_CHART_SAMPLES: 24 } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/curve-tools.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/curve-editor.js'), 'utf8'), context);
  const env = setup({}, context.HSCurveEditor);
  cls(env.container, 'hs-curve-add').dispatch('click');
  assert.equal(env.editor.getState().points.length, 3);
  assert.equal(cls(env.container, 'hs-curve-add').disabled, true);
  env.chart.dispatch('dblclick', { clientX: 138, clientY: 80 });
  assert.equal(env.editor.getState().points.length, 3);
  assert.equal(cls(env.container, 'hs-curve-line').getAttribute('points').split(' ').length, 24);
  env.editor.destroy();
});

test('invalid settings reject atomically and failed mount removes created DOM/listeners', () => {
  const env = setup();
  for (const options of [{ fps: 0 }, { durationMs: -1 }, { interpolation: 'bad' }, { valueMin: 5, valueMax: 2 }, { valueMin: NaN }]) {
    const state = env.editor.getState();
    assert.throws(() => env.editor.set(options), RangeError);
    assert.deepEqual(env.editor.getState(), state);
  }
  env.editor.destroy();
  const doc = new Document(), container = doc.createElement('div');
  assert.throws(() => Editor.mount(container, { durationMs: -1 }), RangeError);
  assert.equal(container.children.length, 0);
  assert.equal(doc.count(), 0);
  assert.throws(() => Editor.mount(null), TypeError);
});

test('destroy during drag is idempotent, removes only own panel, all listeners/capture, no callback', () => {
  const env = setup();
  const sibling = env.doc.createElement('div');
  env.container.appendChild(sibling);
  drag(env, 0);
  const nodes = descendants(cls(env.container, 'hs-curve-editor'));
  const count = env.calls.length;
  env.editor.destroy();
  env.editor.destroy();
  assert.deepEqual(env.container.children, [sibling]);
  assert.equal(env.doc.count(), 0);
  assert.equal(env.doc.defaultView.count(), 0);
  assert.ok(nodes.every((node) => node.count() === 0));
  assert.equal(env.chart.hasPointerCapture(1), false);
  env.doc.dispatch('pointermove', { clientX: 100, clientY: 100 });
  env.doc.dispatch('pointerup');
  env.chart.dispatch('keydown', { key: 'ArrowUp' });
  env.editor.setPoints(line);
  assert.equal(env.calls.length, count);
});

test('multiple editor instances never share keyboard listeners, selection, or state', () => {
  const first = setup(), second = setup({ points: [{ dt: 0, value: -2 }, { dt: 1000, value: 4 }] });
  first.chart.dispatch('keydown', { key: 'ArrowUp' });
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 0);
  assert.equal(second.editor.getState().points[0].value, -2);
  first.editor.destroy();
  second.chart.dispatch('keydown', { key: 'ArrowUp' });
  near(second.editor.getState().points[0].value, -1.94);
  second.editor.destroy();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
