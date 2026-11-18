// Desktop lyrics: the current line in big text, floating over everything.
// Clicks go straight through it; "Move" makes it draggable until you press Done.
// The window only exists while it's needed and is closed after a few minutes unused.
const path = require('path');
const { BrowserWindow, screen, ipcMain } = require('electron');

const FONT = { s: 26, m: 34, l: 44, xl: 58 };
const SIZES = ['s', 'm', 'l', 'xl'];
const LINGER = 5000;               // stay a moment while the next song's lyrics load
const PAUSE_HIDE = 15000;          // close after this long paused
const DISCARD_AFTER = 3 * 60 * 1000;
const TOOLBAR = 40;                // room above the text for the Move toolbar

class LyricsOverlay {
  // onChange(): called when the window shows/hides or Move mode starts/ends.
  constructor({ store, log, onChange, saveSettings }) {
    this.store = store;
    this.log = log || (() => {});
    this.onChange = onChange || (() => {});
    this.saveSettings = saveSettings || ((p) => store.set(p));
    this.win = null;
    this.ready = false;
    this.visible = false;
    this.moving = false;
    this.state = null;
    this.sent = {};
    this.lastActive = 0;
    this.pausedSince = 0;
    this.recheck = null;
    this.discardTimer = null;
    this.drag = null;

    const mine = (e) => !!this.win && !this.win.isDestroyed() && e.sender === this.win.webContents;
    ipcMain.on('ov:ready', (e) => { if (mine(e)) { this.ready = true; this.sent = {}; this._push(); } });
    ipcMain.on('ov:dragStart', (e) => {
      if (!mine(e) || !this.moving) return;
      const c = screen.getCursorScreenPoint();
      const [x, y] = this.win.getPosition();
      this.drag = { cx: c.x, cy: c.y, x, y };
    });
    ipcMain.on('ov:drag', (e) => {
      if (!mine(e) || !this.drag) return;
      const c = screen.getCursorScreenPoint();
      this.win.setPosition(Math.round(this.drag.x + c.x - this.drag.cx), Math.round(this.drag.y + c.y - this.drag.cy));
    });
    ipcMain.on('ov:dragEnd', (e) => { if (!mine(e) || !this.drag) return; this.drag = null; this._savePosition(); });
    ipcMain.on('ov:done', (e) => { if (mine(e)) this.setMoving(false); });
    ipcMain.on('ov:size', (e, dir) => {
      if (!mine(e)) return;
      const i = SIZES.indexOf(this.store.get('desktopLyricsSize'));
      const next = SIZES[Math.max(0, Math.min(SIZES.length - 1, (i < 0 ? 1 : i) + (dir > 0 ? 1 : -1)))];
      this.saveSettings({ desktopLyricsSize: next });
    });
    const relayout = () => this.relayout();
    screen.on('display-metrics-changed', relayout);
    screen.on('display-removed', relayout);
    screen.on('display-added', relayout);
  }

  enabled() { return !!this.store.get('desktopLyrics'); }

  _has(s) {
    return !!(s && s.track && s.lyrics && s.lyrics.status === 'found' && s.lyrics.synced && s.lyrics.synced.length && s.lyrics.key === s.key);
  }

  // Called by the app whenever the song, its lyrics, playback or settings change.
  sync(s) {
    if (s) this.state = s;
    s = this.state;
    if (!this.enabled() && !this.moving) { this._destroy(); return; }
    const now = Date.now();
    const has = this._has(s);
    const playing = has && !!s.track.isPlaying;
    if (playing || !has) this.pausedSince = 0;
    else if (!this.pausedSince) this.pausedSince = now;
    // Shown while lyrics play, for a while after pausing, and briefly while the
    // next song's lyrics load (so it doesn't blink off and on between songs).
    const active = has && (playing || now - this.pausedSince < PAUSE_HIDE);
    if (has && playing) this.lastActive = now;
    const lingering = !has && now - this.lastActive < LINGER;
    const want = this.moving || active || lingering;

    clearTimeout(this.recheck);
    this.recheck = null;
    if (!this.moving && (lingering || (active && !playing))) {
      // Come back when the answer changes by itself (pause timeout, end of linger).
      const at = active ? this.pausedSince + PAUSE_HIDE : this.lastActive + LINGER;
      this.recheck = setTimeout(() => this.sync(), Math.max(50, at - now + 50));
    }
    if (want) this._show(); else this._hide();
    this._push();
  }

  setMoving(on) {
    on = !!on;
    if (on === this.moving) return this.moving;
    this.moving = on;
    this.drag = null;
    if (on && !this.win) this._create();
    if (this.win && !this.win.isDestroyed()) this.win.setIgnoreMouseEvents(!on);
    this.sync();
    this.onChange();
    return this.moving;
  }

  relayout() {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.setBounds(this._bounds());
    this._push();
  }

  // ---------- window ----------
  _font() { return FONT[this.store.get('desktopLyricsSize')] || FONT.m; }

