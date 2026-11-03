'use strict';

/* ================= Trạng thái ================= */
const state = {
  fps: 30,
  playing: false,
  frame: 0,                // frame hiện tại (float) — thanh đò trên timeline chính
  speed: 1,
  loop: false,
  recArmed: false,
  recMode: 'overdub',      // 'overdub' | 'overwrite'
  recSource: 'midi',       // 'midi' = ghi từ đàn/pad (Web MIDI) | 'osc' = ghi từ OSC Resolume gửi về
  midiDeviceId: null,      // thiết bị MIDI vào đang chọn (Web MIDI id)
  midiTpl: '/midi/note/{n}',   // mẫu địa chỉ OSC cho pad: {n} = note 0-127, {c} = kênh 1-16
  midiPadMode: 'auto',     // 'auto' = địa chỉ theo mẫu | 'learn' = học từ OSC vào gần nhất
  midiBounce: true,        // bấm pad là bắn OSC ngay (kể cả khi không REC)
  folders: [],             // [{id, name, offset, events:[{id, frame, address, args, lane}]}]
  activeFolderId: null,    // thư mục nhận cue khi ghi
  lanes: [],               // [{id, name:'V1'|'A1'|'R1', kind:'V'|'A'|'R'}] — thứ tự trên timeline (V trên, A giữa, R dưới)
  audioClips: [],          // INSTANCE nhạc trên timeline (không giới hạn, cùng 1 file vẫn mỗi lần thả 1 instance riêng):
                           // [{id=instanceId, songId=sourceId, laneId=trackId, tlStart=timelineStart, srcStart=sourceStart,
                           //   srcEnd=sourceEnd (tlEnd = tlStart + srcEnd − srcStart), volume, fadeIn, fadeOut}] — toàn bộ GIÂY
  selClipId: null,         // instance clip nhạc đang chọn trên timeline
  recLaneId: null,         // lane R nhận cue khi ghi
  songs: [],               // [{id, name, path, duration, size, peaks, decoding}]
  songIndex: -1,           // bài đang làm mốc thời gian (nguồn đồng hồ)
  autoAdvance: true,
  playbackEndMode: 'infinite',   // 'infinite' = chạy vô hạn | 'contentEndPlus10' = dừng cuối nội dung + 10s
  sel: null,               // cue đang chọn (tham chiếu object)
  multiSel: new Set(),     // vùng chọn nhiều cue (⌘-click)
  selAudioLaneId: null,    // lane A đang chọn (kiem soát highlight) — chọn clip chi tiết = selClipId
  tlTool: 'select',        // 'select' = chọn (➤) | 'cut' = cắt nhanh (✂)
  clipboardAudio: null,    // {songId, srcStart, srcEnd} — SEGMENT clip nhạc đã sao chép (tham chiếu source, không copy file)
  clipboard: null,
  follow: true,
  listenPort: 7000,
  target: { host: '127.0.0.1', port: 7001 },
  filterPreset: 'connect',
  filterRegex: '',
  monFilter: '',
  cueSearch: '',
  songSearch: '',
  // view timeline
  viewStart: 0,
  pps: 0,
  ppsInit: false,
  showAllFolders: false,   // false: timeline chỉ hiện cue của thư mục đang chọn
  rowH: 60,                // Zoom DỌC mặc định 50% (thanh CAO 24–96 → 60)
  aRowH: 96                // lane A = 1.6×
};

const LANE_COLORS = ['#4f8cff', '#9a6bff', '#3ecfb2', '#e5c25a', '#ff8a5c', '#5cd6ff', '#ff6b9d', '#a8e34d'];
/* ===== Timeline CapCut-style ===== */
const TL_MIN_SEC = 180;   // chỉ dùng làm khung nhìn MỶC ĐỊNH khi timeline trống (0:00 → 03:00) — không phải giới hạn
const PPS_MIN = 0.5;      // pixelsPerSecond xa nhất (zoom out)
const PPS_MAX = 800;      // pixelsPerSecond sát nhất (zoom in)
const MAX_MON_ROWS = 300;
const AUTOSAVE_KEY = 'hs-timecode-autosave';
let idSeq = Date.now();
const nid = () => ++idSeq;

const $ = (id) => document.getElementById(id);
const audio = $('player');
const canvas = $('timeline');
const ctx = canvas.getContext('2d');
let audioCtx = null;
let audioSongId = null;   // id bài đang phát trên element <audio> (theo clip, không theo mốc)
let masterVol = 0.9;      // âm lượng tổng (thanh 🔊) — nhân với volume RIÊNG của từng instance clip khi phát
let rxLocal = 0;
let flat = [];             // [{t, ev, folder}] — cue đóng gói theo OFFSET, sắp tăng dần

function curFolder() { return state.folders.find((f) => f.id === state.activeFolderId) || null; }
function curSong() { return state.songs[state.songIndex] || null; }
function mode() { return (curSong() && curSong().path) ? 'audio' : 'free'; }

