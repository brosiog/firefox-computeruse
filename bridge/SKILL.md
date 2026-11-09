---
name: firefox-browser
description: Drive the user's real Firefox (logged-in sessions, open tabs) through the Firefox Computer Use extension. Use to read or act on web pages, or to hand a browsing chore to the extension's local-model agent.
---

# Firefox browser

Run `node <repo>/bridge/fcu.mjs <command>`. The Firefox Computer Use sidebar must be open in Firefox. Exit code 1 means
an error; the reason is printed.

- `fcu.mjs observe` prints the current tab as compact text: the URL, the tabs, and elements with refs such as
  `[12] button "Search"`. Add `--shot /tmp/page.jpg` to save a screenshot with the refs drawn on it.
- `fcu.mjs act '<json>'` runs one action or a JSON array of actions, then prints the results and the new page state.
  Add `--no-observe` to skip the page state.
  - `{"tool":"click","ref":"12"}`
  - `{"tool":"type","ref":"5","text":"...","enter":true}`
  - `{"tool":"select","ref":"7","option":"Large"}`
  - `{"tool":"key","key":"Escape"}`
  - `{"tool":"scroll","dir":"down"}`
  - `{"tool":"hover","ref":"3"}`
  - `{"tool":"navigate","url":"example.com"}`
  - `{"tool":"back"}`
  - `{"tool":"read","query":"price"}`
  - `{"tool":"find","text":"Contact"}`
  - `{"tool":"tab_new","url":"..."}`
  - `{"tool":"tab_switch","tab":2}`
  - `{"tool":"tab_close"}`
  - `{"tool":"wait","seconds":2}`
  - `{"tool":"login","enter":true}` signs in with the user's saved Bitwarden login for this site, if the user turned that
    on for agents (`fcu.mjs status` says). You never see the credentials. With several saved accounts, the result lists
    them: repeat with `"option":"2"`.
- `fcu.mjs task "<what to do, with every detail>"` hands the whole chore to the extension's local-model agent and
  prints its answer. If that agent needs information, it stops and prints its question. Call `task` again with the
  answer included.

Rules:

- Use refs from the latest page state only. After a navigation, the old refs are stale.
- Actions in one call stop at the first failure or page change.
- Submitting, sending, deleting, paying and typing passwords wait for the user to approve in the sidebar. Say so if a
  call is slow.
