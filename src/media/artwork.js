// Fallback cover art when a player doesn't hand Windows a picture.
// Uses free, keyless catalogue searches (iTunes, then Deezer) and only accepts a
// result whose artist and title really match, so random videos don't get wrong covers.
const { cleanup } = require('./lyrics');

const cache = new Map(); // key -> url | null (capped, oldest dropped first)
const MAX = 200;
function remember(k, v) { cache.set(k, v); if (cache.size > MAX) cache.delete(cache.keys().next().value); }
const pending = new Map();

const norm = (s) => (s || '').toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/\(.*?\)|\[.*?\]/g, ' ')
  .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function similar(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

async function getJSON(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

async function itunes(artist, title) {
  const j = await getJSON(`https://itunes.apple.com/search?${new URLSearchParams({ term: `${artist} ${title}`, entity: 'song', limit: '10' })}`);
  const hit = (j?.results || []).find((r) => similar(r.artistName, artist) && similar(r.trackName, title));
  return hit?.artworkUrl100 ? hit.artworkUrl100.replace(/\/\d+x\d+bb\./, '/300x300bb.') : null;
}

async function deezer(artist, title) {
  const j = await getJSON(`https://api.deezer.com/search?${new URLSearchParams({ q: `${artist} ${title}`, limit: '10' })}`);
  const hit = (j?.data || []).find((r) => similar(r.artist?.name, artist) && similar(r.title, title));
  return hit?.album?.cover_medium || hit?.album?.cover_big || null; // 250 px is plenty for a 92 px tile
}

// Returns a URL or null. Never throws.
async function findArtwork(track) {
  if (!track?.title) return null;
  const c = cleanup(track.title, track.artist);
  const artist = (c.artist || '').split(/,\s*|\s+&\s+|\s+x\s+/i)[0];
  if (!artist || !c.title) return null;
  const key = `${norm(artist)}|${norm(c.title)}`;
  if (cache.has(key)) return cache.get(key);
  if (pending.has(key)) return pending.get(key);
  const p = (async () => {
    const url = (await itunes(artist, c.title)) || (await deezer(artist, c.title));
    remember(key, url || null);
    pending.delete(key);
    return url || null;
  })();
  pending.set(key, p);
  return p;
}

module.exports = { findArtwork };
