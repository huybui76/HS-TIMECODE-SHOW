const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('hs', {
  onOsc: (cb) => ipcRenderer.on('osc-in', (_e, msg) => cb(msg)),
  onStatus: (cb) => ipcRenderer.on('osc-status', (_e, s) => cb(s)),
  onStats: (cb) => ipcRenderer.on('stats', (_e, s) => cb(s)),
  send: (address, args, host, port) =>
    ipcRenderer.invoke('osc-send', { address, args, host, port }),
  setListenPort: (p) => ipcRenderer.invoke('port-set', p),
  oscEnable: () => ipcRenderer.invoke('osc-enable'),     // người dùng BẬT Main OSC → mới bind cổng
  oscDisable: () => ipcRenderer.invoke('osc-disable'),   // người dùng TẮT → đóng socket, nhả cổng
  saveProject: (data) => ipcRenderer.invoke('project-save', data),
  saveProjectTo: (filePath, data) => ipcRenderer.invoke('project-save-to', filePath, data),
  openProject: () => ipcRenderer.invoke('project-open'),
  openAudio: () => ipcRenderer.invoke('audio-open'),
  openAudioMulti: () => ipcRenderer.invoke('audio-open-multi'),
  readFileBuf: (p) => ipcRenderer.invoke('read-file-buf', p),
  fileStat: (p) => ipcRenderer.invoke('file-stat', p),
  filePath: (f) => {
    try {
      return webUtils && webUtils.getPathForFile
        ? webUtils.getPathForFile(f)
        : f.path;
    } catch (_) {
      return f.path || '';
    }
  },

  /* ===== Bridge cửa sổ SMALL (Mini) — 1 playback engine duy nhất ở cửa sổ chính ===== */
  openMini: () => ipcRenderer.send('mini-open'),
  miniCmd: (cmd) => ipcRenderer.send('mini-cmd', cmd),           // Mini → engine chính
  onMiniCmd: (cb) => ipcRenderer.on('mini-cmd', (_e, cmd) => cb(cmd)),
  sendUiState: (st) => ipcRenderer.send('ui-state', st),         // engine chính → Mini
  onUiState: (cb) => ipcRenderer.on('ui-state', (_e, st) => cb(st)),
  setMiniTop: (on) => ipcRenderer.send('mini-set-top', on),      // Always on Top (native API)
  onMiniSettings: (cb) => ipcRenderer.on('mini-settings', (_e, s) => cb(s)),
  onMiniState: (cb) => ipcRenderer.on('mini-state', (_e, s) => cb(s)),
  miniFocusMain: () => ipcRenderer.send('mini-focus-main'),

  /* ===== TOOL: CONVERT NHẠC ===== */
  convBins: () => ipcRenderer.invoke('conv-bins'),
  convProbe: (paths) => ipcRenderer.invoke('conv-probe', paths),
  convScanFolder: (dir, deep) => ipcRenderer.invoke('conv-scan-folder', dir, deep),
  convStart: (payload) => ipcRenderer.invoke('conv-start', payload),
  convPause: () => ipcRenderer.send('conv-pause'),
  convResume: () => ipcRenderer.send('conv-resume'),
  convCancel: () => ipcRenderer.send('conv-cancel'),
  convPickFiles: () => ipcRenderer.invoke('conv-pick-files'),
  convPickFolderIn: () => ipcRenderer.invoke('conv-pick-folder-in'),
  convPickFolderOut: () => ipcRenderer.invoke('conv-pick-folder-out'),
  convDefaultOut: () => ipcRenderer.invoke('conv-default-out'),
  convOpenFolder: (dir) => ipcRenderer.invoke('conv-open-folder', dir),
  onConvItem: (cb) => ipcRenderer.on('conv-item', (_e, p) => cb(p)),
  onConvState: (cb) => ipcRenderer.on('conv-state', (_e, p) => cb(p)),
  onConvDone: (cb) => ipcRenderer.on('conv-done', (_e, p) => cb(p))
});
