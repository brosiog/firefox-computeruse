import { runAgent, type AgentEvent } from '../../src/agent/loop';
import type { Action } from '../../src/agent/tools';
import { createHost } from '../../src/browser/host';
import { chat, listModels, modelInfo, prewarm, type Usage } from '../../src/llm/client';
import { primer, systemPrompt } from '../../src/agent/prompt';
import type { Gate } from '../../src/protocol';
import { createBridgeHandler, startBridge } from '../../src/bridge';
import { askBackground, type ChatGptStatus } from '../../src/llm/chatgpt-auth';
import { DEFAULTS, PRESETS, loadSettings, saveSettings, type Settings } from '../../src/settings';
import { createVault, type Vault } from '../../src/vault';

declare const browser: any;

// Bitwarden: one client per URL. `agents`: for coding agents on the bridge (and tasks they delegate), which also
// need their own opt-in.
let vaultClient: { url: string; v: Vault } | null = null;
function vaultFor(agents: boolean): Vault | null {
  if (!settings.vault || !settings.vaultUrl.trim() || (agents && !settings.vaultAgents)) return null;
  const url = settings.vaultUrl.trim();
  if (vaultClient?.url !== url) vaultClient = { url, v: createVault(url) };
  return vaultClient.v;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const log = $('log');
const input = $<HTMLTextAreaElement>('input');
const go = $<HTMLButtonElement>('go');
const statusBtn = $<HTMLButtonElement>('status');

let settings: Settings = { ...DEFAULTS };
let running: AbortController | null = null;
let pendingAsk: ((v: string | null) => void) | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function add(node: HTMLElement) {
  $('empty')?.remove();
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  log.appendChild(node);
  if (stick) log.scrollTop = log.scrollHeight;
}

const k = (n?: number) => (n === undefined ? '?' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function stats(u: Usage, mode: string, est: number): string {
  const parts: string[] = [];
  const prompt = u.promptTokens ?? est;
  if (u.cachedTokens !== undefined && u.promptTokens) {
    parts.push(`prompt ${k(prompt)} (${Math.round((u.cachedTokens / Math.max(1, u.promptTokens)) * 100)}% cached)`);
  } else parts.push(`prompt ${k(prompt)}${u.promptTokens === undefined ? '~' : ''}`);
  if (u.outputTokens !== undefined) parts.push(`out ${u.outputTokens}`);
  if (u.outputTokens && u.genMs) parts.push(`${Math.round(u.outputTokens / (u.genMs / 1000))} tok/s`);
  if (u.promptMs !== undefined) parts.push(`prefill ${(u.promptMs / 1000).toFixed(2)}s`);
  parts.push(`${(u.totalMs / 1000).toFixed(1)}s`);
  if (u.loadMs && u.loadMs > 1000) parts.push(`load ${(u.loadMs / 1000).toFixed(1)}s`);
  if (mode !== 'schema') parts.push(`output: ${mode}`);
  return parts.join(' · ');
}

function describeAction(a: Action): string {
  const bits: string[] = [a.tool];
  if (a.ref) bits.push(`[${a.ref}]`);
  if (a.text !== undefined) bits.push(JSON.stringify(a.text.length > 60 ? a.text.slice(0, 57) + '…' : a.text));
  if (a.option) bits.push(JSON.stringify(a.option));
  if (a.url) bits.push(a.url);
  if (a.key) bits.push(a.key);
  if (a.dir) bits.push(a.dir);
  if (a.query) bits.push(`query=${JSON.stringify(a.query)}`);
  if (a.tab !== undefined) bits.push(`#${a.tab}`);
  if (a.enter) bits.push('⏎');
  return bits.join(' ');
}

// ---------- run ----------

let cur: { root: HTMLElement; think: HTMLElement; act: HTMLElement; res: HTMLElement; st: HTMLElement } | null = null;

function onEvent(e: AgentEvent) {
  switch (e.type) {
    case 'trace':
      if (e2eUrl) e2eTraces.push(e.step);
      break;
    case 'step': {
      const root = el('div', 'step');
      const think = el('div', 'think');
      const act = el('div', 'act');
      const res = el('div', 'res');
      const st = el('div', 'stats');
      root.append(think, act, res, st);
      cur = { root, think, act, res, st };
      add(root);
      break;
    }
    case 'thinking':
      if (cur) cur.think.textContent = e.text;
      break;
    case 'slow':
      if (cur && !cur.think.textContent) cur.think.textContent = 'waiting for the model (it may be loading into memory)…';
      break;
    case 'action':
      if (!cur) break;
      cur.think.textContent = e.action.think ?? '';
      if (!e.action.think) cur.think.remove();
      cur.act.innerHTML = '';
      cur.act.append(el('span', 'chip', describeAction(e.action)));
      cur.st.textContent = stats(e.usage, e.mode, e.promptTokensEst);
      if (e.action.tool === 'done') cur.root.remove();
      break;
    case 'result':
      if (cur) {
        cur.res.className = `res ${e.ok ? 'ok' : 'err'}`;
        cur.res.textContent = e.text;
      }
      break;
    case 'parse-error':
      if (cur) {
        cur.res.className = 'res err';
        cur.res.textContent = `unusable reply: ${e.error}\n${e.raw.slice(0, 200)}`;
      }
      break;
    case 'compacted':
      add(el('div', 'note', 'older steps were summarized to fit the context window'));
      break;
    case 'error':
      add(el('div', 'note err', e.text));
      break;
    case 'done': {
      const f = el('div', `final${e.success ? '' : ' fail'}`, e.answer || (e.success ? 'Done.' : 'Not finished.'));
      f.append(el('div', 'meta', `${e.steps} steps · ${(e.ms / 1000).toFixed(1)}s`));
      add(f);
      break;
    }
  }
}

const e2eParams = new URLSearchParams(location.search);
const e2eUrl = e2eParams.get('e2e');
let e2eApprovals = 0;
let e2eDeclines = 0;
let e2eSecurityDeclines = 0;
const e2eTraces: unknown[] = [];

function approve(gate: Gate, a: Action): Promise<boolean> {
  return new Promise(resolve => {
    if (e2eUrl) {
      // Test build: answer automatically (the job says how), counting it so the test can check the gate fired.
      // A careful user declines what the security gates flag; everything else follows the job's setting.
      if (gate.risk === 'exfil' || gate.risk === 'suspicious') {
        e2eSecurityDeclines++;
        setTimeout(() => resolve(false), 100);
        return;
      }
      const yes = e2eParams.get('approve') !== 'no';
      if (yes) e2eApprovals++;
      else e2eDeclines++;
      setTimeout(() => resolve(yes), 100);
      return;
    }
    const card = el('div', 'card');
    const label: Record<string, string> = {
      write: 'The agent wants to submit or send something',
      delete: 'The agent wants to delete something',
      pay: 'The agent wants to make a payment or purchase',
      secret: 'The agent wants to type into a password or payment field',
      exfil: 'The agent wants to send a form to a different website',
      suspicious: 'The agent wants to act on page text that addresses AI agents (possible prompt injection)',
      login: 'The agent wants to sign in with your Bitwarden login',
    };
    card.append(el('strong', '', label[gate.risk] ?? 'Approval needed'), el('div', 'hint', gate.what));
    if (gate.warn) card.append(el('div', 'warn', gate.warn));
    if (a.text && gate.risk !== 'secret') card.append(el('div', 'hint', `text: ${a.text.slice(0, 200)}`));
    const row = el('div', 'row');
    const yes = el('button', 'primary', 'Allow once');
    const no = el('button', '', 'Decline');
    row.append(yes, no);
    card.append(row);
    add(card);
    const done = (v: boolean) => {
      row.remove();
      card.append(el('div', 'hint', v ? 'allowed' : 'declined'));
      resolve(v);
    };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    running?.signal.addEventListener('abort', () => done(false), { once: true });
    // e2e:bridge build only (compiled out of dist/): the card is shown as usual, and the fixture server answers it, as
    // a person would.
    const bridgeTest = import.meta.env.WXT_BRIDGE_TEST as string | undefined;
    if (bridgeTest) {
      fetch(`${bridgeTest}/e2e/approve?risk=${gate.risk}&what=${encodeURIComponent(gate.what)}`)
        .then(r => r.text())
        .then(t => row.isConnected && done(t === 'yes'), () => row.isConnected && done(false));
    }
  });
}

let e2eAsks = 0;
function ask(q: string): Promise<string | null> {
  return new Promise(resolve => {
    if (e2eUrl) {
      // Test build: the user only repeats the task (the bench measures what the agent does on its own).
      e2eAsks++;
      setTimeout(() => resolve('Please continue with the task as I gave it.'), 100);
      return;
    }
    const card = el('div', 'card');
    card.append(el('strong', '', 'The agent asks'), el('div', '', q), el('div', 'hint', 'Answer in the box below.'));
    add(card);
    input.placeholder = 'Your answer…';
    input.focus();
    pendingAsk = v => {
      pendingAsk = null;
      input.placeholder = 'What should I do?';
      resolve(v);
    };
    running?.signal.addEventListener('abort', () => pendingAsk?.(null), { once: true });
  });
}

async function targetTab(): Promise<{ tabId: number; windowId: number }> {
  const params = new URLSearchParams(location.search);
  // Test hook: a sidebar page opened as a tab (e2e) drives the first tab whose URL starts with `tabUrl`.
  if (params.get('tabUrl')) {
    const all = await browser.tabs.query({});
    const t = all.find((x: any) => x.url?.startsWith(params.get('tabUrl')!));
    if (t) return { tabId: t.id, windowId: t.windowId };
  }
  if (params.get('tab')) {
    const t = await browser.tabs.get(Number(params.get('tab')));
    return { tabId: t.id, windowId: t.windowId };
  }
  const win = await browser.windows.getCurrent();
  const [t] = await browser.tabs.query({ active: true, windowId: win.id });
  return { tabId: t.id, windowId: win.id };
}

// Prewarm when the panel opens and when the user starts typing (at most once every 2 minutes): the model is loaded
// and the prompt's opening is cached before the first step needs it.
let warmedAt = 0;
let warming: Promise<number> | null = null;
function warm(): Promise<number> {
  if (!settings.model || Date.now() - warmedAt < 120000) return warming ?? Promise.resolve(0);
  warmedAt = Date.now();
  const sys = settings.systemOverride || systemPrompt({ vision: settings.vision, reasoning: settings.reasoning, login: !!vaultFor(false) });
  warming = prewarm(settings, primer(sys));
  return warming;
}
input.addEventListener('input', () => void warm());

/** Runs the built-in agent. `fromAgent`: a coding agent delegated the task over the bridge; questions go back to it. */
async function start(task: string, fromAgent?: { maxSteps?: number }): Promise<{ success: boolean; answer: string } | null> {
  if (running) return null;
  if (!settings.model) {
    if (fromAgent) return { success: false, answer: 'No model is configured in the Firefox Computer Use settings.' };
    openSettings();
    return null;
  }
  add(el('div', 'msg user', fromAgent ? `agent: ${task}` : task));
  const ctrl = (running = new AbortController());
  go.textContent = 'Stop';
  go.classList.add('stop');
  let question: string | null = null;
  const agentAsk = async (q: string) => {
    question = q;
    ctrl.abort();
    return null;
  };
  const s = fromAgent?.maxSteps ? { ...settings, maxSteps: fromAgent.maxSteps } : settings;
  try {
    const { tabId, windowId } = await targetTab();
    const host = createHost(tabId, windowId);
    let r = await runAgent({ task, settings: s, host, ui: { event: onEvent, approve, ask: fromAgent ? agentAsk : ask }, signal: ctrl.signal, vault: vaultFor(!!fromAgent) });
    if (question) r = { success: false, answer: `The agent needs more information: ${question}` };
    (window as any).__lastResult = r;
    if (e2eUrl) {
      await fetch(`${e2eUrl}/e2e/report`, {
        method: 'POST',
        body: JSON.stringify({
          job: e2eParams.get('job'),
          result: r,
          approvals: e2eApprovals,
          declines: e2eDeclines,
          securityDeclines: e2eSecurityDeclines,
          asks: e2eAsks,
          transcript: log.innerText,
          traces: e2eTraces,
        }),
      });
      await browser.runtime.sendMessage({ type: 'e2e-done', job: e2eParams.get('job') });
    }
    return r;
  } catch (e) {
    onEvent({ type: 'error', text: `agent crashed: ${(e as Error).message ?? e}` });
    return { success: false, answer: `The agent crashed: ${(e as Error).message ?? e}` };
  } finally {
    running = null;
    go.textContent = 'Run';
    go.classList.remove('stop');
    (window as any).__runDone = true;
  }
}

$('composer').addEventListener('submit', ev => {
  ev.preventDefault();
  const v = input.value.trim();
  if (pendingAsk) {
    if (!v) return;
    add(el('div', 'msg user', v));
    input.value = '';
    pendingAsk(v);
    return;
  }
  if (running) {
    running.abort();
    return;
  }
  if (!v) return;
  input.value = '';
  void start(v);
});
input.addEventListener('keydown', ev => {
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    $<HTMLFormElement>('composer').requestSubmit();
  }
});
$('new').onclick = () => {
  if (running) return;
  log.innerHTML = '';
  input.focus();
};

// ---------- settings ----------

const dlg = $<HTMLDialogElement>('settings');
const form = $<HTMLFormElement>('sform');
const presetSel = $<HTMLSelectElement>('preset');
presetSel.append(new Option('Custom', ''));
for (const [id, p] of Object.entries(PRESETS)) presetSel.append(new Option(p.label, id));

function fill(s: Settings) {
  for (const [key, val] of Object.entries(s)) {
    const f = form.elements.namedItem(key) as HTMLInputElement | HTMLSelectElement | null;
    if (!f) continue;
    if ((f as HTMLInputElement).type === 'checkbox') (f as HTMLInputElement).checked = !!val;
    else f.value = String(val);
  }
  const match = Object.entries(PRESETS).find(([, p]) => p.baseUrl === s.baseUrl && p.kind === s.kind);
  presetSel.value = match?.[0] ?? '';
  $('presetHint').textContent = match?.[1].hint ?? '';
  syncKind();
}

// ChatGPT plan: sign-in box instead of a server URL and key.
const kindSel = form.elements.namedItem('kind') as HTMLSelectElement;
function syncKind() {
  const gpt = kindSel.value === 'chatgpt';
  $('chatgptBox').hidden = !gpt;
  $('baseUrlRow').hidden = gpt;
  $('apiKeyRow').hidden = gpt;
  if (gpt) {
    (form.elements.namedItem('baseUrl') as HTMLInputElement).value = PRESETS.chatgpt.baseUrl;
    void showChatGpt();
  }
}
kindSel.addEventListener('change', syncKind);

function renderChatGpt(st: ChatGptStatus) {
  $('chatgptStatus').textContent = st.signedIn ? `Signed in${st.email ? ` as ${st.email}` : ''}` : 'Not signed in';
  $('chatgptSignIn').hidden = st.signedIn;
  $('chatgptSignOut').hidden = !st.signedIn;
}
async function showChatGpt() {
  try {
    renderChatGpt(await askBackground<ChatGptStatus>({ type: 'chatgpt-status' }));
  } catch (e) {
    $('chatgptStatus').textContent = (e as Error).message;
  }
}
$('chatgptSignIn').onclick = async () => {
  $('chatgptStatus').textContent = 'finish signing in in the new tab…';
  try {
    renderChatGpt(await askBackground<ChatGptStatus>({ type: 'chatgpt-signin' }));
    // Offer the account's models right away; the first listed one is a sensible default.
    $<HTMLButtonElement>('fetchModels').click();
  } catch (e) {
    $('chatgptStatus').textContent = (e as Error).message;
  }
};
$('chatgptSignOut').onclick = async () => {
  try {
    const { revoked } = await askBackground<{ revoked: boolean }>({ type: 'chatgpt-signout' });
    renderChatGpt({ signedIn: false });
    if (!revoked) $('chatgptStatus').textContent = 'Signed out here; OpenAI did not confirm the revocation. You can disconnect the app in ChatGPT Settings.';
  } catch (e) {
    $('chatgptStatus').textContent = (e as Error).message;
  }
};

function read(): Settings {
  const s: any = { ...settings };
  for (const key of Object.keys(DEFAULTS)) {
    const f = form.elements.namedItem(key) as HTMLInputElement | null;
    if (!f) continue;
    const def = (DEFAULTS as any)[key];
    if (typeof def === 'boolean') s[key] = f.checked;
    else if (typeof def === 'number') s[key] = Number(f.value) || def;
    else s[key] = f.value.trim();
  }
  return s;
}

presetSel.onchange = () => {
  const p = PRESETS[presetSel.value];
  if (!p) return;
  const s = read();
  // A model name from another provider means nothing here.
  if (!p.model && p.kind !== s.kind) s.model = '';
  s.kind = p.kind;
  s.baseUrl = p.baseUrl;
  if (p.model) s.model = p.model;
  if (p.contextWindow) s.contextWindow = p.contextWindow;
  if (p.history) s.history = p.history;
  fill(s);
};

$('fetchModels').onclick = async () => {
  const out = $('testOut');
  try {
    const names = await listModels(read());
    const dl = $('models');
    dl.innerHTML = '';
    for (const n of names) dl.append(new Option(n, n));
    out.textContent = `${names.length} models`;
    const m = form.elements.namedItem('model') as HTMLInputElement;
    if (!m.value && names[0]) m.value = names[0];
  } catch (e) {
    out.textContent = (e as Error).message;
  }
};

$('test').onclick = async () => {
  const out = $('testOut');
  out.textContent = 'testing…';
  const s = read();
  const t0 = performance.now();
  try {
    const r = await chat(
      { ...s, maxOutput: 30 },
      [{ role: 'user', content: 'Reply with this JSON exactly: {"tool":"done","answer":"ok"}' }],
      { type: 'object', properties: { tool: { type: 'string' }, answer: { type: 'string' } }, required: ['tool', 'answer'] },
      AbortSignal.timeout(120000),
    );
    const info = await modelInfo(s);
    out.textContent = `ok in ${((performance.now() - t0) / 1000).toFixed(1)}s (${r.mode}) → ${r.text.slice(0, 50)}${info.contextLength ? ` · ctx ${info.contextLength}` : ''}`;
  } catch (e) {
    out.textContent = (e as Error).message;
  }
};

// The master password goes to bw serve on this computer only: never stored, never in settings, never logged.
const vaultOut = $('vaultOut');
const vaultPw = $<HTMLInputElement>('vaultPw');
const vaultNow = () => createVault(read().vaultUrl.trim() || DEFAULTS.vaultUrl);
const STATE_TEXT: Record<string, [string, string]> = {
  unlocked: ['Unlocked: the agent can sign in with your logins', 'ok'],
  locked: ['Locked: enter your master password and press Unlock, or run bw unlock before bw serve', 'warn'],
  unauthenticated: ['Not logged in: run bw login on this computer first', 'bad'],
};
async function showVault(p: Promise<{ state: string; email?: string; error?: string }>) {
  const dot = $('vaultDot');
  vaultOut.textContent = 'Checking…';
  dot.className = 'dot';
  const st = await p;
  const [text, cls] = st.state === 'unreachable' ? [st.error ?? 'bw serve is not reachable', 'bad'] : (STATE_TEXT[st.state] ?? [st.state, '']);
  vaultOut.textContent = `${text}${st.email ? ` · ${st.email}` : ''}${st.error && st.state !== 'unreachable' ? ` (${st.error})` : ''}`;
  dot.className = `dot ${cls}`;
}
$('vaultCheck').onclick = () => void showVault(vaultNow().status());
$('vaultUnlock').onclick = () => {
  const pw = vaultPw.value;
  vaultPw.value = '';
  if (!pw) return void showVault(vaultNow().status());
  void showVault(vaultNow().unlock(pw));
};
vaultPw.addEventListener('keydown', ev => {
  if (ev.key !== 'Enter') return;
  ev.preventDefault();
  $('vaultUnlock').click();
});
$('vaultLock').onclick = () => {
  const v = vaultNow();
  void showVault(v.lock().then(() => v.status(), e => ({ state: 'unreachable', error: (e as Error).message })));
};

function openSettings() {
  fill(settings);
  $('testOut').textContent = '';
  vaultOut.textContent = settings.vault ? 'Checking…' : 'Off';
  $('vaultDot').className = 'dot';
  vaultPw.value = '';
  dlg.showModal();
  if (settings.vault) void showVault(vaultNow().status());
}
$('gear').onclick = openSettings;
statusBtn.onclick = openSettings;

dlg.addEventListener('close', async () => {
  vaultPw.value = '';
  if (dlg.returnValue !== 'save') return;
  settings = read();
  await saveSettings(settings);
  void refreshStatus();
  connectBridge();
});

// ---------- agent bridge ----------

const bridgeHandle = createBridgeHandler({
  settings: () => settings,
  target: targetTab,
  approve,
  busy: () => !!running,
  runTask: (task, maxSteps) => start(task, { maxSteps }),
  vault: () => vaultFor(true),
  note: (text, ok) => add(el('div', `note${ok ? '' : ' err'}`, text)),
});
let bridge: { url: string; stop: () => void } | null = null;
function connectBridge() {
  // e2e:bridge builds: Firefox also opens the real sidebar at install; only the panel tab under test may take agent
  // commands, or the hub would split them between two panels.
  const testSidebar = !!import.meta.env.WXT_BRIDGE_TEST && !new URLSearchParams(location.search).get('tabUrl');
  const url = e2eUrl || testSidebar ? '' : settings.bridgeUrl.trim();
  if (bridge?.url === url) return;
  bridge?.stop();
  bridge = url ? { url, stop: startBridge(url, bridgeHandle, up => ($('agents').hidden = !up)) } : null;
}

async function refreshStatus() {
  statusBtn.textContent = settings.model || 'no model';
  statusBtn.className = 'pill';
  if (settings.kind === 'chatgpt') {
    try {
      const st = await askBackground<ChatGptStatus>({ type: 'chatgpt-status' });
      statusBtn.classList.add(st.signedIn ? 'ok' : 'bad');
      statusBtn.title = st.signedIn ? `ChatGPT plan${st.email ? ` (${st.email})` : ''}` : 'Not signed in to ChatGPT: open Settings';
    } catch {
      statusBtn.classList.add('bad');
    }
    return;
  }
  try {
    const base = settings.baseUrl.replace(/\/+$/, '');
    const url = settings.kind === 'ollama' ? `${base}/api/tags` : `${base}/models`;
    const r = await fetch(url, { headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}, signal: AbortSignal.timeout(4000) });
    statusBtn.classList.add(r.ok ? 'ok' : 'bad');
    statusBtn.title = r.ok ? `${settings.baseUrl} reachable` : `${settings.baseUrl}: HTTP ${r.status}`;
  } catch {
    statusBtn.classList.add('bad');
    statusBtn.title = `${settings.baseUrl} unreachable`;
  }
}

