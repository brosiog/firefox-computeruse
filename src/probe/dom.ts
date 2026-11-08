// DOM semantics for the probe: roles, accessible names, state, visibility. Pure functions over the live DOM.

export const testLayout = () => (globalThis as { __fcuTestLayout?: boolean }).__fcuTestLayout === true;

export const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'BASE', 'TITLE', 'OBJECT', 'EMBED', 'PARAM',
  'SOURCE', 'TRACK', 'MAP', 'AREA', 'BR', 'WBR', 'HR', 'CANVAS', 'AUDIO',
]);

export const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
  'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem',
]);

const LANDMARKS: Record<string, string> = {
  NAV: 'nav', MAIN: 'main', HEADER: 'header', FOOTER: 'footer', ASIDE: 'aside', FORM: 'form', DIALOG: 'dialog',
};
const LANDMARK_ROLES = new Set(['navigation', 'main', 'banner', 'contentinfo', 'complementary', 'form', 'dialog', 'alertdialog', 'search', 'region', 'menu', 'listbox', 'tablist']);
const ROLE_SHORT: Record<string, string> = { navigation: 'nav', banner: 'header', contentinfo: 'footer', complementary: 'aside' };

const TEXT_INPUT_TYPES = new Set(['', 'text', 'email', 'tel', 'url', 'search', 'password', 'number']);

export function clean(s: string | null | undefined, max = 80): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function explicitRole(el: Element): string | null {
  const r = el.getAttribute('role');
  return r ? r.trim().split(/\s+/)[0].toLowerCase() : null;
}

export function implicitRole(el: Element): string | null {
  const tag = el.tagName;
  switch (tag) {
    case 'A':
      return el.hasAttribute('href') ? 'link' : null;
    case 'BUTTON':
      return 'button';
    case 'SELECT':
      return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox';
    case 'TEXTAREA':
      return 'textbox';
    case 'SUMMARY':
      return 'button';
    case 'OPTION':
      return 'option';
    case 'INPUT': {
      const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
      if (t === 'hidden') return null;
      if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return 'searchbox';
      if (t === 'password') return 'password';
      if (t === 'file') return 'file';
      if (TEXT_INPUT_TYPES.has(t)) return 'textbox';
      return t; // date, time, color, ...
    }
  }
  if (/^H[1-6]$/.test(tag)) return 'heading';
  return null;
}

export function roleOf(el: Element): string | null {
  const r = explicitRole(el);
  if (r && r !== 'presentation' && r !== 'none' && r !== 'generic') return r;
  return implicitRole(el);
}

export function isEditable(el: Element): boolean {
  const ce = el.getAttribute('contenteditable');
  if (ce === '' || ce === 'true' || ce === 'plaintext-only') {
    // Only the editing host, not every descendant of it.
    const p = el.parentElement;
    return !(p && (p as HTMLElement).isContentEditable);
  }
  return false;
}

export function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
  return TEXT_INPUT_TYPES.has(t) || t === 'date' || t === 'time' || t === 'datetime-local' || t === 'month' || t === 'week';
}

export function isDisabled(el: Element): boolean {
  if ((el as HTMLButtonElement).disabled) return true;
  if (el.getAttribute('aria-disabled') === 'true') return true;
  const fs = el.closest('fieldset[disabled]');
  return !!fs && !fs.querySelector(':scope > legend')?.contains(el);
}

/** Native controls and ARIA widgets. The cursor heuristic is applied separately by the walker. */
export function isNativeInteractive(el: Element): boolean {
  const tag = el.tagName;
  if (tag === 'A') return el.hasAttribute('href');
  if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY') return true;
  if (tag === 'INPUT') return (el as HTMLInputElement).type !== 'hidden';
  if (isEditable(el)) return true;
  const r = explicitRole(el);
  if (r && INTERACTIVE_ROLES.has(r)) return true;
  const ti = el.getAttribute('tabindex');
  if (ti !== null && Number(ti) >= 0 && tag !== 'BODY' && tag !== 'HTML') {
    // Focusable containers (dialogs, scroll panes) are not controls.
    return !(r && LANDMARK_ROLES.has(r)) && tag !== 'DIALOG' && tag !== 'MAIN' && tag !== 'SECTION' && tag !== 'ARTICLE';
  }
  return false;
}

export function landmarkOf(el: Element): string | null {
  const r = explicitRole(el);
  let kind: string | null = null;
  if (r && LANDMARK_ROLES.has(r)) kind = ROLE_SHORT[r] ?? r;
  else if (LANDMARKS[el.tagName]) kind = LANDMARKS[el.tagName];
  if (!kind) return null;
  if (kind === 'header' || kind === 'footer') {
    // Only page-level header/footer are landmarks.
    if (el.closest('article, aside, main, nav, section') && !r) return null;
  }
  if (kind === 'region' && !el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) return null;
  const label = clean(el.getAttribute('aria-label') || labelledBy(el), 40);
  return label ? `${kind} "${label}"` : kind;
}

function labelledBy(el: Element): string {
  const ids = el.getAttribute('aria-labelledby');
  if (!ids) return '';
  const root = el.getRootNode() as Document | ShadowRoot;
  return ids
    .split(/\s+/)
    .map(id => (root.getElementById ? root.getElementById(id) : null)?.textContent ?? '')
    .join(' ');
}

function textOf(el: Element): string {
  // innerText respects CSS visibility; textContent is the fallback for detached/test layouts.
  const t = (el as HTMLElement).innerText;
  return typeof t === 'string' && !testLayout() ? t : el.textContent ?? '';
}

