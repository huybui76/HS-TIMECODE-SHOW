#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const osc = require('osc');

// Exercise production ingest without opening UDP, Electron or Resolume.
const DEFAULTS = { seconds: 60, oscHz: 3000, midiHz: 200, tickMs: 10, sampleMs: 10000, holdMs: 50 };
const secondsArg = process.argv.indexOf('--seconds');
const seconds = secondsArg < 0 ? DEFAULTS.seconds : Number(process.argv[secondsArg + 1]);
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid --seconds');
const source = fs.readFileSync(path.join(__dirname, '..', 'osc-ingest.js'), 'utf8');
const epoch = () => performance.timeOrigin + performance.now();
const packet = (address, value) => Buffer.from(osc.writePacket({ address, args: [value] }));

function harness() {
  const timeouts = new Set();
  const intervals = new Set();
  const output = { uiBatches: 0, uiItems: 0, eventBatches: 0, eventItems: 0, matched: 0, unmatched: 0 };
  let matchedHook = null;
  const context = vm.createContext({
    Buffer, console, module: { exports: {} },
    process: { on() {} },
    require(name) {
      if (name === 'dgram' || name === 'node:dgram') return { createSocket() { throw new Error('No network in profile'); } };
      if (name.startsWith('./')) return require(path.join(__dirname, '..', name));
      return require(name);
    },
    setTimeout(fn, ms) {
      const id = setTimeout(() => { timeouts.delete(id); fn(); }, ms);
      timeouts.add(id);
      return id;
    },
    clearTimeout(id) { timeouts.delete(id); clearTimeout(id); },
    setInterval(fn, ms) { const id = setInterval(fn, ms); intervals.add(id); return id; },
    clearInterval(id) { intervals.delete(id); clearInterval(id); }
  });
  const api = vm.runInContext(source + '\n;({onPacket, handleMessage, flushUi, flushEvents, finalizeMidi, updateStats, startStats, stopStats, stats, ring, uiBatch, pendingMidi})', context);
  api.handleMessage({ type: 'init', port: {
    on() {}, start() {},
    postMessage(message) {
      if (message.type === 'uiBatch') {
        output.uiBatches++;
        output.uiItems += message.items.length;
        setImmediate(() => api.handleMessage({ type: 'uiAck' }));
      } else if (message.type === 'eventBatch') {
        output.eventBatches++;
        output.eventItems += message.items.length;
        setImmediate(() => api.handleMessage({ type: 'eventAck', id: message.id }));
      } else if (message.type === 'matched') {
        output.matched++;
        if (matchedHook) matchedHook(message);
      } else if (message.type === 'unmatched') output.unmatched++;
    }
  } });
  const config = require('../realtime-config');
  api.handleMessage({ type: 'filter', filter: { whitelist: [
    ...config.DEFAULT_WHITELIST, '/composition/layers/2/video/opacity'
  ] } });
  api.handleMessage({ type: 'recording', on: true });
  return {
    ...api, output,
    onMatch(fn) { matchedHook = fn; },
    close() {
      api.stopStats();
      for (const id of timeouts) clearTimeout(id);
      for (const id of intervals) clearInterval(id);
    }
  };
}

function probes() {
  const h = harness();
  const address = '/composition/layers/1/clips/1/connect';
  const matched = [];
  h.onMatch((m) => matched.push(m.address));
  const t = epoch();
  for (const id of [1, 2]) h.handleMessage({ type: 'midiStart', id, kind: 'note', ts: t });
  h.onPacket(packet(address, 1));
  for (const id of [1, 2]) h.handleMessage({ type: 'midiEnd', id, ts: epoch() });
  for (const id of [1, 2]) h.finalizeMidi(id);
  h.onPacket(packet(address, 0));
  h.onPacket(packet(address, 1));
  const connectRingEvents = h.ring.count;
  const pendingFloat = '/composition/layers/2/video/opacity';
  h.ring.push(pendingFloat, 0.2, t);
  h.ring.push(pendingFloat, 0.7, t + 1);
  h.ring.flushPending(t + 50);
  const id = h.ring.ids.get(pendingFloat);
  const values = [];
  h.ring.forEachInWindow(t, t + 2, (addrId, value) => { if (addrId === id) values.push(value); });
  h.flushUi();
  const result = {
    oneOscMatchedToMidiCount: matched.length,
    sameOscAssignedTwice: matched.length === 2 && matched[0] === matched[1],
    connectInputEvents: 3,
    connectRingEvents,
    uiItemsAfterConnectAndFloat: h.output.uiItems,
    floatFinalValuePresent: values.some((v) => Math.abs(v - 0.7) < 1e-6)
  };
  h.close();
  return result;
}

