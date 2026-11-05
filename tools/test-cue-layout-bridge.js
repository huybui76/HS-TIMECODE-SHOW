#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CFG = require('../realtime-config');
const REC = require('../renderer/rec-engine');
const Layout = require('../renderer/cue-layout');
const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');

function production(name) {
  const match = source.match(new RegExp('^(?:async )?function ' + name + '\\([^]*?^}', 'm'));
  assert.ok(match, 'Missing production function ' + name);
  return match[0];
}

function harness() {
  let sequence = 100;
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', style: {}, innerHTML: '', children: [],
      appendChild(child) { this.children.push(child); }, addEventListener(type, fn) { this[type] = fn; } });
    return elements.get(id);
  };
  const ctx = vm.createContext({ console, structuredClone, REC_CFG: CFG, nid: () => ++sequence,
    window: { HSRealtime: CFG, HSCueLayout: Layout, HSREC: REC }, laneAlloc: new REC.LaneAllocator(),
    $, document: { createElement: () => ({ style: {}, addEventListener(type, fn) { this[type] = fn; } }), querySelectorAll: () => [] },
    recDebug() {}, flashStatus() {}, setStatus() {}, renderFolders() {}, renderProps() {},
    renderTimelineHeader() {}, updateSelBar() {}, updateStatsBar() {}, fillRecFolderSel() {},
    syncOscFloatAddresses() {}, refreshPlaybackSchedule() {}, lowerBoundFlat: () => 0, scheduleAutosave() {}, noteChange() {},
    renderLanes() {}, fillRecLaneSel() {}, refreshVF() {}, confirm: () => true,
    masterVol: 0.9, clipLen: () => 0, SWATCHES: ['#123456', '#abcdef'], selDef: () => ctx.selectedDef,
    oscUI: { targets: [] }, midiMap: new Map(), MIDI: { padMap: new Map() },
    recTransactions: new Map(), restoringHistory: false, infoDirty: false, performance: { now: () => 1000 },
    setTimeout: () => 0, clearTimeout() {}, recActiveSession: null });
  vm.runInContext(source.match(/^const state = \{[^]*?^};/m)[0], ctx);
  vm.runInContext('let flat = [];', ctx);
  for (const name of ['curFolder', 'laneById', 'laneByName', 'nextLaneName', 'sortLanesByKind',
    'recSyncLaneGroups', 'recNormalizeLanes', 'addLane', 'removeLane', 'recLane', 'ensureLanesForProject',
    'makeDef', 'makePlacement', 'insertCue', 'recCueName', 'recMapKey', 'recLaneByName', 'recLayoutCue',
    'recCreateLiveCue', 'recFinalizeCue', 'recAssignOsc', 'midiPadLearn', 'renderSwatches',
    'captureActiveProject', 'serializeProject', 'migrateFolder', 'migrateAudioClips', 'freshProjectData',
    'projectEncode', 'projectDecode', 'projectOscArgs',
    'rebuildFlat', 'refreshAll', 'snapshot', 'applySnapshot', 'deleteSelection']) {
    vm.runInContext(production(name), ctx);
  }
  vm.runInContext('let learnPending = null, learnTimer = null; const LEARN_UI_FLUSH_MS = 160;', ctx);
  ctx.folder = { id: 1, name: 'One', offset: 0, cues: [], events: [], lanes: [], audioClips: [] };
  const run = (code) => vm.runInContext(code, ctx);
  run('state.folders = [folder]; state.activeFolderId = 1; state.lanes = folder.lanes;');
  ctx.run = run;
  ctx.action = (extra = {}, folder = ctx.folder) => {
    const desc = { source: 'midi', kind: 'trigger', num: 60, ch: 1, startFrame: 10,
      durationFrames: 30, address: '/composition/layers/3/clips/7/connect', args: [1, 'actual'], ...extra };
    const cue = ctx.recCreateLiveCue(folder, desc);
    ctx.recFinalizeCue(folder, cue, desc);
    return { cue, def: folder.cues.find((item) => item.id === cue.cueId), desc };
  };
  return ctx;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('production name bridge uses conventional Resolume and MIDI names without REST', () => {
  const h = harness();
  assert.equal(h.recCueName({}, '/composition/layers/3/clips/7/connect'), 'Layer3·Column7·Clip7');
  assert.equal(h.recCueName({}, '/composition/groups/2/layers/3/video/opacity'), 'Group2·Layer3·Opacity');
  assert.equal(h.recCueName({ num: 27, ch: 1 }, ''), 'MIDI D#1(27) ·ch1');
  assert.equal(h.recCueName({ num: 7, ch: 2, kind: 'float' }, ''), 'MIDI CC7 ·ch2');
});

