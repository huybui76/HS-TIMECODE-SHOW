'use strict';
/* ===== HS TIMECODE · MINI — điều khiển từ xa: 3 ô thời gian + playback + danh sách bài 2 cột =====
   • KHÔNG timeline, KHÔNG waveform, KHÔNG công cụ chỉnh sửa.
   • Mini chỉ HIỂN THỊ trạng thái broadcast từ cửa sổ chính và GỬI lệnh về đó (window.hs.miniCmd).
   • Toàn bộ playback/OSC/project data do engine DUY NHẤT ở cửa sổ chính thực thi. */

const $ = (id) => document.getElementById(id);
const state = {
  frame: 0,
  fps: 30,
  speed: 1,
  playing: false,
  contentEnd: 0,
  next: null,             // {name, frame} cue kế tiếp (broadcast từ engine)
  folders: [],           // [{id, name, color, cues, songs}]
  curFolderId: null,     // bài đang mở ở cửa sổ chính (đồng bộ 2 chiều)
  alwaysOnTop: true,
  rx: 0, tx: 0, oscListening: null, oscPort: null
};

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

/* ---------- nhận trạng thái từ engine chính ---------- */
/* Đồng hồ hiển thị: engine gửi mốc (frame + thời điểm nhận), Small chỉ NỘI SUY giữa 2 mốc
   để số chạy mượt 60fps — KHÔNG tự quyết định thời gian, chỉ hiển thị. */
const disp = { baseFrame: 0, baseMs: 0, fps: 30, playing: false, speed: 1 };
let lastRenderMs = 0;

if (window.hs.onUiState) window.hs.onUiState((st) => {
  if (!st) return;
  state.frame = st.frame || 0;
  state.fps = st.fps || 30;
  state.speed = st.speed || 1;
  state.playing = !!st.playing;
  state.contentEnd = st.contentEnd || 0;
  state.next = st.next || null;
  state.folders = Array.isArray(st.folders) ? st.folders : [];
  state.curFolderId = st.curFolderId || null;
  if (st.osc) { state.oscListening = st.osc.listening; state.oscPort = st.osc.port; }
  if (st.stats) { state.rx = st.stats.rx; state.tx = st.stats.tx; }
  // neo lại mốc nội suy theo engine
  disp.baseFrame = state.frame;
  disp.baseMs = performance.now();
  disp.fps = state.fps;
  disp.playing = state.playing;
  disp.speed = state.speed;
  render();
});
if (window.hs.onMiniSettings) window.hs.onMiniSettings((s) => {
  if (!s) return;
  state.alwaysOnTop = !!s.alwaysOnTop;
  renderPin();
});
if (window.hs.onStatus) window.hs.onStatus((s) => {
  state.oscListening = !!s.listening;
  state.oscPort = s.port;
});
if (window.hs.onStats) window.hs.onStats((s) => {
  state.rx = s.rx; state.tx = s.tx;
});

/* ---------- render ---------- */
function displayFrame(nowMs) {
  if (!disp.playing) return disp.baseFrame;
  return disp.baseFrame + ((nowMs - disp.baseMs) / 1000) * disp.fps * disp.speed;
}

function render() {
  const f = state.playing ? displayFrame(performance.now()) : state.frame;
  $('miniTcText').textContent = tcString(f, state.fps);
  // trạng thái ở hàng trên: TẠM DỪNG / ĐANG PHÁT
  const st = $('miniStatus');
  if (state.playing) { st.textContent = 'ĐANG PHÁT'; st.className = 'stv play'; }
  else { st.textContent = 'TẠM DỪNG'; st.className = 'stv pause'; }
  $('mPlay').disabled = state.playing;
  $('mPause').disabled = !state.playing;

  // NEXT — cue kế tiếp của bài đang chạy: "Next: tên cue · cue n/total" + timecode đếm ngược
  const nName = $('miniNextName'), nLabel = $('miniNextLabel'), nIdx = $('miniNextIdx'), nTc = $('miniNextTc');
  if (state.next && state.next.frame > state.frame) {
    nTc.textContent = tcString(state.next.frame - f, state.fps);
    nLabel.textContent = state.next.name || 'cue';
    nIdx.textContent = state.next.idx ? `cue ${state.next.idx}/${state.next.total || '?'}` : '';
    nTc.classList.remove('next-none');
    nName.classList.remove('none');
  } else {
    nTc.textContent = '--:--:--:--';
    nLabel.textContent = 'không còn cue';
    nIdx.textContent = '';
    nTc.classList.add('next-none');
    nName.classList.add('none');
  }

  // CÒN LẠI — đến điểm ngoài cùng của timeline
  $('miniRem').textContent = state.contentEnd > 0
    ? tcString(Math.max(0, state.contentEnd - f), state.fps)
    : '00:00:00:00';

  // thanh vị trí: playhead / cuối nội dung — CHỈ SỐ, không phải timeline
  const pct = state.contentEnd > 0 ? Math.min(100, (f / state.contentEnd) * 100) : 0;
  $('miniBarFill').style.width = pct.toFixed(2) + '%';
  renderProjects();
}

