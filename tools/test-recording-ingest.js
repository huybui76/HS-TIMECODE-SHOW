#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const osc = require('osc');
const CFG = require('../realtime-config');
const source = fs.readFileSync(path.join(__dirname, '..', 'osc-ingest.js'), 'utf8');
const EPOCH = 1700000000000;
const CONNECT = '/composition/layers/1/clips/1/connect';
const OPACITY = '/composition/layers/1/video/opacity';
const SETTLE = CFG.MATCH_PRE_MS + CFG.REC_DIRECT_GRACE_MS + CFG.OSC_MAINTENANCE_MS;
const DRAIN = Math.max(CFG.MATCH_WINDOW_MS, CFG.FLOAT_IDLE_TIMEOUT_MS) +
  CFG.REC_DIRECT_GRACE_MS + CFG.OSC_MAINTENANCE_MS;
const packet = (address, args) => Buffer.from(osc.writePacket({ address,
  args: args.map((arg) => arg === null ? { type: 'N', value: null } : arg) }));
let mocks = [];

function harness({ bind = true } = {}) {
  let now = EPOCH;
  let nextTimer = 0;
  const sockets = [];
  const timers = new Map();
  const out = [];
  const exits = [];
  const processMock = new EventEmitter();
  processMock.exit = (code) => exits.push(code);
  const port = new EventEmitter();
  port.start = () => {};
  port.close = () => {};
  port.postMessage = (message) => out.push(structuredClone(message));
  const clearTimer = (id) => timers.delete(id);
  const addTimer = (fn, ms, interval) => {
    assert.ok(Number.isFinite(ms) && ms > 0, 'fake timers require a positive delay');
    const id = ++nextTimer;
    timers.set(id, { fn, at: now + ms, interval });
    return id;
  };
  const context = vm.createContext({
    Buffer, console, process: processMock, module: { exports: {} },
    require(name) {
      if (name === 'node:perf_hooks') return {
        performance: { timeOrigin: EPOCH, now: () => now - EPOCH },
        monitorEventLoopDelay: () => ({ enable() {}, disable() {}, reset() {},
          percentile: () => 0, mean: 0, max: 0 })
      };
      if (name === 'node:dgram') return { createSocket() {
        const socket = new EventEmitter();
        socket.bind = (settings) => { socket.port = settings.port; socket.emit('listening'); };
        socket.close = () => { socket.closed = true; };
        socket.address = () => ({ port: socket.port });
        socket.setRecvBufferSize = (bytes) => { socket.recvBuffer = bytes; };
        socket.getRecvBufferSize = () => socket.recvBuffer;
        sockets.push(socket);
        return socket;
      } };
      // In particular, ./recording-session is the real module, not a test double.
      return name.startsWith('./') ? require(path.join(__dirname, '..', name)) : require(name);
    },
    setTimeout: (fn, ms) => addTimer(fn, ms, 0), clearTimeout: clearTimer,
    setInterval: (fn, ms) => addTimer(fn, ms, ms), clearInterval: clearTimer
  });
  const api = vm.runInContext(source + `\n;({ onPacket, handleMessage, updateStats,
    state: () => ({ recorder, recSession, recCutoff, actionQueue, actionBytes,
      actionInFlight, pendingMappings, queueCount, queueBytes, filter, stats, echoTokens }) })`, context,
  { filename: 'osc-ingest.js' });
  const send = (message) => port.emit('message', { data: message });
  api.handleMessage({ type: 'init', port });
  const receivePacket = (buffer) => {
    assert.ok(sockets.length && !sockets.at(-1).closed, 'fake UDP must be bound before receiving');
    sockets.at(-1).emit('message', buffer);
  };
  const h = {
    out, exits, sockets, send, state: api.state, now: () => now,
    messages: (type) => out.filter((m) => m.type === type),
    actions: () => out.filter((m) => m.type === 'recordActions').flatMap((m) => m.items),
    events: () => out.filter((m) => m.type === 'eventBatch').flatMap((m) => m.items),
    receive: (address = CONNECT, args = [1]) => receivePacket(packet(address, args)),
    receivePacket,
    bind() { send({ type: 'setPort', port: 17000 }); },
    start(session = 'session-1', options = {}) {
      send({ type: 'recStart', session, fps: 25, anchorEpoch: EPOCH, anchorFrame: 250,
        speed: 1, mappings: [], ...options });
    },
    midi(kind, options = {}, session = 'session-1') {
      send({ type: 'recMidi', session, event: { kind, num: 60, ch: 1, value: 100,
        t: now, ...options } });
    },
    stop(session = 'session-1') { send({ type: 'recStop', session, cutoff: now }); },
    ack(batch) { send({ type: 'recordAck', session: batch.session, batchId: batch.batchId }); },
    advance(ms) {
      assert.ok(Number.isFinite(ms) && ms >= 0);
      const end = now + ms;
      let callbacks = 0;
      for (;;) {
        const entry = [...timers].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!entry) break;
        assert.ok(++callbacks < 100000, 'fake timer runaway');
        const [id, timer] = entry;
        now = timer.at;
        if (timer.interval) timer.at += timer.interval;
        else timers.delete(id);
        timer.fn();
      }
      now = end;
    },
    crash() { processMock.emit('uncaughtException', new Error('mock utility crash')); },
    dispose() {
      send({ type: 'closePort' });
      timers.clear();
      for (const socket of sockets) {
        assert.equal(socket.closed, true);
        socket.removeAllListeners();
      }
      port.removeAllListeners();
      processMock.removeAllListeners();
      assert.equal(timers.size, 0, 'no timer handles survive the mock');
    }
  };
  mocks.push(h);
  if (bind) h.bind();
  return h;
}

