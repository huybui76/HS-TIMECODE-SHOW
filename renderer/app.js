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
  useLearnedMappingFallback: !!window.HSRealtime.USE_LEARNED_MAPPING_FALLBACK,
  recSource: 'midi',       // 'midi' = ghi từ đàn/pad (Web MIDI) | 'osc' = ghi từ OSC Resolume gửi về
  midiDeviceId: null,      // thiết bị MIDI vào đang chọn (Web MIDI id)
  midiTpl: '/midi/note/{n}',   // mẫu địa chỉ OSC cho pad: {n} = note 0-127, {c} = kênh 1-16
  midiPadMode: 'auto',     // 'auto' = địa chỉ theo mẫu | 'learn' = học từ OSC vào gần nhất
  midiBounce: true,        // bấm pad là bắn OSC ngay (kể cả khi không REC)
  recNoteMode: 'auto',     // kiểu cue ghi từ pad: 'auto' (nhả nhanh=Trigger, giữ ≥0,5s=Piano) | 'trigger' | 'piano'
  recSmpteInput: false,    // BẬT = clip ghi lại trong phiên này chạy SMPTE Input theo thanh đò
  folders: [],             // [{id, name, offset, events:[{id, frame, address, args, lane}]}]
  activeFolderId: null,    // thư mục nhận cue khi ghi
  lanes: [],               // [{id, name:'V1'|'A1'|'R1', kind:'V'|'A'|'R'}] — thứ tự trên timeline (V trên, A giữa, R dưới)
  audioClips: [],          // INSTANCE nhạc trên timeline (không giới hạn, cùng 1 file vẫn mỗi lần thả 1 instance riêng):
                           // [{id=instanceId, songId=sourceId, laneId=trackId, tlStart=timelineStart, srcStart=sourceStart,
                           //   srcEnd=sourceEnd (tlEnd = tlStart + srcEnd − srcStart), volume, fadeIn, fadeOut}] — toàn bộ GIÂY
  selClipId: null,         // instance clip nhạc đang chọn trên timeline
  recLaneId: null,         // lane R nhận cue khi ghi
  laneGroupMode: window.HSRealtime.LANE_GROUP_MODE,
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
  follow: false,           // mặc định TẮT: timeline đứng yên khi phát — cue không trượt theo playhead
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
  rowH: 46,                // Zoom DỌC mặc định 30% (thanh CAO 24–96 → 30% = 46)
  aRowH: 74,               // lane A = 1.6× (74 ≈ 46 × 1.6)
  viewY: 0                 // cuộn DỌC lane (px) — khi các lane cao hơn khung nhìn
};

/* ===== AUTO-REC: ghi MIDI + gán OSC Resolume (cấu hình — xem rec-engine.js DEFAULTS) ===== */
const REC_CFG = Object.assign({}, (window.HSREC && window.HSREC.DEFAULTS) || {}, {
  // có thể override ở đây nếu cần; không hard-code rải rác trong code
});
const laneAlloc = new (window.HSREC ? window.HSREC.LaneAllocator : function () { this.allocate = () => ({ needCreate: true }); this.remember = () => {}; this.importGroups = () => {}; this.exportGroups = () => ({}); })();
/* mapping MIDI → OSC học được: key "n<note>c<ch>" | "cc<cc>c<ch>" → {address, kind, lastArgs} */
const midiMap = new Map();
let oscFloatAddressKey = null;
let oscPort = null;
let oscProcStats = null;
let oscProcRecvBuf = null;
let oscProcError = null;
let oscProcSeen = [];
const midiMatchWaiters = new Map();
let midiMatchSeq = 0;
const OSC_MATCH_TIMEOUT_MS = REC_CFG.MATCH_REPLY_TIMEOUT_MS;
let oscRecording = false;
let oscRecArmed = false;
let oscSession = 0;
let oscAnchor = { epoch: performance.timeOrigin + performance.now(), frame: 0, session: 0 };
let oscCaptureSeen = false;
const oscRecSeen = new Map();     // "folderId|address|frame" -> continuous cue
const recTransactions = new Map();
const recLive = new Map(); // UI-only snapshots, never part of the project or playback cache.
let recActiveSession = null;
let oscAssignCue = null;

function syncOscFloatAddresses() {
  if (!window.hs.setOscFloatAddresses) return;
  const addresses = new Set();
  for (const folder of state.folders) {
    const floatCueIds = new Set((folder.events || [])
      .filter((event) => event.recMeta && event.recMeta.kind === 'float')
      .map((event) => event.cueId));
    for (const cue of folder.cues || []) {
      if ((cue.mode === 'float' || floatCueIds.has(cue.id)) && cue.address) addresses.add(cue.address);
    }
  }
  for (const mapping of midiMap.values()) {
    if (mapping.kind === 'float' && mapping.address) addresses.add(mapping.address);
  }
  const list = [...addresses].sort();
  const key = JSON.stringify(list);
  if (key === oscFloatAddressKey) return;
  oscFloatAddressKey = key;
  window.hs.setOscFloatAddresses(list).catch((error) => {
    if (oscFloatAddressKey === key) oscFloatAddressKey = null;
    setStatus('OSC whitelist: ' + error.message);
  });
}
/* debug log (bật bằng state.recDebug) */
const recDebugLog = [];
function recDebug(...args) {
  if (!state.recDebug) return;
  recDebugLog.push({ t: performance.now(), msg: args });
  if (recDebugLog.length > 500) recDebugLog.shift();
  console.log('[REC]', ...args);
}

/* ===== OSC FEEDBACK — gom + throttle hiển thị (KHÔNG ảnh hưởng recording) ===== */
const oscFeed = new (window.HSOSC ? window.HSOSC.OscFeedback : function () {
  this.ingest = () => {}; this.ingestTx = () => {}; this.tick = () => false;
  this.flushAll = () => false; this.clear = () => {}; this.clearMonitorOnly = () => {};
  this.snapshotMonitor = () => []; this.snapshotSeen = () => []; this.snapshotTest = () => [];
  this.pendingMonitor = () => 0; this.pendingSeen = () => 0; this.pendingTest = () => 0;
  this.monitorCount = () => 0; this.testCount = () => 0; this.seenAddrCount = () => 0;
  this.seenHistoryEntries = () => 0;
})();

/* ===== Trạng thái MIDI (khai báo SỚM — pause() lúc init gọi recFinalizeOpen) ===== */
const MIDI = {
  access: null,          // WebMIDIAccess
  inputs: [],            // [{id, name, device}]
  watched: new Set(),    // device id đang lắng nghe
  padMap: new Map(),     // noteKey "n<note>c<ch>" → địa chỉ OSC đã học (pad mode learn)
  notes: new Map(),      // noteKey → {ev, folderId, kind, defNew} đang GIỮ (để note-off quyết định Trigger/Piano)
  cc: new Map(),         // "cc<cc>c<ch>" → {ev, folderId, def} cử chỉ vặn đang chạy
  lastOscIn: null,       // {address, args} OSC vào gần nhất — cho pad learn
  monOpen: new Map()     // noteKey → {t0, vel, label} đang giữ (cho MONITOR MIDI)
};


const LANE_COLORS = ['#4f8cff', '#9a6bff', '#3ecfb2', '#e5c25a', '#ff8a5c', '#5cd6ff', '#ff6b9d', '#a8e34d'];
/* ===== Timeline CapCut-style ===== */
const TL_MIN_SEC = 180;   // chỉ dùng làm khung nhìn MỶC ĐỊNH khi timeline trống (0:00 → 03:00) — không phải giới hạn
const PPS_MIN = 0.5;      // pixelsPerSecond xa nhất (zoom out)
const PPS_MAX = 800;      // pixelsPerSecond sát nhất (zoom in)
const MAX_MON_ROWS = 300;
const AUTOSAVE_KEY = 'hs-timecode-autosave';
/* Con trỏ kéo cắt cho chế độ CẮT NHANH (SVG inline — không cần file) */
const QC_CUT_CURSOR = 'url("data:image/svg+xml;utf8,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><text x="3" y="18" font-size="17" font-weight="bold" fill="#ff3b30" stroke="#fff" stroke-width="0.6">✂</text></svg>') +
  '") 6 6, crosshair';
let idSeq = Date.now();
const nid = () => ++idSeq;

const $ = (id) => document.getElementById(id);
const audio = $('player');
/* file:// URL từ đường dẫn: encodeURI BỎ QUA '#''?' — ký tự này trong tên file (vd
   "PLAYBACK MST #.wav") làm đứt URL (mọi thứ sau # thành fragment) → bài im tiếng,
   playhead đứng. Phải escape thủ công sau encodeURI. */
