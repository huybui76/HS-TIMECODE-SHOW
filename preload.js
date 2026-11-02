const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('hs', {
  onOsc: (cb) => ipcRenderer.on('osc-in', (_e, msg) => cb(msg)),
  onStatus: (cb) => ipcRenderer.on('osc-status', (_e, s) => cb(s)),
  onStats: (cb) => ipcRenderer.on('stats', (_e, s) => cb(s)),
  send: (address, args, host, port) =>
    ipcRenderer.invoke('osc-send', { address, args, host, port }),
  setListenPort: (p) => ipcRenderer.invoke('port-set', p),
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
  }
});
