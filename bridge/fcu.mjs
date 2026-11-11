#!/usr/bin/env node
// Agent bridge for Firefox Browser Use: lets coding agents (Claude Code, Codex, Hermes, pi, …) drive the browser
// through the extension. Zero dependencies, Node 18+.
//
//   node bridge/fcu.mjs                 MCP server on stdio (what harnesses launch)
//   node bridge/fcu.mjs status          is the extension connected?
//   node bridge/fcu.mjs observe [--shot out.jpg] [--budget 8000]
//   node bridge/fcu.mjs act '{"tool":"click","ref":"12"}' [--no-observe]   (one action or a JSON array)
//   node bridge/fcu.mjs task "find the cheapest hub and report its price" [--max-steps 30]
//   node bridge/fcu.mjs serve           run the hub on its own (optional)
//   node bridge/fcu.mjs token           print the pairing token to paste in the sidebar's Settings → Agent bridge
//
// How it connects: the sidebar page long-polls a small HTTP hub on 127.0.0.1 (port 47823, FCU_BRIDGE_PORT). The first
// bridge process to start becomes the hub; later ones (other harnesses, CLI calls) relay their calls through it, and
// take over the port if the hub's process exits. Nothing listens beyond loopback. The bridge is off in the extension
// until the user enters the hub URL and the pairing token in Settings → Agent bridge.
//
// Pairing token: other local processes (other OS users included) can reach a loopback port, so the hub and the
// extension share a secret. It is 32 random bytes made on first use and kept in $XDG_CONFIG_HOME/fcu/token (default
// ~/.config/fcu/token; file 0600, directory 0700), or FCU_BRIDGE_TOKEN. Its UTF-8 text is the HMAC-SHA256 key for:
//   - requests (/poll, /result, /call, /ping): `authorization: FCU <ms>.<nonce>.<hex mac>`, mac over
//     "fcu-req\n<ms>\n<nonce>\n<path>\n<raw body>"; fresh (±60 s) and never reused. The token itself never goes on the
//     wire, so a process squatting the port learns nothing. `authorization: Bearer <token>` works too (curl, scripts).
//   - commands the hub hands the extension on /poll: { id, cmd: "<json text>", sig }, sig = hex mac over
//     "<id>\n<session>\n<json text>". The extension runs only commands with a valid sig, so a fake hub can't drive it.
//   - the hub's answer to /call: header `x-fcu-sig`, hex mac over "fcu-reply\n<request nonce>\n<raw body>", checked
//     by the relaying process, so a fake hub can't feed agents made-up page states.
//
// Web pages cannot use the hub either: every request needs the `x-fcu` and `authorization` headers (a cross-origin page
// can't send them without a CORS preflight, which the hub never grants), a loopback Host (no DNS rebinding), and no
// Origin other than the extension's own.

import http from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const PORT = Number(process.env.FCU_BRIDGE_PORT || 47823);
const HOST = '127.0.0.1';
const VERSION = '0.1.0';
const POLL_MS = 25000;
const TIMEOUT = { status: 5000, observe: 120000, act: 300000, task: 1800000 };
const AUTH_WINDOW_MS = 60000;

// ---------------------------------------------------------------- pairing token

const TOKEN_FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'fcu', 'token');
let tokenCache = null;

