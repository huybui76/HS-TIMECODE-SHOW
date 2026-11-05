#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const config = require('../realtime-config');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
// Execute production lifecycle, window wiring and OSC IPC, not copied implementations.
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `production section: ${start}`);
  return source.slice(from, to);
}
const production = section('const { app,', 'function senderPort()') +
  section('function createWindow()', '/* Giữ renderer thức') +
  section("ipcMain.handle('osc-enable'", "ipcMain.handle('project-save'");
const plain = (value) => JSON.parse(JSON.stringify(value));

function harness() {
  const processes = [], channels = [], timeouts = new Map(), intervals = new Map();
  const handles = new Map(), listeners = new Map();
  let nextTimer = 1, forkErrors = 0;
  class Port {
    constructor() { this.closed = false; this.started = false; }
    close() { this.closed = true; }
    start() { this.started = true; }
    postMessage(msg) { this.lastMessage = msg; }
  }
  class Channel {
    constructor() { this.port1 = new Port(); this.port2 = new Port(); channels.push(this); }
  }
  class Proc extends EventEmitter {
    constructor() { super(); this.sent = []; this.kills = 0; }
    postMessage(msg, ports = []) { this.sent.push({ msg: plain(msg), ports }); }
    kill() { this.kills++; }
    messages(type) { return this.sent.filter((entry) => entry.msg.type === type).map((entry) => entry.msg); }
  }
  class Window {
    constructor() {
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        loading: false, sent: [], transferred: [],
        isLoading() { return this.loading; },
        send(channel, msg) { this.sent.push({ channel, msg: plain(msg) }); },
        postMessage(channel, msg, ports) { this.transferred.push({ channel, msg, ports }); }
      });
    }
    isDestroyed() { return false; }
    loadFile() {}
  }
  const electron = {
    app: { getPath: () => '/mock-user-data' }, BrowserWindow: Window,
    ipcMain: {
      handle: (name, fn) => handles.set(name, fn),
      on: (name, fn) => listeners.set(name, fn)
    },
    utilityProcess: {
      fork() {
        if (forkErrors) { forkErrors--; throw new Error('mock fork failed'); }
        const proc = new Proc(); processes.push(proc); return proc;
      }
    },
    MessageChannelMain: Channel
  };
  const context = vm.createContext({
    __dirname: root, process: { env: {} }, console: { error() {} },
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'path') return path;
      if (name === 'fs') return { readFileSync() { throw new Error('no saved mini settings'); } };
      if (name === './realtime-config') return config;
      if (['dgram', 'osc', './osc-targets', './lan-sync'].includes(name)) return {};
      throw new Error(`Unexpected require: ${name}`);
    },
    setTimeout(fn, delay) { const id = nextTimer++; timeouts.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn, delay) { const id = nextTimer++; intervals.set(id, { fn, delay }); return id; },
    clearInterval(id) { intervals.delete(id); }
  });
  vm.runInContext(production, context, { filename: 'main.js:lifecycle' });
  context.createWindow();
  const win = vm.runInContext('win', context);
  return {
    context, win, processes, channels, timeouts, intervals, listeners,
    invoke: (name, ...args) => handles.get(name)({ sender: win.webContents }, ...args),
    send: (name, msg) => listeners.get(name)({ sender: win.webContents }, msg),
    read: (expression) => vm.runInContext(expression, context),
    failForks: (count) => { forkErrors = count; },
    fireTimeout() {
      const [id, timer] = timeouts.entries().next().value;
      timeouts.delete(id); timer.fn(); return timer.delay;
    }
  };
}

let passed = 0;
function test(name, fn) {
  fn(); passed++;
  console.log(`PASS ${name}`);
}