async function main() {
  const probeResults = probes();
  const h = harness();
  h.handleMessage({ type: 'uiVisible', on: true });
  h.startStats();
  const delay = monitorEventLoopDelay({ resolution: DEFAULTS.tickMs });
  delay.enable();
  const messages = [
    packet('/composition/layers/1/clips/1/transport/position', 0.3),
    packet('/composition/layers/1/video/source/textgenerator/opacity', 0.4),
    packet('/composition/tempocontroller/tempo', 120),
    [packet('/composition/layers/2/clips/1/connect', 0), packet('/composition/layers/2/clips/1/connect', 1)],
    Array.from({ length: 100 }, (_, i) => packet('/composition/layers/2/video/opacity', i / 99))
  ];
  const mix = [0, 0, 1, 1, 0, 0, 2, 2, 3, 4];
  const samples = [];
  const start = performance.now();
  const cpuStart = process.cpuUsage();
  const heapStart = process.memoryUsage().heapUsed;
  let oscCount = 0, midiCount = 0, nextSample = DEFAULTS.sampleMs;
  let maxUiQueue = 0, maxPendingMidi = 0;
  const held = [];
  try {
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        const elapsed = performance.now() - start;
        const targetOsc = Math.floor(Math.min(elapsed, seconds * 1000) * DEFAULTS.oscHz / 1000);
        const targetMidi = Math.floor(Math.min(elapsed, seconds * 1000) * DEFAULTS.midiHz / 1000);
        while (midiCount < targetMidi) {
          const id = ++midiCount;
          h.handleMessage({ type: 'midiStart', id, kind: 'note', ts: epoch() });
          held.push({ id, release: elapsed + DEFAULTS.holdMs });
        }
        while (oscCount < targetOsc) {
          const index = oscCount++;
          const item = messages[mix[index % mix.length]];
          h.onPacket(Array.isArray(item) ? item[Math.floor(index / mix.length) % item.length] : item);
        }
        while (held.length && held[0].release <= elapsed) {
          h.handleMessage({ type: 'midiEnd', id: held.shift().id, ts: epoch() });
        }
        maxUiQueue = Math.max(maxUiQueue, h.uiBatch.size);
        maxPendingMidi = Math.max(maxPendingMidi, h.pendingMidi.size);
        if (elapsed >= nextSample) {
          samples.push({ seconds: Math.round(elapsed / 1000), heapMB: process.memoryUsage().heapUsed / 1048576, ringEntries: h.ring.count });
          nextSample += DEFAULTS.sampleMs;
        }
        if (elapsed >= seconds * 1000 && !held.length) { clearInterval(timer); resolve(); }
      }, DEFAULTS.tickMs);
    });
    await new Promise((resolve) => setTimeout(resolve, require('../realtime-config').MATCH_WINDOW_MS + DEFAULTS.tickMs));
    h.flushUi();
    h.flushEvents();
    h.updateStats();
    const elapsedMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    console.log(JSON.stringify({
      scope: 'Production osc-ingest.js in VM; mock MessagePort; no UDP/Electron/DOM. Not a renderer FPS or delivery test.',
      settings: { ...DEFAULTS, seconds }, probes: probeResults,
      elapsedMs, injectedOsc: oscCount, injectedMidi: midiCount,
      cpuMs: (cpu.user + cpu.system) / 1000,
      cpuOneCorePercent: (cpu.user + cpu.system) / (elapsedMs * 10),
      heapDeltaMB: (process.memoryUsage().heapUsed - heapStart) / 1048576,
      eventLoopDelayMs: { mean: delay.mean / 1e6, p99: delay.percentile(99) / 1e6, max: delay.max / 1e6 },
      output: h.output, maxUiQueue, maxPendingMidi,
      ingestStats: h.stats, ringEntries: h.ring.count,
      ringDropped: h.ring.dropped, internedAddresses: h.ring.ids.size, samples
    }, null, 2));
  } finally { delay.disable(); h.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
