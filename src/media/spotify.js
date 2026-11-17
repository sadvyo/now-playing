// Spotify Web API: Authorization Code + PKCE (no client secret needed).
// The user registers their own app at developer.spotify.com and pastes the Client ID.
const http = require('http');
const crypto = require('crypto');
const EventEmitter = require('events');
const { shell } = require('electron');
const store = require('../store');

const SCOPES = [
  'user-read-currently-playing',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-library-read',
  'user-library-modify',
].join(' ');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

class Spotify extends EventEmitter {
  constructor() {
    super();
    this.accessToken = null;
    this.expiresAt = 0;
    this.user = null;
    this.playback = null;
    this.timer = null;
    this.backoffUntil = 0;
    this.error = null;
    this.server = null;
    this.interval = 2000;
    this.liked = new Map();   // uri -> true/false
    this.queue = [];
    this.queueFor = null;     // track uri the queue was fetched for
    this.queueAt = 0;
  }

  _rememberLiked(uri, v) {
    this.liked.set(uri, v);
    if (this.liked.size > 500) this.liked.delete(this.liked.keys().next().value);
  }

  canLike() {
    const sc = store.get('spotifyScopes');
    return sc == null ? null : /user-library-modify/.test(sc); // null = not known yet
  }

  async _checkLiked(uri) {
    if (!uri || this.liked.has(uri) || this.canLike() === false || this.likePending === uri) return;
    this.likePending = uri;
    try {
      const r = await this.api('GET', `/me/library/contains?uris=${encodeURIComponent(uri)}`);
      if (r.status === 200 && Array.isArray(r.json)) { this._rememberLiked(uri, !!r.json[0]); this._patch({ liked: !!r.json[0] }); }
      else if (r.status === 403) store.set({ spotifyScopes: (store.get('spotifyScopes') || '').replace(/user-library-\w+/g, '') });
    } catch {} finally { this.likePending = null; }
  }

  // Like / unlike the current song (Feb 2026 API: PUT/DELETE /me/library with URIs).
  async setLiked(uri, on) {
    if (!uri) return { ok: false };
    const prev = this.liked.get(uri);
    this.liked.set(uri, on); this._patch({ liked: on });
    const call = () => this.api(on ? 'PUT' : 'DELETE', `/me/library?uris=${encodeURIComponent(uri)}`);
    let r = await call();
    if (r.status === 401) r = await call(); // token had just expired; api() refreshed it
    if (r.status >= 200 && r.status < 300) return { ok: true, liked: on };
    this.liked.set(uri, prev ?? !on); this._patch({ liked: prev ?? !on });
    if (r.status === 403) {
      store.set({ spotifyScopes: (store.get('spotifyScopes') || '').replace(/user-library-\w+/g, '') });
      return { ok: false, needsReconnect: true };
    }
    return { ok: false, error: `Spotify said ${r.status}` };
  }

  async _loadQueue(uri) {
    if (this.queueLoading) return;
    this.queueLoading = true;
    this.queueAt = Date.now();
    try {
      const r = await this.api('GET', '/me/player/queue');
      if (r.status !== 200) return;
      const items = (r.json?.queue || []).slice(0, 3).map((it) => {
        const imgs = (it.type === 'episode' ? it.images || it.show?.images : it.album?.images) || [];
        return {
          title: it.name,
          artist: it.type === 'episode' ? it.show?.name || '' : (it.artists || []).map((a) => a.name).join(', '),
          art: imgs.length ? imgs[imgs.length - 1].url : null, // smallest picture
        };
      });
      this.queue = items; this.queueFor = uri;
      if (this.playback?.uri === uri) this._patch({ upNext: items });
    } catch {} finally { this.queueLoading = false; }
  }

  _patch(fields) {
    if (!this.playback) return;
    this.playback = { ...this.playback, ...fields };
    this.emit('update', this.playback);
  }

  redirectUri() {
    return `http://127.0.0.1:${store.get('spotifyPort') || 8888}/callback`;
  }