test('enable waits for parent handshake, restores filter/modes, binds exactly once', () => {
  const h = harness();
  h.invoke('port-set', 8123);
  const extra = '/composition/layers/2/video/opacity';
  h.invoke('osc-float-addresses', [extra, extra]);
  h.send('osc-mode', { type: 'recording', on: true, session: 9 });
  h.send('osc-ui', { type: 'uiVisible', on: true });
  assert.equal(h.invoke('osc-enable'), true);
  const proc = h.processes[0];
  assert.equal(h.channels.length, 1, 'no unused main relay channel');
  assert.equal(proc.messages('setPort').length, 0);
  assert.equal(h.timeouts.size, 0, 'no 120ms timer');
  assert.equal(h.read('oscListening'), false);
  proc.emit('message', { type: 'portReady' });
  assert.deepEqual(proc.sent.map((entry) => entry.msg.type), ['port', 'filter', 'recording', 'uiVisible', 'setPort']);
  assert.deepEqual(proc.messages('filter')[0].filter.whitelist, [...config.DEFAULT_WHITELIST, extra]);
  assert.deepEqual(proc.messages('recording')[0], { type: 'recording', on: true, session: 9 });
  assert.equal(proc.messages('setPort')[0].port, 8123);
  proc.emit('message', { type: 'portReady' });
  h.invoke('osc-enable');
  assert.equal(proc.messages('setPort').length, 1);
  assert.equal(h.processes.length, 1);
  assert.equal(h.read('oscListening'), false);
  proc.emit('message', { type: 'ready', actualPort: 8123 });
  assert.equal(h.read('oscListening'), true);
  assert.equal(h.intervals.size, 1);
  assert.equal([...h.intervals.values()][0].delay, config.STATS_INTERVAL_MS);
});

test('disable before handshake ignores late handshake/exit and closes pending port', () => {
  const h = harness();
  h.win.webContents.loading = true;
  h.invoke('osc-enable');
  const proc = h.processes[0];
  h.invoke('osc-disable');
  assert.equal(proc.kills, 1);
  assert.equal(proc.messages('closePort').length, 1);
  assert.equal(h.channels[0].port2.closed, true);
  proc.emit('message', { type: 'portReady' });
  proc.emit('message', { type: 'ready' });
  proc.emit('exit', 0);
  assert.equal(proc.messages('setPort').length, 0);
  assert.equal(h.timeouts.size, 0);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.read('oscDesiredOn'), false);
  assert.equal(h.read('oscListening'), false);
});

test('disable cancels crash backoff and even a queued canceled callback cannot respawn', () => {
  const h = harness();
  h.invoke('osc-enable');
  const proc = h.processes[0];
  proc.emit('message', { type: 'portReady' });
  proc.emit('message', { type: 'ready' });
  proc.emit('exit', 1);
  assert.equal(h.intervals.size, 0);
  const timer = [...h.timeouts.values()][0];
  assert.equal(timer.delay, config.OSC_RESTART_INITIAL_MS);
  h.invoke('osc-disable');
  timer.fn();
  assert.equal(h.processes.length, 1);
  assert.equal(h.timeouts.size, 0);
});

test('crash respawns and restores latest absent-process settings before UDP bind', () => {
  const h = harness();
  for (const type of ['recording', 'learn', 'debug']) h.send('osc-mode', { type, on: true });
  for (const type of ['uiVisible', 'captureSeen']) h.send('osc-ui', { type, on: true });
  h.invoke('osc-enable');
  const old = h.processes[0];
  old.emit('message', { type: 'portReady' });
  old.emit('message', { type: 'ready' });
  old.emit('exit', 1);
  h.send('osc-mode', { type: 'debug', on: false });
  h.invoke('osc-float-addresses', ['/exact/learned/float']);
  h.invoke('port-set', 9001);
  h.fireTimeout();
  const proc = h.processes[1];
  assert.equal(proc.messages('setPort').length, 0);
  proc.emit('message', { type: 'portReady' });
  assert.deepEqual(proc.sent.map((entry) => entry.msg.type),
    ['port', 'filter', 'recording', 'learn', 'debug', 'uiVisible', 'captureSeen', 'setPort']);
  assert.deepEqual(proc.messages('debug'), [{ type: 'debug', on: false }]);
  assert.deepEqual(proc.messages('filter')[0].filter.whitelist, [...config.DEFAULT_WHITELIST, '/exact/learned/float']);
  assert.equal(proc.messages('setPort')[0].port, 9001);
  const count = h.win.webContents.sent.length;
  for (const type of ['ready', 'closed', 'error', 'stats', 'rx-delta', 'portReady']) {
    old.emit('message', { type, fatal: true, n: 99, stats: { droppedOverflow: 99 } });
  }
  old.emit('exit', 2);
  assert.equal(h.read('oscProc'), proc);
  assert.equal(h.read('rxCounter'), 0);
  assert.equal(h.win.webContents.sent.length, count);
  assert.equal(h.timeouts.size, 0);
});

