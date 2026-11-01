const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const osc = require('osc');

let win = null;
let udp = null;
let listenPort = Number(process.env.HS_LISTEN) || 7000;
let target = { host: '127.0.0.1', port: 7001 };
const stats = { rx: 0, tx: 0 };

function sendStatus(listening, error) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('osc-status', {
      listening,
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
}

function openPort() {
  closePort();
  udp = new osc.UDPPort({
    localAddress: '0.0.0.0',
    localPort: listenPort
  });
  udp.on('ready', () => sendStatus(true));
  udp.on('error', (err) => {
    let msg = String(err.message || err);
    if (/EADDRINUSE/.test(msg)) {
      msg = `Cổng ${listenPort} bận — có thể 404TimeCode hoặc app khác đang chiếm. Đổi cổng nghe hoặc tắt app đó.`;
    }
    console.error('[osc] lỗi:', msg);
    sendStatus(false, msg);
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
  });
  udp.open();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#0d0d0f',
    title: 'HS TIMECODE',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('osc-send', (_e, payload) => {
  if (!udp) throw new Error('Cổng OSC chưa mở');
  try {
    udp.send(
      { address: String(payload.address), args: payload.args || [] },
      payload.host || target.host,
      payload.port || target.port
    );
    stats.tx++;
    return true;
  } catch (err) {
    throw new Error(String(err.message || err));
  }
});

ipcMain.handle('port-set', (_e, p) => {
  listenPort = Number(p) || 7000;
  openPort();
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

app.whenReady().then(() => {
  createWindow();
  openPort();
  setInterval(() => {
    if (win && !win.isDestroyed()) win.webContents.send('stats', { ...stats });
    console.log(`[stats] rx=${stats.rx} tx=${stats.tx} listen=${listenPort}`);
  }, 3000);
});

app.on('window-all-closed', () => {
  closePort();
  app.quit();
});
