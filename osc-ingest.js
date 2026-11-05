'use strict';

const dgram = require('node:dgram');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const CFG = require('./realtime-config');
const { OscFilter, parsePacket } = require('./osc-parser');
const { OscRing } = require('./osc-ring');
const { RecordingSession } = require('./recording-session');

const nowEpoch = () => performance.timeOrigin + performance.now();
const ring = new OscRing();
const filter = new OscFilter();
let port = null;
let udp = null;
let socketReady = false;
let listenPort = 7000;
let recording = false;
let learnMode = false;
let captureSeen = false;
let uiVisible = false;
let session = 0;
let sequence = 0;
let debugLog = false;
let lastDebug = -Infinity;
let statsTimer = null;
let uiTimer = null;
let eventTimer = null;
let rxDelta = 0;
let batchId = 0;
let uiInFlight = false;
const uiBatch = new Map();
const inFlight = new Map();
const pendingMidi = new Map();
const claimed = new Map();
const eventQueue = new Array(CFG.OSC_EVENT_QUEUE_CAPACITY);
let queueHead = 0;
let queueCount = 0;
let queueBytes = 0;
let recorder = null;
let recSession = null;
let recCutoff = null;
let actionBytes = 0;
let actionBatchSeq = 0;
let floatLearningUntil = 0;
const actionQueue = [];
const actionInFlight = new Map();
const echoTokens = [];
const pendingMappings = new Map();
let lastRecordWarning = -Infinity;
let previewInFlight = false;
let lastPreviewAt = -Infinity;
const loopDelay = monitorEventLoopDelay({ resolution: CFG.OSC_STATS_RESOLUTION_MS });
const stats = {
  pkts: 0, idlePackets: 0, msgTotal: 0, msgKept: 0, msgFiltered: 0,
  msgRateLimited: 0, malformed: 0, bundleDepthMax: 0,
  droppedOverflow: 0, queueDepth: 0, queueHighWater: 0,
  uiSent: 0, uiBatches: 0, eventSent: 0, eventBatches: 0,
  lastMsgsPerSec: 0, datagramsPerSec: 0, filteredPerSec: 0,
  droppedPerSec: 0, rendererMessagesPerSec: 0,
  recvBufRequested: 0, recvBufActual: 0, recvBufWarn: false,
  eventLoopMeanMs: 0, eventLoopP99Ms: 0, eventLoopMaxMs: 0,
  ringEntries: 0, ringOverflow: 0, addressOverflow: 0
};
let previous = { t: nowEpoch(), pkts: 0, messages: 0, filtered: 0, dropped: 0, sends: 0 };

function post(message) {
  if (!port) return false;
  try { port.postMessage(message); return true; } catch (_) { return false; }
}

function postMain(message) {
  if (!process.parentPort) return false;
  try { process.parentPort.postMessage(message); return true; } catch (_) { return false; }
}

function reportError(error, fatal = false) {
  const message = { type: 'error', error: String(error.message || error), fatal };
  if (!postMain(message)) post(message);
  if (debugLog && nowEpoch() - lastDebug >= CFG.OSC_DEBUG_INTERVAL_MS) {
    lastDebug = nowEpoch();
    console.error('[osc-ingest]', message.error);
  }
}

