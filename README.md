<img src="assets/icon.svg" width="64" height="64" alt="">

# firefox-computeruse

A Firefox web agent built for **local models under 50B parameters**, running on macOS. It is a port and redesign of
[Nanobrowser](https://github.com/nanobrowser/nanobrowser): the agent lives in the Firefox sidebar and drives the
current tab. The default configuration targets the Splash server on the LAN Mac (`qwen3.8-27b-splash`). Any
OpenAI-compatible endpoint works, as does Ollama's native API.

The whole extension is about 83 kB: no framework, no AI SDK, no runtime dependencies.

## Install (Firefox 128+)

```sh
pnpm install
pnpm build          # → dist/
```

- **Try it:** open `about:debugging#/runtime/this-firefox`, click *Load Temporary Add-on*, and pick `dist/manifest.json`.
  A temporary add-on lasts until Firefox restarts.
- **Keep it installed:** use Firefox Developer Edition or Nightly with `xpinstall.signatures.required = false`, then install the
  zip from `pnpm zip`. Alternatively, sign it as an unlisted add-on on AMO (`web-ext sign`).

Toggle the sidebar with the toolbar button or **Ctrl+Shift+A** (Alt+Shift+A on Linux/Windows). If Firefox hasn't granted
website access, the sidebar shows an *Allow on all sites* button.

## Working across tabs

The agent always works in the tab you're on. A **This tab** chip above the task box shows which one, and it follows you
when you switch tabs. To give it more tabs, type **@** in the task box (or click the **@** button) and attach other
open tabs, from any window. Keep
typing to filter by title or address. ↑/↓ and Enter (or a click) pick a tab, and Esc closes the list. Each attached tab
shows as a chip above the box, and × removes it. You can attach up to 6 tabs. For example: *"Is the hub on @shop-a.com
cheaper than this one? Check @reviews.example too."*

When the task starts, the agent reads each attached tab's text once, without switching to it, and gets it along with
the task. So it can compare, collect or cross-check across tabs from its first step, and it uses `tab_switch` to act in
one of them. Notes:

- The text comes from the same reader as the `read` tool, without refs (refs belong to the page in front of the agent).
  It is fenced and marked as page data like every other page text.
- Links on an attached tab count as seen for navigation provenance.
- The text sits in the fixed opening of every request, so it is prefilled once per run, not on every step, and it does
  not count against the history budget.
- The budget is shared across tabs: about four page budgets in total (20k characters by default), at most two per tab,
  and less on small context windows.
- Tabs Firefox has unloaded are reloaded first. Pages extensions cannot read (`about:`, AMO) are left out of the list.


| Preset | API | Notes |
| --- | --- | --- |
| **Splash (default)** | OpenAI-compatible, `http://192.168.86.202:8000/v1`, `qwen3.8-27b-splash`, 64K | Sends `reasoning_effort` (default `none`). The first request after idle release reloads the model (~30 s); the panel says so. |
| LM Studio | `http://localhost:1234/v1` | |
| llama.cpp | `http://localhost:8080/v1` | Use `--jinja`; `cache_prompt` is sent. |
| MLX (`mlx_lm.server`) | `http://localhost:8080/v1` | |
| Ollama | native `/api/chat`, `http://localhost:11434` | Sends `num_ctx`, `keep_alive` and `think`. No `OLLAMA_ORIGINS` setup needed (see below). |
| Other | any `/v1/chat/completions` | Optional API key; models are listed from `/models`. |
| **ChatGPT plan** | Responses API, `https://api.openai.com/v1` | *Continue with ChatGPT* in Settings; runs on your ChatGPT subscription. See below. |

The client tries optional features and drops each one the server rejects, remembering the result per server and model:

- JSON-schema output, falling back to JSON mode, then plain text with tolerant parsing.
- `reasoning_effort` and `chat_template_kwargs`.
- `cache_prompt` and `stream_options`.
- If schema-constrained decoding degenerates into a whitespace loop (seen with Qwen3.8 on Splash when the prompt is weak),
  it aborts the stream and falls back to JSON mode.

Two Firefox issues are fixed for LAN servers:

- Firefox's default MV3 extension CSP includes `upgrade-insecure-requests`, which silently rewrites
  `http://192.168.x.x` to `https://` and breaks every plain-HTTP server that isn't on localhost. The manifest overrides it.
- Ollama rejects `moz-extension://` origins. The background page removes the `Origin` header, but only on the
  extension's own requests to the configured model server.

## ChatGPT plan (Sign in with ChatGPT)

Pick **ChatGPT plan** in Settings and choose *Continue with ChatGPT*. A tab opens on OpenAI's sign-in. After you
approve, the extension lists the models your plan offers and the agent runs on your ChatGPT subscription. This is
OpenAI's [open-source token-sharing flow](https://developers.openai.com/siwc/token-sharing-open-source) against the
public Responses API, not ChatGPT's private backend.

- **Redirect.** The flow redirects to `http://127.0.0.1:<port>/auth/callback`. The extension doesn't listen on that
  port. The background page sees the sign-in tab navigate there (`webRequest`), takes the code, cancels the request and
  closes the tab.
- **Checks.** Sign-in uses PKCE, `state` and `nonce`. The ID token's signature is checked against OpenAI's JWKS, along
  with its issuer, audience and expiry. Sign-in fails unless the `chatgpt.tokens.use.direct` scope is granted.
- **Tokens.** Tokens stay in `storage.local` under `chatgptAuth`, separate from settings. They are refreshed in the
  background page only, so several sidebars never race a rotating refresh token. *Sign out* revokes the refresh token.
- **Requests.** Every request sends `store: false` and `stream: true`, and the system prompt goes in `instructions`.
  `temperature` and output caps aren't accepted on this route. Reasoning effort and structured output are still tried
  and dropped when the model rejects them.
- **No prewarm.** There's nothing to load, and the route can't cap a reply at one token.
- **Your data.** Page text, and screenshots when vision is on, go to OpenAI and count against your plan's usage.

**Claude subscriptions.** Anthropic doesn't allow third-party apps to sign in with a Claude.ai account or use its plan
limits. That includes apps built on the Claude Agent SDK, which needs an API key. To use a Claude plan with this
browser, drive it from Claude Code itself through the [agent bridge](#coding-agents-mcp-and-cli). The browser
becomes a tool of Claude Code, which runs under your own login.

## What makes it efficient for small models

- **Cache-friendly history (`extend`, default).** Every request is the previous request plus the new action, its result
  and the new page state. Some prompt caches only match whole earlier prompts. Splash is one: an identical prompt hits,
  but the same system prompt with a different user turn misses. A strict extension hits on every cache type. Past the
  history budget (16k tokens by default), old page states are dropped in one pass, costing one miss, and appending
  resumes. The `compact` mode never keeps old pages. It gives the smallest context and suits longest-common-prefix
  caches (llama.cpp, vLLM).
- **One model call per step, one JSON action.** There is no planner or second model, and the action schema is flat with
  an enum `tool` field, a shape every local constrained decoder handles. An optional one-sentence `think` comes first.
- **Compact page state.** Only what is on or near the screen is listed, as lines like `[12] button "Search"`, plus
  headings, short text and landmarks, within a character budget (5000 by default). Truncation is always stated. `find` and
  `read` reach the rest of the page without scrolling. Refs stay the same for an element across steps, and an open modal
  hides the page behind it.
- **Tolerant parsing.** The parser handles fences, prose, trailing commas, single quotes, truncated JSON, nested
  `args`/`arguments` and about 30 tool-name aliases. Every error goes back to the model as an instruction with an example.
- **Deterministic compaction.** Old results are summarized without calling the model.
- **Chained actions.** Any page action can carry `"then":[…]` to run more actions on the same page in the same step
  (fill a form, then submit). The chain stops at the first error, approval decline or page change, and reports what
  didn't run. Forms went from 11 steps to about 4.
- **Prewarm with an exact-prefix primer.** Every request starts with a fixed `Ready?`/`Ready.` exchange. When the panel
  opens, or the user starts typing, the extension sends just `[system, "Ready?"]`. That loads an idle-released model and
  caches the system prompt even on whole-prompt caches, because the first real step strictly extends it.
- **A short system prompt, kept short by measurement.** It's about 500 tokens, down from about 1,090. Each rule stays
  only if the bench shows it matters:
  - the "use read" rule fixed an aggregation regression;
  - "single quotes inside strings" stopped grammar degeneration;
  - the decline rule replaced a prompt bug.
- **Settle that waits for the page, not for itself.** The agent's own highlight overlay is ignored by the settle
  observer. It used to reset the quiet timer on every action.

Each step shows its stats in the panel: prompt tokens, % cached, output tokens, tok/s, prefill time and total time.

## Browser control on Firefox

Firefox has no `chrome.debugger`/CDP, so this replaces Nanobrowser's whole control layer.

- **Probe.** `src/probe/` is the only code that runs in pages. It is injected into every frame with `scripting.executeScript`.
  - It walks the flat DOM tree, including **closed** shadow roots (Firefox's `openOrClosedShadowRoot`) and slots.
  - It finds controls by role and by `cursor: pointer` (script-driven `div` buttons).
  - It masks password, card and one-time-code values.
  - It skips off-screen subtrees cheaply.
- **Actions** dispatch the full event sequence a person would produce: pointer and mouse events, key events,
  `beforeinput`/`input`/`change`, and the native value setter so React sees changes. Untrusted events don't trigger
  default actions, so the probe performs those itself: implicit form submit on Enter, Tab focus moves, select changes,
  page keys, Space and Enter activation. `target=_blank` links are opened by the extension (the popup blocker would stop
  them otherwise). Every action dispatches at most once.
- **Frames.** Frames are spliced in where their `<iframe>` sits, with short aliases (`[1:4]`), including cross-origin ones.
- **Approvals.** Gating is decided in the page before dispatch:
  - Ask mode (the default) asks before submit, send and delete actions.
  - Payments and passwords ask in both modes.
  - Search forms, consent banners and plain navigation links never ask.
- **Page text is data.** Page text reaches the model inside `<page>…</page>`, and the system prompt says it is data, not
  instructions. See [Prompt-injection defenses](#prompt-injection-defenses).
- **Vision (optional).** For vision models there is a `screenshot` tool that draws refs on the page (set-of-marks),
  downscaled to 1024 px JPEG. Splash reports `vision: true` for Qwen3.8; turn it on in Settings to use it.

## Prompt-injection defenses

A prompt alone does not stop a small model from following instructions written on a web page. So, following the
"constrain actions after untrusted input" design pattern (Beurer-Kellner et al., 2025), the defenses here are
deterministic checks in the probe and the agent loop. None of them costs a model call.

- **Boundary integrity.** Everything the page controls (text, title, tab titles, dialog labels) sits inside `<page>…</page>`.
  Page text that tries to close the fence (`</page>`) is neutralized.
- **Hidden text is dropped.** Text a person can't see never reaches the model: tiny fonts, clipped or off-screen boxes,
  text the same colour as its background, `opacity` near 0, and HTML comments.
- **Injection detector.** Lines written to AI agents ("note for AI assistants", "ignore your previous instructions",
  fake `SYSTEM:` and chat-template tokens, several languages) are marked `⚠`. The page header then says how many there are
  and that they are not from the user. The detector also tests accessible names, so an instruction hidden in an
  `aria-label` is caught.
- **Taint and approval.** Controls that belong to an injected block (its links, an injected dialog's buttons) need the
  user's approval, in every mode. Closing a dialog never does. The taint stays local: it spreads to a container only when
  the injection is nearly all of that container, so a page's own Save or Next button is never caught.
- **Navigation provenance.** The agent can only type a URL that a page offered as a link, that is on the same site, or
  that the user named in the task. A URL carrying data to a third party is blocked with an explanation.
- **Cross-site actions need approval.** A form that submits to another site (`exfil`), and a link inside a frame from
  another site (ads, "sponsored" boxes), ask first. Frames from another site are labelled as such in the page text.
- **Planted answers.** A final answer that repeats a code-like token taken from page text telling the agent what to
  answer is sent back once. A confirmation number the page simply shows is not affected.
- **Declines are not dead ends.** When the user (or the bench) declines one of these requests, the agent is told it came
  from the page and continues the user's task.

Benchmark and results: [bench/README.md](bench/README.md#security-prompt-injection).

## Coding agents (MCP and CLI)

`bridge/fcu.mjs` connects coding agents to the browser. It is one Node file with no dependencies. The sidebar
long-polls it on `127.0.0.1:47823`; set this in *Settings → Agent bridge*, or leave the field empty to turn it off. An
**agents** pill shows in the header while an agent is connected. Agents get three tools:

| Tool | What it does |
| --- | --- |
| `browser_observe` | The current tab as compact text with refs; optionally a screenshot. |
| `browser_act` | One or more actions (same vocabulary as the built-in agent), then the new page state in the same reply. |
| `browser_task` | Hands a whole chore to the extension's local-model agent and returns its answer. It's cheap on the caller's context. |

Actions run with the same probe and approval gates as the built-in agent. Submits, sends, deletes, payments and
passwords wait for **Allow once** in the sidebar, and each agent action is listed in the sidebar log.

```sh
# Claude Code
claude mcp add firefox -- node /path/to/firefox-computeruse/bridge/fcu.mjs
# Codex (~/.codex/config.toml)
[mcp_servers.firefox]
command = "node"
args = ["/path/to/firefox-computeruse/bridge/fcu.mjs"]
# Hermes (~/.hermes/config.yaml)
mcp_servers:
  firefox: { command: node, args: ["/path/to/firefox-computeruse/bridge/fcu.mjs"] }
```

pi has no MCP support. Use the CLI instead: copy `bridge/SKILL.md` into its skills directory, or paste it into
`AGENTS.md`. Any harness that can run shell commands can use the CLI the same way:

```sh
node bridge/fcu.mjs status
node bridge/fcu.mjs observe [--shot page.jpg]
node bridge/fcu.mjs act '[{"tool":"type","ref":"5","text":"usb hub","enter":true}]'
node bridge/fcu.mjs task "find the cheapest USB-C hub here and report its price"
```

Several harnesses can run at once. The first bridge process becomes the hub, and later ones relay through it. If the
hub's process exits, the next call takes over the port. Commands run one at a time. The hub refuses web pages: it
requires an `x-fcu` header (which needs a CORS preflight it never grants), a loopback `Host`, and no foreign `Origin`.

## Development

```sh
pnpm test           # unit tests (vitest + happy-dom): probe, parser, prompt-cache invariants, agent loop
pnpm type-check
pnpm e2e            # real headless Firefox + fixture shop + scripted OpenAI-compatible fake model
pnpm e2e:bridge     # real headless Firefox driven through bridge/fcu.mjs (CLI)
MODEL_URL=http://192.168.86.202:8000/v1 MODEL=qwen3.8-27b-splash pnpm e2e   # same task, real model
```

The e2e task is "find the cheapest USB hub, order 2 for Ada Lovelace, report the order number". It covers:

- a cookie modal
- a search form
- price comparison
- a clickable `div` card
- a quantity `<select>`
- a button rendered late
- a `target=_blank` checkout link
- a **cross-origin payment iframe**
- the payment approval

The e2e needs a Firefox build in `e2e/.cache/firefox` (`scripts/fetch-firefox.sh` downloads the pinned release and
verifies its checksum) or set `FIREFOX=/path/to/firefox`. It builds a separate copy into `.output/e2e` with a test hook
baked in. `dist/` never contains that hook, and `pnpm check:build` fails if it ever does.

### CI

`.github/workflows/ci.yml` runs on every PR and on pushes to `main`. Its two jobs run in parallel:

- **checks**: frozen-lockfile install, `node --check` on every `.mjs`, type-check, unit tests, release build,
  `scripts/check-build.mjs` (manifest, exact permissions, CSP, referenced files, no test hooks or sourcemaps, size
  budget, bridge uses Node built-ins only), Mozilla's add-on linter (`scripts/lint-addon.mjs`: errors and new warnings
  fail), prompt lint, and the packaged zip as a build artifact. `pnpm check` runs the same steps locally.
- **firefox**: pinned Firefox, `pnpm e2e`, `pnpm e2e:bridge`, and the oracle bench over every family and perturbation
  with `--min-pass 1`. Anything below 100% means the extension or harness is broken. The bench report goes to the job
  summary, and on failure the traces are uploaded as an artifact.

Permission, CSP and size-budget changes are deliberate: update the expectation in `scripts/check-build.mjs` in the
same PR.

Measured on 2026-11-07, with Firefox 159 headless on the devbox and Splash 1.6 serving Qwen3.8-27B-4bit on the Mac:

| History mode | Steps | Time | Prompt cached per step | Prefill per step |
| --- | --- | --- | --- | --- |
| compact | 11 | 51.5 s | 0% (whole-prompt cache misses) | 2.3–3.4 s |
| **extend** | 12 | **42.2 s** | **74–92%** | **0.9–1.7 s** |

Prompts were 0.9k–3.9k tokens, and each action was 25–80 output tokens.

## Layout

```
entrypoints/  background (sidebar toggle, Origin fix), sidepanel (UI + agent), probe (in-page script)
src/probe/    perception (walk, snapshot, read, find) and actions, gating
src/agent/    loop, prompt/history, tools + tolerant parser
src/llm/      streaming client: OpenAI-compatible + Ollama native
src/browser/  host: tabs, frames, navigation, screenshots
src/bridge.ts agent bridge, extension side (poll loop, observe/act/task)
bridge/       fcu.mjs: MCP stdio server + CLI + localhost hub; SKILL.md for CLI-only harnesses
e2e/          fixture shop, fake model, Firefox runner
```

## Not done yet

- Native tool-calling mode. JSON actions are more reliable on small models, but some servers do better with tools.
- File uploads (Firefox can't set file inputs from an extension without a native helper), and drag and drop.
- Real trusted input (`isTrusted` events). That would need a native-messaging helper driving Firefox over WebDriver BiDi,
  which only matters for the few sites that check.
- Persisted conversations and follow-up messages in the same run.
- Injection in screenshots (vision mode) is not covered by the text detector; VPI-Bench-style visual attacks are untested.
- No checks yet with a real Firefox on macOS, only headless Firefox on Linux. The extension has no platform-specific code
  apart from the `MacCtrl` shortcut.
