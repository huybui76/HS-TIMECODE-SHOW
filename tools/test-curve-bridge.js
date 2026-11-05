#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tools = require('../renderer/curve-tools');
const CFG = require('../realtime-config');
const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
function production(name) {
  const match = source.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'));
  assert.ok(match, name);
  return match[0];
}
function harness(fps = 30, speed = 1) {
  let sequence = 100, saves = 0, rebuilds = 0, destroys = 0, options;
  const nodes = new Map();
  const node = () => ({ style: {}, listeners: {}, append(...children) { children.forEach((child) => this.appendChild(child)); },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    classList: { toggle() {} }, appendChild(child) { nodes.set(child.id, child); } });
  const folder = { id: 1, offset: 0, events: [], cues: [{ id: 1, address: '/real', args: [.4488, 'full'], mode: 'float', nameEdited: true }] };
  const lanes = [1, 2, 3].map((id) => ({ id, kind: 'R', name: 'R' + id, recGroup: 'same' }));
  folder.lanes = lanes;
  const cue = { id: 2, cueId: 1, frame: 30, duration: fps * speed, lane: 'R1', laneId: 1, enabled: false,
    smpteInput: true, manualLane: true, recGroup: 'same', recMeta: { kind: 'float', recordingSpeed: speed,
      interpolation: 'linear', numericIndex: 0, keyframesRaw: 20, dataOrigin: 'osc', extras: [{ args: [[1]] }],
      keyframes: [{ dt: 0, ms: 0, value: .4488, args: [.4488, 'full'] },
        { dt: 500, ms: 500, value: .9, args: [.9, 'middle'] }, { dt: 1000, ms: 1000, value: .6142, args: [.6142, 'last'] }] } };
  folder.events.push(cue);
  const calls = [];
  const ctx = vm.createContext({ console, structuredClone, Uint8Array, REC_CFG: { ...CFG }, folder, cue, calls,
    oscUI: { targets: [{ id: 'resolume', name: 'Resolume', enabled: true }] },
    window: { HSCurveTools: tools, HSCurveEditor: { mount(container, next) {
      options = next; return { destroy() { destroys++; }, getState: () => ({ points: next.points, interpolation: next.interpolation }) };
    } } },
    document: { createElement: node },
    $: (id) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    state: { folders: [folder], activeFolderId: 1, fps, frame: 100, lanes, sel: cue, multiSel: new Set([cue]) },
    nid: () => ++sequence, laneAlloc: { exportGroups: () => ({}) }, midiMap: new Map(), recTransactions: new Map(),
    selAudioClip: () => null, setStatus() {}, flashStatus() {}, renderRecMeta() {},
    renderProps() {}, renderSwatches() {}, renderFolders() {}, updateSelBar() {},
    tcString: String, parseTC: Number, infoDirty: false,
    rebuildFlat: () => { rebuilds++; }, scheduleAutosave: () => { saves++; },
    refreshAll: () => { ctx.noteChange(); saves++; }, xToFrame: (x) => x, frameToX: (x) => x,
    hitLaneRow: (y) => lanes[y], clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
    ctx: Object.fromEntries(['save', 'restore', 'beginPath', 'clip', 'stroke', 'fill', 'rect', 'moveTo', 'lineTo', 'arc']
      .map((name) => [name, (...args) => calls.push([name, ...args])]))
  });
  vm.runInContext('let propsCurveEditor=null, propsCurveCancel=null; const undoStack=[], redoStack=[]; let lastSnap=null, restoringHistory=false;', ctx);
  for (const name of ['cueCurveSpeed', 'cueCurveOptions', 'cueCurvePoints', 'trimCueCurve', 'cloneCuePlacement', 'splitCuePlacement',
    'resolveCueEditLane', 'moveCueDrag', 'drawCueCurve', 'insertCue', 'defOf', 'findCueLoc', 'curFolder', 'selSet',
    'copySelection', 'pasteSelection', 'snapshot', 'noteChange', 'mountPropsCurve', 'laneByName', 'laneLockedByName',
     'findSelectedFolder', 'selDef', 'projectEncode', 'projectDecode', 'projectOscArgs', 'mountCueOutputSelector']) {
    vm.runInContext(production(name), ctx);
  }
  const run = (code) => vm.runInContext(code, ctx);
  run('lastSnap=snapshot();');
  return { ctx, folder, cue, lanes, calls, nodes, run, options: () => options,
    counts: () => ({ saves, rebuilds, destroys }) };
}
const cases = [];
function test(name, fn) { cases.push([name, fn]); }
function close(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`); }
function timelineEvents(h) {
  const events = {};
  h.ctx.canvas = { style: {}, getBoundingClientRect: () => ({ left: 0, top: 0 }),
    addEventListener: (type, fn) => { events[type] = fn; } };
  h.ctx.window.addEventListener = (type, fn) => { events[type] = fn; };
  Object.assign(h.ctx, { TOP: 20, GUT: 0, sbDrag: null, sbVDrag: null, clipDrag: null, dragInfo: null,
    blockDrag: null, mousePos: null, infoDirty: false });
  vm.runInContext(source.slice(source.indexOf("canvas.addEventListener('mousemove',"),
    source.indexOf("canvas.addEventListener('mouseleave',")), h.ctx);
  vm.runInContext(source.slice(source.indexOf("window.addEventListener('mouseup', (e) => {", source.indexOf('let blockDrag')),
    source.indexOf('// nhấp đúp clip nhạc')), h.ctx);
  return events;
}

for (const fps of [24, 25, 30]) for (const speed of [1, 2]) {
  test(`trim preserves source time, full args and interpolation at ${fps}fps speed${speed}`, () => {
    const h = harness(fps, speed), original = structuredClone(h.cue.recMeta);
    h.ctx.trimCueCurve(h.cue, fps * speed / 4, fps * speed / 2);
    close(h.cue.recMeta.keyframes[0].value, .6744);
    close(h.cue.recMeta.keyframes.at(-1).value, .7571);
    assert.equal(h.cue.recMeta.keyframes.at(-1).dt, 500);
    assert.equal(h.cue.recMeta.keyframes[0].args[1], 'full');
    assert.equal(h.cue.recMeta.interpolation, 'linear');
    assert.deepEqual(original.keyframes.map((p) => p.dt), [0, 500, 1000]);
    assert.equal(h.cue.recMeta.keyframesSent, 3);
  });
}
test('split rebases right curve and preserves flags without aliases or new source definition', () => {
  const h = harness(), right = h.ctx.splitCuePlacement(h.folder, h.cue, 45, 60);
  assert.equal(h.folder.cues.length, 1); assert.equal(right.cueId, h.cue.cueId);
  assert.equal(h.cue.duration, 15); assert.equal(right.duration, 15);
  assert.equal(right.frame, 45); assert.equal(right.recMeta.keyframes[0].dt, 0);
  close(h.cue.recMeta.keyframes.at(-1).value, right.recMeta.keyframes[0].value);
  assert.equal(right.smpteInput, true); assert.equal(right.manualLane, true); assert.equal(right.enabled, false);
  right.recMeta.extras[0].args[0][0] = 99;
  assert.equal(h.cue.recMeta.extras[0].args[0][0], 1);
});
test('recorded duplication clones definition while a library placement retains shared definition', () => {
  const h = harness(), dup = h.ctx.cloneCuePlacement(h.cue, 80, h.folder);
  assert.notEqual(dup.id, h.cue.id); assert.notEqual(dup.cueId, h.cue.cueId);
  dup.recMeta.keyframes[0].args[1] = 'changed';
  assert.equal(h.cue.recMeta.keyframes[0].args[1], 'full');
  const lib = { ...h.cue }; delete lib.recMeta;
  assert.equal(h.ctx.cloneCuePlacement(lib, 90, h.folder).cueId, lib.cueId);
});
test('copy and paste deep preserve metadata and independent source properties', () => {
  const h = harness(); h.ctx.copySelection(); h.ctx.pasteSelection(100);
  const dup = h.folder.events.find((ev) => ev !== h.cue);
  assert.equal(dup.frame, 100); assert.equal(dup.smpteInput, true); assert.equal(dup.recGroup, 'same');
  assert.equal(dup.enabled, false); assert.equal(dup.manualLane, true);
  assert.notEqual(dup.cueId, h.cue.cueId); assert.equal(dup.recMeta.keyframes.length, 3);
  dup.recMeta.keyframes[0].value = 0;
  assert.equal(h.cue.recMeta.keyframes[0].value, .4488);
});
test('paste relative absolute-time offsets survive different source folder offsets', () => {
  const h = harness(); h.folder.offset = 50;
  const second = { ...structuredClone(h.cue), id: 3, frame: 10 };
  h.ctx.state.folders.push({ id: 3, offset: 100, events: [second], cues: [h.folder.cues[0]] });
  h.ctx.state.multiSel.add(second); h.ctx.copySelection(); h.ctx.pasteSelection(200);
  const pasted = [...h.ctx.state.multiSel].map((ev) => ev.frame).sort((a, b) => a - b);
  assert.deepEqual(pasted, [150, 180]);
});
test('group move clamps common frame/lane delta without reshaping curves', () => {
  const h = harness(), second = { ...structuredClone(h.cue), id: 3, frame: 40, lane: 'R2', laneId: 2 };
  h.folder.events.push(second);
  const original = JSON.stringify(h.cue.recMeta);
  const drag = { ev: h.cue, folder: h.folder, f0: 30, grabF: 0, lanes: h.lanes,
    items: [h.cue, second].map((ev) => ({ ev, frame: ev.frame, laneIndex: h.lanes.findIndex((l) => l.name === ev.lane), manualLane: ev.manualLane })) };
  h.ctx.moveCueDrag(drag, -50, 2);
  assert.equal(h.cue.frame, 0); assert.equal(second.frame, 10);
  assert.equal(h.cue.lane, 'R2'); assert.equal(second.lane, 'R3');
  assert.equal(JSON.stringify(h.cue.recMeta), original);
  h.lanes[2].locked = true; h.ctx.moveCueDrag(drag, 60, 2);
  assert.equal(h.cue.frame, 60); assert.equal(second.frame, 70);
  assert.equal(h.cue.lane, 'R1'); assert.equal(second.lane, 'R2');
});
test('Float and Piano collisions use siblings; Trigger overlap remains allowed', () => {
  for (const kind of ['float', 'piano', 'trigger']) {
    const h = harness(); h.cue.recMeta.kind = kind;
    const dup = { ...structuredClone(h.cue), id: 3 }; h.folder.events.push(dup);
    h.ctx.resolveCueEditLane(h.folder, dup);
    assert.equal(dup.lane, kind === 'trigger' ? 'R1' : 'R2');
  }
});
test('canvas maps recorded speed without fitting duration and keeps true nonzero endpoints', () => {
  const h = harness(30, 2); h.cue.duration = 1000;
  h.ctx.drawCueCurve(h.cue, 30, { y: 0, h: 46 }, 35, 85);
  assert.deepEqual(h.calls.find((c) => c[0] === 'rect'), ['rect', 35, 2, 50, 36]);
  const first = h.calls.find((c) => c[0] === 'moveTo');
  assert.equal(first[1], 30); close(first[2], 17 + (1 - .4488) * 17);
  assert.ok(h.calls.some((c) => c[0] === 'lineTo' && c[1] === 90));
  assert.equal(h.calls.filter((c) => c[0] === 'arc').length, 1);
});
test('property preview creates no undo/save; final commit creates exactly one undo', () => {
  const h = harness(); h.ctx.mountPropsCurve(h.cue, h.folder.cues[0], false);
  const options = h.options(), before = h.run('snapshot()');
  assert.equal(options.durationMs, 1000); assert.equal(options.points[0].value, .4488);
  for (const value of [.5, .6, .7]) {
    const points = structuredClone(h.cue.recMeta.keyframes); points[0].value = value;
    options.onChange(points, { interpolation: 'ease', commit: false });
  }
  assert.equal(h.run('undoStack.length'), 0); assert.equal(h.counts().saves, 0); assert.equal(h.counts().rebuilds, 0);
  options.onChange(h.cue.recMeta.keyframes, { interpolation: 'ease', commit: true });
  assert.equal(h.run('undoStack.length'), 1); assert.equal(h.run('undoStack[0]'), before);
  assert.equal(h.counts().saves, 1); assert.equal(h.counts().rebuilds, 1);
});
test('direct numeric commits undo once each and MIDI data remains display-only', () => {
  const h = harness(); h.cue.recMeta.dataOrigin = 'midi'; h.cue.recMeta.unassigned = true;
  h.run('lastSnap=snapshot();'); h.ctx.mountPropsCurve(h.cue, h.folder.cues[0], false);
  for (const value of [.3, .4]) {
    const points = structuredClone(h.cue.recMeta.keyframes); points[0].value = value;
    h.options().onChange(points, { interpolation: 'step', commit: true });
  }
  assert.equal(h.run('undoStack.length'), 2); assert.equal(h.cue.recMeta.dataOrigin, 'midi');
  assert.equal(h.cue.recMeta.unassigned, true);
});
test('destroying/closing preview restores original metadata silently', () => {
  const h = harness(), before = JSON.stringify(h.cue.recMeta);
  h.ctx.mountPropsCurve(h.cue, h.folder.cues[0], false);
  const points = structuredClone(h.cue.recMeta.keyframes); points[0].value = .1;
  h.options().onChange(points, { interpolation: 'ease', commit: false });
  h.run('propsCurveEditor.destroy(); propsCurveCancel();');
  assert.equal(JSON.stringify(h.cue.recMeta), before);
  assert.equal(h.counts().saves, 0); assert.equal(h.counts().destroys, 1);
});
test('locked property editor is inert and ignores callbacks', () => {
  const h = harness(), before = JSON.stringify(h.cue.recMeta);
  h.ctx.mountPropsCurve(h.cue, h.folder.cues[0], true);
  assert.equal(h.nodes.get('curveEditor').inert, true);
  h.options().onChange([], { interpolation: 'step', commit: true });
  assert.equal(JSON.stringify(h.cue.recMeta), before); assert.equal(h.counts().saves, 0);
});
test('cancel callback restores exact metadata and the next gesture has one clean undo', () => {
  const h = harness(), original = structuredClone(h.cue.recMeta);
  h.ctx.mountPropsCurve(h.cue, h.folder.cues[0], false);
  const changed = structuredClone(h.cue.recMeta.keyframes); changed[0].value = .2;
  h.options().onChange(changed, { interpolation: 'linear', commit: false });
  h.options().onChange(h.options().points, { interpolation: 'linear', commit: false });
  assert.equal(JSON.stringify(h.cue.recMeta), JSON.stringify(original));
  assert.equal(h.run('undoStack.length'), 0);
  h.options().onChange(changed, { interpolation: 'linear', commit: true });
  assert.equal(h.run('undoStack.length'), 1); assert.equal(h.counts().saves, 1);
});
test('renderProps destroys old mount and rolls back preview before remounting or deselecting', () => {
  const h = harness(); vm.runInContext(production('renderProps'), h.ctx);
  h.ctx.renderProps();
  const original = JSON.stringify(h.cue.recMeta);
  const changed = structuredClone(h.cue.recMeta.keyframes); changed[0].value = .2;
  h.options().onChange(changed, { interpolation: 'linear', commit: false });
  h.ctx.renderProps();
  assert.equal(h.counts().destroys, 1); assert.equal(JSON.stringify(h.cue.recMeta), original);
  h.ctx.state.sel = null; h.ctx.renderProps();
  assert.equal(h.counts().destroys, 2); assert.equal(h.nodes.get('curveEditor').hidden, true);
});
test('production edge-drag trims from original curve on every preview, never stretches', () => {
  const h = harness(), events = timelineEvents(h);
  h.ctx.blockDrag = { ev: h.cue, folder: h.folder, mode: 'resize-l', mouse: { x: 30, y: 0 },
    f0: 30, end0: 60, moved: false, dur0: 30, meta0: structuredClone(h.cue.recMeta) };
  events.mousemove({ clientX: 45, clientY: 0 });
  assert.equal(h.cue.frame, 45); assert.equal(h.cue.duration, 15); close(h.cue.recMeta.keyframes[0].value, .9);
  events.mousemove({ clientX: 40, clientY: 0 });
  assert.equal(h.cue.frame, 40); assert.equal(h.cue.duration, 20); close(h.cue.recMeta.keyframes[0].value, .7496);
  assert.equal(h.cue.recMeta.keyframes.at(-1).value, .6142); assert.equal(h.run('undoStack.length'), 0);
});
test('production Ctrl/Alt-copy mouseup restores all originals and preserves deep metadata', () => {
  const h = harness(), events = timelineEvents(h);
  const second = { ...structuredClone(h.cue), id: 3, frame: 70, lane: 'R2', laneId: 2 };
  h.folder.events.push(second);
  h.ctx.blockDrag = { ev: h.cue, folder: h.folder, mode: 'move', moved: true, copy: true,
    items: [h.cue, second].map((ev) => ({ ev, folder: h.folder, frame: ev.frame,
      lane: ev.lane, laneId: ev.laneId, manualLane: ev.manualLane })) };
  h.cue.frame += 100; second.frame += 100;
  events.mouseup({});
  assert.equal(h.cue.frame, 30); assert.equal(second.frame, 70);
  assert.deepEqual([...h.ctx.state.multiSel].map((ev) => ev.frame), [130, 170]);
  assert.ok([...h.ctx.state.multiSel].every((ev) => ev.smpteInput && ev.recMeta.keyframes[0].value === .4488));
  assert.equal(h.run('undoStack.length'), 1);
});
test('production locked drag ignores movement and preserves metadata', () => {
  const h = harness(), events = timelineEvents(h), original = JSON.stringify(h.cue);
  h.ctx.blockDrag = { ev: h.cue, locked: true, moved: false };
  events.mousemove({ clientX: 200, clientY: 200 });
  assert.equal(JSON.stringify(h.cue), original); assert.equal(h.run('undoStack.length'), 0);
});
test('property duration change trims and stores one correct before/after undo snapshot', () => {
  const h = harness();
  vm.runInContext(source.slice(source.indexOf("$('pDur').addEventListener('change'"),
    source.indexOf("$('pDur').addEventListener('keydown'")), h.ctx);
  h.ctx.$('pDur').value = '15';
  const before = h.run('snapshot()');
  h.nodes.get('pDur').listeners.change();
  assert.equal(h.cue.duration, 15); close(h.cue.recMeta.keyframes.at(-1).dt, 500);
  close(h.cue.recMeta.keyframes.at(-1).value, .9);
  assert.equal(h.run('undoStack.length'), 1); assert.equal(h.run('undoStack[0]'), before);
});
test('property time change and nudge only move frames, preserve curves and respect locks', () => {
  const h = harness(), original = JSON.stringify(h.cue.recMeta);
  vm.runInContext(source.slice(source.indexOf("$('pTime').addEventListener('change'"),
    source.indexOf("$('pTime').addEventListener('keydown'")), h.ctx);
  h.ctx.$('pTime').value = '120'; h.nodes.get('pTime').listeners.change();
  assert.equal(h.cue.frame, 120); assert.equal(JSON.stringify(h.cue.recMeta), original);
  assert.equal(h.run('undoStack.length'), 1);
  vm.runInContext(production('nudgeSelected'), h.ctx);
  h.ctx.nudgeSelected(-200); assert.equal(h.cue.frame, 0);
  assert.equal(JSON.stringify(h.cue.recMeta), original);
  h.lanes[0].locked = true; h.ctx.nudgeSelected(5); assert.equal(h.cue.frame, 0);
});
test('legacy curve speed defaults to one; extending holds last value without time scaling', () => {
  const h = harness(); delete h.cue.recMeta.recordingSpeed;
  assert.equal(h.ctx.cueCurveSpeed(h.cue), 1);
  h.ctx.trimCueCurve(h.cue, 0, 60);
  assert.deepEqual(Array.from(h.cue.recMeta.keyframes, (p) => p.dt), [0, 500, 1000, 2000]);
  assert.equal(h.cue.recMeta.keyframes.at(-1).value, .6142);
});
test('Shift box selection uses cue spans and rows without changing any cue', () => {
  const h = harness(), events = timelineEvents(h), original = JSON.stringify(h.cue);
  h.ctx.timelineRows = () => [{ lane: 'R1', y: 25, h: 40 }];
  h.ctx.refreshVF = () => [{ ev: h.cue, t: 30 }];
  h.ctx.eventEndFrame = () => 60;
  h.ctx.dragInfo = { x: 20, y: 22, box: true, moved: false, selection: new Set() };
  events.mousemove({ clientX: 70, clientY: 80 });
  assert.equal(h.ctx.state.multiSel.has(h.cue), true); assert.equal(JSON.stringify(h.cue), original);
  events.mouseup({ clientX: 70, clientY: 80 }); assert.equal(h.ctx.dragInfo, null);
});
test('Play Now never sends unassigned or MIDI display-only curves', () => {
  const h = harness(), sent = [];
  h.ctx.sendOsc = (...args) => sent.push(args);
  vm.runInContext(source.slice(source.indexOf("$('pPlayNow').addEventListener('click'"),
    source.indexOf("$('propsHead').addEventListener")), h.ctx);
  h.cue.recMeta.dataOrigin = 'midi'; h.nodes.get('pPlayNow').listeners.click();
  h.cue.recMeta.dataOrigin = 'osc'; h.cue.recMeta.unassigned = true; h.nodes.get('pPlayNow').listeners.click();
  assert.equal(sent.length, 0);
  h.cue.recMeta.unassigned = false; h.nodes.get('pPlayNow').listeners.click(); assert.equal(sent.length, 1);
});
test('real schema codecs preserve complete OSC args and bytes through snapshot and curve copy', () => {
  const h = harness();
  const args = [.4488, 'Tiếng Việt', [2, null, true], Uint8Array.from([0, 127, 255]), null, false];
  h.folder.cues[0].args = structuredClone(args);
  h.cue.recMeta.keyframes[0].args = structuredClone(args);
  h.cue.recMeta.extras = [{ args: structuredClone(args) }];
  const decoded = h.ctx.projectDecode(JSON.parse(h.ctx.snapshot()));
  const restored = h.ctx.projectOscArgs(decoded.folders[0].events[0].recMeta.keyframes[0].args);
  assert.deepEqual(Array.from(restored[3]), [0, 127, 255]);
  assert.ok(restored[3] instanceof Uint8Array);
  assert.equal(restored[1], 'Tiếng Việt'); assert.equal(restored[4], null); assert.equal(restored[5], false);
  assert.deepEqual(Array.from(restored[2]), [2, null, true]);
  h.ctx.copySelection(); h.ctx.pasteSelection(100);
  const dup = h.folder.events.find((ev) => ev !== h.cue);
  const def = h.folder.cues.find((item) => item.id === dup.cueId);
  assert.deepEqual(def.args, args); assert.deepEqual(dup.recMeta.keyframes[0].args, args);
  dup.recMeta.keyframes[0].args[3][0] = 90;
  assert.equal(h.cue.recMeta.keyframes[0].args[3][0], 0);
});
test('renderProps calls real output selector for selection and hides it on deselect', () => {
  const h = harness(); h.folder.cues[0].outputTarget = 'resolume';
  vm.runInContext(production('renderProps'), h.ctx); h.ctx.renderProps();
  assert.equal(h.nodes.get('pOscTargetRow').hidden, false);
  assert.equal(h.nodes.get('pOscTarget').value, '["resolume"]');
  h.ctx.state.sel = null; h.ctx.renderProps(); assert.equal(h.nodes.get('pOscTargetRow').hidden, true);
});
test('Play Now forwards per-cue target without altering full args', () => {
  const h = harness(), sent = [];
  h.folder.cues[0].outputTarget = ['resolume', 'backup'];
  h.ctx.sendOsc = (...args) => sent.push(args);
  vm.runInContext(source.slice(source.indexOf("$('pPlayNow').addEventListener('click'"),
    source.indexOf("$('propsHead').addEventListener")), h.ctx);
  h.nodes.get('pPlayNow').listeners.click();
  assert.deepEqual(sent[0], ['/real', h.folder.cues[0].args, ['resolume', 'backup']]);
});
for (const fps of [24, 25, 30]) {
  test(`captured endpoint rounding parity at ${fps}fps, trims and splits clear normalization flag`, () => {
    const h = harness(fps), endMs = fps === 25 ? 170 : 180;
    h.cue.duration = Math.round(endMs / 1000 * fps);
    h.cue.recMeta.captureEndpoint = true;
    h.cue.recMeta.keyframes = [{ dt: 0, ms: 0, value: .2, args: [.2, 'first'] },
      { dt: endMs, ms: endMs, value: .8, args: [.8, 'exact-last', null] }];
    const raw = JSON.stringify(h.cue.recMeta.keyframes), normalized = h.ctx.cueCurvePoints(h.cue);
    close(normalized.at(-1).dt, h.cue.duration * 1000 / fps);
    assert.equal(normalized.at(-1).value, .8); assert.equal(normalized.at(-1).args[1], 'exact-last');
    assert.equal(JSON.stringify(h.cue.recMeta.keyframes), raw);
    const dup = h.ctx.cloneCuePlacement(h.cue, 80, h.folder);
    assert.equal(dup.recMeta.captureEndpoint, true);
    h.ctx.trimCueCurve(dup, 0, h.cue.duration);
    assert.equal(dup.recMeta.captureEndpoint, false); assert.equal(dup.recMeta.keyframes.at(-1).value, .8);
    const right = h.ctx.splitCuePlacement(h.folder, h.cue, h.cue.frame + 2, h.cue.frame + h.cue.duration);
    assert.equal(h.cue.recMeta.captureEndpoint, false); assert.equal(right.recMeta.captureEndpoint, false);
    assert.equal(right.recMeta.keyframes.at(-1).value, .8);
  });
}
test('only untouched captured sub-frame endpoints normalize; actual editing clears flag and cancel restores it', () => {
  const h = harness(); h.cue.recMeta.captureEndpoint = true;
  h.ctx.mountPropsCurve(h.cue, h.folder.cues[0], false);
  const changed = structuredClone(h.options().points); changed[0].value = .3;
  h.options().onChange(changed, { interpolation: 'linear', commit: false });
  assert.equal(h.cue.recMeta.captureEndpoint, false);
  h.options().onChange(h.options().points, { interpolation: 'linear', commit: false });
  assert.equal(h.cue.recMeta.captureEndpoint, true);
  h.options().onChange(changed, { interpolation: 'linear', commit: true });
  assert.equal(h.cue.recMeta.captureEndpoint, false);
  h.cue.recMeta.keyframes.at(-1).dt = h.cue.recMeta.keyframes.at(-1).ms = 1080;
  h.cue.recMeta.captureEndpoint = true;
  assert.equal(h.ctx.cueCurvePoints(h.cue).at(-1).dt, 1080);
  h.cue.recMeta.keyframes.at(-1).dt = h.cue.recMeta.keyframes.at(-1).ms = 1010;
  h.cue.recMeta.captureEndpoint = false;
  assert.equal(h.ctx.cueCurvePoints(h.cue).at(-1).dt, 1010);
});
test('captured edge-drag previews normalize original duration, not current resized duration', () => {
  const h = harness(30), events = timelineEvents(h);
  h.cue.duration = 5; h.cue.recMeta.captureEndpoint = true;
  h.cue.recMeta.keyframes = [{ dt: 0, ms: 0, value: .2 }, { dt: 180, ms: 180, value: .8 }];
  h.ctx.blockDrag = { ev: h.cue, folder: h.folder, mode: 'resize-r', mouse: { x: 35, y: 0 },
    f0: 30, end0: 35, moved: false, dur0: 5, meta0: structuredClone(h.cue.recMeta) };
  events.mousemove({ clientX: 32, clientY: 0 });
  close(h.cue.recMeta.keyframes.at(-1).value, .44);
  events.mousemove({ clientX: 35, clientY: 0 });
  assert.equal(h.cue.recMeta.keyframes.at(-1).value, .8);
  assert.equal(h.cue.recMeta.captureEndpoint, false);
});

let failed = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
console.log(`${cases.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
