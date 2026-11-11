// Agent bridge, extension side. The sidebar long-polls the local bridge hub (bridge/fcu.mjs) for commands from coding
// agents (MCP or CLI) and runs them on the browser with the same executor, gating and page state as the built-in
// agent. Commands: status, observe, act (one or more actions, then the new page state), task (delegate to the
// built-in agent).

import { createExecutor, type AgentUI, type Executor } from './agent/loop';
import { parseAction, type Action } from './agent/tools';
import { createHost, type Host } from './browser/host';
import type { Settings } from './settings';
import type { Vault } from './vault';

export type BridgeCmd =
  | { op: 'status' }
  | { op: 'observe'; screenshot?: boolean; budget?: number }
  | { op: 'act'; actions: unknown[]; observe?: boolean; screenshot?: boolean }
  | { op: 'task'; task: string; maxSteps?: number };

export interface BridgeResult {
  ok: boolean;
  text: string;
  /** Base64 JPEG. */
  image?: string;
}

export interface BridgeDeps {
  settings(): Settings;
  /** The tab agent commands start on (the sidebar window's active tab). */
  target(): Promise<{ tabId: number; windowId: number }>;
  approve: AgentUI['approve'];
  /** Runs the built-in agent on a task, in the sidebar; null when it is already busy. */
  runTask(task: string, maxSteps?: number): Promise<{ success: boolean; answer: string } | null>;
  busy(): boolean;
  /** One line for the sidebar log, so the user sees what agents do. */
  note(text: string, ok: boolean): void;
  /** Bitwarden for agents: null unless the user allowed coding agents to use logins. */
  vault?(): Vault | null;
  /** Host factory (tests). */
  createHost?: typeof createHost;
  tabAlive?: (tabId: number) => Promise<boolean>;
}

const DEFAULT_BUDGET = 8000;
const NOT_FOR_AGENTS = new Set(['done', 'ask', 'screenshot']);

