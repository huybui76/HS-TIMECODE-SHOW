#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CFG = require('../realtime-config');
const REC = require('../renderer/rec-engine');
const CueLayout = require('../renderer/cue-layout');
const RecordingSession = require('../recording-session');
const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');

function production(name) {
  const match = source.match(new RegExp('^(?:async )?function ' + name + '\\([^]*?^}', 'm'));
  assert.ok(match, 'Missing production function ' + name);
  return match[0];
}

function harness() {
  let now = 1000, sequence = 10;
  const posts = [], statuses = [], sent = [], monitors = [], learned = [], timers = [], saves = [];
  const elements = new Map();
  const folder = { id: 1, offset: 0, cues: [], events: [], lanes: [{ id: 1, name: 'R1', kind: 'R' }], audioClips: [] };
  // Faithful utility mock: osc-ingest answers each recStart exactly once, synchronously —
  // recordStarted, unless a recordRejected for that session was already delivered.
  const pendingStarts = [];
  const oscPortMock = { post: (m) => {
    posts.push(m);
    if (m && m.type === 'recStart' && m.session != null) pendingStarts.push(m.session);
  }, onMessage() {}, close() {} };
  const ctx = vm.createContext({ console, structuredClone, Uint8Array, REC_CFG: { ...CFG, ...REC.DEFAULTS }, rxLocal: 0,
    performance: { timeOrigin: 1700000000000, now: () => now },
    window: { HSRealtime: CFG, HSREC: REC, HSCueLayout: CueLayout, __oscListening: true,
      hs: { setOscFloatAddresses: () => Promise.resolve(), onStatus: (fn) => { ctx.oscStatus = fn; } } },
    laneAlloc: new REC.LaneAllocator(),
    nid: () => ++sequence,
    $: (id) => {
      if (!elements.has(id)) elements.set(id, { textContent: '', style: {},
        classList: { toggle() {} }, appendChild() {} });
      return elements.get(id);
    },
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.cancelled = true; },
    localStorage: { setItem: (...args) => saves.push(args) }, AUTOSAVE_KEY: 'test',
    captureActiveProject() {},
    setStatus: (text) => statuses.push(text), flashStatus: (text) => statuses.push(text),
    sendOsc: (...args) => sent.push(args), monPushMidi: (item) => monitors.push(item),
    midiPadLearn: (...args) => learned.push(args),
    oscFeed: { ingest() {}, panelVisible: false, testVisible: false },
    recDebug() {}, renderProps() {}, renderFolders() {}, updateSelBar() {}, updateOscMetrics() {},
    syncOscFloatAddresses() {}, updateTransport() {},
    renderLanes() {}, fillRecFolderSel() {}, refreshVF() {}, rebuildFlat() {},
    updateStatsBar() {}, tcString: () => '',
    audio: { paused: true, pause() { this.paused = true; } },
    clock: { valid: true }, clockReset() {}, oscTimelineFrame: () => 100,
    findClipAtFrame: () => null, lowerBoundFlat: () => 0, audioClipId: null,
    playbackEndFrames: () => Infinity, preview: { audio: { paused: true } },
    lanControl() {}, previewSetState() {},
    // Playback dispatch has its own production bridge suite; isolate its boundary here.
    playback: { seek() {}, stop() {} }, playbackLastFrame: null,
    refreshPlaybackSchedule() {}, playbackPosition: () => 100,
    port: oscPortMock
  });
  vm.runInContext(source.match(/^const state = \{[^]*?^};/m)[0], ctx);
  vm.runInContext(source.slice(source.indexOf('const midiMap = new Map();'), source.indexOf('function syncOscFloatAddresses()')), ctx);
  vm.runInContext(source.match(/^const MIDI = \{[^]*?^};/m)[0], ctx);
  vm.runInContext('const undoStack = [], redoStack = []; let lastSnap = null, restoringHistory = false, autosaveTimer = null; const REC_UI_FLUSH_MS = 80; let oscRecDirty = false, oscRecFlushTimer = null, oscRecLastStatus = 0; let statusTimer = null;', ctx);
  for (const name of ['curFolder', 'recLane', 'laneById', 'makeDef', 'makePlacement', 'insertCue',
    'projectEncode', 'projectDecode', 'projectOscArgs', 'serializeProject',
    'snapshot', 'applySnapshot', 'noteChange', 'undo', 'redo', 'refreshAll', 'scheduleAutosave',
    'recStartTransaction', 'recStopTransaction', 'recFinishTransaction', 'recInterrupt', 'recReceiveActions',
    'recReceiveMapping',
    'pushOscMode', 'handleOscProcMessage', 'attachOscPort', 'onOscMessage', 'flushOscRecUi',
    'recFinalizeOpen', 'recCreateLiveCue', 'recFinalizeCue', 'recLaneByName', 'recMapKey', 'recCueName',
    'recLayoutCue', 'recNormalizeLanes', 'recSyncLaneGroups',
    'noteName', 'midiNoteKey', 'padAddr', 'recSendMidi', 'midiNoteOn', 'midiNoteOff', 'midiCC',
    'midiDisconnect', 'onMidiMessage', 'recAssignOsc', 'play', 'pause', 'setFrame', 'toggleRec',
    'migrateFolder', 'migrateAudioClips']) vm.runInContext(production(name), ctx);
  const run = (code) => vm.runInContext(code, ctx);
  run(source.match(/^window\.hs\.onStatus\(\(s\) => \{[^]*?^}\);/m)[0]);
  ctx.folder = folder;
  run('state.folders = [folder]; state.activeFolderId = 1; state.lanes = folder.lanes; state.audioClips = []; state.recLaneId = 1; state.frame = 100; oscPort = port; lastSnap = snapshot();');
  const flushUtilityReplies = () => {
    for (const session of pendingStarts.splice(0)) {
      if (!posts.some((m) => m.type === 'recordRejected' && m.session === session)) {
        ctx.handleOscProcMessage({ type: 'recordStarted', session }, oscPortMock);
      }
    }
  };
  const start = () => { ctx.toggleRec(); ctx.play(); flushUtilityReplies(); return run('recActiveSession'); };
  const action = (extra = {}) => ({ kind: 'trigger', source: 'note', num: 60, ch: 1, vel: 100,
    startFrame: 105, durationFrames: 30, startMs: 1700000001100, endMs: 1700000001200,
    holdMs: 100, matched: true, guessed: false, unassigned: false, address: '/real', args: [1, 'all', [2]], ...extra });
  const receive = (session, items) => ctx.handleOscProcMessage({ type: 'recordActions', session, batchId: 1, items });
  const drained = (session) => ctx.handleOscProcMessage({ type: 'recordDrained', session });
  return { ctx, run, folder, posts, statuses, sent, monitors, learned, timers, saves, start, action, receive, drained,
    now: (value) => { now = value; } };
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('arm stopped does not start recording; Play sends one frozen recStart', () => {
  const h = harness(); h.ctx.toggleRec();
  assert.equal(h.posts.filter((m) => m.type === 'recStart').length, 0);
  h.ctx.play(); h.ctx.pushOscMode();
  const starts = h.posts.filter((m) => m.type === 'recStart');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].anchorEpoch, 1700000001000);
  assert.equal(starts[0].anchorFrame, 100);
  assert.equal(starts[0].fps, 30);
});