/* ================= Tiện ích ================= */
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function tcString(frame, fps) {
  const f = Math.max(0, Math.floor(frame));
  const fr = f % fps;
  const totalSec = Math.floor(f / fps);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}:${p(fr)}`;
}

function parseTC(str, fps) {
  str = String(str).trim();
  if (str.includes(':')) {
    const parts = str.split(':').map((x) => parseInt(x, 10) || 0);
    while (parts.length < 4) parts.unshift(0);
    const [h, m, s, f] = parts;
    return (((h * 60 + m) * 60 + s) * fps) + f;
  }
  const sec = parseFloat(str);
  return isNaN(sec) ? null : Math.round(sec * fps);
}

function fmtDur(sec) {
  if (!isFinite(sec) || sec <= 0) return '?';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtSize(b) {
  if (!b) return '';
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
  return Math.round(b / 1e3) + ' KB';
}

function laneOf(address) {
  let m = address.match(/\/composition\/layers\/(\d+)/i);
  if (m) return 'V' + m[1];
  return 'OSC';
}

function laneColor(lane) {
  const m = String(lane).match(/^[VA](\d+)$/);
  if (m) return LANE_COLORS[(Number(m[1]) - 1) % LANE_COLORS.length];
  return '#888';
}

/* ================= Quản lý lane (V/A/R) ================= */
function laneById(id) { return state.lanes.find((l) => l.id === id) || null; }
function laneByName(name) { return state.lanes.find((l) => l.name === name) || null; }
function laneLockedByName(name) { const l = laneByName(name); return !!(l && l.locked); }
function toggleLaneLock(id) {
  const l = laneById(id);
  if (!l) return;
  l.locked = !l.locked;
  if (l.locked) flashStatus(`Lane ${l.name} đã KHÓA — cue không dời/đổi độ dài được.`);
  else flashStatus(`Lane ${l.name} đã mở khóa.`);
  scheduleAutosave();
}

function nextLaneName(kind) {
  let n = 1;
  while (state.lanes.some((l) => l.name === kind + n)) n++;
  return kind + n;
}

/* === Quy tắc thứ tự layer trên timeline: V luôn TRÊN CÙNG · A luôn ở GIỮA · R luôn DƯỚI CÙNG ===
   Trong từng nhóm giữ nguyên thứ tự cũ; lane V MỚI luôn chèn lên ĐẦU nhóm V (phía trên),
   lane A mới xuống đáy nhóm A (giữa), lane R mới xuống đáy nhóm R (dưới cùng). */
function sortLanesByKind() {
  const groups = { V: [], A: [], R: [] };
  state.lanes.forEach((l) => { (groups[l.kind] || groups.V).push(l); });
  state.lanes = [...groups.V, ...groups.A, ...groups.R];
}

function addLane(kind, silent) {
  const lane = { id: nid(), name: nextLaneName(kind), kind, songId: null, songOffset: 0, songEnd: 0, locked: false };
  const fi = state.lanes.findIndex((l) => l.kind === kind);
  if (kind === 'V') {
    // + V: chèn TRÊN cùng nhóm V (trên mọi lane V cũ, dưới không có gì)
    state.lanes.splice(fi >= 0 ? fi : 0, 0, lane);
  } else {
    // + A: vào nhóm A (giữa) · + R: vào nhóm R (dưới cùng) — sắp lại nhóm ngay dưới
    state.lanes.push(lane);
  }
  if (kind === 'R' && !state.recLaneId) state.recLaneId = lane.id;
  sortLanesByKind();
  if (!silent) { renderLanes(); renderTimelineHeader(); scheduleAutosave(); }
  return lane;
}

function removeLane(id) {
  const i = state.lanes.findIndex((l) => l.id === id);
  if (i < 0 || state.lanes.length <= 1) return;
  const lane = state.lanes[i];
  const cueCount = flat.filter((x) => x.ev.lane === lane.name).length;
  if (cueCount && !confirm(`Lane ${lane.name} có ${cueCount} cue. Xóa lane? (các cue trong lane sẽ bị XÓA luôn)`)) return;
  state.lanes.splice(i, 1);
  // xóa lane = xóa luôn các cue ĐẶT trên lane đó (không dời sang lane khác)
  state.folders.forEach((f) => {
    f.events = f.events.filter((ev) => {
      if (ev.lane !== lane.name) return true;
      state.multiSel.delete(ev);
      if (state.sel === ev) state.sel = null;
      return false;
    });
  });
  if (state.recLaneId === id) {
    const r = state.lanes.find((l) => l.kind === 'R');
    state.recLaneId = r ? r.id : null;
  }
  sortLanesByKind();
  rebuildFlat();
  renderLanes();
  fillRecLaneSel();
  scheduleAutosave();
}

function recLane() {
  return laneById(state.recLaneId) || state.lanes.find((l) => l.kind === 'R') || state.lanes[0] || null;
}

function ensureLanesForProject() {
  // bảo đảm mọi cue.lane của BÀI ĐANG MỞ đều có lane trên timeline (KHÔNG đọc cue bài khác)
  const f = curFolder();
  const names = new Set((f ? f.events : []).map((x) => x.lane));
  names.forEach((name) => {
    if (!laneByName(name)) {
      const kind = /^[VA]/.test(name) ? name[0] : 'V';
      state.lanes.push({ id: nid(), name, kind, songId: null, songOffset: 0, songEnd: 0, locked: false });
    }
  });
  if (!state.lanes.length) {
    addLane('V', true);
    addLane('V', true);
    addLane('V', true);
    addLane('A', true);
    addLane('R', true);
  }
  if (!state.recLaneId) {
    const r = state.lanes.find((l) => l.kind === 'R');
    state.recLaneId = r ? r.id : state.lanes[0].id;
  }
  sortLanesByKind(); // nạp lại dự án cũ lộn xộn thứ tự: V trên · A giữa · R dưới
}

function renderLanes() {
  // chỉ cập nhật thống kê + select lane ghi (lane vẽ trên canvas)
  fillRecLaneSel();
  renderTimelineHeader();
  const total = state.folders.reduce((n, f) => n + f.events.length, 0);
  $('tlStats').textContent = `${total} cue · ${state.lanes.length} lane`;
}

function renderTimelineHeader() {
  const h = $('tlHeader');
  const title = h.querySelector('.tl-title');
  const f = curFolder();
  title.innerHTML = `TIMELINE — <span id="tlSongName">${escapeHtml(f ? f.name : 'Chính')}</span>`;
}

$('btnLaneV').addEventListener('click', () => addLane('V'));
$('btnLaneA').addEventListener('click', () => addLane('A'));
$('btnLaneR').addEventListener('click', () => addLane('R'));
$('toolSelect').addEventListener('click', () => setTlTool('select'));
$('toolCut').addEventListener('click', () => setTlTool('cut'));
setTlTool('select');   // mặc định: Chọn (➤)

function fillRecLaneSel() {
  const sel = $('recLaneSel');
  sel.innerHTML = '';
  const mr = $('mrLane');
  mr.innerHTML = '';
  state.lanes.forEach((l) => {
    if (l.kind !== 'R' && l.kind !== 'V') return;
    for (const [el] of [[sel], [mr]]) {
      const opt = document.createElement('option');
      opt.value = l.id;
      opt.textContent = l.name + (l.kind === 'R' ? ' (ghi OSC)' : '');
      el.appendChild(opt);
    }
  });
  sel.value = String(state.recLaneId || '');
  mr.value = String(state.recLaneId || '');
}

/* Bộ lọc ghi */
function activeFilter() {
  switch (state.filterPreset) {
    case 'connect':
      return /\/connect$/i;
    case 'connectcol':
      return /\/(layers\/\d+\/clips\/\d+|columns\/\d+)\/connect$/i;
    case 'all':
      return {
        test: (a) => !/(\/position\/|\/values$|\/speed$|\/opacity$|\/volume$|\/bypass$|masterfader|\/connected$)/i.test(a)
      };
    case 'custom': {
      try { return new RegExp(state.filterRegex); }
      catch (_) { return null; }
    }
  }
  return null;
}

function passFilter(address) {
  const re = activeFilter();
  return re ? re.test(address) : false;
}

function filterDescription() {
  switch (state.filterPreset) {
    case 'connect': return 'Chỉ ghi địa chỉ kết thúc bằng /connect (lệnh bật clip).';
    case 'connectcol': return 'Ghi clip connect và connect cột.';
    case 'all': return 'Ghi gần như tất cả, bỏ phản hồi tần suất cao (position, values, speed…).';
    case 'custom': return 'Regex tuỳ chỉnh của bạn (không cần dấu / bao ngoài).';
  }
}

/* ================= Đóng gói cue theo OFFSET ================= */
function rebuildFlat() {
  /* flat = LỊCH PHÁT CUE của DUY NHẤT bài đang mở — fireDue() bắn OSC từ đây.
     KHÔNG được gộp cue của bài khác: playback phải thuần project isolation. */
  flat = [];
  const f = curFolder();
  if (f) f.events.forEach((ev) => flat.push({ t: f.offset + ev.frame, ev, f }));
  flat.sort((a, b) => a.t - b.t);
}

function lowerBoundFlat(t) {
  let lo = 0, hi = flat.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (flat[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* Các cue hiển thị trên timeline: mặc định chỉ thư mục đang chọn */
let VF = [];
function refreshVF() {
  if (state.showAllFolders) VF = flat.filter((x) => !x.f.hidden);
  else {
    const f = curFolder();
    VF = f ? flat.filter((x) => x.f === f) : flat;
  }
  return VF;
}

/* ================= Thư mục cue ================= */
function addFolder(name) {
  // mỗi BÀI là một PROJECT ĐỘC LẬP — timeline, nhạc, cue đều TRỐNG, không liên quan bài trước
  const f = Object.assign(
    { id: nid(), name: name || `Bài ${state.folders.length + 1}`, offset: 0, events: [], cues: [], color: '', hidden: false, collapsed: false },
    freshProjectData()
  );
  state.folders.push(f);
  pause();                 // thêm bài = đứng im ngay, không tự chạy
  activateProject(f);      // nạp dữ liệu trống của bài mới (frame về 0, audio dừng)
  refreshAll();
  renderProps();
  updateSelBar();
  scheduleAutosave();
  return f;
}

function removeFolder(id) {
  const i = state.folders.findIndex((f) => f.id === id);
  if (i < 0) return;
  const f = state.folders[i];
  if (f.events.length && !confirm(`Xóa bài "${f.name}" (${f.events.length} cue)?`)) return;
  const wasActive = f.id === state.activeFolderId;
  state.folders.splice(i, 1);
  if (state.sel && !state.folders.some((x) => x.events.includes(state.sel))) state.sel = null;
  if (!state.folders.length) { addFolder(); return; }
  if (wasActive) {
    // bài đang mở bị xóa → mở bài kế bên (dữ liệu bài xóa biến mất cùng nó)
    activateProject(state.folders[Math.max(0, i - 1)]);
    refreshAll();
  }
}

/* ================= PROJECT MANAGER — mỗi BÀI là một project ĐỘC LẬP HOÀN TOÀN =================
   • Dữ liệu RIÊNG TỪNG bài, sống TRONG folder: songs, audioClips, lanes, recLaneId, pstate
     (playback settings: frame, zoom, fps, speed, loop, hết-phát, volume, bài đang chọn…).
   • `state` chỉ là bản LÀM VIỆC của bài đang mở — Playback Engine duy nhất chạy trên nó.
   • Chuyển bài: PAUSE → chép dữ liệu làm việc về bài cũ → nạp dữ liệu bài mới (đúng trạng thái đã lưu).
   • KHÔNG có biến global nào giữ dữ liệu riêng của 2 bài cùng lúc. */
function freshProjectData() {
  return { songs: [], audioClips: [], lanes: [], recLaneId: null, pstate: null };
}

/* chép bản làm việc hiện tại về bài đang mở (trước khi rời bài / trước khi Save) */
function captureActiveProject() {
  const f = curFolder();
  if (!f) return;
  f.songs = state.songs;
  f.audioClips = state.audioClips;
  f.lanes = state.lanes;
  f.recLaneId = state.recLaneId;
  f.pstate = {
    frame: Math.round(state.frame), viewStart: state.viewStart,
    pps: state.pps, ppsInit: state.ppsInit,
    fps: state.fps, speed: state.speed, loop: state.loop,
    playbackEndMode: state.playbackEndMode, autoAdvance: state.autoAdvance,
    masterVol, songIndex: state.songIndex,
    rowH: state.rowH, aRowH: state.aRowH
  };
}

/* nạp dữ liệu của 1 bài vào bản làm việc `state` + đồng bộ toàn bộ UI */
function activateProject(f) {
  if (!f.songs) Object.assign(f, freshProjectData());   // bài mới/l cũ chưa có dữ liệu riêng
  state.activeFolderId = f.id;
  state.songs = f.songs;
  state.audioClips = f.audioClips;
  state.lanes = f.lanes;
  state.recLaneId = f.recLaneId || null;
  const p = f.pstate || {};
  state.fps = p.fps || 30; $('fpsSel').value = String(state.fps);
  state.speed = p.speed || 1; $('speedSel').value = String(state.speed);
  state.loop = !!p.loop;                                  // updateTransport() sẽ chấm nút ⟲
  state.playbackEndMode = p.playbackEndMode === 'contentEndPlus10' ? 'contentEndPlus10' : 'infinite';
  const pe = $('playEndSel'); if (pe) pe.value = state.playbackEndMode;
  state.autoAdvance = p.autoAdvance !== false; $('autoAdvChk').checked = state.autoAdvance;
  masterVol = typeof p.masterVol === 'number' ? p.masterVol : 0.9;
  $('vol').value = String(masterVol);
  audio.volume = masterVol;
  state.rowH = p.rowH || 60; state.aRowH = p.aRowH || clamp(Math.round(state.rowH * 1.6), 30, 150);
  const rh = $('rowHRange'); if (rh) rh.value = state.rowH;
  state.viewStart = p.viewStart || 0;
  if (p.pps > 0) { state.pps = p.pps; state.ppsInit = true; }
  else { state.pps = 0; state.ppsInit = false; }         // chưa có zoom → tick() tự khớp nội dung
  state.songIndex = (typeof p.songIndex === 'number' && p.songIndex >= 0 && p.songIndex < state.songs.length) ? p.songIndex : -1;
  state.frame = Math.max(0, p.frame || 0);                // load đúng trạng thái timeline của bài này
  state.sel = null; state.multiSel = new Set();
  state.selClipId = null; state.selAudioLaneId = null;
  state.clipboardAudio = null;
  // audio element là của engine: về trạng thái trung lập, KHÔNG tự phát sau khi chuyển bài
  audio.pause();
  audioSongId = null;
  audio.playbackRate = state.speed;
  rebuildFlat();
  refreshVF();
  ensureLanesForProject();                                // bài trống → dựng bộ lane V/A/R mặc định
  state.playbackIdx = lowerBoundFlat(state.frame);
  state.audioClips.forEach((c) => {
    const m = /^au(\d+)$/.exec(String(c.id));
    if (m) idSeq = Math.max(idSeq, Number(m[1]));
  });
  state.songs.forEach((s) => refreshClipBounds(s));
  state.songs.forEach((s) => { if (s.path && !s.peaks) decodeWaveform(s); });   // nạp lại waveform bài này
  renderLanes(); renderSongs(); fillRecLaneSel(); updateAudioName();
  updateTc(); updateTransport(); infoDirty = true;
  if (state.recLaneId && !laneById(state.recLaneId)) state.recLaneId = (state.lanes.find((l) => l.kind === 'R') || {}).id || null;
  fillRecLaneSel();
}

/* chuyển bài: AN TOÀN — dừng phát trước, không trộn dữ liệu, không tự phát sau khi nạp */
function switchProject(folderId) {
  const target = state.folders.find((x) => x.id === folderId);
  if (!target || target.id === state.activeFolderId) return;
  pause();                    // không bao giờ để 2 project phát chồng âm thanh
  captureActiveProject();     // toàn bộ dữ liệu đang làm việc → về ĐÚNG bài cũ
  activateProject(target);    // nạp dữ liệu của bài mới
  refreshAll();
  renderProps();
  updateSelBar();
  flashStatus(`Đã chuyển sang "${target.name}" — phát đã dừng, dữ liệu từng bài độc lập.`);
  scheduleAutosave();
}

/* Cue GỐC (định nghĩa, cố định trong danh sách) + đối tượng ĐẶT trên timeline.
   Kéo cue gốc vào timeline nhiều lần chỉ tạo đối tượng đặt — cue gốc không đổi. */
function makeDef(address, args) {
  return { id: nid(), address, args: args || [1], name: '', note: '', color: '', mode: 'trigger' };
}

function makePlacement(frame, cueId) {
  return { id: nid(), cueId, frame, lane: 'V1', duration: 0, enabled: true };
}

function defOf(ev) {
  const f = state.folders.find((fo) => fo.events.includes(ev));
  return f ? (f.cues.find((c) => c.id === ev.cueId) || null) : null;
}

function findOrMakeDef(f, address, args) {
  let d = f.cues.find((c) => c.address === address);
  if (!d) {
    d = makeDef(address, args);
    d.name = address.split('/').filter(Boolean).slice(-1)[0] || 'Cue';
    f.cues.push(d);
  }
  return d;
}

const SWATCHES = [
  '#ff8a00', '#ffb340', '#ffe14d', '#c6e34d', '#8fe04d', '#4de07a',
  '#3ecfb2', '#4dc4e0', '#4f8cff', '#5f6bff', '#8a5cff', '#b44dff',
  '#e04dc4', '#ff4d9d', '#ff4d6b', '#ff6b4d', '#e0e0e0', '#9aa0aa',
  '#5a6070', '#46f0b0'
];

function cueColor(ev, folder) {
  const d = folder ? folder.cues.find((c) => c.id === ev.cueId) : defOf(ev);
  return (d && d.color) || laneColor(ev.lane);
}

function cueLabel(ev, folder) {
  const d = folder ? folder.cues.find((c) => c.id === ev.cueId) : defOf(ev);
  return d ? (d.name || d.address) : '?';
}

function insertCue(folder, cue) {
  // chèn giữ thứ tự theo frame (trong nội bộ thư mục)
  let i = folder.events.length;
  while (i > 0 && folder.events[i - 1].frame > cue.frame) i--;
  folder.events.splice(i, 0, cue);
}

function renderFolders() {
  const box = $('folderList');
  box.innerHTML = '';
  const q = state.cueSearch.toLowerCase();
  state.folders.forEach((f) => {
    const div = document.createElement('div');
    div.className = 'folder' + (f.id === state.activeFolderId ? ' active' : '');
    if (f.color) div.style.borderLeft = `3px solid ${f.color}`;

    const head = document.createElement('div');
    head.className = 'fhead';
    if (f.color) head.style.background = f.color + '26';
    const chev = document.createElement('button');
    chev.className = 'fdel chev';
    chev.textContent = f.collapsed ? '▸' : '▾';
    chev.title = f.collapsed ? 'Xổ danh sách cue ra' : 'Thu gọn thư mục';
    chev.addEventListener('click', (e) => {
      e.stopPropagation();
      f.collapsed = !f.collapsed;
      renderFolders();
      scheduleAutosave();
    });
    const name = document.createElement('input');
    name.className = 'fname';
    name.value = f.name;
    name.title = 'Đổi tên thư mục';
    name.addEventListener('change', () => { f.name = name.value.trim() || f.name; name.value = f.name; fillRecFolderSel(); scheduleAutosave(); });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
    const cnt = document.createElement('span');
    cnt.className = 'fcnt';
    cnt.textContent = f.events.length;
    const eye = document.createElement('button');
    eye.className = 'fdel';
    eye.textContent = f.hidden ? '🙈' : '👁';
    eye.title = f.hidden ? 'Cue thư mục này đang ẨN trên timeline — bấm để hiện' : 'Ẩn cue thư mục này trên timeline';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      f.hidden = !f.hidden;
      refreshVF();
      renderFolders();
      scheduleAutosave();
    });
    const colBtn = document.createElement('button');
    colBtn.className = 'fdel fcol';
    colBtn.textContent = '🎨';
    colBtn.title = 'Đổi màu khung thư mục';
    colBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openFolderPalette(f, colBtn);
    });
    const del = document.createElement('button');
    del.className = 'fdel';
    del.textContent = '🗑';
    del.title = 'Xóa bài';
    del.addEventListener('click', (e) => { e.stopPropagation(); removeFolder(f.id); });
    head.append(chev, name, cnt, eye, colBtn, del);
    head.addEventListener('click', (e) => {
      if (e.target === name || e.target === del || e.target === eye || e.target === colBtn || e.target === chev) return;
      // click bài = CHUYỂN PROJECT (Project Manager: pause → chép dữ liệu bài cũ → nạp bài mới)
      switchProject(f.id);
      // lần 1: thu gọn thư mục — lần 2: xổ danh sách cue ra
      f.collapsed = !f.collapsed;
      fillRecFolderSel();
      renderFolders();
      scheduleAutosave();
    });
    div.appendChild(head);

    const offRow = document.createElement('div');
    offRow.className = 'foffset';
    const lab = document.createElement('label');
    lab.textContent = 'OFFSET';
    const off = document.createElement('input');
    off.value = tcString(f.offset, state.fps);
    off.title = 'Dịch toàn bộ cue của thư mục này trên timeline';
    off.addEventListener('change', () => {
      const v = parseTC(off.value, state.fps);
      f.offset = v === null ? f.offset : v;
      off.value = tcString(f.offset, state.fps);
      refreshAll();
    });
    off.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') off.blur(); });
    offRow.append(lab, off);
    div.appendChild(offRow);

    const cuesBox = document.createElement('div');
    cuesBox.className = 'fcues';
    cuesBox.style.display = f.collapsed ? 'none' : '';
    // Danh sách hiện CUE GỐC (cố định) — kéo vào timeline tạo điểm đặt, cue gốc không đổi
    const shown = q ? f.cues.filter((d) => (d.name + ' ' + d.address).toLowerCase().includes(q)) : f.cues;
    if (!shown.length) {
      const em = document.createElement('div');
      em.className = 'folder-empty';
      em.textContent = q ? 'Không có cue khớp tìm kiếm' : 'Chưa có cue — bật REC và gõ MIDI, hoặc nhấn ＋ Cue';
      cuesBox.appendChild(em);
    }
    shown.forEach((def) => {
      const nPlace = f.events.filter((ev) => ev.cueId === def.id).length;
      const row = document.createElement('div');
      row.className = 'cue-row';
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        // kéo cue gốc vào timeline = ĐẶT điểm mới — cue gốc giữ nguyên trong danh sách
        e.dataTransfer.setData('text/hs-cue', `${f.id}:${def.id}`);
        e.dataTransfer.effectAllowed = 'copy';
      });
      if (def.color) row.style.boxShadow = `inset 3px 0 0 ${def.color}`;
      const info = document.createElement('div');
      info.className = 'cue-info';
      const nm = document.createElement('span');
      nm.className = 'cue-name';
      nm.textContent = def.name || '(chưa có tên)';
      const ad = document.createElement('span');
      ad.className = 'cue-addr';
      ad.textContent = def.address || 'chưa điền địa chỉ OSC';
      ad.title = (def.address || 'điền địa chỉ trong THUỘC TÍNH CUE') + ' — cue gốc, kéo vào timeline để đặt';
      info.append(nm, ad);
      const ln = document.createElement('span');
      ln.className = 'ln';
      ln.textContent = '×' + nPlace;
      ln.title = 'Số điểm đặt trên timeline';
      const cx = document.createElement('button');
      cx.className = 'cx';
      cx.textContent = '✕';
      cx.title = 'Xóa cue gốc + toàn bộ điểm đặt của nó';
      row.append(info, ln, cx);
      row.addEventListener('click', (e) => {
        if (e.target === cx) return;
        const first = f.events.find((ev) => ev.cueId === def.id);
        if (first) {
          state.sel = first;
          state.multiSel = new Set([first]);
          renderProps();
          updateSelBar();
          if (!state.playing) setFrame(f.offset + first.frame);
        } else {
          flashStatus('Cue này chưa có trên timeline — kéo thả vào lane V để đặt.');
        }
      });
      cx.addEventListener('click', () => {
        const n = f.events.filter((ev) => ev.cueId === def.id).length;
        if (n && !confirm(`Xóa cue "${def.name || def.address}" và ${n} điểm đặt trên timeline?`)) return;
        f.cues.splice(f.cues.indexOf(def), 1);
        f.events = f.events.filter((ev) => ev.cueId !== def.id);
        if (state.sel && !f.events.includes(state.sel)) state.sel = null;
        refreshAll();
        renderProps();
        updateSelBar();
      });
      cuesBox.appendChild(row);
    });
    div.appendChild(cuesBox);
    box.appendChild(div);
  });
}

function openFolderPalette(f, anchor) {
  document.querySelectorAll('.folder-palette').forEach((p) => p.remove());
  const pal = document.createElement('div');
  pal.className = 'folder-palette';
  const mk = (c) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (f.color === c ? ' sel' : '');
    b.style.background = c;
    b.title = f.color === c ? 'Bỏ màu' : c;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      f.color = f.color === c ? '' : c;
      pal.remove();
      refreshAll();
      scheduleAutosave();
    });
    return b;
  };
  SWATCHES.forEach((c) => pal.appendChild(mk(c)));
  const rb = document.createElement('button');
  rb.className = 'swatch none';
  rb.textContent = '✕';
  rb.title = 'Bỏ màu (dùng màu lane)';
  rb.addEventListener('click', (e) => {
    e.stopPropagation();
    f.color = '';
    pal.remove();
    refreshAll();
    scheduleAutosave();
  });
  pal.appendChild(rb);
  document.body.appendChild(pal);
  const r = anchor.getBoundingClientRect();
  pal.style.left = Math.min(r.left, window.innerWidth - 200) + 'px';
  pal.style.top = (r.bottom + 4) + 'px';
  setTimeout(() => {
    const close = (ev) => {
      if (!pal.contains(ev.target)) { pal.remove(); document.removeEventListener('mousedown', close); }
    };
    document.addEventListener('mousedown', close);
  }, 0);
}

/* ================= Kho nhạc ================= */
function addSongFile(path) {
  // cùng file = CÙNG SOURCE (Media/NHÁC không trùng entry — như CapCut); instance mới sẽ trỏ vào đây
  const existing = state.songs.find((s) => s.path === path);
  if (existing) return existing;
  const song = {
    id: nid(),
    name: path.split('/').pop().replace(/\.[^.]+$/, ''),
    path,
    duration: 0,
    size: 0,
    peaks: null,
    decoding: false
  };
  state.songs.push(song);
  window.hs.fileStat(path).then((st) => { song.size = st.size; renderSongs(); });
  decodeWaveform(song);
  renderSongs();
  scheduleAutosave();
  return song;
}

function removeSong(id) {
  const i = state.songs.findIndex((s) => s.id === id);
  if (i < 0) return;
  const wasActive = i === state.songIndex;
  const song = state.songs[i];
  state.songs.splice(i, 1);
  if (wasActive) state.songIndex = -1;
  else if (i < state.songIndex) state.songIndex--;
  // gỡ MỌI tham chiếu còn sót của bài vừa xóa (không để timeline giữ trọng số cũ)
  state.lanes.forEach((l) => {
    if (l.songId === song.id) { l.songId = null; l.songOffset = 0; l.songEnd = 0; }
  });
  // xóa mọi INSTANCE đang dùng source này (source hết → instance mồ côi phải đi theo;
  // các instance dùng source KHÁC hoàn toàn không đụng tới)
  state.audioClips = state.audioClips.filter((c) => c.songId !== song.id);
  if (state.selClipId && !audioClipById(state.selClipId)) state.selClipId = null;
  if (state.clipboardAudio && state.clipboardAudio.songId === song.id) state.clipboardAudio = null;
  // dừng hẳn âm thanh đang phát của bài vừa xóa — không để tiếng vẫn vang
  pause();
  if (audioSongId === song.id) audioSongId = null;
  if (wasActive) { audio.removeAttribute('src'); audio.load(); }
  renderSongs();
  updateAudioName();
  infoDirty = true;   // CÒN LẠI tính lại ngay, không giữ trọng số của bài vừa xóa
  scheduleAutosave();
}

function activateSong(i, autoplay = false, keepView = false) {
  const changed = i !== state.songIndex;   // thả THÊM instance cùng bài không nhảy playhead/zoom
  state.songIndex = i;
  const song = curSong();
  // CHỌN KHÔNG ĐỘNG PLAYBACK: chọn bài (trong NHÁC, dblclip…) không được đổi playhead.
  // reset view chỉ xảy ra với hành động RÕ RÀNG là điều hướng (drop mới, mở project).
  if (changed && !keepView && !state.playing) {
    state.frame = 0;
    state.ppsInit = false;
    state.viewStart = 0;
  }
  if (song && song.path) {
    // ENGINE đang phát → audio element là của playback engine (tick()), KHÔNG BAO GIỜ
    // được swap src/seek ở đây — chọn bài khác không được làm gián đoạn clip đang phát
    if (!state.playing) {
      audio.src = 'file://' + encodeURI(song.path);
      audio.playbackRate = state.speed;
      audioSongId = null;   // src đổi tay → buộc engine thiết lập lại cặp (src, id) khi phát, không dùng id cũ lệch file
    }
    if (song.duration) decodeWaveform(song);
  } else if (!state.playing) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  renderSongs();
  updateAudioName();
  updateTc();
  scheduleAutosave();
  if (autoplay) play();
}

function updateAudioName() {
  const s = curSong();
  $('audioName').textContent = s && s.path
    ? `🎵 ${s.name} · ${fmtDur(s.duration)}${s.size ? ' · ' + fmtSize(s.size) : ''}`
    : 'chưa chọn nhạc — kéo bài từ danh sách NHÁC vào timeline, hoặc thả file vào khung NHÁC';
}

function renderSongs() {
  const box = $('songList');
  box.innerHTML = '';
  const q = state.songSearch.toLowerCase();
  state.songs.forEach((song, i) => {
    if (q && !song.name.toLowerCase().includes(q) && !String(i + 1).includes(q)) return;
    const item = document.createElement('div');
    item.className = 'song-item' + (i === state.songIndex ? ' active' : '');
    item.draggable = true;

    const info = document.createElement('div');
    info.className = 'sinfo';
    const nm = document.createElement('div');
    nm.className = 'sname';
    nm.textContent = `${i + 1}. ${song.name}`;
    nm.title = song.name + ' — nhấp để lấy làm mốc thời gian, kéo vào timeline để đặt';
    const meta = document.createElement('div');
    meta.className = 'smeta';
    meta.textContent = `${fmtDur(song.duration)}${song.size ? ' · ' + fmtSize(song.size) : ''}`;
    info.append(nm, meta);

    const wave = document.createElement('canvas');
    wave.width = 84; wave.height = 24;
    drawMiniWave(wave, song);

    const del = document.createElement('button');
    del.className = 'sdel';
    del.textContent = '🗑';
    del.title = 'Xóa khỏi danh sách nhạc';
    del.addEventListener('click', (e) => { e.stopPropagation(); removeSong(song.id); });

    item.append(info, wave, del);
    item.addEventListener('click', (e) => {
      if (e.target === del) return;
      // CHỌN = chỉ lấy làm mốc thời gian — KHÔNG reset playhead, KHÔNG ngắt audio đang phát
      activateSong(i, false, true);
    });
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/hs-song', String(song.id));
      e.dataTransfer.effectAllowed = 'copy';
    });
    box.appendChild(item);
  });
  if (!box.children.length) {
    const em = document.createElement('div');
    em.className = 'folder-empty';
    em.style.padding = '10px';
    em.textContent = q ? 'Không có bài khớp tìm kiếm' : 'Chưa có nhạc trong danh sách';
    box.appendChild(em);
  }
}

function drawMiniWave(cv, song) {
  const c2 = cv.getContext('2d');
  c2.clearRect(0, 0, cv.width, cv.height);
  if (!song.peaks) {
    c2.strokeStyle = '#2c2c36';
    c2.beginPath();
    c2.moveTo(2, cv.height / 2); c2.lineTo(cv.width - 2, cv.height / 2);
    c2.stroke();
    return;
  }
  c2.strokeStyle = '#3ecfb2';
  c2.beginPath();
  const mid = cv.height / 2, half = cv.height / 2 - 2;
  const dur = song.duration || 0;
  for (let x = 0; x < cv.width; x++) {
    // mỗi cột = min/max của toàn bộ sample trong cột đó (giữ peak như waveform trên timeline)
    if (dur > 0) {
      const rr = peakRange(song, (x / cv.width) * dur, ((x + 1) / cv.width) * dur);
      if (!rr) continue;
      c2.moveTo(x + .5, mid - rr.mx * half);
      c2.lineTo(x + .5, mid - rr.mn * half);
    } else {
      const bi = Math.min(song.peaks.n - 1, Math.floor((x / cv.width) * song.peaks.n));
      c2.moveTo(x + .5, mid - song.peaks.maxs[bi] * half);
      c2.lineTo(x + .5, mid - song.peaks.mins[bi] * half);
    }
  }
  c2.stroke();
}

/* ===== Waveform MULTI-RESOLUTION (LOD) — zoom chỉ đổi resolution hiển thị, KHÔNG mất dữ liệu sóng =====
   • buildPeakLODs: dựng kim tự tháp min/max từ sample gốc (LOD0 ~2.9ms/bucket → mỗi LOD gộp 8 LOD dưới)
   • peakRange: trả về min/max của TOÀN BỘ bucket/sample trong khoảng thời gian [secA, secB]
     — KHÔNG lấy giá trị đại diện duy nhất cho 1 pixel → peak cao/thấp luôn được giữ */
function buildPeakLODs(ch0, ch1, sampleRate, base = 128, factor = 8) {
  const at = ch1 ? (i) => (ch0[i] + ch1[i]) / 2 : (i) => ch0[i];
  const len = ch0.length;
  const lods = [];
  {
    const n = Math.max(1, Math.ceil(len / base));
    const mins = new Float32Array(n), maxs = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let mn = 1, mx = -1;
      const s = i * base, e = Math.min(len, s + base);
      for (let j = s; j < e; j++) { const v = at(j); if (v < mn) mn = v; if (v > mx) mx = v; }
      mins[i] = mn; maxs[i] = (mx === -1) ? 0 : mx;
    }
    lods.push({ n, mins, maxs, sps: sampleRate / base });
  }
  while (lods[lods.length - 1].n > 60) {
    const prev = lods[lods.length - 1];
    const np = Math.ceil(prev.n / factor);
    const mins = new Float32Array(np), maxs = new Float32Array(np);
    for (let i = 0; i < np; i++) {
      let mn = 1, mx = -1;
      const s = i * factor, e = Math.min(prev.n, s + factor);
      for (let j = s; j < e; j++) { if (prev.mins[j] < mn) mn = prev.mins[j]; if (prev.maxs[j] > mx) mx = prev.maxs[j]; }
      mins[i] = mn; maxs[i] = (mx === -1) ? 0 : mx;
    }
    lods.push({ n: np, mins, maxs, sps: prev.sps / factor });
  }
  return { base, factor, lods };
}

function peakRange(song, secA, secB) {
  if (!song || !song.peaks || !(secB > secA)) return null;
  const pk = song.peaks;
  const lods = (pk.lods && pk.lods.length)
    ? pk.lods
    : [{ n: pk.n, mins: pk.mins, maxs: pk.maxs, sps: pk.n / Math.max(0.001, song.duration || 0) }]; // shape cũ
  const span = secB - secA;
  // chọn LOD mịn nhất mà 1 pixel của ta không cần quá ~8 bucket (zoom-out sâu → dùng level thô, vẫn min/max)
  let lvl = lods[lods.length - 1];
  for (const L of lods) { if (span <= 8 / L.sps) { lvl = L; break; } }
  const i1 = Math.max(0, Math.floor(secA * lvl.sps));
  const i2 = Math.min(lvl.n - 1, Math.ceil(secB * lvl.sps));
  if (i2 < i1) return null;
  let mn = 1, mx = -1;
  for (let i = i1; i <= i2; i++) { if (lvl.mins[i] < mn) mn = lvl.mins[i]; if (lvl.maxs[i] > mx) mx = lvl.maxs[i]; }
  if (mx < mn) return null;
  return { mn, mx };
}

function decodeWaveform(song) {
  if (!song.path || song.peaks || song.decoding) return;
  song.decoding = true;
  window.hs.readFileBuf(song.path)
    .then((buf) => {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!audioCtx) audioCtx = new AC();
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      return audioCtx.decodeAudioData(ab);
    })
    .then((audioBuf) => {
      const ch0 = audioBuf.getChannelData(0);
      const ch1 = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : null;
      song.peaks = buildPeakLODs(ch0, ch1, audioBuf.sampleRate);
      if (!song.duration) song.duration = audioBuf.duration;
      song.decoding = false;
      refreshClipBounds(song);   // biết duration rồi → dựng srcEnd đúng cho instance đã thả trước đó
      renderSongs();
      updateAudioName();
      drawTimeline();
    })
    .catch(() => { song.decoding = false; });
}

/* Kéo thả file từ Finder vào khung NHÁC và vào timeline */
function setupDrop(zone, activate) {
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (zone === $('audioDrop')) zone.classList.add('drag');
  });
  zone.addEventListener('dragleave', () => { if (zone === $('audioDrop')) zone.classList.remove('drag'); });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    $('audioDrop').classList.remove('drag');
    const sid = e.dataTransfer.getData('text/hs-song');
    if (sid) {
      const i = state.songs.findIndex((s) => s.id === Number(sid));
      if (i >= 0) {
        activateSong(i, activate);
        if (zone.__onSongDrop) zone.__onSongDrop(Number(sid), e);
      }
      return;
    }
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    let first = true;
    const exts = /\.(mp3|wav|aiff|aif|m4a|aac|flac|ogg)$/i;
    files.filter((f) => exts.test(f.name)).forEach((f) => {
      const p = window.hs.filePath(f);
      if (!p) return;
      const song = addSongFile(p);   // trùng path → dùng lại source cũ, không thêm entry mới
      if (activate && first) {
        activateSong(state.songs.indexOf(song));
        if (zone.__onSongDrop) zone.__onSongDrop(song.id, e);
        first = false;
      }
    });
  });
}

/* ================= Đồng hồ ================= */
/* Bài & offset đang làm mốc thời gian: lấy từ instance dưới playhead (nếu có) */

/* Clip instance đang chứa playhead (lane A bất kỳ) — nguồn phát thật của engine */
function findClipAtFrame(fr) {
  const sec = fr / state.fps;
  let best = null, bestSong = null;
  for (const c of state.audioClips) {
    const lane = laneById(c.laneId);
    if (!lane || lane.locked) continue;
    const song = clipSong(c);
    if (!song || !song.duration) continue;
    const len = clipLen(c) || song.duration;
    if (sec >= c.tlStart && sec < c.tlStart + len - 0.01) {
      // chồng nhau: instance đặt SAU (tlStart lớn hơn) đè instance trước — như CapCut
      if (!best || c.tlStart > best.tlStart) { best = c; bestSong = song; }
    }
  }
  if (!best) return null;
  // srcEnd PHẢI có trong kết quả — tick() dựa vào clip.srcEnd để quyết định phát (thiếu nó = không bao giờ có tiếng)
  return { song: bestSong, clip: best, tlStart: best.tlStart, srcStart: best.srcStart, srcEnd: best.srcEnd, tlEnd: best.tlStart + (clipLen(best) || bestSong.duration) };
}

function contentEndSeconds() {
  // điểm cuối của NỘI DUNG thực (giây): clip nhạc xa nhất + cue xa nhất; trống = 0
  let endFrames = 0;
  state.audioClips.forEach((c) => {
    const end = (c.tlStart + (clipLen(c) || 0)) * state.fps;
    if (end > endFrames) endFrames = end;
  });
  const f = curFolder();
  if (state.showAllFolders || !f) {
    flat.forEach((x) => {
      const end = x.t + (x.ev.duration || 0);
      if (end > endFrames) endFrames = end;
    });
  } else {
    f.events.forEach((ev) => {
      const end = ev.frame + (ev.duration || 0);
      if (end > endFrames) endFrames = end;
    });
  }
  return endFrames / state.fps;
}

function totalSeconds() {
  /* timelineDuration — thời lượng hiển thị (giây), tách bạch với zoom (state.pps) và scroll (viewStart).
     Trống → 3 phút cho dễ nhìn lúc mới mở; có nội dung → đúng bằng nội dung (không padding, không khoá 3 phút) */
  const c = contentEndSeconds();
  return c > 0 ? c : TL_MIN_SEC;
}

function playbackEndFrames() {
  /* ⚙ 'contentEndPlus10': điểm dừng = cuối nội dung + 10 giây.
     CHỈ dừng khi nội dung thật vượt quá mốc 3 phút; nội dung ngắn/trống (≤ 3 phút)
     → KHÔNG tự dừng (chạy vô hạn) — 180 giây chỉ là khung nhìn mặc định, không phải điểm dừng. */
  const end = (contentEndSeconds() + 10) * state.fps;
  return end > TL_MIN_SEC * state.fps ? end : Infinity;
}

function totalFrames() { return Math.max(1, Math.round(totalSeconds() * state.fps)); }

function setFrame(f) {
  // playhead được phép vượt QUÁ điểm cuối timeline (chỉ khoá dưới 0) — không khíng ở 03:00
  state.frame = Math.max(0, f);
  // đang dừng: xem trước âm thanh bám theo clip dưới thanh đò
  if (!state.playing) {
    const clip = findClipAtFrame(state.frame);   // trước đây dùng biến chưa khai báo → ReferenceError khi ⏹/seek
    const local = clip ? clamp(clip.srcStart + (state.frame / state.fps - clip.tlStart), 0, Math.max(0, clip.srcEnd - 0.02)) : 0;
    if (clip && audioSongId === clip.song.id && audio.paused && !audio.ended) {
      if (Math.abs(audio.currentTime - local) > 0.05) audio.currentTime = local;
    }
  }
  state.playbackIdx = lowerBoundFlat(state.frame);
}

function play() {
  // 'contentEndPlus10' + nội dung vượt 3 phút: đứng quá điểm dừng → về 0 khi bấm Play;
  // 'infinite' HOẶC nội dung ≤ 3 phút: phát tiếp từ chỗ playhead đang đứng, không tự dừng
  const pe = playbackEndFrames();
  if ((state.playbackEndMode || 'infinite') === 'contentEndPlus10' && isFinite(pe) && state.frame >= pe) setFrame(0);
  state.playing = true;
  // nhạc do tick() bật khi playhead đi vào clip — timeline luôn chạy từ vị trí thanh đò
  if (state.recArmed && state.recMode === 'overwrite') {
    const f = curFolder();
    if (f) {
      const before = f.events.length;
      f.events = f.events.filter((ev) => (f.offset + ev.frame) < state.frame);
      if (f.events.length !== before) refreshAll();
    }
  }
  updateTransport();
}

function pause() {
  state.playing = false;
  audio.pause();
  updateTransport();
}

function stop() { pause(); setFrame(0); }
function togglePlay() { state.playing ? pause() : play(); }

/* ================= Phát cue ================= */
function fireDue() {
  while (state.playbackIdx < flat.length && flat[state.playbackIdx].t <= state.frame) {
    const x = flat[state.playbackIdx++];
    if (x.ev.enabled === false) continue;
    const d = x.f.cues.find((c) => c.id === x.ev.cueId);
    if (d && d.address) sendOsc(d.address, d.args);
  }
}

function nextCue() {
  // cue tiếp theo chỉ "mở" sau khi chạy HẾT chiều dài cue trước (t + duration)
  for (const x of refreshVF()) {
    if (x.ev.enabled === false) continue;
    const end = x.t + Math.max(0, x.ev.duration || 0);
    if (end > state.frame) return x;
  }
  return null;
}

function sendOsc(address, args) {
  window.hs.send(address, args, state.target.host, state.target.port)
    .then(() => monRow(address, args, true))
    .catch((e) => setStatus('Gửi OSC lỗi: ' + e.message));
}

/* ================= Ghi OSC ================= */
function refreshAll() {
  rebuildFlat();
  refreshVF();
  state.playbackIdx = lowerBoundFlat(state.frame);
  renderFolders();
  fillRecFolderSel();
  renderLanes();
  updateSelBar();
  infoDirty = true;
  noteChange();
  updateStatsBar();
  scheduleAutosave();
}

function fillRecFolderSel() {
  const sel = $('recFolderSel');
  sel.innerHTML = '';
  state.folders.forEach((f) => {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.name;
    sel.appendChild(opt);
  });
  sel.value = String(state.activeFolderId);
}

function onOscMessage(msg) {
  rxLocal++;
  monRow(msg.address, msg.args, false);
  recordOscSeen(msg.address, msg.args);
  midiPadLearn(msg.address, msg.args);   // nuôi PAD Học: nhớ OSC vào gần nhất
  if (TEST_OSC.on) toRecord(msg);
  const badge = $('mrRx');
  badge.textContent = 'RX ' + rxLocal;
  badge.classList.add('flash');
  setTimeout(() => badge.classList.remove('flash'), 120);
  $('mrLast').textContent = msg.address + '  ' + (msg.args || []).join(',');
  // GHI OSC: chỉ khi nguồn REC = 'osc' (nguồn 'midi' ghi từ đàn — tránh ghi trùng 2 nguồn)
  if (state.recArmed && state.playing && state.recSource === 'osc' && passFilter(msg.address)) {
    const f = curFolder();
    if (!f) { setStatus('Chưa có thư mục cue — nhấn ＋ Bài.'); return; }
    const rl = recLane();
    if (rl && rl.locked) { setStatus(`Lane ghi ${rl.name} đang khóa — mở khóa để ghi.`); return; }
    const def = findOrMakeDef(f, msg.address, msg.args);
    const cue = makePlacement(Math.floor(state.frame) - f.offset, def.id);
    cue.lane = rl ? rl.name : 'V1';
    state.selClipId = null;
    insertCue(f, cue);
    refreshAll();
    flashStatus(`Đã ghi cue @ ${tcString(state.frame, state.fps)} → ${f.name}/${cue.lane}  ${msg.address}`);
  }
}

/* Tạo cue từ một message OSC bất kỳ (nút + trên Monitor / OSC → Cue) */
function cueFromOsc(address, args) {
  let f = curFolder();
  if (!f) f = addFolder();
  const def = findOrMakeDef(f, address, args);
  const cue = makePlacement(Math.floor(state.frame) - f.offset, def.id);
  const rl = recLane();
  cue.lane = rl ? rl.name : 'V1';
  insertCue(f, cue);
  state.sel = cue;
  state.selClipId = null;
  refreshAll();
  renderProps();
  flashStatus(`Đã thêm cue từ ${address} @ ${tcString(state.frame, state.fps)}`);
}

/* ================= Timeline ================= */
const GUT = 64, TOP = 30;

/* Zoom: thanh trượt 0–100, 50% = khung nhìn mặc định (vừa đúng 3 phút) — CapCut-style
   • v ≤ 50: 0.5 … ppsFit (log)   • v > 50: ppsFit … 800 px/s
   Zoom KHÔNG đụng dữ liệu/duration — chỉ pixelsPerSecond */
function ppsFit() { return Math.max(PPS_MIN, (canvas.clientWidth - GUT - 12) / TL_MIN_SEC); }
function sliderToPps(v) {
  const fit = ppsFit();
  return v <= 50
    ? PPS_MIN * Math.pow(fit / PPS_MIN, v / 50)
    : fit * Math.pow(PPS_MAX / fit, (v - 50) / 50);
}
function ppsToSlider(p) {
  const fit = ppsFit();
  return p <= fit
    ? Math.round(Math.log(clamp(p, PPS_MIN, fit) / PPS_MIN) / Math.log(fit / PPS_MIN) * 50)
    : Math.round(50 + Math.log(clamp(p, fit, PPS_MAX) / fit) / Math.log(PPS_MAX / fit) * 50);
}

function frameToX(f) { return ((f / state.fps) - state.viewStart) * state.pps + GUT; }
function xToFrame(x) { return ((x - GUT) / state.pps + state.viewStart) * state.fps; }

/* ===== Zoom / Scroll — CapCut-style =====
   • pixelsPerSecond (state.pps) = tỷ lệ zoom — KHÔNG đụng dữ liệu, KHÔNG đụng playhead
   • viewStart (giây) = scrollLeft — chỉ đổi vị trí nhìn thấy
   • timelineDuration = totalSeconds() — trống = 3 phút, có nội dung = đúng chiều dài nội dung
   • visibleDuration = (width - GUT) / pps — khoảng đang thấy trên màn hình */
function visibleSec() {
  const W = canvas.clientWidth || 0;
  return (state.pps && W > GUT) ? (W - GUT) / state.pps : 0;
}
function clampView() {
  // scroll trong 0 … (cuối vùng cần thấy) − visibleDuration
  // vùng cần thấy = max(timelineDuration, playhead) — playhead vượt 03:00 thì vẫn cuộn theo được
  const vs = visibleSec();
  if (!vs) return;
  const lim = Math.max(totalSeconds(), state.frame / state.fps) - vs;
  state.viewStart = clamp(state.viewStart, 0, Math.max(0, lim));
}
function syncZoomSlider() {
  const pr = $('ppsRange');
  if (pr) pr.value = ppsToSlider(state.pps);
}
function anchorSecDefault() {
  // zoom neo vào vị trí đang focus: playhead nếu thấy nó, không thì giữa vùng nhìn
  const curSec = state.frame / state.fps;
  const vs = visibleSec();
  if (vs && curSec >= state.viewStart && curSec <= state.viewStart + vs) return curSec;
  return state.viewStart + vs / 2;
}
function applyZoom(targetPps, anchorSec) {
  const pps0 = state.pps || targetPps;
  if (pps0 <= 0) return;
  if (anchorSec === undefined) anchorSec = anchorSecDefault();
  const xAnchor = (anchorSec - state.viewStart) * pps0 + GUT;   // điểm neo giữ nguyên pixel
  state.pps = clamp(targetPps, PPS_MIN, PPS_MAX);
  state.viewStart = Math.max(0, anchorSec - (xAnchor - GUT) / state.pps);
  clampView();
  syncZoomSlider();
}
function zoomPps(k) { applyZoom((state.pps || ppsFit()) * k); }

function autoDur(t, lane) {
  for (const fx of VF) {
    if (fx.ev.lane === lane && fx.t > t) return Math.max(1, fx.t - t);
  }
  return Math.round(state.fps * 0.75);
}

/* Chỉ cho đổi độ dài khi rê vào 2 ĐẦU cue — ngưỡng co theo độ rộng khối,
   khối nhỏ (zoom xa) thì không có vùng mép để tránh bấm giữa mà nhảy thời gian */
function cueResizeMode(x, x1, x2) {
  const bw = x2 - x1;
  const edgeT = bw >= 40 ? 8 : (bw >= 16 ? 4 : 0);
  if (!edgeT) return null;
  if (Math.abs(x - x2) <= edgeT) return 'resize-r';
  if (Math.abs(x - x1) <= edgeT) return 'resize-l';
  return null;
}

function eventEndFrame(x) {
  return x.t + (x.ev.duration > 0 ? x.ev.duration : autoDur(x.t, x.ev.lane));
}

function timelineRows() {
  const rows = state.lanes.map((l) => ({
    lane: l.name, id: l.id, kind: l.kind, songId: l.songId,
    h: l.kind === 'A' ? state.aRowH : state.rowH, isAudio: l.kind === 'A'
  }));
  let y = TOP + 6;
  rows.forEach((r) => { r.y = y; y += r.h; });
  return rows;
}

function drawTimeline() {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (W === 0 || H === 0) return;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#101013';
  ctx.fillRect(0, 0, W, H);

  const dur = totalSeconds();
  if (!state.ppsInit && W > GUT + 50) {
    // Zoom NGANG mặc định 50% (= ppsFit: thấy đúng 3 phút trên viewport); chỉ scale hiển thị, không đụng dữ liệu
    state.pps = ppsFit();
    state.ppsInit = true;
    state.lastTotalSec = dur;
  }
  if (state.pps) clampView();
  if (!state.pps) return;

  const rows = timelineRows();

  if (state.playing && state.follow && !dragInfo && !blockDrag) {
    const curSec = state.frame / state.fps;
    const viewSec = (W - GUT) / state.pps;
    if (curSec < state.viewStart || curSec > state.viewStart + viewSec * 0.85) {
      state.viewStart = Math.max(0, curSec - viewSec * 0.25);
      clampView();
    }
  }

  // thước thời gian
  ctx.fillStyle = '#17171b';
  ctx.fillRect(GUT, 0, W - GUT, TOP);
  ctx.font = '10px Menlo, monospace';
  ctx.textBaseline = 'middle';
  const viewSec = (W - GUT) / state.pps;
  // vạch thước ĐỘNG (CapCut-style): chọn bước MAJOR từ bộ cố định sao cho khoảng cách ≥ ~64px
  const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];        // 1s … 10m
  const step = STEPS.find((s) => s * state.pps >= 64) || 1200;    // zoom out sâu quá → 20m
  const minorStep = step / 5;                                     // vạch nhỏ = major/5
  const showMinor = minorStep * state.pps >= 12;                  // vạch nhỏ chỉ hiện khi đủ rộng
  const tEnd = state.viewStart + viewSec;
  if (showMinor) {
    ctx.strokeStyle = '#232329';
    for (let k = Math.ceil(state.viewStart / minorStep); k * minorStep <= tEnd; k++) {
      const t = k * minorStep;
      const x = (t - state.viewStart) * state.pps + GUT;
      if (x < GUT) continue;
      ctx.beginPath(); ctx.moveTo(x + .5, TOP - 5); ctx.lineTo(x + .5, TOP); ctx.stroke();
    }
  }
  for (let k = Math.floor(state.viewStart / step); k * step <= tEnd; k++) {
    const t = k * step;
    const x = (t - state.viewStart) * state.pps + GUT;
    if (x < GUT) continue;
    ctx.strokeStyle = '#2b2b33';
    ctx.beginPath(); ctx.moveTo(x + .5, TOP - 6); ctx.lineTo(x + .5, TOP); ctx.stroke();
    ctx.strokeStyle = '#1c1c22';
    ctx.beginPath(); ctx.moveTo(x + .5, TOP); ctx.lineTo(x + .5, H); ctx.stroke();
    ctx.fillStyle = '#71717c';
    const mm = Math.floor(t / 60), ss = Math.floor(t % 60);
    ctx.fillText(`${mm}:${String(ss).padStart(2, '0')}`, x + 4, TOP / 2 - 1);
  }

  // lane (V/A/R theo thứ tự người dùng) + nút × (xóa) và 🔒 (khóa) trên gutter
  rows.forEach((r) => {
    const laneObj = laneByName(r.lane);
    const locked = !!(laneObj && laneObj.locked);
    ctx.fillStyle = r.isAudio ? '#0e1613' : (r.kind === 'R' ? '#171310' : '#141419');
    ctx.fillRect(GUT, r.y, W - GUT, r.h - 6);
    ctx.fillStyle = '#202027';
    ctx.fillRect(0, r.y, GUT - 6, r.h - 6);
    if (locked) {
      ctx.fillStyle = 'rgba(255,180,80,0.10)';
      ctx.fillRect(GUT, r.y, W - GUT, r.h - 6);
    }
    ctx.fillStyle = r.isAudio ? '#3ecfb2' : (r.kind === 'R' ? '#ffb36b' : '#9a9aa5');
    ctx.font = 'bold 13px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(r.lane, GUT - 14, r.y + (r.h - 6) / 2);
    ctx.textAlign = 'left';
    // nút × xóa lane — TO 21px, vùng bấm 0–28px
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.font = 'bold 21px -apple-system, sans-serif';
    ctx.fillText('×', 9, r.y + (r.h - 6) / 2 + 1);
    // nút khóa lane — TO 17px, đổi màu khi khóa, vùng bấm 28–50px
    ctx.font = '17px -apple-system, sans-serif';
    ctx.fillStyle = locked ? '#ffb36b' : 'rgba(255,255,255,0.32)';
    ctx.fillText(locked ? '🔒' : '🔓', 33, r.y + (r.h - 6) / 2 + 1);
  });

  // các lane A → vẽ TỪNG CLIP INSTANCE (dùng chung source, kéo ngang/móc mép riêng từng seg)
  rows.filter((r) => r.isAudio).forEach((r) => {
    const laneObj = laneByName(r.lane);
    clipsInLane(r.id).forEach((c) => {
      const song = clipSong(c);
      if (!song || !song.path) return;
      // độ dài segment từ SOURCE (srcEnd − srcStart); chưa decode xong → vẽ khung mờ chờ
      let len = clipLen(c);
      if (len <= 0) len = song.duration > 0 ? song.duration : (song.decoding ? 0 : 120);
      const cx1 = (c.tlStart - state.viewStart) * state.pps + GUT;
      if (len <= 0) {
        // chưa biết duration (đang decode) → vẽ KHUNG MỜ + dòng chữ, instance không được "vô hình"
        ctx.strokeStyle = '#2a5a4f';
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(cx1 + .5, r.y + 1.5, 90, r.h - 9);
        ctx.setLineDash([]);
        ctx.fillStyle = '#4a7a6d';
        ctx.font = '11px -apple-system, sans-serif';
        ctx.fillText('đang phân tích sóng…', cx1 + 8, r.y + (r.h - 6) / 2);
        return;
      }
      const cx2 = (c.tlStart + len - state.viewStart) * state.pps + GUT;
      const bx1 = Math.max(cx1, GUT), bx2 = Math.min(cx2, W);
      if (bx2 <= bx1) return;
      // nền clip — chọn CLIP (selClipId) nổi bật hơn chọn lane
      const selAudio = state.selClipId === c.id;
      const laneSel = state.selAudioLaneId && laneById(state.selAudioLaneId) === laneObj;
      ctx.fillStyle = selAudio ? 'rgba(62, 207, 178, 0.30)' : (laneSel ? 'rgba(62, 207, 178, 0.22)' : 'rgba(62, 207, 178, 0.10)');
      ctx.fillRect(bx1, r.y + 1, bx2 - bx1, r.h - 8);
      ctx.strokeStyle = selAudio ? '#bafff0' : (laneSel ? '#ffffff' : '#3ecfb2');
      ctx.lineWidth = selAudio ? 2.5 : (laneSel ? 2 : 1.5);
      ctx.strokeRect(bx1 + .5, r.y + 1.5, bx2 - bx1 - 1, r.h - 9);
      ctx.lineWidth = 1;
      // mép kéo 2 bên — KÉO MÉP = TRIM/khôi phục từ SOURCE (không stretch)
      ctx.fillStyle = selAudio ? '#7dffd8' : '#3ecfb2';
      ctx.fillRect(bx1, r.y + 1, 3, r.h - 8);
      ctx.fillRect(bx2 - 3, r.y + 1, 3, r.h - 8);
      const mid = r.y + (r.h - 6) / 2;
      const half = (r.h - 6) / 2 - 6;
      if (song.peaks && len > 0) {
        ctx.strokeStyle = '#3ecfb2';
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        for (let x = Math.ceil(bx1); x < bx2; x++) {
          // 1 pixel = [secA, secB] tính trong TỪNG SEGMENT — sóng lấy từ srcStart của chính segment
          // (đúng LOD theo mức zoom: zoom in mịn, zoom out đông trend giữ peak)
          const secA = c.srcStart + (x - 0.5 - GUT) / state.pps + state.viewStart - c.tlStart;
          const secB = c.srcStart + (x + 0.5 - GUT) / state.pps + state.viewStart - c.tlStart;
          if (secB <= c.srcStart || secA >= c.srcEnd) continue;
          const rr = peakRange(song, Math.max(c.srcStart, secA), Math.min(c.srcEnd, secB));
          if (!rr) continue;
          ctx.moveTo(x + .5, mid - rr.mx * half);
          ctx.lineTo(x + .5, mid - rr.mn * half);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (song.decoding || !(song.duration > 0)) {
        ctx.fillStyle = '#4a7a6d';
        ctx.font = '11px -apple-system, sans-serif';
        ctx.fillText('đang phân tích sóng nhạc…', bx1 + 10, mid);
      }
      // tên bài trên clip
      if (len > 0 && bx2 - bx1 > 60) {
        ctx.fillStyle = '#bff5e8';
        ctx.font = 'bold 11px -apple-system, sans-serif';
        ctx.fillText(song.name.slice(0, Math.floor((bx2 - bx1) / 7)), bx1 + 8, r.y + 13);
      }
    });
  });

  // cue (đã cộng OFFSET từng thư mục) — chỉ vùng nhìn hiện tại
  refreshVF();
  VF.forEach((x) => {
    const row = rows.find((r) => r.lane === x.ev.lane);
    if (!row) return;
    const x1 = frameToX(x.t);
    const x2 = frameToX(eventEndFrame(x));
    if (x2 < GUT || x1 > W) return;
    const bx = Math.max(x1, GUT), bw = Math.max(3, x2 - x1 - 2);
    const isSelected = selSet().has(x.ev);
    const isHidden = x.ev.enabled === false;
    ctx.fillStyle = cueColor(x.ev, x.f);
    ctx.globalAlpha = isSelected ? 0.9 : (isHidden ? 0.30 : 0.85);
    ctx.fillRect(bx, row.y + 2, bw, row.h - 10);
    ctx.globalAlpha = 1;
    if (isHidden) {
      // sọc chéo trắng + mờ — cue ẩn không gửi OSC
      ctx.save();
      ctx.beginPath(); ctx.rect(bx, row.y + 2, bw, row.h - 10); ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 2;
      for (let sx = bx - row.h; sx < bx + bw; sx += 8) {
        ctx.beginPath();
        ctx.moveTo(sx, row.y + row.h - 8);
        ctx.lineTo(sx + row.h - 4, row.y + 2);
        ctx.stroke();
      }
      ctx.restore();
    }
    // gợn mép hai bên — gợi ý có thể kéo đổi độ dài
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    if (bw > 10) { ctx.fillRect(bx, row.y + 2, 3, row.h - 10); ctx.fillRect(bx + bw - 3, row.y + 2, 3, row.h - 10); }
    if (isSelected) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx + .5, row.y + 2.5, bw - 1, row.h - 11);
      ctx.lineWidth = 1;
    }
    if (bw > 30) {
      ctx.fillStyle = '#0b0b0e';
      ctx.font = 'bold 12px Menlo, monospace';
      const label = cueLabel(x.ev, x.f);
      ctx.fillText(label.slice(0, Math.floor(bw / 7.5)), bx + 7, row.y + (row.h - 6) / 2);
    }
  });

  // thanh đò
  const px = frameToX(state.frame);
  if (px >= GUT - 2 && px <= W + 2) {
    ctx.strokeStyle = '#ff8a00';
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(px, 4); ctx.lineTo(px, H - 4); ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = '#ff8a00';
    ctx.beginPath();
    ctx.moveTo(px - 5, 2); ctx.lineTo(px + 5, 2); ctx.lineTo(px, 10);
    ctx.closePath(); ctx.fill();
  }

  // SCROLLBAR ngang (CapCut-style) — chỉ hiện khi timeline dài hơn visibleDuration
  const viewSecNow = (W - GUT) / state.pps;
  if (viewSecNow > 0 && viewSecNow < dur) {
    const trackY = H - 14, trackH = 10, trackW = W - GUT;
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(GUT, trackY, trackW, trackH);
    const tx = (state.viewStart / dur) * trackW;
    const thumbW = Math.max(48, (viewSecNow / dur) * trackW);
    const tw2 = Math.min(trackW - tx, thumbW);
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    ctx.fillRect(GUT + tx, trackY, Math.max(48, tw2), trackH);
    sbThumb = { x1: GUT + tx, x2: GUT + tx + Math.max(48, tw2), trackW, y: trackY, h: trackH };
  } else {
    sbThumb = null;
  }
}

/* Tương tác timeline */
let dragInfo = null;      // pan / click / scrub
let blockDrag = null;     // kéo khối cue
let clipDrag = null;      // kéo/sửa clip nhạc instance: {mode:'move'|'resize-l'|'resize-r', clip, startX, tl0, ss0, se0, moved}
let sbThumb = null;       // scrollbar ngang vẽ trên canvas (CapCut-style)
let sbDrag = null;        // đang kéo scrollbar: {grabOff, trackW}
let mousePos = { x: -1, y: -1 };

/* ===== AUDIO INSTANCE — mô hình CapCut =====
   • Source audio (state.songs) tồn tại MỘT lần trong danh sách NHÁC.
   • Timeline có KHÔNG GIỚI HẠN instance trỏ vào cùng source (mỗi lần thả = instance mới với id riêng).
   • Cắt ✂ tại vị trí T: instance chia 2 segment, CÙNG trỏ vào source (songId) — không copy file, không mất data:
       seg1: srcStart … cutSrc        seg2: cutSrc … srcEnd  (cutSrc = srcStart + (T − tlStart))
   • Kéo mép ở chế độ Chọn: khôi phục đúng phần bị cắt/trim TỪ SOURCE (giới hạn 0 … duration);
       KHÔNG stretch, KHÔNG đổi pitch — chỉ đổi dài hơn giữa nguồn.
   • ml: instance fields (giây) — tlStart (trên timeline), srcStart/srcEnd (trong bài gốc). */
function makeAudioClip(songId, laneId, tlStart, srcStart, srcEnd) {
  return {
    id: 'au' + nid(),          // instanceId — MỖI instance một id riêng, không bao giờ trùng dù cùng sourceId
    songId, laneId,
    tlStart: Math.max(0, tlStart), srcStart: Math.max(0, srcStart), srcEnd: Math.max(0, srcEnd),
    volume: 1, fadeIn: 0, fadeOut: 0,   // thuộc tính RIÊNG từng instance (độc lập giữa các instance cùng source)
    mute: false                          // im tiếng RIÊNG từng instance — không đụng instance khác
  };
}
function clipLen(clip) { return Math.max(0, (clip.srcEnd || 0) - (clip.srcStart || 0)); }          // độ dài segment (giây)
function clipSong(clip) { return state.songs.find((s) => s.id === clip.songId) || null; }
function clipsInLane(laneId) {
  return state.audioClips.filter((c) => c.laneId === laneId).sort((a, b) => a.tlStart - b.tlStart);
}
function audioClipById(id) { return state.audioClips.find((c) => c.id === id) || null; }
function selAudioClip() { return state.selClipId ? audioClipById(state.selClipId) : null; }
function removeAudioClip(id) {
  const i = state.audioClips.findIndex((c) => c.id === id);
  if (i < 0) return false;
  state.audioClips.splice(i, 1);
  if (state.selClipId === id) state.selClipId = null;
  return true;
}

/* Đặt INSTANCE mới lên lane A (CapCut): mỗi lần thả = 1 instance riêng dù cùng source.
   srcEnd = 0 khi duration chưa decode xong — refreshClipBounds sẽ dựng đúng khi biết duration. */
function addAudioInstance(song, laneId, atSec) {
  const dur = song && song.duration > 0 ? song.duration : 0;
  const clip = makeAudioClip(song.id, laneId, atSec, 0, dur);
  state.audioClips.push(clip);
  refreshClipBounds(song);
  refreshAll();
  return clip;
}

/* Chuẩn hóa range MỌI instance của bài này khi biết/đổi duration: instance full-length (srcEnd=0)
   → phủ cả bài; srcEnd vượt duration → kẹp về đúng giới hạn source (không kéo quá nguồn). */
function refreshClipBounds(song) {
  if (!song || !(song.duration > 0)) return;
  state.audioClips.forEach((c) => {
    if (c.songId !== song.id) return;
    if (!(c.srcEnd > 0)) c.srcEnd = song.duration;
    else if (c.srcEnd > song.duration) c.srcEnd = song.duration;
    if (c.srcStart > c.srcEnd) c.srcStart = Math.max(0, c.srcEnd - 0.06);
  });
  infoDirty = true;
}

/* Fade in/out tuyến tính theo vị trí trong SOURCE (giây) — áp RIÊNG từng instance khi phát */
function fadeFactor(c, localSec) {
  let f = 1;
  if (c.fadeIn > 0) f = Math.min(f, clamp((localSec - c.srcStart) / c.fadeIn, 0, 1));
  if (c.fadeOut > 0) f = Math.min(f, clamp((c.srcEnd - localSec) / c.fadeOut, 0, 1));
  return f;
}

function setTlTool(mode) {
  state.tlTool = mode === 'cut' ? 'cut' : 'select';
  const s = $('toolSelect'), c = $('toolCut');
  if (s) s.classList.toggle('on', state.tlTool === 'select');
  if (c) c.classList.toggle('on', state.tlTool === 'cut');
  canvas.style.cursor = state.tlTool === 'cut' ? 'crosshair' : '';
}

function audioClipHit(x, y) {
  const row = hitLaneRow(y);
  if (!row || !row.isAudio) return null;
  const laneObj = laneByName(row.lane);
  for (const c of clipsInLane(row.id)) {
    const song = clipSong(c);
    if (!song) continue;
    const len = clipLen(c) || (song.duration > 0 ? song.duration : (song.decoding ? 0 : 120));
    if (len <= 0) continue;
    const cx1 = (c.tlStart - state.viewStart) * state.pps + GUT;
    const cx2 = (c.tlStart + len - state.viewStart) * state.pps + GUT;
    if (x >= cx1 && x <= cx2) {
      return { row, song, laneObj, cx1, cx2, clip: c,
        atEdge: (Math.abs(x - cx1) <= 7 || Math.abs(x - cx2) <= 7) ? (Math.abs(x - cx1) <= 7 ? 'l' : 'r') : null };
    }
  }
  return null;
}

function hitLaneRow(y) {
  const rows = timelineRows();
  for (const row of rows) {
    if (y >= row.y && y < row.y + row.h) return row;
  }
  return null;
}

function hitCueBlock(x, y) {
  const row = hitLaneRow(y);
  if (!row) return null;
  const t = xToFrame(x);
  for (const fx of refreshVF()) {
    if (fx.ev.lane !== row.lane) continue;
    if (t >= fx.t && t < eventEndFrame(fx)) return { fx, row };
  }
  return null;
}

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 2) return;   // chuột phải = menu ngữ cảnh, không bắt đầu kéo gì
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  mousePos = { x, y };
  // SCROLLBAR ngang dưới cùng — kéo thumb để scroll, bấm track để nhảy tới
  if (sbThumb && y >= sbThumb.y && y <= sbThumb.y + sbThumb.h && x >= GUT) {
    const thumbW = sbThumb.x2 - sbThumb.x1;
    const inThumb = x >= sbThumb.x1 && x <= sbThumb.x2;
    sbDrag = { grabOff: inThumb ? (x - sbThumb.x1) : thumbW / 2, trackW: sbThumb.trackW };
    if (!inThumb) {
      state.viewStart = (((x - thumbW / 2) - GUT) / sbThumb.trackW) * totalSeconds();
      clampView();
    }
    canvas.style.cursor = 'ew-resize';
    return;
  }
  // gutter bên trái: nút × (xóa lane) và 🔒 (khóa lane) — vùng bấm TO, dễ bấm
  if (x >= 0 && x <= 50) {
    const row = hitLaneRow(y);
    if (row) {
      if (x <= 28) { removeLane(row.id); return; }
      toggleLaneLock(row.id); return;
    }
  }
  // bấm vào thanh đò (playhead) → kéo ngang
  const px = frameToX(state.frame);
  if (Math.abs(x - px) <= 8) {
    dragInfo = { mode: 'scrub', x, y, moved: false };
    canvas.style.cursor = 'ew-resize';
    return;
  }
  // ===== CHẾ ĐỘ CẮT (công cụ ✂): click vào clip = CHIA 2 SEGMENT tại đó (CapCut) =====
  // Hai phần cùng trỏ source gốc (songId/cueId) — KHÔNG copy file, KHÔNG mất data;
  // chế độ Chọn kéo mép 2 phía sẽ lấy lại phần bị cắt từ source. Không dời playhead.
  if (state.tlTool === 'cut') {
    const cutF = Math.max(0, Math.round(xToFrame(x)));
    const cutTl = cutF / state.fps;
    const aHit = audioClipHit(x, y);
    if (aHit) {
      if (aHit.laneObj && aHit.laneObj.locked) { flashStatus(`Lane ${aHit.row.lane} đang khóa — không cắt được.`); return; }
      const c = aHit.clip;
      const len = clipLen(c) || (aHit.song.duration > 0 ? aHit.song.duration : 120);
      const tEnd = c.tlStart + len;
      if (cutTl <= c.tlStart + 0.05 || cutTl >= tEnd - 0.05) {
        flashStatus('Vết cắt quá sát mép clip — không có gì để chia (kéo mép nếu muốn trim).');
      } else {
        const cutSrc = c.srcStart + (cutTl - c.tlStart);   // điểm cắt kể trong bài gốc
        const part2 = makeAudioClip(c.songId, c.laneId, cutTl, cutSrc, c.srcEnd);
        c.srcEnd = cutSrc;
        state.audioClips.push(part2);
        state.selClipId = c.id;
        refreshAll(); scheduleAutosave();
        flashStatus(`Đã chia clip "${aHit.song.name}" tại ${tcString(cutF, state.fps)} — 2 segment CÙNG source; kéo mép để lấy lại phần cắt.`);
      }
      return;
    }
    const hit = hitCueBlock(x, y);
    if (hit && x >= GUT) {
      const ev = hit.fx.ev;
      const f = state.folders.find((fo) => fo.events.includes(ev));
      if (!f) { flashStatus('Cue chưa thuộc thư mục nào.'); return; }
      const endF = eventEndFrame(hit.fx);
      if (laneLockedByName(hit.row.lane)) { flashStatus(`Lane ${hit.row.lane} đang khóa — không cắt được.`); return; }
      if (cutF <= hit.fx.t + 1 || cutF >= endF - 1) {
        flashStatus('Vết cắt quá sát mép cue — không có gì để chia.');
      } else {
        // chia cue thành 2 placement ĐỘC LẬP nhưng cùng cueId (source OSC của cue gốc)
        const ev1 = ev, ev2 = makePlacement(cutF - f.offset, ev.cueId);
        ev2.lane = ev.lane;
        ev2.duration = endF - cutF;
        ev1.duration = cutF - hit.fx.t;
        ev2.enabled = ev.enabled !== false;
        ev2.smpteInput = !!ev.smpteInput;
        insertCue(f, ev2);
        refreshAll(); scheduleAutosave();
        flashStatus(`Đã chia cue tại ${tcString(cutF, state.fps)} — 2 đoạn dùng cùng cue gốc (kéo mép để khôi phục phần đã cắt).`);
      }
      return;
    }
    // trúng nền trống → không cắt gì, vẫn cho kéo pan nền như thường
  }
  // bấm vào khối nhạc trên lane A → kéo dời / KÉO MÉP = TRIM từ source (CapCut-style)
  const clip = audioClipHit(x, y);
  if (clip) {
    if (clip.laneObj && clip.laneObj.locked) { flashStatus(`Lane ${clip.row.lane} đang khóa.`); return; }
    const c = clip.clip;
    const mode = clip.atEdge === 'l' ? 'resize-l' : (clip.atEdge === 'r' ? 'resize-r' : 'move');
    clipDrag = { mode, clip: c, lane: clip.laneObj, startX: x, tl0: c.tlStart, ss0: c.srcStart, se0: c.srcEnd, moved: false };
    canvas.style.cursor = mode === 'move' ? 'grabbing' : 'ew-resize';
    return;
  }
  // bắt đầu kéo khối cue: CHỈ mép 2 đầu = đổi độ dài, thân = dời (thời gian không đổi)
  const hit = hitCueBlock(x, y);
  if (hit && x >= GUT) {
    const f = state.folders.find((fo) => fo.events.includes(hit.fx.ev));
    const locked = laneLockedByName(hit.row.lane);
    const x1 = frameToX(hit.fx.t);
    const x2 = frameToX(eventEndFrame(hit.fx));
    let mode = cueResizeMode(x, x1, x2) || 'move';
    if (locked) mode = 'move'; // lane khóa: chỉ click chọn, không dời/đổi độ dài
    blockDrag = {
      ev: hit.fx.ev, folder: f, mode, mouse: { x, y }, moved: false,
      copy: e.altKey,                  // Alt = đặt thêm 1 điểm mới (cùng cue gốc)
      locked,
      f0: hit.fx.t - f.offset,
      dur0: hit.fx.ev.duration || 0,
      grabF: xToFrame(x) - hit.fx.t,
      end0: eventEndFrame(hit.fx),
      lane0: hit.fx.ev.lane
    };
    canvas.style.cursor = (mode === 'move' && !locked) ? 'grabbing' : (locked ? 'default' : 'ew-resize');
    return;
  }
  dragInfo = { x, y, moved: false, viewStart0: state.viewStart };
});
canvas.addEventListener('mousemove', (e) => {
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  mousePos = { x, y };
  if (sbDrag) {
    // SCROLL ngang bằng scrollbar — chỉ đổi viewStart, không đổi dữ liệu
    state.viewStart = clamp(((x - sbDrag.grabOff) - GUT) / sbDrag.trackW * totalSeconds(),
      0, Math.max(0, totalSeconds() - visibleSec()));
    return;
  }
  if (clipDrag) {
    if (!clipDrag.moved && Math.abs(x - clipDrag.startX) > 3) clipDrag.moved = true;
    if (clipDrag.moved && clipDrag.clip) {
      const c = clipDrag.clip;
      const song = clipSong(c);
      const sDur = song && song.duration > 0 ? song.duration : Infinity;   // giới hạn source: 0 … duration
      const dx = (x - clipDrag.startX) / state.pps;                        // thay đổi GIÂY trên timeline
      if (clipDrag.mode === 'move') {
        // dời cả khối — KHÔNG đổi ánh xạ source (không đổi nội dung đang phát)
        c.tlStart = Math.max(0, clipDrag.tl0 + dx);
      } else if (clipDrag.mode === 'resize-l') {
        // kéo mép TRÁI: mở rộng = lấy lại phần trước srcStart từ source; không thể qua 0 (timeline & source)
        let d = dx;
        const minD = Math.max(-clipDrag.ss0, -clipDrag.tl0);   // srcStart ≥ 0 và tlStart ≥ 0
        if (d < minD) d = minD;
        if (clipDrag.se0 - (clipDrag.ss0 + d) < 0.06) d = clipDrag.se0 - clipDrag.ss0 - 0.06;  // còn ≥60ms
        c.srcStart = clipDrag.ss0 + d;
        c.tlStart = clipDrag.tl0 + d;
      } else { // resize-r: kéo mép PHẢI — mở rộng lấy phần sau srcEnd từ source; không vượt duration source
        let newSE = clipDrag.se0 + dx;
        if (newSE > sDur) newSE = sDur;                    // giới hạn đúng source, không tạo khoảng trắng
        if (newSE < c.srcStart + 0.06) newSE = c.srcStart + 0.06;
        c.srcEnd = newSE;
      }
      // dọn rác: srcEnd/srcStart bị lệch do float → giữ bất biến
      if (c.srcEnd < c.srcStart) c.srcEnd = c.srcStart;
    }
    return;
  }
  if (blockDrag) {
    if (blockDrag.locked) return; // lane khóa — không kéo
    if (!blockDrag.moved && (Math.abs(x - blockDrag.mouse.x) > 2 || Math.abs(y - blockDrag.mouse.y) > 2)) blockDrag.moved = true;
    if (blockDrag.moved) {
      // CẬP NHẬT NGAY khi kéo — mượt như edit video
      const ev = blockDrag.ev;
      const entry = flat.find((p) => p.ev === ev);
      if (blockDrag.mode === 'move') {
        ev.frame = Math.max(0, Math.round(xToFrame(x) - blockDrag.grabF) - blockDrag.folder.offset);
        const row = hitLaneRow(y);
        if (row && !row.isAudio && row.lane !== ev.lane && !laneLockedByName(row.lane)) ev.lane = row.lane;
      } else if (blockDrag.mode === 'resize-r') {
        ev.duration = Math.max(1, Math.round(xToFrame(x)) - (entry ? entry.t : 0));
      } else { // resize-l
        const newStart = Math.round(xToFrame(x));
        ev.duration = Math.max(1, blockDrag.end0 - Math.min(newStart, blockDrag.end0 - 1));
        ev.frame = Math.max(0, newStart - blockDrag.folder.offset);
      }
      rebuildFlat();
    }
    return;
  }
  // gợi ý con trỏ: thanh đò + mép cue + thân khối nhạc = kéo ngang, thân cue = grab
  if (!dragInfo) {
    const px = frameToX(state.frame);
    const hit = hitCueBlock(x, y);
    const clip = audioClipHit(x, y);
    let cur = 'crosshair';
    // CHẾ ĐỘ CẮT (✂): trúng khối cue/clip nhạc = đang có thể cắt → con trỏ dao
    if (state.tlTool === 'cut' && (hit || clip)) cur = 'col-resize';
    // hover scrollbar → con trỏ kéo ngang
    else if (sbThumb && y >= sbThumb.y && y <= sbThumb.y + sbThumb.h && x >= GUT) cur = 'ew-resize';
    else if (Math.abs(x - px) <= 8) cur = 'ew-resize';
    else if (clip) {
      const atEdge = Math.abs(x - clip.cx1) <= 7 || Math.abs(x - clip.cx2) <= 7;
      cur = atEdge ? 'ew-resize' : 'grab';
    } else if (hit) {
      const x1 = frameToX(hit.fx.t), x2 = frameToX(eventEndFrame(hit.fx));
      cur = cueResizeMode(x, x1, x2) ? 'ew-resize' : (laneLockedByName(hit.row.lane) ? 'default' : 'grab');
    }
    canvas.style.cursor = cur;
    return;
  }
  if (dragInfo.mode === 'scrub') {
    // kéo playhead: giữ gần mép phải/trái → timeline TỰ CUỘN ngang theo, playhead không bị khựng ở 03:00
    const Wc = canvas.clientWidth;
    if (x > Wc - 24) state.viewStart += (x - (Wc - 24)) / state.pps * 0.3;
    else if (x < GUT + 24) state.viewStart -= (GUT + 24 - x) / state.pps * 0.3;
    state.viewStart = Math.max(0, state.viewStart);
    setFrame(Math.max(0, Math.round(xToFrame(x))));
    return;
  }
  if (Math.abs(x - dragInfo.x) > 4) dragInfo.moved = true;
  if (dragInfo.moved) {
    state.viewStart = Math.max(0, dragInfo.viewStart0 - (x - dragInfo.x) / state.pps);
  }
});
canvas.addEventListener('mouseleave', () => { dragInfo = null; clipDrag = null; sbDrag = null; mousePos = { x: -1, y: -1 }; });
canvas.addEventListener('mouseup', (e) => {
  if (sbDrag) { sbDrag = null; canvas.style.cursor = 'crosshair'; return; }
  if (clipDrag) {
    if (clipDrag.moved) {
      noteChange();       // kéo dời/trim instance phải hoàn tác được (undo)
      scheduleAutosave();
      const c = clipDrag.clip;
      flashStatus(clipDrag.mode === 'move'
        ? `Đã dời clip tới ${tcString(Math.round(c.tlStart * state.fps), state.fps)}`
        : `Đã ${clipDrag.mode === 'resize-l' ? 'kéo mép trái' : 'kéo mép phải'} clip — data lấy từ source, không stretch.`);
    } else {
      // click đơn = CHỌN instance clip (dùng được Sao chép/Cắt/Dán/Xóa trên selbar + menu chuột phải)
      state.selClipId = clipDrag.clip.id;
      state.selAudioLaneId = clipDrag.lane ? clipDrag.lane.id : null;
      state.sel = null;
      state.multiSel = new Set();
      renderFolders();
      renderProps();
      updateSelBar();
      flashStatus('Đã chọn clip — kéo thân dời, kéo mép trim/khôi phục từ source, hoặc Sao chép/Cắt/Dán/Xóa.');
    }
    clipDrag = null;
    canvas.style.cursor = 'crosshair';
    return;
  }
  if (blockDrag) {
    const ev = blockDrag.ev;
    if (blockDrag.moved && blockDrag.folder && !blockDrag.locked) {
      const f = blockDrag.folder;
      if (blockDrag.copy && blockDrag.mode === 'move') {
        // Alt = đặt thêm 1 ĐIỂM ĐẶT mới (cùng cue gốc) — cue gốc trở về chỗ cũ
        const dup = makePlacement(Math.max(0, ev.frame), ev.cueId);
        dup.lane = ev.lane; dup.duration = ev.duration || 0; dup.enabled = ev.enabled !== false;
        insertCue(f, dup);
        ev.frame = blockDrag.f0;
        ev.lane = blockDrag.lane0;
        ev.duration = blockDrag.dur0 || 0;
        state.sel = dup;
        state.multiSel = new Set([dup]);
        refreshAll();
        renderProps();
        flashStatus(`Đã đặt thêm 1 điểm tại ${tcString(f.offset + dup.frame, state.fps)} trên ${dup.lane}`);
      } else {
        const i = f.events.indexOf(ev);
        if (i >= 0) f.events.splice(i, 1);
        insertCue(f, ev); // sắp lại thứ tự trong thư mục
        state.sel = ev;
        state.multiSel = new Set([ev]);
        refreshAll();
        renderProps();
        flashStatus(blockDrag.mode === 'move'
          ? `Đã dời cue tới ${tcString(f.offset + ev.frame, state.fps)} trên ${ev.lane}`
          : `Độ dài cue = ${tcString(ev.duration || 0, state.fps)}`);
      }
    } else if (!blockDrag.moved) {
      // click chọn cue (⌘/Ctrl = thêm/bỏ khỏi vùng chọn)
      state.selAudioLaneId = null;
      state.selClipId = null;   // chọn cue = bỏ chọn instance clip (selbar không hiện nhầm)
      if (e.metaKey || e.ctrlKey) {
        if (state.multiSel.has(ev)) state.multiSel.delete(ev);
        else state.multiSel.add(ev);
        state.sel = [...state.multiSel].slice(-1)[0] || null;
      } else {
        state.multiSel = new Set([ev]);
        state.sel = ev;
        // click chọn cue thôi — KHÔNG dời playhead (chỉ kéo thanh đò mới đổi currentTime)
      }
      renderFolders();
      renderProps();
      updateSelBar();
    }
    blockDrag = null;
    canvas.style.cursor = 'crosshair';
    return;
  }
  if (!dragInfo) return;
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (dragInfo.mode === 'scrub') { dragInfo = null; return; }
  if (!dragInfo.moved && x >= GUT) {
    const row = hitLaneRow(y);
    if (row && row.isAudio) {
      // click nền lane A (ngoài clip) → bỏ chọn clip/lane
      state.selAudioLaneId = null;
      state.selClipId = null;
      updateSelBar();
    } else {
      state.sel = null;
      state.selAudioLaneId = null;
      updateSelBar();
      renderFolders();
      renderProps();
      // click nền/ruler/trống KHÔNG được dời playhead — chỉ kéo trực tiếp thanh đò mới đổi currentTime
    }
  }
  dragInfo = null;
});

// nhấp đúp clip nhạc → lấy bài SOURCE đó làm mốc thời gian (đồng hồ show) — không đụng instance
canvas.addEventListener('dblclick', (e) => {
  const r = canvas.getBoundingClientRect();
  const clip = audioClipHit(e.clientX - r.left, e.clientY - r.top);
  if (clip && clip.song) {
    const si = state.songs.findIndex((s) => s.id === clip.song.id);
    if (si >= 0) {
      activateSong(si, false, true);   // chỉ làm mốc — không reset playhead, không ngắt playback
      flashStatus(`Đã lấy "${state.songs[si].name}" làm mốc thời gian (playback không đổi).`);
    }
  }
});

/* ================= Menu CHUỘT PHẢI trên timeline (kiểu Resolume) =================
   Trúng cue → menu cue (ghi chú/SMPTE/Ẩn/Sao chép/Cắt/Dán/Xóa);
   trúng clip nhạc → menu clip (Sao chép/Cắt/Dán/Xóa); trúng nền KHÔNG hiện gì */
const tlCtx = $('tlCtx');
let tlCtxTarget = null;   // {type:'cue', ev} | {type:'audio', clip}
let tlCtxFrame = 0;       // vị trí chuột phải (giây lưới frame) cho "Dán vào đây"

function closeTlCtx() { tlCtx.hidden = true; tlCtxTarget = null; }

function openTlCtxAt(cx, cy) {
  const t = tlCtxTarget;
  const btn = (c) => tlCtx.querySelector(`[data-c="${c}"]`);
  const isCue = !!(t && t.type === 'cue');
  btn('note').hidden = !isCue;
  btn('smpte').hidden = !isCue;
  btn('hide').hidden = !isCue;
  if (isCue) {
    btn('smpte').classList.toggle('on', !!t.ev.smpteInput);
    const hiddenClip = t.ev.enabled === false;
    btn('hide').classList.toggle('on', hiddenClip);
    btn('hide').querySelector('span').textContent = hiddenClip ? 'Hiện clip (gửi OSC lại)' : 'Ẩn clip (không gửi OSC)';
    const hasCue = !!(state.clipboardMulti || state.clipboard);
    btn('paste').classList.toggle('disabled', !hasCue);
  } else {
    btn('paste').classList.toggle('disabled', !state.clipboardAudio);
  }
  tlCtx.hidden = false;
  const mw = tlCtx.offsetWidth || 240, mh = tlCtx.offsetHeight || 260;
  tlCtx.style.left = Math.min(cx, window.innerWidth - mw - 8) + 'px';
  tlCtx.style.top = Math.min(cy, window.innerHeight - mh - 8) + 'px';
}

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const hit = hitCueBlock(x, y);
  const clip = audioClipHit(x, y);
  if (hit && x >= GUT) {
    // chọn đúng cue đó (không dời playhead) rồi mở menu cue
    state.sel = hit.fx.ev;
    state.multiSel = new Set([hit.fx.ev]);
    state.selAudioLaneId = null;
    state.selClipId = null;
    renderProps(); updateSelBar(); renderFolders();
    tlCtxTarget = { type: 'cue', ev: hit.fx.ev };
  } else if (clip) {
    state.selClipId = clip.clip.id;      // chọn đúng INSTANCE (menu Sao chép/Cắt/Dán/Xóa theo instance)
    state.selAudioLaneId = clip.laneObj.id;
    state.sel = null;
    state.multiSel = new Set();
    renderProps(); updateSelBar(); renderFolders();
    tlCtxTarget = { type: 'audio', clip };
  } else {
    closeTlCtx();
    return;
  }
  tlCtxFrame = Math.max(0, Math.round(xToFrame(x)));
  openTlCtxAt(e.clientX, e.clientY);
});

tlCtx.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (btn.classList.contains('disabled')) return;
    const t = tlCtxTarget;
    closeTlCtx();
    if (!t) return;
    switch (btn.dataset.c) {
      case 'note': {
        const pn = $('pNote');
        pn.focus();
        flashStatus('Gõ ghi chú vào khung "GHI CHÚ" bên phải — Enter là lưu.');
        break;
      }
      case 'smpte':
        t.ev.smpteInput = !t.ev.smpteInput;
        scheduleAutosave();
        flashStatus(`SMPTE Input ${t.ev.smpteInput ? 'BẬT' : 'TẮT'}` + (t.ev.smpteInput ? ' — cue sẽ chờ tín hiệu SMPTE.' : ' — cue bắn theo thời gian timeline.'));
        break;
      case 'hide': toggleHideSelection(); break;
      case 'copy': copySelection(); break;
      case 'cut': cutSelection(); break;
      case 'paste': pasteSelection(tlCtxFrame); break;   // Dán NGAY vị trí chuột phải — không dời thanh đò
      case 'del': deleteSelection(); break;
    }
  });
});
document.addEventListener('click', (e) => {
  if (!tlCtx.hidden && !tlCtx.contains(e.target)) closeTlCtx();
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!state.pps) return;
  if (e.ctrlKey) {
    // ZOOM CapCut-style: neo đúng vị trí con trỏ, playhead/dữ liệu KHÔNG đổi
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const anchorSec = (x - GUT) / state.pps + state.viewStart;
    applyZoom(state.pps * Math.exp(-e.deltaY * 0.01), anchorSec);   // chậm, mượt
    return;
  }
  const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : (e.shiftKey && e.deltaY ? e.deltaY : 0);
  if (dx) {
    // SCROLL NGANG (2 ngón trái/phải, Shift + cuộn) — chỉ đổi viewStart
    state.viewStart = Math.max(0, state.viewStart + (dx / state.pps) * 0.6);
    clampView();
    return;
  }
  // 2 ngón đẩy LÊN/XUỒNG → KHÔNG làm gì (không tự zoom)
}, { passive: false });

/* Thả vào timeline (CapCut): BÀI HÁT → INSTANCE MỚI trên lane A (cùng source, instanceId riêng — thả
   bao nhiêu lần cũng được, KHÔNG thay thế instance cũ); CUE GỐC → điểm đặt mới; FILE từ Finder →
   thêm source vào NHÁC + đặt instance tại chỗ thả. Canvas tự quản drop (không qua setupDrop). */
canvas.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
canvas.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const row = hitLaneRow(y);
  const cid = e.dataTransfer.getData('text/hs-cue');
  const sid = e.dataTransfer.getData('text/hs-song');
  if (cid && !sid) {
    const [fid, defId] = cid.split(':').map(Number);
    const f = state.folders.find((fo) => fo.id === fid);
    const def = f && f.cues.find((c) => c.id === defId);
    if (def && f) {
      if (row && laneLockedByName(row.lane)) { flashStatus(`Lane ${row.lane} đang khóa — mở khóa để đặt cue.`); return; }
      // thả cue gốc vào timeline = ĐIỂM ĐẶT mới, mặc định dài 3 giây
      const cue = makePlacement(0, def.id);
      cue.duration = 3 * state.fps;
      cue.frame = Math.max(0, Math.round(xToFrame(x)) - f.offset);
      if (row && !row.isAudio) cue.lane = row.lane;
      insertCue(f, cue);
      state.sel = cue;
      state.multiSel = new Set([cue]);
      state.selClipId = null;
      updateSelBar();
      refreshAll();
      renderProps();
      flashStatus(`Đã đặt cue "${cueLabel(cue, f)}" tại ${tcString(f.offset + cue.frame, state.fps)} trên ${cue.lane}`);
    }
    return;
  }
  if (sid) {
    // thả bài từ danh sách NHÁC vào lane A = INSTANCE MỚI tham chiếu source (songId) — không đụng instance cũ
    const i = state.songs.findIndex((s) => s.id === Number(sid));
    if (i < 0) return;
    const song = state.songs[i];
    if (!(row && row.isAudio)) { flashStatus('Thả bài vào lane A (lane nhạc) để tạo instance.'); return; }
    if (laneLockedByName(row.lane)) { flashStatus(`Lane ${row.lane} đang khóa — mở khóa để thả.`); return; }
    const at = Math.max(0, state.viewStart + (x - GUT) / state.pps);   // tính TRƯỚC khi đụng view
    activateSong(i, false, true);   // giữ nguyên playhead/zoom/vùng nhìn — thả không được làm view nhảy
    const clip = addAudioInstance(song, row.id, at);
    state.selClipId = clip.id;
    state.selAudioLaneId = row.id;
    state.sel = null;
    state.multiSel = new Set();
    updateSelBar();
    const n = state.audioClips.filter((c) => c.songId === song.id).length;
    flashStatus(`Instance #${n} của "${song.name}" @ ${tcString(Math.round(at * state.fps), state.fps)} — thả cùng bài lần nữa vẫn tạo instance mới.`);
    return;
  }
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  const exts = /\.(mp3|wav|aiff|aif|m4a|aac|flac|ogg)$/i;
  const audioFiles = files.filter((f) => exts.test(f.name));
  if (audioFiles.length && row && row.isAudio) {
    // FILE thả TRỰC TIẾP lên lane A: thêm source vào NHÁC (một lần) + đặt INSTANCE tại chỗ thả
    if (laneLockedByName(row.lane)) { flashStatus(`Lane ${row.lane} đang khóa — mở khóa để thả.`); return; }
    let first = true;
    audioFiles.forEach((f) => {
      const p = window.hs.filePath(f);
      if (!p) return;
      const song = addSongFile(p);   // trùng path → dùng lại source cũ
      if (first) {
        const at = Math.max(0, state.viewStart + (x - GUT) / state.pps);
        activateSong(state.songs.indexOf(song), false, true);   // giữ view — không reset khi thả
        const clip = addAudioInstance(song, row.id, at);
        state.selClipId = clip.id;
        state.selAudioLaneId = row.id;
        first = false;
      }
    });
    updateSelBar();
    setStatus(`Đã thêm ${audioFiles.length} bài — instance đặt trên lane ${row.lane}.`);
  } else if (audioFiles.length) {
    // thả file lên vùng khác (lane V/R, nền) → chỉ thêm vào danh sách NHÁC, chưa đặt lên timeline
    audioFiles.forEach((f) => { const p = window.hs.filePath(f); if (p) addSongFile(p); });
    setStatus(`Đã thêm ${audioFiles.length} bài vào danh sách NHÁC — kéo vào lane A để đặt instance.`);
  }
});

