// Picks a vivid accent color from cover art (for the progress bar, play button…).
// Runs in the main process with nativeImage, so it works for any image source.
const { nativeImage } = require('electron');

const cache = new Map(); // art url/data -> '#rrggbb' | null
const pending = new Map();
const MAX = 120;

function hsl2rgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((x) => Math.round(x * 255));
}

function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

// bgra: Buffer of width*height*4 (nativeImage.toBitmap order is BGRA on Windows).
function pickFromPixels(bgra) {
  const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  let pixels = 0;
  for (let i = 0; i + 3 < bgra.length; i += 4) {
    const b = bgra[i], g = bgra[i + 1], r = bgra[i + 2], a = bgra[i + 3];
    if (a < 128) continue;
    pixels++;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const v = max / 255;
    const sat = max ? (max - min) / max : 0;
    if (v < 0.18 || sat < 0.18) continue; // ignore near-black and grey pixels
    const [h] = rgb2hsl(r, g, b);
    const w = sat * sat * v;
    const bin = bins[Math.floor(h / 30) % 12];
    bin.w += w; bin.r += r * w; bin.g += g * w; bin.b += b * w;
  }
  const best = bins.reduce((x, y) => (y.w > x.w ? y : x));
  if (!pixels || best.w < pixels * 0.02) return null; // greyscale cover: keep the default color
  const [h, s0, l0] = rgb2hsl(best.r / best.w, best.g / best.w, best.b / best.w);
  // Readable on the dark pop-up, with dark icons on top of it.
  const s = Math.max(0.45, Math.min(0.9, s0));
  let l = Math.max(0.56, Math.min(0.7, l0));
  // Blues/purples look dark at the same lightness: lighten until dark icons on it
  // have good contrast (relative luminance >= 0.3, about 7:1 against #111).
  const lum = ([r, g, b]) => [r, g, b].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
    .reduce((acc, c, i) => acc + c * [0.2126, 0.7152, 0.0722][i], 0);
  let rgb = hsl2rgb(h, s, l);
  while (lum(rgb) < 0.3 && l < 0.86) { l += 0.02; rgb = hsl2rgb(h, s, l); }
  const [r, g, b] = rgb;
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function loadImage(src) {
  if (src.startsWith('data:')) return nativeImage.createFromDataURL(src);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(src, { signal: ctl.signal });
    if (!res.ok) return null;
    return nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
  } finally { clearTimeout(t); }
}

function remember(k, v) { cache.set(k, v); if (cache.size > MAX) cache.delete(cache.keys().next().value); }

function cachedAccent(key) { return key && cache.has(key) ? cache.get(key) : undefined; }

// key: short id for the image (callers pass one so long data: URLs aren't kept as keys).
async function accentFor(src, key = src) {
  if (!src) return null;
  if (cache.has(key)) return cache.get(key);
  if (pending.has(key)) return pending.get(key);
  const p = (async () => {
    let color = null;
    try {
      const img = await loadImage(src);
      if (img && !img.isEmpty()) color = pickFromPixels(img.resize({ width: 24, height: 24, quality: 'good' }).toBitmap());
    } catch { color = null; }
    remember(key, color);
    pending.delete(key);
    return color;
  })();
  pending.set(key, p);
  return p;
}

module.exports = { accentFor, cachedAccent, pickFromPixels };