function updateStats() {
  const t = nowEpoch();
  const scale = 1000 / Math.max(1, t - previous.t);
  const sends = stats.uiBatches + stats.eventBatches;
  stats.lastMsgsPerSec = Math.round((stats.msgTotal - previous.messages) * scale);
  stats.datagramsPerSec = Math.round((stats.pkts - previous.pkts) * scale);
  stats.filteredPerSec = Math.round((stats.msgFiltered - previous.filtered) * scale);
  stats.droppedPerSec = Math.round((stats.droppedOverflow - previous.dropped) * scale);
  stats.rendererMessagesPerSec = Math.round((sends - previous.sends) * scale);
  previous = { t, pkts: stats.pkts, messages: stats.msgTotal, filtered: stats.msgFiltered, dropped: stats.droppedOverflow, sends };
  stats.queueDepth = queueCount + actionQueue.length +
    [...inFlight.values()].reduce((sum, count) => sum + count, 0) +
    [...actionInFlight.values()].reduce((sum, batch) => sum + batch.items.length, 0);
  stats.ringEntries = ring.count;
  stats.ringOverflow = ring.overflow;
  stats.addressOverflow = ring.addressOverflow;
  stats.eventLoopMeanMs = Number.isFinite(loopDelay.mean) ? loopDelay.mean / 1e6 : 0;
  stats.eventLoopP99Ms = loopDelay.percentile(99) / 1e6;
  stats.eventLoopMaxMs = loopDelay.max / 1e6;
  loopDelay.reset();
  ring.trim(t - CFG.OSC_BUFFER_SECONDS * 1000);
  for (const [seq, ts] of claimed) if (ts < t - CFG.OSC_BUFFER_SECONDS * 1000) claimed.delete(seq);
  const message = { type: 'stats', stats: { ...stats } };
  if (!postMain(message)) post(message);
  if (rxDelta) { postMain({ type: 'rx-delta', n: rxDelta }); rxDelta = 0; }
}

function startStats() {
  if (statsTimer) return;
  loopDelay.enable();
  statsTimer = setInterval(updateStats, CFG.STATS_INTERVAL_MS);
}

function stopStats() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
  loopDelay.disable();
}

function queueUi(address, args, t) {
  if (!uiVisible && !captureSeen) return;
  if (!uiBatch.has(address) && uiBatch.size >= CFG.OSC_MAX_ADDRESSES) {
    stats.droppedOverflow++;
    return;
  }
  uiBatch.set(address, { address, args, ts: t });
  if (!uiTimer) uiTimer = setTimeout(flushUi, Math.max(CFG.UI_BATCH_MS, 1000 / CFG.UI_MAX_FPS));
}

function flushUi() {
  if (uiTimer) clearTimeout(uiTimer);
  uiTimer = null;
  if (!uiBatch.size || uiInFlight) return;
  const items = [...uiBatch.values()];
  uiBatch.clear();
  uiInFlight = true;
  if (post({ type: 'uiBatch', items })) { stats.uiBatches++; stats.uiSent += items.length; }
  else uiInFlight = false;
}

function queueEvent(address, args, t, bytes) {
  if (!recording && !learnMode && !captureSeen) return;
  if (queueCount >= CFG.OSC_EVENT_QUEUE_CAPACITY || queueBytes + bytes > CFG.OSC_EVENT_QUEUE_BYTES) {
    stats.droppedOverflow++; return;
  }
  const index = (queueHead + queueCount) % eventQueue.length;
  eventQueue[index] = { address, args, t, seq: ++sequence, session, record: recording, bytes };
  queueCount++;
  queueBytes += bytes;
  stats.queueHighWater = Math.max(stats.queueHighWater, queueCount);
  if (!eventTimer) eventTimer = setTimeout(flushEvents, CFG.UI_BATCH_MS);
}

function flushEvents() {
  if (eventTimer) clearTimeout(eventTimer);
  eventTimer = null;
  while (port && queueCount && inFlight.size < CFG.OSC_MAX_IN_FLIGHT_BATCHES) {
    const count = Math.min(queueCount, CFG.OSC_EVENT_BATCH_SIZE);
    const items = new Array(count);
    for (let i = 0; i < count; i++) items[i] = eventQueue[(queueHead + i) % eventQueue.length];
    const id = ++batchId;
    inFlight.set(id, count);
    if (!post({ type: 'eventBatch', id, items })) { inFlight.delete(id); break; }
    for (let i = 0; i < count; i++) {
      const index = (queueHead + i) % eventQueue.length;
      queueBytes -= eventQueue[index].bytes;
      eventQueue[index] = undefined;
    }
    queueHead = (queueHead + count) % eventQueue.length;
    queueCount -= count;
    stats.eventSent += count;
    stats.eventBatches++;
  }
}

