/* =====================================================================
   HS TIMECODE · LAN SYNC — đồng bộ show + điều khiển nhiều máy
   Chạy trong MAIN process (Node dgram). Không phụ thuộc renderer.
   • Discovery: broadcast UDP định kỳ để tìm máy cùng NHÓM
   • Sync show: máy chính gửi project JSON; máy backup nhận và áp dụng
   • Điều khiển: play/pause/stop/LTC theo máy chính (tùy chọn)
   ===================================================================== */
'use strict';

const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');

const DEFAULTS = {
  // TRÁNH trùng 40404/40405 của 404TimeCode đang chạy cùng máy
  discoveryPort: 40504,
  dataPort: 40505,
  beaconMs: 1500,
  peerTimeoutMs: 6000,
  group: '404TC',
  role: 'master',              // 'master' | 'backup'
  followMaster: true,          // backup theo máy chính: show + LTC + play
  // Giới hạn an toàn
  maxPacketBytes: 60000,
  maxProjectBytes: 8 * 1024 * 1024
};

function localIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

class LanSync {
  constructor(opts) {
    const o = opts || {};
    this.cfg = Object.assign({}, DEFAULTS, o);
    this.deviceId = o.deviceId || crypto.randomBytes(6).toString('hex');
    this.deviceName = o.deviceName || os.hostname();
    this.peers = new Map();       // deviceId → {name, ip, role, ts, group}
    this.sock = null;
    this.dataSock = null;
    this.timer = null;
    this.onProject = o.onProject || null;       // (json) => void  — backup nhận show
    this.onPeerList = o.onPeerList || null;     // (peers[]) => void
    this.onControl = o.onControl || null;       // (cmd) => void
    this.onSendProject = o.onSendProject || null; // () => json  — master lấy show
  }

  start() {
    if (this.sock) return;
    this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock.on('error', () => {});
    this.sock.on('message', (buf, rinfo) => this._onBeacon(buf, rinfo));
    this.sock.bind(this.cfg.discoveryPort, () => {
      try { this.sock.setBroadcast(true); } catch (_) {}
    });

    this.dataSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.dataSock.on('error', () => {});
    this.dataSock.on('message', (buf, rinfo) => this._onData(buf, rinfo));
    this.dataSock.bind(this.cfg.dataPort, () => {
      try { this.dataSock.setBroadcast(true); } catch (_) {}
    });

    this.timer = setInterval(() => this._beacon(), this.cfg.beaconMs);
    this._beacon();
    this._prune();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.sock) { try { this.sock.close(); } catch (_) {} this.sock = null; }
    if (this.dataSock) { try { this.dataSock.close(); } catch (_) {} this.dataSock = null; }
    this.peers.clear();
    this._emitPeers();
  }

  setConfig(partial) {
    Object.assign(this.cfg, partial || {});
    if (partial && partial.deviceName) this.deviceName = partial.deviceName;
    this._beacon();
    this._emitPeers();
  }

  _beacon() {
    if (!this.sock) return;
    const pkt = Buffer.from(JSON.stringify({
      t: 'hs-beacon',
      id: this.deviceId,
      name: this.deviceName,
      role: this.cfg.role,
      group: this.cfg.group,
      ips: localIPs(),
      ts: Date.now()
    }));
    if (pkt.length > this.cfg.maxPacketBytes) return;
    try { this.sock.send(pkt, this.cfg.discoveryPort, '255.255.255.255'); } catch (_) {}
    // gửi unicast tới peer đã biết (một số switch chặn broadcast)
    for (const p of this.peers.values()) {
      try { this.sock.send(pkt, this.cfg.discoveryPort, p.ip); } catch (_) {}
    }
  }

  _onBeacon(buf, rinfo) {
    if (buf.length > this.cfg.maxPacketBytes) return;
    let m;
    try { m = JSON.parse(buf.toString('utf8')); } catch (_) { return; }
    if (!m || m.t !== 'hs-beacon' || !m.id) return;
    if (m.id === this.deviceId) return;                 // chính mình
    if (m.group !== this.cfg.group) return;             // khác nhóm
    this.peers.set(m.id, {
      id: m.id, name: m.name, role: m.role, group: m.group,
      ip: rinfo.address, ts: Date.now()
    });
    this._emitPeers();
  }

  _emitPeers() {
    const list = [...this.peers.values()].map((p) => ({
      id: p.id, name: p.name, role: p.role, ip: p.ip,
      ageMs: Date.now() - p.ts
    }));
    if (this.onPeerList) { try { this.onPeerList(list); } catch (_) {} }
  }

  _prune() {
    setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, p] of this.peers) {
        if (now - p.ts > this.cfg.peerTimeoutMs) { this.peers.delete(id); changed = true; }
      }
      if (changed) this._emitPeers();
    }, 2000);
  }

  _onData(buf, rinfo) {
    if (!buf || buf.length > this.cfg.maxProjectBytes) return;
    let m;
    try { m = JSON.parse(buf.toString('utf8')); } catch (_) { return; }
    if (!m || !m.t) return;
    if (m.group && m.group !== this.cfg.group) return;

    if (m.t === 'hs-project') {
      // chỉ backup nhận, và chỉ khi theo máy chính
      if (this.cfg.role !== 'backup' || !this.cfg.followMaster) return;
      if (this.onProject) { try { this.onProject(m.data); } catch (_) {} }
      return;
    }
    if (m.t === 'hs-control') {
      if (this.cfg.role !== 'backup' || !this.cfg.followMaster) return;
      if (this.onControl) { try { this.onControl(m.cmd); } catch (_) {} }
      return;
    }
  }

  _sendData(payload) {
    if (!this.dataSock) return 0;
    let n = 0;
    // unicast tới peer đã biết
    for (const p of this.peers.values()) {
      try { this.dataSock.send(payload, this.cfg.dataPort, p.ip); n++; } catch (_) {}
    }
    // broadcast dự phòng (peer mới chưa kịp beacon / switch chặn unicast)
    try { this.dataSock.send(payload, this.cfg.dataPort, '255.255.255.255'); n++; } catch (_) {}
    return n;
  }

  /* Master gọi khi show thay đổi (debounce ở renderer) */
  broadcastProject(json) {
    if (this.cfg.role !== 'master') return 0;
    const payload = Buffer.from(JSON.stringify({
      t: 'hs-project', group: this.cfg.group, from: this.deviceId, data: json
    }));
    if (payload.length > this.cfg.maxProjectBytes) return 0;
    return this._sendData(payload);
  }

  /* Điều khiển play/pause/stop/ltc */
  broadcastControl(cmd) {
    if (this.cfg.role !== 'master') return 0;
    const payload = Buffer.from(JSON.stringify({
      t: 'hs-control', group: this.cfg.group, from: this.deviceId, cmd
    }));
    return this._sendData(payload);
  }

  peersList() {
    return [...this.peers.values()].map((p) => ({
      id: p.id, name: p.name, role: p.role, ip: p.ip, ageMs: Date.now() - p.ts
    }));
  }

  status() {
    return {
      running: !!this.sock,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      role: this.cfg.role,
      group: this.cfg.group,
      followMaster: !!this.cfg.followMaster,
      discoveryPort: this.cfg.discoveryPort,
      dataPort: this.cfg.dataPort,
      ips: localIPs(),
      peers: this.peersList()
    };
  }
}

module.exports = { LanSync, DEFAULTS, localIPs };
