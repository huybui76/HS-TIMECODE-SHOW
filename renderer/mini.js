'use strict';
/* ===== HS TIMECODE · MINI — bảng điều khiển CHỌN BÀI + PLAYBACK =====
   • KHÔNG timeline, KHÔNG waveform, KHÔNG công cụ chỉnh sửa.
   • Mini chỉ HIỂN THỊ trạng thái broadcast từ cửa sổ chính và GỬI lệnh về đó (window.hs.miniCmd).
   • Toàn bộ playback/OSC/project data do engine DUY NHẤT ở cửa sổ chính thực thi. */

const $ = (id) => document.getElementById(id);
const state = {
  frame: 0,
  fps: 30,
  playing: false,
  contentEnd: 0,
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
if (window.hs.onUiState) window.hs.onUiState((st) => {
  if (!st) return;
  state.frame = st.frame || 0;
  state.fps = st.fps || 30;
  state.playing = !!st.playing;
  state.contentEnd = st.contentEnd || 0;
  state.folders = Array.isArray(st.folders) ? st.folders : [];
  state.curFolderId = st.curFolderId || null;
  if (st.osc) { state.oscListening = st.osc.listening; state.oscPort = st.osc.port; }
  if (st.stats) { state.rx = st.stats.rx; state.tx = st.stats.tx; }
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
  renderFoot();
});
if (window.hs.onStats) window.hs.onStats((s) => {
  state.rx = s.rx; state.tx = s.tx;
  renderFoot();
});

/* ---------- render ---------- */
function render() {
  $('miniTcText').textContent = tcString(state.frame, state.fps);
  const st = $('miniStatus');
  if (state.playing) { st.textContent = '● ĐANG PHÁT'; st.className = 'status play'; }
  else { st.textContent = '⏸ TẠM DỪNG'; st.className = 'status pause'; }
  $('mPlay').disabled = state.playing;
  $('mPause').disabled = !state.playing;
  // thanh vị trí: playhead / cuối nội dung — CHỈ SỐ, không phải timeline
  const pct = state.contentEnd > 0 ? Math.min(100, (state.frame / state.contentEnd) * 100) : 0;
  $('miniBarFill').style.width = pct.toFixed(2) + '%';
  renderProjects();
  renderFoot();
}

function renderPin() {
  const pin = $('miniPin');
  pin.classList.toggle('on', state.alwaysOnTop);
  pin.title = state.alwaysOnTop
    ? 'Always on Top đang BẬT — bấm để tắt'
    : 'Always on Top đang TẮT — bấm để bật';
}

/* danh sách BÀI (project) — highlight bài đang mở; ● bài đang chạy */
function renderProjects() {
  const list = $('mProjList');
  const sig = state.folders.map((f) => `${f.id}|${f.name}|${f.cues}|${f.songs}`).join('§') + '#' + state.curFolderId + '#' + state.playing;
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
  state.folders.forEach((f) => {
    const row = document.createElement('button');
    const isOpen = f.id === state.curFolderId;
    row.className = 'proj-row' + (isOpen ? ' open' : '') + (isOpen && state.playing ? ' running' : '');
    if (f.color) row.style.borderLeft = '3px solid ' + f.color;
    const nm = document.createElement('span');
    nm.className = 'pname';
    nm.textContent = f.name;
    const meta = document.createElement('span');
    meta.className = 'pmeta';
    meta.textContent = `${f.cues} cue · ${f.songs} nhạc`;
    const badge = document.createElement('span');
    badge.className = 'pbadge';
    if (isOpen && state.playing) { badge.textContent = '● ĐANG CHẠY'; badge.classList.add('run'); }
    else if (isOpen) { badge.textContent = 'ĐANG MỞ'; badge.classList.add('sel'); }
    row.append(nm, meta, badge);
    row.title = `Mở "${f.name}" — cửa sổ chính sẽ chuyển sang bài này`;
    row.addEventListener('click', () => {
      // chọn bài ở SMALL → engine chính chuyển project (2 chiều)
      if (!isOpen) window.hs.miniCmd({ type: 'select-project', folderId: f.id });
    });
    list.appendChild(row);
  });
}

function renderFoot() {
  const osc = $('mOsc');
  if (state.oscListening === null) { osc.textContent = 'OSC ● --'; osc.className = 'badge'; }
  else if (state.oscListening) { osc.textContent = 'OSC ● ' + state.oscPort; osc.className = 'badge on'; }
  else { osc.textContent = 'OSC ● TẮT'; osc.className = 'badge off'; }
  $('mRx').textContent = 'RX ' + state.rx;
  $('mTx').textContent = 'TX ' + state.tx;
}

/* ---------- gửi lệnh về engine chính ---------- */
$('mPlay').addEventListener('click', () => window.hs.miniCmd({ type: 'play' }));
$('mPause').addEventListener('click', () => window.hs.miniCmd({ type: 'pause' }));
$('mStop').addEventListener('click', () => window.hs.miniCmd({ type: 'stop' }));
$('miniMain').addEventListener('click', () => window.hs.miniFocusMain());
$('miniPin').addEventListener('click', () => {
  state.alwaysOnTop = !state.alwaysOnTop;
  renderPin();
  window.hs.setMiniTop(state.alwaysOnTop);   // native setAlwaysOnTop — main process lưu settings
});

renderPin();
render();
