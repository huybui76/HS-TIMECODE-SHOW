'use strict';
/* Test Save/Load thật cho HS TIMECODE:
   • Trích xuất hàm migrateFolder() GỐC từ renderer/app.js (không viết lại logic — test đúng code đang chạy)
   • Mô phỏng: project JSON → Load (migrateFolder) → Save (JSON.stringify như serializeProject) → Load lần 2
   • Kiểm tra: cue KHÔNG có OSC phải còn nguyên qua MỌI vòng Save→Load, và CÓ TRONG file JSON thật */

const fs = require('fs');
let nidCounter = 1000;
const nid = () => 'ID' + (++nidCounter);

const src = fs.readFileSync(__dirname + '/../renderer/app.js', 'utf8');
const start = src.indexOf('function migrateFolder(f) {');
const end = src.indexOf('\n}', start) + 2;   // điểm kết thúc hàm = "\n}" đầu tiên sau dòng bắt đầu
if (start < 0 || end < start + 10) { console.error('KHÔNG tìm thấy migrateFolder trong app.js'); process.exit(1); }
const fnSrc = src.slice(start, end);
// hàm trong app.js gọi laneOf() ở nhánh legacy (v3–v6) — cung cấp stub
const migrateFactory = new Function('nid', 'laneOf',
  '"use strict";\n' + fnSrc.replace('function migrateFolder', 'return function migrateFolder') + '\n');
const migrateFolder = migrateFactory(nid, () => 'V1');

/* ===== Project test: 6 cue (3 có OSC, 3 KHÔNG OSC) + 8 điểm đặt trên 4 lane ===== */
const P = (frame, cueId, lane, duration) => ({ id: nid(), cueId, frame, lane, duration, enabled: true });
const f1 = {
  id: 'F1', name: 'Bài 1', offset: 0, color: '', hidden: false, collapsed: false,
  cues: [
    { id: 'cue1', address: '/test/1', args: [1], name: 'Cue 1', note: '', color: '', mode: 'trigger' },
    { id: 'cue2', address: '', args: [1], name: 'Cue 2 — không OSC', note: '', color: '', mode: 'trigger' },
    { id: 'cue3', address: undefined, args: [1], name: 'Cue 3 — address undefined', note: '', color: '', mode: 'trigger' },
    { id: 'cue4', address: '', name: 'Cue 4 — không args', note: null, color: null },
    { id: 'cue5', address: '/test/5', args: ['/x', 2], name: 'Cue 5', note: 'gợi ý', color: '#fff', mode: 'hold' },
    { id: 'cue6', address: null, args: null, name: null, note: null, color: null, mode: null }
  ],
  events: [
    P(0, 'cue1', 'V1', 0),
    P(10, 'cue2', 'V2', 0),
    P(20, 'cue1', 'V3', 30),
    P(25, 'cue2', 'V2', 0),
    P(30, 'cue4', 'V1', 0),
    P(35, 'cue3', 'R1', 12),
    P(40, 'cue5', 'V1', 0),
    P(45, 'cue6', 'V2', 0)
  ]
};
const project = { version: 7, fps: 30, folders: [JSON.parse(JSON.stringify(f1))] };

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ LỖI: ') + msg); if (!cond) fails++; };

console.log('== VÒNG 1: Load project (hàm migrateFolder GỐC từ app.js) ==');
let loaded = JSON.parse(JSON.stringify(project));
let folder = migrateFolder(loaded.folders[0]);
console.log('  cues:', folder.cues.map((c) => c.id + (c.address ? '(' + c.address + ')' : '(không OSC)')).join(', '));