  isConnected() { return !!store.getSecret('spotifyRefresh'); }

  status() {
    return {
      connected: this.isConnected(),
      user: this.user,
      error: this.error,
      redirectUri: this.redirectUri(),
      clientId: store.get('spotifyClientId'),
    };
  }

  async connect() {
    const clientId = (store.get('spotifyClientId') || '').trim();
    if (!clientId) throw new Error('Paste your Spotify Client ID in Settings first.');
    const verifier = b64url(crypto.randomBytes(64));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    const redirect = this.redirectUri();
    const port = Number(new URL(redirect).port);

    if (this.server) try { this.server.close(); } catch {}

    const code = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error('Spotify login timed out.')); try { this.server.close(); } catch {} }, 5 * 60 * 1000);
      this.server = http.createServer((req, res) => {
        const u = new URL(req.url, redirect);
        if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
        const ok = u.searchParams.get('code') && u.searchParams.get('state') === state;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Now Playing</title>
          <body style="font:16px Segoe UI,system-ui;background:#0e0f13;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
          <div style="text-align:center"><h2>${ok ? 'Spotify connected ✓' : 'Spotify login failed'}</h2>
          <p style="opacity:.7">${ok ? 'You can close this tab and go back to the pop-up.' : (u.searchParams.get('error') || 'State mismatch')}</p></div>`);
        clearTimeout(timeout);
        setTimeout(() => { try { this.server.close(); } catch {} this.server = null; }, 500);
        if (ok) resolve(u.searchParams.get('code'));
        else reject(new Error(u.searchParams.get('error') || 'Login was cancelled.'));
      });
      this.server.on('error', (e) => { clearTimeout(timeout); reject(new Error(`Port ${port} is busy (${e.code}). Change it in Settings and in your Spotify app's Redirect URI.`)); });
      this.server.listen(port, '127.0.0.1', () => {
        const q = new URLSearchParams({
          client_id: clientId,
          response_type: 'code',
          redirect_uri: redirect,
          code_challenge_method: 'S256',
          code_challenge: challenge,
          scope: SCOPES,
          state,
        });
        shell.openExternal(`https://accounts.spotify.com/authorize?${q}`);
      });
    });

    const tok = await this._token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier,
    });
    if (!tok.refresh_token) throw new Error('Spotify did not return a refresh token.');
    store.setSecret('spotifyRefresh', tok.refresh_token);
    this.error = null;
    await this._loadUser();
    this.start();
    return this.status();
  }

  disconnect() {
    store.setSecret('spotifyRefresh', null);
    store.set({ spotifyScopes: null });
    this.liked.clear(); this.queue = []; this.queueFor = null;
    this.accessToken = null;
    this.user = null;
    this.playback = null;
    this.stop();
    this.emit('update', null);
  }

  async _token(params) {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body.error_description || body.error || `HTTP ${res.status}`;
      const err = new Error(`Spotify: ${msg}`);
      err.fatal = body.error === 'invalid_grant' || body.error === 'invalid_client';
      throw err;
    }
    this.accessToken = body.access_token;
    if (body.scope) store.set({ spotifyScopes: body.scope });
    this.expiresAt = Date.now() + (body.expires_in - 60) * 1000;
    if (body.refresh_token) store.setSecret('spotifyRefresh', body.refresh_token);
    return body;
  }

  async _ensureToken() {
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    const refresh = store.getSecret('spotifyRefresh');
    if (!refresh) throw new Error('Not connected');
    try {
      await this._token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: store.get('spotifyClientId') });
    } catch (e) {
      if (e.fatal) { this.error = 'Spotify session expired — reconnect in Settings.'; this.disconnect(); }
      throw e;
    }
    return this.accessToken;
  }

  async api(method, path, body) {
    if (Date.now() < this.backoffUntil) return { status: 429 };
    const token = await this._ensureToken();
    const res = await fetch(`https://api.spotify.com/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || 5);
      this.backoffUntil = Date.now() + wait * 1000;
    }
    if (res.status === 401) { this.accessToken = null; }
    let json = null;
    if (res.status !== 204) json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  async _loadUser() {
    try {
      const r = await this.api('GET', '/me');
      if (r.status === 200) this.user = { name: r.json.display_name || r.json.id, product: r.json.product };
      else if (r.status === 403) this.error = 'Spotify refused access (403). Add your account under "User Management" in your Spotify app, and note Development Mode needs Premium.';
    } catch (e) { this.error = e.message; }
  }

  async poll() {
    if (!this.isConnected()) return;
    try {
      const r = await this.api('GET', '/me/player?additional_types=track,episode');
      if (r.status === 204 || (r.status === 200 && !r.json?.item)) {
        this.playback = null;
      } else if (r.status === 200) {
        const p = r.json;
        const it = p.item;
        const isEp = it.type === 'episode';
        const imgs = (isEp ? it.images || it.show?.images : it.album?.images) || [];
        this.playback = {
          source: 'spotify',
          app: 'spotify-web-api',
          appName: 'Spotify',
          id: it.id,
          title: it.name,
          artist: isEp ? it.show?.name || '' : (it.artists || []).map((a) => a.name).join(', '),
          album: isEp ? '' : it.album?.name || '',
          // Spotify lists 640, 300 and 64 px versions: the 300 px one is sharp enough here.
          art: (imgs.find((i) => i.width && i.width <= 320) || imgs[imgs.length - 1] || {}).url || imgs[0]?.url || null,
          url: it.external_urls?.spotify || null,
          uri: it.uri || null,
          liked: this.liked.has(it.uri) ? this.liked.get(it.uri) : null,
          canLike: this.canLike(),
          upNext: this.queueFor === it.uri ? this.queue : [],
          isPlaying: !!p.is_playing,
          durationMs: it.duration_ms || 0,
          positionMs: p.progress_ms || 0,
          sampledAt: Date.now(),
          device: p.device?.name || null,
          canNext: true,
          canPrev: true,
          canSeek: true,
        };
        this.error = null;
        const uri = this.playback.uri;
        if (uri && !this.liked.has(uri)) this._checkLiked(uri);
        // Queue: when the song changes, and every 30 s while the pop-up is open.
        if (uri && (this.queueFor !== uri || (this.interval <= 2000 && Date.now() - this.queueAt > 30000))) {
          if (this.queueFor !== uri) { this.queue = []; this.playback.upNext = []; }
          this._loadQueue(uri);
        }
      } else if (r.status === 403) {
        this.error = 'Spotify returned 403 — your account must be added to the app\'s User Management (and Development Mode needs Premium).';
      }
    } catch (e) {
      if (e.message !== 'Not connected') this.error = e.message;
    }
    this.emit('update', this.playback);
  }

  async control(action, extra = {}) {
    const map = {
      toggle: this.playback?.isPlaying ? ['PUT', '/me/player/pause'] : ['PUT', '/me/player/play'],
      play: ['PUT', '/me/player/play'],
      pause: ['PUT', '/me/player/pause'],
      next: ['POST', '/me/player/next'],
      previous: ['POST', '/me/player/previous'],
      seek: ['PUT', `/me/player/seek?position_ms=${Math.round(extra.positionMs || 0)}`],
    };
    const m = map[action];
    if (!m) return;
    const r = await this.api(m[0], m[1]);
    if (r.status === 403) this.error = 'Playback control needs Spotify Premium.';
    setTimeout(() => this.poll(), 350);
  }

  setInterval(ms) {
    if (ms === this.interval) return;
    this.interval = ms;
    if (this.timer) this.start();
  }

  start() {
    this.stop();
    if (!this.isConnected()) return;
    if (!this.user) this._loadUser();
    const gen = (this.gen = (this.gen || 0) + 1);
    const loop = async () => {
      await this.poll();
      if (gen !== this.gen) return; // a newer loop took over
      this.timer = setTimeout(loop, this.interval);
    };
    loop();
  }

  stop() {
    this.gen = (this.gen || 0) + 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = { Spotify };
