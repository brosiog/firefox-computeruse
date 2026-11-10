<!--
DRAFT. NOT APPROVED. NOT SUBMITTED. For the owner to review before anything goes to AMO.
Bracketed items are owner decisions. Do not add credentials, account details or private network addresses here.
-->

# Reviewer notes: Firefox Browser Use (draft)

## What the extension is

A Firefox sidebar agent. The user types a task, and a language model the user configures reads the current tab and
acts on it (clicks, types, navigates, asks for confirmation before sensitive actions). The model is not provided by the
developer. The extension ships no model and contacts no developer server. It is built with WXT, has no runtime
dependencies, and contains no remote code: all scripts are bundled in the package.

Source: this repository, branch and commit [owner to fill in]. Build from source:

```sh
pnpm install --frozen-lockfile
pnpm build            # → dist/  (Firefox MV3)
pnpm check:build      # manifest, permissions, CSP, referenced files, no test hooks, no sourcemaps, size budget
pnpm lint:addon       # web-ext lint
```

Other checks in the repository: `pnpm type-check`, `pnpm test`, `pnpm bench:lint`.

## Testing without a real model

No model server is needed to review the extension's behavior. `pnpm e2e` starts a scripted OpenAI-compatible fake model
and a fixture shop site, runs real headless Firefox, and drives the agent end to end. `pnpm e2e:login` runs the sign-in
lab with a fake Bitwarden CLI (`bw serve`) and many local test hostnames.

For manual testing with a real local model: any OpenAI-compatible server on `localhost` works. Set the URL and model
in *Settings*. The default URL is `http://localhost:1234/v1`, LM Studio's port, with no model preselected.

## Permissions

The manifest requests `tabs`, `scripting`, `storage`, `theme`, `webRequest`, `webRequestBlocking`, and host access to
`<all_urls>`. The `webRequest` pair is used for two things only, both in `entrypoints/background.ts` and
`src/llm/chatgpt-auth.ts`:

1. **Origin header removal.** Local model servers (Ollama, and some others) reject requests from `moz-extension://`
   origins. The background page removes the `Origin` header from requests the extension's own pages make. Page requests
   are not changed.
2. **ChatGPT sign-in redirect.** See below.

`webNavigation` was removed in this version because nothing calls it.

## ChatGPT sign-in (optional)

Users can choose *Continue with ChatGPT*. This uses OpenAI's published token-sharing flow
(https://developers.openai.com/siwc/token-sharing-open-source) against `auth.openai.com`, with the public Responses API
at `api.openai.com/v1`:

- The extension registers as a dynamic OAuth client, then runs an authorization-code flow with PKCE, `state` and `nonce`.
- The redirect goes to `http://127.0.0.1:<port>/auth/callback`. **The extension does not listen on that port.** The
  background page sees the sign-in tab's navigation to that URL with `webRequest`, takes the `code` from the URL, cancels
  the request, and closes the tab. This is why `webRequestBlocking` is needed.
- The ID token's signature is checked against OpenAI's JWKS, with issuer, audience and expiry checks.
- Tokens are stored in `storage.local` under `chatgptAuth`. Token refresh and revocation happen only in the background
  page, so refresh tokens are not raced by several sidebars. *Sign out* calls the revocation endpoint and deletes the record.
- Requests use `store: false` and `stream: true`.

To test sign-in, a reviewer needs a ChatGPT account. [Owner to decide: whether to provide a test account through the
AMO reviewer channel. Do not put credentials in these notes.] The feature is optional, and every other mode works
without it.

## Bitwarden integration (optional, off by default)

*Settings → Bitwarden logins* turns on a client for the local Bitwarden CLI's API, `bw serve`, at `http://localhost:8087`
by default. The user runs `bw login`, `bw unlock` and `bw serve` themselves.

- The extension never stores the master password. It is sent only to the local `bw serve` to unlock it.
- The agent is shown only item names and masked usernames (`j•••@example.com`). It is never shown passwords, usernames
  or one-time codes.
- Fill happens in the page, after the extension checks that the frame's origin matches the saved login (same host or
  registrable domain, never `http` for an `https` login, no shared hosting suffixes). The user must approve each sign-in
  by default.
- Filled values are scrubbed from everything the agent receives afterwards.
- `bw serve` rejects requests that carry an `Origin` header. The background page removes it for the extension's own
  requests (see *Permissions*).

The sign-in logic has a lab suite, `pnpm e2e:login`, with about 165 cases run against a fake `bw serve`.

## LAN and local model servers

Users often run models on another machine on their own network, so the extension has to reach plain-`http` addresses
on private networks. Firefox's default MV3 extension CSP includes `upgrade-insecure-requests`, which rewrites `http://`
to `https://` and breaks those servers. The manifest sets an explicit extension-page CSP without that directive:

```
script-src 'self'; object-src 'self';
```

This applies to extension pages only. It does not weaken page content. `scripts/check-build.mjs` verifies that the
policy has no `unsafe-eval`, `unsafe-inline` or `https?:` sources and no `upgrade-insecure-requests`. No addresses are
hard-coded in the build. The default model URL is `localhost`.

## Data handling summary

No analytics, telemetry or developer-side server. Page content and task text go to the model server the user configures,
and to OpenAI only if the user chooses ChatGPT. The manifest declares the AMO data-collection categories
`websiteContent` and `authenticationInfo` (`browser_specific_settings.gecko.data_collection_permissions` in `wxt.config.ts`).
Full details are in the privacy policy (draft:
`amo/privacy-policy.DRAFT.md`). [Owner to confirm the policy's final location and the AMO data-collection categories.]

## Optional local bridge

`bridge/fcu.mjs` is a Node script (no dependencies beyond Node's built-ins, checked by `check-build`). The user starts it
to let a coding agent use the browser. It listens only on `127.0.0.1:47823`. The extension connects to it only when
the user sets the bridge URL.

## Owner checklist before submission (remove this section before sending)

- [ ] Fill in the source commit, and check it matches the uploaded sources zip.
- [ ] Decide whether to provide a ChatGPT test account, and how (not in these notes).
- [ ] Confirm the claims about `webRequest`, the CSP and token storage against the build being submitted.
- [ ] Confirm the reviewers' build steps work on a clean machine.
