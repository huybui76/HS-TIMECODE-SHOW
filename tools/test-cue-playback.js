#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PlaybackScheduler, DEFAULTS } = require('../renderer/cue-playback');
const RecordingSession = require('../recording-session');
const clip = (n = 1) => `/composition/layers/2/clips/${n}/connect`;
const opacity = '/composition/layers/2/video/opacity';
let passed = 0, failed = 0;

function test(name, run) {
  try { run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
}

function harness(cues = [], options = {}) {
  const sent = [];
  const scheduler = new PlaybackScheduler({ config: options.config,
    send: (address, args, target, context) => sent.push({ address, args, target, ...context }) });
  scheduler.load(cues, { fps: options.fps || 30, generation: options.generation });
  return { scheduler, sent, step: (f, o) => scheduler.step(f, undefined, o) };
}

function trigger(frame, extra = {}) {
  return { id: `t${frame}`, frame, duration: 30, mode: 'trigger', address: clip(), args: [1], ...extra };
}

function piano(frame, duration, extra = {}) {
  return trigger(frame, { mode: 'piano', duration, ...extra });
}

function curve(frame = 0, duration = 30, extra = {}) {
  return trigger(frame, { mode: 'float', address: opacity, args: ['full', 0.75, 7, { a: [3] }], valueIndex: 1,
    duration, keyframes: [{ tFrame: 0, value: 0.25 }, { tFrame: duration, value: 0.75 }], ...extra });
}

test('UMD browser global and CommonJS use the same shared config', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/cue-playback.js'), 'utf8');
  const context = { HSRealtime: DEFAULTS };
  vm.runInNewContext(source, context);
  assert.equal(typeof context.HSPlayback.PlaybackScheduler, 'function');
  assert.equal(context.HSPlayback.DEFAULTS, DEFAULTS);
  assert.equal(DEFAULTS, require('../realtime-config'));
});

test('Trigger once at start; visual duration never produces a release', () => {
  const h = harness([trigger(0), trigger(30, { id: 'repeat', duration: 300 })]);
  for (const frame of [0, 0, 1, 29, 30, 30, 31, 400]) h.step(frame);
  assert.deepEqual(h.sent.map((e) => [e.cueId, e.frame, e.args]), [['t0', 0, [1]], ['repeat', 30, [1]]]);
  h.scheduler.stop();
  assert.equal(h.sent.length, 2);
});

test('Piano forces 1/0, preserves full args, target and releases on stop exactly once', () => {
  const h = harness([piano(0, 60, { args: ['name', 99, 5], valueIndex: 1, outputTarget: 'resolume-b' })]);
  h.step(0); h.step(5); h.scheduler.stop(); h.scheduler.stop(); h.step(60);
  assert.deepEqual(h.sent.map((e) => e.args), [['name', 1, 5], ['name', 0, 5]]);
  assert.deepEqual(h.sent.map((e) => e.target), ['resolume-b', 'resolume-b']);
  assert.equal(h.sent[1].reason, 'stop');
});

test('Piano scheduled release, including delayed step across entire cue', () => {
  const h = harness([piano(4, 8)]);
  h.step(0); h.step(50); h.step(100);
  assert.deepEqual(h.sent.map((e) => [e.frame, e.kind, e.args[0]]), [[4, 'piano-on', 1], [12, 'piano-off', 0]]);
});

test('layerclear maps concrete/group/selected layers, never fabricates a layer for a column', () => {
  const addresses = [clip(), '/composition/groups/3/layers/4/clips/8/connect',
    '/composition/selectedlayer/clips/1/connect', '/composition/columns/3/connect'];
  const h = harness(addresses.map((address, i) => piano(0, 5, { id: i, address })),
    { config: { PIANO_END_ACTION: 'layerclear' } });
  h.step(0); h.step(5);
  assert.deepEqual(h.sent.slice(4).map((e) => [e.address, e.args]), [
    ['/composition/layers/2/clear', [1]], ['/composition/groups/3/layers/4/clear', [1]],
    ['/composition/selectedlayer/clear', [1]], ['/composition/columns/3/connect', [0]]]);
});

test('hidden is visual only; disabled, pending, unassigned and addressless cues never send', () => {
  const h = harness([trigger(0, { hidden: true }), trigger(0, { enabled: false }),
    piano(0, 30, { pending: true }), curve(0, 30, { unassigned: true }),
    trigger(0, { address: '' }), trigger(0, { address: null }), piano(0, 0)]);
  h.step(0); h.step(100); h.scheduler.stop();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].kind, 'trigger');
});

