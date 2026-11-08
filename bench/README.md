# bench — measuring the agent so changes are evidence-driven

The bench runs the **real extension in real Firefox** against generated sites, scores each episode with a programmatic
validator, and judges **every step** against an oracle that reads the same page state the model saw. Every number
points at something specific to change.

```sh
node bench/run.mjs --model oracle                                    # self-test: all tasks solvable, harness floor
node bench/run.mjs --model http://192.168.86.202:8000/v1 --model-id qwen3.8-27b-splash --seeds 1 --label base
node bench/run.mjs ... --perturb all --split dev                    # tune on dev only
node bench/run.mjs ... --config base --config 'b2500={"pageBudget":2500}' --config 'nothink={"reasoning":false}'
node bench/run.mjs ... --config 'v2={"systemFile":"prompts/v2.txt"}' # try a system prompt without rebuilding
node bench/compare.mjs bench/.results/<before> bench/.results/<after>
node bench/replay.mjs --from bench/.results/<run> --model <url> --model-id <id> --variants all
node bench/lint.mjs
```

Each run writes `bench/.results/<stamp>-<label>/` containing:

- `report.md`
- `failures.md`
- `episodes.jsonl`
- `traces/<job>.json`: the exact prompt for every step, the raw reply, the oracle's verdict and timings

## The layers, and what each one tells you to change

| Layer | Question | Signal | What it points at |
| --- | --- | --- | --- |
| **Oracle self-test** (`--model oracle`) | Is the task solvable through the extension at all? | Pass rate must be 100%. Seconds per step = harness floor. | Failures are **extension or perception bugs**: the oracle reads only the page state, so if it can't succeed, neither can a model. |
| **Episode validators** | Did the task get done, with no bad side effects? | Pass, pass^k, generalization gap | Overall accuracy and reliability. |
| **Per-step judging** | Where exactly did it go wrong? | ok / neutral (wasted) / wrong per step, first wrong step | `failures.md` gives the page state, the model's action and the expected action at the first wrong decision. |
| **Failure taxonomy** | What kind of failure? | injection, format, loop, step_limit, premature_done, wrong_answer, wrong_action … | Each category maps to one area (see `CATEGORY_HINTS` in `lib/analyze.mjs`). |
| **Perturbations** | Robust, or lucky? | Pass delta from `base` | `noise` → budget and priority. `slow` → waiting and settle. `popup` → interruptions. `inject` → treating page text as data. |
| **Frozen-step replay** | Does this prompt change help? | Paired fixed/broken per decision, ms per decision, output tokens, system-prompt tokens | Prompt rules and sections: leave-one-out ablations show which lines earn their tokens. |
| **Config sweeps** | What does a knob trade? | Accuracy vs prefill tokens per step, peak context, s/step by phase | Page budget, history mode, reasoning on/off, effort, max output. |

### Speed and memory columns

| Column | Meaning |
| --- | --- |
| `s/step (model·observe·act)` | Where time goes: model call, page capture, action plus settle. |
| `prefill tok/step` | Tokens the server had to compute per step (prompt minus cached). This drives latency. |
| `cache` | Share of prompt tokens reused from the server's cache. |
| `peak ctx` | Largest prompt in the episode. This drives KV memory: plan the server's context and memory from it. |
| `out tok/step` | Output tokens per step (`think` length plus the action JSON). This drives decode time. |

## Not benchmaxing

- **Every seed is a new site.** Product names, people, labels, prices and layout skins all come from the seed, and the
  same task must pass in four widget styles: `<button>`, an ARIA div, a bare `cursor:pointer` span, and an `href="#"`
  anchor.
- **Dev and holdout splits.** Holdout seeds draw from vocabulary, button labels and skins (closed-shadow-DOM app, grid
  with the nav on the right) that dev never contains. Tune with `--split dev`. Report holdout. The report prints the gap;
  a growing gap means overfitting.
- **Prompt lint.** `bench/lint.mjs` fails the run if any generator vocabulary appears in the system prompt. It caught
  `"Add to cart"` in the built-in `find` example on its first run.
- **Perturbations are orthogonal to families,** so a fix has to hold everywhere, not on one page.
- **Families are plug-ins** (`families/index.mjs`). They can be retired, replaced or wrapped around external suites
  (MiniWoB-style pages, WebArena slices) without touching the runner. An oracle is optional: without one, steps are judged
  `unknown` and only episode metrics are reported.
- **Statistics.** The report shows Wilson 95% intervals, and `compare.mjs` counts discordant pairs. A difference of one
  or two episodes is noise; add seeds or `--repeat`.

## Families

