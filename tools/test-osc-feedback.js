#!/usr/bin/env node
/* =====================================================================
   HS TIMECODE · Test OSC FEEDBACK (throttle, giới hạn bộ nhớ, bộ lọc)
   Chạy: node tools/test-osc-feedback.js
   ===================================================================== */
'use strict';

const path = require('path');
const F = require(path.join(__dirname, '..', 'renderer', 'osc-feedback.js'));
const { OscFeedback, DEFAULTS, isRecNoise, argsKey } = F;

let pass = 0, fail = 0;
const results = [];
function test(id, name, fn) {
  try { fn(); pass++; results.push({ id, name, ok: true }); }
  catch (e) { fail++; results.push({ id, name, ok: false, msg: e.message }); }
}
function ok(c, m) { if (!c) throw new Error(m || 'điều kiện sai'); }
function eq(a, b, m) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'eq'}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
}

/* ---------------- 1. Giới hạn bộ nhớ: 100.000 message cùng address/args ---------------- */
test('F1', '100k message cùng address/args → lịch sử hữu hạn', () => {
  const fb = new OscFeedback();
  for (let i = 0; i < 100000; i++) fb.ingest('/composition/layers/1/video/position', [0.25, 0.5], i);
  ok(fb.seenHistoryEntries() <= DEFAULTS.seenMaxAddr * DEFAULTS.seenMaxArgsPerAddr,
    `history ${fb.seenHistoryEntries()} phải ≤ ${DEFAULTS.seenMaxAddr * DEFAULTS.seenMaxArgsPerAddr}`);
  ok(fb.pendingMonitor() <= DEFAULTS.pendingMax, 'pending monitor có giới hạn');
  ok(fb.seenAddrCount() === 1, 'chỉ 1 địa chỉ');
  ok(fb.droppedMon > 0, 'overflow được đếm (không âm thầm)');
});

test('F2', '100k message nhiều address khác nhau → số địa chỉ bị chặn', () => {
  const fb = new OscFeedback();
  for (let i = 0; i < 100000; i++) fb.ingest('/x/' + (i % 5000), [i], i);
  ok(fb.seenAddrCount() <= DEFAULTS.seenMaxAddr, `seen ${fb.seenAddrCount()} ≤ ${DEFAULTS.seenMaxAddr}`);
  ok(fb.seenHistoryEntries() <= DEFAULTS.seenMaxAddr * DEFAULTS.seenMaxArgsPerAddr);
});

/* ---------------- 2. Throttle render ---------------- */
test('F3', 'Panel ẩn → KHÔNG render; 10.000 message = 0 lần flush', () => {
  const fb = new OscFeedback();
  let monFlushes = 0, seenFlushes = 0;
  fb.onMonitorFlush = () => monFlushes++;
  fb.onSeenFlush = () => seenFlushes++;
  fb.panelVisible = false;
  for (let i = 0; i < 10000; i++) fb.ingest('/a', [i], i);
  fb.tick(100000);
  eq(monFlushes, 0, 'monitor không render khi ẩn');
  eq(seenFlushes, 0, 'seen không render khi ẩn');
  ok(fb.pendingMonitor() <= DEFAULTS.pendingMax, 'pending vẫn bị chặn');
});