test('unassigned and fallback MIDI Float curves remain display-only', () => {
  const h = harness([curve(0, 30, { dataOrigin: 'midi', guessed: true }),
    curve(0, 30, { curveOrigin: 'midi' }), curve(0, 30, { pending: true }),
    curve(0, 30, { address: '' }), curve(0, 30, { dataOrigin: 'osc', id: 'actual' })]);
  h.step(0); h.step(30);
  assert.equal(h.sent.length, 31);
  assert.ok(h.sent.every((e) => e.cueId === 'actual'));
});

test('Float first/last exact, interpolated interior, full args and max 30Hz independent of tick rate', () => {
  const cue = curve();
  const original = structuredClone(cue);
  const h = harness([cue]);
  for (let i = 0; i <= 300; i++) h.step(i / 10);
  assert.equal(h.sent.length, 31);
  assert.equal(h.sent[0].args[1], 0.25);
  assert.equal(h.sent.at(-1).args[1], 0.75);
  assert.equal(h.sent[15].args[1], 0.5);
  assert.deepEqual(h.sent.map((e) => e.frame), Array.from({ length: 31 }, (_, i) => i));
  assert.ok(h.sent.every((e) => e.args[0] === 'full' && e.args[2] === 7 && e.args[3].a[0] === 3));
  assert.deepEqual(cue, original);
});

test('Float arbitrary duration retains endpoint even when not on sample grid', () => {
  const h = harness([curve(0, 7.25)]);
  h.step(0); h.step(20);
  assert.deepEqual(h.sent.map((e) => e.frame), [0, 1, 2, 3, 4, 5, 6, 7, 7.25]);
  assert.equal(h.sent.at(-1).args[1], 0.75);
});

test('configured Hz samples at fixed cadence and preserves boundary exceptions', () => {
  const h = harness([curve(10, 31)], { config: { PLAYBACK_FLOAT_HZ: 10 } });
  h.scheduler.seek(0); h.step(0); h.step(100);
  assert.deepEqual(h.sent.map((e) => e.frame), [10, 13, 16, 19, 22, 25, 28, 31, 34, 37, 40, 41]);
  assert.equal(h.sent[0].args[1], 0.25);
  assert.equal(h.sent.at(-1).args[1], 0.75);
});

test('single-point/zero-duration floats and invalid points remain finite and deterministic', () => {
  const h = harness([curve(0, 0, { keyframes: [{ dt: 0, value: 0.6 }] }),
    curve(2, 2, { keyframes: [{ tFrame: 0, value: 0.3 }, { dt: NaN, value: 1 },
      { dt: 1, value: Infinity }, null] }), curve(2, 2, { keyframes: [] })]);
  h.step(0); h.step(4); h.step(5);
  assert.deepEqual(h.sent.map((e) => [e.frame, e.args[1]]), [[0, 0.6], [2, 0.3], [3, 0.3], [4, 0.3]]);
});

test('fractional FPS grids avoid drift, duplicate endpoints and tick-dependent output', () => {
  for (const fps of [24, 25, 29.97, 30, 60]) {
    const a = harness([curve(0, fps * 10)], { fps });
    const b = harness([curve(0, fps * 10)], { fps });
    a.step(0); a.step(fps * 10);
    for (let i = 0; i <= 1000; i++) b.step(fps * i / 100);
    assert.equal(a.sent.length, 301);
    assert.deepEqual(a.sent, b.sent);
    assert.equal(a.sent.at(-1).frame, fps * 10);
  }
});

test('inverse actual OSC values and all ease modes retain endpoints', () => {
  for (const [interpolation, expected] of [['linear', 0.75], ['ease', 0.84375],
    ['ease-in', 0.9375], ['ease-out', 0.5625], ['ease-in-out', 0.84375]]) {
    const h = harness([curve(0, 4, { interpolation,
      keyframes: [{ tFrame: 0, value: 1 }, { tFrame: 4, value: 0 }] })]);
    h.step(0); h.step(4);
    assert.equal(h.sent[0].args[1], 1);
    assert.equal(h.sent[1].args[1], expected);
    assert.equal(h.sent.at(-1).args[1], 0);
  }
});

