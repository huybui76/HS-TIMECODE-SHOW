#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const osc = require('osc');
const CFG = require('../realtime-config');
const { RecordingSession } = require('../recording-session');

// Exercise production ingest without opening UDP, Electron or Resolume.
const DEFAULTS = { seconds: 60, oscHz: 3000, midiNoteOnHz: 200, tickMs: 10, sampleMs: 10000, holdMs: 50 };
const secondsArg = process.argv.indexOf('--seconds');
const seconds = secondsArg < 0 ? DEFAULTS.seconds : Number(process.argv[secondsArg + 1]);
const verbose = process.argv.includes('--verbose') && !process.argv.includes('--compact');
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Invalid --seconds');
const source = fs.readFileSync(path.join(__dirname, '..', 'osc-ingest.js'), 'utf8');
const epoch = () => performance.timeOrigin + performance.now();
const packet = (address, value) => Buffer.from(osc.writePacket({ address, args: [value] }));

function harness() {
  const timeouts = new Set();
  const intervals = new Set();
  const immediates = new Set();
  const sockets = new Set();
  const output = { uiBatches: 0, uiItems: 0, eventBatches: 0, eventItems: 0,
    recordBatches: 0, recordActions: 0, recordAcks: 0, recordDrained: 0,
    source: { midi: 0, osc: 0, other: 0 }, kind: { trigger: 0, piano: 0, float: 0, other: 0 },
    matched: 0, guessed: 0, unassigned: 0, matchedNotes: 0, wrongNoteAddress: 0,
    warnings: 0, pointCapWarnings: 0, unexpectedWarnings: 0, warningExamples: [], errors: 0,
    directFloats: 0, floatRawPoints: 0, floatSentPoints: 0,
    floatFirstValue: null, floatLastValue: null, invalidFloatActions: 0 };
  Object.assign(output, { mappingUpdates: 0, invalidMappings: 0, standaloneMappings: 0,
    recordRejected: 0, udpReady: 0 });
  let drainWaiter = null;
  const later = (fn) => {
    const id = setImmediate(() => { immediates.delete(id); fn(); });
    immediates.add(id);
  };
  const context = vm.createContext({
    Buffer, console, module: { exports: {} },
    process: { on() {} },
    require(name) {
      if (name === 'dgram' || name === 'node:dgram') return { createSocket() {
        const socket = new EventEmitter();
        socket.bind = (settings) => { socket.port = settings.port; socket.emit('listening'); };
        socket.close = () => { socket.removeAllListeners(); sockets.delete(socket); };
        socket.address = () => ({ port: socket.port });
        socket.setRecvBufferSize = (bytes) => { socket.recvBuffer = bytes; };
        socket.getRecvBufferSize = () => socket.recvBuffer;
        sockets.add(socket);
        return socket;
      } };
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
  const api = vm.runInContext(source + `\n;({onPacket, handleMessage, flushUi, flushEvents,
    updateStats, startStats, stopStats, stats, ring, uiBatch,
    snapshot: () => ({ pendingNotes: recorder ? recorder.notes.length : 0,
      pendingFloats: recorder ? recorder.floats.length : 0,
      actionQueue: actionQueue.length, actionBytes, actionInFlight: actionInFlight.size,
      pendingMappings: pendingMappings.size,
      rawQueue: queueCount, rawBytes: queueBytes, rawInFlight: inFlight.size }) })`, context);
  api.handleMessage({ type: 'init', port: {
    on() {}, start() {},
    postMessage(message) {
      if (message.type === 'uiBatch') {
        output.uiBatches++;
        output.uiItems += message.items.length;
        later(() => api.handleMessage({ type: 'uiAck' }));
      } else if (message.type === 'eventBatch') {
        output.eventBatches++;
        output.eventItems += message.items.length;
        const id = message.id;
        later(() => api.handleMessage({ type: 'eventAck', id }));
      } else if (message.type === 'recordActions') {
        output.recordBatches++;
        output.recordActions += message.items.length;
        if (!Array.isArray(message.mappings) || message.mappings.length > CFG.REC_ACTION_BATCH_SIZE) {
          output.invalidMappings++;
        } else {
          output.mappingUpdates += message.mappings.length;
          for (const [key, mapping] of message.mappings) {
            const note = /^n(\d+)c1$/.exec(key);
            if (!note || mapping.address !== `/composition/layers/1/clips/${Number(note[1]) - 59}/connect` ||
                mapping.kind !== 'trigger' || mapping.args.length !== 1 || mapping.args[0] !== 1) output.invalidMappings++;
          }
        }
        for (const action of message.items) {
          output.source[Object.hasOwn(output.source, action.source) ? action.source : 'other']++;
          output.kind[Object.hasOwn(output.kind, action.kind) ? action.kind : 'other']++;
          if (action.matched) output.matched++;
          if (action.guessed) output.guessed++;
          if (action.unassigned) output.unassigned++;
          if (action.source === 'osc' && action.kind === 'float') {
            output.directFloats++;
            output.floatRawPoints += action.keyframesRaw;
            output.floatSentPoints += action.keyframesSent;
            output.floatFirstValue = action.keyframes[0]?.value ?? null;
            output.floatLastValue = action.keyframes.at(-1)?.value ?? null;
            if (action.address !== '/composition/layers/2/video/opacity' || action.dataOrigin !== 'osc' ||
                action.keyframesRaw > CFG.FLOAT_MAX_POINTS || action.keyframesSent > action.keyframesRaw ||
                action.keyframes.length !== action.keyframesSent) output.invalidFloatActions++;
          }
          if (action.source === 'midi' && action.kind !== 'float' && action.matched) {
            output.matchedNotes++;
            if (action.address !== `/composition/layers/1/clips/${action.num - 59}/connect`) output.wrongNoteAddress++;
          }
        }
        // Retain only scalar counters and ACK identifiers, never the action objects.
        const { batchId, session } = message;
        later(() => {
          output.recordAcks++;
          api.handleMessage({ type: 'recordAck', batchId, session });
        });
      } else if (message.type === 'recordDrained') {
        output.recordDrained++;
        if (drainWaiter) drainWaiter(message);
      } else if (message.type === 'recordWarning') {
        output.warnings++;
        if (message.text === 'FLOAT_MAX_POINTS reached for osc:/composition/layers/2/video/opacity; interior samples reduced, endpoints retained') {
          output.pointCapWarnings++;
        } else output.unexpectedWarnings++;
        if (output.warningExamples.length < 8) output.warningExamples.push(message.text);
      } else if (message.type === 'recordMapping') output.standaloneMappings++;
      else if (message.type === 'recordRejected') output.recordRejected++;
      else if (message.type === 'ready') {
        if (message.recvBuf.actual === CFG.OSC_RECV_BUFFER_BYTES && !message.recvBuf.warn) output.udpReady++;
      } else if (message.type === 'error') output.errors++;
    }
  } });
  api.handleMessage({ type: 'filter', filter: { whitelist: [
    ...CFG.DEFAULT_WHITELIST, '/composition/layers/2/video/opacity'
  ] } });
  return {
    ...api, output,
    start(session, anchorEpoch) {
      api.handleMessage({ type: 'setPort', port: 17000 });
      api.handleMessage({ type: 'recStart', session, anchorEpoch, fps: 25, anchorFrame: 0, mappings: [] });
      if (output.recordRejected) throw new Error('Profile recording was rejected after fake UDP bind');
      // Keep measuring the raw learn feed as a separate, ACKed transport.
      api.handleMessage({ type: 'learn', on: true });
    },
    stop(session, cutoff) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          timeouts.delete(timer); drainWaiter = null;
          reject(new Error(`recordDrained timed out after ${CFG.REC_DRAIN_TIMEOUT_MS}ms: ${JSON.stringify(api.snapshot())}`));
        }, CFG.REC_DRAIN_TIMEOUT_MS);
        timeouts.add(timer);
        drainWaiter = (message) => {
          if (message.session !== session) return;
          clearTimeout(timer); timeouts.delete(timer); drainWaiter = null; resolve(message);
        };
        api.handleMessage({ type: 'recStop', session, cutoff });
      });
    },
    close() {
      api.handleMessage({ type: 'closePort' });
      for (const id of timeouts) clearTimeout(id);
      for (const id of intervals) clearInterval(id);
      for (const id of immediates) clearImmediate(id);
      timeouts.clear(); intervals.clear(); immediates.clear(); drainWaiter = null;
      return { timeouts: timeouts.size, intervals: intervals.size, immediates: immediates.size,
        sockets: sockets.size, drainWaiter: drainWaiter !== null };
    }
  };
}

