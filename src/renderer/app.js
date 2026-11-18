/* global np */
const $ = (id) => document.getElementById(id);
const shell = $('shell');

let settings = {};
let media = { track: null, sources: [] };
let lyrics = { status: 'idle', synced: [], plain: '' };
let claude = { sessions: [], found: false };
const openCards = new Set();
let lyricIdx = -1;
let userScrolledAt = 0;

// ---------- helpers ----------
const fmt = (ms) => {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
const ago = (t) => {
  const d = Math.max(0, Date.now() - t) / 1000;
  if (d < 10) return 'now';
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function position() {
  const t = media.track;
  if (!t) return 0;
  let p = t.positionMs || 0;
  if (t.isPlaying && t.sampledAt) p += Date.now() - t.sampledAt;
  if (t.durationMs) p = Math.min(p, t.durationMs);
  return Math.max(0, p);
}

// ---------- tabs ----------
function setTab(tab) {
  if (!['playing', 'claude', 'stats'].includes(tab)) tab = 'playing';
  closeSheet();
  shell.dataset.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (settings.tab !== tab) { settings.tab = tab; np.setSettings({ tab }); }
  if (tab === 'playing') { lyricIdx = -1; }
  if (tab === 'stats') loadStats();
  renderSpotifyExtras();
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

// ---------- window buttons ----------
$('closeBtn').onclick = () => np.hide();
$('pinBtn').onclick = () => np.pin(!settings.pinned);
$('settingsBtn').onclick = () => openSettings(true);
$('sizeBtn').onclick = () => np.setSettings({ large: !settings.large });
$('miniBtn').onclick = () => setMode('mini');
$('mmExpand').onclick = () => setMode('full');
$('mmClaude').onclick = () => { setTab('claude'); setMode('full'); };
$('mmPlay').onclick = () => { optimisticToggle(); np.control('toggle'); };
$('mmNext').onclick = () => np.control('next');
$('mmPrev').onclick = () => np.control('previous');
function setMode(mode) {
  if (mode === 'mini') closeSheet();
  shell.dataset.mode = mode;
  renderSpotifyExtras();
  lyricIdx = -1; needsTick = true; updateMiniLyricVisibility();
  if (settings.mode !== mode) { settings.mode = mode; np.setSettings({ mode }); }
}
$('logBtn').onclick = () => np.openLog();

$('settingsBack').onclick = () => openSettings(false);
np.onOpenSettings(() => openSettings(true));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheetKind && $('settings').hidden) { e.preventDefault(); closeSheet(); return; }
  if (document.activeElement && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return;
  if (e.key === 'Escape') { if (!$('settings').hidden) openSettings(false); else if (shell.dataset.mode !== 'mini') np.hide(); }
  if (e.key === '3') setTab('stats');
  if ((e.key === '/' || (e.ctrlKey && (e.key === 'f' || e.key === 'F'))) && media.spotify?.connected && shell.dataset.mode !== 'mini') { e.preventDefault(); setTab('playing'); openSearch(); return; }
  if (e.key === 'm' || e.key === 'M') setMode(shell.dataset.mode === 'mini' ? 'full' : 'mini');
  if (e.key === '[') setLyricsOffset(lyricsOffset() - 250);
  if (e.key === ']') setLyricsOffset(lyricsOffset() + 250);
  if (e.key === ' ') { e.preventDefault(); np.control('toggle'); }
  if (e.key === 'ArrowRight' && e.ctrlKey) np.control('next');
  if (e.key === 'ArrowLeft' && e.ctrlKey) np.control('previous');
  if (e.key === '1') setTab('playing');
  if (e.key === '2') setTab('claude');
});

// ---------- playback controls ----------
$('playBtn').onclick = () => { optimisticToggle(); np.control('toggle'); };
$('miniPlay').onclick = (e) => { e.stopPropagation(); optimisticToggle(); np.control('toggle'); };
$('nextBtn').onclick = () => np.control('next');
$('prevBtn').onclick = () => np.control('previous');
$('mini').onclick = () => setTab('playing');
$('bar').addEventListener('click', (e) => {
  const t = media.track;
  if (!t || !t.durationMs || !t.canSeek) return;
  const r = e.currentTarget.getBoundingClientRect();
  const pos = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * t.durationMs;
  t.positionMs = pos; t.sampledAt = Date.now();
  np.control('seek', pos);
});
function optimisticToggle() {
  const t = media.track;
  if (!t) return;
  t.positionMs = position(); t.sampledAt = Date.now();
  t.isPlaying = !t.isPlaying;
  renderPlayState();
}

// ---------- media rendering ----------
let lastArt = null;
// Blurred background without CSS filters: shrink the cover to 16 px on a canvas and
// let the browser stretch it smoothly. Costs nothing per frame (no GPU needed).
function paintBackdrop(img) {
  const c = $('bgArt');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!img) { c.classList.remove('on'); return; }
  try { ctx.drawImage(img, 0, 0, c.width, c.height); c.classList.add('on'); } catch { c.classList.remove('on'); }
}

function setArt(url) {
  if (url === lastArt) return;
  lastArt = url;
  if (!url) paintBackdrop(null);
  else {
    const probe = new Image();
    probe.onload = () => { if (lastArt === url) paintBackdrop(probe); };
    probe.src = url;
  }
  for (const img of [$('art'), $('miniArt'), $('mmArt')]) {
    img.classList.remove('on', 'err');
    if (url) {
      img.onerror = () => img.classList.add('err');
      img.onload = () => img.classList.add('on');
      img.src = url;
    } else {
      img.removeAttribute('src');
    }
  }
}

function renderPlayState() {
  const playing = !!media.track?.isPlaying;
  $('icoPlay').hidden = playing; $('icoPause').hidden = !playing;
  $('miniIcoPlay').hidden = playing; $('miniIcoPause').hidden = !playing;
  $('mmIcoPlay').hidden = playing; $('mmIcoPause').hidden = !playing;
  $('srcChip').classList.toggle('playing', playing);
}

function renderMedia() {
  const t = media.track;
  const chip = $('srcChip');
  chip.className = 'src';
  if (t) {
    $('title').textContent = t.title || 'Unknown title';
    $('artist').textContent = [t.artist, t.album].filter(Boolean).join(' · ') || ' ';
    chip.classList.add(t.source === 'spotify' || /spotify/i.test(t.app || '') ? 'spotify' : 'system');
    $('srcName').textContent = t.source === 'spotify' ? `Spotify${t.device ? ' · ' + t.device : ''}` : t.appName;
    $('miniTitle').textContent = t.title || 'Unknown title';
    $('mmTitle').textContent = t.title || 'Unknown title';
    $('mmArtist').textContent = t.artist || '';
    $('mmSrc').textContent = $('srcName').textContent;
    $('mmSrc').className = 'mm-src' + (chip.classList.contains('spotify') ? ' spotify' : '');
    $('miniArtist').textContent = t.artist || t.appName || '';
  } else {
    $('title').textContent = 'Nothing playing';
    const hint = !media.smtcAvailable && !media.spotify?.connected
      ? 'Connect Spotify in Settings to get started'
      : 'Play something in Spotify, a browser or any player';
    $('artist').textContent = hint;
    $('srcName').textContent = 'Idle';
    $('miniTitle').textContent = 'Nothing playing';
    $('mmTitle').textContent = 'Nothing playing'; $('mmArtist').textContent = ''; $('mmSrc').textContent = '';
    $('miniArtist').textContent = '';
  }
  if (!t || !t.hasArt) setArt(null);
  $('prevBtn').disabled = !t || t.canPrev === false;
  $('nextBtn').disabled = !t || t.canNext === false;
  $('playBtn').disabled = !t;
  $('mmPlay').disabled = !t;
  $('mmPrev').disabled = $('prevBtn').disabled; $('mmNext').disabled = $('nextBtn').disabled;
  $('progress').classList.toggle('noseek', !t?.canSeek);
  $('progress').classList.toggle('nodur', !t?.durationMs);
  renderPlayState();
  renderSources();
  renderLike();
  renderSpotifyExtras();
  renderUpNext();
  updateMiniLyricVisibility();
  renderVolume();
  applyAccent();
}

// ---------- appearance ----------
const LOOK_DEFAULTS = {
  theme: 'dark', accentMode: 'cover', accentColor: '#1ed760', background: 'cover', corners: 'round',
  uiScale: 1, layout: 'lyrics', lyricsSize: 'm', showUpNext: true, showSources: true, miniLyrics: true, outline: false,
};
const SWATCHES = ['#1ed760', '#d97757', '#5b8cff', '#a67cff', '#ff6fae', '#f0b44c', '#3fd6c6', '#f2f1ee'];
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');
function look(k) { return settings[k] ?? LOOK_DEFAULTS[k]; }
function applyAccent() {
  const t = media.track;
  const c = look('accentMode') === 'fixed' ? look('accentColor') : (t && t.accent) || '#1ed760';
  shell.style.setProperty('--np-accent', c);
}
function applyAppearance() {
  const root = document.documentElement.dataset;
  const theme = look('theme') === 'system' ? (darkScheme.matches ? 'dark' : 'light') : look('theme');
  if (root.theme !== theme) {
    // Switch colors instantly: no half-finished color transitions left behind.
    const html = document.documentElement;
    html.classList.add('theme-switch');
    root.theme = theme;
    void html.offsetWidth;
    requestAnimationFrame(() => requestAnimationFrame(() => html.classList.remove('theme-switch')));
  }
  root.bg = look('background');
  root.corners = look('corners');
  root.layout = look('layout');
  root.lysize = look('lyricsSize');
  root.upnext = look('showUpNext') ? 'on' : 'off';
  root.sources = look('showSources') ? 'on' : 'off';
  root.outline = look('outline') ? 'on' : 'off';
  applyAccent();
  updateMiniLyricVisibility();
  renderAppearanceControls();
}
darkScheme.addEventListener('change', () => { if (look('theme') === 'system') applyAppearance(); });
function saveLook(patch) {
  settings = { ...settings, ...patch };
  applyAppearance();
  np.setSettings(patch);
}
function renderAppearanceControls() {
  document.querySelectorAll('#appearance .seg[data-pref]').forEach((seg) => {
    const v = String(look(seg.dataset.pref));
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  });
  document.querySelectorAll('#appearance [data-pref-bool]').forEach((i) => { i.checked = !!look(i.dataset.prefBool); });
  const fixed = look('accentMode') === 'fixed';
  const cur = String(look('accentColor')).toLowerCase();
  const box = $('swatches');
  box.hidden = !fixed;
  if (document.activeElement && document.activeElement.id === 'customColor') return; // don't rebuild under an open color picker
  box.innerHTML = SWATCHES.map((c) => `<button class="swatch ${cur === c ? 'on' : ''}" style="--c:${c}" data-c="${c}" title="${c}"></button>`).join('')
    + `<label class="swatch custom ${!SWATCHES.includes(cur) ? 'on' : ''}" title="Pick any color"><input type="color" id="customColor" value="${esc(/^#[0-9a-f]{6}$/.test(cur) ? cur : '#1ed760')}" /></label>`;
  box.querySelectorAll('[data-c]').forEach((b) => { b.onclick = () => saveLook({ accentMode: 'fixed', accentColor: b.dataset.c }); });
  const cc = $('customColor');
  cc.oninput = () => { settings.accentMode = 'fixed'; settings.accentColor = cc.value; applyAccent(); }; // live preview
  cc.onchange = () => saveLook({ accentMode: 'fixed', accentColor: cc.value });
}
document.querySelectorAll('#appearance .seg[data-pref] button').forEach((b) => {
  b.onclick = () => {
    const pref = b.parentElement.dataset.pref;
    const v = pref === 'uiScale' ? Number(b.dataset.v) : b.dataset.v;
    saveLook({ [pref]: v });
  };
});
document.querySelectorAll('#appearance [data-pref-bool]').forEach((i) => { i.onchange = () => saveLook({ [i.dataset.prefBool]: i.checked }); });
$('resetLook').onclick = () => saveLook({ ...LOOK_DEFAULTS });

