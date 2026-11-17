const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, screen, shell, nativeImage, Notification } = require('electron');
const path = require('path');
const store = require('./store');
const { SMTC } = require('./media/smtc');
const { Spotify } = require('./media/spotify');
const { fetchLyrics } = require('./media/lyrics');
const { ClaudeSessions } = require('./claude/sessions');
const { ClaudeChats } = require('./claude/chats');
const { ClaudeDesktop } = require('./claude/desktop');
const { findArtwork } = require('./media/artwork');
const { Updater } = require('./updater');
const { accentFor, cachedAccent } = require('./media/accent');
const PKG = require('../package.json');
const fs = require('fs');

const MOCK = process.env.NP_MOCK === '1';
const SIZES = { compact: [380, 600], large: [540, 820], mini: [400, 112] };
const isMini = () => store.get('mode') === 'mini';
let W = 380, H = 600;

let win = null;
let tray = null;
let smtc, spotify, claude;
let lastTrackKey = null;
let lyricsState = { key: null, status: 'idle', synced: [], plain: '' };
let nowPlaying = null;
let lastMediaSig = null;
let lastArtSent;
let lastTip = '';
let sessionsList = [];
let lastBlurHide = 0;
let chats = null;
let updater = null;
let desktop = null;
let chatState = { tasks: [] };
const notified = new Map(); // id -> signature of the last alert we showed
const artFound = new Map(); // trackKey -> url | null

// Small rolling log: %APPDATA%\Now Playing\debug.log
let logFile = null;
function log(msg) {
  try {
    if (!logFile) logFile = path.join(app.getPath('userData'), 'debug.log');
    try { if (fs.statSync(logFile).size > 512 * 1024) fs.renameSync(logFile, logFile + '.old'); } catch {}
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}
process.on('uncaughtException', (e) => log('uncaught: ' + (e.stack || e)));
process.on('unhandledRejection', (e) => log('unhandled: ' + (e?.stack || e)));

if (!MOCK && !app.requestSingleInstanceLock()) { app.exit(0); }
// A small widget doesn't need a GPU process (saves ~100 MB and a process).
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=64 --optimize-for-size');
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess,MediaRouter,Translate,HardwareMediaKeyHandling,AutofillServerCommunication,OptimizationHints,InterestFeedContentSuggestions');
app.commandLine.appendSwitch('disable-background-networking');
app.setAppUserModelId('com.sadvyo.nowplaying');

const ICON = path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const TRAY_ICON = path.join(__dirname, '..', 'assets', 'tray.png');

const LIVE = new Set(['media', 'lyrics', 'claude', 'chats', 'art']);
let dirty = false;
function send(ch, data) {
  if (!win || win.isDestroyed()) return;
  // Nobody can see a hidden window: skip the work and catch up when it's shown.
  if (LIVE.has(ch) && !win.isVisible() && !MOCK) { dirty = true; return; }
  win.webContents.send(ch, data);
}

// ---------- window ----------
function applySize() {
  const [w, h] = SIZES[isMini() ? 'mini' : store.get('large') ? 'large' : 'compact'];
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  W = Math.min(w, wa.width - 24); H = Math.min(h, wa.height - 24);
  if (win) {
    // Windows ignores setSize() on fixed-size transparent windows, so lift the
    // size limits, set the bounds, then pin the limits to the new size.
    win.setMinimumSize(1, 1);
    win.setMaximumSize(10000, 10000);
    const [x, y] = win.getPosition();
    win.setBounds({ x, y, width: W, height: H });
    win.setMinimumSize(W, H);
    win.setMaximumSize(W, H);
    win.webContents.send('ui:resized', { width: W, height: H });
  }
}

function positionWindow() {
  // Mini player remembers where you dragged it.
  const mp = store.get('miniPos');
  if (isMini() && mp) {
    const d = screen.getDisplayMatching({ x: mp.x, y: mp.y, width: W, height: H });
    const wa = d.workArea;
    const x = Math.min(Math.max(mp.x, wa.x), wa.x + wa.width - W);
    const y = Math.min(Math.max(mp.y, wa.y), wa.y + wa.height - H);
    win.setPosition(Math.round(x), Math.round(y), false);
    return;
  }
  const pt = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(pt);
  const wa = d.workArea;
  const margin = 12;
  let x = wa.x + wa.width - W - margin;
  let y = wa.y + wa.height - H - margin;
  // taskbar on top / left
  if (wa.y > d.bounds.y) y = wa.y + margin;
  if (wa.x > d.bounds.x) x = wa.x + margin;
  win.setPosition(Math.round(x), Math.round(y), false);
}

function createWindow() {
  win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    minWidth: W, maxWidth: W, minHeight: H, maxHeight: H,
    thickFrame: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    icon: ICON,
    title: 'Now Playing',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('blur', () => {
    if (store.get('pinned') || isMini() || MOCK) return; // the mini player always stays
    // Focus may have moved into the docked claude.ai view, which still counts as us.
    setTimeout(() => {
      if (!win || win.isFocused()) return;
      if (BrowserWindow.getFocusedWindow()) return; // one of our own popups
      lastBlurHide = Date.now();
      win.hide();
    }, 120);
  });
  rendererReady = false;
  win.on('show', () => { clearTimeout(discardTimer); setActive(true); pushAll(); applyMiniLook(); });
  win.once('ready-to-show', () => applyMiniLook());
  let moveTimer = null;
  win.on('moved', () => {
    if (!isMini()) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => { if (!win || win.isDestroyed()) return; const [x, y] = win.getPosition(); store.set({ miniPos: { x, y } }); }, 300);
  });
  win.on('hide', () => { setActive(false); scheduleDiscard(); });
  win.on('closed', () => { win = null; rendererReady = false; });

  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// ---------- free memory while hidden ----------
// After a few minutes out of sight the window (and its renderer process) is closed;
// it's rebuilt the next time you open the pop-up. The mini player always stays.
const DISCARD_AFTER = 3 * 60 * 1000;
let discardTimer = null;
let pendingGoto = null;
function scheduleDiscard() {
  clearTimeout(discardTimer);
  if (MOCK || store.get('freeMemory') === false) return;
  discardTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || win.isVisible() || isMini()) return;
    log('window discarded to free memory');
    win.destroy();
    win = null;
  }, DISCARD_AFTER);
}
// Deliver a UI message now if the page is ready, otherwise as soon as it says it is.
function sendWhenReady(ch, data) {
  if (win && !win.isDestroyed() && rendererReady) win.webContents.send(ch, data);
  else pendingGoto = { ch, data };
}
const gotoTab = (tab) => sendWhenReady('ui:goto', { tab });
let rendererReady = false;

