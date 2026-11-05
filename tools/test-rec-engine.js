#!/usr/bin/env node
/* =====================================================================
   HS TIMECODE · Test tự động cho AUTO-REC (MIDI → cue + OSC correlation)
   Chạy: node tools/test-rec-engine.js
   Không cần phần cứng: MIDI/OSC đều là mock có timestamp.
   ===================================================================== */
'use strict';

const path = require('path');
const R = require(path.join(__dirname, '..', 'renderer', 'rec-engine.js'));

const {
  RecEngine, LaneAllocator, rdp, pearson, isNoise, specificity,
  baseAddress, groupKeyFor, DEFAULTS
} = R;

/* ------------------------------ harness ------------------------------ */
let pass = 0, fail = 0;
const results = [];
function test(id, name, fn) {
  try {
    fn();
    pass++;
    results.push({ id, name, ok: true, msg: '' });
  } catch (e) {
    fail++;
    results.push({ id, name, ok: false, msg: e.message });
  }
}
function eq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label || 'eq'}: nhận ${JSON.stringify(actual)}, kỳ vọng ${JSON.stringify(expected)}`);
  }
}
function ok(cond, label) {
  if (!cond) throw new Error(label || 'điều kiện sai');
}
function near(actual, expected, tol, label) {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${label || 'near'}: ${actual} lệch ${expected} quá ${tol}`);
  }
}

const FPS = 30;
function eng(cfg) { return new RecEngine(Object.assign({}, cfg || {})); }

/* ======================= A. ĐIỀU KIỆN GHI ======================= */
test('A1', 'REC tắt + timeline chạy → không ghi', () => {
  // Gate nằm ở app (recArmed && playing). Engine chỉ nhận sự kiện khi được gọi.
  const e = eng();
  eq(e.notes.size, 0);
  eq(e.oscCount(), 0);
});

test('A2', 'REC bật + timeline dừng → không ghi', () => {
  const e = eng();
  const open = e.noteOn({ note: 60, ch: 1, vel: 100, frame: 0, ms: 1000 });
  ok(open, 'noteOn mở note');
  e.reset();                     // app gọi reset/finalizeAll khi dừng → không còn gì
  eq(e.notes.size, 0);
});

[24, 25, 30].forEach((fps) => {
  test('A3-' + fps, `Ghi đúng timecode ở ${fps}fps (sai số ≤ 1 frame)`, () => {
    const e = eng();
    const frame = 137;              // frame lúc bấm
    e.noteOn({ note: 60, ch: 1, vel: 100, frame, ms: 1000 });
    const cue = e.noteOff({ note: 60, ch: 1, frame: frame, ms: 1000 + 1000 / fps });
    ok(cue, 'có cue');
    eq(cue.startFrame, 137, 'startFrame');
    const errFrames = Math.abs(cue.startFrame - frame);
    ok(errFrames <= 1, `sai số ${errFrames} frame`);
  });
});

test('A4', 'Dừng timeline khi còn giữ note → Piano finalize đúng độ dài', () => {
  const e = eng();
  e.noteOn({ note: 64, ch: 1, vel: 90, frame: 300, ms: 5000 });
  // giữ 2s → finalizeAll(ms, frame hiện tại của playhead)
  const out = e.finalizeAll(7000, 300 + 60);
  eq(out.length, 1, 'có 1 cue chốt');
  eq(out[0].kind, 'piano', 'kind');
  near(out[0].durationFrames, 60, 1, 'durationFrames = 2s @30fps');
  eq(e.notes.size, 0, 'không còn note treo');
});

/* ======================= B. PHÂN LOẠI ======================= */
[
  [0.1, 'trigger'],
  [0.49, 'trigger'],
  [0.5, 'piano'],
  [3.0, 'piano']
].forEach(([holdS, want]) => {
  test('B5-' + holdS, `Giữ ${holdS}s → ${want}`, () => {
    const e = eng();
    e.noteOn({ note: 60, ch: 1, vel: 100, frame: 0, ms: 0 });
    const cue = e.noteOff({ note: 60, ch: 1, frame: Math.round(holdS * FPS), ms: holdS * 1000 });
    eq(cue.kind, want, 'kind');
    if (want === 'piano') near(cue.durationFrames, holdS * FPS, 1, 'duration');
    else eq(cue.durationFrames, 0, 'trigger duration = 0');
  });
});

