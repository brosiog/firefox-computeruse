// Screenshots of the Bitwarden login UX in real (headless) Firefox, for review: the settings section (locked, unlocking,
// unlocked), the approval cards in the sidebar, the sidebar log after sign-ins, and the page with its fields filled.
// Uses the e2e:bridge build (Firefox's remote protocol cannot open extension pages; that build opens the panel as a tab
// itself). Its approval cards are the real ones; this script answers them through the fixture server, after the shot.
//
//   node e2e/screens.mjs [outDir]       (default e2e/.results/screens)
//   DARK=1 node e2e/screens.mjs         the same in dark mode
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createBw } from './login-lab/bw.mjs';

const root = resolve(import.meta.dirname, '..');
const ff = process.env.FIREFOX ?? resolve(root, 'e2e/.cache/firefox/firefox');
const outDir = resolve(process.argv[2] ?? resolve(root, 'e2e/.results/screens'));
mkdirSync(outDir, { recursive: true });
const dark = !!process.env.DARK;
const sfx = dark ? '-dark' : '';
const PORT = 8797;
const BW_PORT = 8798;

// ---------- a small, believable site ----------
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f4f5f7;color:#1d1d22}header{background:#24292f;color:#fff;padding:12px 24px;font-weight:600}
main{max-width:360px;margin:48px auto;background:#fff;border:1px solid #d8dbe0;border-radius:10px;padding:24px 28px}
h1{font-size:22px;margin:0 0 16px}label{display:block;margin:12px 0 4px;font-size:13px;color:#555}
input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #c5c9d0;border-radius:6px;font:inherit}
button{margin-top:18px;width:100%;padding:10px;border:0;border-radius:6px;background:#1f883d;color:#fff;font:600 15px system-ui}
.note{font-size:13px;color:#666;margin-top:14px}</style></head><body>${body}</body></html>`;
const signIn = page(
  'Sign in · Lab',
  `<header>Lab Cloud</header><main><h1>Sign in to Lab</h1><form method="post" action="/session">
  <label for="e">Email address</label><input id="e" name="email" type="email" autocomplete="username">
  <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password">
  <button type="submit">Sign in</button></form><p class="note">New here? <a href="#">Create an account</a></p></main>`,
);
const welcome = page('Dashboard · Lab', `<header>Lab Cloud</header><main><h1>Welcome back, ada@lab.test</h1><p>You are signed in.</p></main>`);
const framer = page('Win a prize!', `<header style="background:#8b1e3f">Prize Center</header><main style="max-width:520px"><h1>Claim your prize</h1><p>Sign in below to continue.</p><iframe src="http://login.lab.test:${PORT}/" style="width:100%;height:330px;border:1px solid #ccc;border-radius:8px"></iframe></main>`);
// Approval cards wait here until the script answers them (after taking the screenshot).
let answer = null;
const approvals = [];
const answerNext = v => new Promise(r => (answer = { v, r }));
const web = http.createServer((req, res) => {
  const host = (req.headers.host ?? '').split(':')[0];
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/e2e/settings') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ vault: true, vaultUrl: `http://localhost:${BW_PORT}`, vaultAsk: true, vaultAgents: true, bridgeUrl: 'http://127.0.0.1:47829', model: 'qwen3.8-27b-splash' }));
  }
  if (u.pathname === '/e2e/approve') {
    approvals.push(u.searchParams.get('what'));
    const wait = () => (answer ? (res.writeHead(200), res.end(answer.v), answer.r(), (answer = null)) : setTimeout(wait, 50));
    return wait();
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (req.method === 'POST') return req.on('data', () => {}).on('end', () => res.end(welcome));
  res.end(host === 'prizes.test' ? framer : signIn);
});
const bw = createBw();
bw.items = [
  { id: 'a1', type: 1, name: 'Lab Cloud', login: { username: 'ada@lab.test', password: 'Tr0ub4dor&3-lab', uris: [{ uri: 'http://lab.test' }] } },
  { id: 'a2', type: 1, name: 'Lab Cloud (work)', login: { username: 'ada.lovelace@corp.test', password: 'w0rk-pw-123', uris: [{ uri: 'http://lab.test' }] } },
];
let locked = true;
const bwSrv = http.createServer((req, res) => {
  let b = '';
  req.on('data', d => (b += d)).on('end', () => {
    if (req.url === '/unlock' && req.method === 'POST') locked = false;
    if (req.url === '/lock' && req.method === 'POST') locked = true;
    bw.mode = locked ? 'locked' : null;
    const r = req.url === '/unlock' || req.url === '/lock' ? { status: 200, body: JSON.stringify({ success: true, data: { object: 'message', title: 'ok' } }) } : bw.handle({ method: req.method, path: req.url, headers: req.headers });
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(r.body);
  });
});
await new Promise(r => web.listen(PORT, '127.0.0.1', r));
await new Promise(r => bwSrv.listen(BW_PORT, '127.0.0.1', r));

// ---------- Firefox with the e2e:bridge build ----------
const siteUrl = `http://www.lab.test:${PORT}`;
execSync('pnpm exec wxt build -b firefox', { cwd: root, stdio: 'ignore', env: { ...process.env, WXT_BRIDGE_TEST: siteUrl } });
const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: ff,
  headless: true,
  // Lets the remote protocol script and capture the panel (an extension page) for the screenshots.
  env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
  extraPrefsFirefox: {
    'xpinstall.signatures.required': false,
    'extensions.originControls.grantByDefault': true,
    'network.dns.forceResolve': '127.0.0.1',
    'network.trr.mode': 5,
    'ui.systemUsesDarkTheme': dark ? 1 : 0,
    'layout.css.prefers-color-scheme.content-override': dark ? 0 : 1,
    'dom.min_background_timeout_value': 4,
    'dom.timeout.enable_budget_timer_throttling': false,
  },
});
const env = { ...process.env, FCU_BRIDGE_PORT: '47829' };
const mcp = spawn(process.execPath, [resolve(root, 'bridge/fcu.mjs')], { env, stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
let buf = '';
let id = 0;
mcp.stdout.setEncoding('utf8').on('data', d => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
    const m = JSON.parse(buf.slice(0, i));
    pending.get(m.id)?.(m);
  }
});
const rpc = (method, params) => new Promise(r => (pending.set(++id, r), mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')));
const act = actions => rpc('tools/call', { name: 'browser_act', arguments: { actions } }).then(m => m.result?.content?.[0]?.text ?? '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shots = [];
let panelPage = null;
const shot = async (p, name, opts = {}) => {
  const path = resolve(outDir, `${name}${sfx}.png`);
  await p.screenshot({ path, ...(p === panelPage ? { clip: { x: 0, y: 0, width: 401, height: 820 } } : {}), ...opts });
  shots.push(path);
  console.log(path);
};

try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'screens', version: '1' } });
  await browser.installExtension(resolve(root, '.output/e2e-bridge'));
  await sleep(2500);
  const pages = await browser.pages();
  const site = pages.find(p => p.url().startsWith(siteUrl));
  // The remote protocol reports extension tabs as about:blank; the panel is the one with the panel's markup.
  let panel;
  for (const p of pages) if (p !== site && (await p.evaluate(() => !!document.getElementById('composer')).catch(e => (console.log('eval:', e.message.slice(0, 120)), false)))) panel = p;
  if (!site || !panel) throw new Error(`tabs not found: ${pages.map(p => p.url()).join(', ')}`);
  panelPage = panel;
  await site.setViewport({ width: 900, height: 640 });
  // Privileged pages cannot be resized over the remote protocol: lay the panel out at sidebar width, then clip to it.
  await panel.evaluate(() => {
    const st = document.createElement('style');
    st.textContent = 'html{width:400px;height:820px;overflow:hidden;border-right:1px solid #8884} body{height:820px} dialog{max-width:380px;max-height:800px;margin:10px}';
    document.head.append(st);
  });

  // 1. Settings: turn Bitwarden on, point it at bw serve, bridge on a test port; the vault starts locked.
  await panel.evaluate(s => document.querySelector(s).click(), '#gear');
  await sleep(300);
  await panel.evaluate(() => document.querySelector('fieldset.vault').scrollIntoView({ block: 'center' }));
  await panel.evaluate(s => document.querySelector(s).click(), '#vaultCheck');
  await sleep(500);
  await shot(panel, '01-settings-locked');
  await panel.type('#vaultPw', 'correct horse battery staple');
  await shot(panel, '02-settings-typing-master-password');
  await panel.evaluate(s => document.querySelector(s).click(), '#vaultUnlock');
  await sleep(600);
  await shot(panel, '03-settings-unlocked');
  await panel.evaluate(() => document.getElementById('save').click());
  await sleep(2500);

  // 2. Two saved accounts: the agent is shown a list (names, masked usernames) and nothing is filled.
  await act([{ tool: 'login' }]);
  // 3. It picks one; the approval card shows the site, the item and the masked username.
  const pending1 = act([{ tool: 'login', option: '1', enter: true }]);
  await panel.waitForSelector('.card .row button.primary', { timeout: 15000 });
  await sleep(300);
  await shot(panel, '04-approval-card');
  await shot(site, '05-page-before-fill');
  await answerNext('yes');
  const after = await pending1;
  await sleep(800);
  await shot(site, '06-page-after-sign-in');
  await shot(panel, '07-sidebar-log-after-sign-in');

  // 4. Fill without submitting, to show the fields as the page and the agent see them.
  await act([{ tool: 'navigate', url: `http://www.lab.test:${PORT}/` }]);
  const pending2 = act([{ tool: 'login', option: 'Lab Cloud (work)' }]);
  await sleep(1500);
  await answerNext('yes');
  const filled = await pending2;
  await sleep(500);
  await shot(site, '08-page-filled-not-submitted');

  // 5. A page from another site framing the real sign-in: the card says so. Declined.
  await act([{ tool: 'navigate', url: `http://prizes.test:${PORT}/` }]);
  await sleep(800);
  const obs = await rpc('tools/call', { name: 'browser_observe', arguments: {} }).then(m => m.result?.content?.[0]?.text ?? '');
  const ref = /\[(\d+:\d+)\] textbox "Email address"/.exec(obs)?.[1];
  const pending3 = act([{ tool: 'login', ref, option: '1' }]);
  await panel.waitForSelector('.card .row button.primary', { timeout: 15000 });
  await sleep(300);
  await shot(panel, '09-approval-card-framed-page');
  await shot(site, '10-framing-page');
  await answerNext('no');
  await pending3;
  await sleep(300);
  await shot(panel, '11-sidebar-log-declined');

  // What the agent got back, for the record (no secrets in it).
  console.log('\nagent saw after sign-in:\n' + after.split('\n').slice(0, 3).join('\n'));
  console.log('\nagent saw after fill:\n' + filled.split('\n').slice(0, 1).join('\n'));
  console.log('\napproval cards:\n' + approvals.join('\n'));
} finally {
  mcp.kill();
  await browser.close().catch(() => {});
  web.close();
  bwSrv.close();
}
