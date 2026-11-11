# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's private vulnerability reporting:
[open a report](https://github.com/brosiog/firefox-computeruse/security/advisories/new) (the repository's *Security*
tab, then *Report a vulnerability*). Don't open a public issue for a security problem.

Include the Firefox version, the extension version, the model server and model if they matter, and steps or a page
that reproduces it. You'll get a reply in the report thread.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Scope

- The extension: the sidebar, background page and the in-page probe.
- The agent bridge hub (`bridge/fcu.mjs`): anything that lets a web page or another local user reach it, or skip pairing.
- Credential handling: Bitwarden logins reaching the model, a coding agent or the wrong site; ChatGPT sign-in tokens.
- Prompt injection: page text that gets the agent past an approval gate, navigation provenance or the injection checks.

Weaknesses of the model itself (for example, it follows a page's advice within what the gates allow) are out of scope
unless they bypass a deterministic check. Known gaps are listed under *Not done yet* in the README.

## Security model

- **Page content is data.** Everything a page controls reaches the model inside a `<page>…</page>` fence that the
  page can't close. Hidden text is dropped, and lines aimed at AI agents are marked and taint the controls they belong to.
- **Approval gates.** Decided in the page before dispatch. Submits, sends, deletes, payments and passwords ask by
  default. Cross-site form submissions and tainted controls ask at every level and are refused in Full auto.
- **Navigation provenance.** The agent can only open a URL a page offered as a link, one on the same site, or one the
  user named. URLs that carry data to a third party are blocked.
- **Bitwarden.** The username, password and one-time code are never shown to the model. They go from `bw serve`
  straight into the fill, only after the frame's site matches the saved login, and are scrubbed from later page text.
- **Agent bridge.** Off by default. The hub listens on loopback only, refuses web pages (custom header, loopback
  `Host`, no foreign `Origin`), and needs a pairing token pasted into Settings. Commands are signed, so the extension
  ignores a hub that doesn't know the token.
- **Opt-in features.** Bitwarden logins, logins for coding agents, the bridge, web search and vision are all off by
  default. The extension has no server of its own and sends no telemetry.

Details: [Prompt-injection defenses](README.md#prompt-injection-defenses) and
[Bitwarden logins](README.md#bitwarden-logins-opt-in) in the README.
