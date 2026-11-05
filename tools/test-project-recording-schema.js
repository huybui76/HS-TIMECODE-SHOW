#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CFG = require('../realtime-config');
const Layout = require('../renderer/cue-layout');
const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
function production(name) {
  const match = source.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'));
  assert.ok(match, 'Missing production function ' + name);
  return match[0];
}

function harness(config = {}) {
  const elements = new Map(), counts = { history: 0, saves: 0, refresh: 0 };
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.style = {}; this.listeners = {}; this.value = ''; }
    set id(value) { this._id = value; elements.set(value, this); }
    get id() { return this._id; }
    set innerHTML(value) { assert.equal(value, ''); this.children = []; }
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
    append(...children) { children.forEach((child) => this.appendChild(child)); }
    setAttribute(key, value) { this[key] = value; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    focus() { this.focused = true; }
  }
  for (const id of ['propsBody', 'recLaneSel', 'pianoEndAction']) { const item = new Element('div'); item.id = id; }
  const section = new Element('div'), row = new Element('div');
  section.appendChild(row); row.appendChild(elements.get('recLaneSel'));
  const ctx = vm.createContext({ console, structuredClone, Uint8Array, REC_CFG: { ...CFG, ...config },
    window: { HSRealtime: CFG, HSCueLayout: Layout },
    document: { createElement: (tag) => new Element(tag), querySelector: () => null },
    $: (id) => elements.get(id) || null,
    oscUI: { targets: [{ id: 'out-a', name: 'Arena A', enabled: true }, { id: 'out-b', name: 'Arena B', enabled: false }] },
    nid: () => 900, laneAlloc: { exportGroups: () => ({}), importGroups() {} },
    midiMap: new Map(), MIDI: { padMap: new Map() },
    captureActiveProject() {}, clipLen: () => 0, freshProjectData: () => ({ lanes: [], audioClips: [] }),
    noteChange: () => counts.history++, scheduleAutosave: () => counts.saves++,
    refreshAll: () => counts.refresh++, rebuildFlat() {}, renderProps() {}, updateSelBar() {},
    restoringHistory: false
  });
  vm.runInContext(source.match(/^const state = \{[^]*?^};/m)[0], ctx);
  for (const name of ['curFolder', 'projectEncode', 'projectDecode', 'projectOscArgs', 'serializeProject',
    'migrateFolder', 'migrateAudioClips', 'snapshot', 'applySnapshot', 'recSyncLaneGroups', 'recNormalizeLanes',
    'mountCueOutputSelector', 'recMoveLaneById', 'renderRecLaneOrder']) vm.runInContext(production(name), ctx);
  const run = (code) => vm.runInContext(code, ctx);
  run(`state.activeFolderId = 1; state.folders = [{ id: 1, name: 'A', offset: 0, lanes: [], cues: [], events: [], audioClips: [] }];
    state.lanes = state.folders[0].lanes;`);
  return { ctx, run, elements, counts, Element, folder: run('curFolder()') };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const plain = (value) => JSON.parse(JSON.stringify(value));