/* Vẽ khối cue đang kéo (ghost) — ghép vào cuối drawTimeline qua hook */
const _drawTimeline = drawTimeline;
drawTimeline = function () {
  _drawTimeline();
  if (blockDrag && blockDrag.moved && state.pps) {
    const rows = timelineRows();
    const row = rows.find((rr) => rr.lane === blockDrag.ev.lane);
    if (row) {
      const entry = flat.find((p) => p.ev === blockDrag.ev);
      const t = entry ? entry.t : blockDrag.folder.offset + blockDrag.ev.frame;
      const dur = blockDrag.ev.duration > 0
        ? blockDrag.ev.duration
        : autoDur(t, blockDrag.ev.lane);
      const x1 = frameToX(t);
      const bw = Math.max(4, frameToX(t + dur) - x1);
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = cueColor(blockDrag.ev, blockDrag.folder);
      ctx.fillRect(x1, row.y + 2, bw, row.h - 10);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x1 + .5, row.y + 2.5, bw - 1, row.h - 11);
      ctx.lineWidth = 1;
      if (blockDrag.mode !== 'move') {
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px Menlo, monospace';
        ctx.fillText(tcString(dur, state.fps), x1 + bw + 6, row.y + (row.h - 6) / 2);
      }
      // highlight hàng dưới con trỏ
      const hover = hitLaneRow(mousePos.y);
      if (hover && !hover.isAudio && blockDrag.mode === 'move') {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.strokeRect(GUT + .5, hover.y + .5, canvas.clientWidth - GUT - 1, hover.h - 7);
      }
    }
  }
};

