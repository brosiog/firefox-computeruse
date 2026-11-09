// Sign-in fields, for password-manager fills. Finding them reports only which fields exist; filling marks every field it
// fills as secret (dom.vaultFilled), so the username is masked in later page states too, like the password.

import type { LoginForm, ProbeResult } from '../protocol';
import * as act from './actions';
import { isDisabled, shadowOf, testLayout, vaultFilled } from './dom';

export interface LoginFields {
  user?: HTMLInputElement;
  pass?: HTMLInputElement;
  /** One field, or one box per digit. */
  otp?: HTMLInputElement[];
  /** Set when the page has fields, but not ones this should fill (sign-up, change password). */
  refuse?: string;
}

const USERISH = /user|e-?mail|login|account|ident|phone|mobile/i;
const OTPISH = /otp|totp|2fa|mfa|one.?time|verification.?code|security.?code|auth\w*.?code|passcode|\bcode\b|token/i;
const NOT_USER = /search|captcha|coupon|promo|zip|postal|query/i;
const TEXTY = new Set(['', 'text', 'email', 'tel']);

function inputsUnder(root: Document | Element | ShadowRoot): HTMLInputElement[] {
  const out: HTMLInputElement[] = [];
  const visit = (r: Document | Element | ShadowRoot) => {
    for (const el of Array.from(r.querySelectorAll('*'))) {
      if (el.tagName === 'INPUT') out.push(el as HTMLInputElement);
      const sr = shadowOf(el);
      if (sr) visit(sr);
    }
  };
  if ((root as Element).tagName === 'INPUT') out.push(root as HTMLInputElement);
  visit(root);
  return out;
}

function usable(i: HTMLInputElement): boolean {
  if (i.type === 'hidden' || isDisabled(i) || i.readOnly) return false;
  if (testLayout()) return true;
  const r = i.getBoundingClientRect();
  if (r.width * r.height < 4) return false;
  const v = (i as HTMLElement & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (v && !v.call(i, { visibilityProperty: true, opacityProperty: true })) return false;
  return true;
}

const hints = (i: HTMLInputElement) =>
  `${i.name} ${i.id} ${i.getAttribute('aria-label') ?? ''} ${i.placeholder ?? ''} ${i.getAttribute('autocomplete') ?? ''}`;
const ac = (i: HTMLInputElement) => (i.getAttribute('autocomplete') ?? '').toLowerCase();
const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

function isOtp(i: HTMLInputElement): boolean {
  if (!TEXTY.has(i.type) && i.type !== 'number' && i.type !== 'password') return false;
  if (ac(i).includes('one-time-code')) return true;
  return OTPISH.test(hints(i)) && !USERISH.test(`${i.name} ${i.id}`);
}

/** The sign-in fields in the form around `near` (a ref the agent gave), or in the whole frame. */
export function findLoginFields(doc: Document, near?: Element): LoginFields {
  const scope: Element | Document = near?.closest('form') ?? (near && near.tagName !== 'INPUT' ? near : null) ?? doc;
  const all = inputsUnder(scope).filter(usable);
  const otpAll = all.filter(isOtp);
  const otp = otpAll.length > 1 && otpAll.every(i => i.maxLength === 1) ? otpAll : otpAll.slice(0, 1);
  const pw = all.filter(i => i.type === 'password' && !otp.includes(i));
  const out: LoginFields = {};
  if (otp.length) out.otp = otp;

  if (pw.length) {
    // Prefer the password field the agent pointed at, else one in the same form as the others.
    const pass = (near && pw.includes(near as HTMLInputElement) ? (near as HTMLInputElement) : pw[0])!;
    const form = pass.form;
    const sameForm = pw.filter(p => p.form === form);
    if (sameForm.length > 1) {
      return { refuse: 'this looks like a sign-up or change-password form (more than one password field), not a sign-in form' };
    }
    out.pass = pass;
    const cands = all.filter(i => TEXTY.has(i.type) && i !== pass && !otp.includes(i) && (form ? i.form === form : true) && before(i, pass) && !NOT_USER.test(hints(i)));
    out.user =
      cands.find(i => /username|email/.test(ac(i))) ??
      cands.find(i => i.type === 'email' || USERISH.test(hints(i))) ??
      cands[cands.length - 1];
    return out;
  }

  // No password field: a username-first page, or a one-time-code page.
  const cands = all.filter(i => TEXTY.has(i.type) && !otp.includes(i) && !NOT_USER.test(hints(i)));
  const pointed = near && cands.includes(near as HTMLInputElement) ? (near as HTMLInputElement) : undefined;
  out.user =
    cands.find(i => /username|email/.test(ac(i))) ??
    cands.find(i => i.type === 'email' || USERISH.test(hints(i))) ??
    pointed;
  return out;
}

export function loginForm(doc: Document, near?: Element): ProbeResult {
  const f = findLoginFields(doc, near);
  if (f.refuse) return { ok: false, error: f.refuse };
  const form: LoginForm = { url: doc.defaultView?.location.href ?? doc.URL, user: !!f.user, pass: !!f.pass, otp: !!f.otp?.length };
  return { ok: true, msg: 'ok', form };
}

export interface FillCmd {
  origin: string;
  username?: string;
  password?: string;
  totp?: string;
  enter: boolean;
}

/** Fills what it was given into the fields found again now. Values never appear in the receipt. */
export function fillLogin(doc: Document, near: Element | undefined, c: FillCmd, ctx: act.ActCtx): ProbeResult {
  const origin = doc.defaultView?.location.origin ?? '';
  if (origin !== c.origin) return { ok: false, error: `the page is no longer on ${c.origin} (now ${origin}); nothing was filled.` };
  const f = findLoginFields(doc, near);
  if (f.refuse) return { ok: false, error: f.refuse };
  const jobs: [HTMLInputElement, string, string][] = [];
  if (f.user && c.username) jobs.push([f.user, c.username, 'username']);
  if (f.pass && c.password) jobs.push([f.pass, c.password, 'password']);
  if (f.otp?.length && c.totp) {
    if (f.otp.length > 1) f.otp.forEach((box, i) => c.totp![i] !== undefined && jobs.push([box, c.totp![i], i ? '' : 'one-time code']));
    else jobs.push([f.otp[0], c.totp, 'one-time code']);
  }
  if (!jobs.length) return { ok: false, error: 'found no sign-in field to fill on this page.' };
  // Approved by the user before the vault was read; the probe's own gates must not ask again per field.
  const fillCtx: act.ActCtx = { ...ctx, approved: true, gated: () => false };
  let tail = '';
  for (const [k, [el, value]] of jobs.entries()) {
    vaultFilled.add(el);
    const last = k === jobs.length - 1;
    const r = act.type(el, value, true, last && c.enter, fillCtx);
    if (!r.ok) return { ok: false, error: `could not fill the ${jobs[k][2] || 'one-time code'} field: ${r.error}` };
    if (last && c.enter) tail = /pressed Enter[^.;]*/.exec(r.msg)?.[0] ?? '';
  }
  const what = jobs.map(j => j[2]).filter(Boolean);
  const list = what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what[what.length - 1]}` : what[0];
  return { ok: true, msg: `filled the ${list}${tail ? `; ${tail}` : ''}` };
}
