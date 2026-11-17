// Reads Claude Code session transcripts (~/.claude/projects/<project>/<session>.jsonl)
// and turns them into "what is Claude doing right now" cards with todo progress.
//
// Note: chats on claude.ai / the Claude desktop app are stored in the cloud and
// have no public API, so only Claude Code sessions on this PC can be shown.
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

const HEAD = 256 * 1024;
const TAIL = 1536 * 1024;
const WHOLE = 1536 * 1024;

function claudeRoot(override) {
  if (override) return override;
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  return path.join(os.homedir(), '.claude');
}

function readPart(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function linesOf(text, dropFirst) {
  const ls = text.split('\n');
  if (dropFirst) ls.shift();
  const out = [];
  for (const l of ls) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* partial line */ }
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function short(s, n = 140) {
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function isRealPrompt(e) {
  if (e.type !== 'user' || e.isMeta || e.isSidechain) return false;
  const c = e.message?.content;
  if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) return false;
  const t = textOf(c).trim();
  if (!t) return false;
  if (/^<(command-|local-command|system-reminder|user-memory)/.test(t)) return false;
  if (t.startsWith('Caveat:')) return false;
  return true;
}

function describeTool(b) {
  const i = b.input || {};
  const base = (p) => (p ? String(p).split(/[\\/]/).pop() : '');
  switch (b.name) {
    case 'Bash': return `Running ${short(i.description || i.command, 70)}`;
    case 'Edit': case 'MultiEdit': return `Editing ${base(i.file_path)}`;
    case 'Write': return `Writing ${base(i.file_path)}`;
    case 'Read': return `Reading ${base(i.file_path)}`;
    case 'Grep': return `Searching for "${short(i.pattern, 40)}"`;
    case 'Glob': return `Finding ${short(i.pattern, 40)}`;
    case 'WebSearch': return `Searching the web: ${short(i.query, 50)}`;
    case 'WebFetch': return `Reading ${short(i.url, 50)}`;
    case 'Task': case 'Agent': return `Running agent: ${short(i.description, 50)}`;
    case 'TodoWrite': return 'Updating plan';
    case 'TaskCreate': case 'TaskUpdate': return 'Updating tasks';
    default: return `Using ${String(b.name || 'tool').replace(/^mcp__[^_]+__/, '')}`;
  }
}

function parseSession(file, stat) {
  let entries;
  if (stat.size <= WHOLE) {
    entries = linesOf(fs.readFileSync(file, 'utf8'), false);
  } else {
    entries = [
      ...linesOf(readPart(file, 0, HEAD), false),
      ...linesOf(readPart(file, stat.size - TAIL, TAIL), true),
    ];
  }

  let title = null, summary = null, firstPrompt = null, lastPrompt = null;
  let cwd = null, branch = null, sessionId = null, started = null, model = null;
  let todos = null;
  const tasks = new Map(); let taskSeq = 0;
  let lastAssistant = null, lastEntry = null, lastText = null;
  let pendingTool = null; let turns = 0;
  const resolved = new Set();
  // Step timing (for "about N min left"): when each completed-count increase happened.
  let tStart = null, dStart = 0, tLast = null, dLast = 0;
  const sample = (ts, done) => {
    const t = Date.parse(ts || '');
    if (!t) return;
    if (tStart === null || done < dLast) { tStart = t; dStart = done; tLast = t; dLast = done; return; }
    if (done > dLast) { tLast = t; dLast = done; }
  };

  for (const e of entries) {
    if (e.type === 'summary' && e.summary) summary = e.summary;
    if (e.type === 'custom-title' && e.customTitle) title = e.customTitle;
    if (e.isSidechain) continue;
    if (e.cwd) cwd = e.cwd;
    if (e.gitBranch) branch = e.gitBranch;
    if (e.sessionId) sessionId = e.sessionId;
    if (!started && e.timestamp) started = e.timestamp;

    if (e.type === 'user') {
      const c = e.message?.content;
      if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result') resolved.add(b.tool_use_id);
      if (isRealPrompt(e)) {
        const t = short(textOf(c), 160);
        if (!firstPrompt) firstPrompt = t;
        lastPrompt = t;
        turns++;
      }
      lastEntry = e;
    } else if (e.type === 'assistant') {
      lastAssistant = e;
      lastEntry = e;
      const m = e.message || {};
      if (m.model) model = m.model;
      for (const b of m.content || []) {
        if (b.type === 'text' && b.text?.trim()) lastText = b.text;
        if (b.type === 'tool_use') {
          pendingTool = b;
          if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) {
            todos = b.input.todos;
            sample(e.timestamp, todos.filter((x) => x.status === 'completed').length);
          }
          if (b.name === 'TaskCreate') {
            taskSeq++;
            tasks.set(String(taskSeq), { content: b.input?.subject || b.input?.description || `Task ${taskSeq}`, status: 'pending' });
          }
          if (b.name === 'TaskUpdate' && b.input?.taskId && tasks.has(String(b.input.taskId))) {
            const t = tasks.get(String(b.input.taskId));
            if (b.input.status === 'deleted') tasks.delete(String(b.input.taskId));
            else {
              if (b.input.status) t.status = b.input.status;
              if (b.input.subject) t.content = b.input.subject;
            }
            sample(e.timestamp, [...tasks.values()].filter((x) => x.status === 'completed').length);
          }
        }
      }
    }
  }

  if (!todos && tasks.size) todos = [...tasks.values()];

  const age = Date.now() - stat.mtimeMs;
  let status = 'idle', activity = '';
  const lastBlocks = lastAssistant?.message?.content || [];
  const lastBlock = lastBlocks[lastBlocks.length - 1];
  const toolOpen = pendingTool && !resolved.has(pendingTool.id);

  const askQ = (b) => {
    const q = b?.input?.questions?.[0]?.question || b?.input?.question;
    return q ? short(q, 160) : 'Claude asked you a question';
  };
  if (lastEntry?.type === 'assistant' && lastBlock?.type === 'tool_use' && toolOpen && /AskUserQuestion/i.test(lastBlock.name)) {
    status = age < 6 * 3600000 ? 'question' : 'idle'; activity = askQ(lastBlock);
  } else if (lastEntry?.type === 'user' && age < 180000) {
    status = 'working'; activity = 'Thinking…';
  } else if (lastEntry?.type === 'assistant' && lastBlock?.type === 'tool_use' && toolOpen) {
    if (age < 45000) { status = 'working'; activity = describeTool(lastBlock); }
    else if (age < 30 * 60000) { status = 'waiting'; activity = `${describeTool(lastBlock)} — may need your approval`; }
    else { status = 'idle'; activity = 'Stopped mid-task'; }
  } else if (lastEntry?.type === 'assistant' && age < 15000) {
    status = 'working'; activity = 'Writing a reply…';
  } else if (lastEntry?.type === 'assistant') {
    status = age < 6 * 3600000 ? 'done' : 'idle';
    activity = status === 'done' ? 'Finished — waiting for you' : 'Idle';
    // Ended its turn with a question for you?
    const tail = (lastText || '').trim().split('\n').filter(Boolean).pop() || '';
    if (status === 'done' && /\?\s*\**\s*$/.test(tail)) { status = 'question'; activity = short(tail.replace(/^[#>*\-\s]+/, ''), 160); }
  }

  const total = todos ? todos.length : 0;
  const done = todos ? todos.filter((t) => t.status === 'completed').length : 0;
  const active = todos ? todos.find((t) => t.status === 'in_progress') : null;

  return {
    id: sessionId || path.basename(file, '.jsonl'),
    file,
    project: cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : path.basename(path.dirname(file)),
    cwd,
    branch,
    model,
    title: short(title || summary || firstPrompt || 'Untitled session', 90),
    lastPrompt: lastPrompt && lastPrompt !== firstPrompt ? lastPrompt : null,
    lastText: lastText ? short(lastText, 200) : null,
    status,
    activity,
    currentStep: active ? (active.activeForm || active.content) : null,
    todos: todos ? todos.map((t) => ({ content: t.content || t.subject || '', status: t.status || 'pending', activeForm: t.activeForm })) : [],
    progress: total ? { done, total } : null,
    msPerStep: tLast && dLast > dStart ? Math.round((tLast - tStart) / (dLast - dStart)) : null,
    lastStepAt: tLast,
    turns,
    started,
    updated: stat.mtimeMs,
  };
}

class ClaudeSessions extends EventEmitter {
  constructor(getSettings) {
    super();
    this.getSettings = getSettings;
    this.cache = new Map();
    this.timer = null;
    this.sessions = [];
    this.root = null;
    this.found = false;
  }

  scan() {
    const s = this.getSettings();
    this.root = claudeRoot(s.claudeDir);
    const projects = path.join(this.root, 'projects');
    const cutoff = Date.now() - (s.claudeLookbackHours || 12) * 3600000;
    const files = [];
    try {
      for (const d of fs.readdirSync(projects, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const dir = path.join(projects, d.name);
        let names = [];
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const n of names) {
          if (!n.endsWith('.jsonl')) continue;
          const f = path.join(dir, n);
          try {
            const st = fs.statSync(f);
            if (st.mtimeMs >= cutoff) files.push({ f, st });
          } catch {}
        }
      }
      this.found = true;
    } catch {
      this.found = false;
    }

    files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    const out = [];
    for (const { f, st } of files.slice(0, 12)) {
      const c = this.cache.get(f);
      // Re-parse only when the file changed (or once a minute so "x min ago" status ages).
      if (c && c.size === st.size && c.mtime === st.mtimeMs && Date.now() - c.at < 60000) { out.push(c.data); continue; }
      try {
        const data = parseSession(f, st);
        if (!data.turns && !data.todos.length) continue; // empty / metadata-only file
        this.cache.set(f, { size: st.size, mtime: st.mtimeMs, at: Date.now(), data });
        out.push(data);
      } catch {}
    }
    const rank = { question: 0, waiting: 1, working: 2, done: 3, idle: 4 };
    out.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.updated - a.updated));
    this.sessions = out;
    const sig = JSON.stringify([this.found, out.map((x) => [x.id, x.status, x.activity, x.updated, x.progress])]);
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.emit('update', { sessions: out, root: this.root, found: this.found });
  }

  start(interval = 3000) {
    this.stop();
    this.lastSig = null;
    this.scan();
    // No Claude Code on this PC? Check rarely.
    this.timer = setInterval(() => this.scan(), this.found ? interval : Math.max(interval, 30000));
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

module.exports = { ClaudeSessions, parseSession };