test('raw and UI batches never create cues; raw learns and ACKs', () => {
  const h = harness(); const session = h.start(); h.run("state.midiPadMode = 'learn';");
  h.ctx.handleOscProcMessage({ type: 'eventBatch', id: 7, items: [{ session, record: true, address: '/real', args: [1] }] });
  h.ctx.handleOscProcMessage({ type: 'uiBatch', items: [{ address: '/real', args: [1], ts: 1700000001000 }] });
  assert.equal(h.folder.events.length, 0);
  assert.equal(h.learned.length, 1);
  assert.deepEqual(h.posts.slice(-2).map((m) => m.type), ['eventAck', 'uiAck']);
  assert.doesNotMatch(source, /recEngine\.(pushOsc|tick|noteOn|noteOff|cc|finalizeAll)/);
});

test('WebMIDI timestamp and device forwarded once per message without provisional cues', () => {
  const h = harness(); h.start();
  for (const data of [[0x90, 60, 100], [0x80, 60, 0], [0xb0, 7, 90]]) {
    h.ctx.onMidiMessage({ data, timeStamp: 1234, target: { id: 'keyboard' } });
  }
  const events = h.posts.filter((m) => m.type === 'recMidi').map((m) => m.event);
  assert.deepEqual(events.map((e) => e.kind), ['noteOn', 'noteOff', 'cc']);
  assert.ok(events.every((e) => e.t === 1700000001234 && e.device === 'keyboard'));
  assert.equal(h.folder.events.length, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.monitors.length, 2);
});

