const { app, BrowserWindow, ipcMain, dialog, screen, powerSaveBlocker, utilityProcess, MessageChannelMain } = require('electron');
const path = require('path');
const fs = require('fs');
const dgram = require('dgram');
const osc = require('osc');
const { encodeOsc } = require('./osc-encode');
const { OscTargets } = require('./osc-targets');
const { LanSync } = require('./lan-sync');
const realtimeConfig = require('./realtime-config');
const {
  OSC_RESTART_INITIAL_MS, OSC_RESTART_MAX_MS, OSC_PROC_MAX_RESTARTS,
  DEFAULT_WHITELIST, STATS_INTERVAL_MS
} = realtimeConfig;

/* ===== NHIỀU ĐỊA CHỈ OSC (gửi song song) + XÁC THỰC 2 CHIỀU ===== */
let oscTargets = null;
let lanSync = null;
let rxCounter = 0;      // tổng OSC nhận được (dùng cho verify RX)

function ensureOscTargets() {
  if (!oscTargets) {
    oscTargets = new OscTargets({
      onChange: (list) => {
        if (win && !win.isDestroyed()) win.webContents.send('osc-targets', list);
      }
    });
  }
  return oscTargets;
}

function ensureLanSync() {
  if (!lanSync) {
    lanSync = new LanSync({
      onPeerList: (peers) => {
        if (win && !win.isDestroyed()) win.webContents.send('lan-peers', peers);
      },
      onProject: (json) => {
        // backup nhận show từ máy chính
        if (win && !win.isDestroyed()) win.webContents.send('lan-project', json);
      },
      onControl: (cmd) => {
        if (win && !win.isDestroyed()) win.webContents.send('lan-control', cmd);
      }
    });
  }
  return lanSync;
}

/* ===== OSC INGEST chạy trong utilityProcess (ngoài main + renderer) =====
   • Socket UDP + parser + lọc + ring buffer + đối chiếu MIDI↔OSC nằm ở đó.
   • Nối với renderer bằng MessagePort — KHÔNG đi qua ipcMain cho dữ liệu OSC.
   • Crash → tự khởi động lại (backoff), báo UI, không ảnh hưởng cue đã ghi. */
let oscProc = null;
let oscProcRenPort = null;    // đầu port còn lại để cấp cho renderer khi cần
let oscDesiredOn = false;
let oscProcRestartTimer = null;
let oscProcRestartDelay = OSC_RESTART_INITIAL_MS;
let oscProcRestarts = 0;
let oscProcReady = false;     // parent portReady handshake đã hoàn tất
let oscProcLastError = null;
let oscFloatAddresses = new Set();
const oscModeState = new Map();

let win = null;
let miniWin = null;
let sendSock = null;     // socket GỬI-RIÊNG (không nghe) dùng khi listener đang TẮT
let listenPort = Number(process.env.HS_LISTEN) || 7000;
let target = { host: '127.0.0.1', port: 7001 };
const stats = { rx: 0, tx: 0 };
let statsTimer = null;   // bơm số RX/TX — chỉ chạy khi listener ĐANG bật

/* ===== Gửi batch overflow counter từ utility lên UI (dùng chung sendStatus) ===== */
let oscQueueDropped = 0;

/* ===== Cài đặt cửa sổ SMALL (lưu trong userData — pin/always-on-top giữ nguyên lần sau mở) ===== */
const miniSettingsPath = path.join(app.getPath('userData'), 'hs-mini-settings.json');
let miniSettings = { alwaysOnTop: true };   // mặc định BẬT pin
try {
  Object.assign(miniSettings, JSON.parse(fs.readFileSync(miniSettingsPath, 'utf8')));
} catch (_) { /* chưa có file — dùng mặc định */ }
function saveMiniSettings() {
  try { fs.writeFileSync(miniSettingsPath, JSON.stringify(miniSettings, null, 2)); } catch (_) { /* bỏ qua */ }
}

let oscListening = false;   // cờ TRẠNG THÁI THẬT: socket đã bind thành công hay chưa
let mainOscErrorLogged = false;   // chống spam log/status khi lỗi packet liên tục

function sendStatus(error) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('osc-status', {
      listening: oscListening,
      port: listenPort,
      error: error || null
    });
  }
  if (miniWin && !miniWin.isDestroyed()) {
    miniWin.webContents.send('osc-status', {
      listening: oscListening,
      port: listenPort,
      error: error || null
    });
  }
}

