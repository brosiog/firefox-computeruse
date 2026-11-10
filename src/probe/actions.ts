// Actions on the page. Firefox gives extensions no trusted-input API, so actions dispatch the full event sequence a
// person's input would produce (pointer, mouse, key, beforeinput/input/change) and then perform the default action
// that untrusted events do not trigger (focus moves, implicit form submission, select changes, scrolling).
// Every action is checked before dispatch and is dispatched at most once.

import type { Gate, ProbeResult, Risk, ScrollDir } from '../protocol';
import { clean, deepActive, isDisabled, isEditable, isSecretField, isTextField, nameOf, roleOf } from './dom';
import { describe } from './snapshot';
import { DISMISS } from './inject';

type Win = Window & typeof globalThis;

// ---------- risk classification (before dispatch) ----------

const PAY = /\b(pay|buy|purchase|place (your )?order|order now|complete order|subscribe|donate|book now|rent now|confirm (purchase|payment|order|booking)|add payment|upgrade)\b/i;
const DELETE = /\b(delete|remove|discard|erase|destroy|trash|archive all|empty trash|cancel (subscription|account|order|membership)|unsubscribe|close account|revoke)\b/i;
const WRITE = /\b(send|submit|post|publish|reply|comment|tweet|share|save|apply|sign up|signup|register|create|transfer|confirm|invite|upload|request|follow|like|vote|rsvp|schedule|merge|approve)\b/i;
const CONSENT = /cookie|consent|gdpr|privacy-banner|onetrust|cmp/i;
const SEARCH_NAMES = /^(q|query|search|s|k|keywords?|term|text|search_query|field-keywords)$/i;

function isSearchForm(form: HTMLFormElement | null, field?: Element | null): boolean {
  if (field && (field as HTMLInputElement).type === 'search') return true;
  if (field && roleOf(field) === 'searchbox') return true;
  if (field && SEARCH_NAMES.test(field.getAttribute('name') ?? '')) return true;
  if (!form) return false;
  if (form.getAttribute('role') === 'search' || form.closest('[role=search]')) return true;
  if ((form.method || 'get').toLowerCase() === 'get' && /search|find|query/i.test(form.action + ' ' + form.id + ' ' + form.className)) return true;
  return !!form.querySelector('input[type=search]');
}

function inConsentUi(el: Element): boolean {
  for (let p: Element | null = el; p; p = p.parentElement) {
    if (CONSENT.test(p.id + ' ' + (typeof p.className === 'string' ? p.className : ''))) return true;
  }
  return false;
}

/** A form that submits to another site than the page's: what is in it leaves the site. */
let topOrigin: string | null = null;
/** Set by the probe from the host: the origin of the tab's top page (frames cannot read it themselves). */
export function setTopOrigin(o: string | null) {
  topOrigin = o;
}

function crossSiteForm(form: HTMLFormElement | null): string | null {
  if (!form) return null;
  try {
    const target = new URL(form.action || form.ownerDocument.location.href, form.ownerDocument.location.href);
    if (!/^https?:$/.test(target.protocol)) return null;
    // Compared with the site the user is on: a third-party frame's own form counts as another site too.
    const site = topOrigin ?? form.ownerDocument.location.origin;
    return target.origin !== site ? target.host : null;
  } catch {
    return null;
  }
}