test('exact recorded keyframe args preserved and only selected numeric index interpolates', () => {
  const h = harness([curve(0, 2, { keyframes: [
    { tFrame: 0, value: 0.2, args: ['start', 0.2, 9] },
    { tFrame: 2, value: 0.8, args: ['end', 0.8, 11] }] })]);
  h.step(0); h.step(2);
  assert.deepEqual(h.sent.map((e) => e.args), [['start', 0.2, 9], ['start', 0.5, 9], ['end', 0.8, 11]]);
});

test('ms/dt map by fps and frozen recordingSpeed, preserving move without fitting duration', () => {
  for (const fps of [24, 25, 30]) {
    const h = harness([curve(100, fps * 2, { recordingSpeed: 2, keyframes: [
      { dt: 0, value: 0.2 }, { dt: 250, value: 0.4 }, { dt: 1000, value: 0.8 }] })], { fps });
    h.scheduler.seek(0); h.step(100); h.step(100 + fps); h.step(100 + fps * 2);
    const mid = h.sent.find((e) => Math.abs(e.frame - (100 + fps)) < 1e-8);
    assert.ok(mid);
    assert.ok(Math.abs(mid.args[1] - (0.4 + 0.4 / 3)) < 1e-9);
    assert.equal(h.sent.at(-1).frame, 100 + fps * 2);
    assert.equal(h.sent.at(-1).args[1], 0.8);
  }
});

test('duration change never silently stretches ms curves; trim and stretch belong to caller', () => {
  const h = harness([curve(0, 60, {
    keyframes: [{ dt: 0, value: 0.25 }, { dt: 1000, value: 0.75 }] })]);
  h.step(0); h.step(60);
  assert.equal(h.sent[15].args[1], 0.5);
  assert.equal(h.sent[30].args[1], 0.75);
  assert.equal(h.sent.at(-1).args[1], 0.75);
  const trimmed = harness([curve(0, 15, {
    keyframes: [{ dt: 0, value: 0.25 }, { dt: 1000, value: 0.75 }] })]);
  trimmed.step(0); trimmed.step(15);
  assert.equal(trimmed.sent.at(-1).args[1], 0.5);
});

test('explicit recordingSpeed maps ms to timeline once; playback speed only changes sampling', () => {
  const h = harness([curve(0, 60, { recordingSpeed: 2,
    keyframes: [{ ms: 0, value: 0.2 }, { ms: 1000, value: 0.8 }] })]);
  h.step(0, { speed: 2 }); h.step(60, { speed: 2 });
  assert.equal(h.sent.length, 31);
  assert.equal(h.sent[15].frame, 30);
  assert.equal(h.sent[15].args[1], 0.5);
  assert.equal(h.sent.at(-1).args[1], 0.8);
});

test('initial step / seek mid / reset never chase previous Trigger, Piano or Float', () => {
  const cues = [trigger(0), piano(0, 60), curve(0, 60), trigger(30), trigger(50)];
  const h = harness(cues);
  h.step(20); h.step(25);
  assert.equal(h.sent.length, 0);
  h.step(30);
  assert.equal(h.sent.length, 1);
  h.scheduler.seek(40); h.step(40); h.step(60);
  assert.deepEqual(h.sent.map((e) => e.frame), [30, 50]);
  h.scheduler.reset(20); h.step(20);
  assert.equal(h.sent.length, 2);
});

test('seek releases an actually started Piano; seek at cue start remains eligible once', () => {
  const h = harness([piano(0, 60), trigger(30)]);
  h.step(0); h.scheduler.seek(30); h.step(30); h.step(30); h.step(90);
  assert.deepEqual(h.sent.map((e) => [e.kind, e.frame]), [['piano-on', 0], ['piano-off', 30], ['trigger', 30]]);
  assert.equal(h.sent[1].reason, 'seek');
});

test('discontinuity and backward motion release safely and do not catch up skipped starts', () => {
  const h = harness([piano(0, 100), curve(0, 100), trigger(25), trigger(60)]);
  h.step(0); h.step(50, { discontinuity: true }); h.step(50); h.step(60); h.step(20); h.step(20);
  assert.deepEqual(h.sent.map((e) => [e.kind, e.frame]),
    [['piano-on', 0], ['float', 0], ['piano-off', 50], ['trigger', 60]]);
});