function fileUrl(p) {
  return 'file://' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F');
}
audio.addEventListener('error', () => {
  if (!audio.src) return;
  const p = decodeURIComponent(audio.src.replace(/^file:\/\//, ''));
  setStatus('✗ Không đọc được file nhạc: ' + p + ' — kiểm tra file còn tồn tại hoặc đang bị khóa quyền đọc.');
});
const canvas = $('timeline');
const ctx = canvas.getContext('2d');
let audioCtx = null;
let audioSongId = null;   // id bài đang phát trên element <audio> (theo clip, không theo mốc)
let qcHover = null;   // CẮT NHANH: item đang rê chuột khi bật chế độ — { kind:'audio'|'cue', row, cx1, cx2, cutF, locked, clip|fx }
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
  const f = curFolder();
  if (f) f.lanes = state.lanes;
}

function recSyncLaneGroups(f) {
  const groups = {};
  for (const lane of f.lanes || []) {
    if (lane.kind !== 'R' || !lane.recGroup) continue;
    (groups[lane.recGroup] || (groups[lane.recGroup] = [])).push(lane.name);
  }
  f.laneGroups = groups;
  if (f.id === state.activeFolderId) laneAlloc.importGroups(groups);
}

function recNormalizeLanes(f = curFolder(), removeEmpty = REC_CFG.AUTO_REMOVE_EMPTY_LANES) {
  if (!f) return;
  const active = f.id === state.activeFolderId;
  const lanes = active ? state.lanes : (f.lanes || []);
  // Only renderer-owned rows may be removed; a user-created +R is never a spare.
  const kept = lanes.filter((lane) => !(removeEmpty && lane.kind === 'R' && lane.autoRec === true
    && !lane.manual && !lane.manualLane && !lane.locked
    && !f.events.some((event) => event.laneId != null ? event.laneId === lane.id : event.lane === lane.name)));
  const normalized = window.HSCueLayout.normalizeLanes(kept, f.events, { removeEmpty: false });
  const byId = new Map(lanes.map((lane) => [lane.id, lane]));
  lanes.splice(0, lanes.length, ...normalized.lanes.map((lane) => Object.assign(byId.get(lane.id), lane)));
  normalized.events.forEach((event, index) => { f.events[index].lane = event.lane; });
  const roots = new Map();
  for (const lane of lanes) {
    if (!lane.recGroup) continue;
    if (!roots.has(lane.recGroup)) roots.set(lane.recGroup, lane.id);
    lane.auxiliary = roots.get(lane.recGroup) !== lane.id;
    lane.auxOf = lane.auxiliary ? roots.get(lane.recGroup) : null;
  }
  f.lanes = lanes;
  let pointer = active ? state.recLaneId : f.recLaneId;
  if (!lanes.some((lane) => lane.id === pointer)) pointer = (lanes.find((lane) => lane.kind === 'R') || {}).id || null;
  f.recLaneId = pointer;
  if (active) { state.lanes = lanes; state.recLaneId = pointer; }
  recSyncLaneGroups(f);
}

function addLane(kind, silent) {
  const lane = { id: nid(), name: nextLaneName(kind), kind, songId: null, songOffset: 0, songEnd: 0, locked: false };
  if (kind === 'R') { lane.autoRec = !!silent; lane.manual = !silent; }
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
  recNormalizeLanes(curFolder(), false);
  if (!silent) { renderLanes(); renderTimelineHeader(); noteChange(); scheduleAutosave(); }
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
  const f = curFolder();
  if (f) {
    f.events = f.events.filter((ev) => {
      if (ev.lane !== lane.name) return true;
      state.multiSel.delete(ev);
      if (state.sel === ev) state.sel = null;
      return false;
    });
  }
  if (state.recLaneId === id) {
    const r = state.lanes.find((l) => l.kind === 'R');
    state.recLaneId = r ? r.id : null;
  }
  sortLanesByKind();
  recNormalizeLanes(f);
  rebuildFlat();
  renderLanes();
  fillRecLaneSel();
  noteChange();
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
      const kind = /^[VAR]/.test(name) ? name[0] : 'V';
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
  recNormalizeLanes(f, false);
}

function renderLanes() {
  // chỉ cập nhật thống kê + select lane ghi (lane vẽ trên canvas)
  fillRecLaneSel();
  renderTimelineHeader();
  const total = state.folders.reduce((n, f) => n + f.events.length, 0);
  $('tlStats').textContent = `${total} cue · ${state.lanes.length} lane`;
}

function renderTimelineHeader() {
  // Nhãn «TIMELINE — …» đã bỏ theo thiết kế mới — bài đang mở xem ở panel trái
}

$('btnLaneV').addEventListener('click', () => addLane('V'));
$('btnLaneA').addEventListener('click', () => addLane('A'));
$('btnLaneR').addEventListener('click', () => addLane('R'));
$('toolSelect').addEventListener('click', () => setTlTool('select'));
$('toolCut').addEventListener('click', () => setTlTool('cut'));
$('btnQuickCut').addEventListener('click', () => setTlTool(state.tlTool === 'quickcut' ? 'select' : 'quickcut'));
setTlTool('select');   // mặc định: Chọn (➤)


function fillRecLaneSel() {
  const sel = $('recLaneSel');
  sel.innerHTML = '';
  state.lanes.forEach((l) => {
    if (l.kind !== 'R' && l.kind !== 'V') return;
    const opt = document.createElement('option');
    opt.value = l.id;
    opt.textContent = l.name + (l.groupLabel ? ' · ' + l.groupLabel : (l.kind === 'R' ? ' (ghi OSC)' : ''));
    opt.title = l.groupLabel || l.name;
    sel.appendChild(opt);
  });
  sel.value = String(state.recLaneId || '');
  renderRecLaneOrder();
}

/* Bộ lọc ghi */
function activeFilter() {
  switch (state.filterPreset) {
    case 'connect':
      return /\/connect$/i;
    case 'connectcol':
      return /\/(layers\/\d+\/clips\/\d+|columns\/\d+)\/connect$/i;
    case 'all':
      // Bỏ telemetry: /position (kể cả cuối đường dẫn), /position/..., values, speed…
      // KHÔNG bỏ opacity/volume — người dùng còn cần ghi automation.
      return { test: (a) => !(window.HSOSC ? window.HSOSC.isRecNoise(a) : false) };
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
  refreshPlaybackSchedule();
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
  // mỗi BÀI là một PROJECT ĐỘC LẬP — timeline + cue trống, RIÊNG danh sách NHÁC là dùng chung
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
  // cảnh báo ĐỦ: cue + clip nhạc đều mất theo bài — không để xóa nhầm im lặng
  const loss = [];
  if (f.events.length) loss.push(`${f.events.length} cue`);
  if ((f.audioClips || []).length) loss.push(`${f.audioClips.length} clip nhạc`);
  if (loss.length && !confirm(`Xóa bài "${f.name}"? Sẽ mất theo: ${loss.join(', ')}.`)) return;
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
   • Dữ liệu RIÊNG TỪNG bài, sống TRONG folder: audioClips, lanes, recLaneId, pstate
     (playback settings: frame, zoom, fps, speed, loop, hết-phát, volume, bài đang chọn…).
   • RIÊNG danh sách NHÁC (state.songs) là THƯ VIỆN DÙNG CHUNG của mọi bài — thêm 1 lần,
     thả vào timeline bài nào cũng được; tạo bài mới KHÔNG mất danh sách nhạc.
   • `state` chỉ là bản LÀM VIỆC của bài đang mở — Playback Engine duy nhất chạy trên nó.
   • Chuyển bài: PAUSE → chép dữ liệu làm việc về bài cũ → nạp dữ liệu bài mới (đúng trạng thái đã lưu).
   • KHÔNG có biến global nào giữ dữ liệu riêng của 2 bài cùng lúc. */
function freshProjectData() {
  return { audioClips: [], lanes: [], recLaneId: null, pstate: null };
}

/* chép bản làm việc hiện tại về bài đang mở (trước khi rời bài / trước khi Save) */
function captureActiveProject() {
  const f = curFolder();
  if (!f) return;
  f.audioClips = state.audioClips;
  f.lanes = state.lanes;
  f.recLaneId = state.recLaneId;
  recSyncLaneGroups(f);
  f.pstate = {
    frame: Math.round(state.frame), viewStart: state.viewStart,
    pps: state.pps, ppsInit: state.ppsInit,
    fps: state.fps, speed: state.speed, loop: state.loop,
    playbackEndMode: state.playbackEndMode, autoAdvance: state.autoAdvance,
    masterVol, songIndex: state.songIndex,
    rowH: state.rowH, aRowH: state.aRowH
  };
}

/* nạp dữ liệu của 1 bài vào bản làm việc `state` + đồng bộ toàn bộ UI
   (songs KHÔNG nạp từ folder — đó là thư viện dùng chung, giữ nguyên khi chuyển bài) */
function activateProject(f) {
  if (!f.audioClips) Object.assign(f, freshProjectData());   // bài mới/l cũ chưa có dữ liệu riêng
  state.activeFolderId = f.id;
  state.audioClips = f.audioClips;
  state.lanes = f.lanes;
  state.recLaneId = f.recLaneId || null;
  const p = f.pstate || {};
  state.fps = p.fps || 30; $('fpsSel').value = String(state.fps);
  state.speed = p.speed || 1; $('speedSel').value = String(state.speed);
  state.loop = !!p.loop;                                  // updateTransport() sẽ chấm nút ⟲
  state.playbackEndMode = p.playbackEndMode === 'contentEndPlus10' ? 'contentEndPlus10' : 'infinite';
  const pe = $('playEndSel'); if (pe) pe.value = state.playbackEndMode;
  state.autoAdvance = p.autoAdvance !== false;
  masterVol = typeof p.masterVol === 'number' ? p.masterVol : 0.9;
  $('vol').value = String(masterVol);
  audio.volume = masterVol;
  state.rowH = p.rowH || 46; state.aRowH = p.aRowH || clamp(Math.round(state.rowH * 1.6), 30, 150);
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
  return { id: nid(), address, args: args || [1], name: '', nameEdited: false, note: '', color: '', colorManual: false, mode: 'trigger' };
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
    // 🎨 đổi màu → NGUYÊN KHUNG bài nhận màu NHẠT (nền 12%, viền 55%) — như mockup đã duyệt
    if (f.color) {
      div.style.background = f.color + '1F';
      div.style.borderColor = f.color + '8C';
    }

    const head = document.createElement('div');
    head.className = 'fhead';
    if (f.color) head.style.background = f.color + '38';
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
    head.append(chev, name, cnt, colBtn, del);
    head.addEventListener('click', (e) => {
      if (e.target === name || e.target === del || e.target === colBtn || e.target === chev) return;
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
  // THƯ VIỆN DÙNG CHUNG: gỡ MỌI tham chiếu của bài vừa xóa ở TẤT CẢ các bài
  // (lane trỏ source + instance clip trên timeline — không để lại clip mồ côi)
  const af = curFolder();
  state.folders.forEach((fo) => {
    (fo.lanes || []).forEach((l) => {
      if (l.songId === song.id) { l.songId = null; l.songOffset = 0; l.songEnd = 0; }
    });
    if (fo === af) return;   // bài đang mở: mảng clip sống trong state — xử lý ngay dưới
    fo.audioClips = (fo.audioClips || []).filter((c) => c.songId !== song.id);
  });
  // xóa mọi INSTANCE đang dùng source này (source hết → instance mồ côi phải đi theo;
  // các instance dùng source KHÁC hoàn toàn không đụng tới)
  state.audioClips = state.audioClips.filter((c) => c.songId !== song.id);
  if (af) af.audioClips = state.audioClips;   // giữ tham chiếu mảng sống với bài đang mở
  if (state.selClipId && !audioClipById(state.selClipId)) state.selClipId = null;
  if (state.clipboardAudio && state.clipboardAudio.songId === song.id) state.clipboardAudio = null;
  // dừng hẳn âm thanh đang phát của bài vừa xóa — không để tiếng vẫn vang
  pause();
  if (audioSongId === song.id) audioSongId = null;
  if (wasActive) { audio.removeAttribute('src'); audio.load(); }
  if (preview.songId === song.id) previewStop();   // đang nghe thử bài vừa xóa → dừng luôn
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
      audio.src = fileUrl(song.path);
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
  // Tên bài dưới thanh timeline đã bỏ theo thiết kế mới — giữ hàm cho các nơi gọi không lỗi
}

/* Định dạng file nhạc từ đuôi file → pill màu (MP3 tím, WAV ngọc,…) */
function songFmt(path) {
  const m = /\.([a-z0-9]+)$/i.exec(path || '');
  const ext = m ? m[1].toLowerCase() : '';
  const known = ['mp3', 'wav', 'aiff', 'aif', 'm4a', 'aac', 'flac', 'ogg'];
  return { label: ext ? ext.toUpperCase() : 'FILE', cls: 'fmt-' + (known.includes(ext) ? ext : 'other') };
}

/* nghe thử bài hát — tách khỏi engine timeline (khai báo sớm vì renderSongs dùng) */
const preview = { audio: new Audio(), songId: null, raf: null };

function renderSongs() {
  const box = $('songList');
  box.innerHTML = '';
  $('songCount').textContent = state.songs.length;   // badge số lượng bài hát đã thêm
  const q = state.songSearch.toLowerCase();
  state.songs.forEach((song, i) => {
    if (q && !song.name.toLowerCase().includes(q) && !String(i + 1).includes(q)) return;
    const item = document.createElement('div');
    item.className = 'song-item' + (i === state.songIndex ? ' active' : '') +
      (preview.songId != null && song.id === preview.songId ? ' previewing' : '');
    item.dataset.songIdx = i;
    item.draggable = true;

    const info = document.createElement('div');
    info.className = 'sinfo';
    const nm = document.createElement('div');
    nm.className = 'sname';
    nm.textContent = `${i + 1}. ${song.name}`;
    nm.title = song.name + ' — nhấp để lấy làm mốc thời gian, kéo vào timeline để đặt';
    const meta = document.createElement('div');
    meta.className = 'smeta';
    const fmt = songFmt(song.path);
    const pill = document.createElement('span');
    pill.className = 'fmt-pill ' + fmt.cls;
    pill.textContent = fmt.label;
    const dur = document.createElement('span');
    dur.className = 'sdim';
    dur.textContent = fmtDur(song.duration);
    meta.append(pill, dur);
    if (song.size) {
      const size = document.createElement('span');
      size.className = 'sdim';
      size.textContent = '· ' + fmtSize(song.size);
      meta.append(size);
    }
    info.append(nm, meta);

    const pre = document.createElement('span');
    pre.className = 'spre';
    const sprog = document.createElement('div');
    sprog.className = 'sprog';
    const sprogFill = document.createElement('i');
    sprog.appendChild(sprogFill);

    const del = document.createElement('button');
    del.className = 'sdel';
    del.textContent = '🗑';
    del.title = 'Xóa khỏi danh sách nhạc';
    del.addEventListener('click', (e) => { e.stopPropagation(); removeSong(song.id); });

    item.append(info, pre, del, sprog);
    item.addEventListener('click', (e) => {
      if (e.target === del) return;
      // CHỌN = lấy làm mốc thời gian — KHÔNG reset playhead
      // Nếu ĐANG PHÁT bài khác → chuyển sang phát chính bài vừa chọn (giữ viền vàng theo bài đang phát)
      const wasPlaying = !preview.audio.paused;
      activateSong(i, false, true);
      if (wasPlaying) previewStart(true); else previewSetState(false);
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
  syncPreviewButtons();
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
  if (recActiveSession !== null) {
    pause(true);
    setStatus('REC đang chốt phiên sau khi tua; bấm Play để ghi tiếp khi đã chốt.');
  }
  // playhead được phép vượt QUÁ điểm cuối timeline (chỉ khoá dưới 0) — không khíng ở 03:00
  state.frame = Math.max(0, f);
  playbackLastFrame = null;
  playback.seek(state.frame);
  clockReset(state.frame);          // reset mốc clock: seek/scrub không bao giờ làm audio phát lại
  audioClipId = null;               // lần vào clip kế tiếp sẽ seek đúng 1 lần
  // đang dừng: xem trước âm thanh bám theo clip dưới thanh đò
  if (!state.playing) {
    const clip = findClipAtFrame(state.frame);   // trước đây dùng biến chưa khai báo → ReferenceError khi ⏹/seek
    const local = clip ? clamp(clip.srcStart + (state.frame / state.fps - clip.tlStart), 0, Math.max(0, clip.srcEnd - 0.02)) : 0;
    if (clip && audioSongId === clip.song.id && audio.paused && !audio.ended) {
      if (Math.abs(audio.currentTime - local) > 0.05) audio.currentTime = local;
    }
  }
  state.playbackIdx = lowerBoundFlat(state.frame);
  pushOscMode(true);
}

function lanControl(cmd) {
  if (typeof oscUI === 'undefined' || !oscUI.lanOn || oscUI.lanRole !== 'master') return;
  try { window.hs.lanSendControl(cmd); } catch (_) {}
}

function play() {
  if (recTransactions.size && recActiveSession === null) {
    setStatus('REC đang chốt phiên, vui lòng chờ xác nhận.');
    return;
  }
  if (state.playing) return;
  // 'contentEndPlus10' + nội dung vượt 3 phút: đứng quá điểm dừng → về 0 khi bấm Play;
  // 'infinite' HOẶC nội dung ≤ 3 phút: phát tiếp từ chỗ playhead đang đứng, không tự dừng
  const pe = playbackEndFrames();
  if ((state.playbackEndMode || 'infinite') === 'contentEndPlus10' && isFinite(pe) && state.frame >= pe) setFrame(0);
  // timeline phát → dừng nghe thử để không phát chồng 2 nguồn
  if (!preview.audio.paused) { preview.audio.pause(); previewSetState(false); }
  refreshPlaybackSchedule();
  playback.seek(playbackPosition());
  clockReset(state.frame);     // mốc monotonic tính từ vị trí bắt đầu phát
  audioClipId = null;          // cho phép seek đúng 1 lần khi vào clip
  state.playing = true;
  pushOscMode();
  // nhạc do tick() bật khi playhead đi vào clip — timeline luôn chạy từ vị trí thanh đò
  updateTransport();
  lanControl('play');
}

function pause(silent) {
  playback.stop();
  recFinalizeOpen();
  state.playing = false;
  pushOscMode();
  clock.valid = false;
  audioClipId = null;   // lần play sau seek lại đúng chỗ đang đứng
  audio.pause();
  updateTransport();
  if (!silent) lanControl('pause');
}

function stop() { pause(true); lanControl('stop'); setFrame(0); }
function togglePlay() { state.playing ? pause() : play(); }

/* ================= Phát cue ================= */
let playbackKey = null;
let playbackFps = null;
let playbackLastFrame = null;
const playback = new window.HSPlayback.PlaybackScheduler({
  config: REC_CFG,
  send: (address, args, target, context) => sendOsc(address, args, target, { ...context, origin: 'playback' })
});

function playbackPosition() {
  // A refresh/resume must not replay an already-consumed start at this exact frame.
  return state.frame === playbackLastFrame
    ? state.frame + Number.EPSILON * Math.max(1, Math.abs(state.frame)) : state.frame;
}

function refreshPlaybackSchedule() {
  const defs = new Map((curFolder()?.cues || []).map((def) => [def.id, def]));
  const cues = flat.map(({ t, ev }) => {
    const def = defs.get(ev.cueId) || {};
    const meta = ev.recMeta || {};
    const first = (meta.keyframes || []).find((point) => Array.isArray(point.args));
    const valueIndex = first ? first.args.findIndex((value) => typeof value === 'number' && value === first.value) : -1;
    return { id: ev.id, frame: t, duration: ev.duration, mode: def.mode,
      address: def.address, args: def.args, enabled: ev.enabled !== false && def.enabled !== false,
      pending: !!(ev.recording || ev.pending || meta.pending), unassigned: !!meta.unassigned,
      keyframes: meta.keyframes, dataOrigin: meta.dataOrigin, curveOrigin: meta.curveOrigin,
      valueIndex: meta.numericIndex ?? def.valueIndex ?? (valueIndex < 0 ? undefined : valueIndex),
      interpolation: meta.interpolation || def.interpolation,
      preserveRecordedEndpoint: meta.captureEndpoint === true && !meta.curveEdited && !meta.trimmed,
      recordingSpeed: meta.recordingSpeed, outputTarget: def.outputTarget ?? def.target };
  });
  const key = JSON.stringify([state.activeFolderId, state.fps,
    REC_CFG.PLAYBACK_FLOAT_HZ, REC_CFG.PIANO_END_ACTION, cues]);
  if (key === playbackKey) return;
  if (playback.generation !== state.activeFolderId) playbackLastFrame = null;
  Object.assign(playback.config, window.HSRealtime, REC_CFG);
  const preserved = state.playing && playback.reconcile(cues, { fps: state.fps,
    generation: state.activeFolderId, fromFrame: state.frame, inclusive: state.frame !== playbackLastFrame });
  if (!preserved) {
    playback.load(cues, { fps: state.fps, generation: state.activeFolderId });
    playback.seek(playbackPosition());
  }
  playbackKey = key;
  playbackFps = state.fps;
}

function fireDue() {
  if (playbackFps !== state.fps) refreshPlaybackSchedule();
  const frame = state.frame === playbackLastFrame ? Math.max(state.frame, playback.frame) : state.frame;
  playback.step(frame, undefined, { playing: state.playing, speed: state.speed });
  if (state.playing) playbackLastFrame = state.frame;
}

function nextCue() {
  // giống 404 TimeCode: chỉ chọn cue CHƯA bắt đầu (start > playhead), gần nhất
  for (const x of refreshVF()) {
    if (x.ev.enabled === false) continue;
    if (x.t > state.frame) return x;
  }
  return null;
}

function sendOsc(address, args, outputTarget, context) {
  const targets = typeof oscUI === 'undefined' ? [] : oscUI.targets;
  let targetIds;
  if (outputTarget != null) {
    const selected = Array.isArray(outputTarget) ? outputTarget : [outputTarget];
    targetIds = targets.filter((target) => target.enabled !== false && selected.some((item) =>
      (item && typeof item === 'object' ? item.id : item) === target.id)).map((target) => target.id);
    if (!targetIds.length) return;
  } else if (targets.length && !targets.some((target) => target.enabled !== false)) return;
  if (context?.origin === 'playback' && oscPort) {
    try { oscPort.post({ type: 'recTx', address, args, t: performance.timeOrigin + performance.now() }); } catch (_) {}
  }
  window.hs.send(address, args, state.target.host, state.target.port, targetIds)
    .then(() => monRow(address, args, true))
    .catch((e) => setStatus('Gửi OSC lỗi: ' + e.message));
}

/* ================= Ghi OSC ================= */
function refreshAll() {
  recNormalizeLanes();
  syncOscFloatAddresses();
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
  if (!msg || !msg.address) return;
  if (msg.session !== undefined && msg.session !== oscSession) return;
  if (msg.record === true && !(state.recArmed && state.playing)) return;
  rxLocal++;
  if (state.midiPadMode === 'learn' || oscCaptureSeen) midiPadLearn(msg.address, msg.args);
}

/* Gom refresh UI cho REC nguồn OSC (giữ ĐÚNG số cue/thứ tự/timestamp + Undo/autosave) */
const REC_UI_FLUSH_MS = REC_CFG.REC_UI_FLUSH_MS;
let oscRecDirty = false;
let oscRecFlushTimer = null;
let oscRecLastStatus = 0;
function flushOscRecUi() {
  if (oscRecFlushTimer) { clearTimeout(oscRecFlushTimer); oscRecFlushTimer = null; }
  if (!oscRecDirty) return;
  oscRecDirty = false;
  refreshAll();
  const now = performance.now();
  if (now - oscRecLastStatus > REC_CFG.REC_STATUS_INTERVAL_MS) {   // không spam flashStatus mỗi packet
    oscRecLastStatus = now;
    const f = curFolder();
    if (f) flashStatus(`REC MIDI + OSC → ${f.name} · ${tcString(state.frame, state.fps)}`);
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
const GUT = 84, TOP = 30;

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

function cueCurveSpeed(ev) {
  const speed = ev.recMeta && ev.recMeta.recordingSpeed;
  return Number.isFinite(speed) && speed > 0 ? speed : 1;
}

function cueCurveOptions(ev) {
  const meta = ev.recMeta || {};
  return { interpolation: meta.interpolation || 'linear', numericIndex: meta.numericIndex };
}

function cueCurvePoints(ev, meta = ev.recMeta, duration = ev.duration) {
  const points = window.HSCurveTools.cloneCueMetadata({ keyframes: (meta && meta.keyframes) || [] }).keyframes;
  if (!points.length || meta.captureEndpoint !== true || meta.curveEdited || meta.trimmed) return points;
  const scale = state.fps * cueCurveSpeed(ev) / 1000;
  const lastFrame = points[points.length - 1].dt * scale;
  // Match playback's one-frame capture rounding correction; edits never fit curves.
  if (lastFrame > duration && lastFrame - duration < 1) {
    const endMs = duration / scale;
    for (const point of points) point.dt = point.ms = Math.min(point.dt, endMs);
  }
  return points;
}

function trimCueCurve(ev, startFrames, durationFrames, sourceMeta = ev.recMeta, sourceDuration = ev.duration) {
  if (!sourceMeta || !Array.isArray(sourceMeta.keyframes)) return;
  ev.recMeta = window.HSCurveTools.cloneCueMetadata(sourceMeta);
  const framesPerSecond = state.fps * cueCurveSpeed(ev);
  ev.recMeta.keyframes = window.HSCurveTools.trim(cueCurvePoints(ev, sourceMeta, sourceDuration),
    Math.max(0, startFrames) * 1000 / framesPerSecond,
    Math.max(0, startFrames + durationFrames) * 1000 / framesPerSecond, cueCurveOptions(ev));
  ev.recMeta.keyframesSent = ev.recMeta.keyframes.length;
  ev.recMeta.captureEndpoint = false;
}

function cloneCuePlacement(src, frame, folder, copyDefinition = !!src.recMeta) {
  const cue = { ...structuredClone(src), id: nid(), frame };
  if (src.recMeta) cue.recMeta = window.HSCurveTools.cloneCueMetadata(src.recMeta);
  if (copyDefinition) {
    const original = folder.cues.find((d) => d.id === src.cueId)
      || state.folders.flatMap((f) => f.cues).find((d) => d.id === src.cueId);
    if (!original) return null;
    const def = { ...structuredClone(original), id: nid() };
    folder.cues.push(def);
    cue.cueId = def.id;
  }
  return cue;
}

function splitCuePlacement(folder, ev, cutFrame, endFrame) {
  const start = folder.offset + ev.frame;
  const right = cloneCuePlacement(ev, cutFrame - folder.offset, folder, false);
  if (!right) return null;
  // Splitting keeps the definition shared; the two curve payloads are independent.
  const meta = ev.recMeta;
  if (meta && Array.isArray(meta.keyframes)) {
    const framesPerSecond = state.fps * cueCurveSpeed(ev);
    const parts = window.HSCurveTools.split(cueCurvePoints(ev, meta, endFrame - start), (cutFrame - start) * 1000 / framesPerSecond,
      { ...cueCurveOptions(ev), durationMs: (endFrame - start) * 1000 / framesPerSecond });
    ev.recMeta = window.HSCurveTools.cloneCueMetadata(meta);
    ev.recMeta.keyframes = parts.left;
    right.recMeta.keyframes = parts.right;
    ev.recMeta.keyframesSent = parts.left.length;
    right.recMeta.keyframesSent = parts.right.length;
    ev.recMeta.captureEndpoint = right.recMeta.captureEndpoint = false;
  }
  ev.duration = cutFrame - start;
  right.duration = endFrame - cutFrame;
  insertCue(folder, right);
  return right;
}

function resolveCueEditLane(folder, ev) {
  const def = folder.cues.find((d) => d.id === ev.cueId);
  const kind = (ev.recMeta && ev.recMeta.kind) || (def && def.mode);
  if (kind !== 'float' && kind !== 'piano') return;
  const lanes = folder.id === state.activeFolderId ? state.lanes : folder.lanes;
  const lane = lanes.find((l) => l.name === ev.lane);
  if (!lane) return;
  const collides = (target) => folder.events.some((other) => other !== ev && other.lane === target.name
    && other.frame < ev.frame + Math.max(1, ev.duration) && other.frame + Math.max(1, other.duration) > ev.frame);
  if (!collides(lane)) return;
  let target = lanes.find((l) => l !== lane && l.kind === lane.kind && !l.locked
    && l.recGroup === lane.recGroup && !collides(l));
  if (!target) {
    let n = 1;
    while (lanes.some((l) => l.name === lane.kind + n)) n++;
    target = { ...lane, id: nid(), name: lane.kind + n, locked: false,
      autoRec: true, manual: false, auxiliary: true, auxOf: lane.auxOf || lane.id };
    lanes.splice(lanes.indexOf(lane) + 1, 0, target);
  }
  ev.lane = target.name;
  ev.laneId = target.id;
  ev.manualLane = true;
  folder.lanes = lanes;
}

function moveCueDrag(drag, x, y) {
  const lanes = drag.lanes;
  const row = hitLaneRow(y);
  const anchor = drag.items.find((item) => item.ev === drag.ev);
  let delta = Math.round(xToFrame(x) - drag.grabF) - (drag.folder.offset + drag.f0);
  delta = Math.max(delta, -Math.min(...drag.items.map((item) => item.frame)));
  let laneDelta = row && !row.isAudio ? lanes.findIndex((l) => l.id === row.id) - anchor.laneIndex : 0;
  laneDelta = clamp(laneDelta, -Math.min(...drag.items.map((item) => item.laneIndex)),
    lanes.length - 1 - Math.max(...drag.items.map((item) => item.laneIndex)));
  if (drag.items.some((item) => lanes[item.laneIndex + laneDelta].locked)) laneDelta = 0;
  for (const item of drag.items) {
    item.ev.frame = item.frame + delta;
    const lane = lanes[item.laneIndex + laneDelta];
    item.ev.lane = lane.name;
    item.ev.laneId = lane.id;
    if (laneDelta) item.ev.manualLane = true;
    else if (item.manualLane === undefined) delete item.ev.manualLane;
    else item.ev.manualLane = item.manualLane;
  }
}

function drawCueCurve(ev, startFrame, row, left, right) {
  const meta = ev.recMeta;
  if (!meta || meta.kind !== 'float' || !Array.isArray(meta.keyframes) || !meta.keyframes.length) return;
  const points = cueCurvePoints(ev).filter((p) => Number.isFinite(p.value) && Number.isFinite(p.dt ?? p.ms));
  if (!points.length || right <= left) return;
  let low = 0, high = 1;
  for (const point of points) { low = Math.min(low, point.value); high = Math.max(high, point.value); }
  const top = row.y + 17, height = Math.max(3, row.h - 29);
  const px = (dt) => frameToX(startFrame + dt * state.fps * cueCurveSpeed(ev) / 1000);
  const py = (value) => top + (1 - (value - low) / (high - low)) * height;
  ctx.save();
  ctx.beginPath(); ctx.rect(left, row.y + 2, right - left, row.h - 10); ctx.clip();
  ctx.strokeStyle = '#ffffff'; ctx.fillStyle = '#ffffff'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  points.forEach((point, i) => {
    const dt = point.dt ?? point.ms;
    if (!i) { ctx.moveTo(px(dt), py(point.value)); return; }
    const previous = points[i - 1], from = previous.dt ?? previous.ms;
    if (meta.interpolation === 'step') ctx.lineTo(px(dt), py(previous.value));
    if (meta.interpolation === 'ease') {
      for (let j = 1; j < 8; j++) {
        const t = j / 8, eased = t * t * (3 - 2 * t);
        ctx.lineTo(px(from + (dt - from) * t), py(previous.value + (point.value - previous.value) * eased));
      }
    }
    ctx.lineTo(px(dt), py(point.value));
  });
  ctx.stroke();
  for (const point of points) {
    const x = px(point.dt ?? point.ms);
    if (x < left || x > right) continue;
    ctx.beginPath(); ctx.arc(x, py(point.value), 2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawRecPreview(rows, width, height) {
  for (const [session, live] of recLive) {
    const tx = recTransactions.get(session);
    if (!tx || tx.folderId !== state.activeFolderId) continue;
    const folder = state.folders.find((f) => f.id === tx.folderId);
    if (!folder) continue;
    for (const item of live.items.values()) {
      const group = window.HSCueLayout.laneKeyFor(item, state.laneGroupMode);
      const lane = state.lanes.find((l) => l.kind === 'R' && !l.locked && l.recGroup === group)
        || state.lanes.find((l) => l.kind === 'R' && !l.locked && l.id === live.laneId)
        || state.lanes.find((l) => l.kind === 'R' && !l.locked);
      const row = lane && rows.find((r) => r.id === lane.id);
      if (!row || row.y + row.h <= TOP || row.y >= height) continue;
      const start = folder.offset + Math.max(0, item.startFrame - tx.offset);
      const x1 = frameToX(start), x2 = frameToX(start + Math.max(1, item.durationFrames));
      if (x2 < GUT || x1 > width) continue;
      const left = Math.max(GUT, x1), right = Math.min(width, Math.max(x2, x1 + 3));
      if (right <= left) continue;
      const color = !item.address ? '#ffb36b'
        : item.kind === 'float' ? '#b58aff' : item.kind === 'piano' ? '#55d5ad' : '#70aaff';
      ctx.save();
      ctx.beginPath(); ctx.rect(left, row.y + 2, right - left, row.h - 10); ctx.clip();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.24;
      ctx.fillRect(left, row.y + 2, right - left, row.h - 10);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(left + .5, row.y + 2.5, Math.max(1, right - left - 1), row.h - 11);
      ctx.setLineDash([]);
      drawCueCurve(item.cue, start, row, left, right);
      if (right - left > 30) {
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px Menlo, monospace';
        ctx.textBaseline = 'middle';
        const label = 'REC ' + window.HSCueLayout.resolveCueName(item.address, item);
        ctx.fillText(label.slice(0, Math.floor((right - left - 8) / 7)), left + 5,
          item.kind === 'float' ? row.y + 12 : row.y + (row.h - 6) / 2);
      }
      ctx.restore();
    }
  }
}

function timelineRows() {
  const rows = state.lanes.map((l) => ({
    lane: l.name, id: l.id, kind: l.kind, songId: l.songId,
    h: l.kind === 'A' ? state.aRowH : state.rowH, isAudio: l.kind === 'A'
  }));
  let y = TOP + 6 - (state.viewY || 0);   // cuộn dọc: dịch cả bảng lane lên khi viewY > 0
  rows.forEach((r) => { r.y = y; y += r.h; });
  return rows;
}

/* Chiều cao nội dung lane (từ mép trên đến hết lane cuối) — cho cuộn dọc */
function tlContentH() {
  return TOP + 6 + state.lanes.reduce((a, l) => a + (l.kind === 'A' ? state.aRowH : state.rowH), 0) + 8;
}
function clampViewY() {
  if (!canvas || !canvas.clientHeight) return;
  const max = Math.max(0, tlContentH() - (canvas.clientHeight - TOP - 14));
  state.viewY = clamp(state.viewY || 0, 0, max);
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
    // Zoom NGANG mặc định 70% (thanh RỘNG ở 70/100 — CapCut-style); chỉ scale hiển thị, không đụng dữ liệu
    state.pps = sliderToPps(70);
    state.ppsInit = true;
    state.lastTotalSec = dur;
  }
  if (state.pps) clampView();
  clampViewY();
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

  // lane: HÀNG NGANG 🔓 | TÊN(màu theo loại) | 🗑 — không chồng chữ (theo giao diện duyệt)
  // CLIP: vùng lane nằm dưới thước — cuộn dọc thì lane trượt lên nhưng không đè thước
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, TOP, W, H - TOP);
  ctx.clip();
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
    const cy = r.y + (r.h - 6) / 2;
    // 🔓 khóa — TRÁI (đang khóa = vàng cam sáng)
    ctx.font = '13px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = locked ? '#ffb36b' : 'rgba(255,255,255,.35)';
    ctx.fillText(locked ? '🔒' : '🔓', 10, cy);
    // TÊN lane — cạnh lock, căn trái, màu theo loại: V đỏ · A xanh dương · R vàng
    ctx.font = 'bold 14px -apple-system, sans-serif';
    ctx.fillStyle = r.isAudio ? '#6fa2ff' : (r.kind === 'R' ? ((laneObj && laneObj.color) || '#ffd24a') : '#ff6b6b');
    ctx.fillText(r.lane, 33, cy);
    // 🗑 xóa lane — SÁT MÉP PHẢI gutter, mờ đi cho đỡ rối
    ctx.font = '12px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,.30)';
    ctx.fillText('🗑', GUT - 12, cy);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
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
    // kẹp CẢ HAI mép theo viewport: bx…bx2 luôn là phần nhìn thấy thật của cue
    // (trước đây chỉ kẹp bx mà giữ bw gốc → phần đã cuộn qua bị cộng bù, cue trôi/dài ra)
    const bx = Math.max(x1, GUT), bx2 = Math.min(x2, W);
    const bw = Math.max(3, bx2 - bx - 2);
    const isSelected = selSet().has(x.ev);
    const isHidden = x.ev.enabled === false;
    ctx.fillStyle = cueColor(x.ev, x.f);
    const isRec = !!x.ev.recording;
    ctx.globalAlpha = isRec ? 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(performance.now() / 180))
      : (isSelected ? 0.9 : (isHidden ? 0.30 : 0.85));
    ctx.fillRect(bx, row.y + 2, bw, row.h - 10);
    ctx.globalAlpha = 1;
    drawCueCurve(x.ev, x.t, row, bx, bx2);
    if (isRec) {
      // cue đang ghi: viền trắng nhấp nháy
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = 2;
      ctx.strokeRect(bx + 1, row.y + 3, Math.max(2, bw - 2), row.h - 12);
      ctx.lineWidth = 1;
    }
    // cue chưa gán OSC: viền cảnh báo đỏ
    if (x.ev.recMeta && x.ev.recMeta.unassigned && !isRec) {
      ctx.strokeStyle = 'rgba(255,90,90,.85)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx + .75, row.y + 2.75, Math.max(2, bw - 1.5), row.h - 10.5);
      ctx.lineWidth = 1;
    }
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
      const color = cueColor(x.ev, x.f);
      ctx.fillStyle = /^#[\da-f]{6}$/i.test(color) ? window.HSCueLayout.textColor(color) : '#0b0b0e';
      ctx.font = 'bold 12px Menlo, monospace';
      const label = cueLabel(x.ev, x.f);
      ctx.fillText(label.slice(0, Math.floor(bw / 7.5)), bx + 7,
        x.ev.recMeta && x.ev.recMeta.kind === 'float' ? row.y + 13 : row.y + (row.h - 6) / 2);
    }
  });

  drawRecPreview(rows, W, H);
  ctx.restore();   // hết clip vùng lane — thanh đò vẽ đè tự do như cũ

  if (dragInfo && dragInfo.box && dragInfo.end) {
    ctx.fillStyle = 'rgba(79,140,255,.15)'; ctx.strokeStyle = '#8db5ff';
    const left = Math.max(GUT, Math.min(dragInfo.x, dragInfo.end.x));
    const top = Math.max(TOP, Math.min(dragInfo.y, dragInfo.end.y));
    const width = Math.max(0, Math.max(dragInfo.x, dragInfo.end.x) - left);
    const height = Math.max(0, Math.max(dragInfo.y, dragInfo.end.y) - top);
    ctx.fillRect(left, top, width, height); ctx.strokeRect(left, top, width, height);
  }

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

  // ===== CẮT NHANH — PREVIEW TRÊN CANVAS: dòng đỏ tại điểm cắt + phủ đỏ vùng phía sau sẽ bị bỏ + biểu tượng kéo =====
  if (state.tlTool === 'quickcut' && qcHover && state.pps) {
    const q = qcHover;
    const ry = q.row.y, rh = q.row.h;
    const cx1 = Math.max(q.cx1, GUT), cx2 = Math.max(q.cx2, GUT);
    const cutX = frameToX(q.cutF);
    if (!q.locked && cutX > cx1 + 1 && cutX < cx2 - 1) {
      // vùng phía SAU điểm cắt = phần sẽ bị bỏ: phủ đỏ mờ + viền
      ctx.fillStyle = 'rgba(255, 59, 48, .20)';
      ctx.fillRect(cutX, ry + 1, cx2 - cutX, rh - 6);
      ctx.strokeStyle = 'rgba(255, 59, 48, .55)';
      ctx.lineWidth = 1;
      ctx.strokeRect(cutX + .5, ry + 1.5, cx2 - cutX - 1, rh - 7);
      // thanh đỏ tại ĐIỂM CẮT — ngay trong cue/clip
      ctx.fillStyle = '#ff3b30';
      ctx.fillRect(cutX - 1, ry + 1, 3, rh - 6);
      // biểu tượng kéo cắt ngay trên điểm cắt
      ctx.fillStyle = '#ff3b30';
      ctx.font = 'bold 13px "Segoe UI Emoji", -apple-system, sans-serif';
      ctx.fillText('✂', cutX - 5, ry + 14);
    }
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
  } else {    sbThumb = null;
  }

  // SCROLLBAR DỌC bên phải — chỉ hiện khi các lane cao hơn khung nhìn
  const contentH = tlContentH();
  const viewH = H - TOP - 14;
  if (contentH > viewH) {
    const trackX = W - 12, trackW = 10;
    const trackY = TOP, trackH = viewH;
    const th = Math.max(36, (viewH / contentH) * trackH);
    const ty = trackY + (state.viewY / Math.max(1, contentH - viewH)) * (trackH - th);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(trackX, trackY, trackW, trackH);
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    ctx.fillRect(trackX + 2, ty, trackW - 4, th);
    sbVThumb = { x: trackX, y1: ty, y2: ty + th, trackY, trackH };
  } else { sbVThumb = null; }
}

/* Tương tác timeline */
let dragInfo = null;      // pan / click / scrub
let blockDrag = null;     // kéo khối cue
let clipDrag = null;      // kéo/sửa clip nhạc instance: {mode:'move'|'resize-l'|'resize-r', clip, startX, tl0, ss0, se0, moved}
let sbThumb = null;       // scrollbar ngang vẽ trên canvas (CapCut-style)
let sbDrag = null;        // đang kéo scrollbar: {grabOff, trackW}
let sbVThumb = null;      // scrollbar DỌC bên phải: {x, y1, y2, trackY, trackH}
let sbVDrag = null;       // đang kéo scrollbar dọc: {grabOff}
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
  state.tlTool = (mode === 'cut' || mode === 'quickcut') ? mode : 'select';
  const s = $('toolSelect'), c = $('toolCut'), q = $('btnQuickCut');
  if (s) s.classList.toggle('on', state.tlTool === 'select');
  if (c) c.classList.toggle('on', state.tlTool === 'cut');
  if (q) q.classList.toggle('on', state.tlTool === 'quickcut');
  qcHover = null;
  canvas.style.cursor = state.tlTool === 'select' ? '' : 'crosshair';
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
  if (y < TOP) return null;   // vùng thước: không trúng lane kể cả khi lane đã cuộn trượt lên
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
  const labelRow = x < GUT ? hitLaneRow(y) : null;
  const labelLane = labelRow && laneById(labelRow.id);
  canvas.title = labelLane ? labelLane.name + (labelLane.groupLabel ? ' · ' + labelLane.groupLabel : '') : '';
  // PAN an toàn: chuột GIỮA — pan ngay cả khi trúng cue/clip (không dời dữ liệu)
  if (e.button === 1) {
    dragInfo = { x, y, moved: false, viewStart0: state.viewStart, pan: true };
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
    return;
  }
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
  // SCROLLBAR DỌC bên phải — kéo thumb để cuộn, bấm track để nhảy
  if (sbVThumb && x >= sbVThumb.x && y >= sbVThumb.trackY && y <= sbVThumb.trackY + sbVThumb.trackH) {
    const th = sbVThumb.y2 - sbVThumb.y1;
    const inThumb = y >= sbVThumb.y1 && y <= sbVThumb.y2;
    sbVDrag = { grabOff: inThumb ? (y - sbVThumb.y1) : th / 2 };
    if (!inThumb) {
      const max = Math.max(0, tlContentH() - (canvas.clientHeight - TOP - 14));
      state.viewY = ((y - sbVThumb.trackY - th / 2) / Math.max(1, sbVThumb.trackH - th)) * max;
      clampViewY();
    }
    canvas.style.cursor = 'ns-resize';
    return;
  }
  // gutter lane: 🔓 khóa (vùng TRÁI) · 🗑 xóa lane (vùng PHẢI, theo icon vẽ tại GUT-12) — giữa là tên, không làm gì
  if (x >= 0 && x <= GUT - 6) {
    const row = hitLaneRow(y);
    if (row) {
      if (x <= 26) { toggleLaneLock(row.id); return; }
      if (x >= GUT - 26) { removeLane(row.id); return; }
      return;
    }
  }
  // ===== CHẾ ĐỘ CẮT NHANH: CLICK vào cue/clip = GIỮ phần TRƯỚC điểm click, BỎ phần SAU =====
  // Khác tool ✂ (chia 2): cắt nhanh là trim một phía — tail bị bỏ ngay, không sinh segment mới.
  // Vẫn khôi phục được: kéo mép phải ở chế độ Chọn để lấy lại phần đã cắt (audio lấy từ source).
  if (state.tlTool === 'quickcut') {
    const cutF = Math.max(0, Math.round(xToFrame(x)));
    const aHit = audioClipHit(x, y);
    if (aHit) {
      if (aHit.laneObj && aHit.laneObj.locked) { flashStatus(`Lane ${aHit.row.lane} đang khóa — không cắt được.`); return; }
      const c = aHit.clip;
      const len = clipLen(c) || (aHit.song.duration > 0 ? aHit.song.duration : 120);
      const tEnd = c.tlStart + len;
      const cutTl = cutF / state.fps;
      if (cutTl <= c.tlStart + 0.05 || cutTl >= tEnd - 0.05) {
        flashStatus('Điểm cắt quá sát mép clip — rê vào GIỮA clip để bỏ phần sau.');
        return;
      }
      c.srcEnd = c.srcStart + (cutTl - c.tlStart);   // trim đuôi: srcEnd về điểm cắt (source giữ nguyên → kéo mép lấy lại được)
      state.selClipId = c.id; state.sel = null; state.multiSel = new Set();
      refreshAll(); renderProps(); updateSelBar(); scheduleAutosave();
      flashStatus(`✂ Đã bỏ phần sau từ ${tcString(cutF, state.fps)} — clip còn "${aHit.song.name}" đến đây (kéo mép phải để lấy lại).`);
      return;
    }
    const hit = hitCueBlock(x, y);
    if (hit && x >= GUT) {
      const ev = hit.fx.ev;
      const f = state.folders.find((fo) => fo.events.includes(ev));
      if (!f) { flashStatus('Cue chưa thuộc thư mục nào.'); return; }
      if (laneLockedByName(hit.row.lane)) { flashStatus(`Lane ${hit.row.lane} đang khóa — không cắt được.`); return; }
      const endF = eventEndFrame(hit.fx);
      if (cutF <= hit.fx.t + 1 || cutF >= endF - 1) {
        flashStatus('Điểm cắt quá sát mép cue — rê vào GIỮA cue để bỏ phần sau.');
        return;
      }
      noteChange();
      trimCueCurve(ev, 0, cutF - hit.fx.t);
      ev.duration = cutF - hit.fx.t;
      state.sel = ev; state.selClipId = null; state.multiSel = new Set();
      refreshAll(); renderProps(); updateSelBar(); scheduleAutosave();
      flashStatus(`✂ Đã bỏ phần sau từ ${tcString(cutF, state.fps)} — curve đã trim, không stretch.`);
      return;
    }
    flashStatus('Cắt nhanh: rê chuột vào cue/clip (thấy dòng đỏ xem trước) rồi click để bỏ phần phía sau.');
    return;
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
        noteChange();
        splitCuePlacement(f, ev, cutF, endF);
        refreshAll(); scheduleAutosave();
        flashStatus(`Đã chia cue tại ${tcString(cutF, state.fps)} — 2 đoạn dùng cùng cue gốc, curve độc lập.`);
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
    const selected = mode === 'move' && selSet().has(hit.fx.ev) ? [...selSet()] : [hit.fx.ev];
    const lanes = state.lanes.filter((lane) => lane.kind !== 'A');
    blockDrag = {
      ev: hit.fx.ev, folder: f, mode, mouse: { x, y }, moved: false,
      copy: e.altKey || e.ctrlKey,
      locked: locked || selected.some((ev) => laneLockedByName(ev.lane)),
      lanes,
      items: selected.map((ev) => ({ ev, folder: findCueLoc(ev).f, frame: ev.frame,
        lane: ev.lane, laneId: ev.laneId, laneIndex: lanes.findIndex((l) => l.name === ev.lane),
        manualLane: ev.manualLane })),
      meta0: hit.fx.ev.recMeta && window.HSCurveTools.cloneCueMetadata(hit.fx.ev.recMeta),
      f0: hit.fx.t - f.offset,
      dur0: hit.fx.ev.duration || 0,
      grabF: xToFrame(x) - hit.fx.t,
      end0: eventEndFrame(hit.fx),
      lane0: hit.fx.ev.lane,
      manualLane0: !!hit.fx.ev.manualLane
    };
    canvas.style.cursor = (mode === 'move' && !locked) ? 'grabbing' : (locked ? 'default' : 'ew-resize');
    return;
  }
  dragInfo = { x, y, moved: false, viewStart0: state.viewStart, box: e.shiftKey && y >= TOP,
    selection: new Set(selSet()) };
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
  if (sbVDrag && sbVThumb) {
    // SCROLL DỌC bằng scrollbar phải — chỉ đổi viewY, không đổi dữ liệu
    const th = sbVThumb.y2 - sbVThumb.y1;
    const max = Math.max(0, tlContentH() - (canvas.clientHeight - TOP - 14));
    state.viewY = ((y - sbVThumb.trackY - sbVDrag.grabOff) / Math.max(1, sbVThumb.trackH - th)) * max;
    clampViewY();
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
    if (!blockDrag.moved && (Math.abs(x - blockDrag.mouse.x) > 2 || Math.abs(y - blockDrag.mouse.y) > 2)) {
      noteChange();
      blockDrag.moved = true;
    }
    if (blockDrag.moved) {
      // CẬP NHẬT NGAY khi kéo — mượt như edit video
      const ev = blockDrag.ev;
      if (blockDrag.mode === 'move') {
        moveCueDrag(blockDrag, x, y);
      } else if (blockDrag.mode === 'resize-r') {
        ev.duration = Math.max(1, Math.round(xToFrame(x)) - (blockDrag.folder.offset + blockDrag.f0));
        trimCueCurve(ev, 0, ev.duration, blockDrag.meta0, blockDrag.end0 - blockDrag.folder.offset - blockDrag.f0);
      } else { // resize-l
        const newStart = clamp(Math.round(xToFrame(x)), blockDrag.folder.offset + (blockDrag.meta0 ? blockDrag.f0 : 0), blockDrag.end0 - 1);
        ev.duration = blockDrag.end0 - newStart;
        ev.frame = newStart - blockDrag.folder.offset;
        trimCueCurve(ev, ev.frame - blockDrag.f0, ev.duration, blockDrag.meta0, blockDrag.end0 - blockDrag.folder.offset - blockDrag.f0);
      }
      rebuildFlat();
    }
    return;
  }
  // gợi ý con trỏ: thanh đò + mép cue + thân khối nhạc = kéo ngang, thân cue = grab
  if (!dragInfo) {
    // CHẾ ĐỘ CẮT NHANH: tính hover preview (dòng đỏ + vùng bỏ) + con trỏ kéo
    qcHover = null;
    if (state.tlTool === 'quickcut') {
      const qA = audioClipHit(x, y);
      const qC = (!qA && x >= GUT) ? hitCueBlock(x, y) : null;
      if (qA) {
        qcHover = { kind: 'audio', clip: qA.clip, song: qA.song, row: qA.row, cx1: qA.cx1, cx2: qA.cx2, cutF: Math.max(0, Math.round(xToFrame(x))), locked: !!(qA.laneObj && qA.laneObj.locked) };
      } else if (qC) {
        qcHover = { kind: 'cue', fx: qC.fx, row: qC.row, cx1: frameToX(qC.fx.t), cx2: frameToX(eventEndFrame(qC.fx)), cutF: Math.max(0, Math.round(xToFrame(x))), locked: laneLockedByName(qC.row.lane) };
      }
      canvas.style.cursor = qcHover ? (qcHover.locked ? 'not-allowed' : QC_CUT_CURSOR) : 'crosshair';
      return;
    }
    const px = frameToX(state.frame);
    const hit = hitCueBlock(x, y);
    const clip = audioClipHit(x, y);
    // nền lane = con trỏ THƯỜNG; chỉ đổi khi đúng mép/thân cue/clip hoặc scrollbar
    let cur = y >= TOP ? 'default' : 'crosshair';
    // CHẾ ĐỘ CẮT (✂): trúng khối cue/clip nhạc = đang có thể cắt → con trỏ dao
    if (state.tlTool === 'cut' && (hit || clip)) cur = 'col-resize';
    // hover scrollbar → con trỏ kéo ngang
    else if (sbThumb && y >= sbThumb.y && y <= sbThumb.y + sbThumb.h && x >= GUT) cur = 'ew-resize';
    // hover scrollbar dọc → con trỏ kéo dọc
    else if (sbVThumb && x >= sbVThumb.x && y >= sbVThumb.y1 && y <= sbVThumb.y2) cur = 'ns-resize';
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
  if (Math.abs(x - dragInfo.x) > 4 || Math.abs(y - dragInfo.y) > 4) dragInfo.moved = true;
  if (dragInfo.box && dragInfo.moved) {
    dragInfo.end = { x, y };
    const left = Math.min(dragInfo.x, x), right = Math.max(dragInfo.x, x);
    const top = Math.min(dragInfo.y, y), bottom = Math.max(dragInfo.y, y);
    state.multiSel = new Set(dragInfo.selection);
    for (const fx of refreshVF()) {
      const row = timelineRows().find((r) => r.lane === fx.ev.lane);
      if (row && row.y < bottom && row.y + row.h > top
        && frameToX(fx.t) < right && frameToX(eventEndFrame(fx)) > left) state.multiSel.add(fx.ev);
    }
    state.sel = [...state.multiSel].slice(-1)[0] || null;
    updateSelBar();
    return;
  }
  if (dragInfo.moved) {
    state.viewStart = Math.max(0, dragInfo.viewStart0 - (x - dragInfo.x) / state.pps);
  }
});
canvas.addEventListener('mouseleave', () => { dragInfo = null; clipDrag = null; sbDrag = null; mousePos = { x: -1, y: -1 }; qcHover = null; });
// mouseup nghe trên WINDOW: nhả chuột ngoài canvas/mất focus vẫn kết thúc drag
// (trước đây chỉ nghe trên canvas → dragInfo kẹt 'scrub' làm playhead bám chuột + hover chết)
window.addEventListener('mouseup', (e) => {
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
        const copies = blockDrag.items.map((item) => ({ item,
          cue: cloneCuePlacement(item.ev, item.ev.frame, item.folder) }));
        for (const { item } of copies) {
          Object.assign(item.ev, { frame: item.frame, lane: item.lane });
          if (item.laneId === undefined) delete item.ev.laneId; else item.ev.laneId = item.laneId;
          if (item.manualLane === undefined) delete item.ev.manualLane; else item.ev.manualLane = item.manualLane;
        }
        const selected = copies.filter(({ cue }) => cue);
        for (const { item, cue } of selected) {
          insertCue(item.folder, cue);
          resolveCueEditLane(item.folder, cue);
        }
        state.multiSel = new Set(selected.map(({ cue }) => cue));
        state.sel = selected.length ? selected[selected.length - 1].cue : ev;
        refreshAll(); renderProps();
        flashStatus(`Đã sao chép ${selected.length} cue.`);
      } else {
        for (const item of blockDrag.items) {
          const i = item.folder.events.indexOf(item.ev);
          if (i >= 0) item.folder.events.splice(i, 1);
          insertCue(item.folder, item.ev);
          resolveCueEditLane(item.folder, item.ev);
        }
        state.sel = ev;
        state.multiSel = new Set(blockDrag.items.map((item) => item.ev));
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
      if (e.metaKey || e.ctrlKey || e.shiftKey) {
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
  if (dragInfo.box && dragInfo.moved) {
    dragInfo = null; renderFolders(); renderProps(); updateSelBar(); return;
  }
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
let tlCtxTarget = null;   // {type:'cue', ev} | {type:'audio', clip} | {type:'empty', lane, frame}
let tlCtxFrame = 0;       // vị trí chuột phải (giây lưới frame) cho "Dán vào đây"

function closeTlCtx() { tlCtx.hidden = true; tlCtxTarget = null; }

function openTlCtxAt(cx, cy) {
  const t = tlCtxTarget;
  const btn = (c) => tlCtx.querySelector(`[data-c="${c}"]`);
  const isCue = !!(t && t.type === 'cue');
  const isEmpty = !!(t && t.type === 'empty');
  btn('note').hidden = !isCue;
  btn('smpte').hidden = !isCue;
  btn('hide').hidden = !isCue;
  // "Thêm cue tại đây" chỉ cho vùng TRỐNG của lane V/R
  btn('newcue').hidden = !isEmpty;
  const head = $('tlCtxHead');
  if (isEmpty) {
    head.hidden = false;
    head.innerHTML = `Lane <b>${t.lane}</b> · <b>${tcString(t.frame, state.fps)}</b>`;
  } else {
    head.hidden = true;
  }
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
    // VÙNG TRỐNG trên lane cue (V/R) → menu có "Thêm cue tại đây"
    const row = hitLaneRow(y);
    if (!row || row.isAudio || x < GUT) { closeTlCtx(); return; }
    state.sel = null; state.multiSel = new Set();
    state.selClipId = null; state.selAudioLaneId = null;
    updateSelBar(); renderFolders(); renderProps();
    tlCtxTarget = { type: 'empty', lane: row.lane, frame: Math.max(0, Math.round(xToFrame(x))) };
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
      case 'newcue': {
        // tạo cue mới ngay tại vị trí chuột phải trên lane trống
        const f = curFolder();
        if (!f) { flashStatus('Chưa có bài — tạo bài trước.'); return; }
        const def = makeDef('', [1]);
        def.name = 'Cue ' + (f.cues.length + 1);
        def.color = SWATCHES[(f.cues.length * 5) % SWATCHES.length];
        f.cues.push(def);
        const ev = makePlacement(t.frame - f.offset, def.id);
        ev.lane = t.lane;
        insertCue(f, ev);
        state.sel = ev;
        state.multiSel = new Set([ev]);
        state.selClipId = null;
        state.selAudioLaneId = null;
        refreshAll();
        renderProps();
        updateSelBar();
        flashStatus(`Đã thêm "${def.name}" tại ${tcString(t.frame, state.fps)} trên ${t.lane} — điền ĐỊA CHỈ OSC ở panel THUỘC TÍNH CUE.`);
        break;
      }
      case 'note': {
        openNoteModal(t.ev);
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
  // 2 ngón đẩy LÊN/XUỒNG → cuộn DỌC các lane (khi lane cao hơn khung nhìn)
  if (e.deltaY) {
    state.viewY = (state.viewY || 0) + e.deltaY;
    clampViewY();
  }
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
      if (row && !row.isAudio) { cue.lane = row.lane; cue.manualLane = true; }
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

// Nút zoom −/+ đã bỏ theo thiết kế mới — zoom qua thanh RỘNG (zoomPps vẫn dùng cho ⌘+/-)

/* ================= ENGINE CLOCK — nguồn thời gian playback DUY NHẤT =================
   • Có clip nhạc dưới playhead  → AUDIO CLOCK (audio.currentTime) là chuẩn.
   • Không có clip               → MONOTONIC clock (performance.now), KHÔNG cộng dồn từng tick.
   • Engine chạy bằng setInterval (không phải rAF) nên vẫn chạy khi cửa sổ bị che/minimize/hide.
   • rAF chỉ còn dùng để VẼ giao diện — không quyết định thời gian playback. */
const clock = { anchorMs: 0, anchorFrame: 0, valid: false };
function clockReset(frame) {
  clock.anchorMs = performance.now();
  clock.anchorFrame = Math.max(0, frame);
  clock.valid = true;
}
function clockNow(nowMs) {
  return clock.anchorFrame + ((nowMs - clock.anchorMs) / 1000) * state.fps * state.speed;
}
function oscTimelineFrame(nowMs) {
  if (!state.playing) return state.frame;
  if (clock.valid) return clockNow(nowMs);
  const clip = findClipAtFrame(state.frame);
  if (clip && !audio.paused) return (clip.tlStart - clip.srcStart + audio.currentTime) * state.fps;
  return state.frame;
}
let audioClipId = null;   // clip instance mà <audio> đang phục vụ (để chỉ seek 1 lần)

/* ================= Vòng lặp ENGINE (10ms) ================= */
let lastInfoFrame = -1;
let infoDirty = true;   // cần tính lại HIỆN TẠI/CUE TIẾP/CÒN LẠI (sau khi thêm/xóa nhạc, cue…)
function engineStep(nowMs) {
  if (!state.playing) { clock.valid = false; return; }

  // ÂM THANH THEO CLIP INSTANCE: clip nào nằm dưới playhead (lane A bất kỳ) thì phát
  const clip = findClipAtFrame(state.frame);
  const localInClip = clip ? (clip.srcStart + (state.frame / state.fps - clip.tlStart)) : 0;
  const active = clip && localInClip < clip.srcEnd - 0.01;

  if (active) {
    if (audioClipId !== clip.id || audioSongId !== clip.song.id) {
      // VÀO CLIP MỚI → nạp source + seek ĐÚNG MỘT LẦN tại vị trí hiện tại
      if (audioSongId !== clip.song.id) {
        audio.src = fileUrl(clip.song.path);
        audioSongId = clip.song.id;
      }
      audio.playbackRate = state.speed;
      audio.currentTime = clamp(localInClip, 0, Math.max(0, clip.song.duration - 0.02));
      audioClipId = clip.id;
      audio.play().catch(() => {});
      clock.valid = false;              // từ đây audio là clock
    } else {
      // ĐANG TRONG CÙNG CLIP → KHÔNG BAO GIỜ SEEK LÙI; lấy vị trí từ AUDIO
      if (audio.paused) audio.play().catch(() => {});
      state.frame = (clip.tlStart - clip.srcStart + audio.currentTime) * state.fps;
    }
    // ÂM LƯỢNG theo INSTANCE: tổng (🔊) × volume riêng × fade in/out × mute
    const local = clip.srcStart + (state.frame / state.fps - clip.tlStart);
    const vol = clip.clip.mute ? 0
      : clamp(masterVol * (typeof clip.clip.volume === 'number' ? clip.clip.volume : 1) * fadeFactor(clip.clip, local), 0, 1);
    if (Math.abs(audio.volume - vol) > 0.01) audio.volume = vol;
  } else {
    // NGOÀI CLIP → MONOTONIC clock: không cộng dồn, không phụ thuộc số lần tick
    if (!audio.paused) audio.pause();
    audioClipId = null;
    if (!clock.valid) clockReset(state.frame);
    state.frame = clockNow(nowMs);
    if (Math.abs(audio.volume - masterVol) > 0.01) audio.volume = masterVol;
  }

  // Unified recorder owns note/CC closure, independently of renderer ticks.
  fireDue();
  // KẾT THÚC PHÁT: loop (chạy lại) > 'contentEndPlus10' > 'infinite'
  if (state.loop && state.frame >= totalFrames()) { setFrame(0); clockReset(0); }
  else {
    const stopF = playbackEndFrames();
    if ((state.playbackEndMode || 'infinite') === 'contentEndPlus10' && isFinite(stopF) && state.frame >= stopF) {
      state.frame = stopF;
      pause();
      setStatus('Đã phát hết — cuối nội dung + 10 giây. Muốn chạy vô hạn: đổi "Hết phát" thành "chạy vô hạn".');
    }
  }
}

/* ================= Vòng lặp UI (rAF) — chỉ VẼ, không quyết định thời gian ================= */
function tick() {
  if (state.playing) updateTc();
  if (Math.floor(state.frame) !== lastInfoFrame || infoDirty) {
    lastInfoFrame = Math.floor(state.frame);
    infoDirty = false;
    updateInfoStrip();
  }
  if (state.pps) { const pr = $('ppsRange'); if (pr) { pr.value = ppsToSlider(state.pps); syncSliderFill(pr); } }
  drawTimeline();
  requestAnimationFrame(tick);
}

setInterval(() => engineStep(performance.now()), 10);
requestAnimationFrame(tick);
syncAllSliders();   // tô màu thanh trượt khớp thumb ngay khi mở app

/* Dải HIỆN TẠI / CUE TIẾP THEO / CÒN LẠI (của thư mục đang chọn) */
function updateInfoStrip() {
  $('infoCur').textContent = tcString(state.frame, state.fps);
  const nx = nextCue();
  const nextTc = $('infoNext'), nextName = $('infoNextName');
  if (nx) {
    // ĐẾM NGƯỢC: còn bao lâu nữa cue bắn ra — tên cue đứng BÊN CẠNH đồng hồ
    nextTc.textContent = tcString(Math.max(0, nx.t - state.frame), state.fps);
    nextName.textContent = cueLabel(nx.ev, nx.f);   // chỉ TÊN cue (theo thiết kế mới)
    nextTc.classList.remove('next-none');
    nextName.classList.remove('none');
  } else {
    // Không còn cue: khối NEXT mờ đi, bố cục giữ nguyên
    nextTc.textContent = '--:--:--:--';
    nextName.textContent = 'không còn cue';
    nextTc.classList.add('next-none');
    nextName.classList.add('none');
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
/* Cập nhật biến --p cho thanh trượt tự style: phần tô màu luôn khớp đúng vị trí thumb */
function syncSliderFill(el) {
  if (!el) return;
  const min = Number(el.min || 0), max = Number(el.max || 100);
  const v = Number(el.value);
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--p', pct.toFixed(2) + '%');
}
function syncAllSliders() {
  syncSliderFill($('ppsRange'));
  syncSliderFill($('rowHRange'));
  syncSliderFill($('vol'));
}

function updateTc() {
  // Đồng hồ cam lớn trên topbar đã bỏ (trùng ô HIỆN TẠI) — giữ hàm để các nơi gọi không lỗi
  const el = $('tcText');
  if (el) el.textContent = tcString(state.frame, state.fps);
}

function toggleFollow() {
  state.follow = !state.follow;
  flashStatus('Follow (theo thanh đò): ' + (state.follow ? 'BẬT' : 'TẮT'));
  updateTransport();
}

function updateTransport() {
  $('btnPlay').textContent = state.playing ? '⏸' : '▶';
  $('btnPlay').classList.toggle('active', state.playing);
  $('btnLoop').classList.toggle('active', state.loop);
  const bf = $('btnFollow');
  if (bf) bf.classList.toggle('on', state.follow);
  // REC hiển thị trên chip REC của dải đồng hồ (nút REC trên topbar đã bỏ)
  const chipRec = $('chipRec');
  if (chipRec) {
    chipRec.classList.toggle('armed', state.recArmed);
    chipRec.textContent = recTransactions.size && recActiveSession === null ? 'REC: chốt phiên'
      : recTransactions.get(recActiveSession)?.accepted === false ? 'REC: chờ xác nhận'
      : recActiveSession !== null ? 'REC: đang ghi / chờ kết quả'
      : state.recArmed ? 'REC: chờ Play' : '● REC TẮT';
  }
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

/* ================= Monitor (dữ liệu do oscFeed giữ) ================= */
/* OSC_SEEN / Monitor / Test OSC: dữ liệu do oscFeed giữ (giới hạn cứng).
   Ở đây chỉ còn phần DỰNG DOM theo đợt flush — không chạy trên từng message. */

/* Dựng lại OSC Seen (chỉ khi panel mở, tối đa ~8 lần/giây) */
function renderOscSeen() {
  const box = $('oscSeenList');
  if (!box) return;
  const list = oscFeed.snapshotSeen();
  if (!list.length) {
    box.innerHTML = '<div class="empty">Chưa có OSC nào được nhận</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  list.slice(0, 40).forEach((item) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.title = `Nhận ${item.count} lần · ${item.argsCount} dạng args`;
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.textContent = `×${item.count}`;
    const argsSpan = document.createElement('span');
    argsSpan.className = 'args';
    const argText = (item.args || []).map((a) => (typeof a === 'number' ? Math.round(a * 1000) / 1000 : a)).join(',');
    argsSpan.textContent = argText || '—';
    const addrSpan = document.createElement('span');
    addrSpan.className = 'addr';
    addrSpan.textContent = item.address;
    div.append(addrSpan, argsSpan, cnt);
    div.addEventListener('click', () => {
      const parsed = Array.isArray(item.args) && item.args.length ? item.args.slice() : parseOscArgs(item.argKey);
      let f = curFolder();
      if (!f) f = addFolder();
      const def = findOrMakeDef(f, item.address, parsed);
      const cue = makePlacement(Math.floor(state.frame) - f.offset, def.id);
      const rl = recLane();
      cue.lane = rl ? rl.name : 'V1';
      insertCue(f, cue);
      state.sel = cue;
      refreshAll();
      renderProps();
      flashStatus(`Đã thêm cue từ ${item.address} @ ${tcString(state.frame, state.fps)}`);
    });
    frag.appendChild(div);
  });
  box.innerHTML = '';
  box.appendChild(frag);
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
/* Monitor: append theo ĐỢT (flush). rows = mảng dòng mới, all = toàn bộ buffer hiện có. */
/* =====================================================================
   MONITOR 2 TAB: OSC | MIDI — mỗi dòng có nút ＋ đầu dòng, KHÔNG có cột giờ
   ===================================================================== */
const MON = {
  src: 'osc',              // 'osc' | 'midi'
  pause: false,
  filter: '',
  midiRows: [],            // [{t,kind,label,num,ch,type,val}]
  midiMax: 300,
  midiCount: 0,
  seen: new Map()          // "addr|val" → 1 (chống nhấp nháy cùng giá trị)
};

function monTypeClass(t) {
  return t === 'f' ? 'f' : t === 'i' ? 'i' : t === 's' ? 's' : 't';
}

/* Dựng 1 dòng OSC: ＋ · chấm · địa chỉ · giá trị */
function makeOscRow(r) {
  const div = document.createElement('div');
  const k = (r.type || '').toLowerCase();
  const typeCls = k.startsWith('float') || typeof r.args?.[0] === 'number' && !Number.isInteger(r.args[0])
    ? 'f' : (Number.isInteger(r.args?.[0]) ? 'i' : (typeof r.args?.[0] === 'string' ? 's' : 't'));
  div.className = 'mrow2' + (r.isTx ? ' tx' : '');
  const val = (r.args || []).map((x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x)).join(',');

  const btn = document.createElement('button');
  btn.className = 'addbtn';
  btn.textContent = '＋';
  btn.title = 'Thêm vào cue tại thanh đò';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    cueFromOsc(r.address, r.args);
    btn.style.borderColor = 'var(--green)';
    btn.style.background = 'rgba(46,224,111,.25)';
    btn.style.color = '#fff';
    setTimeout(() => { btn.style.cssText = ''; }, 420);
  });

  const dot = document.createElement('span');
  dot.className = 'dot ' + monTypeClass(typeCls);
  const addr = document.createElement('span');
  addr.className = 'a';
  addr.textContent = r.address;
  addr.title = r.address;
  const v = document.createElement('span');
  v.className = 'v ' + (typeCls === 'f' ? 'f' : typeCls === 'i' ? 'i' : typeCls === 's' ? 's' : '');
  v.textContent = val;
  v.title = val;

  div.append(btn, dot, addr, v);
  return div;
}

/* Dựng 1 dòng MIDI: ＋ · note · kênh · loại · số · giá trị */
function makeMidiRow(m) {
  const div = document.createElement('div');
  div.className = 'mrow2';
  const btn = document.createElement('button');
  btn.className = 'addbtn';
  btn.textContent = '＋';
  btn.title = 'Thêm vào cue tại thanh đò';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    monAddMidiCue(m);
    btn.style.borderColor = 'var(--green)';
    btn.style.background = 'rgba(46,224,111,.25)';
    btn.style.color = '#fff';
    setTimeout(() => { btn.style.cssText = ''; }, 420);
  });

  const nm = document.createElement('span');
  nm.className = 'nm2';
  nm.textContent = m.label;
  const ch = document.createElement('span');
  ch.className = 'ch';
  ch.textContent = 'ch' + m.ch;
  const typ = document.createElement('span');
  typ.className = 'typ ' + m.cls;
  typ.textContent = m.type;
  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = '#' + m.num;
  const val = document.createElement('span');
  val.className = 'v';
  val.textContent = m.val;

  div.append(btn, nm, ch, typ, num, val);
  return div;
}

/* Thêm cue từ 1 dòng MIDI (Trigger / Piano / Float) */
function monAddMidiCue(m) {
  const f = curFolder();
  if (!f) { setStatus('Chưa có bài — nhấn ＋ Bài.'); return; }
  const rl = recLane();
  if (rl && rl.locked) { setStatus(`Lane ${rl.name} đang khóa.`); return; }
  const frame = Math.floor(state.frame) - f.offset;
  const addr = padAddr(m.num, m.ch);
  const def = findOrMakeDef(f, addr, [m.isCC ? m.rawVal : 1]);
  def.mode = m.type === 'Piano' ? 'piano' : (m.type === 'Float' ? 'float' : 'trigger');
  const cue = makePlacement(Math.max(0, frame), def.id);
  cue.lane = rl ? rl.name : 'V1';
  cue.duration = m.type === 'Piano' ? Math.round((m.holdFrames || 0)) : 0;
  insertCue(f, cue);
  state.sel = cue;
  refreshAll();
  renderProps();
  flashStatus(`Đã thêm cue ${m.type} "${m.label}" @ ${tcString(state.frame, state.fps)}`);
}

/* Đẩy dòng MIDI vào buffer + render nếu đang ở tab MIDI */
function monPushMidi(rec) {
  MON.midiRows.unshift(rec);
  MON.midiCount++;
  if (MON.midiRows.length > MON.midiMax) MON.midiRows.length = MON.midiMax;
  if (MON.src === 'midi' && !MON.pause) {
    const box = $('monitorMidi');
    if (box) {
      box.insertBefore(makeMidiRow(rec), box.firstChild);
      while (box.children.length > MON.midiMax) box.removeChild(box.lastChild);
      applyMonFilter();
    }
  }
  updateMonFooter();
}

/* Render các dòng OSC mới (gói mới nhất lên đầu) */
function renderMonitorRows(rows) {
  const box = $('monitor');
  if (!box) return;
  if (MON.pause) return;
  const frag = document.createDocumentFragment();
  for (const r of rows.slice().reverse()) {
    frag.appendChild(makeOscRow(r));
  }
  box.insertBefore(frag, box.firstChild);
  while (box.children.length > oscFeed.cfg.monitorMaxRows) box.removeChild(box.lastChild);
  box.scrollTop = 0;
  applyMonFilter();
  updateMonFooter();
}

/* Dựng lại toàn bộ từ buffer */
function renderMonitorAll() {
  const box = $('monitor');
  if (!box) return;
  box.innerHTML = '';
  const all = oscFeed.snapshotMonitor();
  if (all.length) renderMonitorRows(all.slice(-oscFeed.cfg.monitorMaxRows));
  applyMonFilter();
  updateMonFooter();
}

function renderMidiAll() {
  const box = $('monitorMidi');
  if (!box) return;
  box.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const m of MON.midiRows) frag.appendChild(makeMidiRow(m));
  box.appendChild(frag);
  applyMonFilter();
  updateMonFooter();
}

function applyMonFilter() {
  const q = MON.filter;
  const box = MON.src === 'osc' ? $('monitor') : $('monitorMidi');
  if (!box) return;
  for (const el of box.children) {
    el.style.display = (!q || el.textContent.toLowerCase().includes(q)) ? '' : 'none';
  }
}

function updateMonFooter() {
  const el = $('monCount');
  if (!el) return;
  const n = MON.src === 'osc' ? ($('monitor') ? $('monitor').children.length : 0) : MON.midiRows.length;
  el.textContent = n + ' dòng';
  const rate = $('monRate');
  if (rate) {
    if (MON.src === 'midi') rate.textContent = MON.midiCount ? MON.midiCount + ' tổng' : '0';
    else rate.textContent = oscProcStats ? (oscProcStats.lastMsgsPerSec || 0) + '/s' : '—';
  }
}

/* Đổi tab nguồn */
function setMonSource(src) {
  MON.src = src === 'midi' ? 'midi' : 'osc';
  document.querySelectorAll('.mon-tab').forEach((b) => b.classList.toggle('on', b.dataset.src === MON.src));
  const o = $('monitor'), m = $('monitorMidi');
  if (o) o.hidden = MON.src !== 'osc';
  if (m) m.hidden = MON.src !== 'midi';
  if (MON.src === 'midi') {
    // MIDI: render từ buffer, không cần utility parse
    renderMidiAll();
  } else {
    renderMonitorAll();
  }
  applyMonFilter();
  updateMonFooter();
  // Monitor visibility never enables discovery of unlisted addresses.
  if (window.hs.oscUi) {
    window.hs.oscUi({ type: 'uiVisible', on: MON.src === 'osc' || oscCaptureSeen });
  }
  oscFeed.panelVisible = (MON.src === 'osc');
}

document.querySelectorAll('.mon-tab').forEach((b) => {
  b.addEventListener('click', () => setMonSource(b.dataset.src));
});

/* monRow giữ API cũ cho TX */
function monRow(address, args, isTx) {
  oscFeed.ingestTx(address, args, performance.now());
}

/* Nối oscFeed → DOM (chạy theo đợt flush, KHÔNG theo từng message) */
oscFeed.onMonitorFlush = (rows) => renderMonitorRows(rows, oscFeed.monitor);
oscFeed.onSeenFlush = () => renderOscSeen();
oscFeed.onTestFlush = () => { if (oscFeed.testVisible) renderTestOscRows(); };
oscFeed.onMonitorClear = () => { const b = $('monitor'); if (b) b.innerHTML = ''; };

/* Nhịp flush UI: rAF, tối đa 30 fps (33ms) — không setState theo từng message */
let lastFeedFlush = 0;
function feedRaf(ts) {
  if (ts - lastFeedFlush >= 33) {
    lastFeedFlush = ts;
    oscFeed.tick(performance.now());
  }
  requestAnimationFrame(feedRaf);
}
requestAnimationFrame(feedRaf);

/* ===== MONITOR 2 TAB: nút điều khiển ===== */
$('monPauseBtn').addEventListener('click', (e) => {
  MON.pause = !MON.pause;
  $('paneMon').classList.toggle('paused', MON.pause);
  e.currentTarget.classList.toggle('on', MON.pause);
  e.currentTarget.textContent = MON.pause ? '▶' : '⏸';
  oscFeed.monitorPaused = MON.pause;
  if (!MON.pause) {
    if (MON.src === 'midi') renderMidiAll(); else renderMonitorAll();
  }
});

$('btnMonClear').addEventListener('click', () => {
  const o = $('monitor'); if (o) o.innerHTML = '';
  const m = $('monitorMidi'); if (m) m.innerHTML = '';
  MON.midiRows.length = 0;
  MON.midiCount = 0;
  oscFeed.clear();
  renderOscSeen();
  updateMonFooter();
});

$('monFilter').addEventListener('input', (e) => {
  MON.filter = e.target.value.toLowerCase();
  state.monFilter = MON.filter;
  applyMonFilter();
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
  follow: () => toggleFollow(),
  help: () => flashStatus('Quy trình: ① Bật OSC (panel KẾT NỐI OSC) + Bật Output trong Resolume (Preferences → OSC → 127.0.0.1:7000) ② Kéo nhạc vào lane A ③ Bật REC, Phát, gõ MIDI ④ Dừng REC, Play lại để chạy show. ⌘-click chọn nhiều cue. Kéo cue từ danh sách vào timeline = tạo bản sao (giữ Alt khi kéo trên timeline cũng vậy).'),
  testosc: () => openTestOsc(),
  convert: () => openConvTool()
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
  const seenList = oscFeed.snapshotSeen();
  if (!seenList.length) { setStatus('Chưa có OSC nào được nhận.'); return; }
  let created = 0;
  const entries = seenList.map((it) => [it.address, it]);
  let f = curFolder();
  if (!f) f = addFolder();
  entries.forEach(([addr, item]) => {
    const args = (Array.isArray(item.args) && item.args.length) ? item.args.slice() : parseOscArgs(item.argKey);
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
$('btnFollow').addEventListener('click', toggleFollow);
function toggleRec() {
  if (recTransactions.size && recActiveSession === null) {
    setStatus('REC đang chốt phiên, chưa thể đổi REC.');
    return;
  }
  if (state.recArmed) recFinalizeOpen();
  else if (!curFolder()) addFolder();
  state.recArmed = !state.recArmed;
  pushOscMode();
  updateTransport();
  flashStatus(recTransactions.size && recActiveSession === null ? 'REC đang chốt phiên...'
    : state.recArmed ? 'REC BẬT: MIDI + OSC. Bấm Play để bắt đầu phiên ghi.' : 'REC TẮT.');
}
$('recFolderSel').addEventListener('change', (e) => {
  state.activeFolderId = Number(e.target.value);
  renderFolders();
});

/* ĐIỀU KHIỂN GHI — nút trên topbar (● REC) + panel KẾT NỐI OSC (LANE GHI, MIDI REC, Dọn trùng) */
$('recLaneSel').addEventListener('change', (e) => {
  state.recLaneId = Number(e.target.value);
  scheduleAutosave();
});
function dedupeSelectedFolder() {
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
}
$('mrDedupe').addEventListener('click', dedupeSelectedFolder);

/* ================= Cụm nút ghi trên dải đồng hồ (kiểu 404) ================= */
$('chipRec').addEventListener('click', toggleRec);
$('chipPad').addEventListener('click', () => {
  const order = ['auto', 'trigger', 'piano'];
  state.recNoteMode = order[(order.indexOf(state.recNoteMode) + 1) % order.length];
  updateRecChips();
  flashStatus('Kiểu ghi pad: ' + (state.recNoteMode === 'auto'
    ? 'TỰ ĐỘNG — nhả nhanh = Trigger, giữ ≥ 0,5 s = Piano. Núm vặn/fader = Float.'
    : state.recNoteMode === 'trigger' ? 'TRIGGER — mọi pad mới đều bắn lúc đầu.' : 'PIANO — giữ = chạy, nhả = dừng.'));
  scheduleAutosave();
});
$('chipMidi').addEventListener('click', () => {
  const box = document.getElementById('mrMidiBox');
  if (box) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flashStatus('Chọn thiết bị MIDI trong panel KẾT NỐI OSC — mục MIDI REC — ĐÀN PAD. Cắm bàn vào là app tự nhận.');
});
$('chipResolume').addEventListener('click', () => $('btnCheckResolume').click());
$('chipBounce').addEventListener('click', () => {
  state.midiBounce = !state.midiBounce;
  const cb = $('mrBounce');
  if (cb) cb.checked = state.midiBounce;
  updateRecChips();
  flashStatus(state.midiBounce ? 'Bounce gửi mapping thật khi không ghi; trong REC, MIDI phải nối trực tiếp tới Resolume.' : 'Bấm pad KHÔNG bắn OSC khi không ghi.');
  scheduleAutosave();
});
$('chipSmpte').addEventListener('click', () => {
  state.recSmpteInput = !state.recSmpteInput;
  updateRecChips();
  flashStatus(state.recSmpteInput
    ? 'SMPTE Input BẬT cho phiên ghi — clip ghi lại chạy theo thanh đò, đúng từng khung.'
    : 'SMPTE Input TẮT — app chỉ bắn clip lúc đầu, anh tự điều khiển clip trong Resolume.');
});
$('chipRecMode').addEventListener('click', () => {
  state.recMode = state.recMode === 'overwrite' ? 'overdub' : 'overwrite';
  document.querySelectorAll('input[name="recMode"]').forEach((r) => { r.checked = r.value === state.recMode; });
  updateRecChips();
  flashStatus(state.recMode === 'overwrite' ? 'GHI ĐÈ — phím bấm lại thay clip cũ từ chỗ bấm trở đi.' : 'GHI THÊM — giữ cả clip cũ lẫn mới.');
  scheduleAutosave();
});
$('chipDedupe').addEventListener('click', dedupeSelectedFolder);

function updateRecChips() {
  const chipPad = $('chipPad');
  if (chipPad) {
    chipPad.textContent = state.recNoteMode === 'auto' ? '▦ Tự động' : state.recNoteMode === 'trigger' ? '⏵ Trigger' : '🎹 Piano';
    chipPad.classList.toggle('on', state.recNoteMode !== 'auto');
  }
  const chipBounce = $('chipBounce');
  if (chipBounce) {
    chipBounce.classList.toggle('on', !!state.midiBounce);
    chipBounce.title = 'Bounce chỉ gửi khi không có phiên REC hoạt động. Trong REC, MIDI phải được map trực tiếp trong Resolume để tránh phản hồi OSC trùng.';
  }
  const chipSmpte = $('chipSmpte');
  if (chipSmpte) chipSmpte.classList.toggle('on', !!state.recSmpteInput);
  const chipRecMode = $('chipRecMode');
  if (chipRecMode) chipRecMode.textContent = state.recMode === 'overwrite' ? 'Ghi đè' : 'Ghi thêm';
}

function updateMidiChip() {
  const chip = $('chipMidi');
  if (!chip) return;
  const n = MIDI.inputs.length;
  if (!n) { chip.textContent = '♪ MIDI'; chip.classList.remove('ok'); return; }
  const first = MIDI.inputs[0];
  chip.textContent = '♪ MIDI';
  chip.title = 'MIDI đã nhận: ' + (first.name || 'thiết bị') + (n > 1 ? ` (+${n - 1})` : '') + ' — bấm để nhảy tới chỗ chọn thiết bị.';
  chip.classList.add('ok');
}
// «Hết phát» / «Tự chuyển bài» / «Theo thanh đò» đã bỏ UI theo thiết kế mới — giữ giá trị mặc định/trong dự án
$('speedSel').addEventListener('change', (e) => {
  if (recActiveSession !== null) pause(true);
  // đổi tốc độ: neo lại clock tại vị trí hiện tại để không nhảy thời gian
  state.frame = oscTimelineFrame(performance.now());
  clockReset(state.frame);
  state.speed = parseFloat(e.target.value) || 1;
  pushOscMode(true);
  if (mode() === 'audio') audio.playbackRate = state.speed;
});
$('fpsSel').addEventListener('change', (e) => {
  if (recActiveSession !== null) pause(true);
  state.frame = oscTimelineFrame(performance.now());
  clockReset(state.frame);
  state.fps = parseInt(e.target.value, 10) || 30;
  pushOscMode(true);
  updateTc();
  renderFolders();
  scheduleAutosave();
});
$('vol').addEventListener('input', (e) => {
  masterVol = parseFloat(e.target.value);
  audio.volume = masterVol;   // khi đang phát clip, tick() sẽ nhân thêm volume/fade riêng của instance
  const vv = $('volVal'); if (vv) vv.textContent = Math.round(masterVol * 100) + '%';
  syncSliderFill(e.target);
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
  const items = [...set].map((ev) => {
    const loc = findCueLoc(ev);
    return { ...structuredClone(ev), frame: ev.frame + (loc ? loc.f.offset : 0),
      clipboardDefinition: structuredClone(defOf(ev)) };
  });
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
  if ([...selSet()].some((ev) => laneLockedByName(ev.lane))) { setStatus('Locked cues cannot be cut.'); return; }
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
  if ([...set].some((ev) => laneLockedByName(ev.lane))) { setStatus('Locked cues cannot be deleted.'); return; }
  noteChange();
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
  if (!state.lanes.some((l) => l.kind !== 'A' && !l.locked)) { setStatus('No unlocked cue lane.'); return; }
  const base = Math.max(0, Math.round(atFrame !== undefined ? atFrame : state.frame) - f.offset);
  const base0 = items[0].frame;
  const newSel = new Set();
  noteChange();
  items.forEach((src) => {
    // dán = điểm đặt mới, dùng lại cue gốc (cueId) đã có trong thư mục đích nếu trùng nguồn
    let defId = src.cueId;
    if (src.recMeta || !f.cues.some((c) => c.id === defId)) {
      // cue gốc ở thư mục khác → tạo bản def tương ứng trong thư mục đích
      const srcF = state.folders.find((fo) => fo.cues.some((c) => c.id === src.cueId));
      const sd = src.clipboardDefinition || (srcF && srcF.cues.find((c) => c.id === src.cueId));
      if (!sd) return;
      const nd = { ...structuredClone(sd), id: nid() };
      f.cues.push(nd);
      defId = nd.id;
    }
    const cue = cloneCuePlacement(src, Math.max(0, base + (src.frame - base0)), f, false);
    cue.cueId = defId;
    delete cue.clipboardDefinition;
    let lane = laneByName(cue.lane);
    if (!lane || lane.locked || lane.kind === 'A') lane = state.lanes.find((l) => l.kind !== 'A' && !l.locked);
    if (!lane) return;
    cue.lane = lane.name; cue.laneId = lane.id;
    insertCue(f, cue);
    resolveCueEditLane(f, cue);
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
// Thanh Sao chép/Cắt/Dán/↑/↓ đã bỏ theo thiết kế mới — thao tác qua ⌘C/⌘X/⌘V + phím mũi tên
// (hàm copySelection/cutSelection/pasteSelection/nudgeSelected vẫn giữ cho phím tắt + menu chuột phải)
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
function nudgeSelected(df) {
  const set = selSet();
  if (!set.size) return;
  if ([...set].some((ev) => laneLockedByName(ev.lane))) return;
  const delta = Math.max(df, -Math.min(...[...set].map((ev) => ev.frame)));
  noteChange();
  set.forEach((ev) => {
    const loc = findCueLoc(ev);
    if (!loc) return;
    loc.f.events.splice(loc.i, 1);
    ev.frame += delta;
    insertCue(loc.f, ev);
    resolveCueEditLane(loc.f, ev);
  });
  refreshAll();
}

$('cueSearch').addEventListener('input', (e) => { state.cueSearch = e.target.value; renderFolders(); });
$('songSearch').addEventListener('input', (e) => { state.songSearch = e.target.value; renderSongs(); });
$('songSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.target.value = ''; state.songSearch = '';
    e.target.classList.remove('open');
    $('btnSongSearch').classList.remove('is-active');
    $('btnSongSearch').closest('.musictools')?.classList.remove('searching');
    renderSongs();
  }
});
$('btnSortSongs').addEventListener('click', () => {
  const act = curSong();
  state.songs.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  state.songIndex = act ? state.songs.indexOf(act) : -1;
  renderSongs();
  scheduleAutosave();
});

/* ===== Nghe thử bài hát trực tiếp (độc lập timeline/cue) ===== */
function previewUpdate() {
  const song = state.songs.find((s) => s.id === preview.songId);
  const d = preview.audio.duration || (song && song.duration) || 0;
  const t = preview.audio.currentTime || 0;
  // thanh tiến trình riêng dưới cụm nút phát
  const nowEl = $('songNow');
  if (nowEl) {
    const show = !!song && (t > 0 || !preview.audio.paused);
    nowEl.hidden = !show;
    if (show) {
      $('songNowName').textContent = song.name;
      $('songNowTime').textContent = `${fmtDur(t)} / ${fmtDur(d)}`;
      $('songNowFill').style.width = (d > 0 ? (t / d) * 100 : 0) + '%';
    }
  }
  const el = $('songList')?.querySelector('.song-item.previewing');
  if (!song || !el) return;
  const pre = el.querySelector('.spre');
  if (pre) pre.textContent = `${fmtDur(t)} / ${fmtDur(d)}`;
  const bar = el.querySelector('.sprog i');
  if (bar) bar.style.width = (d > 0 ? (t / d) * 100 : 0) + '%';
}
function previewTick() {
  previewUpdate();
  if (!preview.audio.paused) preview.raf = requestAnimationFrame(previewTick);
}
function syncPreviewButtons() {
  const has = state.songIndex >= 0;
  const playing = !preview.audio.paused;
  $('btnSongPlay').disabled = !has;
  $('btnSongRestart').disabled = !has;
  $('btnSongPause').disabled = !playing;
  $('btnSongPlay').classList.toggle('on', playing);
  $('btnSongPause').classList.toggle('on', !playing && preview.audio.currentTime > 0);
}
function previewSetState(playing) {
  syncPreviewButtons();
  if (playing) { previewUpdate(); cancelAnimationFrame(preview.raf); preview.raf = requestAnimationFrame(previewTick); }
  else { cancelAnimationFrame(preview.raf); previewUpdate(); }
}
function previewStop() {
  preview.audio.pause();
  preview.songId = null;
  document.querySelectorAll('.song-item.previewing').forEach((e) => {
    e.classList.remove('previewing');
    const p = e.querySelector('.sprog i'); if (p) p.style.width = '0%';
    const t = e.querySelector('.spre'); if (t) t.textContent = '';
  });
  previewSetState(false);
  renderSongs();
}
function previewStart(restart = false) {
  const song = curSong();
  if (!song || !song.path) return;
  if (preview.songId !== song.id) {
    preview.audio.src = fileUrl(song.path);
    preview.songId = song.id;
    preview.audio.currentTime = 0;
  } else if (restart) {
    preview.audio.currentTime = 0;
  }
  // dừng engine chính nếu đang phát để không phát chồng 2 nguồn
  if (state.playing) pause();
  preview.audio.play().then(() => {
    renderSongs();
    previewSetState(true);
  }).catch((e) => setStatus('Không phát được bài: ' + e.message));
}
preview.audio.addEventListener('ended', () => previewSetState(false));
$('btnSongPlay').addEventListener('click', () => previewStart(false));
$('btnSongPause').addEventListener('click', () => { preview.audio.pause(); previewSetState(false); });
$('btnSongRestart').addEventListener('click', () => previewStart(true));
/* tốc độ nghe thử — chỉ áp cho audio preview, không đụng timeline */
const songSpeedSel = $('songSpeed');
if (songSpeedSel) songSpeedSel.addEventListener('change', (e) => {
  preview.audio.playbackRate = parseFloat(e.target.value) || 1;
});
/* Ô "Thêm nhạc hoặc kéo vào" = nút thêm nhạc (nút ＋ Thêm riêng đã bỏ) */
$('audioDrop').addEventListener('click', async () => {
  const paths = await window.hs.openAudioMulti();
  if (paths && paths.length) {
    const added = paths.map((p) => addSongFile(p)).filter(Boolean);
    if (state.songIndex < 0 && added.length) activateSong(state.songs.indexOf(added[0]));
    setStatus(`Đã thêm ${paths.length} bài vào danh sách NHÁC.`);
  }
});

/* Cổng nghe: TỰ ÁP DỤNG sau 0,6s (bỏ nút "Áp dụng" riêng) */
let listenPortTimer = null;
function applyListenPort() {
  const p = parseInt($('listenPort').value, 10);
  if (!(p >= 1024 && p <= 65535)) { setStatus('Cổng nghe không hợp lệ (1024–65535).'); return; }
  state.listenPort = p;
  window.hs.setListenPort(p)
    .then(() => setStatus(window.__oscListening
      ? `Đã đổi cổng nghe :${p}.`
      : `Đã lưu cổng nghe :${p} — bấm "Bật OSC" để nghe.`))
    .catch((e) => setStatus('Lỗi đổi cổng: ' + e.message));
}
$('listenPort').addEventListener('input', () => {
  clearTimeout(listenPortTimer);
  listenPortTimer = setTimeout(applyListenPort, 600);
});
$('listenPort').addEventListener('blur', applyListenPort);

/* Main OSC mặc định TẮT khi mở app — nút này là công tắc DUY NHẤT bật/tắt cổng nghe */
$('btnOscToggle').addEventListener('click', () => {
  if (window.__oscListening) {
    window.hs.oscDisable().catch((e) => setStatus('Lỗi tắt OSC: ' + e.message));
  } else {
    window.hs.oscEnable().catch((e) => setStatus('Lỗi bật OSC: ' + e.message));
  }
});
/* Các ô host/port cũ đã thay bằng danh sách địa chỉ OSC (oscUI.targets).
   Giữ state.target để tương thích Mini/legacy — đồng bộ từ target đầu tiên. */
function syncLegacyTarget() {
  const t = oscUI.targets && oscUI.targets[0];
  if (t) { state.target.host = t.host; state.target.port = t.port; }
}

/* Nút "Kiểm tra Resolume" cũ: chuyển sang xác thực target đầu tiên */
const legacyCheck = $('btnCheckResolume');
if (legacyCheck) {
  legacyCheck.addEventListener('click', () => {
    const t = oscUI.targets && oscUI.targets[0];
    if (!t) { setStatus('Chưa có địa chỉ OSC — bấm ＋ Thêm trong panel ĐỊA CHỈ OSC.'); return; }
    verifyTarget(t.id);
  });
}

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
/* Accepted events and latest-only UI feedback use separate batches. */
function attachOscPort(portApi) {
  if (!portApi) return;
  if (oscPort && oscPort !== portApi) recInterrupt('Cổng OSC bị thay thế');
  if (oscPort) { try { oscPort.close(); } catch (_) {} }
  oscPort = portApi;
  // portApi: {onMessage, post, close} do preload bọc từ MessagePort
  if (portApi.onMessage) portApi.onMessage((data) => handleOscProcMessage(data, portApi));
  pushOscMode();
  oscFloatAddressKey = null;
  syncOscFloatAddresses();
  if (window.hs.oscUi) {
    window.hs.oscUi({ type: 'uiVisible', on: !!(oscFeed.panelVisible || oscFeed.testVisible) });
    window.hs.oscUi({ type: 'captureSeen', on: oscCaptureSeen });
  }
}

/* Cập nhật metrics trên panel MIDI REC (nhịp 1s, do utility báo) */
let oscMetricsTimer = null;
let lastUiBatches = 0;
function updateOscMetrics() {
  const st = oscProcStats;
  if (!st) return;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('omRx', st.lastMsgsPerSec || 0);
  set('omKept', st.msgKept || 0);
  set('omFiltered', st.msgFiltered || 0);
  set('omLimited', st.msgRateLimited || 0);
  set('omMalformed', st.malformed || 0);
  set('omBatches', st.uiBatches || 0);
  set('omQueue', st.queueDepth || 0);
  set('omDropped', st.droppedOverflow || 0);
  set('omLoop', (st.eventLoopP99Ms || 0).toFixed(1) + 'ms');
  set('omIpc', st.rendererMessagesPerSec || 0);
  set('omPkt', st.datagramsPerSec || 0);
  for (const [id, warning, title] of [
    ['omQueue', st.queueDepth > 0, 'Accepted OSC events queued or awaiting renderer ACK; high water: ' + (st.queueHighWater || 0)],
    ['omDropped', st.droppedOverflow > 0, 'Accepted events lost to bounded queue overflow; total: ' + (st.droppedOverflow || 0)],
    ['omLoop', st.eventLoopP99Ms > REC_CFG.OSC_EVENT_LOOP_WARN_MS, 'Utility event-loop delay p99; max: ' + (st.eventLoopMaxMs || 0).toFixed(1) + 'ms'],
    ['omIpc', false, 'Renderer event/UI batches per second'],
    ['omPkt', false, 'Incoming UDP datagrams per second']
  ]) {
    const el = $(id);
    if (el) { el.classList.toggle('warn', !!warning); el.title = title; }
  }
  const bufEl = $('omBuf');
  if (bufEl) {
    const rb = oscProcRecvBuf;
    if (rb) {
      const mb = (rb.actual / 1048576).toFixed(1);
      bufEl.textContent = `buf ${mb}MB`;
      bufEl.classList.toggle('warn', !!rb.warn);
      bufEl.title = rb.warn
        ? `HĐH giới hạn ${mb}MB (yêu cầu ${(rb.requested / 1048576).toFixed(1)}MB) — có thể rớt gói khi burst`
        : `UDP receive buffer ${mb}MB`;
    } else {
      bufEl.textContent = 'buf —';
    }
  }
  if (oscProcError) {
    const el = $('oscStatus');
    if (el) el.title = 'Lỗi OSC: ' + oscProcError;
  }
}

function handleOscProcMessage(m, sourcePort = oscPort) {
  if (!m || !m.type) return;
  if (sourcePort && oscPort && sourcePort !== oscPort) return;
  switch (m.type) {
    case 'recordStarted': {
      const tx = recTransactions.get(m.session);
      if (!tx || tx.accepted) break;
      tx.accepted = true;
      if (tx.overwrite) {
        const f = state.folders.find((folder) => folder.id === tx.folderId);
        if (f) {
          f.events = f.events.filter((cue) => tx.offset + cue.frame < tx.anchorFrame);
          refreshAll();
        }
      }
      updateTransport();
      break;
    }
    case 'recordPreview':
      try { recReceivePreview(m); }
      finally { if (sourcePort) sourcePort.post({ type: 'previewAck' }); }
      break;
    case 'recordActions':
      try { recReceiveActions(m); }
      finally { if (sourcePort) sourcePort.post({ type: 'recordAck', batchId: m.batchId }); }
      break;
    case 'recordDrained': {
      const tx = recTransactions.get(m.session);
      if (tx && tx.cutoff !== null) recFinishTransaction(tx);
      break;
    }
    case 'recordMapping': {
      recReceiveMapping(m.session, m.key, m.mapping);
      break;
    }
    case 'recordWarning': {
      const tx = recTransactions.get(m.session);
      if (tx && m.text) {
        tx.warnings.add(String(m.text));
        clearTimeout(statusTimer);
        setStatus('REC: ' + [...tx.warnings].join(' '));
      }
      break;
    }
    case 'recordRejected':
      if (recTransactions.has(m.session)) recInterrupt('Utility từ chối REC: ' + (m.text || 'không thể mở phiên'));
      break;
    case 'uiBatch': {
      // Latest values are feedback only: never record or learn from this stream.
      try {
        if (!Array.isArray(m.items)) return;
        for (let i = 0; i < m.items.length; i++) {
          const it = m.items[i];
          oscFeed.ingest(it.address, it.args, it.ts - performance.timeOrigin);
        }
      } finally {
        if (sourcePort) sourcePort.post({ type: 'uiAck' });
      }
      break;
    }
    case 'eventBatch': {
      try {
        if (Array.isArray(m.items)) {
          for (const item of m.items) onOscMessage(item);
        }
      } finally {
        if (sourcePort) sourcePort.post({ type: 'eventAck', id: m.id });
      }
      break;
    }
    case 'stats':
      oscProcStats = m.stats || null;
      updateOscMetrics();
      break;
    case 'seen':
      if (Array.isArray(m.items)) oscProcSeen = m.items;
      break;
    case 'matched': {
      // Kết quả ghép MIDI↔OSC từ utility
      const cb = midiMatchWaiters.get(m.id);
      if (cb) { midiMatchWaiters.delete(m.id); cb(m); }
      break;
    }
    case 'unmatched': {
      const cb = midiMatchWaiters.get(m.id);
      if (cb) { midiMatchWaiters.delete(m.id); cb(null); }
      break;
    }
    case 'error':
      oscProcError = m.error || null;
      if (m.fatal) {
        window.__oscListening = false;
        recInterrupt('Tiến trình OSC lỗi');
        setStatus('OSC lỗi: ' + oscProcError);
      }
      updateOscMetrics();
      break;
    case 'restarting':
      window.__oscListening = false;
      for (const resolve of midiMatchWaiters.values()) resolve(null);
      midiMatchWaiters.clear();
      recInterrupt('Tiến trình OSC khởi động lại');
      break;
    case 'ready':
      window.__oscListening = true;
      oscProcRecvBuf = m.recvBuf || null;
      updateOscMetrics();
      break;
    case 'closed':
      window.__oscListening = false;
      recInterrupt('OSC đã đóng');
      updateOscMetrics();
      break;
    default:
      break;
  }
}

function recStartTransaction() {
  if (recTransactions.size || !oscPort) {
    setStatus('REC chưa thể bắt đầu: đang chốt phiên hoặc chưa có kết nối OSC.');
    return false;
  }
  if (window.__oscListening !== true) {
    setStatus('REC chưa thể bắt đầu: OSC chưa sẵn sàng lắng nghe. Bật OSC rồi bấm Play để thử lại.');
    return false;
  }
  const f = curFolder();
  const lane = recLane();
  if (!f || (lane && lane.locked)) {
    setStatus('REC cần bài và lane ghi không khóa.');
    return false;
  }
  const now = performance.now();
  const tx = { session: ++oscSession, folderId: f.id, offset: f.offset,
    fps: state.fps, speed: state.speed, anchorEpoch: performance.timeOrigin + now,
    anchorFrame: oscTimelineFrame(now), smpteInput: !!state.recSmpteInput,
    recSnap: snapshot(), cutoff: null, timer: null, actions: new Set(),
    accepted: false, overwrite: state.recMode === 'overwrite', warnings: new Set() };
  oscAnchor = { epoch: tx.anchorEpoch, frame: tx.anchorFrame, session: tx.session };
  recTransactions.set(tx.session, tx);
  recLive.set(tx.session, { laneId: lane && lane.kind === 'R' ? lane.id : null, items: new Map() });
  recActiveSession = tx.session;
  const mappings = new Map(midiMap);
  for (const [key, address] of MIDI.padMap) {
    if (address && !mappings.has(key)) mappings.set(key, { address, kind: 'trigger', args: [1] });
  }
  // Persisted projects may have device-independent mappings from earlier versions.
  if (state.midiDeviceId) {
    for (const [key, mapping] of [...mappings]) {
      const deviceKey = state.midiDeviceId + '|' + key;
      if (!key.includes('|') && !mappings.has(deviceKey)) mappings.set(deviceKey, mapping);
    }
  }
  try {
    oscPort.post({ type: 'recStart', session: tx.session, fps: tx.fps,
      anchorEpoch: tx.anchorEpoch, anchorFrame: tx.anchorFrame, speed: tx.speed,
      mappings: [...mappings], smpteInput: tx.smpteInput,
      config: { USE_LEARNED_MAPPING_FALLBACK: !!state.useLearnedMappingFallback } });
  } catch (_) {
    recInterrupt('Không gửi được lệnh bắt đầu REC');
    return false;
  }
  if (!recTransactions.has(tx.session) || recActiveSession !== tx.session) return false;
  return true;
}

function recStopTransaction() {
  const tx = recTransactions.get(recActiveSession);
  if (!tx || tx.cutoff !== null) return;
  tx.cutoff = performance.timeOrigin + performance.now();
  recActiveSession = null;
  const heldCount = MIDI.notes.size;
  MIDI.notes.clear();
  MIDI.cc.clear();
  tx.timer = setTimeout(() => {
    if (recTransactions.has(tx.session)) {
      try { oscPort.post({ type: 'recAbort', session: tx.session }); }
      catch (_) { recInterrupt('Không gửi được lệnh hủy phiên REC'); return; }
      recFinishTransaction(tx, 'Hết thời gian chốt REC; giữ phần đã nhận, dữ liệu chưa nhận có thể bị mất.');
    }
  }, REC_CFG.REC_DRAIN_TIMEOUT_MS);
  try { oscPort.post({ type: 'recStop', session: tx.session, cutoff: tx.cutoff }); }
  catch (_) { recInterrupt('Kết nối REC gián đoạn'); }
  updateTransport();
  if (heldCount) setStatus('REC đang chốt phiên; note còn giữ được đóng tại thời điểm dừng.');
}

function recFinishTransaction(tx, warning) {
  if (!recTransactions.has(tx.session)) return;
  recLive.delete(tx.session);
  clearTimeout(tx.timer);
  if (recActiveSession === tx.session) recActiveSession = null;
  // Flush while suppression is still active, then commit exactly one history entry.
  flushOscRecUi();
  refreshAll();
  const after = snapshot();
  recTransactions.delete(tx.session);
  if (after !== tx.recSnap) {
    undoStack.push(tx.recSnap);
    if (undoStack.length > REC_CFG.REC_HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
  }
  lastSnap = after;
  updateTransport();
  renderProps();
  scheduleAutosave();
  if (warning) tx.warnings.add(warning);
  clearTimeout(statusTimer);
  setStatus(tx.warnings.size ? 'REC: ' + [...tx.warnings].join(' ')
    : 'REC đã chốt phiên; hoàn tác cả phiên bằng Cmd+Z.');
}

function recInterrupt(reason) {
  recLive.clear();
  if (!recTransactions.size) return;
  state.recArmed = false;
  oscRecording = false;
  oscRecArmed = false;
  try { if (window.hs.oscMode) window.hs.oscMode({ type: 'recording', on: false, session: oscSession }); } catch (_) {}
  MIDI.notes.clear();
  MIDI.cc.clear();
  const port = oscPort;
  for (const tx of [...recTransactions.values()]) {
    try { if (port) port.post({ type: 'recAbort', session: tx.session }); } catch (_) {}
    recFinishTransaction(tx, reason + ': giữ cue đã nhận; phần chưa nhận có thể mất, không tự khôi phục thời gian ghi.');
  }
  for (const resolve of midiMatchWaiters.values()) resolve(null);
  midiMatchWaiters.clear();
}

function recReceivePreview(message) {
  const tx = recTransactions.get(message.session);
  const live = recLive.get(message.session);
  if (!tx || !live || !Array.isArray(message.items)
    || !state.folders.some((folder) => folder.id === tx.folderId)) return;
  const items = new Map();
  for (const item of message.items.slice(0, REC_CFG.REC_PREVIEW_MAX_ITEMS)) {
    if (!item || (typeof item.id !== 'string' && !Number.isFinite(item.id))
      || (typeof item.id === 'string' && (!item.id.length || item.id.length > 128))
      || tx.actions.has(item.id) || !['trigger', 'piano', 'float'].includes(item.kind)
      || !Number.isFinite(item.startFrame) || item.startFrame < 0
      || !Number.isFinite(item.durationFrames) || item.durationFrames < 0) continue;
    const keyframes = [];
    const points = Array.isArray(item.keyframes) ? item.keyframes : [];
    const count = Math.min(points.length, REC_CFG.REC_PREVIEW_MAX_POINTS);
    for (let i = 0; i < count; i++) {
      const point = points[count === 1 ? 0 : Math.round(i * (points.length - 1) / (count - 1))];
      const dt = point && (point.dt ?? point.ms);
      if (Number.isFinite(dt) && dt >= 0 && Number.isFinite(point.value)) {
        keyframes.push({ dt, ms: dt, value: point.value });
      }
    }
    const preview = { id: item.id, kind: item.kind, source: item.source === 'osc' ? 'osc' : 'midi',
      num: Number.isInteger(item.num) && item.num >= 0 && item.num <= 127 ? item.num : undefined,
      ch: Number.isInteger(item.ch) && item.ch >= 1 && item.ch <= 16 ? item.ch : 1,
      device: typeof item.device === 'string' ? item.device.slice(0, 256) : '',
      address: typeof item.address === 'string' && item.address.startsWith('/') ? item.address.slice(0, 1024) : '',
      startFrame: item.startFrame, durationFrames: item.durationFrames,
      cue: { duration: item.durationFrames, recMeta: { kind: item.kind, recordingSpeed: tx.speed, keyframes } } };
    items.set(item.id, preview);
  }
  live.items = items;
}

function recReceiveMapping(session, key, mapping) {
  const tx = recTransactions.get(session);
  if (!tx || !tx.accepted || typeof key !== 'string' || !mapping || !mapping.address || mapping.guessed || mapping.unassigned) return;
  midiMap.set(key, structuredClone(mapping));
  syncOscFloatAddresses();
}

function recReceiveActions(message) {
  const tx = recTransactions.get(message.session);
  if (!tx || !tx.accepted) return;
  for (const entry of Array.isArray(message.mappings) ? message.mappings : []) {
    if (Array.isArray(entry) && entry.length === 2) recReceiveMapping(message.session, entry[0], entry[1]);
  }
  if (!Array.isArray(message.items)) return;
  const f = state.folders.find((folder) => folder.id === tx.folderId);
  if (!f) { setStatus('REC: bài nhận đã bị xóa, không thể đặt cue.'); return; }
  for (const descriptor of message.items) {
    const live = recLive.get(message.session);
    if (live && descriptor) {
      live.items.delete(descriptor.id);
      live.items.delete(descriptor.actionId);
    }
    if (!descriptor || !['trigger', 'piano', 'float'].includes(descriptor.kind) ||
      !Number.isFinite(descriptor.startFrame) ||
      (descriptor.session !== undefined && descriptor.session !== tx.session)) continue;
    if (descriptor.actionId != null && tx.actions.has(descriptor.actionId)) continue;
    const desc = { ...descriptor, startFrame: descriptor.startFrame - tx.offset + f.offset,
      smpteInput: tx.smpteInput, recordingSpeed: tx.speed };
    const cue = recCreateLiveCue(f, desc);
    recFinalizeCue(f, cue, desc);
    if (descriptor.actionId != null) tx.actions.add(descriptor.actionId);
  }
  f.events.sort((a, b) => a.frame - b.frame);
  oscRecDirty = true;
  if (!oscRecFlushTimer) oscRecFlushTimer = setTimeout(flushOscRecUi, REC_UI_FLUSH_MS);
}

/* recStart/recStop share the ordered port; main mode IPC is only discovery state. */
function pushOscMode(reanchor = false) {
  if (reanchor && recActiveSession !== null) {
    pause(true);
    setStatus('REC đã dừng để đổi mốc; chờ chốt phiên rồi bấm Play để ghi tiếp.');
  }
  if (recActiveSession !== null && (!state.recArmed || !state.playing || reanchor)) recStopTransaction();
  if (state.recArmed && state.playing && recActiveSession === null && !recTransactions.size && !recStartTransaction()) {
    pause(true);
  }
  const on = recActiveSession !== null;
  if (on !== oscRecording || state.recArmed !== oscRecArmed) {
    if (!on) oscSession++;
    oscRecording = on;
    oscRecArmed = state.recArmed;
    oscRecSeen.clear();
  }
  if (!oscPort) return;
  try {
    const sendMode = window.hs.oscMode || ((message) => oscPort.post(message));
    sendMode({ type: 'recording', on, session: oscSession });
    sendMode({ type: 'learn', on: state.midiPadMode === 'learn' });
    sendMode({ type: 'debug', on: !!state.recDebug });
  } catch (_) {}
}

if (window.hs.onOscPort) window.hs.onOscPort(attachOscPort);
if (window.hs.onOscProc) window.hs.onOscProc(handleOscProcMessage);

/* Fallback: nếu chạy bản cũ không có port → dùng IPC như trước */
if (window.hs.onOsc) window.hs.onOsc(onOscMessage);
if (window.hs.onOscBatch) {
  window.hs.onOscBatch((batch) => {
    if (!Array.isArray(batch) || !batch.length) return;
    for (let i = 0; i < batch.length; i++) onOscMessage(batch[i]);
  });
}

/* Gửi MIDI event sang utility để đối chiếu (chỉ khi REC bật) */
function oscProcMidiStart(kind, num, ch, startTs, family) {
  if (!oscPort) return null;
  const id = ++midiMatchSeq;
  try {
    oscPort.post({ type: 'midiStart', id, kind, num, ch, ts: startTs, family: family || null });
  } catch (_) { return null; }
  return id;
}
function oscProcMidiEnd(id, endTs) {
  if (!oscPort || !id) return Promise.resolve(null);
  return new Promise((resolve) => {
    midiMatchWaiters.set(id, resolve);
    try { oscPort.post({ type: 'midiEnd', id, ts: endTs }); }
    catch (_) { midiMatchWaiters.delete(id); resolve(null); return; }
    setTimeout(() => {
      if (midiMatchWaiters.has(id)) { midiMatchWaiters.delete(id); resolve(null); }
    }, OSC_MATCH_TIMEOUT_MS);
  });
}
window.hs.onStatus((s) => {
  window.__oscListening = !!s.listening;   // mini bridge đọc cờ này khi broadcast
  if (!s.listening) recInterrupt('OSC chưa lắng nghe');
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

/* =====================================================================
   PANEL OSC — TABBAR ẨN/HIỆN NHANH + NHIỀU ĐỊA CHỈ + LAN
   ===================================================================== */
const OSC_TABS = ['paneOsc', 'paneLan', 'paneMidi', 'paneMon'];
const oscUI = {
  targets: [],        // [{id,name,host,port,enabled,verified,lastError,sent}]
  peers: [],
  lanOn: false,
  lanRole: 'master',
  lanFollow: true,
  pending: new Set()
};

/* --- tab switching --- */
function showOscPane(id) {
  OSC_TABS.forEach((p) => {
    const el = $(p);
    if (el) el.hidden = (p !== id);
  });
  document.querySelectorAll('#oscTabbar .osc-tab').forEach((b) => {
    b.classList.toggle('on', b.dataset.pane === id);
  });
  // Monitor chỉ render khi pane hiển thị; utility chỉ parse để HIỂN THỊ khi pane mở
  const monOpen = (id === 'paneMon');
  if (monOpen) {
    // 2 tab con: OSC cần utility parse/observe, MIDI render từ buffer
    setMonSource(MON.src);
    oscFeed.flushAll();
  } else {
    oscFeed.panelVisible = false;
    if (window.hs.oscUi) {
      window.hs.oscUi({ type: 'uiVisible', on: oscCaptureSeen });
    }
  }
  // MIDI pane cần quét thiết bị lần đầu
  if (id === 'paneMidi' && !MIDI.inputs.length) { midiScan().catch(() => {}); }
  scheduleAutosave();
}

document.querySelectorAll('#oscTabbar .osc-tab').forEach((b) => {
  b.addEventListener('click', () => showOscPane(b.dataset.pane));
});

/* --- nhiều địa chỉ OSC --- */
function renderOscTargets() {
  const box = $('oscTargetList');
  if (!box) return;
  box.innerHTML = '';
  oscUI.targets.forEach((t, i) => {
    const card = document.createElement('div');
    card.className = 'osc-tcard' + (t.verified ? ' verified' : '') + (t.enabled ? '' : ' off');
    card.dataset.id = t.id;

    const head = document.createElement('div');
    head.className = 'osc-tcard-h';
    const chk = document.createElement('span');
    chk.className = 'osc-tcheck' + (t.enabled ? ' on' : '');
    chk.textContent = t.enabled ? '✓' : '';
    chk.title = t.enabled ? 'Đang bật — bấm để tắt' : 'Đang tắt — bấm để bật';
    chk.addEventListener('click', async () => {
      t.enabled = !t.enabled;
      await saveOscTargets();
    });
    const nm = document.createElement('span');
    nm.className = 'tnm';
    nm.textContent = t.name || ('OSC Out ' + (i + 1));
    const sp = document.createElement('span');
    sp.className = 'spacer';
    const btnConn = document.createElement('button');
    btnConn.className = 'osc-knob' + (t.verified ? ' ok' : '');
    btnConn.textContent = t.verified ? 'Đã kết nối' : 'Kết nối';
    btnConn.addEventListener('click', () => verifyTarget(t.id));
    head.append(chk, nm, sp, btnConn);

    const grid = document.createElement('div');
    grid.className = 'osc-tgrid';
    const lHost = document.createElement('label');
    lHost.innerHTML = '<span>HOST / IP</span>';
    const inHost = document.createElement('input');
    inHost.type = 'text'; inHost.value = t.host;
    inHost.addEventListener('change', async () => { t.host = inHost.value.trim() || '127.0.0.1'; await saveOscTargets(); });
    lHost.appendChild(inHost);
    const lPort = document.createElement('label');
    lPort.innerHTML = '<span>PORT</span>';
    const inPort = document.createElement('input');
    inPort.type = 'number'; inPort.value = t.port;
    inPort.addEventListener('change', async () => { t.port = parseInt(inPort.value, 10) || 7001; await saveOscTargets(); });
    lPort.appendChild(inPort);
    grid.append(lHost, lPort);

    const msg = document.createElement('div');
    msg.className = 'osc-tmsg' + (t.verified ? ' ok' : (t.lastError ? ' err' : ''));
    msg.textContent = t.verified
      ? '✓ Đã xác thực — kết nối 2 chiều OK.'
      : (t.lastError || 'Bấm "Kiểm tra" để xác thực Resolume.');

    const foot = document.createElement('div');
    foot.className = 'osc-tfoot';
    const sent = document.createElement('span');
    sent.className = 'sent';
    sent.textContent = t.sent ? `Đã gửi ${t.sent} gói` : 'Chưa gửi gói nào';
    const btnFind = document.createElement('button');
    btnFind.className = 'osc-knob ghost';
    btnFind.textContent = 'Tìm Resolume';
    btnFind.addEventListener('click', () => findTarget(t.id));
    const btnVerify = document.createElement('button');
    btnVerify.className = 'osc-knob ghost';
    btnVerify.textContent = 'Kiểm tra';
    btnVerify.addEventListener('click', () => verifyTarget(t.id));
    const del = document.createElement('button');
    del.className = 'osc-del';
    del.textContent = '🗑';
    del.title = 'Xoá địa chỉ này';
    del.addEventListener('click', async () => {
      oscUI.targets = oscUI.targets.filter((x) => x.id !== t.id);
      await saveOscTargets();
    });
    foot.append(sent, btnFind, btnVerify, del);

    card.append(head, grid, msg, foot);
    box.appendChild(card);
  });
  if (!oscUI.targets.length) {
    const em = document.createElement('div');
    em.className = 'osc-tmsg';
    em.textContent = 'Chưa có địa chỉ OSC — bấm "＋ Thêm".';
    box.appendChild(em);
  }
  mountCueOutputSelector(state.sel);
}

async function saveOscTargets() {
  if (window.hs.oscTargetsSet) {
    oscUI.targets = await window.hs.oscTargetsSet(oscUI.targets);
  }
  syncLegacyTarget();
  renderOscTargets();
  updateLanSummary();
  scheduleAutosave();
}

async function findTarget(id) {
  const t = oscUI.targets.find((x) => x.id === id);
  if (!t) return;
  t.lastError = null;
  renderOscTargets();
  const r = await window.hs.oscTargetsFind(id);
  if (r && r.ok) {
    t.verified = true;
  } else {
    t.verified = false;
    t.lastError = (r && r.error) || 'Không tìm thấy Resolume';
  }
  renderOscTargets();
  flashStatus(r && r.ok ? `Tìm thấy Resolume tại ${r.host}:${r.port}` : 'Không tìm thấy Resolume — kiểm tra OSC Output trong Arena.');
}

async function verifyTarget(id) {
  const t = oscUI.targets.find((x) => x.id === id);
  if (!t) return;
  t.lastError = null;
  renderOscTargets();
  const r = await window.hs.oscTargetsVerify(id);
  if (r && r.ok) {
    t.verified = true;
    flashStatus(`✓ Kết nối 2 chiều OK với ${r.host}:${r.port} (RX ${r.rxMsgs || 0} · echo ${r.echoMsgs || 0} gói)`);
  } else {
    t.verified = false;
    t.lastError = (r && r.error) || 'Không xác thực được';
    flashStatus('✗ ' + t.lastError);
  }
  renderOscTargets();
}

$('btnAddOscTarget').addEventListener('click', async () => {
  const n = oscUI.targets.length + 1;
  oscUI.targets.push({
    id: 't' + Date.now() + '_' + n,
    name: 'OSC Out ' + n,
    host: n === 1 ? '127.0.0.1' : '192.168.1.2' + (n - 1),
    port: 7001,
    enabled: true, verified: false, lastError: null, sent: 0
  });
  await saveOscTargets();
});

/* --- LAN sync --- */
function renderLanPeers() {
  const box = $('lanPeers');
  if (!box) return;
  box.innerHTML = '';
  if (!oscUI.peers.length) {
    const em = document.createElement('div');
    em.className = 'osc-tmsg';
    em.textContent = oscUI.lanOn ? 'Đang tìm các máy khác trong nhóm…' : 'LAN đang tắt.';
    box.appendChild(em);
    return;
  }
  oscUI.peers.forEach((p) => {
    const c = document.createElement('div');
    c.className = 'peer-card';
    const dot = document.createElement('span'); dot.className = 'dot';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.name;
    const ip = document.createElement('span'); ip.className = 'ip'; ip.textContent = p.ip;
    const role = document.createElement('span');
    role.className = 'role' + (p.role === 'master' ? ' master' : '');
    role.textContent = p.role === 'master' ? 'MÁY CHÍNH' : 'BACKUP';
    c.append(dot, nm, ip, role);
    box.appendChild(c);
  });
}

function updateLanSummary() {
  const el = $('lanSummary');
  if (!el) return;
  const n = oscUI.peers.length + (oscUI.lanOn ? 1 : 0);
  const verified = oscUI.targets.filter((t) => t.verified && t.enabled).length;
  el.textContent = oscUI.lanOn ? `${n} máy · ${verified} xác thực` : `${verified} xác thực`;
  el.title = oscUI.lanOn
    ? `LAN bật · ${oscUI.peers.length} máy khác trong nhóm`
    : 'LAN tắt';
}

function renderLanSelf() {
  const el = $('lanSelf');
  if (!el) return;
  el.innerHTML = oscUI.lanOn
    ? `Máy này: <b>${$('lanName').value || '—'}</b> · vai trò <b>${oscUI.lanRole === 'master' ? 'Máy chính' : 'Máy backup'}</b>`
    : 'LAN đang tắt — bấm "Bật LAN" để tìm máy khác.';
}

async function refreshLanStatus() {
  if (!window.hs.lanStatus) return;
  const st = await window.hs.lanStatus();
  oscUI.lanOn = !!st.running;
  oscUI.lanRole = st.role || 'master';
  $('lanState').textContent = st.running ? 'ĐANG CHẠY' : 'TẮT';
  $('lanState').className = 'pill ' + (st.running ? 'on' : 'off');
  $('btnLanToggle').textContent = st.running ? 'Tắt LAN' : 'Bật LAN';
  $('btnLanToggle').className = 'mini' + (st.running ? '' : ' primary');
  if (st.deviceName && !$('lanName').value) $('lanName').value = st.deviceName;
  if (st.group) $('lanGroup').value = st.group;
  $('lanRole').value = oscUI.lanRole;
  $('lanFollow').checked = st.followMaster !== false;
  oscUI.peers = st.peers || [];
  renderLanPeers();
  renderLanSelf();
  updateLanSummary();
}

$('btnLanToggle').addEventListener('click', async () => {
  if (oscUI.lanOn) {
    await window.hs.lanStop();
  } else {
    await window.hs.lanConfig({
      role: $('lanRole').value,
      group: $('lanGroup').value.trim() || '404TC',
      deviceName: $('lanName').value.trim() || undefined,
      followMaster: $('lanFollow').checked
    });
    await window.hs.lanStart();
  }
  await refreshLanStatus();
  flashStatus(oscUI.lanOn ? 'LAN đã bật — đang tìm máy khác.' : 'LAN đã tắt.');
});

['lanRole', 'lanGroup', 'lanName', 'lanFollow'].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener('change', async () => {
    await window.hs.lanConfig({
      role: $('lanRole').value,
      group: $('lanGroup').value.trim() || '404TC',
      deviceName: $('lanName').value.trim() || undefined,
      followMaster: $('lanFollow').checked
    });
    oscUI.lanRole = $('lanRole').value;
    renderLanSelf();
  });
});

if (window.hs.onOscTargets) {
  window.hs.onOscTargets((list) => {
    oscUI.targets = Array.isArray(list) ? list : [];
    renderOscTargets();
    updateLanSummary();
  });
}
if (window.hs.onLanPeers) {
  window.hs.onLanPeers((peers) => {
    oscUI.peers = Array.isArray(peers) ? peers : [];
    renderLanPeers();
    updateLanSummary();
  });
}
if (window.hs.onLanProject) {
  window.hs.onLanProject((json) => {
    // Máy backup nhận show từ máy chính
    try {
      const data = typeof json === 'string' ? JSON.parse(json) : json;
      if (data && data.version) {
        applyProject(data);
        setStatus('Đã nhận show từ máy chính.');
      }
    } catch (_) {}
  });
}
if (window.hs.onLanControl) {
  window.hs.onLanControl((cmd) => {
    if (!cmd) return;
    if (cmd === 'play' && !state.playing) play();
    else if (cmd === 'pause' && state.playing) pause();
    else if (cmd === 'stop') stop();
  });
}

/* Đồng bộ show lên máy khác khi master thay đổi (debounce 1,2s) */
let lanPushTimer = null;
function lanPushProject() {
  if (!oscUI.lanOn || oscUI.lanRole !== 'master') return;
  clearTimeout(lanPushTimer);
  lanPushTimer = setTimeout(() => {
    try {
      window.hs.lanSendProject(JSON.stringify(serializeProject()));
    } catch (_) {}
  }, 1200);
}

/* Khởi tạo khi mở panel lần đầu */
async function initOscPanelOnce() {
  if (initOscPanelOnce.done) return;
  initOscPanelOnce.done = true;
  if (window.hs.oscTargetsGet) {
    oscUI.targets = await window.hs.oscTargetsGet();
    if (!oscUI.targets.length) {
      oscUI.targets = [{
        id: 't' + Date.now(), name: 'OSC Out 1', host: '127.0.0.1', port: 7001,
        enabled: true, verified: false, lastError: null, sent: 0
      }];
      await saveOscTargets();
    }
    renderOscTargets();
  }
  await refreshLanStatus();
  updateLanSummary();
}

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
  oscFeed.testVisible = true;
  oscCaptureSeen = true;
  if (window.hs.oscUi) {
    window.hs.oscUi({ type: 'captureSeen', on: true });
    window.hs.oscUi({ type: 'uiVisible', on: true });
  }
  oscFeed.flushAll();          // hiện ngay dữ liệu đã gom (giới hạn)
  renderTestOscRows();
}

function closeTestOsc() {
  oscAssignCue = null;
  $('testOscModal').style.display = 'none';
  oscFeed.testVisible = false; // ẩn = không tích lũy/không render thêm
  oscCaptureSeen = false;
  if (window.hs.oscUi) {
    window.hs.oscUi({ type: 'captureSeen', on: false });
    window.hs.oscUi({ type: 'uiVisible', on: !!oscFeed.panelVisible });
  }
}

/* =====================================================================
   TOOL: CONVERT NHẠC — UI layer
   UI chỉ nói chuyện với Conversion Manager (main process qua preload).
   Không có process/scan nào chạy khi tool đóng.
   ===================================================================== */
const CONV = {
  files: [],          // { id, path, rel, name, fmt, duration, size, checked, status, pct, err, speed }
  running: false,
  paused: false,
  total: 0,
  doneCount: 0,
  wired: false
};

function convId() { return 'c' + (++idSeq); }

function convFmtOf(p) {
  const m = /\.([a-z0-9]+)$/i.exec(p || '');
  return (m ? m[1] : 'AUDIO').toUpperCase().replace('AIF', 'AIFF');
}

function convTc(sec) {
  if (!isFinite(sec) || sec <= 0) return '—';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function convPcmOpts() {
  const q = $('convPcmQ').value;
  if (q === 'src') return { sampleRate: '', bitDepth: '', channels: '' };
  const [sr, bd] = q.split('-');
  return { sampleRate: sr === '44' ? 44100 : sr === '48' ? 48000 : 96000, bitDepth: bd === '16' ? '16' : '24', channels: '' };
}

function convSettings() {
  const fmt = $('convFmt').value;
  const s = {
    format: fmt,
    outDir: $('convOutDir').value,
    keepTree: $('convKeepTree').checked,
    meta: $('convMeta').checked,
    dup: $('convDup').value,
    openAfter: $('convOpenAfter').checked
  };
  if (fmt === 'wav' || fmt === 'aiff') Object.assign(s, convPcmOpts());
  else if (fmt === 'mp3') { s.bitrate = Number($('convMp3Q').value); }
  else if (fmt === 'flac') { Object.assign(s, convPcmOpts()); }
  else { s.bitrate = Number($('convCompQ').value); }
  return s;
}

function convGroups() {
  const v = $('convFmt').value;
  $('convGrpPcm').hidden = !(v === 'wav' || v === 'aiff' || v === 'flac');
  $('convGrpMp3').hidden = v !== 'mp3';
  $('convGrpComp').hidden = !(v === 'm4a' || v === 'ogg' || v === 'opus');
  convWarn();
}

function convWarn() {
  const hasMp3 = CONV.files.some((f) => f.checked && f.fmt === 'MP3');
  $('convWarn').classList.toggle('show', hasMp3 && $('convFmt').value === 'wav');
}

function convRender() {
  const box = $('convList');
  const map = {
    wait: ['wait', 'ĐANG CHỜ'], conv: ['conv', 'CONVERTING'], done: ['done', 'XONG'],
    fail: ['fail', 'LỖI'], skip: ['skip', 'BỎ QUA'], cancel: ['cancel', 'ĐÃ HỦY']
  };
  box.innerHTML = CONV.files.map((f, i) => {
    const m = map[f.status] || map.wait;
    return `<div class="conv-row ${f.status === 'conv' ? 'conv' : ''} ${f.status === 'done' ? 'done' : ''} ${f.showErr ? 'showdetails' : ''}" draggable="true" data-i="${i}">
      <input type="checkbox" ${f.checked ? 'checked' : ''} ${f.status === 'conv' ? 'disabled' : ''}>
      <div class="conv-fnm"><b title="${f.path}">${f.name}</b><span class="conv-fprog"><i style="width:${f.pct || 0}%"></i></span></div>
      <span class="conv-fmt ${f.fmt === 'WAV' ? 'wav' : f.fmt === 'FLAC' ? 'flac' : f.fmt === 'M4A' ? 'm4a' : ''}">${f.fmt}</span>
      <span class="conv-dim">${convTc(f.duration)}</span>
      <span class="conv-st ${m[0]}">${m[1]}</span>
      <div class="conv-detail">${f.err || ''}</div>
    </div>`;
  }).join('') || '<div class="conv-empty">Chưa có file — kéo vào hoặc bấm ＋ File</div>';

  box.querySelectorAll('.conv-row').forEach((el) => {
    const i = Number(el.dataset.i);
    const f = CONV.files[i];
    if (!f) return;
    el.querySelector('input').addEventListener('change', (e) => { f.checked = e.target.checked; convUpdate(); });
    el.querySelector('.conv-st').addEventListener('click', () => {
      if (f.status === 'fail') { f.showErr = !f.showErr; convRender(); }
    });
    el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/conv-idx', String(i)));
    el.addEventListener('dragover', (e) => e.preventDefault());
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData('text/conv-idx'));
      if (!Number.isInteger(from) || from === i) return;
      const [moved] = CONV.files.splice(from, 1);
      CONV.files.splice(i, 0, moved);
      convRender();
    });
  });

  $('convCount').textContent = CONV.files.length + ' file';
  const totalDur = CONV.files.reduce((a, f) => a + (f.duration || 0), 0);
  $('convSum').innerHTML = `<b>${CONV.files.length}</b> files • ${convTc(totalDur)}`;
  convUpdate();
}

function convUpdate() {
  const sel = CONV.files.filter((f) => f.checked && f.status !== 'conv').length;
  $('convSelInfo').textContent = sel + ' được chọn';
  convWarn();
  const canRun = !CONV.running && CONV.files.some((f) => f.checked && ['wait', 'fail', 'cancel', 'done'].includes(f.status));
  $('convRun').disabled = !canRun;
  $('convPause').disabled = !CONV.running;
  $('convPause').textContent = CONV.paused ? '▶' : '⏸';
  $('convPause').title = CONV.paused ? 'Resume' : 'Pause';
  $('convCancel').disabled = !CONV.running;
}

function convAddPaths(paths, relBase) {
  if (!paths || !paths.length) return;
  const before = CONV.files.length;
  paths.forEach((p) => {
    const rel = relBase ? pathDirRel(relBase, p) : '';
    CONV.files.push({
      id: convId(), path: p, rel, name: p.split('/').pop(),
      fmt: convFmtOf(p), duration: 0, size: 0,
      checked: true, status: 'wait', pct: 0, err: '', speed: 0
    });
  });
  convRender();
  // lấy duration bất đồng bộ, cập nhật dần
  const slice = CONV.files.slice(before);
  window.hs.convProbe(slice.map((f) => f.path)).then((durs) => {
    slice.forEach((f, i) => { f.duration = durs[i] || 0; });
    convRender();
  }).catch(() => {});
}

function pathDirRel(base, full) {
  if (!base || !full || !full.startsWith(base)) return '';
  const rel = full.slice(base.length).replace(/^\/+/, '');
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  return dir;
}

async function convPickFiles() {
  const paths = await window.hs.convPickFiles();
  convAddPaths(paths);
}

async function convPickFolder(deep) {
  const dir = await window.hs.convPickFolderIn();
  if (!dir) return;
  setStatus('Đang quét thư mục…');
  try {
    const found = await window.hs.convScanFolder(dir, deep);
    if (!found.length) { flashStatus('Không tìm thấy file âm thanh trong thư mục.'); return; }
    convAddPaths(found.map((x) => x.path), deep ? dir : '');
    // gán rel + duration + size có sẵn từ scan (không probe lại)
    const added = CONV.files.slice(-found.length);
    added.forEach((f, i) => {
      f.rel = found[i].rel || '';
      f.duration = found[i].duration || 0;
      f.size = found[i].size || 0;
    });
    convRender();
    flashStatus(`Đã thêm ${found.length} file từ thư mục.`);
  } catch (e) {
    setStatus('Lỗi quét thư mục: ' + e.message);
  }
}

function convStart() {
  if (CONV.running) return;
  if (!$('convOutDir').value) { flashStatus('Chọn thư mục lưu trước khi convert.'); return; }
  // cho phép convert LẠI file đã xong (đổi chất lượng / đổi nơi lưu vẫn chạy được)
  const sel = CONV.files.filter((f) => f.checked && ['wait', 'fail', 'cancel', 'done'].includes(f.status));
  if (!sel.length) { flashStatus('Không có file nào được chọn để convert.'); return; }
  sel.forEach((f) => { f.status = 'wait'; f.pct = 0; f.err = ''; f.showErr = false; });
  CONV.jobMap = sel;               // map phản hồi index → đúng object file của lần chạy này
  CONV.total = sel.length;
  CONV.doneCount = 0;
  $('convDone').classList.remove('show');
  $('convBarBatch').style.width = '0%';
  $('convPctBatch').textContent = '0/' + sel.length;
  $('convBarFile').style.width = '0%';
  $('convPctFile').textContent = '0%';
  CONV.running = true;
  CONV.paused = false;
  convRender();
  window.hs.convStart({
    files: sel.map((f) => ({ path: f.path, rel: f.rel, duration: f.duration })),
    opts: convSettings()
  }).then((res) => {
    CONV.total = res.total;
    convUpdate();
  }).catch((e) => {
    CONV.running = false;
    convUpdate();
    flashStatus('Không bắt đầu được convert: ' + e.message);
  });
}

function convWire() {
  if (CONV.wired) return;
  CONV.wired = true;

  $('convClose').addEventListener('click', () => convClose());
  $('convAddFiles').addEventListener('click', () => convPickFiles());
  $('convDrop').addEventListener('click', () => convPickFiles());
  $('convDrop').addEventListener('dragover', (e) => { e.preventDefault(); $('convDrop').classList.add('over'); });
  $('convDrop').addEventListener('dragleave', () => $('convDrop').classList.remove('over'));
  $('convDrop').addEventListener('drop', async (e) => {
    e.preventDefault();
    $('convDrop').classList.remove('over');
    const paths = [];
    for (const f of e.dataTransfer.files || []) {
      const p = window.hs.filePath(f);
      if (p) paths.push(p);
    }
    convAddPaths(paths);
  });

  $('convAddFolder').addEventListener('click', (e) => {
    e.stopPropagation();
    $('convFolderPop').classList.toggle('open');
  });
  document.addEventListener('click', () => $('convFolderPop').classList.remove('open'));
  $('convFolderPop').querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      $('convFolderPop').classList.remove('open');
      convPickFolder(b.dataset.mode === 'deep');
    });
  });

  $('convSelAll').addEventListener('click', () => { CONV.files.forEach((f) => { f.checked = true; }); convRender(); });
  $('convDeselAll').addEventListener('click', () => { CONV.files.forEach((f) => { f.checked = false; }); convRender(); });
  $('convRmSel').addEventListener('click', () => {
    CONV.files = CONV.files.filter((f) => !f.checked || f.status === 'conv');
    convRender();
  });
  $('convClear').addEventListener('click', () => {
    if (CONV.running) { flashStatus('Dừng convert trước khi xóa hàng đợi.'); return; }
    CONV.files = [];
    convRender();
  });

  $('convFmt').addEventListener('change', convGroups);
  $('convPickOut').addEventListener('click', async () => {
    const dir = await window.hs.convPickFolderOut();
    if (dir) $('convOutDir').value = dir;
  });

  $('convRun').addEventListener('click', convStart);
  $('convPause').addEventListener('click', () => {
    if (!CONV.running) return;
    CONV.paused = !CONV.paused;
    if (CONV.paused) window.hs.convPause(); else window.hs.convResume();
    convUpdate();
  });
  $('convCancel').addEventListener('click', () => {
    if (!CONV.running) return;
    window.hs.convCancel();
    CONV.files.forEach((f) => {
      if (f.status === 'conv' || (f.status === 'wait' && f.checked)) { f.status = 'cancel'; f.pct = 0; }
    });
    CONV.running = false;
    CONV.paused = false;
    $('convCur').textContent = 'Đã hủy — file tạm đã xóa';
    $('convBarFile').style.width = '0%';
    $('convPctFile').textContent = '0%';
    convRender();
  });

  $('convRetry').addEventListener('click', () => {
    CONV.files.forEach((f) => { if (f.status === 'fail') { f.status = 'wait'; f.pct = 0; f.err = ''; f.showErr = false; } });
    convRender();
    convStart();
  });
  $('convDoneBtn').addEventListener('click', () => { $('convDone').classList.remove('show'); $('convCur').textContent = 'Sẵn sàng'; });
  $('convOpenFolder').addEventListener('click', () => {
    const dir = $('convOutDir').value;
    if (dir) window.hs.convOpenFolder(dir);
  });

  /* Sự kiện từ Conversion Manager */
  window.hs.onConvItem((p) => {
    // map theo ĐÚNG danh sách của lần chạy này (không theo trạng thái checked hiện tại)
    const item = (CONV.jobMap && CONV.jobMap[p.i]) || CONV.files[p.i];
    if (!item) return;
    if (p.status === 'converting') {
      item.status = 'conv'; item.pct = 0;
      $('convCur').innerHTML = `Đang convert: <b>${item.name}</b> → ${p.out || ''}`;
      convRender();
    } else if (p.status === 'done') {
      item.status = 'done'; item.pct = 100;
      CONV.doneCount++;
      $('convBarBatch').style.width = (CONV.doneCount / Math.max(1, CONV.total) * 100) + '%';
      $('convPctBatch').textContent = CONV.doneCount + '/' + CONV.total;
      convRender();
    } else if (p.status === 'failed') {
      item.status = 'fail'; item.err = p.error || 'Lỗi không xác định'; item.showErr = false;
      convRender();
    } else if (p.status === 'skipped') {
      item.status = 'skip';
      convRender();
    } else if (p.status === 'cancelled') {
      item.status = 'cancel'; item.pct = 0;
      convRender();
    } else {
      if (typeof p.pct === 'number') {
        item.pct = p.pct;
        const row = $('convList').querySelector(`.conv-row[data-i="${CONV.files.indexOf(item)}"]`);
        if (row) {
          const bar = row.querySelector('.conv-fprog i');
          if (bar) bar.style.width = p.pct + '%';
        }
        $('convBarFile').style.width = p.pct + '%';
        $('convPctFile').textContent = Math.round(p.pct) + '%';
      }
      if (typeof p.speed === 'number') item.speed = p.speed;
    }
  });

  window.hs.onConvState((p) => {
    if (p.total) CONV.total = p.total;
    if (typeof p.paused === 'boolean') CONV.paused = p.paused;
    if (typeof p.running === 'boolean') CONV.running = p.running;
    convUpdate();
  });

  window.hs.onConvDone((p) => {
    CONV.running = false;
    CONV.paused = false;
    $('convCur').textContent = p.cancelled ? 'Đã hủy' : 'Hoàn tất';
    $('convBarFile').style.width = '0%';
    $('convPctFile').textContent = '0%';
    const fail = p.failed || 0;
    if (!p.cancelled) {
      $('convDoneTitle').textContent = `${p.done} files converted successfully`;
      $('convDoneStats').innerHTML =
        `<span class="ok">Completed: ${p.done}</span><span class="er">Failed: ${fail}</span><span class="sk">Skipped: ${p.skipped || 0}</span>`;
      $('convDone').classList.add('show');
      $('convRetry').style.display = fail ? 'inline-flex' : 'none';
      if (p.outDir && $('convOutDir').value) {
        CONV.lastOutDir = p.outDir;
      }
      if ($('convOpenAfter').checked && p.outDir) window.hs.convOpenFolder(p.outDir);
    }
    convRender();
  });
}

function convClose() {
  if (CONV.running) window.hs.convCancel();   // đóng tool = dừng an toàn, xóa file tạm
  CONV.running = false;
  CONV.paused = false;
  $('convModal').style.display = 'none';
  $('convDone').classList.remove('show');
  $('convBarFile').style.width = '0%';
  $('convPctFile').textContent = '0%';
}

function openConvTool() {
  $('convModal').style.display = 'flex';
  convWire();
  convGroups();
  // mặc định lưu vào Downloads (chỉ set nếu người dùng chưa chọn thư mục)
  if (!$('convOutDir').value) {
    window.hs.convDefaultOut().then((dir) => {
      if (dir && !$('convOutDir').value) $('convOutDir').value = dir;
    }).catch(() => {});
  }
  convRender();
  // kiểm tra FFmpeg chỉ khi MỞ tool
  window.hs.convBins().then((b) => {
    const el = $('convEngine');
    if (!b.ffmpeg) { el.textContent = 'FFmpeg: không tìm thấy'; el.classList.add('bad'); }
    else { el.textContent = 'FFmpeg ✓'; el.classList.remove('bad'); }
  }).catch(() => {});
}

function renderTestOscRows() {
  const box = $('toRows');
  if (!box) return;
  const src = TEST_OSC.rows.length ? TEST_OSC.rows : oscFeed.snapshotTest().map(testRowOf);
  box.innerHTML = '';
  const shown = src.filter(toPassFilters).slice(-300);
  shown.forEach((m) => {
    const div = document.createElement('div');
    div.className = 'to-row' + (m.tx ? ' tx' : '');
    const t = document.createElement('span'); t.textContent = m.t;
    const a = document.createElement('span'); a.className = 'addr'; a.textContent = m.address;
    const ty = document.createElement('span'); ty.className = 'typ'; ty.textContent = oscTypeLabel(m.type);
    const v = document.createElement('span'); v.className = 'args'; v.textContent = (m.args || []).join(', ');
    div.append(t, a, ty, v);
    div.addEventListener('click', () => {
      if (oscAssignCue) {
        recAssignOsc(oscAssignCue, m.address, m.args);
        closeTestOsc();
      } else cueFromOsc(m.address, m.args);
    });
    box.appendChild(div);
  });
  $('toCount').textContent = `${TEST_OSC.rows.length} gói`;
  if ($('toAutoScroll').checked) box.scrollTop = box.scrollHeight;
}

/* Test OSC giờ gom trong oscFeed (giới hạn testMaxRows); đây chỉ là chuyển đổi dòng */
function testRowOf(r) {
  const d = new Date(r.t);
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  return { t, address: r.address, args: r.args, type: oscTypeOf(r.args), tx: false };
}
function toRecord(msg) {
  // Không cần nữa: oscFeed.ingest đã ghi khi testVisible. Giữ hàm cho tương thích.
}

$('toClose').addEventListener('click', closeTestOsc);
$('testOscModal').addEventListener('mousedown', (e) => { if (e.target === $('testOscModal')) closeTestOsc(); });
$('toStart').addEventListener('click', () => {
  // Test OSC cần cổng nghe để nhận — bấm "Bắt đầu nhận" là hành động bật OSC của người dùng
  if (!window.__oscListening) window.hs.oscEnable().catch(() => {});
  TEST_OSC.on = true;
  oscFeed.testVisible = true;
  oscCaptureSeen = true;
  if (window.hs.oscUi) {
    window.hs.oscUi({ type: 'captureSeen', on: true });
    window.hs.oscUi({ type: 'uiVisible', on: true });
  }
  oscFeed.flushAll();
  $('toStart').disabled = true;
  $('toStart').textContent = '● Đang nhận…';
  $('toStart').classList.add('armed');
  $('toStop').disabled = false;
  flashStatus('Test OSC: đang nhận mọi OSC đến cổng nghe. Bấm OSC trong bảng để tạo cue.');
});
$('toStop').addEventListener('click', () => {
  TEST_OSC.on = false;
  oscFeed.testVisible = false;
  oscCaptureSeen = false;
  if (window.hs.oscUi) {
    window.hs.oscUi({ type: 'captureSeen', on: false });
    window.hs.oscUi({ type: 'uiVisible', on: !!oscFeed.panelVisible });
  }
  $('toStart').disabled = false;
  $('toStart').textContent = '▶ Bắt đầu nhận';
  $('toStart').classList.remove('armed');
  $('toStop').disabled = true;
  flashStatus('Test OSC: đã dừng nhận.');
});
$('toClear').addEventListener('click', () => { TEST_OSC.rows = []; oscFeed.test.length = 0; oscFeed.pendingTestRows.length = 0; renderTestOscRows(); });
$('toFilterText').addEventListener('input', (e) => { TEST_OSC.text = e.target.value.toLowerCase(); renderTestOscRows(); });
$('toFilterRegex').addEventListener('input', (e) => { TEST_OSC.regex = e.target.value.trim(); renderTestOscRows(); });
$('toFilterType').addEventListener('change', (e) => { TEST_OSC.type = e.target.value; renderTestOscRows(); });

/* ================= Kéo giãn panel + thanh trượt RỘNG/CAO ================= */
(function setupSplitters() {
  const cuePanel = $('cuePanel'), oscPanel = $('oscPanel'), center = $('center');
  const props = $('propsPanel');

  /* Kéo giãn panel bằng DELTA từ lúc bấm — không phụ thuộc vị trí mép màn hình.
     splitR nằm sát mép phải (cách 6px), nên công thức "innerWidth - clientX" cho sai số. */
  function dragX(handle, getWidth, setWidth, sign) {
    const dir = sign === -1 ? -1 : 1;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = getWidth();
      const mm = (ev) => setWidth(startW + dir * (ev.clientX - startX));
      const mu = () => {
        document.removeEventListener('mousemove', mm);
        document.removeEventListener('mouseup', mu);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        handle.classList.remove('dragging');
        scheduleAutosave();
      };
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', mm);
      document.addEventListener('mouseup', mu);
    });
  }

  const minPanel = 250;
  const maxPanel = () => Math.min(620, window.innerWidth * 0.5);

  dragX(
    $('splitL'),
    () => cuePanel.getBoundingClientRect().width,
    (w) => { cuePanel.style.width = clamp(w, minPanel, maxPanel()) + 'px'; }
  );
  /* splitR nằm ở MÉP TRÁI panel (giữa timeline và panel).
     Panel neo mép phải cửa sổ ⇒ kéo splitter sang TRÁI = panel RỘNG ra, sang PHẢI = HẸP lại. */
  dragX(
    $('splitR'),
    () => oscPanel.getBoundingClientRect().width,
    (w) => { oscPanel.style.width = clamp(w, minPanel, maxPanel()) + 'px'; },
    -1
  );
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
    const pv = $('ppsVal'); if (pv) pv.textContent = Math.round(Number(ppsRange.value)) + '%';
    syncSliderFill(ppsRange);
  });

  // thanh trượt CAO: chiều cao lane toàn bộ layer (V/R; lane A tỉ lệ 1.6×)
  $('rowHRange').addEventListener('input', (e) => {
    state.rowH = Number(e.target.value);
    state.aRowH = clamp(Math.round(state.rowH * 1.6), 30, 150);
    const rv = $('rowHVal'); if (rv) rv.textContent = state.rowH + 'px';
    syncSliderFill(e.target);
    scheduleAutosave();
  });

  // ===== TAB «Bài» | «Nhạc» — panel trái 2 tầng =====
  $('tabCue').addEventListener('click', () => switchCueTab(true));
  $('tabMusic').addEventListener('click', () => switchCueTab(false));
  // 🔍 tìm cue / tìm bài hát — icon bật/tắt ô tìm (mặc định đóng)
  $('btnCueSearch').addEventListener('click', () => toggleSearch('cueSearch', 'btnCueSearch'));
  $('btnSongSearch').addEventListener('click', () => toggleSearch('songSearch', 'btnSongSearch'));
})();

function mountCueOutputSelector(ev) {
  let row = $('pOscTargetRow');
  if (!ev) { if (row) row.hidden = true; return; }
  const folder = state.folders.find((item) => item.events.includes(ev));
  const def = folder && folder.cues.find((item) => item.id === ev.cueId);
  if (!def || !$('propsBody')) return;
  if (!row) {
    row = document.createElement('label');
    row.id = 'pOscTargetRow';
    row.className = 'row';
    const label = document.createElement('span');
    label.textContent = 'OSC Out';
    const select = document.createElement('select');
    select.id = 'pOscTarget';
    row.append(label, select);
    $('propsBody').appendChild(row);
  }
  row.hidden = false;
  const select = $('pOscTarget');
  select.innerHTML = '';
  const targets = typeof oscUI !== 'undefined' ? oscUI.targets : [];
  const selected = def.outputTarget == null ? null : Array.isArray(def.outputTarget) ? def.outputTarget : [def.outputTarget];
  function option(value, text) {
    const item = document.createElement('option');
    item.value = value;
    item.textContent = text;
    select.appendChild(item);
  }
  option('', 'Tất cả OSC Out');
  for (const target of targets) option(JSON.stringify([target.id]),
    (target.name || target.id) + (target.enabled === false ? ' (đang tắt)' : ''));
  if (selected && (selected.length !== 1 || !targets.some((target) => target.id === selected[0]))) {
    option(JSON.stringify(selected), selected.length === 1 ? selected[0] + ' (không khả dụng)' :
      selected.length ? selected.join(', ') + ' (nhóm OSC Out)' : 'Không gửi OSC');
  }
  select.value = selected ? JSON.stringify(selected) : '';
  const lane = (folder.lanes || []).find((item) => ev.laneId != null ? item.id === ev.laneId : item.name === ev.lane);
  select.disabled = !!(lane && lane.locked);
  select.onchange = () => {
    if (select.disabled || state.sel !== ev || !folder.events.includes(ev)) return;
    noteChange();
    if (!select.value) delete def.outputTarget;
    else {
      const ids = JSON.parse(select.value);
      def.outputTarget = ids.length === 1 ? ids[0] : ids;
    }
    rebuildFlat();
    noteChange();
    scheduleAutosave();
  };
}

function recMoveLaneById(id, toIdOrDelta) {
  const folder = curFolder();
  if (!folder) return false;
  const lanes = state.lanes.filter((lane) => lane.kind === 'R');
  const from = lanes.findIndex((lane) => String(lane.id) === String(id));
  const to = typeof toIdOrDelta === 'number' ? from + toIdOrDelta
    : lanes.findIndex((lane) => String(lane.id) === String(toIdOrDelta));
  if (from < 0 || to < 0 || to >= lanes.length || from === to
    || lanes.slice(Math.min(from, to), Math.max(from, to) + 1).some((lane) => lane.locked)) return false;
  noteChange();
  const [moving] = lanes.splice(from, 1);
  lanes.splice(to, 0, moving);
  let index = 0;
  state.lanes.splice(0, state.lanes.length, ...state.lanes.map((lane) => lane.kind === 'R' ? lanes[index++] : lane));
  folder.lanes = state.lanes;
  recNormalizeLanes(folder, false);
  refreshAll();
  noteChange();
  scheduleAutosave();
  return true;
}

function renderRecLaneOrder() {
  const anchor = $('recLaneSel');
  if (!anchor || !anchor.parentElement) return;
  let panel = $('recLaneOrder');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'recLaneOrder';
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', 'Thứ tự hàng REC');
    anchor.parentElement.parentElement.appendChild(panel);
  }
  panel.innerHTML = '';
  const lanes = state.lanes.filter((lane) => lane.kind === 'R');
  panel.hidden = lanes.length < 2;
  for (const [index, lane] of lanes.entries()) {
    const row = document.createElement('div');
    row.className = 'row';
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.textContent = lane.name + (lane.groupLabel ? ' · ' + lane.groupLabel : '');
    handle.title = 'Kéo để đổi thứ tự; dùng phím mũi tên lên/xuống';
    handle.draggable = !lane.locked;
    handle.disabled = !!lane.locked;
    handle.addEventListener('dragstart', (event) => {
      panel.dataset.dragLane = String(lane.id);
      if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(lane.id)); }
    });
    handle.addEventListener('dragend', () => { delete panel.dataset.dragLane; });
    handle.addEventListener('keydown', (event) => {
      if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (recMoveLaneById(lane.id, event.key === 'ArrowUp' ? -1 : 1)) {
        const next = document.querySelector('#recLaneOrder [data-lane-id="' + lane.id + '"]');
        if (next) next.focus();
      }
    });
    handle.dataset.laneId = String(lane.id);
    row.addEventListener('dragover', (event) => { if (!lane.locked && panel.dataset.dragLane) event.preventDefault(); });
    row.addEventListener('drop', (event) => {
      event.preventDefault(); event.stopPropagation();
      const from = panel.dataset.dragLane;
      delete panel.dataset.dragLane;
      if (from) recMoveLaneById(from, String(lane.id));
    });
    row.appendChild(handle);
    for (const [delta, label] of [[-1, 'Lên'], [1, 'Xuống']]) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = label;
      const adjacent = lanes[index + delta];
      button.disabled = !!lane.locked || !adjacent || !!adjacent.locked;
      button.setAttribute('aria-label', lane.name + ' ' + label);
      button.addEventListener('click', () => recMoveLaneById(lane.id, delta));
      row.appendChild(button);
    }
    panel.appendChild(row);
  }
}

if ($('pianoEndAction')) {
  $('pianoEndAction').value = REC_CFG.PIANO_END_ACTION;
  $('pianoEndAction').addEventListener('change', (event) => {
    if (!['connect0', 'layerclear'].includes(event.target.value)) return;
    noteChange();
    REC_CFG.PIANO_END_ACTION = event.target.value;
    rebuildFlat();
    noteChange();
    scheduleAutosave();
  });
}

function switchCueTab(cueTab) {
  $('tabCue').classList.toggle('is-active', cueTab);
  $('tabMusic').classList.toggle('is-active', !cueTab);
  $('paneCue').hidden = !cueTab;
  $('paneMusic').hidden = cueTab;
}

function toggleSearch(inputId, btnId) {
  const input = $(inputId), btn = $(btnId);
  // ô tìm trong hàng công cụ (có class search-inline) → xổ tại chỗ, không xuống hàng
  const inline = input.classList.contains('search-inline');
  if (inline) {
    const open = input.classList.toggle('open');
    btn.classList.toggle('is-active', open);
    // panel hẹp: đang mở tìm kiếm thì ẩn nhãn BÀI HÁT + badge số để ô tìm vừa 1 hàng
    const tools = btn.closest('.musictools');
    if (tools) tools.classList.toggle('searching', open);
    if (open) { input.focus(); }
    else {
      input.value = '';
      state.songSearch = '';
      renderSongs();
    }
    return;
  }
  input.hidden = !input.hidden;
  btn.classList.toggle('is-active', !input.hidden);
  if (!input.hidden) {
    input.focus();
  } else {
    input.value = '';
    input.dispatchEvent(new Event('input'));   // đóng ô tìm = xóa từ khóa lọc (render lại danh sách)
  }
}

/* ⚙ Cài đặt — ẩn/hiện panel KẾT NỐI OSC bên phải (MẶC ĐỊNH TẮT — bấm ⚙ mới mở) */
$('btnGear').addEventListener('click', () => {
  const p = $('oscPanel');
  p.hidden = !p.hidden;
  $('btnGear').classList.toggle('on', !p.hidden);
  if (!p.hidden) {
    drawTimeline();                     // canvas giữa đổi kích thước → vẽ lại ngay
    initOscPanelOnce();
    // mở đúng pane đang chọn (mặc định OSC)
    const active = document.querySelector('#oscTabbar .osc-tab.on');
    showOscPane(active ? active.dataset.pane : 'paneOsc');
  } else {
    // Panel ẩn → không render DOM Monitor/Seen
    oscFeed.panelVisible = false;
    if (window.hs.oscUi) {
      window.hs.oscUi({ type: 'uiVisible', on: oscCaptureSeen });
    }
  }
});

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

let propsCurveEditor = null;
let propsCurveCancel = null;

function mountPropsCurve(ev, def, locked) {
  let container = $('curveEditor');
  if (!container) {
    container = document.createElement('div');
    container.id = 'curveEditor';
    $('propsBody').appendChild(container);
  }
  const meta = ev && ev.recMeta;
  container.hidden = !meta || meta.kind !== 'float' || !window.HSCurveEditor;
  if (container.hidden) return;
  container.style.pointerEvents = locked ? 'none' : '';
  container.style.opacity = locked ? '.5' : '';
  container.inert = locked;
  const points = cueCurvePoints(ev);
  if (Number.isInteger(meta.numericIndex)) points.forEach((point) => { point.numericIndex = meta.numericIndex; });
  let before = null, initial = null;
  propsCurveCancel = () => {
    if (before) ev.recMeta = before;
    before = null;
  };
  propsCurveEditor = window.HSCurveEditor.mount(container, {
    points, durationMs: Math.max(0, ev.duration || 0) * 1000 / (state.fps * cueCurveSpeed(ev)),
    interpolation: meta.interpolation || 'linear', fps: state.fps * cueCurveSpeed(ev),
    onChange(nextPoints, options) {
      if (locked || !findCueLoc(ev)) return;
      if (before && !options.commit && initial && options.interpolation === initial.interpolation
        && JSON.stringify(nextPoints) === JSON.stringify(initial.points)) {
        ev.recMeta = before; before = null; renderRecMeta(ev); return;
      }
      if (!before) { before = structuredClone(ev.recMeta); noteChange(); }
      ev.recMeta = { ...ev.recMeta, keyframes: window.HSCurveTools.cloneCueMetadata({ keyframes: nextPoints }).keyframes,
        interpolation: options.interpolation, keyframesSent: nextPoints.length, captureEndpoint: false };
      renderRecMeta(ev);
      if (!options.commit) return;
      const original = before;
      before = null;
      initial = { points: structuredClone(nextPoints), interpolation: options.interpolation };
      if (JSON.stringify(original) === JSON.stringify(ev.recMeta)) return;
      rebuildFlat();
      noteChange();
      scheduleAutosave();
    }
  });
  initial = propsCurveEditor.getState();
}

function renderProps() {
  if (propsCurveEditor) { propsCurveEditor.destroy(); propsCurveEditor = null; }
  if (propsCurveCancel) { propsCurveCancel(); propsCurveCancel = null; }
  if ($('curveEditor')) $('curveEditor').hidden = true;
  const ev = state.sel;
  mountCueOutputSelector(ev);
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
  const laneObj = laneByName(ev.lane);
  const pHideBtn = $('pHideBtn');
  pHideBtn.classList.toggle('active', ev.enabled === false);
  pHideBtn.textContent = ev.enabled === false ? '⊘ ĐANG ẨN' : '⊘ ẨN CLIP';
  pHideBtn.disabled = !!(laneObj && laneObj.locked);
  ['Trigger', 'Piano', 'Float'].forEach((m) => {
    $('pMode' + m).classList.toggle('active', d && (d.mode || 'trigger') === m.toLowerCase());
  });
  renderSwatches();
  renderRecMeta(ev);
  mountPropsCurve(ev, d, !!(laneObj && laneObj.locked));
}

/* Thông tin AUTO-REC của cue: nguồn MIDI, OSC khớp, độ trễ, keyframe Float */
function renderRecMeta(ev) {
  const box = $('pRecMeta');
  if (!box) return;
  const m = ev && ev.recMeta;
  if (!m) { box.hidden = true; return; }
  box.hidden = false;
  const kind = { trigger: 'Trigger', piano: 'Piano', float: 'Float' }[m.kind] || m.kind;
  const src = m.source === 'osc' ? 'OSC' : m.kind === 'float' ? `CC ${m.num}` : `MIDI ${m.num}`;
  const status = m.unassigned ? 'Chưa gán OSC' : m.guessed ? 'gán từ mapping (suy đoán)'
    : m.matched ? `Resolume báo về · lệch ${m.latencyMs != null ? m.latencyMs : 0}ms` : 'Đã gán thủ công';
  const kf = m.kind === 'float'
    ? `<span>Keyframe: <b>${(m.keyframes || []).length}/${m.keyframesRaw || 0}</b> điểm${m.dataOrigin === 'midi' ? ' · MIDI display only' : ''}</span>`
    : '';
  const extras = (m.extras || []).length
    ? `<span>Ngõ vào phụ: <b>${m.extras.map((e) => e.address).join(', ')}</b></span>`
    : '';
  box.innerHTML = `
    <span class="rm-tag ${m.matched ? (m.guessed ? 'guess' : 'ok') : 'none'}">${status}</span>
    <span>${kind} · ${src} · ch${m.ch}${m.vel != null ? ' · vel ' + m.vel : ''}</span>
    <span>Giữ: <b>${(m.holdMs / 1000).toFixed(2)}s</b></span>
    ${kf}${extras}`;
  if (m.unassigned) {
    const choose = document.createElement('button');
    choose.textContent = 'Chọn từ OSC';
    choose.addEventListener('click', () => { openTestOsc(); oscAssignCue = ev; });
    box.appendChild(choose);
  }
}

function recAssignOsc(cue, address, args) {
  const f = state.folders.find((folder) => folder.events.includes(cue));
  const def = f && f.cues.find((item) => item.id === cue.cueId);
  if (!def || !address || !address.startsWith('/')) return;
  def.address = address;
  if (Array.isArray(args)) def.args = structuredClone(args);
  if (cue.recMeta) {
    Object.assign(cue.recMeta, { unassigned: false, guessed: false, matched: false, mappingStatus: 'manual' });
    if (cue.recMeta.num != null && cue.recMeta.source !== 'osc') {
      midiMap.set(recMapKey(cue.recMeta), { address, kind: cue.recMeta.kind, args: structuredClone(def.args) });
    }
  }
  if (!def.nameEdited) def.name = recCueName(cue.recMeta || {}, address);
  recLayoutCue(f, cue, { ...(cue.recMeta || {}), address, kind: def.mode,
    startFrame: cue.frame, durationFrames: cue.duration }, true);
  recNormalizeLanes(f);
  refreshAll();
  renderProps();
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
      d.colorManual = true;
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
  if (d) { d.name = e.target.value; d.nameEdited = true; renderFolders(); scheduleAutosave(); }
});
$('pTime').addEventListener('change', () => {
  const f = findSelectedFolder();
  const v = parseTC($('pTime').value, state.fps);
  if (state.sel && v !== null && f) {
    const laneObj = laneByName(state.sel.lane);
    if (laneObj && laneObj.locked) { flashStatus(`Lane ${state.sel.lane} đang khóa.`); renderProps(); return; }
    noteChange();
    const i = f.events.indexOf(state.sel);
    f.events.splice(i, 1);
    state.sel.frame = Math.max(0, v - f.offset);
    insertCue(f, state.sel);
    resolveCueEditLane(f, state.sel);
    refreshAll();
  }
});
$('pTime').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('pDur').addEventListener('change', () => {
  const v = parseTC($('pDur').value, state.fps);
  if (state.sel) {
    const laneObj = laneByName(state.sel.lane);
    if (laneObj && laneObj.locked) { flashStatus(`Lane ${state.sel.lane} đang khóa.`); renderProps(); return; }
    noteChange();
    const duration = v === null || v <= 0 ? (state.sel.recMeta && state.sel.recMeta.kind === 'float' ? 1 : 0) : v;
    trimCueCurve(state.sel, 0, duration);
    state.sel.duration = duration;
    const folder = findSelectedFolder();
    if (folder) resolveCueEditLane(folder, state.sel);
    rebuildFlat();
    infoDirty = true;
    noteChange();
    scheduleAutosave();
    renderProps();
  }
});
$('pDur').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('pAddr').addEventListener('change', () => {
  const d = selDef();
  const v = $('pAddr').value.trim();
  if (!d) return;
  if (v.startsWith('/')) {
    recAssignOsc(state.sel, v, d.args);
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
  rebuildFlat();
  scheduleAutosave();
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
    if (d) { d.mode = m.toLowerCase(); rebuildFlat(); renderProps(); scheduleAutosave(); }
  });
});
$('pPlayNow').addEventListener('click', () => {
  const d = selDef();
  if (!d) return;
  if (state.sel && state.sel.recMeta && (state.sel.recMeta.unassigned || state.sel.recMeta.dataOrigin === 'midi')) {
    setStatus('Cue is display-only until actual OSC data is assigned.'); return;
  }
  if (!d.address) { setStatus('Cue chưa có địa chỉ OSC — điền ĐỊA CHỈ OSC ở trên trước.'); return; }
  sendOsc(d.address, d.args, d.outputTarget);
  flashStatus(`Đã gửi ngay: ${d.address}`);
});
$('propsHead').addEventListener('click', (e) => {
  if (e.target.closest('input, button')) return;
  const b = $('propsBody');
  b.style.display = b.style.display === 'none' ? '' : 'none';
});