$('btnZoomIn').addEventListener('click', () => zoomPps(1.3));
$('btnZoomOut').addEventListener('click', () => zoomPps(1 / 1.3));

/* ================= Vòng lặp chính ================= */
let lastT = null;
let lastInfoFrame = -1;
let infoDirty = true;   // cần tính lại HIỆN TẠI/CUE TIẾP/CÒN LẠI (sau khi thêm/xóa nhạc, cue…)
function tick(t) {
  if (state.playing) {
    // ÂM THANH THEO CLIP INSTANCE: clip nào nằm dưới playhead (lane A bất kỳ) thì phát, đúng srcStart → srcEnd
    const clip = findClipAtFrame(state.frame);
    const local = clip ? (clip.srcStart + (state.frame / state.fps - clip.tlStart)) : 0;
    if (clip && local < clip.srcEnd - 0.01) {
      // KHÔNG dùng !audio.ended làm gate: khi bài nguồn đã phát hết file (ended), playhead vẫn
      // phải phát tiếp các clip khác/seek lại — seek currentTime sẽ tự xóa cờ ended
      if (audioSongId !== clip.song.id) {
        audio.src = 'file://' + encodeURI(clip.song.path);
        audioSongId = clip.song.id;
        audio.playbackRate = state.speed;
      }
      if (Math.abs(audio.currentTime - local) > 0.3) {
        audio.currentTime = clamp(local, 0, Math.max(0, clip.song.duration - 0.02));
      }
      if (audio.paused) audio.play().catch(() => {});
      // ÂM LƯỢNG theo INSTANCE: tổng (🔊) × volume riêng × fade in/out × mute — mỗi instance độc lập
      const vol = clip.clip.mute ? 0
        : clamp(masterVol * (typeof clip.clip.volume === 'number' ? clip.clip.volume : 1) * fadeFactor(clip.clip, local), 0, 1);
      if (Math.abs(audio.volume - vol) > 0.01) audio.volume = vol;
      // playhead bám theo fireplace thật — tính từ tlStart trừ đi srcStart (tiết kiệm mapping)
      state.frame = (clip.tlStart - clip.srcStart + audio.currentTime) * state.fps;
    } else {
      // ngoài clip (hoặc clip đã chạy tới điểm cắt srcEnd): im tiếng ngay, playhead vẫn chạy
      if (!audio.paused) audio.pause();
      if (Math.abs(audio.volume - masterVol) > 0.01) audio.volume = masterVol;
      if (lastT != null) state.frame += ((t - lastT) / 1000) * state.fps * state.speed;
    }
    fireDue();
    // KẾT THÚC PHÁT theo setting: loop (chạy lại) > 'contentEndPlus10' (chỉ dừng nếu nội dung vượt 3 phút,
    // điểm dừng = cuối nội dung + 10s) > 'infinite' (chạy vô hạn). 03:00 KHÔNG bao giờ là điểm dừng.
    if (state.loop && state.frame >= totalFrames()) setFrame(0);
    else {
      const stopF = playbackEndFrames();
      if ((state.playbackEndMode || 'infinite') === 'contentEndPlus10' && isFinite(stopF) && state.frame >= stopF) {
        state.frame = stopF;
        pause();
        setStatus('Đã phát hết — cuối nội dung + 10 giây. Muốn chạy vô hạn: đổi "Hết phát" thành "chạy vô hạn".');
      }
    }
    updateTc();
  }
  if (Math.floor(state.frame) !== lastInfoFrame || infoDirty) {
    lastInfoFrame = Math.floor(state.frame);
    infoDirty = false;
    updateInfoStrip();
  }
  if (state.pps) { const pr = $('ppsRange'); if (pr) pr.value = ppsToSlider(state.pps); }
  lastT = t;
  drawTimeline();
  requestAnimationFrame(tick);
}

