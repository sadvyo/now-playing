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
const SETUP = /^NowPlaying-Setup-\d+\.\d+\.\d+\.exe$/i;
const PORTABLE = /-portable\.exe$/i;

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
  // 'portable' (single .exe), 'installed' (via the setup), or 'dev' (not packaged).
  kind() { return this.exePath() ? 'portable' : this.app.isPackaged ? 'installed' : 'dev'; }
  tempDir() { return path.join(this.app.getPath('temp'), 'now-playing-update'); }

  _set(patch) {
    this.state = { ...this.state, ...patch, current: this.app.getVersion(), repo: this.repo() };
    this.emit('state', this.state);
  }

  start() {
    this.cleanupOld();
    this.noteVersion();
    if (!this.repo()) { this._set({ status: 'off' }); return; }
    setTimeout(() => this.check(false), 45 * 1000); // not during startup
    this.timer = setInterval(() => this.check(false), CHECK_EVERY);
  }

  stop() { clearInterval(this.timer); clearTimeout(this.retryTimer); }

  async check(manual) {
    const repo = this.repo();
    if (!repo) { this._set({ status: 'off' }); return this.state; }
    if (this.busy || this.state.status === 'ready') return this.state;
    this.busy = true;
    this._set({ status: 'checking', error: null });
    try {
      const rel = await this._fetchRelease(repo);
      const version = String(rel.tag_name || '').replace(/^v/, '');
      const assets = rel.assets || [];
      const setup = assets.find((a) => SETUP.test(a.name));
      const portable = assets.find((a) => PORTABLE.test(a.name));
      const kind = this.kind();
      // Installed copies update with the setup. The portable .exe moves over to the
      // installed version as soon as a setup exists (even for the same version).
      const asset = kind === 'portable' ? (setup || portable) : setup;
      if (!version || !asset) throw new Error('The latest release has no file for this kind of install.');
      const migrate = kind === 'portable' && asset === setup && !newer(this.app.getVersion(), version);
      const info = { latest: version, notes: String(rel.body || '').split('\n').find((l) => l.trim()) || '', checkedAt: Date.now(), migrate };
      if (!newer(version, this.app.getVersion()) && !migrate) { this._set({ status: 'up-to-date', ...info }); return this.state; }
      this.log(`update available: ${version}${migrate ? ' (switching to the installed version)' : ''}`);
      if (kind === 'dev') { this._set({ status: 'available', ...info, error: 'Not a packaged build.' }); return this.state; }
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

  // Newest release info. First latest.json through GitHub's normal file downloads
  // (not rate-limited); the GitHub API only as a fallback for older releases.
  async _fetchRelease(repo) {
    try {
      const r = await fetch(`https://github.com/${repo}/releases/latest/download/latest.json`, { headers: { 'User-Agent': UA }, cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        if (j && j.version && Array.isArray(j.files)) {
          return {
            tag_name: 'v' + j.version,
            body: j.notes || '',
            assets: j.files.map((f) => ({
              name: f.name,
              size: f.size,
              digest: f.sha256 ? 'sha256:' + f.sha256 : '',
              browser_download_url: `https://github.com/${repo}/releases/download/v${j.version}/${encodeURIComponent(f.name)}`,
            })),
          };
        }
      }
    } catch { /* fall back to the API */ }

    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
    });
    if (res.status === 404) throw new Error('No releases published yet.');
    if (res.status === 403 || res.status === 429) {
      // Rate limit: retry by itself when GitHub says the limit resets.
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      const at = reset > Date.now() ? reset + 5000 : Date.now() + 3600 * 1000;
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.check(false), at - Date.now());
      const hhmm = new Date(at).toTimeString().slice(0, 5);
      throw new Error(`GitHub is limiting update checks from your network right now — trying again at ${hhmm}.`);
    }
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    return res.json();
  }

  async download() {
    // "Download" button when automatic downloads are off.
    this.store.set({ autoDownload: this.store.get('autoDownload') });
    return this.check(true);
  }

  async _download(asset, info) {
    const installer = SETUP.test(asset.name);
    info = { ...info, installer };
    const dir = installer ? this.tempDir() : path.dirname(this.exePath());
    fs.mkdirSync(dir, { recursive: true });
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
    if (this.state.installer) {
      // Silent per-user install; the setup closes this copy, installs, then starts the new one.
      if (old) this.store.set({ migratedFrom: old });
      return this._launch(file, ['/S', '--force-run'], () => { if (old) this.store.set({ migratedFrom: null }); });
    }
    if (this.store.get('launchAtStartup')) {
      this.app.setLoginItemSettings({ openAtLogin: true, path: file, args: ['--hidden'] });
    }
    return this._launch(file, old ? ['--updated-from', old] : []);
  }

  // Start the new version / installer and quit only once it has really started.
  // If Windows refuses to run it, stay open and say so instead of crashing.
  _launch(file, args, onFail) {
    try { this.app.releaseSingleInstanceLock(); } catch {}
    const fail = (msg) => {
      this.log('update launch failed: ' + msg);
      try { this.app.requestSingleInstanceLock(); } catch {}
      if (onFail) onFail();
      this._set({ status: 'error', error: `Couldn't start the update (${msg}). Try again, or run it from ${path.dirname(file)}.` });
    };
    let child;
    try { child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false }); }
    catch (e) { fail(e.message); return false; }
    child.once('error', (e) => fail(e.code || e.message));
    child.once('spawn', () => {
      child.unref();
      this.app.isQuitting = true;
      setTimeout(() => this.app.quit(), 300);
    });
    return true;
  }

  // Remember the version so the first run after an update can say "Updated to …".
  noteVersion() {
    const prev = this.store.get('lastRunVersion');
    const cur = this.app.getVersion();
    if (prev && newer(cur, prev)) this.justUpdated = true;
    if (prev !== cur) this.store.set({ lastRunVersion: cur });
  }

  // In the new version: remove the previous .exe once it has exited.
  cleanupOld() {
    // Installed after running portable: delete the old portable .exe and spent installers.
    if (this.kind() === 'installed') {
      try { for (const f of fs.readdirSync(this.tempDir())) if (SETUP.test(f) || f.endsWith('.part')) rmQuiet(path.join(this.tempDir(), f)); } catch {}
      const prev = this.store.get('migratedFrom');
      if (prev && OLD_NAME.test(path.basename(prev))) {
        let tries = 0;
        const attempt = () => fs.rm(prev, { force: true }, (err) => {
          if (!err) { this.log('removed portable copy ' + prev); this.store.set({ migratedFrom: null }); this.migrated = true; return; }
          if (++tries < 6) setTimeout(attempt, 10000);
        });
        setTimeout(attempt, 8000);
      } else if (prev) this.store.set({ migratedFrom: null });
    }
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