/* vòng cập nhật hiển thị riêng của Small — luôn chạy (backgroundThrottling:false),
   nội suy giữa các broadcast để số thời gian không giật; KHÔNG phải nguồn thời gian. */
function miniTick() {
  if (state.playing) {
    const now = performance.now();
    if (now - lastRenderMs >= 33) {   // ~30fps cho phần chữ/thanh — đủ mượt, nhẹ CPU
      lastRenderMs = now;
      render();
    }
  }
  requestAnimationFrame(miniTick);
}
requestAnimationFrame(miniTick);

function renderPin() {
  const pin = $('miniPin');
  pin.classList.toggle('on', state.alwaysOnTop);
  pin.title = state.alwaysOnTop
    ? 'Always on Top đang BẬT — bấm để tắt'
    : 'Always on Top đang TẮT — bấm để bật';
}

/* danh sách BÀI — lưới 2 CỘT, head hiện SỐ BÀI; bài chọn nền cam nhạt nổi bật; meta luôn hiện cue/nhạc */
function renderProjects() {
  const list = $('mProjList');
  $('miniProjCount').textContent = `(${state.folders.length})`;
  const sig = state.folders.map((f) => `${f.id}|${f.name}|${f.color}|${f.cues}|${f.songs}`).join('§') + '#' + state.curFolderId + '#' + state.playing;
  if (list.__sig === sig) return;
  list.__sig = sig;
  list.innerHTML = '';
  if (!state.folders.length) {
    const em = document.createElement('div');
    em.className = 'proj-empty';
    em.textContent = 'Chưa có bài — tạo ở cửa sổ chính (+ Bài).';
    list.appendChild(em);
    return;
  }
  state.folders.forEach((f, i) => {
    const row = document.createElement('button');
    const isOpen = f.id === state.curFolderId;
    row.className = 'proj-row' + (isOpen ? ' open' : '') + (isOpen && state.playing ? ' running' : '');
    if (f.color && !isOpen) row.style.borderLeftColor = f.color;
    const num = document.createElement('i');
    num.className = 'pnum';
    num.textContent = i + 1;                       // SỐ THỨ TỰ bài
    const col = document.createElement('span');
    col.className = 'pcol';
    const nm = document.createElement('span');
    nm.className = 'pname';
    nm.textContent = f.name;
    const meta = document.createElement('span');
    meta.className = 'pmeta';
    // meta LUÔN hiện đủ số cue · số nhạc — trạng thái thêm cuối dòng
    meta.textContent = `${f.cues} cue · ${f.songs} nhạc`;
    if (isOpen && state.playing) {
      const tag = document.createElement('span');
      tag.className = 'run-tag';
      tag.textContent = ' · ● ĐANG CHẠY';
      meta.appendChild(tag);
    } else if (isOpen) {
      meta.append(' · ĐANG MỞ');
    }
    col.append(nm, meta);
    row.append(num, col);
    row.title = `Mở "${f.name}" — cửa sổ chính sẽ chuyển sang bài này`;
    row.addEventListener('click', () => {
      // chọn bài ở SMALL → engine chính chuyển project (2 chiều)
      if (!isOpen) window.hs.miniCmd({ type: 'select-project', folderId: f.id });
    });
    list.appendChild(row);
  });
}

/* ---------- gửi lệnh về engine chính ---------- */
$('mPlay').addEventListener('click', () => window.hs.miniCmd({ type: 'play' }));
$('mPause').addEventListener('click', () => window.hs.miniCmd({ type: 'pause' }));
$('mStop').addEventListener('click', () => window.hs.miniCmd({ type: 'stop' }));
$('miniPin').addEventListener('click', () => {
  state.alwaysOnTop = !state.alwaysOnTop;
  renderPin();
  window.hs.setMiniTop(state.alwaysOnTop);   // native setAlwaysOnTop — main process lưu settings
});

renderPin();
render();
