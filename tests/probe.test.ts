// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { createProbe } from '../src/probe';
import type { ProbeResult, Snapshot } from '../src/protocol';

(globalThis as any).__fcuTestLayout = true;

const page = (html: string) => {
  document.body.innerHTML = html;
  return createProbe(window as any);
};
const snap = async (p: ReturnType<typeof createProbe>, budget = 5000) => (await p.run({ op: 'snapshot', budget })) as Snapshot;
const refOf = (text: string, needle: string) => {
  const line = text.split('\n').find(l => l.includes(needle));
  if (!line) throw new Error(`no line with ${needle} in\n${text}`);
  return Number(/^\[(\d+)\]/.exec(line)![1]);
};

describe('snapshot', () => {
  beforeEach(() => (document.body.innerHTML = ''));

  it('lists controls with roles, names and state, plus headings and text', async () => {
    const p = page(`
      <h1>Shop</h1>
      <p>Welcome to the <b>best</b> shop.</p>
      <nav aria-label="Main"><a href="/a">Home</a> <a href="/b">Deals</a></nav>
      <label for="q">Search</label><input id="q" value="hubs">
      <input type="password" value="hunter2" aria-label="Password">
      <input type="checkbox" checked aria-label="Remember me">
      <select aria-label="Size"><option>Small</option><option selected>Large</option></select>
      <button disabled>Buy</button>
      <div role="button" aria-expanded="false">Menu</div>
      <div style="display:none"><button>Hidden</button></div>
    `);
    const s = await snap(p);
    expect(s.text).toContain('# Shop');
    expect(s.text).toContain('Welcome to the best shop.');
    expect(s.text).toContain('== nav "Main" ==');
    expect(s.text).toMatch(/\[\d+\] link "Home"/);
    expect(s.text).toMatch(/\[\d+\] textbox "Search" value="hubs"/);
    expect(s.text).toMatch(/\[\d+\] password "Password" value=•••/);
    expect(s.text).not.toContain('hunter2');
    expect(s.text).toMatch(/checkbox "Remember me" checked/);
    expect(s.text).toMatch(/combobox "Size" value="Large" options: Small\|Large/);
    expect(s.text).toMatch(/button "Buy" disabled/);
    expect(s.text).toMatch(/button "Menu" collapsed/);
    expect(s.text).not.toContain('Hidden');
  });

  it('keeps refs stable across snapshots', async () => {
    const p = page(`<button>One</button><button>Two</button>`);
    const a = await snap(p);
    document.body.insertAdjacentHTML('afterbegin', '<button>Zero</button>');
    const b = await snap(p);
    expect(refOf(b.text, '"One"')).toBe(refOf(a.text, '"One"'));
    expect(refOf(b.text, '"Two"')).toBe(refOf(a.text, '"Two"'));
  });

  it('respects the budget and says so', async () => {
    const p = page(Array.from({ length: 300 }, (_, i) => `<button>Button number ${i}</button>`).join(''));
    const s = await snap(p, 1500);
    expect(s.text.length).toBeLessThan(1700);
    expect(s.hidden.dropped).toBeGreaterThan(0);
  });

  it('shows only the modal dialog when one is open', async () => {
    const p = page(`<button>Behind</button><div role="dialog" aria-modal="true" aria-label="Sign in"><button>Close</button></div>`);
    const s = await snap(p);
    expect(s.modal).toContain('Sign in');
    expect(s.text).toContain('Close');
    expect(s.text).not.toContain('Behind');
  });

  it('walks open shadow roots', async () => {
    const p = page(`<div id="host"></div>`);
    const host = document.getElementById('host')!;
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = '<button>In shadow</button>';
    const s = await snap(p);
    expect(s.text).toContain('In shadow');
  });

  it('treats a label for a visually hidden checkbox as the checkbox', async () => {
    const p = page(`<label><input type="checkbox" style="opacity:0"> Accept terms</label>`);
    const s = await snap(p);
    expect(s.text).toMatch(/\[\d+\] checkbox "Accept terms" unchecked/);
  });
});

