#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const RecordingSession = require('../recording-session');
const { LaneAllocator } = require('../renderer/rec-engine');
const EPOCH = 1700000000000;
const clip = (n = 1) => `/composition/layers/1/clips/${n}/connect`;
const opacity = (n = 1) => `/composition/layers/${n}/video/opacity`;
let passed = 0;
let failed = 0;

function test(name, run) {
  try { run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
}

function harness(config = {}, options = {}) {
  const actions = [], mappings = [], warnings = [];
  const engine = new RecordingSession({ config, emit: (a) => actions.push(a),
    onMapping: (key, value) => mappings.push([key, value]), onWarning: (text) => warnings.push(text) });
  if (!options.idle) engine.start(Object.assign({ session: 'mock', fps: 30, anchorEpoch: EPOCH,
    anchorFrame: 100, mappings: [] }, options));
  return {
    engine, actions, mappings, warnings,
    osc(t, address = clip(), args = [1]) { return engine.ingestOsc({ t: EPOCH + t, address, args, seq: t }); },
    midi(kind, t, num = 60, value = 100, ch = 1, device) {
      return engine.midi({ kind, t: EPOCH + t, num, value, ch, device });
    },
    tick(t) { engine.tick(EPOCH + t); },
    finish(t) { engine.finish(EPOCH + t); },
    drain(t = 10000) { engine.finish(EPOCH + t); engine.tick(EPOCH + t + 1000); assert.equal(engine.isDrained(), true); }
  };
}

test('A1 inactive MIDI/OSC are dropped, input validation is side-effect free', () => {
  const h = harness({}, { idle: true });
  assert.equal(h.midi('noteOn', 0), false);
  assert.equal(h.osc(0), false);
  h.engine.start({ session: 1, fps: 30, anchorEpoch: EPOCH, anchorFrame: 0 });
  for (const event of [null, {}, { address: 'bad', args: [], t: EPOCH },
    { address: '/x', args: 'bad', t: EPOCH }, { address: '/x', args: [], t: NaN }]) {
    assert.equal(h.engine.ingestOsc(event), false);
  }
  assert.equal(h.engine.midi({ kind: 'cc', num: 128, ch: 1, value: 4, t: EPOCH }), false);
  assert.equal(h.midi('noteOff', 1), false);
  h.drain();
  assert.equal(h.actions.length, 0);
  assert.equal(h.osc(10001), false);
});

test('A pre-anchor OSC can match MIDI prewindow but never becomes direct, frames clamp at zero', () => {
  const h = harness({ RECORD_LATENCY_COMPENSATION_MS: 40 }, { anchorFrame: 0 });
  h.osc(-10, clip(1)); h.osc(-10, clip(2)); h.osc(-10, opacity(), [0.5]);
  h.midi('noteOn', 0); h.midi('noteOff', 10); h.drain(400);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].matched, true);
  assert.equal(h.actions[0].startFrame, 0);
});

for (const fps of [24, 25, 30]) {
  test(`A3 frozen epoch/frame/speed and subtractive latency at ${fps}fps`, () => {
    const config = { RECORD_LATENCY_COMPENSATION_MS: 40 };
    const h = harness(config, { fps, speed: 2, anchorFrame: 137 });
    config.RECORD_LATENCY_COMPENSATION_MS = 900;
    h.midi('noteOn', 1040);
    h.midi('noteOff', 1140);
    h.tick(1400);
    const a = h.actions[0];
    assert.equal(a.startFrame, 137 + fps * 2);
    assert.equal(a.startMs, EPOCH + 1040);
    assert.equal(a.durationFrames, fps);
    assert.equal(a.session, 'mock');
    assert.equal(a.actionId, a.id);
  });
}

for (const hold of [0, 100, 490, 500, 3000]) {
  test(`B classification and explicit duration at ${hold}ms`, () => {
    const h = harness();
    h.midi('noteOn', 0);
    h.midi('noteOff', hold);
    h.tick(hold + 151);
    assert.equal(h.actions.length, 1);
    const a = h.actions[0];
    assert.equal(a.kind, hold >= 500 ? 'piano' : 'trigger');
    assert.equal(a.durationFrames, hold >= 500 ? Math.round(hold * 30 / 1000) : 30);
    assert.equal(a.holdMs, hold);
    assert.equal(a.unassigned, true);
    assert.deepEqual(a.args, []);
    assert.equal(a.address, '');
  });
}

