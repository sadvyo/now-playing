// Preload for the desktop lyrics window: only what that page needs.
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (cb) => { ipcRenderer.on(ch, (_e, data) => cb(data)); };

contextBridge.exposeInMainWorld('ov', {
  onLyrics: on('ov:lyrics'),
  onPlay: on('ov:play'),
  onLook: on('ov:look'),
  ready: () => ipcRenderer.send('ov:ready'),
  dragStart: () => ipcRenderer.send('ov:dragStart'),
  drag: () => ipcRenderer.send('ov:drag'),
  dragEnd: () => ipcRenderer.send('ov:dragEnd'),
  done: () => ipcRenderer.send('ov:done'),
  size: (dir) => ipcRenderer.send('ov:size', dir),
});
