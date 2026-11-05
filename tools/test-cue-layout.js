#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const L = require('../renderer/cue-layout');
let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
function frozen(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}
const clip = (layer, num = 1, kind = 'trigger') => ({
  address: `/composition/layers/${layer}/clips/${num}/connect`, kind, startFrame: 10, durationFrames: 30
});
const parameter = (layer, name, kind = 'float') => ({
  address: `/composition/layers/${layer}/video/${name}`, kind, startFrame: 10, durationFrames: 30
});
const lane = (id, desc, extra = {}) => ({ id, name: 'R' + id, kind: 'R', recGroup: L.laneKeyFor(desc), ...extra });
const plan = (descriptor, lanes = [], events = [], config = {}) => L.planLane({ descriptor, lanes, events, config });

test('UMD browser global and CommonJS export the same API without app dependencies', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../renderer/cue-layout'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.HSCueLayout), Object.keys(L));
  assert.equal(context.HSCueLayout.resolveCueName('', { num: 27, ch: 1 }), 'MIDI D#1(27) \u00b7ch1');
});

test('D1 conventional clip/column/group names derive only from the OSC path', () => {
  const names = [
    ['/composition/layers/3/clips/7/connect', 'Layer3\u00b7Column7\u00b7Clip7'],
    ['/composition/columns/4/connect', 'Column4'],
    ['/composition/groups/2/columns/4/connect', 'Group2\u00b7Column4'],
    ['/composition/groups/2/layers/3/clips/7/connect', 'Group2\u00b7Layer3\u00b7Column7\u00b7Clip7'],
    ['/composition/groups/2/layers/3/clear', 'Group2\u00b7Layer3\u00b7Clear']
  ];
  for (const [address, expected] of names) {
    assert.equal(L.resolveCueName(address, { name: 'REST name must not leak', layerName: 'REST' }), expected);
  }
});

test('D2 known parameter casing, clip parameters and fallback path beautification', () => {
  for (const [tail, label] of [['opacity', 'Opacity'], ['playmode', 'Playmode'], ['speed', 'Speed'], ['volume', 'Volume'], ['clear', 'Clear']]) {
    assert.equal(L.resolveCueName('/composition/layers/3/video/' + tail), 'Layer3\u00b7' + label);
  }
  assert.equal(L.resolveCueName('/composition/layers/3/clips/7/video/opacity'), 'Layer3\u00b7Column7\u00b7Clip7\u00b7Opacity');
  assert.equal(L.resolveCueName('/custom/foo_bar/playMode'), 'Custom\u00b7Foo Bar\u00b7Play Mode');
});

test('D3 unknown MIDI notes use scientific octave, number, channel and CC label', () => {
  assert.equal(L.resolveCueName('', { num: 27, ch: 1 }), 'MIDI D#1(27) \u00b7ch1');
  assert.equal(L.resolveCueName('', { num: 0, ch: 16 }), 'MIDI C-1(0) \u00b7ch16');
  assert.equal(L.resolveCueName('', { num: 60, kind: 'piano', ch: 2 }), 'MIDI C4(60) \u00b7ch2');
  assert.equal(L.resolveCueName('', { num: 7, kind: 'float', ch: 3 }), 'MIDI CC7 \u00b7ch3');
  assert.equal(L.resolveCueName('', { cc: 0, ch: 1 }), 'MIDI CC0 \u00b7ch1');
  assert.equal(L.resolveCueName(''), 'OSC');
});

test('D4 same-layer clips share keys across Trigger/Piano and clip indices', () => {
  assert.equal(L.laneKeyFor(clip(3, 1)), L.laneKeyFor(clip(3, 12, 'piano')));
  assert.notEqual(L.laneKeyFor(clip(3)), L.laneKeyFor(clip(4)));
  assert.equal(L.labelFor(clip(3, 1)), 'Layer3\u00b7Clips');
  assert.equal(L.labelFor(clip(3, 12, 'piano')), 'Layer3\u00b7Clips');
});

