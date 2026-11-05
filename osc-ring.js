/* =====================================================================
   HS TIMECODE · OSC RING BUFFER — typed arrays cấp phát cố định
   Không tạo object mỗi message. Bảng intern địa chỉ (Map address → id).
   Dùng cho correlation MIDI↔OSC trong utility process.
   ===================================================================== */
'use strict';

const { OSC_RING_CAPACITY, OSC_PER_ADDRESS_MAX_HZ, OSC_MAX_ADDRESSES } = require('./realtime-config');

function pendingOrder(a, b) { return a.pendingTs - b.pendingTs || a.id - b.id; }

class OscRing {
  constructor(opts) {
    const o = opts || {};
    this.cap = o.capacity === undefined ? OSC_RING_CAPACITY : o.capacity;
    if (!Number.isSafeInteger(this.cap) || this.cap <= 0) throw new RangeError('capacity must be a positive integer');
    this.minIntervalMs = o.minIntervalMs === undefined ? 1000 / OSC_PER_ADDRESS_MAX_HZ : o.minIntervalMs;
    if (!Number.isFinite(this.minIntervalMs) || this.minIntervalMs < 0) throw new RangeError('minIntervalMs must be nonnegative and finite');
    this.ts = new Float64Array(this.cap);          // ms monotonic
    this.val = new Float32Array(this.cap);         // giá trị float đầu tiên
    this.addrId = new Uint16Array(this.cap);       // stable intern id, bounded below 65536
    this.kind = new Uint8Array(this.cap);          // 0=continuous,1=discrete,2=other
    this.seq = new Float64Array(this.cap);        // unique ownership token per stored message
    this.used = new Uint8Array(this.cap);          // slot có dữ liệu
    this.head = 0;                                  // vị trí ghi kế tiếp
    this.count = 0;                                 // số slot đang dùng (≤ cap)
    this.ids = new Map();                           // address → id
    this.names = [];                                // id → address
    this.nextId = 1;
    this.nextSeq = 1;
    this.dropped = 0;                              // deduped or deferred input messages
    this.overflow = 0;                             // retained messages overwritten at capacity
    this.addressOverflow = 0;                      // rejected new-address attempts
    // dedupe/rate-limit state
    this.lastVal = new Map();                       // addrId → {val, ts}
    this.pending = new Set();                      // reused per-address state objects
    this.flushQueue = [];
  }

  intern(address) {
    let id = this.ids.get(address);
    if (id === undefined) {
      if (this.ids.size >= OSC_MAX_ADDRESSES) {
        this.addressOverflow++;
        return 0;
      }
      id = this.nextId++;
      this.ids.set(address, id);
      this.names[id] = address;
    }
    return id;
  }
  addressOf(id) { return this.names[id] || ''; }

  /* Ghi 1 message; trả true nếu được ghi (đã qua dedupe/rate-limit) */
  push(address, value, tMs, kind) {
    const id = this.intern(address);
    if (!id) return false;
    const k = kind === undefined ? 0 : kind;
    let prev = this.lastVal.get(id);
    if (prev && k !== 1) {
      // bỏ nếu cùng giá trị
      if (Math.abs(prev.val - value) < 1e-6) {
        // A reversal cancels an obsolete endpoint, e.g. .2 -> .7 -> .2.
        this.pending.delete(prev);
        this.dropped++;
        return false;
      }
      // rate limit theo địa chỉ
      if (this.minIntervalMs > 0 && tMs - prev.ts < this.minIntervalMs) {
        // ghi đè giá trị "đang chờ" để giữ điểm cuối chính xác
        prev.pendingVal = value;
        prev.pendingTs = tMs;
        prev.pendingKind = k;
        this.pending.add(prev);
        this.dropped++;
        return false;
      }
    }
    if (prev) this.pending.delete(prev);
    this._write(id, value, tMs, k);
    if (!prev) {
      prev = { id, val: value, ts: tMs, pendingVal: 0, pendingTs: 0, pendingKind: 0 };
      this.lastVal.set(id, prev);
    } else {
      prev.val = value;
      prev.ts = tMs;
    }
    return true;
  }

  flushPending(now, force = false) {
    const queue = this.flushQueue;
    for (const state of this.pending) {
      if (force || now - state.ts >= this.minIntervalMs) queue.push(state);
    }
    queue.sort(pendingOrder);
    for (const state of queue) {
      this._write(state.id, state.pendingVal, state.pendingTs, state.pendingKind);
      state.val = state.pendingVal;
      state.ts = state.pendingTs;
      this.pending.delete(state);
    }
    const count = queue.length;
    queue.length = 0;
    return count;
  }

  _write(id, value, tMs, k) {
    const i = this.head;
    this.ts[i] = tMs;
    this.val[i] = value;
    this.addrId[i] = id;
    this.kind[i] = k;
    this.seq[i] = this.nextSeq++;
    this.used[i] = 1;
    this.head = (this.head + 1) % this.cap;
    if (this.count < this.cap) this.count++;
    else this.overflow++;
  }

  /* Lấy các bản ghi trong [t0, t1] — callback(id, value, ts, kind, seq), FIFO. */
  forEachInWindow(t0, t1, cb) {
    const start = (this.head - this.count + this.cap) % this.cap;
    for (let n = 0; n < this.count; n++) {
      const i = (start + n) % this.cap;
      if (!this.used[i]) continue;
      const t = this.ts[i];
      if (t < t0) continue;
      // Pending endpoints can be written after newer timestamps from other addresses.
      if (t > t1) continue;
      cb(this.addrId[i], this.val[i], t, this.kind[i], this.seq[i]);
    }
  }

  /* Lấy giá trị mới nhất của mỗi địa chỉ trong cửa sổ → Map(id → {value,ts}) */
  latestById(t0, t1) {
    const map = new Map();
    this.forEachInWindow(t0, t1, (id, v, ts) => {
      const cur = map.get(id);
      if (!cur || ts >= cur.ts) map.set(id, { value: v, ts });
    });
    return map;
  }

  clear() {
    this.head = 0; this.count = 0; this.used.fill(0);
    this.lastVal.clear();
    this.pending.clear();
    this.flushQueue.length = 0;
    this.dropped = 0;
    this.overflow = 0;
    this.addressOverflow = 0;
  }

  /* Stable in-place compaction also handles delayed endpoints older than the FIFO tail. */
  trim(cutoffMs) {
    const start = (this.head - this.count + this.cap) % this.cap;
    let keep = 0;
    for (let n = 0; n < this.count; n++) {
      const i = (start + n) % this.cap;
      if (this.ts[i] < cutoffMs) continue;
      const dest = (start + keep++) % this.cap;
      if (dest !== i) {
        this.ts[dest] = this.ts[i];
        this.val[dest] = this.val[i];
        this.addrId[dest] = this.addrId[i];
        this.kind[dest] = this.kind[i];
        this.seq[dest] = this.seq[i];
      }
      this.used[dest] = 1;
    }
    for (let n = keep; n < this.count; n++) this.used[(start + n) % this.cap] = 0;
    this.count = keep;
    this.head = (start + keep) % this.cap;
    for (const [id, state] of this.lastVal) {
      if (this.pending.has(state) && state.pendingTs < cutoffMs) this.pending.delete(state);
      if (state.ts < cutoffMs && !this.pending.has(state)) this.lastVal.delete(id);
    }
  }
}

module.exports = { OscRing };