/* ================= Modal ghi chú cue ================= */
let noteTarget = null;
function cueDefOf(ev) {
  const fo = state.folders.find((fo) => fo.events.includes(ev));
  return fo ? (fo.cues.find((c) => c.id === ev.cueId) || null) : null;
}
function openNoteModal(ev) {
  noteTarget = cueDefOf(ev);
  if (!noteTarget) return;
  $('noteInput').value = noteTarget.note || '';
  $('noteTarget').textContent = (noteTarget.name || 'cue') + ' · ' + (noteTarget.address || '—');
  $('noteModal').style.display = 'flex';
  setTimeout(() => $('noteInput').focus(), 0);
}
function closeNoteModal() { $('noteModal').style.display = 'none'; noteTarget = null; }
function saveNote() {
  if (!noteTarget) { closeNoteModal(); return; }
  noteTarget.note = $('noteInput').value;
  renderFolders();
  scheduleAutosave();
  closeNoteModal();
  flashStatus('Đã lưu ghi chú.');
}
$('noteSave').addEventListener('click', saveNote);
$('noteClose').addEventListener('click', closeNoteModal);
$('noteModal').addEventListener('mousedown', (e) => { if (e.target === $('noteModal')) closeNoteModal(); });
$('noteInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveNote();
  if (e.key === 'Escape') closeNoteModal();
});