export function classifyClick(el: Element): Gate {
  const label = `${nameOf(el, 100)} ${el.getAttribute('value') ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
  const what = describe(el);
  const formOf = el.closest('form') as HTMLFormElement | null;
  const xs = crossSiteForm(formOf);
  if (xs && el.matches('button, input[type=submit], input[type=image], [role=button], a, [onclick]')) {
    return { risk: 'exfil', what: `${what}, which sends the form to another site (${xs})` };
  }
  if (inConsentUi(el)) return { risk: 'read', what };
  // A plain link to another page is navigation, whatever its label ("Proceed to checkout", "Delete account" settings
  // page). Script links (#, javascript:) can act, so they are judged by label like buttons.
  const a = el.closest('a[href]') as HTMLAnchorElement | null;
  if (a && !el.closest('button') && /^https?:/.test(a.href) && !/#$|#\/?$/.test(a.getAttribute('href') ?? '') && !a.hasAttribute('download')) {
    const href = a.getAttribute('href') ?? '';
    if (!href.startsWith('#') && !/^javascript:/i.test(href)) return { risk: 'read', what };
  }
  if (PAY.test(label)) return { risk: 'pay', what };
  if (DELETE.test(label)) return { risk: 'delete', what };
  const btn = el.closest('button, input[type=submit], input[type=image]') as HTMLButtonElement | HTMLInputElement | null;
  const form = btn?.form ?? null;
  const isSubmit = !!btn && (btn.type === 'submit' || btn.type === 'image') && !!form;
  if (isSubmit && isSearchForm(form)) return { risk: 'read', what };
  if (WRITE.test(label)) return { risk: 'write', what };
  if (isSubmit && (form!.method || '').toLowerCase() === 'post') return { risk: 'write', what };
  if (isSubmit) {
    // A submit button with an unrevealing label: judge by the form.
    return { risk: (form!.method || 'get').toLowerCase() === 'post' ? 'write' : 'read', what };
  }
  return { risk: 'read', what };
}

function classifyEnter(field: Element): Gate {
  const what = `Enter in ${describe(field)}`;
  const form = (field as HTMLInputElement).form ?? null;
  const xs = crossSiteForm(form);
  if (xs) return { risk: 'exfil', what: `${what}, which sends the form to another site (${xs})` };
  if (field.tagName === 'TEXTAREA' || isEditable(field)) {
    // Chat-style composers send on Enter.
    return isSearchForm(form, field) ? { risk: 'read', what } : { risk: 'write', what: `send via ${what}` };
  }
  if (!form) return { risk: isSearchForm(null, field) ? 'read' : 'read', what };
  if (isSearchForm(form, field)) return { risk: 'read', what };
  const submit = form.querySelector('button[type=submit], input[type=submit], button:not([type])');
  if (submit) {
    const g = classifyClick(submit);
    if (g.risk !== 'read') return { risk: g.risk, what: `${what}, which submits ${g.what}` };
  }
  return { risk: (form.method || 'get').toLowerCase() === 'post' ? 'write' : 'read', what: `${what} (submits a form)` };
}

// ---------- geometry and checks ----------

function center(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

function bringIntoView(el: Element, win: Win) {
  const r = el.getBoundingClientRect();
  if (r.top < 0 || r.bottom > win.innerHeight || r.left < 0 || r.right > win.innerWidth) {
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
  }
}

function coverNote(el: Element): string {
  const { x, y } = center(el);
  const root = el.getRootNode() as Document | ShadowRoot;
  const hit = (root.elementFromPoint ? root.elementFromPoint(x, y) : null) ?? el.ownerDocument.elementFromPoint(x, y);
  if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return '';
  const lbl = hit.closest('label');
  if (lbl && (lbl as HTMLLabelElement).control === el) return '';
  // Shadow hosts: elementFromPoint returns the host.
  if (hit.shadowRoot?.contains(el)) return '';
  return ` Note: it was covered by ${describe(hit)}; the event went to the element directly. If nothing happened, close what covers it.`;
}

// ---------- event dispatch ----------

function mouseInit(el: Element, win: Win, extra: MouseEventInit = {}): MouseEventInit {
  const { x, y } = center(el);
  return { bubbles: true, cancelable: true, composed: true, view: win, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, ...extra };
}

function hoverSeq(el: Element, win: Win) {
  const i = mouseInit(el, win, { buttons: 0 });
  el.dispatchEvent(new win.PointerEvent('pointerover', { ...i, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new win.PointerEvent('pointerenter', { ...i, bubbles: false, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new win.MouseEvent('mouseover', i));
  el.dispatchEvent(new win.MouseEvent('mouseenter', { ...i, bubbles: false }));
  el.dispatchEvent(new win.PointerEvent('pointermove', { ...i, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new win.MouseEvent('mousemove', i));
}

function clickSeq(el: Element, win: Win) {
  hoverSeq(el, win);
  const down = mouseInit(el, win, { buttons: 1, detail: 1 });
  const up = mouseInit(el, win, { buttons: 0, detail: 1 });
  const pd = el.dispatchEvent(new win.PointerEvent('pointerdown', { ...down, pointerType: 'mouse', isPrimary: true }));
  const md = pd && el.dispatchEvent(new win.MouseEvent('mousedown', down));
  if (md) focusFor(el);
  el.dispatchEvent(new win.PointerEvent('pointerup', { ...up, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new win.MouseEvent('mouseup', up));
  // Untrusted click events still run activation behavior (links navigate, checkboxes toggle, submit buttons submit).
  el.dispatchEvent(new win.MouseEvent('click', up));
}

function focusFor(el: Element) {
  const f = (el as HTMLElement).closest?.(
    'a[href],button,input,select,textarea,summary,[tabindex],[contenteditable=""],[contenteditable=true]',
  ) as HTMLElement | null;
  (f ?? (el as HTMLElement)).focus?.({ preventScroll: true });
}

const KEY_CODES: Record<string, number> = {
  Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ' ': 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37,
  ArrowRight: 39, PageUp: 33, PageDown: 34, Home: 36, End: 35,
};
const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter', tab: 'Tab', space: ' ', spacebar: ' ',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft',
  right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End',
};

interface KeySpec {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

export function parseKey(spec: string): KeySpec {
  const parts = spec.split('+').map(s => s.trim()).filter(Boolean);
  const k: KeySpec = { key: '', ctrl: false, shift: false, alt: false, meta: false };
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'ctrl' || l === 'control') k.ctrl = true;
    else if (l === 'shift') k.shift = true;
    else if (l === 'alt' || l === 'option') k.alt = true;
    else if (l === 'meta' || l === 'cmd' || l === 'command') k.meta = true;
    else k.key = KEY_ALIASES[l] ?? (p.length === 1 ? p : p[0].toUpperCase() + p.slice(1));
  }
  if (!k.key && spec.trim() === '+') k.key = '+';
  return k;
}

function codeFor(key: string): string {
  if (key.length === 1) {
    if (/[a-z]/i.test(key)) return 'Key' + key.toUpperCase();
    if (/[0-9]/.test(key)) return 'Digit' + key;
    if (key === ' ') return 'Space';
    return '';
  }
  return key;
}

function keyEvent(type: string, k: KeySpec, win: Win): KeyboardEvent {
  const code = KEY_CODES[k.key] ?? (k.key.length === 1 ? k.key.toUpperCase().charCodeAt(0) : 0);
  return new win.KeyboardEvent(type, {
    key: k.key, code: codeFor(k.key), keyCode: code, which: code, charCode: type === 'keypress' ? k.key.charCodeAt(0) : 0,
    ctrlKey: k.ctrl, shiftKey: k.shift, altKey: k.alt, metaKey: k.meta, bubbles: true, cancelable: true, composed: true, view: win,
  } as KeyboardEventInit);
}

/** keydown (+ keypress for printable keys); returns whether the page let the default action happen. */
function keyDown(target: Element, k: KeySpec, win: Win): boolean {
  const ok = target.dispatchEvent(keyEvent('keydown', k, win));
  if (ok && (k.key.length === 1 || k.key === 'Enter') && !k.ctrl && !k.meta) target.dispatchEvent(keyEvent('keypress', k, win));
  return ok;
}
function keyUp(target: Element, k: KeySpec, win: Win) {
  target.dispatchEvent(keyEvent('keyup', k, win));
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, v: string, win: Win) {
  // The prototype setter bypasses framework value trackers (React), so their input listeners see a real change.
  const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc?.set) desc.set.call(el, v);
  else el.value = v;
}

function inputEvent(el: Element, win: Win, inputType: string, data: string | null) {
  el.dispatchEvent(new win.InputEvent('input', { bubbles: true, composed: true, inputType, data }));
}

// ---------- actions ----------

export interface ActCtx {
  win: Win;
  doc: Document;
  approved: boolean;
  gated: (risk: Risk) => boolean;
  /** The element sits on page text written to AI agents. */
  isTainted?: (el: Element) => boolean;
}

/** Acting on an element that came with injected text is the user's call, except closing a dialog. */
function suspicious(el: Element, ctx: ActCtx, verb: string): Gate | null {
  // A link inside a frame embedded from another site (an ad, a "sponsored" box) leads where that site wants, not
  // where the user's page does: following one is the user's call.
  const a = el.closest('a[href]');
  const own = el.ownerDocument.location.origin;
  if (a && topOrigin && own !== topOrigin && own !== 'null') {
    return { risk: 'suspicious', what: `${verb} ${describe(el)}, a link inside a frame from another site (${el.ownerDocument.location.host})` };
  }
  if (!ctx.isTainted?.(el)) return null;
  if (DISMISS.test(nameOf(el, 40).trim())) return null;
  return { risk: 'suspicious', what: `${verb} ${describe(el)}, which is part of page text written to AI agents (possible prompt injection)` };
}

function withheld(g: Gate): ProbeResult {
  return { ok: false, error: `needs approval: ${g.what}`, gate: g };
}

/** The withheld result when this action needs approval first, else null. An action that is otherwise harmless (risk
 *  `read`) still asks, as `act`, when every action needs approval. */
function hold(g: Gate, ctx: ActCtx, verb: string): ProbeResult | null {
  if (ctx.approved) return null;
  if (ctx.gated(g.risk)) return withheld(g);
  if (g.risk === 'read' && ctx.gated('act')) return withheld({ risk: 'act', what: `${verb} ${g.what}` });
  return null;
}

export function click(el: Element, ctx: ActCtx): ProbeResult {
  const { win } = ctx;
  if (isDisabled(el)) return { ok: false, error: `${describe(el)} is disabled.` };
  const tag = el.tagName;
  if (tag === 'SELECT') return { ok: false, error: `${describe(el)} is a dropdown: use the select tool with the option text.` };
  if (tag === 'INPUT' && (el as HTMLInputElement).type === 'file') {
    return { ok: false, error: 'File pickers cannot be opened by the agent. Ask the user to choose the file.' };
  }
  const sus = suspicious(el, ctx, 'click');
  if (sus && !ctx.approved && ctx.gated('suspicious')) return withheld(sus);
  const held = hold(classifyClick(el), ctx, 'click');
  if (held) return held;

  // Links that open a new tab would hit the popup blocker; the host opens them as a tab instead.
  const a = el.closest('a[href]') as HTMLAnchorElement | null;
  if (a && (a.target === '_blank' || a.target === '_new') && /^https?:/.test(a.href)) {
    return { ok: true, msg: `opened link ${describe(a)} in a new tab`, openUrl: a.href };
  }
  bringIntoView(el, win);
  const note = coverNote(el);
  flash(el, ctx.doc);
  clickSeq(el, win);
  const after = toggledState(el);
  return { ok: true, msg: `clicked ${describe(el)}${after}.${note}` };
}

function toggledState(el: Element): string {
  const i = (el.tagName === 'LABEL' ? (el as HTMLLabelElement).control : el) as HTMLInputElement | null;
  if (i && i.tagName === 'INPUT' && (i.type === 'checkbox' || i.type === 'radio')) return `, now ${i.checked ? 'checked' : 'unchecked'}`;
  const ae = el.getAttribute('aria-expanded');
  if (ae) return `, now ${ae === 'true' ? 'expanded' : 'collapsed'}`;
  const ac = el.getAttribute('aria-checked');
  if (ac) return `, now ${ac === 'true' ? 'checked' : 'unchecked'}`;
  return optionPicked(el);
}

/** After picking an option of a custom listbox: whether it took, and what its opener shows now, so the model need
 *  not reopen the list to check. */
function optionPicked(el: Element): string {
  const opt = el.closest('[role=option]');
  const list = opt?.closest('[role=listbox]');
  if (!opt || !list) return '';
  const parts: string[] = [];
  if (opt.isConnected && opt.getAttribute('aria-selected') === 'true') parts.push(', now selected');
  const id = list.id;
  const doc = list.ownerDocument;
  const opener =
    (id && doc.querySelector(`[aria-controls="${CSS.escape(id)}"], [aria-owns="${CSS.escape(id)}"]`)) ||
    list.parentElement?.querySelector('[aria-haspopup=listbox], [role=combobox]');
  const shows = opener && opener !== list ? (opener.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  if (opener && shows) parts.push(`; ${describe(opener)} now shows "${shows}"`);
  return parts.join('');
}

/** `perKeyMax`: text up to this length is typed key by key (default 80); longer text is pasted. */
export function type(el: Element, text: string, clear: boolean, enter: boolean, ctx: ActCtx, perKeyMax = 80): ProbeResult {
  const { win, doc } = ctx;
  if (isDisabled(el)) return { ok: false, error: `${describe(el)} is disabled.` };
  const editable = isEditable(el) || (el as HTMLElement).isContentEditable;
  if (!isTextField(el) && !editable) {
    // Typing into a wrapper: use the first text field inside it.
    const inner = el.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable=""], [contenteditable=true]');
    if (inner) return type(inner, text, clear, enter, ctx, perKeyMax);
    return { ok: false, error: `${describe(el)} is not a text field. Click it first if it opens one.` };
  }
  if ((el as HTMLInputElement).readOnly) return { ok: false, error: `${describe(el)} is read-only.` };
  if (isSecretField(el) && !ctx.approved && ctx.gated('secret')) return withheld({ risk: 'secret', what: `type into ${describe(el)}` });
  const sus = suspicious(el, ctx, 'type into');
  if (sus && !ctx.approved && ctx.gated('suspicious')) return withheld(sus);
  const held = (enter && hold(classifyEnter(el), ctx, 'type, then press')) || hold({ risk: 'read', what: `into ${describe(el)}` }, ctx, 'type');
  if (held) return held;

  bringIntoView(el, win);
  flash(el, doc);
  if (deepActive(doc) !== el) {
    clickSeq(el, win);
    (el as HTMLElement).focus?.({ preventScroll: true });
  }

  if (editable) {
    const host = el as HTMLElement;
    const sel = win.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(host);
    if (!clear) range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
    if (clear && host.textContent) doc.execCommand('delete', false);
    // execCommand produces beforeinput/input events editors (ProseMirror, Lexical, Draft) understand.
    const ok = doc.execCommand('insertText', false, text);
    if (!ok || !host.textContent?.includes(text.slice(0, 20))) {
      if (clear) host.textContent = '';
      host.append(doc.createTextNode(text));
      inputEvent(host, win, 'insertText', text);
    }
  } else {
    const f = el as HTMLInputElement | HTMLTextAreaElement;
    if (clear && f.value) {
      f.select?.();
      setNativeValue(f, '', win);
      inputEvent(f, win, 'deleteContentBackward', null);
    }
    // Per-key events for short text so autocompletes and validators react as they do for a person.
    if (text.length <= perKeyMax) {
      for (const ch of text) {
        const k: KeySpec = { key: ch === '\n' ? 'Enter' : ch, ctrl: false, shift: ch !== ch.toLowerCase(), alt: false, meta: false };
        const go = keyDown(f, k, win);
        if (go) {
          const bi = f.dispatchEvent(new win.InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: ch }));
          if (bi) {
            setNativeValue(f, f.value + ch, win);
            inputEvent(f, win, 'insertText', ch);
          }
        }
        keyUp(f, k, win);
      }
    } else {
      f.dispatchEvent(new win.InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'insertFromPaste', data: text }));
      setNativeValue(f, f.value + text, win);
      inputEvent(f, win, 'insertFromPaste', text);
    }
    f.dispatchEvent(new win.Event('change', { bubbles: true }));
  }

  const shown = isSecretField(el) ? '•••' : clean(isTextField(el) ? (el as HTMLInputElement).value : el.textContent, 60);
  let msg = `typed into ${describe(el)}; value is now "${shown}"`;
  if (enter) msg += '; ' + pressEnter(el, ctx);
  return { ok: true, msg: msg + '.' };
}

function pressEnter(el: Element, ctx: ActCtx): string {
  const { win } = ctx;
  const k = parseKey('Enter');
  const go = keyDown(el, k, win);
  keyUp(el, k, win);
  if (!go) return 'pressed Enter (handled by the page)';
  if (el.tagName === 'INPUT') {
    const form = (el as HTMLInputElement).form;
    if (form) {
      const submitter = form.querySelector('button[type=submit], input[type=submit], button:not([type])') as HTMLElement | null;
      try {
        if (submitter && !isDisabled(submitter)) form.requestSubmit(submitter as HTMLButtonElement);
        else form.requestSubmit();
      } catch {
        form.submit();
      }
      return 'pressed Enter and submitted the form';
    }
  }
  return 'pressed Enter';
}

export function select(el: Element, option: string, ctx: ActCtx): ProbeResult {
  const { win } = ctx;
  if (el.tagName !== 'SELECT') {
    const inner = el.querySelector('select');
    if (inner) return select(inner, option, ctx);
    return { ok: false, error: `${describe(el)} is not a native dropdown. Click it to open it, then click the option.` };
  }
  const s = el as HTMLSelectElement;
  if (s.disabled) return { ok: false, error: `${describe(el)} is disabled.` };
  const want = option.trim().toLowerCase();
  const opts = Array.from(s.options);
  const o =
    opts.find(x => x.text.trim().toLowerCase() === want) ??
    opts.find(x => x.value.toLowerCase() === want) ??
    opts.find(x => x.text.toLowerCase().includes(want)) ??
    opts.find(x => want.includes(x.text.trim().toLowerCase()) && x.text.trim().length > 1);
  if (!o) {
    return { ok: false, error: `No option "${option}" in ${describe(el)}. Options: ${opts.slice(0, 30).map(x => clean(x.text, 30)).join(' | ')}` };
  }
  if (o.disabled) return { ok: false, error: `Option "${clean(o.text, 40)}" is disabled.` };
  const held = hold({ risk: 'read', what: `"${clean(o.text, 60)}" in ${describe(el)}` }, ctx, 'select');
  if (held) return held;
  flash(el, ctx.doc);
  s.focus({ preventScroll: true });
  o.selected = true;
  s.dispatchEvent(new win.Event('input', { bubbles: true }));
  s.dispatchEvent(new win.Event('change', { bubbles: true }));
  return { ok: true, msg: `selected "${clean(o.text, 60)}" in ${describe(el)}.` };
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([type=hidden]):not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"]),[contenteditable=""],[contenteditable=true]';

export function key(target: Element | null, spec: string, ctx: ActCtx): ProbeResult {
  const { win, doc } = ctx;
  const k = parseKey(spec);
  if (!k.key) return { ok: false, error: `Unknown key "${spec}". Use names like Enter, Escape, Tab, ArrowDown, PageDown, Control+a.` };
  const el = target ?? deepActive(doc) ?? doc.body;
  if (target) (target as HTMLElement).focus?.({ preventScroll: true });
  const field = el && (isTextField(el) || isEditable(el));
  const on = el === doc.body ? 'the page' : describe(el);
  if (k.key === 'Enter' && !k.ctrl && !k.meta && el && field) {
    const held = hold(classifyEnter(el), ctx, 'press');
    if (held) return held;
    return { ok: true, msg: pressEnter(el, ctx) + '.' };
  }
  if (k.key === 'Enter' || k.key === ' ') {
    const role = roleOf(el);
    if (role && /^(button|link|menuitem|option|tab|checkbox|radio|switch|treeitem)/.test(role) && !(k.key === ' ' && role === 'link')) {
      const held = hold(classifyClick(el), ctx, `press ${spec} on`);
      if (held) return held;
    }
  }
  const held = hold({ risk: 'read', what: on }, ctx, `press ${spec} on`);
  if (held) return held;
  const go = keyDown(el, k, win);
  let effect = '';
  if (go) effect = defaultKeyAction(el, k, ctx);
  keyUp(el, k, win);
  return { ok: true, msg: `pressed ${spec} on ${on}${go ? effect : ' (handled by the page)'}.` };
}

function defaultKeyAction(el: Element, k: KeySpec, ctx: ActCtx): string {
  const { win, doc } = ctx;
  const role = roleOf(el);
  switch (k.key) {
    case 'Tab': {
      const all = Array.from(doc.querySelectorAll(FOCUSABLE)).filter(e => (e as HTMLElement).offsetParent !== null || e === el);
      const i = all.indexOf(el);
      const next = all[(i + (k.shift ? -1 : 1) + all.length) % all.length] as HTMLElement | undefined;
      next?.focus();
      return next ? `; focus moved to ${describe(next)}` : '';
    }
    case 'Enter':
    case ' ':
      if (role && /^(button|link|menuitem|option|tab|checkbox|radio|switch|treeitem|clickable)/.test(role)) {
        if (k.key === ' ' && role === 'link') break;
        el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: win, detail: 0 }));
        return `; activated ${describe(el)}`;
      }
      if (k.key === ' ' && !isTextField(el)) return scrollMain(doc, k.shift ? 'up' : 'down', 0.9, win);
      break;
    case 'ArrowDown':
    case 'ArrowUp':
      if (el.tagName === 'SELECT') {
        const s = el as HTMLSelectElement;
        s.selectedIndex = Math.max(0, Math.min(s.options.length - 1, s.selectedIndex + (k.key === 'ArrowDown' ? 1 : -1)));
        s.dispatchEvent(new win.Event('change', { bubbles: true }));
        return `; now "${clean(s.selectedOptions[0]?.text, 40)}"`;
      }
      if (!isTextField(el) && !isEditable(el) && !role?.match(/combobox|listbox|menu|grid|tree|slider/)) {
        return scrollMain(doc, k.key === 'ArrowDown' ? 'down' : 'up', 0.15, win);
      }
      break;
    case 'PageDown':
    case 'PageUp':
      return scrollMain(doc, k.key === 'PageDown' ? 'down' : 'up', 0.9, win);
    case 'Home':
    case 'End':
      if (!isTextField(el)) return scrollMain(doc, k.key === 'End' ? 'down' : 'up', 1000, win);
      break;
    case 'Backspace':
      if (isTextField(el)) {
        const f = el as HTMLInputElement;
        setNativeValue(f, f.value.slice(0, -1), win);
        inputEvent(f, win, 'deleteContentBackward', null);
        return `; value is now "${isSecretField(el) ? '•••' : clean(f.value, 40)}"`;
      }
      break;
    case 'a':
      if ((k.ctrl || k.meta) && isTextField(el)) {
        (el as HTMLInputElement).select();
        return '; selected all text';
      }
      break;
  }
  return '';
}

function scrollableAncestor(el: Element, win: Win): Element | null {
  for (let p: Element | null = el; p; p = p.parentElement) {
    const s = win.getComputedStyle(p);
    if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && p.scrollHeight > p.clientHeight + 4) return p;
    if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && p.scrollWidth > p.clientWidth + 4) return p;
  }
  return null;
}

export function mainScroller(doc: Document, win: Win): Element {
  const se = doc.scrollingElement ?? doc.documentElement;
  if (se.scrollHeight > se.clientHeight + 40) return se;
  // App layouts often scroll an inner pane: pick the largest scrollable element.
  let best: Element = se;
  let area = 0;
  for (const el of Array.from(doc.querySelectorAll('div, main, section, ul, article'))) {
    if (el.scrollHeight <= el.clientHeight + 40) continue;
    const s = win.getComputedStyle(el);
    if (s.overflowY !== 'auto' && s.overflowY !== 'scroll') continue;
    const a = el.clientWidth * el.clientHeight;
    if (a > area) {
      area = a;
      best = el;
    }
  }
  return best;
}

function scrollMain(doc: Document, dir: ScrollDir, pages: number, win: Win): string {
  return '; ' + scrollEl(mainScroller(doc, win), dir, pages, doc, win);
}

function scrollEl(sc: Element, dir: ScrollDir, pages: number, doc: Document, win: Win): string {
  const isDoc = sc === doc.scrollingElement || sc === doc.documentElement;
  const vert = dir === 'up' || dir === 'down';
  const view = vert ? (isDoc ? win.innerHeight : sc.clientHeight) : isDoc ? win.innerWidth : sc.clientWidth;
  const sign = dir === 'down' || dir === 'right' ? 1 : -1;
  const before = vert ? (isDoc ? win.scrollY : sc.scrollTop) : isDoc ? win.scrollX : sc.scrollLeft;
  const delta = sign * Math.max(40, Math.round(view * pages));
  const opts = { [vert ? 'top' : 'left']: delta, behavior: 'instant' } as ScrollToOptions;
  if (isDoc) win.scrollBy(opts);
  else sc.scrollBy(opts);
  const after = vert ? (isDoc ? win.scrollY : sc.scrollTop) : isDoc ? win.scrollX : sc.scrollLeft;
  const max = vert ? sc.scrollHeight - view : sc.scrollWidth - view;
  const where = after <= 0 ? 'at the top' : after >= max - 2 ? 'at the end' : `${Math.round((after / Math.max(1, max)) * 100)}% ${vert ? 'down' : 'across'}`;
  if (Math.abs(after - before) < 2) return `could not scroll ${dir}: already ${sign > 0 ? 'at the end' : 'at the start'}`;
  return `scrolled ${dir}${isDoc ? '' : ` in ${describe(sc)}`}; now ${where}`;
}

export function scroll(target: Element | null, dir: ScrollDir, pages: number, ctx: ActCtx): ProbeResult {
  const { win, doc } = ctx;
  const sc = target ? (scrollableAncestor(target, win) ?? mainScroller(doc, win)) : mainScroller(doc, win);
  return { ok: true, msg: scrollEl(sc, dir, pages, doc, win) + '.' };
}

export function hover(el: Element, ctx: ActCtx): ProbeResult {
  bringIntoView(el, ctx.win);
  flash(el, ctx.doc);
  hoverSeq(el, ctx.win);
  // Synthetic mouse events cannot trigger CSS :hover. Focus opens :focus-within menus, the usual accessible twin.
  const f = (el as HTMLElement).closest?.('[tabindex],a[href],button') as HTMLElement | null;
  f?.focus({ preventScroll: true });
  return {
    ok: true,
    msg: `hovered ${describe(el)}. If a menu should have opened and did not, it may open only on a real mouse hover: use find with the menu item's text (it lists links inside closed menus).`,
  };
}