test('Bounce uses actual/manual mapping only and honors user switch', () => {
  const h = harness();
  h.ctx.midiNoteOn(60, 1, 100); h.ctx.midiNoteOff(60, 1);
  assert.equal(h.sent.length, 0);
  h.run("midiMap.set('n60c1', { address: '/mapped' });");
  h.ctx.midiNoteOn(60, 1, 100); h.ctx.midiNoteOff(60, 1);
  assert.deepEqual(h.sent.map((m) => m[0]), ['/mapped', '/mapped']);
  h.run('state.midiBounce = false;'); h.ctx.midiNoteOn(60, 1, 100);
  assert.equal(h.sent.length, 2);
});

test('stop sends old session cutoff before off; drain blocks Play/REC and commits once', () => {
  const h = harness(); const session = h.start(); h.now(1500); h.ctx.pause(true);
  const stopIndex = h.posts.findIndex((m) => m.type === 'recStop');
  assert.equal(h.posts[stopIndex].session, session);
  assert.equal(h.posts[stopIndex].cutoff, 1700000001500);
  assert.ok(h.posts.slice(stopIndex + 1).some((m) => m.type === 'recording' && !m.on));
  h.ctx.play(); h.ctx.toggleRec();
  assert.equal(h.run('state.playing'), false);
  assert.equal(h.run('state.recArmed'), true);
  assert.equal(h.run('undoStack.length'), 0);
  h.receive(session, [h.action()]); h.drained(session); h.drained(session);
  assert.equal(h.folder.events.length, 1);
  assert.equal(h.run('undoStack.length'), 1);
  h.ctx.play(); assert.notEqual(h.run('recActiveSession'), session);
});

test('late actions route to frozen folder, offset, SMPTE and unique definitions', () => {
  const h = harness(); h.run('state.recSmpteInput = true; folder.offset = 10;'); const session = h.start();
  h.ctx.pause(true);
  h.run('state.folders.push({ id: 2, offset: 0, events: [], cues: [], lanes: [] }); state.activeFolderId = 2; state.lanes = []; state.fps = 60; state.recSmpteInput = false; folder.offset = 20;');
  h.receive(session, [h.action({ args: [1] }), h.action({ args: [0] })]);
  assert.equal(h.folder.cues.length, 2);
  assert.notEqual(h.folder.events[0].cueId, h.folder.events[1].cueId);
  assert.deepEqual(h.folder.cues.map((d) => Array.from(d.args)), [[1], [0]]);
  assert.equal(h.folder.events[0].frame, 95);
  assert.equal(h.folder.events[0].smpteInput, true);
  assert.equal(h.run('state.folders[1].events.length'), 0);
  assert.equal(h.run('state.lanes.length'), 0);
});

test('descriptor flags and real args preserved; no renderer fallback or guessed mapping writes', () => {
  const h = harness(); const session = h.start();
  h.run("midiMap.set('n60c1', { address: '/existing' });");
  h.receive(session, [h.action({ address: '', args: [], matched: false, unassigned: true }),
    h.action({ address: '/guess', guessed: true, matched: false })]);
  assert.equal(h.folder.cues[0].address, '');
  assert.equal(h.folder.events[0].recMeta.unassigned, true);
  assert.equal(h.folder.events[1].recMeta.matched, false);
  assert.equal(h.folder.events[1].recMeta.guessed, true);
  assert.equal(h.run("midiMap.get('n60c1').address"), '/existing');
});

test('recordActions ACK even invalid session, malformed batch or consumer error', () => {
  const h = harness();
  h.receive(-1, []); h.receive(-1, null);
  h.run('recReceiveActions = () => { throw new Error("consumer"); };');
  assert.throws(() => h.receive(1, []), /consumer/);
  assert.equal(h.posts.filter((m) => m.type === 'recordAck').length, 3);
});

test('timeout aborts utility before unlocking, keeps partial cues and rejects later actions', () => {
  const h = harness(); const session = h.start(); h.receive(session, [h.action()]); h.ctx.pause(true);
  const timer = h.timers.find((item) => item.ms === CFG.REC_DRAIN_TIMEOUT_MS);
  assert.ok(timer);
  const post = h.ctx.port.post;
  h.ctx.port.post = (message) => {
    if (message.type === 'recAbort') {
      assert.equal(message.session, session);
      assert.equal(h.run('recTransactions.size'), 1);
      h.ctx.play();
      assert.equal(h.run('state.playing'), false);
    }
    post(message);
  };
  timer.fn();
  assert.equal(h.run('recTransactions.size'), 0);
  assert.equal(h.run('undoStack.length'), 1);
  assert.match(h.statuses.at(-1), /Hết thời gian/);
  h.receive(session, [h.action()]); assert.equal(h.folder.events.length, 1);
  h.ctx.play();
  const abort = h.posts.findIndex((message) => message.type === 'recAbort');
  const next = h.posts.findIndex((message) => message.type === 'recStart' && message.session !== session);
  assert.ok(abort >= 0 && next > abort);
});