function closePort() {
  oscDesiredOn = false;
  if (oscProcRestartTimer !== null) {
    clearTimeout(oscProcRestartTimer);
    oscProcRestartTimer = null;
  }
  oscProcReady = false;
  if (oscProcRenPort) {
    try { oscProcRenPort.close(); } catch (_) {}
    oscProcRenPort = null;
  }
  const proc = oscProc;
  oscProc = null;  // exit/message callbacks của process cũ không còn sở hữu trạng thái
  if (proc) {
    try { proc.postMessage({ type: 'closePort' }); } catch (_) {}
    try { proc.kill(); } catch (_) {}
  }
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  oscListening = false;
  sendStatus(null);
}

function attachOscRenderer() {
  if (!oscProc || !oscDesiredOn) return;
  if (!oscProcRenPort) {
    const channel = new MessageChannelMain();
    try {
      oscProc.postMessage({ type: 'port' }, [channel.port1]);
    } catch (e) {
      channel.port1.close();
      channel.port2.close();
      throw e;
    }
    oscProcRenPort = channel.port2;
  }
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
    try {
      win.webContents.postMessage('osc-port', null, [oscProcRenPort]);
      oscProcRenPort = null;
    } catch (_) { /* giữ port để thử lại khi renderer load xong */ }
  }
}

function sendOscFilterToProc() {
  if (!oscProc || !oscProcReady) return;
  try {
    oscProc.postMessage({
      type: 'filter',
      filter: { whitelist: [...new Set([...DEFAULT_WHITELIST, ...oscFloatAddresses])] }
    });
  } catch (_) {}
}

/* Khởi động (hoặc khởi động lại) utility process OSC */
function startOscProcess() {
  if (!oscDesiredOn || oscProc) return;
  let proc;
  try {
    proc = utilityProcess.fork(path.join(__dirname, 'osc-ingest.js'), [], {
      serviceName: 'HS OSC Ingest',
      stdio: 'inherit'
    });
  } catch (e) {
    oscProcLastError = e.message;
    console.error('[osc-proc] fork lỗi:', e.message);
    scheduleOscRestart();
    return;
  }
  oscProc = proc;
  oscProcReady = false;

  proc.on('message', (m) => {
    if (oscProc !== proc || !oscDesiredOn || !m || !m.type) return;
    if (m.type === 'portReady') {
      // Renderer reload cũng có portReady, nhưng KHÔNG bind lại UDP.
      if (oscProcReady) return;
      oscProcReady = true;
      sendOscFilterToProc();
      for (const mode of oscModeState.values()) proc.postMessage(mode);
      sendOscSettingsToProc();
      return;
    }
    if (m.type === 'rx-delta') {
      if (m.n) { rxCounter += m.n; stats.rx += m.n; }
      return;  // chỉ verify/counters; không chuyển từng delta đến UI
    }
    if (win && !win.isDestroyed()) win.webContents.send('osc-proc', m);
    if (m.type === 'ready') {
      oscListening = true;
      oscProcRestartDelay = OSC_RESTART_INITIAL_MS;
      oscProcLastError = null;
      if (!statsTimer) {
        statsTimer = setInterval(() => {
          if (oscProc !== proc || !oscListening) return;
          if (win && !win.isDestroyed()) win.webContents.send('stats', { ...stats });
          if (miniWin && !miniWin.isDestroyed()) miniWin.webContents.send('stats', { ...stats });
        }, STATS_INTERVAL_MS);
      }
      sendStatus(null);
    } else if (m.type === 'error') {
      oscProcLastError = m.error || 'lỗi OSC';
      if (m.fatal) {
        oscListening = false;
        if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
        sendStatus(oscProcLastError);
        // A failed bind leaves the utility alive but unable to receive. Restart it
        // through the same bounded backoff path as an unexpected process exit.
        try { proc.kill(); } catch (_) {}
      }
    } else if (m.type === 'closed') {
      oscListening = false;
      if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
      sendStatus(null);
    } else if (m.type === 'stats' && m.stats) {
      oscQueueDropped = m.stats.droppedOverflow || 0;
    }
  });

  proc.on('exit', (code) => {
    if (oscProc !== proc) return;
    oscProc = null;
    oscProcReady = false;
    oscListening = false;
    if (oscProcRenPort) {
      try { oscProcRenPort.close(); } catch (_) {}
      oscProcRenPort = null;
    }
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
    if (!oscDesiredOn) return;
    sendStatus(oscProcLastError || 'OSC process dừng — đang khởi động lại…');
    if (win && !win.isDestroyed()) {
      win.webContents.send('osc-proc', { type: 'restarting', code });
    }
    scheduleOscRestart();
  });

  try {
    attachOscRenderer();
  } catch (e) {
    oscProcLastError = e.message;
    proc.kill();
  }
}

