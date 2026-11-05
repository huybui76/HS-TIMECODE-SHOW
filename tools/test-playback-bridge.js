#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CFG = require('../realtime-config');
const HSPlayback = require('../renderer/cue-playback');
const RecordingSession = require('../recording-session');
const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');

function production(name) {
  const match = source.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'));
  assert.ok(match, 'Missing production function ' + name);
  return match[0];
}

function harness(config = {}) {
  let now = 0;
  const sends = [], posts = [], statuses = [], order = [];
  const elements = new Map();
  const targets = [{ id: 'a', host: 'one', port: 7001, enabled: true },
    { id: 'b', host: 'two', port: 7002, enabled: true },
    { id: 'off', host: 'off', port: 7003, enabled: false }];
  const folder = { id: 1, offset: 0, cues: [], events: [] };
  const context = vm.createContext({ console, structuredClone, REC_CFG: { ...CFG, ...config },
    window: { HSRealtime: CFG, HSPlayback, hs: { send: (...args) => {
      order.push('send'); sends.push(structuredClone(args)); return Promise.resolve();
    } } },
    performance: { timeOrigin: 1700000000000, now: () => now },
    oscUI: { targets }, flat: [], recActiveSession: null, recTransactions: new Map(),
    oscPort: { post: (message) => { order.push('token'); posts.push(structuredClone(message)); } },
    audio: { paused: true, currentTime: 0, volume: 1, pause() { this.paused = true; },
      play() { this.paused = false; return Promise.resolve(); } },
    audioSongId: null, audioClipId: null, masterVol: 1,
    preview: { audio: { paused: true } },
    findClipAtFrame: () => null, totalFrames: () => 10000,
    playbackEndFrames: () => Infinity, updateTransport() {}, previewSetState() {},
    lanControl() {}, recFinalizeOpen() {}, pushOscMode() {},
    monRow() {}, setStatus: (message) => statuses.push(message),
    renderProps() {}, scheduleAutosave() {}, infoDirty: false,
    $: (id) => {
      if (!elements.has(id)) elements.set(id, { value: '', addEventListener(type, fn) { this[type] = fn; } });
      return elements.get(id);
    },
    selDef: () => folder.cues[0]
  });
  const run = (code) => vm.runInContext(code, context);
  run(source.match(/^const state = \{[^]*?^};/m)[0]);
  const start = source.indexOf('let playbackKey =');
  run(source.slice(start, source.indexOf('function nextCue()', start)));
  for (const name of ['curFolder', 'rebuildFlat', 'lowerBoundFlat', 'setFrame', 'play', 'pause',
    'sendOsc', 'clamp', 'clockReset', 'clockNow', 'oscTimelineFrame', 'engineStep']) run(production(name));
  run("const clock = { anchorMs: 0, anchorFrame: 0, valid: false };");
  // These wrappers are production one-liners, not test reimplementations.
  run(source.match(/^function stop\(\)[^\n]*/m)[0]);
  context.folder = folder;
  run('state.folders = [folder]; state.activeFolderId = folder.id;');
  const add = ({ frame = 0, duration = 0, mode = 'trigger', address = '/trigger', args = [1],
    meta, enabled = true, pending = false, target, ...extra } = {}) => {
    const id = folder.events.length + 1;
    const def = { id, mode, address, args, ...extra };
    if (target !== undefined) def.target = target;
    const ev = { id, cueId: id, frame, duration, enabled, pending, recMeta: meta };
    folder.cues.push(def); folder.events.push(ev);
    return { ev, def };
  };
  const step = (ms) => { now = ms; context.engineStep(ms); };
  const frame = (value) => { now = value / run('state.fps * state.speed') * 1000; context.engineStep(now); };
  return { context, run, add, step, frame, sends, posts, statuses, targets, folder, order, elements,
    rebuild: () => context.rebuildFlat(), play: () => context.play(), stop: () => context.stop(),
    seek: (value) => context.setFrame(value), scheduler: () => run('playback') };
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const payloads = (h, address) => h.sends.filter((send) => send[0] === address).map((send) => send[1]);

test('Play first delayed engine step includes exact current Trigger once with full args', () => {
  const h = harness();
  const args = [7, 'actual', [1, 'nested'], new Uint8Array([4, 5]), null, true];
  h.add({ args }); h.rebuild(); h.play(); h.step(10); h.step(20);
  assert.deepEqual(payloads(h, '/trigger'), [args]);
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.order, ['token', 'send']);
  assert.equal(h.posts[0].t, 1700000000010);
});

