// Windows media sessions (System Media Transport Controls) via a long-lived
// Windows PowerShell process. No native modules needed.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { nativeImage } = require('electron');

// Video thumbnails can be 1280x720 or bigger; the pop-up shows them at <= 92 px.
function shrink(buf) {
  try {
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    const scale = Math.min(1, 320 / Math.max(width, height));
    const out = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' }) : img;
    return 'data:image/jpeg;base64,' + out.toJPEG(85).toString('base64');
  } catch { return null; }
}

const APP_NAMES = [
  [/spotify/i, 'Spotify'],
  [/^chrome|google\.chrome|chrome\.exe/i, 'Chrome'],
  [/msedge|microsoftedge/i, 'Edge'],
  [/firefox|308046B0AF4A39CB/i, 'Firefox'],
  [/opera/i, 'Opera'],
  [/brave/i, 'Brave'],
  [/vivaldi/i, 'Vivaldi'],
  [/vlc/i, 'VLC'],
  [/ZuneVideo|Microsoft\.Media\.Player|ZuneMusic/i, 'Media Player'],
  [/foobar/i, 'foobar2000'],
  [/AppleMusic|iTunes/i, 'Apple Music'],
  [/TIDAL/i, 'TIDAL'],
  [/Deezer/i, 'Deezer'],
  [/YouTubeMusic|ytmdesktop|youtube-music/i, 'YouTube Music'],
  [/mpc-hc|mpc-be/i, 'MPC'],
  [/PotPlayer/i, 'PotPlayer'],
  [/discord/i, 'Discord'],
  [/AIMP/i, 'AIMP'],
  [/MusicBee/i, 'MusicBee'],
  [/Plex/i, 'Plex'],
];

function appName(aumid = '') {
  for (const [re, name] of APP_NAMES) if (re.test(aumid)) return name;
  const tail = aumid.split('!').pop().split('\\').pop().replace(/\.exe$/i, '');
  return tail.length > 24 ? tail.slice(0, 24) + '…' : tail || 'Media';
}

function sniff(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return 'image/png';
}