test('independent actions retain their own args/modes and share clip group/color', () => {
  const h = harness(); const a = h.action();
  const b = h.action({ kind: 'piano', startFrame: 60, address: '/composition/layers/3/clips/8/connect', args: [0] });
  assert.notEqual(a.def.id, b.def.id);
  assert.deepEqual(Array.from(a.def.args), [1, 'actual']);
  assert.deepEqual(Array.from(b.def.args), [0]);
  assert.equal(b.def.mode, 'piano');
  assert.equal(a.cue.lane, b.cue.lane);
  assert.equal(a.def.color, b.def.color);
  assert.equal(a.cue.recGroup, 'layer:3/clips');
});

test('parameters separate by layer+parameter, columns have one group', () => {
  const h = harness();
  const a = h.action({ address: '/composition/layers/3/video/opacity', kind: 'float' });
  const b = h.action({ address: '/composition/layers/3/video/speed', kind: 'float' });
  const c = h.action({ address: '/composition/columns/1/connect' });
  const d = h.action({ address: '/composition/columns/9/connect' });
  assert.notEqual(a.cue.lane, b.cue.lane);
  assert.equal(c.cue.lane, d.cue.lane);
});

test('unknown MIDI notes, CC and device identities never merge', () => {
  const h = harness();
  const cues = [h.action({ address: '', num: 1 }), h.action({ address: '', num: 2 }),
    h.action({ address: '', num: 1, kind: 'float' }), h.action({ address: '', num: 1, device: 'B' })];
  assert.equal(new Set(cues.map((item) => item.cue.lane)).size, 4);
});

test('exact address setting separates clips but does not rewrite existing placements', () => {
  const h = harness(); h.run("state.laneGroupMode = 'address';");
  const a = h.action(); const b = h.action({ address: '/composition/layers/3/clips/8/connect' });
  assert.notEqual(a.cue.lane, b.cue.lane);
  h.run("state.laneGroupMode = 'layer+type';"); h.refreshAll();
  assert.notEqual(a.cue.lane, b.cue.lane);
});

test('overlap aux inserted directly under root before unrelated group with continuous R labels', () => {
  const h = harness(); const a = h.action({ kind: 'piano', durationFrames: 60 });
  const b = h.action({ address: '/composition/layers/4/clips/1/connect' });
  const c = h.action({ kind: 'piano', startFrame: 20, durationFrames: 30 });
  assert.deepEqual(h.folder.lanes.map((lane) => lane.name), ['R1', 'R2', 'R3']);
  assert.equal(a.cue.lane, 'R1'); assert.equal(c.cue.lane, 'R2'); assert.equal(b.cue.lane, 'R3');
  assert.equal(h.folder.lanes[1].auxOf, h.folder.lanes[0].id);
  assert.equal(h.folder.lanes[1].auxiliary, true);
  assert.equal(h.folder.lanes[1].color, h.folder.lanes[0].color);
});

test('trigger on same layer uses root even over an active Piano', () => {
  const h = harness(); const a = h.action({ kind: 'piano', durationFrames: 90 });
  assert.equal(h.action({ startFrame: 20 }).cue.lane, a.cue.lane);
});

test('only auto-created empty R rows removed; manual +R and legacy unmarked rows retained', () => {
  const h = harness(); const manual = h.addLane('R'); const automatic = h.addLane('R', true);
  h.folder.lanes.push({ id: 9, name: 'R9', kind: 'R', recGroup: 'legacy' });
  h.recNormalizeLanes();
  assert.ok(h.folder.lanes.includes(manual)); assert.ok(!h.folder.lanes.includes(automatic));
  assert.ok(h.folder.lanes.some((lane) => lane.id === 9));
  assert.deepEqual(Array.from(h.folder.lanes, (lane) => lane.name), ['R1', 'R2']);
});

test('silent auto spare is reused for aux without consuming empty manual +R', () => {
  const h = harness(); h.action({ kind: 'piano', durationFrames: 90 });
  const manual = h.addLane('R'); const spare = h.addLane('R', true);
  const a = h.action({ kind: 'piano', startFrame: 20 });
  assert.equal(h.folder.lanes.find((lane) => lane.name === a.cue.lane).id, spare.id);
  assert.equal(h.folder.lanes[1], spare); assert.ok(h.folder.lanes.includes(manual));
  assert.equal(manual.recGroup, undefined);
});

