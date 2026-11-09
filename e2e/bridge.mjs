// Agent bridge end to end: the extension (plus a hook that opens its panel as a tab) in a real headless Firefox, on
// the fixture shop, and bridge/fcu.mjs driving it from the command line exactly as a coding agent would.
//
//   pnpm e2e:bridge     (FIREFOX=/path/to/firefox to use another build)
import { execFileSync, execSync } from 'node:child_process';
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
const fcu = (...args) => {
  try {
    return { ok: true, out: execFileSync(process.execPath, [resolve(root, 'bridge/fcu.mjs'), ...args], { env: { ...process.env, FCU_BRIDGE_PORT: port }, encoding: 'utf8' }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

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
try {
  await browser.installExtension(resolve(root, '.output/e2e-bridge'));

  await new Promise(r => setTimeout(r, 1500)); // let the shop tab finish loading
  const st = fcu('status');
  check('status: extension connected', st.ok && st.out.includes('connected'), st.out);

  const obs = fcu('observe');
  check('observe returns the shop page with refs', obs.ok && obs.out.includes(`URL: ${shop}`) && /\[\d+\]/.test(obs.out), obs.out);

  // The cookie modal hides the page: accept it, then use the refs from the page state that comes back.
  const accept = /\[(\d+)\] button "Accept all"/.exec(obs.out)?.[1];
  const acc = fcu('act', JSON.stringify({ tool: 'click', ref: accept }));
  check('act: click returns the new page state', acc.ok && !acc.out.includes('Modal dialog open') && acc.out.includes('<page>'), acc.out);
  const box = /\[(\d+)\] (?:searchbox|textbox)[^\n]*/i.exec(acc.out)?.[1];
  const act = box ? fcu('act', JSON.stringify([{ tool: 'type', ref: box, text: 'usb hub', enter: true }])) : { ok: false, out: 'no search box in:\n' + acc.out };
  check('act: type + Enter searches', act.ok && act.out.includes('/search') && act.out.includes('<page>'), act.out);

  const nav = fcu('act', JSON.stringify({ tool: 'navigate', url: `${shop}/` }), '--no-observe');
  check('act: navigate', nav.ok && nav.out.includes('opened'), nav.out);

  const shot = resolve(root, 'e2e/.results/bridge-shot.jpg');
  execSync(`mkdir -p ${resolve(root, 'e2e/.results')}`);
  const sc = fcu('observe', '--shot', shot);
  check('observe --shot writes a screenshot', sc.ok && existsSync(shot), sc.out);

  const bad = fcu('act', '{"tool":"click"}');
  check('invalid action is explained', !bad.ok && bad.out.includes('"ref"'), bad.out);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close().catch(() => {});
  srv.close();
}
process.exit(failed ? 1 : 0);
