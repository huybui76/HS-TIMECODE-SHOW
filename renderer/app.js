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
  folders: [],             // [{id, name, offset, events:[{id, frame, address, args, lane}]}]
  activeFolderId: null,    // thư mục nhận cue khi ghi
  lanes: [],               // [{id, name:'V1'|'A1'|'R1', kind:'V'|'A'|'R', songId}] — thứ tự trên timeline
  recLaneId: null,         // lane R nhận cue khi ghi
  songs: [],               // [{id, name, path, duration, size, peaks, decoding}]
  songIndex: -1,           // bài đang làm mốc thời gian (nguồn đồng hồ)
  autoAdvance: true,
  sel: null,               // cue đang chọn (tham chiếu object)
  multiSel: new Set(),     // vùng chọn nhiều cue (⌘-click)
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
  ppsInit: false
};

const LANE_COLORS = ['#4f8cff', '#9a6bff', '#3ecfb2', '#e5c25a', '#ff8a5c', '#5cd6ff', '#ff6b9d', '#a8e34d'];
const MAX_MON_ROWS = 300;
const AUTOSAVE_KEY = 'hs-timecode-autosave';
let idSeq = Date.now();
const nid = () => ++idSeq;

const $ = (id) => document.getElementById(id);
const audio = $('player');
const canvas = $('timeline');
const ctx = canvas.getContext('2d');
let audioCtx = null;
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

function nextLaneName(kind) {
  let n = 1;
  while (state.lanes.some((l) => l.name === kind + n)) n++;
  return kind + n;
}

function addLane(kind, silent) {
  const lane = { id: nid(), name: nextLaneName(kind), kind, songId: null };
  state.lanes.push(lane);
  if (kind === 'R' && !state.recLaneId) state.recLaneId = lane.id;
  if (!silent) { renderLanes(); renderTimelineHeader(); scheduleAutosave(); }
  return lane;
}

function removeLane(id) {
  const i = state.lanes.findIndex((l) => l.id === id);
  if (i < 0 || state.lanes.length <= 1) return;
  const lane = state.lanes[i];
  const cueCount = flat.filter((x) => x.ev.lane === lane.name).length;
  if (cueCount && !confirm(`Lane ${lane.name} có ${cueCount} cue. Xóa lane? (cue sẽ chuyển sang lane đầu tiên)`)) return;
  state.lanes.splice(i, 1);
  const fallback = state.lanes[0].name;
  state.folders.forEach((f) => f.events.forEach((ev) => { if (ev.lane === lane.name) ev.lane = fallback; }));
  if (state.recLaneId === id) {
    const r = state.lanes.find((l) => l.kind === 'R');
    state.recLaneId = r ? r.id : null;
  }
  rebuildFlat();
  renderLanes();
  fillRecLaneSel();
  scheduleAutosave();
}

function recLane() {
  return laneById(state.recLaneId) || state.lanes.find((l) => l.kind === 'R') || state.lanes[0] || null;
}

function ensureLanesForProject() {
  // bảo đảm mọi cue.lane đều có lane trên timeline
  const names = new Set(flat.map((x) => x.ev.lane));
  names.forEach((name) => {
    if (!laneByName(name)) {
      const kind = /^[VA]/.test(name) ? name[0] : 'V';
      state.lanes.push({ id: nid(), name, kind, songId: null });
    }
  });
  if (!state.lanes.length) {
    addLane('V', true);
    addLane('V', true);
    addLane('A', true);
    addLane('R', true);
  }
  if (!state.recLaneId) {
    const r = state.lanes.find((l) => l.kind === 'R');
    state.recLaneId = r ? r.id : state.lanes[0].id;
  }
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
  title.innerHTML = `TIMELINE — <span id="tlSongName">${escapeHtml(curSong() ? curSong().name : 'Chính')}</span>`;
}

$('btnLaneV').addEventListener('click', () => addLane('V'));
$('btnLaneA').addEventListener('click', () => addLane('A'));
$('btnLaneR').addEventListener('click', () => addLane('R'));

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
  flat = [];
  state.folders.forEach((f) => {
    f.events.forEach((ev) => flat.push({ t: f.offset + ev.frame, ev, f }));
  });
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

/* ================= Thư mục cue ================= */
function addFolder(name) {
  const f = { id: nid(), name: name || `Thư mục ${state.folders.length + 1}`, offset: 0, events: [] };
  state.folders.push(f);
  state.activeFolderId = f.id;
  refreshAll();
  return f;
}

function removeFolder(id) {
  const i = state.folders.findIndex((f) => f.id === id);
  if (i < 0) return;
  const f = state.folders[i];
  if (f.events.length && !confirm(`Xóa thư mục "${f.name}" (${f.events.length} cue)?`)) return;
  state.folders.splice(i, 1);
  if (state.sel && !state.folders.some((x) => x.events.includes(state.sel))) state.sel = null;
  if (!state.folders.length) addFolder('Chính');
  else if (state.activeFolderId === id) state.activeFolderId = state.folders[Math.max(0, i - 1)].id;
  refreshAll();
}

function makeCue(frame, address, args) {
  return {
    id: nid(), frame, address, args: args || [1], lane: laneOf(address),
    name: '', duration: 0, note: '', color: '', enabled: true, mode: 'trigger'
  };
}

const SWATCHES = [
  '#ff8a00', '#ffb340', '#ffe14d', '#c6e34d', '#8fe04d', '#4de07a',
  '#3ecfb2', '#4dc4e0', '#4f8cff', '#5f6bff', '#8a5cff', '#b44dff',
  '#e04dc4', '#ff4d9d', '#ff4d6b', '#ff6b4d', '#e0e0e0', '#9aa0aa',
  '#5a6070', '#46f0b0'
];

function cueColor(ev, lane) {
  return ev.color || laneColor(lane || ev.lane);
}

