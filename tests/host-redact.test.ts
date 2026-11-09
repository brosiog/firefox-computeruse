// @vitest-environment node
// The real createHost with a fake `browser`: once a password-manager fill has told the host its values, they are
// scrubbed from what the host returns, including another tab's text read for @-attached tabs (readTab) and tab titles.
import { afterEach, describe, expect, it } from 'vitest';
import { createHost } from '../src/browser/host';

const USER = 'ada@lab.test';
const PASS = 'Tr0ub4dor&3-lab';

function fakeBrowser(tabs: Record<number, { url: string; title: string; text: string }>) {
  return {
    tabs: {
      get: async (id: number) => ({ id, status: 'complete', windowId: 1, ...tabs[id] }),
      query: async () => Object.entries(tabs).map(([id, t]) => ({ id: Number(id), windowId: 1, ...t })),
    },
    scripting: {
      executeScript: async (o: { target: { tabId: number }; files?: string[]; args?: any[] }) => {
        if (o.files) return [];
        const cmd = o.args?.[0];
        if (cmd?.op === 'read') return [{ result: { ok: true, msg: tabs[o.target.tabId].text, links: [`https://lab.test/u?email=${encodeURIComponent(USER)}`] } }];
        return [{ result: { ok: true, msg: 'ok' } }];
      },
    },
  };
}

afterEach(() => delete (globalThis as any).browser);

describe('host redaction', () => {
  const tabs = {
    1: { url: 'https://lab.test/login', title: 'Sign in', text: 'Sign in' },
    2: { url: 'https://lab.test/account', title: `Account of ${USER}`, text: `Welcome back, ${USER.toUpperCase()}! Your password is ${PASS}.` },
  };

  it('scrubs filled values from another tab read for @-attached tabs, and from tab titles', async () => {
    (globalThis as any).browser = fakeBrowser(tabs);
    const host = createHost(1, 1, [2]);
    const before = await host.readTab!(2, 4000);
    expect(before.text).toContain(PASS); // nothing filled yet: nothing to scrub
    host.redact!({ username: USER, password: PASS });
    const after = await host.readTab!(2, 4000);
    expect(after.text).toBe('Welcome back, •••! Your password is •••.');
    expect(after.title).toBe('Account of •••');
    expect(after.links.join(' ')).not.toContain(encodeURIComponent(USER));
    const titles = (await host.tabs()).map(t => t.title).join(' | ');
    expect(titles).not.toContain(USER);
  });
});