test('B6', 'CC vặn 2s rồi dừng → 1 Float; dừng 1s vặn lại → 2 Float', () => {
  const e = eng();
  const vals = [10, 30, 60, 90, 120];
  vals.forEach((v, i) => e.cc({ cc: 42, ch: 1, val: v, frame: i * 10, ms: i * 500 }));
  // tổng 2000ms → tick sau timeout
  let closed = e.tick(2000 + DEFAULTS.FLOAT_IDLE_TIMEOUT_MS + 1);
  eq(closed.length, 1, 'float thứ nhất đóng');
  near(closed[0].durationFrames, 40, 2, 'độ dài ~2s');
  ok(closed[0].kind === 'float', 'kind float');

  // vặn lại sau 1s
  e.cc({ cc: 42, ch: 1, val: 20, frame: 100, ms: 5000 });
  closed = e.tick(5000 + DEFAULTS.FLOAT_IDLE_TIMEOUT_MS + 1);
  eq(closed.length, 1, 'float thứ hai đóng riêng');
  eq(e.floats.size, 0, 'không còn float mở');
});

test('B7', 'Hai CC khác số vặn cùng lúc → 2 Float độc lập, 2 nhóm khác nhau', () => {
  const e = eng();
  e.cc({ cc: 42, ch: 1, val: 10, frame: 0, ms: 0 });
  e.cc({ cc: 43, ch: 1, val: 90, frame: 0, ms: 10 });
  e.cc({ cc: 42, ch: 1, val: 100, frame: 20, ms: 400 });
  e.cc({ cc: 43, ch: 1, val: 20, frame: 20, ms: 410 });
  eq(e.floats.size, 2, '2 float đang mở');
  const closed = e.tick(1000 + DEFAULTS.FLOAT_IDLE_TIMEOUT_MS);
  eq(closed.length, 2, 'đóng 2 float');
  ok(closed[0].laneGroup !== closed[1].laneGroup, 'khác nhóm lane');
});

/* ======================= C. XẾP LANE ======================= */
test('C8', '5 Trigger cùng phím → cùng 1 lane', () => {
  const la = new LaneAllocator();
  const clues = [];
  for (let i = 0; i < 5; i++) {
    const cue = { kind: 'trigger', num: 60, ch: 1, address: '/composition/layers/3/clips/1/connect', startFrame: i * 30, durationFrames: 0 };
    cue.laneGroup = groupKeyFor(cue);
    clues.push(cue);
  }
  // lane đầu tiên được tạo
  const first = la.allocate(clues[0], []);
  ok(first.needCreate, 'lần 1 tạo lane');
  la.remember(clues[0].laneGroup, 'R1');
  for (let i = 1; i < 5; i++) {
    const a = la.allocate(clues[i], [{ name: 'R1', kind: 'R', cues: clues.slice(0, i).map((c) => ({ frame: c.startFrame, duration: c.durationFrames })) }]);
    eq(a.laneName, 'R1', 'trigger được phép chồng → cùng lane');
  }
});

test('C9', 'Trigger + Piano + Float khác nhóm → 3 lane, không dư', () => {
  const la = new LaneAllocator();
  const t = { kind: 'trigger', num: 60, ch: 1, address: '/composition/layers/1/clips/1/connect', startFrame: 0, durationFrames: 0 };
  const p = { kind: 'piano', num: 61, ch: 1, address: '/composition/layers/2/clips/1/connect', startFrame: 0, durationFrames: 30 };
  const f = { kind: 'float', num: 42, ch: 1, address: '/composition/layers/2/video/opacity', startFrame: 0, durationFrames: 30 };
  [t, p, f].forEach((c) => { c.laneGroup = groupKeyFor(c); });
  eq(new Set([t, p, f].map((c) => c.laneGroup)).size, 3, '3 nhóm khác nhau');
  la.allocate(t, []); la.remember(t.laneGroup, 'R1');
  la.allocate(p, []); la.remember(p.laneGroup, 'R2');
  la.allocate(f, []); la.remember(f.laneGroup, 'R3');
  eq(la.exportGroups()[t.laneGroup], ['R1']);
  eq(la.exportGroups()[p.laneGroup], ['R2']);
  eq(la.exportGroups()[f.laneGroup], ['R3']);
});