export function createBridgeHandler(d: BridgeDeps) {
  let host: Host | null = null;
  let exec: Executor | null = null;
  let execSettings: Settings | null = null;
  let lock: Promise<unknown> = Promise.resolve();
  const tabs = () => (globalThis as any).browser?.tabs;
  const alive = d.tabAlive ?? (async (id: number) => !!(await tabs()?.get(id).catch(() => null)));
  const tabUrl = async (id: number): Promise<string> => (await tabs()?.get(id).catch(() => null))?.url ?? '';

  // One persistent host: refs and frame aliases stay stable across calls, and so do declines. It keeps the tab the
  // agent switched to, but starts over on the active tab when that tab was closed or the user switched tabs.
  let activeAfter: number | undefined;
  let win = 0;
  const activeTab = async (): Promise<number | undefined> => {
    const t = tabs();
    if (!t || !host) return undefined;
    const [a] = await t.query({ active: true, windowId: win }).catch(() => []);
    return a?.id;
  };
  async function ensureHost(): Promise<{ host: Host; exec: Executor }> {
    // The user switched tabs if the active tab is neither the agent's tab nor the one active after its last command
    // (right after tab_new, Firefox may still report the previous tab as active).
    const active = host ? await activeTab() : undefined;
    const userSwitched = !!host && active !== undefined && activeAfter !== undefined && active !== host.tabId && active !== activeAfter;
    if (!host || userSwitched || !(await alive(host.tabId))) {
      const { tabId, windowId } = await d.target();
      host = (d.createHost ?? createHost)(tabId, windowId);
      win = windowId;
      exec = null;
    }
    // Rebuilt when settings change (approval mode); declines are kept per executor.
    if (!exec || execSettings !== d.settings()) {
      execSettings = d.settings();
      exec = createExecutor({ host, settings: execSettings, ui: { approve: d.approve, ask: async () => null }, signal: new AbortController().signal, vault: d.vault?.() ?? null });
    }
    return { host, exec: exec! };
  }

  async function observe(screenshot: boolean, budget?: number): Promise<BridgeResult> {
    const { host } = await ensureHost();
    const obs = await host.observe(Math.max(1000, budget ?? Math.max(DEFAULT_BUDGET, d.settings().pageBudget)));
    const r: BridgeResult = { ok: true, text: obs.text };
    if (screenshot && !obs.restricted) {
      const img = await host.screenshot(true);
      if (img) r.image = img;
      else r.text += '\n(screenshot failed)';
    }
    return r;
  }

  async function act(cmd: Extract<BridgeCmd, { op: 'act' }>): Promise<BridgeResult> {
    if (d.busy()) return { ok: false, text: 'the sidebar agent is running a task in this browser; wait for it to finish, then try again.' };
    const list = Array.isArray(cmd.actions) ? cmd.actions : [cmd.actions];
    if (!list.length) return { ok: false, text: 'no actions given. Example: [{"tool":"click","ref":"12"}]' };
    const parsed: Action[] = [];
    for (const [i, raw] of list.entries()) {
      const p = parseAction(typeof raw === 'string' ? raw : JSON.stringify(raw), true, !!d.vault?.());
      if (!p.ok) return { ok: false, text: `actions[${i}]: ${p.error.replace(/Reply with[^.]*\.\s*/g, '')}` };
      if (NOT_FOR_AGENTS.has(p.action.tool)) return { ok: false, text: `actions[${i}]: "${p.action.tool}" is not available here (use browser_observe with screenshot:true to look at the page).` };
      parsed.push(p.action);
    }
    const { host, exec } = await ensureHost();
    const lines: string[] = [];
    let ok = true;
    const tab0 = host.tabId;
    let url = await tabUrl(host.tabId);
    for (let i = 0; i < parsed.length; i++) {
      const a = parsed[i];
      let r: { ok: boolean; text: string };
      try {
        r = await exec.run(a, url);
      } catch (e) {
        r = { ok: false, text: `the action failed: ${(e as Error).message ?? e}` };
      }
      const label = `${a.tool}${a.ref ? ` [${a.ref}]` : ''}`;
      lines.push(`${label}: ${r.ok ? 'OK' : 'Error'}: ${r.text}`);
      d.note(`agent: ${label} → ${r.ok ? 'ok' : r.text.slice(0, 120)}`, r.ok);
      ok = r.ok;
      const changed = /URL is now|new tab|navigated|opened |went back|switched to|closed the tab/.test(r.text) || host.tabId !== tab0;
      const rest = parsed.length - i - 1;
      if (rest && (!r.ok || changed)) {
        lines.push(`(the remaining ${rest} action(s) were not run: ${r.ok ? 'the page changed; refs are from the old page' : 'this one failed'})`);
        break;
      }
      url = (await tabUrl(host.tabId)) || url;
    }
    // A click or Enter can start a navigation a little after the action returns. The built-in loop never notices (the
    // model call takes longer), but a direct caller would get the old page: give it a moment to start.
    const last = parsed[parsed.length - 1];
    if (ok && (cmd.observe !== false || cmd.screenshot) && (last.tool === 'click' || last.tool === 'key' || last.tool === 'select' || (last.tool === 'type' && last.enter))) {
      await navStart(host.tabId, url, /submitted the form/.test(lines[lines.length - 1] ?? '') ? 1500 : 300);
    }
    let text = lines.join('\n');
    let image: string | undefined;
    if (cmd.observe !== false || cmd.screenshot) {
      const o = await observe(!!cmd.screenshot);
      text += `\n\n${o.text}`;
      image = o.image;
    }
    return { ok, text, image };
  }

  // Firefox reports `loading` (with the old URL) as soon as a submit is sent, but can flip back to `complete` for a
  // moment before the new document commits, so waiting for `complete` alone can snapshot the old page. Once a
  // navigation has started, wait for the URL to change (or give up after a while: same-URL posts, slow servers).
  async function navStart(tabId: number, url: string, ms: number) {
    const t = tabs();
    if (!t) return;
    let started = 0;
    for (const t0 = Date.now(); Date.now() - t0 < (started ? ms + 2000 : ms); ) {
      const tab = await t.get(tabId).catch(() => null);
      if (!tab || tab.url !== url) return;
      if (tab.status === 'loading') started ||= Date.now();
      await new Promise(r => setTimeout(r, 40));
    }
  }

  async function run(cmd: BridgeCmd): Promise<BridgeResult> {
    switch (cmd.op) {
      case 'status':
        return { ok: true, text: `connected; ${d.busy() ? 'the sidebar agent is busy' : 'idle'}; approvals: ${d.settings().approval}; Bitwarden logins: ${d.vault?.() ? 'on (login tool)' : 'off'}` };
      case 'observe':
        return observe(!!cmd.screenshot, cmd.budget);
      case 'act':
        return act(cmd);
      case 'task': {
        if (!cmd.task?.trim()) return { ok: false, text: 'task is empty' };
        const r = await d.runTask(cmd.task.trim(), cmd.maxSteps);
        if (!r) return { ok: false, text: 'the sidebar agent is already running a task; wait for it to finish.' };
        // The run may have moved to another tab or page: the next direct command re-checks its host.
        return { ok: r.success, text: r.answer || (r.success ? 'Done.' : 'Not finished.') };
      }
      default:
        return { ok: false, text: `unknown command ${(cmd as { op: string }).op}` };
    }
  }

  /** Commands run one at a time; status answers right away. */
  return (cmd: BridgeCmd): Promise<BridgeResult> => {
    if (cmd.op === 'status') return run(cmd);
    const p = lock.then(async () => {
      const r = await run(cmd);
      activeAfter = await activeTab();
      return r;
    }).catch(e => ({ ok: false, text: `bridge error: ${(e as Error).message ?? e}` }));
    lock = p;
    return p;
  };
}

