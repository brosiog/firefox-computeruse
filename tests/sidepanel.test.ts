// @vitest-environment happy-dom
// The composer's @ mentions: typing @ lists tabs, picking attaches them as chips. Runs the real panel script against
// its HTML with a stubbed WebExtension API.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const TABS = [
  { id: 1, windowId: 1, index: 0, active: true, title: 'Shop B', url: 'https://b.test/' },
  { id: 2, windowId: 1, index: 1, active: false, title: 'Shop A hubs', url: 'https://www.a.test/hubs', favIconUrl: 'data:image/png;base64,AA==' },
  { id: 3, windowId: 1, index: 2, active: false, title: 'Add-ons', url: 'about:addons' },
  { id: 4, windowId: 2, index: 0, active: true, title: 'Reviews of hubs', url: 'https://reviews.test/hub', favIconUrl: 'https://reviews.test/favicon.ico', lastAccessed: 5 },
];

const tick = () => new Promise(r => setTimeout(r, 0));
const $ = (s: string) => document.querySelector(s) as HTMLElement;
const input = () => $('#input') as HTMLTextAreaElement;
const options = () => [...document.querySelectorAll('#mentions [role=option]')].map(o => o.textContent ?? '');
const chips = () => [...document.querySelectorAll('#attachbar .tabchip .t')].map(c => c.textContent);
const menuOpen = () => !$('#mentions').hidden;

async function type(text: string) {
  const i = input();
  i.focus();
  i.setRangeText(text, i.selectionStart, i.selectionEnd, 'end');
  i.dispatchEvent(new Event('input'));
  await tick();
  await tick();
}
const key = async (k: string) => {
  input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  await tick();
};

beforeAll(async () => {
  const html = readFileSync(resolve(import.meta.dirname, '../entrypoints/sidepanel/index.html'), 'utf8');
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script[\s\S]*?<\/script>/g, '');
  // happy-dom has no Option constructor.
  (globalThis as any).Option ??= function (text: string, value: string) {
    const o = document.createElement('option');
    o.text = text;
    o.value = value;
    return o;
  };
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  (globalThis as any).browser = {
    storage: { local: { get: async () => ({ settings: { model: '', bridgeUrl: '' } }), set: async () => {} } },
    permissions: { contains: async () => true, request: async () => true },
    tabs: { query: async () => TABS, get: async (id: number) => TABS.find(t => t.id === id) },
    windows: { getCurrent: async () => ({ id: 1 }) },
    runtime: { sendMessage: async () => {} },
  };
  await import('../entrypoints/sidepanel/main');
  await tick();
});

describe('@ tab mentions', () => {
  it('lists readable tabs, this window first, other windows marked', async () => {
    await type('compare @');
    expect(menuOpen()).toBe(true);
    const o = options();
    expect(o.map(t => t.split('\n')[0])).toHaveLength(3);
    expect(o[0]).toContain('Shop B');
    expect(o[0]).toContain('current');
    expect(o[1]).toContain('Shop A hubs');
    expect(o[2]).toContain('Reviews of hubs');
    expect(o[2]).toContain('other window');
    expect(o.join()).not.toContain('Add-ons');
    // Only data: favicons are shown (a remote one would be fetched from the extension page).
    expect([...document.querySelectorAll('#mentions img')].map(i => (i as HTMLImageElement).src)).toEqual(['data:image/png;base64,AA==']);
  });

  it('filters by what follows the @, and Enter picks', async () => {
    await type('hub');
    expect(options().map(t => t.includes('hub'))).toEqual([true, true]);
    await key('Enter');
    expect(menuOpen()).toBe(false);
    expect(chips()).toEqual(['Shop A hubs']);
    expect(input().value).toBe('compare @a.test ');
  });

  it('arrow keys and a click pick more tabs; picking an attached one detaches it', async () => {
    await type('and @');
    await key('ArrowDown');
    await key('ArrowDown');
    expect($('#mentions [aria-selected=true]').textContent).toContain('Reviews');
    await key('Enter');
    expect(chips()).toEqual(['Shop A hubs', 'Reviews of hubs']);
    await type(' @shop');
    expect(options().find(t => t.includes('Shop A'))).toContain('attached');
    const a = [...document.querySelectorAll('#mentions [role=option]')].find(o => o.textContent!.includes('Shop A'))!;
    a.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(chips()).toEqual(['Reviews of hubs']);
  });

  it('Escape closes the menu without submitting; the chip × removes a tab', async () => {
    await type(' @x');
    expect(menuOpen()).toBe(true);
    await key('Escape');
    expect(menuOpen()).toBe(false);
    ($('#attachbar .tabchip button') as HTMLButtonElement).click();
    expect(chips()).toEqual([]);
    expect($('#attachbar').hidden).toBe(true);
  });

  it('an @ inside a word or an email does not open the menu', async () => {
    input().value = '';
    await type('mail me at ada@example');
    expect(menuOpen()).toBe(false);
  });

  it('the @ button inserts an @ and opens the menu', async () => {
    input().value = 'look at';
    input().setSelectionRange(7, 7);
    ($('#at') as HTMLButtonElement).click();
    await tick();
    await tick();
    expect(input().value).toBe('look at @');
    expect(menuOpen()).toBe(true);
  });
});
