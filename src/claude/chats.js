// Receives progress / question reports from the "Now Playing – Claude progress"
// Claude Desktop extension (bridge/), over HTTP on 127.0.0.1 only.
const http = require('http');
const EventEmitter = require('events');

const DONE_TTL = 3 * 3600 * 1000;   // keep finished tasks visible for 3 h
const STALE = 30 * 60 * 1000;       // "working" with no update for 30 min -> idle

const keyOf = (t) => String(t || 'Claude chat').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

class ClaudeChats extends EventEmitter {
  constructor(log) {
    super();
    this.log = log || (() => {});
    this.tasks = new Map();
    this.server = null;
    this.port = null;
    this.lastSeen = 0;   // last time the extension talked to us
    this.listening = false;
    this.error = null;
    this.finishTimers = new Map();
  }

  // Progress hit 100% but Claude may still call task_finished with a summary:
  // wait a little so you get one notification, not two.
  _scheduleFinished(k) {
    clearTimeout(this.finishTimers.get(k));
    this.finishTimers.set(k, setTimeout(() => {
      this.finishTimers.delete(k);
      const t = this.tasks.get(k);
      if (t && t.status === 'done' && !t.finishedSent) { t.finishedSent = true; this.emit('finished', t); }
    }, 30000));
  }

  start(port = 47823) {
    this.port = port;
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.on('error', (e) => { this.error = `Port ${port} busy (${e.code})`; this.listening = false; this.log('bridge server: ' + e.message); this._emit(); });
    this.server.listen(port, '127.0.0.1', () => { this.listening = true; this.error = null; this._emit(); });
    this.timer = setInterval(() => this._sweep(), 60000);
  }

  stop() {
    clearInterval(this.timer);
    for (const t of this.finishTimers.values()) clearTimeout(t);
    try { this.server?.close(); } catch {}
  }

  _handle(req, res) {
    // Browsers can't send this header cross-site without a CORS preflight we never answer.
    if (req.method !== 'POST' || req.headers['x-nowplaying'] !== '1' || !/json/.test(req.headers['content-type'] || '')) {
      res.writeHead(req.url === '/health' ? 200 : 403); res.end(req.url === '/health' ? 'ok' : ''); return;
    }
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch { res.writeHead(400); res.end(); return; }
      this.lastSeen = Date.now();
      const ok = this.apply(req.url, p);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'text/plain' });
      res.end(ok ? 'ok' : 'unknown');
    });
  }

  apply(url, p) {
    const k = keyOf(p.task);
    const prev = this.tasks.get(k) || { id: k, task: clip(p.task || 'Claude chat', 70), done: 0, total: 0, created: Date.now() };
    const t = { ...prev, updated: Date.now() };
    if (url === '/claude/progress') {
      const now = Date.now();
      t.total = Math.max(1, Number(p.total) || prev.total || 1);
      t.done = Math.min(t.total, Math.max(0, Number(p.done) || 0));
      t.step = clip(p.step || '', 120);
      t.status = t.done >= t.total ? 'done' : 'working';
      t.question = null;
      // Timing for "about N min left": measure how long completed steps took.
      if (!prev.startAt || t.done < (prev.startDone ?? 0) || prev.status === 'done') {
        t.startAt = now; t.startDone = t.done; t.lastStepAt = now; t.msPerStep = null;
      } else if (t.done > (prev.done ?? 0)) {
        t.lastStepAt = now;
        const steps = t.done - t.startDone;
        if (steps > 0) t.msPerStep = Math.round((now - t.startAt) / steps);
      }
      if (t.status === 'done' && prev.status !== 'done') this._scheduleFinished(k);
    } else if (url === '/claude/question') {
      t.status = 'question';
      t.question = clip(p.question || 'Claude needs your answer', 240);
      t.questionAt = Date.now();
      this.emit('question', t);
    } else if (url === '/claude/done') {
      const already = prev.status === 'done' && prev.finishedSent;
      t.status = 'done';
      if (t.total) t.done = t.total;
      t.summary = clip(p.summary || '', 200);
      t.question = null;
      clearTimeout(this.finishTimers.get(k)); this.finishTimers.delete(k);
      if (!already) { t.finishedSent = true; this.emit('finished', t); }
    } else {
      return false;
    }
    this.tasks.set(k, t);
    this._emit();
    return true;
  }

  dismiss(id) {
    const t = this.tasks.get(id);
    if (!t) return;
    // A question card with no progress behind it (e.g. the test alert) just goes away.
    if (t.status === 'question' && t.total) { t.status = 'working'; t.question = null; } else this.tasks.delete(id);
    this._emit();
  }

  clearFinished() {
    for (const [k, t] of this.tasks) if (t.status === 'done' || t.status === 'idle') this.tasks.delete(k);
    this._emit();
  }

  _sweep() {
    const now = Date.now();
    let changed = false;
    for (const [k, t] of this.tasks) {
      if (t.status === 'done' && now - t.updated > DONE_TTL) { this.tasks.delete(k); changed = true; }
      else if (t.status === 'working' && now - t.updated > STALE) { t.status = 'idle'; changed = true; }
    }
    if (changed) this._emit();
  }

  list() {
    const rank = { question: 0, working: 1, idle: 2, done: 3 };
    return [...this.tasks.values()].sort((a, b) => (rank[a.status] - rank[b.status]) || (b.updated - a.updated));
  }

  snapshot() {
    return { tasks: this.list(), listening: this.listening, port: this.port, lastSeen: this.lastSeen, error: this.error };
  }

  _emit() { this.emit('update', this.snapshot()); }
}

module.exports = { ClaudeChats };