/** The pairing token: FCU_BRIDGE_TOKEN, else the per-user token file (created on first use). */
function token() {
  if (tokenCache) return tokenCache;
  const env = process.env.FCU_BRIDGE_TOKEN?.trim();
  if (env) return (tokenCache = env);
  const read = () => readFileSync(TOKEN_FILE, 'utf8').trim();
  try {
    tokenCache = read();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    mkdirSync(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
    try {
      // 'wx': if another bridge process wins the race, use its token.
      writeFileSync(TOKEN_FILE, randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
    } catch (e2) {
      if (e2.code !== 'EEXIST') throw e2;
    }
    tokenCache = read();
  }
  // Tighten what may have been created loosely (umask, by hand). Best effort: not every filesystem has modes.
  try {
    chmodSync(dirname(TOKEN_FILE), 0o700);
    chmodSync(TOKEN_FILE, 0o600);
  } catch {}
  // Another bridge process may have created the file a moment ago and not written it yet.
  for (let i = 0; !tokenCache && i < 20; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    tokenCache = read();
  }
  if (!tokenCache) throw new Error(`${TOKEN_FILE} is empty: delete it to make a new pairing token`);
  return tokenCache;
}

const mac = msg => createHmac('sha256', token()).update(msg).digest('hex');
const sha = s => createHash('sha256').update(String(s)).digest();
/** Constant-time string comparison (hashing first makes the lengths equal). */
const same = (a, b) => timingSafeEqual(sha(a), sha(b));

function authHeader(path, raw) {
  const ts = Date.now();
  const nonce = randomBytes(16).toString('base64url');
  return { nonce, header: `FCU ${ts}.${nonce}.${mac(`fcu-req\n${ts}\n${nonce}\n${path}\n${raw}`)}` };
}

const nonces = new Map(); // nonce → when it was used (kept past AUTH_WINDOW_MS, so it can't be replayed)

/** Checks a request's pairing token. Returns { nonce } (null for Bearer) when it is valid, false when not. */
function authorized(req, raw) {
  const a = String(req.headers.authorization ?? '');
  if (a.startsWith('Bearer ')) return same(a.slice(7).trim(), token()) && { nonce: null };
  const m = /^FCU (\d{1,16})\.([\w-]{16,64})\.([0-9a-f]{64})$/.exec(a);
  if (!m) return false;
  const [, ts, nonce, sig] = m;
  if (Math.abs(Date.now() - Number(ts)) > AUTH_WINDOW_MS || nonces.has(nonce)) return false;
  if (!same(sig, mac(`fcu-req\n${ts}\n${nonce}\n${req.url}\n${raw}`))) return false;
  nonces.set(nonce, Date.now());
  return { nonce };
}

// ---------------------------------------------------------------- hub

let hub = null; // http.Server when this process is the hub
const queue = []; // commands waiting for the extension: { id, cmd, resolve, reject, timer }
const inflight = new Map(); // id → same, delivered to the extension
const waiters = new Map(); // session → the extension's pending /poll: { res, timer, at }
const seen = new Map(); // session → last time it polled or answered
const STALE_MS = POLL_MS + 10000; // a live sidebar polls at least this often, even while it works on a call

const live = () => [...seen.values()].some(t => Date.now() - t < STALE_MS);
const extConnected = () => waiters.size > 0 || [...seen.values()].some(t => Date.now() - t < 4000) || (inflight.size > 0 && live());

function deliver() {
  if (!waiters.size || !queue.length) return;
  // Several sidebars (windows) may be open: the one that polled last is the one in use.
  const [sid, w] = [...waiters].sort((a, b) => b[1].at - a[1].at)[0];
  waiters.delete(sid);
  clearTimeout(w.timer);
  const job = queue.shift();
  job.session = sid;
  inflight.set(job.id, job);
  // The command goes as JSON text, signed byte for byte: the extension checks the sig before it parses anything.
  const cmd = JSON.stringify(job.cmd ?? null);
  send(w.res, 200, { id: job.id, cmd, sig: mac(`${job.id}\n${sid}\n${cmd}`) });
}

// A sidebar that stopped polling was closed or reloaded: its calls will never be answered.
setInterval(() => {
  for (const [id, job] of inflight) {
    if (Date.now() - (seen.get(job.session) ?? 0) > STALE_MS) {
      inflight.delete(id);
      job.reject(new Error('the Firefox sidebar was closed or reloaded during the call'));
    }
  }
  for (const [sid, t] of seen) if (Date.now() - t > STALE_MS * 4) seen.delete(sid);
  for (const [n, t] of nonces) if (Date.now() - t > AUTH_WINDOW_MS * 3) nonces.delete(n);
}, 5000).unref();

function hubCall(cmd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const job = { id, cmd, resolve, reject };
    job.timer = setTimeout(() => {
      queue.splice(queue.indexOf(job) >>> 0, 1);
      inflight.delete(id);
      reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser`));
    }, timeoutMs);
    // Not connected: give a sidebar that is between polls (or retrying) a few seconds before failing.
    const grace = extConnected()
      ? undefined
      : setTimeout(() => {
          if (extConnected() || !queue.includes(job)) return;
          queue.splice(queue.indexOf(job), 1);
          job.reject(new Error(`Firefox Browser Use is not connected. Open its sidebar in Firefox (Ctrl+Shift+A, or Alt+Shift+A on Linux/Windows); in its Settings → Agent bridge, the URL must be http://127.0.0.1:${PORT} and the pairing token the one \`node bridge/fcu.mjs token\` prints.`));
        }, 5000);
    const done = fn => v => (clearTimeout(job.timer), clearTimeout(grace), fn(v));
    job.resolve = done(resolve);
    job.reject = done(reject);
    queue.push(job);
    deliver();
  });
}

