// Sign-in fields, for password-manager fills. Finding them reports only which fields exist; filling marks every field it
// fills as secret (dom.vaultFilled), so the username is masked in later page states too, like the password.
//
// The finder is deliberately picky: a saved login going into the wrong field (a contact form's email, a card's CVC, a
// form that posts to another site) is worse than not filling. The cases it is judged on are in e2e/login-lab/cases.mjs.

import type { LoginForm, ProbeResult } from '../protocol';
import { siteOf } from '../vault';
import * as act from './actions';
import { isDisabled, shadowOf, testLayout, vaultFilled, visuallyHidden } from './dom';

export interface LoginFields {
  user?: HTMLInputElement;
  pass?: HTMLInputElement;
  /** One field, or one box per digit. */
  otp?: HTMLInputElement[];
  /** Set when the page has fields, but not ones this should fill (sign-up, change password, SMS codes). */
  refuse?: string;
}

const USERISH = /user|e-?mail|login|account|ident|phone|mobile|benutzer|courriel|correo|ユーザー|用户|아이디/i;
const STRONG_USER = /user|login|ident|account|benutzer|ユーザー|用户|아이디/i;
const OTPISH = /otp|totp|2fa|mfa|one.?time|verification.?code|security.?code|auth\w*.?code|passcode|\bcode\b|_code\b|token/i;
// Codes a password manager cannot know.
const OTHER_CODE = /sms|text(ed)? (message|you)|by text|e-?mail(ed)?|phone|recovery|backup|reset|promo|coupon|zip|postal|gift|discount|referral|invite|voucher/i;
const CODEISH = /code|otp|pin\b|token/i;
const NOT_USER = /search|captcha|coupon|promo|zip|postal|query|street|address.?line|billing|shipping|city|first.?name|last.?name|full.?name|message|subject/i;
const CARD = /card|cvc|cvv|csc|ccnum|cc.?num|cc.?exp|expir|iban|routing/i;
const PW_NAME = /^(pass(word)?|passwd|pwd|kennwort|passwort)$/i;
const SIGNIN = /sign.?in|log.?in|login|log on|next|continue|weiter|anmelden|connexion|connecter|iniciar|accedi|entrar|ログイン|登录|로그인|войти/i;
const NOT_SIGNIN = /subscribe|newsletter|send|message|contact|pay|order|checkout|sign.?up|register|create|join|reset|forgot|search|donate|apply|book/i;
const TEXTY = new Set(['', 'text', 'email', 'tel', 'username']);

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

/** Parent across shadow boundaries. */
const up = (el: Element): Element | null => el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null);