test('normal long timer delay catches up ALL events globally in time order, no automatic jump heuristic', () => {
  const h = harness([trigger(19), curve(2, 3), piano(1, 7), trigger(3), piano(8, 2)]);
  h.step(0); h.step(100);
  assert.deepEqual(h.sent.map((e) => e.frame), [1, 2, 3, 3, 4, 5, 8, 8, 10, 19]);
  assert.deepEqual(h.sent.filter((e) => e.frame === 8).map((e) => e.kind), ['piano-off', 'piano-on']);
});

test('same-frame release before starts deterministic even when input is reversed', () => {
  const h = harness([piano(10, 10, { id: 'next' }), trigger(10, { id: 'trigger' }),
    piano(0, 10, { id: 'previous' })]);
  h.step(0); h.step(10); h.step(20);
  assert.deepEqual(h.sent.filter((e) => e.frame === 10).map((e) => [e.cueId, e.kind]),
    [['previous', 'piano-off'], ['next', 'piano-on'], ['trigger', 'trigger']]);
});

test('playing false safety-releases, resume does not reactivate old holds or curves', () => {
  const h = harness([piano(0, 50), curve(0, 50), trigger(30)]);
  h.step(0); h.step(20, { playing: false }); h.step(20); h.step(50);
  assert.deepEqual(h.sent.map((e) => [e.kind, e.frame]),
    [['piano-on', 0], ['float', 0], ['piano-off', 20], ['trigger', 30]]);
});

test('generation and explicit load release old outputs and reset at current frame without chase', () => {
  const old = [piano(0, 100, { outputTarget: 'old' }), trigger(20)];
  const h = harness(old, { generation: 1 });
  h.step(0); h.step(30, { generation: 2 });
  assert.deepEqual(h.sent.map((e) => [e.kind, e.generation]), [['piano-on', 1], ['piano-off', 1]]);
  h.scheduler.load([trigger(0), trigger(40, { outputTarget: 'new' })]);
  h.step(30); h.step(40);
  assert.equal(h.sent.at(-1).target, 'new');
  assert.equal(h.sent.length, 3);
});

test('step cues overload caches identity; 1000 inactive cues are not scanned per tick', () => {
  let reads = 0;
  const cues = Array.from({ length: 1000 }, (_, i) => ({ ...trigger(1000 + i),
    get enabled() { reads++; return true; } }));
  const h = harness();
  h.scheduler.step(0, cues, { fps: 30 });
  const initial = reads;
  for (let i = 1; i < 100; i++) h.scheduler.step(i, cues, { fps: 30 });
  assert.ok(initial >= 1000);
  assert.equal(reads, initial);
  assert.equal(h.sent.length, 0);
});

test('snapshots full args, nested data, and buffers; caller/send mutation cannot corrupt later sends', () => {
  const cue = piano(0, 5, { args: [1, { x: [7] }, Buffer.from([4, 5])] });
  const h = harness([cue]);
  cue.args[1].x[0] = 99; cue.args[2][0] = 99;
  h.step(0); h.sent[0].args[1].x[0] = 88; h.sent[0].args[2][0] = 88;
  h.step(5);
  assert.deepEqual(h.sent[1].args, [0, { x: [7] }, Buffer.from([4, 5])]);
});

test('safety stop attempts all Piano releases even if a send throws', () => {
  const sent = [];
  const scheduler = new PlaybackScheduler({ send(address, args) {
    sent.push([address, args[0]]);
    if (!args[0] && address === clip(1)) throw new Error('target failed');
  } });
  scheduler.load([piano(0, 10, { address: clip(1) }), piano(0, 10, { address: clip(2) })]);
  scheduler.step(0);
  assert.throws(() => scheduler.stop(), /target failed/);
  assert.deepEqual(sent.slice(2), [[clip(1), 0], [clip(2), 0]]);
  scheduler.stop();
  assert.equal(sent.length, 4);
});

test('invalid transport/config inputs fail before destructive playback changes', () => {
  assert.throws(() => new PlaybackScheduler(), /requires send/);
  assert.throws(() => new PlaybackScheduler({ send() {}, config: { PLAYBACK_FLOAT_HZ: 0 } }), /positive/);
  const h = harness([piano(0, 5)]);
  h.step(0);
  assert.throws(() => h.scheduler.load([], { fps: 0 }), /positive/);
  assert.throws(() => h.step(NaN), /finite/);
  assert.throws(() => h.step(1, { speed: 0 }), /positive/);
  assert.throws(() => h.scheduler.seek(Infinity), /finite/);
  assert.equal(h.sent.length, 1);
  h.scheduler.reset(3);
  assert.equal(h.sent[1].kind, 'piano-off');
});

