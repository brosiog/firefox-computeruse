// Judges one login-lab case. Shared by the unit lab and the Firefox lab.
//
// ctx = {
//   results:     [{ ok, text }] one per step (what the agent got back)
//   texts:       every string the agent received from the first login step on (results + the final page state)
//   lastPage:    the final page state text
//   reports:     [{ frame, inputs: [{ key, want, value, init, type, checked }] }] the page's own view of its fields
//   submissions: [...] form bodies the server (or the page) received
//   gates, gateWhat: approval cards shown (risk, description)
// }
import { TOTP } from './bw.mjs';
import { ITEM } from './cases.mjs';

export function itemsOf(c) {
  return c.items ?? [DEFAULT_ITEM];
}
const DEFAULT_ITEM = ITEM();

/** Secrets that must never reach the agent: every saved username and password (4+ chars), and the TOTP code. */
export function secretsOf(c) {
  const out = new Set([TOTP]);
  for (const it of itemsOf(c)) {
    for (const v of [it?.login?.username, it?.login?.password]) if (typeof v === 'string' && v.trim().length >= 4) out.add(v);
  }
  return [...out];
}

export function judge(c, ctx) {
  const fails = [];
  const e = c.expect ?? {};
  const last = ctx.results[ctx.results.length - 1] ?? { ok: false, text: '(no result)' };
  const inputs = ctx.reports.flatMap(r => r.inputs.map(i => ({ ...i, frame: r.frame })));

  if (!e.anyOutcome) {
    if (e.steps) e.steps.forEach((want, i) => ctx.results[i] && ctx.results[i].ok !== want && fails.push(`step ${i + 1} ok=${ctx.results[i].ok}, wanted ${want}: ${short(ctx.results[i].text)}`));
    if (e.ok !== undefined && last.ok !== e.ok) fails.push(`ok=${last.ok}, wanted ${e.ok}: ${short(last.text)}`);
    if (e.text && !e.text.test(last.text)) fails.push(`result text does not match ${e.text}: ${short(last.text)}`);
    if (e.ok && !e.partial) {
      const it = itemsOf(c)[e.item ?? 0];
      const want = w => {
        if (w === 'user') return it.login.username || null;
        if (w === 'pass') return it.login.password || null;
        if (w === 'otp') return TOTP;
        const d = /^otp(\d)$/.exec(w ?? '');
        if (d) return TOTP[Number(d[1])];
        return null;
      };
      for (const i of inputs) {
        if (i.want === 'maybe' || i.type === 'hidden' || i.type === 'submit' || i.type === 'checkbox' || i.type === 'radio') continue;
        const exp = i.want ? (want(i.want) ?? i.init) : i.init;
        if (i.value !== exp) fails.push(`field ${i.frame}/${i.key} (${i.want ?? 'untouched'}) is ${JSON.stringify(mask(i.value))}, wanted ${JSON.stringify(mask(exp))}`);
      }
      if (!inputs.length) fails.push('the page reported no fields');
    }
    if (e.nothingFilled) {
      for (const i of inputs) if (i.type !== 'hidden' && i.value !== i.init) fails.push(`field ${i.frame}/${i.key} changed to ${JSON.stringify(mask(i.value))} but nothing should be filled`);
    }
    if (e.submitted !== undefined && ctx.submissions.length !== e.submitted) fails.push(`${ctx.submissions.length} submission(s), wanted ${e.submitted}`);
    if (e.gates && JSON.stringify(ctx.gates) !== JSON.stringify(e.gates)) fails.push(`approvals ${JSON.stringify(ctx.gates)}, wanted ${JSON.stringify(e.gates)}`);
    const custom = e.custom?.({ ...ctx, input: k => inputs.find(i => i.key === k) });
    if (custom) fails.push(custom);
  }

  // Never, in any case: a secret in text the agent received.
  for (const s of secretsOf(c)) {
    for (const t of ctx.texts) {
      if (t.includes(s) || t.includes(encodeURIComponent(s))) {
        fails.push(`LEAK: ${s === TOTP ? 'the TOTP code' : `"${mask(s)}"`} reached the agent: …${short(around(t, s))}…`);
        break;
      }
    }
  }
  return fails;
}

const short = t => String(t).replace(/\s+/g, ' ').slice(0, 220);
const mask = v => (typeof v === 'string' && v.length > 3 ? `${v.slice(0, 2)}…(${v.length})` : v);
function around(t, s) {
  const i = t.indexOf(s) >= 0 ? t.indexOf(s) : t.indexOf(encodeURIComponent(s));
  return t.slice(Math.max(0, i - 60), i).replace(s, '') + '[SECRET]' + t.slice(i + s.length, i + s.length + 40);
}
