const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  loadSaved: () => ipcRenderer.invoke('load-saved'),
  getCover: file => ipcRenderer.invoke('get-cover', file),
  pickImage: () => ipcRenderer.invoke('pick-image'),
  switchMode: mode => ipcRenderer.invoke('switch-mode', mode),
  artistInfo: name => ipcRenderer.invoke('artist-info', name),
  openLink: url => ipcRenderer.invoke('open-link', url),
  setChrome: color => ipcRenderer.send('set-chrome', color),
  // miniplayer: the player window uses these ...
  miniOpen: state => ipcRenderer.invoke('mini-open', state),
  miniState: st => ipcRenderer.send('mini-state', st),
  onMiniCmd: cb => ipcRenderer.on('mini-cmd', (e, cmd, arg) => cb(cmd, arg)),
  onMiniClosed: cb => ipcRenderer.on('mini-closed', () => cb()),
  // ... and the miniplayer window uses these
  miniReady: () => ipcRenderer.send('mini-ready'),
  onMiniState: cb => ipcRenderer.on('mini-state', (e, st) => cb(st)),
  miniCmd: (cmd, arg) => ipcRenderer.send('mini-cmd', cmd, arg),
  miniExpand: () => ipcRenderer.send('mini-expand'),
  miniLayout: layout => ipcRenderer.invoke('mini-layout', layout),
  miniDragStart: () => ipcRenderer.send('mini-drag-start'),
  miniDrag: (dx, dy) => ipcRenderer.send('mini-drag', dx, dy),
  miniDragEnd: () => ipcRenderer.send('mini-drag-end')
});