test('empty locked auto row is retained and missing rec pointer falls back safely', () => {
  const h = harness(); const locked = h.addLane('R', true); locked.locked = true;
  h.run('state.recLaneId = -1;'); h.recNormalizeLanes();
  assert.equal(h.run('state.recLaneId'), locked.id); assert.ok(h.folder.lanes.includes(locked));
});

test('delete row updates events, pointers and allocator but never inactive folder', () => {
  const h = harness(); const a = h.action(); const b = h.action({ address: '/other' });
  const other = { id: 2, lanes: [{ id: 50, name: 'R1', kind: 'R' }], events: [{ lane: 'R1' }] };
  h.run('state.recLaneId = folder.lanes[1].id;');
  h.other = other; h.run('state.folders.push(other);');
  const pointer = h.run('state.recLaneId');
  h.removeLane(h.folder.lanes[0].id);
  assert.ok(!h.folder.events.includes(a.cue)); assert.equal(b.cue.lane, 'R1');
  assert.equal(other.events[0].lane, 'R1'); assert.equal(other.events.length, 1);
  assert.equal(h.run('state.recLaneId'), pointer);
  assert.deepEqual(Array.from(h.laneAlloc.exportGroups()['address:/other']), ['R1']);
});

test('normalization after reorder preserves selected event identity and stable rec pointer', () => {
  const h = harness(); const a = h.action(); const b = h.action({ address: '/other' });
  const laneId = h.folder.lanes[0].id;
  h.selected = a.cue; h.run('state.sel = selected; state.multiSel.add(selected); state.recLaneId = folder.lanes[0].id;');
  h.folder.lanes.reverse(); h.recNormalizeLanes();
  assert.equal(h.run('state.sel'), a.cue); assert.ok(h.run('state.multiSel.has(selected)'));
  assert.equal(a.cue.lane, 'R2'); assert.equal(b.cue.lane, 'R1');
  assert.equal(h.run('state.recLaneId'), laneId);
  assert.deepEqual(Array.from(h.laneAlloc.exportGroups()['layer:3/clips']), ['R2']);
});

test('delete cue removes auto empty row and renumbers later rows', () => {
  const h = harness(); const a = h.action(); const b = h.action({ address: '/other' });
  h.selSet = () => new Set([a.cue]); h.selAudioClip = () => null;
  h.findCueLoc = (cue) => ({ f: h.folder, i: h.folder.events.indexOf(cue) });
  h.deleteSelection(false);
  assert.equal(h.folder.lanes.length, 1); assert.equal(b.cue.lane, 'R1');
});

test('manual lane stays through refresh and finalizer; explicit new mapping may regroup', () => {
  const h = harness(); const a = h.action(); const manual = h.addLane('R');
  a.cue.lane = manual.name; a.cue.manualLane = true;
  h.refreshAll(); h.recFinalizeCue(h.folder, a.cue, a.desc);
  assert.equal(a.cue.lane, manual.name); assert.ok(a.cue.manualLane);
  h.recAssignOsc(a.cue, '/composition/layers/9/clips/2/connect', [1]);
  assert.equal(a.cue.manualLane, false); assert.equal(a.cue.recGroup, 'layer:9/clips');
});

test('manual action name and color survive remapping and finalization, siblings unchanged', () => {
  const h = harness(); const a = h.action(); const b = h.action({ startFrame: 80 });
  a.def.name = 'Operator'; a.def.nameEdited = true; a.def.color = '#abcdef'; a.def.colorManual = true;
  const color = b.def.color;
  h.recAssignOsc(a.cue, '/composition/layers/9/clips/2/connect', [0]);
  assert.equal(a.def.name, 'Operator'); assert.equal(a.def.color, '#abcdef'); assert.equal(b.def.color, color);
});

test('swatch handler marks only selected action color manual', () => {
  const h = harness(); const a = h.action(); const b = h.action(); h.selectedDef = a.def;
  h.renderSwatches(); h.$('pSwatches').children[0].click();
  assert.equal(a.def.colorManual, true); assert.equal(a.def.color, '#123456');
  assert.equal(b.def.colorManual, false);
});