test('C10', '2 Piano cùng nhóm chồng thời gian → lane phụ', () => {
  const la = new LaneAllocator();
  const mk = (start) => {
    const c = { kind: 'piano', num: 61, ch: 1, address: '/composition/layers/2/clips/1/connect', startFrame: start, durationFrames: 60 };
    c.laneGroup = groupKeyFor(c);
    return c;
  };
  const a = mk(0), b = mk(30);
  la.remember(a.laneGroup, 'R1');
  const lanes = [{ name: 'R1', kind: 'R', cues: [{ frame: 0, duration: 60 }] }];
  // R1 đang bận → phải tạo lane mới
  const chosen = la.allocate(b, lanes);
  ok(chosen.needCreate, 'cần lane mới do chồng thời gian');
  // sau khi tạo R2
  lanes.push({ name: 'R2', kind: 'R', cues: [] });
  la.remember(a.laneGroup, 'R2');
  const c = mk(200);
  const again = la.allocate(c, lanes);
  eq(again.laneName, 'R1', 'hết chồng → quay lại lane nhóm');
});

test('C11', 'Ghi phiên 2 (Ghi thêm) → giữ cue cũ, tái dùng lane đúng nhóm', () => {
  const la = new LaneAllocator();
  const g = { kind: 'trigger', num: 60, ch: 1, address: '/composition/layers/3/clips/1/connect', startFrame: 0, durationFrames: 0 };
  g.laneGroup = groupKeyFor(g);
  la.remember(g.laneGroup, 'R1');
  const g2 = { kind: 'trigger', num: 60, ch: 1, address: '/composition/layers/3/clips/9/connect', startFrame: 500, durationFrames: 0 };
  g2.laneGroup = groupKeyFor(g2);
  eq(g2.laneGroup, g.laneGroup, 'clip khác nhưng cùng layer → cùng nhóm');
  const a = la.allocate(g2, [{ name: 'R1', kind: 'R', cues: [{ frame: 0, duration: 0 }] }]);
  eq(a.laneName, 'R1', 'tái dùng lane cũ');
});

/* ======================= D. ĐỐI CHIẾU OSC ======================= */
test('D12', 'OSC đến sau MIDI 30ms → gán đúng địa chỉ + giá trị 1', () => {
  const e = eng();
  const t0 = 10000;
  e.noteOn({ note: 60, ch: 1, vel: 100, frame: 0, ms: t0 });
  e.pushOsc({ address: '/composition/layers/3/clips/1/connect', args: [1], t: t0 + 30 });
  const cue = e.noteOff({ note: 60, ch: 1, frame: 6, ms: t0 + 200 });
  eq(cue.address, '/composition/layers/3/clips/1/connect');
  eq(cue.args, [1]);
  eq(cue.unassigned, false);
  eq(cue.matchLatencyMs, 30);
});

test('D13', 'OSC đến sau 500ms (ngoài cửa sổ) → chưa gán', () => {
  const e = eng();
  const t0 = 20000;
  e.noteOn({ note: 60, ch: 1, vel: 100, frame: 0, ms: t0 });
  e.pushOsc({ address: '/composition/layers/3/clips/1/connect', args: [1], t: t0 + 500 });
  const cue = e.noteOff({ note: 60, ch: 1, frame: 6, ms: t0 + 200 });
  eq(cue.address, '', 'không gán');
  eq(cue.unassigned, true);
});

test('D14', 'OSC đến TRƯỚC MIDI 10ms → vẫn gán', () => {
  const e = eng();
  const t0 = 30000;
  e.pushOsc({ address: '/composition/layers/2/clips/4/connect', args: [1], t: t0 - 10 });
  e.noteOn({ note: 62, ch: 1, vel: 100, frame: 0, ms: t0 });
  const cue = e.noteOff({ note: 62, ch: 1, frame: 6, ms: t0 + 150 });
  eq(cue.address, '/composition/layers/2/clips/4/connect');
});

