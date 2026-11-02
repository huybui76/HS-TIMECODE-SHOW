'use strict';
/* Acceptance test cho Cut/Split + Multi-Instance audio (CapCut-style) — HS TIMECODE.
   • Trích hàm GỐC makeAudioClip() + migrateAudioClips() từ renderer/app.js (test đúng code đang chạy).
   • Cut / kéo-mép (resize-l / resize-r) mô phỏng ĐÚNG công thức trong handler timeline của app.js
     (ghi chú "mirror app.js" tại từng khối) để chốt behavior theo spec:
       – Cut: 2 segment cùng source, không copy file, không mất data
       – Kéo mép: khôi phục từ source gốc, KHÔNG stretch, không vượt giới hạn source
       – Thêm cùng file nhiều lần: nhiều instance độc lập (instanceId riêng, cùng sourceId)
       – Save → Load (v8): mọi instance + cut/trim range bất biến
       – Dự án v7 cũ (nhạc gắn trên lane): migrate thành 1 instance full-range */

const fs = require('fs');
let nidCounter = 5000;
const nid = () => ++nidCounter;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ===== Trích hàm GỐC từ app.js ===== */
const src = fs.readFileSync(__dirname + '/../renderer/app.js', 'utf8');
function extractFn(name, nextMarker) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) { console.error('KHÔNG tìm thấy ' + name + ' trong app.js'); process.exit(1); }
  const end = src.indexOf(nextMarker, start);
  const body = src.slice(start, end);
  return new Function('nid', 'clamp', 'makeAudioClip',
    '"use strict";\n' + body.replace('function ' + name, 'return function ' + name) + '\n');
}
const makeAudioClip = extractFn('makeAudioClip', '\nfunction clipLen')(nid, clamp, null);
const clipLen = extractFn('clipLen', '\nfunction clipSong')(nid, clamp, makeAudioClip);
const migrateAudioClips = extractFn('migrateAudioClips', '\nfunction applyProject')(nid, clamp, makeAudioClip);

/* ===== Mirror khối serialize audioClips trong serializeProject() (app.js) ===== */
function serializeAudioClips(clips) {
  return clips.map((c) => ({
    instanceId: c.id, sourceId: c.songId, trackId: c.laneId,
    timelineStart: c.tlStart, timelineEnd: c.tlStart + clipLen(c),
    sourceStart: c.srcStart, sourceEnd: c.srcEnd,
    volume: typeof c.volume === 'number' ? c.volume : 1,
    fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0
  }));
}

/* ===== Mirror công thức cut + kéo mép trong mousedown/mousemove của app.js ===== */
function cutAt(clips, clip, cutTl) {
  const cutSrc = clip.srcStart + (cutTl - clip.tlStart);
  const part2 = makeAudioClip(clip.songId, clip.laneId, cutTl, cutSrc, clip.srcEnd);
  clip.srcEnd = cutSrc;
  clips.push(part2);
  return part2;
}
function resizeLeft(clip, dx, sDur) {
  const tl0 = clip.tlStart, ss0 = clip.srcStart, se0 = clip.srcEnd;
  let d = dx;
  const minD = Math.max(-ss0, -tl0);
  if (d < minD) d = minD;
  if (se0 - (ss0 + d) < 0.06) d = se0 - ss0 - 0.06;
  clip.srcStart = ss0 + d;
  clip.tlStart = tl0 + d;
}
function resizeRight(clip, dx, sDur) {
  let newSE = clip.srcEnd + dx;
  if (newSE > sDur) newSE = sDur;
  if (newSE < clip.srcStart + 0.06) newSE = clip.srcStart + 0.06;
  clip.srcEnd = newSE;
}

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ LỖI: ') + msg); if (!cond) fails++; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ================= TEST 1 — CUT: audio 5 phút, cắt tại 2:00 → 2 segment ================= */
console.log('== TEST 1 — Cut tại 2:00 trên audio 5 phút ==');
const SONG_ID = 101, LANE_ID = 7, DUR = 300;
let clips = [makeAudioClip(SONG_ID, LANE_ID, 0, 0, DUR)];
const part2 = cutAt(clips, clips[0], 120);
ok(clips.length === 2, 'Có đúng 2 segment sau Cut');
ok(clips.every((c) => c.songId === SONG_ID), 'Cả 2 segment CÙNG sourceId (không tạo file mới)');
ok(clips.every((c) => c.id !== clips.find((x) => x !== c).id), 'Mỗi segment có instanceId RIÊNG');
ok(near(clips[0].srcStart, 0) && near(clips[0].srcEnd, 120), 'seg1: sourceStart=0 → sourceEnd=120');
ok(near(part2.srcStart, 120) && near(part2.srcEnd, 300), 'seg2: sourceStart=120 → sourceEnd=300 (nối liền, không mất data)');
ok(near(part2.tlStart, 120), 'seg2: timelineStart=120 (đúng vị trí cắt)');
ok(near(clips.reduce((n, c) => n + clipLen(c), 0), DUR), 'Tổng độ dài 2 segment = 300s (nguyên vẹn nguồn)');

