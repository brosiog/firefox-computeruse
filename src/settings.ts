export type ProviderKind = 'ollama' | 'openai' | 'chatgpt';
/** every: each action that changes the page or tabs asks; ask: submits, sends, deletes, payments and passwords ask;
 *  auto: only payments and passwords ask; off: nothing asks, the agent runs on its own. */
export type ApprovalMode = 'every' | 'ask' | 'auto' | 'off';
export type Structured = 'auto' | 'schema' | 'json' | 'off';
export type Effort = 'default' | 'none' | 'low' | 'medium' | 'high' | 'xhigh';

export interface Settings {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Context window the server should allocate (Ollama num_ctx) and the budget compaction works to. */
  contextWindow: number;
  maxOutput: number;
  temperature: number;
  maxSteps: number;
  /** Characters of page state per step. ~3.5 chars per token. */
  pageBudget: number;
  approval: ApprovalMode;
  vision: boolean;
  /** Attach a screenshot with every step (vision models only). */
  screenshotEachStep: boolean;
  /** Ask the model for a one-sentence `think` before each action. */
  reasoning: boolean;
  /** The model's own thinking. `none` is much faster for browsing steps; `default` sends nothing. Splash, vLLM and
   *  OpenAI take `reasoning_effort`; Ollama and llama.cpp get an on/off switch. */
  effort: Effort;
  structured: Structured;
  keepAlive: string;
  /** extend: append-only history (works with every prompt cache, incl. Splash); compact: smallest context. */
  history: 'extend' | 'compact';
  /** Tokens of history (extend mode) before old page states are dropped. */
  historyBudget: number;
  /** Agent bridge hub (bridge/fcu.mjs) the sidebar connects to, so coding agents can use the browser. Empty: off. */
  bridgeUrl: string;
  /** Opt-in: the agent may sign in with Bitwarden logins (through `bw serve`), without ever seeing them. */
  vault: boolean;
  /** The Bitwarden CLI's local API (`bw serve`). */
  vaultUrl: string;
  /** Ask in the sidebar before each fill (on by default; the site check applies either way). */
  vaultAsk: boolean;
  /** Coding agents on the bridge (and tasks they delegate) may use Bitwarden logins too. Off by default. */
  vaultAgents: boolean;
  /** Opt-in: the agent gets a web_search tool (Parallel's keyless Search MCP). The search words leave the browser. */
  webSearch: boolean;
  /** Benchmarks only: replaces the built-in system prompt. Not shown in the UI. */
  systemOverride?: string;
}

export interface Preset {
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  hint: string;
  model?: string;
  contextWindow?: number;
  history?: 'extend' | 'compact';
}

export const PRESETS: Record<string, Preset> = {
  chatgpt: {
    label: 'ChatGPT plan (Sign in with ChatGPT)',
    kind: 'chatgpt',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 128000,
    history: 'extend',
    hint: 'Uses your ChatGPT subscription. Sign in below, then pick a model.',
  },
  ollama: { label: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', hint: 'ollama serve' },
  lmstudio: { label: 'LM Studio', kind: 'openai', baseUrl: 'http://localhost:1234/v1', hint: 'Developer → Start server' },
  llamacpp: { label: 'llama.cpp server', kind: 'openai', baseUrl: 'http://localhost:8080/v1', hint: 'llama-server -m model.gguf -c 16384 --jinja' },
  mlx: { label: 'MLX (mlx_lm.server)', kind: 'openai', baseUrl: 'http://localhost:8080/v1', hint: 'mlx_lm.server --model <repo>' },
  openai: { label: 'OpenAI-compatible (other)', kind: 'openai', baseUrl: 'http://localhost:8000/v1', contextWindow: 131072, hint: 'vLLM, OpenRouter, …' },
};

export const DEFAULTS: Settings = {
  kind: 'openai',
  // Neutral local default (LM Studio's port). No model is preselected: pick one from the server's list in Settings.
  baseUrl: 'http://localhost:1234/v1',
  model: '',
  apiKey: '',
  contextWindow: 131072,
  maxOutput: 400,
  temperature: 0.2,
  maxSteps: 40,
  pageBudget: 5000,
  approval: 'ask',
  vision: false,
  screenshotEachStep: false,
  reasoning: true,
  effort: 'none',
  structured: 'auto',
  keepAlive: '30m',
  history: 'extend',
  historyBudget: 16000,
  bridgeUrl: 'http://127.0.0.1:47823',
  vault: false,
  vaultUrl: 'http://localhost:8087',
  vaultAsk: true,
  vaultAgents: false,
  webSearch: false,
};

declare const browser: any;

export async function loadSettings(): Promise<Settings> {
  try {
    const { settings } = await browser.storage.local.get('settings');
    return { ...DEFAULTS, ...(settings ?? {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await browser.storage.local.set({ settings: s });
}
