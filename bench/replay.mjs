// Frozen-step replay: take decision points recorded by a bench run (exact prompt the model saw + the oracle's verdict
// for that page) and re-ask them under prompt variants. No browser; one model call per point per variant, so a prompt
// change gets a paired, step-level accuracy delta in minutes instead of a full suite run.
//
//   node bench/replay.mjs --from bench/.results/<run> --model http://<model-server>:8000/v1 --model-id <model-id>
//        [--variants base,no-rules,drop-rule-3|all] [--limit 40] [--pick hard|all]
//
// --pick hard (default) takes every step the original run got wrong plus an equal number of right ones, so both
// "does this fix mistakes" and "does this break what worked" are measured.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { makeCtx } from './lib/gen.mjs';
import { interruptions, judge, view } from './lib/oracle.mjs';
import { promptVariants, tokensOf } from './lib/variants.mjs';
import { FAMILIES } from './families/index.mjs';

const root = resolve(import.meta.dirname, '..');
const a = process.argv.slice(2);
const opt = { limit: 40, pick: 'hard', variants: 'all', modelId: 'default' };
for (let i = 0; i < a.length; i += 2) opt[a[i].replace(/^--/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase())] = a[i + 1];
if (!opt.from || !opt.model) {
  console.error('usage: node bench/replay.mjs --from <results dir> --model <url> [--model-id id] [--variants all|a,b] [--limit n]');
  process.exit(2);
}
execSync('pnpm exec vite build -c bench/vite.core.config.ts', { cwd: root, stdio: 'ignore' });
const core = await import(resolve(root, 'bench/.build/core.mjs'));

// ---------- decision points ----------
const dir = resolve(opt.from);
const points = [];
for (const f of readdirSync(resolve(dir, 'traces'))) {
  const ep = JSON.parse(readFileSync(resolve(dir, 'traces', f), 'utf8'));
  const ctx = makeCtx(ep.split, ep.seed);
  const inst = FAMILIES[ep.family].make(ctx);
  for (const t of ep.traces ?? []) {
    const url = (/^URL: (https?:\/\/[^/]+)/m.exec(t.messages.at(-1).content) || [])[1] ?? 'http://127.0.0.1:8795';
    const job = { id: ep.id, ctx, inst, data: inst.data, origin: url, base: `/t/${ep.id}`, log: [] };
    let verdict = null;
    try {
      const v = view(t.messages);
      verdict = interruptions(v, job) ?? inst.oracle(v, job);
    } catch {
      verdict = null;
    }
    if (!verdict) continue;
    points.push({ key: `${ep.key}#${t.n}`, family: ep.family, messages: t.messages, verdict, orig: t.parseError ? 'invalid' : judge(verdict, t.action) });
  }
}
const rnd = (() => {
  let s = 7;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
})();
const shuffle = xs => xs.map(x => [rnd(), x]).sort((p, q) => p[0] - q[0]).map(p => p[1]);
let chosen;
if (opt.pick === 'hard') {
  const bad = shuffle(points.filter(p => p.orig === 'wrong' || p.orig === 'invalid'));
  const good = shuffle(points.filter(p => p.orig === 'ok'));
  const half = Math.ceil(Number(opt.limit) / 2);
  chosen = [...bad.slice(0, half), ...good.slice(0, Number(opt.limit) - Math.min(half, bad.length))];
} else chosen = shuffle(points).slice(0, Number(opt.limit));
console.log(`${points.length} decision points (${points.filter(p => p.orig !== 'ok').length} not ok in the original run); replaying ${chosen.length}`);

// ---------- variants ----------
const all = promptVariants(core);
const names = opt.variants === 'all' ? Object.keys(all) : opt.variants.split(',');
const settingsBase = { ...core.DEFAULTS, kind: 'openai', baseUrl: opt.model, model: opt.modelId, maxOutput: 400 };
const results = {};
for (const name of names) {
  const v = all[name];
  if (!v) throw new Error(`unknown variant ${name}; have ${Object.keys(all).join(', ')}`);
  const s = { ...settingsBase, ...(v.settings ?? {}) };
  const schema = core.actionSchema(false, s.reasoning);
  const rows = [];
  for (const p of chosen) {
    const msgs = [{ role: 'system', content: v.system }, ...p.messages.slice(1).map(m => ({ role: m.role, content: m.content }))];
    const t0 = Date.now();
    let action = null;
    let usage = {};
    try {
      const r = await core.chat(s, msgs, schema, AbortSignal.timeout(180000));
      usage = r.usage;
      const parsed = core.parseAction(r.text, false);
      action = parsed.ok ? parsed.action : null;
    } catch (e) {
      usage = { error: e.message };
    }
    rows.push({ key: p.key, family: p.family, orig: p.orig, judge: judge(p.verdict, action), ms: Date.now() - t0, out: usage.outputTokens ?? 0, think: action?.think?.length ?? 0 });
  }
  results[name] = rows;
  const st = summarize(rows, results.base);
  console.log(`${name.padEnd(18)} ok ${st.ok}/${rows.length}  wrong ${st.wrong}  invalid ${st.invalid}  fixed ${st.fixed} broken ${st.broken}  ${st.ms}ms  out ${st.out}  sys ${tokensOf(v.system)} tok`);
}

function summarize(rows, base) {
  const ok = rows.filter(r => r.judge === 'ok').length;
  const m = new Map((base ?? []).map(r => [r.key, r.judge]));
  return {
    ok,
    wrong: rows.filter(r => r.judge === 'wrong').length,
    invalid: rows.filter(r => r.judge === 'invalid').length,
    neutral: rows.filter(r => r.judge === 'neutral').length,
    fixed: base ? rows.filter(r => r.judge === 'ok' && m.get(r.key) !== 'ok').length : 0,
    broken: base ? rows.filter(r => r.judge !== 'ok' && m.get(r.key) === 'ok').length : 0,
    ms: Math.round(rows.reduce((s, r) => s + r.ms, 0) / Math.max(1, rows.length)),
    out: Math.round(rows.reduce((s, r) => s + r.out, 0) / Math.max(1, rows.length)),
  };
}

const lines = ['# Replay', '', `${chosen.length} decision points from \`${dir}\`, model \`${opt.modelId}\``, '', '| variant | ok | neutral | wrong | invalid | fixed vs base | broken vs base | ms/decision | out tok | system tok | what changed |', '|---|---|---|---|---|---|---|---|---|---|---|'];
for (const name of names) {
  const st = summarize(results[name], name === 'base' ? null : results.base);
  lines.push(`| ${name} | ${st.ok} | ${st.neutral} | ${st.wrong} | ${st.invalid} | ${st.fixed} | ${st.broken} | ${st.ms} | ${st.out} | ${tokensOf(all[name].system)} | ${all[name].about ?? ''} |`);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
writeFileSync(resolve(dir, `replay-${stamp}.md`), lines.join('\n') + '\n');
writeFileSync(resolve(dir, `replay-${stamp}.json`), JSON.stringify({ opt, results }, null, 1));
console.log('\n' + lines.join('\n'));