test('rapid disable/re-enable cannot be clobbered by old exit or messages', () => {
  const h = harness();
  h.invoke('osc-enable');
  const old = h.processes[0];
  h.invoke('osc-disable');
  h.invoke('osc-enable');
  const proc = h.processes[1];
  proc.emit('message', { type: 'portReady' });
  proc.emit('message', { type: 'ready' });
  old.emit('exit', 0);
  old.emit('message', { type: 'closed' });
  assert.equal(h.read('oscProc'), proc);
  assert.equal(h.read('oscListening'), true);
  assert.equal(h.intervals.size, 1);
  assert.equal(h.timeouts.size, 0);
});

test('renderer reload replaces transferred port, never rebinds UDP', () => {
  const h = harness();
  h.invoke('osc-enable');
  const proc = h.processes[0];
  proc.emit('message', { type: 'portReady' });
  proc.emit('message', { type: 'ready' });
  const original = h.win.webContents.transferred[0].ports[0];
  h.win.webContents.emit('did-finish-load');
  assert.equal(h.channels.length, 2);
  assert.equal(proc.messages('port').length, 2);
  const replacement = h.win.webContents.transferred[1].ports[0];
  assert.notEqual(original, replacement);
  assert.equal(replacement, h.channels[1].port2);
  assert.equal(proc.sent.filter((entry) => entry.msg.type === 'port')[1].ports[0], h.channels[1].port1);
  proc.emit('message', { type: 'portReady' });
  assert.equal(proc.messages('setPort').length, 1);
  assert.equal(h.read('oscListening'), true);
});

test('initial renderer loading reuses pending port, crash/disable close pending handles', () => {
  const h = harness();
  h.win.webContents.loading = true;
  h.invoke('osc-enable');
  assert.equal(h.win.webContents.transferred.length, 0);
  h.win.webContents.loading = false;
  h.win.webContents.emit('did-finish-load');
  assert.equal(h.channels.length, 1);
  assert.equal(h.win.webContents.transferred.length, 1);
  h.processes[0].emit('exit', 1);
  h.win.webContents.loading = true;
  h.fireTimeout();
  h.processes[1].emit('exit', 1);
  assert.equal(h.channels[1].port2.closed, true);
  h.invoke('osc-disable');
  assert.equal(h.timeouts.size, 0);
});

test('port changes bind only after handshake and float whitelist replaces cached extras', () => {
  const h = harness();
  h.invoke('port-set', 8001);
  assert.equal(h.processes.length, 0);
  h.invoke('osc-enable');
  const proc = h.processes[0];
  h.invoke('port-set', 8002);
  h.invoke('osc-float-addresses', ['/first']);
  assert.equal(proc.messages('filter').length, 0);
  proc.emit('message', { type: 'portReady' });
  assert.equal(proc.messages('setPort')[0].port, 8002);
  h.invoke('port-set', 8003);
  assert.equal(proc.messages('setPort')[1].port, 8003);
  h.invoke('osc-float-addresses', ['/second', '/second']);
  assert.deepEqual(proc.messages('filter')[1].filter.whitelist, [...config.DEFAULT_WHITELIST, '/second']);
  const filters = proc.messages('filter').length;
  h.invoke('osc-float-addresses', null);
  assert.deepEqual(proc.messages('filter')[filters].filter.whitelist, config.DEFAULT_WHITELIST);
});