/* ================= Bàn phím ================= */
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'r': case 'R': toggleRec(); break;
    case 's': case 'S': stop(); break;
    case 'l': case 'L': $('btnLoop').click(); break;
    case 'f': case 'F': toggleFollow(); break;
    case 'c': case 'C':
      if (!e.metaKey && !e.ctrlKey && !e.altKey) setTlTool(state.tlTool === 'cut' ? 'select' : 'cut');
      break;
    case 'x': case 'X':
      if (!e.metaKey && !e.ctrlKey && !e.altKey) setTlTool(state.tlTool === 'quickcut' ? 'select' : 'quickcut');
      break;
    case 'Escape':
      if (state.tlTool !== 'select') setTlTool('select');
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
  return JSON.stringify(projectEncode({ folders: state.folders, lanes: state.lanes, audioClips: state.audioClips,
    activeFolderId: state.activeFolderId, recLaneId: state.recLaneId,
    midiMap: [...midiMap], laneGroups: laneAlloc.exportGroups(), laneGroupMode: state.laneGroupMode,
    useLearnedMappingFallback: state.useLearnedMappingFallback,
    pianoEndAction: REC_CFG.PIANO_END_ACTION }));
}

let restoringHistory = false;
function applySnapshot(snap) {
  restoringHistory = true;
  try {
    const d = projectDecode(JSON.parse(snap));
    state.folders = d.folders;
    if (d.activeFolderId != null) state.activeFolderId = d.activeFolderId;
    state.recLaneId = d.recLaneId == null ? null : d.recLaneId;
    state.useLearnedMappingFallback = typeof d.useLearnedMappingFallback === 'boolean'
      ? d.useLearnedMappingFallback : !!REC_CFG.USE_LEARNED_MAPPING_FALLBACK;
    if ($('learnedMappingFallback')) $('learnedMappingFallback').checked = state.useLearnedMappingFallback;
    state.laneGroupMode = ['layer+type', 'address'].includes(d.laneGroupMode) ? d.laneGroupMode : window.HSRealtime.LANE_GROUP_MODE;
    if ($('laneGroupMode')) $('laneGroupMode').value = state.laneGroupMode;
    REC_CFG.PIANO_END_ACTION = ['connect0', 'layerclear'].includes(d.pianoEndAction) ? d.pianoEndAction : window.HSRealtime.PIANO_END_ACTION;
    if ($('pianoEndAction')) $('pianoEndAction').value = REC_CFG.PIANO_END_ACTION;
    state.lanes = d.lanes;
    state.audioClips = Array.isArray(d.audioClips) ? d.audioClips : [];
    midiMap.clear();
    for (const [key, mapping] of d.midiMap || []) midiMap.set(key, mapping);
    MIDI.padMap.clear();
    laneAlloc.importGroups(d.laneGroups || {});
    const f = curFolder();
    if (f) { f.lanes = state.lanes; f.audioClips = state.audioClips; f.recLaneId = state.recLaneId; recNormalizeLanes(f, false); }
    state.sel = null;
    state.selClipId = null;
    state.multiSel = new Set();
    refreshAll();
    renderProps();
    updateSelBar();
  } finally { restoringHistory = false; }
}

