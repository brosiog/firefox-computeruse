// The login lab in real Firefox: every case in e2e/login-lab/cases.mjs, driven through the MCP bridge exactly as a
// coding agent would, against a fake bw serve, on many hostnames (Firefox resolves them all to 127.0.0.1).
//
//   pnpm e2e:login                 all cases
//   pnpm e2e:login std- fr-        cases whose id starts with any of these
import { spawn, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createBw } from './login-lab/bw.mjs';
import { CASES, HOST, HOSTS } from './login-lab/cases.mjs';
import { itemsOf, judge } from './login-lab/oracle.mjs';

const root = resolve(import.meta.dirname, '..');
const ff = process.env.FIREFOX ?? resolve(root, 'e2e/.cache/firefox/firefox');
if (!existsSync(ff)) {
  console.error(`Firefox not found at ${ff}. Run scripts/fetch-firefox.sh or set FIREFOX.`);
  process.exit(2);
}
const PORT = 8795;
const BW_PORT = 8796;
const BRIDGE_PORT = process.env.FCU_BRIDGE_PORT ?? '47823';
// A pairing token for this run only: fcu.mjs gets it from the environment, the panel from /e2e/settings.
const BRIDGE_TOKEN = randomBytes(32).toString('base64url');
const base = `http://${HOST}:${PORT}`;
const only = process.argv.slice(2);
const cases = CASES.filter(c => !only.length || only.some(p => c.id.startsWith(p)));

// ---------- the lab's web server (every host) ----------
const st = { c: null, reports: {}, atSubmit: {}, submissions: [], gates: [], gateWhat: [], approve: 'yes', approveDelay: 50 };
const LAB_JS = `(() => {
  const roots = (window.__roots = [document]);
  const fields = () => { const out = []; const seen = new Set(); const visit = r => { for (const el of r.querySelectorAll('*')) { if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !seen.has(el)) { seen.add(el); out.push(el); } if (el.shadowRoot) visit(el.shadowRoot); } }; roots.forEach(visit); return out; };
  const snap = () => ({ id: __case.id, frame: __case.frame, url: location.href, title: document.title, inputs: fields().map(el => ({ key: el.getAttribute('data-key') || el.name || el.id, want: el.getAttribute('data-want'), value: el.value, init: el.defaultValue, type: el.type, checked: el.checked })) });
  const send = atSubmit => navigator.sendBeacon('/lab/state', JSON.stringify({ ...snap(), atSubmit: atSubmit === true }));
  let t; const report = () => { clearTimeout(t); t = setTimeout(send, 30); };
  addEventListener('input', report, true); addEventListener('change', report, true); addEventListener('load', report); setInterval(report, 200);
  // A submit navigates away: report the fields as they were sent.
  addEventListener('submit', () => send(true), true); addEventListener('pagehide', send);
  window.__labSubmit = data => fetch('/lab/submit?id=' + __case.id, { method: 'POST', body: JSON.stringify(data) });
})();`;
const pageOf = (c, frame, html) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Lab ${c.id}</title><script>window.__case = ${JSON.stringify({ id: c.id, frame })}</script><script>${LAB_JS}</script></head><body>${html
    .replaceAll('{{SUBMIT}}', `/lab/submit?id=${c.id}`)
    .replace(/\{\{FRAME:(\w+)\}\}/g, (_m, n) => `http://${c.frames[n].host}:${PORT}/f/${c.id}/${n}`)}</body></html>`;
const body = req => new Promise(r => { let b = ''; req.on('data', d => (b += d)); req.on('end', () => r(b)); });
const parse = (b, type) => { try { return type?.includes('json') || b.startsWith('{') ? JSON.parse(b) : Object.fromEntries(new URLSearchParams(b)); } catch { return { raw: b }; } };

const web = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const html = (h, code = 200) => (res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }), res.end(h));
  const p = u.pathname;
  if (p === '/e2e/settings') {
    const s = { bridgeUrl: `http://127.0.0.1:${BRIDGE_PORT}`, bridgeToken: BRIDGE_TOKEN, vault: true, vaultUrl: `http://localhost:${BW_PORT}`, vaultAsk: true, vaultAgents: true };
    return (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(s)));
  }
  if (p === '/e2e/approve') {
    st.gates.push(u.searchParams.get('risk'));
    st.gateWhat.push(u.searchParams.get('what') ?? '');
    return setTimeout(() => (res.writeHead(200), res.end(st.approve)), st.approveDelay);
  }
  if (p === '/lab/state' && req.method === 'POST') {
    const r = parse(await body(req));
    if (st.c && r.id === st.c.id) {
      // After a sign-in the page may be a new one (a greeting, the form again with an error): judge the fields as they
      // were when the form was sent.
      if (r.atSubmit) st.atSubmit[r.frame] = r;
      else if (!st.atSubmit[r.frame]) st.reports[r.frame] = r;
    }
    return res.end('ok');
  }
  if (p === '/lab/submit') {
    const data = req.method === 'POST' ? parse(await body(req), req.headers['content-type']) : Object.fromEntries(u.searchParams);
    if (st.c && u.searchParams.get('id') === st.c.id) st.submissions.push({ host: req.headers.host, method: req.method, ...data });
    return html('<!doctype html><title>Submitted</title><h1>Submitted</h1><p>Thanks.</p>');
  }
  const cm = /^\/c\/([\w-]+)$/.exec(p);
  const fm = /^\/f\/([\w-]+)\/(\w+)$/.exec(p);
  const c = CASES.find(x => x.id === (cm?.[1] ?? fm?.[1]));
  if (c && cm) {
    if (req.method === 'POST') {
      const data = parse(await body(req), req.headers['content-type']);
      // Intermediate steps (?step=) are navigation; anything else posted to a case page is a sign-in.
      if (st.c?.id === c.id && !u.searchParams.has('step')) st.submissions.push({ host: req.headers.host, method: 'POST', ...data });
    }
    return html(pageOf(c, 'top', typeof c.html === 'function' ? c.html(u.searchParams) : c.html));
  }
  if (c && fm) return html(pageOf(c, fm[2], c.frames[fm[2]].html));
  if (p === '/') return html(`<!doctype html><title>Lab</title><h1>Login lab</h1>`);
  html('<!doctype html><title>Not found</title>Not found', 404);
});