async function checkPermission() {
  const ok = await browser.permissions.contains({ origins: ['<all_urls>'] });
  $('perm').hidden = ok;
}
$('grant').onclick = async () => {
  await browser.permissions.request({ origins: ['<all_urls>'] });
  void checkPermission();
};

(async () => {
  settings = await loadSettings();
  void refreshStatus();
  connectBridge();
  void checkPermission();
  if (e2eUrl) {
    // Test build: record what this page can reach before the run.
    const probes: string[] = [];
    probes.push(`perm <all_urls>: ${await browser.permissions.contains({ origins: ['<all_urls>'] })}`);
    probes.push(`perm model: ${await browser.permissions.contains({ origins: [new URL(settings.baseUrl).origin + '/*'] })}`);
    for (const [m, body] of [['GET', undefined], ['POST', '{}']] as const) {
      try {
        const r = await fetch(settings.baseUrl.replace(/\/+$/, '') + (m === 'GET' ? '/models' : '/chat/completions'), { method: m, body, headers: body ? { 'Content-Type': 'application/json' } : {} });
        probes.push(`${m} → ${r.status}`);
      } catch (e) {
        probes.push(`${m} → ${(e as Error).message}`);
      }
    }
    add(el('div', 'note', probes.join(' | ')));
  }
  const task = new URLSearchParams(location.search).get('task');
  // Bench runs stand in for "the user typed the task": the prewarm finishes first, as it would while typing.
  if (task && e2eUrl) {
    const ms = await warm();
    add(el('div', 'note', `prewarm ${Math.round(ms)}ms`));
  } else void warm();
  if (task) void start(task);
  else input.focus();
})();