test('B repeated noteOn safely finalizes prior note exactly once', () => {
  const h = harness();
  h.midi('noteOn', 0);
  h.osc(10, clip(1));
  h.midi('noteOn', 100);
  h.osc(110, clip(2));
  h.midi('noteOff', 200);
  h.drain(300);
  assert.equal(h.actions.length, 2);
  assert.deepEqual(h.actions.map((a) => a.address), [clip(1), clip(2)]);
  assert.deepEqual(h.actions.map((a) => a.holdMs), [100, 100]);
  assert.equal(new Set(h.actions.map((a) => a.id)).size, 2);
});

test('B velocity zero is still noteOn; caller owns MIDI zero/off translation', () => {
  const h = harness();
  h.midi('noteOn', 0, 60, 0);
  h.finish(600);
  h.tick(1000);
  assert.equal(h.actions[0].vel, 0);
  assert.equal(h.actions[0].kind, 'piano');
});

test('B CC gestures split after idle, unmatched CC never fabricates OSC args', () => {
  const h = harness();
  h.midi('cc', 0, 42, 0);
  h.midi('cc', 100, 42, 127);
  h.midi('cc', 1000, 42, 64);
  h.tick(1400);
  assert.equal(h.actions.length, 2);
  assert.equal(h.actions[0].keyframes[0].value, 0);
  assert.equal(h.actions[0].keyframes.at(-1).value, 1);
  for (const a of h.actions) {
    assert.equal(a.dataOrigin, 'midi');
    assert.equal(a.unassigned, true);
    assert.equal(a.address, '');
    assert.deepEqual(a.args, []);
  }
});

test('C lane helper reuses triggers and separates overlapping pianos/floats', () => {
  const h = harness();
  h.midi('noteOn', 0); h.osc(10); h.midi('noteOff', 50);
  h.midi('noteOn', 500); h.osc(510, clip(2)); h.midi('noteOff', 600);
  h.midi('noteOn', 1000, 61); h.osc(1010, clip(3)); h.midi('noteOff', 2000, 61);
  h.midi('cc', 2300, 42, 0); h.midi('cc', 2400, 42, 127);
  h.drain(3000);
  assert.equal(h.actions[0].laneGroup, h.actions[1].laneGroup);
  assert.notEqual(h.actions[1].laneGroup, h.actions[2].laneGroup);
  assert.notEqual(h.actions[2].laneGroup, h.actions[3].laneGroup);
  const allocator = new LaneAllocator();
  allocator.remember(h.actions[0].laneGroup, 'R1');
  assert.equal(allocator.allocate(h.actions[1], [{ name: 'R1', cues: [] }]).laneName, 'R1');
});

test('D short release waits for late onset OSC and preserves full cloned args', () => {
  const h = harness();
  h.midi('noteOn', 0); h.midi('noteOff', 5); h.tick(10);
  assert.equal(h.actions.length, 0);
  const args = [1, 'Tiếng Việt', [2, { type: 'f', value: 0.75 }], Buffer.from([1, 2]), 5, 6, 7, 8, 9];
  h.osc(120, clip(), args);
  args[2][1].value = 999; args[3][0] = 99;
  h.tick(200);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].args.length, 9);
  assert.equal(h.actions[0].args[2][1].value, 0.75);
  assert.equal(h.actions[0].args[3][0], 1);
  assert.equal(h.actions[0].matchLatencyMs, 120);
});

for (const offset of [-20, -10, 0, 150, -21, 500]) {
  test(`D note onset window offset ${offset}ms, outside OSC stays independent`, () => {
    const h = harness();
    h.osc(1000 + offset);
    h.midi('noteOn', 1000); h.midi('noteOff', 1020);
    h.drain(2000);
    const midi = h.actions.find((a) => a.source === 'midi');
    assert.equal(midi.matched, offset >= -20 && offset <= 150);
    assert.equal(h.actions.filter((a) => a.source === 'osc').length, midi.matched ? 0 : 1);
  });
}

test('D three fast notes and three OSC use greedy event time despite reverse noteOff order', () => {
  const h = harness();
  for (let i = 0; i < 3; i++) h.midi('noteOn', i * 10, 60 + i);
  for (let i = 2; i >= 0; i--) h.osc(18 + i * 10, clip(i + 1));
  for (let i = 2; i >= 0; i--) h.midi('noteOff', 120 + (2 - i), 60 + i);
  h.drain(300);
  assert.equal(h.actions.length, 3);
  assert.deepEqual(h.actions.map((a) => a.address), [clip(1), clip(2), clip(3)]);
});