// ---------- fake bw serve ----------
const bw = createBw();
const bwSrv = http.createServer(async (req, res) => {
  if (st.c?.bw === 'down') return req.socket.destroy();
  const b = await body(req);
  const r = bw.handle({ method: req.method, path: req.url, headers: req.headers, body: b });
  if (r.delay) await new Promise(x => setTimeout(x, r.delay));
  res.writeHead(r.status, { 'content-type': 'application/json' });
  res.end(r.body);
});
await new Promise(r => web.listen(PORT, '127.0.0.1', r));
await new Promise(r => bwSrv.listen(BW_PORT, '127.0.0.1', r));

// ---------- extension + Firefox + MCP ----------
execSync('pnpm exec wxt build -b firefox', { cwd: root, stdio: 'ignore', env: { ...process.env, WXT_BRIDGE_TEST: base } });
const script = resolve(root, 'bridge/fcu.mjs');
const env = { ...process.env, FCU_BRIDGE_PORT: BRIDGE_PORT, FCU_BRIDGE_TOKEN: BRIDGE_TOKEN };
const mcpProc = spawn(process.execPath, [script], { env, stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
let buf = '';
let rid = 0;
mcpProc.stdout.setEncoding('utf8').on('data', d => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
    const m = JSON.parse(buf.slice(0, i));
    pending.get(m.id)?.(m);
  }
});
const rpc = (method, params, ms = 60000) =>
  Promise.race([
    new Promise(r => (pending.set(++rid, r), mcpProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n'))),
    new Promise(r => setTimeout(() => r({ result: { isError: true, content: [{ text: `(lab) no answer after ${ms / 1000}s` }] } }), ms)),
  ]);
const call = async (name, args) => {
  const r = (await rpc('tools/call', { name, arguments: args }))?.result ?? {};
  return { ok: !r.isError, text: r.content?.[0]?.text ?? '' };
};

const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: ff,
  headless: true,
  extraPrefsFirefox: {
    'xpinstall.signatures.required': false,
    'extensions.originControls.grantByDefault': true,
    'network.dns.forceResolve': '127.0.0.1',
    'network.trr.mode': 5,
    'network.proxy.type': 0,
    'dom.min_background_timeout_value': 4,
    'dom.min_background_timeout_value_without_budget_throttling': 4,
    'dom.timeout.enable_budget_timer_throttling': false,
    'prompts.tab_modal.enabled': true,
  },
});
// The js-alert case: dismiss page dialogs the way a person would, so the run can go on.


