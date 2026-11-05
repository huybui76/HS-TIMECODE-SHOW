#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CFG = require('../realtime-config');
const REC = require('../renderer/rec-engine');
const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');

// Execute production functions, not a second implementation of the bridge.
function production(name) {
  const match = source.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'));
  assert.ok(match, 'Missing production function ' + name);
  return match[0];
}

function harness() {
  let now = 1000;
  const posts = [], ui = [], pushed = [], learned = [], feedback = [], whitelist = [], timers = [];
  const elements = new Map();
  const folder = { id: 1, offset: 0, events: [], cues: [] };
  const ctx = vm.createContext({
    console, REC_CFG: { ...REC.DEFAULTS },
    performance: { timeOrigin: 1700000000000, now: () => now },
    window: { hs: {
      oscUi: (msg) => ui.push(msg),
      setOscFloatAddresses: (list) => { whitelist.push(list); return Promise.resolve(); }
    } },
    $: (id) => {
      if (!elements.has(id)) elements.set(id, { textContent: '', title: '', style: {},
        classList: { toggle: (key, value) => { elements.get(id)[key] = value; } } });
      return elements.get(id);
    },
    recEngine: { pushOsc: (msg) => pushed.push(msg) },
    oscFeed: { ingest: (...args) => feedback.push(args), panelVisible: false, testVisible: false, flushAll() {} },
    midiPadLearn: (...args) => learned.push(args),
    curFolder: () => folder, recLane: () => null, passFilter: () => true,
    findOrMakeDef: (f, address, args) => {
      let def = f.cues.find((item) => item.address === address);
      if (!def) { def = { id: f.cues.length + 1, address, args }; f.cues.push(def); }
      return def;
    },
    makePlacement: (frame, cueId) => ({ frame, cueId }),
    insertCue: (f, cue) => f.events.push(cue),
    clock: { anchorMs: 1000, anchorFrame: 100, valid: true },
    clockReset: (frame) => { ctx.clock.anchorFrame = frame; ctx.clock.anchorMs = now; ctx.clock.valid = true; },
    findClipAtFrame: () => null, audio: { paused: true, pause() {} },
    audioSongId: null, audioClipId: null, lowerBoundFlat: () => 0,
    playbackEndFrames: () => Infinity, preview: { audio: { paused: true } },
    previewSetState() {}, updateTransport() {}, lanControl() {}, recFinalizeOpen() {},
    renderTestOscRows() {}, renderMidiAll() {}, renderMonitorAll() {}, applyMonFilter() {}, updateMonFooter() {},
    document: { querySelectorAll: () => [] }, MON: { src: 'osc' },
    setStatus() {}, refreshAll() {}, tcString: () => '', flashStatus() {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    rxLocal: 0, oscRecDirty: false, oscRecFlushTimer: null, REC_UI_FLUSH_MS: CFG.REC_UI_FLUSH_MS,
    flushOscRecUi() {},
    port: { post: (msg) => posts.push(msg), close() {}, onMessage(fn) { this.receive = fn; } }
  });
  vm.runInContext(source.match(/^const state = \{[^]*?^};/m)[0], ctx);
  vm.runInContext(source.slice(source.indexOf('const midiMap = new Map();'), source.indexOf('function syncOscFloatAddresses()')), ctx);
  for (const name of ['clockNow', 'oscTimelineFrame', 'syncOscFloatAddresses', 'pushOscMode',
    'onOscMessage', 'updateOscMetrics', 'handleOscProcMessage', 'attachOscPort',
    'oscProcMidiStart', 'oscProcMidiEnd', 'play', 'pause', 'setFrame',
    'openTestOsc', 'closeTestOsc', 'setMonSource']) vm.runInContext(production(name), ctx);
  const run = (code) => vm.runInContext(code, ctx);
  run('state.folders = [curFolder()]; state.frame = 100;');
  const start = () => run("state.recArmed = true; state.playing = true; state.recSource = 'osc'; pushOscMode();");
  const item = (extra = {}) => ({ address: '/composition/layers/1/clips/1/connect',
    args: [1, 'full', 3, 4, 5, 6], t: ctx.performance.timeOrigin + now,
    seq: 1, session: run('oscSession'), record: true, ...extra });
  return { ctx, run, start, item, folder, posts, ui, pushed, learned, feedback, whitelist, timers, elements,
    now: (value) => { now = value; } };
}

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

test('shared defaults preserve all config values and legacy aliases', () => {
  for (const [key, value] of Object.entries(CFG)) assert.deepEqual(REC.DEFAULTS[key], value);
  assert.equal(REC.DEFAULTS.MATCH_PRE_WINDOW_MS, CFG.MATCH_PRE_MS);
  assert.equal(REC.DEFAULTS.OSC_BUFFER_MAX, CFG.OSC_RING_CAPACITY);
  assert.equal(REC.DEFAULTS.RDP_EPSILON, CFG.FLOAT_RDP_EPSILON);
});

test('browser UMD reads shared config without require', () => {
  const browser = { HSRealtime: CFG };
  browser.self = browser;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/rec-engine.js'), 'utf8'), browser);
  assert.equal(browser.HSREC.DEFAULTS.MATCH_REPLY_TIMEOUT_MS, CFG.MATCH_REPLY_TIMEOUT_MS);
});

test('uiBatch preserves full args and never calls accepted-event handler', () => {
  const h = harness();
  h.start();
  h.run('onOscMessage = () => { throw new Error("UI must not record"); };');
  const args = [1, 2, 3, 4, 5, 'last'];
  h.ctx.handleOscProcMessage({ type: 'uiBatch', items: [{ address: '/a', args, ts: 1700000000123 }] });
  assert.deepEqual(h.feedback, [['/a', args, 123]]);
  assert.equal(h.pushed.length + h.learned.length + h.folder.events.length, 0);
});

test('eventBatch records ordered full args and ACKs once without feedback duplication', () => {
  const h = harness(); h.start();
  h.ctx.handleOscProcMessage({ type: 'eventBatch', id: 7, items: [h.item(), h.item({ seq: 2 })] }, h.ctx.port);
  assert.equal(h.pushed.length, 2);
  assert.deepEqual(h.pushed[0].args, h.item().args);
  assert.equal(h.pushed[0].t, 1000);
  assert.equal(h.folder.events.length, 2);
  assert.equal(h.feedback.length, 0);
  assert.equal(JSON.stringify(h.posts), JSON.stringify([{ type: 'eventAck', id: 7 }]));
});

test('malformed/empty eventBatch still ACKs', () => {
  const h = harness();
  h.ctx.handleOscProcMessage({ type: 'eventBatch', id: 8 }, h.ctx.port);
  h.ctx.handleOscProcMessage({ type: 'eventBatch', id: 9, items: [] }, h.ctx.port);
  assert.deepEqual(h.posts.map((msg) => msg.id), [8, 9]);
});

test('event handler errors still ACK the originating port', () => {
  const h = harness(); h.start();
  h.run('onOscMessage = () => { throw new Error("fixture failure"); };');
  const origin = [];
  assert.throws(() => h.ctx.handleOscProcMessage({ type: 'eventBatch', id: 10, items: [h.item()] },
    { post: (msg) => origin.push(msg) }), /fixture failure/);
  assert.equal(JSON.stringify(origin), JSON.stringify([{ type: 'eventAck', id: 10 }]));
});

test('10k accepted discrete events keep all placements but schedule one UI flush', () => {
  const h = harness(); h.start();
  const items = Array.from({ length: 10000 }, (_, seq) => h.item({ seq }));
  h.ctx.handleOscProcMessage({ type: 'eventBatch', id: 11, items }, h.ctx.port);
  assert.equal(h.folder.events.length, 10000);
  assert.equal(h.pushed.length, 10000);
  assert.equal(h.timers.length, 1);
  assert.equal(h.feedback.length, 0);
  assert.equal(h.posts.length, 1);
});

for (const fps of [24, 25, 30, 60]) test('ingress epoch sets frame at ' + fps + 'fps independent of arrival frame', () => {
  const h = harness(); h.run('state.fps = ' + fps + '; state.speed = 2; REC_CFG.RECORD_LATENCY_COMPENSATION_MS = 50;'); h.start();
  h.now(9000); h.run('state.frame = 99999;');
  h.ctx.onOscMessage(h.item({ t: 1700000001550 }));
  assert.equal(h.folder.events[0].frame, 100 + fps);
  assert.equal(h.pushed[0].t, 1550);
});

test('received frame clamps below zero', () => {
  const h = harness(); h.start();
  h.run('REC_CFG.RECORD_LATENCY_COMPENSATION_MS = 10000;');
  h.ctx.onOscMessage(h.item());
  assert.equal(h.folder.events[0].frame, 0);
});

test('recording requires armed + playing + producer record + current session', () => {
  const h = harness(); h.start();
  h.ctx.onOscMessage(h.item({ record: false }));
  h.ctx.onOscMessage(h.item({ session: -1 }));
  h.run('state.playing = false;'); h.ctx.onOscMessage(h.item());
  h.run('state.playing = true; state.recArmed = false;'); h.ctx.onOscMessage(h.item());
  assert.equal(h.folder.events.length, 0);
});

test('discrete connect/clear/playmode preserve repeats within one frame', () => {
  const h = harness(); h.start();
  for (const action of ['connect', 'clear', 'playmode']) {
    for (const value of [1, 0, 1]) h.ctx.onOscMessage(h.item({ address: '/composition/layers/1/' + action, args: [value] }));
  }
  assert.equal(h.folder.events.length, 9);
  assert.equal(h.run('oscRecSeen.size'), 0);
});

test('continuous values retain phase2 per-frame dedupe and full args', () => {
  const h = harness(); h.start();
  h.ctx.onOscMessage(h.item({ address: '/opacity' }));
  const args = [0.7, 2, 3, 4, 5, 6];
  h.ctx.onOscMessage(h.item({ address: '/opacity', args }));
  assert.equal(h.folder.events.length, 1);
  assert.deepEqual(Array.from(h.folder.cues[0].args), args);
});

test('accepted events learn only in current learn/capture mode', () => {
  const h = harness();
  h.ctx.onOscMessage(h.item({ record: false }));
  assert.equal(h.learned.length, 0);
  h.run("state.midiPadMode = 'learn';"); h.ctx.onOscMessage(h.item({ record: false }));
  h.run("state.midiPadMode = 'auto'; oscCaptureSeen = true;"); h.ctx.onOscMessage(h.item({ record: false }));
  assert.equal(h.learned.length, 2);
});

test('play/pause/seek fence generations and reject old queued events after resume', () => {
  const h = harness(); h.run("state.recArmed = true; state.recSource = 'osc';");
  h.ctx.play(); const old = h.item();
  h.ctx.pause(true); h.ctx.play();
  h.ctx.onOscMessage(old);
  assert.equal(h.pushed.length, 0);
  const beforeSeek = h.item();
  h.ctx.setFrame(500);
  h.ctx.onOscMessage(beforeSeek);
  h.ctx.onOscMessage(h.item());
  assert.equal(h.folder.events.length, 1);
  assert.equal(h.folder.events[0].frame, 500);
  assert.equal(h.run('oscAnchor.session'), h.run('oscSession'));
});

test('paused old-session eventBatch is ACKed without recording or learning', () => {
  const h = harness(); h.start(); const queued = h.item();
  h.run("state.midiPadMode = 'learn';"); h.ctx.pause(true);
  h.ctx.handleOscProcMessage({ type: 'eventBatch', id: 14, items: [queued] }, h.ctx.port);
  assert.equal(h.folder.events.length + h.pushed.length + h.learned.length, 0);
  assert.equal(h.posts.at(-1).id, 14);
});

test('record toggle while paused also advances generation', () => {
  const h = harness();
  const before = h.run('oscSession');
  h.run('state.recArmed = true; pushOscMode();');
  assert.ok(h.run('oscSession') > before);
  assert.equal(h.run('oscRecording'), false);
});

test('new anchor uses actual monotonic clock, not last rendered frame', () => {
  const h = harness(); h.run('state.playing = true; state.recArmed = true;'); h.now(1500);
  h.run('pushOscMode();');
  assert.equal(h.run('oscAnchor.frame'), 115);
  h.run('state.speed = 2; pushOscMode(true);');
  assert.equal(h.run('oscAnchor.epoch'), 1700000001500);
});

test('audio-clock anchor derives current audio position', () => {
  const h = harness();
  h.ctx.clock.valid = false; h.ctx.audio.paused = false; h.ctx.audio.currentTime = 12;
  h.ctx.findClipAtFrame = () => ({ tlStart: 20, srcStart: 10 });
  h.run('state.playing = true; state.recArmed = true; pushOscMode();');
  assert.equal(h.run('oscAnchor.frame'), 660);
});

test('port attach/replacement replays modes whitelist and UI without new generation', () => {
  const h = harness(); h.start();
  h.run("midiMap.set('cc1c1', { kind: 'float', address: '/opacity' });");
  h.ctx.attachOscPort(h.ctx.port);
  const session = h.run('oscSession');
  h.ctx.attachOscPort(h.ctx.port);
  assert.equal(h.run('oscSession'), session);
  assert.deepEqual(h.posts.filter((msg) => msg.type === 'recording').map((msg) => [msg.on, msg.session]), [[true, session], [true, session]]);
  assert.equal(h.whitelist.length, 2);
  assert.deepEqual(Array.from(h.whitelist[0]), ['/opacity']);
  assert.deepEqual(h.ui.filter((msg) => msg.type === 'captureSeen').map((msg) => msg.on), [false, false]);
});

test('attach while REC armed but stopped replays recording off and current learn/debug', () => {
  const h = harness(); h.run("state.recArmed = true; state.midiPadMode = 'learn'; state.recDebug = true;");
  h.ctx.attachOscPort(h.ctx.port);
  assert.equal(h.posts.find((msg) => msg.type === 'recording').on, false);
  assert.equal(h.posts.find((msg) => msg.type === 'learn').on, true);
  assert.equal(h.posts.find((msg) => msg.type === 'debug').on, true);
});

test('Monitor never enables capture; explicit modal capture survives attach and ends on close', () => {
  const h = harness(); h.ctx.setMonSource('osc');
  assert.equal(h.ui.some((msg) => msg.type === 'captureSeen' && msg.on), false);
  h.ctx.openTestOsc(); h.ctx.attachOscPort(h.ctx.port);
  assert.equal(h.run('oscCaptureSeen'), true);
  assert.equal(h.ui.filter((msg) => msg.type === 'captureSeen').at(-1).on, true);
  h.ctx.closeTestOsc();
  assert.equal(h.run('oscCaptureSeen'), false);
  assert.equal(h.ui.filter((msg) => msg.type === 'captureSeen').at(-1).on, false);
});

test('restart settles every MIDI match waiter with null', () => {
  const h = harness(); const results = [];
  h.ctx.resolveMatch = (value) => results.push(value);
  h.run('midiMatchWaiters.set(1, resolveMatch); midiMatchWaiters.set(2, resolveMatch);');
  h.ctx.handleOscProcMessage({ type: 'restarting' });
  assert.deepEqual(results, [null, null]);
  assert.equal(h.run('midiMatchWaiters.size'), 0);
});

test('MIDI end waiter exists before synchronous reply and uses configured timeout', async () => {
  const h = harness();
  h.ctx.port.post = (msg) => {
    if (msg.type === 'midiEnd') h.ctx.handleOscProcMessage({ type: 'matched', id: msg.id, address: '/a' });
  };
  h.ctx.attachOscPort(h.ctx.port);
  const result = await h.ctx.oscProcMidiEnd(12, 1700000001000);
  assert.equal(result.address, '/a');
  assert.equal(h.timers.at(-1).ms, CFG.MATCH_REPLY_TIMEOUT_MS);
  assert.equal(h.run('midiMatchWaiters.size'), 0);
});

test('parent stats route updates bounded queue/drop/latency/IPC/packet metrics', () => {
  const h = harness();
  assert.match(source, /window\.hs\.onOscProc\(handleOscProcMessage\)/);
  h.ctx.handleOscProcMessage({ type: 'stats', stats: { queueDepth: 123, droppedOverflow: 4,
    eventLoopP99Ms: 75.3, rendererMessagesPerSec: 67, datagramsPerSec: 10000 } });
  assert.equal(h.elements.get('omQueue').textContent, 123);
  assert.equal(h.elements.get('omDropped').warn, true);
  assert.equal(h.elements.get('omLoop').textContent, '75.3ms');
  assert.equal(h.elements.get('omLoop').warn, true);
  assert.equal(h.elements.get('omIpc').textContent, 67);
  assert.equal(h.elements.get('omPkt').textContent, 10000);
});

test('uiBatch ACKs once even when a feedback consumer throws', () => {
  const h = harness();
  const sent = [];
  h.ctx.oscFeed.ingest = () => { throw new Error('mock feedback failure'); };
  assert.throws(() => h.ctx.handleOscProcMessage({ type: 'uiBatch', items: [
    { address: '/test', args: [1], ts: 1000000 }
  ] }, { post: (m) => sent.push(m) }), /mock feedback failure/);
  assert.deepEqual(sent.map((m) => m.type), ['uiAck']);
});

test('save/load retains recording metadata, Float keyframes and lane group without aliasing', () => {
  const h = harness();
  Object.assign(h.ctx, { structuredClone, nid: () => 123, freshProjectData: () => ({}),
    captureActiveProject() {}, laneAlloc: { exportGroups: () => ({}) }, oscUI: { targets: [] } });
  h.run(production('migrateAudioClips')); h.run(production('migrateFolder')); h.run(production('serializeProject'));
  const meta = { kind: 'float', num: 7, ch: 1, vel: 127, holdMs: 500, score: 90, latencyMs: 15,
    matched: true, guessed: false, unassigned: false, keyframesRaw: 3, keyframesSent: 2,
    keyframes: [{ dt: 0, value: 0.2 }, { dt: 15, value: 0.7 }],
    extras: [{ address: '/extra', args: [1, [2, 3]], count: 2, dtMs: 10 }] };
  h.folder.cues.push({ id: 9, address: '/opacity', args: [0.7], mode: 'float' });
  h.folder.events.push({ id: 10, cueId: 9, frame: 100, recGroup: 'float|@/opacity', recMeta: meta });
  h.ctx.saved = JSON.parse(JSON.stringify(h.ctx.serializeProject()));
  h.run('loaded = migrateFolder(saved.folders[0], null, [], null);');
  const loaded = h.ctx.loaded;
  assert.equal(loaded.cues[0].mode, 'float');
  assert.equal(loaded.events[0].recGroup, 'float|@/opacity');
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.events[0].recMeta)), meta);
  loaded.events[0].recMeta.extras[0].args[1][0] = 99;
  assert.equal(h.ctx.saved.folders[0].events[0].recMeta.extras[0].args[1][0], 2);
});