test('name input handler marks explicit edits without touching siblings', () => {
  const h = harness(); const a = h.action(); h.selectedDef = a.def;
  vm.runInContext(source.match(/^\$\('pName'\)\.addEventListener\('input', \(e\) => \{[^]*?^\}\);/m)[0], h);
  h.$('pName').input({ target: { value: 'Manual Name' } });
  assert.equal(a.def.nameEdited, true); assert.equal(a.def.name, 'Manual Name');
});

test('group manual color preserved and inherited by new actions', () => {
  const h = harness(); const a = h.action(); const root = h.folder.lanes[0];
  root.color = '#abc123'; root.colorManual = true;
  const b = h.action({ startFrame: 80 });
  assert.equal(root.color, '#abc123'); assert.equal(b.def.color, '#abc123');
  assert.notEqual(a.def.color, '');
});

test('inactive descriptor normalization uses its folder only', () => {
  const h = harness(); h.action(); const active = h.folder.lanes;
  const other = { id: 2, offset: 100, lanes: [], cues: [], events: [] };
  h.other = other; h.run('state.folders.push(other);');
  const a = h.action({ startFrame: 120, source: 'osc', kind: 'float', device: 'device' }, other);
  assert.equal(a.cue.frame, 20); assert.equal(a.cue.recMeta.source, 'osc');
  assert.equal(a.cue.recMeta.device, 'device'); assert.equal(h.run('state.lanes'), active);
});

test('serialize/migrate preserves lane schema, manual flags, colors, pointers and mode', () => {
  const h = harness(); const a = h.action({ kind: 'piano', durationFrames: 60, recordingSpeed: 1.5 });
  h.action({ kind: 'piano', startFrame: 20 }); h.addLane('R');
  a.def.colorManual = true; a.def.nameEdited = true; a.cue.manualLane = true;
  h.folder.lanes[0].colorManual = true;
  h.run("state.recLaneId = folder.lanes[0].id; state.laneGroupMode = 'address';");
  const saved = JSON.parse(JSON.stringify(h.serializeProject()));
  assert.equal(saved.settings.laneGroupMode, 'address');
  const loaded = h.migrateFolder(saved.folders[0], null, []);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.lanes)), saved.folders[0].lanes);
  assert.equal(loaded.recLaneId, saved.folders[0].recLaneId);
  assert.equal(loaded.cues[0].colorManual, true); assert.equal(loaded.cues[0].nameEdited, true);
  assert.equal(loaded.events[0].manualLane, true);
  assert.equal(loaded.events[0].recMeta.recordingSpeed, 1.5);
});

test('optional settings listener validates values and updates persisted mode', () => {
  const h = harness();
  const listener = source.match(/^if \(\$\('laneGroupMode'\)\) \{[^]*?^}/m);
  assert.ok(listener); vm.runInContext(listener[0], h);
  h.$('laneGroupMode').change({ target: { value: 'address' } });
  assert.equal(h.serializeProject().settings.laneGroupMode, 'address');
  h.$('laneGroupMode').change({ target: { value: 'invalid' } });
  assert.equal(h.run('state.laneGroupMode'), CFG.LANE_GROUP_MODE);
});

test('old laneGroups recover auto ownership and new conventional group without claiming +R', () => {
  const h = harness(); const a = h.action(); const saved = JSON.parse(JSON.stringify(h.serializeProject().folders[0]));
  saved.lanes = [{ id: 1, name: 'R1', kind: 'R' }, { id: 2, name: 'R2', kind: 'R' }];
  saved.events[0].lane = 'R1'; delete saved.laneGroups;
  const loaded = h.migrateFolder(saved, { isOwnFolder: true, laneGroups: { old: ['R1'] } }, []);
  assert.equal(loaded.lanes[0].recGroup, 'layer:3/clips'); assert.equal(loaded.lanes[0].autoRec, true);
  assert.equal(loaded.lanes[1].autoRec, false);
  assert.equal(loaded.cues[0].name, a.def.name);
});

test('undo snapshot restores lane metadata and alias references', () => {
  const h = harness(); const a = h.action(); const snap = h.snapshot();
  h.folder.lanes[0].groupLabel = 'changed'; h.addLane('R');
  h.applySnapshot(snap);
  assert.equal(h.run('state.lanes[0].groupLabel'), 'Layer3·Clips');
  assert.equal(h.run('curFolder().lanes === state.lanes'), true);
  assert.equal(h.run('state.folders[0].events[0].cueId'), a.cue.cueId);
});

let failed = 0;
for (const { name, fn } of tests) {
  try { fn(); console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
console.log(`${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
