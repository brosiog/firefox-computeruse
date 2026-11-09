// One pass over the rendered DOM (flat tree, shadow roots included) producing ordered items: controls, headings,
// text runs, landmarks and frame placeholders, each tagged with where it sits relative to the viewport.

import { looksInjected } from './inject';
import {
  SKIP_TAGS, isBlock, visuallyHidden, sameColorAsBackground, clean, flatChildren, isNativeInteractive, isRenderedStyle, landmarkOf, nameOf, roleOf, shownSelf,
  stateOf, testLayout,
} from './dom';

export const Zone = { In: 0, Above: 1, Below: 2 } as const;
export type Zone = (typeof Zone)[keyof typeof Zone];

export type ItemKind = 'el' | 'head' | 'text' | 'mark' | 'frame';

export interface Item {
  kind: ItemKind;
  zone: Zone;
  /** Line text without the ref prefix. */
  line: string;
  el?: Element;
  level?: number;
  frameId?: number;
  /** Inside site chrome (nav, header, footer, aside): budgeted after the main content. */
  chrome?: boolean;
  /** For text items: the element the text came from (taint tracking). */
  host?: Element;
  /** The line reads as written to an AI agent (prompt injection). */
  flag?: boolean;
}

export interface WalkResult {
  items: Item[];
  scroller: Element | null;
  /** Controls skipped without being visited (far off-screen subtrees). */
  skippedBelow: number;
  skippedAbove: number;
}

const INTERACTIVE_SELECTOR =
  'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=""],[contenteditable=true],[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox]';

export interface WalkOptions {
  /** Walk everything regardless of distance from the viewport (find). */
  full: boolean;
  textMax: number;
  getFrameId?: (el: Element) => number;
}