function scheduleOscRestart() {
  if (!oscDesiredOn || oscProc || oscProcRestartTimer !== null) return;
  if (oscProcRestarts >= OSC_PROC_MAX_RESTARTS) {
    oscDesiredOn = false;
    sendStatus('OSC process lỗi quá nhiều lần — tắt OSC. Bật lại thủ công.');
    return;
  }
  oscProcRestarts++;
  const delay = Math.min(OSC_RESTART_MAX_MS, oscProcRestartDelay);
  oscProcRestartDelay = Math.min(OSC_RESTART_MAX_MS, oscProcRestartDelay * 2);
  oscProcRestartTimer = setTimeout(() => {
    oscProcRestartTimer = null;
    if (oscDesiredOn && !oscProc) startOscProcess();
  }, delay);
}

function openPort() {
  if (!oscDesiredOn) {
    oscProcRestarts = 0;
    oscProcRestartDelay = OSC_RESTART_INITIAL_MS;
    oscProcLastError = null;
  }
  oscDesiredOn = true;
  if (oscProcRestartTimer !== null) return;
  startOscProcess();
}

function sendOscSettingsToProc() {
  if (!oscDesiredOn || !oscProc || !oscProcReady) return;
  try { oscProc.postMessage({ type: 'setPort', port: listenPort }); } catch (_) {}
}

function senderPort() {
  if (!sendSock) {
    sendSock = dgram.createSocket('udp4');
    try { sendSock.unref(); } catch (_) { /* bỏ qua */ }
  }
  return sendSock;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#0d0d0f',
    title: 'HS TIMECODE',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // SHOW REALTIME: không cho Chromium ngắt/throttle renderer khi cửa sổ bị che,
      // minimize hoặc hide (Cmd+H). Engine playback + timer chạy trong renderer.
      backgroundThrottling: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Renderer reload (dev) → cấp lại port cho lần load mới
  win.webContents.on('did-finish-load', () => attachOscRenderer());
}

/* Giữ renderer thức trong lúc show: chặn App Nap / hibernate của macOS cho cả 2 cửa sổ. */
let powerBlockerId = null;
function keepAwake(on) {
  if (on && powerBlockerId === null) {
    try { powerBlockerId = powerSaveBlocker.start('prevent-app-suspension'); } catch (_) {}
  } else if (!on && powerBlockerId !== null) {
    try { powerSaveBlocker.stop(powerBlockerId); } catch (_) {}
    powerBlockerId = null;
  }
}

ipcMain.handle('osc-send', (_e, payload) => {
  const addr = String(payload.address);
  const args = payload.args || [];
  try {
    const t = ensureOscTargets();
    if (Array.isArray(payload.targetIds)) {
      const n = t.send(addr, args, payload.targetIds);
      stats.tx += n;
      return n;
    }
    if (t.targets.some((x) => x.enabled)) {
      // Đa địa chỉ: gửi song song tất cả target đang bật
      const n = t.send(addr, args);
      stats.tx += Math.max(1, n);
      return n;
    }
    // Chưa cấu hình target nào → dùng host/port cũ (tương thích)
    const host = payload.host || target.host;
    const port = Number(payload.port) || target.port;
    const buf = encodeOsc(addr, args);
    senderPort().send(buf, port, host, (err) => {
      if (err) console.error('[osc-send] lỗi gửi:', err.message);
    });
    stats.tx++;
    return 1;
  } catch (err) {
    throw new Error(String(err.message || err));
  }
});

/* ===== IPC: địa chỉ OSC ===== */
ipcMain.handle('osc-targets-get', () => ensureOscTargets().list());
ipcMain.handle('osc-targets-set', (_e, arr) => ensureOscTargets().setTargets(arr));
ipcMain.handle('osc-targets-find', async (_e, id) => {
  ensureOscTargets();
  return oscTargets.find(id, () => rxCounter);
});
ipcMain.handle('osc-targets-verify', async (_e, id) => {
  ensureOscTargets();
  return oscTargets.verify(id, () => rxCounter);
});
ipcMain.handle('osc-targets-reset-count', () => ensureOscTargets().resetCounters());

