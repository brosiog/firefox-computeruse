<!--
DRAFT. NOT APPROVED. NOT PUBLISHED.
For the owner to review, edit and approve before any AMO submission. Bracketed items are decisions or facts the owner must
fill in. This draft describes the code as of the amo-storefront-fixes branch.
-->

# Privacy Policy: Firefox Browser Use

_Last updated: [DATE, owner to set]_

Firefox Browser Use ("the extension") is a Firefox extension that runs a web agent in the Firefox sidebar. The agent
reads the page in the current tab and can act on it, using a language model that **you** configure.

**Short version:** the extension has no server of its own. It collects no analytics or telemetry, and sends nothing to
the developer. Page content goes only to the model server you choose, and to OpenAI if you choose ChatGPT sign-in.

## 1. Who is responsible

[Developer name, owner to fill in]
Contact: [contact address or form, owner to fill in]

## 2. What the extension handles on your computer

Stored in Firefox's local extension storage (`storage.local`) in your Firefox profile:

| Item | What it is | Where it goes |
| --- | --- | --- |
| Settings | Model server URL, model name, API key if you typed one, approval level, vision and other options, bridge and Bitwarden URLs | Stays on this computer |
| ChatGPT sign-in record (`chatgptAuth`) | Opaque install ID, OAuth client ID, the account's email and subject from the ID token, the ID token, access token and refresh token, expiry, and granted scopes | Sent only to OpenAI's sign-in service (`auth.openai.com`) and to the ChatGPT API (`api.openai.com`). Stored in plain form in the Firefox profile. |

The extension does **not** store:

- your Bitwarden master password (it is sent only to the local `bw serve` you run, and is never written to disk);
- your Bitwarden usernames, passwords or one-time codes (the agent receives only item names and masked usernames, and
  secrets are scrubbed from everything the agent sees);
- your task history or the sidebar log. Both live only while the sidebar is open.

Removing a sign-in with **Sign out** revokes the ChatGPT refresh token where OpenAI's service supports it, then deletes
the record. Uninstalling the extension removes everything in its storage.

## 3. What leaves your computer, and where it goes

Nothing leaves your computer unless you configure or use one of these features.

**a) The model server you configure.** When you give the agent a task, the extension sends the model server:

- the task text you typed, and the text of any other tabs you attached with `@`;
- the text of the page the agent is reading, and the results of its actions;
- a screenshot of the page, only if you turn on vision (and only for vision-capable models);
- the model's own replies and the agent's action history for the current task.

The server is whatever URL you set in Settings. If that is a server on your own machine or local network (for example
LM Studio, llama.cpp, MLX, Ollama, or a Splash server on another Mac you own), the data stays on your network. If you
point it at a hosted provider, the data goes to that provider under its own terms. The developer does not receive a copy.

**b) ChatGPT plan (optional).** If you choose *Continue with ChatGPT*:

- sign-in and token refresh go to OpenAI's sign-in service (`auth.openai.com`);
- the page content and task text described in (a), and screenshots if vision is on, go to the ChatGPT API
  (`api.openai.com`) and count against your ChatGPT plan's usage. OpenAI's privacy policy applies to that data.

**c) Bitwarden (optional, off by default).** The extension talks only to the local Bitwarden CLI API you run, by default
`http://localhost:8087`. Any sync with Bitwarden's servers is done by the Bitwarden CLI, under Bitwarden's policy. The
extension sends the vault's responses only into the sign-in fields of the page you are on, after checking that the page
matches the saved login.

**d) Agent bridge (optional, off unless you set a URL).** The extension connects to a local hub on
`127.0.0.1:47823` (`bridge/fcu.mjs`) that you run. Coding agents you connect to that hub (for example Claude Code or
Codex) can read the page and act on it through the extension. What those agents do with that content is governed by
the agent and its provider.

**Not done:** no advertising, no analytics, no crash reporting, no sale or sharing of data with third parties, and no
data sent to the developer.

**Data-collection categories declared to Mozilla (AMO):** `websiteContent` (page text and task text sent to the model
server you configure, or to OpenAI with ChatGPT sign-in, and screenshots if vision is on) and `authenticationInfo`
(the ChatGPT sign-in tokens, and the Bitwarden sign-in handling in section 3c). The extension does not declare any other
category.

## 4. Permissions and why they are needed

| Permission | Why |
| --- | --- |
| `tabs` | Show the current tab's address and title to the agent, and open or switch tabs when the agent is asked to. |
| `scripting` | Read and act on pages, using the extension's own page-reading and action code. |
| `storage` | Keep your settings and (if used) the ChatGPT sign-in record. |
| `theme` | Match the sidebar to your Firefox theme. |
| `webRequest`, `webRequestBlocking` | Two narrow uses: (1) removing the `Origin` header from requests the extension's own pages make to your model and Bitwarden servers, because some local servers reject extension origins; (2) during ChatGPT sign-in, catching the sign-in redirect so the extension can read the code without opening a listening port. |
| Host access, all sites | The agent must be able to work on whichever site you ask it to. The extension acts only when you give it a task, or when a coding agent connected through the bridge asks. |

## 5. Your choices

- Turn off vision to keep screenshots out of model requests.
- Use a model server on your own machine or network to keep page content there.
- Leave Bitwarden and the bridge off.
- Sign out of ChatGPT to revoke the sign-in and delete the stored tokens.
- Approval settings: the default asks before submits, sends, deletes, payments and passwords.

## 6. Children

The extension is not directed to children under 13 and does not knowingly collect data from them.

## 7. Changes

If this policy changes, the new version is published in the repository and the "Last updated" date changes. [Owner to
confirm where the policy is published, e.g. the AMO listing and the repository README.]

## Owner checklist before approval (remove this section before publishing)

- [ ] Confirm the developer name and contact.
- [ ] Set the "Last updated" date.
- [ ] Confirm the AMO data-collection categories. `wxt.config.ts` now declares `data_collection_permissions: { required:
      ['websiteContent', 'authenticationInfo'] }`, which section 3 describes. Decide whether tab addresses and titles (sent to
      the model with the `tabs` permission) also need `browsingActivity`; this draft does not declare it.
- [ ] Confirm that the statements about ChatGPT token storage (plain form in the profile) and revocation match the shipped build.
- [ ] Confirm where the policy will be published, and that the AMO listing links to it.
