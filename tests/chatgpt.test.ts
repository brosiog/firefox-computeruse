import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizeUrl, b64url, checkClaims, parseCallback, pkceChallenge } from '../src/llm/chatgpt-auth';
import { chat, listModels, prewarm, setChatGptTokenSource } from '../src/llm/client';
import { DEFAULTS, type Settings } from '../src/settings';

afterEach(() => vi.unstubAllGlobals());

describe('Sign in with ChatGPT: authorization', () => {
  const base = { hostId: 'urn:uuid:1', redirectUri: 'http://127.0.0.1:4321/auth/callback', state: 's', nonce: 'n', challenge: 'c' };

  it('first sign-in registers dynamically with the app name', () => {
    const q = new URL(authorizeUrl(base)).searchParams;
    expect(q.get('client_id')).toBe('dynamic_agent_client');
    expect(q.get('agent_name_hint')).toBe('Firefox Computer Use');
    expect(q.get('scope')).toBe('openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
    expect(q.get('resource')).toBe('https://api.openai.com/v1');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('ext_agent_host_id')).toBe('urn:uuid:1');
    expect(q.has('id_token_hint')).toBe(false);
  });

  it('reauthorization reuses the issued client id and hints, without the name hint', () => {
    const q = new URL(authorizeUrl({ ...base, clientId: 'oaiapp_1', idTokenHint: 'tok', loginHint: 'a@b.c' })).searchParams;
    expect(q.get('client_id')).toBe('oaiapp_1');
    expect(q.has('agent_name_hint')).toBe(false);
    expect(q.get('id_token_hint')).toBe('tok');
    expect(q.get('login_hint')).toBe('a@b.c');
  });

  it('PKCE challenge is the RFC 7636 S256 value', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(b64url(new Uint8Array([251, 255]))).toBe('-_8');
  });

  it('callback: state, errors and the issued client id', () => {
    const cb = (q: string) => `http://127.0.0.1:4321/auth/callback?${q}`;
    expect(parseCallback(cb('state=s&code=k&client_id=oaiapp_9'), { state: 's' })).toEqual({ code: 'k', clientId: 'oaiapp_9' });
    expect(parseCallback(cb('state=s&code=k'), { state: 's', clientId: 'oaiapp_1' })).toEqual({ code: 'k', clientId: 'oaiapp_1' });
    expect(() => parseCallback(cb('state=x&code=k&client_id=oaiapp_9'), { state: 's' })).toThrow(/state/);
    expect(() => parseCallback(cb('state=s&error=access_denied'), { state: 's' })).toThrow(/cancelled/);
    expect(() => parseCallback(cb('state=s&code=k'), { state: 's' })).toThrow(/registering/);
    expect(() => parseCallback(cb('state=s&code=k&client_id=oaiapp_2'), { state: 's', clientId: 'oaiapp_1' })).toThrow(/different client/);
  });

  it('ID token claims: issuer, audience, expiry, nonce', () => {
    const now = 1_800_000_000_000;
    const ok = { iss: 'https://auth.openai.com', aud: 'oaiapp_1', exp: now / 1000 + 60, nonce: 'n', sub: 'u' };
    expect(() => checkClaims(ok, 'oaiapp_1', 'n', now)).not.toThrow();
    expect(() => checkClaims({ ...ok, iss: 'https://evil' }, 'oaiapp_1', 'n', now)).toThrow(/issuer/);
    expect(() => checkClaims({ ...ok, aud: ['other'] }, 'oaiapp_1', 'n', now)).toThrow(/client/);
    expect(() => checkClaims({ ...ok, exp: now / 1000 - 3600 }, 'oaiapp_1', 'n', now)).toThrow(/expired/);
    expect(() => checkClaims({ ...ok, nonce: 'x' }, 'oaiapp_1', 'n', now)).toThrow(/nonce/);
  });
});

// A Responses API endpoint that records requests and streams one action.
function fakeResponses(opts: { reject?: (body: any) => any; status401Once?: boolean } = {}) {
  const calls: { url: string; auth: string; body: any }[] = [];
  let first401 = !!opts.status401Once;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).Authorization;
    if (url.endsWith('/models')) return new Response(JSON.stringify({ models: [{ slug: 'm1', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }] }));
    const body = JSON.parse(String(init.body));
    calls.push({ url, auth, body });
    if (first401) {
      first401 = false;
      return new Response(JSON.stringify({ error: { message: 'bad token', code: 'subscription_sharing_invalid_user' } }), { status: 401 });
    }
    const err = opts.reject?.(body);
    if (err) return new Response(JSON.stringify({ error: err }), { status: 400 });
    const ev = (o: object) => `event: x\ndata: ${JSON.stringify(o)}\n\n`;
    const sse =
      ev({ type: 'response.output_text.delta', delta: '{"tool":"done",' }) +
      ev({ type: 'response.output_text.delta', delta: '"answer":"ok"}' }) +
      ev({ type: 'response.completed', response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 9 } } });
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  return calls;
}