export function walk(root: Element, opts: WalkOptions): WalkResult {
  const win = root.ownerDocument.defaultView!;
  const vh = win.innerHeight || 800;
  const vw = win.innerWidth || 1200;
  const items: Item[] = [];
  let scroller: Element | null = null;
  let scrollerArea = 0;
  let skippedBelow = 0;
  let skippedAbove = 0;
  const layout = !testLayout();

  // Text accumulates across inline content and is flushed at block and control boundaries.
  let buf = '';
  let bufZone: Zone = Zone.In;
  let bufChrome = false;
  let bufHost: Element | null = null;
  let chromeDepth = 0;
  let mainDepth = 0;
  // visibility is inherited and can be overridden by descendants; text follows its parent element's computed value.
  const hiddenVis = new WeakSet<Element>();
  const invisibleText = new WeakMap<Element, boolean>();
  const inMain = new WeakSet<Item>();
  const push = (it: Item) => {
    if (chromeDepth > 0) it.chrome = true;
    if (mainDepth > 0) inMain.add(it);
    items.push(it);
  };

  const zoneOf = (r: DOMRect): Zone => {
    if (!layout) return Zone.In;
    if (r.bottom <= 0) return Zone.Above;
    if (r.top >= vh) return Zone.Below;
    if (r.right <= 0 || r.left >= vw) return Zone.Below;
    return Zone.In;
  };

  const flush = () => {
    if (!buf) return;
    const t = clean(buf, opts.textMax);
    buf = '';
    if (t.length < 2 || !/[\p{L}\p{N}]/u.test(t)) return;
    const prev = items[items.length - 1];
    if (prev && (prev.line === t || (prev.kind === 'el' && prev.line.includes(`"${t}"`)))) return;
    push({ kind: 'text', zone: bufZone, line: t, chrome: bufChrome || undefined, host: bufHost ?? undefined });
  };

  const visit = (node: Node, inControl: boolean, parentPointer: boolean) => {
    if (node.nodeType === 3) {
      if (inControl) return;
      const pe = (node as Text).parentElement;
      if (pe && hiddenVis.has(pe)) return;
      if (pe && layout) {
        let inv = invisibleText.get(pe);
        if (inv === undefined) invisibleText.set(pe, (inv = sameColorAsBackground(pe, win)));
        if (inv) return;
      }
      const v = node.nodeValue;
      if (!v) return;
      if (!buf) {
        const p = (node as Text).parentElement;
        bufZone = p ? zoneOf(p.getBoundingClientRect()) : Zone.In;
        bufChrome = chromeDepth > 0;
        bufHost = (node as Text).parentElement;
      }
      buf += v;
      return;
    }
    if (node.nodeType !== 1) {
      if (node.nodeType === 11) for (const c of flatChildren(node as ShadowRoot)) visit(c, inControl, parentPointer);
      return;
    }
    const el = node as Element;
    const tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return;
    const style = win.getComputedStyle(el);
    if (!style || !isRenderedStyle(style)) return;
    const rect = el.getBoundingClientRect();
    if (visuallyHidden(el, style, rect, win)) return;

    // Far off-screen subtrees: count their controls cheaply instead of walking them.
    if (layout && !opts.full && rect.height > 0 && style.position !== 'fixed' && style.position !== 'sticky') {
      if (rect.top > vh * 2.5 || rect.bottom < -vh * 1.5) {
        const n = el.querySelectorAll(INTERACTIVE_SELECTOR).length + (isNativeInteractive(el) ? 1 : 0);
        if (rect.top > 0) skippedBelow += n;
        else skippedAbove += n;
        return;
      }
    }

    const block = isBlock(el, style);
    if (block) flush();
    if (style.visibility === 'hidden' || style.visibility === 'collapse') hiddenVis.add(el);

    if (layout && (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 40) {
      const area = rect.width * rect.height;
      if (area > scrollerArea) {
        scrollerArea = area;
        scroller = el;
      }
    }

    if (tag === 'IFRAME' || tag === 'FRAME') {
      flush();
      if ((!layout || (rect.width > 40 && rect.height > 40)) && opts.getFrameId) {
        const fid = opts.getFrameId(el);
        if (fid > 0) push({ kind: 'frame', zone: zoneOf(rect), line: '', frameId: fid });
      }
      return;
    }

    const pointer = style.cursor === 'pointer';
    const role = roleOf(el);
    let control = false;
    let ctlRole = role;
    let ctlState: string | null = null;

    if (tag === 'LABEL') {
      // Custom checkboxes: the real input is visually hidden and the label is what a person clicks.
      const c = (el as HTMLLabelElement).control as HTMLInputElement | null;
      if (c && (c.type === 'checkbox' || c.type === 'radio') && !visiblyRendered(c, win)) {
        control = true;
        ctlRole = c.type;
        ctlState = c.checked ? 'checked' : 'unchecked';
        if (c.disabled) ctlState += ' disabled';
      }
    }
    if (!control && isNativeInteractive(el)) {
      // A real control nested in another control (a button inside a clickable card) is still its own target.
      control = !inControl || tag !== 'DIV' && tag !== 'SPAN' && tag !== 'LI';
    }
    if (!control && !inControl && pointer && !parentPointer && tag !== 'HTML' && tag !== 'BODY') {
      // Script-driven clickables (React onClick on a div) only reveal themselves through the pointer cursor.
      control = rect.width * rect.height > 0 || !layout;
      if (!ctlRole || ctlRole === 'heading') ctlRole = 'clickable';
    }

    if (control && shownSelf(el, style, rect)) {
      flush();
      if (tag === 'svg' || tag === 'SVG') ctlRole = ctlRole ?? 'clickable';
      const name = nameOf(el);
      const state = ctlState ?? stateOf(el, ctlRole);
      let line = ctlRole ?? 'clickable';
      if (name) line += ` "${name.replace(/"/g, "'")}"`;
      if (state) line += ' ' + state;
      push({ kind: 'el', zone: zoneOf(rect), line, el });
      if (tag === 'SELECT' || tag === 'svg' || tag === 'SVG' || tag === 'INPUT' || tag === 'TEXTAREA') return;
      for (const c of flatChildren(el)) visit(c, true, true);
      return;
    }

    if (tag === 'svg' || tag === 'SVG') return;

    if (role === 'heading' && !inControl) {
      flush();
      const lvl = Number(el.getAttribute('aria-level')) || Number(tag[1]) || 2;
      const t = nameOf(el, 100);
      if (t) push({ kind: 'head', zone: zoneOf(rect), line: t, level: lvl });
      for (const c of flatChildren(el)) visit(c, true, pointer);
      return;
    }

    const mark = !inControl ? landmarkOf(el) : null;
    const markAt = items.length;
    if (mark) {
      flush();
      push({ kind: 'mark', zone: zoneOf(rect), line: mark });
      if (/^main\b/.test(mark)) inMain.add(items[items.length - 1]);
    }
    const chrome = !!mark && /^(nav|header|footer|aside)\b/.test(mark);
    const isMain = !!mark && /^main\b/.test(mark);
    if (chrome) chromeDepth++;
    if (isMain) mainDepth++;
    for (const c of flatChildren(el)) visit(c, inControl, pointer);
    if (block || mark) flush();
    if (chrome) chromeDepth--;
    if (isMain) mainDepth--;
    // A landmark with nothing in it is noise.
    if (mark && items.length === markAt + 1) items.pop();
  };

  visit(root, false, false);
  flush();
  // With a main landmark on the page, everything outside it is chrome too (unlabelled sidebars, promo blocks).
  if (items.some(it => inMain.has(it))) for (const it of items) if (!inMain.has(it)) it.chrome = true;
  markInjection(items, root);
  return { items, scroller, skippedBelow, skippedAbove };
}

function visiblyRendered(el: Element, win: Window): boolean {
  const s = win.getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
  if (testLayout()) return true;
  const r = el.getBoundingClientRect();
  return r.width >= 4 && r.height >= 4;
}

const CONTAINERS = 'li,dd,td,th,blockquote,section,article,aside,form,dialog,[role=dialog],[role=alertdialog],fieldset,div';
const CONTROLS = 'a[href],button,input,select,textarea,[contenteditable=true],[role=button],[role=link],[role=switch],[role=checkbox],[role=radio],[role=menuitem],[role=tab],[role=option],[role=combobox],[onclick]';

/**
 * Flags lines that read as written to an AI agent, and taints the controls that share a block with them (a link inside
 * an injected paragraph, the buttons of an injected dialog). Tainted controls need the user's approval to act on.
 */
export function markInjection(items: Item[], root: Element): void {
  const blocks = new Set<Element>();
  for (const it of items) {
    if (it.kind !== 'text' && it.kind !== 'head' && it.kind !== 'el') continue;
    // Element lines are `role "name" state`: test the name itself too, so an instruction in an aria-label is caught
    // by patterns anchored at the start of a sentence.
    const name = it.kind === 'el' ? (/^\S+ "([^"]*)"/.exec(it.line)?.[1] ?? '') : '';
    if (!looksInjected(it.line) && !(name && looksInjected(name))) continue;
    it.flag = true;
    const own = it.kind === 'el' ? it.el : it.host;
    if (!own) continue;
    blocks.add(own);
    // The container around the injected text (its links, a dialog's buttons), when it is small enough to be one
    // unit; a page-wide wrapper is not tainted, or every control on the page would need approval.
    // Only when the injected text is most of that container: a page section (or a whole app shell) that merely
    // contains an injected line must not drag its legitimate controls (pagination, submit) under approval.
    const c = (own.parentElement ?? own).closest(CONTAINERS);
    const flaggedLen = (it.kind === 'el' ? name || it.line : own.textContent ?? it.line).trim().length;
    const cLen = (c?.textContent ?? '').trim().length;
    // On a small page the injected text can be half of everything, so a share alone is not enough: the rest of the
    // container must be little more than a caption ("Guest comment", "Close"), and it must not hold a heading (a
    // heading means a page section, not one injected block).
    const rest = cLen - flaggedLen;
    if (c && c !== root && c !== root.ownerDocument.body && c.querySelectorAll(CONTROLS).length <= 4 && cLen > 0 && flaggedLen / cLen >= 0.5 && rest <= 80 && !c.querySelector('h1,h2,h3,h4,[role=heading]')) blocks.add(c);
  }
  if (!blocks.size) return;
  for (const it of items) {
    if (it.kind !== 'el' || !it.el) continue;
    for (let p: Element | null = it.el; p && p !== root; p = p.parentElement) {
      if (blocks.has(p)) {
        it.flag = true;
        break;
      }
    }
  }
}