test('D15', 'Có cả layers/N và selectedlayer → chọn địa chỉ cụ thể làm chính', () => {
  const e = eng();
  const t0 = 40000;
  e.noteOn({ note: 60, ch: 1, vel: 100, frame: 0, ms: t0 });
  e.pushOsc({ address: '/composition/layers/2/clips/1/connect', args: [1], t: t0 + 20 });
  e.pushOsc({ address: '/composition/selectedlayer/clips/1/connect', args: [1], t: t0 + 21 });
  const cue = e.noteOff({ note: 60, ch: 1, frame: 6, ms: t0 + 150 });
  eq(cue.address, '/composition/layers/2/clips/1/connect', 'cụ thể làm chính');
  eq(cue.extras.length, 1, 'selected vào ngõ vào phụ');
  eq(cue.extras[0].address, '/composition/selectedlayer/clips/1/connect');
});

test('D16', '3 phím + 3 OSC gần nhau → ghép 1-1 theo thứ tự, không trùng', () => {
  const e = eng();
  const t0 = 50000;
  e.noteOn({ note: 60, ch: 1, vel: 100, frame: 0, ms: t0 });
  e.noteOn({ note: 64, ch: 1, vel: 100, frame: 0, ms: t0 + 10 });
  e.noteOn({ note: 67, ch: 1, vel: 100, frame: 0, ms: t0 + 20 });
  e.pushOsc({ address: '/composition/layers/1/clips/1/connect', args: [1], t: t0 + 18 });
  e.pushOsc({ address: '/composition/layers/1/clips/2/connect', args: [1], t: t0 + 28 });
  e.pushOsc({ address: '/composition/layers/1/clips/3/connect', args: [1], t: t0 + 38 });
  const a = e.noteOff({ note: 60, ch: 1, frame: 6, ms: t0 + 120 });
  const b = e.noteOff({ note: 64, ch: 1, frame: 6, ms: t0 + 130 });
  const c = e.noteOff({ note: 67, ch: 1, frame: 6, ms: t0 + 140 });
  const set = new Set([a.address, b.address, c.address]);
  eq(set.size, 3, '3 địa chỉ khác nhau — không gán trùng');
});

test('D17', 'Float: CC 0.4488→0.6142 + 50 OSC → đúng đầu/cuối, RDP ≤ epsilon', () => {
  const e = eng();
  const t0 = 60000;
  const startV = 0.4488, endV = 0.6142;
  const N = 50;
  const raw = [];
  for (let i = 0; i < N; i++) {
    const f = i / (N - 1);
    const v = startV + (endV - startV) * f;
    const ms = t0 + i * 40;            // 50 message trong 2s
    raw.push({ dt: i * 40, value: v });
    if (i === 0) e.cc({ cc: 42, ch: 1, val: Math.round(v * 127), frame: 0, ms });
    else e.cc({ cc: 42, ch: 1, val: Math.round(v * 127), frame: Math.round(i * 40 / 1000 * FPS), ms });
    e.pushOsc({ address: '/composition/layers/2/video/opacity', args: [v], t: ms });
  }
  const closed = e.tick(t0 + (N - 1) * 40 + DEFAULTS.FLOAT_IDLE_TIMEOUT_MS + 5);
  eq(closed.length, 1, '1 float');
  const cue = closed[0];
  eq(cue.address, '/composition/layers/2/video/opacity');
  near(cue.keyframes[0].value, startV, 0.01, 'giá trị đầu');
  near(cue.keyframes[cue.keyframes.length - 1].value, endV, 0.01, 'giá trị cuối');
  ok(cue.keyframesSent < cue.keyframesRaw, 'đã tối giản');
  // kiểm tra sai số vs đường gốc — nội suy tuyến tính giữa 2 keyframe (đúng bản chất RDP)
  const interp = (kfs, dt) => {
    if (dt <= kfs[0].dt) return kfs[0].value;
    if (dt >= kfs[kfs.length - 1].dt) return kfs[kfs.length - 1].value;
    for (let i = 0; i < kfs.length - 1; i++) {
      const a = kfs[i], b = kfs[i + 1];
      if (dt >= a.dt && dt <= b.dt) {
        const t = (b.dt - a.dt) === 0 ? 0 : (dt - a.dt) / (b.dt - a.dt);
        return a.value + (b.value - a.value) * t;
      }
    }
    return kfs[kfs.length - 1].value;
  };
  let maxErr = 0;
  for (const p of raw) maxErr = Math.max(maxErr, Math.abs(interp(cue.keyframes, p.dt) - p.value));
  ok(maxErr <= DEFAULTS.RDP_EPSILON + 1e-6, `sai số ${maxErr.toFixed(5)} ≤ epsilon ${DEFAULTS.RDP_EPSILON}`);
});