/* Dải HIỆN TẠI / CUE TIẾP THEO / CÒN LẠI (của thư mục đang chọn) */
function updateInfoStrip() {
  $('infoCur').textContent = tcString(state.frame, state.fps);
  const nx = nextCue();
  if (nx) {
    // ĐẾM NGƯỢC: còn bao lâu nữa cue bắn ra
    $('infoNext').textContent = tcString(Math.max(0, nx.t - state.frame), state.fps);
    const fname = nx.f.name ? `${nx.f.name}: ` : '';
    $('infoNextName').textContent = fname + cueLabel(nx.ev, nx.f) + ' @ ' + tcString(nx.t, state.fps);
  } else {
    $('infoNext').textContent = '--:--:--:--';
    $('infoNextName').textContent = 'không còn cue nào';
  }
  // CÒN LẠI = điểm NGOÀI CÙNG của timeline: max(cuối instance clip nhạc, cue cuối cùng)
  let endFrame = 0;
  state.audioClips.forEach((c) => {
    const song = clipSong(c);
    const len = clipLen(c) || (song ? song.duration : 0) || 0;
    const end = (c.tlStart + len) * state.fps;
    if (end > endFrame) endFrame = end;
  });
  const f = curFolder();
  const pool = (state.showAllFolders || !f) ? flat : flat.filter((x) => x.f === f);
  pool.forEach((x) => {
    const end = x.t + (x.ev.duration || 0);
    if (end > endFrame) endFrame = end;
  });
  $('infoRem').textContent = endFrame > 0
    ? tcString(Math.max(0, endFrame - state.frame), state.fps)
    : '--:--:--:--';
}
requestAnimationFrame(tick);

audio.addEventListener('loadedmetadata', () => {
  const s = curSong();
  if (s && audio.duration && Math.abs((s.duration || 0) - audio.duration) > 0.5) {
    s.duration = audio.duration;
    refreshClipBounds(s);
    renderSongs();
    updateAudioName();
    scheduleAutosave();
  }
});
audio.addEventListener('ended', () => {
  // KHÔNG dừng timeline khi bài hát phát xong — tick() tự im tiếng và playhead chạy tiếp
  // theo tổng chiều dài timeline (cue có thể dài hơn âm thanh)
  if (!audio.paused) audio.pause();
});

/* ================= UI ================= */
function updateTc() { $('tcText').textContent = tcString(state.frame, state.fps); }

function updateTransport() {
  $('btnPlay').textContent = state.playing ? '⏸' : '▶';
  $('btnPlay').classList.toggle('active', state.playing);
  $('btnLoop').classList.toggle('active', state.loop);
  $('btnRec').classList.toggle('armed', state.recArmed);
  $('btnRec').textContent = state.recArmed ? '● REC BẬT' : '● REC TẮT';
  $('recDot').classList.toggle('on', state.recArmed && state.playing);
  const mr = $('mrRec');
  mr.textContent = state.recArmed ? '● REC BẬT' : '● REC TẮT';
  mr.classList.toggle('armed', state.recArmed);
}

let statusTimer = null;
function setStatus(msg) { $('sbLeft').textContent = msg; }
function flashStatus(msg) {
  setStatus(msg);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => setStatus('Sẵn sàng'), 2500);
}

let lastStats = { rx: 0, tx: 0 };
function updateStatsBar() {
  const total = state.folders.reduce((n, f) => n + f.events.length, 0);
  $('sbStats').textContent = `RX ${lastStats.rx} · TX ${lastStats.tx} · Cue ${total}`;
}
window.hs.onStats((s) => { lastStats = s; updateStatsBar(); });

/* ================= Monitor ================= */
const monBox = $('monitor');
let monPaused = false;
const OSC_SEEN = new Map(); // address → {args: [[...]], first: t, last: t, count}
const MAX_SEEN = 60;
function oscSeenKey(args) { return (args || []).map((a) => (typeof a === 'number' ? Math.round(a * 1000) / 1000 : String(a))).join('|'); }
function recordOscSeen(address, args) {
  const key = oscSeenKey(args);
  let item = OSC_SEEN.get(address);
  if (!item) {
    item = { args: new Map(), count: 0 };
    OSC_SEEN.set(address, item);
  }
  if (!item.args.has(key)) item.args.set(key, []);
  item.args.get(key).push({ t: Date.now(), count: 1 });
  item.count++;
  while (item.args.size > 20) {
    const first = item.args.keys().next().value;
    item.args.delete(first);
  }
  while (OSC_SEEN.size > MAX_SEEN) {
    const first = OSC_SEEN.keys().next().value;
    OSC_SEEN.delete(first);
  }
  renderOscSeen();
}
function renderOscSeen() {
  const box = $('oscSeenList');
  if (!OSC_SEEN.size) {
    box.innerHTML = '<div class="empty">Chưa có OSC nào được nhận</div>';
    return;
  }
  box.innerHTML = '';
  const arr = [...OSC_SEEN.entries()].slice(0, 40);
  arr.forEach(([addr, item]) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.title = `Nhận ${item.count} lần · ${item.args.size} dạng args`;
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.textContent = `×${item.count}`;
    const argsSpan = document.createElement('span');
    argsSpan.className = 'args';
    argsSpan.textContent = [...item.args.keys()].slice(0, 2).map((k) => k || '—').join(' · ');
    const addrSpan = document.createElement('span');
    addrSpan.className = 'addr';
    addrSpan.textContent = addr;
    div.append(addrSpan, argsSpan, cnt);
    div.addEventListener('click', () => {
      const args = [...item.args.keys()].slice(0, 1)[0];
      const parsed = parseOscArgs(args);
      let f = curFolder();
      if (!f) f = addFolder();
      const def = findOrMakeDef(f, addr, parsed);
      const cue = makePlacement(Math.floor(state.frame) - f.offset, def.id);
      const rl = recLane();
      cue.lane = rl ? rl.name : 'V1';
      insertCue(f, cue);
      state.sel = cue;
      refreshAll();
      renderProps();
      flashStatus(`Đã thêm cue từ ${addr} @ ${tcString(state.frame, state.fps)}`);
    });
    box.appendChild(div);
  });
}

function parseOscArgs(str) {
  if (!str || str.length < 2) return [1];
  const inner = str.slice(1, -1);
  if (!inner) return [1];
  return inner.split(',').map((s) => {
    const v = s.trim();
    return !isNaN(Number(v)) ? Number(v) : v;
  });
}
function monRow(address, args, isTx) {
  if (monPaused) return;
  const d = new Date();
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  const div = document.createElement('div');
  div.className = 'mon-row' + (isTx ? ' tx' : '');
  const plus = document.createElement('button');
  plus.className = 'm2c';
  plus.textContent = '＋';
  plus.title = 'Tạo cue từ OSC này (tại thanh đò, vào thư mục đang chọn)';
  plus.addEventListener('click', () => cueFromOsc(address, args));
  const txt = document.createElement('span');
  txt.className = 'mtxt';
  const v = (args || []).map((x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x)).join(',');
  txt.innerHTML = `<span class="t">${t}</span> <span class="a">${escapeHtml(address)}</span> <span class="v">${escapeHtml(v)}</span>`;
  div.append(plus, txt);
  if (state.monFilter && !`${address} ${v}`.toLowerCase().includes(state.monFilter)) {
    div.style.display = 'none';
  }
  monBox.appendChild(div);
  while (monBox.children.length > MAX_MON_ROWS) monBox.removeChild(monBox.firstChild);
  monBox.scrollTop = monBox.scrollHeight;
}

