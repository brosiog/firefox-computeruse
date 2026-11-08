// Oracles read the same page state the model saw (the prompt) and say which actions are right at that moment.
// They power three things:
// - the fake model (oracle mode): proves every task is solvable through the extension and measures harness overhead;
// - per-step judging of real-model traces: each step is ok / neutral (information gathering) / wrong, which localizes
//   the first wrong decision;
// - frozen-step replay: re-asking a recorded decision under another prompt and scoring the new answer.

export function view(messages) {
  const user = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
  const pages = [...user.matchAll(/<page>\n([\s\S]*?)<\/page>/g)];
  const page = pages.length ? pages[pages.length - 1][1] : '';
  const url = (/^URL: (.*)$/m.exec(user.slice(user.lastIndexOf('URL: '))) || [])[1] ?? '';
  const modal = (/^Modal dialog open: (.*)$/m.exec(user) || [])[1] ?? null;
  const tabs = (/^Tabs: (.*)$/m.exec(user) || [])[1] ?? '';
  const all = messages.map(m => m.content).join('\n');
  const lines = page.split('\n');
  const els = [];
  // Refs come from the page state and from the last result (find/read return refs for off-screen elements).
  const lastResult = pages.length ? user.slice(0, user.lastIndexOf('<page>')) : user;
  for (const line of [...lines, ...lastResult.split('\n')]) {
    const m = /^\[([\d:]+)\] (.*)$/.exec(line.trim().replace(/^(OK|Error): /, ''));
    if (m) els.push({ ref: m[1], line: m[2] });
  }
  let path = '';
  try {
    const u = new URL(url);
    path = u.pathname.replace(/^\/t\/[^/]+/, '') || '/';
    path += u.search;
  } catch {
    // restricted page
  }
  return { user, page, url, path, modal, tabs, all, els, lines };
}

/** Ref of the first element whose line matches. Lines look like: button "Save" disabled. */
export const ref = (v, re) => v.els.find(e => re.test(e.line))?.ref ?? null;
export const refsAll = (v, re) => v.els.filter(e => re.test(e.line)).map(e => e.ref);
export const has = (v, re) => re.test(v.page);
export const quote = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const named = (role, name) => new RegExp(`^${role} "${quote(name)}"`, 'i');

/** Generic interruptions every family inherits: the popup perturbation's dialog. */
export function interruptions(v, job) {
  if (/\(no visible content\)|page is still loading/.test(v.user) && !v.els.length) return { act: { tool: 'wait', seconds: 1 }, accept: [{ tool: 'wait' }] };
  if (v.modal && /Newsletter/i.test(v.modal)) {
    const words = job.ctx.pool.dismiss.map(quote).join('|');
    const close = ref(v, new RegExp(`^button "(${words})"`, 'i'));
    if (close) return { act: { think: 'Dismiss the dialog.', tool: 'click', ref: close }, accept: [{ tool: 'click', ref: close }, { tool: 'key', key: /escape/i }] };
  }
  return null;
}

const NEUTRAL = new Set(['read', 'find', 'scroll', 'wait', 'screenshot']);

/**
 * Judges an action against an oracle verdict: ok (one of the accepted actions), neutral (gathering information
 * without changing anything) or wrong.
 */
export function judge(verdict, a) {
  if (!a) return 'invalid';
  if (!verdict) return 'unknown';
  if (verdict.accept.some(spec => matches(spec, a))) {
    // A chain is ok if every chained action is also right on this page.
    // Later chain items act on a page the oracle has not seen yet (a submit after the fields it fills), so they are
    // not judged here; the episode validator still catches a bad outcome.
    if (a.then?.length && !a.then.every(x => verdict.accept.some(spec => matches(spec, x)))) return 'chained';
    return 'ok';
  }
  if ((verdict.neutral ?? NEUTRAL).has(a.tool)) return 'neutral';
  return 'wrong';
}

function matches(spec, a) {
  if (spec.tool && spec.tool !== a.tool) return false;
  if (spec.ref !== undefined) {
    const list = Array.isArray(spec.ref) ? spec.ref : [spec.ref];
    if (!list.includes(String(a.ref))) return false;
  }
  for (const k of ['text', 'option', 'answer', 'url', 'key', 'query']) {
    if (spec[k] === undefined) continue;
    const re = spec[k] instanceof RegExp ? spec[k] : new RegExp(quote(String(spec[k])), 'i');
    if (!re.test(String(a[k] ?? (k === 'text' ? (a.query ?? '') : '')))) return false;
  }
  if (spec.dir && spec.dir !== a.dir) return false;
  if (spec.enter !== undefined && !!a.enter !== spec.enter) return false;
  if (spec.tab !== undefined && Number(a.tab) !== spec.tab) return false;
  return true;
}
