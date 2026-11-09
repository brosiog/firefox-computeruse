// Minimal streaming chat client for local model servers. Two wire formats:
// - Ollama native (/api/chat, NDJSON): num_ctx, keep_alive, `format` (JSON schema), `think: false`.
// - OpenAI-compatible (/chat/completions, SSE): LM Studio, llama.cpp server, mlx_lm.server, vLLM, cloud APIs.
// - ChatGPT plan (Responses API, SSE): Sign in with ChatGPT; the background page supplies the access token.
// Output is constrained to the action schema where the server supports it, falling back step by step
// (schema → json → off) and remembering what worked per server and model.

import type { Settings, Structured } from '../settings';
import { RESOURCE, askBackground } from './chatgpt-auth';

/** Where ChatGPT access tokens come from. The sidebar asks the background page; tests swap in a stub. */
let chatGptToken = (force: boolean) => askBackground<string>({ type: 'chatgpt-token', force });
export function setChatGptTokenSource(f: (force: boolean) => Promise<string>) {
  chatGptToken = f;
}

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Base64 JPEG, no data: prefix. */
  images?: string[];
}

export interface Usage {
  promptTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  promptMs?: number;
  genMs?: number;
  loadMs?: number;
  totalMs: number;
}

export interface ChatResult {
  text: string;
  usage: Usage;
  mode: Structured;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

type Level = 'schema' | 'json' | 'off';
const LADDER: Level[] = ['schema', 'json', 'off'];
const learned = new Map<string, { level: Level; noThinkOk: boolean; extrasOk: boolean }>();

export function isLocalUrl(u: string): boolean {
  try {
    const h = new URL(u).hostname;
    return (
      h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.local') || /^10\./.test(h) ||
      /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\./.test(h)
    );
  } catch {
    return false;
  }
}

/** Thinking tokens count against the output limit, so a thinking model needs far more room than the action itself. */
export const outputBudget = (s: Settings) => (s.effort === 'none' ? s.maxOutput : Math.max(s.maxOutput, s.effort === 'low' ? 2048 : 8192));

const trimSlash = (u: string) => u.replace(/\/+$/, '');

export function stripThinking(t: string): string {
  let s = t.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\|channel\|>analysis[\s\S]*?<\|end\|>/g, '');
  // An unterminated think block (output cut off mid-thought) leaves nothing usable before it.
  const open = s.search(/<think>/i);
  if (open >= 0) s = s.slice(0, open);
  return s.trim();
}

async function* lines(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const onAbort = () => reader.cancel().catch(() => {});
  signal.addEventListener('abort', onAbort);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) yield line;
      }
    }
    if (buf.trim()) yield buf.trim();
  } finally {
    signal.removeEventListener('abort', onAbort);
    // Also stops the download when the consumer bails out early (degenerate output).
    reader.cancel().catch(() => {});
  }
}

/** Grammar-constrained decoding can collapse into endless whitespace inside the JSON: throws so the caller stops early
 *  and falls back. */
function checkDegenerate(text: string): void {
  if (/\s{48}$/.test(text) || /(.{1,8})\1{30}$/s.test(text)) throw new LlmError('model output degenerated (repeating whitespace)', 422);
}

export async function chat(
  s: Settings,
  msgs: ChatMsg[],
  schema: object | null,
  signal: AbortSignal,
  onText?: (full: string) => void,
): Promise<ChatResult> {
  const key = `${s.kind}|${trimSlash(s.baseUrl)}|${s.model}`;
  const prior = learned.get(key);
  // A copy: a schema-less call (prewarm) must not overwrite what was learned about this server's structured output.
  const state = {
    ...(prior ?? {
      level: (s.structured === 'auto' ? 'schema' : s.structured === 'off' ? 'off' : s.structured) as Level,
      noThinkOk: true,
      extrasOk: true,
    }),
  };
  if (!schema) state.level = 'off';
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r =
        s.kind === 'ollama'
          ? await ollama(s, msgs, schema, state, signal, onText)
          : s.kind === 'chatgpt'
            ? await responses(s, msgs, schema, state, signal, onText)
            : await openai(s, msgs, schema, state, signal, onText);
      if (schema) learned.set(key, state);
      return r;
    } catch (e) {
      if (signal.aborted) throw e;
      const err = e as LlmError;
      const msg = (err.message || '').toLowerCase();
      if (err.status !== 400 && err.status !== 422 && err.status !== 500) throw e;
      // Learn and retry with fewer features.
      if (state.noThinkOk && s.effort !== 'default' && /think|reasoning|chat_template_kwargs|enable_thinking|effort/.test(msg)) {
        state.noThinkOk = false;
        continue;
      }
      if (state.extrasOk && /cache_prompt|stream_options|unrecognized|unknown|extra/.test(msg)) {
        state.extrasOk = false;
        continue;
      }
      const li = LADDER.indexOf(state.level);
      if (li < LADDER.length - 1 && (s.structured === 'auto' || err.status !== 500)) {
        state.level = LADDER[li + 1];
        continue;
      }
      throw e;
    }
  }
  throw new LlmError('model server kept rejecting the request');
}