function noteChange() {
  // ĐANG GHI (REC): mọi thay đổi thuộc CÙNG một phiên → KHÔNG đẩy snapshot trung gian.
  // Cả phiên chỉ thành 1 bước undo khi tắt REC (xem toggleRec).
  if (restoringHistory || recTransactions.size) return;
  const snap = snapshot();
  if (snap === lastSnap) return;
  if (lastSnap) {
    undoStack.push(lastSnap);
    if (undoStack.length > REC_CFG.REC_HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
  }
  lastSnap = snap;
}

function undo() {
  if (state.recArmed || recTransactions.size) { setStatus('Tắt REC và chờ chốt phiên trước khi hoàn tác.'); return; }
  if (!undoStack.length) { setStatus('Không còn gì để hoàn tác.'); return; }
  const cur = snapshot();
  applySnapshot(undoStack.pop());
  redoStack.push(cur);
  lastSnap = snapshot();
  flashStatus('Đã hoàn tác.');
}

function redo() {
  if (state.recArmed || recTransactions.size) { setStatus('Tắt REC và chờ chốt phiên trước khi làm lại.'); return; }
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
  syncOscFloatAddresses();
  clearTimeout(autosaveTimer);
  if (recTransactions.size) return;
  autosaveTimer = setTimeout(() => {
    if (recTransactions.size) return;
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(serializeProject()));
      if (typeof lanPushProject === 'function') lanPushProject();
    } catch (_) { /* đầy thì thôi */ }
  }, 800);
}