// ---------- volume ----------
let volLocalAt = 0, volSendTimer = null, volPending = null;
function volIcon(v, muted) {
  const silent = muted || v === 0;
  $('volMuteX').hidden = !silent;
  $('volWave1').style.display = silent ? 'none' : '';
  $('volWave2').style.display = silent || v < 50 ? 'none' : '';
}
function showVol(v) {
  const r = $('volRange');
  r.value = String(v);
  r.style.setProperty('--fill', v + '%');
  $('volVal').textContent = String(v);
}
function renderVolume() {
  const t = media.track;
  const can = !!(t && typeof t.volume === 'number');
  $('vol').classList.toggle('off', !can);
  if (!can) { $('volPop').hidden = true; $('vol').classList.remove('open'); return; }
  // Don't let a slightly old reading fight the slider while you're dragging it.
  if (Date.now() - volLocalAt > 1500) { showVol(t.volume); volIcon(t.volume, t.muted); }
  $('volBtn').title = `Volume ${t.volume}%${t.volumeVia === 'spotify' ? ' (Spotify device)' : ''} — scroll to change`;
}
function setVol(v) {
  v = Math.max(0, Math.min(100, Math.round(v)));
  volLocalAt = Date.now();
  if (media.track) { media.track.volume = v; media.track.muted = false; }
  showVol(v); volIcon(v, false);
  // At most ~16 updates a second while dragging; the last value always goes out.
  volPending = v;
  if (!volSendTimer) volSendTimer = setTimeout(() => { volSendTimer = null; if (volPending != null) { np.setVolume(volPending); volPending = null; } }, 60);
}
$('volBtn').onclick = (e) => {
  e.stopPropagation();
  const open = $('volPop').hidden;
  $('volPop').hidden = !open;
  $('vol').classList.toggle('open', open);
};
$('volRange').addEventListener('input', (e) => setVol(Number(e.target.value)));
for (const el of [$('volBtn'), $('volPop'), $('mmArt').parentElement]) {
  el.addEventListener('wheel', (e) => {
    const t = media.track;
    if (!t || typeof t.volume !== 'number') return;
    e.preventDefault();
    setVol(t.volume + (e.deltaY < 0 ? 5 : -5));
    if (el === $('mmArt').parentElement) el.title = `Volume ${media.track.volume}%`;
  }, { passive: false });
}
document.addEventListener('click', (e) => {
  if (!$('volPop').hidden && !$('vol').contains(e.target)) { $('volPop').hidden = true; $('vol').classList.remove('open'); }
});

// ---------- like ----------
function renderLike() {
  const t = media.track;
  const can = !!(t && t.source === 'spotify' && t.uri);
  const on = can && t.liked === true;
  const locked = can && t.canLike === false;
  for (const b of [$('likeBtn'), $('mmLike')]) {
    b.classList.toggle('on', on);
    b.classList.toggle('locked', locked);
    b.title = !can ? '' : locked ? 'Reconnect Spotify to like songs' : on ? 'Remove from Liked Songs' : 'Save to Liked Songs';
  }
  $('likeBtn').classList.toggle('off', !can);
  $('mmLike').hidden = !can;
}
async function toggleLike(btn) {
  const t = media.track;
  if (!t || t.source !== 'spotify' || !t.uri) return;
  if (t.canLike === false) { reconnectForLikes(); return; }
  t.liked = !t.liked; renderLike();
  btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop');
  const r = await np.spotifyLike();
  if (r && r.needsReconnect) reconnectForLikes();
  else if (r && !r.ok && r.error) alertBox(r.error);
}
async function reconnectForLikes() {
  alertBox('Liking songs needs one more Spotify permission — a Spotify login page will open.');
  const r = await np.spotifyConnect();
  if (r && r.status) media.spotify = r.status;
  if (r && !r.ok && r.error) alertBox(r.error);
}
$('likeBtn').onclick = (e) => toggleLike(e.currentTarget);
$('mmLike').onclick = (e) => { e.stopPropagation(); toggleLike(e.currentTarget); };

// ---------- up next (Spotify queue) ----------
let lastUpNextSig = '';
function renderUpNext() {
  const t = media.track;
  const q = (t && t.source === 'spotify' && t.upNext) || [];
  const sig = JSON.stringify(q);
  if (sig === lastUpNextSig) return;
  lastUpNextSig = sig;
  const box = $('upNext');
  box.hidden = !q.length;
  box.innerHTML = q.length ? '<span class="lbl">Up next</span>' + q.map((x) =>
    `<div class="q" title="${esc(x.title)} — ${esc(x.artist)}">${x.art ? `<img src="${esc(x.art)}" alt="" loading="lazy">` : '<i></i>'}<span>${esc(x.title)} <em>${esc(x.artist)}</em></span></div>`).join('') : '';
}

// ---------- mini player lyric line ----------
function miniLyricsOn() {
  return shell.dataset.mode === 'mini' && look('miniLyrics') && lyrics.status === 'found' && lyrics.synced.length > 0 && !!media.track;
}
function updateMiniLyricVisibility() {
  const on = miniLyricsOn();
  $('mmLyric').hidden = !on;
  $('mmSrc').hidden = on;
  if (!on) lastMiniLyric = null;
}
let lastMiniLyric = null;
function setMiniLyric(text) {
  updateMiniLyricVisibility();
  if (!miniLyricsOn()) return;
  text = (text || '').trim() || '♪';
  if (text === lastMiniLyric) return;
  lastMiniLyric = text;
  const box = $('mmLyric');
  const old = $('mmLyricText');
  const span = old.cloneNode(false);           // fresh node restarts the animations
  span.textContent = text;
  span.className = 'in';
  old.replaceWith(span);
  const overflow = span.scrollWidth - box.clientWidth;
  if (overflow > 4) {
    // Long line: slide it left once so the end becomes readable (~40 px/s).
    span.style.setProperty('--dist', `-${overflow + 12}px`);
    span.style.setProperty('--dur', `${Math.max(1.6, (overflow + 12) / 55)}s`);
    span.className = 'scroll';
  }
}

let lastSourcesSig = '';
function renderSources() {
  const box = $('sources');
  const sig = JSON.stringify([settings.preferredApp, settings.source, media.spotify?.connected, media.track?.source, media.track?.isPlaying, (media.sources || []).map((x) => [x.app, x.title, x.isPlaying])]);
  if (sig === lastSourcesSig) return;
  lastSourcesSig = sig;
  const items = [];
  const pref = settings.preferredApp;
  const srcMode = settings.source;
  items.push({ id: '__auto', label: 'Auto', active: !pref && srcMode === 'auto' });
  if (media.spotify?.connected) items.push({ id: '__spotify', label: 'Spotify account', active: !pref && srcMode === 'spotify', playing: media.track?.source === 'spotify' && media.track.isPlaying });
  for (const s of media.sources || []) {
    items.push({ id: s.app, label: `${s.appName}: ${s.title}`, active: pref === s.app, playing: s.isPlaying });
  }
  box.hidden = items.length <= 1;
  box.innerHTML = items.map((i) => `<button class="chip ${i.active ? 'active' : ''} ${i.playing ? 'playing' : ''}" data-id="${esc(i.id)}" title="${esc(i.label)}">${i.id === '__auto' ? '' : '<i></i>'}<span>${esc(i.label)}</span></button>`).join('');
  box.querySelectorAll('.chip').forEach((b) => b.onclick = () => {
    const id = b.dataset.id;
    if (id === '__auto') np.setSettings({ preferredApp: null, source: 'auto' });
    else if (id === '__spotify') np.setSettings({ preferredApp: null, source: 'spotify' });
    else np.setSettings({ preferredApp: id === settings.preferredApp ? null : id, source: 'auto' });
  });
}