function cueLabel(ev) {
  return ev.name || ev.address;
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

    const head = document.createElement('div');
    head.className = 'fhead';
    const name = document.createElement('input');
    name.className = 'fname';
    name.value = f.name;
    name.title = 'Đổi tên thư mục';
    name.addEventListener('change', () => { f.name = name.value.trim() || f.name; name.value = f.name; fillRecFolderSel(); scheduleAutosave(); });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
    const cnt = document.createElement('span');
    cnt.className = 'fcnt';
    cnt.textContent = f.events.length;
    const del = document.createElement('button');
    del.className = 'fdel';
    del.textContent = '🗑';
    del.title = 'Xóa thư mục';
    del.addEventListener('click', (e) => { e.stopPropagation(); removeFolder(f.id); });
    head.append(name, cnt, del);
    head.addEventListener('click', (e) => {
      if (e.target === name || e.target === del) return;
      state.activeFolderId = f.id;
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
    const shown = q ? f.events.filter((ev) => ev.address.toLowerCase().includes(q)) : f.events;
    if (!shown.length) {
      const em = document.createElement('div');
      em.className = 'folder-empty';
      em.textContent = q ? 'Không có cue khớp tìm kiếm' : 'Chưa có cue — bật REC và gõ MIDI, hoặc nhấn ＋ Cue';
      cuesBox.appendChild(em);
    }
    shown.forEach((ev) => {
      const row = document.createElement('div');
      row.className = 'cue-row' + (selSet().has(ev) ? ' sel' : '');
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/hs-cue', `${f.id}:${ev.id}`);
        e.dataTransfer.effectAllowed = 'copyMove';
      });
      if (ev.color) row.style.boxShadow = `inset 3px 0 0 ${ev.color}`;
      if (ev.enabled === false) row.style.opacity = '0.45';
      const tc = document.createElement('span');
      tc.className = 'tc';
      tc.textContent = tcString(f.offset + ev.frame, state.fps);
      tc.title = 'Nhấp đúp để sửa timecode';
      const ln = document.createElement('span');
      ln.className = 'ln';
      ln.textContent = ev.lane;
      const ad = document.createElement('span');
      ad.className = 'ad';
      ad.textContent = cueLabel(ev);
      ad.title = ev.address + ' — nhấp đúp để sửa';
      const cx = document.createElement('button');
      cx.className = 'cx';
      cx.textContent = '✕';
      cx.title = 'Xóa cue';
      row.append(tc, ln, ad, cx);
      row.addEventListener('click', (e) => {
        if (e.target === cx) return;
        state.sel = ev;
        renderFolders();
        renderProps();
        if (!state.playing) setFrame(f.offset + ev.frame);
      });
      tc.addEventListener('dblclick', () => editCueTc(f, ev, tc));
      ad.addEventListener('dblclick', () => {
        const v = prompt('Địa chỉ OSC:', ev.address);
        if (v && v.startsWith('/')) { ev.address = v.trim(); ev.lane = laneOf(ev.address); refreshAll(); }
      });
      cx.addEventListener('click', () => {
        const i = f.events.indexOf(ev);
        if (i >= 0) f.events.splice(i, 1);
        if (state.sel === ev) state.sel = null;
        refreshAll();
      });
      cuesBox.appendChild(row);
    });
    div.appendChild(cuesBox);
    box.appendChild(div);
  });
}

function editCueTc(folder, ev, span) {
  const inp = document.createElement('input');
  inp.value = tcString(folder.offset + ev.frame, state.fps);
  inp.style.width = '92px';
  inp.style.background = '#0e0e12';
  span.innerHTML = '';
  span.appendChild(inp);
  inp.focus();
  inp.select();
  const commit = () => {
    const v = parseTC(inp.value, state.fps);
    if (v !== null) ev.frame = v - folder.offset; // frame nội bộ = vị trí hiệu dụng − OFFSET
    refreshAll();
  };
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') renderFolders();
  });
  inp.addEventListener('blur', () => commit());
}

/* ================= Kho nhạc ================= */
function addSongFile(path) {
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
  state.songs.splice(i, 1);
  if (wasActive) {
    state.songIndex = -1;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  } else if (i < state.songIndex) {
    state.songIndex--;
  }
  renderSongs();
  updateAudioName();
  scheduleAutosave();
}

function activateSong(i, autoplay = false) {
  state.songIndex = i;
  const song = curSong();
  state.frame = 0;
  state.ppsInit = false;
  state.viewStart = 0;
  if (song && song.path) {
    audio.src = 'file://' + encodeURI(song.path);
    audio.playbackRate = state.speed;
    if (song.duration) decodeWaveform(song);
  } else {
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
      activateSong(i);
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
  for (let x = 0; x < cv.width; x++) {
    const bi = Math.min(song.peaks.n - 1, Math.floor((x / cv.width) * song.peaks.n));
    c2.moveTo(x + .5, mid - song.peaks.maxs[bi] * half);
    c2.lineTo(x + .5, mid - song.peaks.mins[bi] * half);
  }
  c2.stroke();
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
      const n = 3000;
      const ch0 = audioBuf.getChannelData(0);
      const ch1 = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : null;
      const mins = new Float32Array(n), maxs = new Float32Array(n);
      const step = Math.max(1, Math.floor(ch0.length / n));
      for (let i = 0; i < n; i++) {
        let mn = 1, mx = -1;
        const s = i * step, e = Math.min(ch0.length, s + step);
        for (let j = s; j < e; j++) {
          let v = ch0[j];
          if (ch1) v = (v + ch1[j]) / 2;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        mins[i] = mn;
        maxs[i] = (mx === -1) ? 0 : mx;
      }
      song.peaks = { n, mins, maxs };
      if (!song.duration) song.duration = audioBuf.duration;
      song.decoding = false;
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
      addSongFile(p);
      if (activate && first) {
        activateSong(state.songs.length - 1);
        if (zone.__onSongDrop) zone.__onSongDrop(state.songs[state.songs.length - 1].id, e);
        first = false;
      }
    });
  });
}

/* ================= Đồng hồ ================= */
function totalSeconds() {
  const s = curSong();
  if (s && s.path && s.duration > 0) return s.duration;
  const lastT = flat.length ? flat[flat.length - 1].t / state.fps : 0;
  return Math.max(600, lastT + 30);
}

function totalFrames() { return Math.max(1, Math.round(totalSeconds() * state.fps)); }