test('D selected alias is extra, independent concrete connect remains direct', () => {
  const h = harness();
  h.midi('noteOn', 0);
  h.osc(20, '/composition/selectedlayer/clips/1/connect');
  h.osc(21, clip(1)); h.osc(22, clip(2));
  h.midi('noteOff', 50); h.drain(200);
  const note = h.actions.find((a) => a.source === 'midi');
  assert.equal(note.address, clip(1));
  assert.equal(note.extras.length, 1);
  assert.equal(h.actions.length, 2);
  assert.equal(h.actions.find((a) => a.source === 'osc').address, clip(2));
});

test('D opacity cannot match a note; column and clear can', () => {
  for (const address of [opacity(), '/composition/columns/2/connect', '/composition/layers/1/clear']) {
    const h = harness();
    h.midi('noteOn', 0); h.osc(10, address); h.midi('noteOff', 50); h.drain(500);
    assert.equal(h.actions.find((a) => a.source === 'midi').matched, address !== opacity());
  }
});

test('D held note onset survives retention and consumes only associated connect0', () => {
  const h = harness({ OSC_BUFFER_SECONDS: 1 });
  h.midi('noteOn', 0); h.osc(10); h.tick(200);
  for (let t = 1000; t <= 7000; t += 1000) { h.osc(t, clip(2)); h.tick(t + 200); }
  h.midi('noteOff', 8000); h.osc(8010, clip(), [0]); h.osc(8011, clip(3), [0]);
  h.drain(8200);
  const a = h.actions.find((x) => x.source === 'midi');
  assert.equal(a.kind, 'piano');
  assert.equal(a.address, clip());
  assert.equal(a.extras.filter((x) => x.release).length, 1);
  assert.equal(h.actions.filter((x) => x.source === 'osc').length, 8);
  assert.equal(h.warnings.length, 0);
});

test('D OSC-only discrete waits cross-port grace, selected alias does not duplicate', () => {
  const h = harness();
  h.osc(0, '/composition/selectedlayer/clips/1/connect'); h.osc(1);
  h.tick(20); assert.equal(h.actions.length, 0);
  h.tick(60); assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].source, 'osc');
  assert.equal(h.actions[0].address, clip());
  assert.equal(h.actions[0].durationFrames, 30);
  assert.equal(h.actions[0].extras.length, 1);
});

test('D late cross-port MIDI timestamp matches OSC before direct grace expires', () => {
  const h = harness();
  h.osc(0); h.tick(25); h.midi('noteOn', 10); h.midi('noteOff', 20); h.tick(200);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].source, 'midi');
  assert.equal(h.actions[0].matchLatencyMs, -10);
});

test('D float curve is complete actual OSC, endpoints not replaced by CC', () => {
  const h = harness();
  h.midi('cc', 0, 42, 0); h.midi('cc', 100, 42, 64); h.midi('cc', 200, 42, 127);
  for (let i = 0; i <= 20; i++) h.osc(i * 10 + 5, opacity(), [0.4488 + i / 20 * (0.6142 - 0.4488), 'preserved']);
  h.drain(600);
  assert.equal(h.actions.length, 1);
  const a = h.actions[0];
  assert.equal(a.dataOrigin, 'osc');
  assert.equal(a.keyframes[0].value, 0.4488);
  assert.equal(a.keyframes.at(-1).value, 0.6142);
  assert.equal(a.keyframes.at(-1).dt, 205);
  assert.equal(a.keyframesRaw, 21);
  assert.equal(a.keyframesSent, 2);
  assert.deepEqual(a.args, [0.6142, 'preserved']);
});

test('D correlation beats high message count and supports inverse OSC mapping', () => {
  const h = harness();
  const values = [0, 1, 0.25, 0.8, 0.1];
  for (let i = 0; i < values.length; i++) {
    h.midi('cc', i * 100, 42, values[i] * 127);
    h.osc(i * 100 + 3, opacity(1), [1 - values[i]]);
    for (let j = 0; j < 10; j++) h.osc(i * 100 + j, opacity(2), [0.5]);
  }
  h.drain(800);
  const a = h.actions.find((x) => x.source === 'midi');
  assert.equal(a.address, opacity(1));
  assert.equal(a.keyframes[0].value, 1);
  assert.equal(h.actions.filter((x) => x.address === opacity(1)).length, 1);
  assert.equal(h.actions.filter((x) => x.source === 'osc').length, 1);
});

