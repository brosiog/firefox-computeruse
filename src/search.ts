// Web search for the agent through Parallel's hosted Search MCP, which answers without an account or API key
// (anonymous calls run in Parallel's fast mode and are rate limited). One stateless JSON-RPC POST per search: the
// server needs no session, so there is nothing to initialize, keep or close.
//
// The server returns ~2.4 KB of page excerpt for each of ten results (~28 KB). That would flood a small model's
// context, so results are cut to a few short, readable lines each before the model sees them.

export const SEARCH_URL = 'https://search.parallel.ai/mcp';

const MAX_RESULTS = 5;
const EXCERPT_CHARS = 500;
const MAX_QUERY_CHARS = 200;
const TIMEOUT_MS = 20_000;

export interface SearchHit {
  title: string;
  url: string;
  date?: string;
  excerpt: string;
}

/**
 * Picks the lines of an excerpt most likely to hold the answer: readable lines (menus, bare links and fragments
 * dropped, markdown links reduced to their text), ranked by how many of the query's words they contain, then put back
 * in page order up to the character budget. Without a query it keeps the first lines.
 */
export function tidyExcerpt(raw: string, query = '', max = EXCERPT_CHARS): string {
  const clean = (l: string) =>
    l
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^[\s*#>|\-\d.]+(?=[A-Za-z])/, '')
      .replace(/\s+/g, ' ')
      .trim();
  const lines = raw.split('\n').map(clean).filter(l => l.length >= 30 && l !== '...');
  if (!lines.length) return clean(raw).slice(0, max);
  const words = [...new Set(query.toLowerCase().match(/[a-z0-9.]{3,}/g) ?? [])];
  const score = (l: string) => {
    const low = l.toLowerCase();
    return words.reduce((n, w) => n + (low.includes(w) ? 1 : 0), 0);
  };
  const ranked = lines.map((text, i) => ({ text, i, score: score(text) })).sort((x, y) => y.score - x.score || x.i - y.i);
  const picked: typeof ranked = [];
  let used = 0;
  for (const l of ranked) {
    const room = max - used;
    if (room < 40) break;
    const text = l.text.length > room ? l.text.slice(0, room).replace(/\s+\S*$/, '') + '…' : l.text;
    picked.push({ ...l, text });
    used += text.length + 1;
  }
  return picked.sort((x, y) => x.i - y.i).map(l => l.text).join(' ');
}

export function parseSearchResponse(body: unknown, query = ''): SearchHit[] {
  const results = (body as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const hits: SearchHit[] = [];
  for (const r of results) {
    const url = typeof r?.url === 'string' ? r.url : '';
    if (!/^https?:\/\//i.test(url)) continue;
    const excerpts: string[] = Array.isArray(r.excerpts) ? r.excerpts.filter((e: unknown) => typeof e === 'string') : [];
    hits.push({
      title: typeof r.title === 'string' ? r.title.replace(/\s+/g, ' ').trim() : url,
      url,
      date: typeof r.publish_date === 'string' ? r.publish_date : undefined,
      excerpt: tidyExcerpt(excerpts.join('\n'), query),
    });
    if (hits.length >= MAX_RESULTS) break;
  }
  return hits;
}

export function formatHits(query: string, hits: SearchHit[]): string {
  if (!hits.length) return `no results for "${query}". Try different words.`;
  const body = hits
    .map((h, i) => `${i + 1}. ${h.title}${h.date ? ` (${h.date})` : ''}\n   ${h.url}\n   ${h.excerpt}`)
    .join('\n');
  return `Search results for "${query}":\n${body}`;
}

/** Pulls the JSON-RPC message out of a plain JSON reply or a one-event SSE stream. */
function rpcMessage(text: string, contentType: string): any {
  if (!contentType.includes('text/event-stream')) return JSON.parse(text);
  const data = text
    .split('\n')
    .filter(l => l.startsWith('data:'))
    .map(l => l.slice(5).trim())
    .filter(Boolean);
  for (const d of data.reverse()) {
    try {
      const m = JSON.parse(d);
      if (m && (m.result || m.error)) return m;
    } catch {
      // keep looking
    }
  }
  throw new Error('no result in the search reply');
}

/**
 * Runs one search. Resolves to the hits; throws an Error with a message fit for the model on any failure (rate limit,
 * network, bad reply), so the agent can carry on by browsing instead.
 */
export async function webSearch(query: string, signal?: AbortSignal, f: typeof fetch = fetch): Promise<SearchHit[]> {
  const q = query.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS);
  if (!q) throw new Error('give a query to search for');
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await f(SEARCH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'web_search', arguments: { objective: q, search_queries: [q] } },
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    if (signal?.aborted) throw new Error('stopped');
    throw new Error(`web search is unreachable (${timeout.aborted ? 'timed out' : 'network error'}). Use the browser instead`);
  }
  if (res.status === 429) throw new Error('web search is rate limited right now. Use the browser instead, or try again later');
  if (!res.ok) throw new Error(`web search failed (HTTP ${res.status}). Use the browser instead`);
  let msg: any;
  try {
    msg = rpcMessage(await res.text(), res.headers.get('content-type') ?? '');
  } catch {
    throw new Error('web search sent a reply that could not be read. Use the browser instead');
  }
  if (msg.error) throw new Error(`web search failed: ${String(msg.error.message ?? 'error').slice(0, 120)}. Use the browser instead`);
  if (msg.result?.isError) throw new Error(`web search failed: ${String(msg.result.content?.[0]?.text ?? 'error').slice(0, 120)}. Use the browser instead`);
  const text = msg.result?.structuredContent ?? msg.result?.content?.find((c: any) => c?.type === 'text')?.text;
  let body: unknown = text;
  if (typeof text === 'string') {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error('web search sent a reply that could not be read. Use the browser instead');
    }
  }
  return parseSearchResponse(body, q);
}
