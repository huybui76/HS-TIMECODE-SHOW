/* =====================================================================
   HS TIMECODE · REC ENGINE — ghi MIDI tự động + đối chiếu OSC Resolume
   Module THUẦN (không DOM, không IPC) → chạy được cả trong renderer lẫn Node test.
   - Không quyết định thời gian playback: nhận frame + ms từ ngoài vào.
   - Mọi ngưỡng nằm trong DEFAULTS (cấu hình được).
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../realtime-config'));
  else root.HSREC = factory(root.HSRealtime);
})(typeof self !== 'undefined' ? self : this, function (config) {
  'use strict';

  /* ------------------------- HẰNG SỐ CẤU HÌNH ------------------------- */
  const DEFAULTS = Object.assign({}, config, {
    OSC_BUFFER_MAX: config.OSC_RING_CAPACITY,
    MATCH_PRE_WINDOW_MS: config.MATCH_PRE_MS,
    RDP_EPSILON: config.FLOAT_RDP_EPSILON
  });

  /* Địa chỉ OSC bị coi là NHIỄU khi đối chiếu (không dùng làm địa chỉ chính của cue) */
  const NOISE_PATTERNS = [
    /^\/composition\/tempocontroller\b/i,
    /\/position$/i,
    /\/position\//i,
    /\/speed$/i,
    /\/values$/i,
    /^\/composition\/master\b/i,
    /\/audio\/.*(volume|fft)/i,
    /^\/sys\//i,
    /^\/midi\//i
  ];

  const SPECIFIC_LAYER_CLIP = /^\/composition\/layers\/\d+\/clips\/\d+\/connect$/i;
  const ANY_LAYER_CLIP = /^\/composition\/(layers\/\d+|columns\/\d+)\/(clips\/\d+\/)?connect$/i;
  const SPECIFIC_ANY = /^\/composition\/layers\/\d+\//i;
  const SELECTED_ANY = /^\/composition\/selected/i;

  function isNoise(address) {
    return NOISE_PATTERNS.some((re) => re.test(address || ''));
  }
  function isSelectedAddress(address) { return SELECTED_ANY.test(address || ''); }

  /* Điểm "độ đặc hiệu" của địa chỉ — càng cụ thể càng cao */
  function specificity(address) {
    if (!address) return 0;
    if (SPECIFIC_LAYER_CLIP.test(address)) return 100;
    if (ANY_LAYER_CLIP.test(address)) return 80;
    if (SPECIFIC_ANY.test(address)) return 60;
    if (SELECTED_ANY.test(address)) return 10;
    return 20;
  }

  /* Gom nhóm lane: bỏ chỉ số clip để các clip cùng layer nằm chung lane */
  function baseAddress(address) {
    if (!address) return '';
    return String(address)
      .replace(/\/clips\/\d+/gi, '/clips/*')
      .replace(/\/columns\/\d+/gi, '/columns/*');
  }

  /* Khoá nhóm lane:
     • CÓ địa chỉ OSC → loại + địa chỉ gốc (bỏ chỉ số clip) ⇒ mọi clip của cùng layer
       (vd "Piano Layer 2", "Float layers/2/video/opacity", "Trigger layers/3/clips/x") chung 1 lane.
     • CHƯA có địa chỉ → loại + số note/CC + kênh (mỗi phím 1 lane riêng, không gộp bừa). */
  function groupKeyFor(cue) {
    const kind = cue.kind === 'float' ? 'float' : (cue.kind === 'piano' ? 'piano' : 'trigger');
    const addr = baseAddress(cue.address || '');
    if (addr) return `${kind}|@${addr}`;
    return `${kind}|n${cue.num}|c${cue.ch}`;
  }

  /* --------------------- Ramer–Douglas–Peucker --------------------- */
  /* points: [{dt, value}] — giữ chính xác điểm đầu & cuối */
  function rdp(points, epsilon) {
    const pts = Array.isArray(points) ? points.slice() : [];
    if (pts.length <= 2) return pts;
    const eps = Number(epsilon) > 0 ? Number(epsilon) : DEFAULTS.RDP_EPSILON;
    const keep = new Set([0, pts.length - 1]);

    const simplify = (i0, i1) => {
      if (i1 <= i0 + 1) return;
      const p0 = pts[i0], p1 = pts[i1];
      const dx = p1.dt - p0.dt || 1e-9;
      const dy = p1.value - p0.value;
      let maxD = -1, idx = -1;
      for (let i = i0 + 1; i < i1; i++) {
        const p = pts[i];
        const t = (p.dt - p0.dt) / dx;
        const proj = p0.value + dy * t;
        const d = Math.abs(p.value - proj);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > eps && idx > 0) {
        keep.add(idx);
        simplify(i0, idx);
        simplify(idx, i1);
      }
    };
    simplify(0, pts.length - 1);
    return [...keep].sort((a, b) => a - b).map((i) => pts[i]);
  }

  /* ------------------------------ ENGINE ------------------------------ */
  class RecEngine {
    constructor(cfg) {
      this.cfg = Object.assign({}, DEFAULTS, cfg || {});
      this.reset();
    }

    setConfig(partial) { Object.assign(this.cfg, partial || {}); }

    reset() {
      this.osc = [];              // ring buffer: {address,args,t,used}
      this.notes = new Map();     // "n<note>c<ch>" → open note
      this.floats = new Map();    // "cc<cc>c<ch>" → open float
      this.active = new Set();    // cue đang ghi (để UI tô viền)
      this.seq = 0;
    }

    /* ---------- OSC ring buffer ---------- */
    pushOsc(msg) {
      if (!msg || !msg.address) return null;
      const t = Number(msg.t);
      if (!isFinite(t)) return null;
      const rec = {
        address: String(msg.address),
        args: Array.isArray(msg.args) ? msg.args.slice(0, 8) : [],
        t,
        used: false
      };
      this.osc.push(rec);
      // cắt theo thời gian
      const cutoff = t - this.cfg.OSC_BUFFER_SECONDS * 1000;
      let i = 0;
      while (i < this.osc.length && this.osc[i].t < cutoff) i++;
      if (i > 0) this.osc.splice(0, i);
      // chặn cứng bộ nhớ
      if (this.osc.length > this.cfg.OSC_BUFFER_MAX) {
        this.osc.splice(0, this.osc.length - this.cfg.OSC_BUFFER_MAX);
      }
      return rec;
    }

    oscCount() { return this.osc.length; }

    /* Lấy message trong khoảng [t0, t1], loại nhiễu, chưa dùng */
    candidates(t0, t1, opts) {
      const o = opts || {};
      const out = [];
      for (const m of this.osc) {
        if (m.t < t0 || m.t > t1) continue;
        if (m.used && !o.allowUsed) continue;
        if (isNoise(m.address)) continue;
        if (o.needFloat) {
          const v = floatArg(m);
          if (v === null) continue;
        }
        out.push(m);
      }
      return out;
    }

    /* ---------- MIDI ---------- */
    noteOn(ev) {
      const key = 'n' + ev.note + 'c' + (ev.ch || 1);
      const t = this._midiTime(ev.ms);
      const open = {
        key, note: ev.note, ch: ev.ch || 1, vel: ev.vel == null ? 127 : ev.vel,
        startFrame: ev.frame, startMs: t, lastFrame: ev.frame
      };
      this.notes.set(key, open);
      return open;
    }

    /* Trả về cue đã hoàn tất (hoặc null nếu không có note đang mở) */
    noteOff(ev) {
      const key = 'n' + ev.note + 'c' + (ev.ch || 1);
      const open = this.notes.get(key);
      if (!open) return null;
      this.notes.delete(key);

      const endFrame = Math.max(open.startFrame, ev.frame);
      const endMs = this._midiTime(ev.ms);
      const holdMs = Math.max(0, endMs - open.startMs);
      const durFrames = Math.max(0, Math.round(endFrame - open.startFrame));
      const kind = holdMs >= this.cfg.PIANO_HOLD_THRESHOLD_S * 1000 ? 'piano' : 'trigger';

      const cue = {
        id: ++this.seq,
        kind,
        num: open.note,
        ch: open.ch,
        vel: open.vel,
        value: null,
        startFrame: Math.round(open.startFrame),
        durationFrames: kind === 'piano' ? durFrames : 0,
        startMs: open.startMs,
        endMs,
        holdMs,
        address: '',
        args: [],
        guessed: false,
        unassigned: true,
        extras: [],
        score: 0,
        keyframes: []
      };
      this._resolveTriggerCue(cue, open.startMs, endMs);
      cue.laneGroup = groupKeyFor(cue);
      return cue;
    }

    /* Control Change → mở/cập nhật Float */
    cc(ev) {
      const key = 'cc' + ev.cc + 'c' + (ev.ch || 1);
      const t = this._midiTime(ev.ms);
      const f = this.floats.get(key);
      const v = Math.max(0, Math.min(1, (Number(ev.val) || 0) / 127));

      if (!f) {
        const cue = {
          id: ++this.seq,
          kind: 'float',
          num: ev.cc,
          ch: ev.ch || 1,
          vel: null,
          value: v,
          startFrame: Math.round(ev.frame),
          durationFrames: 0,
          startMs: t,
          endMs: t,
          holdMs: 0,
          address: '',
          args: [v],
          guessed: false,
          unassigned: true,
          extras: [],
          score: 0,
          keyframes: [{ dt: 0, value: v, ms: 0 }]
        };
        const open = { key, cue, lastMs: t, lastFrame: ev.frame, lastValue: v, ccSamples: [{ dt: 0, value: v }] };
        this.floats.set(key, open);
        this.active.add(cue.id);
        return { type: 'open', cue };
      }

      f.lastMs = t;
      f.lastFrame = ev.frame;
      f.lastValue = v;
      f.cue.endMs = t;
      f.cue.durationFrames = Math.max(0, Math.round(ev.frame - f.cue.startFrame));
      f.cue.keyframes.push({
        dt: Math.round(t - f.cue.startMs),
        value: v,
        ms: Math.round(t - f.cue.startMs)
      });
      f.ccSamples.push({ dt: Math.round(t - f.cue.startMs), value: v });
      return { type: 'update', cue: f.cue };
    }

    /* Gọi định kỳ (engineStep): đóng các Float đã ngừng vặn */
    tick(ms) {
      const now = this._midiTime(ms);
      const done = [];
      for (const [key, f] of [...this.floats.entries()]) {
        if (now - f.lastMs >= this.cfg.FLOAT_IDLE_TIMEOUT_MS) {
          // thời điểm kết thúc = lần CC cuối (không cộng timeout vào độ dài cue)
          done.push(this._finalizeFloat(key, f));
        }
      }
      return done;
    }

    /* Kết thúc mọi thứ đang mở (dừng timeline / tắt REC)
       frame = vị trí playhead hiện tại → độ dài note đang giữ được tính tới đây */
    finalizeAll(ms, frame) {
      const now = this._midiTime(ms);
      const endFrame = Number.isFinite(Number(frame)) ? Number(frame) : null;
      const out = [];
      // note đang giữ → coi như nhả tại đây
      for (const open of [...this.notes.values()]) {
        out.push(this.noteOff({
          note: open.note, ch: open.ch,
          frame: endFrame == null ? open.lastFrame : endFrame,
          ms: now
        }));
      }
      for (const [key, f] of [...this.floats.entries()]) {
        out.push(this._finalizeFloat(key, f));
      }
      return out.filter(Boolean);
    }

    activeCueIds() { return [...this.active]; }
    activeCount() { return this.notes.size + this.floats.size; }

    /* ---------- nội bộ ---------- */
    _midiTime(ms) {
      const t = Number(ms);
      return (isFinite(t) ? t : 0) + this.cfg.RECORD_LATENCY_COMPENSATION_MS;
    }

    _finalizeFloat(key, f) {
      this.floats.delete(key);
      const cue = f.cue;
      this.active.delete(cue.id);
      cue.durationFrames = Math.max(0, Math.round(f.lastFrame - cue.startFrame));
      cue.endMs = f.lastMs;
      cue.holdMs = Math.max(0, f.lastMs - cue.startMs);

      // 1) chọn địa chỉ OSC tương quan nhất trong suốt cử chỉ
      const cands = this.candidates(
        cue.startMs - this.cfg.MATCH_PRE_WINDOW_MS,
        cue.endMs + this.cfg.MATCH_WINDOW_MS,
        { needFloat: true }
      );
      const byAddr = new Map();
      for (const m of cands) {
        const v = floatArg(m);
        if (v === null) continue;
        if (!byAddr.has(m.address)) byAddr.set(m.address, []);
        byAddr.get(m.address).push({ t: m.t, value: v, rec: m });
      }
      let best = null;
      for (const [address, list] of byAddr) {
        const corr = Math.abs(pearson(f.ccSamples, list));
        const score = list.length * 2 + corr * 120 + specificity(address);
        if (!best || score > best.score) best = { address, list, score, corr };
      }

      if (best) {
        cue.address = best.address;
        cue.unassigned = false;
        cue.score = Math.round(best.score);
        // 2) giá trị keyframe ưu tiên từ OSC (fallback CC)
        const used = [];
        cue.keyframes = cue.keyframes.map((kf) => {
          const absMs = cue.startMs + kf.dt;
          const near = nearestFloat(best.list, absMs, this.cfg.MATCH_WINDOW_MS);
          if (near) { used.push(near.rec); return { dt: kf.dt, value: near.value }; }
          return { dt: kf.dt, value: kf.value };
        });
        used.forEach((r) => { r.used = true; });
        cue.args = [cue.keyframes[cue.keyframes.length - 1].value];
        // các địa chỉ khác cùng xuất hiện → ngõ vào phụ
        for (const [address, list] of byAddr) {
          if (address === best.address) continue;
          cue.extras.push({ address, args: [list[list.length - 1].value], count: list.length });
        }
      } else if (cue.keyframes.length) {
        cue.args = [cue.keyframes[cue.keyframes.length - 1].value];
      }

      // 3) tối giản RDP, luôn giữ đầu + cuối chính xác
      const raw = cue.keyframes.map((k) => ({ dt: k.dt, value: k.value }));
      cue.keyframesRaw = raw.length;
      cue.keyframes = rdp(raw, this.cfg.RDP_EPSILON)
        .map((k) => ({ dt: k.dt, value: k.value }));
      cue.keyframesSent = cue.keyframes.length;
      cue.laneGroup = groupKeyFor(cue);
      return cue;
    }

    /* Đối chiếu OSC cho Trigger/Piano */
    _resolveTriggerCue(cue, startMs, endMs) {
      const t0 = startMs - this.cfg.MATCH_PRE_WINDOW_MS;
      const t1 = endMs + this.cfg.MATCH_WINDOW_MS;
      const cands = this.candidates(t0, t1);
      if (!cands.length) return;

      // chấm điểm: độ đặc hiệu + độ gần thời điểm bấm + ưu tiên connect
      const scored = cands.map((m) => {
        const dt = Math.abs(m.t - startMs);
        const near = 60 * (1 - Math.min(1, dt / (this.cfg.MATCH_WINDOW_MS + this.cfg.MATCH_PRE_WINDOW_MS)));
        let s = near + specificity(m.address);
        if (/\/connect$/i.test(m.address)) s += 30;
        return { m, s, dt };
      }).sort((a, b) => b.s - a.s || a.dt - b.dt);

      const pick = scored[0];
      cue.address = pick.m.address;
      cue.args = pick.m.args.length ? pick.m.args.slice() : [1];
      cue.value = typeof cue.args[0] === 'number' ? cue.args[0] : 1;
      cue.unassigned = false;
      cue.score = Math.round(pick.s);
      cue.matchLatencyMs = Math.round(pick.m.t - startMs);
      pick.m.used = true;

      // các message khác trong cùng cửa sổ (selectedlayer…) → ngõ vào phụ
      for (const c of scored.slice(1)) {
        if (isSelectedAddress(c.m.address) || /\/connect$/i.test(c.m.address)) {
          cue.extras.push({ address: c.m.address, args: c.m.args.slice(0, 4), dtMs: Math.round(c.dt) });
        }
      }
    }
  }

  /* ----------------------------- helpers ----------------------------- */
  function floatArg(msg) {
    if (!msg || !Array.isArray(msg.args)) return null;
    for (const a of msg.args) {
      const n = typeof a === 'number' ? a : NaN;
      if (isFinite(n) && n >= 0 && n <= 1) return n;
    }
    return null;
  }

  function nearestFloat(list, t, tol) {
    let best = null, bestD = Infinity;
    for (const item of list) {
      const d = Math.abs(item.t - t);
      if (d <= tol && d < bestD) { bestD = d; best = item; }
    }
    return best;
  }

  /* Tương quan Pearson giữa chuỗi CC và chuỗi OSC (theo trục thời gian tương đối) */
  function pearson(samplesA, listB) {
    if (!samplesA || !listB || samplesA.length < 2 || listB.length < 2) return 0;
    const t0 = Math.min(samplesA[0].dt || 0, 0);
    const duration = Math.max(
      samplesA[samplesA.length - 1].dt || 0,
      1
    );
    const startAbs = listB[0].t;
    // lấy mẫu lại B theo trục dt của A
    const pairs = [];
    for (const s of samplesA) {
      const abs = startAbs + (s.dt - t0);
      const near = nearestFloatLocal(listB, abs);
      if (near) pairs.push([s.value, near.value]);
    }
    if (pairs.length < 2) return 0;
    const n = pairs.length;
    const ma = pairs.reduce((a, p) => a + p[0], 0) / n;
    const mb = pairs.reduce((a, p) => a + p[1], 0) / n;
    let num = 0, da = 0, db = 0;
    for (const [a, b] of pairs) {
      num += (a - ma) * (b - mb);
      da += (a - ma) ** 2;
      db += (b - mb) ** 2;
    }
    if (da <= 0 || db <= 0) return 0;
    return num / Math.sqrt(da * db);
  }

  function nearestFloatLocal(list, t) {
    let best = null, bestD = Infinity;
    for (const it of list) {
      const d = Math.abs(it.t - t);
      if (d < bestD) { bestD = d; best = it; }
    }
    return best;
  }

  /* --------------------- Xếp lane (thuần, test được) --------------------- */
  /* lanes: [{id,name,kind}] hiện có · groups: Map(groupKey → [laneName,...]) */
  class LaneAllocator {
    constructor() {
      this.groups = new Map();   // groupKey -> [laneName]
    }
    importGroups(obj) {
      this.groups = new Map();
      if (!obj) return;
      for (const [k, v] of Object.entries(obj)) this.groups.set(k, Array.isArray(v) ? v.slice() : []);
    }
    exportGroups() {
      const o = {};
      for (const [k, v] of this.groups) o[k] = v.slice();
      return o;
    }
    /* Trả về { laneName, needCreate } — needCreate=true thì caller tạo lane R mới */
    allocate(cue, existingLanes) {
      const gk = cue.laneGroup || groupKeyFor(cue);
      const canOverlap = cue.kind === 'trigger';
      const occupied = this.groups.get(gk) || [];
      const isFree = (laneName) => {
        if (!existingLanes.some((l) => l.name === laneName)) return true;
        if (canOverlap) return true;
        return !existingLanes.some((l) => l.name === laneName && overlapsCue(laneName, cue, existingLanes));
      };
      // dùng lane cũ nếu trống về thời gian
      for (const name of occupied) {
        if (isFree(name)) return { laneName: name, needCreate: false };
      }
      // tạo lane mới cho nhóm
      return { laneName: null, needCreate: true };
    }
    remember(gk, laneName) {
      const arr = this.groups.get(gk) || [];
      if (!arr.includes(laneName)) arr.push(laneName);
      this.groups.set(gk, arr);
    }
    /* lane phụ cho Piano/Float chồng thời gian */
    overlapLane(gk, cue, existingLanes) {
      const arr = this.groups.get(gk) || [];
      for (const name of arr) {
        const busy = existingLanes.some((l) => l.name === name && overlapsCue(l.name, cue, existingLanes));
        if (!busy) return name;
      }
      return null;
    }
  }

  /* Hàm thuần: dựa vào existingLanes[].__cues? Không — caller truyền predicate.
     Để đơn giản & test được, dùng mảng cue truyền vào qua existingLanes[i].cues (nếu có). */
  function overlapsCue(laneName, cue, existingLanes) {
    const lane = existingLanes.find((l) => l.name === laneName);
    if (!lane || !Array.isArray(lane.cues)) return false;
    const a0 = cue.startFrame, a1 = cue.startFrame + Math.max(1, cue.durationFrames || 0);
    for (const c of lane.cues) {
      const b0 = c.frame, b1 = c.frame + Math.max(0, c.duration || 0);
      if (a0 < b1 && b0 < a1) return true;
    }
    return false;
  }

  return {
    DEFAULTS, RecEngine, LaneAllocator,
    rdp, pearson, floatArg, isNoise, specificity, baseAddress, groupKeyFor
  };
});