test('Piano ON/OFF retains nonnumeric args and target id', () => {
  const h = harness(); h.add({ mode: 'piano', address: '/piano', args: ['label', 9, [4]], duration: 30, target: 'b' });
  h.rebuild(); h.play(); h.frame(0); h.frame(30); h.frame(31);
  assert.deepEqual(payloads(h, '/piano'), [['label', 1, [4]], ['label', 0, [4]]]);
  assert.ok(h.sends.every((send) => JSON.stringify(send[4]) === '["b"]'));
  assert.equal(h.posts.length, 2);
});

test('layerclear configured release also uses target and playback recTx', () => {
  const h = harness({ PIANO_END_ACTION: 'layerclear' });
  h.add({ mode: 'piano', address: '/composition/layers/3/clips/7/connect', duration: 30, target: ['a', 'off'] });
  h.rebuild(); h.play(); h.frame(0); h.stop();
  assert.deepEqual(h.sends.map((send) => [send[0], send[1], send[4]]), [
    ['/composition/layers/3/clips/7/connect', [1], ['a']], ['/composition/layers/3/clear', [1], ['a']]
  ]);
  assert.equal(h.posts.at(-1).address, '/composition/layers/3/clear');
});

test('actual Float is 30Hz plus exact endpoints; only actual value argument changes', () => {
  const h = harness();
  h.add({ mode: 'float', duration: 30, address: '/opacity', args: [99, 'keep', 0.4488], meta: {
    dataOrigin: 'osc', keyframes: [
      { dt: 0, value: 0.4488, args: [99, 'keep', 0.4488] },
      { dt: 1000, value: 0.6142, args: [99, 'keep', 0.6142] }
    ]
  } });
  h.rebuild(); h.play(); for (let ms = 0; ms <= 1000; ms += 10) h.step(ms);
  const values = payloads(h, '/opacity');
  assert.equal(values.length, 31);
  assert.deepEqual(values[0], [99, 'keep', 0.4488]);
  assert.deepEqual(values.at(-1), [99, 'keep', 0.6142]);
  assert.ok(values.every((args) => args[0] === 99 && args[1] === 'keep'));
  assert.equal(h.posts.length, 31);
});

test('Float dt conversion never stretches to placement duration', () => {
  const h = harness(); h.add({ mode: 'float', duration: 60, address: '/opacity', args: [0.2],
    meta: { dataOrigin: 'osc', keyframes: [{ dt: 0, value: 0.2 }, { dt: 1000, value: 0.8 }] } });
  h.rebuild(); h.play(); h.frame(0); h.frame(30);
  assert.equal(payloads(h, '/opacity').at(-1)[0], 0.8);
});

test('disabled/pending/recording/unassigned/no-address/MIDI guessed Float never send', () => {
  const h = harness(); h.add({ enabled: false }); h.add({ pending: true });
  const live = h.add(); live.ev.recording = true;
  h.add({ meta: { unassigned: true } }); h.add({ address: '' });
  h.add({ mode: 'float', duration: 30, meta: { guessed: true, dataOrigin: 'midi', keyframes: [{ dt: 0, value: 0.1 }] } });
  h.rebuild(); h.play(); h.frame(0); h.frame(60);
  assert.equal(h.sends.length, 0); assert.equal(h.posts.length, 0);
});

test('visual folder hidden is not mute; smpteInput remains passive metadata', () => {
  const h = harness(); h.folder.hidden = true; h.add().ev.smpteInput = true;
  h.rebuild(); h.play(); h.frame(0);
  assert.equal(h.sends.length, 1); assert.equal(h.folder.events[0].smpteInput, true);
});

test('seek midpoint does not chase earlier Piano or Float, but exact start is eligible', () => {
  const h = harness(); h.add({ mode: 'piano', duration: 60 });
  h.add({ mode: 'float', duration: 60, address: '/opacity', args: [0.2], meta: {
    dataOrigin: 'osc', keyframes: [{ dt: 0, value: 0.2 }, { dt: 2000, value: 0.7 }] } });
  h.add({ frame: 30, address: '/exact' }); h.rebuild(); h.seek(30); h.play(); h.step(10);
  assert.deepEqual(h.sends.map((send) => send[0]), ['/exact']);
});