export function nameOf(el: Element, max = 80): string {
  let n = clean(el.getAttribute('aria-label'), max) || clean(labelledBy(el), max);
  if (n) return n;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
    const input = el as HTMLInputElement;
    const t = (input.type || '').toLowerCase();
    if (t === 'submit' || t === 'button' || t === 'reset') return clean(input.value || (t === 'submit' ? 'Submit' : ''), max);
    if (t === 'image') return clean(input.alt || input.value || 'Submit', max);
    const labels = input.labels;
    if (labels && labels.length) {
      n = clean(Array.from(labels).map(l => textOf(l)).join(' '), max);
      if (n) return n;
    }
    n = clean(input.getAttribute('placeholder') || input.title || input.getAttribute('name'), max);
    return n;
  }
  if (tag === 'IMG') return clean((el as HTMLImageElement).alt || el.getAttribute('title'), max);
  n = clean(textOf(el), max);
  if (n) return n;
  // Icon buttons: look for an accessible label on a descendant image/svg.
  const img = el.querySelector('img[alt], svg[aria-label], [title], svg title');
  if (img) {
    n = clean(img.getAttribute('alt') || img.getAttribute('aria-label') || img.getAttribute('title') || img.textContent, max);
    if (n) return n;
  }
  return clean(el.getAttribute('title') || el.getAttribute('data-tooltip') || el.getAttribute('name'), max);
}

/** Fields whose values the model must never see. */
export function isSecretField(el: Element): boolean {
  if (el.tagName !== 'INPUT') return false;
  const i = el as HTMLInputElement;
  if (i.type === 'password') return true;
  const ac = (i.getAttribute('autocomplete') || '').toLowerCase();
  return /cc-number|cc-csc|cc-exp|one-time-code|new-password|current-password/.test(ac);
}

export function stateOf(el: Element, role: string | null): string {
  const parts: string[] = [];
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    const i = el as HTMLInputElement;
    const t = (i.type || '').toLowerCase();
    if (t === 'checkbox' || t === 'radio') parts.push(i.checked ? 'checked' : 'unchecked');
    else if (t !== 'submit' && t !== 'button' && t !== 'reset' && t !== 'image' && t !== 'file') {
      if (isSecretField(el)) parts.push(i.value ? 'value=•••' : 'empty');
      else parts.push(i.value ? `value="${clean(i.value, 40)}"` : 'empty');
    }
  } else if (tag === 'SELECT') {
    const s = el as HTMLSelectElement;
    const sel = s.selectedOptions[0];
    parts.push(`value="${clean(sel?.textContent, 30)}"`);
    if (s.options.length <= 8) {
      parts.push('options: ' + Array.from(s.options, o => clean(o.textContent, 20)).filter(Boolean).join('|'));
    } else parts.push(`${s.options.length} options`);
  } else if (isEditable(el)) {
    const v = clean(el.textContent, 40);
    parts.push(v ? `value="${v}"` : 'empty');
  }
  const ac = el.getAttribute('aria-checked');
  if (ac && tag !== 'INPUT') parts.push(ac === 'true' ? 'checked' : ac === 'mixed' ? 'mixed' : 'unchecked');
  const ae = el.getAttribute('aria-expanded');
  if (ae) parts.push(ae === 'true' ? 'expanded' : 'collapsed');
  if (el.getAttribute('aria-selected') === 'true') parts.push('selected');
  if (el.getAttribute('aria-pressed') === 'true') parts.push('pressed');
  if (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') parts.push('current');
  if (role === 'slider' || role === 'spinbutton') {
    const v = el.getAttribute('aria-valuenow');
    if (v && tag !== 'INPUT') parts.push(`value=${v}`);
  }
  if (isDisabled(el)) parts.push('disabled');
  const doc = el.ownerDocument;
  if (doc && deepActive(doc) === el) parts.push('focused');
  return parts.join(' ');
}

export function deepActive(doc: Document): Element | null {
  let a: Element | null = doc.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

/** Shadow root including closed ones: Firefox gives content scripts `openOrClosedShadowRoot`. */
export function shadowOf(el: Element): ShadowRoot | null {
  const anyEl = el as Element & { openOrClosedShadowRoot?: ShadowRoot | null };
  return anyEl.openOrClosedShadowRoot ?? el.shadowRoot ?? null;
}

/** Children in rendered (flat tree) order: shadow content with slots resolved, else light children. */
export function flatChildren(node: Element | ShadowRoot | Document): Node[] {
  if ((node as Node).nodeType === 1) {
    const el = node as Element;
    if (el.tagName === 'SLOT') {
      const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
      return assigned.length ? assigned : Array.from(el.childNodes);
    }
    const sr = shadowOf(el);
    if (sr) return Array.from(sr.childNodes);
  }
  return Array.from(node.childNodes);
}

/** Whether the element participates in rendering at all (not display:none etc.). Prunes subtrees. */
export function isRenderedStyle(style: CSSStyleDeclaration): boolean {
  if (style.display === 'none') return false;
  if (style.contentVisibility === 'hidden') return false;
  if (style.opacity === '0') return false;
  return true;
}

export function shownSelf(el: Element, style: CSSStyleDeclaration, rect: DOMRect): boolean {
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (testLayout()) return true;
  if (style.display === 'contents') return true;
  if (rect.width * rect.height < 4) {
    // Overflow-visible zero-size wrappers still show their children; the element itself is not a target.
    return false;
  }
  if (el.getAttribute('aria-hidden') === 'true') return false;
  return true;
}

const INLINE_TAGS = new Set(['A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DFN', 'EM', 'I', 'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'LABEL', 'IMG', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

/** Block boundaries break text runs. Test DOMs (no layout engine) fall back to tag defaults. */
export function isBlock(el: Element, style: CSSStyleDeclaration): boolean {
  if (testLayout()) return !INLINE_TAGS.has(el.tagName);
  return !style.display.startsWith('inline') && style.display !== 'contents';
}