function openSocket() {
  closeSocket();
  const socket = dgram.createSocket('udp4');
  udp = socket;
  socket.on('error', (error) => {
    if (udp !== socket) return;
    closeSocket();
    reportError(error, true);
  });
  socket.on('listening', () => {
    if (udp !== socket) return;
    socketReady = true;
    stats.recvBufRequested = CFG.OSC_RECV_BUFFER_BYTES;
    try { socket.setRecvBufferSize(CFG.OSC_RECV_BUFFER_BYTES); }
    catch (error) { reportError('UDP receive buffer: ' + error.message); }
    try { stats.recvBufActual = socket.getRecvBufferSize(); } catch (_) { stats.recvBufActual = 0; }
    stats.recvBufWarn = stats.recvBufActual < stats.recvBufRequested;
    const message = { type: 'ready', port: listenPort, actualPort: socket.address().port,
      recvBuf: { requested: stats.recvBufRequested, actual: stats.recvBufActual, warn: stats.recvBufWarn } };
    if (!postMain(message)) post(message);
    startStats();
  });
  socket.on('message', (buffer) => { if (udp === socket) onPacket(buffer); });
  socket.bind({ address: '0.0.0.0', port: listenPort });
}

function closeSocket() {
  stopStats();
  const old = udp;
  udp = null;
  socketReady = false;
  if (old) { try { old.close(); } catch (_) {} }
  const message = { type: 'closed' };
  if (!postMain(message)) post(message);
}

function isDiscrete(address) {
  return address.endsWith('/connect') || address.endsWith('/clear') || address.endsWith('/playmode');
}

function queueAction(action) {
  const bytes = retainedSize(action);
  if (actionQueue.length >= CFG.REC_ACTION_QUEUE_CAPACITY || actionBytes + bytes > CFG.OSC_EVENT_QUEUE_BYTES) {
    stats.droppedOverflow++;
    recordWarning('REC action queue overflow; recording is incomplete.');
    return;
  }
  actionQueue.push(action);
  actionBytes += bytes;
}

function recordWarning(text) {
  const t = nowEpoch();
  if (t - lastRecordWarning < CFG.OSC_DEBUG_INTERVAL_MS) return;
  lastRecordWarning = t;
  post({ type: 'recordWarning', session: recSession, text });
}

function flushActions() {
  while (port && actionQueue.length && actionInFlight.size < CFG.REC_ACTION_MAX_IN_FLIGHT) {
    const items = actionQueue.slice(0, CFG.REC_ACTION_BATCH_SIZE);
    const batchId = ++actionBatchSeq;
    const mappings = [...pendingMappings].slice(0, CFG.REC_ACTION_BATCH_SIZE);
    const batch = { type: 'recordActions', session: recSession, batchId, items, mappings };
    actionInFlight.set(batchId, batch);
    if (!post(batch)) { actionInFlight.delete(batchId); break; }
    for (const [key] of mappings) pendingMappings.delete(key);
    actionQueue.splice(0, items.length);
    stats.eventSent += items.length;
    stats.eventBatches++;
  }
  if (recorder && recCutoff !== null && recorder.isDrained() && !actionQueue.length && !actionInFlight.size) {
    pendingMappings.clear();
    post({ type: 'recordDrained', session: recSession, cutoff: recCutoff });
    recorder = null;
    recSession = null;
    recCutoff = null;
  }
}

function retainedSize(value) {
  if (typeof value === 'string') return value.length * 2;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (Array.isArray(value)) {
    let bytes = value.length * 8;
    for (const item of value) bytes += retainedSize(item);
    return bytes;
  }
  if (value && typeof value === 'object') {
    let bytes = 0;
    for (const [key, item] of Object.entries(value)) bytes += key.length * 2 + retainedSize(item);
    return bytes;
  }
  return 8;
}