test('real RecordingSession normalized descriptors play actual OSC curves and Piano safely', () => {
  const actions = [];
  const session = new RecordingSession({ config: { FLOAT_MATCH_MAX_LAGS: 32, FLOAT_MATCH_MAX_SAMPLES: 256 },
    emit: (cue) => actions.push(cue) });
  const epoch = 1700000000000;
  session.start({ session: 1, anchorEpoch: epoch, anchorFrame: 0, fps: 30, speed: 2 });
  session.midi({ kind: 'noteOn', num: 60, ch: 1, value: 100, t: epoch });
  session.ingestOsc({ address: clip(), args: [1, 'real'], t: epoch + 5, seq: 1 });
  for (let i = 0; i < 3; i++) {
    session.midi({ kind: 'cc', num: 8, ch: 1, value: i * 60, t: epoch + i * 100 });
    session.ingestOsc({ address: opacity, args: [0.25 + i * 0.25, 'curve', 99], t: epoch + i * 100 + 5, seq: i + 2 });
  }
  session.midi({ kind: 'noteOff', num: 60, ch: 1, value: 0, t: epoch + 600 });
  session.finish(epoch + 700); session.tick(epoch + 1200);
  assert.equal(actions.length, 2);
  const normalized = actions.map((a) => ({ ...a, frame: a.startFrame,
    duration: a.durationFrames, mode: a.kind, outputTarget: 'live',
    keyframes: a.keyframes.map((p) => ({ ...p, tFrame: a.holdMs ? p.dt * a.durationFrames / a.holdMs : 0 })) }));
  const h = harness(normalized);
  h.scheduler.seek(0); h.step(0); h.step(100);
  const floats = h.sent.filter((e) => e.kind === 'float');
  assert.equal(floats[0].args[0], 0.25);
  assert.equal(floats.at(-1).args[0], 0.75);
  assert.ok(floats.every((e) => e.args[1] === 'curve' && e.args[2] === 99));
  assert.deepEqual(h.sent.filter((e) => e.kind.startsWith('piano')).map((e) => e.args), [[1, 'real'], [0, 'real']]);
  assert.ok(h.sent.every((e) => e.target === 'live'));
});

test('append reconcile preserves active Piano snapshot and Float sampling through original end', () => {
  const cues = [piano(0, 90, { id: 'held' }), curve(0, 90, { id: 'curve' })];
  const h = harness(cues); h.step(0); h.step(10);
  const note = h.scheduler.pianos.get(0), active = h.scheduler.floats.get(1);
  const pendingOff = h.scheduler.events.find((event) => event.kind === 'piano-off');
  const added = trigger(1, { id: 'recorded' });
  assert.equal(h.scheduler.reconcile([cues[0], added, cues[1]]), true);
  assert.equal(h.scheduler.pianos.get(0), note); assert.equal(h.scheduler.floats.get(1), active);
  assert.equal(h.scheduler.events.find((event) => event.kind === 'piano-off'), pendingOff);
  assert.equal(h.sent.filter((event) => event.kind === 'piano-off').length, 0);
  h.step(90);
  assert.deepEqual(h.sent.filter((event) => event.kind === 'piano-off').map((event) => event.frame), [90]);
  assert.equal(h.sent.filter((event) => event.kind === 'float').length, 91);
  assert.equal(h.sent.filter((event) => event.kind === 'float').at(-1).args[1], 0.75);
  assert.ok(h.sent.every((event) => event.cueId !== 'recorded'));
});

test('append reconcile skips current/past starts, retains pending originals and enables future inserts', () => {
  const original = [trigger(0), piano(30, 10, { id: 'future-note' })];
  const h = harness(original); h.step(0); h.step(10);
  assert.equal(h.scheduler.reconcile([original[0], trigger(10, { id: 'current' }), original[1],
    trigger(20, { id: 'new-future' })]), true);
  h.step(40);
  assert.deepEqual(h.sent.map((event) => event.cueId), ['t0', 'new-future', 'future-note', 'future-note']);
  assert.equal(h.scheduler.reconcile([original[0]]), false);
});

