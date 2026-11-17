// Registers the progress connector ("now-playing") with the Claude desktop app by adding
// it to claude_desktop_config.json, and self-tests it so problems show up in our log.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SERVER_NAME = 'now-playing';

class ClaudeDesktop {
  constructor(app, log) {
    this.app = app;
    this.log = log || (() => {});
    this.dir = path.join(app.getPath('userData'), 'claude-bridge');
    this.script = path.join(this.dir, 'bridge.ps1');
    this.test = { state: 'not run' };
  }

  // Copy the PowerShell server out of app.asar to a stable path Claude can launch.
  install(srcScript, port) {
    fs.mkdirSync(this.dir, { recursive: true });
    const src = fs.readFileSync(srcScript, 'utf8');
    let cur = null;
    try { cur = fs.readFileSync(this.script, 'utf8'); } catch {}
    if (cur !== '\ufeff' + src) fs.writeFileSync(this.script, '\ufeff' + src, 'utf8');
    this.port = port;
  }

  entry() {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return {
      command: ps,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script],
      env: { NOWPLAYING_PORT: String(this.port || 47823) },
    };
  }

  configPaths() {
    const out = [];
    const roaming = process.env.APPDATA || this.app.getPath('appData');
    const classic = path.join(roaming, 'Claude');
    if (fs.existsSync(classic)) out.push(path.join(classic, 'claude_desktop_config.json'));
    // Microsoft Store / MSIX install keeps its files in a virtualised folder.
    try {
      const pk = path.join(process.env.LOCALAPPDATA || '', 'Packages');
      for (const d of fs.readdirSync(pk)) {
        if (!/^(Anthropic\.)?Claude/i.test(d)) continue;
        const dir = path.join(pk, d, 'LocalCache', 'Roaming', 'Claude');
        if (fs.existsSync(dir)) out.push(path.join(dir, 'claude_desktop_config.json'));
      }
    } catch {}
    return out;
  }

  status() {
    const paths = this.configPaths();
    const connected = paths.some((p) => {
      try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return !!j?.mcpServers?.[SERVER_NAME]; } catch { return false; }
    });
    return { claudeFound: paths.length > 0, connected, paths, test: this.test, logFile: path.join(this.dir, 'bridge.log') };
  }

  connect() {
    const paths = this.configPaths();
    if (!paths.length) throw new Error('Claude desktop app settings folder not found. Is the Claude app installed and opened at least once?');
    const written = [];
    for (const p of paths) {
      let cfg = {};
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        try { cfg = raw.trim() ? JSON.parse(raw) : {}; }
        catch { throw new Error(`Couldn't read ${p} (it isn't valid JSON), so I left it untouched.`); }
        const bak = p + '.nowplaying-backup';
        if (!fs.existsSync(bak)) fs.writeFileSync(bak, raw);
      }
      cfg.mcpServers = { ...(cfg.mcpServers || {}), [SERVER_NAME]: this.entry() };
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
      fs.renameSync(tmp, p);
      written.push(p);
      this.log('claude config updated: ' + p);
    }
    return { written, status: this.status() };
  }

  disconnect() {
    for (const p of this.configPaths()) {
      try {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (cfg?.mcpServers?.[SERVER_NAME]) { delete cfg.mcpServers[SERVER_NAME]; fs.writeFileSync(p, JSON.stringify(cfg, null, 2)); }
      } catch {}
    }
    return this.status();
  }

  // Start the connector the same way Claude does and check it answers.
  selfTest() {
    return new Promise((resolve) => {
      if (process.platform !== 'win32') { this.test = { state: 'skipped' }; resolve(this.test); return; }
      const e = this.entry();
      const started = Date.now();
      const p = spawn(e.command, e.args, { env: { ...process.env, ...e.env }, windowsHide: true });
      let out = '', err = '';
      const finish = (state, extra = {}) => {
        if (this.test.done) return;
        this.test = { state, ms: Date.now() - started, done: true, ...extra, stderr: err.slice(0, 400) || undefined };
        try { p.kill(); } catch {}
        this.log(`bridge self-test: ${state} ${JSON.stringify(extra)} ${err ? 'stderr=' + err.slice(0, 400) : ''}`);
        resolve(this.test);
      };
      this.test = { state: 'running' };
      const timer = setTimeout(() => finish('timeout', { got: out.slice(0, 300) }), 15000);
      p.stdout.setEncoding('utf8');
      p.stderr.setEncoding('utf8');
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', (x) => { clearTimeout(timer); finish('failed', { error: x.message }); });
      p.on('exit', (code) => { if (!this.test.done) { clearTimeout(timer); finish('exited', { code, got: out.slice(0, 300) }); } });
      p.stdout.on('data', (d) => {
        out += d;
        const lines = out.split('\n').filter((l) => l.trim());
        let tools = null, init = false;
        for (const l of lines) {
          try {
            const j = JSON.parse(l.replace(/^\ufeff/, ''));
            if (j.id === 1 && j.result?.serverInfo) init = true;
            if (j.id === 2 && Array.isArray(j.result?.tools)) tools = j.result.tools.map((t) => t.name);
          } catch { /* partial */ }
        }
        if (init && tools) { clearTimeout(timer); finish(tools.length === 3 ? 'ok' : 'bad-tools', { tools }); }
      });
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } } }) + '\n');
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    });
  }
}

module.exports = { ClaudeDesktop };