test('D simultaneous independent CC gestures match 1:1 addresses', () => {
  const h = harness();
  const a = [0, 1, 0, 1, 0.2], b = [0, 0.25, 1, 0.5, 0.7];
  for (let i = 0; i < a.length; i++) {
    h.midi('cc', i * 100, 42, a[i] * 127); h.midi('cc', i * 100, 43, b[i] * 127);
    h.osc(i * 100 + 2, opacity(1), [a[i]]); h.osc(i * 100 + 4, opacity(2), [b[i]]);
  }
  h.drain(800);
  assert.equal(h.actions.length, 2);
  assert.deepEqual(h.actions.map((x) => [x.num, x.address]), [[42, opacity(1)], [43, opacity(2)]]);
});

for (const lag of [-20, 90, 100, 140, 150]) {
  test(`D CC correlation aligns causal OSC lag ${lag}ms without replacing the actual curve`, () => {
    const h = harness();
    const values = [0, 1, 0.25, 0.8, 0.1];
    for (let i = 0; i < values.length; i++) {
      h.midi('cc', 100 + i * 100, 42, values[i] * 127);
      h.osc(100 + i * 100 + lag, opacity(), [0.2 + 0.5 * values[i], 'actual']);
    }
    h.drain(1000);
    assert.equal(h.actions.length, 1);
    const a = h.actions[0];
    assert.equal(a.matched, true);
    assert.equal(a.matchLatencyMs, lag);
    assert.equal(a.keyframes[0].value, 0.2);
    assert.equal(a.keyframes.at(-1).value, 0.25);
    assert.equal(a.keyframes.at(-1).t, EPOCH + 500 + lag);
    assert.deepEqual(a.args, [0.25, 'actual']);
  });
}

test('D late selected onset alias is consumed after primary resolved, independent actions remain', () => {
  const h = harness();
  h.midi('noteOn', 0); h.osc(140); h.tick(150);
  assert.equal(h.engine.notes[0].primary.address, clip());
  h.osc(149, '/composition/selectedlayer/clips/1/connect');
  h.osc(149, clip(2));
  h.osc(149, '/composition/selectedlayer/clips/2/connect');
  h.tick(200); h.midi('noteOff', 600); h.drain(700);
  const note = h.actions.find((a) => a.source === 'midi');
  assert.equal(h.actions.length, 2);
  assert.equal(note.extras.length, 1);
  assert.equal(note.extras[0].address, '/composition/selectedlayer/clips/1/connect');
  assert.equal(h.actions.find((a) => a.source === 'osc').address, clip(2));
});

test('D late selected packets outside alias window or with different value remain independent', () => {
  const h = harness();
  h.midi('noteOn', 0); h.osc(140); h.tick(150);
  h.osc(149, '/composition/selectedlayer/clips/1/connect', [0]);
  h.osc(151, '/composition/selectedlayer/clips/1/connect', [1]);
  h.tick(220); h.midi('noteOff', 600); h.drain(700);
  assert.equal(h.actions.length, 3);
  assert.equal(h.actions.find((a) => a.source === 'midi').extras.length, 0);
});

test('D delayed simultaneous CC gestures keep separate OSC ownership', () => {
  const h = harness();
  const a = [0, 1, 0, 1, 0.2], b = [0, 0.25, 1, 0.5, 0.7];
  for (let i = 0; i < a.length; i++) {
    h.midi('cc', i * 100, 42, a[i] * 127); h.midi('cc', i * 100, 43, b[i] * 127);
    h.osc(i * 100 + 90, opacity(1), [0.2 + 0.5 * a[i]]);
    h.osc(i * 100 + 140, opacity(2), [0.1 + 0.8 * b[i]]);
  }
  h.drain(1000);
  assert.equal(h.actions.length, 2);
  assert.deepEqual(h.actions.map((a) => [a.num, a.address]), [[42, opacity(1)], [43, opacity(2)]]);
  assert.equal(h.actions.reduce((n, a) => n + a.keyframesRaw, 0), 10);
});

test('D CC OSC beyond the causal window is not rescued by lag alignment', () => {
  const h = harness();
  const values = [0, 1, 0.25, 0.8, 0.1];
  for (let i = 0; i < values.length; i++) {
    h.midi('cc', i * 100, 42, values[i] * 127);
    h.osc(i * 100 + 500, opacity(), [0.2 + 0.5 * values[i]]);
  }
  h.drain(1500);
  assert.equal(h.actions.filter((a) => a.source === 'midi')[0].matched, false);
  assert.equal(h.actions.filter((a) => a.source === 'osc').length, 1);
});