test('F4', 'Panel mở → render theo nhịp, không theo từng message', () => {
  const fb = new OscFeedback({ monitorFlushMs: 60, seenFlushMs: 120 });
  let monFlushes = 0, monRows = 0;
  fb.onMonitorFlush = (rows) => { monFlushes++; monRows += rows.length; };
  fb.panelVisible = true;
  // 10.000 message trải 10.000ms (1 msg/ms) → tick mỗi ms
  for (let i = 0; i < 10000; i++) {
    fb.ingest('/a', [i], i);
    fb.tick(i);
  }
  // 10.000ms / 60ms ≈ 167 lần, cho phép +2 sai số biên
  ok(monFlushes <= Math.floor(10000 / 60) + 2, `flushes ${monFlushes} ≤ ${Math.floor(10000 / 60) + 2}`);
  ok(monFlushes < 10000 / 10, 'ít hơn nhiều so với 1 lần/message');
  ok(monRows > 0, 'có dòng được render');
  // Tổng số dòng qua các đợt có thể > buffer, nhưng BUFFER/DOM phải bị cắt:
  ok(fb.monitorCount() <= DEFAULTS.monitorMaxRows, `buffer ${fb.monitorCount()} ≤ ${DEFAULTS.monitorMaxRows}`);
  ok(fb.pendingMonitor() <= DEFAULTS.pendingMax, 'pending có giới hạn');
});

test('F5', 'Mở panel sau khi ẩn → hiện dữ liệu đã gom và tiếp tục cập nhật', () => {
  const fb = new OscFeedback();
  let flushed = 0;
  fb.onMonitorFlush = (rows) => { flushed += rows.length; };
  fb.panelVisible = false;
  for (let i = 0; i < 500; i++) fb.ingest('/a', [i], i);
  eq(flushed, 0, 'chưa render khi ẩn');
  ok(fb.pendingMonitor() > 0, 'dữ liệu vẫn được gom');
  fb.panelVisible = true;
  fb.flushAll(true);
  ok(flushed > 0, 'mở panel → render dữ liệu cũ');
  const before = flushed;
  for (let i = 0; i < 100; i++) fb.ingest('/a', [i], 1000 + i);
  fb.tick(1e9);
  ok(flushed > before, 'tiếp tục cập nhật sau khi mở');
});

test('F6', 'Monitor buffer cắt theo monitorMaxRows', () => {
  const fb = new OscFeedback({ monitorMaxRows: 50 });
  fb.panelVisible = true;
  for (let i = 0; i < 2000; i++) { fb.ingest('/a', [i], i); fb.tick(i * 10); }
  ok(fb.monitorCount() <= 50, `monitor ${fb.monitorCount()} ≤ 50`);
});

/* ---------------- 3. Test OSC modal ---------------- */
test('F7', 'Test OSC đóng → không tích lũy; mở → giới hạn testMaxRows', () => {
  const fb = new OscFeedback({ testMaxRows: 100 });
  fb.testVisible = false;
  for (let i = 0; i < 1000; i++) fb.ingest('/a', [i], i);
  eq(fb.pendingTest(), 0, 'không gom khi đóng modal');

  fb.testVisible = true;
  for (let i = 0; i < 5000; i++) { fb.ingest('/a', [i], i); fb.tick(i * 10); }
  ok(fb.testCount() <= 100, `test ${fb.testCount()} ≤ 100`);
});

/* ---------------- 4. Coalesce vs mất sự kiện ---------------- */
test('F8', 'Overflow chỉ bỏ bản sao HIỂN THỊ, đếm dropped (không âm thầm)', () => {
  const fb = new OscFeedback({ pendingMax: 10 });
  for (let i = 0; i < 100; i++) fb.ingest('/a', [i], i);
  eq(fb.pendingMonitor(), 10, 'pending bị chặn đúng');
  eq(fb.droppedMon, 90, 'đếm đủ số bị bỏ');
});

test('F9', 'Monitor pause → không gom; resume lại hoạt động', () => {
  const fb = new OscFeedback();
  fb.panelVisible = true;
  fb.monitorPaused = true;
  for (let i = 0; i < 100; i++) fb.ingest('/a', [i], i);
  eq(fb.pendingMonitor(), 0, 'pause không gom');
  fb.monitorPaused = false;
  fb.ingest('/a', [1], 200);
  ok(fb.pendingMonitor() > 0, 'resume gom lại');
});