| id | Exercises |
| --- | --- |
| shop | search, price comparison, quantity select, a late-rendered button, a `target=_blank` checkout, a **cross-origin payment iframe**, payment approval |
| form | text fields, native select, custom ARIA listbox, radios, a pre-checked box to uncheck, a required box, gated submit |
| table | paginated lookup; rows below the fold; reading rows across cells |
| longpage | a target many screens down among near-duplicate controls (find vs scroll) |
| widgets | a CSS `:hover` menu (synthetic events can't trigger `:hover`), switches inside **closed** shadow roots, save |
| multitab | two new-tab pages, a fact from each, a computed answer |
| todo | a list that re-renders and re-sorts after every change (**stale refs**), gated delete |
| reviews | aggregation over items, some behind "Show all" |
| decline | the user declines the approval; the agent must stop with no workaround |

## Adding a family

Copy a small one (`reviews.mjs`). It needs:

- `make(ctx)` returning `{ goal, route, validate, oracle }`.
- All text drawn through `ctx`: `ctx.word(...)`, `ctx.person()`, `ctx.int(...)`.
- Validators that check server-side state (`job.log`), never the transcript.
- An oracle that reads only `view(messages)`, which is what the model saw.

Run `--model oracle` until it passes 100% on every perturbation.

## Running external suites later

Wrap each external task as a family. `route` serves its static pages, `validate` ports its checker, and `oracle` can
return `null`. Keep its own pass rate separate in the report (`--families`) so it stays comparable with published numbers.

## First results (2026-11-08, Qwen3.8-27B-4bit on Splash 1.6, Firefox 159 headless)

### Bugs and changes the bench drove

| Found by | Problem | Change |
| --- | --- | --- |
| oracle self-test | CSS `:hover` menus can't be opened by synthetic events | `hover` also focuses (opens `:focus-within` menus); `find` lists links inside closed menus |
| oracle self-test, `slow` | an empty page was observed while the tab was still loading | `observe` waits for the load, then re-checks an empty page for up to ~2 s |
| oracle self-test, `slow` | text under `visibility:hidden` leaked into the page state | text follows its parent's computed visibility |
| oracle self-test, `noise` | mega-menus pushed the page's content out of the budget | content inside `<main>` first; chrome (nav, header, footer, aside, outside main) after, capped at 30 controls |
| oracle self-test, `table` | `find`/`read` presented partial word matches as hits | both say "No exact match …" first |
| prompt lint | the `find` example used a fixture label ("Add to cart") | neutral example |
| Splash run, `model_error` | Splash 403 on the extension Origin; stripping only for configured origins raced | strip Origin on all of the extension's own requests |
| Splash run, `decline` | prompt said "if the user declines, choose another way"; the model pressed Enter instead | prompt rule fixed; a declined risk on a page is auto-declined from then on |
| Splash run, wrong steps | the model guessed URLs with `tab_new` instead of clicking links | prompt rule: open pages by clicking; never guess URLs |

### Numbers

- **Base:** 89% → 100% (18 paired episodes; wrong steps 3.3% → 0%; 4.15 → 3.68 s/step).
- **Perturbations (dev):** 36/36.
- **Peak context:** `noise` doubles it (4.4k → 8.6k tokens). That's the clearest memory target.
- **Replay ablations (24 decisions):** no single rule mattered. A 230-token prompt matched the 980-token one, and
  `nothink` halved output tokens.
- **Full-episode check of `lean`** (minimal prompt, no think), 18 dev episodes each:

  | Config | Pass | s/step | Output tokens/step | Peak context |
  | --- | --- | --- | --- | --- |
  | base | 100% | 4.1 | 45 | 8.6k |
  | lean | 94% | 3.1 | 18 | 7.8k |

  The one `lean` failure was arithmetic: an average of 2.3 instead of 2.2, with no `think`. The suggested next
  experiment is adaptive thinking, with `think` only for reading and aggregation tasks. That's within noise at n=18; add
  seeds before deciding.

The suite now saturates for this model at 1 seed. To find the next failures, use more seeds and `--repeat 3`
(pass^k), combine perturbations, and add harder families (multi-hop, longer horizons).

## Speed pass (2026-11-08): faster, with no drop in results

**Acceptance bar:** 0 broken episodes against every earlier real-model episode, plus 100% on the full matrix (dev and
holdout × all five perturbations, 90 episodes) and 100% in oracle mode.

### What changed, and what each change did

| Change | Effect |
| --- | --- |
| Bench: background-timer throttling disabled | Act phase 1.0 → 0.3 s per step. This was a measurement artifact: a real sidebar is never throttled. |
| Settle ignores the agent's own highlight overlay | The quiet timer is no longer reset by the overlay's fade-out |
| `then` chains | Forms 11 → about 4 steps; fill-then-submit happens in one step |
| Prewarm with an exact-prefix primer | Model loaded and system prompt cached before the first step (whole-prompt caches included) |
| Built-in prompt about 1,090 → about 500 tokens | Measured, not guessed. Removing the "use read" rule broke a holdout aggregation task 2 of 3 times, so it went back (3/3). |
| "Single quotes inside string values" | A double quote inside `think` ended the string under Splash's grammar, and the reply degenerated: two lost steps in one episode |
| Interior-quote repair in the parser | Replies with raw inner quotes parse instead of costing a retry step |
| `find`/`read` wording for near-misses | "Nothing on this page contains X. Similar but different text…" |
| `read` uses `<main>` even under mega-menus | `shop.noise` 13–15 → 9–10 steps; peak context 12.0k → 7.4k |
| Bench fixes | Validation waits for in-flight requests; the table generator never makes near-namesakes (an ambiguous ground truth the old validator scored as a failure) |

### Results

90/90 on the full matrix, 90/90 in oracle mode, and **0 broken in 54 + 40 paired episodes**.

| | Before | After |
| --- | --- | --- |
| Steps per episode | 5.6 | 4.7 |
| Model time per episode | 15.3 s | 12.3 s |
| Prefill per step | 524 tokens | 397 tokens |
| Median peak context | 2.1–2.5k | 2.0k |

Wall time per episode (5.6 × 3.91 s → 4.7 × 3.19 s) dropped about 30%, partly because the old numbers included
throttled timers.
