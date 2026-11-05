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
const connect = '/composition/layers/1/clips/1/connect';
const opacity = '/composition/layers/1/video/opacity';
const packet = (address, args) => Buffer.from(osc.writePacket({ address, args }));

function harness() {
  let now = 1000000;
  let nextTimer = 0;
  const timers = new Map();
  const out = [];
  let binds = 0;
  const sockets = [];
  const context = vm.createContext({
    Buffer, console, process: { on() {} }, module: { exports: {} },
    require(name) {
      if (name === 'node:perf_hooks') return {
        performance: { timeOrigin: 1000000, now: () => now - 1000000 },
        monitorEventLoopDelay: () => ({ enable() {}, disable() {}, reset() {}, percentile: () => 0, mean: 0, max: 0 })
      };
      if (name === 'node:dgram') return { createSocket() {
        const socket = new EventEmitter();
        socket.bind = (settings) => { binds++; socket.port = settings.port; socket.emit('listening'); };
        socket.close = () => { socket.closed = true; };
        socket.setRecvBufferSize = (bytes) => { socket.requested = bytes; };
        socket.getRecvBufferSize = () => 1024 * 1024;
        socket.address = () => ({ port: socket.port });
        sockets.push(socket);
        return socket;
      } };
      return name.startsWith('./') ? require(path.join(__dirname, '..', name)) : require(name);
    },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: now + ms, interval: 0 }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: now + ms, interval: ms }); return id; },
    clearInterval(id) { timers.delete(id); }
  });
  const api = vm.runInContext(source + '\n;({onPacket,handleMessage,flushUi,flushEvents,maintain,updateStats,stats,ring,uiBatch,pendingMidi,inFlight})', context);
  api.handleMessage({ type: 'init', port: { on() {}, start() {}, close() {}, postMessage: (m) => out.push(m) } });
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      const [id, timer] = entry;
      now = timer.at;
      if (timer.interval) timer.at += timer.interval;
      else timers.delete(id);
      timer.fn();
    }
    now = end;
  };
  return { ...api, out, advance, sockets, now: () => now, binds: () => binds,
    start() { api.handleMessage({ type: 'recording', on: true, session: 7 }); },
    events() { return out.filter((m) => m.type === 'eventBatch').flatMap((m) => m.items); },
    configure(addresses) { api.handleMessage({ type: 'filter', filter: { whitelist: [...CFG.DEFAULT_WHITELIST, ...addresses] } }); }
  };
}

let passed = 0;
function test(name, run) {
  run();
  passed++;
  console.log('PASS ' + name);
}

test('idle and visible Monitor alone do not decode or buffer OSC', () => {
  const h = harness();
  h.handleMessage({ type: 'uiVisible', on: true });
  h.onPacket(packet(connect, [1]));
  h.advance(100);
  assert.equal(h.stats.idlePackets, 1);
  assert.equal(h.stats.msgTotal, 0);
  assert.equal(h.ring.count, 0);
  assert.equal(h.events().length, 0);
  assert.equal(h.binds(), 0);
});

test('ordered stream preserves repeated connect and all args; UI is separate', () => {
  const h = harness(); h.start();
  h.handleMessage({ type: 'uiVisible', on: true });
  for (const value of [1, 1, 0, 1]) h.onPacket(packet(connect, [value, 'label', 0.5]));
  h.advance(40);
  assert.deepEqual(Array.from(h.events(), (m) => Array.from(m.args)), [[1, 'label', 0.5], [1, 'label', 0.5], [0, 'label', 0.5], [1, 'label', 0.5]]);
  assert.equal(h.ring.count, 4);
  assert.equal(h.events().every((m) => m.t === h.now() - 40 && m.session === 7), true);
  assert.equal(h.out.filter((m) => m.type === 'uiBatch')[0].items.length, 1);
});

test('bundle leaf metrics include rejected messages and malformed leaves', () => {
  const h = harness(); h.start();
  const bundle = Buffer.from(osc.writePacket({ timeTag: { raw: [0, 1] }, packets: [
    { address: connect, args: [1] },
    { address: '/composition/layers/1/position', args: [0.2] },
    { address: '/composition/layers/1/video/source/textgenerator/opacity', args: [0.5] }
  ] }));
  h.onPacket(bundle); h.advance(40);
  assert.equal(h.stats.pkts, 1);
  assert.equal(h.stats.msgTotal, 3);
  assert.equal(h.stats.msgFiltered, 2);
  assert.equal(h.events().length, 1);
  h.updateStats();
  assert.ok(h.stats.lastMsgsPerSec > h.stats.datagramsPerSec);
});

test('assigned opacity endpoint survives rate limiting without losing raw stream', () => {
  const h = harness(); h.start(); h.configure([opacity]);
  h.onPacket(packet(opacity, [0.2])); h.advance(1);
  h.onPacket(packet(opacity, [0.7])); h.advance(40);
  const values = [];
  h.ring.forEachInWindow(0, h.now(), (_, v) => values.push(v));
  assert.equal(values.length, 2);
  assert.ok(Math.abs(values[1] - 0.7) < 1e-6);
  assert.equal(h.events().length, 2);
});