function toggleWindow(force) {
  if (!win || win.isDestroyed()) {
    if (force === false) return;
    createWindow();
    win.once('ready-to-show', () => toggleWindow(true));
    return;
  }
  const show = force ?? !win.isVisible();
  if (show) {
    applySize();
    positionWindow();
    win.show();
    win.focus();
  } else {
    win.hide();
  }
}

// ---------- tray ----------
function buildTrayMenu() {
  const s = store.get();
  return Menu.buildFromTemplate([
    { label: 'Show / hide', click: () => toggleWindow() },
    { label: 'Mini player', type: 'checkbox', checked: s.mode === 'mini', click: (i) => setSettings({ mode: i.checked ? 'mini' : 'full' }) },
    ...(s.mode === 'mini' ? [{ label: 'Click-through mini player', type: 'checkbox', checked: !!s.clickThrough, click: (i) => setSettings({ clickThrough: i.checked }) }] : []),
    { type: 'separator' },
    { label: 'Keep on screen (pin)', type: 'checkbox', checked: !!s.pinned, click: (i) => setSettings({ pinned: i.checked }) },
    { label: 'Start with Windows', type: 'checkbox', checked: !!s.launchAtStartup, click: (i) => setSettings({ launchAtStartup: i.checked }) },
    { label: 'Settings…', click: () => { toggleWindow(true); sendWhenReady('ui:open-settings'); } },
    ...(updater?.state.status === 'ready' ? [{ label: `Restart to update (v${updater.state.latest})`, click: () => updater.apply() }] : []),
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}

function createTray() {
  tray = new Tray(trayImage('normal'));
  trayState = 'normal';
  tray.setToolTip('Now Playing');
  // Clicking the tray blurs the window first; don't immediately re-open it.
  tray.on('click', () => { if (Date.now() - lastBlurHide < 300) return; toggleWindow(); });
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
}

// ---------- tray icon status ----------
const trayImgs = new Map();
let trayState = '';
function trayImage(name) {
  if (!trayImgs.has(name)) {
    // createFromPath picks name@1.5x / name@2x automatically on high-DPI screens.
    let img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray', name + '.png'));
    if (img.isEmpty()) img = nativeImage.createFromPath(TRAY_ICON);
    trayImgs.set(name, img);
  }
  return trayImgs.get(name);
}

function claudeSummary() {
  const tasks = chatState.tasks || [];
  const questions = tasks.filter((t) => t.status === 'question').length
    + sessionsList.filter((s) => s.status === 'question' || s.status === 'waiting').length;
  const fracs = [];
  let working = 0;
  for (const t of tasks) if (t.status === 'working') { working++; if (t.total) fracs.push(t.done / t.total); }
  for (const c of sessionsList) if (c.status === 'working') { working++; if (c.progress?.total) fracs.push(c.progress.done / c.progress.total); }
  const frac = fracs.length ? fracs.reduce((a, b) => a + b, 0) / fracs.length : 0;
  return { questions, working, frac };
}

function updateTrayIcon() {
  if (!tray) return;
  const { questions, working, frac } = claudeSummary();
  const name = questions ? 'question' : working ? `ring-${Math.max(0, Math.min(8, Math.round(frac * 8)))}` : 'normal';
  if (name === trayState) return; // only touch the tray when the picture changes
  trayState = name;
  tray.setImage(trayImage(name));
}

function updateTrayTooltip() {
  if (!tray) return;
  updateTrayIcon();
  const working = sessionsList.filter((s) => s.status === 'working').length;
  let tip = nowPlaying ? `${nowPlaying.isPlaying ? '▶' : '❚❚'} ${nowPlaying.title}${nowPlaying.artist ? ' — ' + nowPlaying.artist : ''}` : 'Nothing playing';
  if (working) tip += `\nClaude Code: ${working} working`;
  const chatQ = (chatState.tasks || []).filter((t) => t.status === 'question').length;
  const codeQ = sessionsList.filter((s) => s.status === 'question' || s.status === 'waiting').length;
  if (chatQ + codeQ) tip += `\n❓ Claude needs your answer (${chatQ + codeQ})`;
  tip = tip.slice(0, 127);
  if (tip !== lastTip) { lastTip = tip; tray.setToolTip(tip); }
}

// ---------- settings ----------
function setLoginItem(on) {
  // The portable .exe unpacks to a temp folder each run; register the real .exe instead.
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  app.setLoginItemSettings({ openAtLogin: on, path: exe, args: ['--hidden'] });
}

function applyHotkey(prev) {
  try { if (prev) globalShortcut.unregister(prev); } catch {}
  const hk = store.get('hotkey');
  if (!hk) return true;
  try { return globalShortcut.register(hk, () => toggleWindow()); } catch { return false; }
}

// ---------- global media hotkeys ----------
const MEDIA_HOTKEYS = ['playPause', 'next', 'previous', 'volUp', 'volDown', 'clickThrough'];
let mediaRegistered = [];
let hotkeyStatus = {};
function applyMediaHotkeys() {
  for (const a of mediaRegistered) { try { globalShortcut.unregister(a); } catch {} }
  mediaRegistered = [];
  hotkeyStatus = {};
  const hk = store.get('mediaHotkeys') || {};
  for (const name of MEDIA_HOTKEYS) {
    const accel = hk[name];
    if (!accel) continue;
    let ok = false;
    try { ok = globalShortcut.register(accel, () => onMediaHotkey(name)); } catch { ok = false; }
    hotkeyStatus[name] = ok; // false = another app (or another of our shortcuts) has it
    if (ok) mediaRegistered.push(accel);
  }
}
function onMediaHotkey(name) {
  if (name === 'playPause') mediaControl('toggle');
  else if (name === 'next') mediaControl('next');
  else if (name === 'previous') mediaControl('previous');
  else if (name === 'volUp' || name === 'volDown') {
    const t = nowPlaying;
    if (t && typeof t.volume === 'number') setVolumeLevel(t.volume + (name === 'volUp' ? 5 : -5));
  } else if (name === 'clickThrough') setSettings({ clickThrough: !store.get('clickThrough') });
}

// ---------- mini player look: transparency + click-through ----------
function applyMiniLook() {
  if (!win || win.isDestroyed()) return;
  const mini = isMini();
  // (Transparency is drawn by the page itself: see .shell[data-mode="mini"] in styles.css.)
  const through = mini && !!store.get('clickThrough');
  if (through) win.setIgnoreMouseEvents(true, { forward: true }); // mouse moves still reach us (Ctrl-hover)
  else win.setIgnoreMouseEvents(false);
}

function setSettings(patch) {
  const prevHotkey = store.get('hotkey');
  store.set(patch);
  if ('launchAtStartup' in patch && app.isPackaged) setLoginItem(!!patch.launchAtStartup);
  let hotkeyOk = true;
  if ('hotkey' in patch) hotkeyOk = applyHotkey(prevHotkey);
  if ('mediaHotkeys' in patch || 'hotkey' in patch) applyMediaHotkeys();
  if ('mode' in patch || 'miniOpacity' in patch || 'clickThrough' in patch) applyMiniLook();
  if ('spotifyPort' in patch || 'spotifyClientId' in patch) send('spotify:status', spotify.status());
  if ('claudeDir' in patch || 'claudeLookbackHours' in patch) claude.scan();
  if (('large' in patch || 'mode' in patch) && win) {
    applySize(); positionWindow();
    if ('mode' in patch && !win.isVisible()) toggleWindow(true);
  }
  recompute();
  const out = { ...store.publicSettings(), hotkeyOk, hotkeyStatus };
  send('settings', out);
  return out;
}

// ---------- now playing aggregation ----------
// With a Spotify account connected, the Windows "Spotify" session is the same
// music, so hide it and let the account (art, lyrics, device) represent it.
function systemSessions() {
  const all = smtc?.sessions || [];
  if (spotify?.isConnected() && spotify.playback && !spotify.error) return all.filter((x) => !/spotify/i.test(x.app));
  return all;
}

function pickTrack() {
  const s = store.get();
  const sys = systemSessions();
  const sp = spotify?.playback;
  let pref = s.preferredApp ? sys.find((x) => x.app === s.preferredApp) : null;

  // A source picked by clicking its chip is only a temporary choice: once it stops
  // and something else starts playing, follow the new music again.
  const othersPlaying = sys.some((x) => x.isPlaying && x.app !== s.preferredApp) || !!(sp && sp.isPlaying);
  if (s.preferredApp && (!pref || !pref.isPlaying) && othersPlaying) {
    store.set({ preferredApp: null }); pref = null; s.preferredApp = null;
    send('settings', store.publicSettings());
  }
  if (s.source === 'spotify' && !(sp && sp.isPlaying) && sys.some((x) => x.isPlaying)) {
    store.set({ source: 'auto' }); s.source = 'auto';
    send('settings', store.publicSettings());
  }

  const sysBest = () => {
    if (pref) return pref;
    return sys.find((x) => x.isPlaying && x.isCurrent) || sys.find((x) => x.isPlaying) || sys.find((x) => x.isCurrent) || sys[0] || null;
  };

  if (s.source === 'spotify') return sp || null;
  if (s.source === 'system') return sysBest();
  // auto
  if (pref) return pref;
  const sysPlaying = sys.find((x) => x.isPlaying);
  if (sp && sp.isPlaying) {
    // Prefer the Web API (better art + lyrics) when the desktop app is the thing playing.
    if (!sysPlaying || /spotify/i.test(sysPlaying.app)) return sp;
    // Something else is playing locally while Spotify plays elsewhere — prefer local.
    return sysPlaying;
  }
  return sysPlaying || sp || sysBest();
}

function trackKey(t) {
  return t ? `${t.source}|${t.title}|${t.artist}`.toLowerCase() : null;
}

function wantsLyrics(t) {
  if (!t) return false;
  if (t.source === 'spotify' || /spotify/i.test(t.app || '')) return true;
  return !!store.get('lyricsForAll');
}

async function loadLyrics(t, key) {
  lyricsState = { key, status: 'loading', synced: [], plain: '' };
  send('lyrics', lyricsState);
  try {
    const clean = !(t.source === 'spotify' || /spotify/i.test(t.app || ''));
    const r = await fetchLyrics(t, { clean });
    if (lastTrackKey !== key) return;
    lyricsState = { key, ...r };
  } catch (e) {
    if (lastTrackKey !== key) return;
    lyricsState = { key, status: 'error', synced: [], plain: '', error: e.message };
  }
  send('lyrics', lyricsState);
}

// Fill in a cover from iTunes/Deezer when the player didn't provide a picture.
function withArt(t) {
  if (!t || t.art) return t;
  const k = trackKey(t);
  if (artFound.has(k)) { const u = artFound.get(k); if (u) { t.art = u; t.artFrom = 'lookup'; } return t; }
  artFound.set(k, null);
  findArtwork(t).then((u) => {
    if (!u) return;
    artFound.set(k, u);
    recompute();
  }).catch((e) => log('artwork lookup: ' + e.message));
  return t;
}

// Short cache key for an image (data: URLs can be ~30 KB long).
const artKey = (a) => (a.startsWith('data:') ? `d${a.length}:${a.slice(-48)}` : a);
function withAccent(t) {
  if (!t || !t.art) return t;
  const k = artKey(t.art);
  const c = cachedAccent(k);
  if (c !== undefined) { t.accent = c; return t; }
  accentFor(t.art, k).then(() => recompute()).catch(() => {}); // de-duplicated inside
  return t;
}

function recompute() {
  const t = withAccent(withArt(pickTrack()));
  // If the Web API track and the Windows Spotify session are the same song, enrich
  // with the desktop app's controls (works without Premium) and local position.
  if (t && t.source === 'spotify') {
    const local = (smtc?.sessions || []).find((x) => /spotify/i.test(x.app) && x.title === t.title);
    if (local) t.localApp = local.app;
  }
  if (t) {
    const localApp = t.source === 'system' ? t.app : t.localApp;
    const local = localApp ? (smtc?.sessions || []).find((x) => x.app === localApp) : null;
    if (local && typeof local.volume === 'number') { t.volumeVia = 'local'; t.volumeApp = local.app; t.volume = local.volume; t.muted = local.muted; }
    else if (t.source === 'spotify' && typeof t.volume === 'number') { t.volumeVia = 'spotify'; }
    else { t.volumeVia = null; t.volume = null; }
  }
  nowPlaying = t;
  const key = trackKey(t);
  if (key !== lastTrackKey) {
    lastTrackKey = key;
    if (wantsLyrics(t)) loadLyrics(t, key);
    else { lyricsState = { key, status: t ? 'off' : 'idle', synced: [], plain: '' }; send('lyrics', lyricsState); }
  } else if (t && wantsLyrics(t) && lyricsState.status === 'off') {
    loadLyrics(t, key);
  }
  const art = t?.art || null;
  if (art !== lastArtSent && win?.isVisible()) { lastArtSent = art; send('art', art); }
  const payload = {
    track: t ? { ...t, art: undefined, hasArt: !!art } : null,
    key,
    sources: (spotify?.isConnected() ? (smtc?.sessions || []).filter((x) => !/spotify/i.test(x.app)) : (smtc?.sessions || [])).map(({ art, ...rest }) => rest),
    smtcAvailable: !!smtc?.available,
    smtcError: smtc?.error || null,
    smtcInfo: smtc ? { running: !!smtc.proc, count: smtc.sessions.length, thumbErr: smtc.thumbErr } : null,
    spotify: spotify?.status(),
  };
  // Skip identical updates (most polls change nothing).
  const sig = JSON.stringify(payload, (k, v) => (k === 'sampledAt' ? undefined : v));
  if (sig !== lastMediaSig) { lastMediaSig = sig; send('media', payload); }
  updateTrayTooltip();
}

// Poll fast only while the pop-up is on screen.
function setActive(on) {
  spotify?.setInterval(on ? 2000 : 10000);
  smtc?.setRate(on ? 1000 : 3000);
  claude?.start(on ? 3000 : 15000);
}

function pushAll() {
  dirty = false;
  lastMediaSig = null; lastArtSent = undefined;
  send('settings', store.publicSettings());
  recompute();
  send('lyrics', lyricsState);
  if (claude) send('claude', { sessions: claude.sessions, root: claude.root, found: claude.found });
  if (chats) send('chats', chats.snapshot());
  if (updater) send('update', updater.state);
}


// ---------- Claude alerts ----------
function ensureToastShortcut() {
  // Windows only shows toasts for apps with a Start-menu shortcut carrying our AppUserModelID.
  // The installer creates that shortcut itself; the portable .exe needs us to.
  if (process.platform !== 'win32' || !app.isPackaged || !process.env.PORTABLE_EXECUTABLE_FILE) return;
  try {
    const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Now Playing.lnk');
    const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'update' : 'create', {
      target, appUserModelId: 'com.sadvyo.nowplaying', description: 'Now Playing', icon: target, iconIndex: 0,
    });
  } catch (e) { log('shortcut: ' + e.message); }
}

function alertQuestion({ id, title, body }) {
  const s = store.get();
  log(`alert: ${title} — ${body}`);
  if (s.notifyQuestions !== false && Notification.isSupported()) {
    const n = new Notification({ title, body, icon: ICON, urgency: 'critical', timeoutType: 'default' });
    n.on('click', () => { toggleWindow(true); gotoTab('claude'); });
    n.show();
  }
  if (s.popupOnQuestion !== false && (!win || !win.isVisible())) {
    toggleWindow(true);
    gotoTab('claude');
  }
  send('claude:alert', { id, title, body });
}

// Fire one alert per new question (chat bridge + Claude Code).
function checkAlerts() {
  const seen = new Set();
  for (const t of chatState.tasks || []) {
    if (t.status !== 'question') continue;
    const sig = `${t.question}|${t.questionAt}`;
    seen.add('chat:' + t.id);
    if (notified.get('chat:' + t.id) === sig) continue;
    notified.set('chat:' + t.id, sig);
    alertQuestion({ id: t.id, title: `Claude has a question · ${t.task}`, body: t.question });
  }
  for (const c of sessionsList) {
    if (c.status !== 'question' && c.status !== 'waiting') continue;
    const sig = `${c.status}|${c.activity}`;
    seen.add('code:' + c.id);
    if (notified.get('code:' + c.id) === sig) continue;
    notified.set('code:' + c.id, sig);
    alertQuestion({
      id: c.id,
      title: c.status === 'waiting' ? `Claude Code needs approval · ${c.project}` : `Claude Code has a question · ${c.project}`,
      body: c.activity || c.title,
    });
  }
  for (const k of [...notified.keys()]) if (!seen.has(k)) notified.delete(k);
}

function alertDone({ title, body }) {
  if (store.get('notifyDone') === false || !Notification.isSupported()) return;
  log(`done: ${title}`);
  const n = new Notification({ title, body: body || 'Task finished.', icon: ICON, silent: true, urgency: 'low' });
  n.on('click', () => { toggleWindow(true); gotoTab('claude'); });
  n.show();
}

// Claude Code: notice working -> done transitions (never on the first scan).
const codePrev = new Map();
function checkCodeDone(list) {
  const seen = new Set();
  for (const c of list) {
    seen.add(c.id);
    const prev = codePrev.get(c.id);
    if (prev && (prev === 'working' || prev === 'waiting') && c.status === 'done') {
      alertDone({ title: `Claude Code finished · ${c.project}`, body: c.lastText || c.title });
    }
    codePrev.set(c.id, c.status);
  }
  for (const k of [...codePrev.keys()]) if (!seen.has(k)) codePrev.delete(k);
}

function installBridge() {
  // Claude's "Upload a plugin" page needs a real .zip; ours lives inside app.asar.
  const out = path.join(app.getPath('downloads'), 'Now Playing - Claude plugin.zip');
  fs.writeFileSync(out, fs.readFileSync(path.join(__dirname, '..', 'assets', 'claude-plugin.zip')));
  shell.showItemInFolder(out);
  return out;
}

async function mediaControl(action, positionMs) {
  const t = nowPlaying;
  if (!t) return;
  if (t.source === 'spotify') {
    if (t.localApp && action !== 'seek') smtc.command(action, t.localApp);
    else await spotify.control(action, { positionMs });
  } else {
    smtc.command(action, t.app, { positionMs });
  }
}

async function setVolumeLevel(level) {
  const t = nowPlaying;
  if (!t) return;
  const v = Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
  if (t.volumeVia === 'local') { smtc.command('volume', t.volumeApp, { level: v }); t.volume = v; recompute(); }
  else if (t.volumeVia === 'spotify') await spotify.setVolume(v);
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('settings:get', () => store.publicSettings());
  ipcMain.handle('settings:set', (_e, patch) => setSettings(patch || {}));
  ipcMain.handle('app:ready', () => {
    rendererReady = true;
    pushAll();
    if (pendingGoto && win) { win.webContents.send(pendingGoto.ch, pendingGoto.data); pendingGoto = null; }
    return true;
  });
  ipcMain.handle('window:hide', () => toggleWindow(false));
  ipcMain.handle('window:pin', (_e, v) => setSettings({ pinned: !!v }));
  ipcMain.handle('open:external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
  ipcMain.handle('open:path', (_e, p) => { if (p) shell.openPath(p); });
  ipcMain.handle('chats:dismiss', (_e, id) => chats?.dismiss(id));
  ipcMain.handle('chats:clear', () => chats?.clearFinished());
  ipcMain.handle('bridge:install', () => installBridge());
  ipcMain.handle('update:state', () => updater?.state);
  ipcMain.handle('update:check', () => updater?.check(true));
  ipcMain.handle('update:apply', () => updater?.apply());
  ipcMain.handle('desktop:status', () => desktop?.status());
  ipcMain.handle('desktop:connect', async () => {
    try { const r = desktop.connect(); desktop.selfTest().then(() => send('desktop', desktop.status())); return { ok: true, ...r }; }
    catch (e) { log('connect claude: ' + e.message); return { ok: false, error: e.message, status: desktop.status() }; }
  });
  ipcMain.handle('desktop:disconnect', () => desktop?.disconnect());
  ipcMain.handle('desktop:test', async () => { await desktop.selfTest(); return desktop.status(); });
  ipcMain.handle('bridge:test', () => { chats?.apply('/claude/question', { task: 'Test alert', question: 'This is what a question from Claude looks like.' }); return true; });

  ipcMain.handle('open:log', () => { log('log opened'); shell.openPath(path.join(app.getPath('userData'), 'debug.log')); });
  ipcMain.handle('app:quit', () => { app.isQuitting = true; app.quit(); });

  ipcMain.handle('spotify:connect', async () => {
    try { const s = await spotify.connect(); recompute(); return { ok: true, status: s }; }
    catch (e) { return { ok: false, error: e.message, status: spotify.status() }; }
    finally { toggleWindow(true); }
  });
  ipcMain.handle('spotify:like', async () => {
    const t = nowPlaying;
    if (!t || t.source !== 'spotify' || !t.uri) return { ok: false, error: 'Likes work for songs from your Spotify account.' };
    const r = await spotify.setLiked(t.uri, !t.liked);
    recompute();
    return r;
  });
  ipcMain.handle('spotify:disconnect', () => { spotify.disconnect(); recompute(); return spotify.status(); });

  // Volume: the playing app's own volume on this PC (native helper), or the
  // Spotify Connect device volume when Spotify plays somewhere else.
  ipcMain.handle('media:volume', (_e, level) => setVolumeLevel(level));
  ipcMain.handle('media:control', (_e, { action, positionMs }) => mediaControl(action, positionMs));
  ipcMain.handle('hotkeys:status', () => hotkeyStatus);
  // Click-through mini player: hold Ctrl over it to use it again.
  ipcMain.handle('window:interactive', (_e, on) => {
    if (!win || !isMini() || !store.get('clickThrough')) return;
    if (on) win.setIgnoreMouseEvents(false); else win.setIgnoreMouseEvents(true, { forward: true });
  });
}

// ---------- mock data for screenshots / dev on non-Windows ----------
function startMock() {
  const now = Date.now();
  spotify.isConnected = () => true;
  spotify.status = () => ({ connected: true, user: { name: 'demo-user' }, redirectUri: 'http://127.0.0.1:8888/callback', clientId: 'xxxx' });
  spotify.playback = {
    source: 'spotify', app: 'spotify-web-api', appName: 'Spotify', title: 'Midnight City', artist: 'M83',
    album: "Hurry Up, We're Dreaming", art: null, isPlaying: true, durationMs: 243000, positionMs: 62000,
    sampledAt: now, canNext: true, canPrev: true, canSeek: true, device: 'MY-PC',
    uri: 'spotify:track:mock', liked: true, canLike: true,
    upNext: [
      { title: 'Outro', artist: 'M83', art: null },
      { title: 'Wait', artist: 'M83', art: null },
      { title: 'Kids', artist: 'MGMT', art: null },
    ],
  };
  smtc.sessions = [
    { source: 'system', app: 'Spotify.exe', appName: 'Spotify', title: 'Midnight City', artist: 'M83', isPlaying: true, status: 'Playing', durationMs: 243000, positionMs: 62000, sampledAt: now, volume: 64, muted: false },
    { source: 'system', app: 'msedge', appName: 'Edge', title: 'Stage lighting basics — DMX in 10 minutes', artist: 'LightingTV', isPlaying: false, status: 'Paused', durationMs: 612000, positionMs: 140000, sampledAt: now },
  ];
  lyricsState = {
    key: 'spotify|midnight city|m83', status: 'found', plain: '', synced: [
      { t: 30000, text: 'Waiting in a car' }, { t: 36000, text: 'Waiting for a ride in the dark' },
      { t: 44000, text: 'The night city grows' }, { t: 50000, text: 'Look at the horizon glow' },
      { t: 56000, text: 'Waiting in a car' }, { t: 62000, text: 'Waiting for a ride in the dark' },
      { t: 70000, text: 'Drinking in the lounge' }, { t: 76000, text: 'Following the neon signs' },
      { t: 82000, text: 'Waiting for a roar' }, { t: 88000, text: 'Looking at the mutating skyline' },
      { t: 96000, text: '♪' },
    ],
  };
  lastTrackKey = 'spotify|midnight city|m83';
  setTimeout(() => {
    if (process.env.NP_EMPTY) return;
    chats.apply('/claude/progress', { task: 'Research notes', done: 3, total: 6, step: 'Writing the second section' });
    chats.apply('/claude/progress', { task: 'Now Playing app update', done: 4, total: 5, step: 'Building the .exe' });
    chats.apply('/claude/question', { task: 'Now Playing app update', question: 'Should the mini player also show lyrics?' });
    chats.apply('/claude/done', { task: 'Weekly summary', summary: 'Summary written and saved.' });
    const ev = chats.tasks.get('research notes');
    if (ev) { ev.msPerStep = 95000; ev.lastStepAt = Date.now() - 20000; chats._emit(); }
  }, 300);
  claude.scan = () => {
    const t = Date.now();
    claude.sessions = [
      { id: 'a', project: 'demo-game', branch: 'main', title: 'Add an animation and rebalance stats', status: 'working', activity: 'Running unit tests', progress: { done: 3, total: 5 }, msPerStep: 50000, lastStepAt: t - 10000, updated: t - 4000, todos: [
        { content: 'Read existing code', status: 'completed' }, { content: 'Add the animation', status: 'completed' },
        { content: 'Rebalance stats', status: 'completed' }, { content: 'Run unit tests', status: 'in_progress' }, { content: 'Update changelog', status: 'pending' }] },
      { id: 'b', project: 'demo-docs', title: 'Convert a document to PDF', status: 'waiting', activity: 'Running pandoc — may need your approval', progress: { done: 1, total: 3 }, updated: t - 90000, todos: [] },
      { id: 'c', project: 'demo-app', title: 'Build a small desktop app', status: 'done', activity: 'Finished — waiting for you', lastText: 'Built the portable .exe and installer.', progress: { done: 5, total: 5 }, updated: t - 600000, todos: [] },
    ];
    claude.found = true; claude.root = 'C:\\Users\\you\\.claude';
    send('claude', { sessions: claude.sessions, root: claude.root, found: true });
  };
}

// ---------- boot ----------
app.whenReady().then(() => {
  store.load();
  log(`start v${app.getVersion()} ${process.platform} ${require('os').release()}`);
  smtc = new SMTC();
  smtc.log = log;
  spotify = new Spotify();
  claude = new ClaudeSessions(() => store.get());

  smtc.on('update', recompute);
  spotify.on('update', recompute);
  claude.on('update', (d) => { sessionsList = d.sessions; send('claude', d); updateTrayTooltip(); if (!MOCK) { checkAlerts(); checkCodeDone(d.sessions); } });
  chats = new ClaudeChats(log);
  chats.on('update', (d) => { chatState = d; send('chats', d); updateTrayTooltip(); if (!MOCK) checkAlerts(); });
  chats.on('finished', (t) => { if (!MOCK) alertDone({ title: `Claude finished · ${t.task}`, body: t.summary }); });

  registerIpc();
  applySize();
  createWindow();

  if (MOCK) {
    startMock();
    store.set({ lyricsOffsets: { 'spotify|midnight city|m83': 500 }, mediaHotkeys: { playPause: 'CommandOrControl+Alt+Space', next: 'CommandOrControl+Alt+PageDown', volUp: 'CommandOrControl+Alt+=' } });
    store.set({ tab: process.env.NP_TAB || 'playing', large: process.env.NP_LARGE === '1', mode: process.env.NP_MINI === '1' ? 'mini' : 'full' });
    applySize();
    claude.scan();
    win.once('ready-to-show', () => { win.setPosition(0, 0); win.show(); });
    if (process.env.NP_SHOT) {
      setTimeout(async () => {
        if (process.env.NP_SETTINGS) send('ui:open-settings');
        if (process.env.NP_SWITCH) { setSettings({ large: true }); await new Promise((r) => setTimeout(r, 300)); setSettings({ mode: process.env.NP_SWITCH }); }
        await new Promise((r) => setTimeout(r, 600));
        const img = await win.webContents.capturePage();
        require('fs').writeFileSync(process.env.NP_SHOT, img.toPNG());
        app.exit(0);
      }, 2500);
    }
    return;
  }

  createTray();
  ensureToastShortcut();
  chats.start(store.get('bridgePort') || 47823);
  updater = new Updater({ app, store, log, defaultRepo: PKG.nowplaying?.updateRepo });
  let notifiedReady = null;
  updater.on('state', (st) => {
    send('update', st);
    if (st.status === 'ready' && notifiedReady !== st.latest && Notification.isSupported()) {
      notifiedReady = st.latest;
      const n = new Notification({ title: `Now Playing ${st.latest} is ready`, body: 'Click to restart and update.', icon: ICON, silent: true });
      n.on('click', () => updater.apply());
      n.show();
    }
  });
  updater.start();
  if (updater.justUpdated && Notification.isSupported()) {
    const installed = updater.kind() === 'installed';
    new Notification({
      title: `Now Playing updated to ${app.getVersion()}`,
      body: installed ? "It's installed now — find it in the Start menu. Updates keep coming automatically." : 'Running the new version.',
      icon: ICON, silent: true,
    }).show();
  }
  desktop = new ClaudeDesktop(app, log);
  try {
    desktop.install(path.join(__dirname, '..', 'assets', 'bridge.ps1'), store.get('bridgePort') || 47823);
    // The uploaded plugin already provides the connector; an extra entry in Claude's
    // config (added by v1.4.0) would make Claude list the same tools twice.
    if (desktop.status().connected) { desktop.disconnect(); log('removed duplicate now-playing entry from Claude config'); }
    setTimeout(() => desktop.selfTest().then(() => send('desktop', desktop.status())), 4000);
  } catch (e) { log('bridge install: ' + e.message); }
  smtc.start();
  spotify.start();
  setActive(false);
  applyHotkey();
  applyMediaHotkeys();
  if (store.get('launchAtStartup') && app.isPackaged) setLoginItem(true);
  if (!process.argv.includes('--hidden')) win.once('ready-to-show', () => toggleWindow(true));
  else scheduleDiscard();
});

app.on('second-instance', () => toggleWindow(true));
app.on('window-all-closed', (e) => e.preventDefault());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  smtc?.stop();
  spotify?.stop();
  claude?.stop();
  chats?.stop();
  updater?.stop();
});