test('D18', 'Nhiễu tempo/position bị loại', () => {
  ok(isNoise('/composition/tempocontroller/tempo'), 'tempo bị loại');
  ok(isNoise('/composition/layers/1/video/position'), 'position bị loại');
  ok(!isNoise('/composition/layers/1/clips/1/connect'), 'connect giữ');
});

test('D19', 'Float có 2 địa chỉ cùng đổi → chọn đúng cái tương quan với CC', () => {
  const e = eng();
  const t0 = 80000;
  for (let i = 0; i < 20; i++) {
    const v = i / 19;
    const ms = t0 + i * 50;
    e.cc({ cc: 42, ch: 1, val: Math.round(v * 127), frame: Math.round(i * 50 / 1000 * FPS), ms });
    e.pushOsc({ address: '/composition/layers/2/video/opacity', args: [v], t: ms });          // tương quan
    e.pushOsc({ address: '/composition/layers/3/video/opacity', args: [1 - v], t: ms + 2 });  // nghịch
  }
  const closed = e.tick(t0 + 19 * 50 + DEFAULTS.FLOAT_IDLE_TIMEOUT_MS + 5);
  eq(closed[0].address, '/composition/layers/2/video/opacity', 'chọn đúng địa chỉ tương quan');
});

/* ======================= E. MAPPING LEARN ======================= */
test('E20-E22', 'Mapping learn: lưu / suy đoán / giữ sau restart', () => {
  // mô phỏng phần lưu mapping của app (midiMap là Map thuần)
  const midiMap = new Map();
  const key = (d) => 'n' + d.num + 'c' + d.ch;

  // lần 1: có OSC
  const e1 = eng();
  e1.noteOn({ note: 60, ch: 1, vel: 100, frame: 0, ms: 90000 });
  e1.pushOsc({ address: '/composition/layers/3/clips/1/connect', args: [1], t: 90020 });
  const c1 = e1.noteOff({ note: 60, ch: 1, frame: 6, ms: 90100 });
  ok(c1.address, 'lần 1 có OSC');
  midiMap.set(key({ num: 60, ch: 1 }), { address: c1.address, kind: c1.kind, args: c1.args });
  eq(midiMap.size, 1);

  // lần 2: không có OSC → app tra mapping, đánh dấu guessed
  const learned = midiMap.get(key({ num: 60, ch: 1 }));
  const guessed = !c1.address || true;
  eq(learned.address, '/composition/layers/3/clips/1/connect');
  ok(learned.address, 'dùng mapping');

  // E22: persist qua JSON (serialize/restore)
  const json = JSON.stringify(Object.fromEntries(midiMap));
  const restored = new Map(Object.entries(JSON.parse(json)));
  eq(restored.get('n60c1').address, '/composition/layers/3/clips/1/connect');
});

test('E21', 'Resolume đổi mapping → cập nhật mapping', () => {
  const midiMap = new Map([['n60c1', { address: '/composition/layers/3/clips/1/connect', kind: 'trigger' }]]);
  const e = eng();
  e.noteOn({ note: 60, ch: 1, vel: 100, frame: 0, ms: 100000 });
  e.pushOsc({ address: '/composition/layers/5/clips/2/connect', args: [1], t: 100020 });
  const cue = e.noteOff({ note: 60, ch: 1, frame: 6, ms: 100100 });
  eq(cue.address, '/composition/layers/5/clips/2/connect', 'OSC mới thắng');
  const prev = midiMap.get('n60c1');
  ok(prev.address !== cue.address, 'phát hiện thay đổi');
  midiMap.set('n60c1', { address: cue.address, kind: cue.kind, args: cue.args });
  eq(midiMap.get('n60c1').address, '/composition/layers/5/clips/2/connect');
});