test('failed timeout abort disarms and preserves partial recording instead of opening another session', () => {
  const h = harness(); const session = h.start(); h.receive(session, [h.action()]); h.ctx.pause(true);
  h.ctx.port.post = () => { throw new Error('closed'); };
  h.timers.find((timer) => timer.ms === CFG.REC_DRAIN_TIMEOUT_MS).fn();
  assert.equal(h.run('state.recArmed'), false);
  assert.equal(h.run('recTransactions.size'), 0);
  assert.equal(h.folder.events.length, 1);
  assert.equal(h.run('undoStack.length'), 1);
});

test('restart finalizes partial transaction and never replays recStart', () => {
  const h = harness(); const session = h.start(); h.receive(session, [h.action()]);
  h.ctx.handleOscProcMessage({ type: 'restarting' }); h.ctx.attachOscPort(h.ctx.port);
  assert.equal(h.posts.filter((m) => m.type === 'recStart').length, 1);
  assert.equal(h.run('state.recArmed'), false);
  assert.equal(h.run('recTransactions.size'), 0);
  assert.equal(h.folder.events.length, 1);
  assert.ok(h.statuses.some((text) => /không tự khôi phục/.test(text)));
});

test('seek closes session, pauses timeline and requires explicit post-drain Play', () => {
  const h = harness(); const session = h.start(); h.ctx.setFrame(500);
  assert.equal(h.run('state.frame'), 500);
  assert.equal(h.run('state.playing'), false);
  assert.equal(h.posts.filter((m) => m.type === 'recStop').length, 1);
  h.ctx.play(); assert.equal(h.run('state.playing'), false);
  h.drained(session); h.ctx.play();
  assert.equal(h.posts.filter((m) => m.type === 'recStart').length, 2);
});

test('history includes mappings/groups, restores without extra entries; armed undo refused', () => {
  const h = harness(); const session = h.start();
  h.ctx.undo(); assert.equal(h.run('recTransactions.size'), 1);
  h.receive(session, [h.action()]);
  h.ctx.handleOscProcMessage({ type: 'recordMapping', session, key: 'n60c1', mapping: { address: '/real', kind: 'trigger' } });
  h.ctx.pause(true); h.drained(session); h.ctx.toggleRec(); h.ctx.undo();
  assert.equal(h.folder.events.length, 1); // old object is detached after restoring history
  assert.equal(h.run('state.folders[0].events.length'), 0);
  assert.equal(h.run('midiMap.size'), 0);
  assert.equal(h.run('undoStack.length'), 0);
  assert.equal(h.run('redoStack.length'), 1);
  h.ctx.redo();
  assert.equal(h.run('state.folders[0].events.length'), 1);
  assert.equal(h.run("midiMap.get('n60c1').address"), '/real');
});

test('manual assignment clears unassigned/guessed, persists mapping and respects edited names', () => {
  const h = harness(); const session = h.start(); h.receive(session, [h.action({ address: '', unassigned: true, matched: false })]);
  const cue = h.folder.events[0], def = h.folder.cues[0]; def.name = 'Custom'; def.nameEdited = true;
  h.ctx.recAssignOsc(cue, '/assigned', [0.7, 'actual']);
  assert.equal(def.name, 'Custom'); assert.equal(def.address, '/assigned');
  assert.equal(cue.recMeta.unassigned, false); assert.equal(cue.recMeta.guessed, false);
  assert.equal(h.run("midiMap.get('n60c1').address"), '/assigned');
  assert.match(source, /d\.nameEdited = true/);
});

test('disconnect synthesizes noteOff only for held device, never opens another input', () => {
  const h = harness(); h.start();
  h.ctx.midiNoteOn(60, 1, 100, 1000, 'one'); h.ctx.midiNoteOn(61, 1, 100, 1000, 'two');
  h.ctx.midiDisconnect('one');
  const offs = h.posts.filter((m) => m.type === 'recMidi' && m.event.kind === 'noteOff');
  assert.equal(offs.length, 1); assert.equal(offs[0].event.device, 'one');
  assert.equal(h.run('MIDI.notes.size'), 1);
});