$('monPause').addEventListener('change', (e) => { monPaused = e.target.checked; });
$('btnMonClear').addEventListener('click', () => {
  monBox.innerHTML = '';
  OSC_SEEN.clear();
  renderOscSeen();
});
$('monFilter').addEventListener('input', (e) => {
  state.monFilter = e.target.value.toLowerCase();
  [...monBox.children].forEach((rowEl) => {
    const txt = rowEl.textContent.toLowerCase();
    rowEl.style.display = (!state.monFilter || txt.includes(state.monFilter)) ? '' : 'none';
  });
});

/* ================= Menu bar ================= */
const menuActions = {
  new: () => newProjectDialog(),
  open: () => openProjectDialog(),
  save: () => saveProjectDialog(),
  saveas: () => saveProjectAsDialog(),
  undo, redo,
  cut: cutSelection,
  copy: copySelection,
  paste: () => pasteSelection(),
  hide: toggleHideSelection,
  'delete': () => deleteSelection(),
  zoomin: () => zoomPps(1.3),
  zoomout: () => zoomPps(1 / 1.3),
  home: () => setFrame(0),
  follow: () => { $('followChk').checked = !$('followChk').checked; state.follow = $('followChk').checked; flashStatus('Theo thanh đò: ' + (state.follow ? 'BẬT' : 'TẮT')); },
  help: () => flashStatus('Quy trình: ① Bật OSC (panel KẾT NỐI OSC) + Bật Output trong Resolume (Preferences → OSC → 127.0.0.1:7000) ② Kéo nhạc vào lane A ③ Bật REC, Phát, gõ MIDI ④ Dừng REC, Play lại để chạy show. ⌘-click chọn nhiều cue. Kéo cue từ danh sách vào timeline = tạo bản sao (giữ Alt khi kéo trên timeline cũng vậy).'),
  testosc: () => openTestOsc()
};