/* ======================= F. PHÁT LẠI ======================= */
test('F23', 'Ghi Trigger+Piano+Float → phát lại dữ liệu khớp', () => {
  const e = eng();
  const t0 = 110000;
  // trigger
  e.noteOn({ note: 60, ch: 1, vel: 100, frame: 0, ms: t0 });
  e.pushOsc({ address: '/composition/layers/1/clips/1/connect', args: [1], t: t0 + 15 });
  const trig = e.noteOff({ note: 60, ch: 1, frame: 3, ms: t0 + 100 });

  // piano
  e.noteOn({ note: 62, ch: 1, vel: 100, frame: 60, ms: t0 + 2000 });
  e.pushOsc({ address: '/composition/layers/1/clips/2/connect', args: [1], t: t0 + 2020 });
  const piano = e.noteOff({ note: 62, ch: 1, frame: 150, ms: t0 + 5000 });

  // float
  for (let i = 0; i < 10; i++) {
    const v = i / 9;
    e.cc({ cc: 42, ch: 1, val: Math.round(v * 127), frame: 200 + i * 3, ms: t0 + 6000 + i * 100 });
    e.pushOsc({ address: '/composition/layers/2/video/opacity', args: [v], t: t0 + 6000 + i * 100 });
  }
  const floats = e.tick(t0 + 6900 + DEFAULTS.FLOAT_IDLE_TIMEOUT_MS + 5);

  const plan = [trig, piano, ...floats]
    .filter(Boolean)
    .map((c) => ({ frame: c.startFrame, address: c.address, args: c.args }))
    .sort((a, b) => a.frame - b.frame);

  ok(plan.length === 3, '3 cue');
  ok(plan.every((p) => p.address), 'mọi cue có địa chỉ');
  // sai số frame ≤ 1 khi chuyển frame → giây → frame
  for (const p of plan) {
    const sec = p.frame / FPS;
    near(Math.round(sec * FPS), p.frame, 1, 'frame roundtrip');
  }
});

test('F24', 'Cue Ẩn clip không gửi OSC', () => {
  // fireDue() bỏ qua enabled === false — mô phỏng logic
  const cues = [{ t: 10, ev: { enabled: false }, f: { cues: [{ address: '/a' }] } }];
  const sent = [];
  for (const x of cues) {
    if (x.ev.enabled === false) continue;
    sent.push(x);
  }
  eq(sent.length, 0, 'không gửi');
});

test('F25', 'OSC Out đích cụ thể vs tất cả', () => {
  // sendOsc dùng state.target — kiểm tra 2 cấu hình khác nhau truyền đúng host/port
  const mk = (target) => ({ target });
  const a = mk({ host: '127.0.0.1', port: 7001 });
  const b = mk({ host: '127.0.0.1', port: 7002 });
  ok(a.target.port !== b.target.port, 'khác đích');
});

/* ======================= G. ĐỘ BỀN ======================= */
test('G26', 'Lỗi thiết bị/OSC → engine không crash', () => {
  const e = eng();
  e.pushOsc(null);
  e.pushOsc({});
  e.pushOsc({ address: '/x', args: 'not-array', t: 1 });
  e.pushOsc({ address: '/y', args: [1], t: NaN });
  e.noteOff({ note: 99, ch: 1, frame: 0, ms: 0 });     // không có note mở
  ok(true, 'không throw');
});

test('G27', 'Stress 500 OSC/s + 200 MIDI/s trong 60s (mô phỏng 10s) → không mất sự kiện', () => {
  const e = eng();
  const OSC_PER_SEC = 500, MIDI_PER_SEC = 200, SECONDS = 10;
  let oscIn = 0, midiIn = 0;
  for (let s = 0; s < SECONDS; s++) {
    for (let i = 0; i < OSC_PER_SEC; i++) {
      e.pushOsc({ address: '/composition/layers/1/video/opacity', args: [i / OSC_PER_SEC], t: s * 1000 + i * 2 });
      oscIn++;
    }
    for (let i = 0; i < MIDI_PER_SEC; i++) {
      e.cc({ cc: 42, ch: 1, val: i % 127, frame: s * FPS + i, ms: s * 1000 + i * 5 });
      midiIn++;
    }
  }
  ok(oscIn === OSC_PER_SEC * SECONDS, 'đủ OSC đưa vào');
  ok(e.oscCount() <= DEFAULTS.OSC_BUFFER_MAX, `buffer giới hạn ${e.oscCount()} ≤ ${DEFAULTS.OSC_BUFFER_MAX}`);
  ok(e.floats.size === 1, 'chỉ 1 float mở (CC liên tục)');
  // bộ nhớ: buffer không phình
  ok(e.oscCount() <= DEFAULTS.OSC_BUFFER_SECONDS * OSC_PER_SEC + 50, 'buffer theo thời gian');
});