async function post(url: string, body: unknown, s: Settings, signal: AbortSignal, bearer = s.apiKey): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new LlmError(`cannot reach ${new URL(url).origin}: is the model server running? (${(e as Error).message})`);
  }
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '');
    let m = t;
    try {
      const j = JSON.parse(t);
      m = j.error?.message ?? j.error ?? j.message ?? t;
      // Responses API: the code says what to do, the param says which field to drop.
      if (j.error?.code) m = `${m} [${j.error.code}${j.error.param ? `, param: ${j.error.param}` : ''}]`;
    } catch {
      // plain text error
    }
    if (res.status === 403 && /origin/i.test(String(m))) {
      m += ' — the server rejected the extension origin. Reload the extension (it removes the Origin header), or allow moz-extension://* on the server.';
    }
    if (/subscription_sharing_usage_limit_exceeded/.test(String(m))) {
      throw new LlmError('ChatGPT plan usage limit reached for this app. See ChatGPT → Settings → Usage.', 429);
    }
    throw new LlmError(`model server error ${res.status}: ${String(m).slice(0, 400)}`, res.status);
  }
  return res;
}

async function ollama(
  s: Settings,
  msgs: ChatMsg[],
  schema: object | null,
  st: { level: Level; noThinkOk: boolean },
  signal: AbortSignal,
  onText?: (t: string) => void,
): Promise<ChatResult> {
  const t0 = performance.now();
  const body: Record<string, unknown> = {
    model: s.model,
    messages: msgs.map(m => (m.images?.length ? { role: m.role, content: m.content, images: m.images } : { role: m.role, content: m.content })),
    stream: true,
    keep_alive: s.keepAlive || '30m',
    options: { num_ctx: s.contextWindow, temperature: s.temperature, num_predict: outputBudget(s) },
  };
  if (st.level === 'schema' && schema) body.format = schema;
  else if (st.level === 'json') body.format = 'json';
  if (s.effort !== 'default' && st.noThinkOk) body.think = s.effort === 'none' ? false : s.effort === 'low' || s.effort === 'medium' || s.effort === 'high' ? s.effort : true;
  const res = await post(`${trimSlash(s.baseUrl)}/api/chat`, body, s, signal);
  let text = '';
  const usage: Usage = { totalMs: 0 };
  for await (const line of lines(res.body!, signal)) {
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.error) throw new LlmError(`model error: ${j.error}`, 500);
    const c = j.message?.content;
    if (c) {
      text += c;
      onText?.(text);
      checkDegenerate(text);
    }
    if (j.done) {
      usage.promptTokens = j.prompt_eval_count;
      usage.outputTokens = j.eval_count;
      usage.promptMs = j.prompt_eval_duration ? j.prompt_eval_duration / 1e6 : undefined;
      usage.genMs = j.eval_duration ? j.eval_duration / 1e6 : undefined;
      usage.loadMs = j.load_duration ? j.load_duration / 1e6 : undefined;
    }
  }
  usage.totalMs = performance.now() - t0;
  return { text: stripThinking(text), usage, mode: st.level };
}