test('seek while playing releases active before resetting and does not chase', () => {
  const h = harness(); h.add({ mode: 'piano', duration: 90 }); h.rebuild(); h.play(); h.frame(0);
  h.seek(45); assert.deepEqual(payloads(h, '/trigger'), [[1], [0]]);
  h.step(10); assert.equal(h.sends.length, 2);
});

test('pause safety release is immediate, resume does not repeat consumed current start', () => {
  const h = harness(); h.add({ mode: 'piano', duration: 30 }); h.rebuild(); h.play(); h.frame(0);
  h.context.pause(true); assert.deepEqual(payloads(h, '/trigger'), [[1], [0]]);
  h.play(); h.frame(0); h.frame(10); assert.equal(h.sends.length, 2);
});

test('stop resets eligibility: play again may fire start zero once', () => {
  const h = harness(); h.add(); h.rebuild(); h.play(); h.frame(0); h.stop(); h.play(); h.frame(0);
  assert.equal(h.sends.length, 2);
});

test('unchanged rebuild while playing/recording does not reload, release, or repeat', () => {
  const h = harness(); h.add({ mode: 'piano', duration: 30 }); h.rebuild(); h.play(); h.frame(0);
  const events = h.scheduler().events;
  h.run('state.recArmed = true;');
  for (let i = 0; i < 10; i++) { h.rebuild(); h.frame(0); }
  assert.equal(h.scheduler().events, events);
  assert.deepEqual(payloads(h, '/trigger'), [[1]]);
  h.frame(30); assert.deepEqual(payloads(h, '/trigger'), [[1], [0]]);
});

test('cosmetic/SMPTE edits do not reload; actual schedule edit safety-releases active Piano', () => {
  const h = harness(); const cue = h.add({ mode: 'piano', duration: 60 }); h.rebuild(); h.play(); h.frame(0);
  const events = h.scheduler().events;
  cue.def.name = 'Renamed'; cue.def.color = '#112233'; cue.ev.smpteInput = true;
  h.rebuild(); assert.equal(h.scheduler().events, events); assert.equal(h.sends.length, 1);
  cue.ev.duration = 90; h.rebuild(); assert.deepEqual(payloads(h, '/trigger'), [[1], [0]]);
  h.frame(0); h.frame(90); assert.equal(h.sends.length, 2);
});

test('actual editing rebuild never repeats consumed exact current or earlier events', () => {
  const h = harness(); const old = h.add(); h.rebuild(); h.play(); h.frame(0);
  old.def.args = [99]; h.add({ frame: 0, address: '/new-current' }); h.add({ frame: 10, address: '/future' });
  h.rebuild(); h.frame(0); h.frame(10);
  assert.deepEqual(h.sends.map((send) => send[0]), ['/trigger', '/future']);
});

test('append finalized REC action in past does not replay old events', () => {
  const h = harness(); h.add(); h.rebuild(); h.play(); h.frame(10);
  h.add({ frame: 1, address: '/recorded', meta: { dataOrigin: 'osc' } }); h.rebuild(); h.frame(10); h.frame(11);
  assert.deepEqual(h.sends.map((send) => send[0]), ['/trigger']);
});

test('REC append preserves active Piano/Float snapshots, cadence and original end', () => {
  const h = harness(); h.add({ mode: 'piano', duration: 90, address: '/held' });
  h.add({ mode: 'float', duration: 90, address: '/curve', args: [0.2], meta: {
    dataOrigin: 'osc', keyframes: [{ dt: 0, value: 0.2 }, { dt: 3000, value: 0.8 }] } });
  h.rebuild(); h.play(); h.frame(0); h.frame(10);
  const note = h.scheduler().pianos.get(0), active = h.scheduler().floats.get(1);
  h.add({ frame: 1, address: '/recorded', meta: { dataOrigin: 'osc' } }); h.rebuild();
  assert.equal(h.scheduler().pianos.get(0), note); assert.equal(h.scheduler().floats.get(1), active);
  assert.deepEqual(payloads(h, '/held'), [[1]]);
  h.frame(20); h.add({ frame: 11, address: '/recorded-two' }); h.rebuild(); h.frame(90);
  assert.deepEqual(payloads(h, '/held'), [[1], [0]]);
  const values = payloads(h, '/curve'); assert.equal(values.length, 91);
  assert.equal(values.at(-1)[0], 0.8);
  assert.ok(!h.sends.some((send) => send[0].startsWith('/recorded')));
});

