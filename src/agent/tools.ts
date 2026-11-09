// The agent's tools: one flat JSON object per step, `{"think": "...", "tool": "...", ...args}`.
// A flat object with an enum `tool` is the schema every local constrained-decoding engine handles (Ollama `format`,
// llama.cpp/LM Studio/vLLM `json_schema`), and the easiest shape for small models to produce reliably.

export type ToolName =
  | 'click' | 'type' | 'select' | 'key' | 'scroll' | 'hover' | 'navigate' | 'back' | 'read' | 'find' | 'tab_new'
  | 'tab_switch' | 'tab_close' | 'wait' | 'screenshot' | 'login' | 'ask' | 'done';

export interface Action {
  think?: string;
  tool: ToolName;
  ref?: string;
  text?: string;
  url?: string;
  option?: string;
  key?: string;
  dir?: 'up' | 'down' | 'left' | 'right';
  query?: string;
  offset?: number;
  tab?: number;
  seconds?: number;
  enter?: boolean;
  answer?: string;
  success?: boolean;
  /** More page actions to run right after this one, on the same page (fill several fields in one step). */
  then?: Action[];
  /** Chained actions ignored because they followed a non-page action (reported to the model). */
  dropped?: number;
}

/** Tools that may be chained with `then`: page actions whose refs come from the same page state. */
export const CHAINABLE = new Set<ToolName>(['click', 'type', 'select', 'key', 'scroll', 'hover']);
export const MAX_CHAIN = 8;

interface Spec {
  name: ToolName;
  sig: string;
  doc: string;
  required: (keyof Action)[];
  vision?: boolean;
  /** Offered only when Bitwarden logins are on. */
  login?: boolean;
}

export const TOOLS: Spec[] = [
  { name: 'click', sig: '{"tool":"click","ref":"12"}', doc: 'click an element', required: ['ref'] },
  { name: 'type', sig: '{"tool":"type","ref":"5","text":"...","enter":true}', doc: 'replace the text in a field; enter:true presses Enter after (submits search boxes and forms)', required: ['ref', 'text'] },
  { name: 'select', sig: '{"tool":"select","ref":"7","option":"Large"}', doc: 'pick an option in a dropdown (combobox with options)', required: ['ref', 'option'] },
  { name: 'key', sig: '{"tool":"key","key":"Escape"}', doc: 'press a key (Enter, Escape, Tab, ArrowDown, PageDown, Control+a); optional ref to focus first', required: ['key'] },
  { name: 'scroll', sig: '{"tool":"scroll","dir":"down"}', doc: 'scroll the page one screen; optional ref scrolls the area containing it', required: ['dir'] },
  { name: 'hover', sig: '{"tool":"hover","ref":"3"}', doc: 'move the mouse over an element (opens hover menus)', required: ['ref'] },
  { name: 'navigate', sig: '{"tool":"navigate","url":"example.com"}', doc: 'open a URL in this tab; plain words search the web', required: ['url'] },
  { name: 'back', sig: '{"tool":"back"}', doc: 'go back in history', required: [] },
  { name: 'read', sig: '{"tool":"read","query":"price"}', doc: 'get the page\'s full text (query filters to matching lines; offset pages through long text)', required: [] },
  { name: 'find', sig: '{"tool":"find","text":"Contact us"}', doc: 'search the whole page, including off-screen, for elements or text; returns refs you can use', required: ['text'] },
  { name: 'tab_new', sig: '{"tool":"tab_new","url":"..."}', doc: 'open a URL in a new tab and switch to it', required: ['url'] },
  { name: 'tab_switch', sig: '{"tool":"tab_switch","tab":2}', doc: 'switch to a tab by its number in the tab list', required: ['tab'] },
  { name: 'tab_close', sig: '{"tool":"tab_close"}', doc: 'close the current tab', required: [] },
  { name: 'wait', sig: '{"tool":"wait","seconds":2}', doc: 'wait for the page to finish loading or updating (max 10)', required: [] },
  { name: 'screenshot', sig: '{"tool":"screenshot"}', doc: 'look at the page as an image, with refs drawn on it', required: [], vision: true },
  { name: 'login', sig: '{"tool":"login","enter":true}', doc: 'sign in with the user\'s saved Bitwarden login for this site: fills the username, password or one-time code without showing them to you; enter:true submits; optional ref picks the form; option picks an account when several are listed', required: [], login: true },
  { name: 'ask', sig: '{"tool":"ask","text":"Which size?"}', doc: 'ask the user a question when you are missing information only they have', required: ['text'] },
  { name: 'done', sig: '{"tool":"done","answer":"...","success":true}', doc: 'finish: the answer or a summary of what you did; success:false if you could not do it', required: ['answer'] },
];

export function toolsFor(vision: boolean, login = false): Spec[] {
  return TOOLS.filter(t => (!t.vision || vision) && (!t.login || login));
}