function serializeProject() {
  captureActiveProject();   // dữ liệu đang làm việc phải nằm về ĐÚNG bài đang mở trước khi ghi đĩa
  return projectEncode({
    version: 13,
    fps: state.fps,
    // v11: bảng học MIDI→OSC + nhóm lane auto-rec (giữ qua lần mở sau)
    midiMap: Object.fromEntries(midiMap),
    laneGroups: laneAlloc.exportGroups(),
    // v12: nhiều địa chỉ OSC + cấu hình LAN (backup nhiều máy)
    oscTargets: (typeof oscUI !== 'undefined' ? oscUI.targets : []).map((t) => ({
      id: t.id, name: t.name, host: t.host, port: t.port,
      enabled: t.enabled !== false, verified: !!t.verified
    })),
    lan: {
      role: (typeof oscUI !== 'undefined' ? oscUI.lanRole : 'master'),
      group: ($('lanGroup') && $('lanGroup').value) || '404TC',
      deviceName: ($('lanName') && $('lanName').value) || '',
      followMaster: $('lanFollow') ? $('lanFollow').checked : true
    },
    autoAdvance: state.autoAdvance,
    playbackEndMode: state.playbackEndMode,
    activeFolderId: state.activeFolderId,
    recLaneId: state.recLaneId,
    songIndex: state.songIndex,
    rowH: state.rowH,
    aRowH: state.aRowH,
    pps: state.pps ? +(state.pps.toFixed(3)) : 0,   // Zoom NGANG đang dùng — khôi phục khi mở lại project
    showAllFolders: state.showAllFolders,
    // v10: THƯ VIỆN NHẠC DÙNG CHUNG — lưu MỘT LẦN ở project, mọi bài thả clip từ đây
    songs: state.songs.map((s) => ({ id: s.id, name: s.name, path: s.path, duration: s.duration, size: s.size })),
    // v9: MỖI BÀI (folder) tự mang dữ liệu độc lập — không có audio/cue/track dùng chung giữa các bài
    folders: state.folders.map((f) => ({
      id: f.id, name: f.name, offset: f.offset, color: f.color, hidden: !!f.hidden, collapsed: !!f.collapsed,
      cues: f.cues, events: f.events,
      // AUDIO: instance riêng từng bài — source nằm ở THƯ VIỆN CHUNG (data.songs) ở trên
      songs: [],   // v10: không còn nhạc riêng theo bài — giữ field rỗng cho tương thích ngược
      audioClips: (f.audioClips || []).map((c) => ({
        instanceId: c.id,          // id riêng của TỪNG instance (không dùng sourceId làm id)
        sourceId: c.songId,        // bài gốc trong THƯ VIỆN CHUNG
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
      lanes: (f.lanes || []).map((l) => ({ id: l.id, name: l.name, kind: l.kind, locked: !!l.locked,
        recGroup: l.recGroup || null, groupLabel: l.groupLabel || '', color: l.color || '',
        colorManual: !!l.colorManual, autoRec: !!l.autoRec, manual: !!l.manual, manualLane: !!l.manualLane,
        auxiliary: !!l.auxiliary, auxOf: l.auxOf == null ? null : l.auxOf })),
      laneGroups: f.laneGroups || {},
      recLaneId: f.recLaneId || null,
      pstate: f.pstate || null       // playback settings riêng của bài này
    })),
    settings: {
      listenPort: state.listenPort,
      targetHost: state.target.host,
      targetPort: state.target.port,
      filterPreset: state.filterPreset,
      filterRegex: state.filterRegex,
      recMode: state.recMode,
      laneGroupMode: state.laneGroupMode,
      useLearnedMappingFallback: state.useLearnedMappingFallback,
      pianoEndAction: REC_CFG.PIANO_END_ACTION
    }
  });
}

// Project transport stays JSON; only OSC byte values need an explicit wire type.
function projectEncode(value) {
  if (value instanceof Uint8Array) return { __hsOscBytes: Array.from(value) };
  if (Array.isArray(value)) return value.map(projectEncode);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, projectEncode(item)]));
  return value;
}