// ---------- lyrics ----------
function renderLyrics() {
  const box = $('lyrics');
  const inner = $('lyricsInner');
  lyricIdx = -1;
  box.classList.remove('static');
  const t = media.track;
  const canSeek = !!t?.canSeek;

  if (!t) {
    box.classList.add('static');
    const connected = media.spotify?.connected;
    inner.innerHTML = `<div class="empty"><b>${connected ? 'Waiting for music' : 'No music yet'}</b>
      ${connected ? 'Start a song on Spotify or play a video, and it shows up here.' : 'Connect your Spotify account to see what you play and its synced lyrics. Other players (YouTube, VLC…) are picked up automatically.'}
      ${connected ? '' : '<button class="btn primary" id="emptyConnect">Connect Spotify</button>'}</div>`;
    const b = $('emptyConnect'); if (b) b.onclick = () => openSettings(true);
    return;
  }
  if (lyrics.status === 'off') {
    box.classList.add('static');
    inner.innerHTML = `<div class="empty"><b>${esc(t.appName)}</b>Lyrics are shown for Spotify. Turn on <i>“Try lyrics for every player”</i> in Settings to look them up for this one too.</div>`;
    return;
  }
  if (lyrics.status === 'hidden') {
    box.classList.add('static');
    inner.innerHTML = '<div class="empty"><b>Lyrics are off for this song</b>You turned them off for this one.<div class="row"><button class="btn ghost small" id="lyBack">Show lyrics again</button><button class="btn link small" id="lyPick">Pick other lyrics</button></div></div>';
    $('lyBack').onclick = () => chooseLyrics('auto');
    $('lyPick').onclick = () => openLyricsPicker();
    return;
  }
  if (lyrics.status === 'loading' || lyrics.status === 'idle') {
    box.classList.add('static');
    inner.innerHTML = '<div class="empty">Finding lyrics…</div>';
    return;
  }
  if (lyrics.status === 'instrumental') {
    box.classList.add('static');
    inner.innerHTML = '<div class="empty"><b>♪ Instrumental ♪</b></div>';
    return;
  }
  if (lyrics.status !== 'found') {
    box.classList.add('static');
    inner.innerHTML = `<div class="empty"><b>No lyrics found</b>${lyrics.status === 'error' ? 'Could not reach the lyrics service.' : 'This track has no lyrics in the LRCLIB database yet.'}<button class="btn ghost small" id="lySearch">Search for lyrics</button></div>`;
    $('lySearch').onclick = () => openLyricsPicker();
    return;
  }
  if (lyrics.synced.length) {
    inner.innerHTML = lyrics.synced.map((l, i) => l.text
      ? `<div class="ly ${canSeek ? 'seekable' : ''}" data-i="${i}" data-t="${l.t}">${esc(l.text)}</div>`
      : `<div class="ly blank" data-i="${i}" data-t="${l.t}"></div>`).join('')
      + '<div class="lyric-credit">Lyrics from LRCLIB</div>';
    if (canSeek) inner.querySelectorAll('.ly.seekable').forEach((el) => el.onclick = () => {
      const ms = Number(el.dataset.t);
      media.track.positionMs = ms; media.track.sampledAt = Date.now();
      np.control('seek', ms);
    });
    box.scrollTop = 0;
  } else {
    box.classList.add('static');
    inner.innerHTML = `<div class="plain">${esc(lyrics.plain)}</div><div class="lyric-credit">Unsynced lyrics · LRCLIB</div>`;
  }
}
$('lyrics').addEventListener('wheel', () => { userScrolledAt = Date.now(); }, { passive: true });

// ---------- lyrics timing nudge (remembered per song) ----------
function lyricsOffset() { return (settings.lyricsOffsets || {})[lyrics.key] || 0; }
let offSaveTimer = null;
function setLyricsOffset(ms) {
  if (!lyrics.key) return;
  ms = Math.max(-10000, Math.min(10000, Math.round(ms / 50) * 50));
  const map = { ...(settings.lyricsOffsets || {}) };
  delete map[lyrics.key];          // re-insert so it counts as most recently used
  if (ms) map[lyrics.key] = ms;
  const keys = Object.keys(map);
  for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete map[k]; // keep the last 300 songs
  settings.lyricsOffsets = map;
  renderSyncUI();
  lyricIdx = -1; needsTick = true; tick();
  clearTimeout(offSaveTimer);
  offSaveTimer = setTimeout(() => { offSaveTimer = null; np.setSettings({ lyricsOffsets: settings.lyricsOffsets }); }, 500);
}
function renderSyncUI() {
  renderLyFix();
  const box = $('lySync');
  const on = lyrics.status === 'found' && lyrics.synced.length > 0;
  box.hidden = !on;
  if (!on) return;
  const off = lyricsOffset();
  $('lyOff').textContent = (off > 0 ? '+' : off < 0 ? '−' : '') + (Math.abs(off) / 1000).toFixed(off % 1000 === 0 ? 1 : 2) + ' s';
  box.classList.toggle('shifted', off !== 0);
}
$('lyEarlier').onclick = () => setLyricsOffset(lyricsOffset() - 250);
$('lyLater').onclick = () => setLyricsOffset(lyricsOffset() + 250);
$('lyOff').onclick = () => setLyricsOffset(0);

function tickLyrics(pos) {
  if (lyrics.status !== 'found' || !lyrics.synced.length) return;
  const mini = shell.dataset.mode === 'mini';
  if (!mini && shell.dataset.tab !== 'playing') return;
  const L = lyrics.synced;
  let i = -1;
  // binary search for last line with t <= pos
  let lo = 0, hi = L.length - 1;
  const at = pos - lyricsOffset() + 150; // positive offset = lyrics later
  while (lo <= hi) { const m = (lo + hi) >> 1; if (L[m].t <= at) { i = m; lo = m + 1; } else hi = m - 1; }
  if (i === lyricIdx) return;
  lyricIdx = i;
  if (mini) { setMiniLyric(i >= 0 ? L[i].text : ''); return; }
  const els = $('lyricsInner').querySelectorAll('.ly');
  els.forEach((el, k) => { el.classList.toggle('now', k === i); el.classList.toggle('past', k < i); });
  if (i >= 0 && Date.now() - userScrolledAt > 4000) {
    const el = els[i];
    const box = $('lyrics');
    box.scrollTop = el.offsetTop - box.clientHeight * 0.38;
  }
}

// ---------- progress ticker ----------
// Updates the bar/time ~4x a second only while something plays and the window is visible
// (instead of redrawing at 60 fps forever).
let lastPct = -1, lastTime = '', lastDur = '', needsTick = true;
function tick() {
  if (document.hidden) return;
  const t = media.track;
  if (!needsTick && !t?.isPlaying) return;
  needsTick = false;
  const pos = position();
  const pct = t && t.durationMs ? Math.round((pos / t.durationMs) * 1000) / 10 : 0;
  if (pct !== lastPct) {
    lastPct = pct;
    const w = pct + '%';
    $('fill').style.width = w; $('knob').style.left = w; $('miniFill').style.width = w; $('mmFill').style.width = w;
  }
  const tp = fmt(pos), td = fmt(t?.durationMs || 0);
  if (tp !== lastTime) { lastTime = tp; $('tPos').textContent = tp; }
  if (td !== lastDur) { lastDur = td; $('tDur').textContent = td; }
  tickLyrics(pos);
}
setInterval(tick, 250);
document.addEventListener('visibilitychange', () => { needsTick = true; tick(); });

// ---------- claude ----------
let chats = { tasks: [], lastSeen: 0, listening: false };
const INSTRUCTION = 'When you work on a task with more than one step, use the Now Playing tools: call progress_update when you start (done=0 with your planned total) and after each step, call ask_user_alert right before you stop to ask me a question or need my decision, and call task_finished when you are done.';

// "about 4 min left": average time per finished step × steps left, minus time already spent on this one.
function etaText(msPerStep, lastStepAt, done, total) {
  if (!msPerStep || !lastStepAt || !total || done >= total) return '';
  const left = msPerStep * (total - done) - (Date.now() - lastStepAt);
  if (left < 45000) return 'almost done';
  const min = Math.round(left / 60000);
  if (min < 60) return `about ${Math.max(1, min)} min left`;
  return `about ${Math.floor(min / 60)} h ${min % 60} min left`;
}

function pbar(done, total, eta) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const e = eta && eta.ms ? ` data-ms="${eta.ms}" data-last="${eta.last}" data-done="${done}" data-total="${total}"` : '';
  const et = eta && eta.ms ? etaText(eta.ms, eta.last, done, total) : '';
  return `<div class="pbar"><div class="ptrack"><div class="pfill" style="width:${pct}%"></div></div><span class="pcount">${done}/${total}<span class="eta"${e}>${et ? ' · ' + et : ''}</span></span></div>`;
}

function chatCard(t) {
  const label = { working: 'Working', question: 'Needs your answer', done: 'Finished', idle: 'No updates for a while' }[t.status] || '';
  return `<div class="card ${t.status}" data-chat="${esc(t.id)}">
    <div class="card-top"><span class="sdot"></span><span class="proj">${esc(label)}</span><span class="ago" data-t="${t.updated}">${ago(t.updated)}</span></div>
    <div class="card-title">${esc(t.task)}</div>
    ${t.total ? pbar(t.done, t.total, t.status === 'working' ? { ms: t.msPerStep, last: t.lastStepAt } : null) : ''}
    ${t.step && t.status !== 'done' ? `<div class="step">Now: ${esc(t.step)}</div>` : ''}
    ${t.status === 'question' ? `<div class="qbox"><b>Claude asks</b>${esc(t.question)}</div>` : ''}
    ${t.status === 'done' && t.summary ? `<div class="summary">${esc(t.summary)}</div>` : ''}
    ${t.status === 'question' || t.status === 'done' || t.status === 'idle'
      ? `<div class="row-actions"><button class="btn ghost small" data-dismiss="${esc(t.id)}">${t.status === 'question' ? 'Got it' : 'Remove'}</button></div>` : ''}
  </div>`;
}

function codeCard(s) {
  const p = s.progress;
  const todos = (s.todos || []).map((t) => `<li class="${esc(t.status)}">${esc(t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content)}</li>`).join('');
  const isQ = s.status === 'question' || s.status === 'waiting';
  return `<div class="card ${s.status === 'waiting' ? 'question' : s.status} ${openCards.has(s.id) ? 'open' : ''}" data-id="${esc(s.id)}">
    <div class="card-top"><span class="sdot"></span><span class="proj">${esc(s.project)}</span>${s.branch ? `<span class="branch">${esc(s.branch)}</span>` : ''}<span class="ago" data-t="${s.updated}">${ago(s.updated)}</span></div>
    <div class="card-title">${esc(s.title)}</div>
    ${p ? pbar(p.done, p.total, s.status === 'working' ? { ms: s.msPerStep, last: s.lastStepAt } : null) : ''}
    ${s.currentStep && s.status !== 'done' && !isQ ? `<div class="step">Now: ${esc(s.currentStep)}</div>` : ''}
    ${isQ ? `<div class="qbox"><b>${s.status === 'waiting' ? 'Needs approval' : 'Claude asks'}</b>${esc(s.activity)}</div>`
      : s.activity ? `<div class="act"><span class="lbl">${esc(s.activity)}</span></div>` : ''}
    ${todos ? `<ul class="todos">${todos}</ul>` : ''}
    ${s.lastText ? `<div class="lasttext">${esc(s.lastText)}</div>` : ''}
    ${s.cwd ? `<div class="card-actions"><button class="btn ghost small" data-open="${esc(s.cwd)}">Open folder</button></div>` : ''}
  </div>`;
}