test('in-place curve or payload edit still safely resets instead of reconciling as append', () => {
  const h = harness(); const cue = h.add({ mode: 'piano', duration: 90 });
  h.rebuild(); h.play(); h.frame(0); h.frame(10);
  cue.def.args[0] = 9; h.add({ frame: 1, address: '/recorded' }); h.rebuild();
  assert.deepEqual(payloads(h, '/trigger'), [[1], [0]]);
  assert.equal(h.scheduler().pianos.size, 0); h.frame(90); assert.equal(h.sends.length, 2);
});

test('bridge step mode and capture flag preserve endpoints without changing edited trim semantics', () => {
  for (const meta of [
    { captureEndpoint: true }, { captureEndpoint: true, curveEdited: true },
    { captureEndpoint: true, trimmed: true }, { captureEndpoint: false }
  ]) {
    const h = harness(); h.run('state.fps = 24;');
    h.add({ mode: 'float', duration: 4, address: '/curve', args: [0.2], meta: { ...meta,
      dataOrigin: 'osc', keyframes: [{ dt: 0, value: 0.2 }, { dt: 180, value: 0.8 }] } });
    h.rebuild(); h.play(); h.frame(0); h.frame(4);
    assert.equal(payloads(h, '/curve').at(-1)[0] === 0.8, !!meta.captureEndpoint && !meta.curveEdited && !meta.trimmed);
  }
  const h = harness(); h.add({ mode: 'float', duration: 30, args: [0.2], meta: {
    dataOrigin: 'osc', interpolation: 'step', keyframes: [{ dt: 0, value: 0.2 }, { dt: 1000, value: 0.8 }] } });
  h.rebuild(); h.play(); h.frame(0); h.frame(15); assert.equal(payloads(h, '/trigger').at(-1)[0], 0.2);
  h.frame(30); assert.equal(payloads(h, '/trigger').at(-1)[0], 0.8);
});

test('real recorder descriptors through production bridge align untouched capture endpoints at 24/25/30fps', () => {
  for (const [fps, endMs] of [[24, 180], [25, 170], [30, 180]]) {
    const h = harness(), actions = [], epoch = 1700000000000;
    const recorder = new RecordingSession({ emit: (action) => actions.push(action) });
    recorder.start({ session: fps, anchorEpoch: epoch, anchorFrame: 0, fps });
    recorder.ingestOsc({ address: '/actual', args: [0.2, 'full'], t: epoch, seq: 1 });
    recorder.ingestOsc({ address: '/actual', args: [0.8, 'full'], t: epoch + endMs, seq: 2 });
    recorder.finish(epoch + endMs); recorder.tick(epoch + endMs + 1000);
    assert.equal(actions.length, 1); const action = actions[0];
    h.run('state.fps = ' + fps);
    h.add({ frame: action.startFrame, mode: action.kind, duration: action.durationFrames,
      address: action.address, args: action.args, meta: { ...action, captureEndpoint: true } });
    h.rebuild(); h.play(); h.frame(0); h.frame(action.durationFrames);
    assert.deepEqual(payloads(h, '/actual')[0], [0.2, 'full']);
    assert.deepEqual(payloads(h, '/actual').at(-1), [0.8, 'full']);
  }
});

test('project rebuild isolates cues and resets exact-current consumed identity', () => {
  const h = harness(); h.add(); h.rebuild(); h.play(); h.frame(0); h.context.pause(true);
  const other = { id: 2, offset: 0, events: [{ id: 2, cueId: 2, frame: 0 }],
    cues: [{ id: 2, mode: 'trigger', address: '/project-two', args: [2] }] };
  h.context.other = other; h.run('state.folders.push(other); state.activeFolderId = 2;'); h.rebuild(); h.play(); h.frame(0);
  assert.deepEqual(h.sends.map((send) => send[0]), ['/trigger', '/project-two']);
});

test('selected targets preserved; disabled/missing selections and all-disabled output skip tokens', () => {
  const h = harness(); h.add({ target: ['a', 'b', 'off'] }); h.add({ target: 'missing' }); h.add({ target: 'off' });
  h.rebuild(); h.play(); h.frame(0);
  assert.equal(h.sends.length, 1); assert.deepEqual(h.sends[0][4], ['a', 'b']); assert.equal(h.posts.length, 1);
  h.context.sendOsc('/manual', [1]); assert.equal(h.posts.length, 1);
  h.targets.forEach((target) => { target.enabled = false; });
  h.context.sendOsc('/skip', [1], undefined, { origin: 'playback' }); assert.equal(h.posts.length, 1);
});