let passed = 0;
let failed = 0;
function test(name, run) {
  mocks = [];
  try { run(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
  finally {
    for (const h of mocks) {
      try { h.dispose(); }
      catch (error) { failed++; console.error(`FAIL mock cleanup\n${error.stack}`); }
    }
  }
}

function assertBatchIdentity(h, session) {
  const batches = h.messages('recordActions');
  assert.ok(batches.length > 0);
  assert.equal(new Set(batches.map((b) => b.batchId)).size, batches.length);
  const actions = h.actions();
  assert.equal(new Set(actions.map((a) => a.id)).size, actions.length);
  for (const b of batches) {
    assert.equal(b.session, session);
    assert.ok(Number.isInteger(b.batchId) && b.batchId > 0);
    assert.ok(b.items.length > 0 && b.items.length <= CFG.REC_ACTION_BATCH_SIZE);
    assert.ok(Array.isArray(b.mappings) && b.mappings.length <= CFG.REC_ACTION_BATCH_SIZE);
    assert.equal(new Set(b.mappings.map(([key]) => key)).size, b.mappings.length);
    for (const a of b.items) {
      assert.equal(a.session, session);
      assert.ok(Number.isInteger(a.id) && a.id > 0);
      assert.equal(a.actionId, a.id);
    }
  }
}

test('REC without UDP is rejected; fake bind/readiness permits recording without network', () => {
  const h = harness({ bind: false });
  h.start();
  assert.equal(h.state().recorder, null);
  assert.equal(h.state().recSession, null);
  assert.equal(h.messages('recordRejected').length, 1);
  assert.equal(h.messages('recordRejected')[0].session, 'session-1');
  assert.match(h.messages('recordRejected')[0].text, /not listening/i);
  assert.equal(h.messages('recordWarning').length, 0);
  h.bind();
  assert.equal(h.sockets[0].recvBuffer, 8 * 1024 * 1024);
  assert.equal(h.messages('ready').length, 1);
  assert.equal(h.messages('ready')[0].recvBuf.actual, CFG.OSC_RECV_BUFFER_BYTES);
  h.start(); h.receive(); h.advance(SETTLE);
  assert.equal(h.actions().length, 1);
  assert.equal(h.state().recSession, 'session-1');
  assert.equal(h.messages('recordRejected').length, 1);
});

test('default whitelist records allowed connects but never unknown or hard-blocked paths', () => {
  const h = harness(); h.start();
  for (const address of [OPACITY, '/composition/layers/1/position',
    '/composition/layers/1/video/source/textgenerator/opacity', '/sys/ping']) h.receive(address, [0.5]);
  h.receive(); h.advance(SETTLE);
  assert.deepEqual(h.actions().map((a) => a.address), [CONNECT]);
  assert.equal(h.state().stats.msgFiltered, 4);
  assert.equal(h.state().stats.malformed, 0);
  assert.equal(h.state().filter.learning, false);
});

test('MIDI note plus parsed OSC produces one anchored action with every real argument', () => {
  const h = harness(); h.start();
  h.send({ type: 'learn', on: true });
  h.advance(1000);
  const args = [1, 'Ti\u1ebfng Vi\u1ec7t', 0.5, true, false, null, 2, 3, 4, 5, 6, 7,
    [0.25, 'nested'], new Uint8Array([1, 2, 255])];
  const onset = h.now();
  h.midi('noteOn'); h.advance(5); h.receive(CONNECT, args);
  h.advance(35); h.midi('noteOff', { value: 0 });
  h.advance(CFG.MATCH_WINDOW_MS - 1);
  assert.equal(h.actions().length, 0, 'noteOff still waits for the match window');
  h.advance(CFG.OSC_MAINTENANCE_MS + 1);
  assert.equal(h.actions().length, 1);
  const a = h.actions()[0];
  assert.equal(a.source, 'midi'); assert.equal(a.matched, true);
  assert.equal(a.unassigned, false); assert.equal(a.address, CONNECT);
  assert.equal(a.startMs, onset); assert.equal(a.startFrame, 275);
  assert.equal(a.durationFrames, 25); assert.equal(a.matchLatencyMs, 5);
  assert.deepEqual(a.args, args);
  assert.deepEqual(h.events().map((e) => e.args), [args]);
  assert.equal(h.events()[0].t, onset + 5);
  assert.equal(h.events()[0].record, false, 'raw learn delivery is not a second recording path');
  assert.equal(h.messages('recordMapping').length, 0);
  assert.deepEqual(h.messages('recordActions').flatMap((b) => b.mappings),
    [['n60c1', { address: CONNECT, args, kind: 'trigger' }]]);
  assertBatchIdentity(h, 'session-1');
  h.advance(1000);
  for (const b of h.messages('eventBatch')) h.send({ type: 'eventAck', id: b.id });
  assert.equal(h.actions().length, 1, 'raw feed ACK cannot create another recorded action');
  h.stop(); h.advance(DRAIN);
  assert.equal(h.messages('recordDrained').length, 0);
  h.ack(h.messages('recordActions')[0]);
  assert.equal(h.messages('recordDrained').length, 1);
});

test('OSC-only click is a one-second trigger; unmatched MIDI has no fabricated address', () => {
  const h = harness(); h.start();
  h.receive(CONNECT, [1, 'direct']); h.advance(SETTLE);
  h.midi('noteOn', { num: 61 }); h.advance(40); h.midi('noteOff', { num: 61, value: 0 });
  h.advance(CFG.MATCH_WINDOW_MS + CFG.OSC_MAINTENANCE_MS);
  assert.equal(h.actions().length, 2);
  const [direct, note] = h.actions();
  assert.equal(direct.source, 'osc'); assert.equal(direct.kind, 'trigger');
  assert.equal(direct.durationFrames, 25); assert.deepEqual(direct.args, [1, 'direct']);
  assert.equal(note.source, 'midi'); assert.equal(note.num, 61);
  assert.equal(note.unassigned, true); assert.equal(note.matched, false);
  assert.equal(note.address, ''); assert.deepEqual(note.args, []);
  assertBatchIdentity(h, 'session-1');
});

test('CC opens scoped discovery before unknown opacity and records actual OSC endpoints', () => {
  const h = harness(); h.start();
  const midiValues = [0, 64, 127];
  const actualValues = [0.25, 0.5, 0.75];
  for (let i = 0; i < 3; i++) {
    if (i) h.advance(100);
    h.midi('cc', { num: 42, value: midiValues[i] });
    assert.equal(h.state().filter.learning, true);
    h.advance(5); h.receive(OPACITY, [actualValues[i], 'actual', 7]);
    h.receive('/composition/layers/1/video/source/textgenerator/opacity', [actualValues[i]]);
  }
  h.advance(CFG.FLOAT_IDLE_TIMEOUT_MS + CFG.OSC_MAINTENANCE_MS);
  assert.equal(h.actions().length, 1);
  const a = h.actions()[0];
  assert.equal(a.kind, 'float'); assert.equal(a.source, 'midi');
  assert.equal(a.matched, true); assert.equal(a.address, OPACITY);
  assert.equal(a.dataOrigin, 'osc'); assert.equal(a.unassigned, false);
  assert.equal(a.keyframesRaw, 3);
  assert.equal(a.keyframes[0].value, 0.25); assert.equal(a.keyframes.at(-1).value, 0.75);
  assert.deepEqual(a.keyframes[0].args, [0.25, 'actual', 7]);
  assert.deepEqual(a.args, [0.75, 'actual', 7]);
  assert.equal(h.state().stats.msgFiltered, 3, 'hard blocks survive temporary discovery');
  h.advance(CFG.MATCH_WINDOW_MS + CFG.OSC_MAINTENANCE_MS);
  assert.equal(h.state().filter.learning, false, 'discovery closes after idle plus match timeout');
  h.receive('/composition/layers/2/video/opacity', [0.9]); h.advance(DRAIN);
  assert.equal(h.actions().length, 1); assert.equal(h.state().stats.msgFiltered, 4);
});

test('stop retains final received packet before batch timer, ignores late direct, gates restart until ACK', () => {
  const h = harness(); h.start(); h.send({ type: 'learn', on: true });
  h.advance(CFG.UI_BATCH_MS - 1);
  const cutoff = h.now();
  h.receive(CONNECT, [1, 'last-before-stop']); h.stop();
  assert.equal(h.messages('eventBatch').length, 0);
  assert.equal(h.messages('recordDrained').length, 0);
  h.start('too-early');
  assert.equal(h.state().recSession, 'session-1');
  h.advance(1); h.receive('/composition/layers/1/clips/2/connect', [1, 'late']);
  h.advance(DRAIN);
  assert.equal(h.actions().length, 1);
  assert.equal(h.actions()[0].startMs, cutoff);
  assert.deepEqual(h.actions()[0].args, [1, 'last-before-stop']);
  assert.equal(h.events().length, 2, 'raw learn feed is independent of recording cutoff');
  h.start('still-unacked');
  assert.equal(h.state().recSession, 'session-1');
  assert.equal(h.messages('recordRejected').length, 2);
  assert.equal(h.messages('recordWarning').length, 0);
  assert.equal(h.messages('recordDrained').length, 0);
  h.ack(h.messages('recordActions')[0]);
  assert.deepEqual(h.messages('recordDrained'), [{ type: 'recordDrained', session: 'session-1', cutoff }]);
  h.start('session-2');
  assert.equal(h.state().recSession, 'session-2');
  h.receive('/composition/layers/1/clips/3/connect', [1]); h.advance(SETTLE);
  assert.equal(h.actions().length, 2); assert.equal(h.actions()[1].session, 'session-2');
});

test('all emitted batches must be ACKed before recordDrained, even out of order', () => {
  const h = harness(); h.start();
  h.receive(); h.advance(SETTLE); h.receive(); h.advance(SETTLE); h.stop(); h.advance(DRAIN);
  const batches = h.messages('recordActions');
  assert.equal(batches.length, 2); assert.equal(h.messages('recordDrained').length, 0);
  h.ack(batches[1]); assert.equal(h.messages('recordDrained').length, 0);
  h.ack(batches[1]); assert.equal(h.messages('recordDrained').length, 0);
  h.ack(batches[0]); assert.equal(h.messages('recordDrained').length, 1);
  h.ack(batches[0]); assert.equal(h.messages('recordDrained').length, 1);
});

test('stalled ACKs cap the action window at four and bound queued actions with overflow warnings', () => {
  const h = harness(); h.start();
  assert.equal(CFG.REC_ACTION_MAX_IN_FLIGHT, 4);
  const wire = packet(CONNECT, [1]);
  const total = CFG.REC_ACTION_QUEUE_CAPACITY + CFG.REC_ACTION_BATCH_SIZE * 8;
  for (let i = 0; i < total; i += CFG.REC_ACTION_BATCH_SIZE) {
    for (let j = 0; j < CFG.REC_ACTION_BATCH_SIZE; j++) h.receivePacket(wire);
    h.advance(SETTLE);
    assert.ok(h.state().actionInFlight.size <= 4);
    assert.ok(h.state().actionQueue.length <= CFG.REC_ACTION_QUEUE_CAPACITY);
    assert.ok(h.state().actionBytes <= CFG.OSC_EVENT_QUEUE_BYTES);
  }
  assert.equal(h.messages('recordActions').length, 4);
  assert.equal(h.state().actionQueue.length, CFG.REC_ACTION_QUEUE_CAPACITY);
  assert.ok(h.state().stats.droppedOverflow > 0);
  assert.ok(h.messages('recordWarning').some((m) => m.session === 'session-1' && /overflow/i.test(m.text)));
  const retained = h.actions().length + h.state().actionQueue.length;
  assert.equal(retained + h.state().stats.droppedOverflow, total);
  h.stop(); h.advance(DRAIN);
  let acked = 0;
  while (acked < h.messages('recordActions').length) {
    assert.equal(h.messages('recordDrained').length, 0);
    h.ack(h.messages('recordActions')[acked++]);
    assert.ok(h.state().actionInFlight.size <= 4);
  }
  assert.equal(h.actions().length, retained);
  assert.equal(h.state().actionQueue.length, 0); assert.equal(h.state().actionBytes, 0);
  assert.equal(h.state().actionInFlight.size, 0); assert.equal(h.messages('recordDrained').length, 1);
  assertBatchIdentity(h, 'session-1');
});

test('large full-argument actions hit the byte bound before the item bound and warn', () => {
  const h = harness(); h.start();
  const label = 'x'.repeat(64 * 1024);
  const wire = packet(CONNECT, [1, label]);
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 16; j++) h.receivePacket(wire);
    h.advance(SETTLE);
    assert.ok(h.state().actionBytes <= CFG.OSC_EVENT_QUEUE_BYTES);
    assert.ok(h.state().actionQueue.length <= CFG.REC_ACTION_QUEUE_CAPACITY);
  }
  assert.equal(h.messages('recordActions').length, 4);
  const retained = h.actions().length + h.state().actionQueue.length;
  // The byte cap includes unACKed batches, so it may leave no room in the queue.
  assert.ok(retained > 0 && retained < CFG.REC_ACTION_QUEUE_CAPACITY);
  assert.equal(retained + h.state().stats.droppedOverflow, 12 * 16);
  assert.ok(h.state().stats.droppedOverflow > 0);
  assert.ok(h.messages('recordWarning').some((m) => /overflow/i.test(m.text)));
  assert.equal(h.actions()[0].args[1], label, 'large args are not truncated to fit');
});