test('D5 columns share one row; group prefix isolates composition/group/layers', () => {
  const column = (n) => ({ address: '/composition/columns/' + n + '/connect' });
  assert.equal(L.laneKeyFor(column(1)), L.laneKeyFor(column(8)));
  assert.equal(L.labelFor(column(1)), 'Columns');
  const grouped = { address: '/composition/groups/2/layers/3/clips/1/connect' };
  assert.notEqual(L.laneKeyFor(grouped), L.laneKeyFor(clip(3)));
  assert.equal(L.labelFor(grouped), 'Group2\u00b7Layer3\u00b7Clips');
  assert.equal(L.labelFor({ address: '/composition/groups/2/columns/1/connect' }), 'Group2\u00b7Columns');
});

test('D6 parameters group by layer and normalized final parameter, including clip paths', () => {
  const opacity = parameter(3, 'opacity');
  assert.equal(L.laneKeyFor(opacity), L.laneKeyFor({ address: '/composition/layers/3/clips/7/video/opacity' }));
  assert.equal(L.laneKeyFor(opacity), L.laneKeyFor({ address: '/composition/layers/3/opacity' }));
  assert.notEqual(L.laneKeyFor(opacity), L.laneKeyFor(parameter(3, 'volume')));
  assert.notEqual(L.laneKeyFor(opacity), L.laneKeyFor(parameter(4, 'opacity')));
  assert.equal(L.labelFor(opacity), 'Layer3\u00b7Opacity');
});

test('D7 exact-address mode never coalesces paths', () => {
  assert.notEqual(L.laneKeyFor(clip(3, 1), 'address'), L.laneKeyFor(clip(3, 2), 'address'));
  assert.notEqual(L.laneKeyFor({ address: '/Foo' }, 'address'), L.laneKeyFor({ address: '/foo' }, 'address'));
  assert.equal(L.labelFor(clip(3), 'address'), L.resolveCueName(clip(3).address));
});

test('D8 unmapped MIDI keys distinguish device/channel/key and note versus CC', () => {
  const note = { device: 'a|b', num: 27, ch: 1, kind: 'trigger' };
  const key = L.laneKeyFor(note);
  for (const other of [{ ...note, device: 'a' }, { ...note, ch: 2 }, { ...note, num: 28 }, { ...note, kind: 'float' }]) {
    assert.notEqual(key, L.laneKeyFor(other));
  }
  assert.equal(key, L.laneKeyFor({ ...note, kind: 'piano' }));
});

test('E1 a new group always creates its own root, not an unrelated empty row', () => {
  const result = plan(clip(3), [lane(1, clip(2)), { id: 2, kind: 'R', name: 'R2' }]);
  assert.equal(result.create, true);
  assert.equal(result.auxiliary, false);
  assert.equal(result.index, 2);
  assert.equal(result.groupKey, L.laneKeyFor(clip(3)));
});

test('E2 lane lookup uses persisted group and stable ID, not its R name', () => {
  const root = lane('stable-id', clip(3), { name: 'R19', color: '#123456' });
  const result = plan(clip(3, 8), [root]);
  assert.equal(result.create, false);
  assert.equal(result.laneId, 'stable-id');
  assert.equal(result.laneName, 'R19');
  assert.equal(result.color, '#123456');
});

test('E3 Trigger may overlap any existing event on its group row', () => {
  for (const kind of ['trigger', 'piano', 'float']) {
    const result = plan(clip(3), [lane(1, clip(3))], [{ lane: 'R1', frame: 0, duration: 100, recMeta: { kind } }]);
    assert.equal(result.laneId, 1);
    assert.equal(result.create, false);
  }
});

test('E4 Piano/Float overlap creates auxiliary immediately below the final sibling', () => {
  for (const desc of [clip(3, 1, 'piano'), parameter(3, 'opacity')]) {
    const lanes = [lane(1, desc), lane(2, clip(4)), lane(3, desc), lane(4, clip(5))];
    const events = [1, 3].map((id) => ({ lane: 'R' + id, frame: 0, duration: 100, recMeta: { kind: 'piano' } }));
    const result = plan(desc, lanes, events);
    assert.equal(result.create, true);
    assert.equal(result.auxiliary, true);
    assert.equal(result.index, 3);
  }
});