function send(res, code, body, headers = () => ({})) {
  if (res.writableEnded) return;
  if (body === undefined) return res.writeHead(code, headers('')).end();
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), ...headers(s) }).end(s);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', c => {
      s += c;
      if (s.length > 64e6) req.destroy();
    });
    req.on('end', () => resolve(s));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const origin = req.headers.origin;
  const hostOk = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '');
  if (req.method !== 'POST' || !req.headers['x-fcu'] || !hostOk || (origin && !origin.startsWith('moz-extension://'))) return send(res, 403, { error: 'forbidden' });
  let raw, body;
  try {
    raw = await readBody(req);
  } catch {
    return send(res, 400, { error: 'bad request' });
  }
  const auth = authorized(req, raw);
  if (!auth) return send(res, 403, { error: 'forbidden: wrong or missing pairing token' });
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return send(res, 400, { error: 'bad json' });
  }
  switch (req.url) {
    case '/ping':
      return send(res, 200, { fcu: VERSION, connected: extConnected() });
    case '/poll': {
      const sid = String(body.session ?? 'default');
      seen.set(sid, Date.now());
      // An empty reply is signed over the poll's nonce too, so a hub without the token can't even look connected.
      const idle = w => send(w.res, 204, undefined, () => (w.nonce ? { 'x-fcu-sig': mac(`fcu-idle\n${w.nonce}`) } : {}));
      const prev = waiters.get(sid);
      if (prev) clearTimeout(prev.timer), idle(prev);
      const w = { res, at: Date.now(), nonce: auth.nonce };
      w.timer = setTimeout(() => {
        if (waiters.get(sid) === w) waiters.delete(sid);
        seen.set(sid, Date.now());
        idle(w);
      }, POLL_MS);
      res.on('close', () => {
        if (waiters.get(sid) === w) waiters.delete(sid), clearTimeout(w.timer);
      });
      waiters.set(sid, w);
      return deliver();
    }
    case '/result': {
      if (body.session) seen.set(String(body.session), Date.now());
      const job = inflight.get(body.id);
      inflight.delete(body.id);
      job?.resolve(body.result);
      return send(res, 204);
    }
    case '/call': {
      // Signed, so the relaying process knows the answer came from a hub that has the token.
      const sign = s => (auth.nonce ? { 'x-fcu-sig': mac(`fcu-reply\n${auth.nonce}\n${s}`) } : {});
      try {
        send(res, 200, { result: await hubCall(body.cmd, body.timeoutMs ?? 60000) }, sign);
      } catch (e) {
        send(res, 200, { error: e.message }, sign);
      }
      return;
    }
    default:
      return send(res, 404, { error: 'not found' });
  }
}

function listen() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => void handle(req, res).catch(e => send(res, 500, { error: String(e) })));
    srv.requestTimeout = 0;
    srv.headersTimeout = 10000;
    srv.once('error', () => resolve(null));
    srv.listen(PORT, HOST, () => resolve(srv));
  });
}

// ---------------------------------------------------------------- client side (relay to an existing hub)