function onPacket(buffer) {
  stats.pkts++;
  rxDelta++;
  // A visible monitor is not permission to decode arbitrary background telemetry.
  if (!recording && !recorder && !learnMode && !captureSeen) { stats.idlePackets++; return; }
  const t = nowEpoch();
  const result = parsePacket(buffer, filter, { onMessage(address, args) {
    stats.msgKept++;
    const echoIndex = echoTokens.findIndex((item) => item.t <= t && t - item.t <= CFG.REC_ECHO_WINDOW_MS &&
      item.address === address && item.signature === JSON.stringify(args));
    if (echoIndex >= 0) echoTokens.splice(echoIndex, 1);
    else if (recorder) recorder.ingestOsc({ address, args, t, seq: ++sequence });
    const value = args.find((arg) => typeof arg === 'number' || typeof arg === 'boolean');
    if (value !== undefined) {
      if (!ring.push(address, Number(value), t, isDiscrete(address) ? 1 : 0)) stats.msgRateLimited++;
    }
    // Recording transport preserves every accepted event and all arguments.
    queueEvent(address, args, t, address.length * 2 + retainedSize(args));
    queueUi(address, args, t);
  } });
  stats.msgTotal += result.received;
  stats.msgFiltered += result.filtered;
  stats.malformed += result.malformed;
  stats.bundleDepthMax = Math.max(stats.bundleDepthMax, result.maxDepth);
}

function scoreMatch(address, t, midi) {
  const parts = address.split('/');
  let score = 60 * Math.max(0, 1 - Math.abs(t - midi.startTs) / (CFG.MATCH_WINDOW_MS + CFG.MATCH_PRE_MS));
  if (parts[1] === 'composition' && parts[2] === 'layers') score += 60;
  if (address.endsWith('/connect')) score += 30;
  if (midi.family && !address.includes(midi.family)) score -= 20;
  return score;
}

function selectMidi(midi) {
  const end = (midi.kind === 'float' ? midi.endTs : midi.startTs) + CFG.MATCH_WINDOW_MS;
  let best = null;
  ring.flushPending(nowEpoch(), true);
  ring.forEachInWindow(midi.startTs - CFG.MATCH_PRE_MS, end, (addrId, value, t, kind, seq) => {
    if (claimed.has(seq)) return;
    const address = ring.addressOf(addrId);
    if (midi.kind !== 'float' && !isDiscrete(address)) return;
    if (midi.kind === 'float' && isDiscrete(address)) return;
    const score = scoreMatch(address, t, midi);
    if (!best || score > best.score) best = { address, value, t, seq, score };
  });
  if (best) claimed.set(best.seq, best.t);
  return best;
}

function finalizeMidi(id) {
  const midi = pendingMidi.get(id);
  if (!midi) return;
  pendingMidi.delete(id);
  const best = midi.searched ? midi.best : selectMidi(midi);
  if (!best) { post({ type: 'unmatched', id }); return; }
  post({ type: 'matched', id, address: best.address, value: best.value,
    latencyMs: best.t - midi.startTs, score: best.score });
}

function maintain() {
  const t = nowEpoch();
  while (echoTokens.length && t - echoTokens[0].t > CFG.REC_ECHO_WINDOW_MS) echoTokens.shift();
  ring.flushPending(t);
  filter.setLearning(learnMode || captureSeen || t < floatLearningUntil);
  if (recorder) recorder.tick(t);
  flushActions();
  if (recorder && !previewInFlight && t - lastPreviewAt >= CFG.REC_PREVIEW_MS) {
    lastPreviewAt = t;
    previewInFlight = post({ type: 'recordPreview', session: recSession, items: recorder.preview(t) });
  }
  // Resolve only on MIDI deadlines, never scan pending MIDI for each OSC packet.
  for (const [id, midi] of pendingMidi) {
    // Cache a note's onset match before ring retention expires; deliver only after release.
    if (midi.kind !== 'float' && !midi.searched && t >= midi.startTs + CFG.MATCH_WINDOW_MS) {
      midi.best = selectMidi(midi);
      midi.searched = true;
    }
    if (midi.endTs !== null && t >= midi.endTs + CFG.MATCH_WINDOW_MS) finalizeMidi(id);
  }
}
setInterval(maintain, CFG.OSC_MAINTENANCE_MS);

