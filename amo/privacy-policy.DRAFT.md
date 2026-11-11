<!--
DRAFT. NOT APPROVED. NOT PUBLISHED.
For the owner to review, edit and approve before any AMO submission. Bracketed items are decisions or facts the owner must
fill in. This draft describes version 0.1.x, including saved conversations, notes, web search and the paired
bridge.
-->

# Privacy Policy: Firefox Browser Use

_Last updated: [DATE, owner to set]_

Firefox Browser Use ("the extension") is a Firefox extension that runs a web agent in the Firefox sidebar. The agent
reads the page in the current tab and can act on it, using a language model that **you** configure.

**Short version:** the extension has no server of its own. It collects no analytics or telemetry, and sends nothing to
the developer. Page content goes only to the model server you choose, and to OpenAI if you choose ChatGPT sign-in. If
you turn on web search, the agent's search words go to Parallel's search service.

## 1. Who is responsible

[Developer name, owner to fill in]
Contact: [contact address or form, owner to fill in]

## 2. What the extension handles on your computer

Stored in Firefox's local extension storage (`storage.local`) in your Firefox profile:

| Item | What it is | Where it goes |
| --- | --- | --- |
| Settings | Model server URL, model name, API key if you typed one, approval level, vision, web search and other options, bridge and Bitwarden URLs, the agent bridge pairing token if you pasted one, and your "Things to remember" notes | Stays on this computer, except that the API key goes to your model server, the notes are sent to your model server with tasks (see 3a), and the pairing token is sent only to the local bridge hub |
| Past conversations (`chats`) | For each saved conversation: a title, timestamps, and each request you typed with the agent's final answer. No page contents, screenshots or tab text. At most 200 conversations. | Stays on this computer. Earlier turns of the open conversation are sent to your model server with a follow-up (see 3a). |
| ChatGPT sign-in record (`chatgptAuth`) | Opaque install ID, OAuth client ID, the account's email and subject from the ID token, the ID token, access token and refresh token, expiry, and granted scopes | Sent only to OpenAI's sign-in service (`auth.openai.com`) and to the ChatGPT API (`api.openai.com`). Stored in plain form in the Firefox profile. |

The extension does **not** store:

- your Bitwarden master password (it is sent only to the local `bw serve` you run, and is never written to disk);
- your Bitwarden usernames, passwords or one-time codes (the agent receives only item names and masked usernames, and
  secrets are scrubbed from everything the agent sees);
- the sidebar log (the agent's steps, page states and approval cards). It lives only while the sidebar is open.

Past conversations can be deleted one at a time (×) or all at once (*Delete all*) under the *Past conversations*
button. *Settings → Keep past conversations* deletes conversations not touched for 1, 7, 30 or 90 days; the default is
to keep them until you delete them. Notes are edited or removed in *Settings → Things to remember*.

If you use the agent bridge, the hub program (`bridge/fcu.mjs`) also keeps the pairing token in a file readable only by
your user account (mode 0600) in your user configuration directory on this computer.

Removing a sign-in with **Sign out** revokes the ChatGPT refresh token where OpenAI's service supports it, then deletes
the record. Uninstalling the extension removes everything in its storage (it does not remove the hub's token file).

## 3. What leaves your computer, and where it goes

Nothing leaves your computer unless you configure or use one of these features.

**a) The model server you configure.** When you give the agent a task, the extension sends the model server:

- the task text you typed, and the text of any other tabs you attached with `@`;
- the text of the page the agent is reading, and the results of its actions;
- a screenshot of the page, only if you turn on vision (and only for vision-capable models);
- the model's own replies and the agent's action history for the current task;
- your "Things to remember" notes: every note without a site, and each site note (`amazon.com: …`) only when that site
  is named in the task or is the address of the current or an attached tab;
- for a follow-up in the sidebar, the earlier turns of that conversation (the last 8 requests and answers, shortened).
  Tasks a coding agent hands over through the bridge get the notes but not the sidebar conversation.

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

**d) Agent bridge (optional, off by default).** The bridge URL in *Settings → Agent bridge* is empty unless you set
it. When set, the extension connects to a hub on this computer (`bridge/fcu.mjs`, by default `127.0.0.1:47823`) that
you run. Pairing needs a token: `node bridge/fcu.mjs token` prints it, and you paste it into *Settings → Agent bridge*.
The hub answers only requests that carry the token, and it signs each command, so the extension ignores a hub that
does not know the token. Coding agents you connect to that hub (for example Claude Code or Codex) can read the page and
act on it through the extension. What those agents do with that content is governed by the agent and its provider.

**e) Web search (optional, off by default).** With *Settings → Let the agent search the web* on, the agent can run web
searches through Parallel's keyless Search service (`https://search.parallel.ai/mcp`), with no account or API key. Each
search sends only the search words the model wrote, at most 200 characters. No page content, cookies, tab addresses
or notes are sent. Parallel's privacy policy (https://parallel.ai/privacy-policy) applies to those searches. The search
words can include details from your task or the page, because the model writes them.

**Not done:** no advertising, no analytics, no crash reporting, no sale of data, no sharing with third parties other
than the services you turn on above, and no data sent to the developer.

**Data-collection categories declared to Mozilla (AMO):** `websiteContent` (page text and task text sent to the model
server you configure, or to OpenAI with ChatGPT sign-in, screenshots if vision is on, and notes and earlier turns of
the conversation) and `authenticationInfo`
(the ChatGPT sign-in tokens, and the Bitwarden sign-in handling in section 3c). The extension does not declare any other
category.

## 4. Permissions and why they are needed

| Permission | Why |
| --- | --- |
| `tabs` | Show the current tab's address and title to the agent, and open or switch tabs when the agent is asked to. |
| `scripting` | Read and act on pages, using the extension's own page-reading and action code. |
| `storage` | Keep your settings (including notes and the bridge pairing token), past conversations, and (if used) the ChatGPT sign-in record. |
| `theme` | Match the sidebar to your Firefox theme. |
| `webRequest`, `webRequestBlocking` | Two narrow uses: (1) removing the `Origin` header from requests the extension's own pages make to your model and Bitwarden servers, because some local servers reject extension origins; (2) during ChatGPT sign-in, catching the sign-in redirect so the extension can read the code without opening a listening port. |
| Host access, all sites | The agent must be able to work on whichever site you ask it to. The extension acts only when you give it a task, or when a coding agent connected through the bridge asks. |

## 5. Your choices

- Turn off vision to keep screenshots out of model requests.
- Use a model server on your own machine or network to keep page content there.
- Leave Bitwarden, the bridge and web search off. With web search off, nothing goes to Parallel.
- Keep "Things to remember" free of anything you don't want sent to your model server, and use site-prefixed notes
  (`amazon.com: …`) so a note is sent only when that site is involved.
- Set *Keep past conversations* to a short period, or delete conversations under *Past conversations*.
- Start a new conversation (*New task*) so earlier turns are not sent with the next task.
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
- [ ] Decide whether web search (section 3e) needs the `searchTerms` category; this draft does not declare it.
- [ ] Confirm that section 3d (bridge off by default, pairing token, signed commands, 0600 token file) matches the
      shipped bridge, and the token file's exact location.
- [ ] Confirm the past-conversation and notes statements (sections 2 and 3a) match the shipped build.