let desk = null;
function setupCard() {
  return `<div class="setup"><h4>Connect your Claude chats</h4>
    Claude will report its progress here and you'll get a notification when it asks you something.
    <ol>
      <li><b>Get the plugin</b> — saved to your Downloads folder.<br><button class="btn primary clau small" data-act="install">Get Claude plugin</button></li>
      <li><b>Upload it in Claude</b> — Customize → Plugins → <i>Upload a plugin</i> → drop <i>Now Playing - Claude plugin.zip</i>. Then restart Claude.</li>
      <li>Optional: <button class="btn ghost small" data-act="copy">Copy instruction</button> into Claude's personal preferences.</li>
    </ol>
    ${bridgeTestLine()}
    <button class="btn link small" data-act="test">Send a test alert</button></div>`;
}
function bridgeTestLine() {
  const t = desk?.test;
  if (!t || t.state === 'not run' || t.state === 'skipped') return '';
  if (t.state === 'running') return '<div class="testline">Checking the connector…</div>';
  if (t.state === 'ok') return '<div class="testline ok">Connector self-test passed ✓</div>';
  return `<div class="testline err">Connector self-test: ${esc(t.state)}${t.error ? ' — ' + esc(t.error) : ''}. Open Settings → debug log and send it to Claude.</div>`;
}

function renderClaude() {
  const list = $('claudeList');
  const ss = claude.sessions || [];
  const ts = chats.tasks || [];
  const qCount = ts.filter((t) => t.status === 'question').length + ss.filter((s) => s.status === 'question' || s.status === 'waiting').length;
  const working = ts.filter((t) => t.status === 'working').length + ss.filter((s) => s.status === 'working').length;

  const badge = $('claudeBadge');
  badge.hidden = !(qCount + working);
  badge.textContent = qCount || working;
  badge.classList.toggle('q', qCount > 0);
  const tab = document.querySelector('.tab[data-tab="claude"]');
  tab.classList.toggle('working', working > 0 && !qCount);
  tab.classList.toggle('question', qCount > 0);
  $('mmClaude').classList.toggle('working', working > 0 && !qCount);
  $('mmClaude').classList.toggle('question', qCount > 0);
  $('mmClaudeN').textContent = qCount ? '?' : working ? String(working) : '';
  $('mmClaude').title = qCount ? 'Claude has a question' : working ? 'Claude is working' : 'Claude';

  const parts = [];
  if (qCount) parts.push(`${qCount} need${qCount === 1 ? 's' : ''} your answer`);
  if (working) parts.push(`${working} working`);
  $('claudeSub').textContent = parts.join(' · ') || (ts.length || ss.length ? 'All quiet' : 'Waiting for updates…');
  $('clearDone').hidden = !ts.some((t) => t.status === 'done' || t.status === 'idle');

  let html = '';
  if (ts.length) html += `<div class="section">Chats</div>` + ts.map(chatCard).join('');
  else if (!chats.lastSeen) html += setupCard();
  else html += `<div class="empty" style="height:auto;padding:18px">No active chats right now. Claude adds a card here when it starts a multi-step task.</div>`;
  if (ss.length) html += `<div class="section">Claude Code</div>` + ss.map(codeCard).join('');
  list.innerHTML = html;

  list.querySelectorAll('[data-dismiss]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); np.dismissChat(b.dataset.dismiss); });
  list.querySelectorAll('[data-open]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); np.openPath(b.dataset.open); });
  list.querySelectorAll('[data-act]').forEach((b) => b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); setupAction(b.dataset.act, b); });
  list.querySelectorAll('.card[data-id]').forEach((c) => c.onclick = () => {
    const id = c.dataset.id;
    if (openCards.has(id)) openCards.delete(id); else openCards.add(id);
    c.classList.toggle('open');
  });
}

function alertBox(msg) { const d = document.createElement('div'); d.className = 'toast'; d.textContent = msg; document.body.appendChild(d); setTimeout(() => d.remove(), 6000); }
async function setupAction(act, el) {
  if (act === 'install') { const t = el.textContent; await np.installBridge(); el.textContent = 'Saved to Downloads ✓'; setTimeout(() => (el.textContent = t), 3000); }
  if (act === 'copy') { await navigator.clipboard.writeText(INSTRUCTION); const t = el.textContent; el.textContent = 'Copied ✓'; setTimeout(() => (el.textContent = t), 1500); }
  if (act === 'test') np.testAlert();
  if (act === 'connect') {
    el.textContent = 'Connecting…'; el.disabled = true;
    const r = await np.desktopConnect();
    if (r.ok) { desk = r.status; el.textContent = 'Connected ✓ — now restart Claude'; }
    else { el.disabled = false; el.textContent = 'Connect to Claude'; alertBox(r.error); }
    renderClaude(); renderBridgeStatus();
  }
}

$('clearDone').onclick = () => np.clearChats();
setInterval(() => {
  if (document.hidden || shell.dataset.tab !== 'claude' || shell.dataset.mode === 'mini') return;
  document.querySelectorAll('.ago[data-t]').forEach((el) => (el.textContent = ago(Number(el.dataset.t))));
  document.querySelectorAll('.eta[data-ms]').forEach((el) => {
    const t = etaText(Number(el.dataset.ms), Number(el.dataset.last), Number(el.dataset.done), Number(el.dataset.total));
    el.textContent = t ? ' · ' + t : '';
  });
}, 5000);

// ---------- settings ----------
function openSettings(open) {
  $('settings').hidden = !open;
  if (open) fillSettings();
}

function fillSettings() {
  $('spClientId').value = settings.spotifyClientId || '';
  $('spRedirect').value = media.spotify?.redirectUri || `http://127.0.0.1:${settings.spotifyPort || 8888}/callback`;
  $('source').value = settings.source || 'auto';
  $('lyricsForAll').checked = !!settings.lyricsForAll;
  np.hotkeyStatus().then((st) => { hkStatus = { ...(st || {}), hotkey: settings.hotkeyOk }; renderShortcuts(); });
  renderShortcuts();
  $('miniOpacity').value = String(Math.round((settings.miniOpacity || 1) * 100));
  $('miniOpVal').textContent = $('miniOpacity').value + '%';
  $('clickThrough').checked = !!settings.clickThrough;
  $('pinned').checked = !!settings.pinned;
  $('launchAtStartup').checked = !!settings.launchAtStartup;
  $('claudeDir').value = settings.claudeDir || '';
  $('notifyQuestions').checked = settings.notifyQuestions !== false;
  $('popupOnQuestion').checked = settings.popupOnQuestion !== false;
  $('notifyDone').checked = settings.notifyDone !== false;
  $('freeMemory').checked = settings.freeMemory !== false;
  $('autoDownload').checked = settings.autoDownload !== false;
  renderUpdate();
  renderBridgeStatus();
  $('claudeLookbackHours').value = String(settings.claudeLookbackHours || 12);
  renderSpotifyStatus();
  renderDiag();
  renderDlControls();
}

function renderDiag() {
  const d = media.smtcInfo;
  const el = $('mediaDiag');
  if (!el) return;
  if (!media.smtcAvailable) { el.textContent = 'Windows media players: not available on this system'; return; }
  if (!d || !d.running) { el.textContent = `Windows media players: starting…${media.smtcError ? ' (' + media.smtcError.slice(0, 120) + ')' : ''}`; el.className = 'status-line' + (media.smtcError ? ' warn' : ''); return; }
  el.className = 'status-line';
  el.textContent = `Windows media players: ${d.count} found · pictures: ${d.thumbErr ? 'problem (' + d.thumbErr.slice(0, 90) + ')' : 'OK'}`;
}

function renderSpotifyStatus(err) {
  const sp = media.spotify || {};
  const el = $('spStatus');
  el.className = 'status-line';
  if (err) { el.textContent = err; el.classList.add('err'); }
  else if (sp.connected) {
    el.textContent = `Connected${sp.user ? ' as ' + sp.user.name : ''}${sp.user?.product && sp.user.product !== 'premium' ? ' · controls need Premium' : ''}`;
    el.classList.add('ok');
    if (sp.error) { el.textContent += ` — ${sp.error}`; el.classList.replace('ok', 'warn'); }
  } else { el.textContent = sp.error || 'Not connected'; if (sp.error) el.classList.add('err'); }
  $('spConnect').hidden = !!sp.connected;
  $('spDisconnect').hidden = !sp.connected;
}

$('spClientId').addEventListener('change', (e) => np.setSettings({ spotifyClientId: e.target.value.trim() }));
$('copyRedirect').onclick = () => { navigator.clipboard.writeText($('spRedirect').value); $('copyRedirect').textContent = 'Copied'; setTimeout(() => ($('copyRedirect').textContent = 'Copy'), 1200); };
$('spHelp').onclick = () => { $('spHelpText').hidden = !$('spHelpText').hidden; };
document.querySelectorAll('[data-url]').forEach((a) => a.onclick = (e) => { e.preventDefault(); np.openExternal(a.dataset.url); });
$('spConnect').onclick = async () => {
  await np.setSettings({ spotifyClientId: $('spClientId').value.trim() });
  $('spConnect').disabled = true;
  $('spConnect').textContent = 'Waiting for browser…';
  const r = await np.spotifyConnect();
  $('spConnect').disabled = false;
  $('spConnect').textContent = 'Connect Spotify';
  if (r.status) media.spotify = r.status;
  renderSpotifyStatus(r.ok ? null : r.error);
};
$('spDisconnect').onclick = async () => { media.spotify = await np.spotifyDisconnect(); renderSpotifyStatus(); };
$('source').onchange = (e) => np.setSettings({ source: e.target.value, preferredApp: null });
$('lyricsForAll').onchange = (e) => np.setSettings({ lyricsForAll: e.target.checked });
$('pinned').onchange = (e) => np.pin(e.target.checked);
$('launchAtStartup').onchange = (e) => np.setSettings({ launchAtStartup: e.target.checked });
$('claudeDir').addEventListener('change', (e) => np.setSettings({ claudeDir: e.target.value.trim() }));
$('claudeLookbackHours').onchange = (e) => np.setSettings({ claudeLookbackHours: Number(e.target.value) });
$('quitBtn').onclick = () => np.quit();
$('notifyQuestions').onchange = (e) => np.setSettings({ notifyQuestions: e.target.checked });
$('popupOnQuestion').onchange = (e) => np.setSettings({ popupOnQuestion: e.target.checked });
$('notifyDone').onchange = (e) => np.setSettings({ notifyDone: e.target.checked });
$('freeMemory').onchange = (e) => np.setSettings({ freeMemory: e.target.checked });
$('autoDownload').onchange = (e) => np.setSettings({ autoDownload: e.target.checked });