function post(path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const auth = authHeader(path, data);
    const headers = { 'x-fcu': '1', authorization: auth.header, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) };
    const req = http.request({ host: HOST, port: PORT, path, method: 'POST', headers, timeout: timeoutMs }, res => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', c => (s += c));
      res.on('end', () => {
        if (res.statusCode === 403) return reject(new Error(`the bridge hub on ${HOST}:${PORT} refused this process's pairing token (a hub run by another user? set FCU_BRIDGE_PORT)`));
        const sig = String(res.headers['x-fcu-sig'] ?? '');
        if (path === '/call' && !same(sig, mac(`fcu-reply\n${auth.nonce}\n${s}`)))
          return reject(new Error(`the process on ${HOST}:${PORT} answered without the pairing token: it is not your fcu bridge hub (set FCU_BRIDGE_PORT)`));
        try {
          resolve(s ? JSON.parse(s) : {});
        } catch {
          reject(new Error(`port ${PORT} is in use by something that is not the fcu bridge`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out waiting for the bridge hub')));
    req.on('error', reject);
    req.end(data);
  });
}

async function ensure() {
  if (hub) return;
  hub = await listen();
  if (hub) return;
  // Someone holds the port: make sure it is a bridge hub.
  const r = await post('/ping', {}, 3000).catch(e => ({ error: e.message }));
  if (!r.fcu) throw new Error(r.error ?? `port ${PORT} is in use by something that is not the fcu bridge (set FCU_BRIDGE_PORT)`);
}

/** Sends a command to the browser, through this process's hub or another one's. */
async function call(cmd) {
  const timeoutMs = TIMEOUT[cmd.op] ?? 120000;
  for (let attempt = 0; ; attempt++) {
    await ensure();
    if (hub) return hubCall(cmd, timeoutMs);
    try {
      const r = await post('/call', { cmd, timeoutMs }, timeoutMs + 5000);
      if (r.error) throw new Error(r.error);
      return r.result;
    } catch (e) {
      // The hub's process exited before the request reached it: take over the port and retry once. Never retry a
      // request that may have reached the browser (an action could run twice).
      if (e.code === 'ECONNREFUSED' && attempt === 0) continue;
      throw e;
    }
  }
}

// ---------------------------------------------------------------- MCP (stdio, JSON-RPC 2.0, one message per line)

const ACTIONS_DOC = `Each action is one JSON object, same vocabulary as the in-browser agent:
{"tool":"click","ref":"12"}  {"tool":"type","ref":"5","text":"...","enter":true}  {"tool":"select","ref":"7","option":"Large"}
{"tool":"key","key":"Escape"} (optional ref)  {"tool":"scroll","dir":"down"} (optional ref)  {"tool":"hover","ref":"3"}
{"tool":"navigate","url":"example.com"}  {"tool":"back"}  {"tool":"read","query":"price"} (full page text; offset pages)
{"tool":"find","text":"Contact us"} (search the whole page for elements/text, returns refs)
{"tool":"tab_new","url":"..."}  {"tool":"tab_switch","tab":2}  {"tool":"tab_close"}  {"tool":"wait","seconds":2}
{"tool":"login","enter":true} signs in with the user's saved Bitwarden login for the site (you never see the username or password; optional ref picks the form, option picks an account when several are listed). Available only when the user allowed agents to use Bitwarden (otherwise it is an unknown tool).
Refs are the bracketed numbers in the page state ("12", or "3:7" inside frames). Actions run in order and stop at the first failure or page change; what did not run is reported. Actions may wait for the user's approval in the sidebar, depending on its approval level (status shows it): every = every action, ask = submits, sends, deletes, payments and passwords, auto = payments and passwords only, off = never.`;

const TOOLS = [
  {
    name: 'browser_observe',
    description: 'Read the current Firefox tab as compact text: URL, title, tabs, and visible elements with refs like [12] button "Search". Call before acting on a page you have not seen.',
    inputSchema: {
      type: 'object',
      properties: {
        screenshot: { type: 'boolean', description: 'Also return a JPEG screenshot with refs drawn on it.' },
        budget: { type: 'integer', description: 'Max characters of page state (default 8000).' },
      },
    },
  },
  {
    name: 'browser_act',
    description: `Run one or more actions in the current Firefox tab, then return the new page state (so you rarely need browser_observe after). ${ACTIONS_DOC}`,
    inputSchema: {
      type: 'object',
      properties: {
        actions: { type: 'array', items: { type: 'object' }, description: 'Actions to run in order, e.g. [{"tool":"type","ref":"5","text":"usb hub","enter":true}].' },
        observe: { type: 'boolean', description: 'Return the page state afterwards (default true).' },
        screenshot: { type: 'boolean', description: 'Also return a screenshot afterwards.' },
      },
      required: ['actions'],
    },
  },
  {
    name: 'browser_task',
    description: 'Delegate a whole browsing task to the extension\'s own local-model agent, which works step by step in the current tab and returns its answer. Cheaper on your context for multi-step chores (search, fill a form, collect facts); use browser_observe/browser_act when you need precise control. If it needs information only you have, it stops and returns its question: call again with the answer included in the task.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What to do, with every detail it needs (names, quantities, what to report back).' },
        max_steps: { type: 'integer', description: 'Step limit (default: the extension setting).' },
      },
      required: ['task'],
    },
  },
];

