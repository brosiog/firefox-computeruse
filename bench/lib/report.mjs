// Aggregates episodes into the numbers that drive changes: accuracy (pass, pass^k, dev/holdout gap), decision quality
// (ok / wasted / wrong steps), speed (seconds per step by phase), and memory/compute (peak context, prefill tokens,
// cache reuse). Plus failures.md: the first wrong decision of every failed episode, with what the oracle expected.
import { CATEGORY_HINTS } from './analyze.mjs';

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : '–');
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const f1 = x => (Number.isFinite(x) ? x.toFixed(1) : '–');
const k = n => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/** Wilson 95% interval: with small suites, differences inside it are noise. */
export function wilson(p, n) {
  if (!n) return [0, 0];
  const z = 1.96;
  const ph = p / n;
  const d = 1 + (z * z) / n;
  const c = ph + (z * z) / (2 * n);
  const m = z * Math.sqrt((ph * (1 - ph)) / n + (z * z) / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
}

export function rowStats(eps) {
  const n = eps.length;
  const pass = eps.filter(e => e.pass).length;
  const steps = eps.reduce((a, e) => a + e.metrics.steps, 0) || 1;
  const m = key => eps.reduce((a, e) => a + (e.metrics[key] || 0), 0);
  // pass^k: a task (same seed, family, perturbation) counts only if every repeat passed.
  const groups = new Map();
  for (const e of eps) {
    const g = `${e.family}|${e.perturb}|${e.split}|${e.seed}`;
    groups.set(g, (groups.get(g) ?? true) && e.pass);
  }
  const allPass = [...groups.values()].filter(Boolean).length;
  const [lo, hi] = wilson(pass, n);
  return {
    n,
    pass,
    passRate: n ? pass / n : 0,
    ci: [lo, hi],
    passK: groups.size ? allPass / groups.size : 0,
    stepsPerEp: n ? m('steps') / n : 0,
    okSteps: m('ok') / steps,
    wasted: m('neutral') / steps,
    wrong: (m('wrong') + m('invalid')) / steps,
    invalid: m('invalid') / steps,
    stale: m('staleRefs'),
    secPerStep: m('wallMs') / steps / 1000,
    modelSec: m('modelMs') / steps / 1000,
    observeSec: m('observeMs') / steps / 1000,
    actSec: m('actMs') / steps / 1000,
    prefillPerStep: (m('promptTokens') - m('cachedTokens')) / steps,
    cache: m('promptTokens') ? m('cachedTokens') / m('promptTokens') : 0,
    outPerStep: m('outputTokens') / steps,
    peakCtx: Math.max(0, ...eps.map(e => e.metrics.peakPromptTokens)),
    pageChars: mean(eps.map(e => e.metrics.pageChars)),
  };
}

const HEAD = '| | n | pass | 95% CI | pass^k | steps/ep | ok | wasted | wrong | s/step (model·observe·act) | prefill tok/step | cache | out tok/step | peak ctx |';
const SEP = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
function row(label, s) {
  return `| ${label} | ${s.n} | **${pct(s.pass, s.n)}** | ${(s.ci[0] * 100).toFixed(0)}–${(s.ci[1] * 100).toFixed(0)}% | ${pct(s.passK * 100, 100)} | ${f1(s.stepsPerEp)} | ${pct(s.okSteps * 100, 100)} | ${pct(s.wasted * 100, 100)} | ${pct(s.wrong * 100, 100)} | ${f1(s.secPerStep)} (${f1(s.modelSec)}·${f1(s.observeSec)}·${f1(s.actSec)}) | ${k(s.prefillPerStep)} | ${pct(s.cache * 100, 100)} | ${k(s.outPerStep)} | ${k(s.peakCtx)} |`;
}

function table(title, eps, keyOf) {
  const groups = new Map();
  for (const e of eps) {
    const g = keyOf(e);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  const lines = [`### ${title}`, '', HEAD, SEP];
  for (const [g, list] of [...groups].sort()) lines.push(row(g, rowStats(list)));
  return lines.join('\n');
}

export function renderReport(eps, meta) {
  const out = [`# Bench report — ${meta.label}`, '', `${meta.when} · model \`${meta.model}\` · ${eps.length} episodes · configs: ${[...new Set(eps.map(e => e.config))].join(', ')}`, ''];
  out.push(table('By config and split', eps, e => `${e.config} / ${e.split}`), '');
  // Generalization gap: tuning that raises dev but not holdout is overfitting.
  const gaps = [];
  for (const c of new Set(eps.map(e => e.config))) {
    const d = eps.filter(e => e.config === c && e.split === 'dev');
    const h = eps.filter(e => e.config === c && e.split === 'holdout');
    if (d.length && h.length) gaps.push(`- **${c}**: dev ${pct(rowStats(d).pass, d.length)} vs holdout ${pct(rowStats(h).pass, h.length)} → gap ${((rowStats(d).passRate - rowStats(h).passRate) * 100).toFixed(0)} pts`);
  }
  if (gaps.length) out.push('### Generalization gap (dev − holdout)', '', ...gaps, '');
  out.push(table('By family', eps, e => `${e.config} / ${e.family}`), '');
  out.push(table('By perturbation', eps, e => `${e.config} / ${e.perturb}`), '');
  const cats = new Map();
  for (const e of eps.filter(e => !e.pass)) cats.set(e.category, (cats.get(e.category) ?? 0) + 1);
  if (cats.size) {
    out.push('### Failure categories', '', '| category | count | what to look at |', '|---|---|---|');
    for (const [c, n] of [...cats].sort((a, b) => b[1] - a[1])) out.push(`| ${c} | ${n} | ${CATEGORY_HINTS[c] ?? ''} |`);
    out.push('');
  }
  const wrongTools = new Map();
  for (const e of eps) for (const s of e.steps ?? []) if (s.judge === 'wrong') wrongTools.set(s.tool, (wrongTools.get(s.tool) ?? 0) + 1);
  if (wrongTools.size) out.push(`Wrong steps by tool: ${[...wrongTools].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ')}`, '');
  return out.join('\n');
}

export function renderFailures(eps) {
  const out = ['# First wrong decision per failed episode', ''];
  for (const e of eps.filter(e => !e.pass)) {
    out.push(`## ${e.key} — ${e.category}`, '', `- goal: ${e.goal}`, `- validator: ${e.reason}`, `- answer: ${String(e.answer).slice(0, 300)}`);
    const w = e.firstWrong;
    if (w) {
      out.push(`- step ${w.n}: model \`${JSON.stringify(w.action ?? w.parseError)}\``, `- oracle expected: \`${JSON.stringify(w.expected)}\``, `- result: ${String(w.result ?? '').slice(0, 300)}`);
    }
    out.push(`- trace: traces/${e.id}.json`, '');
  }
  return out.join('\n');
}
