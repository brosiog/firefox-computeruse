// The page state the model sees: what is on screen first, then a short look-ahead below, inside a character budget.
// Truncation is always stated so the model knows to scroll or use find.

import { clean, nameOf } from './dom';
import type { Refs } from './refs';
import { walk, Zone, type Item } from './walk';

export interface Rendered {
  text: string;
  refs: string[];
  above: number;
  below: number;
  dropped: number;
  chrome: number;
  scroller: Element | null;
}

const CHROME_CAP = 30;

export function findModal(doc: Document): Element | null {
  const cands = doc.querySelectorAll('dialog[open], [aria-modal="true"]');
  for (let i = cands.length - 1; i >= 0; i--) {
    const el = cands[i];
    let modal = el.getAttribute('aria-modal') === 'true';
    if (!modal) {
      try {
        modal = el.matches(':modal');
      } catch {
        modal = false;
      }
    }
    if (!modal) continue;
    const s = doc.defaultView!.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    return el;
  }
  return null;
}

export function lineFor(it: Item, prefix: string, refs: Refs): string {
  switch (it.kind) {
    case 'el':
      return `[${prefix}${refs.show(it.el!)}] ${it.line}`;
    case 'head':
      return `${'#'.repeat(Math.min(it.level ?? 2, 4))} ${it.line}`;
    case 'mark':
      return `== ${it.line} ==`;
    case 'frame':
      return `‹frame:${it.frameId}›`;
    default:
      return it.line;
  }
}

export function render(
  root: Element,
  budget: number,
  prefix: string,
  refs: Refs,
  getFrameId?: (el: Element) => number,
): Rendered {
  const { items, scroller, skippedAbove, skippedBelow } = walk(root, { full: false, textMax: 160, getFrameId });
  const cost = (it: Item) => it.line.length + 8;
  const pick = new Uint8Array(items.length);
  let used = 0;

  // 1. Main content on screen: controls and structure, then text. Site chrome (nav, header, footer, aside) comes
  //    after, so a mega-menu cannot push the page's actual content out of the budget.
  const take = (want: (it: Item) => boolean, limit: number) => {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (pick[i] || !want(it)) continue;
      if (used + cost(it) > limit) {
        if (it.kind === 'text') continue;
        break;
      }
      pick[i] = 1;
      used += cost(it);
    }
  };
  const onScreen = (it: Item) => it.zone === Zone.In;
  take(it => onScreen(it) && !it.chrome && it.kind !== 'text', budget);
  take(it => onScreen(it) && !it.chrome && it.kind === 'text', budget * 0.85);
  // 2. Site chrome on screen, while it fits, capped: a page's 150 menu links cost thousands of tokens per step and
  //    are reachable with find. Headings and landmarks in chrome are cheap orientation and always fit first.
  let chromeEls = 0;
  take(it => onScreen(it) && !!it.chrome && it.kind !== 'text' && (it.kind !== 'el' || ++chromeEls <= CHROME_CAP), budget * 0.95);
  // 3. A look-ahead below the fold: controls and headings only.
  let ahead = 0;
  for (let i = 0; i < items.length && ahead < 25; i++) {
    const it = items[i];
    if (it.zone !== Zone.Below || it.chrome || (it.kind !== 'el' && it.kind !== 'head' && it.kind !== 'frame')) continue;
    if (used + cost(it) > budget) break;
    pick[i] = 1;
    used += cost(it);
    ahead++;
  }

  const lines: string[] = [];
  const shown: string[] = [];
  let above = skippedAbove;
  let below = skippedBelow;
  let dropped = 0;
  let chrome = 0;
  let foldMarked = false;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!pick[i]) {
      if (it.kind === 'el') {
        if (it.zone === Zone.Above) above++;
        else if (it.zone === Zone.Below) below++;
        else if (it.chrome) chrome++;
        else dropped++;
      }
      continue;
    }
    if (it.kind === 'mark' && !nextPickedIsContent(items, pick, i)) continue;
    if (it.zone === Zone.Below && !foldMarked) {
      lines.push('-- below the visible area --');
      foldMarked = true;
    }
    const line = lineFor(it, prefix, refs);
    if (it.kind === 'el') shown.push(line.slice(1, line.indexOf(']')));
    lines.push(line);
  }
  return { text: lines.join('\n'), refs: shown, above, below, dropped, chrome, scroller };
}