const findRef = (text, re) => {
  for (const line of text.split('\n')) if (re.test(line)) return /^\s*\[([\d:]+)\]/.exec(line)?.[1];
  return undefined;
};

const out = [];
let failed = 0;
try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'login-lab', version: '1' } });
  await browser.installExtension(resolve(root, '.output/e2e-bridge'));
  await new Promise(r => setTimeout(r, 2000));
  // The lab tab opens after install: dismiss its dialogs (js-alert case) as a person would, or the page would block
  // and every later bridge call would queue behind it.
  for (const pg of await browser.pages()) if ((await pg.url()).startsWith(base)) pg.on('dialog', d => d.dismiss().catch(() => {}));
  const t0 = Date.now();
  for (const c of cases) {
    const started = Date.now();
    Object.assign(st, { c, reports: {}, atSubmit: {}, submissions: [], gates: [], gateWhat: [], approve: c.approve ?? 'yes', approveDelay: c.approveDelay ?? 50 });
    bw.items = itemsOf(c);
    bw.mode = c.bw === 'down' ? null : (c.bw ?? null);
    const url = `http://${c.host ?? HOST}:${PORT}/c/${c.id}`;
    let page = (await call('browser_act', { actions: [{ tool: 'navigate', url }] })).text;
    if (c.frames || c.ff) {
      await new Promise(r => setTimeout(r, c.frames ? 700 : 250));
      page = (await call('browser_observe', {})).text;
    }
    const results = [];
    for (const s of c.steps ?? [{ act: { tool: 'login' } }]) {
      const act = { ...s.act };
      if (s.ref) {
        const ref = findRef(page, s.ref);
        if (!ref) {
          results.push({ ok: false, text: `(lab) no ref matching ${s.ref} in:\n${page}` });
          break;
        }
        act.ref = ref;
      }
      const r = await call('browser_act', { actions: [act] });
      results.push(r);
      page = r.text;
    }
    await new Promise(r => setTimeout(r, 500));
    const last = (await call('browser_observe', {})).text;
    const fails = judge(c, { results, texts: [...results.map(r => r.text), last], lastPage: last, reports: Object.values({ ...st.reports, ...st.atSubmit }), submissions: st.submissions, gates: st.gates, gateWhat: st.gateWhat });
    if (fails.length) failed++;
    const ms = Date.now() - started;
    console.log(`${fails.length ? 'FAIL' : 'PASS'}  ${c.id.padEnd(30)} ${String(ms).padStart(5)}ms  ${c.title}${fails.length ? '\n        ' + fails.join('\n        ') : ''}`);
    out.push({ id: c.id, group: c.group, title: c.title, ff: !!c.ff, pass: !fails.length, fails, ms, results: results.map(r => ({ ok: r.ok, text: r.text.slice(0, 600) })) });
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed in ${((Date.now() - t0) / 1000).toFixed(0)}s; bw serve rejected ${bw.log.rejected} request(s) for an Origin or Host header`);
  if (bw.log.rejected) failed++;
} catch (e) {
  failed++;
  console.error(e);
} finally {
  mkdirSync(resolve(root, 'e2e/.results'), { recursive: true });
  writeFileSync(resolve(root, 'e2e/.results/login-lab.json'), JSON.stringify(out, null, 1));
  mcpProc.kill();
  await browser.close().catch(() => {});
  web.close();
  bwSrv.close();
}
process.exit(failed ? 1 : 0);