async function openai(
  s: Settings,
  msgs: ChatMsg[],
  schema: object | null,
  st: { level: Level; noThinkOk: boolean; extrasOk: boolean },
  signal: AbortSignal,
  onText?: (t: string) => void,
): Promise<ChatResult> {
  const t0 = performance.now();
  const local = isLocalUrl(s.baseUrl);
  const body: Record<string, unknown> = {
    model: s.model || 'default',
    messages: msgs.map(m =>
      m.images?.length
        ? {
            role: m.role,
            content: [
              { type: 'text', text: m.content },
              ...m.images.map(b => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b}` } })),
            ],
          }
        : { role: m.role, content: m.content },
    ),
    stream: true,
    temperature: s.temperature,
    max_tokens: outputBudget(s),
  };
  if (st.level === 'schema' && schema) body.response_format = { type: 'json_schema', json_schema: { name: 'action', strict: false, schema } };
  else if (st.level === 'json') body.response_format = { type: 'json_object' };
  if (st.extrasOk) {
    body.stream_options = { include_usage: true };
    // llama.cpp: reuse the KV cache for the shared prompt prefix (default on in new builds; explicit for old ones).
    if (local) body.cache_prompt = true;
  }
  if (s.effort !== 'default' && st.noThinkOk) {
    // Splash / vLLM / OpenAI read reasoning_effort; llama.cpp and LM Studio Qwen templates read enable_thinking.
    body.reasoning_effort = s.effort;
    if (local) body.chat_template_kwargs = { enable_thinking: s.effort !== 'none' };
  }
  const res = await post(`${trimSlash(s.baseUrl)}/chat/completions`, body, s, signal);
  let text = '';
  const usage: Usage = { totalMs: 0 };
  let firstTok = 0;
  for await (const line of lines(res.body!, signal)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') break;
    let j: any;
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    if (j.error) throw new LlmError(`model error: ${j.error.message ?? j.error}`, 500);
    const c = j.choices?.[0]?.delta?.content;
    if (c) {
      if (!firstTok) firstTok = performance.now();
      text += c;
      onText?.(text);
      checkDegenerate(text);
    }
    if (j.usage) {
      usage.promptTokens = j.usage.prompt_tokens;
      usage.outputTokens = j.usage.completion_tokens;
      usage.cachedTokens = j.usage.prompt_tokens_details?.cached_tokens ?? usage.cachedTokens;
    }
    if (j.timings) {
      // llama.cpp server timings: cache_n is the reused prefix, prompt_n what had to be computed.
      usage.cachedTokens = j.timings.cache_n ?? usage.cachedTokens;
      usage.promptTokens = (j.timings.prompt_n ?? 0) + (j.timings.cache_n ?? 0) || usage.promptTokens;
      usage.promptMs = j.timings.prompt_ms;
      usage.genMs = j.timings.predicted_ms;
      usage.outputTokens = j.timings.predicted_n ?? usage.outputTokens;
    }
  }
  usage.totalMs = performance.now() - t0;
  if (usage.promptMs === undefined && firstTok) usage.promptMs = firstTok - t0;
  return { text: stripThinking(text), usage, mode: st.level };
}

/**
 * ChatGPT plan through the public Responses API (Sign in with ChatGPT). Differences from chat/completions: the
 * system prompt goes in `instructions` (system items are rejected); `store: false` and `stream: true` are required;
 * temperature and max_output_tokens are not accepted; success is only `response.completed`.
 */
async function responses(
  s: Settings,
  msgs: ChatMsg[],
  schema: object | null,
  st: { level: Level; noThinkOk: boolean },
  signal: AbortSignal,
  onText?: (t: string) => void,
): Promise<ChatResult> {
  const t0 = performance.now();
  const body: Record<string, unknown> = {
    model: s.model,
    instructions: msgs.filter(m => m.role === 'system').map(m => m.content).join('\n\n'),
    input: msgs
      .filter(m => m.role !== 'system')
      .map(m => ({
        type: 'message',
        role: m.role,
        content:
          m.role === 'assistant'
            ? [{ type: 'output_text', text: m.content }]
            : [{ type: 'input_text', text: m.content }, ...(m.images ?? []).map(b => ({ type: 'input_image', image_url: `data:image/jpeg;base64,${b}` }))],
      })),
    store: false,
    stream: true,
  };
  if (st.level === 'schema' && schema) body.text = { format: { type: 'json_schema', name: 'action', schema, strict: false } };
  else if (st.level === 'json') body.text = { format: { type: 'json_object' } };
  if (s.effort !== 'default' && st.noThinkOk) body.reasoning = { effort: s.effort };
  const url = `${RESOURCE}/responses`;
  let res: Response;
  try {
    res = await post(url, body, s, signal, await chatGptToken(false));
  } catch (e) {
    // An access token can be revoked or rotated early: refresh once and retry.
    if ((e as LlmError).status !== 401 || signal.aborted) throw e;
    res = await post(url, body, s, signal, await chatGptToken(true));
  }
  let text = '';
  const usage: Usage = { totalMs: 0 };
  let firstTok = 0;
  let completed = false;
  for await (const line of lines(res.body!, signal)) {
    if (!line.startsWith('data:')) continue;
    let j: any;
    try {
      j = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    switch (j.type) {
      case 'response.output_text.delta':
        if (!firstTok) firstTok = performance.now();
        text += j.delta ?? '';
        onText?.(text);
        checkDegenerate(text);
        break;
      case 'response.completed': {
        completed = true;
        const u = j.response?.usage;
        if (u) {
          usage.promptTokens = u.input_tokens;
          usage.cachedTokens = u.input_tokens_details?.cached_tokens;
          usage.outputTokens = u.output_tokens;
        }
        break;
      }
      case 'response.incomplete':
        throw new LlmError(`ChatGPT stopped early: ${j.response?.incomplete_details?.reason ?? 'incomplete'}`, 500);
      case 'response.failed':
      case 'error': {
        const err = j.response?.error ?? j.error ?? j;
        if (err.code === 'subscription_sharing_usage_limit_exceeded') {
          throw new LlmError('ChatGPT plan usage limit reached for this app. See ChatGPT → Settings → Usage.', 429);
        }
        throw new LlmError(`ChatGPT error: ${err.message ?? 'request failed'}${err.code ? ` [${err.code}]` : ''}`, err.code === 'subscription_sharing_unsupported_capability' ? 400 : 503);
      }
    }
  }
  if (!completed) throw new LlmError('ChatGPT stream ended before the response completed', 503);
  usage.totalMs = performance.now() - t0;
  if (firstTok) usage.promptMs = firstTok - t0;
  return { text: stripThinking(text), usage, mode: st.level };
}

export interface ModelInfo {
  contextLength?: number;
  vision?: boolean;
  thinking?: boolean;
}

export async function listModels(s: Settings): Promise<string[]> {
  if (s.kind === 'chatgpt') {
    const res = await fetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${await chatGptToken(false)}` } });
    if (!res.ok) throw new LlmError(`listing models failed: ${res.status}`, res.status);
    const j = await res.json();
    // ChatGPT plan: { models: [{ slug, visibility }] }, only `list` entries are offered.
    if (Array.isArray(j.models)) return j.models.filter((m: any) => m.visibility === 'list').map((m: any) => m.slug);
    return (j.data ?? []).map((m: { id: string }) => m.id);
  }
  const base = trimSlash(s.baseUrl);
  const headers: Record<string, string> = s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {};
  const url = s.kind === 'ollama' ? `${base}/api/tags` : `${base}/models`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new LlmError(`listing models failed: ${res.status}`, res.status);
  const j = await res.json();
  if (s.kind === 'ollama') return (j.models ?? []).map((m: { name: string }) => m.name);
  return (j.data ?? []).map((m: { id: string }) => m.id);
}

