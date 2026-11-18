// Synced lyrics from LRCLIB (https://lrclib.net) — free, no API key.
// Spotify's own lyrics are not available through its public Web API.
const UA = 'NowPlayingPopup/1.0 (electron desktop widget)';
const cache = new Map(); // capped: a long listening session shouldn't grow memory forever
const MAX = 60;
function remember(k, v) { cache.set(k, v); if (cache.size > MAX) cache.delete(cache.keys().next().value); }

function parseLRC(lrc) {
  const out = [];
  for (const raw of (lrc || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) {
      const frac = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
      out.push({ t: Number(m[1]) * 60000 + Number(m[2]) * 1000 + frac, text });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// YouTube-style titles: "Artist - Song (Official Video) [4K]"
function cleanup(title, artist) {
  let t = (title || '')
    .replace(/\s*[([](official|lyrics?|lyric video|audio|video|music video|hd|4k|visualizer|live|remaster(ed)?[^)\]]*|explicit|clean)[^)\]]*[)\]]/gi, '')
    .replace(/\s*\|.*$/, '')
    .replace(/\s+(ft\.?|feat\.?)\s.*$/i, '')
    .trim();
  let a = (artist || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
  const dash = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) { a = dash[1].trim(); t = dash[2].trim(); }
  return { title: t, artist: a };
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`lyrics HTTP ${res.status}`);
  return res.json();
}

function pack(rec) {
  if (!rec) return null;
  const id = rec.id ?? null; // LRCLIB record id, so the picker can mark the one in use
  if (rec.instrumental) return { status: 'instrumental', synced: [], plain: '', id };
  const synced = parseLRC(rec.syncedLyrics);
  if (synced.length) return { status: 'found', synced, plain: rec.plainLyrics || '', id };
  if (rec.plainLyrics) return { status: 'found', synced: [], plain: rec.plainLyrics, id };
  return null;
}

// ---------- "Wrong lyrics?" picker ----------
// Other matches for a song (or for a search you typed), best first.
async function candidates({ title, artist, durationMs }, { clean = false, query = '' } = {}) {
  const q = clean ? cleanup(title, artist) : { title, artist };
  const firstArtist = (q.artist || '').split(/,\s*|\s+&\s+/)[0];
  const urls = query.trim()
    ? [`https://lrclib.net/api/search?${new URLSearchParams({ q: query.trim() })}`]
    : [
        `https://lrclib.net/api/search?${new URLSearchParams({ track_name: q.title || '', artist_name: firstArtist })}`,
        `https://lrclib.net/api/search?${new URLSearchParams({ q: `${firstArtist} ${q.title || ''}`.trim() })}`,
      ];
  const seen = new Map();
  for (const url of urls) {
    const data = await getJSON(url).catch(() => null);
    for (const r of Array.isArray(data) ? data : []) if (r && r.id != null && !seen.has(r.id)) seen.set(r.id, r);
    if (seen.size >= 12) break;
  }
  const dur = (durationMs || 0) / 1000;
  return [...seen.values()]
    .map((r) => ({
      id: r.id,
      title: r.trackName || r.name || '',
      artist: r.artistName || '',
      album: r.albumName || '',
      durationMs: Math.round((r.duration || 0) * 1000),
      synced: !!r.syncedLyrics,
      instrumental: !!r.instrumental,
      // closer length + synced first
      score: (r.syncedLyrics ? 0 : 60) + (dur ? Math.abs((r.duration || 0) - dur) : 0),
    }))
    .sort((a, b) => a.score - b.score)
    .slice(0, 12)
    .map(({ score, ...c }) => c);
}

// Lyrics for one specific LRCLIB record (the one you picked).
async function byId(id) {
  const key = `id:${id}`;
  if (cache.has(key)) return cache.get(key);
  const rec = await getJSON(`https://lrclib.net/api/get/${encodeURIComponent(id)}`);
  const result = pack(rec) || { status: 'none', synced: [], plain: '', id };
  remember(key, result);
  return result;
}

async function fetchLyrics({ title, artist, album, durationMs }, { clean = false } = {}) {
  let q = { title, artist };
  if (clean) q = cleanup(title, artist);
  if (!q.title) return { status: 'none', synced: [], plain: '' };
  const key = `${q.artist}|${q.title}|${Math.round((durationMs || 0) / 1000)}`.toLowerCase();
  if (cache.has(key)) return cache.get(key);

  let result = null;
  const firstArtist = (q.artist || '').split(/,\s*|\s+&\s+/)[0];
  const tries = [];
  if (durationMs) {
    tries.push(`https://lrclib.net/api/get?${new URLSearchParams({
      track_name: q.title, artist_name: firstArtist, album_name: album || '', duration: String(Math.round(durationMs / 1000)),
    })}`);
  }
  tries.push(`https://lrclib.net/api/search?${new URLSearchParams({ track_name: q.title, artist_name: firstArtist })}`);
  tries.push(`https://lrclib.net/api/search?${new URLSearchParams({ q: `${firstArtist} ${q.title}`.trim() })}`);

  for (const url of tries) {
    const data = await getJSON(url);
    if (!data) continue;
    if (Array.isArray(data)) {
      if (!data.length) continue;
      const dur = (durationMs || 0) / 1000;
      const scored = data
        .map((r) => ({ r, s: (r.syncedLyrics ? 0 : 1000) + (dur ? Math.abs((r.duration || 0) - dur) : 0) }))
        .sort((a, b) => a.s - b.s);
      if (dur && Math.abs((scored[0].r.duration || 0) - dur) > 12 && !clean) continue;
      result = pack(scored[0].r);
    } else {
      result = pack(data);
    }
    if (result) break;
  }
  result = result || { status: 'none', synced: [], plain: '' };
  remember(key, result);
  return result;
}

module.exports = { fetchLyrics, parseLRC, cleanup, candidates, byId };
