#!/usr/bin/env node
// Minimal MCP server (stdio, no dependencies) that forwards Claude's progress
// reports to the Now Playing desktop app on 127.0.0.1.
const http = require('http');
const readline = require('readline');

const PORT = Number(process.env.NOWPLAYING_PORT) || 47823;

const INSTRUCTIONS = `The user watches a desktop progress widget ("Now Playing"). Keep it accurate:
- At the start of any task with 2 or more steps, call progress_update with a short task name, done=0 and your planned total.
- After finishing each step, call progress_update again (increase done, describe the next step). Adjust total if the plan changes.
- Right before you end a turn with a question, a choice, or a request for approval that the user must answer, call ask_user_alert with that question.
- When the task is complete, call task_finished with a one-line summary.
Use the same task name for the whole task. These calls are cheap; don't mention them to the user.`;

const TOOLS = [
  {
    name: 'progress_update',
    description: 'Update the user\'s desktop progress bar for the task you are working on. Call it when you start a multi-step task (done=0) and after every completed step. Keep `task` the same for the whole task.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Short name of the task, 2-6 words, e.g. "Event report #5".' },
        done: { type: 'integer', minimum: 0, description: 'Steps completed so far.' },
        total: { type: 'integer', minimum: 1, description: 'Total planned steps.' },
        step: { type: 'string', description: 'What you are doing now, e.g. "Writing the budget section".' },
      },
      required: ['task', 'done', 'total'],
    },
  },
  {
    name: 'ask_user_alert',
    description: 'Send the user a desktop notification that you need their input. Call it immediately before ending your turn with a question, a choice, or a request for approval.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Same task name used in progress_update (or a short name of the chat).' },
        question: { type: 'string', description: 'The question or decision, in one short sentence.' },
      },
      required: ['task', 'question'],
    },
  },
  {
    name: 'task_finished',
    description: 'Mark the task finished on the user\'s desktop widget.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        summary: { type: 'string', description: 'One-line summary of the result.' },
      },
      required: ['task'],
    },
  },
];

function post(path, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path, method: 'POST', timeout: 2500,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'X-NowPlaying': '1' },
    }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(data);
  });
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function callTool(name, args = {}) {
  const map = { progress_update: '/claude/progress', ask_user_alert: '/claude/question', task_finished: '/claude/done' };
  if (!map[name]) throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 });
  const ok = await post(map[name], { ...args, at: Date.now() });
  // Never derail Claude if the widget isn't running.
  return { content: [{ type: 'text', text: ok ? 'ok' : 'ok (Now Playing app is not running; nothing shown)' }] };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'now-playing-claude-bridge', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    } else if (method === 'tools/list') {
      reply(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      reply(id, await callTool(params?.name, params?.arguments));
    } else if (method === 'ping') {
      reply(id, {});
    } else {
      fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    fail(id, e.code || -32603, e.message);
  }
});