function setFrame(f, fromAudio = false) {
  state.frame = clamp(f, 0, totalFrames());
  if (mode() === 'audio' && !fromAudio && curSong().duration > 0) {
    audio.currentTime = clamp(state.frame / state.fps, 0, Math.max(0, curSong().duration - 0.02));
  }
  state.playbackIdx = lowerBoundFlat(state.frame);
}

function play() {
  const s = curSong();
  if (mode() === 'audio') {
    if (!s) { setStatus('Chưa có nhạc — thêm bài trong danh sách NHÁC trước.'); return; }
    if (s.duration === 0) { setStatus('Đang nạp nhạc, thử lại giây lát…'); return; }
  }
  if (state.frame >= totalFrames() - 1) setFrame(0);
  state.playing = true;
  if (mode() === 'audio') {
    audio.playbackRate = state.speed;
    audio.play().catch((e) => setStatus('Không phát được nhạc: ' + e.message));
  }
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

function atEndReached() {
  if (state.loop) {
    setFrame(0);
    if (mode() === 'audio') { audio.currentTime = 0; audio.play().catch(() => {}); }
    return;
  }
  if (state.autoAdvance && state.songIndex >= 0 && state.songIndex < state.songs.length - 1) {
    activateSong(state.songIndex + 1, true);
    return;
  }
  state.frame = totalFrames();
  pause();
  setStatus('Đã hết bài cuối.');
}

/* ================= Phát cue ================= */
function fireDue() {
  while (state.playbackIdx < flat.length && flat[state.playbackIdx].t <= state.frame) {
    const x = flat[state.playbackIdx++];
    if (x.ev.enabled === false) continue;
    sendOsc(x.ev.address, x.ev.args);
  }
}

function nextCue() {
  for (const x of flat) {
    if (x.t > state.frame && x.ev.enabled !== false) return x;
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
  state.playbackIdx = lowerBoundFlat(state.frame);
  renderFolders();
  fillRecFolderSel();
  renderLanes();
  updateSelBar();
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
  const badge = $('mrRx');
  badge.textContent = 'RX ' + rxLocal;
  badge.classList.add('flash');
  setTimeout(() => badge.classList.remove('flash'), 120);
  $('mrLast').textContent = msg.address + '  ' + (msg.args || []).join(',');
  if (state.recArmed && state.playing && passFilter(msg.address)) {
    const f = curFolder();
    if (!f) { setStatus('Chưa có thư mục cue — nhấn ＋ Thư mục.'); return; }
    const rl = recLane();
    const cue = makeCue(Math.floor(state.frame) - f.offset, msg.address, msg.args);
    cue.lane = rl ? rl.name : 'V1';
    insertCue(f, cue);
    refreshAll();
    flashStatus(`Đã ghi cue @ ${tcString(state.frame, state.fps)} → ${f.name}/${cue.lane}  ${msg.address}`);
  }
}

/* Tạo cue từ một message OSC bất kỳ (nút + trên Monitor / OSC → Cue) */
function cueFromOsc(address, args) {
  let f = curFolder();
  if (!f) f = addFolder('Chính');
  const cue = makeCue(Math.floor(state.frame) - f.offset, address, args);
  cue.name = address.split('/').filter(Boolean).slice(-1)[0] || 'Cue';
  const rl = recLane();
  cue.lane = rl ? rl.name : 'V1';
  insertCue(f, cue);
  state.sel = cue;
  refreshAll();
  renderProps();
  flashStatus(`Đã thêm cue từ ${address} @ ${tcString(state.frame, state.fps)}`);
}

/* ================= Timeline ================= */
const GUT = 46, TOP = 24, ROW = 28, A1H = 46;

function frameToX(f) { return ((f / state.fps) - state.viewStart) * state.pps + GUT; }
function xToFrame(x) { return ((x - GUT) / state.pps + state.viewStart) * state.fps; }

function eventEndFrame(x) {
  if (x.ev.duration > 0) return x.t + x.ev.duration;
  const idx = flat.indexOf(x);
  for (let j = idx + 1; j < flat.length; j++) {
    if (flat[j].ev.lane === x.ev.lane) return flat[j].t;
  }
  return x.t + Math.round(state.fps * 0.75);
}

function timelineRows() {
  const rows = state.lanes.map((l) => ({
    lane: l.name, id: l.id, kind: l.kind, songId: l.songId,
    h: l.kind === 'A' ? A1H : ROW, isAudio: l.kind === 'A'
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
    state.pps = (W - GUT - 12) / dur;
    state.ppsInit = true;
  }
  if (!state.pps) return;

  const rows = timelineRows();

  if (state.playing && state.follow && !dragInfo && !blockDrag) {
    const curSec = state.frame / state.fps;
    const viewSec = (W - GUT) / state.pps;
    if (curSec < state.viewStart || curSec > state.viewStart + viewSec * 0.85) {
      state.viewStart = Math.max(0, curSec - viewSec * 0.25);
    }
  }

  // thước thời gian
  ctx.fillStyle = '#17171b';
  ctx.fillRect(GUT, 0, W - GUT, TOP);
  ctx.font = '10px Menlo, monospace';
  ctx.textBaseline = 'middle';
  const viewSec = (W - GUT) / state.pps;
  let step = 1;
  while (step * state.pps < 52) step *= (step >= 8 ? 10 : 2);
  const startT = Math.floor(state.viewStart / step) * step;
  for (let t = startT; t <= state.viewStart + viewSec; t += step) {
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

  // lane (V/A/R theo thứ tự người dùng) + nút xóa trên gutter
  rows.forEach((r, ri) => {
    ctx.fillStyle = r.isAudio ? '#0e1613' : (r.kind === 'R' ? '#171310' : '#141419');
    ctx.fillRect(GUT, r.y, W - GUT, r.h - 6);
    ctx.fillStyle = '#202027';
    ctx.fillRect(0, r.y, GUT - 6, r.h - 6);
    ctx.fillStyle = r.isAudio ? '#3ecfb2' : (r.kind === 'R' ? '#ffb36b' : '#9a9aa5');
    ctx.font = 'bold 10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(r.lane, GUT - 12, r.y + (r.h - 6) / 2);
    ctx.textAlign = 'left';
    // nút xóa lane ( × nhỏ dưới tên khi hover impossible trên canvas — luôn hiện mờ )
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.font = '9px -apple-system, sans-serif';
    ctx.fillText('×', 4, r.y + 8 + (ri === 0 ? 0 : 0));
    // xóa bằng chuột phải tại gutter
  });

  // các lane A có nhạc → vẽ waveform của bài gắn trên lane đó
  rows.filter((r) => r.isAudio && r.songId).forEach((r) => {
    const song = state.songs.find((s) => s.id === r.songId);
    if (!song || !song.path) return;
    const mid = r.y + (r.h - 6) / 2;
    const half = (r.h - 6) / 2 - 3;
    const songDur = song.duration || dur;
    if (song.peaks) {
      ctx.strokeStyle = '#3ecfb2';
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      for (let x = GUT; x < W; x++) {
        const sec = (x - GUT) / state.pps + state.viewStart;
        if (sec < 0 || sec > songDur) continue;
        const bi = Math.min(song.peaks.n - 1, Math.floor((sec / songDur) * song.peaks.n));
        ctx.moveTo(x + .5, mid - song.peaks.maxs[bi] * half);
        ctx.lineTo(x + .5, mid - song.peaks.mins[bi] * half);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else {
      ctx.strokeStyle = '#2a4a41';
      ctx.beginPath(); ctx.moveTo(GUT, mid); ctx.lineTo(W, mid); ctx.stroke();
      ctx.fillStyle = '#4a7a6d';
      ctx.font = '10px -apple-system, sans-serif';
      ctx.fillText(song.decoding ? 'đang phân tích sóng nhạc…' : 'kéo bài hát từ danh sách NHÁC vào đây', GUT + 8, mid - 6);
    }
    const endX = frameToX(songDur * state.fps);
    if (endX > GUT && endX < W) {
      ctx.strokeStyle = '#3ecfb2';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(endX, r.y); ctx.lineTo(endX, r.y + r.h - 6); ctx.stroke();
      ctx.setLineDash([]);
    }
  });

  // cue (đã cộng OFFSET từng thư mục)
  flat.forEach((x) => {
    const row = rows.find((r) => r.lane === x.ev.lane);
    if (!row) return;
    const x1 = frameToX(x.t);
    const x2 = frameToX(eventEndFrame(x));
    if (x2 < GUT || x1 > W) return;
    const bx = Math.max(x1, GUT), bw = Math.max(3, x2 - x1 - 2);
    const isSelected = selSet().has(x.ev);
    ctx.fillStyle = cueColor(x.ev);
    ctx.globalAlpha = isSelected ? 1 : (x.ev.enabled === false ? 0.3 : 0.78);
    ctx.fillRect(bx, row.y + 2, bw, row.h - 10);
    ctx.globalAlpha = 1;
    if (isSelected) {
      ctx.strokeStyle = '#fff';
      ctx.strokeRect(bx + .5, row.y + 2.5, bw - 1, row.h - 11);
    }
    if (bw > 34) {
      ctx.fillStyle = '#0b0b0e';
      ctx.font = '9px Menlo, monospace';
      const label = x.ev.address.split('/').slice(-2).join('/');
      ctx.fillText(label.slice(0, Math.floor(bw / 6)), bx + 4, row.y + (row.h - 6) / 2);
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
}

/* Tương tác timeline */
let dragInfo = null;      // pan / click
let blockDrag = null;     // kéo khối cue: {fx, folder, grabDt, mouse:{x,y}}
let mousePos = { x: -1, y: -1 };

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
  for (const fx of flat) {
    if (fx.ev.lane !== row.lane) continue;
    if (t >= fx.t && t < eventEndFrame(fx)) return { fx, row };
  }
  return null;
}

canvas.addEventListener('mousedown', (e) => {
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  mousePos = { x, y };
  // nút × xóa lane trên gutter
  if (x <= 18 && x >= 0) {
    const row = hitLaneRow(y);
    if (row) { removeLane(row.id); return; }
  }
  // context menu để xóa lane (phím Shift + click)
  if (e.button === 2 && x <= 18) {
    const row = hitLaneRow(y);
    if (row) { removeLane(row.id); e.preventDefault(); return; }
  }
  // bắt đầu kéo khối cue: mép phải = đổi độ dài, thân = dời
  const hit = hitCueBlock(x, y);
  if (hit && x >= GUT) {
    const f = state.folders.find((fo) => fo.events.includes(hit.fx.ev));
    const endX = frameToX(eventEndFrame(hit.fx));
    const mode = (hit.fx.ev.duration > 0 && Math.abs(x - endX) <= 6) ? 'resize' : 'move';
    blockDrag = { fx: hit.fx, folder: f, mouse: { x, y }, moved: false, mode };
    canvas.style.cursor = mode === 'resize' ? 'ew-resize' : 'grabbing';
    return;
  }
  dragInfo = { x, y, moved: false, viewStart0: state.viewStart };
});
canvas.addEventListener('mousemove', (e) => {
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  mousePos = { x, y };
  if (blockDrag) {
    if (Math.abs(x - blockDrag.mouse.x) > 2 || Math.abs(y - blockDrag.mouse.y) > 2) blockDrag.moved = true;
    return;
  }
  // con trỏ gợi ý vùng đổi độ dài ở mép phải khối cue
  if (!dragInfo && !blockDrag) {
    const hit = hitCueBlock(x, y);
    canvas.style.cursor = (hit && hit.fx.ev.duration > 0 && Math.abs(x - frameToX(eventEndFrame(hit.fx))) <= 6)
      ? 'ew-resize' : 'crosshair';
  }
  if (!dragInfo) return;
  if (Math.abs(x - dragInfo.x) > 4) dragInfo.moved = true;
  if (dragInfo.moved) {
    state.viewStart = Math.max(0, dragInfo.viewStart0 - (x - dragInfo.x) / state.pps);
  }
});
canvas.addEventListener('mouseleave', () => { dragInfo = null; mousePos = { x: -1, y: -1 }; });
canvas.addEventListener('mouseup', (e) => {
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (blockDrag) {
    if (blockDrag.mode === 'resize') {
      if (blockDrag.moved && blockDrag.folder) {
        const ev = blockDrag.fx.ev;
        const newDur = Math.max(1, Math.round(xToFrame(x)) - blockDrag.fx.t);
        ev.duration = newDur;
        refreshAll();
        renderProps();
        flashStatus(`Độ dài cue = ${tcString(newDur, state.fps)}`);
      }
    } else if (blockDrag.moved && blockDrag.folder) {
      const newT = Math.round(xToFrame(x)) - blockDrag.folder.offset;
      const row = hitLaneRow(y);
      const ev = blockDrag.fx.ev;
      const i = blockDrag.folder.events.indexOf(ev);
      if (i >= 0) blockDrag.folder.events.splice(i, 1);
      ev.frame = Math.max(0, newT);
      if (row && !row.isAudio) ev.lane = row.lane;
      insertCue(blockDrag.folder, ev); // chèn lại — trước đây bị thiếu làm cue biến mất
      state.sel = ev;
      state.multiSel = new Set([ev]);
      refreshAll();
      renderProps();
      flashStatus(`Đã dời cue tới ${tcString(blockDrag.folder.offset + ev.frame, state.fps)} trên ${ev.lane}`);
    } else {
      // click chọn cue (⌘/Ctrl = thêm/bỏ khỏi vùng chọn)
      const ev = blockDrag.fx.ev;
      if (e.metaKey || e.ctrlKey) {
        if (state.multiSel.has(ev)) state.multiSel.delete(ev);
        else state.multiSel.add(ev);
        state.sel = [...state.multiSel].slice(-1)[0] || null;
      } else {
        state.multiSel = new Set([ev]);
        state.sel = ev;
        if (!state.playing) setFrame(blockDrag.fx.t);
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
  if (!dragInfo.moved && x >= GUT) {
    const row = hitLaneRow(y);
    if (row && row.isAudio) {
      // bấm lane A có nhạc → lấy bài đó làm mốc thời gian
      const si = state.songs.findIndex((s) => s.id === row.songId);
      if (si >= 0) activateSong(si);
    } else {
      state.sel = null;
      renderFolders();
      renderProps();
      setFrame(Math.round(xToFrame(x)));
    }
  }
  dragInfo = null;
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left;
  const anchorSec = (x - GUT) / state.pps + state.viewStart;
  const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25;
  state.pps = clamp(state.pps * factor, 2, 600);
  state.viewStart = Math.max(0, anchorSec - (x - GUT) / state.pps);
}, { passive: false });

/* Thả vào timeline: bài hát (gắn vào lane A) hoặc cue (đặt thời điểm + lane) */
setupDrop(canvas, true);
canvas.__onSongDrop = (songId, e) => {
  const r = canvas.getBoundingClientRect();
  const row = hitLaneRow(e.clientY - r.top);
  if (row && row.isAudio) {
    row.songId = songId; // gắn bài vào đúng lane A bị thả
    const lane = laneById(row.id);
    if (lane) lane.songId = songId;
    scheduleAutosave();
  }
};
canvas.addEventListener('drop', (e) => {
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const cid = e.dataTransfer.getData('text/hs-cue');
  const sid = e.dataTransfer.getData('text/hs-song');
  if (cid && !sid) {
    e.preventDefault();
    e.stopPropagation();
    const [fid, ceid] = cid.split(':').map(Number);
    const f = state.folders.find((fo) => fo.id === fid);
    const ev = f && f.events.find((c) => c.id === ceid);
    if (ev && f) {
      const row = hitLaneRow(y);
      const i = f.events.indexOf(ev);
      if (i >= 0) f.events.splice(i, 1);
      ev.frame = Math.max(0, Math.round(xToFrame(x)) - f.offset);
      if (row && !row.isAudio) ev.lane = row.lane;
      insertCue(f, ev); // chèn lại — trước đây bị thiếu làm cue biến mất
      state.sel = ev;
      state.multiSel = new Set([ev]);
      updateSelBar();
      refreshAll();
      renderProps();
      flashStatus(`Đã đặt cue tại ${tcString(f.offset + ev.frame, state.fps)} trên ${ev.lane}`);
    }
    return;
  }
  if (sid) {
    e.preventDefault();
    const i = state.songs.findIndex((s) => s.id === Number(sid));
    if (i >= 0) {
      const row = hitLaneRow(y);
      if (row && row.isAudio) {
        row.songId = state.songs[i].id;
        const lane = laneById(row.id);
        if (lane) lane.songId = state.songs[i].id;
        scheduleAutosave();
        flashStatus(`Đã gắn "${state.songs[i].name}" vào lane ${row.lane}`);
      }
    }
    return;
  }
  const files = [...e.dataTransfer.files];
  if (files.length) {
    e.preventDefault();
    const row = hitLaneRow(y);
    const exts = /\.(mp3|wav|aiff|aif|m4a|aac|flac|ogg)$/i;
    const audioFiles = files.filter((f) => exts.test(f.name));
    if (audioFiles.length && row && row.isAudio) {
      let first = true;
      audioFiles.forEach((f) => {
        const p = window.hs.filePath(f);
        if (!p) return;
        addSongFile(p);
        if (first) {
          const si = state.songs.length - 1;
          row.songId = state.songs[si].id;
          const lane = laneById(row.id);
          if (lane) lane.songId = state.songs[si].id;
          activateSong(si);
          first = false;
        }
      });
      scheduleAutosave();
      setStatus(`Đã thêm ${audioFiles.length} bài vào lane ${row.lane}.`);
      return;
    }
  }
}, true); // chặn trước handler của setupDrop

/* Vẽ khối cue đang kéo (ghost) — ghép vào cuối drawTimeline qua hook */
const _drawTimeline = drawTimeline;
drawTimeline = function () {
  _drawTimeline();
  if (blockDrag && blockDrag.moved && state.pps) {
    const rows = timelineRows();
    const row = rows.find((rr) => rr.lane === blockDrag.fx.ev.lane);
    if (row) {
      const x1 = blockDrag.mode === 'resize'
        ? frameToX(blockDrag.fx.t)
        : frameToX(xToFrame(mousePos.x));
      const bw = blockDrag.mode === 'resize'
        ? Math.max(3, mousePos.x - x1)
        : Math.max(3, frameToX(eventEndFrame(blockDrag.fx)) - frameToX(blockDrag.fx.t));
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = cueColor(blockDrag.fx.ev);
      ctx.fillRect(x1, row.y + 2, bw, row.h - 10);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#fff';
      ctx.strokeRect(x1 + .5, row.y + 2.5, bw - 1, row.h - 11);
      if (blockDrag.mode === 'resize') {
        const dFrames = Math.max(1, Math.round(xToFrame(mousePos.x)) - blockDrag.fx.t);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 10px Menlo, monospace';
        ctx.fillText(tcString(dFrames, state.fps), x1 + bw + 6, row.y + (row.h - 6) / 2);
      }
      // highlight hàng dưới con trỏ
      const hover = hitLaneRow(mousePos.y);
      if (hover && !hover.isAudio && blockDrag.mode !== 'resize') {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.strokeRect(GUT + .5, hover.y + .5, canvas.clientWidth - GUT - 1, hover.h - 7);
      }
    }
  }
};

$('btnZoomIn').addEventListener('click', () => { state.pps = clamp(state.pps * 1.3, 2, 600); });
$('btnZoomOut').addEventListener('click', () => { state.pps = clamp(state.pps / 1.3, 2, 600); });

/* ================= Vòng lặp chính ================= */
let lastT = null;
let lastInfoFrame = -1;
function tick(t) {
  if (state.playing) {
    if (mode() === 'audio') {
      state.frame = audio.currentTime * state.fps;
    } else if (lastT != null) {
      state.frame += ((t - lastT) / 1000) * state.fps * state.speed;
    }
    fireDue();
    if (state.frame >= totalFrames()) atEndReached();
    updateTc();
  }
  if (Math.floor(state.frame) !== lastInfoFrame) {
    lastInfoFrame = Math.floor(state.frame);
    updateInfoStrip();
  }
  lastT = t;
  drawTimeline();
  requestAnimationFrame(tick);
}

/* Dải HIỆN TẠI / CUE TIẾP THEO / CÒN LẠI */
function updateInfoStrip() {
  $('infoCur').textContent = tcString(state.frame, state.fps);
  const nx = nextCue();
  if (nx) {
    $('infoNext').textContent = tcString(nx.t, state.fps);
    const fname = nx.f.name && nx.f.name !== 'Chính' ? `${nx.f.name}: ` : '';
    $('infoNextName').textContent = fname + (nx.ev.name || nx.ev.address);
    $('infoRem').textContent = tcString(Math.max(0, nx.t - state.frame), state.fps);
  } else {
    $('infoNext').textContent = '--:--:--:--';
    $('infoNextName').textContent = 'không còn cue nào';
    const rem = totalFrames() - state.frame;
    $('infoRem').textContent = tcString(Math.max(0, rem), state.fps);
  }
}
requestAnimationFrame(tick);

audio.addEventListener('loadedmetadata', () => {
  const s = curSong();
  if (s && audio.duration && Math.abs((s.duration || 0) - audio.duration) > 0.5) {
    s.duration = audio.duration;
    renderSongs();
    updateAudioName();
    scheduleAutosave();
  }
});
audio.addEventListener('ended', () => { if (state.playing) atEndReached(); });

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
      if (!f) f = addFolder('Chính');
      const cue = makeCue(Math.floor(state.frame) - f.offset, addr, parsed);
      cue.name = addr.split('/').filter(Boolean).slice(-1)[0] || 'Cue';
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
  open: () => openProjectDialog(),
  save: () => saveProjectDialog(),
  undo, redo,
  cut: cutSelection,
  copy: copySelection,
  paste: () => pasteSelection(),
  hide: toggleHideSelection,
  'delete': () => deleteSelection(),
  zoomin: () => { state.pps = clamp(state.pps * 1.3, 2, 600); },
  zoomout: () => { state.pps = clamp(state.pps / 1.3, 2, 600); },
  home: () => setFrame(0),
  follow: () => { $('followChk').checked = !$('followChk').checked; state.follow = $('followChk').checked; flashStatus('Theo thanh đò: ' + (state.follow ? 'BẬT' : 'TẮT')); },
  help: () => flashStatus('Quy trình: ① Bật Output trong Resolume (Preferences → OSC → 127.0.0.1:7000) ② Kéo nhạc vào lane A ③ Bật REC, Phát, gõ MIDI ④ Dừng REC, Play lại để chạy show. ⌘-click chọn nhiều cue.')
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
  entries.forEach(([addr, item]) => {
    const args = parseOscArgs([...item.args.keys()][0]);
    let f = curFolder();
    if (!f) f = addFolder('Chính');
    const cue = makeCue(Math.floor(state.frame) - f.offset, addr, args);
    cue.name = addr.split('/').filter(Boolean).slice(-1)[0] || 'Cue';
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
    if (!f) { addFolder('Chính'); }
    if (!state.playing) play();
    flashStatus(`REC BẬT — ghi vào thư mục "${(f || curFolder()).name}". Gõ MIDI vào Resolume ngay.`);
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
    const key = `${ev.frame}|${ev.address}|${JSON.stringify(ev.args)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  refreshAll();
  flashStatus(`Dọn trùng: đã bỏ ${before - f.events.length} cue trùng.`);
});
$('mrMonitor').addEventListener('click', () => {
  $('monHead').scrollIntoView({ behavior: 'smooth', block: 'center' });
  monBox.scrollTop = monBox.scrollHeight;
  flashStatus('Bảng MONITOR nằm ở panel phải — mỗi dòng OSC có nút ＋ để chuyển thành cue.');
});
$('autoAdvChk').addEventListener('change', (e) => { state.autoAdvance = e.target.checked; });
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
$('vol').addEventListener('input', (e) => { audio.volume = parseFloat(e.target.value); });

$('btnAddCue').addEventListener('click', () => {
  let f = curFolder();
  if (!f) f = addFolder('Chính');
  const addr = $('testAddr').value.trim() || '/composition/layers/1/clips/1/connect';
  const cue = makeCue(Math.floor(state.frame) - f.offset, addr, [1]);
  cue.name = 'Cue mới';
  insertCue(f, cue);
  state.sel = cue;
  refreshAll();
  renderProps();
  flashStatus(`Đã thêm cue rỗng @ ${tcString(state.frame, state.fps)} — chỉnh chi tiết ở THUỘC TÍNH CUE bên dưới.`);
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
  $('selCount').textContent = `${n} đã chọn`;
  $('selBar').style.display = n ? 'flex' : 'none';
}

function findCueLoc(ev) {
  for (const f of state.folders) {
    const i = f.events.indexOf(ev);
    if (i >= 0) return { f, i };
  }
  return null;
}

function copySelection() {
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
  if (!copySelection()) return;
  deleteSelection(false);
  flashStatus(`Đã cắt — nhấn Dán để đặt tại thanh đò.`);
}

function pasteSelection(atFrame) {
  const items = state.clipboardMulti || (state.clipboard ? [state.clipboard] : null);
  if (!items || !items.length) { setStatus('Chưa có cue nào trong bộ nhớ.'); return; }
  let f = curFolder();
  if (!f) f = addFolder('Chính');
  const base = Math.floor(atFrame !== undefined ? atFrame : state.frame) - f.offset;
  const base0 = items[0].frame;
  const newSel = new Set();
  items.forEach((src) => {
    const cue = makeCue(Math.max(0, base + (src.frame - base0)), src.address, JSON.parse(JSON.stringify(src.args || [1])));
    cue.name = src.name || ''; cue.duration = src.duration || 0;
    cue.note = src.note || ''; cue.color = src.color || '';
    cue.mode = src.mode || 'trigger'; cue.lane = src.lane || cue.lane;
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

function deleteSelection(notify = true) {
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
    const firstNew = state.songs.length;
    paths.forEach((p) => addSongFile(p));
    if (state.songIndex < 0) activateSong(firstNew);
    setStatus(`Đã thêm ${paths.length} bài vào danh sách NHÁC.`);
  }
});

$('btnApplyPort').addEventListener('click', () => {
  const p = parseInt($('listenPort').value, 10);
  if (!(p >= 1024 && p <= 65535)) { setStatus('Cổng nghe không hợp lệ (1024–65535).'); return; }
  state.listenPort = p;
  window.hs.setListenPort(p).catch((e) => setStatus('Lỗi đổi cổng: ' + e.message));
});
$('targetHost').addEventListener('change', (e) => { state.target.host = e.target.value.trim() || '127.0.0.1'; });
$('targetPort').addEventListener('change', (e) => { state.target.port = parseInt(e.target.value, 10) || 7001; });

$('btnCheckResolume').addEventListener('click', () => {
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

setupDrop($('audioDrop'), true);

/* OSC từ main process */
window.hs.onOsc(onOscMessage);
window.hs.onStatus((s) => {
  const el = $('oscStatus');
  if (s.listening) {
    el.className = 'pill on';
    el.textContent = `ĐANG NGHE :${s.port}`;
  } else {
    el.className = 'pill off';
    el.textContent = s.error ? `LỖI: ${s.error}` : 'ĐÓNG';
  }
});

/* ================= Panel thuộc tính cue ================= */
function findSelectedFolder() {
  if (!state.sel) return null;
  return state.folders.find((f) => f.events.includes(state.sel)) || null;
}

function renderProps() {
  const ev = state.sel;
  $('propsEmptyHint').style.display = ev ? 'none' : '';
  $('propsBody').style.display = ev ? '' : 'none';
  if (!ev) return;
  const f = findSelectedFolder();
  $('pName').value = ev.name || '';
  $('pTime').value = tcString(f ? f.offset + ev.frame : ev.frame, state.fps);
  $('pDur').value = ev.duration > 0 ? tcString(ev.duration, state.fps) : '';
  $('pAddr').value = ev.address;
  $('pArgs').value = (ev.args || []).join(', ');
  $('pNote').value = ev.note || '';
  $('pEnabled').checked = ev.enabled !== false;
  ['Trigger', 'Piano', 'Float'].forEach((m) => {
    $('pMode' + m).classList.toggle('active', (ev.mode || 'trigger') === m.toLowerCase());
  });
  renderSwatches();
}

function renderSwatches() {
  const box = $('pSwatches');
  box.innerHTML = '';
  if (!state.sel) return;
  SWATCHES.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (state.sel.color === c ? ' sel' : '');
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => {
      state.sel.color = state.sel.color === c ? '' : c;
      renderProps();
      renderFolders();
      scheduleAutosave();
    });
    box.appendChild(b);
  });
}

$('pName').addEventListener('input', (e) => { if (state.sel) { state.sel.name = e.target.value; renderFolders(); scheduleAutosave(); } });
$('pTime').addEventListener('change', () => {
  const f = findSelectedFolder();
  const v = parseTC($('pTime').value, state.fps);
  if (state.sel && v !== null && f) {
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
    state.sel.duration = v === null || v <= 0 ? 0 : v;
    scheduleAutosave();
  }
});
$('pDur').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('pAddr').addEventListener('change', () => {
  const v = $('pAddr').value.trim();
  if (state.sel && v.startsWith('/')) {
    state.sel.address = v;
    state.sel.lane = laneOf(v);
    refreshAll();
  }
});
$('pArgs').addEventListener('change', () => {
  if (!state.sel) return;
  state.sel.args = $('pArgs').value.split(',').map((s) => s.trim()).filter((s) => s !== '')
    .map((s) => (!isNaN(Number(s)) ? Number(s) : s));
  scheduleAutosave();
});
$('pNote').addEventListener('input', (e) => { if (state.sel) { state.sel.note = e.target.value; scheduleAutosave(); } });
$('pEnabled').addEventListener('change', (e) => {
  if (state.sel) { state.sel.enabled = e.target.checked; renderFolders(); scheduleAutosave(); }
});
['Trigger', 'Piano', 'Float'].forEach((m) => {
  $('pMode' + m).addEventListener('click', () => {
    if (state.sel) { state.sel.mode = m.toLowerCase(); renderProps(); scheduleAutosave(); }
  });
});
$('pDelete').addEventListener('click', () => { deleteSelected(); renderProps(); });
$('pPlayNow').addEventListener('click', () => {
  if (!state.sel) return;
  sendOsc(state.sel.address, state.sel.args);
  flashStatus(`Đã gửi ngay: ${state.sel.address}`);
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
  return JSON.stringify({ folders: state.folders, lanes: state.lanes });
}

function applySnapshot(snap) {
  const d = JSON.parse(snap);
  state.folders = d.folders;
  state.lanes = d.lanes;
  state.sel = null;
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
  return {
    version: 5,
    fps: state.fps,
    autoAdvance: state.autoAdvance,
    activeFolderId: state.activeFolderId,
    recLaneId: state.recLaneId,
    songIndex: state.songIndex,
    folders: state.folders,
    lanes: state.lanes,
    songs: state.songs.map((s) => ({ id: s.id, name: s.name, path: s.path, duration: s.duration, size: s.size })),
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

function migrateCue(e) {
  return {
    id: e.id || nid(), frame: e.frame || 0, address: e.address,
    args: e.args || [1], lane: laneOf(e.address),
    name: e.name || '', duration: e.duration || 0, note: e.note || '',
    color: e.color || '', enabled: e.enabled !== false, mode: e.mode || 'trigger'
  };
}

function applyProject(data) {
  if (!data || ![3, 4, 5].includes(data.version)) { setStatus('File dự án không hợp lệ.'); return; }
  pause();
  state.fps = data.fps || 30;
  $('fpsSel').value = String(state.fps);
  state.folders = (Array.isArray(data.folders) && data.folders.length)
    ? data.folders.map((f) => ({
        id: f.id || nid(),
        name: f.name || 'Thư mục',
        offset: f.offset || 0,
        events: Array.isArray(f.events) ? f.events.filter((e) => e && e.address).map(migrateCue) : []
      }))
    : [{ id: nid(), name: 'Chính', offset: 0, events: [] }];
  state.songs = (Array.isArray(data.songs) ? data.songs : []).map((s) => ({
    id: s.id || nid(), name: s.name || 'Bài', path: s.path || '',
    duration: s.duration || 0, size: s.size || 0, peaks: null, decoding: false
  }));
  state.lanes = (Array.isArray(data.lanes) && data.lanes.length)
    ? data.lanes.filter((l) => l && l.name).map((l) => ({
        id: l.id || nid(), name: l.name, kind: l.kind || l.name[0], songId: l.songId || null
      }))
    : [];
  state.songIndex = -1;
  state.autoAdvance = data.autoAdvance !== false;
  $('autoAdvChk').checked = state.autoAdvance;
  state.sel = null;
  renderSongs();
  state.activeFolderId = state.folders.some((f) => f.id === data.activeFolderId)
    ? data.activeFolderId : state.folders[0].id;
  refreshAll();
  ensureLanesForProject();
  renderLanes();
  // nếu dự án có nhạc mà chưa lane A nào gắn bài → gắn bài đầu vào lane A đầu
  const aLane = state.lanes.find((l) => l.kind === 'A');
  if (aLane && !aLane.songId && state.songs[0]) aLane.songId = state.songs[0].id;
  // nạp lại waveform các bài
  state.songs.forEach((s) => { if (s.path) { decodeWaveform(s); } });
  const st = data.settings || {};
  if (st.listenPort) { state.listenPort = st.listenPort; $('listenPort').value = st.listenPort; window.hs.setListenPort(st.listenPort); }
  if (st.targetHost) { state.target.host = st.targetHost; $('targetHost').value = st.targetHost; }
  if (st.targetPort) { state.target.port = st.targetPort; $('targetPort').value = String(st.targetPort); }
  if (st.filterPreset) { state.filterPreset = st.filterPreset; $('filterSel').value = st.filterPreset; $('filterRegex').style.display = st.filterPreset === 'custom' ? 'block' : 'none'; }
  if (st.filterRegex !== undefined) { state.filterRegex = st.filterRegex; $('filterRegex').value = st.filterRegex; }
  if (st.recMode) { state.recMode = st.recMode; const el = document.querySelector(`input[name="recMode"][value="${st.recMode}"]`); if (el) el.checked = true; }
  if (data.recLaneId && state.lanes.some((l) => l.id === data.recLaneId)) {
    state.recLaneId = data.recLaneId;
    fillRecLaneSel();
  }
  $('filterHint').textContent = filterDescription();
  if (typeof data.songIndex === 'number' && data.songIndex >= 0 && data.songIndex < state.songs.length) {
    activateSong(data.songIndex);
  } else {
    updateAudioName();
  }
  setStatus(`Đã nạp dự án: ${state.folders.length} thư mục, ${state.songs.length} bài.`);
}

async function saveProjectDialog() {
  const r = await window.hs.saveProject(serializeProject());
  if (r) setStatus('Đã lưu dự án: ' + r);
}
async function openProjectDialog() {
  const r = await window.hs.openProject();
  if (r) applyProject(r.data);
}
$('btnSaveProj').addEventListener('click', saveProjectDialog);
$('btnOpenProj').addEventListener('click', openProjectDialog);

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if (e.metaKey || e.ctrlKey) {
    if (k === 's') { e.preventDefault(); saveProjectDialog(); }
    else if (k === 'o') { e.preventDefault(); openProjectDialog(); }
    else if (k === 'c') { e.preventDefault(); copySelection(); }
    else if (k === 'x') { e.preventDefault(); cutSelection(); }
    else if (k === 'v') { e.preventDefault(); pasteSelection(); }
    else if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === 'a') { e.preventDefault(); selectAllCues(); }
  }
});

function selectAllCues() {
  const set = new Set();
  state.folders.forEach((f) => f.events.forEach((ev) => set.add(ev)));
  state.multiSel = set;
  state.sel = [...set].slice(-1)[0] || null;
  renderFolders();
  updateSelBar();
  flashStatus(`Đã chọn ${set.size} cue.`);
}

/* ================= Khởi động ================= */
(function init() {
  if (!state.folders.length) addFolder('Chính');
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
      if ([3, 4, 5].includes(data.version)) { applyProject(data); restored = true; }
    }
  } catch (_) { /* bỏ qua */ }
  if (!restored) refreshAll();
  setStatus('Bật ● REC → gõ MIDI vào Resolume → cue tự ghi vào lane R. Chưa nhận OSC? Bấm "Resolume" trên thanh MIDI REC.');
})();
