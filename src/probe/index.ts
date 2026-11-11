// The probe: the only code that runs inside pages. One instance per frame, installed idempotently on
// `globalThis.__fcu` in the extension's content-script world, driven by scripting.executeScript calls.

import type { ProbeCmd, ProbeResult, Risk, Snapshot } from '../protocol';
import * as act from './actions';
import { Refs } from './refs';
import { fillLogin, loginForm } from './login';
import { readPage, pickContentRoot } from './read';
import { find, findModal, render, scrollFacts, describe } from './snapshot';

export interface Probe {
  run(cmd: ProbeCmd & { gate?: Risk[]; top?: string }): Promise<ProbeResult | Snapshot>;
}

declare const browser: { runtime: { getFrameId?: (t: unknown) => number } } | undefined;

export function createProbe(win: Window & typeof globalThis = window as Window & typeof globalThis): Probe {
  const doc = win.document;
  const refs = new Refs();
  const getFrameId = (t: unknown): number => {
    try {
      return typeof browser !== 'undefined' && browser?.runtime.getFrameId ? browser.runtime.getFrameId(t) : -1;
    } catch {
      return -1;
    }
  };
  const selfFrame = win === win.top ? 0 : getFrameId(win);
  const prefix = selfFrame > 0 ? `${selfFrame}:` : '';

  const root = () => findModal(doc) ?? doc.body ?? doc.documentElement;

  const resolve = (id: number) => {
    const r = refs.resolve(id, doc);
    return 'error' in r ? { error: `${prefix}${r.error}` } : r;
  };

  const ctx = (approved: boolean | undefined, gate: Risk[] | undefined): act.ActCtx => ({
    win,
    doc,
    approved: !!approved,
    gated: risk => (gate ?? ['write', 'delete', 'pay', 'secret', 'exfil', 'suspicious', 'offsite', 'login']).includes(risk),
    isTainted: el => {
      for (let p: Element | null = el; p; p = p.parentElement) if (tainted.has(p)) return true;
      return false;
    },
  });

  let marks: HTMLElement | null = null;
  // Controls on text written to AI agents (prompt injection): acting on them needs the user's approval.
  const tainted = new WeakSet<Element>();
  const taint = (el: Element) => tainted.add(el);

  return {
    async run(cmd) {
      act.setTopOrigin(cmd.top ?? null);
      try {
        switch (cmd.op) {
          case 'snapshot': {
            const modal = findModal(doc);
            const r = render(modal ?? doc.body ?? doc.documentElement, cmd.budget, prefix, refs, el => getFrameId(el));
            for (const el of r.tainted) taint(el);
            return {
              ok: true,
              frameId: selfFrame,
              url: win.location.href,
              title: doc.title,
              text: r.text,
              scroll: scrollFacts(doc, r.scroller),
              refs: r.refs,
              vw: win.innerWidth,
              vh: win.innerHeight,
              hidden: { above: r.above, below: r.below, dropped: r.dropped, chrome: r.chrome },
              modal: modal ? describe(modal) : null,
              links: refs.hrefs(),
              flagged: r.flagged,
            } satisfies Snapshot;
          }
          case 'click': {
            const r = resolve(cmd.id);
            if ('error' in r) return { ok: false, error: r.error };
            return act.click(r.el, ctx(cmd.approved, cmd.gate));
          }
          case 'type': {
            const r = resolve(cmd.id);
            if ('error' in r) return { ok: false, error: r.error };
            return act.type(r.el, cmd.text, cmd.clear, cmd.enter, ctx(cmd.approved, cmd.gate));
          }
          case 'select': {
            const r = resolve(cmd.id);
            if ('error' in r) return { ok: false, error: r.error };
            return act.select(r.el, cmd.option, ctx(cmd.approved, cmd.gate));
          }
          case 'key': {
            let el: Element | null = null;
            if (cmd.id !== undefined) {
              const r = resolve(cmd.id);
              if ('error' in r) return { ok: false, error: r.error };
              el = r.el;
            }
            return act.key(el, cmd.key, ctx(cmd.approved, cmd.gate));
          }
          case 'scroll': {
            let el: Element | null = null;
            if (cmd.id !== undefined) {
              const r = resolve(cmd.id);
              if ('error' in r) return { ok: false, error: r.error };
              el = r.el;
            }
            return act.scroll(el, cmd.dir, cmd.pages ?? 0.8, ctx(false, cmd.gate));
          }
          case 'hover': {
            const r = resolve(cmd.id);
            if ('error' in r) return { ok: false, error: r.error };
            return act.hover(r.el, ctx(false, cmd.gate));
          }
          case 'read': {
            const modal = findModal(doc);
            const text = readPage(modal ?? pickContentRoot(doc), prefix, refs, cmd.offset, cmd.budget, cmd.query, taint, cmd.plain);
            return { ok: true, msg: text, links: refs.hrefs() };
          }
          case 'find': {
            const { lines, total } = find(root(), cmd.text, cmd.limit, prefix, refs, el => getFrameId(el), taint);
            if (!lines.length) return { ok: true, msg: `nothing on this page matches "${cmd.text}".` };
            const shown = lines.filter(l => l.startsWith('[') || !l.startsWith('No exact')).length;
            const more = total > shown ? `\n(${total - shown} more matches; refine the text)` : '';
            return { ok: true, msg: lines.join('\n') + more, links: refs.hrefs() };
          }
          case 'settle':
            return { ok: true, msg: await act.settle(doc, cmd.quietMs, cmd.maxMs) };
          case 'loginForm':
          case 'fillLogin': {
            let near: Element | undefined;
            if (cmd.id !== undefined) {
              const r = resolve(cmd.id);
              if ('error' in r) return { ok: false, error: r.error };
              near = r.el;
            }
            if (cmd.op === 'loginForm') return loginForm(doc, near);
            const c = ctx(cmd.approved, cmd.gate);
            if (!c.approved && c.gated('login')) return { ok: false, error: 'needs approval: sign in with a saved login', gate: { risk: 'login', what: 'sign in with a saved login' } };
            return fillLogin(doc, near, cmd, c);
          }
          case 'marks': {
            marks?.remove();
            marks = null;
            if (cmd.show) marks = drawMarks(doc, refs, prefix);
            return { ok: true, msg: 'ok' };
          }
        }
      } catch (e) {
        return { ok: false, error: `page error: ${(e as Error)?.message ?? String(e)}` };
      }
      return { ok: false, error: 'unknown command' };
    },
  };
}

/** Set-of-marks overlay: ref labels drawn over visible controls, for screenshots sent to vision models. */
function drawMarks(doc: Document, refs: Refs, prefix: string): HTMLElement {
  const layer = doc.createElement('div');
  layer.id = act.MARKS_ID;
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const vh = doc.defaultView!.innerHeight;
  const vw = doc.defaultView!.innerWidth;
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const id = refs.peek(el);
    if (id === undefined) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw || r.width * r.height < 4) continue;
    const box = doc.createElement('div');
    box.style.cssText = `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:2px solid rgba(255,80,0,.85);`;
    const tag = doc.createElement('span');
    tag.textContent = prefix + id;
    tag.style.cssText = 'position:absolute;left:-2px;top:-14px;font:bold 11px/13px monospace;background:#ff5000;color:#fff;padding:0 3px;border-radius:2px;';
    box.appendChild(tag);
    layer.appendChild(box);
  }
  (doc.body ?? doc.documentElement).appendChild(layer);
  return layer;
}

export function install(): void {
  const g = globalThis as { __fcu?: Probe };
  if (!g.__fcu) g.__fcu = createProbe();
}