/** JSON schema for one step. Property order matters to grammar-based decoders: think comes first. */
export function actionSchema(vision: boolean, reasoning: boolean, login = false): object {
  const names = toolsFor(vision, login).map(t => t.name);
  const props: Record<string, object> = {};
  if (reasoning) props.think = { type: 'string', maxLength: 300 };
  props.tool = { type: 'string', enum: names };
  props.ref = { type: 'string' };
  props.text = { type: 'string' };
  props.url = { type: 'string' };
  props.option = { type: 'string' };
  props.key = { type: 'string' };
  props.dir = { type: 'string', enum: ['up', 'down', 'left', 'right'] };
  props.query = { type: 'string' };
  props.offset = { type: 'integer' };
  props.tab = { type: 'integer' };
  props.seconds = { type: 'number' };
  props.enter = { type: 'boolean' };
  props.answer = { type: 'string' };
  props.success = { type: 'boolean' };
  props.then = {
    type: 'array',
    maxItems: MAX_CHAIN,
    items: {
      type: 'object',
      properties: {
        tool: { type: 'string', enum: [...CHAINABLE] },
        ref: props.ref,
        text: props.text,
        option: props.option,
        key: props.key,
        dir: props.dir,
        enter: props.enter,
      },
      required: ['tool'],
      additionalProperties: false,
    },
  };
  return { type: 'object', properties: props, required: reasoning ? ['think', 'tool'] : ['tool'], additionalProperties: false };
}

// ---------- tolerant parsing ----------

const TOOL_ALIASES: Record<string, ToolName> = {
  click_element: 'click', press: 'key', press_key: 'key', keypress: 'key', input: 'type', type_text: 'type', fill: 'type',
  input_text: 'type', goto: 'navigate', go_to: 'navigate', open: 'navigate', open_url: 'navigate', go_to_url: 'navigate',
  search: 'find', search_page: 'find', extract: 'read', get_text: 'read', read_page: 'read', finish: 'done',
  complete: 'done', answer: 'done', go_back: 'back', select_option: 'select', new_tab: 'tab_new', open_tab: 'tab_new',
  switch_tab: 'tab_switch', close_tab: 'tab_close', ask_user: 'ask', scroll_down: 'scroll', scroll_up: 'scroll',
  sign_in: 'login', signin: 'login', log_in: 'login', autofill: 'login', fill_login: 'login',
};

/** First balanced {...} in a string, tolerant of prose and code fences around it. */
export function extractJson(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  // Truncated output: close what is open.
  return s.slice(start) + (inStr ? '"' : '') + '}'.repeat(Math.max(1, depth));
}

function repair(j: string): string {
  return j
    .replace(/,\s*([}\]])/g, '$1') // trailing commas
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":') // unquoted keys
    .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, v: string) => `: ${JSON.stringify(v)}`) // single-quoted values
    .replace(/:\s*True\b/g, ': true')
    .replace(/:\s*False\b/g, ': false')
    .replace(/:\s*None\b/g, ': null');
}

/**
 * Escapes quotes inside string values that a model left raw ("think":"it shows "Done" now"). A quote inside a string
 * closes it only if what follows is structure (, } ] :); otherwise it is text. Without this, every such reply cost a
 * retry step (seen with Qwen3.8 on Splash, which does not strictly enforce the schema).
 */