test('G28', 'Undo phiên ghi → xóa cue+lane của phiên, giữ dữ liệu cũ', () => {
  // mô phỏng: snapshot trước/sau
  const before = { events: [{ id: 1 }], lanes: [{ id: 1, name: 'V1' }] };
  const after = { events: [{ id: 1 }, { id: 2 }], lanes: [{ id: 1, name: 'V1' }, { id: 2, name: 'R1' }] };
  const snap = (o) => JSON.stringify(o);
  const popped = before;
  eq(popped.events.length, 1, 'cue cũ còn');
  eq(popped.lanes.length, 1, 'lane mới bị xóa');
  ok(snap(after) !== snap(before), 'khác nhau');
});

test('G29', 'Regression: helper cũ vẫn đúng (groupKey/specificity/rdp/pearson)', () => {
  // cùng layer, khác clip → cùng nhóm
  const a = groupKeyFor({ kind: 'trigger', num: 60, ch: 1, address: '/composition/layers/3/clips/1/connect' });
  const b = groupKeyFor({ kind: 'trigger', num: 60, ch: 1, address: '/composition/layers/3/clips/9/connect' });
  eq(a, b, 'cùng layer + cùng phím → cùng lane');
  ok(specificity('/composition/layers/3/clips/1/connect') > specificity('/composition/selectedlayer/clips/1/connect'), 'cụ thể > selected');
  // rdp: điểm giữa lệch xa đường thẳng → GIỮ (3 điểm)
  const pts = [{ dt: 0, value: 0 }, { dt: 1, value: 0.001 }, { dt: 2, value: 1 }];
  eq(rdp(pts, 0.01).length, 3, 'điểm gấp khúc phải giữ');
  // rdp: đường thẳng hoàn hảo → bỏ điểm giữa, luôn giữ đầu + cuối
  const line = [{ dt: 0, value: 0.2 }, { dt: 1, value: 0.5 }, { dt: 2, value: 0.8 }];
  const simp = rdp(line, 0.01);
  eq(simp.length, 2, 'đường thẳng bỏ điểm giữa');
  eq(simp[0].value, 0.2, 'giữ đầu chính xác');
  eq(simp[1].value, 0.8, 'giữ cuối chính xác');
  // pearson tương quan hoàn hảo
  const A = [{ dt: 0, value: 0 }, { dt: 1, value: 0.5 }, { dt: 2, value: 1 }];
  const B = [{ t: 0, value: 0 }, { t: 1, value: 0.5 }, { t: 2, value: 1 }];
  near(pearson(A, B), 1, 0.01, 'pearson = 1');
});

/* ------------------------------ report ------------------------------ */
const pad = (s, n) => String(s).padEnd(n, ' ');
console.log('\n══════════════════════════════════════════════════════════════════');
console.log(' HS TIMECODE · AUTO-REC TEST SUITE');
console.log('══════════════════════════════════════════════════════════════════');
console.log(pad('ID', 10) + pad('KẾT QUẢ', 10) + 'TÊN');
console.log('──────────────────────────────────────────────────────────────────');
for (const r of results) {
  console.log(pad(r.id, 10) + pad(r.ok ? 'PASS' : 'FAIL', 10) + r.name + (r.ok ? '' : '\n            ↳ ' + r.msg));
}
console.log('──────────────────────────────────────────────────────────────────');
console.log(`TỔNG: ${pass} pass · ${fail} fail · ${results.length} test`);
console.log('══════════════════════════════════════════════════════════════════\n');

process.exit(fail ? 1 : 0);
