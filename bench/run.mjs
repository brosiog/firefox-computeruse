// Bench runner: builds the bench copy of the extension, launches one headless Firefox, and runs the job matrix
// (configs × splits × families × perturbations × seeds × repeats) through the real extension, then judges every
// step against the oracle and writes a report.
//
//   node bench/run.mjs --model oracle                         # self-test: every task solvable, harness overhead
//   node bench/run.mjs --model http://192.168.86.202:8000/v1 --model-id qwen3.8-27b-splash --seeds 1
//   node bench/run.mjs ... --families shop,form --perturb base,noise,popup --repeat 2
//   node bench/run.mjs ... --config base --config 'b2500={"pageBudget":2500}' --config 'nothink={"reasoning":false}'
//   node bench/run.mjs ... --split holdout          (report holdout only when you are done tuning)
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { analyze } from './lib/analyze.mjs';
import { makeCtx } from './lib/gen.mjs';
import { PERTURBATIONS } from './lib/perturb.mjs';
import { renderFailures, renderReport } from './lib/report.mjs';
import { createServer } from './lib/server.mjs';
import { FAMILIES } from './families/index.mjs';
import { lintPrompts } from './lint.mjs';

const root = resolve(import.meta.dirname, '..');

function args() {
  const a = process.argv.slice(2);
  const o = { config: [], model: 'oracle', modelId: '', split: 'both', families: 'all', perturb: 'base', seeds: 2, repeat: 1, maxSteps: 25, label: '', port: 8795, budget: 0 };
  for (let i = 0; i < a.length; i++) {
    const key = a[i].replace(/^--/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase());
    const val = a[i + 1];
    if (key === 'config') o.config.push(val);
    else o[key] = /^\d+$/.test(val) ? Number(val) : val;
    i++;
  }
  if (!o.config.length) o.config = ['base'];
  return o;
}

const opt = args();
const configs = opt.config.map(c => {
  const m = /^([\w.-]+)(?:=(.*))?$/s.exec(c);
  if (!m) throw new Error(`bad --config ${c}`);
  let over = m[2] ? JSON.parse(m[2]) : {};
  if (over.systemFile) over = { ...over, systemOverride: readFileSync(resolve(over.systemFile), 'utf8') };
  delete over.systemFile;
  return { name: m[1], over };
});

execSync('pnpm exec vite build -c bench/vite.core.config.ts', { cwd: root, stdio: 'ignore' });
const lint = await lintPrompts(configs.map(c => c.over.systemOverride).filter(Boolean));
if (lint.length) {
  console.error('Prompt lint failed: fixture vocabulary in the system prompt (this would tune the agent to the bench):\n' + lint.join('\n'));
  process.exit(3);
}

const families = opt.families === 'all' ? Object.keys(FAMILIES) : String(opt.families).split(',');
const perturbs = String(opt.perturb === 'all' ? Object.keys(PERTURBATIONS).join(',') : opt.perturb).split(',');
const splits = opt.split === 'both' ? ['dev', 'holdout'] : [opt.split];
for (const f of families) if (!FAMILIES[f]) throw new Error(`unknown family ${f}; have ${Object.keys(FAMILIES).join(', ')}`);
for (const p of perturbs) if (!PERTURBATIONS[p]) throw new Error(`unknown perturbation ${p}`);

const ff = process.env.FIREFOX ?? resolve(root, 'e2e/.cache/firefox/firefox');
if (!existsSync(ff)) throw new Error(`Firefox not found at ${ff}`);
const srv = createServer(opt.port);
await srv.listen();
const modelUrl = opt.model === 'oracle' ? `${srv.origin}/v1` : opt.model;
const modelId = opt.model === 'oracle' ? 'oracle' : opt.modelId || 'default';

console.log('building the bench extension…');
execSync('pnpm exec wxt build -b firefox', { cwd: root, stdio: 'ignore', env: { ...process.env, WXT_E2E_URL: srv.origin } });
const { DEFAULTS } = await import(resolve(root, 'bench/.build/core.mjs'));