/* ================= TEST 2 — RESTORE: kéo mép trái seg2 ngược về trước ================= */
console.log('== TEST 2 — Kéo mép trái seg2 khôi phục phần đã cắt ==');
resizeLeft(part2, -200, DUR);          // kéo vượt cả đầu source
ok(near(part2.srcStart, 0), 'srcStart khôi phục về 0 (đúng dữ liệu đầu nguồn) — KHÔNG vượt quá source');
ok(near(part2.tlStart, 0), 'timelineStart = 0 (không tạo khoảng trắng)');
ok(near(clipLen(part2), 300), 'seg2 dài lại 300s — data lấy từ source gốc, không stretch');
resizeLeft(part2, -999, DUR);          // kéo tiếp khi đã chạm giới hạn
ok(near(part2.srcStart, 0) && near(part2.tlStart, 0), 'Kéo quá giới hạn → đứng yên ở 0 (chặn đúng limit source)');

/* trim trước rồi restore — chỉ khôi phục được đến mức đã trim của CHÍNH segment này */
const trimmed = makeAudioClip(SONG_ID, LANE_ID, 100, 50, 250);
resizeLeft(trimmed, -999, DUR);
ok(near(trimmed.srcStart, 0) && near(trimmed.tlStart, 50), 'Segment đã trim srcStart=50: kéo trái chỉ về 0 (mapping timeline giữ nguyên)');

/* kéo mép PHẢI: không vượt quá cuối source, không tạo khoảng trắng */
const rClip = makeAudioClip(SONG_ID, LANE_ID, 10, 0, 100);
resizeRight(rClip, 999, DUR);
ok(near(rClip.srcEnd, DUR), 'Kéo mép phải vượt quá → kẹp đúng sourceEnd=300');
resizeRight(rClip, -999, DUR);
ok(rClip.srcEnd >= rClip.srcStart + 0.06, 'Kéo mép phải sát quá → vẫn còn ≥ 60ms (clip không bị méo)');

/* ================= TEST 3 — MULTIPLE INSTANCES: cùng song.wav 3 lần ================= */
console.log('== TEST 3 — Thêm cùng source 3 lần + xóa instance 2 ==');
clips = [
  makeAudioClip(SONG_ID, LANE_ID, 0, 0, 60),
  makeAudioClip(SONG_ID, LANE_ID, 120, 0, 60),
  makeAudioClip(SONG_ID, LANE_ID, 300, 0, 60)
];
ok(clips.length === 3 && new Set(clips.map((c) => c.id)).size === 3, '3 instance tồn tại độc lập, instanceId khác nhau từng đôi');
ok(clips.every((c) => c.songId === SONG_ID), 'Cả 3 cùng sourceId (source chỉ 1 trong Media)');
clips = clips.filter((c) => c.id !== clips[1].id);   // xóa instance 2 (như removeAudioClip)
ok(clips.length === 2 && near(clips[0].tlStart, 0) && near(clips[1].tlStart, 300), 'Xóa instance 2 → instance 1 & 3 nguyên vẹn');

/* ================= TEST 4 — INDEPENDENT EDITING: trim instance 1 không đụng instance 3 ================= */
console.log('== TEST 4 — Chỉnh instance 1 không ảnh hưởng instance 3 ==');
const i1 = clips[0], i3 = clips[1];
const i3Before = JSON.stringify(i3);
resizeLeft(i1, -10, DUR);
resizeRight(i1, 30, DUR);
i1.volume = 0.5; i1.fadeIn = 2;
ok(near(i1.srcEnd, 90) && i1.srcEnd !== 60, 'instance 1 đã bị trim (range đổi: srcEnd 60 → 90)');
ok(JSON.stringify(i3) === i3Before, 'instance 3 HOÀN TOÀN không đổi (position/trim/volume/fade riêng)');

