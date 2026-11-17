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
  shell.dataset.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (settings.tab !== tab) { settings.tab = tab; np.setSettings({ tab }); }
  if (tab === 'playing') { lyricIdx = -1; }
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
  shell.dataset.mode = mode;
  lyricIdx = -1; needsTick = true; updateMiniLyricVisibility();
  if (settings.mode !== mode) { settings.mode = mode; np.setSettings({ mode }); }
}
$('logBtn').onclick = () => np.openLog();

$('settingsBack').onclick = () => openSettings(false);
np.onOpenSettings(() => openSettings(true));
document.addEventListener('keydown', (e) => {
  if (document.activeElement && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return;
  if (e.key === 'Escape') { if (!$('settings').hidden) openSettings(false); else if (shell.dataset.mode !== 'mini') np.hide(); }
  if (e.key === 'm' || e.key === 'M') setMode(shell.dataset.mode === 'mini' ? 'full' : 'mini');
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
  renderUpNext();
  updateMiniLyricVisibility();
  renderVolume();
  shell.style.setProperty('--np-accent', (t && t.accent) || '#1ed760');
}

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
  return shell.dataset.mode === 'mini' && lyrics.status === 'found' && lyrics.synced.length > 0 && !!media.track;
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
    inner.innerHTML = `<div class="empty"><b>No lyrics found</b>${lyrics.status === 'error' ? 'Could not reach the lyrics service.' : 'This track has no lyrics in the LRCLIB database yet.'}</div>`;
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

function tickLyrics(pos) {
  if (lyrics.status !== 'found' || !lyrics.synced.length) return;
  const mini = shell.dataset.mode === 'mini';
  if (!mini && shell.dataset.tab !== 'playing') return;
  const L = lyrics.synced;
  let i = -1;
  // binary search for last line with t <= pos
  let lo = 0, hi = L.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (L[m].t <= pos + 150) { i = m; lo = m + 1; } else hi = m - 1; }
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
  $('hotkey').value = prettyHotkey(settings.hotkey);
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

// hotkey recorder
function prettyHotkey(h) { return (h || '').replace('CommandOrControl', 'Ctrl').replace(/\+/g, ' + '); }
const hk = $('hotkey');
hk.addEventListener('focus', () => { hk.classList.add('rec'); hk.value = 'Press keys…'; });
hk.addEventListener('blur', () => { hk.classList.remove('rec'); hk.value = prettyHotkey(settings.hotkey); });
hk.addEventListener('keydown', async (e) => {
  e.preventDefault();
  if (e.key === 'Escape') { hk.blur(); return; }
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
  const mods = [];
  if (e.ctrlKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  if (!mods.length) return;
  let key = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.key;
  if (key === ' ') key = 'Space';
  if (key.length === 1) key = key.toUpperCase();
  const accel = [...mods, key].join('+');
  const r = await np.setSettings({ hotkey: accel });
  $('hotkeyWarn').hidden = r.hotkeyOk !== false;
  hk.blur();
});

// ---------- wiring ----------
let lastKey = null;
np.onSettings((s) => {
  settings = s;
  if (s.mode && shell.dataset.mode !== s.mode) shell.dataset.mode = s.mode;
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
  if (m.key !== lastKey) { lastKey = m.key; renderLyrics(); }
  if (!$('settings').hidden) { renderSpotifyStatus(); renderDiag(); }
});
np.onLyrics((l) => { lyrics = l; renderLyrics(); lyricIdx = -1; lastMiniLyric = null; updateMiniLyricVisibility(); needsTick = true; });
np.onClaude((c) => { claude = c; renderClaude(); });
np.onDesktop((d) => { desk = d; renderClaude(); if (!$('settings').hidden) renderBridgeStatus(); });
np.onChats((c) => { chats = c; renderClaude(); if (!$('settings').hidden) renderBridgeStatus(); });
np.onGoto((g) => { if (g?.tab) { if (shell.dataset.mode === 'mini') setMode('full'); openSettings(false); setTab(g.tab); } });
np.onAlert(() => { const l = $('claudeList'); l.classList.remove('flash'); void l.offsetWidth; l.classList.add('flash'); });
np.onSpotifyStatus((s) => { media.spotify = s; if (!$('settings').hidden) fillSettings(); });

(async () => {
  settings = await np.getSettings();
  shell.dataset.mode = settings.mode || 'full';
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