test('reconcile rejects payload, mode, target, keyframe, order, ID and clock/config edits without mutation', () => {
  const cues = [piano(0, 90, { id: 'held', args: [1, { value: [2] }] }), curve(0, 90, { id: 'float' })];
  const h = harness(cues); h.step(0); h.step(10);
  const events = h.scheduler.events, active = h.scheduler.floats.get(1);
  for (const patch of [
    (items) => { items[0].args[1].value[0] = 3; }, (items) => { items[0].mode = 'trigger'; },
    (items) => { items[0].outputTarget = 'other'; }, (items) => { items[1].keyframes[1].value = 0.9; },
    (items) => items.reverse(), (items) => { items[1].id = 'held'; }
  ]) {
    const changed = structuredClone(cues); patch(changed);
    assert.equal(h.scheduler.reconcile(changed), false);
    assert.equal(h.scheduler.events, events); assert.equal(h.scheduler.floats.get(1), active);
  }
  assert.equal(h.scheduler.reconcile(cues, { fps: 25 }), false);
  assert.equal(h.scheduler.reconcile(cues, { generation: 2 }), false);
  h.scheduler.config.PIANO_END_ACTION = 'layerclear';
  assert.equal(h.scheduler.reconcile(cues), false);
  assert.equal(h.sent.filter((event) => event.kind === 'piano-off').length, 0);
});

test('step interpolation holds left value until exact right point', () => {
  const h = harness([curve(0, 30, { interpolation: 'step',
    keyframes: [{ tFrame: 0, value: 0.2 }, { tFrame: 30, value: 0.8 }] })]);
  h.step(0); h.step(15); h.step(30);
  assert.equal(h.sent.find((event) => event.frame === 15).args[1], 0.2);
  assert.equal(h.sent.at(-1).args[1], 0.8);
});

test('reconcile snapshots detect in-place payload edits; active output retains original target snapshot', () => {
  const cue = piano(0, 30, { id: 'held', args: [1, Buffer.from([4, 5])], outputTarget: ['a'] });
  const h = harness([cue]); h.step(0);
  cue.outputTarget[0] = 'b'; cue.args[1][0] = 9;
  assert.equal(h.scheduler.reconcile([cue, trigger(5, { id: 'append' })]), false);
  h.step(30);
  assert.deepEqual(h.sent.at(-1).target, ['a']);
  assert.deepEqual(h.sent.at(-1).args, [0, Buffer.from([4, 5])]);
});

test('only marked captured endpoints align sub-frame rounding; intentional trims stay interpolated', () => {
  const cue = curve(0, 4, { keyframes: [{ dt: 0, value: 0.2 }, { dt: 180, value: 0.8 }] });
  const plain = harness([cue], { fps: 24 }); plain.step(0); plain.step(4);
  assert.ok(Math.abs(plain.sent.at(-1).args[1] - 0.7555555555555555) < 1e-12);
  const captured = harness([{ ...cue, preserveRecordedEndpoint: true }], { fps: 24 });
  captured.step(0); captured.step(4); assert.equal(captured.sent.at(-1).args[1], 0.8);
  assert.equal(cue.keyframes[1].dt, 180);
  const largeTrim = harness([{ ...cue, duration: 2, preserveRecordedEndpoint: true }], { fps: 24 });
  largeTrim.step(0); largeTrim.step(2); assert.ok(largeTrim.sent.at(-1).args[1] < 0.8);
});

test('real recorder non-frame-aligned captures retain exact first/last at 24/25/30fps', () => {
  for (const [fps, endMs] of [[24, 180], [25, 170], [30, 180]]) {
    const actions = [], epoch = 1700000000000;
    const recorder = new RecordingSession({ emit: (action) => actions.push(action) });
    recorder.start({ session: fps, anchorEpoch: epoch, anchorFrame: 0, fps });
    recorder.ingestOsc({ address: opacity, args: [0.2, 'actual'], t: epoch, seq: 1 });
    recorder.ingestOsc({ address: opacity, args: [0.8, 'actual'], t: epoch + endMs, seq: 2 });
    recorder.finish(epoch + endMs); recorder.tick(epoch + endMs + 1000);
    assert.equal(actions.length, 1);
    const action = actions[0];
    const h = harness([{ ...action, id: action.actionId, mode: action.kind, frame: action.startFrame,
      duration: action.durationFrames, preserveRecordedEndpoint: true }], { fps });
    h.scheduler.seek(0); h.step(0); h.step(action.durationFrames);
    assert.equal(h.sent[0].args[0], 0.2); assert.equal(h.sent.at(-1).args[0], 0.8);
    assert.equal(h.sent.at(-1).frame, action.durationFrames);
    assert.ok(action.keyframes.at(-1).dt * fps / 1000 > action.durationFrames);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