function attachPort(next) {
  if (port) { try { port.close(); } catch (_) {} }
  stats.droppedOverflow += [...inFlight.values()].reduce((sum, count) => sum + count, 0);
  inFlight.clear();
  if (actionInFlight.size) {
    stats.droppedOverflow += [...actionInFlight.values()].reduce((sum, batch) => sum + batch.items.length, 0);
    actionInFlight.clear();
    actionBytes = actionQueue.reduce((sum, action) => sum + retainedSize(action), 0);
  }
  uiInFlight = false;
  previewInFlight = false;
  port = next;
  port.on('message', (event) => handleMessage(event.data));
  if (port.start) port.start();
  post({ type: 'portReady' });
  postMain({ type: 'portReady' });
  flushEvents();
  flushActions();
}

function handleMessage(message) {
  if (!message || !message.type) return;
  switch (message.type) {
    case 'init':
      if (message.port) attachPort(message.port);
      if (message.filter) applyFilter(message.filter);
      break;
    case 'setPort':
      listenPort = Number(message.port) || 7000;
      openSocket();
      break;
    case 'closePort': closeSocket(); break;
    case 'filter': applyFilter(message.filter || {}); break;
    case 'recording':
      if (recording && (!message.on || message.session !== session)) {
        ring.flushPending(nowEpoch(), true);
        flushEvents();
      }
      recording = !!message.on;
      session = message.session === undefined ? session : message.session;
      break;
    case 'recStart':
      if (recorder) {
        post({ type: 'recordRejected', session: message.session, text: 'Previous recording session has not drained.' });
        break;
      }
      if (!udp || !socketReady) {
        post({ type: 'recordRejected', session: message.session, text: 'OSC UDP input is not listening.' });
        break;
      }
      recSession = message.session;
      recCutoff = null;
      echoTokens.length = 0;
      pendingMappings.clear();
      lastRecordWarning = -Infinity;
      lastPreviewAt = -Infinity;
      previewInFlight = false;
      recorder = new RecordingSession({
        config: { USE_LEARNED_MAPPING_FALLBACK: message.config &&
          typeof message.config.USE_LEARNED_MAPPING_FALLBACK === 'boolean'
          ? message.config.USE_LEARNED_MAPPING_FALLBACK : CFG.USE_LEARNED_MAPPING_FALLBACK },
        emit: queueAction,
        onMapping: (key, mapping) => {
          if (pendingMappings.size < CFG.REC_MAPPING_MAX || pendingMappings.has(key)) pendingMappings.set(key, mapping);
          else recordWarning('MIDI mapping table is full.');
        },
        onWarning: recordWarning
      });
      try {
        recorder.start(message);
        post({ type: 'recordStarted', session: recSession });
      } catch (error) {
        recorder = null;
        recSession = null;
        recCutoff = null;
        post({ type: 'recordRejected', session: message.session, text: error.message });
      }
      break;
    case 'recMidi':
      if (recorder && message.session === recSession && recCutoff === null) {
        if (message.event && message.event.kind === 'cc') {
          floatLearningUntil = nowEpoch() + CFG.FLOAT_IDLE_TIMEOUT_MS + CFG.MATCH_WINDOW_MS;
          filter.setLearning(true);
        }
        recorder.midi(message.event);
      }
      break;
    case 'recTx':
      if (recorder && echoTokens.length < CFG.REC_ECHO_MAX_PENDING) {
        echoTokens.push({ address: message.address, signature: JSON.stringify(message.args), t: message.t ?? nowEpoch() });
      }
      break;
    case 'recStop':
      if (recorder && message.session === recSession && recCutoff === null) {
        recCutoff = Number.isFinite(message.cutoff) ? message.cutoff : nowEpoch();
        recorder.finish(recCutoff);
        recorder.tick(nowEpoch());
        flushActions();
      }
      break;
    case 'recordAck':
      if (actionInFlight.has(message.batchId)) {
        for (const action of actionInFlight.get(message.batchId).items) actionBytes -= retainedSize(action);
      }
      actionInFlight.delete(message.batchId);
      flushActions();
      break;
    case 'previewAck': previewInFlight = false; break;
    case 'recAbort':
      if (message.session === recSession) {
        recorder = null; recSession = null; recCutoff = null;
        actionQueue.length = 0; actionInFlight.clear(); pendingMappings.clear(); actionBytes = 0;
        previewInFlight = false;
      }
      break;
    case 'learn':
      learnMode = !!message.on;
      filter.setLearning(learnMode || captureSeen || nowEpoch() < floatLearningUntil);
      break;
    case 'captureSeen':
      captureSeen = !!message.on;
      filter.setLearning(learnMode || captureSeen || nowEpoch() < floatLearningUntil);
      break;
    case 'uiVisible':
      uiVisible = !!message.on;
      if (!uiVisible) { uiBatch.clear(); if (uiTimer) clearTimeout(uiTimer); uiTimer = null; }
      break;
    case 'debug': debugLog = !!message.on; break;
    case 'eventAck':
      inFlight.delete(message.id);
      flushEvents();
      break;
    case 'uiAck':
      uiInFlight = false;
      if (uiBatch.size && !uiTimer) uiTimer = setTimeout(flushUi, Math.max(CFG.UI_BATCH_MS, 1000 / CFG.UI_MAX_FPS));
      break;
    case 'midiStart':
      if (pendingMidi.size >= CFG.OSC_PENDING_MIDI_MAX) {
        stats.droppedOverflow++;
        post({ type: 'unmatched', id: message.id });
      } else pendingMidi.set(message.id, { kind: message.kind, startTs: message.ts ?? nowEpoch(), endTs: null, family: message.family });
      break;
    case 'midiEnd': {
      const midi = pendingMidi.get(message.id);
      if (midi) midi.endTs = message.ts ?? nowEpoch();
      else post({ type: 'unmatched', id: message.id });
      break;
    }
    case 'querySeen': {
      const t = nowEpoch();
      const items = [];
      for (const [id, item] of ring.latestById(t - CFG.OSC_BUFFER_SECONDS * 1000, t)) {
        items.push({ address: ring.addressOf(id), value: item.value, ts: item.ts });
      }
      post({ type: 'seen', items });
      break;
    }
    case 'reset':
      ring.clear(); pendingMidi.clear(); claimed.clear();
      break;
    case 'trim': ring.trim(nowEpoch() - CFG.OSC_BUFFER_SECONDS * 1000); break;
  }
}

function applyFilter(settings) {
  if (settings.whitelist) filter.setWhitelist(settings.whitelist);
  if (settings.blacklist) filter.setBlacklist(settings.blacklist);
  if (settings.learnAddresses) filter.setLearnAddresses(settings.learnAddresses);
}

if (process.parentPort) {
  process.parentPort.on('message', (event) => {
    if (event.data && event.data.type === 'port' && event.ports && event.ports[0]) attachPort(event.ports[0]);
    else handleMessage(event.data);
  });
}
process.on('message', handleMessage);
// Report, then terminate so the parent can restore a fresh, consistent process.
process.on('uncaughtException', (error) => { reportError(error, true); process.exit(1); });

module.exports = { nowEpoch };