test('physical MIDI owns active recording: no mapped Bounce or playback echo tokens', () => {
  const h = harness(); h.start();
  h.receive(h.run('recActiveSession'), [h.action()]);
  h.run("midiMap.set('n60c1', { address: '/mapped' });"); h.ctx.midiNoteOn(60, 1, 100);
  h.ctx.midiNoteOff(60, 1);
  assert.equal(h.sent.length, 0);
  assert.equal(h.posts.filter((m) => m.type === 'recTx').length, 0);
});

test('duplicate action ids dedupe while repeats with different ids retain one-second descriptor lengths', () => {
  const h = harness(); const session = h.start();
  const item = h.action({ actionId: 1 });
  h.receive(session, [item, item, h.action({ actionId: 2, args: [0] })]);
  assert.equal(h.folder.events.length, 2);
  assert.ok(h.folder.events.every((cue) => cue.duration === 30));
  assert.equal(h.folder.events[0].recMeta.actionId, 1);
});

test('final actions use conventional names and group different clips on their shared layer lane', () => {
  const h = harness(); const session = h.start();
  h.receive(session, [h.action({ address: '/composition/layers/3/clips/7/connect' }),
    h.action({ address: '/composition/layers/3/clips/8/connect' })]);
  assert.deepEqual(h.folder.cues.map((def) => def.name), ['Layer3\u00b7Column7\u00b7Clip7', 'Layer3\u00b7Column8\u00b7Clip8']);
  const [first, second] = h.folder.events;
  assert.equal(first.lane, second.lane);
  assert.equal(first.recGroup, 'layer:3/clips');
  const lane = h.folder.lanes.find((item) => item.name === first.lane);
  assert.equal(lane.groupLabel, 'Layer3\u00b7Clips');
  assert.equal(h.folder.cues[0].color, lane.color);
  assert.equal(h.folder.cues[1].color, lane.color);
  assert.ok(CueLayout.PALETTE.includes(lane.color));
});

test('unassigned MIDI name and lane remap preserve cue identity and edited names', () => {
  const h = harness(); const session = h.start();
  h.receive(session, [h.action({ num: 27, address: '', unassigned: true, matched: false })]);
  const cue = h.folder.events[0], def = h.folder.cues[0];
  assert.equal(def.name, 'MIDI D#1(27) \u00b7ch1');
  assert.equal(cue.recGroup, 'midi:["",1,"note",27]');
  const id = cue.id;
  h.ctx.recAssignOsc(cue, '/composition/layers/3/clips/7/connect', [1]);
  assert.equal(cue.id, id);
  assert.equal(def.name, 'Layer3\u00b7Column7\u00b7Clip7');
  assert.equal(cue.recGroup, 'layer:3/clips');
  assert.equal(cue.recMeta.unassigned, false);
  assert.ok(!h.folder.lanes.some((lane) => lane.recGroup === 'midi:["",1,"note",27]'));
});

test('migration retains edited name, source, mapping status and actual curve origin', () => {
  const h = harness(); const session = h.start();
  h.receive(session, [h.action({ actionId: 3, kind: 'float', source: 'midi', dataOrigin: 'osc',
    mappingStatus: 'manual', device: 'keys', keyframes: [{ dt: 0, value: 0.1 }, { dt: 30, value: 0.7 }] })]);
  h.folder.cues[0].nameEdited = true;
  h.ctx.freshProjectData = () => ({ lanes: [], audioClips: [] });
  const restored = h.ctx.migrateFolder(JSON.parse(JSON.stringify(h.folder)), null, [], null);
  assert.equal(restored.cues[0].nameEdited, true);
  assert.equal(restored.events[0].recMeta.dataOrigin, 'osc');
  assert.equal(restored.events[0].recMeta.source, 'midi');
  assert.equal(restored.events[0].recMeta.mappingStatus, 'manual');
  assert.equal(restored.events[0].recMeta.actionId, 3);
});

test('old source port cannot mutate or drain a transaction after replacement', () => {
  const h = harness(); const session = h.start();
  const oldPort = h.ctx.port;
  h.ctx.attachOscPort({ post: (message) => h.posts.push(message), onMessage() {}, close() {} });
  h.ctx.handleOscProcMessage({ type: 'recordActions', session, items: [h.action()] }, oldPort);
  assert.equal(h.run('recTransactions.size'), 0);
  assert.equal(h.run('state.recArmed'), false);
  assert.equal(h.folder.events.length, 0);
});

