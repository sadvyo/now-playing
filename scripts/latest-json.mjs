// Writes dist/latest.json describing the release files (name, size, SHA-256).
// The app reads it through GitHub's normal downloads, which aren't rate-limited
// like the GitHub API.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const dist = 'dist';
const files = fs.readdirSync(dist)
  .filter((n) => /^NowPlaying-Setup-.*\.exe$|-portable\.exe$/i.test(n))
  .map((name) => {
    const buf = fs.readFileSync(path.join(dist, name));
    return { name, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  });
if (!files.length) { console.error('no release files found in dist/'); process.exit(1); }
const out = { version: pkg.version, notes: process.env.RELEASE_NOTES || '', files };
fs.writeFileSync(path.join(dist, 'latest.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
