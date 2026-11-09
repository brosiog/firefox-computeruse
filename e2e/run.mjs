// End-to-end: the e2e build (.output/e2e) loaded into a real Firefox (headless, WebDriver BiDi via puppeteer-core),
// a fixture shop, and the scripted fake model. The agent runs the whole task: consent dialog, search, read, pick the
// cheapest, select quantity, wait for a late button, a target=_blank link, a cross-origin payment iframe, and the
// payment approval. The panel page reports its result back to the fixture server.
//
//   pnpm e2e            (FIREFOX=/path/to/firefox to use another build)
import { execSync } from 'node:child_process';
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
const shopOrigin = `http://127.0.0.1:${PORTS.shop}`;
execSync('pnpm exec wxt build -b firefox', { cwd: root, stdio: 'ignore', env: { ...process.env, WXT_E2E_URL: shopOrigin } });

// MODEL_URL / MODEL point the run at a real model server (e.g. Splash on the LAN) instead of the scripted fake.
const realModel = process.env.MODEL_URL;
const srv = await start();
state.config = {
  settings: {
    kind: 'openai', baseUrl: realModel ?? `http://127.0.0.1:${PORTS.model}/v1`, model: process.env.MODEL ?? 'fake-splash', apiKey: '', contextWindow: 65536,
    maxOutput: 400, temperature: 0.2, maxSteps: 30, pageBudget: 5000, approval: 'ask', vision: false,
    screenshotEachStep: false, reasoning: true, effort: 'none', structured: 'auto', keepAlive: '30m',
  },
  task: 'Find the cheapest USB hub, order 2 of them for Ada Lovelace, and tell me the order number.',
  tabUrl: shopOrigin,
};
const reported = new Promise(r => (state.onReport = r));

const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: ff,
  headless: true,
  dumpio: !!process.env.DUMPIO,
  extraPrefsFirefox: { 'devtools.console.stdout.chrome': !!process.env.DUMPIO, 'devtools.console.stdout.content': !!process.env.DUMPIO, 'xpinstall.signatures.required': false, 'extensions.originControls.grantByDefault': true,
    // The panel runs in a background tab here; a real sidebar is never throttled. Without these, every timer in the
    // agent rounds up to 1 s and act/settle timings are fiction.
    'dom.min_background_timeout_value': 4,
    'dom.min_background_timeout_value_without_budget_throttling': 4,
    'dom.timeout.enable_budget_timer_throttling': false, ...JSON.parse(process.env.FF_PREFS ?? '{}') },
});
let failed = false;
const t0 = Date.now();
try {
  await browser.installExtension(resolve(root, '.output/e2e'));
  const report = await Promise.race([reported, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: no report from the panel')), realModel ? 600000 : 150000))]);
  console.log('\n--- panel transcript ---\n' + report.transcript + '\n------------------------');
  const result = report.result;
  const order = state.orders[0];
  const checks = [
    ['agent reported success', result?.success === true],
    ['answer has the order number', !!order && result?.answer?.includes(order.number)],
    ['exactly one order placed', state.orders.length === 1],
    ['cheapest product (2) ordered', order?.p === '2'],
    ['quantity 2', order?.qty === '2'],
    ['name typed into the form', order?.name === 'Ada Lovelace'],
    ['payment went through the approval gate once', report.approvals === 1],
  ];
  if (!realModel) {
    checks.push(
      ['moz-extension Origin never reached the model server', state.originRejected === 0],
      // Prewarm requests (max_tokens 1) carry no schema by design; every agent step must.
      ['json_schema structured output requested', state.requests.some(r => r.max_tokens !== 1) && state.requests.filter(r => r.max_tokens !== 1).every(r => r.response_format === 'json_schema')],
      ['reasoning_effort "none" sent', state.requests.every(r => r.reasoning_effort === 'none')],
    );
  }
  const share = state.prefixShare.length ? state.prefixShare : [0];
  const avg = share.reduce((a, b) => a + b, 0) / Math.max(1, share.length);
  console.log(`model calls: ${state.requests.length}; prompt prefix reused from the previous call: avg ${(avg * 100).toFixed(1)}%, min ${(Math.min(...share) * 100).toFixed(1)}%`);
  console.log(`prompt sizes (chars): ${state.requests.map(r => r.flat.length).join(', ')}`);
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed = true;
  }
  console.log(`total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) {
  failed = true;
  console.error(e);
  console.error('requests so far:', state.requests.length, 'origin rejections:', state.originRejected);
  if (state.requests.length) console.error('last prompt tail:\n' + state.requests.at(-1).flat.slice(-1500));
} finally {
  await browser.close().catch(() => {});
  srv.close();
}
process.exit(failed ? 1 : 0);