// ---------- updates ----------
let upd = { status: 'idle' };
function renderUpdate() {
  const st = upd || {};
  const el = $('updStatus');
  el.className = 'status-line';
  const v = st.current ? `v${st.current}` : '';
  const text = {
    off: `${v} · updates not set up`,
    idle: `${v}`,
    checking: `${v} · checking…`,
    'up-to-date': `${v} · up to date`,
    available: `v${st.latest} is available${st.error ? ' — ' + st.error : ''}`,
    downloading: `Downloading v${st.latest}… ${st.progress || 0}%`,
    ready: `v${st.latest} downloaded — restart to update`,
    error: `${v} · couldn't check: ${st.error || 'unknown error'}`,
  }[st.status] || v;
  el.textContent = text;
  if (st.status === 'ready' || st.status === 'up-to-date') el.classList.add('ok');
  if (st.status === 'error') el.classList.add('warn');
  $('updApply').hidden = st.status !== 'ready';
  $('updCheck').disabled = st.status === 'checking' || st.status === 'downloading';
  const b = $('updBanner');
  b.hidden = st.status !== 'ready';
  if (st.status === 'ready') b.textContent = st.migrate
    ? `Faster start: switch to the installed version — click to restart`
    : `Update v${st.latest} is ready — click to restart`;
  if (st.status === 'ready' && st.migrate) el.textContent = 'Installed version ready — restart to switch (starts faster).';
}
$('updCheck').onclick = async () => { upd = (await np.updateCheck()) || upd; renderUpdate(); };
$('updApply').onclick = () => np.updateApply();
$('updBanner').onclick = () => np.updateApply();
np.onUpdate((st) => { upd = st; renderUpdate(); });
$('installBridge').onclick = (e) => setupAction('install', e.currentTarget);
$('copyInstr').onclick = (e) => setupAction('copy', e.currentTarget);
$('testAlert').onclick = () => np.testAlert();
function renderBridgeStatus() {
  const el = $('bridgeStatus');
  el.className = 'status-line';
  $('installBridge').textContent = 'Get Claude plugin';
  $('bridgeTest').innerHTML = bridgeTestLine();
  if (!chats.listening) { el.textContent = chats.error ? `Can't listen for Claude: ${chats.error}` : 'Starting…'; if (chats.error) el.classList.add('err'); return; }
  if (chats.lastSeen) { el.textContent = `Claude connected · last update ${ago(chats.lastSeen)}`; el.classList.add('ok'); }
  else el.textContent = 'Not connected yet — upload the plugin in Claude, then start a task.';
}

// ---------- shortcuts ----------
const SHORTCUTS = [
  ['hotkey', 'Show / hide pop-up'],
  ['playPause', 'Play / pause'],
  ['next', 'Next song'],
  ['previous', 'Previous song'],
  ['volUp', 'Volume up'],
  ['volDown', 'Volume down'],
  ['clickThrough', 'Mini player click-through'],
  ['desktopLyrics', 'Desktop lyrics on / off'],
];
const SUGGESTED = {
  playPause: 'CommandOrControl+Alt+Space',
  next: 'CommandOrControl+Alt+PageDown',
  previous: 'CommandOrControl+Alt+PageUp',
  volUp: 'CommandOrControl+Alt+=',   // not Ctrl+Alt+arrows: some laptops rotate the screen with those
  volDown: 'CommandOrControl+Alt+-',
};
let hkStatus = {};
function prettyHotkey(h) {
  return (h || '').replace('CommandOrControl', 'Ctrl').replace('Super', 'Win').replace(/\+/g, ' + ')
    .replace('PageDown', 'Page Down').replace('PageUp', 'Page Up');
}
function currentAccel(name) { return name === 'hotkey' ? settings.hotkey : (settings.mediaHotkeys || {})[name]; }
async function saveAccel(name, accel) {
  const patch = name === 'hotkey' ? { hotkey: accel } : { mediaHotkeys: { ...(settings.mediaHotkeys || {}), [name]: accel } };
  const r = await np.setSettings(patch);
  settings = { ...settings, ...r };
  hkStatus = { ...(r.hotkeyStatus || {}), hotkey: r.hotkeyOk };
  renderShortcuts();
}
// Turn a key press into an Electron accelerator ("CommandOrControl+Alt+Space").
function accelFromEvent(e) {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  const c = e.code;
  const map = { Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', PageUp: 'PageUp', PageDown: 'PageDown',
    Home: 'Home', End: 'End', Insert: 'Insert', Delete: 'Delete', Equal: '=', Minus: '-', Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
    BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Backquote: '`', NumpadAdd: 'numadd', NumpadSubtract: 'numsub',
    MediaPlayPause: 'MediaPlayPause', MediaTrackNext: 'MediaNextTrack', MediaTrackPrevious: 'MediaPreviousTrack' };
  let key = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^Digit\d$/.test(c) ? c.slice(5) : /^Numpad\d$/.test(c) ? 'num' + c.slice(6) : /^F\d{1,2}$/.test(c) ? c : map[c];
  if (!key) return null;
  // Global shortcuts need a modifier, except F-keys and media keys.
  if (!mods.length && !/^F\d{1,2}$|^Media/.test(key)) return null;
  return [...mods, key].join('+');
}
function renderShortcuts() {
  const box = $('hkList');
  box.innerHTML = SHORTCUTS.map(([name, label]) => {
    const accel = currentAccel(name);
    const bad = accel && hkStatus[name] === false;
    return `<div class="hk-row" data-name="${name}"><span>${esc(label)}</span>
      <input readonly class="${bad ? 'bad' : ''}" value="${esc(accel ? prettyHotkey(accel) : 'Not set')}" />
      <button class="x" title="Remove" ${accel ? '' : 'hidden'}>×</button>
      ${bad ? '<span class="taken">Taken by another app or shortcut — pick another.</span>' : ''}</div>`;
  }).join('');
  box.querySelectorAll('.hk-row').forEach((row) => {
    const name = row.dataset.name;
    const input = row.querySelector('input');
    input.onfocus = () => { input.classList.add('rec'); input.value = 'Press keys… (Esc to cancel)'; };
    input.onblur = () => { input.classList.remove('rec'); const a = currentAccel(name); input.value = a ? prettyHotkey(a) : 'Not set'; };
    input.onkeydown = (e) => {
      e.preventDefault();
      if (e.key === 'Escape') { input.blur(); return; }
      const accel = accelFromEvent(e);
      if (!accel) return;
      input.blur();
      saveAccel(name, accel);
    };
    row.querySelector('.x').onclick = () => saveAccel(name, '');
  });
}
$('hkSuggest').onclick = async () => {
  const cur = settings.mediaHotkeys || {};
  const next = { ...cur };
  for (const [k, v] of Object.entries(SUGGESTED)) if (!next[k]) next[k] = v;
  const r = await np.setSettings({ mediaHotkeys: next });
  settings = { ...settings, ...r };
  hkStatus = { ...(r.hotkeyStatus || {}), hotkey: r.hotkeyOk };
  renderShortcuts();
};

// ---------- mini player options ----------
let opTimer = null;
$('miniOpacity').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('miniOpVal').textContent = v + '%';
  clearTimeout(opTimer);
  settings.miniOpacity = v / 100; applyMiniLook(); // instant preview
  opTimer = setTimeout(() => np.setSettings({ miniOpacity: v / 100 }), 150);
});
$('clickThrough').onchange = (e) => np.setSettings({ clickThrough: e.target.checked });
// Click-through: holding Ctrl while the mouse is over the mini player makes it clickable.
let interactive = false;
document.addEventListener('mousemove', (e) => {
  if (shell.dataset.mode !== 'mini' || !settings.clickThrough) return;
  if (e.ctrlKey !== interactive) { interactive = e.ctrlKey; np.setInteractive(interactive); shell.classList.toggle('ct-live', interactive); }
});
document.addEventListener('mouseleave', () => { if (interactive) { interactive = false; np.setInteractive(false); shell.classList.remove('ct-live'); } });

// ---------- icons used by the panels ----------
const ICON = {
  check: '<svg class="chk" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z" class="fillsvg" /></svg>',
  queue: '<svg viewBox="0 0 24 24"><path d="M4 6h11M4 11h11M4 16h6M15 14.5l5 3-5 3z" /></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>',
};
const DEV_ICON = {
  Computer: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="11.5" rx="1.6" /><path d="M8.5 20h7M12 16v4" /></svg>',
  Smartphone: '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.2" /><path d="M11 18.5h2" /></svg>',
  Tablet: '<svg viewBox="0 0 24 24"><rect x="4.5" y="2.5" width="15" height="19" rx="2.2" /><path d="M11 18.5h2" /></svg>',
  Speaker: '<svg viewBox="0 0 24 24"><rect x="5.5" y="2.5" width="13" height="19" rx="2.2" /><circle cx="12" cy="14.5" r="3.2" /><path d="M12 7h.01" /></svg>',
  TV: '<svg viewBox="0 0 24 24"><rect x="2.5" y="4.5" width="19" height="12.5" rx="1.6" /><path d="M8 21h8" /></svg>',
  Automobile: '<svg viewBox="0 0 24 24"><path d="M5 16.5V12l2-5h10l2 5v4.5M3.5 12h17M5 16.5h14" /><circle cx="7.5" cy="18" r="1.6" /><circle cx="16.5" cy="18" r="1.6" /></svg>',
  GameConsole: '<svg viewBox="0 0 24 24"><path d="M7 8h10a4 4 0 0 1 4 4v1a3.5 3.5 0 0 1-6.3 2.1L14 14h-4l-.7 1.1A3.5 3.5 0 0 1 3 13v-1a4 4 0 0 1 4-4zM8 10.5v3M6.5 12h3M16 11.5h.01M17.5 13h.01" /></svg>',
};
DEV_ICON.CastAudio = DEV_ICON.Speaker; DEV_ICON.AVR = DEV_ICON.Speaker; DEV_ICON.AudioDongle = DEV_ICON.Speaker;
DEV_ICON.CastVideo = DEV_ICON.TV; DEV_ICON.STB = DEV_ICON.TV;
const DEV_TYPE = { Computer: 'Computer', Smartphone: 'Phone', Tablet: 'Tablet', Speaker: 'Speaker', TV: 'TV', CastAudio: 'Cast speaker', CastVideo: 'Cast device', Automobile: 'Car', GameConsole: 'Game console', AVR: 'Receiver', STB: 'TV box', AudioDongle: 'Audio adapter' };