class SMTC extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.buf = '';
    this.sessions = [];
    this.current = null;
    this.thumbs = new Map(); // app -> { key, data }
    this.stopped = false;
    this.restarts = 0;
    this.available = process.platform === 'win32';
    this.error = null;
    const dir = path.join(os.tmpdir(), 'nowplaying-popup');
    fs.mkdirSync(dir, { recursive: true });
    this.scriptPath = path.join(dir, 'smtc.ps1');
    this.cmdFile = path.join(dir, 'cmds');
    fs.mkdirSync(this.cmdFile, { recursive: true });
    this.cmdSeq = 0;
    this.thumbDir = path.join(dir, 'thumbs');
    fs.mkdirSync(this.thumbDir, { recursive: true });
    this.thumbErr = null;
    this.log = () => {};
  }

  start() {
    if (!this.available) return;
    // clear leftovers from earlier runs
    try { for (const f of fs.readdirSync(this.thumbDir)) fs.unlink(path.join(this.thumbDir, f), () => {}); } catch {}
    try { for (const f of fs.readdirSync(this.cmdFile)) fs.unlinkSync(path.join(this.cmdFile, f)); } catch {}
    // Script lives inside app.asar, PowerShell can't read it there -> copy to temp.
    const script = fs.readFileSync(path.join(__dirname, 'smtc.ps1'), 'utf8');
    fs.writeFileSync(this.scriptPath, '\ufeff' + script, 'utf8');
    this._spawn();
  }

  // Native helper (NowPlayingHelper.exe, ~10 MB) when it's bundled and healthy;
  // otherwise the PowerShell script. Both speak the same JSON-lines format.
  helperPath() {
    const { app } = require('electron');
    const p = app.isPackaged
      ? path.join(process.resourcesPath, 'helper', 'NowPlayingHelper.exe')
      : path.join(__dirname, '..', '..', 'helper', 'bin', 'NowPlayingHelper.exe');
    return fs.existsSync(p) ? p : null;
  }

  _spawn() {
    if (this.stopped) return;
    if (this.backend !== 'powershell' && this.helperPath()) { this._spawnNative(); return; }
    this.backend = 'powershell';
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    this.proc = spawn(ps, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', this.scriptPath, '-CmdFile', this.cmdFile, '-ThumbDir', this.thumbDir, '-RateMs', String(this.rate || 3000),
    ], { windowsHide: true });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => { this.error = String(d).slice(0, 300); this.log('smtc stderr: ' + String(d).slice(0, 800)); });
    this.proc.on('error', (e) => { this.error = e.message; });
    this.proc.on('exit', (code) => {
      this.log('smtc exited ' + code);
      this.proc = null;
      if (this.stopped) return;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(this.restarts++, 5));
      setTimeout(() => this._spawn(), delay);
    });
  }

  _spawnNative() {
    this.backend = 'native';
    this.ready = false;
    const started = Date.now();
    const proc = spawn(this.helperPath(), ['--rate', String(this.rate || 3000)], { windowsHide: true });
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this._onData(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => this.log('helper stderr: ' + String(d).slice(0, 800)));
    proc.stdin.on('error', () => {});
    proc.on('error', (e) => { this.error = e.message; this.log('helper error: ' + e.message); });
    // No "ready" line within 10 s counts as a failure.
    const readyTimer = setTimeout(() => { if (!this.ready) { this.log('helper not ready in 10 s'); try { proc.kill(); } catch {} } }, 10000);
    proc.on('exit', (code) => {
      clearTimeout(readyTimer);
      if (this.proc === proc) this.proc = null;
      if (this.stopped) return;
      const quick = !this.ready || Date.now() - started < 20000;
      if (quick) this.helperFailures = (this.helperFailures || 0) + 1;
      this.log(`helper exited ${code}${quick ? ` (failure ${this.helperFailures})` : ''}`);
      if (this.helperFailures >= 3) {
        this.log('native helper keeps failing: switching to PowerShell');
        this.backend = 'powershell';
      }
      setTimeout(() => this._spawn(), quick ? 1500 : 1000);
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      try { this._onState(JSON.parse(line)); } catch { /* ignore partial */ }
    }
  }

  _onState(msg) {
    if (msg.ready) { this.ready = true; this.log(`media helper: ${msg.helper || 'native'} v${msg.version || '?'}`); return; }
    if (msg.error) { this.error = msg.error; return; }
    if (msg.audioErr && msg.audioErr !== this.audioErr) { this.audioErr = msg.audioErr; this.log('volume: ' + msg.audioErr); }
    this.restarts = 0;
    this.error = null;
    const offset = Date.now() - (msg.now || Date.now()); // clock skew guard (normally ~0)
    let list = msg.sessions || [];
    if (!Array.isArray(list)) list = list.value || [list];
    this.current = msg.current || null;
    if (msg.thumbErr !== this.thumbErr) { this.thumbErr = msg.thumbErr || null; if (this.thumbErr) this.log('thumbnail: ' + this.thumbErr); }
    this.sessions = list.filter((s) => s && (s.title || s.artist)).map((s) => {
      if (s.thumb || s.thumbFile) {
        try {
          const buf = s.thumbFile ? fs.readFileSync(s.thumbFile) : Buffer.from(String(s.thumb).replace(/^data:[^,]*,/, ''), 'base64');
          const data = shrink(buf) || `data:${sniff(buf)};base64,${buf.toString('base64')}`;
          this.thumbs.set(s.app, { key: s.thumbKey, data });
        } catch (e) { this.log('read thumb failed: ' + e.message); }
        if (s.thumbFile) fs.unlink(s.thumbFile, () => {});
      }
      const t = this.thumbs.get(s.app);
      const playing = s.status === 'Playing';
      return {
        source: 'system',
        app: s.app,
        appName: appName(s.app),
        title: s.title || '',
        artist: s.artist || s.albumArtist || '',
        album: s.album || '',
        art: t && t.key === s.thumbKey ? t.data : null,
        isPlaying: playing,
        status: s.status,
        durationMs: s.durationMs > 0 ? s.durationMs : 0,
        positionMs: Math.max(0, s.positionMs || 0),
        // Position was sampled at updatedAt; renderer extrapolates while playing.
        sampledAt: (s.updatedAt > 0 ? s.updatedAt : msg.now) + offset,
        canNext: !!s.canNext,
        canPrev: !!s.canPrev,
        canSeek: !!s.canSeek,
        isCurrent: s.app === msg.current,
        volume: typeof s.volume === 'number' ? s.volume : null, // only the native helper reports volume
        muted: !!s.muted,
      };
    });
    const live = new Set(list.map((x) => x && x.app));
    for (const k of this.thumbs.keys()) if (!live.has(k)) this.thumbs.delete(k);
    this.emit('update', this.sessions);
  }

  setRate(ms) {
    if (this.rate === ms) return;
    this.rate = ms;
    this.command('rate', null, { ms });
  }

  command(action, app, extra = {}) {
    if (!this.available) return;
    if (this.backend === 'native') {
      if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify({ action, app, ...extra }) + '\n');
      return;
    }
    if (action === 'volume') return; // PowerShell fallback can't change volume
    const name = `${Date.now()}-${String(++this.cmdSeq).padStart(6, '0')}`;
    const tmp = path.join(this.cmdFile, name + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify({ action, app, ...extra }));
    fs.renameSync(tmp, path.join(this.cmdFile, name + '.json'));
  }

  stop() {
    this.stopped = true;
    if (this.proc) {
      try { this.proc.stdin?.end(); } catch {} // the helper exits when its input closes
      try { this.proc.kill(); } catch {}
    }
  }
}

module.exports = { SMTC, appName };
