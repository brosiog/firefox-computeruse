// Agent bridge end to end: the extension (plus a hook that opens its panel as a tab) in a real headless Firefox, on
// the fixture shop, and bridge/fcu.mjs driving it from the command line exactly as a coding agent would.
//
//   pnpm e2e:bridge     (FIREFOX=/path/to/firefox to use another build)
import { execFile, execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { PORTS, start, state } from './server.mjs';

const root = resolve(import.meta.dirname, '..');
const ff = process.env.FIREFOX ?? resolve(root, 'e2e/.cache/firefox/firefox');
if (!existsSync(ff)) {
  console.error(`Firefox not found at ${ff}. Download it into e2e/.cache/firefox or set FIREFOX.`);
  process.exit(2);
}
const shop = `http://127.0.0.1:${PORTS.shop}`;
execSync('pnpm exec wxt build -b firefox', { cwd: root, stdio: 'ignore', env: { ...process.env, WXT_BRIDGE_TEST: shop } });
const port = process.env.FCU_BRIDGE_PORT ?? '47823';
const script = resolve(root, 'bridge/fcu.mjs');
const env = { ...process.env, FCU_BRIDGE_PORT: port };
// Async on purpose: the fixture shop is served from this process, so a sync child call would stall every page load.
const fcu = (...args) =>
  new Promise(res => execFile(process.execPath, [script, ...args], { env, encoding: 'utf8' }, (e, so, se) => res({ ok: !e, out: `${so}${e ? se : ''}` })));

// An MCP client (what a harness runs). Started first, it holds the hub; the CLI calls below relay through it.
function mcpClient() {
  const p = spawn(process.execPath, [script], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let buf = '';
  let n = 0;
  p.stdout.setEncoding('utf8').on('data', c => {
    buf += c;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
      const m = JSON.parse(buf.slice(0, i));
      pending.get(m.id)?.(m);
    }
  });
  const rpc = (method, params) => new Promise(r => (pending.set(++n, r), p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')));
  return { rpc, kill: () => p.kill() };
}

const srv = await start();
state.config = { settings: {}, task: '', tabUrl: shop };
const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: ff,
  headless: true,
  extraPrefsFirefox: {
    'xpinstall.signatures.required': false,
    'extensions.originControls.grantByDefault': true,
    // The panel runs in a background tab here (a real sidebar is never throttled).
    'dom.min_background_timeout_value': 4,
    'dom.min_background_timeout_value_without_budget_throttling': 4,
    'dom.timeout.enable_budget_timer_throttling': false,
  },
});
let failed = false;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n${detail}`}`);
  if (!ok) failed = true;
};
const mcp = mcpClient();
try {
  const init = await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  check('MCP initialize', init.result?.serverInfo?.name === 'firefox-computeruse', JSON.stringify(init));
  await browser.installExtension(resolve(root, '.output/e2e-bridge'));

  await new Promise(r => setTimeout(r, 1500)); // let the shop tab finish loading
  const st = await fcu('status');
  check('status: extension connected', st.ok && st.out.includes('connected'), st.out);

  const obs = await fcu('observe');
  check('observe returns the shop page with refs', obs.ok && obs.out.includes(`URL: ${shop}`) && /\[\d+\]/.test(obs.out), obs.out);

  // The cookie modal hides the page: accept it, then use the refs from the page state that comes back.
  const accept = /\[(\d+)\] button "Accept all"/.exec(obs.out)?.[1];
  const acc = await fcu('act', JSON.stringify({ tool: 'click', ref: accept }));
  check('act: click returns the new page state', acc.ok && !acc.out.includes('Modal dialog open') && acc.out.includes('<page>'), acc.out);
  const box = /\[(\d+)\] (?:searchbox|textbox)[^\n]*/i.exec(acc.out)?.[1];
  const act = box ? await fcu('act', JSON.stringify([{ tool: 'type', ref: box, text: 'usb hub', enter: true }])) : { ok: false, out: 'no search box in:\n' + acc.out };
  check('act: type + Enter searches', act.ok && act.out.includes('/search') && act.out.includes('<page>'), act.out);

  const nav = await fcu('act', JSON.stringify({ tool: 'navigate', url: `${shop}/` }), '--no-observe');
  check('act: navigate', nav.ok && nav.out.includes('opened'), nav.out);

  const shot = resolve(root, 'e2e/.results/bridge-shot.jpg');
  execSync(`mkdir -p ${resolve(root, 'e2e/.results')}`);
  const sc = await fcu('observe', '--shot', shot);
  check('observe --shot writes a screenshot', sc.ok && existsSync(shot), sc.out);

  const bad = await fcu('act', '{"tool":"click"}');
  check('invalid action is explained', !bad.ok && bad.out.includes('"ref"'), bad.out);

  // MCP tool calls on the real browser: a new tab, then back to the first one.
  const call = async (name, args) => (await mcp.rpc('tools/call', { name, arguments: args })).result;
  const nt = await call('browser_act', { actions: [{ tool: 'tab_new', url: `${shop}/search?q=hub` }] });
  const ntText = nt?.content?.[0]?.text ?? '';
  check('MCP browser_act: tab_new opens and observes the new tab', !nt?.isError && ntText.includes('URL: ' + shop + '/search?q=hub'), ntText);
  const sw = await call('browser_act', { actions: [{ tool: 'tab_switch', tab: 1 }] });
  const swText = sw?.content?.[0]?.text ?? '';
  check('MCP browser_act: tab_switch back', !sw?.isError && /URL: http:\/\/127\.0\.0\.1:\d+\/\n/.test(swText), swText);
  const ob = await call('browser_observe', { screenshot: true });
  check('MCP browser_observe returns text and a JPEG', ob?.content?.[1]?.mimeType === 'image/jpeg' && ob.content[1].data.length > 1000, JSON.stringify(ob).slice(0, 300));

  // Approval gates: the payment waits for the panel's answer (given by the fixture server in this build), and only an
  // allowed one goes through.
  const pay = async ans => {
    state.approveNext = ans;
    const co = await call('browser_act', { actions: [{ tool: 'navigate', url: `${shop}/checkout?p=2&qty=2` }] });
    const text = co?.content?.[0]?.text ?? '';
    const name = /\[(\d+)\] textbox "Full name"/.exec(text)?.[1];
    const place = /\[(\d+)\] button "Place order"/.exec(text)?.[1];
    const r = await call('browser_act', { actions: [{ tool: 'type', ref: name, text: 'Ada Lovelace' }, { tool: 'click', ref: place }] });
    return { r, text: r?.content?.[0]?.text ?? '' };
  };
  const before = state.orders.length;
  const yes = await pay('yes');
  check('gate: an allowed payment goes through', !yes.r.isError && state.orders.length === before + 1 && yes.text.includes('Order number') && state.gates.includes('pay'), yes.text);
  const no = await pay('no');
  check('gate: a declined payment is blocked and reported', no.r.isError && state.orders.length === before + 1 && no.text.includes('declined'), no.text);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  mcp.kill();
  await browser.close().catch(() => {});
  srv.close();
}
process.exit(failed ? 1 : 0);