test('OSC is owned by one MIDI only and matching waits for post window', () => {
  const h = harness(); h.start();
  for (const id of [1, 2]) h.handleMessage({ type: 'midiStart', id, kind: 'note', ts: h.now() });
  h.onPacket(packet(connect, [1]));
  for (const id of [1, 2]) h.handleMessage({ type: 'midiEnd', id, ts: h.now() });
  assert.equal(h.out.filter((m) => m.type === 'matched').length, 0);
  h.advance(CFG.MATCH_WINDOW_MS + CFG.OSC_MAINTENANCE_MS);
  assert.equal(h.out.filter((m) => m.type === 'matched').length, 1);
  assert.equal(h.out.filter((m) => m.type === 'unmatched').length, 1);
});

test('pre-window and long-held notes remain eligible until release', () => {
  const h = harness(); h.start();
  h.onPacket(packet(connect, [1])); h.advance(10);
  h.handleMessage({ type: 'midiStart', id: 1, kind: 'note', ts: h.now() });
  h.advance(10000);
  h.updateStats();
  assert.equal(h.pendingMidi.size, 1);
  h.handleMessage({ type: 'midiEnd', id: 1, ts: h.now() });
  h.advance(160);
  assert.equal(h.out.filter((m) => m.type === 'matched').length, 1);
});

test('post-note OSC matches; beyond window does not', () => {
  for (const gap of [30, 500]) {
    const h = harness(); h.start();
    h.handleMessage({ type: 'midiStart', id: 1, kind: 'note', ts: h.now() });
    h.handleMessage({ type: 'midiEnd', id: 1, ts: h.now() });
    h.advance(gap); h.onPacket(packet(connect, [1])); h.advance(160);
    assert.equal(h.out.filter((m) => m.type === 'matched').length, gap === 30 ? 1 : 0);
  }
});

test('backpressure bounds in-flight and queue, counts loss, ACK drains', () => {
  const h = harness(); h.start();
  for (let i = 0; i < 100000; i++) {
    h.onPacket(packet(connect, [i % 2]));
    if (i % CFG.OSC_EVENT_BATCH_SIZE === 0) h.flushEvents();
  }
  h.updateStats();
  assert.ok(h.inFlight.size <= CFG.OSC_MAX_IN_FLIGHT_BATCHES);
  assert.ok(h.stats.queueDepth <= CFG.OSC_EVENT_QUEUE_CAPACITY + CFG.OSC_EVENT_BATCH_SIZE * CFG.OSC_MAX_IN_FLIGHT_BATCHES);
  assert.ok(h.stats.droppedOverflow > 0);
  let acked = 0;
  for (;;) {
    const batches = h.out.filter((m) => m.type === 'eventBatch');
    if (acked >= batches.length) break;
    h.handleMessage({ type: 'eventAck', id: batches[acked++].id });
  }
  h.updateStats();
  assert.equal(h.stats.queueDepth, 0);
});

test('learn discovery never forwards hard-blocked/noisy telemetry', () => {
  const h = harness();
  h.handleMessage({ type: 'learn', on: true });
  for (const address of [opacity, '/composition/layers/1/audio/volume', '/composition/layers/1/position']) {
    h.onPacket(packet(address, [0.5]));
  }
  h.advance(40);
  assert.deepEqual(Array.from(h.events(), (m) => m.address), [opacity]);
  assert.equal(h.events()[0].record, false);
});

test('socket requests 8MB, reports OS limit, rejects stale socket data and survives malformed', () => {
  const h = harness(); h.start();
  h.handleMessage({ type: 'setPort', port: 17000 });
  assert.equal(h.sockets[0].requested, CFG.OSC_RECV_BUFFER_BYTES);
  assert.equal(h.out.find((m) => m.type === 'ready').recvBuf.warn, true);
  h.handleMessage({ type: 'setPort', port: 17001 });
  assert.equal(h.sockets[0].closed, true);
  h.sockets[0].emit('message', packet(connect, [1]));
  h.sockets[1].emit('message', Buffer.from([1, 2, 3]));
  h.sockets[1].emit('message', packet(connect, [1]));
  h.advance(40);
  assert.equal(h.stats.malformed, 1);
  assert.equal(h.events().length, 1);
  h.sockets[1].emit('error', new Error('EADDRINUSE'));
  assert.equal(h.out.filter((m) => m.type === 'error').at(-1).fatal, true);
});

test('large bundle charges each retained leaf, not whole datagram per leaf', () => {
  const h = harness(); h.start();
  const packets = Array.from({ length: 1000 }, () => ({ address: connect, args: [1] }));
  h.onPacket(Buffer.from(osc.writePacket({ timeTag: { raw: [0, 1] }, packets })));
  h.advance(40);
  assert.equal(h.events().length, 1000);
  assert.equal(h.stats.droppedOverflow, 0);
});

test('UI waits for ACK and keeps only latest values while renderer is stalled', () => {
  const h = harness(); h.start();
  h.handleMessage({ type: 'uiVisible', on: true });
  for (let i = 0; i < 1000; i++) { h.onPacket(packet(connect, [i])); h.advance(40); }
  assert.equal(h.out.filter((m) => m.type === 'uiBatch').length, 1);
  assert.equal(h.uiBatch.size, 1);
  h.handleMessage({ type: 'uiAck' }); h.advance(40);
  const batches = h.out.filter((m) => m.type === 'uiBatch');
  assert.equal(batches.length, 2);
  assert.equal(batches[1].items[0].args[0], 999);
});

console.log(`${passed} ingest tests passed`);