// ---------- panel (slides up over the Playing tab) ----------
let sheetKind = null;
function openSheet(kind, title, full = false) {
  sheetKind = kind;
  $('sheetTitle').textContent = title;
  $('sheet').classList.toggle('full', full);
  $('sheetWrap').hidden = false;
  const body = $('sheetBody');
  body.innerHTML = '';
  body.scrollTop = 0;
  return body;
}
function closeSheet() {
  if (!sheetKind) return;
  sheetKind = null;
  $('sheetWrap').hidden = true;
  $('sheetBody').innerHTML = '';
}
$('sheetClose').onclick = closeSheet;
$('sheetDim').onclick = closeSheet;
const sheetMsg = (title, text, cls = '') => `<div class="sheet-msg ${cls}">${title ? `<b>${esc(title)}</b>` : ''}${text ? `<span>${esc(text)}</span>` : ''}</div>`;
function note(msg) {
  document.querySelectorAll('.toast.ok').forEach((x) => x.remove());
  const d = document.createElement('div');
  d.className = 'toast ok'; d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 2800);
}
function showReconnect(body, why) {
  body.innerHTML = `<div class="sheet-msg"><b>One more Spotify permission</b><span>${esc(why)} A Spotify login page opens in your browser.</span><button class="btn primary" id="rcBtn">Reconnect Spotify</button></div>`;
  $('rcBtn').onclick = async () => {
    const b = $('rcBtn'); b.disabled = true; b.textContent = 'Waiting for the browser…';
    const r = await np.spotifyConnect();
    if (r && r.status) media.spotify = r.status;
    closeSheet();
    if (r && !r.ok && r.error) alertBox(r.error); else note('Spotify reconnected');
  };
}

// The Spotify-only buttons (playlist, devices, search) follow what's playing.
function renderSpotifyExtras() {
  const t = media.track;
  const fromAccount = !!(t && t.source === 'spotify');
  $('plBtn').classList.toggle('off', !(fromAccount && t.uri));
  $('devBtn').classList.toggle('off', !fromAccount);
  $('devBtn').title = fromAccount && t.device ? `Playing on ${t.device} — switch device` : 'Play on another device';
  $('searchBtn').hidden = !media.spotify?.connected || shell.dataset.tab !== 'playing' || shell.dataset.mode === 'mini';
}

// ---------- move music between devices ----------
async function openDevices() {
  const body = openSheet('devices', 'Play on');
  body.innerHTML = sheetMsg('', 'Looking for your devices…');
  const r = await np.spotifyDevices();
  if (sheetKind !== 'devices') return;
  if (!r || !r.ok) { body.innerHTML = sheetMsg("Couldn't load your devices", r?.error || 'Try again in a moment.', 'err'); return; }
  const list = r.devices || [];
  if (!list.length) { body.innerHTML = sheetMsg('No devices found', 'Open Spotify on your PC, phone or speaker and it shows up here.'); return; }
  body.innerHTML = list.map((d) => `<button class="row-btn ${d.active ? 'on' : ''}" data-id="${esc(d.id)}" ${d.restricted ? 'disabled' : ''}>
      <span class="row-ico">${DEV_ICON[d.type] || DEV_ICON.Speaker}</span>
      <span class="row-main"><span class="row-title">${esc(d.name)}</span><span class="row-sub">${d.active ? 'Playing here now' : d.restricted ? "Spotify doesn't allow controlling this one" : esc(DEV_TYPE[d.type] || 'Spotify device')}</span></span>
      ${d.active ? ICON.check : ''}</button>`).join('')
    + '<div class="sheet-note">Only devices with Spotify open show up. Switching needs Spotify Premium.</div>';
  body.querySelectorAll('.row-btn[data-id]').forEach((b) => b.onclick = async () => {
    const d = list.find((x) => x.id === b.dataset.id);
    if (!d || d.active) { closeSheet(); return; }
    const sub = b.querySelector('.row-sub');
    b.classList.add('busy'); sub.textContent = 'Switching…';
    const res = await np.spotifyTransfer(d.id);
    if (sheetKind !== 'devices') return;
    if (res && res.ok) { closeSheet(); note(`Playing on ${d.name}`); return; }
    b.classList.remove('busy');
    sub.textContent = res?.error || "Couldn't switch to this device";
    sub.style.color = 'var(--warn)';
  });
}
$('devBtn').onclick = () => openDevices();

// ---------- add the current song to a playlist ----------
const addedTo = new Set(); // "playlist|song" added during this session
async function openPlaylists(force = false) {
  const t = media.track;
  if (!t || t.source !== 'spotify' || !t.uri) return;
  const uri = t.uri, songTitle = t.title || 'This song';
  const body = openSheet('playlists', 'Add to playlist');
  body.innerHTML = sheetMsg('', 'Loading your playlists…');
  const r = await np.spotifyPlaylists(force);
  if (sheetKind !== 'playlists') return;
  if (r && r.needsReconnect) { showReconnect(body, 'Adding songs to playlists needs a new permission.'); return; }
  if (!r || !r.ok) { body.innerHTML = sheetMsg("Couldn't load your playlists", r?.error || 'Try again in a moment.', 'err'); return; }
  const items = [...(r.items || [])];
  const last = items.findIndex((p) => p.id === settings.lastPlaylist);
  if (last > 0) items.unshift(items.splice(last, 1)[0]); // the one you used last comes first
  if (!items.length) { body.innerHTML = sheetMsg('No playlists to add to', 'Songs can go into playlists you made or collaborate on. Create one in Spotify first.'); return; }
  body.innerHTML = `<div class="row-sub" style="padding:0 8px 8px">${esc(songTitle)}${t.artist ? ' · ' + esc(t.artist) : ''}</div>`
    + (items.length > 7 ? `<div class="search-bar">${ICON.search}<input id="plFilter" placeholder="Find a playlist" spellcheck="false" autocomplete="off" /></div>` : '')
    + '<div id="plList"></div><button class="btn link small" id="plRefresh" style="margin:6px 4px 0">Refresh list</button>';
  const draw = (q) => {
    q = (q || '').trim().toLowerCase();
    const shown = q ? items.filter((p) => p.name.toLowerCase().includes(q)) : items;
    $('plList').innerHTML = shown.length ? shown.map((p) => {
      const done = addedTo.has(p.id + '|' + uri);
      const count = typeof p.count === 'number' ? `${p.count} song${p.count === 1 ? '' : 's'}` : '';
      return `<button class="row-btn" data-id="${esc(p.id)}"><span class="row-ico">${p.art ? `<img src="${esc(p.art)}" alt="" loading="lazy">` : ICON.note}</span>
        <span class="row-main"><span class="row-title">${esc(p.name)}</span><span class="row-sub">${esc([count, p.collaborative ? 'shared' : ''].filter(Boolean).join(' · '))}</span></span>${done ? ICON.check : ''}</button>`;
    }).join('') : sheetMsg('', 'No playlist with that name.');
    $('plList').querySelectorAll('.row-btn[data-id]').forEach((b) => b.onclick = () => addTo(items.find((p) => p.id === b.dataset.id), b));
  };
  const addTo = async (p, b) => {
    if (!p) return;
    const k = p.id + '|' + uri;
    if (addedTo.has(k)) { note(`Already added to ${p.name}`); return; }
    b.classList.add('busy');
    const res = await np.spotifyAddToPlaylist(p.id, uri);
    if (sheetKind !== 'playlists') return;
    b.classList.remove('busy');
    if (res && res.ok) {
      addedTo.add(k);
      settings.lastPlaylist = p.id;
      closeSheet();
      note(`Added to ${p.name}`);
    } else if (res && res.needsReconnect) showReconnect(body, 'Adding songs to playlists needs a new permission.');
    else alertBox(res?.error || "Couldn't add the song.");
  };
  draw('');
  const f = $('plFilter');
  if (f) f.oninput = () => draw(f.value);
  $('plRefresh').onclick = () => openPlaylists(true);
}
$('plBtn').onclick = () => openPlaylists();

// ---------- search Spotify: play now or add to queue ----------
let search = { q: '', items: [], offset: 0, more: false };
let searchTimer = null, searchSeq = 0;
function openSearch() {
  if (!media.spotify?.connected) { openSettings(true); return; }
  const body = openSheet('search', 'Search Spotify', true);
  body.innerHTML = `<div class="search-bar">${ICON.search}<input id="sq" placeholder="Songs, artists, albums…" spellcheck="false" autocomplete="off" /></div><div id="sres"></div>`;
  const input = $('sq');
  input.value = search.q;
  renderSearch();
  input.focus(); input.select();
  input.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(input.value), 320); };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(input.value, false, true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); $('sres').querySelector('.row-btn')?.focus(); }
  };
}
async function runSearch(q, more = false, force = false) {
  q = String(q || '').trim();
  if (!more && !force && q === search.q && (search.items.length || !q)) return;
  const seq = ++searchSeq;
  if (!q) { search = { q: '', items: [], offset: 0, more: false }; renderSearch(); return; }
  const offset = more ? search.offset + 10 : 0;
  if (!more) { search = { q, items: [], offset: 0, more: false }; renderSearch('loading'); }
  const r = await np.spotifySearch(q, offset);
  if (seq !== searchSeq || sheetKind !== 'search') return;
  if (!r || !r.ok) { renderSearch('error', r?.error); return; }
  search = { q, items: more ? [...search.items, ...r.items] : r.items, offset, more: !!r.more && offset + 10 < 1000 };
  renderSearch();
}
function renderSearch(state, err) {
  const box = $('sres');
  if (!box) return;
  if (state === 'loading') { box.innerHTML = sheetMsg('', 'Searching…'); return; }
  if (state === 'error') { box.innerHTML = sheetMsg("Search didn't work", err || 'Try again in a moment.', 'err'); return; }
  if (!search.q) { box.innerHTML = sheetMsg('', 'Type to search. Click a song to play it now, or use the queue button to play it next.'); return; }
  if (!search.items.length) { box.innerHTML = sheetMsg('Nothing found', `No songs match “${search.q}”.`); return; }
  box.innerHTML = search.items.map((it, i) => `<div class="row-btn" role="button" tabindex="0" data-i="${i}" title="Play now">
      <span class="row-ico">${it.art ? `<img src="${esc(it.art)}" alt="" loading="lazy">` : ICON.note}</span>
      <span class="row-main"><span class="row-title">${esc(it.title)}${it.explicit ? '<span class="tag e" title="Explicit">E</span>' : ''}</span><span class="row-sub">${esc([it.artist, it.album].filter(Boolean).join(' · '))}</span></span>
      <span class="row-end">${fmt(it.durationMs)}<button class="row-act" data-q="${i}" title="Add to queue">${ICON.queue}</button></span></div>`).join('')
    + (search.more ? '<button class="btn ghost small more-btn" id="sMore">More results</button>' : '');
  box.querySelectorAll('.row-btn[data-i]').forEach((row) => {
    const it = search.items[Number(row.dataset.i)];
    row.onclick = () => playNow(it, row);
    row.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); playNow(it, row); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); row.nextElementSibling?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (row.previousElementSibling || $('sq'))?.focus(); }
    };
  });
  box.querySelectorAll('.row-act[data-q]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); queueIt(search.items[Number(b.dataset.q)], b); });
  const more = $('sMore');
  if (more) more.onclick = () => { more.disabled = true; more.textContent = 'Loading…'; runSearch(search.q, true); };
}
async function playNow(it, row) {
  if (!it) return;
  row.classList.add('busy');
  const r = await np.spotifyPlayNow(it.uri);
  row.classList.remove('busy');
  if (r && r.ok) { closeSheet(); note(`Playing ${it.title}`); }
  else alertBox(r?.error || "Couldn't play that song.");
}
async function queueIt(it, btn) {
  if (!it || btn.classList.contains('done')) return;
  btn.disabled = true;
  const r = await np.spotifyQueue(it.uri);
  btn.disabled = false;
  if (r && r.ok) { btn.classList.add('done'); btn.innerHTML = ICON.check; btn.title = 'Added to the queue'; note(`Added to queue: ${it.title}`); }
  else alertBox(r?.error || "Couldn't add it to the queue.");
}
$('searchBtn').onclick = () => openSearch();