// ---------- pairing token (see bridge/fcu.mjs for the protocol) ----------
// The hub and the sidebar share a token the user pastes into Settings. Its UTF-8 text is an HMAC-SHA256 key: each
// request carries a fresh MAC (the token itself is never sent, so a process squatting the port learns nothing), and the
// sidebar runs only commands whose sig proves the hub has the token.

const enc = new TextEncoder();
const toHex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
const fromHex = (s: string) => (/^[0-9a-f]{64}$/.test(s) ? new Uint8Array(s.match(/../g)!.map(h => parseInt(h, 16))) : null);
const nonce = () => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export function bridgeKey(token: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(token.trim()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** `authorization` value for one request: "FCU <ms>.<nonce>.<hex mac>". */
export async function bridgeAuth(key: CryptoKey, path: string, body: string): Promise<string> {
  const ts = Date.now();
  const n = nonce();
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`fcu-req\n${ts}\n${n}\n${path}\n${body}`));
  return `FCU ${ts}.${n}.${toHex(mac)}`;
}

/** The command in a /poll reply, or null when its sig is not the hub's (wrong token, or not our hub). The sig covers
 *  "<id>\n<session>\n<cmd JSON text>" exactly as received, and is checked before the text is parsed. */
export async function openBridgeCmd(key: CryptoKey, session: string, msg: unknown): Promise<{ id: string; cmd: BridgeCmd } | null> {
  const { id, cmd, sig } = (msg ?? {}) as Record<string, unknown>;
  if (typeof id !== 'string' || typeof cmd !== 'string' || typeof sig !== 'string') return null;
  const bytes = fromHex(sig);
  if (!bytes || !(await crypto.subtle.verify('HMAC', key, bytes, enc.encode(`${id}\n${session}\n${cmd}`)))) return null;
  try {
    const parsed = JSON.parse(cmd);
    return parsed && typeof parsed === 'object' && typeof parsed.op === 'string' ? { id, cmd: parsed } : null;
  } catch {
    return null;
  }
}

/**
 * Polls the hub until stopped. Calls `onState` when the connection comes or goes, and `onIssue` (once per kind) when
 * the hub refuses the token or sends a command that is not signed with it. Without a hub (no agent running) it retries
 * every 2 s: a refused loopback connection costs nothing.
 */
export function startBridge(
  url: string,
  token: string,
  handle: (cmd: BridgeCmd) => Promise<BridgeResult>,
  onState: (up: boolean) => void,
  onIssue: (text: string) => void = () => {},
): () => void {
  const base = url.replace(/\/+$/, '');
  const session = crypto.randomUUID();
  let stopped = false;
  let up = false;
  const ctrl = new AbortController();
  const set = (v: boolean) => {
    if (v !== up) onState((up = v));
  };
  const told = new Set<string>();
  const issue = (kind: string, text: string) => {
    if (!told.has(kind)) told.add(kind), onIssue(text);
  };
  const ran = new Set<string>(); // command ids already run: a replayed command is dropped
  const keyP = bridgeKey(token);
  const post = async (path: string, payload: unknown, signal?: AbortSignal) => {
    const body = JSON.stringify(payload);
    const headers = { 'x-fcu': '1', 'content-type': 'application/json', authorization: await bridgeAuth(await keyP, path, body) };
    return fetch(`${base}${path}`, { method: 'POST', headers, body, signal });
  };
  (async () => {
    while (!stopped) {
      try {
        const r = await post('/poll', { session }, ctrl.signal);
        if (r.status === 403) issue('403', `Agent bridge: the hub at ${base} refused the pairing token. Run \`node bridge/fcu.mjs token\` and paste it in Settings.`);
        if (r.status !== 200 && r.status !== 204) throw new Error(`HTTP ${r.status}`);
        set(true);
        if (r.status === 204) continue;
        const job = await openBridgeCmd(await keyP, session, await r.json());
        if (!job || ran.has(job.id)) {
          issue('sig', `Agent bridge: ignored a command from ${base} that was not signed with the pairing token (not your fcu hub, or a different token).`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        ran.add(job.id);
        void handle(job.cmd).then(result => post('/result', { id: job.id, session, result }).catch(() => {}));
      } catch {
        set(false);
        if (!stopped) await new Promise(r => setTimeout(r, 2000));
      }
    }
  })();
  return () => {
    stopped = true;
    ctrl.abort();
    set(false);
  };
}