function probes() {
  const h = harness();
  const address = '/composition/layers/1/clips/1/connect';
  let matched = 0, unassigned = 0;
  const engine = new RecordingSession({ emit(action) {
    if (action.matched) matched++;
    if (action.unassigned) unassigned++;
  } });
  try {
    const t = epoch();
    engine.start({ session: 'probe', fps: 25, anchorEpoch: t, anchorFrame: 0 });
    for (const num of [60, 61]) engine.midi({ kind: 'noteOn', num, ch: 1, value: 100, t });
    engine.ingestOsc({ address, args: [1], t, seq: 1 });
    for (const num of [60, 61]) engine.midi({ kind: 'noteOff', num, ch: 1, value: 0, t: t + 1 });
    engine.tick(t + CFG.MATCH_WINDOW_MS + 2);
    h.start('ring-probe', t); h.handleMessage({ type: 'uiVisible', on: true });
    for (const value of [1, 0, 1]) h.onPacket(packet(address, value));
    const connectRingEvents = h.ring.count;
    const pendingFloat = '/composition/layers/2/video/opacity';
    h.onPacket(packet(pendingFloat, 0.2)); h.onPacket(packet(pendingFloat, 0.7));
    h.ring.flushPending(epoch() + 50, true);
    const id = h.ring.ids.get(pendingFloat);
    let finalPresent = false;
    h.ring.forEachInWindow(t, epoch() + 50, (addrId, value) => {
      if (addrId === id && Math.abs(value - 0.7) < 1e-6) finalPresent = true;
    });
    h.flushUi();
    return { ownershipImplementation: 'real RecordingSession; ring/UI via production ingest',
      oneOscMatchedToMidiCount: matched, unassignedMidiCount: unassigned,
      sameOscAssignedTwice: matched > 1, connectInputEvents: 3, connectRingEvents,
      uiItemsAfterConnectAndFloat: h.output.uiItems, floatFinalValuePresent: finalPresent };
  } finally { h.close(); }
}