// ---------- wrong lyrics: pick another match, or none ----------
let lyrSeq = 0;
function openLyricsPicker() {
  if (!media.track) return;
  const body = openSheet('lyrics', 'Pick the right lyrics', true);
  body.innerHTML = `<div class="search-bar">${ICON.search}<input id="lq" placeholder="Search by artist and song name" spellcheck="false" autocomplete="off" /></div>
    <div id="lres"></div>
    <div class="sheet-actions"><button class="btn ghost small" id="lyAuto">Pick automatically</button><button class="btn ghost small" id="lyNone">No lyrics for this song</button></div>`;
  const input = $('lq');
  let timer = null;
  input.oninput = () => { clearTimeout(timer); timer = setTimeout(() => loadCandidates(input.value), 350); };
  input.onkeydown = (e) => { if (e.key === 'Enter') { clearTimeout(timer); loadCandidates(input.value); } };
  $('lyAuto').onclick = () => chooseLyrics('auto');
  $('lyNone').onclick = () => chooseLyrics('none');
  loadCandidates('');
}
async function loadCandidates(q) {
  const seq = ++lyrSeq;
  const box = $('lres');
  if (!box) return;
  q = String(q || '').trim();
  box.innerHTML = sheetMsg('', q ? 'Searching…' : 'Looking for other versions of this song…');
  const r = await np.lyricsCandidates(q);
  if (seq !== lyrSeq || sheetKind !== 'lyrics') return;
  if (!r || !r.ok) { box.innerHTML = sheetMsg("Couldn't reach the lyrics service", r?.error || 'Try again in a moment.', 'err'); return; }
  if (!r.items.length) { box.innerHTML = sheetMsg('No matches', q ? 'Try a different spelling of the artist or the song.' : 'Search by artist and song name above.'); return; }
  const dur = media.track?.durationMs || 0;
  box.innerHTML = r.items.map((c) => {
    const inUse = r.current != null && c.id === r.current;
    const diff = dur && c.durationMs ? Math.round((c.durationMs - dur) / 1000) : null;
    const len = c.durationMs ? fmt(c.durationMs) + (diff == null ? '' : Math.abs(diff) <= 2 ? ' · same length as this song'
      : ` · ${Math.abs(diff) < 60 ? Math.abs(diff) + ' s' : fmt(Math.abs(diff) * 1000)} ${diff > 0 ? 'longer' : 'shorter'}`) : '';
    const kind = c.instrumental ? 'Instrumental' : c.synced ? 'Synced' : 'Text only';
    return `<button class="row-btn ${inUse ? 'on' : ''}" data-id="${esc(String(c.id))}">
      <span class="row-main"><span class="row-title">${esc(c.title || 'Untitled')}</span><span class="row-sub">${esc([c.artist, c.album].filter(Boolean).join(' · '))}</span><span class="row-sub">${esc(len)}</span></span>
      <span class="row-end">${inUse ? '<span class="tag use">In use</span>' : ''}<span class="tag">${kind}</span></span></button>`;
  }).join('');
  box.querySelectorAll('.row-btn[data-id]').forEach((b) => b.onclick = () => chooseLyrics(Number(b.dataset.id)));
}
async function chooseLyrics(v) {
  const ok = await np.lyricsChoose(v);
  closeSheet();
  if (ok) note(v === 'none' ? 'Lyrics turned off for this song' : v === 'auto' ? 'Lyrics picked automatically again' : 'Lyrics changed for this song');
}
function renderLyFix() {
  $('lyFix').hidden = !(media.track && (lyrics.status === 'found' || lyrics.status === 'instrumental'));
}
$('lyFix').onclick = () => openLyricsPicker();