test('D scoring sample/lag caps do not truncate the emitted OSC curve', () => {
  const h = harness({ FLOAT_MATCH_MAX_SAMPLES: 8, FLOAT_MATCH_MAX_LAGS: 8 });
  for (let i = 0; i < 200; i++) {
    const value = ((i * 17) % 101) / 100;
    h.midi('cc', i * 10, 42, value * 127);
    h.osc(i * 10 + 90, opacity(), [0.2 + 0.5 * value]);
  }
  h.drain(2500);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].matched, true);
  assert.equal(h.actions[0].keyframesRaw, 200);
  assert.equal(h.actions[0].keyframes[0].t, EPOCH + 90);
  assert.equal(h.actions[0].keyframes.at(-1).t, EPOCH + 2080);
});

test('D consumed float samples are not counted again in a remaining direct segment', () => {
  const h = harness();
  h.midi('cc', 0, 42, 0); h.midi('cc', 100, 42, 127);
  h.osc(5, opacity(), [0.2]); h.osc(105, opacity(), [0.8]); h.osc(300, opacity(), [0.4]);
  h.tick(450);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].keyframesRaw, 2);
  h.tick(650);
  assert.equal(h.actions.length, 2);
  assert.equal(h.actions[1].keyframesRaw, 1);
  assert.equal(h.actions.reduce((n, a) => n + a.keyframesRaw, 0), 3);
});

test('G cutoff removes future OSC and MIDI samples from raw keyframe counts', () => {
  const h = harness();
  for (const t of [0, 100, 200, 300, 400]) h.osc(t, opacity(), [t / 500]);
  h.finish(200); h.tick(600);
  assert.equal(h.actions[0].keyframesRaw, 3);
  const m = harness();
  m.midi('cc', 0, 42, 0); m.midi('cc', 100, 42, 64); m.midi('cc', 300, 42, 127);
  m.finish(200); m.tick(600);
  assert.equal(m.actions[0].keyframesRaw, 2);
});

test('D equal-score independent float addresses are unassigned, not guessed', () => {
  const h = harness();
  for (let i = 0; i < 4; i++) {
    h.midi('cc', i * 100, 42, i * 40);
    h.osc(i * 100 + 2, opacity(1), [i / 3]); h.osc(i * 100 + 2, opacity(2), [1 - i / 3]);
  }
  h.drain(800);
  const a = h.actions.find((x) => x.source === 'midi');
  assert.equal(a.unassigned, true);
  assert.equal(a.matched, false);
  assert.deepEqual(a.args, []);
  assert.equal(h.actions.filter((x) => x.source === 'osc').length, 2);
});

test('D one OSC address contested equally by simultaneous CC is not stolen', () => {
  const h = harness();
  for (let i = 0; i < 4; i++) {
    h.midi('cc', i * 100, 42, i * 40); h.midi('cc', i * 100, 43, i * 40);
    h.osc(i * 100 + 2, opacity(), [i / 3]);
  }
  h.drain(800);
  assert.equal(h.actions.filter((x) => x.source === 'midi' && x.unassigned).length, 2);
  assert.equal(h.actions.filter((x) => x.source === 'osc').length, 1);
});

test('D selected float aliases become extras, no separate direct action', () => {
  const h = harness();
  for (let i = 0; i < 4; i++) {
    h.midi('cc', i * 100, 42, i * 40);
    h.osc(i * 100 + 2, '/composition/selectedlayer/video/opacity', [i / 3]);
    h.osc(i * 100 + 3, opacity(), [i / 3]);
  }
  h.drain(800);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].address, opacity());
  assert.equal(h.actions[0].extras.length, 4);
});

test('D OSC-only float selects concrete address even if selected alias arrived first', () => {
  const h = harness();
  for (let i = 0; i < 4; i++) {
    h.osc(i * 100, '/composition/selectedlayer/video/opacity', [i / 3]);
    h.osc(i * 100 + 1, opacity(), [i / 3]);
  }
  h.drain(800);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].address, opacity());
  assert.equal(h.actions[0].extras.length, 4);
});

test('D non-normalized custom integer OSC is direct trigger with unchanged args', () => {
  const h = harness();
  h.osc(0, '/custom/action', [42, 'payload']);
  h.drain(100);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].kind, 'trigger');
  assert.deepEqual(h.actions[0].args, [42, 'payload']);
});

