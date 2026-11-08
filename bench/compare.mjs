// Paired comparison of two bench runs (same tasks): which episodes a change fixed or broke, and what it did to speed
// and memory. Pairs by task key (split.family.perturbation.seed.repeat), so both runs must use the same matrix.
//   node bench/compare.mjs bench/.results/<before>[,<more>][:config] bench/.results/<after>[:config]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rowStats } from './lib/report.mjs';

// Each side may be several runs joined with commas (e.g. a base-page run and a perturbation run); --config picks one
// config out of a multi-config run on either side (A:name or B:name).
const argv = process.argv.slice(2);
const load = spec => {
  const [dirs, cfg] = spec.split(':');
  return dirs.split(',').flatMap(d => readFileSync(resolve(d, 'episodes.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))).filter(e => !cfg || e.config === cfg);
};
const [a, b] = argv.slice(0, 2).map(load);
if (!a || !b) {
  console.error('usage: node bench/compare.mjs <run A> <run B>');
  process.exit(2);
}
const key = e => e.key;
const mb = new Map(b.map(e => [key(e), e]));
const pairs = a.filter(e => mb.has(key(e))).map(e => [e, mb.get(key(e))]);
const fixed = pairs.filter(([x, y]) => !x.pass && y.pass);
const broken = pairs.filter(([x, y]) => x.pass && !y.pass);
const sa = rowStats(pairs.map(p => p[0]));
const sb = rowStats(pairs.map(p => p[1]));
const d = (x, y, f = v => v.toFixed(2)) => `${f(x)} → ${f(y)}`;
console.log(`${pairs.length} paired episodes`);
console.log(`pass        ${d(sa.passRate * 100, sb.passRate * 100, v => v.toFixed(0) + '%')}   fixed ${fixed.length}, broken ${broken.length}`);
console.log(`wrong steps ${d(sa.wrong * 100, sb.wrong * 100, v => v.toFixed(1) + '%')}   wasted ${d(sa.wasted * 100, sb.wasted * 100, v => v.toFixed(1) + '%')}`);
console.log(`steps/ep    ${d(sa.stepsPerEp, sb.stepsPerEp, v => v.toFixed(1))}   s/step ${d(sa.secPerStep, sb.secPerStep)}   model s/step ${d(sa.modelSec, sb.modelSec)}`);
console.log(`prefill/step ${d(sa.prefillPerStep, sb.prefillPerStep, v => v.toFixed(0))}   cache ${d(sa.cache * 100, sb.cache * 100, v => v.toFixed(0) + '%')}   peak ctx ${d(sa.peakCtx, sb.peakCtx, v => v.toFixed(0))}   page chars ${d(sa.pageChars, sb.pageChars, v => v.toFixed(0))}`);
for (const [x, y] of fixed) console.log(`  + fixed  ${x.key}  (${x.category} → pass)`);
for (const [x, y] of broken) console.log(`  - broken ${x.key}  (pass → ${y.category}: ${y.reason})`);
// McNemar-style sign: with few discordant pairs, a difference is not evidence.
const n = fixed.length + broken.length;
if (n) console.log(`discordant pairs: ${n}${n < 6 ? ' (too few to call a real difference; add seeds or repeats)' : ''}`);
