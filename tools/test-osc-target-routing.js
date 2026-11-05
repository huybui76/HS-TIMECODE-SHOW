'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const osc = require('osc');
const source = fs.readFileSync(path.join(__dirname, '..', 'osc-targets.js'), 'utf8');
const sent = [];
const socket = { on() {}, unref() {}, send(buffer, port, host, cb) {
  sent.push({ message: osc.readPacket(Uint8Array.from(buffer), {}), port, host }); cb(null);
} };
const context = vm.createContext({ Buffer, console, setTimeout, clearTimeout, module: { exports: {} },
  require: (name) => name === 'dgram' ? { createSocket: () => socket } :
    name.startsWith('./') ? require(path.join(__dirname, '..', name)) : require(name) });
vm.runInContext(source, context);
const exported = context.module.exports;
const Targets = exported.OscTargets || exported;
const targets = new Targets();
targets.setTargets([
  { id: 'a', host: '127.0.0.1', port: 7001, enabled: true },
  { id: 'b', host: '127.0.0.2', port: 7002, enabled: true },
  { id: 'c', host: '127.0.0.3', port: 7003, enabled: false }
]);
assert.equal(targets.send('/test', [0.5]), 2);
assert.deepEqual(sent.splice(0).map((item) => item.port), [7001, 7002]);
assert.equal(targets.send('/test', [1], ['b']), 1);
assert.equal(sent.splice(0)[0].host, '127.0.0.2');
assert.equal(targets.send('/test', [1], ['c', 'missing']), 0);
assert.equal(targets.send('/test', [1], []), 0);
assert.equal(sent.length, 0);
assert.equal(targets.send('/test', [1], ['a', 'a']), 1);
assert.equal(sent.length, 1);
console.log('PASS target fanout, explicit route, disabled/missing, empty list, duplicate IDs');

const ipc = new Map();
let tx = 0;
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = main.indexOf("ipcMain.handle('osc-send'");
const end = main.indexOf('\n/* ===== IPC:', start);
const mainContext = vm.createContext({
  ipcMain: { handle: (name, fn) => ipc.set(name, fn) },
  ensureOscTargets: () => targets,
  stats: { get tx() { return tx; }, set tx(value) { tx = value; } },
  Buffer, osc, encodeOsc: require('../osc-encode').encodeOsc,
  target: { host: 'legacy', port: 7999 }, senderPort: () => socket, console
});
vm.runInContext(main.slice(start, end), mainContext);
sent.length = 0;
assert.equal(ipc.get('osc-send')(null, { address: '/test', args: [1], targetIds: ['b'] }), 1);
assert.equal(tx, 1);
assert.equal(sent[0].port, 7002);
assert.equal(ipc.get('osc-send')(null, { address: '/test', args: [1], targetIds: [] }), 0);
assert.equal(tx, 1);
assert.equal(sent.length, 1);
console.log('PASS production main IPC explicit target selection never falls back or broadcasts');

const payload = [1, 'Ti\u1ebfng Vi\u1ec7t', [2, null], new Uint8Array([4, 5]), null, true];
sent.length = 0;
assert.equal(targets.send('/test', payload, ['a']), 1);
const decoded = sent[0].message.args;
assert.equal(decoded[1], payload[1]);
assert.deepEqual(decoded[2], [2, null]);
assert.deepEqual(Array.from(decoded[3]), [4, 5]);
assert.equal(decoded[4], null);
assert.equal(decoded[5], true);
targets.setTargets([]);
assert.equal(ipc.get('osc-send')(null, { address: '/legacy', args: payload }), 1);
assert.equal(sent.at(-1).message.args[4], null);
assert.equal(sent.at(-1).host, 'legacy');
const { encodeOsc } = require('../osc-encode');
const view = new DataView(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2);
assert.deepEqual(Array.from(osc.readPacket(Uint8Array.from(encodeOsc('/view', [view])), {}).args[0]), [2, 3]);
console.log('PASS Nil/UTF8/nested/blob encoding in selected and legacy outputs; DataView blob');