test('D direct OSC float grouping/idle/RDP keeps actual first/last endpoints', () => {
  const h = harness();
  for (let i = 0; i < 30; i++) h.osc(i * 20, opacity(), [0.2 + i / 29 * 0.5]);
  h.tick(879); assert.equal(h.actions.length, 0);
  h.tick(920); assert.equal(h.actions.length, 1);
  const a = h.actions[0];
  assert.equal(a.source, 'osc'); assert.equal(a.kind, 'float');
  assert.equal(a.keyframes[0].value, 0.2); assert.equal(a.keyframes.at(-1).value, 0.7);
  assert.equal(a.keyframes.at(-1).dt, 580);
  assert.equal(a.keyframesRaw, 30); assert.equal(a.keyframesSent, 2);
  h.osc(1500, opacity(), [0.9]); h.drain(1600);
  assert.equal(h.actions.length, 2);
});

test('E learned fallback copies exact args and never relearns guessed values', () => {
  const mapping = { address: clip(3), args: [0.37, 'cached'], kind: 'trigger' };
  const h = harness({}, { mappings: [['n60c1', mapping]] });
  mapping.args[0] = 9;
  h.midi('noteOn', 0); h.midi('noteOff', 10); h.drain(200);
  assert.deepEqual(h.actions[0].args, [0.37, 'cached']);
  assert.equal(h.actions[0].guessed, true); assert.equal(h.actions[0].matched, false);
  assert.equal(h.mappings.length, 0);
});

test('E real OSC changes mapping; subsequent fallback uses new actual args', () => {
  const h = harness({}, { mappings: [['n60c1', { address: clip(1), args: [1] }]] });
  h.midi('noteOn', 0); h.osc(10, clip(2), [0.8, 7]); h.midi('noteOff', 50); h.tick(300);
  h.midi('noteOn', 500); h.midi('noteOff', 550); h.drain(800);
  assert.equal(h.mappings.length, 1);
  assert.deepEqual(h.mappings[0], ['n60c1', { address: clip(2), args: [0.8, 7], kind: 'trigger' }]);
  assert.deepEqual(h.actions[1].args, [0.8, 7]); assert.equal(h.actions[1].guessed, true);
});

test('E float fallback is MIDI display curve, never cached-address fabricated OSC curve', () => {
  const h = harness({}, { mappings: [['cc42c1', { address: opacity(), args: [0.37, 'cached'] }]] });
  h.midi('cc', 0, 42, 0); h.midi('cc', 100, 42, 127); h.drain(500);
  const a = h.actions[0];
  assert.equal(a.guessed, true); assert.equal(a.dataOrigin, 'midi');
  assert.deepEqual(a.args, [0.37, 'cached']);
  assert.deepEqual(a.keyframes.map((k) => k.value), [0, 1]);
  assert.equal(h.mappings.length, 0);
});

test('E optional device separates equal notes on different MIDI inputs', () => {
  const h = harness();
  h.midi('noteOn', 0, 60, 10, 1, 'a'); h.midi('noteOn', 10, 60, 20, 1, 'b');
  h.osc(20, clip(1)); h.osc(30, clip(2));
  h.midi('noteOff', 100, 60, 0, 1, 'b'); h.midi('noteOff', 110, 60, 0, 1, 'a');
  h.drain(300);
  assert.equal(h.actions.length, 2); assert.equal(h.mappings[0][0], 'a|n60c1');
  assert.equal(h.mappings[1][0], 'b|n60c1');
});

