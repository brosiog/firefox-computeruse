// Live run: the real extension in real Firefox on the open web, full auto, with web_search on.
// Each task starts on a blank local page; the agent must search and click through to other sites.
//   FIREFOX=<firefox binary> node bench/live.mjs --model <url> --model-id <id> [--set short|long|video|big] [--only id,…] [--approval off|ask] [--headed]
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const root = resolve(import.meta.dirname, '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const modelUrl = arg('model');
const modelId = arg('model-id', 'default');
const approval = arg('approval', 'off');
const only = arg('only', '');
const port = 8796;
const origin = `http://127.0.0.1:${port}`;

const TASKS = [
  { id: 'firefox', task: 'Find the latest stable Firefox release, open Mozilla\'s release notes page for it, and tell me the version number and its release date.' },
  { id: 'rust', task: 'Find the Wikipedia article about the Rust programming language, then follow a link from it to the official Rust website, and tell me the current stable Rust version shown there.' },
  { id: 'wxt', task: 'Find the GitHub repository of the WXT web extension framework, open it, then click through to its documentation website and tell me the main heading on the documentation home page.' },
  { id: 'python', task: 'Find the latest Python 3 release on python.org, then follow the link to the "What\'s New" page for that version on docs.python.org and name one new feature it lists.' },
  { id: 'hn', task: 'Open Hacker News (news.ycombinator.com), click the link of the top story to go to the site it points to, and tell me that page\'s headline and which website it is on.' },
  { id: 'mdn', task: 'Find the MDN Web Docs page for the JavaScript Array.prototype.at() method, then follow its link to the ECMAScript specification and tell me the section title shown there.' },
];
// Longer horizon: several tabs, facts carried between them, and an action at the end (on sites made for testing).
const LONG = [
  { id: 'peaks', task: 'Open the Wikipedia articles for Mount Everest and for K2, each in its own tab. Using the elevations in metres from each article, tell me which is taller and by how many metres.' },
  { id: 'todo-hn', task: 'Open the TodoMVC React example at todomvc.com in one tab. In a second tab, open Hacker News (news.ycombinator.com) and note the titles of the top 3 stories. Then switch back to the TodoMVC tab, add each of those 3 titles as a todo, mark the second one as completed, and tell me how many items the app says are left.' },
  { id: 'form', task: 'Find the current stable Rust version on rust-lang.org and the latest Python 3 version on python.org, each in its own tab. Then open https://httpbin.org/forms/post in a third tab, fill in Customer name "Bench Test", choose the Medium pizza size, write both versions in Delivery instructions, submit the order, and tell me what the server echoed back for the instructions.' },
  { id: 'internet', task: 'On the-internet.herokuapp.com, open "Dynamic Loading" example 2, click Start, and note the text that appears when loading finishes. Then open the "Checkboxes" page of the same site in a new tab and make both checkboxes checked. Tell me the text you noted and the final state of both checkboxes.' },
  { id: 'releases', task: 'Open the GitHub releases page of the wxt-dev/wxt repository in one tab and the GitHub releases page of the vitejs/vite repository in another. Tell me the latest release name of each and which one was published more recently.' },
];
const VIDEO = [
  { id: 'yt-lyric', task: 'Open https://www.youtube.com/watch?v=dQw4w9WgXcQ and, using the video\'s transcript, tell me the first line that is sung and at what time it starts.' },
  { id: 'yt-talk', task: 'Open https://www.youtube.com/watch?v=iG9CE55wbtY and, from its transcript, tell me at what time the speaker first mentions Shakespeare and what he says about him.' },
  { id: 'tiktok', task: 'Find a TikTok video (a tiktok.com/@…/video/… page) that explains how to make cold brew coffee, open it, and use its transcript to tell me the steps it describes. If it has no transcript, try another video.' },
  { id: 'x-video', task: 'Find a public post on x.com from @NASA that contains a video, open it, and use the video\'s transcript to tell me what it is about. If the post or video cannot be viewed without signing in, say so.' },
  { id: 'yt-search', task: 'Go to youtube.com, search for the TED talk "Do schools kill creativity", open it, and from its transcript tell me the first sentence the speaker says.' },
];
const NOBUY = ' Do not add anything to a cart, sign in, or buy anything.';
const BIG = [
  { id: 'earbuds', task: 'On YouTube, find a recent video that compares budget wireless earbuds, open it, and read its transcript to list the products it compares. Then, for up to 3 of those products, find the lowest price you can right now by checking at least two different stores or a price comparison site, and open each product at its cheapest offer in its own tab. Tell me each product, the lowest price, the store, and the URL.' + NOBUY },
  { id: 'keyboards', task: 'Find a YouTube video comparing budget mechanical keyboards, open it, and use its transcript to note which keyboards it recommends. Then, for up to 3 of them, compare prices across stores and open each one at its cheapest offer in its own tab. Report each keyboard with its lowest price, store and URL, and say which one the video liked best.' + NOBUY },
];
const set = arg('set', 'short');
const pool = set === 'long' ? LONG : set === 'video' ? VIDEO : set === 'big' ? BIG : set === 'all' ? [...TASKS, ...LONG] : TASKS;
const picked = only ? pool.filter((x, i) => only.split(',').includes(String(i + 1)) || only.split(',').includes(x.id)) : pool;

const settings = {
  kind: 'openai', baseUrl: modelUrl, model: modelId, apiKey: '', contextWindow: 131072, maxOutput: 400, temperature: 0.2,
  maxSteps: set === 'short' ? 25 : set === 'big' ? 80 : 45, pageBudget: 5000, approval, vision: false, screenshotEachStep: false, reasoning: true, effort: 'none',
  structured: 'auto', keepAlive: '30m', history: 'extend', historyBudget: 16000, bridgeUrl: '', vault: false,
  vaultUrl: 'http://localhost:8087', vaultAsk: true, vaultAgents: false, webSearch: true,
};

const queue = picked.map(t => ({ ...t, job: `live-${t.id}`, timeoutMs: set === 'short' ? 480000 : set === 'big' ? 1800000 : 900000 }));
const reports = new Map();
const waiters = new Map();
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, origin);
  if (u.pathname === '/e2e/next') {
    const j = queue.shift();
    if (!j) return res.writeHead(204).end();
    j.startedAt = Date.now();
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      id: j.job, settings, task: j.task, startUrl: `${origin}/start/${j.id}`, tabUrl: `${origin}/start/${j.id}`, approve: 'yes', timeoutMs: j.timeoutMs,
    }));
  }
  if (u.pathname === '/e2e/report') {
    let b = '';
    for await (const c of req) b += c;
    const r = JSON.parse(b);
    reports.set(r.job, { ...r, endedAt: Date.now() });
    waiters.get(r.job)?.();
    return res.writeHead(200).end('ok');
  }
  if (/^\/start\/[\w-]+$/.test(u.pathname)) return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>New tab</title><body><p>Start page.</p></body>');
  res.writeHead(404).end();
});
await new Promise(r => srv.listen(port, '127.0.0.1', r));