test('autosave is postponed until drained, including a pre-existing timer', () => {
  const h = harness(); h.ctx.scheduleAutosave(); const pending = h.timers.at(-1);
  const session = h.start(); pending.fn(); assert.equal(h.saves.length, 0);
  h.receive(session, [h.action()]); h.ctx.pause(true); h.drained(session);
  const save = h.timers.at(-1); assert.equal(save.ms, 800); save.fn();
  assert.equal(h.saves.length, 1);
});

test('REC Play without a utility connection stays stopped instead of creating a silent gap', () => {
  const h = harness(); h.run('oscPort = null;'); h.ctx.toggleRec(); h.ctx.play();
  assert.equal(h.run('state.playing'), false);
  assert.equal(h.run('recActiveSession'), null);
  assert.ok(h.statuses.some((text) => /chưa có kết nối/.test(text)));
});

test('existing port without a ready UDP listener never starts REC or auto-starts on readiness', () => {
  for (const listening of [false, undefined, 1]) {
    const h = harness(); h.ctx.window.__oscListening = listening;
    h.ctx.toggleRec(); h.ctx.play();
    assert.equal(h.run('state.playing'), false);
    assert.equal(h.run('recActiveSession'), null);
    assert.equal(h.posts.filter((message) => message.type === 'recStart').length, 0);
    h.ctx.handleOscProcMessage({ type: 'ready' });
    assert.equal(h.run('recActiveSession'), null);
    assert.equal(h.run('state.playing'), false);
    h.ctx.play(); assert.notEqual(h.run('recActiveSession'), null);
  }
});

test('main status listener aborts closed utility session before finalizing and gates rearm', () => {
  const h = harness(); const session = h.start(); h.receive(session, [h.action()]);
  const post = h.ctx.port.post;
  h.ctx.port.post = (message) => {
    if (message.type === 'recAbort') {
      assert.equal(message.session, session);
      assert.equal(h.run('recTransactions.size'), 1);
    }
    post(message);
  };
  h.ctx.oscStatus({ listening: false, port: 7000 });
  assert.equal(h.ctx.window.__oscListening, false);
  assert.equal(h.run('state.playing'), true);
  assert.equal(h.run('state.recArmed'), false);
  assert.equal(h.run('recTransactions.size'), 0);
  assert.equal(h.folder.events.length, 1);
  assert.equal(h.run('undoStack.length'), 1);
  h.ctx.toggleRec();
  assert.equal(h.run('recActiveSession'), null);
  h.ctx.oscStatus({ listening: true, port: 7000 });
  assert.equal(h.run('recActiveSession'), null);
  h.ctx.play();
  assert.equal(h.posts.filter((message) => message.type === 'recStart').length, 2);
});

test('port replacement abort goes only to old utility port; failed abort still retains partial cues', () => {
  for (const fail of [false, true]) {
    const h = harness(); const session = h.start(); h.receive(session, [h.action()]);
    const replacement = [], original = h.ctx.port.post;
    h.ctx.port.post = (message) => {
      original(message);
      if (fail && message.type === 'recAbort') throw new Error('closed old port');
    };
    h.ctx.attachOscPort({ post: (message) => replacement.push(message), onMessage() {}, close() {} });
    assert.equal(h.posts.filter((message) => message.type === 'recAbort' && message.session === session).length, 1);
    assert.equal(replacement.filter((message) => message.type === 'recAbort' || message.type === 'recStart').length, 0);
    assert.equal(h.run('state.recArmed'), false);
    assert.equal(h.run('recTransactions.size'), 0);
    assert.equal(h.folder.events.length, 1);
  }
});

test('recordRejected closes only matching transaction, disarms and keeps received cues', () => {
  const h = harness(); const session = h.start(); h.receive(session, [h.action()]);
  h.ctx.handleOscProcMessage({ type: 'recordRejected', session: -1, text: 'stale' });
  assert.equal(h.run('recActiveSession'), session);
  h.ctx.handleOscProcMessage({ type: 'recordWarning', session, text: 'ordinary warning' });
  assert.equal(h.run('recActiveSession'), session);
  h.ctx.handleOscProcMessage({ type: 'recordRejected', session, text: 'previous session not drained' });
  assert.equal(h.run('recActiveSession'), null);
  assert.equal(h.run('state.recArmed'), false);
  assert.equal(h.run('state.playing'), true);
  assert.equal(h.folder.events.length, 1);
  assert.equal(h.run('undoStack.length'), 1);
  assert.ok(h.posts.some((message) => message.type === 'recAbort' && message.session === session));
  assert.match(h.statuses.at(-1), /previous session not drained/);
});