function projectDecode(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return value.map(projectDecode);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '__hsOscBytes' && Array.isArray(value.__hsOscBytes)
      && value.__hsOscBytes.length <= REC_CFG.OSC_EVENT_QUEUE_BYTES
      && value.__hsOscBytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      return Uint8Array.from(value.__hsOscBytes);
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, projectDecode(item)]));
  }
  return value;
}

function projectOscArgs(args, fallback = []) {
  if (!Array.isArray(args)) return structuredClone(fallback);
  let remaining = REC_CFG.OSC_EVENT_QUEUE_BYTES;
  function valid(value, depth) {
    if (--remaining < 0 || depth > REC_CFG.OSC_MAX_BUNDLE_DEPTH) return false;
    if (value == null || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'string') { remaining -= value.length; return remaining >= 0; }
    if (value instanceof Uint8Array) { remaining -= value.byteLength; return remaining >= 0; }
    if (Array.isArray(value)) return value.every((item) => valid(item, depth + 1));
    if (value && typeof value === 'object') return Object.entries(value).every(([key, item]) =>
      !['__proto__', 'constructor', 'prototype', '__hsOscBytes'].includes(key) && valid(item, depth + 1));
    return false;
  }
  const decoded = projectDecode(args);
  return valid(decoded, 0) ? decoded : structuredClone(fallback);
}

function migrateFolder(f, legacy, library, idMap) {
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
      args: projectOscArgs(c.args, [1]),
      name: c.name == null ? '' : String(c.name),
      nameEdited: !!c.nameEdited,
      note: c.note == null ? '' : String(c.note),
      color: c.color == null ? '' : String(c.color),
      colorManual: c.colorManual == null ? !!c.color : !!c.colorManual,
      mode: c.mode || 'trigger',
      ...(typeof c.outputTarget === 'string' ? { outputTarget: c.outputTarget } :
        Array.isArray(c.outputTarget) && c.outputTarget.every((id) => typeof id === 'string')
          ? { outputTarget: c.outputTarget.slice() } : {})
    }));
    const ids = new Set(nf.cues.map((c) => c.id));
    nf.events = (Array.isArray(f.events) ? f.events : [])
      .filter((e) => e && ids.has(e.cueId))
      .map((e) => {
        const event = {
          id: e.id || nid(), cueId: e.cueId, frame: e.frame || 0,
          lane: e.lane || 'V1', duration: e.duration || 0, enabled: e.enabled !== false,
          smpteInput: !!e.smpteInput
        };
        if (e.manualLane) event.manualLane = true;
        if (e.laneId != null) event.laneId = e.laneId;
        if (typeof e.recGroup === 'string') event.recGroup = e.recGroup;
        const meta = e.recMeta;
        if (meta && ['trigger', 'piano', 'float'].includes(meta.kind)) {
          event.recMeta = { kind: meta.kind };
          for (const key of ['num', 'ch', 'vel', 'holdMs', 'score', 'latencyMs', 'keyframesRaw', 'keyframesSent', 'session', 'startMs', 'endMs']) {
            if (Number.isFinite(meta[key])) event.recMeta[key] = meta[key];
          }
          if (Number.isFinite(meta.recordingSpeed) && meta.recordingSpeed > 0) event.recMeta.recordingSpeed = meta.recordingSpeed;
          if (Number.isSafeInteger(meta.numericIndex) && meta.numericIndex >= 0) event.recMeta.numericIndex = meta.numericIndex;
          if (['linear', 'step', 'ease', 'ease-in', 'ease-out', 'ease-in-out'].includes(meta.interpolation)) event.recMeta.interpolation = meta.interpolation;
          for (const key of ['matched', 'guessed', 'unassigned']) event.recMeta[key] = !!meta[key];
          for (const key of ['captureEndpoint', 'curveEdited', 'trimmed']) {
            if (typeof meta[key] === 'boolean') event.recMeta[key] = meta[key];
          }
          if (typeof meta.manualLane === 'boolean') event.recMeta.manualLane = meta.manualLane;
          for (const key of ['source', 'dataOrigin', 'mappingStatus', 'device']) {
            if (typeof meta[key] === 'string') event.recMeta[key] = meta[key];
          }
          if (typeof meta.actionId === 'string' || Number.isFinite(meta.actionId)) event.recMeta.actionId = meta.actionId;
          event.recMeta.keyframes = (Array.isArray(meta.keyframes) ? meta.keyframes : [])
            .filter((point) => point && Number.isFinite(point.dt ?? point.ms) && (point.dt ?? point.ms) >= 0 && Number.isFinite(point.value))
            .filter((point, index, points) => index < REC_CFG.FLOAT_MAX_POINTS - 1 || index === points.length - 1)
            .map((point) => {
              const saved = { dt: point.dt ?? point.ms, value: point.value };
              for (const key of ['ms', 't', 'tFrame', 'seq']) if (Number.isFinite(point[key])) saved[key] = point[key];
              if (Number.isSafeInteger(point.numericIndex) && point.numericIndex >= 0) saved.numericIndex = point.numericIndex;
              if (Array.isArray(point.args)) saved.args = projectOscArgs(point.args);
              return saved;
            });
          event.recMeta.extras = (Array.isArray(meta.extras) ? meta.extras : [])
            .filter((extra) => extra && typeof extra.address === 'string')
            .slice(0, REC_CFG.OSC_MAX_ADDRESSES)
            .map((extra) => ({ address: extra.address,
              args: projectOscArgs(extra.args),
              ...(Number.isFinite(extra.count) ? { count: extra.count } : {}),
              ...(Number.isFinite(extra.dtMs) ? { dtMs: extra.dtMs } : {}),
              ...(Number.isFinite(extra.t) ? { t: extra.t } : {}),
              ...(Number.isFinite(extra.seq) ? { seq: extra.seq } : {}),
              ...(typeof extra.release === 'boolean' ? { release: extra.release } : {}) }));
        }
        return event;
      });
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
  // ===== dữ liệu AUDIO/TRACK RIÊNG TỪNG BÀI (source nằm ở THƯ VIỆN CHUNG — tham số `library`) =====
  if (f.songs || f.audioClips || f.lanes) {
    // v9/v10: folder tự mang instance + lane — clip đối chiếu source vào THƯ VIỆN CHUNG
    nf.lanes = (f.lanes || []).filter((l) => l && l.name).map((l) => ({
      id: l.id || nid(), name: l.name, kind: l.kind || l.name[0], locked: !!l.locked,
      recGroup: typeof l.recGroup === 'string' ? l.recGroup : null,
      groupLabel: typeof l.groupLabel === 'string' ? l.groupLabel : '',
      color: typeof l.color === 'string' ? l.color : '', colorManual: !!l.colorManual,
      autoRec: l.autoRec === true, manual: !!l.manual, manualLane: !!l.manualLane,
      auxiliary: !!l.auxiliary, auxOf: l.auxOf == null ? null : l.auxOf
    }));
    if (!nf.lanes.length) nf.lanes = [];   // activateProject sẽ dựng bộ lane mặc định
    nf.audioClips = migrateAudioClips({ audioClips: f.audioClips || [] }, library, nf.lanes.length ? nf.lanes : [{ id: 1, kind: 'A' }], idMap);
    nf.recLaneId = f.recLaneId || null;
    nf.pstate = f.pstate || null;
  } else if (legacy && legacy.isOwnFolder && Array.isArray(legacy.lanes)) {
    // v≤8: dữ liệu audio global cũ → gắn về ĐÚNG MỘT bài (bài active khi lưu) — không trộn 2 bài
    nf.lanes = legacy.lanes;
    nf.audioClips = legacy.audioClips;
    nf.recLaneId = legacy.recLaneId || null;
    nf.pstate = null;
  } else {
    // bài khác của dự án cũ: hoàn toàn TRỐNG — không được thừa hưởng dữ liệu của bài khác
    Object.assign(nf, freshProjectData());
  }
  const groups = f.laneGroups || (legacy && legacy.isOwnFolder && legacy.laneGroups) || {};
  for (const lane of nf.lanes) {
    if (!lane.recGroup) {
      const oldGroup = Object.keys(groups).find((key) => Array.isArray(groups[key]) && groups[key].includes(lane.name));
      if (oldGroup) {
        const event = nf.events.find((item) => item.lane === lane.name);
        const def = event && nf.cues.find((item) => item.id === event.cueId);
        const descriptor = { ...(event && event.recMeta), address: def && def.address, kind: def && def.mode };
        lane.recGroup = event ? window.HSCueLayout.laneKeyFor(descriptor, state.laneGroupMode) : oldGroup;
        lane.groupLabel = event ? window.HSCueLayout.labelFor(descriptor, state.laneGroupMode) : '';
        lane.autoRec = true;
      }
    }
  }
  recSyncLaneGroups(nf);
  return nf;
}

/* ===== AUDIO INSTANCE — nạp lại từ file dự án =====
   • v8+: đọc đúng danh sách audioClips đã lưu (mọi instance + cut/trim range giữ nguyên).
   • v3–v7 (dự án cũ, nhạc gắn trên lane): mỗi lane A có bài → đúng 1 instance full-range tại songOffset.
   • idMap: remap id source khi gộp thư viện (file cũ có cùng file ở nhiều bài) — clip không thành mồ côi.
   • Clip mồ côi (sourceId không còn trong thư viện) bị bỏ — không sinh clip ma. */
