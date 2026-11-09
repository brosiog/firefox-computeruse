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
import { parseAttack } from './security/attacks.mjs';
import { rng } from './lib/gen.mjs';

const root = resolve(import.meta.dirname, '..');

function args() {
  const a = process.argv.slice(2);
  const o = { config: [], model: 'oracle', modelId: '', split: 'both', families: 'all', perturb: 'base', attack: 'none', seeds: 2, repeat: 1, maxSteps: 25, label: '', port: 8795, budget: 0 };
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
// --attack none | sample | vector:goal[,…] | sample×N (N seeded samples per task)
const attacks = String(opt.attack).split(',').flatMap(a => {
  const m = /^sample[x×](\d+)$/.exec(a);
  return m ? Array.from({ length: Number(m[1]) }, () => 'sample') : [a];
});
for (const f of families) if (!FAMILIES[f]) throw new Error(`unknown family ${f}; have ${Object.keys(FAMILIES).join(', ')}`);
for (const p of perturbs) if (!PERTURBATIONS[p]) throw new Error(`unknown perturbation ${p}`);

const ff = process.env.FIREFOX ?? resolve(root, 'e2e/.cache/firefox/firefox');
if (!existsSync(ff)) throw new Error(`Firefox not found at ${ff}`);
const srv = createServer(opt.port);
await srv.listen();
const modelUrl = opt.model === 'oracle' ? `${srv.origin}/v1` : opt.model;
const modelId = opt.model === 'oracle' ? 'oracle' : opt.modelId || 'default';

// --ext <dir>: install a prebuilt bench extension instead (e.g. an older version, for before/after comparisons).
const extDir = opt.ext ? resolve(String(opt.ext)) : resolve(root, '.output/e2e');
if (!opt.ext) {
  console.log('building the bench extension…');
  execSync('pnpm exec wxt build -b firefox', { cwd: root, stdio: 'ignore', env: { ...process.env, WXT_E2E_URL: srv.origin } });
}
const { DEFAULTS } = await import(resolve(root, 'bench/.build/core.mjs'));

// ---------- the matrix ----------
const jobs = [];
let i = 0;
for (const cfg of configs)
  for (const split of splits)
    for (let s = 0; s < opt.seeds; s++)
      for (const family of families)
        for (const perturb of perturbs)
          for (const [ai, attackSpec] of attacks.entries())
          for (let r = 0; r < opt.repeat; r++) {
            const seed = (split === 'dev' ? 1000 : 9000) + s * 17 + Object.keys(FAMILIES).indexOf(family);
            const ctx = makeCtx(split, seed);
            const inst = FAMILIES[family].make(ctx);
            const attack = attackSpec === 'none' ? null : parseAttack(attackSpec, { split }, rng(seed * 31 + ai * 7919 + 13));
            const akey = attack ? `.a-${attack.vector}-${attack.goal}-${attack.wording}` : '';
            jobs.push({
              id: `j${++i}`,
              key: `${split}.${family}.${perturb}${akey}.s${seed}.r${r}`,
              attack,
              config: cfg.name,
              split, family, perturb, seed, rep: r, ctx, inst, data: inst.data,
              timeoutMs: opt.timeoutSec ? Number(opt.timeoutSec) * 1000 : opt.model === 'oracle' ? 90000 : 600000,
              settings: { ...DEFAULTS, kind: 'openai', baseUrl: modelUrl, model: modelId, maxSteps: opt.maxSteps, approval: 'ask', ...cfg.over },
            });
          }
console.log(`${jobs.length} jobs: ${configs.length} config(s) × ${splits.join('+')} × ${opt.seeds} seed(s) × ${families.length} families × ${perturbs.length} perturbation(s) × ${attacks.length} attack(s) × ${opt.repeat} repeat(s)`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = resolve(root, 'bench/.results', `${stamp}${opt.label ? '-' + opt.label : ''}`);
mkdirSync(resolve(outDir, 'traces'), { recursive: true });

const launch = () => puppeteer.launch({
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
let browser = await launch();
let restarts = 0;
// Waits until the model server answers (not for the oracle, which is served here).
const modelUp = async () => {
  if (opt.model === 'oracle') return;
  for (let i = 0, said = false; ; i++) {
    try {
      const r = await fetch(`${modelUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) return;
    } catch {}
    if (!said) console.log(`model server unreachable at ${modelUrl}: pausing until it answers`), (said = true);
    await new Promise(r => setTimeout(r, 15000));
  }
};
srv.setGate(modelUp);
// An episode lost to the model server (unreachable, 503 while its engine recovers) says nothing about the agent:
// it is run again once the server is back, up to twice.
const lostToServer = a => /^Model error: (cannot reach|model server error 5\d\d)/.test(a.answer ?? '');
let retries = 0;
// The job's own wall-clock limit, counted from when the extension picked it up (not while it waits for the server).
const waitJob = (job, p) =>
  Promise.race([
    p,
    new Promise(r => {
      const tick = setInterval(() => {
        if (job.startedAt && Date.now() - job.startedAt > job.timeoutMs + 30000) clearInterval(tick), r(null);
      }, 1000);
      p.then(() => clearInterval(tick));
    }),
  ]);
const episodes = [];
const t0 = Date.now();
try {
  const done = jobs.map(j => srv.enqueue(j));
  await browser.installExtension(extDir);
  let finished = 0;
  for (const [idx, p] of done.entries()) {
    const job = jobs[idx];
    // Each job also has its own wall-clock limit, enforced here as well as in the extension.
    const got = await waitJob(job, p);
    // A hung job can wedge the extension's job loop (older builds wait forever on a question to the user), and then
    // every later job would "time out" with 0 steps. Restart Firefox so one hang costs one episode, not the run.
    if (!got) {
      await browser.close().catch(() => {});
      browser = await launch();
      await browser.installExtension(extDir);
      restarts++;
    }
    let a = analyze(job, got ? job.report : null);
    for (let t = 0; t < 2 && got && lostToServer(a); t++) {
      retries++;
      console.log(`    retrying ${job.key}: ${a.answer.slice(0, 90)}`);
      job.startedAt = undefined;
      const again = await waitJob(job, srv.retry(job));
      a = analyze(job, again ? job.report : null);
      if (!again) break;
    }
    const ep = {
      id: job.id, key: job.key, config: job.config, split: job.split, family: job.family, perturb: job.perturb, seed: job.seed, rep: job.rep,
      goal: job.inst.goal, pass: a.pass, reason: a.reason, category: a.category, answer: a.answer, success: a.success,
      metrics: a.metrics, firstWrong: a.firstWrong, attack: job.attack, security: a.security, steps: a.steps.map(({ action, ...s }) => ({ ...s, action })),
    };
    episodes.push(ep);
    writeFileSync(resolve(outDir, 'traces', `${job.id}.json`), JSON.stringify({ ...ep, traces: job.report?.traces ?? [], transcript: job.report?.transcript }, null, 1));
    finished++;
    const m = a.metrics;
    console.log(`${String(finished).padStart(3)}/${jobs.length} ${a.pass ? 'PASS' : 'FAIL'} ${job.config.padEnd(8)} ${job.key.padEnd(34)} ${String(m.steps).padStart(2)} steps ${((m.wallMs ?? 0) / 1000).toFixed(1).padStart(5)}s ${a.pass ? '' : `${a.category}: ${a.reason}`}`);
  }
} finally {
  await browser.close().catch(() => {});
  srv.close();
}

const meta = { label: opt.label || stamp, when: new Date().toISOString(), model: modelId, wallSec: (Date.now() - t0) / 1000, restarts, retries, opt };
writeFileSync(resolve(outDir, 'episodes.jsonl'), episodes.map(e => JSON.stringify(e)).join('\n') + '\n');
writeFileSync(resolve(outDir, 'meta.json'), JSON.stringify(meta, null, 1));
const report = renderReport(episodes, meta);
writeFileSync(resolve(outDir, 'report.md'), report);
writeFileSync(resolve(outDir, 'failures.md'), renderFailures(episodes));
console.log('\n' + report + `\n\nresults: ${outDir}`);
// --min-pass <0..1>: exit 1 when the pass rate over all planned jobs (a job that never ran counts as a failure) is
// below the bar. CI runs the oracle with --min-pass 1: anything short of 100% is an extension or harness bug.
if (opt.minPass !== undefined) {
  const bar = Number(opt.minPass);
  const passed = episodes.filter(e => e.pass).length;
  const rate = jobs.length ? passed / jobs.length : 0;
  const line = `${passed}/${jobs.length} passed (${(rate * 100).toFixed(1)}%), bar ${(bar * 100).toFixed(1)}%`;
  if (!(rate >= bar)) {
    console.error(`\nbench gate FAILED: ${line}`);
    for (const e of episodes.filter(e => !e.pass)) console.error(`  ${e.key}  ${e.category}: ${e.reason}`);
    if (episodes.length < jobs.length) console.error(`  ${jobs.length - episodes.length} job(s) never ran (the run stopped on a stuck job)`);
    process.exit(1);
  }
  console.log(`bench gate: ${line}`);
}
process.exit(0);