test('synchronous utility rejection cannot leave a falsely active session or overwrite project data', () => {
  const h = harness(); h.run("state.recMode = 'overwrite';");
  h.folder.events.push({ id: 99, cueId: 99, frame: 200, lane: 'R1' });
  const post = h.ctx.port.post;
  h.ctx.port.post = (message) => {
    post(message);
    if (message.type === 'recStart') h.ctx.handleOscProcMessage({ type: 'recordRejected', session: message.session, text: 'not listening' });
  };
  h.start();
  assert.equal(h.run('state.recArmed'), false);
  assert.equal(h.run('state.playing'), false);
  assert.equal(h.run('recTransactions.size'), 0);
  assert.equal(h.folder.events.length, 1);
});

test('one physical MIDI feedback produces exactly one action without app Bounce during REC', () => {
  const h = harness(); const session = h.start(), items = [];
  const address = '/composition/layers/1/clips/2/connect';
  h.run("midiMap.set('keys|n60c1', { address: '/composition/layers/1/clips/2/connect', kind: 'trigger', args: [1] });");
  const recorder = new RecordingSession({ emit: (item) => items.push(item) });
  recorder.start(h.posts.find((message) => message.type === 'recStart'));
  h.ctx.midiNoteOn(60, 1, 100, 1100, 'keys');
  recorder.midi(h.posts.filter((message) => message.type === 'recMidi').at(-1).event);
  recorder.ingestOsc({ address, args: [1], t: 1700000001110 });
  h.ctx.midiNoteOff(60, 1, 1200, 'keys');
  recorder.midi(h.posts.filter((message) => message.type === 'recMidi').at(-1).event);
  assert.equal(h.sent.length, 0);
  h.now(1300); h.ctx.pause(true); recorder.finish(1700000001300); recorder.tick(1700000005000);
  assert.equal(items.length, 1); assert.equal(items[0].matched, true);
  h.receive(session, items); h.drained(session);
  assert.equal(h.folder.events.length, 1);
  h.ctx.midiNoteOn(60, 1, 100, undefined, 'keys'); h.ctx.midiNoteOff(60, 1, undefined, 'keys');
  assert.deepEqual(h.sent.map((send) => [send[0], send[1][0]]), [[address, 1], [address, 0]]);
});

test('actual captured Float endpoint flag persists with edit guards and full OSC payloads', () => {
  const h = harness(); const session = h.start();
  const args = [0.2, 'Tiếng Việt', [null, true], new Uint8Array([0, 127, 255])];
  h.receive(session, [h.action({ kind: 'float', source: 'midi', dataOrigin: 'osc', args,
    keyframes: [{ dt: 0, value: 0.2, args }, { dt: 180, value: 0.8, args: [0.8, ...args.slice(1)] }],
    extras: [{ address: '/extra', args, t: 1700000001100, seq: 5, release: true }] }),
  h.action({ kind: 'float', source: 'osc', dataOrigin: 'osc', matched: false }),
  h.action({ kind: 'float', dataOrigin: 'midi', guessed: true, matched: false }),
  h.action({ kind: 'float', dataOrigin: 'osc', guessed: true, matched: false }),
  h.action({ kind: 'trigger', dataOrigin: 'osc' })]);
  assert.deepEqual(h.folder.events.map((cue) => cue.recMeta.captureEndpoint), [true, true, false, false, false]);
  Object.assign(h.folder.events[0].recMeta, { curveEdited: false, trimmed: false });
  Object.assign(h.folder.events[1].recMeta, { captureEndpoint: false, curveEdited: true, trimmed: true });
  const before = h.ctx.snapshot();
  h.ctx.applySnapshot(before);
  const restored = h.run('state.folders[0]');
  assert.ok(restored.cues[0].args[3] instanceof Uint8Array);
  assert.deepEqual(Array.from(restored.events[0].recMeta.keyframes[0].args[3]), [0, 127, 255]);
  h.ctx.freshProjectData = () => ({ lanes: [], audioClips: [] });
  const saved = JSON.parse(JSON.stringify(h.ctx.serializeProject()));
  const migrated = h.ctx.migrateFolder(saved.folders[0], null, [], null);
  assert.equal(migrated.events[0].recMeta.captureEndpoint, true);
  assert.equal(migrated.events[0].recMeta.curveEdited, false);
  assert.equal(migrated.events[1].recMeta.captureEndpoint, false);
  assert.equal(migrated.events[1].recMeta.trimmed, true);
  assert.equal(migrated.events[1].recMeta.curveEdited, true);
  assert.deepEqual(Array.from(migrated.cues[0].args[3]), [0, 127, 255]);
  assert.deepEqual(Array.from(migrated.events[0].recMeta.extras[0].args[3]), [0, 127, 255]);
  assert.equal(migrated.events[0].recMeta.extras[0].release, true);
});

