const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const dgram = require('dgram');
const osc = require('osc');

let win = null;
let miniWin = null;
let udp = null;          // OSC listener hệ thống chính — CHỈ tồn tại khi người dùng BẬT OSC
let sendSock = null;     // socket GỬI-RIÊNG (không nghe) dùng khi listener đang TẮT
let listenPort = Number(process.env.HS_LISTEN) || 7000;
let target = { host: '127.0.0.1', port: 7001 };
const stats = { rx: 0, tx: 0 };
let statsTimer = null;   // bơm số RX/TX — chỉ chạy khi listener ĐANG bật

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
  if (udp) {
    try { udp.close(); } catch (_) { /* port đã đóng */ }
    udp = null;
  }
  if (sendSock) {
    try { sendSock.close(); } catch (_) { /* đã đóng */ }
    sendSock = null;
  }
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  oscListening = false;
  sendStatus(null);
}

function openPort() {
  closePort();
  udp = new osc.UDPPort({
    localAddress: '0.0.0.0',
    localPort: listenPort
  });
  udp.on('ready', () => {
    oscListening = true;
    sendStatus(null);
    // Bơm số liệu RX/TX CHỈ khi đang nghe — OSC TẮT thì không có timer nền nào chạy
    if (!statsTimer) {
      statsTimer = setInterval(() => {
        if (win && !win.isDestroyed()) win.webContents.send('stats', { ...stats });
        if (miniWin && !miniWin.isDestroyed()) miniWin.webContents.send('stats', { ...stats });
      }, 3000);
    }
  });
  udp.on('error', (err) => {
    let msg = String(err.message || err);
    if (/EADDRINUSE/.test(msg)) {
      msg = `Cổng ${listenPort} bận — có thể 404TimeCode hoặc app khác đang chiếm. Đổi cổng nghe hoặc tắt app đó.`;
    }
    console.error('[osc] lỗi:', msg);
    oscListening = false;
    sendStatus(msg);
  });
  udp.on('message', (msg) => {
    stats.rx++;
    if (win && !win.isDestroyed()) {
      win.webContents.send('osc-in', {
        address: msg.address,
        args: msg.args || [],
        t: Date.now()
      });
    }
    if (miniWin && !miniWin.isDestroyed()) {
      miniWin.webContents.send('osc-in', {
        address: msg.address,
        args: msg.args || [],
        t: Date.now()
      });
    }
  });
  udp.open();
}

/* Socket GỬI-RIÊNG: khi Main OSC đang TẮT mà app vẫn cần bắn cue (show control),
   gửi qua socket nguồn với port tạm do OS cấp — KHÔNG chiếm cổng nghe (app khác vẫn
   dùng được :7000), KHÔNG nghe gói nào, KHÔNG timer. Tạo lười khi cần gửi đầu tiên. */
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
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('osc-send', (_e, payload) => {
  const addr = String(payload.address);
  const args = payload.args || [];
  const host = payload.host || target.host;
  const port = Number(payload.port) || target.port;
  try {
    if (udp) {
      // Đang nghe → gửi từ listener như cũ
      udp.send({ address: addr, args }, host, port);
    } else {
      // Đang TẮT → gửi qua socket riêng, KHÔNG tự bật nghe (đóng gói OSC y hệt UDPPort.send)
      const buf = Buffer.from(osc.writePacket({ address: addr, args }));
      senderPort().send(buf, port, host, (err) => {
        if (err) console.error('[osc-send] lỗi gửi:', err.message);
      });
    }
    stats.tx++;
    return true;
  } catch (err) {
    throw new Error(String(err.message || err));
  }
});

ipcMain.handle('osc-enable', () => {
  openPort();
  return true;
});

ipcMain.handle('osc-disable', () => {
  closePort();   // đóng socket, nhả cổng, dừng timer, báo trạng thái
  return true;
});

ipcMain.handle('port-set', (_e, p) => {
  listenPort = Number(p) || 7000;
  // CHỈ rebind khi đang nghe — OSC TẮT thì chỉ lưu cổng, KHÔNG tự mở (cả khi nạp project)
  if (udp) openPort();
  return listenPort;
});

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
      nodeIntegration: false
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
