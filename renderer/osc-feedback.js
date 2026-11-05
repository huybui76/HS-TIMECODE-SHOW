/* =====================================================================
   HS TIMECODE · OSC FEEDBACK (thuần) — gom + giới hạn dữ liệu & nhịp render
   Mục tiêu:
     • onOscMessage chỉ CẬP NHẬT DỮ LIỆU (O(1) amortized), không dựng DOM.
     • UI (Monitor / OSC Seen / Test OSC) flush theo nhịp ≤ 20 lần/giây.
     • Bộ nhớ hữu hạn: history args có giới hạn, pending queue có giới hạn.
     • Panel/modal ẩn → chỉ giữ buffer giới hạn, KHÔNG tạo DOM.
   Không quyết định thời gian playback, không đụng engine clock.
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HSOSC = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    monitorMaxRows: 300,          // số dòng Monitor giữ tối đa
    monitorFlushMs: 60,           // ~16 lần/giây — gộp cập nhật Monitor
    seenMaxAddr: 60,              // số địa chỉ OSC Seen giữ
    seenMaxArgsPerAddr: 8,        // số dạng args khác nhau mỗi địa chỉ
    seenHistoryPerArg: 1,         // số bản ghi lịch sử mỗi (address,args) — chỉ cần lần cuối
    seenFlushMs: 120,             // ~8 lần/giây cho OSC Seen
    testMaxRows: 500,             // dòng Test OSC giữ
    testFlushMs: 100,             // ~10 lần/giây
    pendingMax: 2000,             // chặn cứng pending queue hiển thị (coalesce, KHÔNG mất sự kiện ghi)
    // Ngưỡng phát hiện dữ liệu "chỉ để hiển thị" khi panel ẩn:
    idleFlushMs: 250
  };

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function argsKey(args) {
    if (!Array.isArray(args) || !args.length) return '—';
    return args.map((a) => (typeof a === 'number'
      ? String(Math.round(a * 1000) / 1000)
      : String(a))).join('|');
  }

  class OscFeedback {
    constructor(cfg) {
      this.cfg = Object.assign({}, DEFAULTS, cfg || {});
      // OSC Seen
      this.seen = new Map();          // address → {count, args: Map(key → {last, count, t})}
      // Monitor
      this.monitor = [];              // [{t, address, argsKey, isTx}] (giới hạn monitorMaxRows)
      // Test OSC
      this.test = [];                 // giữ riêng vì modal có filter riêng
      // Pending (chỉ dùng khi panel ẩn hoặc chưa flush)
      this.pendingMon = [];           // {t, address, args, isTx}
      this.pendingSeenAddrs = new Set();
      this.pendingTestRows = [];
      // Đồng hồ flush
      this.lastMonFlush = -Infinity;
      this.lastSeenFlush = -Infinity;
      this.lastTestFlush = -Infinity;
      // Trạng thái hiển thị (app đặt)
      this.panelVisible = false;      // #oscPanel đang mở?
      this.testVisible = false;       // modal Test OSC đang mở?
      this.monitorPaused = false;
      // Callbacks (app gán)
      this.onMonitorFlush = null;
      this.onSeenFlush = null;
      this.onTestFlush = null;
      this.onMonitorClear = null;
      // Đếm coalesce để test
      this.droppedMon = 0;
      this.droppedTest = 0;
    }

    /* ---------------- ingest: O(1) amortized, KHÔNG DOM ---------------- */
    ingest(address, args, tMs) {
      const t = Number.isFinite(Number(tMs)) ? Number(tMs) : now();

      /* --- OSC Seen: cập nhật thống kê gọn --- */
      let item = this.seen.get(address);
      if (!item) {
        item = { count: 0, args: new Map() };
        this.seen.set(address, item);
        // giới hạn số địa chỉ (LRU đơn giản theo thứ tự chèn)
        while (this.seen.size > this.cfg.seenMaxAddr) {
          this.seen.delete(this.seen.keys().next().value);
        }
      }
      item.count++;
      const key = argsKey(args);
      let argEntry = item.args.get(key);
      if (!argEntry) {
        argEntry = { last: t, count: 0, args: Array.isArray(args) ? args.slice(0, 4) : [] };
        item.args.set(key, argEntry);
        while (item.args.size > this.cfg.seenMaxArgsPerAddr) {
          item.args.delete(item.args.keys().next().value);
        }
      }
      argEntry.last = t;
      argEntry.count++;
      this.pendingSeenAddrs.add(address);

      /* --- Monitor: hàng đợi hiển thị (coalesce) --- */
      if (!this.monitorPaused) {
        if (this.pendingMon.length >= this.cfg.pendingMax) {
          // Quá tải: bỏ dòng CŨ NHẤT của hàng đợi hiển thị (không ảnh hưởng recording)
          this.pendingMon.shift();
          this.droppedMon++;
        }
        this.pendingMon.push({ t, address, args, isTx: false });
      }

      /* --- Test OSC buffer (chỉ khi modal bật) --- */
      if (this.testVisible) {
        if (this.pendingTestRows.length >= this.cfg.pendingMax) {
          this.pendingTestRows.shift();
          this.droppedTest++;
        }
        this.pendingTestRows.push({ t, address, args });
      }
    }

    /* Ghi TX (gửi OSC) vào monitor — cùng đường coalesce */
    ingestTx(address, args, tMs) {
      if (this.monitorPaused) return;
      const t = Number.isFinite(Number(tMs)) ? Number(tMs) : now();
      if (this.pendingMon.length >= this.cfg.pendingMax) { this.pendingMon.shift(); this.droppedMon++; }
      this.pendingMon.push({ t, address, args, isTx: true });
    }

    /* ---------------- flush theo nhịp, có giới hạn công việc ---------------- */
    tick(tMs) {
      const t = Number.isFinite(Number(tMs)) ? Number(tMs) : now();
      let did = false;

      // Monitor chỉ vẽ khi panel mở (nếu ẩn: giữ pending có giới hạn, không đụng DOM)
      if (this.panelVisible && !this.monitorPaused && this.pendingMon.length &&
          t - this.lastMonFlush >= this.cfg.monitorFlushMs) {
        this.lastMonFlush = t;
        const rows = this.pendingMon.splice(0, this.pendingMon.length);
        // giới hạn DOM: chỉ lấy N dòng cuối của cả buffer
        this.monitor.push(...rows);
        if (this.monitor.length > this.cfg.monitorMaxRows) {
          this.monitor.splice(0, this.monitor.length - this.cfg.monitorMaxRows);
        }
        if (this.onMonitorFlush && rows.length) { this.onMonitorFlush(rows, this.monitor); did = true; }
      }

      // OSC Seen: cũng chỉ render khi panel mở
      if (this.panelVisible && this.pendingSeenAddrs.size &&
          t - this.lastSeenFlush >= this.cfg.seenFlushMs) {
        this.lastSeenFlush = t;
        const addrs = [...this.pendingSeenAddrs].slice(0, 40);
        this.pendingSeenAddrs.clear();
        if (this.onSeenFlush) { this.onSeenFlush(addrs, this.seen); did = true; }
      }

      // Test OSC: chỉ khi modal mở
      if (this.testVisible && this.pendingTestRows.length &&
          t - this.lastTestFlush >= this.cfg.testFlushMs) {
        this.lastTestFlush = t;
        const rows = this.pendingTestRows.splice(0, this.pendingTestRows.length);
        this.test.push(...rows);
        if (this.test.length > this.cfg.testMaxRows) {
          this.test.splice(0, this.test.length - this.cfg.testMaxRows);
        }
        if (this.onTestFlush && rows.length) { this.onTestFlush(rows, this.test); did = true; }
      }

      return did;
    }

    /* Khi panel/modal vừa mở: render ngay từ buffer giới hạn (1 lần, có callback) */
    flushAll() {
      this.lastMonFlush = -Infinity;
      this.lastSeenFlush = -Infinity;
      this.lastTestFlush = -Infinity;
      let did = false;

      if (this.panelVisible && this.pendingMon.length && !this.monitorPaused) {
        const rows = this.pendingMon.splice(0, this.pendingMon.length);
        this.monitor.push(...rows);
        if (this.monitor.length > this.cfg.monitorMaxRows) {
          this.monitor.splice(0, this.monitor.length - this.cfg.monitorMaxRows);
        }
        if (this.onMonitorFlush) { this.onMonitorFlush(rows, this.monitor); did = true; }
      }
      if (this.panelVisible && this.pendingSeenAddrs.size) {
        this.pendingSeenAddrs.clear();
        if (this.onSeenFlush) { this.onSeenFlush([], this.seen); did = true; }
      }
      if (this.testVisible && this.pendingTestRows.length) {
        const rows = this.pendingTestRows.splice(0, this.pendingTestRows.length);
        this.test.push(...rows);
        if (this.test.length > this.cfg.testMaxRows) {
          this.test.splice(0, this.test.length - this.cfg.testMaxRows);
        }
        if (this.onTestFlush) { this.onTestFlush(rows, this.test); did = true; }
      }
      return did;
    }

    /* Hiển thị lại toàn bộ buffer hiện có (khi mở panel sau khi bị ẩn) */
    snapshotMonitor() { return this.monitor.slice(); }
    snapshotSeen() {
      const out = [];
      for (const [address, item] of this.seen) {
        const firstKey = item.args.keys().next().value;
        const entry = firstKey ? item.args.get(firstKey) : null;
        out.push({
          address,
          count: item.count,
          argsCount: item.args.size,
          args: entry ? entry.args : [],
          argKey: firstKey || '—'
        });
      }
      return out;
    }
    snapshotTest() { return this.test.slice(); }

    /* ---------------- trạng thái/hằng số cho test ---------------- */
    pendingMonitor() { return this.pendingMon.length; }
    pendingSeen() { return this.pendingSeenAddrs.size; }
    pendingTest() { return this.pendingTestRows.length; }
    monitorCount() { return this.monitor.length; }
    testCount() { return this.test.length; }
    seenAddrCount() { return this.seen.size; }
    seenHistoryEntries() {
      let n = 0;
      for (const [, item] of this.seen) n += item.args.size * this.cfg.seenHistoryPerArg;
      return n;
    }
    clear() {
      this.monitor.length = 0;
      this.test.length = 0;
      this.seen.clear();
      this.pendingMon.length = 0;
      this.pendingSeenAddrs.clear();
      this.pendingTestRows.length = 0;
      this.droppedMon = 0;
      this.droppedTest = 0;
      if (this.onMonitorClear) this.onMonitorClear();
    }
    clearMonitorOnly() {
      this.monitor.length = 0;
      this.pendingMon.length = 0;
    }
  }

  /* -------- Bộ lọc "all" của REC nguồn OSC: nhận diện /position cuối đường dẫn -------- */
  /* Địa chỉ telemetry KHÔNG dùng để tạo cue. KHÔNG áp toàn cục — chỉ nơi ghi OSC. */
  const OSC_REC_NOISE = [
    /\/position\/?$/i,          // /position  và  /position/
    /\/position\//i,            // /position/x
    /\/values$/i,
    /\/speed$/i,
    /\/bypass$/i,
    /\/connected$/i,
    /\/masterfader$/i,
    /^\/composition\/tempocontroller\b/i
  ];
  function isRecNoise(address) {
    return OSC_REC_NOISE.some((re) => re.test(String(address || '')));
  }

  return { DEFAULTS, OscFeedback, argsKey, isRecNoise, OSC_REC_NOISE };
});