/* ===== IPC: LAN sync ===== */
ipcMain.handle('lan-start', () => { ensureLanSync().start(); return lanSync.status(); });
ipcMain.handle('lan-stop', () => { if (lanSync) lanSync.stop(); return { running: false }; });
ipcMain.handle('lan-status', () => ensureLanSync().status());
ipcMain.handle('lan-config', (_e, cfg) => { ensureLanSync().setConfig(cfg || {}); return lanSync.status(); });
ipcMain.on('lan-project', (_e, json) => {
  if (!lanSync) return;
  lanSync.broadcastProject(json);
});
ipcMain.on('lan-control', (_e, cmd) => {
  if (!lanSync) return;
  lanSync.broadcastControl(cmd);
});

ipcMain.handle('osc-enable', () => {
  openPort();
  return true;
});

ipcMain.handle('osc-float-addresses', (event, addresses) => {
  if (!win || event.sender !== win.webContents) return false;
  oscFloatAddresses = new Set(Array.isArray(addresses) ? addresses : []);
  sendOscFilterToProc();
  return true;
});

ipcMain.handle('osc-disable', () => {
  closePort();   // đóng socket, nhả cổng, dừng timer, báo trạng thái
  return true;
});

ipcMain.handle('port-set', (_e, p) => {
  listenPort = Number(p) || 7000;
  // CHỈ rebind khi đang nghe — OSC TẮT thì chỉ lưu cổng, KHÔNG tự mở (cả khi nạp project)
  if (oscProc && oscProcReady) sendOscSettingsToProc();
  return listenPort;
});

/* Renderer báo trạng thái REC / learn / debug → utility quyết định có parse hay bỏ sớm */
ipcMain.on('osc-mode', (_e, m) => {
  if (!m || !m.type) return;
  if (['recording', 'learn', 'debug'].includes(m.type)) oscModeState.set(m.type, { ...m });
  if (oscProc && oscProcReady) {
    try { oscProc.postMessage(m); } catch (_) {}
  }
});

/* Ẩn/hiện UI Monitor → cho utility biết có cần gom lô UI hay không */
ipcMain.on('osc-ui', (_e, m) => {
  if (!m || !m.type) return;
  if (['uiVisible', 'captureSeen'].includes(m.type)) oscModeState.set(m.type, { ...m });
  if (oscProc && oscProcReady) {
    try { oscProc.postMessage(m); } catch (_) {}
  }
});

/* Chuyển tiếp kết quả ghép MIDI↔OSC từ utility (dùng port riêng trong renderer) */

ipcMain.handle('project-save', async (_e, data) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: 'hs-timecode-project.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2));
  return r.filePath;
});

ipcMain.handle('project-save-to', (_e, filePath, data) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
});