test('parent rx-delta updates counters silently and stats use a single bounded status path', () => {
  const h = harness();
  h.invoke('osc-enable');
  const proc = h.processes[0];
  proc.emit('message', { type: 'portReady' });
  proc.emit('message', { type: 'ready' });
  h.win.webContents.sent.length = 0;
  proc.emit('message', { type: 'rx-delta', n: 7 });
  proc.emit('message', { type: 'rx-delta', n: 3 });
  assert.equal(h.win.webContents.sent.length, 0);
  assert.equal(h.read('rxCounter'), 10);
  assert.equal(h.read('stats.rx'), 10);
  proc.emit('message', { type: 'stats', stats: { droppedOverflow: 5 } });
  assert.equal(h.read('oscQueueDropped'), 5);
  assert.equal(h.win.webContents.sent.length, 1);
  assert.equal(h.win.webContents.sent[0].channel, 'osc-proc');
  [...h.intervals.values()][0].fn();
  assert.deepEqual(h.win.webContents.sent[1], { channel: 'stats', msg: { rx: 10, tx: 0 } });
  proc.emit('message', { type: 'stats', stats: { droppedOverflow: 0 } });
  assert.equal(h.read('oscQueueDropped'), 0);
  proc.emit('message', { type: 'error', fatal: true, error: 'EADDRINUSE' });
  assert.equal(h.read('oscListening'), false);
  assert.equal(h.intervals.size, 0);
  assert.equal(proc.kills, 1, 'fatal socket error must terminate the unusable process');
  proc.emit('exit', 1);
  assert.equal(h.timeouts.size, 1, 'fatal socket failure follows bounded restart backoff');
  h.fireTimeout();
  const retry = h.processes[1];
  retry.emit('message', { type: 'portReady' });
  assert.equal(retry.messages('setPort').length, 1);
});

test('fork failures back off, cap retries and manual enable resets the budget', () => {
  const h = harness();
  h.failForks(config.OSC_PROC_MAX_RESTARTS + 1);
  h.invoke('osc-enable');
  let retries = 0;
  while (h.timeouts.size) {
    const expected = Math.min(config.OSC_RESTART_MAX_MS, config.OSC_RESTART_INITIAL_MS * 2 ** retries);
    assert.equal(h.fireTimeout(), expected);
    retries++;
  }
  assert.equal(retries, config.OSC_PROC_MAX_RESTARTS);
  assert.equal(h.read('oscDesiredOn'), false);
  h.invoke('osc-enable');
  assert.equal(h.processes.length, 1);
  assert.equal(h.read('oscProcRestarts'), 0);
});

test('duplicate exit cannot schedule multiple restarts; ready resets delay not total budget', () => {
  const h = harness();
  h.invoke('osc-enable');
  h.processes[0].emit('exit', 1);
  h.processes[0].emit('exit', 1);
  assert.equal(h.timeouts.size, 1);
  h.invoke('osc-enable');
  assert.equal(h.timeouts.size, 1);
  h.fireTimeout();
  h.processes[1].emit('message', { type: 'portReady' });
  h.processes[1].emit('message', { type: 'ready' });
  h.processes[1].emit('exit', 1);
  assert.equal(h.read('oscProcRestarts'), 2);
  assert.equal([...h.timeouts.values()][0].delay, config.OSC_RESTART_INITIAL_MS);
});

test('preload closes superseded renderer port without requiring local config', () => {
  const ipcRenderer = new EventEmitter();
  let hs;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'preload.js'), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return { ipcRenderer, contextBridge: { exposeInMainWorld(name, api) { assert.equal(name, 'hs'); hs = api; } } };
    }
  }, { filename: 'preload.js' });
  const ports = [0, 1].map(() => ({ closed: false, start() {}, close() { this.closed = true; } }));
  const received = [];
  hs.onOscPort((port) => received.push(port));
  ipcRenderer.emit('osc-port', { ports: [ports[0]] });
  ipcRenderer.emit('osc-port', { ports: [ports[1]] });
  assert.equal(ports[0].closed, true);
  assert.equal(ports[1].closed, false);
  assert.equal(received.length, 2);
  assert.equal(hs.realtimeConfig, undefined);
});

console.log(`\n${passed} passed, 0 failed (mock processes/channels/timers; no Electron or network)`);