test('E5 overlap is half-open, empty intervals do not collide and self is excluded', () => {
  const desc = clip(3, 1, 'piano');
  const lanes = [lane(1, desc)];
  for (const event of [{ frame: 0, duration: 10 }, { frame: 40, duration: 20 }, { frame: 20, duration: 0 }]) {
    assert.equal(plan(desc, lanes, [{ ...event, lane: 'R1' }]).create, false);
  }
  assert.equal(plan(desc, lanes, [{ lane: 'R1', frame: 39, duration: 2 }]).create, true);
  const self = { id: 'event', lane: 'R1', frame: 10, duration: 30 };
  assert.equal(plan({ ...desc, __cue: self }, lanes, [self]).create, false);
  assert.equal(plan({ ...desc, cue: { ...self } }, lanes, [self]).create, false);
  assert.equal(plan({ ...desc, durationFrames: 0 }, lanes, [self]).create, false);
});

test('E6 offset conversion belongs to the caller; planner compares local frames', () => {
  const desc = { ...clip(3, 1, 'piano'), startFrame: 1010 };
  const local = { ...desc, startFrame: desc.startFrame - 1000 };
  const lanes = [lane(1, desc)];
  const events = [{ lane: 'R1', frame: 20, duration: 20 }];
  assert.equal(plan(local, lanes, events).create, true);
  assert.equal(plan(desc, lanes, events).create, false);
});

test('E6b shared cue definitions do not hide collisions between separate placements', () => {
  const desc = clip(3, 1, 'piano');
  const cue = { id: 'placement-a', cueId: 'definition', lane: 'R1', frame: 10, duration: 30 };
  const other = { ...cue, id: 'placement-b' };
  assert.equal(plan({ ...desc, __cue: cue }, [lane(1, desc)], [cue, other]).create, true);
});

test('E7 free auxiliary is reused, locked sibling skipped, empty auto spare repositioned', () => {
  const desc = clip(3, 1, 'piano');
  const busy = [{ lane: 'R1', frame: 0, duration: 100 }];
  assert.equal(plan(desc, [lane(1, desc), lane(2, desc)], busy).laneId, 2);
  assert.equal(plan(desc, [lane(1, desc, { locked: true })]).create, true);
  const spare = { id: 4, name: 'R4', kind: 'R', autoRec: true };
  const result = plan(desc, [spare, lane(1, desc), lane(2, clip(4))], busy);
  assert.equal(result.laneId, 4);
  assert.equal(result.index, 1);
  assert.equal(result.auxiliary, true);
  assert.equal(plan(desc, [{ ...spare, manual: true }, lane(1, desc)], busy).create, true);
});

test('E8 normal refresh preserves manual lane, explicit regroup/first assignment remaps', () => {
  const lanes = [lane(1, clip(4)), lane(2, clip(3))];
  const cue = { id: 'moved', manualLane: true, lane: 'R1', frame: 10, duration: 30 };
  const desc = { ...clip(3), cue };
  assert.equal(plan(desc, lanes, [cue]).laneId, 1);
  assert.equal(plan(desc, lanes, [cue]).preserveManual, true);
  assert.equal(plan(desc, lanes, [cue], { regroup: true }).laneId, 2);
  assert.equal(plan({ ...desc, pendingRemap: true }, lanes, [cue]).laneId, 2);
  assert.equal(plan({ ...desc, firstAssignment: true }, lanes, [cue]).laneId, 2);
});

test('E9 plan honors address-mode config and never mutates inputs', () => {
  const desc = frozen(clip(3, 1, 'piano'));
  const lanes = frozen([lane(1, desc)]);
  const events = frozen([{ lane: 'R1', frame: 10, duration: 30 }]);
  const config = frozen({ LANE_GROUP_MODE: 'address' });
  assert.equal(plan(desc, lanes, events, config).groupKey, L.laneKeyFor(desc, 'address'));
  assert.equal(plan(desc, lanes, events).create, true);
});

