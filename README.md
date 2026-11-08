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

## Model servers

| Preset | API | Notes |
| --- | --- | --- |
| **Splash (default)** | OpenAI-compatible, `http://192.168.86.202:8000/v1`, `qwen3.8-27b-splash`, 64K | Sends `reasoning_effort` (default `none`). The first request after idle release reloads the model (~30 s); the panel says so. |
| LM Studio | `http://localhost:1234/v1` | |
| llama.cpp | `http://localhost:8080/v1` | Use `--jinja`; `cache_prompt` is sent. |
| MLX (`mlx_lm.server`) | `http://localhost:8080/v1` | |
| Ollama | native `/api/chat`, `http://localhost:11434` | Sends `num_ctx`, `keep_alive` and `think`. No `OLLAMA_ORIGINS` setup needed (see below). |
| Other | any `/v1/chat/completions` | Optional API key; models are listed from `/models`. |

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
  instructions.
- **Vision (optional).** For vision models there is a `screenshot` tool that draws refs on the page (set-of-marks),
  downscaled to 1024 px JPEG. Splash reports `vision: true` for Qwen3.8; turn it on in Settings to use it.

## Development

```sh
pnpm test           # unit tests (vitest + happy-dom): probe, parser, prompt-cache invariants, agent loop
pnpm type-check
pnpm e2e            # real headless Firefox + fixture shop + scripted OpenAI-compatible fake model
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

The e2e needs a Firefox build in `e2e/.cache/firefox` (download it from Mozilla) or set `FIREFOX=/path/to/firefox`. It
builds a separate copy into `.output/e2e` with a test hook baked in. `dist/` never contains that hook.

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
e2e/          fixture shop, fake model, Firefox runner
```

## Not done yet

- Native tool-calling mode. JSON actions are more reliable on small models, but some servers do better with tools.
- File uploads (Firefox can't set file inputs from an extension without a native helper), and drag and drop.
- Real trusted input (`isTrusted` events). That would need a native-messaging helper driving Firefox over WebDriver BiDi,
  which only matters for the few sites that check.
- Persisted conversations, follow-up messages in the same run, and an MCP bridge.
- No checks yet with a real Firefox on macOS, only headless Firefox on Linux. The extension has no platform-specific code
  apart from the `MacCtrl` shortcut.