/** Resolves when the DOM has been quiet for `quietMs`, or after `maxMs`. */
export function settle(doc: Document, quietMs: number, maxMs: number): Promise<string> {
  return new Promise(resolve => {
    const start = performance.now();
    let last = start;
    let count = 0;
    // The agent's own highlight box (appended, then faded 700 ms later) must not count as the page reacting: it used
    // to keep resetting the quiet timer.
    const ours = (n: Node | null) => !!n && n.nodeType === 1 && ((n as Element).id === FLASH_ID || (n as Element).id === MARKS_ID);
    const mo = new MutationObserver(recs => {
      const real = recs.filter(r => !ours(r.target) && !(r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every(ours)));
      if (!real.length) return;
      count += real.length;
      last = performance.now();
    });
    mo.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
    const tick = () => {
      const now = performance.now();
      if (now - last >= quietMs || now - start >= maxMs) {
        mo.disconnect();
        resolve(now - start >= maxMs ? `still changing after ${Math.round(maxMs)}ms` : `quiet after ${Math.round(now - start)}ms`);
        return;
      }
      setTimeout(tick, 50);
    };
    setTimeout(tick, Math.min(quietMs, 100));
    void count;
  });
}

// ---------- visual feedback ----------

const FLASH_ID = '__fcu_flash';
export const MARKS_ID = '__fcu_marks';

export function flash(el: Element, doc: Document) {
  try {
    const r = el.getBoundingClientRect();
    let box = doc.getElementById(FLASH_ID) as HTMLDivElement | null;
    if (!box) {
      box = doc.createElement('div');
      box.id = FLASH_ID;
      box.setAttribute('aria-hidden', 'true');
      box.style.cssText =
        'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #ff6a00;border-radius:4px;box-shadow:0 0 0 4px rgba(255,106,0,.25);transition:opacity .4s;';
      (doc.body ?? doc.documentElement).appendChild(box);
    }
    Object.assign(box.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px`, opacity: '1' });
    const b = box;
    setTimeout(() => (b.style.opacity = '0'), 700);
  } catch {
    // Feedback only.
  }
}