async function main() {
  const probeResults = probes();
  const h = harness();
  h.handleMessage({ type: 'uiVisible', on: true });
  const delay = monitorEventLoopDelay({ resolution: DEFAULTS.tickMs });
  const noise = [
    packet('/composition/layers/1/clips/1/transport/position', 0.3),
    packet('/composition/layers/1/video/source/textgenerator/opacity', 0.4),
    packet('/composition/tempocontroller/tempo', 120)
  ];
  const connects = Array.from({ length: 16 }, (_, i) => packet(`/composition/layers/1/clips/${i + 1}/connect`, 1));
  const floats = Array.from({ length: 100 }, (_, i) => packet('/composition/layers/2/video/opacity', i / 99));
  const samples = [];
  const sampleMs = Math.min(DEFAULTS.sampleMs, seconds * 500);
  const durationMs = seconds * 1000;
  const session = 'profile';
  const start = performance.now();
  const anchorEpoch = epoch();
  const cpuStart = process.cpuUsage();
  const heapStart = process.memoryUsage().heapUsed;
  let oscCount = 0, noteOns = 0, noteOffs = 0, noiseCount = 0, floatCount = 0;
  let nextSample = sampleMs, feedElapsedMs = 0, drainMs = 0;
  let maxUiQueue = 0, maxPendingMidi = 0, maxHeld = 0, maxActionQueue = 0, maxActionInFlight = 0;
  let feedTimer = null;
  const held = [];
  const sample = () => {
    const cpu = process.cpuUsage(cpuStart);
    if (samples.length >= 120) samples.shift();
    samples.push({ seconds: (performance.now() - start) / 1000,
      cpuMs: (cpu.user + cpu.system) / 1000, heapMB: process.memoryUsage().heapUsed / 1048576,
      eventLoopP99Ms: delay.percentile(99) / 1e6, ringEntries: h.ring.count, ...h.snapshot() });
  };
  const release = () => {
    while (held.length && held[0].release <= performance.now()) {
      const note = held.shift();
      h.handleMessage({ type: 'recMidi', session, event: {
        kind: 'noteOff', num: note.num, ch: 1, value: 0, t: epoch() } });
      noteOffs++;
    }
  };
  try {
    h.start(session, anchorEpoch); h.startStats(); delay.enable(); sample();
    await new Promise((resolve, reject) => {
      feedTimer = setInterval(() => {
        try {
          const elapsed = performance.now() - start;
          const targetOsc = Math.floor(Math.min(elapsed, durationMs) * DEFAULTS.oscHz / 1000);
          release();
          while (oscCount < targetOsc) {
            // Every 15 packets: one note/connect pair, two floats and twelve denied leaves.
            const index = oscCount++;
            if (index % 15 === 0) {
              const slot = noteOns % connects.length;
              const num = 60 + slot;
              h.handleMessage({ type: 'recMidi', session, event: { kind: 'noteOn', num,
                ch: 1, value: 100, t: epoch() } });
              noteOns++;
              held.push({ num, release: performance.now() + DEFAULTS.holdMs });
              h.onPacket(connects[slot]);
            } else if (index % 15 === 5 || index % 15 === 10) {
              h.onPacket(floats[floatCount++ % floats.length]);
            } else h.onPacket(noise[noiseCount++ % noise.length]);
          }
          maxUiQueue = Math.max(maxUiQueue, h.uiBatch.size);
          const state = h.snapshot();
          maxPendingMidi = Math.max(maxPendingMidi, state.pendingNotes + state.pendingFloats);
          maxHeld = Math.max(maxHeld, held.length);
          maxActionQueue = Math.max(maxActionQueue, state.actionQueue);
          maxActionInFlight = Math.max(maxActionInFlight, state.actionInFlight);
          if (elapsed >= nextSample) { sample(); nextSample += sampleMs; }
          if (elapsed >= durationMs && !feedElapsedMs) feedElapsedMs = elapsed;
          if (elapsed >= durationMs && !held.length) { clearInterval(feedTimer); feedTimer = null; resolve(); }
        } catch (error) { clearInterval(feedTimer); feedTimer = null; reject(error); }
      }, DEFAULTS.tickMs);
    });
    const cutoff = epoch();
    const drainStart = performance.now();
    await h.stop(session, cutoff);
    drainMs = performance.now() - drainStart;
    h.flushUi();
    h.flushEvents();
    await new Promise((resolve) => setImmediate(resolve));
    h.updateStats();
    sample();
    const elapsedMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    // Point-cap reduction is expected for a continuous long stream, not packet loss.
    // Keep it visible and validate that only the known endpoint-preserving cap fired.
    const expectedPointCap = floatCount > CFG.FLOAT_MAX_POINTS;
    const closeTo = (actual, expected) => actual !== null && Math.abs(actual - expected) < 1e-6;
    delay.disable();
    const cleanup = { feedTimer: feedTimer !== null, eventLoopMonitorDisabled: true, ...h.close() };
    const checks = {
      baselineOwnership: probeResults.oneOscMatchedToMidiCount === 1 && probeResults.unassignedMidiCount === 1,
      baselineConnects: probeResults.connectRingEvents === 3,
      baselineFloatEndpoint: probeResults.floatFinalValuePresent,
      allNotesReleased: noteOffs === noteOns,
      oneToOneNotes: h.output.source.midi === noteOns && h.output.matchedNotes === noteOns &&
        h.output.wrongNoteAddress === 0 && h.output.source.osc === 1,
      noGuessedOrUnassigned: h.output.guessed === 0 && h.output.unassigned === 0,
      allowedPacketCount: h.stats.msgKept === noteOns + floatCount,
      rawFeedComplete: h.output.eventItems === noteOns + floatCount,
      allActionsAckedAndDrained: h.output.recordAcks === h.output.recordBatches && h.output.recordDrained === 1,
      fakeUdpReady: h.output.udpReady === 1 && h.output.recordRejected === 0,
      mappingsShareAckWindow: h.output.mappingUpdates > 0 && h.output.invalidMappings === 0 &&
        h.output.standaloneMappings === 0 && maxActionInFlight <= CFG.REC_ACTION_MAX_IN_FLIGHT,
      noPacketLossOrErrors: h.stats.droppedOverflow === 0 && h.output.errors === 0 && h.stats.malformed === 0,
      expectedWarningsOnly: h.output.unexpectedWarnings === 0 &&
        h.output.pointCapWarnings === (expectedPointCap ? 1 : 0),
      floatEndpointsAndCap: h.output.directFloats === 1 && h.output.invalidFloatActions === 0 &&
        closeTo(h.output.floatFirstValue, 0) && closeTo(h.output.floatLastValue, ((floatCount - 1) % 100) / 99) &&
        (expectedPointCap ? h.output.floatRawPoints < floatCount : h.output.floatRawPoints === floatCount),
      queuesDrained: Object.values(h.snapshot()).every((count) => count === 0),
      cleanupComplete: !cleanup.feedTimer && cleanup.eventLoopMonitorDisabled && !cleanup.drainWaiter &&
        cleanup.timeouts === 0 && cleanup.intervals === 0 && cleanup.immediates === 0 && cleanup.sockets === 0
    };
    const failedChecks = Object.keys(checks).filter((key) => !checks[key]);
    console.log(JSON.stringify({
      status: failedChecks.length ? 'failed' : expectedPointCap ? 'passed-with-expected-point-reduction' : 'passed',
      failedChecks,
      scope: 'Production osc-ingest.js in VM; mock MessagePort; no UDP/Electron/DOM. Not a renderer FPS or delivery test.',
      settings: { ...DEFAULTS, seconds, sampleMs, allowedOscHz: 600, connectHz: 200, floatHz: 400,
        noiseHz: 2400, midiNoteOffHz: 200, midiTotalMessagesHz: 400,
        midiRateMeaning: '200 note-ons/s plus 200 delayed note-offs/s, not 200 total MIDI messages/s',
        drainTimeoutMs: CFG.REC_DRAIN_TIMEOUT_MS, floatMaxPoints: CFG.FLOAT_MAX_POINTS,
        floatMatchMaxLags: CFG.FLOAT_MATCH_MAX_LAGS, floatMatchMaxSamples: CFG.FLOAT_MATCH_MAX_SAMPLES,
        packetBuffersPrebuilt: true },
      pointCap: { expected: expectedPointCap,
        meaning: 'Continuous opacity stream may reduce interior samples at the configured cap; this is not lossless curve capture. Warnings and retained point counts remain reported.' },
      probes: probeResults, checks,
      elapsedMs, feedElapsedMs, drainMs, cutoff,
      injectedOsc: oscCount, injectedNoise: noiseCount, injectedConnect: noteOns, injectedFloat: floatCount,
      injectedMidiNoteOn: noteOns, injectedMidiNoteOff: noteOffs, injectedMidiTotal: noteOns + noteOffs,
      measuredFeedOscHz: oscCount / (feedElapsedMs / 1000),
      cpuMs: (cpu.user + cpu.system) / 1000,
      cpuOneCorePercent: (cpu.user + cpu.system) / (elapsedMs * 10),
      heapDeltaMB: (process.memoryUsage().heapUsed - heapStart) / 1048576,
      eventLoopDelayMs: { mean: delay.mean / 1e6, p99: delay.percentile(99) / 1e6, max: delay.max / 1e6 },
      output: h.output, maxUiQueue, maxPendingMidi, maxHeld, maxActionQueue, maxActionInFlight,
      finalQueues: h.snapshot(),
      ingestStats: h.stats, ringEntries: h.ring.count,
      ringOverflow: h.ring.overflow, internedAddresses: h.ring.ids.size, cleanup,
      sampleCount: samples.length,
      sampleSummary: { heapMinMB: Math.min(...samples.map((s) => s.heapMB)),
        heapMaxMB: Math.max(...samples.map((s) => s.heapMB)),
        first: samples[0], last: samples.at(-1) },
      ...(verbose ? { samples } : {})
    }, null, verbose ? 2 : undefined));
    if (failedChecks.length) process.exitCode = 1;
  } finally { if (feedTimer) clearInterval(feedTimer); delay.disable(); h.close(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
