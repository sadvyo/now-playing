const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (cb) => {
  const fn = (_e, data) => cb(data);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('np', {
  ready: () => ipcRenderer.invoke('app:ready'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  hide: () => ipcRenderer.invoke('window:hide'),
  pin: (v) => ipcRenderer.invoke('window:pin', v),
  quit: () => ipcRenderer.invoke('app:quit'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  openPath: (p) => ipcRenderer.invoke('open:path', p),
  spotifyConnect: () => ipcRenderer.invoke('spotify:connect'),
  spotifyDisconnect: () => ipcRenderer.invoke('spotify:disconnect'),
  spotifyLike: () => ipcRenderer.invoke('spotify:like'),
  control: (action, positionMs) => ipcRenderer.invoke('media:control', { action, positionMs }),
  dismissChat: (id) => ipcRenderer.invoke('chats:dismiss', id),
  clearChats: () => ipcRenderer.invoke('chats:clear'),
  installBridge: () => ipcRenderer.invoke('bridge:install'),
  testAlert: () => ipcRenderer.invoke('bridge:test'),
  desktopStatus: () => ipcRenderer.invoke('desktop:status'),
  desktopConnect: () => ipcRenderer.invoke('desktop:connect'),
  desktopTest: () => ipcRenderer.invoke('desktop:test'),
  onDesktop: on('desktop'),
  onChats: on('chats'),
  onAlert: on('claude:alert'),
  onGoto: on('ui:goto'),
  openLog: () => ipcRenderer.invoke('open:log'),
  updateState: () => ipcRenderer.invoke('update:state'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateApply: () => ipcRenderer.invoke('update:apply'),
  onUpdate: on('update'),
  onMedia: on('media'),
  onArt: on('art'),
  onLyrics: on('lyrics'),
  onClaude: on('claude'),
  onSettings: on('settings'),
  onSpotifyStatus: on('spotify:status'),
  onOpenSettings: on('ui:open-settings'),
});
