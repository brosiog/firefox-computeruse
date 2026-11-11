<!--
DRAFT. NOT APPROVED. NOT SUBMITTED TO AMO.
For the owner to review and edit. Bracketed items are placeholders the owner must fill in. Nothing here has been
published or entered on AMO. Describes the code on branch amo-storefront-fixes, version 0.1.0.
-->

# AMO listing copy: Firefox Browser Use (draft)

## Name

Firefox Browser Use

## Summary (250 characters max)

Firefox Browser Use runs a web agent in the Firefox sidebar. It reads and acts on the current tab with a model you
configure: a local server such as LM Studio, Ollama or llama.cpp, or ChatGPT sign-in. No telemetry.

_Character count: 214 (measured on the text above, line breaks removed)._

## Full description

Firefox Browser Use is a web agent that lives in the Firefox sidebar. Type a task, and the agent reads the page in your
current tab and clicks, types, scrolls and navigates to carry it out. It asks before sensitive actions such as
submitting a form, sending a message, deleting something, paying or entering a password. You choose the approval level
in Settings.

The agent is built for local language models. Point it at a server on your own computer or network:

- LM Studio, the default at `http://localhost:1234/v1`
- llama.cpp, MLX (`mlx_lm.server`), or any other OpenAI-compatible `/v1/chat/completions` server
- Ollama, through its native API

You can also choose *Continue with ChatGPT* in Settings to use your ChatGPT plan instead. Then the page content and your
tasks go to OpenAI under OpenAI's terms.

What it does:

- Works in the tab you are on, and can read other tabs you attach with @ in the task box.
- Shows what the agent does step by step in the sidebar, and lets you stop it at any time.
- Optional: fill sign-ins from your own Bitwarden vault through the local Bitwarden CLI (`bw serve`). The agent never sees
  passwords, usernames or one-time codes, and you approve each sign-in by default.
- Optional: an agent bridge on your own computer, for coding agents such as Claude Code or Codex to use your Firefox.
  It is off by default and connects only after you pair it with a token the bridge prints.
- Optional: web search for the agent through Parallel's keyless search service. Off by default; only the search words
  are sent.

Privacy: the extension has no server of its own. It has no analytics or telemetry and sends nothing to the developer.
Page content goes only to the model server you choose, and to OpenAI if you choose ChatGPT sign-in. Full details are in
the privacy policy on this page.

Requires Firefox 128 or later. The data-collection categories declared for this add-on are website content, browsing
activity and authentication information, and search terms if you turn on web search.

## Suggested categories

- Primary: Web Development (confirm against AMO's current list when submitting)
- Secondary: Privacy & Security, or Other if Privacy & Security does not fit

## Links

- Support email: none (leave empty; the support website covers it)
- Support website: https://github.com/brosiog/firefox-computeruse/issues
- Homepage: https://github.com/brosiog/firefox-computeruse
- Privacy policy: paste `amo/privacy-policy.md` into the listing's privacy policy field
- License: Apache-2.0

## Version notes for 0.1.0

First public version.

- Sidebar agent that drives the current tab, with approval levels for sensitive actions.
- Local model servers (LM Studio by default, llama.cpp, MLX, Ollama, and any OpenAI-compatible server) and optional
  ChatGPT sign-in.
- Optional Bitwarden sign-in and optional agent bridge. Both are off by default.
- Minimal permissions. Host access to all sites, needed so the agent can work on the sites you ask about.
- PNG icons at 48, 96 and 128 pixels; neutral default settings (no preselected model).

## Screenshots: outstanding (not created, not fabricated)

No screenshots exist yet. The owner must capture them from a real build. Needed:

1. The sidebar with a task in progress on a real page, showing the step log.
2. The approval prompt for a sensitive action (for example, a submit button).
3. Settings with a local model server (LM Studio or Ollama) selected. Hide any API key or private network address.
4. Optional: the *Continue with ChatGPT* sign-in panel, showing no account details.
5. Optional: the attached-tabs chips (@ mentions) above the task box.

Check AMO's current screenshot size and format rules at submission time.

## Owner decisions before submission

- Fill in every bracketed placeholder above.
- Confirm the categories against AMO's list.
- Decide whether to add a reviewer test account for ChatGPT sign-in (see amo/reviewer-notes.DRAFT.md).