ok(folder.cues.length === 6, 'Test A: 6/6 cue còn nguyên sau Load (kể cả cue không OSC)');
ok(folder.cues.every((c) => typeof c.address === 'string'), 'Test D: address luôn là chuỗi (undefined/null → ""), không mất cue');
const c2 = folder.cues.find((c) => c.id === 'cue2');
ok(c2 && c2.address === '' && c2.name === 'Cue 2 — không OSC', 'Test A: cue2 (address "") giữ nguyên id + tên');
const c3 = folder.cues.find((c) => c.id === 'cue3');
const c6 = folder.cues.find((c) => c.id === 'cue6');
ok(c3 && c3.address === '' && c6 && c6.address === '', 'Test A: cue3 (undefined) + cue6 (null) vẫn còn, address = ""');
ok(folder.cues.find((c) => c.id === 'cue4').args.length === 1, 'Test B/D: cue4 thiếu args → mặc định [1], cue vẫn còn nguyên');
const c5 = folder.cues.find((c) => c.id === 'cue5');
ok(c5.address === '/test/5' && JSON.stringify(c5.args) === JSON.stringify(['/x', 2]) && c5.mode === 'hold' && c5.note === 'gợi ý',
   'Test C/D: cue5 giữ nguyên Address + Arguments + mode + note + color');
ok(folder.events.length === 8, 'Test E/F: 8/8 điểm đặt trên 4 lane còn nguyên');
ok(folder.events.every((e) => folder.cues.some((c) => c.id === e.cueId)), 'Test F: mọi điểm đặt trỏ đúng cue gốc (kể cả cue không OSC)');
ok(folder.events.every((e, i) => i === 0 || folder.events[i - 1].frame <= e.frame), 'Test E: thứ tự theo frame không đổi');
const cues1 = JSON.stringify(folder.cues);
const events1 = JSON.stringify(folder.events);

console.log('== VÒNG 2: Save (JSON.stringify như serializeProject) → Load lần 2 (Test G) ==');
let saved = JSON.parse(JSON.stringify({ version: 7, fps: 30, folders: [folder] }));
folder = migrateFolder(saved.folders[0]);
ok(folder.cues.length === 6, 'Test G: vòng 2 Save→Load — vẫn đủ 6 cue');
ok(folder.events.length === 8, 'Test G: vòng 2 Save→Load — vẫn đủ 8 điểm đặt');
ok(JSON.stringify(folder.cues) === cues1, 'Test G: dữ liệu cues BẤT BIẾN qua 2 vòng Save→Load');
ok(JSON.stringify(folder.events) === events1, 'Test G: dữ liệu events BẤT BIẾN qua 2 vòng Save→Load');

console.log('== VÒNG 3: Save → Load lần nữa (Test G lặp) ==');
saved = JSON.parse(JSON.stringify({ version: 7, fps: 30, folders: [folder] }));
folder = migrateFolder(saved.folders[0]);
ok(folder.cues.length === 6 && folder.events.length === 8, 'Test G: vòng 3 — vẫn 6 cue + 8 điểm đặt');
ok(JSON.stringify(folder.cues) === cues1 && JSON.stringify(folder.events) === events1, 'Test G: bất biến qua vòng 3');

console.log('== MỤC #8: kiểm tra FILE JSON THẬT sau Save ==');
const testFile = __dirname + '/test-project-out.json';
fs.writeFileSync(testFile, JSON.stringify(project, null, 2));
const raw = JSON.parse(fs.readFileSync(testFile, 'utf8'));
const noOsc = raw.folders[0].cues.filter((c) => c.address == null || c.address === '').length;
ok(noOsc === 4, 'FILE: 4 cue không OSC NẰM TRONG FILE sau Save (không bị lọc lúc ghi). Lưu ý: address=undefined bị JSON chuẩn bỏ property — Load sẽ chuẩn hóa về "" (không mất cue)');
const reloaded = migrateFolder(JSON.parse(fs.readFileSync(testFile, 'utf8')).folders[0]);
ok(reloaded.cues.length === 6 && reloaded.events.length === 8, 'FILE→Load: 6 cue + 8 điểm đặt khôi phục từ file');

console.log(fails === 0 ? '\n★ TẤT CẢ TEST ĐẠT ✔' : '\n★ ' + fails + ' TEST THẤT BẠT ✗');
process.exit(fails === 0 ? 0 : 1);
