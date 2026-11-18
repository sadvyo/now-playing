/* global ov */
// Desktop lyrics page. No polling: one timer is set for the exact moment the next
// line starts, and the karaoke fill is a CSS transition the compositor runs.
const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const stage = $('stage'), cur = $('cur'), base = $('base'), hl = $('hl'), hlIn = $('hlIn'), next = $('next');

let lines = [], lyKey = null, offset = 0, play = null;
let look = { font: 34, style: 'outline', next: true, fill: true, accent: '#1ed760', moving: false };
let idx = -2;
let timer = null;
const LEAD = 150; // same small lead as the pop-up, so both switch lines together

function position() {
  if (!play) return 0;
  let p = play.positionMs || 0;
  if (play.isPlaying && play.sampledAt) p += Date.now() - play.sampledAt;
  if (play.durationMs) p = Math.min(p, play.durationMs);
  return Math.max(0, p);
}
const lyricTime = () => position() - offset + LEAD; // positive offset = lyrics later
function find(at) {
  let lo = 0, hi = lines.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (lines[m].t <= at) { i = m; lo = m + 1; } else hi = m - 1; }
  return i;
}
const textAt = (i) => (i >= 0 && i < lines.length ? String(lines[i].text || '').trim() : '');
const isBlank = (t) => !t || /^[♪♫\s]+$/.test(t);
const hasLyrics = () => !!(play && lyKey && play.key === lyKey && lines.length);

function update() {
  clearTimeout(timer);
  timer = null;
  const on = hasLyrics();
  stage.classList.toggle('idle', !on && !look.moving);
  stage.classList.toggle('paused', on && !play.isPlaying && !look.moving);
  if (!on) {
    idx = -2;
    if (look.moving) showText('Your lyrics show here', 'Drag this where you want it, then press Done');
    return;
  }
  const at = lyricTime();
  const i = find(at);
  if (i !== idx) { idx = i; showLine(i); }
  setFill(i, at);
  // Wake up exactly when the next line starts (re-synced on every real update).
  if (play.isPlaying && i + 1 < lines.length) {
    timer = setTimeout(update, Math.max(20, Math.min(lines[i + 1].t - at + 5, 30000)));
  }
}

function showLine(i) {
  const t = textAt(i);
  let upcoming = '';
  for (let k = i + 1; k < Math.min(lines.length, i + 4); k++) { const x = textAt(k); if (!isBlank(x)) { upcoming = x; break; } }
  showText(isBlank(t) ? '' : t, upcoming);
}

function showText(text, upcoming) {
  const blank = isBlank(text);
  base.textContent = blank ? '♪' : text;
  hlIn.textContent = blank ? '' : text;
  cur.classList.toggle('blank', blank);
  next.textContent = upcoming || '';
  fit();
  cur.classList.remove('enter');
  void cur.offsetWidth; // restart the fade-in
  cur.classList.add('enter');
}

// Long lines shrink to fit the width (down to half size) instead of being cut off.
function fit() {
  cur.style.fontSize = look.font + 'px';
  const pad = look.style === 'box' ? look.font * 1.1 : 0;
  const avail = stage.clientWidth - 16 - pad;
  const w = cur.offsetWidth;
  if (w > avail && w > 0) cur.style.fontSize = Math.max(look.font * 0.5, Math.floor(look.font * avail / w)) + 'px';
}

function setFill(i, at) {
  if (!look.fill || i < 0 || cur.classList.contains('blank')) { setQ(1, 0); return; }
  const start = lines[i].t;
  const end = i + 1 < lines.length ? lines[i + 1].t : start + 6000;
  // Lines are usually sung a bit faster than the gap to the next one (breaths,
  // instrumental breaks), so the fill takes the shorter of the gap and an estimate.
  const est = 700 + textAt(i).length * 95;
  const dur = Math.max(300, Math.min(end - start - 120, est));
  const q = Math.min(1, Math.max(0, (at - start) / dur));
  setQ(q, play.isPlaying && q < 1 ? (1 - q) * dur : 0);
}

function setQ(q, ms) {
  hl.style.transition = 'none';
  hlIn.style.transition = 'none';
  hl.style.transform = `translateX(${(q - 1) * 100}%)`;
  hlIn.style.transform = `translateX(${(1 - q) * 100}%)`;
  if (ms > 0) {
    void hl.offsetWidth; // apply the start position before gliding from it
    // ~25 updates a second: looks like a smooth sweep but costs a third of 60 fps
    // (the screen isn't redrawn between steps).
    const tr = `transform ${Math.round(ms)}ms steps(${Math.max(1, Math.round(ms / 40))}, end)`;
    hl.style.transition = tr;
    hlIn.style.transition = tr;
    hl.style.transform = 'translateX(0)';
    hlIn.style.transform = 'translateX(0)';
  }
}

function applyLook() {
  root.style.setProperty('--font', look.font + 'px');
  root.style.setProperty('--accent', look.accent || '#1ed760');
  root.dataset.style = look.style;
  root.dataset.fill = look.fill ? 'on' : 'off';
  root.dataset.next = look.next ? 'on' : 'off';
  stage.classList.toggle('moving', !!look.moving);
}

ov.onLyrics((m) => { lines = Array.isArray(m?.lines) ? m.lines : []; lyKey = m?.key || null; offset = Number(m?.offset) || 0; idx = -2; update(); });
ov.onPlay((p) => { play = p; update(); });
ov.onLook((l) => { look = { ...look, ...l }; applyLook(); idx = -2; update(); });
window.addEventListener('resize', () => { idx = -2; update(); });

// ---- Move mode: drag anywhere on the handle ----
let dragging = false, framePending = false;
stage.addEventListener('pointerdown', (e) => {
  if (!look.moving || e.button !== 0 || e.target.closest('button')) return;
  dragging = true;
  stage.setPointerCapture(e.pointerId);
  stage.classList.add('dragging');
  ov.dragStart();
});
stage.addEventListener('pointermove', () => {
  if (!dragging || framePending) return;
  framePending = true;
  requestAnimationFrame(() => { framePending = false; if (dragging) ov.drag(); });
});
const endDrag = () => { if (!dragging) return; dragging = false; stage.classList.remove('dragging'); ov.dragEnd(); };
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);
stage.addEventListener('lostpointercapture', endDrag);
$('done').onclick = () => ov.done();
$('smaller').onclick = () => ov.size(-1);
$('bigger').onclick = () => ov.size(1);

applyLook();
ov.ready();
