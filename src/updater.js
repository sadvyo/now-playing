// Auto-update from GitHub Releases.
// Checks the latest release, downloads the new portable .exe next to the current one,
// verifies it (size + SHA-256), then restarts into it and removes the old file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const EventEmitter = require('events');

const CHECK_EVERY = 6 * 3600 * 1000;
const UA = 'NowPlayingPopup-updater';
const OLD_NAME = /^NowPlaying-\d+\.\d+\.\d+-portable\.exe$/i;

function rmQuiet(f) { try { fs.rmSync(f, { force: true }); } catch {} }

function newer(a, b) { // is version a newer than b?
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

class Updater extends EventEmitter {
  constructor({ app, store, log, defaultRepo }) {
    super();
    this.app = app;
    this.store = store;
    this.log = log || (() => {});
    this.defaultRepo = defaultRepo || '';
    this.state = { status: 'idle', current: app.getVersion() };
    this.timer = null;
    this.busy = false;
  }

  repo() { return (this.store.get('updateRepo') || this.defaultRepo || '').trim(); }
  exePath() { return process.env.PORTABLE_EXECUTABLE_FILE || null; }

  _set(patch) {
    this.state = { ...this.state, ...patch, current: this.app.getVersion(), repo: this.repo() };
    this.emit('state', this.state);
  }

  start() {
    this.cleanupOld();
    if (!this.repo()) { this._set({ status: 'off' }); return; }
    setTimeout(() => this.check(false), 45 * 1000); // not during startup
    this.timer = setInterval(() => this.check(false), CHECK_EVERY);
  }

  stop() { clearInterval(this.timer); }

  async check(manual) {
    const repo = this.repo();
    if (!repo) { this._set({ status: 'off' }); return this.state; }
    if (this.busy || this.state.status === 'ready') return this.state;
    this.busy = true;
    this._set({ status: 'checking', error: null });
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
      });
      if (res.status === 404) throw new Error('No releases published yet.');
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const rel = await res.json();
      const version = String(rel.tag_name || '').replace(/^v/, '');
      const asset = (rel.assets || []).find((a) => /portable\.exe$/i.test(a.name));
      if (!version || !asset) throw new Error('The latest release has no portable .exe.');
      const info = { latest: version, notes: String(rel.body || '').split('\n').find((l) => l.trim()) || '', checkedAt: Date.now() };
      if (!newer(version, this.app.getVersion())) { this._set({ status: 'up-to-date', ...info }); return this.state; }
      this.log(`update available: ${version}`);
      if (!this.exePath()) { this._set({ status: 'available', ...info, error: 'Running outside the portable .exe; download it manually.' }); return this.state; }
      if (!manual && this.store.get('autoDownload') === false) { this._set({ status: 'available', ...info }); return this.state; }
      await this._download(asset, info);
    } catch (e) {
      this.log('update check: ' + e.message);
      this._set({ status: 'error', error: e.message });
    } finally {
      this.busy = false;
    }
    return this.state;
  }

  async download() {
    // "Download" button when automatic downloads are off.
    this.store.set({ autoDownload: this.store.get('autoDownload') });
    return this.check(true);
  }

  async _download(asset, info) {
    const dir = path.dirname(this.exePath());
    const file = path.join(dir, asset.name);
    const part = file + '.part';
    if (fs.existsSync(file) && fs.statSync(file).size === asset.size && (await this._verify(file, asset))) {
      this._set({ status: 'ready', file, ...info }); return;
    }
    this._set({ status: 'downloading', progress: 0, ...info });
    const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': UA } });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(part);
    let got = 0, lastPct = -1;
    try {
      for await (const chunk of Readable.fromWeb(res.body)) {
        hash.update(chunk);
        got += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        const pct = total ? Math.floor((got / total) * 100) : 0;
        if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; this._set({ progress: pct }); }
      }
      await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));
    } catch (e) {
      out.destroy(); rmQuiet(part);
      throw e;
    }
    if (asset.size && got !== asset.size) { rmQuiet(part); throw new Error('Download was incomplete.'); }
    const digest = hash.digest('hex');
    const want = String(asset.digest || '').replace(/^sha256:/, '');
    if (want && want !== digest) { rmQuiet(part); throw new Error('Downloaded file failed its checksum.'); }
    fs.renameSync(part, file);
    this.log(`update downloaded: ${file} sha256=${digest}`);
    this._set({ status: 'ready', file, progress: 100, ...info });
  }

  async _verify(file, asset) {
    const want = String(asset.digest || '').replace(/^sha256:/, '');
    if (!want) return true;
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex') === want;
  }

  // Restart into the downloaded version.
  apply() {
    const file = this.state.file;
    const old = this.exePath();
    if (this.state.status !== 'ready' || !file || !fs.existsSync(file)) return false;
    this.log(`applying update ${this.state.latest}`);
    if (this.store.get('launchAtStartup')) {
      this.app.setLoginItemSettings({ openAtLogin: true, path: file, args: ['--hidden'] });
    }
    try { this.app.releaseSingleInstanceLock(); } catch {}
    const child = spawn(file, old ? ['--updated-from', old] : [], { detached: true, stdio: 'ignore' });
    child.unref();
    this.app.isQuitting = true;
    setTimeout(() => this.app.quit(), 200);
    return true;
  }

  // In the new version: remove the previous .exe once it has exited.
  cleanupOld() {
    const i = process.argv.indexOf('--updated-from');
    if (i < 0) return;
    const old = process.argv[i + 1];
    const me = this.exePath();
    if (!old || !me || path.resolve(old) === path.resolve(me)) return;
    if (path.dirname(path.resolve(old)) !== path.dirname(path.resolve(me)) || !OLD_NAME.test(path.basename(old))) return;
    this.justUpdated = true;
    let tries = 0;
    const attempt = () => {
      fs.rm(old, { force: true }, (err) => {
        if (!err) { this.log('removed old version ' + old); return; }
        if (++tries < 6) setTimeout(attempt, 10000); // still locked while the old one shuts down
        else this.log('could not remove old version: ' + err.message);
      });
    };
    setTimeout(attempt, 8000);
  }
}

module.exports = { Updater, newer };
