// Listening stats, kept only on this PC: %APPDATA%\Now Playing\stats.json.
// Time is counted while something plays (the song shown in the pop-up), in short
// steps; gaps longer than 30 s (sleep, a frozen player) are never counted.
const fs = require('fs');
const path = require('path');
const { cleanup } = require('./media/lyrics');

const DETAIL_DAYS = 62;   // days kept with per-song / per-artist detail (this + last month)
const TOTAL_DAYS = 400;   // days kept as a single total (for the all-time chart)
const MAX_SONGS = 2500;   // all-time songs kept (the least played are dropped first)
const MAX_ARTISTS = 1500;
const MAX_STEP = 30000;   // a longer gap between two checks is not counted
const SAVE_EVERY = 60000;
const BROWSERS = /^(chrome|edge|firefox|opera|brave|vivaldi|arc|yandex|zen)$/i;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const fresh = () => ({ v: 1, since: 0, days: {}, totals: {}, all: { ms: 0, plays: 0, s: {}, a: {} }, meta: {} });

function splitArtists(a) {
  return String(a || '').split(/\s*,\s+|\s+(?:feat\.?|ft\.?|featuring)\s+/i).map((x) => x.trim()).filter(Boolean);
}

// One stable identity per song, whatever player it comes from.
function identify(t) {
  const spotify = t.source === 'spotify' || /spotify/i.test(t.app || '');
  let title = t.title || '', artist = t.artist || '';
  if (!spotify) ({ title, artist } = cleanup(title, artist)); // "Artist - Song (Official Video)"
  title = title.trim(); artist = artist.trim();
  if (!title) return null;
  const artists = (Array.isArray(t.artists) && t.artists.length ? t.artists : splitArtists(artist)).slice(0, 6);
  const art = typeof t.art === 'string' && /^https:\/\//.test(t.art) && t.art.length < 400 ? t.art : null;
  return {
    key: `${norm(artist)}|${norm(title)}`,
    title, artist, artists, art,
    browser: !spotify && BROWSERS.test(String(t.appName || '').trim()),
    durationMs: t.durationMs || 0,
  };
}

function positionOf(t, now) {
  let p = t.positionMs || 0;
  if (t.isPlaying && t.sampledAt) p += now - t.sampledAt;
  return p;
}

class Stats {
  constructor(dir, { log = () => {}, readonly = false } = {}) {
    this.file = path.join(dir, 'stats.json');
    this.log = log;
    this.readonly = readonly;
    this.cur = null;
    this.lastTick = 0;
    this.dirty = false;
    this.saveTimer = null;
    this.data = this._load();
  }