// ---------- listening stats ----------
let statsData = null, statsTable = false, statsSeq = 0;
const statsShowAll = { a: false, s: false };
const RANGE_TEXT = { today: 'today', week: 'this week', month: 'this month', all: 'in total' };
const WEEKDAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const statsRange = () => (['today', 'week', 'month', 'all'].includes(settings.statsRange) ? settings.statsRange : 'week');
function fmtDur(ms) {
  if (!ms || ms < 60000) return ms > 0 ? '<1 min' : '0 min';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
const fmtTick = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m}m` : `${Math.round((m / 60) * 10) / 10}h`; };
function niceMax(ms) {
  const m = ms / 60000;
  const steps = [2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480, 600, 720, 960, 1200, 1440, 1800, 2400, 3000, 3600, 4800, 6000, 7200, 9000, 12000, 15000, 18000, 24000, 30000, 36000, 48000, 60000];
  return (steps.find((x) => x >= m) || Math.ceil(m / 60000) * 60000) * 60000;
}
// The tooltip / list name of one bar.
function barName(d, i) {
  const now = new Date();
  if (d.range === 'today') return `${String(i).padStart(2, '0')}:00–${String((i + 1) % 24).padStart(2, '0')}:00`;
  if (d.range === 'week') {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d.chart.now + i);
    return `${WEEKDAY_LONG[i]} ${day.getDate()} ${day.toLocaleString('en-GB', { month: 'short' })}${i === d.chart.now ? ' · today' : ''}`;
  }
  if (d.range === 'month') return `${i + 1} ${now.toLocaleString('en-GB', { month: 'long' })}${i === d.chart.now ? ' · today' : ''}`;
  const m = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
  return m.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
}
function xLabelShown(d, i) {
  const n = d.chart.values.length, now = d.chart.now;
  if (i === now) return true;
  if (d.range === 'today') return i % 6 === 0 && Math.abs(i - now) > 2;
  if (d.range === 'month') return (i === 0 || (i + 1) % 5 === 0) && Math.abs(i - now) > 2 && i < n;
  return true;
}
function xLabel(d, i) { return d.range === 'today' ? `${String(i).padStart(2, '0')}:00` : d.chart.labels[i]; }

async function loadStats() {
  const seq = ++statsSeq;
  const body = $('stBody');
  if (statsData) body.classList.add('loading'); // keep the old view while the new one loads
  const d = await np.statsGet(statsRange());
  if (seq !== statsSeq) return;
  body.classList.remove('loading');
  statsData = d;
  renderStats();
}
function renderStats() {
  const body = $('stBody');
  const range = statsRange();
  document.querySelectorAll('#stRange button').forEach((b) => b.classList.toggle('on', b.dataset.v === range));
  if (settings.statsEnabled === false) {
    body.innerHTML = '<div class="st-empty"><b>Listening stats are off</b>Turn them on to see how much you listen, and to what. They stay on this PC.<br><br><button class="btn primary" id="stTurnOn">Keep listening stats</button></div>';
    $('stTurnOn').onclick = () => { settings.statsEnabled = true; np.setSettings({ statsEnabled: true }).then(loadStats); };
    return;
  }
  const d = statsData;
  if (!d) { body.innerHTML = ''; return; }
  if (d.range !== range) return; // the new range is loading: keep showing the old one
  const since = d.since ? new Date(d.since).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
  const foot = `<div class="st-foot"><span>Kept only on this PC${since ? ' · counting since ' + esc(since) : ''}</span></div>`;
  if (!d.totalMs) {
    body.innerHTML = `<div class="st-empty"><b>Nothing ${RANGE_TEXT[d.range]} yet</b>Play some music — listening time and plays are counted while it plays.</div>${foot}`;
    return;
  }
  const mins = Math.round(d.totalMs / 60000);
  const hero = mins < 1 ? '&lt;1<span class="u">min</span>'
    : mins < 60 ? `${mins}<span class="u">min</span>`
    : `${Math.floor(mins / 60)}<span class="u">h</span>${mins % 60}<span class="u">min</span>`;
  const n = settings.large ? 8 : 5;
  const c = d.chart;
  const top = niceMax(Math.max(...c.values, 1));
  const chart = statsTable
    ? `<table class="st-table">${c.values.map((v, i) => `<tr class="${i === c.now ? 'now' : ''}"><td>${esc(barName(d, i))}</td><td>${esc(fmtDur(v))}</td></tr>`).join('')}</table>`
    : `<div class="st-plot" id="stPlot">
        <div class="st-grid" style="bottom:100%"><span>${fmtTick(top)}</span></div>
        <div class="st-grid" style="bottom:50%"><span>${fmtTick(top / 2)}</span></div>
        ${c.values.map((v, i) => `<div class="st-col" tabindex="0" data-i="${i}" aria-label="${esc(barName(d, i))}: ${esc(fmtDur(v))}">${v > 0 ? `<div class="st-bar" style="height:${Math.max(2.5, (v / top) * 100).toFixed(1)}%"></div>` : ''}</div>`).join('')}
      </div>
      <div class="st-x">${c.values.map((_, i) => `<span class="${i === c.now ? 'now' : ''}">${xLabelShown(d, i) ? esc(xLabel(d, i)) : ''}</span>`).join('')}</div>
      <div class="st-tip" id="stTip" hidden></div>`;
  const artists = d.topArtists.slice(0, statsShowAll.a ? 10 : n);
  const maxA = d.topArtists[0]?.ms || 1;
  const songs = d.topSongs.slice(0, statsShowAll.s ? 10 : n);
  body.innerHTML = `
    <div class="st-hero"><div class="st-big">${hero}</div>
      <div class="st-sub">Listened ${RANGE_TEXT[d.range]}${d.avgPerDayMs ? ` · about ${fmtDur(d.avgPerDayMs)} a day` : ''}</div></div>
    <div class="st-tiles">
      <div class="st-tile"><div class="l">Plays</div><div class="v">${d.plays.toLocaleString('en-US')}</div></div>
      <div class="st-tile"><div class="l">Songs</div><div class="v">${d.songs.toLocaleString('en-US')}</div></div>
      <div class="st-tile"><div class="l">Artists</div><div class="v">${d.artists.toLocaleString('en-US')}</div></div>
    </div>
    <div class="st-card" id="stCard">
      <div class="st-card-head"><span>Listening time by ${c.unit}</span><button class="btn link" id="stView">${statsTable ? 'Show chart' : 'Show as list'}</button></div>
      ${chart}
    </div>
    ${artists.length ? `<div class="st-sec"><span>Top artists</span>${d.topArtists.length > n ? `<button class="btn link" data-more="a">${statsShowAll.a ? 'Show fewer' : 'Show more'}</button>` : ''}</div>
    <div class="st-list">${artists.map((a, i) => `<div class="st-row"><span class="rk">${i + 1}</span><div class="nm"><div class="t1">${esc(a.name)}</div><div class="meter" style="width:${Math.max(2, Math.round((a.ms / maxA) * 100))}%"></div></div><span class="vl">${esc(fmtDur(a.ms))}</span></div>`).join('')}</div>` : ''}
    ${songs.length ? `<div class="st-sec"><span>Top songs</span>${d.topSongs.length > n ? `<button class="btn link" data-more="s">${statsShowAll.s ? 'Show fewer' : 'Show more'}</button>` : ''}</div>
    <div class="st-list">${songs.map((x, i) => `<div class="st-row song"><span class="rk">${i + 1}</span><span class="th">${x.art ? `<img src="${esc(x.art)}" alt="" loading="lazy">` : ''}</span><div class="nm"><div class="t1">${esc(x.title)}</div><div class="t2">${esc(x.artist)}</div></div><span class="vl">${x.plays ? `${x.plays} play${x.plays === 1 ? '' : 's'}<div class="t2">${esc(fmtDur(x.ms))}</div>` : esc(fmtDur(x.ms))}</span></div>`).join('')}</div>` : ''}
    ${foot}`;
  $('stView').onclick = () => { statsTable = !statsTable; renderStats(); };
  body.querySelectorAll('[data-more]').forEach((b) => b.onclick = () => { statsShowAll[b.dataset.more] = !statsShowAll[b.dataset.more]; renderStats(); });
  body.querySelectorAll('.th img').forEach((img) => { img.onerror = () => img.remove(); });
  if (!statsTable) wireChartTips(d);
}
// One tooltip for the chart: on hover and on keyboard focus of each bar.
function wireChartTips(d) {
  const card = $('stCard'), tip = $('stTip');
  const show = (col) => {
    const i = Number(col.dataset.i);
    tip.innerHTML = `<b>${esc(fmtDur(d.chart.values[i]))}</b>${esc(barName(d, i))}`;
    tip.hidden = false;
    const cr = card.getBoundingClientRect();
    const r = col.getBoundingClientRect();
    const bar = col.querySelector('.st-bar');
    const y = (bar ? bar.getBoundingClientRect().top : r.bottom) - cr.top;
    const half = tip.offsetWidth / 2;
    const x = Math.min(Math.max(r.left + r.width / 2 - cr.left, half + 4), cr.width - half - 4);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  };
  const hide = () => { tip.hidden = true; };
  card.querySelectorAll('.st-col').forEach((col) => {
    col.addEventListener('pointerenter', () => show(col));
    col.addEventListener('focus', () => show(col));
    col.addEventListener('pointerleave', hide);
    col.addEventListener('blur', hide);
  });
}
document.querySelectorAll('#stRange button').forEach((b) => b.onclick = () => {
  if (statsRange() === b.dataset.v) return;
  settings.statsRange = b.dataset.v;
  statsShowAll.a = statsShowAll.s = false;
  document.querySelectorAll('#stRange button').forEach((x) => x.classList.toggle('on', x === b));
  loadStats();
  np.setSettings({ statsRange: b.dataset.v });
});
// Refresh while the Stats tab is on screen.
setInterval(() => {
  if (!document.hidden && shell.dataset.tab === 'stats' && shell.dataset.mode !== 'mini' && !document.querySelector('.st-col:hover, .st-col:focus')) loadStats();
}, 30000);

// ---------- desktop lyrics + stats settings ----------
function renderDlControls() {
  $('dlOn').checked = !!settings.desktopLyrics;
  $('dlFill').checked = settings.desktopLyricsFill !== false;
  $('dlNext').checked = settings.desktopLyricsNext !== false;
  document.querySelectorAll('.seg[data-dl]').forEach((seg) => {
    const v = String(settings[seg.dataset.dl] || (seg.dataset.dl === 'desktopLyricsSize' ? 'm' : 'outline'));
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  });
  $('dlMove').textContent = settings.overlayMoving ? 'Done moving' : 'Move…';
  $('dlMove').classList.toggle('primary', !!settings.overlayMoving);
  $('dlMove').classList.toggle('ghost', !settings.overlayMoving);
  $('stOn').checked = settings.statsEnabled !== false;
  $('stBrowsers').checked = settings.statsBrowsers !== false;
}
$('dlOn').onchange = (e) => np.setSettings({ desktopLyrics: e.target.checked });
$('dlFill').onchange = (e) => np.setSettings({ desktopLyricsFill: e.target.checked });
$('dlNext').onchange = (e) => np.setSettings({ desktopLyricsNext: e.target.checked });
document.querySelectorAll('.seg[data-dl] button').forEach((b) => b.onclick = () => {
  const k = b.parentElement.dataset.dl;
  settings[k] = b.dataset.v;
  renderDlControls();
  np.setSettings({ [k]: b.dataset.v });
});
$('dlMove').onclick = async () => {
  settings.overlayMoving = await np.overlayMove(!settings.overlayMoving);
  renderDlControls();
  if (settings.overlayMoving) note('Drag the lyrics on your screen, then press Done');
};
$('dlReset').onclick = () => { np.setSettings({ desktopLyricsPos: null }); note('Desktop lyrics moved back to the bottom of the screen'); };
$('stOn').onchange = (e) => np.setSettings({ statsEnabled: e.target.checked });
$('stBrowsers').onchange = (e) => np.setSettings({ statsBrowsers: e.target.checked });
let resetArmedAt = 0;
$('stReset').onclick = async () => {
  const b = $('stReset');
  if (Date.now() - resetArmedAt > 4000) {
    resetArmedAt = Date.now();
    b.textContent = 'Click again to delete all stats';
    setTimeout(() => { if (Date.now() - resetArmedAt >= 3900) b.textContent = 'Reset stats'; }, 4000);
    return;
  }
  resetArmedAt = 0;
  b.textContent = 'Reset stats';
  await np.statsReset();
  statsData = null;
  note('Listening stats deleted');
};

// Used by the screenshot tests (mock mode only sends these).
np.onUiAction((a) => {
  if (!a) return;
  if (a.tab) setTab(a.tab);
  if (a.open === 'devices') openDevices();
  if (a.open === 'playlists') openPlaylists();
  if (a.open === 'search') { search.q = ''; openSearch(); if (a.q) { $('sq').value = a.q; runSearch(a.q, false, true); } }
  if (a.open === 'lyrics') openLyricsPicker();
  if (a.statsTable) { statsTable = true; renderStats(); }
  if (a.scrollTo) document.querySelector(a.scrollTo)?.scrollIntoView();
  if (a.hover) setTimeout(() => { document.querySelector(a.hover)?.dispatchEvent(new PointerEvent('pointerenter')); }, 300);
});

// ---------- wiring ----------
let lastKey = null;
function applyMiniLook() {
  shell.style.setProperty('--mini-op', String(Math.max(0.3, Math.min(1, Number(settings.miniOpacity) || 1))));
  shell.classList.toggle('click-through', !!settings.clickThrough);
}
np.onSettings((s) => {
  if (offSaveTimer) s.lyricsOffsets = settings.lyricsOffsets; // a timing change is about to be saved
  const statsChanged = s.statsEnabled !== settings.statsEnabled;
  settings = s;
  if (!$('settings').hidden) renderDlControls();
  if (statsChanged && shell.dataset.tab === 'stats') loadStats();
  applyMiniLook();
  applyAppearance();
  if (s.mode && shell.dataset.mode !== s.mode) { shell.dataset.mode = s.mode; renderSpotifyExtras(); }
  $('sizeBtn').classList.toggle('on', !!s.large);
  $('icoGrow').hidden = !!s.large; $('icoShrink').hidden = !s.large;
  $('pinBtn').classList.toggle('on', !!s.pinned);
  if (!$('settings').hidden) { $('pinned').checked = !!s.pinned; $('launchAtStartup').checked = !!s.launchAtStartup; }
  renderSources();
});
np.onArt((url) => setArt(url));
np.onMedia((m) => {
  media = m;
  needsTick = true;
  renderMedia();
  if (m.key !== lastKey) { lastKey = m.key; renderLyrics(); renderLyFix(); if (sheetKind === 'lyrics' || sheetKind === 'playlists') closeSheet(); }
  if (!$('settings').hidden) { renderSpotifyStatus(); renderDiag(); }
});
np.onLyrics((l) => { lyrics = l; renderLyrics(); renderSyncUI(); lyricIdx = -1; lastMiniLyric = null; updateMiniLyricVisibility(); needsTick = true; });
np.onClaude((c) => { claude = c; renderClaude(); });
np.onDesktop((d) => { desk = d; renderClaude(); if (!$('settings').hidden) renderBridgeStatus(); });
np.onChats((c) => { chats = c; renderClaude(); if (!$('settings').hidden) renderBridgeStatus(); });
np.onGoto((g) => { if (g?.tab) { if (shell.dataset.mode === 'mini') setMode('full'); openSettings(false); setTab(g.tab); } });
np.onAlert(() => { const l = $('claudeList'); l.classList.remove('flash'); void l.offsetWidth; l.classList.add('flash'); });
np.onSpotifyStatus((s) => { media.spotify = s; if (!$('settings').hidden) fillSettings(); });

(async () => {
  settings = await np.getSettings();
  shell.dataset.mode = settings.mode || 'full';
  applyMiniLook();
  applyAppearance();
  $('sizeBtn').classList.toggle('on', !!settings.large);
  $('icoGrow').hidden = !!settings.large; $('icoShrink').hidden = !settings.large;
  setTab(settings.tab || 'playing');
  needsTick = true;
  desk = await np.desktopStatus();
  upd = (await np.updateState()) || upd;
  renderUpdate();
  renderClaude();
  $('pinBtn').classList.toggle('on', !!settings.pinned);
  await np.ready();
  tick();
})();