ipcMain.handle('project-open', async () => {
  const r = await dialog.showOpenDialog(win, {
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths.length) return null;
  return {
    path: r.filePaths[0],
    data: JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'))
  };
});

ipcMain.handle('audio-open', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Chọn file nhạc',
    filters: [{
      name: 'Audio',
      extensions: ['mp3', 'wav', 'aiff', 'aif', 'm4a', 'aac', 'flac', 'ogg']
    }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle('audio-open-multi', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Chọn file nhạc (chọn nhiều file bằng ⌘ hoặc Shift)',
    filters: [{
      name: 'Audio',
      extensions: ['mp3', 'wav', 'aiff', 'aif', 'm4a', 'aac', 'flac', 'ogg']
    }],
    properties: ['openFile', 'multiSelections']
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths;
});

ipcMain.handle('read-file-buf', (_e, filePath) => {
  return fs.readFileSync(filePath);
});

ipcMain.handle('file-stat', (_e, filePath) => {
  try {
    const st = fs.statSync(filePath);
    return { size: st.size };
  } catch (_) {
    return { size: 0 };
  }
});

/* ===== TOOL: CONVERT NHẠC — Batch Audio Converter (FFmpeg) =====
   Module riêng (conversion-manager.js). Chỉ sống khi tool được dùng:
   không có process/worker/scan nào khi tool đóng. */
const { ConversionManager } = require('./conversion-manager');
const convMgr = new ConversionManager((channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
});

ipcMain.handle('conv-bins', async () => convMgr.bins());
ipcMain.handle('conv-probe', async (_e, paths) => convMgr.probe(paths));
ipcMain.handle('conv-scan-folder', async (_e, dir, deep) => convMgr.scanFolder(dir, deep));
ipcMain.handle('conv-start', async (_e, payload) => convMgr.start(payload));
ipcMain.on('conv-pause', () => convMgr.pause());
ipcMain.on('conv-resume', () => convMgr.resume());
ipcMain.on('conv-cancel', () => convMgr.cancel());

ipcMain.handle('conv-pick-files', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Chọn file âm thanh',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'aiff', 'aif', 'ogg', 'oga', 'opus', 'wma'] }]
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('conv-pick-folder-in', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Chọn thư mục chứa nhạc',
    properties: ['openDirectory']
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('conv-pick-folder-out', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Chọn thư mục lưu',
    defaultPath: app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory']
  });
  return res.canceled ? null : res.filePaths[0];
});

/* Thư mục lưu mặc định = Downloads */
ipcMain.handle('conv-default-out', () => app.getPath('downloads'));

ipcMain.handle('conv-open-folder', async (_e, dir) => {
  const { shell } = require('electron');
  if (dir && fs.existsSync(dir)) { shell.openPath(dir); return true; }
  return false;
});

/* ===== Cửa sổ SMALL (Mini) — điều khiển từ xa, KHÔNG phải playback engine thứ hai =====
   • Mini chỉ GỬI lệnh (play/stop/trigger cue…) và NHẬN trạng thái — engine duy nhất nằm ở cửa sổ chính.
   • Always on Top dùng API native win.setAlwaysOnTop (macOS level 'screen-saver') — không phải CSS. */
function createMiniWindow() {
  if (miniWin && !miniWin.isDestroyed()) {
    miniWin.show();
    miniWin.focus();
    return;
  }
  // Kích thước CỐ ĐỊNH mặc định 454×468 px — mở lần nào cũng đúng kích thước này
  miniWin = new BrowserWindow({
    width: 454,
    height: 468,
    minWidth: 340,
    minHeight: 280,
    backgroundColor: '#0d0d0f',
    title: 'HS TIMECODE · Mini',
    icon: path.join(__dirname, 'build', 'icon.png'),
    alwaysOnTop: miniSettings.alwaysOnTop !== false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Small luôn cập nhật realtime kể cả khi bị che / app chính minimize, hide
      backgroundThrottling: false
    }
  });
  miniWin.setAlwaysOnTop(miniSettings.alwaysOnTop !== false, 'screen-saver');
  miniWin.loadFile(path.join(__dirname, 'renderer', 'mini.html'));
  // Mini mở lúc nào cũng nhận đúng trạng thái OSC hiện tại (TẮT thì báo TẮT, không tự bật)
  miniWin.webContents.on('did-finish-load', () => {
    sendStatus(null);
    if (miniWin && !miniWin.isDestroyed()) miniWin.webContents.send('stats', { ...stats });
  });
  miniWin.once('ready-to-show', () => {
    if (!miniWin) return;
    miniWin.webContents.send('mini-settings', { alwaysOnTop: miniSettings.alwaysOnTop !== false });
    miniWin.show();
  });
  const notifyClosed = () => {
    if (win && !win.isDestroyed()) win.webContents.send('mini-state', { open: false });
  };
  miniWin.on('closed', () => {
    miniWin = null;
    notifyClosed();
  });
  if (win && !win.isDestroyed()) win.webContents.send('mini-state', { open: true });
}

ipcMain.on('mini-open', () => createMiniWindow());
ipcMain.on('mini-set-top', (_e, on) => {
  miniSettings.alwaysOnTop = !!on;
  saveMiniSettings();
  if (miniWin && !miniWin.isDestroyed()) miniWin.setAlwaysOnTop(!!on, 'screen-saver');
  if (miniWin && !miniWin.isDestroyed()) miniWin.webContents.send('mini-settings', { alwaysOnTop: miniSettings.alwaysOnTop !== false });
});
ipcMain.on('mini-focus-main', () => {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
});
// lệnh điều khiển từ Mini → engine ở cửa sổ chính
ipcMain.on('mini-cmd', (_e, cmd) => {
  if (win && !win.isDestroyed()) win.webContents.send('mini-cmd', cmd || {});
});
// trạng thái UI broadcast từ cửa sổ chính → Mini
ipcMain.on('ui-state', (_e, st) => {
  if (miniWin && !miniWin.isDestroyed()) miniWin.webContents.send('ui-state', st);
  // giữ renderer thức suốt lúc phát show (macOS App Nap có thể treo timer khi ẩn app)
  keepAwake(!!(st && st.playing));
});

app.whenReady().then(() => {
  createWindow();
  // KHÔNG mở cổng OSC khi mở app: Main OSC mặc định TẮT — không listener, không polling,
  // không timer nền. Chỉ mở khi người dùng bấm "Bật OSC" hoặc dùng chức năng cần nhận OSC.
  win.webContents.on('did-finish-load', () => sendStatus(null));
});

app.on('window-all-closed', () => {
  closePort();
  app.quit();
});