/* ================= TEST 5 — SAVE → LOAD (v8): bất biến qua 2 vòng ================= */
console.log('== TEST 5 — Save → Load (dùng migrateAudioClips GỐC từ app.js) ==');
const songs = [{ id: SONG_ID, duration: DUR }];
const lanes = [{ id: LANE_ID, kind: 'A' }, { id: 99, kind: 'V' }];
function roundTrip(cs) {
  const saved = { version: 8, audioClips: serializeAudioClips(cs) };
  const disk = JSON.parse(JSON.stringify(saved));                    // ghi ra file rồi đọc lại
  return migrateAudioClips(disk, songs, lanes);
}
const before = serializeAudioClips(clips);
let reloaded = roundTrip(clips);
ok(reloaded.length === clips.length, 'Load: đủ số instance');
ok(near(reloaded[0].tlStart, clips[0].tlStart) && near(reloaded[0].srcStart, clips[0].srcStart) && near(reloaded[0].srcEnd, clips[0].srcEnd),
   'Load: range timeline/source giữ nguyên (tiếp tục kéo mép khôi phục được)');
ok(near(reloaded[0].volume, 0.5) && near(reloaded[0].fadeIn, 2), 'Load: volume/fade theo instance giữ nguyên');
const again = roundTrip(reloaded);
ok(JSON.stringify(serializeAudioClips(again)) === JSON.stringify(serializeAudioClips(reloaded)), 'Vòng 2 Save→Load: BẤT BIẾN');
ok(new Set(reloaded.map((c) => c.id)).size === reloaded.length, 'instanceId duy nhất sau Load');
/* Cut → Save → Load: 2 segment vẫn chỉ về cùng source */
const cutClip = makeAudioClip(SONG_ID, LANE_ID, 0, 0, 300);
const clones = [cutClip];
cutAt(clones, cutClip, 120);
const reloadedCut = roundTrip(clones);
ok(reloadedCut.length === 2 && reloadedCut.every((c) => c.songId === SONG_ID), 'Sau Cut → Save → Load: vẫn 2 segment cùng source');
ok(near(reloadedCut[0].srcEnd, 120) && near(reloadedCut[1].srcStart, 120), 'Vết cắt giữ đúng vị trí qua Save → Load');

/* Clip mồ côi (source đã xóa khỏi Media) không sinh clip ma */
const orphan = migrateAudioClips({ audioClips: [{ instanceId: 'au1', sourceId: 999, timelineStart: 0 }] }, songs, lanes);
ok(orphan.length === 0, 'Instance mồ côi (sourceId không còn) bị bỏ khi Load');

/* ================= TEST 6 — MIGRATE dự án v7 (nhạc gắn trên lane) ================= */
console.log('== TEST 6 — Dự án v7 cũ: lane gắn bài → 1 instance full-range ==');
const v7 = migrateAudioClips(
  { version: 7 },                                     // KHÔNG có audioClips → rẽ nhánh migrate
  songs,
  [{ id: LANE_ID, kind: 'A', songId: SONG_ID, songOffset: 30, songEnd: 0 }, { id: 99, kind: 'V' }]
);
ok(v7.length === 1, 'v7 → đúng 1 instance cho lane A có bài');
ok(v7[0] && near(v7[0].tlStart, 30) && near(v7[0].srcStart, 0) && near(v7[0].srcEnd, 300),
   'v7 migrate: full-range 0→300 đặt tại offset 30 của lane');

/* ================= TEST 7 — instance full-length đặt trước khi biết duration ================= */
console.log('== TEST 7 — srcEnd=0 (chưa decode) → refreshClipBounds dựng full ==');
const early = [makeAudioClip(SONG_ID, LANE_ID, 5, 0, 0)];            // thả khi duration chưa biết
const savedEarly = { version: 8, audioClips: serializeAudioClips(early) };
const loadEarly = migrateAudioClips(savedEarly, [{ id: SONG_ID, duration: 240 }], lanes);
// mirror refreshClipBounds trong app.js
loadEarly.forEach((c) => {
  const dur = 240;
  if (!(c.srcEnd > 0)) c.srcEnd = dur;
  else if (c.srcEnd > dur) c.srcEnd = dur;
  if (c.srcStart > c.srcEnd) c.srcStart = Math.max(0, c.srcEnd - 0.06);
});
ok(loadEarly.length === 1 && near(loadEarly[0].srcEnd, 240), 'Biết duration (từ file dự án) → srcEnd phủ cả bài');

console.log(fails === 0 ? '\n★ TẤT CẢ ACCEPTANCE TEST ĐẠT ✔' : '\n★ ' + fails + ' TEST THẤT BẠI ✗');
process.exit(fails === 0 ? 0 : 1);
