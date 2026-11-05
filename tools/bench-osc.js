#!/usr/bin/env node
/* =====================================================================
   HS TIMECODE · Benchmark OSC feedback (baseline + after-fix)
   Tái hiện ĐÚNG logic production cũ (baseline) và logic mới, không DOM thật.
   Chạy: node tools/bench-osc.js [--messages 100000] [--json]
   ===================================================================== */
'use strict';

const ARGS = process.argv.slice(2);
const getNum = (flag, def) => {
  const i = ARGS.indexOf(flag);
  return i >= 0 && ARGS[i + 1] ? Number(ARGS[i + 1]) : def;
};
const JSON_OUT = ARGS.includes('--json');
const N = getNum('--messages', 100000);

/* ============================ BASELINE (code cũ) ============================ */
/* Mô phỏng nguyên văn cấu trúc cũ:
   - OSC_SEEN: Map address → {args: Map key → Array push({t,count}) KHÔNG giới hạn}
   - renderOscSeen(): dựng lại DOM mỗi message
   - monRow(): tạo DOM + scroll mỗi message
   - Test OSC: dựng 300 dòng mỗi message khi mở
*/
function makeBaseline() {
  const OSC_SEEN = new Map();
  const MAX_SEEN = 60;
  const MAX_MON_ROWS = 300;
  const stats = { rendersSeen: 0, rendersMon: 0, rendersTest: 0, domNodes: 0, historyEntries: 0 };

  const oscSeenKey = (args) => (args || [])
    .map((a) => (typeof a === 'number' ? Math.round(a * 1000) / 1000 : String(a))).join('|');

  function recordOscSeen(address, args) {
    const key = oscSeenKey(args);
    let item = OSC_SEEN.get(address);
    if (!item) { item = { args: new Map(), count: 0 }; OSC_SEEN.set(address, item); }
    if (!item.args.has(key)) item.args.set(key, []);
    item.args.get(key).push({ t: Date.now(), count: 1 });   // ← KHÔNG BAO GIỜ CẮT: tăng vô hạn
    item.count++;
    while (item.args.size > 20) item.args.delete(item.args.keys().next().value);
    while (OSC_SEEN.size > MAX_SEEN) OSC_SEEN.delete(OSC_SEEN.keys().next().value);
    renderOscSeen();
  }

  function renderOscSeen() {
    stats.rendersSeen++;
    let nodes = 0;
    const arr = [...OSC_SEEN.entries()].slice(0, 40);
    for (const [addr, item] of arr) nodes += 4;      // div + 3 span
    stats.domNodes += nodes;
  }

  function monRow(address, args) {
    stats.rendersMon++;
    stats.domNodes += 2;                              // div + txt span
  }

  function toRecord(msg) {
    stats.rendersTest++;                              // renderTestOscRows mỗi gói khi mở
    stats.domNodes += 300 * 5;
  }

  function handle(address, args) {
    recordOscSeen(address, args);
    monRow(address, args);
    toRecord({ address, args });
  }

  function snapshot() {
    let hist = 0;
    for (const [, item] of OSC_SEEN) {
      for (const [, arr] of item.args) hist += arr.length;
    }
    return { ...stats, historyEntries: hist, seenAddrs: OSC_SEEN.size };
  }

  return { handle, snapshot, OSC_SEEN };
}

/* ============================ AFTER (code mới) ============================ */
const path = require('path');
const R = require(path.join(__dirname, '..', 'renderer', 'osc-feedback.js'));

function makeAfter() {
  const fb = new R.OscFeedback({
    seenMaxAddr: 60,
    seenMaxArgsPerAddr: 8,
    seenHistoryPerArg: 1,          // chỉ giữ lần cuối — đủ cho UI
    monitorMaxRows: 300,
    monitorFlushMs: 60,
    seenFlushMs: 120,
    testMaxRows: 500
  });
  const stats = { rendersSeen: 0, rendersMon: 0, rendersTest: 0, domNodes: 0 };

  // "DOM" giả lập: đếm node được tạo mỗi lần flush (không phải mỗi message)
  fb.onMonitorFlush = (rows) => { stats.rendersMon++; stats.domNodes += rows.length * 2; };
  fb.onSeenFlush = (list) => { stats.rendersSeen++; stats.domNodes += list.length * 4; };
  fb.onTestFlush = (rows) => { stats.rendersTest++; stats.domNodes += rows.length * 5; };

  function handle(address, args) {
    fb.ingest(address, args, Date.now());
  }

  function snapshot() {
    return {
      ...stats,
      historyEntries: fb.seenHistoryEntries(),
      seenAddrs: fb.seenAddrCount(),
      pendingMonitor: fb.pendingMonitor(),
      pendingSeen: fb.pendingSeen(),
      pendingTest: fb.pendingTest()
    };
  }

  return { handle, snapshot, fb };
}

/* ================================ RUN ================================ */
function run(name, engine) {
  const t0 = process.hrtime.bigint();
  const mem0 = process.memoryUsage().heapUsed;
  // 100k message: 80% telemetry lặp cùng address/args, 10% trigger, 10% float
  for (let i = 0; i < N; i++) {
    const r = i % 10;
    if (r < 8) engine.handle('/composition/layers/1/video/position', [0.25, 0.5]);
    else if (r < 9) engine.handle('/composition/layers/3/clips/1/connect', [1]);
    else engine.handle('/composition/layers/2/video/opacity', [(i % 100) / 100]);
  }
  // ép flush phần còn treo (như 1 nhịp UI cuối)
  if (engine.fb) { engine.fb.flushAll(); }
  const t1 = process.hrtime.bigint();
  const mem1 = process.memoryUsage().heapUsed;
  return {
    ms: Number(t1 - t0) / 1e6,
    heapDeltaMB: (mem1 - mem0) / 1048576,
    ...engine.snapshot()
  };
}

const base = run('baseline', makeBaseline());
const after = run('after', makeAfter());

if (JSON_OUT) {
  console.log(JSON.stringify({ messages: N, baseline: base, after }, null, 2));
} else {
  const row = (k, a, b) => `${k.padEnd(26)} ${String(a).padStart(14)} ${String(b).padStart(14)}`;
  console.log('\n══════════════════════════════════════════════════════════════════════════');
  console.log(` OSC FEEDBACK BENCHMARK · ${N.toLocaleString()} messages`);
  console.log('══════════════════════════════════════════════════════════════════════════');
  console.log(row('', 'BEFORE', 'AFTER'));
  console.log('──────────────────────────────────────────────────────────────────────────');
  console.log(row('Thời gian xử lý (ms)', base.ms.toFixed(0), after.ms.toFixed(0)));
  console.log(row('Render Seen (lần)', base.rendersSeen, after.rendersSeen));
  console.log(row('Render Monitor (lần)', base.rendersMon, after.rendersMon));
  console.log(row('Render Test (lần)', base.rendersTest, after.rendersTest));
  console.log(row('DOM ops (node ước tính)', base.domNodes.toLocaleString(), after.domNodes.toLocaleString()));
  console.log(row('Lịch sử args giữ lại', base.historyEntries.toLocaleString(), after.historyEntries.toLocaleString()));
  console.log(row('Heap tăng (MB)', base.heapDeltaMB.toFixed(1), after.heapDeltaMB.toFixed(1)));
  console.log('──────────────────────────────────────────────────────────────────────────');
  console.log(` Pending queue sau flush: monitor=${after.pendingMonitor} seen=${after.pendingSeen} test=${after.pendingTest}`);
  console.log('══════════════════════════════════════════════════════════════════════════\n');
}