// ---------- the matrix ----------
const jobs = [];
let i = 0;
for (const cfg of configs)
  for (const split of splits)
    for (let s = 0; s < opt.seeds; s++)
      for (const family of families)
        for (const perturb of perturbs)
          for (let r = 0; r < opt.repeat; r++) {
            const seed = (split === 'dev' ? 1000 : 9000) + s * 17 + Object.keys(FAMILIES).indexOf(family);
            const ctx = makeCtx(split, seed);
            const inst = FAMILIES[family].make(ctx);
            jobs.push({
              id: `j${++i}`,
              key: `${split}.${family}.${perturb}.s${seed}.r${r}`,
              config: cfg.name,
              split, family, perturb, seed, rep: r, ctx, inst, data: inst.data,
              timeoutMs: opt.model === 'oracle' ? 90000 : 600000,
              settings: { ...DEFAULTS, kind: 'openai', baseUrl: modelUrl, model: modelId, maxSteps: opt.maxSteps, approval: 'ask', ...cfg.over },
            });
          }
console.log(`${jobs.length} jobs: ${configs.length} config(s) × ${splits.join('+')} × ${opt.seeds} seed(s) × ${families.length} families × ${perturbs.length} perturbation(s) × ${opt.repeat} repeat(s)`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = resolve(root, 'bench/.results', `${stamp}${opt.label ? '-' + opt.label : ''}`);
mkdirSync(resolve(outDir, 'traces'), { recursive: true });

const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: ff,
  headless: true,
  extraPrefsFirefox: { 'xpinstall.signatures.required': false, 'extensions.originControls.grantByDefault': true,
    // The panel runs in a background tab here; a real sidebar is never throttled. Without these, every timer in the
    // agent rounds up to 1 s and act/settle timings are fiction.
    'dom.min_background_timeout_value': 4,
    'dom.min_background_timeout_value_without_budget_throttling': 4,
    'dom.timeout.enable_budget_timer_throttling': false },
});
const episodes = [];
const t0 = Date.now();
try {
  const done = jobs.map(j => srv.enqueue(j));
  await browser.installExtension(resolve(root, '.output/e2e'));
  let finished = 0;
  for (const [idx, p] of done.entries()) {
    const job = jobs[idx];
    // Each job also has its own wall-clock limit, enforced here as well as in the extension.
    const timedOut = new Promise(r => setTimeout(() => r(null), job.timeoutMs + 30000 + idx * 0));
    const got = await Promise.race([p, timedOut]);
    const a = analyze(job, got ? job.report : null);
    const ep = {
      id: job.id, key: job.key, config: job.config, split: job.split, family: job.family, perturb: job.perturb, seed: job.seed, rep: job.rep,
      goal: job.inst.goal, pass: a.pass, reason: a.reason, category: a.category, answer: a.answer, success: a.success,
      metrics: a.metrics, firstWrong: a.firstWrong, steps: a.steps.map(({ action, ...s }) => ({ ...s, action })),
    };
    episodes.push(ep);
    writeFileSync(resolve(outDir, 'traces', `${job.id}.json`), JSON.stringify({ ...ep, traces: job.report?.traces ?? [], transcript: job.report?.transcript }, null, 1));
    finished++;
    const m = a.metrics;
    console.log(`${String(finished).padStart(3)}/${jobs.length} ${a.pass ? 'PASS' : 'FAIL'} ${job.config.padEnd(8)} ${job.key.padEnd(34)} ${String(m.steps).padStart(2)} steps ${((m.wallMs ?? 0) / 1000).toFixed(1).padStart(5)}s ${a.pass ? '' : `${a.category}: ${a.reason}`}`);
    if (!got) break; // the extension is stuck on this job; later jobs would wait behind it
  }
} finally {
  await browser.close().catch(() => {});
  srv.close();
}

const meta = { label: opt.label || stamp, when: new Date().toISOString(), model: modelId, wallSec: (Date.now() - t0) / 1000, opt };
writeFileSync(resolve(outDir, 'episodes.jsonl'), episodes.map(e => JSON.stringify(e)).join('\n') + '\n');
writeFileSync(resolve(outDir, 'meta.json'), JSON.stringify(meta, null, 1));
const report = renderReport(episodes, meta);
writeFileSync(resolve(outDir, 'report.md'), report);
writeFileSync(resolve(outDir, 'failures.md'), renderFailures(episodes));
console.log('\n' + report + `\n\nresults: ${outDir}`);
process.exit(0);