test('LTC-like externally supplied frames share same scheduler, never invent chase', () => {
  const h = harness(); h.add({ frame: 20 }); h.add({ frame: 25, mode: 'piano', duration: 10, address: '/note' });
  h.rebuild(); h.seek(20); h.run('state.playing = true;');
  for (const frame of [20, 20, 24, 25, 30, 35, 35]) { h.run('state.frame = ' + frame); h.context.fireDue(); }
  assert.deepEqual(h.sends.map((send) => [send[0], send[1]]), [['/trigger', [1]], ['/note', [1]], ['/note', [0]]]);
  h.seek(30); h.context.fireDue(); assert.equal(h.sends.length, 3);
});

test('external frames sample actual Float with exact endpoints and no midpoint seek chase', () => {
  const h = harness(); h.add({ frame: 10, mode: 'float', duration: 30, address: '/float', args: [0.4488],
    meta: { dataOrigin: 'osc', keyframes: [{ dt: 0, value: 0.4488 }, { dt: 1000, value: 0.6142 }] } });
  h.rebuild(); h.seek(10); h.run('state.playing = true;');
  for (const frame of [10, 15, 20, 25, 30, 35, 40]) { h.run('state.frame = ' + frame); h.context.fireDue(); }
  const values = payloads(h, '/float'); assert.equal(values.length, 31);
  assert.equal(values[0][0], 0.4488); assert.equal(values.at(-1)[0], 0.6142);
  h.seek(20); h.context.fireDue(); assert.equal(h.sends.length, 31);
});

test('frozen recording speed maps curve once; playback speed limits wall cadence only', () => {
  const h = harness(); h.run('state.speed = 2;');
  h.add({ mode: 'float', duration: 60, address: '/float', args: [0.2], meta: {
    dataOrigin: 'osc', recordingSpeed: 2, keyframes: [{ dt: 0, value: 0.2 }, { dt: 1000, value: 0.8 }] } });
  h.rebuild(); h.play(); for (let ms = 0; ms <= 1000; ms += 10) h.step(ms);
  const values = payloads(h, '/float'); assert.equal(values.length, 31);
  assert.equal(values.at(-1)[0], 0.8);
});

test('scheduler output carries action context, real selected target, and safety reason', () => {
  const h = harness(); const calls = [];
  h.context.sendOsc = (...args) => calls.push(args);
  h.add({ mode: 'piano', duration: 30, target: 'b' }); h.rebuild(); h.play(); h.frame(0); h.stop();
  assert.equal(calls[0][2], 'b'); assert.equal(calls[0][3].cueId, 1);
  assert.equal(calls[0][3].kind, 'piano-on'); assert.equal(calls[0][3].origin, 'playback');
  assert.equal(calls[1][3].kind, 'piano-off'); assert.equal(calls[1][3].reason, 'stop');
});

test('fps cache revision and mode prop hook rebuild without scanning schedule each step', () => {
  const h = harness(); h.add(); h.rebuild(); h.play(); h.frame(0);
  const events = h.scheduler().events;
  h.run('state.fps = 25;'); h.context.fireDue(); assert.notEqual(h.scheduler().events, events);
  const hook = source.match(/^\['Trigger', 'Piano', 'Float'\]\.forEach\(\(m\) => \{\n  \$\('pMode'[^]*?^}\);/m);
  assert.ok(hook); h.run(hook[0]);
  h.elements.get('pModePiano').click(); assert.equal(h.folder.cues[0].mode, 'piano');
  assert.equal(h.scheduler().events.length, 0); // zero-duration Piano is not executable
});

test('engine runs on timer and UI tick does not dispatch playback', () => {
  assert.match(source, /setInterval\(\(\) => engineStep\(performance\.now\(\)\), 10\)/);
  assert.doesNotMatch(production('tick'), /fireDue|playback\.step|engineStep/);
  assert.doesNotMatch(source, /REST|fetch\([^]*chase/);
});

let passed = 0;
for (const { name, fn } of cases) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (error) { console.error('FAIL ' + name + '\n' + error.stack); }
}
console.log(`${passed}/${cases.length} playback bridge tests passed`);
if (passed !== cases.length) process.exitCode = 1;
