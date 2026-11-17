// Tiny JSON settings store kept in the app's userData folder.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULTS = {
  spotifyClientId: '',
  spotifyPort: 8888,
  spotifyRefresh: null,       // encrypted (base64) when safeStorage is available
  spotifyRefreshPlain: false, // true if stored unencrypted
  spotifyScopes: null,        // permissions granted on the last token
  source: 'auto',             // 'auto' | 'spotify' | 'system'
  preferredApp: null,         // pin one Windows media session (AUMID)
  lyricsForAll: false,        // try lyrics for non-Spotify players too
  pinned: false,              // keep window open when it loses focus
  hotkey: 'CommandOrControl+Shift+Space',
  launchAtStartup: false,
  claudeDir: '',              // override for ~/.claude
  claudeLookbackHours: 12,
  tab: 'playing',
  notifyQuestions: true,      // Windows notification when Claude asks something
  popupOnQuestion: true,      // also pop the window open
  notifyDone: true,           // quiet notification when a task finishes
  bridgePort: 47823,
  large: false,               // bigger window
  mode: 'full',               // 'full' | 'mini' (compact player bar)
  freeMemory: true,           // close the hidden window after a few minutes
  mediaHotkeys: {},           // { playPause, next, previous, volUp, volDown, clickThrough } accelerators
  miniOpacity: 1,             // mini player transparency (0.3 – 1)
  clickThrough: false,        // mini player lets clicks pass through to what's under it
  lyricsOffsets: {},          // song key -> ms to shift synced lyrics (positive = later)
  // Appearance
  theme: 'dark',              // 'dark' | 'light' | 'system'
  accentMode: 'cover',        // 'cover' (from the album art) | 'fixed'
  accentColor: '#1ed760',
  background: 'cover',        // 'cover' blur | 'plain' | 'glass'
  corners: 'round',           // 'round' | 'soft' | 'square'
  uiScale: 1,                 // 0.9 | 1 | 1.15 | 1.3
  layout: 'lyrics',           // Playing tab: 'lyrics' | 'cover' (big artwork)
  lyricsSize: 'm',            // 's' | 'm' | 'l'
  showUpNext: true,
  showSources: true,
  miniLyrics: true,
  outline: false,
  autoDownload: true,         // download updates in the background
  updateRepo: '',             // override GitHub repo for updates (owner/name)
  miniPos: null,
};

let file;
let data = { ...DEFAULTS };

function load() {
  file = path.join(app.getPath('userData'), 'settings.json');
  try {
    data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    data = { ...DEFAULTS };
  }
  return data;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('settings save failed', e);
  }
}

function get(key) { return key ? data[key] : { ...data }; }

function set(patch) {
  data = { ...data, ...patch };
  save();
  return data;
}

function setSecret(key, value) {
  if (value == null) { set({ [key]: null }); return; }
  if (safeStorage.isEncryptionAvailable()) {
    set({ [key]: safeStorage.encryptString(value).toString('base64'), [key + 'Plain']: false });
  } else {
    set({ [key]: value, [key + 'Plain']: true });
  }
}

function getSecret(key) {
  const v = data[key];
  if (!v) return null;
  if (data[key + 'Plain']) return v;
  try { return safeStorage.decryptString(Buffer.from(v, 'base64')); } catch { return null; }
}

// What the renderer is allowed to see (no tokens).
function publicSettings() {
  const { spotifyRefresh, spotifyRefreshPlain, ...rest } = data;
  return rest;
}

module.exports = { load, get, set, setSecret, getSecret, publicSettings, DEFAULTS };
