import { afterEach, describe, expect, it, vi } from 'vitest';
import { chat, prewarm } from '../src/llm/client';
import { DEFAULTS, type Settings } from '../src/settings';

// An OpenAI-compatible server that records every request body and answers with one streamed action.
function fakeServer(reject?: (body: any) => string | null) {
  const bodies: any[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const why = reject?.(body);
    if (why) return new Response(JSON.stringify({ error: { message: why } }), { status: 400 });
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: '{"tool":"done","answer":"ok"}' } }] })}\n\ndata: [DONE]\n\n`;
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  return bodies;
}

const schema = { type: 'object', properties: { tool: { type: 'string' } } };
const msgs = [{ role: 'user' as const, content: 'hi' }];
let n = 0;
// A fresh server key per test: chat() remembers what each server accepts.
const settings = (): Settings => ({ ...DEFAULTS, kind: 'openai', baseUrl: `http://test-${++n}.invalid/v1`, model: 'm', structured: 'auto', effort: 'none' });

afterEach(() => vi.unstubAllGlobals());

describe('chat: learned structured-output level', () => {
  it('a prewarm (no schema) does not turn structured output off for later steps', async () => {
    const bodies = fakeServer();
    const s = settings();
    await chat(s, msgs, schema, AbortSignal.timeout(5000));
    await prewarm(s, msgs);
    await chat(s, msgs, schema, AbortSignal.timeout(5000));
    expect(bodies.map(b => b.response_format?.type ?? null)).toEqual(['json_schema', null, 'json_schema']);
  });

  it('a downgrade learned from a rejection survives a prewarm', async () => {
    const bodies = fakeServer(b => (b.response_format?.type === 'json_schema' ? 'response_format json_schema not supported' : null));
    const s = settings();
    await chat(s, msgs, schema, AbortSignal.timeout(5000));
    await prewarm(s, msgs);
    await chat(s, msgs, schema, AbortSignal.timeout(5000));
    expect(bodies.map(b => b.response_format?.type ?? null)).toEqual(['json_schema', 'json_object', null, 'json_object']);
  });
});
