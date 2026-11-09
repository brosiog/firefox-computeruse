// @vitest-environment happy-dom
// The login lab (e2e/login-lab/cases.mjs) on happy-dom: the real login tool, vault client and probe, with a host that
// runs the probe on this document. Cases that need a real browser (scripts, layout, frames, hostnames) run in
// e2e/login-lab.mjs instead.
import { describe, expect, it } from 'vitest';
import { createExecutor } from '../src/agent/loop';
import { parseAction } from '../src/agent/tools';
import type { Host } from '../src/browser/host';
import { createProbe } from '../src/probe';
import type { Snapshot } from '../src/protocol';
import { DEFAULTS } from '../src/settings';
import { createVault } from '../src/vault';
import { createRedactor } from '../src/redact';
// @ts-ignore plain JS lab modules
import { CASES, HOST } from '../e2e/login-lab/cases.mjs';
// @ts-ignore
import { createBw } from '../e2e/login-lab/bw.mjs';
// @ts-ignore
import { itemsOf, judge } from '../e2e/login-lab/oracle.mjs';

(globalThis as any).__fcuTestLayout = true;

function fields(root: Document | ShadowRoot): any[] {
  const out: any[] = [];
  for (const el of Array.from(root.querySelectorAll('input, textarea')) as HTMLInputElement[]) {
    out.push({ key: el.getAttribute('data-key') || el.name || el.id, want: el.getAttribute('data-want'), value: el.value, init: el.defaultValue, type: el.type, checked: el.checked });
  }
  return out;
}

async function runCase(c: any) {
  const url = `http://${c.host ?? HOST}:8795/c/${c.id}`;
  (window as any).happyDOM.setURL(url);
  const html = (typeof c.html === 'function' ? c.html(new URLSearchParams('')) : c.html).replaceAll('{{SUBMIT}}', `/lab/submit?id=${c.id}`);
  document.body.innerHTML = html;
  const submissions: any[] = [];
  const onSubmit = (e: Event) => {
    e.preventDefault();
    submissions.push(Object.fromEntries(new FormData(e.target as HTMLFormElement) as any));
  };
  document.addEventListener('submit', onSubmit, true);
  const probe = createProbe(window as any);
  const snapText = async () => `URL: ${url}\n<page>\n${((await probe.run({ op: 'snapshot', budget: 20000 })) as Snapshot).text}\n</page>`;
  const red = createRedactor();
  const scrub = (r: any) => (r && typeof r === 'object' ? { ...r, ...(r.msg ? { msg: red.scrub(r.msg) } : {}), ...(r.error ? { error: red.scrub(r.error) } : {}) } : r);
  const host: Host = {
    tabId: 1,
    observe: async () => ({ url, title: document.title, refs: [], text: red.scrub(await snapText()) }),
    act: async (ref, cmd: any, gate) => scrub(await probe.run({ ...cmd, ...(ref ? { id: Number(ref) } : {}), gate })),
    redact: v => (red.add(v.username, true), red.add(v.password), red.add(v.totp)),
    settle: async () => '',
    navigate: async () => 'not in the unit lab',
    back: async () => '',
    tabs: async () => [],
    newTab: async () => '',
    switchTab: async () => '',
    closeTab: async () => '',
    screenshot: async () => null,
  };
  const bw = createBw();
  bw.items = itemsOf(c);
  bw.mode = c.bw === 'down' ? null : (c.bw ?? null);
  const fetchImpl = c.bw === 'down' ? ((async () => { throw new TypeError('NetworkError when attempting to fetch resource.'); }) as any) : bw.fetch;
  const gates: string[] = [];
  const gateWhat: string[] = [];
  const exec = createExecutor({
    host,
    settings: { ...DEFAULTS, vault: true },
    ui: { approve: async g => (gates.push(g.risk), gateWhat.push(g.what), c.approve !== 'no'), ask: async () => null },
    signal: new AbortController().signal,
    vault: createVault('http://localhost:8796', fetchImpl),
    loginRetryMs: 0,
  });
  const snapAgent = async () => red.scrub(await snapText());
  let page = await snapAgent();
  const results: { ok: boolean; text: string }[] = [];
  for (const s of c.steps ?? [{ act: { tool: 'login' } }]) {
    const act = { ...s.act };
    if (s.ref) {
      const line = page.split('\n').find(l => s.ref.test(l));
      const ref = line && /^\s*\[([\d:]+)\]/.exec(line)?.[1];
      if (!ref) {
        results.push({ ok: false, text: `(lab) no ref matching ${s.ref} in:\n${page}` });
        break;
      }
      act.ref = ref;
    }
    const p = parseAction(JSON.stringify(act), false, true);
    const r = p.ok ? await exec.run(p.action, url) : { ok: false, text: p.error };
    page = await snapAgent();
    results.push({ ok: r.ok, text: `${r.text}\n\n${page}` });
  }
  document.removeEventListener('submit', onSubmit, true);
  const reports = [{ frame: 'top', inputs: [document, ...Array.from(document.querySelectorAll('*')).map(e => e.shadowRoot).filter(Boolean)].flatMap(r => fields(r as any)) }];
  return judge(c, { results, texts: [...results.map(r => r.text), page], lastPage: page, reports, submissions, gates, gateWhat });
}

describe('login lab (happy-dom)', () => {
  const unit = (CASES as any[]).filter(c => !c.ff);
  it('has plenty of cases', () => expect(unit.length).toBeGreaterThan(80));
  for (const c of unit) {
    it(`${c.group}: ${c.title} [${c.id}]`, async () => {
      const fails = await runCase(c);
      if (fails.length) throw new Error(`${c.id}:\n  ${fails.join('\n  ')}`);
    });
  }
});