export function escapeInnerQuotes(j: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < j.length; i++) {
    const c = j[i];
    if (inStr && c === '\\') {
      out += c + (j[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '"') {
      if (!inStr) inStr = true;
      else {
        const rest = j.slice(i + 1).match(/^\s*(.)/)?.[1];
        if (rest === undefined || ',}]:'.includes(rest)) inStr = false;
        else {
          out += '\\"';
          continue;
        }
      }
    }
    out += c;
  }
  return out;
}

export type Parsed = { ok: true; action: Action } | { ok: false; error: string };

export function parseAction(raw: string, vision: boolean, login = false): Parsed {
  const j = extractJson(raw);
  if (!j) return { ok: false, error: 'Your reply had no JSON object. Reply with exactly one JSON action.' };
  let obj: any;
  try {
    obj = JSON.parse(j);
  } catch {
    try {
      obj = JSON.parse(repair(j));
    } catch {
      try {
        obj = JSON.parse(repair(escapeInnerQuotes(j)));
      } catch {
        obj = undefined;
      }
    }
    if (obj === undefined) {
      return { ok: false, error: 'Your reply was not valid JSON. Reply with exactly one JSON action, e.g. {"tool":"click","ref":"12"}.' };
    }
  }
  if (Array.isArray(obj)) obj = obj[0];
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'Reply with one JSON object.' };
  // Common shapes small models produce: {"action": {...}}, {"name": .., "arguments": {..}}, {"tool": .., "args": {..}}.
  if (obj.action && typeof obj.action === 'object') obj = { think: obj.think ?? obj.thought, ...obj.action };
  const nested = obj.args ?? obj.arguments ?? obj.parameters ?? obj.params ?? obj.input;
  let rawTool = obj.tool ?? obj.name ?? obj.action ?? obj.function ?? obj.type;
  if (typeof nested === 'string') {
    try {
      Object.assign(obj, JSON.parse(nested));
    } catch {
      // ignore
    }
  } else if (nested && typeof nested === 'object') obj = { ...obj, ...nested };
  // {"type": "..."} collides with the type tool's name: only treat it as the tool name if it names a tool.
  if (typeof rawTool !== 'string') return { ok: false, error: 'Missing "tool". Every reply needs "tool", e.g. {"tool":"click","ref":"12"}.' };
  rawTool = rawTool.trim().toLowerCase();
  const allowed = toolsFor(vision, login).map(t => t.name) as string[];
  const tool = (allowed.includes(rawTool) ? rawTool : TOOL_ALIASES[rawTool]) as ToolName | undefined;
  if (!tool || !allowed.includes(tool)) {
    return { ok: false, error: `Unknown tool "${rawTool}". Tools: ${allowed.join(', ')}.` };
  }
  const a: Action = { tool };
  if (typeof obj.think === 'string' || typeof obj.thought === 'string') a.think = String(obj.think ?? obj.thought).slice(0, 400);
  const ref = obj.ref ?? obj.id ?? obj.element ?? obj.index ?? obj.element_id;
  if (ref !== undefined && ref !== null && ref !== '') a.ref = String(ref).replace(/^\[|\]$/g, '').replace(/^ref\s*/i, '').trim();
  const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
  a.text = str(obj.text ?? obj.value ?? obj.content ?? (tool === 'ask' ? obj.question : undefined));
  if (tool === 'find' && a.text === undefined) a.text = str(obj.query);
  a.url = str(obj.url ?? obj.href ?? obj.link);
  a.option = str(obj.option ?? obj.choice ?? (tool === 'select' ? (obj.value ?? obj.text) : tool === 'login' ? (obj.account ?? obj.item) : undefined));
  a.key = str(obj.key ?? obj.keys ?? (tool === 'key' ? obj.text : undefined));
  if (rawTool === 'scroll_up') a.dir = 'up';
  else if (rawTool === 'scroll_down') a.dir = 'down';
  else if (obj.dir ?? obj.direction) a.dir = String(obj.dir ?? obj.direction).toLowerCase() as Action['dir'];
  if (tool === 'scroll' && !a.dir) a.dir = 'down';
  a.query = str(obj.query);
  if (obj.offset !== undefined) a.offset = Number(obj.offset) || 0;
  if (obj.tab !== undefined) a.tab = Number(obj.tab);
  if (obj.seconds !== undefined) a.seconds = Number(obj.seconds);
  if (obj.enter !== undefined || obj.submit !== undefined || obj.press_enter !== undefined) a.enter = !!(obj.enter ?? obj.submit ?? obj.press_enter);
  a.answer = str(obj.answer ?? obj.result ?? obj.summary ?? (tool === 'done' ? (obj.text ?? obj.message) : undefined));
  if (obj.success !== undefined) a.success = obj.success !== false && obj.success !== 'false';

  const spec = TOOLS.find(t => t.name === tool)!;
  const missing = spec.required.filter(k => a[k] === undefined || a[k] === '');
  if (missing.length) return { ok: false, error: `"${tool}" needs ${missing.map(m => `"${m}"`).join(' and ')}. Example: ${spec.sig}` };
  if (a.dir && !['up', 'down', 'left', 'right'].includes(a.dir)) return { ok: false, error: '"dir" must be up, down, left or right.' };
  if (a.ref && !/^(\d+:)?\d+$/.test(a.ref)) return { ok: false, error: `"${a.ref}" is not a ref. Refs are the numbers in brackets, e.g. "12" or "3:7".` };
  if (Array.isArray(obj.then) && obj.then.length) {
    const chain: Action[] = [];
    for (const [i, item] of obj.then.slice(0, MAX_CHAIN).entries()) {
      const p = parseAction(JSON.stringify(item), vision, login);
      if (!p.ok) return { ok: false, error: `then[${i}]: ${p.error}` };
      if (!CHAINABLE.has(p.action.tool) || p.action.then) return { ok: false, error: `then[${i}]: only ${[...CHAINABLE].join(', ')} can be chained.` };
      delete p.action.think;
      chain.push(p.action);
    }
    // After navigation-type tools the refs would belong to another page: the main action runs, the chain does not.
    if (CHAINABLE.has(tool)) a.then = chain;
    else a.dropped = chain.length;
  }
  // Drop fields that do not belong to this tool so history stays canonical.
  for (const k of Object.keys(a) as (keyof Action)[]) if (a[k] === undefined) delete a[k];
  return { ok: true, action: a };
}

/** Canonical compact form of an action for the history (stable bytes → stable KV-cache prefix). */
export function canonical(a: Action): string {
  const order: (keyof Action)[] = ['think', 'tool', 'ref', 'text', 'url', 'option', 'key', 'dir', 'query', 'offset', 'tab', 'seconds', 'enter', 'answer', 'success'];
  const o: Record<string, unknown> = {};
  for (const k of order) if (a[k] !== undefined) o[k] = a[k];
  if (a.then?.length) o.then = a.then.map(x => JSON.parse(canonical(x)));
  return JSON.stringify(o);
}