function migrateAudioClips(data, songs, lanes, idMap) {
  const remap = (id) => (idMap && idMap.has(id) ? idMap.get(id) : id);
  const songOk = (id) => songs.some((s) => s.id === remap(id));
  if (Array.isArray(data.audioClips)) {
    return data.audioClips.filter((c) => c && songOk(c.sourceId != null ? c.sourceId : c.songId)).map((c) => {
      const laneId = (c.trackId != null ? c.trackId : c.laneId);
      const clip = makeAudioClip(
        remap(c.sourceId != null ? c.sourceId : c.songId),
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
    const song = songs.find((s) => s.id === remap(l.songId));
    const end = l.songEnd > 0 ? Math.min(l.songEnd, song.duration || l.songEnd) : (song.duration || 0);
    clips.push(makeAudioClip(remap(l.songId), l.id, Math.max(0, l.songOffset || 0), 0, end));
  });
  return clips;
}

function applyProject(data) {
  if (!data || ![3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].includes(data.version)) { setStatus('File dự án không hợp lệ.'); return; }
  if (recTransactions.size || state.recArmed) { setStatus('Tắt REC và chờ chốt phiên trước khi mở dự án.'); return; }
  data = projectDecode(data);
  // v11: khôi phục bảng học MIDI→OSC + nhóm lane (v10 trở xuống: rỗng)
  midiMap.clear();
  if (data.midiMap && typeof data.midiMap === 'object') {
    for (const [k, v] of Object.entries(data.midiMap)) {
      if (v && v.address) midiMap.set(k, { address: v.address, kind: v.kind || 'trigger', args: projectOscArgs(v.args) });
    }
  }
  laneAlloc.importGroups(data.laneGroups);
  // v12: nhiều địa chỉ OSC
  if (Array.isArray(data.oscTargets) && data.oscTargets.length) {
    oscUI.targets = data.oscTargets.map((t) => ({
      id: t.id || ('t' + Date.now() + Math.random().toString(36).slice(2, 6)),
      name: t.name || t.host, host: t.host || '127.0.0.1',
      port: Number(t.port) || 7001, enabled: t.enabled !== false,
      verified: false, lastError: null, sent: 0
    }));
    if (window.hs.oscTargetsSet) window.hs.oscTargetsSet(oscUI.targets).catch(() => {});
    renderOscTargets();
  }
  if (data.lan) {
    oscUI.lanRole = data.lan.role === 'backup' ? 'backup' : 'master';
    if ($('lanRole')) $('lanRole').value = oscUI.lanRole;
    if ($('lanGroup') && data.lan.group) $('lanGroup').value = data.lan.group;
    if ($('lanName') && data.lan.deviceName) $('lanName').value = data.lan.deviceName;
    if ($('lanFollow')) $('lanFollow').checked = data.lan.followMaster !== false;
  }
  pause();
  audioSongId = null;
  state.ppsInit = false; // nạp xong tính lại zoom khớp nội dung
  state.fps = data.fps || 30;
  $('fpsSel').value = String(state.fps);
  state.rowH = data.rowH || 46;            // không có zoom đã lưu → mặc định dọc 30% (thanh CAO)
  state.aRowH = data.aRowH || clamp(Math.round(state.rowH * 1.6), 30, 150);
  // Zoom NGANG: có lưu → khôi phục zoom đã lưu; chưa có → để ppsInit tính lại = 70% (mặc định RỘNG)
  if (data.pps && data.pps > 0) { state.pps = data.pps; state.ppsInit = true; }
  else { state.pps = 0; state.ppsInit = false; }
  state.showAllFolders = false;   // chức năng «Hiện cue của MỌI thư mục» đã bỏ — timeline luôn hiện bài đang mở
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
    return { songs, lanes: lanes.length ? lanes : [], audioClips, recLaneId: null, laneGroups: data.laneGroups };
  })() : null;
  // ===== THƯ VIỆN NHẠC DÙNG CHUNG (v10) =====
  // File mới: data.songs là thư viện chung. File cũ (v≤9): GỘP nhạc của các bài lại
  // (dedupe theo path, GIỮ id gốc để instance clip trên timeline không become mồ côi).
  const idAlias = new Map();   // id bị gộp → id giữ lại (chỉ dùng khi migrate file cũ)
  if (Array.isArray(data.songs) && data.songs.length) {
    state.songs = data.songs.map((s) => ({
      id: s.id || nid(), name: s.name || 'Bài', path: s.path || '',
      duration: s.duration || 0, size: s.size || 0, peaks: null, decoding: false
    }));
  } else {
    const lib = [], seenPath = new Set();
    const pushLib = (s) => {
      if (!s || !s.path) return;
      if (seenPath.has(s.path)) {
        const kept = lib.find((x) => x.path === s.path);
        if (kept && s.id != null && s.id !== kept.id) idAlias.set(s.id, kept.id);   // cùng file, id khác → clip theo id cũ vẫn resolve được
        return;
      }
      seenPath.add(s.path);
      lib.push({ id: s.id || nid(), name: s.name || 'Bài', path: s.path, duration: s.duration || 0, size: s.size || 0, peaks: null, decoding: false });
    };
    if (legacyActive) legacyActive.songs.forEach(pushLib);              // v≤8: nhạc global cũ
    (Array.isArray(data.folders) ? data.folders : []).forEach((fo) => (fo.songs || []).forEach(pushLib));   // v9: nhạc theo từng bài
    state.songs = lib;
  }
  state.folders = (Array.isArray(data.folders) && data.folders.length)
    ? data.folders.map((f) => migrateFolder(f, { ...legacyActive, laneGroups: data.laneGroups, isOwnFolder: f.id === data.activeFolderId }, state.songs, idAlias))
    : [Object.assign({ id: nid(), name: 'Chính', offset: 0, events: [], cues: [], color: '', hidden: false, collapsed: false }, freshProjectData())];
  state.songIndex = -1;
  state.autoAdvance = data.autoAdvance !== false;
  state.playbackEndMode = data.playbackEndMode === 'contentEndPlus10' ? 'contentEndPlus10' : 'infinite';
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
  state.useLearnedMappingFallback = typeof st.useLearnedMappingFallback === 'boolean'
    ? st.useLearnedMappingFallback : !!REC_CFG.USE_LEARNED_MAPPING_FALLBACK;
  if ($('learnedMappingFallback')) $('learnedMappingFallback').checked = state.useLearnedMappingFallback;
  state.laneGroupMode = ['layer+type', 'address'].includes(st.laneGroupMode) ? st.laneGroupMode : window.HSRealtime.LANE_GROUP_MODE;
  if ($('laneGroupMode')) $('laneGroupMode').value = state.laneGroupMode;
  REC_CFG.PIANO_END_ACTION = ['connect0', 'layerclear'].includes(st.pianoEndAction) ? st.pianoEndAction : window.HSRealtime.PIANO_END_ACTION;
  if ($('pianoEndAction')) $('pianoEndAction').value = REC_CFG.PIANO_END_ACTION;
  rebuildFlat();
  if (st.listenPort) { state.listenPort = st.listenPort; $('listenPort').value = st.listenPort; window.hs.setListenPort(st.listenPort); }
  if (st.targetHost) { state.target.host = st.targetHost; $('targetHost').value = st.targetHost; }
  if (st.targetPort) { state.target.port = st.targetPort; $('targetPort').value = String(st.targetPort); }
  if (st.filterPreset) { state.filterPreset = st.filterPreset; $('filterSel').value = st.filterPreset; $('filterRegex').style.display = st.filterPreset === 'custom' ? 'block' : 'none'; }
  if (st.filterRegex !== undefined) { state.filterRegex = st.filterRegex; $('filterRegex').value = st.filterRegex; }
  if (st.recMode) { state.recMode = st.recMode; const el = document.querySelector(`input[name="recMode"][value="${st.recMode}"]`); if (el) el.checked = true; }
  $('filterHint').textContent = filterDescription();
  setStatus(`Đã nạp dự án: ${state.folders.length} bài · ${state.songs.length} nhạc dùng chung (v${data.version}).`);
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
  state.audioClips = [];      // dự án mới = không instance nào (thư viện NHÁC cũng xóa trắng — dự án mới hoàn toàn)
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
  updateRecChips();
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
      if ([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].includes(data.version)) { applyProject(data); restored = true; }
    }
  } catch (_) { /* bỏ qua */ }
  if (!restored) refreshAll();
  audio.volume = masterVol;
  setStatus('Bật ● REC → gõ MIDI pad hoặc để Resolume gửi OSC → cue tự ghi vào LANE GHI (panel KẾT NỐI OSC).');
})();

/* ================= MIDI REC — mô hình 404TimeCode (midir → CoreMIDI bên 404) =================
   • Web MIDI API (Electron/macOS bật sẵn): quét thiết bị vào, note-on/off → địa chỉ OSC.
   • PAD Tự động: địa chỉ từ MẪU (/midi/note/{n} — {n}=note 0-127, {c}=kênh 1-16).
   • PAD Học từ OSC vào: pad chưa có địa chỉ riêng → nhận message OSC vào GẦN NHẤT làm địa chỉ
     (giống "đơn tơ địa chỉ" của 404: bấm pad trên Resolume → cue học địa chỉ).
   • Bounce: chỉ bắn mapping thật ngoài REC; trong REC, MIDI nối trực tiếp tới Resolume.
   • Ghi cue: khi REC BẬT + đang phát → note-on đặt cue bắn (mode Trigger), note-off kéo dài
     cue (mode Piano — "giữ/nhả" như 404). */
function noteName(n) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return names[n % 12] + (Math.floor(n / 12) - 1);
}

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
    if (inp.state === 'disconnected') return;
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
  updateMidiChip();
  const n = MIDI.inputs.length;
  flashStatus(n ? `MIDI: tìm thấy ${n} thiết bị vào — chọn thiết bị rồi REC BẬT + gõ pad.` : 'MIDI: không tìm thấy thiết bị nào vào — kiểm tra kết nối đàn/pad.');
}

/* lắng nghe thiết bị đang chọn (bỏ theo dõi thiết bị khác) */
function midiWatch() {
  const want = state.midiDeviceId;
  for (const id of MIDI.watched) {
    if (id !== want || !MIDI.inputs.some((input) => input.id === id && input.state !== 'disconnected')) {
      midiDisconnect(id);
      MIDI.watched.delete(id);
    }
  }
  MIDI.inputs.forEach((inp) => {
    if (inp.id === want && !MIDI.watched.has(inp.id)) {
      inp.onmidimessage = onMidiMessage;
      MIDI.watched.add(inp.id);
    } else if (inp.id !== want) {
      inp.onmidimessage = null;
      MIDI.watched.delete(inp.id);
    }
  });
  if (MIDI.access) {
    MIDI.access.onstatechange = (event) => {
      if (event.port && event.port.state === 'disconnected') midiDisconnect(event.port.id);
      midiScan();
    };
  }
}

function onMidiMessage(ev) {
  const [status, d1, d2] = ev.data;
  const type = status & 0xf0;      // 0x90 note-on, 0x80 note-off, 0xB0 CC…
  const ch = (status & 0x0f) + 1;  // 1-16
  const device = (ev.currentTarget && ev.currentTarget.id) || (ev.target && ev.target.id) || state.midiDeviceId;
  if (type === 0x90 && d2 > 0) midiNoteOn(d1, ch, d2, ev.timeStamp, device);
  else if (type === 0x80 || (type === 0x90 && d2 === 0)) midiNoteOff(d1, ch, ev.timeStamp, device);
  else if (type === 0xB0) midiCC(d1, ch, d2, ev.timeStamp, device);
  /* aftertouch/pitch-bend: bỏ qua */
}


/* ================= AUTO-REC BRIDGE: utility descriptors -> cue model =================
   Utility owns classification, matching and timestamps; renderer places final actions. */

/* Chốt TOÀN BỘ phiên ghi đang mở (dừng timeline / tắt REC) */
function recFinalizeOpen() {
  recStopTransaction();
}

/* Each action owns a definition, even when its address repeats. */
function recCreateLiveCue(f, desc) {
  const addr = desc.address || '';
  const def = makeDef(addr, Array.isArray(desc.args) ? structuredClone(desc.args) : []);
  def.name = recCueName(desc, addr);
  def.mode = desc.kind === 'float' ? 'float' : 'trigger';
  f.cues.push(def);
  // Lane: lúc đang ghi CHƯA biết địa chỉ OSC thật → dùng lane ghi hiện có.
  // Lane đúng nhóm được quyết định khi finalize (recFinalizeCue).
  const lanes = f.id === state.activeFolderId ? state.lanes : (f.lanes || []);
  const held = lanes.find((lane) => lane.id === f.recLaneId) || lanes.find((lane) => lane.kind === 'R');
  const cue = makePlacement(Math.max(0, desc.startFrame - f.offset), def.id);
  cue.lane = held ? held.name : (lanes[0] ? lanes[0].name : 'V1');
  cue.duration = desc.durationFrames || 0;
  cue.recording = true;            // UI: viền/nhãn "đang ghi"
  insertCue(f, cue);
  state.selClipId = null;
  return cue;
}

/* Cập nhật cue đang ghi thành cue hoàn chỉnh từ kết quả engine */
function recFinalizeCue(f, cue, desc) {
  if (!f || !cue || !f.events.includes(cue)) return;
  cue.recording = false;
  if (desc.startFrame != null) cue.frame = Math.max(0, desc.startFrame - f.offset);
  cue.duration = desc.durationFrames || 0;

  let def = f.cues.find((c) => c.id === cue.cueId);
  if (!def) {
    def = makeDef(desc.address || '', Array.isArray(desc.args) ? structuredClone(desc.args) : []);
    def.name = recCueName(desc, desc.address);
    f.cues.push(def);
    cue.cueId = def.id;
  }
  // Utility owns matching and fallback decisions; never reinterpret its flags.
  const address = desc.address || '';
  const guessed = !!desc.guessed;
  const unassigned = !!desc.unassigned;
  def.address = address;
  def.args = Array.isArray(desc.args) ? structuredClone(desc.args) : [];
  def.mode = desc.kind === 'float' ? 'float' : desc.kind === 'piano' ? 'piano' : 'trigger';
  if (!def.nameEdited) def.name = recCueName(desc, address);

  // XẾP LANE theo nhóm (đã biết địa chỉ OSC thật ở bước này)
  recLayoutCue(f, cue, { ...desc, startFrame: cue.frame });

  cue.recMeta = {
    kind: desc.kind,
    source: desc.source,
    dataOrigin: desc.dataOrigin,
    captureEndpoint: desc.kind === 'float' && desc.dataOrigin === 'osc' && !guessed && !unassigned &&
      (!!desc.matched || desc.source === 'osc'),
    recordingSpeed: desc.recordingSpeed,
    ...(Number.isSafeInteger(desc.numericIndex) && desc.numericIndex >= 0 ? { numericIndex: desc.numericIndex } : {}),
    ...(typeof desc.interpolation === 'string' ? { interpolation: desc.interpolation } : {}),
    ...(desc.manualLane ? { manualLane: true } : {}),
    session: desc.session,
    actionId: desc.actionId,
    device: desc.device,
    mappingStatus: desc.mappingStatus,
    startMs: desc.startMs,
    endMs: desc.endMs,
    num: desc.num,
    ch: desc.ch,
    vel: desc.vel,
    holdMs: Math.round(desc.holdMs || 0),
    matched: !!desc.matched,
    guessed,
    unassigned,
    score: desc.score || 0,
    latencyMs: desc.matchLatencyMs == null ? desc.latencyMs : desc.matchLatencyMs,
    extras: structuredClone(desc.extras || []),
    keyframes: structuredClone(desc.keyframes || []),
    keyframesRaw: desc.keyframesRaw || 0,
    keyframesSent: desc.keyframesSent || 0
  };
  cue.smpteInput = !!desc.smpteInput;

  // mapping learn: chỉ lưu khi có OSC thật (không lưu suy đoán)
  if (desc.matched && !guessed && !unassigned && address && desc.source !== 'osc' && desc.num != null) {
    const k = recMapKey(desc);
    const prev = midiMap.get(k);
    if (prev && prev.address !== desc.address) {
      flashStatus(`Resolume đổi mapping: ${prev.address} → ${desc.address}. Đã cập nhật.`);
    }
    midiMap.set(k, { address: desc.address, kind: desc.kind, args: (desc.args || []).slice() });
  }
  if (unassigned) {
    flashStatus(`⚠ Cue MIDI ${desc.num} ch${desc.ch} CHƯA GÁN OSC — dùng "Chọn từ OSC" để gán.`);
  } else {
    recDebug('matched', {
      midi: `${desc.num}/${desc.ch}`, osc: def.address, guessed,
      latency: desc.matchLatencyMs, score: desc.score,
      extras: (desc.extras || []).map((e) => e.address)
    });
  }
}

function recMapKey(desc) {
  const key = (desc.source === 'cc' || desc.kind === 'float')
    ? 'cc' + desc.num + 'c' + desc.ch
    : 'n' + desc.num + 'c' + desc.ch;
  return desc.device ? desc.device + '|' + key : key;
}

/* Tên cue tự đặt từ mapping Resolume nếu nhận ra layer/clip */
function recCueName(desc, address) {
  return window.HSCueLayout.resolveCueName(address, desc);
}

/* Xếp lane R cho cue theo nhóm: cùng nhóm → cùng lane; chồng thời gian (Piano/Float) → lane phụ */
function recLaneByName(f, desc) {
  const lanes = f.id === state.activeFolderId ? state.lanes : (f.lanes || (f.lanes = []));
  const plan = window.HSCueLayout.planLane({ descriptor: desc, lanes, events: f.events,
    config: { ...REC_CFG, LANE_GROUP_MODE: state.laneGroupMode, regroup: !!desc.regroup } });
  if (plan.preserveManual) return plan.laneName;
  let lane = lanes.find((item) => item.id === plan.laneId);
  if (plan.create) {
    let n = 1;
    while (lanes.some((item) => item.name === 'R' + n)) n++;
    lane = { id: nid(), name: 'R' + n, kind: 'R', locked: false, autoRec: true };
    lanes.splice(plan.index, 0, lane);
  } else if (plan.index != null) {
    lanes.splice(lanes.indexOf(lane), 1);
    lanes.splice(plan.index, 0, lane);
  }
  Object.assign(lane, { recGroup: plan.groupKey, groupLabel: plan.groupLabel,
    color: lane.colorManual ? lane.color : plan.color, auxiliary: !!plan.auxiliary });
  f.lanes = lanes;
  return lane.name;
}

function recLayoutCue(f, cue, desc, regroup = false) {
  cue.lane = recLaneByName(f, { ...desc, __cue: cue, regroup });
  if (regroup) cue.manualLane = false;
  const lane = f.lanes.find((item) => item.name === cue.lane);
  if (cue.laneId != null) cue.laneId = lane.id;
  cue.recGroup = lane.recGroup || null;
  const def = f.cues.find((item) => item.id === cue.cueId);
  if (def && !def.colorManual) def.color = lane.color || '';
  recNormalizeLanes(f);
}

function padAddr(note, ch, device = state.midiDeviceId) {
  const key = midiNoteKey(note, ch);
  const mapping = (device && midiMap.get(device + '|' + key)) || midiMap.get(key);
  return (device && MIDI.padMap.get(device + '|' + key)) || MIDI.padMap.get(key) || (mapping && mapping.address) || '';
}

function recSendMidi(kind, num, ch, value, timeStamp, device) {
  const tx = recTransactions.get(recActiveSession);
  if (!tx || tx.cutoff !== null || !state.recArmed || !state.playing || !oscPort) return false;
  const t = Number.isFinite(timeStamp) ? (timeStamp > 1e12 ? timeStamp : performance.timeOrigin + timeStamp)
    : performance.timeOrigin + performance.now();
  // Keep pre-ACK MIDI after recStart on the same FIFO port, including a following recStop.
  try { oscPort.post({ type: 'recMidi', session: tx.session, event: { kind, num, ch, value, t, device } }); }
  catch (_) { recInterrupt('Không gửi được MIDI tới recorder'); return false; }
  return true;
}

function midiDisconnect(device) {
  let held = false;
  for (const [key, note] of [...MIDI.notes]) {
    if (note.device !== device) continue;
    midiNoteOff(note.note, note.ch, undefined, device);
    MIDI.notes.delete(key);
    held = true;
  }
  if (held || recActiveSession !== null) setStatus('MIDI ngắt kết nối; đã nhả note đang giữ, không tự chọn thiết bị khác.');
}

function midiNoteOn(note, ch, vel, timeStamp, device = state.midiDeviceId) {
  const addr = padAddr(note, ch, device);
  // MONITOR MIDI: ghi nhận note-on (chưa biết Trigger/Piano → tạm 'Trigger', cập nhật khi off)
  MIDI.monOpen = MIDI.monOpen || new Map();
  const key = (device || '') + '|' + midiNoteKey(note, ch);
  MIDI.monOpen.set(key, { t0: performance.now(), vel, label: noteName(note) });
  monPushMidi({
    kind: 'note', label: noteName(note), num: note, ch,
    type: 'Trigger', cls: 'trig', val: 'vel ' + vel,
    rawVal: vel / 127, holdFrames: 0
  });
  // During REC, physical MIDI drives Resolume; app Bounce would duplicate its feedback.
  const bounce = state.midiBounce && addr && recActiveSession === null;
  if (bounce) sendOsc(addr, [1]);
  MIDI.notes.set(key, { note, ch, vel, device, bounceAddress: bounce ? addr : '' });
  if (!recSendMidi('noteOn', note, ch, vel, timeStamp, device)) return;
  updateTransport();
}

function midiNoteOff(note, ch, timeStamp, device = state.midiDeviceId) {
  const key = (device || '') + '|' + midiNoteKey(note, ch);
  // MONITOR MIDI: nếu giữ ≥ ngưỡng Piano → thêm dòng Piano
  const open = MIDI.monOpen && MIDI.monOpen.get(key);
  if (open) {
    MIDI.monOpen.delete(key);
    const heldMs = performance.now() - open.t0;
    if (heldMs >= REC_CFG.PIANO_HOLD_THRESHOLD_S * 1000) {
      monPushMidi({
        kind: 'note', label: open.label, num: note, ch,
        type: 'Piano', cls: 'piano', val: (heldMs / 1000).toFixed(1) + 's',
        rawVal: open.vel / 127,
        holdFrames: Math.round(heldMs / 1000 * state.fps)
      });
    }
  }
  const held = MIDI.notes.get(key);
  MIDI.notes.delete(key);
  const bounce = state.midiBounce && recActiveSession === null;
  recSendMidi('noteOff', note, ch, 0, timeStamp, device);
  const addr = held ? held.bounceAddress : padAddr(note, ch, device);
  if (bounce && addr) sendOsc(addr, [0]);
  updateTransport();
}

/* Núm vặn / fader (CC) → cue Float: vặn là "cử chỉ" → 1 cue, kéo dài tới khi ngưng vặn,
   giá trị def luôn = mức mới nhất (mô hình dữ liệu gửi args theo cue gốc). */
function midiCC(ccNum, ch, val, timeStamp, device = state.midiDeviceId) {
  // MONITOR MIDI: mọi CC đều hiện (kể cả khi REC tắt)
  monPushMidi({
    kind: 'cc', label: 'CC ' + ccNum, num: ccNum, ch,
    type: 'Float', cls: 'float', val: (val / 127).toFixed(3),
    rawVal: val / 127, isCC: true, holdFrames: 0
  });
  recSendMidi('cc', ccNum, ch, val, timeStamp, device);
}

/* PAD LEARN — "đơn tơ địa chỉ" kiểu 404: đang ở chế độ Học + có CUE đang chọn
   → OSC vào gần nhất tự thành ĐỊA CHỈ của cue đó (bấm clip trong Resolume là xong).
   Đồng thời nhớ OSC vào cuối cùng cho pad map (note bấm sau dùng địa chỉ này). */
/* PAD LEARN — học địa chỉ OSC vào gần nhất.
   Chống telemetry nền ghi đè cue:
   • Bỏ qua địa chỉ telemetry (position/values/speed/bypass/connected/tempo…) — không bao giờ là đích map.
   • Gom UI: dữ liệu (def.address) cập nhật ngay, nhưng noteChange/render/flash tối đa ~6 lần/giây. */
const LEARN_UI_FLUSH_MS = 160;
let learnPending = null;        // {f, def, address, args, firstInWindow}
let learnTimer = null;

function midiPadLearn(address, args) {
  MIDI.lastOscIn = { address, args: args || [] };
  if (state.midiPadMode !== 'learn') return;
  if (window.HSOSC && window.HSOSC.isRecNoise(address)) return;   // telemetry không dùng để học
  const cue = state.sel;
  if (!cue) return;
  const f = state.folders.find((fo) => fo.events.includes(cue));
  if (!f) return;
  const def = f.cues.find((c) => c.id === cue.cueId);
  if (!def) return;
  if (def.address === address && !(cue.recMeta && cue.recMeta.unassigned)) return;
  // Dữ liệu cập nhật ngay (đúng semantics: OSC vào gần nhất thắng)
  def.address = address;
  if (Array.isArray(args) && args.length) def.args = args.slice();
  if (!def.nameEdited) def.name = recCueName(cue.recMeta || {}, address);
  recLayoutCue(f, cue, { ...(cue.recMeta || {}), address, kind: def.mode,
    startFrame: cue.frame, durationFrames: cue.duration }, true);
  if (cue.recMeta) {
    Object.assign(cue.recMeta, { unassigned: false, guessed: false, matched: false, mappingStatus: 'manual' });
    if (cue.recMeta.num != null && cue.recMeta.source !== 'osc') {
      midiMap.set(recMapKey(cue.recMeta), { address, kind: cue.recMeta.kind, args: structuredClone(def.args) });
    }
  }
  // UI + undo: gom theo cửa sổ ngắn
  if (!learnPending) learnPending = { firstAt: performance.now() };
  learnPending.f = f; learnPending.def = def; learnPending.address = address;
  if (!learnTimer) learnTimer = setTimeout(flushLearnUi, LEARN_UI_FLUSH_MS);
}

function flushLearnUi() {
  if (learnTimer) { clearTimeout(learnTimer); learnTimer = null; }
  const p = learnPending;
  learnPending = null;
  if (!p || !p.def) return;
  // noteChange phải chạy TRƯỚC khi đổi để snapshot "trước" được giữ — nhưng vì
  // địa chỉ đã gán rồi, ta chốt trạng thái hiện tại làm mốc hoàn tác của lần học này.
  noteChange();
  renderFolders();
  renderProps();
  scheduleAutosave();
  if (performance.now() - (p.firstAt || 0) >= 0) {
    flashStatus(`Đã học địa chỉ: ${p.address} → cue "${p.def.name}" (Cmd+Z hoàn tác).`);
  }
}

/* ---------- UI gắn kết ---------- */
if ($('learnedMappingFallback')) {
  $('learnedMappingFallback').checked = state.useLearnedMappingFallback;
  $('learnedMappingFallback').addEventListener('change', (e) => {
    state.useLearnedMappingFallback = !!e.target.checked;
    noteChange();
    scheduleAutosave();
  });
}
if ($('laneGroupMode')) {
  $('laneGroupMode').value = state.laneGroupMode;
  $('laneGroupMode').addEventListener('change', (e) => {
    state.laneGroupMode = ['layer+type', 'address'].includes(e.target.value) ? e.target.value : window.HSRealtime.LANE_GROUP_MODE;
    scheduleAutosave();
    noteChange();
  });
}
$('mrMidiScan').addEventListener('click', midiScan);
$('mrMidiDevice').addEventListener('change', (e) => {
  state.midiDeviceId = e.target.value || null;
  midiWatch();
  scheduleAutosave();
});
$('mrSource').addEventListener('change', (e) => {
  state.recSource = e.target.value === 'osc' ? 'osc' : 'midi';
  pushOscMode();
  $('mrBounce').parentElement.style.display = '';
  $('mrPadBox').style.display = '';
  $('mrTpl').style.display = '';
  $('mrMidiBox').style.display = '';
  $('mrMidiScan').style.display = '';
  scheduleAutosave();
  flashStatus('REC thống nhất luôn ghi cả MIDI + OSC; nguồn chọn chỉ để tham khảo. Bounce chỉ gửi mapping thật.');
});
$('mrPadMode').addEventListener('change', (e) => {
  state.midiPadMode = e.target.value === 'learn' ? 'learn' : 'auto';
  pushOscMode();
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
/* đồng bộ recMode (radio trong panel cài đặt) */
document.querySelectorAll('input[name="recMode"]').forEach((r) => {
  r.addEventListener('change', (e) => {
    if (e.target.checked) {
      state.recMode = e.target.value;
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

  // BROADCAST trạng thái (20Hz — timer riêng, KHÔNG phụ thuộc rAF/visibility của cửa sổ chính)
  setInterval(() => {
    captureActiveProject();       // pstate mỗi bài luôn tươi trong danh sách broadcast
    const f = curFolder();
    const nx = nextCue();
    const st = {
      frame: Math.round(state.frame),
      fps: state.fps,
      speed: state.speed,
      playing: state.playing,
      contentEnd: totalFrames(),
      curFolderId: f ? f.id : null,
      // cue kế tiếp cho ô NEXT của cửa sổ SMALL — kèm số thứ tự trong toàn bộ cue của bài
      next: nx ? {
        name: cueLabel(nx.ev, nx.f), frame: nx.t,
        idx: VF.indexOf(nx) + 1, total: VF.filter((x) => x.ev.enabled !== false).length
      } : null,
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
  }, 50);

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
      sendOsc(d.address, d.args, d.outputTarget); // engine chính là nguồn gửi OSC duy nhất
      flashStatus(`Mini đã bắn cue: ${d.name} → ${d.address}`);
      return;
    }
  });
})();