document.querySelectorAll('#menubar .menu').forEach((menu) => {
  const btn = menu.querySelector('.menu-btn');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.classList.contains('open');
    document.querySelectorAll('#menubar .menu').forEach((m) => m.classList.remove('open'));
    if (!open) menu.classList.add('open');
  });
  menu.querySelectorAll('.menu-drop button').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.remove('open');
      const fn = menuActions[item.dataset.act];
      if (fn) fn();
    });
  });
});
document.addEventListener('click', () => {
  document.querySelectorAll('#menubar .menu').forEach((m) => m.classList.remove('open'));
});
$('btnOscToCues').addEventListener('click', () => {
  if (!OSC_SEEN.size) { setStatus('Chưa có OSC nào được nhận.'); return; }
  let created = 0;
  const entries = [...OSC_SEEN.entries()];
  let f = curFolder();
  if (!f) f = addFolder();
  entries.forEach(([addr, item]) => {
    const args = parseOscArgs([...item.args.keys()][0]);
    const def = findOrMakeDef(f, addr, args);
    const cue = makePlacement(Math.floor(state.frame) - f.offset, def.id);
    const rl = recLane();
    cue.lane = rl ? rl.name : 'V1';
    insertCue(f, cue);
    created++;
  });
  if (created) {
    refreshAll();
    renderOscSeen();
    flashStatus(`Đã tạo ${created} cue từ OSC đã nhận @ ${tcString(state.frame, state.fps)}`);
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ================= Sự kiện UI ================= */
$('btnPlay').addEventListener('click', togglePlay);
$('btnStop').addEventListener('click', stop);
$('btnHome').addEventListener('click', () => setFrame(0));
$('btnLoop').addEventListener('click', () => { state.loop = !state.loop; updateTransport(); });
$('btnRec').addEventListener('click', () => {
  state.recArmed = !state.recArmed;
  updateTransport();
  if (state.recArmed) {
    const f = curFolder();
    if (!f) { addFolder(); }
    if (!state.playing) play();
    flashStatus(`REC BẬT — ghi vào thư mục "${(f || curFolder()).name}".` +
      (state.recSource === 'osc' && !window.__oscListening
        ? ' ⚠ OSC đang TẮT — bấm "Bật OSC" (panel KẾT NỐI OSC) để ghi được từ Resolume.'
        : ' Gõ MIDI vào Resolume ngay.'));
  } else {
    flashStatus('REC TẮT.');
  }
});
$('recFolderSel').addEventListener('change', (e) => {
  state.activeFolderId = Number(e.target.value);
  renderFolders();
});

/* Thanh MIDI REC trên timeline */
function toggleRec() { $('btnRec').click(); }
$('mrRec').addEventListener('click', toggleRec);
$('mrLane').addEventListener('change', (e) => {
  state.recLaneId = Number(e.target.value);
  const sel = $('recLaneSel');
  if ([...sel.options].some((o) => o.value === e.target.value)) sel.value = e.target.value;
  scheduleAutosave();
});
$('recLaneSel').addEventListener('change', (e) => {
  state.recLaneId = Number(e.target.value);
  $('mrLane').value = e.target.value;
  scheduleAutosave();
});
$('mrResolume').addEventListener('click', () => $('btnCheckResolume').click());
$('mrToCue').addEventListener('click', () => {
  const t = $('mrLast').textContent.trim();
  if (!t || t === '—') { setStatus('Chưa nhận OSC nào để chuyển thành cue.'); return; }
  // mrLast = "address args..." — tách address (bắt đầu bằng /)
  const m = t.match(/(\/\S+)(?:\s+(.*))?/);
  if (!m) { setStatus('OSC mới nhất không đọc được.'); return; }
  const addr = m[1];
  const args = (m[2] || '').split(/[,\s]+/).filter(Boolean)
    .map((s) => (isNaN(Number(s)) ? s : Number(s)));
  cueFromOsc(addr, args.length ? args : [1]);
});
$('mrDedupe').addEventListener('click', () => {
  const f = curFolder();
  if (!f || !f.events.length) { setStatus('Thư mục đang chọn không có cue.'); return; }
  const seen = new Set();
  const before = f.events.length;
  f.events = f.events.filter((ev) => {
    const key = `${ev.frame}|${ev.lane}|${ev.cueId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  refreshAll();
  flashStatus(`Dọn trùng: đã bỏ ${before - f.events.length} điểm đặt trùng.`);
});
$('mrMonitor').addEventListener('click', () => {
  $('monHead').scrollIntoView({ behavior: 'smooth', block: 'center' });
  monBox.scrollTop = monBox.scrollHeight;
  flashStatus('Bảng MONITOR nằm ở panel phải — mỗi dòng OSC có nút ＋ để chuyển thành cue.');
});
$('autoAdvChk').addEventListener('change', (e) => { state.autoAdvance = e.target.checked; });
$('playEndSel').addEventListener('change', (e) => {
  state.playbackEndMode = e.target.value === 'contentEndPlus10' ? 'contentEndPlus10' : 'infinite';
  flashStatus('Hết phát: ' + (state.playbackEndMode === 'infinite' ? 'chạy vô hạn — chỉ dừng khi bấm ⏸/⏹' : 'tự dừng ở cuối nội dung + 10 giây'));
  scheduleAutosave();
});
$('speedSel').addEventListener('change', (e) => {
  state.speed = parseFloat(e.target.value) || 1;
  if (mode() === 'audio') audio.playbackRate = state.speed;
});
$('fpsSel').addEventListener('change', (e) => {
  state.fps = parseInt(e.target.value, 10) || 30;
  updateTc();
  renderFolders();
  scheduleAutosave();
});
$('followChk').addEventListener('change', (e) => { state.follow = e.target.checked; });
$('vol').addEventListener('input', (e) => {
  masterVol = parseFloat(e.target.value);
  audio.volume = masterVol;   // khi đang phát clip, tick() sẽ nhân thêm volume/fade riêng của instance
});

$('btnAddCue').addEventListener('click', () => {
  let f = curFolder();
  if (!f) f = addFolder();
  // chỉ tạo CUE GỐC trong danh sách — lên timeline chỉ khi kéo thả vào lane
  const def = makeDef('', [1]);
  def.name = 'Cue ' + (f.cues.length + 1);
  def.color = SWATCHES[(f.cues.length * 5) % SWATCHES.length];
  f.cues.push(def);
  renderFolders();
  scheduleAutosave();
  flashStatus(`Đã tạo "${def.name}" — điền ĐỊA CHỈ OSC, rồi KÉO vào timeline để đặt (mặc định 3 giây).`);
});
$('btnAddFolder').addEventListener('click', () => addFolder());

/* ================= Vùng chọn nhiều cue + thao tác ================= */
function selSet() {
  const s = new Set(state.multiSel);
  if (state.sel) s.add(state.sel);
  return s;
}

function updateSelBar() {
  const n = selSet().size;
  const ac = selAudioClip();
  $('selCount').textContent = ac ? '1 clip nhạc' : `${n} đã chọn`;
  $('selBar').style.display = (n || ac) ? 'flex' : 'none';
  // nút Mute phản chiếu đúng TRẠNG THÁI INSTANCE đang chọn
  const mb = $('btnSelMute');
  if (mb) {
    mb.classList.toggle('active', !!(ac && ac.mute));
    mb.textContent = ac && ac.mute ? '🔇 ĐANG MUTE' : '🔇 Mute';
    mb.style.display = ac ? '' : 'none';
  }
}

function selAudioLane() {
  return state.selAudioLaneId ? laneById(state.selAudioLaneId) : null;
}

function findCueLoc(ev) {
  for (const f of state.folders) {
    const i = f.events.indexOf(ev);
    if (i >= 0) return { f, i };
  }
  return null;
}

function copySelection() {
  // INSTANCE clip nhạc đang chọn — sao chép SEGMENT (tham chiếu source, không copy file)
  const c = selAudioClip();
  if (c) {
    state.clipboardAudio = {
      songId: c.songId, srcStart: c.srcStart, srcEnd: c.srcEnd,
      volume: typeof c.volume === 'number' ? c.volume : 1, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0,
      mute: !!c.mute
    };
    flashStatus('Đã sao chép clip nhạc (segment — tham chiếu source gốc).');
    return true;
  }
  const set = selSet();
  if (!set.size) { setStatus('Chưa chọn cue nào.'); return false; }
  const items = [...set].map((ev) => JSON.parse(JSON.stringify(ev)));
  items.sort((a, b) => a.frame - b.frame);
  state.clipboardMulti = items;
  state.clipboard = items[0]; // tương thích Dán đơn
  flashStatus(`Đã sao chép ${items.length} cue.`);
  return true;
}

function cutSelection() {
  const c = selAudioClip();
  if (c) {
    if (!copySelection()) return;
    removeAudioClip(c.id);
    state.selAudioLaneId = null;
    refreshAll();
    renderProps();
    updateSelBar();
    flashStatus('Đã cắt clip nhạc — Dán sẽ tạo INSTANCE MỚI tại playhead.');
    return;
  }
  if (!copySelection()) return;
  deleteSelection(false);
  flashStatus(`Đã cắt — nhấn Dán để đặt tại thanh đò.`);
}

function deleteSelection(notify = true) {
  // xóa INSTANCE clip đang chọn — source vẫn còn nguyên trong danh sách NHÁC, instance khác không đổi
  const c = selAudioClip();
  if (c) {
    removeAudioClip(c.id);
    state.selAudioLaneId = null;
    refreshAll();
    renderProps();
    updateSelBar();
    if (notify) flashStatus('Đã xóa instance clip — source vẫn còn trong danh sách NHÁC.');
    return;
  }
  const set = selSet();
  if (!set.size) return;
  set.forEach((ev) => {
    const loc = findCueLoc(ev);
    if (loc) loc.f.events.splice(loc.i, 1);
  });
  state.sel = null;
  state.multiSel = new Set();
  refreshAll();
  renderProps();
  updateSelBar();
  if (notify) flashStatus('Đã xóa cue.');
}

function pasteSelection(atFrame) {
  // dán clip nhạc = INSTANCE MỚI từ segment đã sao chép (không thay thế instance nào)
  if (state.clipboardAudio && !selSet().size) {
    const song = state.songs.find((s) => s.id === state.clipboardAudio.songId);
    if (!song) { setStatus('Bài nguồn đã bị xóa khỏi danh sách NHÁC.'); state.clipboardAudio = null; return; }
    let lane = selAudioLane();
    if (!lane || lane.kind !== 'A' || lane.locked) lane = state.lanes.find((l) => l.kind === 'A' && !l.locked);
    if (!lane) { setStatus('Chưa có lane A — bấm ＋ A trên timeline.'); return; }
    const at = (atFrame !== undefined ? atFrame : state.frame) / state.fps;   // "Dán vào đây" = vị trí chuột phải
    const cb = state.clipboardAudio;
    let srcEnd = cb.srcEnd > 0 ? cb.srcEnd : (song.duration > 0 ? song.duration : 0);
    if (song.duration > 0 && srcEnd > song.duration) srcEnd = song.duration;
    const clip = makeAudioClip(song.id, lane.id, at, cb.srcStart, srcEnd);
    clip.volume = cb.volume; clip.fadeIn = cb.fadeIn; clip.fadeOut = cb.fadeOut; clip.mute = !!cb.mute;
    state.audioClips.push(clip);
    refreshClipBounds(song);
    state.selClipId = clip.id;
    state.selAudioLaneId = lane.id;
    refreshAll();
    updateSelBar();
    flashStatus(`Đã dán INSTANCE MỚI "${song.name}" vào lane ${lane.name} @ ${tcString(Math.round(at * state.fps), state.fps)}.`);
    return;
  }
  const items = state.clipboardMulti || (state.clipboard ? [state.clipboard] : null);
  if (!items || !items.length) { setStatus('Chưa có cue nào trong bộ nhớ.'); return; }
  let f = curFolder();
  if (!f) f = addFolder();
  const base = Math.floor(atFrame !== undefined ? atFrame : state.frame) - f.offset;
  const base0 = items[0].frame;
  const newSel = new Set();
  items.forEach((src) => {
    // dán = điểm đặt mới, dùng lại cue gốc (cueId) đã có trong thư mục đích nếu trùng nguồn
    let defId = src.cueId;
    if (!f.cues.some((c) => c.id === defId)) {
      // cue gốc ở thư mục khác → tạo bản def tương ứng trong thư mục đích
      const srcF = state.folders.find((fo) => fo.cues.some((c) => c.id === src.cueId));
      const sd = srcF && srcF.cues.find((c) => c.id === src.cueId);
      if (!sd) return;
      const nd = findOrMakeDef(f, sd.address, sd.args);
      nd.name = sd.name; nd.color = sd.color; nd.note = sd.note; nd.mode = sd.mode;
      defId = nd.id;
    }
    const cue = makePlacement(Math.max(0, base + (src.frame - base0)), defId);
    cue.lane = src.lane || cue.lane;
    cue.duration = src.duration || 0;
    cue.enabled = src.enabled !== false;
    if (!laneByName(cue.lane)) cue.lane = state.lanes[0].name;
    insertCue(f, cue);
    newSel.add(cue);
  });
  state.multiSel = newSel;
  state.sel = [...newSel].slice(-1)[0];
  refreshAll();
  renderProps();
  updateSelBar();
  flashStatus(`Đã dán ${items.length} cue @ ${tcString(state.frame, state.fps)}.`);
}

function toggleHideSelection() {
  const set = selSet();
  if (!set.size) { setStatus('Chưa chọn cue nào.'); return; }
  const allVisible = [...set].every((ev) => ev.enabled !== false);
  set.forEach((ev) => { ev.enabled = allVisible ? false : true; });
  refreshAll();
  renderProps();
  flashStatus(allVisible ? `Đã ẩn ${set.size} cue (không gửi OSC).` : `Đã hiện ${set.size} cue.`);
}

function deselectAll() {
  state.sel = null;
  state.multiSel = new Set();
  renderFolders();
  renderProps();
  updateSelBar();
}

function deleteSelected(notify = true) { deleteSelection(notify); }

$('btnDelCue').addEventListener('click', () => deleteSelection());
$('btnCopy').addEventListener('click', copySelection);
$('btnCut').addEventListener('click', cutSelection);
$('btnPaste').addEventListener('click', () => pasteSelection());
$('btnSelCopy').addEventListener('click', copySelection);
$('btnSelCut').addEventListener('click', cutSelection);
$('btnSelPaste').addEventListener('click', () => pasteSelection());
$('btnSelHide').addEventListener('click', toggleHideSelection);
$('btnSelMute').addEventListener('click', () => {
  const c = selAudioClip();
  if (!c) { setStatus('Chưa chọn clip nhạc nào.'); return; }
  c.mute = !c.mute;                       // chỉ đụng INSTANCE này — instance khác/source không đổi
  updateSelBar();
  scheduleAutosave();
  flashStatus(c.mute ? `Đã MUTE instance @ ${tcString(Math.round(c.tlStart * state.fps), state.fps)} — phát tới clip này sẽ im tiếng.` : 'Đã bỏ mute instance.');
});
$('btnSelDel').addEventListener('click', () => deleteSelection());
$('btnSelNone').addEventListener('click', deselectAll);
$('btnCueUp').addEventListener('click', () => nudgeSelected(-1));
$('btnCueDown').addEventListener('click', () => nudgeSelected(1));

function nudgeSelected(df) {
  const set = selSet();
  if (!set.size) return;
  set.forEach((ev) => {
    const loc = findCueLoc(ev);
    if (!loc) return;
    loc.f.events.splice(loc.i, 1);
    ev.frame = Math.max(0, ev.frame + df);
    insertCue(loc.f, ev);
  });
  refreshAll();
}

$('cueSearch').addEventListener('input', (e) => { state.cueSearch = e.target.value; renderFolders(); });
$('songSearch').addEventListener('input', (e) => { state.songSearch = e.target.value; renderSongs(); });
$('btnSortSongs').addEventListener('click', () => {
  const act = curSong();
  state.songs.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  state.songIndex = act ? state.songs.indexOf(act) : -1;
  renderSongs();
  scheduleAutosave();
});
$('btnAddSong').addEventListener('click', async () => {
  const paths = await window.hs.openAudioMulti();
  if (paths && paths.length) {
    const added = paths.map((p) => addSongFile(p)).filter(Boolean);
    if (state.songIndex < 0 && added.length) activateSong(state.songs.indexOf(added[0]));
    setStatus(`Đã thêm ${paths.length} bài vào danh sách NHÁC.`);
  }
});

$('btnApplyPort').addEventListener('click', () => {
  const p = parseInt($('listenPort').value, 10);
  if (!(p >= 1024 && p <= 65535)) { setStatus('Cổng nghe không hợp lệ (1024–65535).'); return; }
  state.listenPort = p;
  window.hs.setListenPort(p)
    .then(() => setStatus(window.__oscListening
      ? `Đã đổi cổng nghe :${p}.`
      : `Đã lưu cổng nghe :${p} — OSC đang TẮT, bấm "Bật OSC" để nghe.`))
    .catch((e) => setStatus('Lỗi đổi cổng: ' + e.message));
});

/* Main OSC mặc định TẮT khi mở app — nút này là công tắc DUY NHẤT bật/tắt cổng nghe */
$('btnOscToggle').addEventListener('click', () => {
  if (window.__oscListening) {
    window.hs.oscDisable().catch((e) => setStatus('Lỗi tắt OSC: ' + e.message));
  } else {
    window.hs.oscEnable().catch((e) => setStatus('Lỗi bật OSC: ' + e.message));
  }
});
$('targetHost').addEventListener('change', (e) => { state.target.host = e.target.value.trim() || '127.0.0.1'; });
$('targetPort').addEventListener('change', (e) => { state.target.port = parseInt(e.target.value, 10) || 7001; });

$('btnCheckResolume').addEventListener('click', () => {
  // Kiểm tra cần NHẬN phản hồi — tự bật cổng nghe nếu đang TẮT (hành động của người dùng)
  if (!window.__oscListening) window.hs.oscEnable().catch(() => {});
  const rxBefore = rxLocal;
  setStatus('Đã gửi lệnh test (bật clip L1C1 trong Resolume) — chờ phản hồi 3 giây…');
  sendOsc('/composition/layers/1/clips/1/connect', [1]);
  setTimeout(() => {
    if (rxLocal > rxBefore) {
      setStatus('✓ ĐANG nhận OSC từ Resolume! Bật REC và gõ MIDI để ghi timecode.');
    } else {
      setStatus('✗ Không nhận được OSC. Kiểm tra: Resolume đang mở? Arena → Preferences → OSC → Output: bật, Address 127.0.0.1, Port 7000 (khớp Cổng nghe của app).');
    }
  }, 3000);
});

$('filterSel').addEventListener('change', (e) => {
  state.filterPreset = e.target.value;
  $('filterRegex').style.display = state.filterPreset === 'custom' ? 'block' : 'none';
  $('filterHint').textContent = filterDescription();
  scheduleAutosave();
});
$('filterRegex').addEventListener('change', (e) => {
  state.filterRegex = e.target.value.trim();
  scheduleAutosave();
});
document.querySelectorAll('input[name="recMode"]').forEach((r) => {
  r.addEventListener('change', (e) => { state.recMode = e.target.value; });
});

$('btnTestSend').addEventListener('click', () => {
  const addr = $('testAddr').value.trim();
  if (!addr.startsWith('/')) { setStatus('Địa chỉ OSC phải bắt đầu bằng /'); return; }
  const args = $('testArgs').value.split(',').map((s) => s.trim()).filter((s) => s !== '')
    .map((s) => (!isNaN(Number(s)) ? Number(s) : s));
  sendOsc(addr, args);
});

setupDrop($('audioDrop'), false); // kéo nhạc vào KHÔNG tự phát — đứng im cho bạn sửa

/* OSC từ main process */
window.hs.onOsc(onOscMessage);
window.hs.onStatus((s) => {
  window.__oscListening = !!s.listening;   // mini bridge đọc cờ này khi broadcast
  const el = $('oscStatus');
  const tgl = $('btnOscToggle');
  tgl.classList.toggle('armed', !!s.listening);
  if (s.listening) {
    tgl.textContent = '■ Tắt OSC';
    el.className = 'pill on';
    el.textContent = `ĐANG NGHE :${s.port}`;
  } else {
    tgl.textContent = '▶ Bật OSC';
    el.className = 'pill off';
    el.textContent = s.error ? `LỖI: ${s.error}` : 'TẮT';
  }
});

/* ================= Tool: Test OSC (nhận từ Resolume) ================= */
const TEST_OSC = { on: false, rows: [], text: '', regex: '', type: 'all', max: 500 };

function oscTypeOf(args) {
  if (!args || !args.length) return 'trigger';
  if (args.every((a) => typeof a === 'string')) return 'string';
  if (args.every((a) => Number.isInteger(a))) return 'int';
  return 'float';
}

function oscTypeLabel(t) {
  return { trigger: 'trigger', float: 'float', int: 'int', string: 'string' }[t] || t;
}

function toPassFilters(msg) {
  if (TEST_OSC.text && !msg.address.toLowerCase().includes(TEST_OSC.text)) return false;
  if (TEST_OSC.regex) {
    try { if (!new RegExp(TEST_OSC.regex).test(msg.address)) return false; }
    catch (_) { /* regex sai → bỏ qua */ }
  }
  if (TEST_OSC.type !== 'all' && oscTypeOf(msg.args) !== TEST_OSC.type) return false;
  return true;
}

function openTestOsc() {
  $('testOscModal').style.display = 'flex';
  renderTestOscRows();
}

function closeTestOsc() { $('testOscModal').style.display = 'none'; }

function renderTestOscRows() {
  const box = $('toRows');
  box.innerHTML = '';
  const shown = TEST_OSC.rows.filter(toPassFilters).slice(-300);
  shown.forEach((m) => {
    const div = document.createElement('div');
    div.className = 'to-row' + (m.tx ? ' tx' : '');
    const t = document.createElement('span'); t.textContent = m.t;
    const a = document.createElement('span'); a.className = 'addr'; a.textContent = m.address;
    const ty = document.createElement('span'); ty.className = 'typ'; ty.textContent = oscTypeLabel(m.type);
    const v = document.createElement('span'); v.className = 'args'; v.textContent = (m.args || []).join(', ');
    div.append(t, a, ty, v);
    div.addEventListener('click', () => cueFromOsc(m.address, m.args));
    box.appendChild(div);
  });
  $('toCount').textContent = `${TEST_OSC.rows.length} gói`;
  if ($('toAutoScroll').checked) box.scrollTop = box.scrollHeight;
}

function toRecord(msg) {
  const d = new Date();
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  TEST_OSC.rows.push({ t, address: msg.address, args: msg.args, type: oscTypeOf(msg.args), tx: false });
  while (TEST_OSC.rows.length > TEST_OSC.max) TEST_OSC.rows.shift();
  if ($('testOscModal').style.display !== 'none') renderTestOscRows();
}

$('toClose').addEventListener('click', closeTestOsc);
$('testOscModal').addEventListener('mousedown', (e) => { if (e.target === $('testOscModal')) closeTestOsc(); });
$('toStart').addEventListener('click', () => {
  // Test OSC cần cổng nghe để nhận — bấm "Bắt đầu nhận" là hành động bật OSC của người dùng
  if (!window.__oscListening) window.hs.oscEnable().catch(() => {});
  TEST_OSC.on = true;
  $('toStart').disabled = true;
  $('toStart').textContent = '● Đang nhận…';
  $('toStart').classList.add('armed');
  $('toStop').disabled = false;
  flashStatus('Test OSC: đang nhận mọi OSC đến cổng nghe. Bấm OSC trong bảng để tạo cue.');
});
$('toStop').addEventListener('click', () => {
  TEST_OSC.on = false;
  $('toStart').disabled = false;
  $('toStart').textContent = '▶ Bắt đầu nhận';
  $('toStart').classList.remove('armed');
  $('toStop').disabled = true;
  flashStatus('Test OSC: đã dừng nhận.');
});
$('toClear').addEventListener('click', () => { TEST_OSC.rows = []; renderTestOscRows(); });
$('toFilterText').addEventListener('input', (e) => { TEST_OSC.text = e.target.value.toLowerCase(); renderTestOscRows(); });
$('toFilterRegex').addEventListener('input', (e) => { TEST_OSC.regex = e.target.value.trim(); renderTestOscRows(); });
$('toFilterType').addEventListener('change', (e) => { TEST_OSC.type = e.target.value; renderTestOscRows(); });

/* ================= Kéo giãn panel + thanh trượt RỘNG/CAO ================= */
(function setupSplitters() {
  const cuePanel = $('cuePanel'), oscPanel = $('oscPanel'), center = $('center');
  const props = $('propsPanel');

  function dragX(handle, onMove) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const mm = (ev) => onMove(ev);
      const mu = () => {
        document.removeEventListener('mousemove', mm);
        document.removeEventListener('mouseup', mu);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', mm);
      document.addEventListener('mouseup', mu);
    });
  }

  dragX($('splitL'), (e) => {
    cuePanel.style.width = clamp(e.clientX, 250, Math.min(620, window.innerWidth * 0.5)) + 'px';
  });
  dragX($('splitR'), (e) => {
    oscPanel.style.width = clamp(window.innerWidth - e.clientX, 250, Math.min(620, window.innerWidth * 0.5)) + 'px';
  });
  $('hsplitProps').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const rect = center.getBoundingClientRect();
    const mm = (ev) => {
      const h = clamp(rect.bottom - ev.clientY, 120, rect.height * 0.7);
      props.style.height = h + 'px';
    };
    const mu = () => {
      document.removeEventListener('mousemove', mm);
      document.removeEventListener('mouseup', mu);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', mm);
    document.addEventListener('mouseup', mu);
  });

  // thanh trượt RỘNG: zoom CapCut-style — neo tại playhead/giữa vùng nhìn, đụng pixelsPerSecond thôi
  const ppsRange = $('ppsRange');
  ppsRange.addEventListener('input', () => {
    if (!state.pps) state.pps = ppsFit();
    applyZoom(sliderToPps(Number(ppsRange.value)));
    state.ppsInit = true;
  });

  // thanh trượt CAO: chiều cao lane toàn bộ layer (V/R; lane A tỉ lệ 1.6×)
  $('rowHRange').addEventListener('input', (e) => {
    state.rowH = Number(e.target.value);
    state.aRowH = clamp(Math.round(state.rowH * 1.6), 30, 150);
    scheduleAutosave();
  });

  $('showAllChk').addEventListener('change', (e) => {
    state.showAllFolders = e.target.checked;
    refreshVF();
    scheduleAutosave();
  });
})();

/* ================= Panel thuộc tính cue ================= */
function findSelectedFolder() {
  if (!state.sel) return null;
  return state.folders.find((f) => f.events.includes(state.sel)) || null;
}

function selDef() {
  const f = findSelectedFolder();
  if (!f || !state.sel) return null;
  return f.cues.find((c) => c.id === state.sel.cueId) || null;
}

function renderProps() {
  const ev = state.sel;
  $('propsEmptyHint').style.display = ev ? 'none' : '';
  $('propsBody').style.display = ev ? '' : 'none';
  if (!ev) return;
  const f = findSelectedFolder();
  const d = selDef();
  $('pName').value = (d && d.name) || '';
  $('pTime').value = tcString(f ? f.offset + ev.frame : ev.frame, state.fps);
  $('pDur').value = ev.duration > 0 ? tcString(ev.duration, state.fps) : '';
  $('pAddr').value = (d && d.address) || '';
  $('pArgs').value = d ? (d.args || []).join(', ') : '';
  $('pNote').value = (d && d.note) || '';
  const laneObj = laneByName(ev.lane);
  const pHideBtn = $('pHideBtn');
  pHideBtn.classList.toggle('active', ev.enabled === false);
  pHideBtn.textContent = ev.enabled === false ? '⊘ ĐANG ẨN — bấm để HIỆN LẠI' : '⊘ ẨN CLIP — KHÔNG GỬI QUA OSC';
  pHideBtn.disabled = !!(laneObj && laneObj.locked);
  ['Trigger', 'Piano', 'Float'].forEach((m) => {
    $('pMode' + m).classList.toggle('active', d && (d.mode || 'trigger') === m.toLowerCase());
  });
  renderSwatches();
}

function renderSwatches() {
  const box = $('pSwatches');
  box.innerHTML = '';
  const d = selDef();
  if (!d) return;
  SWATCHES.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (d.color === c ? ' sel' : '');
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => {
      d.color = d.color === c ? '' : c;
      renderProps();
      renderFolders();
      scheduleAutosave();
    });
    box.appendChild(b);
  });
}

/* TÊN / ĐỊA CHỈ / THAM SỐ / GHI CHÚ / MÀU / CHẾ ĐỘ sửa trên CUE GỐC — chỉ đổi thuộc tính, không sinh cue mới */
$('pName').addEventListener('input', (e) => {
  const d = selDef();
  if (d) { d.name = e.target.value; renderFolders(); scheduleAutosave(); }
});
$('pTime').addEventListener('change', () => {
  const f = findSelectedFolder();
  const v = parseTC($('pTime').value, state.fps);
  if (state.sel && v !== null && f) {
    const laneObj = laneByName(state.sel.lane);
    if (laneObj && laneObj.locked) { flashStatus(`Lane ${state.sel.lane} đang khóa.`); renderProps(); return; }
    const i = f.events.indexOf(state.sel);
    f.events.splice(i, 1);
    state.sel.frame = v - f.offset;
    insertCue(f, state.sel);
    refreshAll();
  }
});
$('pTime').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('pDur').addEventListener('change', () => {
  const v = parseTC($('pDur').value, state.fps);
  if (state.sel) {
    const laneObj = laneByName(state.sel.lane);
    if (laneObj && laneObj.locked) { flashStatus(`Lane ${state.sel.lane} đang khóa.`); renderProps(); return; }
    state.sel.duration = v === null || v <= 0 ? 0 : v;
    infoDirty = true;
    scheduleAutosave();
  }
});
$('pDur').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('pAddr').addEventListener('change', () => {
  const d = selDef();
  const v = $('pAddr').value.trim();
  if (!d) return;
  if (v.startsWith('/')) {
    d.address = v; // chỉ sửa thuộc tính — điểm đặt trên timeline giữ nguyên vị trí
    renderFolders();
    scheduleAutosave();
  } else {
    flashStatus('Địa chỉ OSC phải bắt đầu bằng "/" — ví dụ /composition/layers/4/clips/1/connect');
    renderProps(); // trả về địa chỉ cũ
  }
});
$('pArgs').addEventListener('change', () => {
  const d = selDef();
  if (!d) return;
  d.args = $('pArgs').value.split(',').map((s) => s.trim()).filter((s) => s !== '')
    .map((s) => (!isNaN(Number(s)) ? Number(s) : s));
  scheduleAutosave();
});
$('pNote').addEventListener('input', (e) => {
  const d = selDef();
  if (d) { d.note = e.target.value; scheduleAutosave(); }
});
$('pHideBtn').addEventListener('click', () => {
  if (!state.sel) return;
  state.sel.enabled = state.sel.enabled === false; // đảo: đang ẩn → hiện, đang hiện → ẩn
  refreshAll();
  renderProps();
  scheduleAutosave();
  flashStatus(state.sel.enabled === false ? 'Đã ẨN clip — mờ + sọc, không gửi OSC khi phát.' : 'Đã hiện lại clip.');
});
['Trigger', 'Piano', 'Float'].forEach((m) => {
  $('pMode' + m).addEventListener('click', () => {
    const d = selDef();
    if (d) { d.mode = m.toLowerCase(); renderProps(); scheduleAutosave(); }
  });
});
$('pDelete').addEventListener('click', () => { deleteSelected(); renderProps(); });
$('pPlayNow').addEventListener('click', () => {
  const d = selDef();
  if (!d) return;
  if (!d.address) { setStatus('Cue chưa có địa chỉ OSC — điền ĐỊA CHỈ OSC ở trên trước.'); return; }
  sendOsc(d.address, d.args);
  flashStatus(`Đã gửi ngay: ${d.address}`);
});
$('propsHead').addEventListener('click', (e) => {
  if (e.target.closest('input, button')) return;
  const b = $('propsBody');
  b.style.display = b.style.display === 'none' ? '' : 'none';
});

/* ================= Bàn phím ================= */
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'r': case 'R': $('btnRec').click(); break;
    case 's': case 'S': stop(); break;
    case 'l': case 'L': $('btnLoop').click(); break;
    case 'c': case 'C':
      if (!e.metaKey && !e.ctrlKey && !e.altKey) setTlTool(state.tlTool === 'cut' ? 'select' : 'cut');
      break;
    case 't': case 'T':
      if (!e.metaKey && !e.ctrlKey && !e.altKey) setTlTool('select');
      break;
    case 'Home': setFrame(0); break;
    case 'ArrowLeft': setFrame(state.frame - (e.shiftKey ? state.fps : 1)); break;
    case 'ArrowRight': setFrame(state.frame + (e.shiftKey ? state.fps : 1)); break;
    case 'Delete': case 'Backspace': deleteSelected(); break;
  }
});

/* ================= Undo / Redo ================= */
const undoStack = [], redoStack = [];
let lastSnap = null;

function snapshot() {
  return JSON.stringify({ folders: state.folders, lanes: state.lanes, audioClips: state.audioClips });
}

function applySnapshot(snap) {
  const d = JSON.parse(snap);
  state.folders = d.folders;
  state.lanes = d.lanes;
  state.audioClips = Array.isArray(d.audioClips) ? d.audioClips : [];   // undo cả cut/trim/dời instance
  state.sel = null;
  state.selClipId = null;
  state.multiSel = new Set();
  refreshAll();
  renderProps();
  updateSelBar();
}

function noteChange() {
  const snap = snapshot();
  if (snap === lastSnap) return;
  if (lastSnap) {
    undoStack.push(lastSnap);
    if (undoStack.length > 60) undoStack.shift();
    redoStack.length = 0;
  }
  lastSnap = snap;
}

function undo() {
  if (!undoStack.length) { setStatus('Không còn gì để hoàn tác.'); return; }
  const cur = snapshot();
  applySnapshot(undoStack.pop());
  redoStack.push(cur);
  lastSnap = snapshot();
  flashStatus('Đã hoàn tác.');
}

function redo() {
  if (!redoStack.length) { setStatus('Không còn gì để làm lại.'); return; }
  const cur = snapshot();
  applySnapshot(redoStack.pop());
  undoStack.push(cur);
  lastSnap = snapshot();
  flashStatus('Đã làm lại.');
}

/* ================= Lưu / mở dự án ================= */
let autosaveTimer = null;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(serializeProject()));
    } catch (_) { /* đầy thì thôi */ }
  }, 800);
}

function serializeProject() {
  captureActiveProject();   // dữ liệu đang làm việc phải nằm về ĐÚNG bài đang mở trước khi ghi đĩa
  return {
    version: 9,
    fps: state.fps,
    autoAdvance: state.autoAdvance,
    playbackEndMode: state.playbackEndMode,
    activeFolderId: state.activeFolderId,
    recLaneId: state.recLaneId,
    songIndex: state.songIndex,
    rowH: state.rowH,
    aRowH: state.aRowH,
    pps: state.pps ? +(state.pps.toFixed(3)) : 0,   // Zoom NGANG đang dùng — khôi phục khi mở lại project
    showAllFolders: state.showAllFolders,
    // v9: MỖI BÀI (folder) tự mang dữ liệu độc lập — không có audio/cue/track dùng chung giữa các bài
    folders: state.folders.map((f) => ({
      id: f.id, name: f.name, offset: f.offset, color: f.color, hidden: !!f.hidden, collapsed: !!f.collapsed,
      cues: f.cues, events: f.events,
      // AUDIO: riêng từng bài — files (source) + instance (range/volume/fade/mute)
      songs: (f.songs || []).map((s) => ({ id: s.id, name: s.name, path: s.path, duration: s.duration, size: s.size })),
      audioClips: (f.audioClips || []).map((c) => ({
        instanceId: c.id,          // id riêng của TỪNG instance (không dùng sourceId làm id)
        sourceId: c.songId,        // bài gốc trong songs[] của CÙNG bài này
        trackId: c.laneId,
        timelineStart: c.tlStart,
        timelineEnd: c.tlStart + clipLen(c),
        sourceStart: c.srcStart,
        sourceEnd: c.srcEnd,
        volume: typeof c.volume === 'number' ? c.volume : 1,
        fadeIn: c.fadeIn || 0,
        fadeOut: c.fadeOut || 0,
        mute: !!c.mute
      })),
      // TRACKS: riêng từng bài
      lanes: (f.lanes || []).map((l) => ({ id: l.id, name: l.name, kind: l.kind, locked: !!l.locked })),
      recLaneId: f.recLaneId || null,
      pstate: f.pstate || null       // playback settings riêng của bài này
    })),
    settings: {
      listenPort: state.listenPort,
      targetHost: state.target.host,
      targetPort: state.target.port,
      filterPreset: state.filterPreset,
      filterRegex: state.filterRegex,
      recMode: state.recMode
    }
  };
}

function migrateFolder(f, legacy) {
  /* legacy (v≤8): { songs, audioClips, lanes, activeFolderId } — dữ liệu audio global cũ
     được gắn về ĐÚNG MỘT bài (bài active) để không trộn dữ liệu giữa các bài */
  const nf = {
    id: f.id || nid(),
    name: f.name || 'Thư mục',
    offset: f.offset || 0,
    color: f.color || '',
    hidden: !!f.hidden,
    collapsed: !!f.collapsed,
    cues: [],
    events: []
  };
  if (Array.isArray(f.cues)) {
    // v7: cue gốc + điểm đặt — LƯU FULL MỌI CUE, kể cả cue CHƯA CÓ OSC Address (address: '')
    // → không được filter cue vì address rỗng/rỗng-undefined (lỗi cũ: save→load mất cue)
    nf.cues = f.cues.filter((c) => c && typeof c === 'object').map((c) => ({
      id: c.id || nid(),
      address: c.address == null ? '' : String(c.address),
      args: Array.isArray(c.args) ? c.args : [1],
      name: c.name == null ? '' : String(c.name),
      note: c.note == null ? '' : String(c.note),
      color: c.color == null ? '' : String(c.color),
      mode: c.mode || 'trigger'
    }));
    const ids = new Set(nf.cues.map((c) => c.id));
    nf.events = (Array.isArray(f.events) ? f.events : [])
      .filter((e) => e && ids.has(e.cueId))
      .map((e) => ({
        id: e.id || nid(), cueId: e.cueId, frame: e.frame || 0,
        lane: e.lane || 'V1', duration: e.duration || 0, enabled: e.enabled !== false,
        smpteInput: !!e.smpteInput
      }));
  } else {
    // v3–v6: mỗi event tự mang address → gom thành cue gốc theo address
    (Array.isArray(f.events) ? f.events : []).forEach((e) => {
      if (!e || !e.address) return;
      let d = nf.cues.find((c) => c.address === e.address);
      if (!d) {
        d = { id: nid(), address: e.address, args: e.args || [1], name: e.name || '', note: e.note || '', color: e.color || '', mode: e.mode || 'trigger' };
        nf.cues.push(d);
      }
      nf.events.push({
        id: e.id || nid(), cueId: d.id, frame: e.frame || 0,
        lane: e.lane || laneOf(e.address), duration: e.duration || 0, enabled: e.enabled !== false
      });
    });
  }
  nf.events.sort((a, b) => a.frame - b.frame);
  // ===== dữ liệu AUDIO/TRACK RIÊNG TỪNG BÀI =====
  if (f.songs || f.audioClips || f.lanes) {
    // v9: folder tự mang dữ liệu — nạp nguyên khối, instance migrate đúng range/volume/mute
    nf.songs = (f.songs || []).map((s) => ({
      id: s.id || nid(), name: s.name || 'Bài', path: s.path || '',
      duration: s.duration || 0, size: s.size || 0, peaks: null, decoding: false
    }));
    nf.lanes = (f.lanes || []).filter((l) => l && l.name).map((l) => ({
      id: l.id || nid(), name: l.name, kind: l.kind || l.name[0], locked: !!l.locked
    }));
    if (!nf.lanes.length) nf.lanes = [];   // activateProject sẽ dựng bộ lane mặc định
    nf.audioClips = migrateAudioClips({ audioClips: f.audioClips || [] }, nf.songs, nf.lanes.length ? nf.lanes : [{ id: 1, kind: 'A' }]);
    nf.recLaneId = f.recLaneId || null;
    nf.pstate = f.pstate || null;
  } else if (legacy && legacy.isOwnFolder) {
    // v≤8: dữ liệu audio global cũ → gắn về ĐÚNG MỘT bài (bài active khi lưu) — không trộn 2 bài
    nf.songs = legacy.songs;
    nf.lanes = legacy.lanes;
    nf.audioClips = legacy.audioClips;
    nf.recLaneId = legacy.recLaneId || null;
    nf.pstate = null;
  } else {
    // bài khác của dự án cũ: hoàn toàn TRỐNG — không được thừa hưởng nhạc của bài khác
    Object.assign(nf, freshProjectData());
  }
  return nf;
}

/* ===== AUDIO INSTANCE — nạp lại từ file dự án =====
   • v8+: đọc đúng danh sách audioClips đã lưu (mọi instance + cut/trim range giữ nguyên).
   • v3–v7 (dự án cũ, nhạc gắn trên lane): mỗi lane A có bài → đúng 1 instance full-range tại songOffset.
   • Clip mồ côi (sourceId không còn trong songs) bị bỏ — không sinh clip ma. */
function migrateAudioClips(data, songs, lanes) {
  const songOk = (id) => songs.some((s) => s.id === id);
  if (Array.isArray(data.audioClips)) {
    return data.audioClips.filter((c) => c && songOk(c.sourceId != null ? c.sourceId : c.songId)).map((c) => {
      const laneId = (c.trackId != null ? c.trackId : c.laneId);
      const clip = makeAudioClip(
        c.sourceId != null ? c.sourceId : c.songId,
        lanes.some((l) => l.id === laneId) ? laneId : lanes[0].id,
        +(c.timelineStart != null ? c.timelineStart : c.tlStart) || 0,
        +(c.sourceStart != null ? c.sourceStart : c.srcStart) || 0,
        +(c.sourceEnd != null ? c.sourceEnd : c.srcEnd) || 0
      );
      if (c.instanceId != null || c.id != null) clip.id = String(c.instanceId != null ? c.instanceId : c.id);
      clip.volume = typeof c.volume === 'number' ? clamp(c.volume, 0, 1) : 1;
      clip.fadeIn = Math.max(0, +c.fadeIn || 0);
      clip.fadeOut = Math.max(0, +c.fadeOut || 0);
      clip.mute = !!c.mute;
      return clip;
    });
  }
  const clips = [];
  lanes.forEach((l) => {
    if (l.kind !== 'A' || !l.songId || !songOk(l.songId)) return;
    const song = songs.find((s) => s.id === l.songId);
    const end = l.songEnd > 0 ? Math.min(l.songEnd, song.duration || l.songEnd) : (song.duration || 0);
    clips.push(makeAudioClip(l.songId, l.id, Math.max(0, l.songOffset || 0), 0, end));
  });
  return clips;
}

function applyProject(data) {
  if (!data || ![3, 4, 5, 6, 7, 8, 9].includes(data.version)) { setStatus('File dự án không hợp lệ.'); return; }
  pause();
  audioSongId = null;
  state.ppsInit = false; // nạp xong tính lại zoom khớp nội dung
  state.fps = data.fps || 30;
  $('fpsSel').value = String(state.fps);
  state.rowH = data.rowH || 60;            // không có zoom đã lưu → mặc định dọc 50%
  state.aRowH = data.aRowH || clamp(Math.round(state.rowH * 1.6), 30, 150);
  // Zoom NGANG: có lưu → khôi phục zoom đã lưu; chưa có → để ppsInit tính lại = 50% (3 phút vừa màn hình)
  if (data.pps && data.pps > 0) { state.pps = data.pps; state.ppsInit = true; }
  else { state.pps = 0; state.ppsInit = false; }
  state.showAllFolders = !!data.showAllFolders;
  const chk = $('showAllChk'); if (chk) chk.checked = state.showAllFolders;
  const rh = $('rowHRange'); if (rh) rh.value = state.rowH;
  // v≤8: songs/audioClips/lanes là GLOBAL — migrate gắn về ĐÚNG MỘT bài (bài active), các bài khác TRỐNG
  const legacyActive = data.version <= 8 ? (() => {
    const songs = (Array.isArray(data.songs) ? data.songs : []).map((s) => ({
      id: s.id || nid(), name: s.name || 'Bài', path: s.path || '',
      duration: s.duration || 0, size: s.size || 0, peaks: null, decoding: false
    }));
    const lanes = (Array.isArray(data.lanes) && data.lanes.length)
      ? data.lanes.filter((l) => l && l.name).map((l) => ({
          id: l.id || nid(), name: l.name, kind: l.kind || l.name[0],
          songId: l.songId || null, songOffset: l.songOffset || 0, songEnd: l.songEnd > 0 ? l.songEnd : 0, locked: !!l.locked
        }))
      : [];
    const audioClips = migrateAudioClips(data, songs, lanes.length ? lanes : [{ id: 1, kind: 'A' }]);
    return { songs, lanes: lanes.length ? lanes : [], audioClips, recLaneId: null };
  })() : null;
  state.folders = (Array.isArray(data.folders) && data.folders.length)
    ? data.folders.map((f) => migrateFolder(f, legacyActive && { ...legacyActive, isOwnFolder: f.id === data.activeFolderId }))
    : [Object.assign({ id: nid(), name: 'Chính', offset: 0, events: [], cues: [], color: '', hidden: false, collapsed: false }, freshProjectData())];
  state.songIndex = -1;
  state.autoAdvance = data.autoAdvance !== false;
  $('autoAdvChk').checked = state.autoAdvance;
  state.playbackEndMode = data.playbackEndMode === 'contentEndPlus10' ? 'contentEndPlus10' : 'infinite';
  const pSel = $('playEndSel');
  if (pSel) pSel.value = state.playbackEndMode;
  state.sel = null;
  state.selClipId = null;
  state.clipboardAudio = null;
  state.activeFolderId = state.folders.some((f) => f.id === data.activeFolderId)
    ? data.activeFolderId : state.folders[0].id;
  // NẠP ĐÚNG bài được chọn: toàn bộ songs/instances/lanes/playback state lấy từ folder đó
  const active = state.folders.find((f) => f.id === state.activeFolderId);
  activateProject(active);
  if (data.version <= 7 && legacyActive) {
    const aLane = state.lanes.find((l) => l.kind === 'A');
    if (aLane && state.lanes.some((l) => l.songId) === false && legacyActive.songs[0] && !state.audioClips.length) {
      // dự án rất cũ: nhạc gắn trên lane → migrateAudioClips đã tạo instance; không cần gì thêm
    }
  }
  refreshAll();
  renderProps();
  updateSelBar();
  const st = data.settings || {};
  if (st.listenPort) { state.listenPort = st.listenPort; $('listenPort').value = st.listenPort; window.hs.setListenPort(st.listenPort); }
  if (st.targetHost) { state.target.host = st.targetHost; $('targetHost').value = st.targetHost; }
  if (st.targetPort) { state.target.port = st.targetPort; $('targetPort').value = String(st.targetPort); }
  if (st.filterPreset) { state.filterPreset = st.filterPreset; $('filterSel').value = st.filterPreset; $('filterRegex').style.display = st.filterPreset === 'custom' ? 'block' : 'none'; }
  if (st.filterRegex !== undefined) { state.filterRegex = st.filterRegex; $('filterRegex').value = st.filterRegex; }
  if (st.recMode) { state.recMode = st.recMode; const el = document.querySelector(`input[name="recMode"][value="${st.recMode}"]`); if (el) el.checked = true; }
  $('filterHint').textContent = filterDescription();
  setStatus(`Đã nạp dự án: ${state.folders.length} bài — mỗi bài dữ liệu độc lập (v${data.version}).`);
}

let projPath = null; // file dự án đang mở — ⌘S lưu thẳng vào đây

async function saveProjectDialog() {
  if (projPath) {
    try {
      await window.hs.saveProjectTo(projPath, serializeProject());
      setStatus('Đã lưu: ' + projPath);
    } catch (err) { setStatus('Lỗi lưu: ' + err.message); }
    return;
  }
  await saveProjectAsDialog();
}

async function saveProjectAsDialog() {
  const r = await window.hs.saveProject(serializeProject());
  if (r) { projPath = r; setStatus('Đã lưu dự án: ' + r); }
}

async function openProjectDialog() {
  const r = await window.hs.openProject();
  if (r) { applyProject(r.data); projPath = r.path; }
}

function newProjectDialog() {
  if (!confirm('Tạo dự án mới? Thay đổi chưa lưu của dự án hiện tại sẽ mất.')) return;
  pause();
  projPath = null;
  state.folders = [];
  state.songs = [];
  state.songIndex = -1;
  state.lanes = [];
  state.recLaneId = null;
  state.sel = null;
  state.multiSel = new Set();
  state.clipboard = null;
  state.clipboardMulti = null;
  state.clipboardAudio = null;
  state.selClipId = null;
  state.audioClips = [];      // dự án mới = không instance nào (danh sách NHÁC/source cũng rỗng)
  state.frame = 0;
  state.viewStart = 0;
  state.ppsInit = false;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  addFolder();                // addFolder tự gắn bộ dữ liệu TRỐNG riêng + dựng lane mặc định
  renderSongs();
  updateAudioName();
  refreshAll();
  setStatus('Dự án mới — chưa lưu.');
}
$('btnSaveProj').addEventListener('click', saveProjectDialog);
$('btnOpenProj').addEventListener('click', openProjectDialog);

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if (e.metaKey || e.ctrlKey) {
    if (k === 's') { e.preventDefault(); e.shiftKey ? saveProjectAsDialog() : saveProjectDialog(); }
    else if (k === 'o') { e.preventDefault(); openProjectDialog(); }
    else if (k === 'c') { e.preventDefault(); copySelection(); }
    else if (k === 'x') { e.preventDefault(); cutSelection(); }
    else if (k === 'v') { e.preventDefault(); pasteSelection(); }
    else if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === 'a') { e.preventDefault(); selectAllCues(); }
  }
});

function selectAllCues() {
  // CHỈ chọn cue của bài đang mở — không đụng cue của bài khác (project isolation)
  const f = curFolder();
  const set = new Set(f ? f.events : []);
  state.multiSel = set;
  state.sel = [...set].slice(-1)[0] || null;
  state.selClipId = null;
  state.selAudioLaneId = null;
  renderFolders();
  updateSelBar();
  flashStatus(`Đã chọn ${set.size} cue của bài "${f ? f.name : '?'}".`);
}

/* ================= Khởi động ================= */
(function init() {
  if (!state.folders.length) addFolder();
  if (!state.lanes.length) {
    addLane('V', true);
    addLane('V', true);
    addLane('V', true);
    addLane('A', true);
    addLane('R', true);
  }
  $('filterHint').textContent = filterDescription();
  updateTc();
  updateTransport();
  fillRecFolderSel();
  fillRecLaneSel();
  renderFolders();
  renderSongs();
  renderProps();
  renderLanes();
  updateAudioName();
  let restored = false;
  try {
    const saved = localStorage.getItem(AUTOSAVE_KEY);
    if (saved) {
      const data = JSON.parse(saved);
      if ([3, 4, 5, 6, 7, 8, 9].includes(data.version)) { applyProject(data); restored = true; }
    }
  } catch (_) { /* bỏ qua */ }
  if (!restored) refreshAll();
  audio.volume = masterVol;
  setStatus('Bật ● REC → gõ MIDI vào Resolume → cue tự ghi vào lane R. Chưa nhận OSC? Bấm "Resolume" trên thanh MIDI REC.');
})();

/* ================= MIDI REC — mô hình 404TimeCode (midir → CoreMIDI bên 404) =================
   • Web MIDI API (Electron/macOS bật sẵn): quét thiết bị vào, note-on/off → địa chỉ OSC.
   • PAD Tự động: địa chỉ từ MẪU (/midi/note/{n} — {n}=note 0-127, {c}=kênh 1-16).
   • PAD Học từ OSC vào: pad chưa có địa chỉ riêng → nhận message OSC vào GẦN NHẤT làm địa chỉ
     (giống "đơn tơ địa chỉ" của 404: bấm pad trên Resolume → cue học địa chỉ).
   • Bounce: bấm pad (note-on) bắn OSC NGAY theo địa chỉ của pad — mọi lúc, không cần REC.
   • Ghi cue: khi REC BẬT + đang phát → note-on đặt cue bắn (mode Trigger), note-off kéo dài
     cue (mode Piano — "giữ/nhả" như 404). */
const MIDI = {
  access: null,          // WebMIDIAccess
  inputs: [],            // [{id, name, device}]
  watched: new Set(),    // device id đang lắng nghe
  padMap: new Map(),     // noteKey "n<note>c<ch>" → địa chỉ OSC đã học (pad mode learn)
  notes: new Map(),      // noteKey → {ev, folderId} đang GIỮ (để note-off tính duration Piano)
  lastOscIn: null        // {address, args} OSC vào gần nhất — cho pad learn
};

function midiNoteKey(note, ch) { return 'n' + note + 'c' + (ch || 1); }

/* Mẫu địa chỉ → địa chỉ thật: {n} note 0-127, {c} kênh 1-16 */
function midiAddrFor(note, ch) {
  const tpl = state.midiTpl || '/midi/note/{n}';
  return tpl.replace(/\{n\}/g, String(note)).replace(/\{c\}/g, String(ch || 1));
}

async function midiScan() {
  if (!navigator.requestMIDIAccess) {
    setStatus('Trình duyệt này không hỗ trợ Web MIDI.');
    return;
  }
  try {
    MIDI.access = await navigator.requestMIDIAccess({ sysex: false });
  } catch (e) {
    setStatus('Không mở được MIDI: ' + e.message);
    return;
  }
  const sel = $('mrMidiDevice');
  const prev = state.midiDeviceId || sel.value;
  sel.innerHTML = '<option value="">— không có —</option>';
  MIDI.inputs = [];
  MIDI.access.inputs.forEach((inp) => {
    MIDI.inputs.push(inp);
    const o = document.createElement('option');
    o.value = inp.id;
    o.textContent = inp.name || ('MIDI ' + inp.id);
    o.title = inp.name || '';
    sel.appendChild(o);
  });
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : '';
  state.midiDeviceId = sel.value || null;
  midiWatch();
  const n = MIDI.inputs.length;
  flashStatus(n ? `MIDI: tìm thấy ${n} thiết bị vào — chọn thiết bị rồi REC BẬT + gõ pad.` : 'MIDI: không tìm thấy thiết bị nào vào — kiểm tra kết nối đàn/pad.');
}

/* lắng nghe thiết bị đang chọn (bỏ theo dõi thiết bị khác) */
function midiWatch() {
  const want = state.midiDeviceId;
  MIDI.inputs.forEach((inp) => {
    if (inp.id === want && !MIDI.watched.has(inp.id)) {
      inp.onmidimessage = onMidiMessage;
      MIDI.watched.add(inp.id);
    } else if (inp.id !== want) {
      inp.onmidimessage = null;
      MIDI.watched.delete(inp.id);
    }
  });
  if (MIDI.access && MIDI.access.statechange) {
    // cắm/rút thiết bị → tự quét lại
    MIDI.access.onstatechange = () => { midiScan(); };
  }
}

function onMidiMessage(ev) {
  const [status, d1, d2] = ev.data;
  const type = status & 0xf0;      // 0x90 note-on, 0x80 note-off, 0xB0 CC…
  const ch = (status & 0x0f) + 1;  // 1-16
  if (type === 0x90 && d2 > 0) midiNoteOn(d1, ch, d2);
  else if (type === 0x80 || (type === 0x90 && d2 === 0)) midiNoteOff(d1, ch);
  /* CC/aftertouch: bỏ qua — REC MIDI của 404 cũng chỉ nhốt note pad */
}

function padAddr(note, ch) {
  const key = midiNoteKey(note, ch);
  if (state.midiPadMode === 'learn' && MIDI.padMap.has(key)) return MIDI.padMap.get(key);
  return midiAddrFor(note, ch);   // auto: luôn theo mẫu
}

function midiNoteOn(note, ch, vel) {
  const addr = padAddr(note, ch);
  $('mrLast').textContent = `MIDI n${note} ch${ch} → ${addr}`;
  $('mrLast').title = $('mrLast').textContent;
  const badge = $('mrRx');
  badge.textContent = 'MIDI ●';
  badge.classList.add('flash');
  setTimeout(() => badge.classList.remove('flash'), 120);
  // BOUNCE: bắn OSC ngay theo địa chỉ pad (mặc định bật) — như bấm pad trong Resolume
  if (state.midiBounce) sendOsc(addr, [1]);
  // REC: tạo/đặt cue tại playhead
  if (state.recArmed && state.playing) {
    const f = curFolder();
    if (!f) { setStatus('Chưa có bài để ghi — nhấn ＋ Bài.'); return; }
    const rl = recLane();
    if (rl && rl.locked) { setStatus(`Lane ghi ${rl.name} đang khóa — mở khóa để ghi.`); return; }
    const def = findOrMakeDef(f, addr, [1]);
    if (!def.name) def.name = 'Pad ' + note;
    const cue = makePlacement(Math.floor(state.frame) - f.offset, def.id);
    cue.lane = rl ? rl.name : 'V1';
    cue.duration = 0;                    // note-off sẽ kéo dài (Piano) — 404 giữ/nhả
    insertCue(f, cue);
    state.selClipId = null;
    refreshAll();
    MIDI.notes.set(midiNoteKey(note, ch), { ev: cue, folderId: f.id });
    flashStatus(`MIDI ghi cue @ ${tcString(state.frame, state.fps)} → ${cue.lane}  ${addr}`);
  }
}

function midiNoteOff(note, ch) {
  const key = midiNoteKey(note, ch);
  const held = MIDI.notes.get(key);
  if (held) {
    // kéo dài cue đúng khoảng GIỮ pad (mode Piano của 404)
    const f = state.folders.find((x) => x.id === held.folderId);
    if (f && f.events.includes(held.ev)) {
      const dur = Math.max(0, Math.floor(state.frame) - f.offset - held.ev.frame);
      if (dur > 0) held.ev.duration = dur;
      refreshAll();
      scheduleAutosave();
    }
    MIDI.notes.delete(key);
    if (state.midiBounce) {
      // nhả pad = thả nút Piano trong Resolume → gửi 0
      sendOsc(padAddr(note, ch), [0]);
    }
  } else if (state.midiBounce) {
    sendOsc(padAddr(note, ch), [0]);
  }
}

/* PAD LEARN — "đơn tơ địa chỉ" kiểu 404: đang ở chế độ Học + có CUE đang chọn
   → OSC vào gần nhất tự thành ĐỊA CHỈ của cue đó (bấm clip trong Resolume là xong).
   Đồng thời nhớ OSC vào cuối cùng cho pad map (note bấm sau dùng địa chỉ này). */
function midiPadLearn(address, args) {
  MIDI.lastOscIn = { address, args: args || [] };
  if (state.midiPadMode !== 'learn') return;
  const cue = state.sel;
  if (!cue) return;
  const f = state.folders.find((fo) => fo.events.includes(cue));
  if (!f) return;
  let def = f.cues.find((c) => c.id === cue.cueId);
  if (!def) return;
  if (def.address === address) return;      // đã đúng — khỏi đụng (không spam undo)
  noteChange();                             // học địa chỉ phải HOÀN TÁC được (như 404: Cmd+Z trả về gốc)
  def.address = address;
  if (Array.isArray(args) && args.length) def.args = args.slice(0, 4);
  if (!def.name || /^Pad \d+$/.test(def.name)) def.name = address.split('/').filter(Boolean).slice(-1)[0] || def.name;
  renderFolders();
  renderProps();
  flashStatus(`Đã học địa chỉ: ${address} → cue "${def.name}" (Cmd+Z hoàn tác).`);
}

/* ---------- UI gắn kết ---------- */
$('mrMidiScan').addEventListener('click', midiScan);
$('mrMidiDevice').addEventListener('change', (e) => {
  state.midiDeviceId = e.target.value || null;
  midiWatch();
  scheduleAutosave();
});
$('mrSource').addEventListener('change', (e) => {
  state.recSource = e.target.value === 'osc' ? 'osc' : 'midi';
  const midiOnly = state.recSource === 'midi';
  $('mrBounce').parentElement.style.display = midiOnly ? '' : 'none';
  $('mrPadBox').style.display = midiOnly ? '' : 'none';
  $('mrTpl').style.display = midiOnly ? '' : 'none';
  $('mrMidiBox').style.display = midiOnly ? '' : 'none';
  $('mrMidiScan').style.display = midiOnly ? '' : 'none';
  scheduleAutosave();
  flashStatus(state.recSource === 'midi'
    ? 'REC nguồn MIDI: bấm pad trên đàn → ghi cue (bounce OSC bật).'
    : 'REC nguồn OSC: Resolume gửi về :7000 → ghi cue theo bộ lọc.');
});
$('mrPadMode').addEventListener('change', (e) => {
  state.midiPadMode = e.target.value === 'learn' ? 'learn' : 'auto';
  scheduleAutosave();
  flashStatus(state.midiPadMode === 'learn'
    ? 'PAD Học: cue đang chọn + bấm clip trong Resolume → địa chỉ OSC vào gần nhất thành địa chỉ pad.'
    : 'PAD Tự động: địa chỉ pad sinh từ mẫu — sửa trong ô MẪU.');
});
$('mrTpl').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  state.midiTpl = v.startsWith('/') ? v : '/midi/note/{n}';
  e.target.value = state.midiTpl;
  scheduleAutosave();
});
$('mrBounce').addEventListener('change', (e) => {
  state.midiBounce = e.target.checked;
  scheduleAutosave();
});
$('mrRecMode').addEventListener('change', (e) => {
  state.recMode = e.target.value === 'overwrite' ? 'overwrite' : 'overdub';
  document.querySelectorAll('input[name="recMode"]').forEach((r) => { r.checked = r.value === state.recMode; });
  scheduleAutosave();
});
/* đồng bộ 2 thanh recMode (panel cài đặt ↔ thanh MIDI REC) */
document.querySelectorAll('input[name="recMode"]').forEach((r) => {
  r.addEventListener('change', (e) => {
    if (e.target.checked) {
      state.recMode = e.target.value;
      const mr = $('mrRecMode');
      if (mr) mr.value = state.recMode;
      scheduleAutosave();
    }
  });
});

/* khởi động MIDI: quét 1 lần sau khi app mở (không chặn UI) */
setTimeout(() => { midiScan(); }, 800);

/* ================= CỬA SỔ SMALL (MINI) — 1 playback engine duy nhất =================
   • Cửa sổ chính là engine: Mini chỉ NHẬN broadcast trạng thái + GỬI lệnh về đây.
   • Mini KHÔNG tự phát nhạc, KHÔNG gửi OSC trực tiếp — mọi thứ đi qua engine này. */
(function setupMiniBridge() {
  if (!window.hs || !window.hs.sendUiState) return;   // preload cũ — bỏ qua an toàn

  const btnMini = $('btnMini');
  btnMini.addEventListener('click', () => window.hs.openMini());
  if (window.hs.onMiniState) window.hs.onMiniState((s) => {
    btnMini.classList.toggle('active', !!(s && s.open));
  });

  // BROADCAST trạng thái (10Hz — đủ mượt cho timecode, nhẹ cho IPC)
  let lastSig = '';
  setInterval(() => {
    captureActiveProject();       // pstate mỗi bài luôn tươi trong danh sách broadcast
    const f = curFolder();
    const st = {
      frame: Math.round(state.frame),
      fps: state.fps,
      playing: state.playing,
      contentEnd: totalFrames(),
      curFolderId: f ? f.id : null,
      // SMALL chỉ cần DANH SÁCH BÀI + bài đang mở + trạng thái phát — không cần timeline
      folders: state.folders.map((fo) => ({
        id: fo.id, name: fo.name, color: fo.color,
        cues: (fo.events || []).length, songs: (fo.songs || []).length
      })),
      osc: { listening: !!(window.__oscListening), port: state.listenPort },
      stats: { rx: lastStats.rx, tx: lastStats.tx }
    };
    // GỬI LUÔN mỗi tick (10Hz, payload nhỏ): cửa sổ SMALL có thể mở BẤT KỲ LÚC NÀO —
    // nếu chỉ gửi khi thay đổi, SMALL mở sau sẽ không bao giờ nhận được state đầu tiên
    window.hs.sendUiState(st);
  }, 100);

  // NHẬN LỆNH từ Mini → thực thi trên engine DUY NHẤT này
  if (window.hs.onMiniCmd) window.hs.onMiniCmd((cmd) => {
    if (!cmd || !cmd.type) return;
    if (cmd.type === 'play') { if (!state.playing) play(); return; }
    if (cmd.type === 'pause') { if (state.playing) pause(); return; }
    if (cmd.type === 'play-pause') { togglePlay(); return; }
    if (cmd.type === 'stop') { stop(); setStatus('Mini: đã dừng.'); return; }
    if (cmd.type === 'home') { setFrame(0); updateTc(); return; }
    if (cmd.type === 'select-project') {
      // chọn bài ở SMALL → cửa sổ chính mở ĐÚNG bài đó (chuyển an toàn: pause trước khi nạp)
      switchProject(cmd.folderId);
      return;
    }
    if (cmd.type === 'trigger-cue') {
      const f = state.folders.find((fo) => fo.id === cmd.folderId);
      const d = f && f.cues.find((c) => c.id === cmd.cueId);
      if (!d) { setStatus('Mini: không tìm thấy cue.'); return; }
      if (!d.address) { setStatus(`Mini: cue "${d.name}" chưa có địa chỉ OSC.`); return; }
      sendOsc(d.address, d.args);       // engine chính là nguồn gửi OSC duy nhất
      flashStatus(`Mini đã bắn cue: ${d.name} → ${d.address}`);
      return;
    }
  });
})();