test('real utility descriptors roundtrip through renderer with full args and device mapping', () => {
  const h = harness(); const session = h.start(); const descriptors = [], mappings = [];
  const recorder = new RecordingSession({ emit: (item) => descriptors.push(item),
    onMapping: (key, mapping) => mappings.push({ key, mapping }) });
  recorder.start(h.posts.find((m) => m.type === 'recStart'));
  h.ctx.onMidiMessage({ data: [0x90, 60, 100], timeStamp: 1100, target: { id: 'keys' } });
  recorder.midi(h.posts.filter((m) => m.type === 'recMidi').at(-1).event);
  recorder.ingestOsc({ address: '/composition/layers/1/clips/2/connect', args: [1, 'full', [2, 3]], t: 1700000001110 });
  h.ctx.onMidiMessage({ data: [0x80, 60, 0], timeStamp: 1200, target: { id: 'keys' } });
  recorder.midi(h.posts.filter((m) => m.type === 'recMidi').at(-1).event);
  h.now(1300); h.ctx.pause(true);
  recorder.finish(h.posts.find((m) => m.type === 'recStop').cutoff); recorder.tick(1700000005000);
  assert.ok(recorder.isDrained()); assert.equal(descriptors.length, 1);
  for (const mapping of mappings) h.ctx.handleOscProcMessage({ type: 'recordMapping', session, ...mapping });
  h.receive(session, descriptors); h.drained(session);
  assert.deepEqual(JSON.parse(JSON.stringify(h.folder.cues[0].args)), [1, 'full', [2, 3]]);
  assert.equal(h.folder.events[0].recMeta.source, 'midi');
  assert.equal(h.folder.events[0].recMeta.dataOrigin, 'osc');
  assert.equal(h.run("midiMap.get('keys|n60c1').address"), '/composition/layers/1/clips/2/connect');
});

for (const fps of [24, 25, 30, 60]) test('MIDI epoch delegates to utility frozen anchor at ' + fps + 'fps, not renderer arrival clock', () => {
  const h = harness(); h.run('state.fps = ' + fps + '; state.speed = 2;');
  const session = h.start(), items = [];
  const recorder = new RecordingSession({ config: { RECORD_LATENCY_COMPENSATION_MS: 50 }, emit: (item) => items.push(item) });
  recorder.start(h.posts.find((message) => message.type === 'recStart'));
  h.now(9000); h.run('state.frame = 99999; state.fps = 120; state.speed = 0.5;');
  h.ctx.onMidiMessage({ data: [0x90, 60, 100], timeStamp: 1550, target: { id: 'keys' } });
  recorder.midi(h.posts.filter((message) => message.type === 'recMidi').at(-1).event);
  recorder.ingestOsc({ address: '/composition/layers/1/clips/1/connect', args: [1], t: 1700000001560 });
  h.ctx.onMidiMessage({ data: [0x80, 60, 0], timeStamp: 1600, target: { id: 'keys' } });
  recorder.midi(h.posts.filter((message) => message.type === 'recMidi').at(-1).event);
  recorder.finish(1700000001700); recorder.tick(1700000005000);
  h.receive(session, items);
  assert.equal(items.length, 1);
  assert.equal(h.folder.events[0].frame, 100 + fps);
  assert.equal(h.folder.events[0].duration, fps);
  assert.equal(h.folder.events[0].recMeta.startMs, 1700000001550);
});

let failed = 0;
for (const { name, fn } of cases) {
  try { fn(); console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
}
console.log(`${cases.length - failed}/${cases.length} recording bridge tests passed`);
process.exitCode = failed ? 1 : 0;
