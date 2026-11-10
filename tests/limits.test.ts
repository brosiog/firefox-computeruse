import { afterEach, describe, expect, it, vi } from 'vitest';
import { chat, LlmError, prewarm, thinkingLoops } from '../src/llm/client';
import { DEFAULTS } from '../src/settings';

afterEach(() => vi.unstubAllGlobals());

describe('prewarm', () => {
  it('sends exactly one 1-token request: a cut-off reply is the point, not a reason to retry', async () => {
    const sent: number[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).max_tokens);
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
    });
    await prewarm({ ...DEFAULTS, baseUrl: 'http://localhost:8000/v1', model: 'warm', effort: 'xhigh' }, [{ role: 'system', content: 'SYS' }]);
    expect(sent).toEqual([1]);
  });
});

const sse = (...chunks: object[]) => chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
const reason = (r: string) => ({ choices: [{ delta: { reasoning_content: r } }] });
let n = 0;
const cfg = () => ({ ...DEFAULTS, baseUrl: 'http://localhost:8000/v1', model: `think-${++n}`, effort: 'xhigh' as const });

describe('thinking stream', () => {
  it('detects a looping thought but not long varied thinking', () => {
    const para = 'Let me check the price of the second item again and compare it with the first one. ';
    expect(thinkingLoops(para.repeat(40))).toBe(true);
    const varied = Array.from({ length: 300 }, (_, i) => `Step ${i}: item ${i * 7} costs ${i * 13} so far.`).join(' ');
    expect(thinkingLoops(varied)).toBe(false);
  });

  it('reports thinking progress and returns the answer when thinking ends', async () => {
    vi.stubGlobal('fetch', async () => new Response(sse(...Array.from({ length: 20 }, (_, i) => reason(`thought ${i} `.repeat(10))), { choices: [{ delta: { content: '{"tool":"done"}' }, finish_reason: 'stop' }] }), { status: 200 }));
    const seen: number[] = [];
    const r = await chat(cfg(), [{ role: 'user', content: 'x' }], null, AbortSignal.timeout(5000), undefined, { onThinking: t => seen.push(t) });
    expect(r.text).toBe('{"tool":"done"}');
    expect(seen.length).toBeGreaterThan(0);
  });

  it('cuts a looping thought short with a loop error instead of waiting out the budget', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => (calls++, new Response(sse(...Array.from({ length: 200 }, () => reason('I should click the button. Wait, let me reconsider. '))), { status: 200 })));
    const e = await chat(cfg(), [{ role: 'user', content: 'x' }], null, AbortSignal.timeout(5000)).catch(x => x);
    expect(e).toBeInstanceOf(LlmError);
    expect(e.kind).toBe('loop');
    expect(calls).toBe(1);
  });
});