function toContent(r) {
  const content = [{ type: 'text', text: r?.text ?? '' }];
  if (r?.image) content.push({ type: 'image', data: r.image, mimeType: 'image/jpeg' });
  return { content, isError: r?.ok === false };
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'browser_observe':
      return call({ op: 'observe', screenshot: !!args.screenshot, budget: args.budget });
    case 'browser_act': {
      let actions = args.actions;
      if (typeof actions === 'string') actions = JSON.parse(actions);
      if (!Array.isArray(actions)) actions = [actions];
      return call({ op: 'act', actions, observe: args.observe !== false, screenshot: !!args.screenshot });
    }
    case 'browser_task':
      return call({ op: 'task', task: String(args.task ?? ''), maxSteps: args.max_steps });
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function mcp() {
  const out = m => process.stdout.write(JSON.stringify(m) + '\n');
  const reply = (id, result) => out({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });
  // Take the port early so the sidebar connects before the first tool call.
  void ensure().catch(e => process.stderr.write(`fcu bridge: ${e.message}\n`));
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) void onMessage(line);
    }
  });
  process.stdin.on('end', () => process.exit(0));

  async function onMessage(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return fail(null, -32700, 'parse error');
    }
    const { id, method, params } = m;
    if (id === undefined) return; // notifications (initialized, cancelled)
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'firefox-computeruse', version: VERSION },
          instructions: 'Drives the user\'s real Firefox through the Firefox Browser Use extension (its sidebar must be open). Start with browser_observe, act with browser_act using refs from the page state, or hand a whole chore to browser_task.',
        });
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: TOOLS });
      case 'tools/call':
        try {
          return reply(id, toContent(await callTool(params?.name, params?.arguments)));
        } catch (e) {
          return reply(id, { content: [{ type: 'text', text: e.message }], isError: true });
        }
      default:
        return fail(id, -32601, `method not found: ${method}`);
    }
  }
}

// ---------------------------------------------------------------- CLI

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

async function cli(argv) {
  const [cmd, ...args] = argv;
  const shot = flag(args, '--shot');
  const budget = flag(args, '--budget');
  const maxSteps = flag(args, '--max-steps');
  const noObserve = args.includes('--no-observe') ? (args.splice(args.indexOf('--no-observe'), 1), true) : false;
  let r;
  switch (cmd) {
    case 'status': {
      await ensure();
      const p = hub ? { connected: extConnected() } : await post('/ping', {}, 3000);
      if (!p.connected && hub) await new Promise(res => setTimeout(res, 4000)); // let a sidebar between retries find us
      const ok = hub ? extConnected() : p.connected;
      console.log(ok ? 'connected' : `not connected: open the Firefox Browser Use sidebar, with the URL http://${HOST}:${PORT} and the pairing token from \`node bridge/fcu.mjs token\` in its Settings → Agent bridge`);
      process.exit(ok ? 0 : 1);
    }
    case 'observe':
      r = await call({ op: 'observe', screenshot: !!shot, budget: budget ? Number(budget) : undefined });
      break;
    case 'act': {
      let actions = JSON.parse(args.join(' ') || '[]');
      if (!Array.isArray(actions)) actions = [actions];
      r = await call({ op: 'act', actions, observe: !noObserve, screenshot: !!shot });
      break;
    }
    case 'task':
      r = await call({ op: 'task', task: args.join(' '), maxSteps: maxSteps ? Number(maxSteps) : undefined });
      break;
    case 'token':
      console.log(token());
      console.error(`Paste it in Firefox Browser Use → Settings → Agent bridge, with the URL http://${HOST}:${PORT}.`);
      process.exit(0);
    case 'serve':
      token(); // made now, so `token` and the first relay agree with this hub
      await ensure();
      if (!hub) {
        console.error(`a bridge hub already runs on ${HOST}:${PORT}`);
        process.exit(1);
      }
      console.error(`fcu bridge hub on http://${HOST}:${PORT}`);
      return;
    default:
      console.error('usage: fcu.mjs [mcp | status | observe [--shot f.jpg] | act <json> [--no-observe] | task <text> [--max-steps n] | serve | token]');
      process.exit(2);
  }
  if (shot && r?.image) {
    writeFileSync(shot, Buffer.from(r.image, 'base64'));
    r.text += `\n(screenshot saved to ${shot})`;
  }
  console.log(r?.text ?? '');
  process.exit(r?.ok === false ? 1 : 0);
}

const argv = process.argv.slice(2);
if (!argv.length || argv[0] === 'mcp') mcp();
else
  cli(argv).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