  _bounds() {
    const font = this._font();
    const next = this.store.get('desktopLyricsNext') !== false;
    const pos = this.store.get('desktopLyricsPos');
    const disp = pos && Number.isFinite(pos.cx) && Number.isFinite(pos.bottom)
      ? screen.getDisplayNearestPoint({ x: Math.round(pos.cx), y: Math.round(pos.bottom - 20) })
      : screen.getPrimaryDisplay();
    const wa = disp.workArea;
    const width = Math.max(320, Math.min(wa.width - 16, Math.round(font * 30)));
    const height = Math.round(TOOLBAR + font * 1.7 + (next ? font * 0.95 : 0) + 22);
    const cx = pos ? pos.cx : wa.x + wa.width / 2;
    const bottom = pos ? pos.bottom : wa.y + wa.height - 48;
    let x = Math.round(cx - width / 2), y = Math.round(bottom - height);
    x = Math.min(Math.max(x, wa.x), wa.x + wa.width - width);
    y = Math.min(Math.max(y, wa.y), wa.y + wa.height - height);
    return { x, y, width, height };
  }

  _savePosition() {
    if (!this.win || this.win.isDestroyed()) return;
    const b = this.win.getBounds();
    this.store.set({ desktopLyricsPos: { cx: Math.round(b.x + b.width / 2), bottom: Math.round(b.y + b.height) } });
    this.win.setBounds(this._bounds()); // pulls it back on screen if it was dropped half outside
  }

  _create() {
    this.win = new BrowserWindow({
      ...this._bounds(),
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      focusable: false,          // never steals focus from what you're doing
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
      thickFrame: false,
      backgroundColor: '#00000000',
      title: 'Now Playing - desktop lyrics',
      webPreferences: {
        preload: path.join(__dirname, 'overlay-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        // Its one timer (next line) must fire on time even if Windows thinks the
        // see-through window is covered; when nothing plays the page does no work.
        backgroundThrottling: false,
      },
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setIgnoreMouseEvents(!this.moving);
    this.win.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
    this.win.on('closed', () => {
      const was = this.visible;
      this.win = null; this.ready = false; this.visible = false; this.sent = {}; this.drag = null;
      if (was) this.onChange();
    });
  }

  _show() {
    clearTimeout(this.discardTimer);
    this.discardTimer = null;
    if (!this.win || this.win.isDestroyed()) this._create();
    if (this.visible) return;
    this.win.setBounds(this._bounds());
    this.win.showInactive();
    this.win.setAlwaysOnTop(true, 'screen-saver'); // other "always on top" windows can push it down
    this.visible = true;
    this.onChange();
  }

  _hide() {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.visible) {
      this.win.hide();
      this.visible = false;
      this.onChange();
    }
    if (!this.discardTimer) {
      this.discardTimer = setTimeout(() => { this.discardTimer = null; if (!this.visible && !this.moving) this._destroy(); }, DISCARD_AFTER);
    }
  }

  _destroy() {
    clearTimeout(this.recheck); this.recheck = null;
    clearTimeout(this.discardTimer); this.discardTimer = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    else if (this.visible) { this.visible = false; this.onChange(); }
  }

  // ---------- data for the page ----------
  _send(ch, data) { if (this.win && !this.win.isDestroyed() && this.ready) this.win.webContents.send(ch, data); }

  _push() {
    if (!this.win || !this.ready) return;
    const s = this.state || {};
    const has = this._has(s);
    const st = this.store.get();

    const offset = has ? Number((st.lyricsOffsets || {})[s.lyrics.key]) || 0 : 0;
    const lyId = has ? `${s.lyrics.key}#${s.lyrics.id ?? ''}#${s.lyrics.synced.length}#${offset}` : '';
    if (lyId !== this.sent.lyId) {
      this.sent.lyId = lyId;
      this._send('ov:lyrics', has ? { key: s.lyrics.key, lines: s.lyrics.synced, offset } : { key: null, lines: [], offset: 0 });
    }

    const t = s.track;
    const play = t ? { key: s.key, isPlaying: !!t.isPlaying, positionMs: t.positionMs || 0, sampledAt: t.sampledAt || Date.now(), durationMs: t.durationMs || 0 } : null;
    if (this._playChanged(play, this.sent.play)) { this.sent.play = play; this._send('ov:play', play); }

    const look = {
      font: this._font(),
      style: st.desktopLyricsLook === 'box' ? 'box' : 'outline',
      next: st.desktopLyricsNext !== false,
      fill: st.desktopLyricsFill !== false,
      accent: (st.accentMode === 'fixed' ? st.accentColor : t && t.accent) || '#1ed760',
      moving: this.moving,
      size: st.desktopLyricsSize || 'm',
    };
    const sig = JSON.stringify(look);
    if (sig !== this.sent.look) { this.sent.look = sig; this._send('ov:look', look); }
  }

  // Positions are extrapolated on the page, so only send real changes (not every poll).
  _playChanged(a, b) {
    if (!a || !b) return a !== b;
    if (a.key !== b.key || a.isPlaying !== b.isPlaying || a.durationMs !== b.durationMs) return true;
    const now = Date.now();
    const at = (p) => p.positionMs + (p.isPlaying ? now - p.sampledAt : 0);
    return Math.abs(at(a) - at(b)) > 400;
  }
}

module.exports = { LyricsOverlay, OVERLAY_SIZES: SIZES };
