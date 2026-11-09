// Page text as compact markdown for reading tasks: main content, headings, lists, tables, with refs inline on links and
// buttons so the model can act on what it read. Paged by character offset; filtered by query.

import { looksInjected } from './inject';
import { SKIP_TAGS, isBlock, visuallyHidden, sameColorAsBackground, testLayout, clean, flatChildren, isNativeInteractive, isRenderedStyle, nameOf, roleOf } from './dom';
import type { Refs } from './refs';

const SKIP_IN_READ = new Set(['NAV', 'FOOTER', 'ASIDE']);
const SKIP_ROLES = new Set(['navigation', 'contentinfo', 'complementary', 'banner', 'search']);

export function pickContentRoot(doc: Document): Element {
  const cands = Array.from(doc.querySelectorAll('main, [role=main], article'));
  let best: Element | null = null;
  let bestLen = 0;
  for (const c of cands) {
    const len = (c.textContent ?? '').length;
    if (len > bestLen) {
      best = c;
      bestLen = len;
    }
  }
  const bodyLen = (doc.body?.textContent ?? '').length;
  // A real <main> landmark is the content even when menus and footers hold most of the page's text (mega-menus did,
  // and read returned the menu). An <article> with a small share of the text is probably something minor.
  const main = cands.find(c => c.tagName === 'MAIN' || c.getAttribute('role') === 'main');
  if (main && (main.textContent ?? '').trim().length >= 40) return main;
  return best && bestLen > bodyLen * 0.25 ? best : doc.body ?? doc.documentElement;
}

/** `plain`: links and buttons keep their names but not their refs (text read from another tab, where refs would be
 * mistaken for refs on the current page). They are still registered, so their URLs count as seen. */
export function readLines(root: Element, prefix: string, refs: Refs, taint?: (el: Element) => void, plain = false): string[] {
  const win = root.ownerDocument.defaultView!;
  const lines: string[] = [];
  let buf = '';
  let lead = '';
  const isBodyRoot = root === root.ownerDocument.body;

  let lineEls: Element[] = [];
  const flush = () => {
    const t = buf.replace(/\s+/g, ' ').trim();
    buf = '';
    if (t) {
      // Text written to AI agents is marked, and the links inside it are tainted (acting on them needs approval).
      if (looksInjected(t)) {
        lines.push('⚠ ' + lead + t);
        for (const e of lineEls) taint?.(e);
      } else lines.push(lead + t);
    }
    lineEls = [];
    lead = '';
  };

  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      const p = (node as Text).parentElement;
      const vis = p ? win.getComputedStyle(p).visibility : '';
      if (vis === 'hidden' || vis === 'collapse') return;
      if (p && !testLayout() && sameColorAsBackground(p, win)) return;
      buf += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType === 11) {
      for (const c of flatChildren(node as ShadowRoot)) visit(c);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag) || tag === 'svg' || tag === 'SVG' || tag === 'IFRAME') return;
    const style = win.getComputedStyle(el);
    if (!isRenderedStyle(style)) return;
    if (visuallyHidden(el, style, el.getBoundingClientRect(), win)) return;
    const role = roleOf(el);
    if (isBodyRoot && (SKIP_IN_READ.has(tag) || (role && SKIP_ROLES.has(role)))) return;

    if (/^H[1-6]$/.test(tag) || role === 'heading') {
      flush();
      const lvl = Number(el.getAttribute('aria-level')) || Number(tag[1]) || 2;
      const t = clean(el.textContent, 200);
      if (t) lines.push(`${'#'.repeat(Math.min(lvl, 4))} ${t}`);
      return;
    }
    if (tag === 'IMG') {
      const alt = clean((el as HTMLImageElement).alt, 80);
      if (alt) buf += ` (image: ${alt}) `;
      return;
    }
    if (isNativeInteractive(el) && (tag === 'A' || tag === 'BUTTON' || role === 'button' || role === 'link')) {
      const n = nameOf(el, 120);
      if (n) {
        const id = refs.show(el);
        buf += plain ? ` ${n} ` : ` ${n}[${prefix}${id}] `;
        lineEls.push(el);
      }
      return;
    }
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (tag === 'TR') {
      flush();
      const cells = Array.from(el.children)
        .filter(c => c.tagName === 'TD' || c.tagName === 'TH')
        .map(c => clean((c as HTMLElement).innerText ?? c.textContent, 60));
      if (cells.some(Boolean)) lines.push('| ' + cells.join(' | ') + ' |');
      return;
    }
    const block = isBlock(el, style);
    if (block) flush();
    if (tag === 'LI') lead = '- ';
    else if (tag === 'BLOCKQUOTE') lead = '> ';
    for (const c of flatChildren(el)) visit(c);
    if (block) flush();
  };
  visit(root);
  flush();
  // Collapse runs of duplicate lines (repeated widgets).
  return lines.filter((l, i) => l !== lines[i - 1]);
}

export function readPage(root: Element, prefix: string, refs: Refs, offset: number, budget: number, query?: string, taint?: (el: Element) => void, plain = false): string {
  const lines = readLines(root, prefix, refs, taint, plain);
  if (query && query.trim()) {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    const keep = new Set<number>();
    // Lines with every word first; only if there are none, lines with any word, said as such.
    const allHit = lines.some(l => words.every(w => l.toLowerCase().includes(w)));
    lines.forEach((l, i) => {
      const low = l.toLowerCase();
      if (allHit ? words.every(w => low.includes(w)) : words.some(w => low.includes(w))) {
        keep.add(i);
        if (i > 0) keep.add(i - 1);
        if (i + 1 < lines.length) keep.add(i + 1);
      }
    });
    if (!keep.size) return `No text on this page matches "${query}". (${lines.length} lines of text in total.)`;
    let out = allHit ? '' : `No line contains all of "${query}". Lines with some of the words:\n`;
    let last = -2;
    for (const i of [...keep].sort((a, b) => a - b)) {
      const add = (i !== last + 1 ? '…\n' : '') + lines[i] + '\n';
      if (out.length + add.length > budget) {
        out += `(more matches omitted)\n`;
        break;
      }
      out += add;
      last = i;
    }
    return out.trim();
  }
  const all = lines.join('\n');
  if (!all) return '(no readable text on this page)';
  const slice = all.slice(offset, offset + budget);
  const end = offset + slice.length;
  let note = '';
  if (offset > 0 || end < all.length) {
    note = `\n(chars ${offset}-${end} of ${all.length}${end < all.length ? `; read with offset ${end} for more` : '; end'})`;
  }
  return slice + note;
}