test('E10 normalization removes only empty auto R, renumbers continuously and remaps simultaneously', () => {
  const lanes = frozen([
    { id: 'v', kind: 'V', name: 'V1' },
    lane(8, clip(1)), lane(1, clip(2)), lane(3, clip(3)),
    { id: 'manual', kind: 'R', name: 'R4', color: '#123456', manual: true },
    { id: 'user-plus-R', kind: 'R', name: 'R5' }
  ]);
  const events = frozen([{ lane: 'R8', frame: 0, duration: 1 }, { lane: 'R1', frame: 5, duration: 1 }]);
  const result = L.normalizeLanes(lanes, events);
  assert.deepEqual(result.lanes.map((item) => item.name), ['V1', 'R1', 'R2', 'R3', 'R4']);
  assert.deepEqual(result.events.map((item) => item.lane), ['R1', 'R2']);
  assert.deepEqual(result.groups[L.laneKeyFor(clip(1))], [8]);
  assert.deepEqual(result.renames, { R8: 'R1', R1: 'R2', R4: 'R3', R5: 'R4' });
  assert.equal(result.lanes[3].color, '#123456');
  assert.equal(result.lanes[3].manual, true);
  assert.equal(lanes[1].name, 'R8');
  assert.equal(events[0].lane, 'R8');
});

test('E11 removeEmpty false/manual option preserves empty rows; locked/manualLane flags retained', () => {
  const lanes = [lane(1, clip(1)), lane(2, clip(2), { locked: true }), lane(3, clip(3), { manualLane: true })];
  assert.equal(L.normalizeLanes(lanes, [], { removeEmpty: false }).lanes.length, 3);
  assert.equal(L.normalizeLanes(lanes, [], { manual: true }).lanes.length, 3);
  assert.equal(L.normalizeLanes(lanes, []).lanes.length, 2);
  assert.equal(L.normalizeLanes(lanes, []).lanes[0].locked, true);
});

test('E11b empty autoRec ownership cleanup never removes non-R lanes or bare user +R', () => {
  const lanes = [
    { id: 1, name: 'R9', kind: 'R', autoRec: true },
    { id: 2, name: 'V1', kind: 'V', autoRec: true },
    { id: 3, name: 'R12', kind: 'R' }
  ];
  assert.deepEqual(L.normalizeLanes(lanes, []).lanes.map((item) => item.id), [2, 3]);
  const occupied = [{ laneId: 1, lane: 'stale-name', frame: 0, duration: 1 }];
  assert.deepEqual(L.normalizeLanes(lanes, occupied).lanes.map((item) => item.id), [1, 2, 3]);
});

test('E12 stable lane IDs and colors survive normalize/replan and event laneId takes priority', () => {
  const desc = clip(3);
  const old = lane('stable', desc, { name: 'R99', color: L.groupColor(L.laneKeyFor(desc)) });
  const normalized = L.normalizeLanes([old], [{ laneId: 'stable', lane: 'R99', frame: 0, duration: 1 }]);
  const result = plan(desc, normalized.lanes, normalized.events);
  assert.equal(result.laneId, 'stable');
  assert.equal(result.color, old.color);
  assert.equal(result.laneName, 'R1');
});

test('E13 palette32 deterministic colors avoid preceding duplicate and persisted colors win', () => {
  assert.equal(L.PALETTE.length, 32);
  assert.equal(new Set(L.PALETTE).size, 32);
  const keys = Array.from({ length: 100 }, (_, i) => L.laneKeyFor(clip(i + 1)));
  const colors = L.assignGroupColors(keys);
  keys.forEach((key, i) => {
    assert.equal(L.groupColor(key), L.groupColor(key));
    assert.notEqual(L.groupColor(key, L.groupColor(key)), L.groupColor(key));
    if (i) assert.notEqual(colors[key], colors[keys[i - 1]]);
  });
  assert.deepEqual(L.assignGroupColors(keys.slice().reverse(), frozen(colors)), colors);
  const key = keys[0];
  const result = plan(clip(1), [], [], { groupColors: frozen({ [key]: '#abcdef' }) });
  assert.equal(result.color, '#abcdef');
});

test('E14 automatic text color meets WCAG AA contrast on every palette color', () => {
  for (const color of L.PALETTE) {
    const rgb = color.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    const contrast = L.textColor(color) === '#000000' ? (luminance + 0.05) / 0.05 : 1.05 / (luminance + 0.05);
    assert.ok(contrast >= 4.5, color + ' contrast=' + contrast);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