test('metadata migration ignores invalid kinds and nonfinite keyframes', () => {
  const h = harness(); Object.assign(h.ctx, { structuredClone, nid: () => 1, freshProjectData: () => ({}) });
  h.run(production('migrateFolder'));
  const folder = { cues: [{ id: 1 }], events: [
    { cueId: 1, recGroup: {}, recMeta: { kind: 'float', score: Infinity,
      keyframes: [null, { dt: NaN, value: 1 }, { dt: 1, value: Infinity }, { dt: -1, value: 0 }, { dt: 0, value: 0.2 }] } },
    { cueId: 1, recMeta: { kind: 'invalid' } }
  ] };
  const loaded = h.ctx.migrateFolder(folder, null, [], null);
  assert.equal(loaded.events[0].recGroup, undefined);
  assert.equal(loaded.events[0].recMeta.score, undefined);
  assert.equal(loaded.events[0].recMeta.keyframes.length, 1);
  assert.equal(loaded.events[1].recMeta, undefined);
});

test('finalizing Float keeps Float mode while Trigger/Piano modes remain unchanged', () => {
  const h = harness();
  Object.assign(h.ctx, { laneAlloc: { remember() {} }, recLaneByName: () => 'R1',
    recDebug() {}, recCueName: () => 'Cue' });
  h.run(production('recMapKey')); h.run(production('recFinalizeCue'));
  for (const kind of ['float', 'piano', 'trigger']) {
    const cue = { cueId: 1 }, def = { id: 1, name: 'Existing cue' };
    const folder = { offset: 0, events: [cue], cues: [def] };
    h.ctx.recFinalizeCue(folder, cue, { kind, num: 1, ch: 1, address: '/opacity', args: [0.7],
      laneGroup: kind + '|@/opacity', keyframes: [{ dt: 0, value: 0.7 }] });
    assert.equal(def.mode, kind);
    assert.equal(cue.recMeta.kind, kind);
  }
});

(async () => {
  let failed = 0;
  for (const { name, fn } of cases) {
    try { await fn(); console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
  }
  console.log(`${cases.length - failed}/${cases.length} renderer tests passed`);
  process.exitCode = failed ? 1 : 0;
})();