for (const intermediateTick of [false, true]) {
  test(`G finish waits for late pre-cutoff note OSC${intermediateTick ? ' after intermediate tick' : ''}`, () => {
    const h = harness();
    h.midi('noteOn', 0); h.midi('noteOff', 10);
    h.finish(600);
    assert.equal(h.actions.length, 0);
    assert.equal(h.engine.isDrained(), false);
    if (intermediateTick) {
      h.tick(800);
      assert.equal(h.actions.length, 0);
    }
    assert.equal(h.osc(10), true);
    h.tick(929);
    assert.equal(h.actions.length, 0);
    assert.equal(h.engine.isDrained(), false);
    h.tick(930); h.tick(1000);
    assert.equal(h.actions.length, 1);
    assert.equal(h.actions[0].source, 'midi');
    assert.equal(h.actions[0].matched, true);
    assert.equal(h.actions[0].address, clip());
    assert.equal(h.engine.isDrained(), true);
  });

  test(`G finish waits for late pre-cutoff CC OSC${intermediateTick ? ' after intermediate tick' : ''}`, () => {
    const h = harness();
    h.midi('cc', 0, 42, 0); h.midi('cc', 100, 42, 127);
    h.finish(600);
    assert.equal(h.actions.length, 0);
    if (intermediateTick) {
      h.tick(800);
      assert.equal(h.actions.length, 0);
    }
    assert.equal(h.osc(10, opacity(), [0.25]), true);
    assert.equal(h.osc(110, opacity(), [0.75]), true);
    h.tick(929);
    assert.equal(h.actions.length, 0);
    h.tick(930); h.tick(1000);
    assert.equal(h.actions.length, 1);
    assert.equal(h.actions[0].source, 'midi');
    assert.equal(h.actions[0].matched, true);
    assert.equal(h.actions[0].keyframes[0].value, 0.25);
    assert.equal(h.actions[0].keyframes.at(-1).value, 0.75);
    assert.equal(h.engine.isDrained(), true);
  });
}

test('G finish retries a pending note previously resolved without onset OSC', () => {
  const h = harness();
  h.midi('noteOn', 0); h.tick(200);
  assert.equal(h.engine.notes[0].resolved, true);
  h.midi('noteOff', 500); h.finish(600); h.tick(800);
  assert.equal(h.actions.length, 0);
  assert.equal(h.osc(10), true);
  h.tick(1000);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].matched, true);
  assert.equal(h.actions[0].address, clip());
  assert.equal(h.engine.isDrained(), true);
});

test('G finish keeps a contiguous CC gesture open for late pre-cutoff MIDI', () => {
  const h = harness();
  h.midi('cc', 0, 42, 0); h.midi('cc', 100, 42, 64); h.tick(350);
  h.finish(400); h.tick(500);
  assert.equal(h.actions.length, 0);
  assert.equal(h.midi('cc', 390, 42, 127), true);
  h.tick(800);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].endMs, EPOCH + 390);
  assert.equal(h.actions[0].keyframes.at(-1).value, 1);
  assert.equal(h.engine.isDrained(), true);
});

test('G late pre-cutoff CC extends one matched gesture with all actual OSC samples', () => {
  const h = harness();
  h.midi('cc', 0, 42, 0); h.midi('cc', 100, 42, 64); h.tick(350);
  h.finish(400); h.tick(500);
  h.midi('cc', 390, 42, 127);
  h.osc(10, opacity(), [0.2]); h.osc(110, opacity(), [0.6]); h.osc(400, opacity(), [0.9]);
  h.tick(800);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].matched, true);
  assert.equal(h.actions[0].keyframesRaw, 3);
  assert.equal(h.actions[0].keyframes.at(-1).value, 0.9);
  assert.equal(h.engine.isDrained(), true);
});

test('G finish held notes/CC, allows late pre-cutoff MIDI and OSC, ignores future direct', () => {
  const h = harness();
  h.midi('noteOn', 0); h.osc(10); h.midi('cc', 0, 42, 0); h.midi('cc', 100, 42, 127);
  h.osc(0, opacity(), [0.2]); h.osc(100, opacity(), [0.7]);
  h.finish(600);
  assert.equal(h.engine.isDrained(), false);
  assert.equal(h.midi('noteOn', 550, 61), true); h.osc(620, clip(2));
  assert.equal(h.midi('noteOn', 601, 62), false);
  h.osc(650, clip(3));
  h.tick(1000);
  assert.equal(h.engine.isDrained(), true);
  assert.equal(h.actions.filter((a) => a.source === 'midi').length, 3);
  assert.equal(h.actions.some((a) => a.source === 'osc' && a.startMs > EPOCH + 600), false);
  const note = h.actions.find((a) => a.num === 60);
  assert.equal(note.holdMs, 600);
  assert.equal(h.actions.find((a) => a.num === 61).address, clip(2));
});

test('G finish post-cutoff OSC can match a pending float before maturation', () => {
  const h = harness();
  h.midi('cc', 0, 42, 0); h.midi('cc', 100, 42, 127);
  h.finish(100);
  h.osc(20, opacity(), [0.2]); h.osc(120, opacity(), [0.7]);
  h.tick(200); h.tick(500);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].matched, true);
  assert.equal(h.actions[0].keyframes.at(-1).value, 0.7);
  assert.equal(h.engine.isDrained(), true);
});