function fixture(h) {
  const args = [0.4488, 'Tiếng Việt / 日本語', [false, null, 'nested', new Uint8Array([0, 128, 255])],
    new Uint8Array([1, 2, 3, 4]), { r: 1, g: 2, b: 3, a: 0.5 }, { high: 42, low: 77, unsigned: false }];
  const meta = { kind: 'float', source: 'osc', dataOrigin: 'osc', recordingSpeed: 1.25, actionId: 'action-1', session: 7,
    matched: true, guessed: false, unassigned: false, manualLane: true, numericIndex: 0, interpolation: 'step',
    mappingStatus: 'manual', device: 'device-1', keyframesRaw: 12, keyframesSent: 2,
    keyframes: [{ dt: 0, ms: 0, t: 1000, tFrame: 0, seq: 17, numericIndex: 0, value: 0.4488, args },
      { dt: 1000, ms: 1000, t: 2000, seq: 20, numericIndex: 0, value: 0.6142, args: [0.6142, ...args.slice(1)] }],
    extras: [{ address: '/extra', args, dtMs: 1, count: 2, t: 1001, seq: 18, release: true }] };
  h.folder.cues.push({ id: 10, address: '/opacity', args, name: 'Manual name', nameEdited: true,
    color: '#123456', colorManual: true, mode: 'float', outputTarget: ['out-a', 'missing-out'] });
  h.folder.events.push({ id: 20, cueId: 10, frame: 12, duration: 38, lane: 'R1', laneId: 100,
    enabled: true, manualLane: true, recGroup: 'float|@/opacity', recMeta: meta });
  h.folder.lanes.push({ id: 100, kind: 'R', name: 'R1', manual: true, manualLane: true, colorManual: true });
  h.run('state.recLaneId = 100;');
  h.ctx.midiMap.set('cc7c1', { address: '/opacity', kind: 'float', args });
  return { args, meta };
}

test('project JSON roundtrip preserves full source payloads, metadata and overrides without aliases', () => {
  const h = harness(), original = fixture(h);
  const saved = h.ctx.serializeProject();
  assert.equal(saved.version, 13);
  assert.deepEqual(plain(saved.folders[0].cues[0].args[3]), { __hsOscBytes: [1, 2, 3, 4] });
  h.ctx.disk = JSON.parse(JSON.stringify(saved));
  const loaded = h.run('migrateFolder(disk.folders[0], null, [], null)');
  const event = loaded.events[0], def = loaded.cues[0];
  assert.deepEqual(event.recMeta.keyframes[0].args[3], original.args[3]);
  assert.deepEqual(event.recMeta.keyframes[0].args[2][3], original.args[2][3]);
  assert.deepEqual(plain(event.recMeta), plain(original.meta));
  assert.deepEqual(plain(def.outputTarget), ['out-a', 'missing-out']);
  assert.equal(def.nameEdited, true); assert.equal(def.colorManual, true);
  assert.equal(event.manualLane, true); assert.equal(event.laneId, 100);
  assert.equal(def.args[1], original.args[1]);
  event.recMeta.keyframes[0].args[2][3][0] = 42;
  def.args[3][0] = 44;
  assert.equal(original.args[2][3][0], 0); assert.equal(original.args[3][0], 1);
  original.args[3][0] = 55;
  assert.equal(saved.folders[0].cues[0].args[3].__hsOscBytes[0], 1);
});

test('byte codec handles Buffer before JSON toJSON and rejects forged or invalid byte markers', () => {
  const h = harness();
  const encoded = h.ctx.projectEncode([Buffer.from([0, 255]), new Uint8Array([])]);
  const result = h.ctx.projectDecode(JSON.parse(JSON.stringify(encoded)));
  assert.deepEqual(result[0], new Uint8Array([0, 255]));
  assert.deepEqual(result[1], new Uint8Array([]));
  for (const marker of [{ __hsOscBytes: [-1] }, { __hsOscBytes: [256] }, { __hsOscBytes: [1.2] },
    { __hsOscBytes: [1], extra: true }, { __hsOscBytes: 'bad' }]) {
    assert.equal(h.ctx.projectDecode(marker) instanceof Uint8Array, false);
    assert.deepEqual(plain(h.ctx.projectOscArgs([marker])), []);
  }
});

test('bounded payload validation rejects nonfinite/deep values, retains complete nested standard OSC values', () => {
  const h = harness();
  assert.deepEqual(plain(h.ctx.projectOscArgs([Infinity])), []);
  let nested = [1]; for (let i = 0; i <= CFG.OSC_MAX_BUNDLE_DEPTH; i++) nested = [nested];
  assert.deepEqual(plain(h.ctx.projectOscArgs(nested)), []);
  assert.deepEqual(plain(h.ctx.projectOscArgs([1, 'utf8', [null, true], { high: 1, low: 2 }])),
    [1, 'utf8', [null, true], { high: 1, low: 2 }]);
});