let n = 0;
const gpt = (): Settings => ({ ...DEFAULTS, kind: 'chatgpt', baseUrl: 'https://api.openai.com/v1', model: `gpt-test-${++n}`, effort: 'low' });
const schema = { type: 'object', properties: { tool: { type: 'string' } } };
const msgs = [
  { role: 'system' as const, content: 'SYS' },
  { role: 'user' as const, content: 'Ready?' },
  { role: 'assistant' as const, content: 'Ready.' },
  { role: 'user' as const, content: 'page', images: ['AAAA'] },
];

describe('chat: ChatGPT plan over the Responses API', () => {
  it('sends instructions + input, store:false, stream:true, no temperature or output cap', async () => {
    const tokens: boolean[] = [];
    setChatGptTokenSource(async force => (tokens.push(force), 'tok'));
    const calls = fakeResponses();
    const r = await chat(gpt(), msgs, schema, AbortSignal.timeout(5000));
    expect(r.text).toBe('{"tool":"done","answer":"ok"}');
    expect(r.usage).toMatchObject({ promptTokens: 100, cachedTokens: 80, outputTokens: 9 });
    const { url, auth, body } = calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(auth).toBe('Bearer tok');
    expect(body.instructions).toBe('SYS');
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.temperature).toBeUndefined();
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.text.format.type).toBe('json_schema');
    expect(body.input.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(body.input[1].content[0].type).toBe('output_text');
    expect(body.input[2].content[1]).toEqual({ type: 'input_image', image_url: 'data:image/jpeg;base64,AAAA' });
    expect(tokens).toEqual([false]);
  });

  it('refreshes the token once after a 401', async () => {
    const tokens: boolean[] = [];
    setChatGptTokenSource(async force => (tokens.push(force), force ? 'new' : 'old'));
    const calls = fakeResponses({ status401Once: true });
    await chat(gpt(), msgs, schema, AbortSignal.timeout(5000));
    expect(tokens).toEqual([false, true]);
    expect(calls.map(c => c.auth)).toEqual(['Bearer old', 'Bearer new']);
  });

  it('drops an unsupported reasoning effort, then an unsupported format', async () => {
    setChatGptTokenSource(async () => 'tok');
    const calls = fakeResponses({
      reject: b =>
        b.reasoning
          ? { message: 'Unsupported value', code: 'subscription_sharing_unsupported_capability', param: 'reasoning.effort' }
          : b.text?.format?.type === 'json_schema'
            ? { message: 'Unsupported', code: 'subscription_sharing_unsupported_capability', param: 'text.format' }
            : null,
    });
    await chat(gpt(), msgs, schema, AbortSignal.timeout(5000));
    expect(calls.map(c => [!!c.body.reasoning, c.body.text?.format?.type ?? null])).toEqual([
      [true, 'json_schema'],
      [false, 'json_schema'],
      [false, 'json_object'],
    ]);
  });

  it('a usage-limit error is reported, not retried', async () => {
    setChatGptTokenSource(async () => 'tok');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'limit', code: 'subscription_sharing_usage_limit_exceeded' } }), { status: 429 }));
    await expect(chat(gpt(), msgs, schema, AbortSignal.timeout(5000))).rejects.toThrow(/usage limit/);
  });

  it('a stream without response.completed is an error', async () => {
    setChatGptTokenSource(async () => 'tok');
    vi.stubGlobal('fetch', async () => new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '{}' })}\n\n`, { status: 200 }));
    await expect(chat(gpt(), msgs, null, AbortSignal.timeout(5000))).rejects.toThrow(/before the response completed/);
  });

  it('lists only models marked for listing, and never prewarms', async () => {
    setChatGptTokenSource(async () => 'tok');
    const calls = fakeResponses();
    expect(await listModels(gpt())).toEqual(['m1']);
    expect(await prewarm(gpt(), msgs)).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