test('5000 alternating matched notes coalesce mappings inside the four-batch ACK window', () => {
  const h = harness(); h.start();
  const addresses = [CONNECT, '/composition/layers/1/clips/2/connect'];
  const wires = addresses.map((address) => packet(address, [1]));
  const total = 5000;
  for (let i = 0; i < total; i++) {
    h.midi('noteOn'); h.receivePacket(wires[i % 2]);
    h.advance(1); h.midi('noteOff', { value: 0 });
    h.advance(CFG.MATCH_WINDOW_MS + CFG.OSC_MAINTENANCE_MS);
    assert.ok(h.messages('recordActions').length <= CFG.REC_ACTION_MAX_IN_FLIGHT);
    assert.ok(h.state().pendingMappings.size <= 1, 'updates to one MIDI key must coalesce');
    assert.ok(h.state().pendingMappings.size <= CFG.REC_MAPPING_MAX);
    assert.ok(h.state().actionQueue.length <= CFG.REC_ACTION_QUEUE_CAPACITY);
    assert.ok(h.state().actionBytes <= CFG.OSC_EVENT_QUEUE_BYTES);
  }
  assert.equal(h.messages('recordMapping').length, 0);
  assert.equal(h.messages('recordActions').length, 4);
  assert.equal(h.state().pendingMappings.size, 1);
  assert.equal(h.state().pendingMappings.get('n60c1').address, addresses[1]);
  const retained = [...h.actions(), ...h.state().actionQueue];
  assert.equal(retained.length + h.state().stats.droppedOverflow, total);
  for (const action of retained) {
    assert.equal(action.source, 'midi'); assert.equal(action.matched, true);
    assert.equal(action.guessed, false); assert.equal(action.unassigned, false);
    assert.equal(action.address, addresses[(action.id - 1) % 2]);
  }
  h.stop(); h.advance(DRAIN);
  let acked = 0;
  while (acked < h.messages('recordActions').length) {
    assert.equal(h.messages('recordDrained').length, 0);
    h.ack(h.messages('recordActions')[acked++]);
    assert.ok(h.state().actionInFlight.size <= CFG.REC_ACTION_MAX_IN_FLIGHT);
  }
  const mappings = h.messages('recordActions').flatMap((b) => b.mappings);
  assert.ok(mappings.length < total, 'coalesced updates must not become per-note IPC');
  assert.equal(mappings.at(-1)[0], 'n60c1');
  assert.equal(mappings.at(-1)[1].address, addresses[1]);
  assert.equal(h.state().pendingMappings.size, 0);
  assert.equal(h.state().actionBytes, 0);
  assert.equal(h.messages('recordDrained').length, 1);
  assertBatchIdentity(h, 'session-1');
});

