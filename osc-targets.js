/* =====================================================================
   HS TIMECODE · OSC TARGETS — nhiều địa chỉ OSC + xác thực 2 chiều
   Chạy trong MAIN process. Không phụ thuộc renderer.
   • send() gửi song song tất cả target đang bật
   • find()/verify() xác thực Resolume (RX nghe + TX gửi thử + echo)
   ===================================================================== */
'use strict';

const dgram = require('dgram');
const osc = require('osc');

const DEFAULTS = {
  port: 7001,
  verifyTimeoutMs: 2500,
  findTimeoutMs: 900,
  probeAddress: '/composition/master',
  testAddress: '/composition/layers/1/clips/1/connect'
};

class OscTargets {
  constructor(opts) {
    const o = opts || {};
    this.cfg = Object.assign({}, DEFAULTS, o);
    this.targets = [];        // [{id, name, host, port, enabled, verified, lastError, sent}]
    this.sock = null;         // socket gửi dùng chung
    this.pendingEcho = new Map();  // targetKey -> resolver
    this.onChange = o.onChange || null;
  }

  sockInstance() {
    if (!this.sock) {
      this.sock = dgram.createSocket('udp4');
      try { this.sock.unref(); } catch (_) {}
      this.sock.on('error', () => {});
    }
    return this.sock;
  }

  list() {
    return this.targets.map((t) => ({
      id: t.id, name: t.name, host: t.host, port: t.port,
      enabled: t.enabled, verified: !!t.verified, lastError: t.lastError || null, sent: t.sent || 0
    }));
  }

  setTargets(arr) {
    const prev = new Map(this.targets.map((t) => [t.host + ':' + t.port, t]));
    this.targets = (Array.isArray(arr) ? arr : []).map((t) => {
      const key = t.host + ':' + t.port;
      const old = prev.get(key);
      return {
        id: t.id, name: t.name || t.host,
        host: String(t.host || '127.0.0.1'),
        port: Number(t.port) || this.cfg.port,
        enabled: t.enabled !== false,
        verified: old ? !!old.verified : false,
        lastError: null,
        sent: old ? old.sent : 0,
        _pending: null
      };
    });
    this.emit();
    return this.list();
  }

  emit() {
    if (this.onChange) {
      try { this.onChange(this.list()); } catch (_) {}
    }
  }

  /* Gửi 1 gói OSC tới TẤT CẢ target đang bật (song song, không chặn) */
  send(address, args) {
    const buf = Buffer.from(osc.writePacket({ address, args: args || [] }));
    let sentCount = 0;
    for (const t of this.targets) {
      if (!t.enabled) continue;
      this.sockInstance().send(buf, t.port, t.host, (err) => {
        if (err) {
          t.lastError = String(err.message || err);
          t.verified = false;
        }
      });
      t.sent = (t.sent || 0) + 1;
      sentCount++;
    }
    this.emit();
    return sentCount;
  }

  /* Tìm Resolume: thử host/port đã nhập, nghe echo */
  async find(targetId, rxSnapshot) {
    const t = this.targets.find((x) => x.id === targetId);
    if (!t) return { ok: false, error: 'Không tìm thấy target' };

    // Gửi probe không ảnh hưởng state (chỉ đọc composition master)
    const before = rxSnapshot ? rxSnapshot() : 0;
    this._probe(t.host, t.port);
    await sleep(this.cfg.findTimeoutMs);
    const after = rxSnapshot ? rxSnapshot() : 0;
    const heard = after > before;

    if (heard) {
      t.verified = true;
      t.lastError = null;
      this.emit();
      return { ok: true, host: t.host, port: t.port, rx: after - before };
    }
    t.verified = false;
    t.lastError = 'Không thấy phản hồi';
    this.emit();
    return { ok: false, error: 'Không thấy Resolume phản hồi', host: t.host, port: t.port };
  }

  _probe(host, port) {
    const buf = Buffer.from(osc.writePacket({ address: this.cfg.probeAddress, args: [] }));
    this.sockInstance().send(buf, port, host, () => {});
  }

  /* Xác thực 3 bước: RX nghe → TX gửi connect 1 → 0 → chờ echo */
  async verify(targetId, rxSnapshot) {
    const t = this.targets.find((x) => x.id === targetId);
    if (!t) return { ok: false, error: 'Không tìm thấy target' };

    // Bước 1: RX — nghe 1.2s xem có traffic
    const rx0 = rxSnapshot ? rxSnapshot() : 0;
    await sleep(1200);
    const rx1 = rxSnapshot ? rxSnapshot() : 0;
    const rxOk = rx1 > rx0;

    // Bước 2: TX — gửi connect 1, chờ echo 600ms, gửi 0 để tắt
    const rx2 = rx1;
    this.sendTo(t, this.cfg.testAddress, [1]);
    await sleep(600);
    const rx3 = rxSnapshot ? rxSnapshot() : 0;
    this.sendTo(t, this.cfg.testAddress, [0]);   // khôi phục trạng thái clip
    const txOk = rx3 > rx2;

    const ok = rxOk && txOk;
    t.verified = ok;
    t.lastError = ok ? null : (!rxOk ? 'Không nhận OSC (RX)' : 'Không nhận echo (TX)');
    this.emit();

    return {
      ok,
      rxOk,
      txOk,
      rxMsgs: rx3 - rx0,
      echoMsgs: rx3 - rx2,
      host: t.host,
      port: t.port,
      error: t.lastError || null
    };
  }

  sendTo(t, address, args) {
    const buf = Buffer.from(osc.writePacket({ address, args: args || [] }));
    this.sockInstance().send(buf, t.port, t.host, () => {});
    t.sent = (t.sent || 0) + 1;
  }

  resetCounters() {
    this.targets.forEach((t) => { t.sent = 0; });
    this.emit();
  }

  close() {
    if (this.sock) {
      try { this.sock.close(); } catch (_) {}
      this.sock = null;
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { OscTargets, DEFAULTS };