  _load() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return fresh(); }
    try {
      const d = JSON.parse(raw);
      if (!d || d.v !== 1 || typeof d.days !== 'object') throw new Error('unknown format');
      const out = { ...fresh(), ...d, all: { ...fresh().all, ...(d.all || {}) } };
      this._prune(out, Date.now());
      return out;
    } catch (e) {
      // Keep the damaged file instead of silently losing it.
      try { fs.renameSync(this.file, this.file + '.bad'); } catch {}
      this.log('stats: could not read stats.json (' + e.message + ') — starting fresh, old file kept as stats.json.bad');
      return fresh();
    }
  }

  // ---- recording ----
  // Call with the song on screen (or null) whenever it may have changed, and every ~15 s.
  tick(t, { enabled = true, browsers = true } = {}, now = Date.now()) {
    const dt = now - this.lastTick;
    this.lastTick = now;
    const prev = this.cur;
    // The time since the last check belongs to what was playing then.
    if (prev && prev.playing && dt > 0 && dt <= MAX_STEP) this._add(prev, dt, now);

    const id = enabled && t ? identify(t) : null;
    if (!id || (id.browser && !browsers)) { this.cur = null; return; }
    const playing = !!t.isPlaying;
    const pos = positionOf(t, now);
    if (!prev || prev.key !== id.key) {
      this.cur = { ...id, playing, sessionMs: 0, counted: false, lastPos: pos };
      return;
    }
    // Same song started again from the top (repeat): a new play.
    if (prev.counted && pos < 5000 && prev.lastPos > 20000) { prev.sessionMs = 0; prev.counted = false; }
    prev.playing = playing;
    prev.lastPos = pos;
    if (id.art) prev.art = id.art;
    if (id.durationMs) prev.durationMs = id.durationMs;
    if (id.artists.length) prev.artists = id.artists;
  }

  _add(c, dt, now) {
    const d = new Date(now);
    const day = dayKey(d);
    const data = this.data;
    if (!data.since) data.since = now - dt;
    let D = data.days[day];
    if (!D) {
      D = data.days[day] = { ms: 0, plays: 0, h: new Array(24).fill(0), s: {}, a: {} };
      this._prune(data, now); // a new day started: drop what's too old
    }
    D.ms += dt;
    D.h[d.getHours()] += dt;
    data.totals[day] = D.ms;
    const ds = (D.s[c.key] ||= [0, 0]);
    const as = (data.all.s[c.key] ||= [0, 0]);
    ds[0] += dt; as[0] += dt;
    data.all.ms += dt;
    for (const name of c.artists) {
      D.a[name] = (D.a[name] || 0) + dt;
      data.all.a[name] = (data.all.a[name] || 0) + dt;
    }
    const prevArt = data.meta[c.key] && data.meta[c.key][2];
    data.meta[c.key] = [c.title, c.artist, c.art || prevArt || null];
    // A play counts after 30 s (or half of a very short song).
    c.sessionMs += dt;
    const need = c.durationMs ? Math.min(30000, Math.max(5000, c.durationMs / 2)) : 30000;
    if (!c.counted && c.sessionMs >= need) {
      c.counted = true;
      ds[1]++; as[1]++; D.plays++; data.all.plays++;
    }
    this.dirty = true;
    this._scheduleSave();
  }

  _prune(data, now) {
    const today = new Date(now);
    const cutDetail = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - DETAIL_DAYS));
    const cutTotal = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - TOTAL_DAYS));
    for (const k of Object.keys(data.days)) if (k < cutDetail) delete data.days[k];
    for (const k of Object.keys(data.totals)) if (k < cutTotal) delete data.totals[k];
    const trim = (map, max, val) => {
      const keys = Object.keys(map);
      if (keys.length <= max) return;
      keys.sort((x, y) => val(map[x]) - val(map[y]));
      for (const k of keys.slice(0, keys.length - Math.floor(max * 0.9))) delete map[k];
    };
    trim(data.all.s, MAX_SONGS, (v) => v[0]);
    trim(data.all.a, MAX_ARTISTS, (v) => v);
    // Song names are only kept while some count still uses them.
    const used = new Set(Object.keys(data.all.s));
    for (const D of Object.values(data.days)) for (const k of Object.keys(D.s)) used.add(k);
    for (const k of Object.keys(data.meta)) if (!used.has(k)) delete data.meta[k];
  }

  // ---- saving ----
  _scheduleSave() {
    if (this.saveTimer || this.readonly) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, SAVE_EVERY);
    this.saveTimer.unref?.();
  }

  save() {
    if (!this.dirty || this.readonly) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file); // never leaves a half-written file
      this.dirty = false;
    } catch (e) { this.log('stats save: ' + e.message); }
  }

  flush() { clearTimeout(this.saveTimer); this.saveTimer = null; this.save(); }

  reset() {
    this.data = fresh();
    this.cur = null;
    this.dirty = true;
    this.flush();
  }

  // ---- reading ----
  _dayMs(k) { return this.data.days[k]?.ms ?? this.data.totals[k] ?? 0; }

  summary(range = 'week', now = Date.now()) {
    const d = new Date(now);
    const y = d.getFullYear(), m = d.getMonth(), date = d.getDate();
    let keys = [], chart, elapsedDays = 1;
    if (range === 'today') {
      keys = [dayKey(d)];
      const D = this.data.days[keys[0]];
      chart = { values: D ? D.h.slice() : new Array(24).fill(0), labels: Array.from({ length: 24 }, (_, h) => String(h)), now: d.getHours(), unit: 'hour' };
    } else if (range === 'week') {
      const dow = (d.getDay() + 6) % 7; // Monday first
      for (let i = 0; i < 7; i++) keys.push(dayKey(new Date(y, m, date - dow + i)));
      chart = { values: keys.map((k) => this._dayMs(k)), labels: WEEKDAYS.slice(), now: dow, unit: 'day' };
      elapsedDays = dow + 1;
    } else if (range === 'month') {
      const n = new Date(y, m + 1, 0).getDate();
      for (let i = 1; i <= n; i++) keys.push(dayKey(new Date(y, m, i)));
      chart = { values: keys.map((k) => this._dayMs(k)), labels: keys.map((_, i) => String(i + 1)), now: date - 1, unit: 'day' };
      elapsedDays = date;
    } else {
      range = 'all';
      const values = [], labels = [];
      for (let i = 11; i >= 0; i--) {
        const first = new Date(y, m - i, 1);
        const prefix = `${first.getFullYear()}-${pad(first.getMonth() + 1)}-`;
        let sum = 0;
        for (const [k, v] of Object.entries(this.data.totals)) if (k.startsWith(prefix)) sum += v;
        values.push(sum); labels.push(MONTHS[first.getMonth()]);
      }
      chart = { values, labels, now: 11, unit: 'month' };
    }

    let totalMs = 0, plays = 0;
    const songs = new Map(), artists = new Map();
    if (range === 'all') {
      totalMs = this.data.all.ms; plays = this.data.all.plays;
      for (const [k, v] of Object.entries(this.data.all.s)) songs.set(k, [v[0], v[1]]);
      for (const [k, v] of Object.entries(this.data.all.a)) artists.set(k, v);
    } else {
      for (const k of keys) {
        const D = this.data.days[k];
        if (!D) { totalMs += this.data.totals[k] || 0; continue; }
        totalMs += D.ms; plays += D.plays || 0;
        for (const [sk, v] of Object.entries(D.s)) { const cur = songs.get(sk) || [0, 0]; cur[0] += v[0]; cur[1] += v[1]; songs.set(sk, cur); }
        for (const [ak, v] of Object.entries(D.a)) artists.set(ak, (artists.get(ak) || 0) + v);
      }
    }
    const meta = this.data.meta;
    const topSongs = [...songs.entries()]
      .filter(([, v]) => v[0] >= 10000)
      .sort((a, b) => b[1][1] - a[1][1] || b[1][0] - a[1][0])
      .slice(0, 10)
      .map(([k, v]) => {
        const mm = meta[k] || [];
        const [a, t] = k.split('|');
        return { title: mm[0] || t, artist: mm[1] || a, art: mm[2] || null, ms: v[0], plays: v[1] };
      });
    const topArtists = [...artists.entries()]
      .filter(([, v]) => v >= 10000)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, ms]) => ({ name, ms }));
    return {
      range, totalMs, plays,
      songs: songs.size, artists: artists.size,
      avgPerDayMs: range === 'week' || range === 'month' ? Math.round(totalMs / Math.max(1, elapsedDays)) : null,
      chart, topSongs, topArtists,
      since: this.data.since || null,
    };
  }
}

module.exports = { Stats, identify, dayKey };