test('F10', 'clear() xoá sạch mọi buffer', () => {
  const fb = new OscFeedback();
  fb.panelVisible = true;
  for (let i = 0; i < 100; i++) { fb.ingest('/a', [i], i); fb.tick(i * 10); }
  fb.clear();
  eq(fb.monitorCount(), 0);
  eq(fb.testCount(), 0);
  eq(fb.seenAddrCount(), 0);
  eq(fb.pendingMonitor(), 0);
});

/* ---------------- 5. Bộ lọc REC 'all' ---------------- */
test('F11', 'preset all: bỏ /position cuối đường dẫn VÀ /position/...', () => {
  ok(isRecNoise('/composition/layers/1/video/position'), '/position cuối');
  ok(isRecNoise('/composition/layers/1/video/position/'), '/position/ cuối');
  ok(isRecNoise('/composition/layers/1/video/position/x'), '/position/x');
  ok(isRecNoise('/composition/layers/1/video/values'), '/values');
  ok(isRecNoise('/composition/layers/1/video/speed'), '/speed');
  ok(isRecNoise('/composition/tempocontroller/tempo'), 'tempo');
});

test('F12', 'preset all: GIỮ opacity/volume/connect (cần ghi automation)', () => {
  ok(!isRecNoise('/composition/layers/2/video/opacity'), 'opacity phải giữ');
  ok(!isRecNoise('/composition/layers/2/audio/volume'), 'volume phải giữ');
  ok(!isRecNoise('/composition/layers/3/clips/1/connect'), 'connect phải giữ');
  ok(!isRecNoise('/composition/columns/2/connect'), 'connect cột phải giữ');
});

test('F13', 'connect 1→0 không bị dedupe (hai lệnh hợp lệ)', () => {
  const fb = new OscFeedback();
  fb.ingest('/composition/layers/3/clips/1/connect', [1], 1);
  fb.ingest('/composition/layers/3/clips/1/connect', [0], 2);
  const list = fb.snapshotSeen();
  eq(list.length, 1, 'cùng địa chỉ');
  eq(list[0].argsCount, 2, 'hai dạng args khác nhau (1 và 0) được giữ');
  eq(list[0].count, 2, 'đếm đủ 2 lần');
});

/* ---------------- 6. argsKey ---------------- */
test('F14', 'argsKey ổn định, làm tròn 3 chữ số', () => {
  eq(argsKey([0.4488]), '0.449');
  eq(argsKey([0.44881]), '0.449');
  ok(argsKey([1]) !== argsKey([0]), 'khác giá trị → khác key');
  eq(argsKey([]), '—');
});

/* ---------------- 7. Hiệu năng ---------------- */
test('F15', '100k ingest < 500ms, không tăng tuyến tính theo lịch sử', () => {
  const fb = new OscFeedback();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 100000; i++) fb.ingest('/composition/layers/1/video/position', [0.25], i);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(ms < 500, `ingest 100k mất ${ms.toFixed(1)}ms`);
  ok(fb.seenHistoryEntries() <= 8, `history ${fb.seenHistoryEntries()} không phình`);
});

/* ---------------- report ---------------- */
const pad = (s, n) => String(s).padEnd(n);
console.log('\n══════════════════════════════════════════════════════════════════════════');
console.log(' HS TIMECODE · OSC FEEDBACK TEST SUITE');
console.log('══════════════════════════════════════════════════════════════════════════');
console.log(pad('ID', 8) + pad('KẾT QUẢ', 10) + 'TÊN');
console.log('──────────────────────────────────────────────────────────────────────────');
for (const r of results) {
  console.log(pad(r.id, 8) + pad(r.ok ? 'PASS' : 'FAIL', 10) + r.name + (r.ok ? '' : '\n          ↳ ' + r.msg));
}
console.log('──────────────────────────────────────────────────────────────────────────');
console.log(`TỔNG: ${pass} pass · ${fail} fail · ${results.length} test`);
console.log('══════════════════════════════════════════════════════════════════════════\n');
process.exit(fail ? 1 : 0);