test('migration filters invalid metadata, caps keyframes but retains exact last endpoint', () => {
  const h = harness({ FLOAT_MAX_POINTS: 3 }); fixture(h);
  const meta = h.folder.events[0].recMeta;
  Object.assign(meta, { numericIndex: -1, recordingSpeed: 0, interpolation: 'unknown' });
  meta.keyframes = [{ dt: -1, value: 4 }, { dt: 0, value: NaN }, ...Array.from({ length: 7 }, (_, i) =>
    ({ dt: i, value: i / 10, seq: i, args: [i / 10, 'payload'] }))];
  const loaded = h.ctx.migrateFolder(h.folder, null, [], null).events[0].recMeta;
  assert.deepEqual(plain(loaded.keyframes.map((p) => p.dt)), [0, 1, 6]);
  assert.equal(loaded.numericIndex, undefined); assert.equal(loaded.recordingSpeed, undefined);
  assert.equal(loaded.interpolation, undefined); assert.equal(loaded.keyframes.at(-1).seq, 6);
  assert.deepEqual(plain(loaded.keyframes.at(-1).args), [0.6, 'payload']);
});

test('snapshot application restores actual typed bytes, metadata and runtime piano setting independently', () => {
  const h = harness(); fixture(h);
  h.ctx.REC_CFG.PIANO_END_ACTION = 'layerclear';
  const snap = h.ctx.snapshot();
  h.folder.cues[0].args[3][0] = 99;
  h.ctx.REC_CFG.PIANO_END_ACTION = 'connect0';
  h.ctx.applySnapshot(snap);
  const restored = h.run('curFolder()');
  assert.deepEqual(restored.cues[0].args[3], new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual(restored.events[0].recMeta.keyframes[0].args[3], new Uint8Array([1, 2, 3, 4]));
  assert.equal(h.ctx.REC_CFG.PIANO_END_ACTION, 'layerclear');
  assert.equal(h.elements.get('pianoEndAction').value, 'layerclear');
  assert.equal(h.ctx.serializeProject().settings.pianoEndAction, 'layerclear');
});

test('real applyProject accepts v13 JSON and restores output routing, source bytes, mappings and piano setting', () => {
  const h = harness(); fixture(h);
  h.ctx.REC_CFG.PIANO_END_ACTION = 'layerclear';
  h.ctx.disk = JSON.parse(JSON.stringify(h.ctx.serializeProject()));
  for (const id of ['fpsSel', 'rowHRange', 'laneGroupMode', 'listenPort', 'targetHost', 'targetPort',
    'filterSel', 'filterRegex', 'filterHint']) { const item = new h.Element('input'); item.id = id; }
  Object.assign(h.ctx, { recTransactions: new Map(), pause() {}, audioSongId: null, audio: {},
    renderOscTargets() {}, setStatus() {}, filterDescription: () => '', clamp: (n, low, high) => Math.max(low, Math.min(high, n)) });
  h.ctx.document.querySelector = () => null;
  h.ctx.window.hs = { setListenPort() {} };
  h.run(`function activateProject(folder) { state.lanes = folder.lanes; state.audioClips = folder.audioClips;
    state.recLaneId = folder.recLaneId; }
    ${production('applyProject')}`);
  h.ctx.REC_CFG.PIANO_END_ACTION = 'connect0';
  h.ctx.applyProject(h.ctx.disk);
  const loaded = h.run('curFolder()');
  assert.deepEqual(loaded.cues[0].args[3], new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual(plain(loaded.cues[0].outputTarget), ['out-a', 'missing-out']);
  assert.deepEqual(loaded.events[0].recMeta.keyframes[1].args[3], new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual(h.ctx.midiMap.get('cc7c1').args[3], new Uint8Array([1, 2, 3, 4]));
  assert.equal(h.ctx.REC_CFG.PIANO_END_ACTION, 'layerclear');
});

test('piano settings listener updates the runtime copy, scheduler revision, history and serialization only for valid values', () => {
  const h = harness();
  const listener = source.match(/^if \(\$\('pianoEndAction'\)\) \{[^]*?^}/m);
  assert.ok(listener); h.run(listener[0]);
  const select = h.elements.get('pianoEndAction');
  select.listeners.change({ target: { value: 'layerclear' } });
  assert.equal(h.ctx.REC_CFG.PIANO_END_ACTION, 'layerclear');
  assert.equal(CFG.PIANO_END_ACTION, 'connect0');
  assert.equal(h.ctx.serializeProject().settings.pianoEndAction, 'layerclear');
  select.listeners.change({ target: { value: 'invalid' } });
  assert.equal(h.ctx.REC_CFG.PIANO_END_ACTION, 'layerclear');
  assert.equal(h.counts.saves, 1); assert.equal(h.counts.history, 2);
});

test('OSC selector retains unavailable target IDs and target lists until an explicit edit', () => {
  const h = harness(); fixture(h);
  h.run('state.sel = curFolder().events[0]; mountCueOutputSelector(state.sel);');
  const select = h.elements.get('pOscTarget');
  assert.equal(select.children[0].textContent, 'Tất cả OSC Out');
  assert.match(select.children.find((o) => o.value === '["out-b"]').textContent, /đang tắt/);
  assert.equal(select.value, '["out-a","missing-out"]');
  assert.equal(select.children.length, 4);
  h.folder.cues[0].outputTarget = 'gone'; h.ctx.mountCueOutputSelector(h.folder.events[0]);
  assert.equal(select.value, '["gone"]'); assert.match(select.children.at(-1).textContent, /không khả dụng/);
  select.value = '["out-a"]'; select.onchange();
  assert.equal(h.folder.cues[0].outputTarget, 'out-a');
  select.value = ''; select.onchange();
  assert.equal('outputTarget' in h.folder.cues[0], false);
  assert.equal(h.counts.saves, 2); assert.equal(h.counts.history, 4);
  h.ctx.mountCueOutputSelector(null); assert.equal(h.elements.get('pOscTargetRow').hidden, true);
});

test('OSC selector does not edit a locked lane or stale selection and preserves empty destination list', () => {
  const h = harness(); fixture(h);
  h.folder.cues[0].outputTarget = [];
  h.run('state.sel = curFolder().events[0]; mountCueOutputSelector(state.sel);');
  const select = h.elements.get('pOscTarget');
  assert.equal(select.value, '[]');
  h.folder.lanes[0].locked = true; h.ctx.mountCueOutputSelector(h.folder.events[0]);
  assert.equal(select.disabled, true);
  select.value = ''; select.onchange(); assert.deepEqual(plain(h.folder.cues[0].outputTarget), []);
  h.folder.lanes[0].locked = false; h.ctx.mountCueOutputSelector(h.folder.events[0]);
  h.run('state.sel = null'); select.onchange(); assert.deepEqual(plain(h.folder.cues[0].outputTarget), []);
  assert.equal(h.counts.saves, 0);
});

function laneFixture(h) {
  const lanes = [{ id: 'v', name: 'V1', kind: 'V' }, { id: 'a', name: 'A1', kind: 'A' },
    ...[1, 2, 3].map((i) => ({ id: 'r' + i, name: 'R' + i, kind: 'R', recGroup: 'g' + i, manual: true }))];
  h.folder.lanes.push(...lanes);
  const events = lanes.filter((l) => l.kind === 'R').map((l, i) =>
    ({ id: 'e' + i, cueId: 10, laneId: l.id, lane: l.name, frame: 10 + i, duration: 20, recMeta: { kind: 'float' } }));
  h.folder.events.push(...events);
  h.ctx.other = { id: 2, lanes: [{ id: 'other', name: 'R1', kind: 'R' }], events: [{ id: 'other-event', lane: 'R1' }] };
  h.run('state.folders.push(other); state.recLaneId = "r2"; state.sel = curFolder().events[0]; state.multiSel.add(state.sel);');
  return { lanes, events, other: JSON.stringify(h.ctx.other) };
}

test('real lane reorder preserves V/A slots, event identities/payloads and independent folder', () => {
  const h = harness(), before = laneFixture(h);
  const eventPayload = h.folder.events.map((e) => ({ ...e }));
  assert.equal(h.ctx.recMoveLaneById('r3', 'r1'), true);
  assert.deepEqual(plain(h.folder.lanes.map((l) => l.id)), ['v', 'a', 'r3', 'r1', 'r2']);
  assert.deepEqual(plain(h.folder.lanes.map((l) => l.name)), ['V1', 'A1', 'R1', 'R2', 'R3']);
  h.folder.events.forEach((event, i) => {
    assert.equal(event, before.events[i]);
    assert.equal(event.id, eventPayload[i].id); assert.equal(event.frame, eventPayload[i].frame);
    assert.equal(event.laneId, eventPayload[i].laneId); assert.equal(event.recMeta, eventPayload[i].recMeta);
    assert.equal(event.lane, h.folder.lanes.find((l) => l.id === event.laneId).name);
  });
  assert.equal(h.run('state.sel'), before.events[0]); assert.equal(h.run('state.multiSel.has(state.sel)'), true);
  assert.equal(h.run('state.recLaneId'), 'r2'); assert.equal(JSON.stringify(h.ctx.other), before.other);
  assert.equal(h.counts.history, 2); assert.equal(h.counts.saves, 1); assert.equal(h.counts.refresh, 1);
  assert.equal(h.ctx.recMoveLaneById('r3', 1), true);
});

test('lane reorder refuses locked source/destination/crossed rows and invalid moves without history', () => {
  const h = harness(); laneFixture(h); h.folder.lanes[3].locked = true;
  const before = JSON.stringify(h.folder);
  for (const [id, target] of [['r1', 'r3'], ['r2', -1], ['r1', 1], ['r1', -1], ['v', 'r1'], ['gone', 1], ['r1', 'r1']]) {
    assert.equal(h.ctx.recMoveLaneById(id, target), false);
  }
  assert.equal(JSON.stringify(h.folder), before);
  assert.deepEqual(h.counts, { history: 0, saves: 0, refresh: 0 });
});

test('lane controls mount drag handles, keyboard and button routes into actual reorder helper', () => {
  const h = harness(); laneFixture(h); h.ctx.renderRecLaneOrder();
  const panel = h.elements.get('recLaneOrder');
  assert.equal(panel.children.length, 3); assert.equal(panel.hidden, false);
  const handle = panel.children[0].children[0]; assert.equal(handle.draggable, true);
  let prevented = 0, stopped = 0;
  handle.listeners.keydown({ key: 'ArrowDown', preventDefault: () => prevented++, stopPropagation: () => stopped++ });
  assert.deepEqual(plain(h.folder.lanes.map((l) => l.id)), ['v', 'a', 'r2', 'r1', 'r3']);
  assert.equal(prevented, 1); assert.equal(stopped, 1);
  h.ctx.renderRecLaneOrder();
  const sourceHandle = panel.children[0].children[0], targetRow = panel.children[2];
  sourceHandle.listeners.dragstart({ dataTransfer: { setData() {} } });
  targetRow.listeners.drop({ preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(plain(h.folder.lanes.map((l) => l.id)), ['v', 'a', 'r1', 'r3', 'r2']);
});

let passed = 0;
for (const { name, fn } of tests) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (error) { console.error('FAIL ' + name + '\n' + error.stack); process.exitCode = 1; }
}
console.log(`Project recording schema: ${passed} passed, ${tests.length - passed} failed`);