test('G finish trims already-ingested future MIDI samples and notes', () => {
  const h = harness();
  h.midi('noteOn', 10); h.midi('noteOff', 900);
  h.midi('noteOn', 800, 61);
  h.midi('cc', 0, 42, 0); h.midi('cc', 100, 42, 64); h.midi('cc', 900, 42, 127);
  h.finish(600); h.tick(1100);
  assert.equal(h.actions.length, 2);
  assert.equal(h.actions.find((a) => a.num === 60).endMs, EPOCH + 600);
  assert.equal(h.actions.find((a) => a.num === 42).endMs, EPOCH + 100);
  assert.equal(h.engine.isDrained(), true);
});

test('G long float retains initial OSC/CC past buffer expiry within point cap', () => {
  const h = harness({ OSC_BUFFER_SECONDS: 1, FLOAT_MAX_POINTS: 1000 });
  for (let i = 0; i < 80; i++) {
    h.midi('cc', i * 100, 42, (i % 11) * 12);
    h.osc(i * 100 + 5, opacity(), [0.2 + (i % 11) * 0.05]);
    h.tick(i * 100 + 10);
  }
  h.drain(8100);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].matched, true);
  assert.equal(h.actions[0].keyframes[0].value, 0.2);
  assert.equal(h.actions[0].keyframesRaw, 80);
});

test('G point cap warns and preserves exact endpoints for long direct float', () => {
  const h = harness({ FLOAT_MAX_POINTS: 8, OSC_RING_CAPACITY: 50 });
  for (let i = 0; i < 100; i++) h.osc(i * 10, opacity(), [i / 99]);
  assert.ok(h.engine.streams[0].points.length <= 8);
  const retained = h.engine.streams[0].points.length;
  h.drain(1100);
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].keyframes[0].value, 0);
  assert.equal(h.actions[0].keyframes.at(-1).value, 1);
  assert.equal(h.actions[0].keyframesRaw, retained);
  assert.equal(h.warnings.length, 1);
});

test('G hard OSC cap/time retention, abort report and restart isolation', () => {
  const h = harness({ OSC_RING_CAPACITY: 16, OSC_BUFFER_SECONDS: 1 });
  for (let i = 0; i < 100; i++) h.osc(i, clip(i + 1));
  assert.ok(h.engine.osc.length <= 16); assert.ok(h.warnings.length > 0);
  h.osc(5000, clip(200)); assert.equal(h.engine.osc.length, 1);
  h.midi('noteOn', 5001);
  const report = h.engine.abort('mock failure');
  assert.equal(report.notes, 1); assert.equal(report.unmatched.length, 1);
  assert.equal(h.engine.isDrained(), true);
  h.engine.start({ session: 'next', fps: 25, anchorEpoch: EPOCH + 6000, anchorFrame: 0 });
  h.midi('noteOn', 6000); h.midi('noteOff', 6050); h.drain(6200);
  assert.equal(h.actions.at(-1).session, 'next'); assert.equal(h.actions.at(-1).address, '');
});

test('G bounded pending MIDI overflow explicitly warns but emits each note once', () => {
  const h = harness({ OSC_PENDING_MIDI_MAX: 4 });
  for (let i = 0; i < 20; i++) h.midi('noteOn', i, i);
  assert.ok(h.engine.notes.length <= 4);
  h.drain(1000);
  assert.equal(h.actions.length, 20); assert.equal(new Set(h.actions.map((a) => a.id)).size, 20);
  assert.ok(h.warnings.some((w) => w.includes('MIDI capacity')));
});

test('G 2000 rapid mock notes plus OSC no duplicates, no unbounded retained state', () => {
  const h = harness();
  for (let i = 0; i < 2000; i++) {
    const t = i * 10;
    h.midi('noteOn', t, i % 100); h.osc(t + 2, clip(i % 20 + 1));
    h.midi('noteOff', t + 5, i % 100); h.tick(t + 6);
  }
  h.drain(21000);
  assert.equal(h.actions.length, 2000);
  assert.ok(h.actions.every((a) => a.source === 'midi' && a.matched));
  assert.equal(h.engine.osc.length, 0); assert.equal(h.engine.streams.length, 0);
  assert.equal(h.engine.activeNotes.size, 0); assert.equal(h.engine.activeFloats.size, 0);
});

console.log(`\nRecordingSession: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