describe('actions', () => {
  it('fails closed on refs never shown', async () => {
    const p = page(`<button>A</button>`);
    const r = (await p.run({ op: 'click', id: 99 })) as ProbeResult;
    expect(r.ok).toBe(false);
  });

  it('clicks with the full event sequence', async () => {
    const p = page(`<button id="b">Go</button>`);
    const seen: string[] = [];
    const b = document.getElementById('b')!;
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) b.addEventListener(t, () => seen.push(t));
    const s = await snap(p);
    const r = (await p.run({ op: 'click', id: refOf(s.text, '"Go"') })) as ProbeResult;
    expect(r.ok).toBe(true);
    expect(seen).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  });

  it('types into inputs firing input and change, replacing old text', async () => {
    const p = page(`<input id="i" aria-label="Name" value="old">`);
    const i = document.getElementById('i') as HTMLInputElement;
    let inputs = 0;
    let changes = 0;
    i.addEventListener('input', () => inputs++);
    i.addEventListener('change', () => changes++);
    const s = await snap(p);
    const r = (await p.run({ op: 'type', id: refOf(s.text, '"Name"'), text: 'Ada', clear: true, enter: false })) as ProbeResult;
    expect(r.ok).toBe(true);
    expect(i.value).toBe('Ada');
    expect(inputs).toBeGreaterThanOrEqual(3);
    expect(changes).toBe(1);
  });

  it('gates a purchase button until approved', async () => {
    const p = page(`<button id="b">Place order</button>`);
    let clicked = 0;
    document.getElementById('b')!.addEventListener('click', () => clicked++);
    const s = await snap(p);
    const id = refOf(s.text, 'Place order');
    const r = (await p.run({ op: 'click', id, gate: ['pay'] } as any)) as ProbeResult;
    expect(r.ok).toBe(false);
    expect(!r.ok && r.gate?.risk).toBe('pay');
    expect(clicked).toBe(0);
    const r2 = (await p.run({ op: 'click', id, approved: true, gate: ['pay'] } as any)) as ProbeResult;
    expect(r2.ok).toBe(true);
    expect(clicked).toBe(1);
  });

  it('does not gate search submits', async () => {
    const p = page(`<form role="search" action="/s"><input name="q" aria-label="Search"><button>Search</button></form>`);
    const form = document.querySelector('form')!;
    let submitted = 0;
    form.addEventListener('submit', e => {
      e.preventDefault();
      submitted++;
    });
    const s = await snap(p);
    const r = (await p.run({ op: 'type', id: refOf(s.text, 'textbox "Search"'), text: 'usb hub', clear: true, enter: true, gate: ['write', 'pay'] } as any)) as ProbeResult;
    expect(r.ok).toBe(true);
    expect(submitted).toBe(1);
  });

  it('gates Enter in a POST form whose button says Send', async () => {
    const p = page(`<form method="post"><input aria-label="Message"><button type="submit">Send</button></form>`);
    const s = await snap(p);
    const r = (await p.run({ op: 'type', id: refOf(s.text, '"Message"'), text: 'hi', clear: true, enter: true, gate: ['write'] } as any)) as ProbeResult;
    expect(r.ok).toBe(false);
    expect(!r.ok && r.gate?.risk).toBe('write');
  });

  it('selects native options by text', async () => {
    const p = page(`<select aria-label="Color"><option value="r">Red</option><option value="g">Green</option></select>`);
    const s = await snap(p);
    const r = (await p.run({ op: 'select', id: refOf(s.text, '"Color"'), option: 'green' })) as ProbeResult;
    expect(r.ok).toBe(true);
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('g');
  });

  it('find searches beyond the snapshot and returns usable refs', async () => {
    const p = page(Array.from({ length: 200 }, (_, i) => `<button>Item ${i}</button>`).join('') + '<button>Checkout now</button>');
    await snap(p, 800);
    const r = (await p.run({ op: 'find', text: 'checkout', limit: 5 })) as ProbeResult;
    expect(r.ok && r.msg).toMatch(/\[\d+\] button "Checkout now"/);
    const id = Number(/\[(\d+)\]/.exec((r as any).msg)![1]);
    const c = (await p.run({ op: 'click', id, gate: [] } as any)) as ProbeResult;
    expect(c.ok).toBe(true);
  });

  it('read returns main content with inline refs and paging', async () => {
    const p = page(`<nav><a href="/">Nav link</a></nav><main><h2>Specs</h2><p>Weight: 120 g. See <a href="/more">details</a>.</p><ul><li>USB-C</li><li>HDMI</li></ul></main>`);
    const r = (await p.run({ op: 'read', offset: 0, budget: 4000 })) as any;
    expect(r.msg).toContain('## Specs');
    expect(r.msg).toMatch(/details\[\d+\]/);
    expect(r.msg).toContain('- USB-C');
    expect(r.msg).not.toContain('Nav link');
    const q = (await p.run({ op: 'read', offset: 0, budget: 4000, query: 'weight' })) as any;
    expect(q.msg).toContain('Weight: 120 g.');
  });
});

describe('visibility', () => {
  it('omits text under visibility:hidden but keeps visible descendants', async () => {
    const p = page(`<div style="visibility:hidden">Secret tooltip <span style="visibility:visible">Shown child</span></div><p>Plain</p>`);
    const s = await snap(p);
    expect(s.text).not.toContain('Secret tooltip');
    expect(s.text).toContain('Shown child');
    expect(s.text).toContain('Plain');
  });
});

describe('find and read say when there is no exact match', () => {
  it('find', async () => {
    const p = page(`<p>Ken Lovelace</p><p>Grace Torvalds</p>`);
    const r = (await p.run({ op: 'find', text: 'Ken Torvalds', limit: 5 })) as any;
    expect(r.msg).toMatch(/^Nothing on this page contains "Ken Torvalds"/);
  });
  it('read with query', async () => {
    const p = page(`<main><p>Ken Lovelace</p><p>Grace Torvalds</p><p>Ken Torvalds — Denver</p></main>`);
    const r = (await p.run({ op: 'read', offset: 0, budget: 2000, query: 'Ken Torvalds' })) as any;
    expect(r.msg).toContain('Ken Torvalds — Denver');
    expect(r.msg).not.toContain('Ken Lovelace');
  });
});

describe('read picks main over a mega-menu', () => {
  it('uses <main> even when navigation holds most of the text', async () => {
    const nav = Array.from({ length: 200 }, (_, i) => `<a href="#${i}">Menu item number ${i}</a>`).join(' ');
    const p = page(`<div>${nav}</div><main><h1>Checkout</h1><p>Full name and card details below.</p></main>`);
    const r = (await p.run({ op: 'read', offset: 0, budget: 4000 })) as any;
    expect(r.msg).toContain('# Checkout');
    expect(r.msg).not.toContain('Menu item number');
  });
});