test('one exact playback echo token consumes only one of two identical direct clicks', () => {
  const h = harness(); h.start(); h.send({ type: 'learn', on: true });
  const args = [1, 'same', 0.5];
  h.send({ type: 'recTx', address: CONNECT, args, t: h.now() });
  h.receive(CONNECT, args); h.receive(CONNECT, args); h.advance(SETTLE);
  assert.equal(h.actions().length, 1); assert.deepEqual(h.actions()[0].args, args);
  assert.equal(h.state().echoTokens.length, 0);
  assert.equal(h.events().length, 2, 'echo exclusion must not hide raw learn events');
  h.receive(CONNECT, args); h.advance(SETTLE);
  assert.equal(h.actions().length, 2, 'no persistent address/value suppression');
});

test('echo matching compares every argument and expired tokens cannot suppress a later click', () => {
  const h = harness(); h.start();
  h.send({ type: 'recTx', address: CONNECT, args: [1, 'playback'], t: h.now() });
  h.receive(CONNECT, [1, 'different']); h.advance(SETTLE);
  assert.equal(h.actions().length, 1);
  h.receive(CONNECT, [1, 'playback']); h.advance(SETTLE);
  assert.equal(h.actions().length, 1, 'the unmatched token remains available exactly once');
  h.send({ type: 'recTx', address: CONNECT, args: [1, 'expired'], t: h.now() });
  h.advance(CFG.REC_ECHO_WINDOW_MS + CFG.OSC_MAINTENANCE_MS);
  h.receive(CONNECT, [1, 'expired']); h.advance(SETTLE);
  assert.equal(h.actions().length, 2); assert.deepEqual(h.actions()[1].args, [1, 'expired']);
});

test('mock utility crash reports fatal exit without claiming an unACKed recording drained', () => {
  const h = harness(); h.start(); h.receive(); h.advance(SETTLE);
  assert.equal(h.messages('recordActions').length, 1);
  h.crash();
  assert.deepEqual(h.exits, [1]);
  assert.deepEqual(h.messages('error'), [{ type: 'error', error: 'mock utility crash', fatal: true }]);
  assert.equal(h.messages('recordDrained').length, 0);
  const fresh = harness(); fresh.start('fresh');
  fresh.receive(); fresh.advance(SETTLE);
  assert.equal(fresh.actions().length, 1); assert.equal(fresh.actions()[0].session, 'fresh');
  assert.equal(fresh.state().actionInFlight.size, 1);
});

console.log(`\nRecording ingest: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