console.log('building the e2e extension…');
execSync('pnpm exec wxt build -b firefox', { cwd: root, stdio: 'ignore', env: { ...process.env, WXT_E2E_URL: origin } });
const browser = await puppeteer.launch({
  browser: 'firefox', executablePath: process.env.FIREFOX, headless: !process.argv.includes('--headed'),
  extraPrefsFirefox: { 'xpinstall.signatures.required': false, 'extensions.originControls.grantByDefault': true,
    'dom.min_background_timeout_value': 4, 'dom.min_background_timeout_value_without_budget_throttling': 4, 'dom.timeout.enable_budget_timer_throttling': false },
});
const out = resolve(root, 'bench/.results', `live-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${set}-${approval}`);
mkdirSync(out, { recursive: true });
try {
  await browser.installExtension(resolve(root, '.output/e2e'));
  const rows = [];
  for (const t of picked) {
    const job = `live-${t.id}`;
    const t0 = Date.now();
    await Promise.race([new Promise(r => waiters.set(job, r)), new Promise(r => setTimeout(r, set === 'short' ? 540000 : set === 'big' ? 1900000 : 960000))]);
    const rep = reports.get(job);
    const traces = rep?.traces ?? [];
    const urls = [...new Set(traces.map(x => { try { return new URL(x.url).host; } catch { return ''; } }).filter(h => h && !h.startsWith('127.0.0.1')))];
    const tools = traces.flatMap(x => [x.action?.tool, ...(x.action?.then ?? []).map(c => c.tool)]).filter(Boolean);
    const errs = traces.filter(x => x.result && !x.result.ok).map(x => String(x.result.text).slice(0, 160));
    const row = {
      id: t.id, ok: rep?.result?.success ?? false, answer: rep?.result?.answer ?? '(no report: timed out)', steps: traces.length,
      sec: Math.round((Date.now() - t0) / 1000), sites: urls, searches: tools.filter(x => x === 'web_search').length, transcripts: tools.filter(x => x === 'transcript').length,
      clicks: tools.filter(x => x === 'click').length, tabOps: tools.filter(x => /^tab_|switch/.test(x)).length, approvals: rep?.approvals ?? 0, securityDeclines: rep?.securityDeclines ?? 0, errors: errs,
      modelSec: Math.round(traces.reduce((n, x) => n + (x.ms?.model ?? 0), 0) / 1000),
    };
    rows.push(row);
    writeFileSync(resolve(out, `${t.id}.json`), JSON.stringify({ ...row, task: t.task, traces, transcript: rep?.transcript }, null, 1));
    console.log(`${row.ok ? 'DONE' : 'FAIL'} ${t.id.padEnd(8)} ${String(row.steps).padStart(2)} steps ${String(row.sec).padStart(4)}s  search ${row.searches} click ${row.clicks} tabs ${row.tabOps} transcript ${row.transcripts}  sites: ${row.sites.join(', ')}`);
    console.log(`     answer: ${row.answer.replace(/\s+/g, ' ').slice(0, 300)}`);
    if (row.securityDeclines) console.log(`     security declines: ${row.securityDeclines}`);
    for (const e of row.errors) console.log(`     error: ${e.replace(/\s+/g, ' ')}`);
  }
  writeFileSync(resolve(out, 'summary.json'), JSON.stringify(rows, null, 1));
  console.log(`results: ${out}`);
} finally {
  await browser.close().catch(() => {});
  srv.close();
}

process.exit(0);