function usable(i: HTMLInputElement): boolean {
  if (i.type === 'hidden' || isDisabled(i) || i.readOnly) return false;
  const win = i.ownerDocument.defaultView!;
  // Hidden by itself or an ancestor: display:none, visibility (the nearest element that sets it decides), a closed
  // <details>, near-zero opacity, aria-hidden.
  let vis: string | null = null;
  for (let p: Element | null = i, depth = 0; p && depth < 60; p = up(p), depth++) {
    const st = win.getComputedStyle(p);
    if (st.display === 'none') return false;
    if (parseFloat(st.opacity) < 0.1) return false;
    const own = (p as HTMLElement).style?.visibility;
    if (vis === null && own) vis = own;
    if (p.tagName === 'DETAILS' && !(p as HTMLDetailsElement).open && !p.querySelector(':scope > summary')?.contains(i)) return false;
    if (p !== i && p.getAttribute('aria-hidden') === 'true') return false;
  }
  const v0 = win.getComputedStyle(i).visibility;
  if (vis === 'hidden' || vis === 'collapse' || v0 === 'hidden' || v0 === 'collapse') return false;
  if (testLayout()) return true;
  const r = i.getBoundingClientRect();
  if (r.width * r.height < 4) return false;
  if (visuallyHidden(i, win.getComputedStyle(i), r, win)) return false;
  // Inside a clipped box (height:0 or 1px with overflow hidden) or an ancestor pushed off-screen.
  for (let p: Element | null = up(i), depth = 0; p && depth < 20; p = up(p), depth++) {
    const st = win.getComputedStyle(p);
    const pr = p.getBoundingClientRect();
    if ((st.overflow !== 'visible' || st.overflowX !== 'visible' || st.overflowY !== 'visible') && (pr.width < 4 || pr.height < 4)) return false;
    if ((st.position === 'absolute' || st.position === 'fixed') && visuallyHidden(p, st, pr, win)) return false;
  }
  const cv = (i as HTMLElement & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (cv && !cv.call(i, { visibilityProperty: true, opacityProperty: true })) return false;
  return true;
}

const ac = (i: HTMLInputElement) => (i.getAttribute('autocomplete') ?? '').toLowerCase();
const labelText = (i: HTMLInputElement) => Array.from(i.labels ?? []).map(l => l.textContent ?? '').join(' ');
const hints = (i: HTMLInputElement) =>
  `${i.name} ${i.id} ${i.getAttribute('aria-label') ?? ''} ${i.placeholder ?? ''} ${ac(i)} ${labelText(i)} ${labelledBy(i)}`;
const ids = (i: HTMLInputElement) => `${i.name} ${i.id}`;
function labelledBy(i: HTMLInputElement): string {
  const ref = i.getAttribute('aria-labelledby');
  if (!ref) return '';
  const root = i.getRootNode() as Document | ShadowRoot;
  return ref.split(/\s+/).map(id => root.getElementById?.(id)?.textContent ?? '').join(' ');
}
const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const isCard = (i: HTMLInputElement) => ac(i).startsWith('cc-') || CARD.test(ids(i) + ' ' + (i.getAttribute('aria-label') ?? ''));

function isOtpLike(i: HTMLInputElement): boolean {
  if (!TEXTY.has(i.type) && i.type !== 'number' && i.type !== 'password') return false;
  if (ac(i).includes('one-time-code')) return true;
  return OTPISH.test(hints(i)) && !STRONG_USER.test(ids(i)) && !/e-?mail$/i.test(i.name);
}

function isPassword(i: HTMLInputElement): boolean {
  if (isCard(i)) return false;
  if (i.type === 'password') return true;
  // A password field with "show password" switched on is type=text.
  return TEXTY.has(i.type) && (ac(i).includes('current-password') || PW_NAME.test(i.name) || PW_NAME.test(i.id));
}

/** Buttons that say what a form is for. */
function buttonsOf(scope: Element | Document): string {
  return Array.from(scope.querySelectorAll('button, input[type=submit], input[type=button], [role=button]'))
    .map(b => `${b.textContent ?? ''} ${(b as HTMLInputElement).value ?? ''} ${b.getAttribute('aria-label') ?? ''}`)
    .join(' | ');
}

/** For username-only pages: does the field's form look like a sign-in step, not a newsletter or contact form? */
function signInContext(i: HTMLInputElement): boolean {
  let scope: Element | null = i.form;
  if (!scope) {
    scope = i;
    for (let k = 0; k < 4 && scope && !scope.querySelector('button, input[type=submit], [role=button]'); k++) scope = up(scope);
  }
  if (!scope) return false;
  if (scope.querySelector('textarea')) return false;
  const btn = buttonsOf(scope);
  if (NOT_SIGNIN.test(btn)) return false;
  return SIGNIN.test(btn) || STRONG_USER.test(ids(i)) || ac(i).includes('username');
}

/** The sign-in fields in the form around `near` (a ref the agent gave), or in the whole frame. */
export function findLoginFields(doc: Document, near?: Element): LoginFields {
  const scope: Element | Document = (near && (near as HTMLInputElement).form) ?? near?.closest('form') ?? (near && near.tagName !== 'INPUT' ? near : null) ?? doc;
  const all = inputsUnder(scope).filter(usable);
  const otpLike = all.filter(i => !isCard(i) && isOtpLike(i) && !isPassword(i));
  const otherCode = otpLike.filter(i => OTHER_CODE.test(hints(i)));
  const otpAll = otpLike.filter(i => !otherCode.includes(i));
  const otp = otpAll.length > 1 && otpAll.every(i => i.maxLength === 1) ? otpAll : otpAll.slice(0, 1);
  const pw = all.filter(i => isPassword(i) && !otp.includes(i));
  const out: LoginFields = {};
  if (otp.length) out.otp = otp;

  const userCands = (form: HTMLFormElement | null | undefined, exclude: HTMLInputElement[]) =>
    all.filter(
      i =>
        TEXTY.has(i.type) && !exclude.includes(i) && !otpLike.includes(i) && !pw.includes(i) && !isCard(i) &&
        !NOT_USER.test(hints(i)) && !(CODEISH.test(ids(i)) && !STRONG_USER.test(ids(i))) && (form === undefined || i.form === form),
    );
  const strong = (cs: HTMLInputElement[]) =>
    cs.find(i => /username|email|webauthn/.test(ac(i))) ?? cs.find(i => i.type === 'email' || USERISH.test(hints(i)));

  if (pw.length) {
    // Group password fields by form: a sign-in form has exactly one. Prefer the form the agent pointed into.
    const groups = new Map<HTMLFormElement | null, HTMLInputElement[]>();
    for (const p of pw) groups.set(p.form, [...(groups.get(p.form) ?? []), p]);
    const pointed = near && pw.find(p => p === near || (p.form && p.form === (near as HTMLInputElement).form));
    const single = [...groups.values()].filter(g => g.length === 1).map(g => g[0]);
    const pass = pointed && groups.get(pointed.form)!.length === 1 ? pointed : single.find(p => ac(p).includes('current-password')) ?? single[0];
    if (!pass) return { refuse: 'this looks like a sign-up or change-password form (more than one password field), not a sign-in form' };
    out.pass = pass;
    const cands = userCands(pass.form, [pass]);
    const prior = cands.filter(i => before(i, pass));
    out.user = strong(prior) ?? prior[prior.length - 1] ?? strong(cands.filter(i => !before(i, pass)));
    if (out.otp && out.otp[0].form !== pass.form) delete out.otp;
    return out;
  }

  // No password field: a username-first page, or a one-time-code page.
  if (!otp.length && otherCode.length) {
    return { refuse: 'this page asks for a code sent by text message or email (or a recovery code), which Bitwarden does not have. Ask the user for it' };
  }
  const cands = userCands(undefined, []);
  const pointedUser = near && cands.includes(near as HTMLInputElement) ? (near as HTMLInputElement) : undefined;
  const u = pointedUser ?? strong(cands);
  if (u && !otp.length && signInContext(u)) out.user = u;
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

/** Where submitting this form would send it: the default button's formaction, else the form's action. */
function destination(form: HTMLFormElement): string {
  const btn =
    form.querySelector('button[type=submit], input[type=submit], button:not([type])') ??
    (form.id ? Array.from(form.ownerDocument.querySelectorAll('button[form], input[form]')).find(b => b.getAttribute('form') === form.id) : null);
  const fa = btn?.getAttribute('formaction');
  if (fa) return new URL(fa, form.baseURI).href;
  return form.action;
}

const sameSite = (a: string, b: string) => {
  try {
    const x = new URL(a);
    const y = new URL(b);
    if (!/^https?:$/.test(x.protocol)) return true; // javascript:, about: — not a network destination
    return x.hostname === y.hostname || siteOf(x.hostname) === siteOf(y.hostname);
  } catch {
    return true;
  }
};

const PER_KEY_MAX = 4096;

/** Fills what it was given into the fields found again now. Values never appear in the receipt. */
export function fillLogin(doc: Document, near: Element | undefined, c: FillCmd, ctx: act.ActCtx): ProbeResult {
  const win = doc.defaultView!;
  const origin = win.location.origin ?? '';
  if (origin !== c.origin) return { ok: false, error: `the page is no longer on ${c.origin} (now ${origin}); nothing was filled.` };
  let f = findLoginFields(doc, near);
  if (f.refuse) return { ok: false, error: f.refuse };

  type Job = { role: 'user' | 'pass' | 'otp'; el: HTMLInputElement; value: string; label: string; box?: number };
  const plan = (fields: LoginFields): Job[] => {
    const jobs: Job[] = [];
    if (fields.user && c.username) jobs.push({ role: 'user', el: fields.user, value: c.username, label: 'username' });
    if (fields.pass && c.password) jobs.push({ role: 'pass', el: fields.pass, value: c.password, label: 'password' });
    if (fields.otp?.length && c.totp) {
      if (fields.otp.length > 1) fields.otp.forEach((box, i) => c.totp![i] !== undefined && jobs.push({ role: 'otp', el: box, value: c.totp![i], label: 'one-time code', box: i }));
      else jobs.push({ role: 'otp', el: fields.otp[0], value: c.totp, label: 'one-time code' });
    }
    return jobs;
  };
  let jobs = plan(f);
  if (!jobs.length) return { ok: false, error: 'found no sign-in field to fill on this page.' };

  // Checks before anything is typed: nothing is half-filled.
  for (const j of jobs) {
    if (j.el.maxLength > 0 && j.value.length > j.el.maxLength) {
      return { ok: false, error: `the ${j.label} field allows only ${j.el.maxLength} characters and the saved ${j.label} is longer, so this is probably not the sign-in field (a PIN or code?). Nothing was filled.` };
    }
  }
  const form = jobs.find(j => j.role === 'pass')?.el.form ?? jobs[0].el.form;
  if (form) {
    const dest = destination(form);
    if (!sameSite(dest, win.location.href)) {
      let host = dest;
      try {
        host = new URL(dest).host;
      } catch {
        // keep
      }
      return { ok: false, error: `this form sends to another site (${host}), not to ${win.location.host}. Nothing was filled.` };
    }
  }
  // A GET form would put the password in the page address (history, server logs, the agent's own page state).
  const getForm = !!form && (form.getAttribute('method') ?? 'get').toLowerCase() === 'get' && jobs.some(j => j.role === 'pass');
  const submit = c.enter && !getForm;

  // Approved by the user before the vault was read; the probe's own gates must not ask again per field.
  const fillCtx: act.ActCtx = { ...ctx, approved: true, gated: () => false };
  const filled = new Set<string>();
  for (let k = 0; k < jobs.length; k++) {
    let j = jobs[k];
    for (let attempt = 0; attempt < 2; attempt++) {
      vaultFilled.add(j.el);
      const r = act.type(j.el, j.value, true, false, fillCtx, PER_KEY_MAX);
      if (!r.ok) return { ok: false, error: `could not fill the ${j.label} field: ${r.error}` };
      if (j.el.isConnected || attempt) break;
      // The page swapped the field for a new element while it was being filled: find it again and refill once.
      f = findLoginFields(doc, near);
      const again = plan(f).find(x => x.role === j.role && x.box === j.box);
      if (!again) break;
      j = jobs[k] = again;
    }
    const accepted = j.el.isConnected && (j.role === 'user' ? !!j.el.value : j.el.value === j.value);
    if (!accepted) {
      const done = [...filled];
      return { ok: false, error: `the page did not accept the ${j.label} (the field ${j.el.isConnected ? 'stayed empty or changed' : 'was removed'}).${done.length ? ` Filled before that: ${done.join(', ')}.` : ''}` };
    }
    filled.add(j.label);
  }
  // Enter only once every field holds its value: pages may clear the form as soon as it is submitted.
  let tail = '';
  if (submit) {
    const r = act.key(jobs[jobs.length - 1].el, 'Enter', fillCtx);
    tail = r.ok ? (/pressed Enter[^.;]*/.exec(r.msg)?.[0] ?? 'pressed Enter') : '';
  }
  const what = [...filled];
  const list = what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what[what.length - 1]}` : what[0];
  let msg = `filled the ${list}${tail ? `; ${tail}` : ''}`;
  if (c.enter && getForm) msg += '; did not submit it: this form would put the password in the page address (a GET form). Click its button only if the user wants that';
  return { ok: true, msg };
}
