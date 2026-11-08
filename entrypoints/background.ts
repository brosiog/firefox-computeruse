import { defineBackground } from 'wxt/utils/define-background';

declare const browser: any;

// The background is deliberately tiny: the agent runs in the sidebar page, which stays alive while it is open.
// Two jobs here:
// 1. The toolbar button toggles the sidebar.
// 2. Local model servers (Ollama, Splash) reject requests whose Origin is moz-extension://. The Origin header is
//    removed from the extension's own requests so no server-side origin allow-list is needed.
export default defineBackground(() => {
  // e2e/bench builds only (WXT_E2E_URL set at build time): a job loop. For each job from the fixture server: set the
  // settings, open the task's start page, open the panel as a tab driving it, wait for the panel's report, clean up.
  const e2e = import.meta.env.WXT_E2E_URL as string | undefined;
  if (e2e) void benchLoop(e2e);

  browser.action.onClicked.addListener(() => {
    browser.sidebarAction.toggle();
  });

  // Every request the extension's own pages make (model servers, model lists) goes out without an Origin header.
  // Gating this on the configured server's origin raced with settings changes: the bench caught Splash answering
  // 403 "Origin moz-extension://… is not allowed" on the first request after a change. Page requests are untouched.
  const extOrigin = new URL(browser.runtime.getURL('/')).origin;
  browser.webRequest.onBeforeSendHeaders.addListener(
    (details: { originUrl?: string; requestHeaders?: { name: string; value?: string }[] }) => {
      if (!details.originUrl?.startsWith(extOrigin)) return {};
      return { requestHeaders: (details.requestHeaders ?? []).filter(h => h.name.toLowerCase() !== 'origin') };
    },
    { urls: ['<all_urls>'], types: ['xmlhttprequest', 'other'] },
    ['blocking', 'requestHeaders'],
  );
});

async function benchLoop(base: string) {
  const keeper = (await browser.tabs.query({}))[0]?.id;
  for (;;) {
    let job: any;
    try {
      const r = await fetch(`${base}/e2e/next`);
      if (r.status === 204) return;
      job = await r.json();
    } catch {
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }
    await browser.storage.local.set({ settings: job.settings });
    await new Promise(r => setTimeout(r, 150));
    const start = await browser.tabs.create({ url: job.startUrl, active: true });
    const done = new Promise<void>(resolve => {
      const on = (m: any) => {
        if (m?.type === 'e2e-done' && m.job === job.id) {
          browser.runtime.onMessage.removeListener(on);
          resolve();
        }
      };
      browser.runtime.onMessage.addListener(on);
      setTimeout(resolve, job.timeoutMs ?? 300000);
    });
    const q = new URLSearchParams({ task: job.task, tabUrl: job.tabUrl, e2e: base, job: job.id, approve: job.approve ?? 'yes' });
    await browser.tabs.create({ url: browser.runtime.getURL(`/sidepanel.html?${q}`), active: false });
    await done;
    await browser.tabs.update(start.id, { active: true }).catch(() => {});
    const all = await browser.tabs.query({});
    await browser.tabs.remove(all.map((t: any) => t.id).filter((id: number) => id !== keeper)).catch(() => {});
  }
}