function nextPickedIsContent(items: Item[], pick: Uint8Array, i: number): boolean {
  for (let j = i + 1; j < items.length; j++) {
    if (!pick[j]) continue;
    return items[j].kind !== 'mark';
  }
  return false;
}

/** Search the whole page for controls or text matching a query, ignoring the viewport. */
export function find(root: Element, query: string, limit: number, prefix: string, refs: Refs, getFrameId?: (el: Element) => number) {
  const { items } = walk(root, { full: true, textMax: 200, getFrameId });
  const q = query.toLowerCase().trim();
  const words = q.split(/\s+/).filter(w => w.length > 1);
  const scored: { i: number; s: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'mark' || it.kind === 'frame') continue;
    const l = it.line.toLowerCase();
    let s = 0;
    if (l.includes(q)) s = 10;
    else if (words.length > 1) {
      const hit = words.filter(w => l.includes(w)).length;
      if (hit === words.length) s = 6;
      else if (hit >= Math.ceil(words.length / 2)) s = 2;
    }
    if (!s) continue;
    if (it.kind === 'el') s += 3;
    scored.push({ i, s });
  }
  // Links inside closed menus (display:none, opened by CSS :hover that synthetic events cannot trigger) are invisible
  // to the walk. They are listed separately: following a link does not need it to be visible.
  const hiddenLinks: string[] = [];
  if (q.length >= 2) {
    for (const a of Array.from(root.querySelectorAll('a[href]'))) {
      const t = clean(a.textContent, 80);
      if (!t || !t.toLowerCase().includes(q) || (a as HTMLElement).getClientRects().length) continue;
      if (!/^https?:/.test((a as HTMLAnchorElement).href)) continue;
      hiddenLinks.push(`[${prefix}${refs.show(a)}] link "${t}" (in a closed menu; clicking follows the link)`);
      if (hiddenLinks.length >= 5) break;
    }
  }
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  // Say plainly when nothing contains the whole query: partial hits ("Ken Lovelace" for "Ken Torvalds") must not read
  // as success, or the model never moves on (next page, another search).
  const exact = scored.filter(x => x.s >= 6);
  const top = (exact.length ? exact : scored).slice(0, limit).sort((a, b) => a.i - b.i);
  const out: string[] = [];
  if (!exact.length && scored.length) {
    out.push(`Nothing on this page contains "${query}". Similar but different text (likely not what you want; it may be elsewhere, e.g. on another page):`);
  }
  for (const { i } of top) {
    const it = items[i];
    let line = lineFor(it, prefix, refs);
    if (it.kind === 'text') {
      // Text hits point at the nearest control after them so the model can act on what it found.
      const ctl = nearestControl(items, i);
      if (ctl) line += `  → near [${prefix}${refs.show(ctl.el!)}] ${ctl.line}`;
    }
    const where = it.zone === Zone.Above ? ' (above)' : it.zone === Zone.Below ? ' (below)' : '';
    out.push(line + where);
  }
  out.push(...hiddenLinks);
  return { lines: out, total: (exact.length || scored.length) + hiddenLinks.length, exact: exact.length + hiddenLinks.length };
}

function nearestControl(items: Item[], i: number): Item | null {
  for (let d = 1; d <= 4; d++) {
    const a = items[i + d];
    if (a?.kind === 'el') return a;
    const b = items[i - d];
    if (b?.kind === 'el') return b;
  }
  return null;
}

export function describe(el: Element): string {
  const n = nameOf(el, 50);
  return `${el.tagName.toLowerCase()}${n ? ` "${n}"` : ''}`;
}

export function scrollFacts(doc: Document, scroller: Element | null): string {
  const win = doc.defaultView!;
  const se = doc.scrollingElement ?? doc.documentElement;
  const main = se.scrollHeight > se.clientHeight + 40 ? se : scroller;
  if (!main) return 'fits on one screen';
  const isDoc = main === se;
  const top = isDoc ? win.scrollY : main.scrollTop;
  const view = isDoc ? win.innerHeight : main.clientHeight;
  const total = main.scrollHeight;
  const pages = Math.max(1, Math.ceil(total / Math.max(1, view)));
  const page = Math.min(pages, Math.floor(top / Math.max(1, view)) + 1);
  const pct = Math.round((top / Math.max(1, total - view)) * 100);
  const where = pct <= 0 ? 'at top' : pct >= 99 ? 'at bottom' : `${pct}% down`;
  return `screen ${page}/${pages}, ${where}${isDoc ? '' : ` (inner scroll area ${describe(main)})`}`;
}

