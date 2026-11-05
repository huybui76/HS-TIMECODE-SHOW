const { contextBridge, ipcRenderer, webUtils } = require('electron');
let oscPort = null;

contextBridge.exposeInMainWorld('hs', {
  /* OSC IN: MessagePort trực tiếp từ utility process (KHÔNG qua ipcMain cho dữ liệu).
     contextBridge không truyền được object MessagePort → bọc thành API tối thiểu. */
  onOscPort: (cb) => {
    ipcRenderer.on('osc-port', (event) => {
      const [port] = event.ports || [];
      if (!port) return;
      if (oscPort) { try { oscPort.close(); } catch (_) {} }
      oscPort = port;
      port.start();
      port.onmessage = null;
      cb && cb({
        onMessage: (fn) => { port.onmessage = (ev) => fn(ev.data); },
        post: (msg, transfer) => { try { port.postMessage(msg, transfer || []); } catch (_) {} },
        close: () => { try { port.close(); } catch (_) {} }
      });
    });
  },
  /* Trạng thái/metrics + lỗi từ utility process */
  onOscProc: (cb) => ipcRenderer.on('osc-proc', (_e, m) => cb(m)),
  /* ===== NHIỀU ĐỊA CHỈ OSC + XÁC THỰC 2 CHIỀU ===== */
  oscTargetsGet: () => ipcRenderer.invoke('osc-targets-get'),
  oscTargetsSet: (arr) => ipcRenderer.invoke('osc-targets-set', arr),
  oscTargetsFind: (id) => ipcRenderer.invoke('osc-targets-find', id),
  oscTargetsVerify: (id) => ipcRenderer.invoke('osc-targets-verify', id),
  oscTargetsResetCount: () => ipcRenderer.invoke('osc-targets-reset-count'),
  onOscTargets: (cb) => ipcRenderer.on('osc-targets', (_e, list) => cb(list)),
  /* ===== LAN SYNC (show + control nhiều máy) ===== */
  lanStart: () => ipcRenderer.invoke('lan-start'),
  lanStop: () => ipcRenderer.invoke('lan-stop'),
  lanStatus: () => ipcRenderer.invoke('lan-status'),
  lanConfig: (cfg) => ipcRenderer.invoke('lan-config', cfg),
  lanSendProject: (json) => ipcRenderer.send('lan-project', json),
  lanSendControl: (cmd) => ipcRenderer.send('lan-control', cmd),
  onLanPeers: (cb) => ipcRenderer.on('lan-peers', (_e, peers) => cb(peers)),
  onLanProject: (cb) => ipcRenderer.on('lan-project', (_e, json) => cb(json)),
  onLanControl: (cb) => ipcRenderer.on('lan-control', (_e, cmd) => cb(cmd)),
  /* Gửi mode (REC/learn/debug) + UI visible sang utility */
  oscMode: (m) => ipcRenderer.send('osc-mode', m),
  oscUi: (m) => ipcRenderer.send('osc-ui', m),
  /* Gửi sự kiện MIDI sang utility để đối chiếu (trả kết quả qua port) */
  onOsc: (cb) => ipcRenderer.on('osc-in', (_e, msg) => cb(msg)),
  onOscBatch: (cb) => ipcRenderer.on('osc-in-batch', (_e, batch) => cb(batch)),
  onStatus: (cb) => ipcRenderer.on('osc-status', (_e, s) => cb(s)),
  onStats: (cb) => ipcRenderer.on('stats', (_e, s) => cb(s)),
  send: (address, args, host, port, targetIds) =>
    ipcRenderer.invoke('osc-send', { address, args, host, port, targetIds }),
  setListenPort: (p) => ipcRenderer.invoke('port-set', p),
  setOscFloatAddresses: (addresses) => ipcRenderer.invoke('osc-float-addresses', addresses),
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