export async function modelInfo(s: Settings): Promise<ModelInfo> {
  if (s.kind !== 'ollama' || !s.model) return {};
  try {
    const res = await fetch(`${trimSlash(s.baseUrl)}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: s.model }),
    });
    if (!res.ok) return {};
    const j = await res.json();
    const info = j.model_info ?? {};
    const ctxKey = Object.keys(info).find(k => k.endsWith('.context_length'));
    const caps: string[] = j.capabilities ?? [];
    return { contextLength: ctxKey ? Number(info[ctxKey]) : undefined, vision: caps.includes('vision'), thinking: caps.includes('thinking') };
  } catch {
    return {};
  }
}

/**
 * Loads the model (servers that unload it when idle) and caches the opening of the prompt, while the user is still
 * typing. Fire-and-forget; failures are irrelevant.
 */
export async function prewarm(s: Settings, msgs: ChatMsg[], signal?: AbortSignal): Promise<number> {
  const t0 = performance.now();
  // Nothing to load on a hosted model, and the Responses API can't cap the reply at one token: it would cost plan usage.
  if (s.kind === 'chatgpt') return 0;
  try {
    await chat({ ...s, maxOutput: 1, effort: s.effort === 'default' ? 'default' : 'none' }, msgs, null, signal ?? AbortSignal.timeout(120000));
  } catch {
    // ignore
  }
  return performance.now() - t0;
}
