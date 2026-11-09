// The login tool: sign in with a saved Bitwarden login without the agent seeing it.
//
//   1. The probe reports which sign-in fields the frame has, and the frame's URL (not the tab's). Without a ref, the
//      top frame is tried first, then every frame; a page that is still rendering gets a moment.
//   2. The vault lists the logins saved for that URL; the agent sees only names and masked usernames. It can pick one
//      by number, by name, or by the full username its task gave (matched in the vault, never shown).
//   3. The user approves the fill in the sidebar (unless they turned that off).
//   4. The credentials go from the vault into the probe's fill command, which checks the frame is still on the same
//      origin, fills the fields, and marks them secret so later page states mask them. The host is told the values,
//      so anything the page repeats (a greeting, a title, a URL) is scrubbed from what the agent gets from then on.
// The result text says what was filled, never with what. Nothing here puts a secret in a string the agent receives.

import type { Gate, LoginForm, ProbeResult, Risk } from '../protocol';
import type { Host } from '../browser/host';
import { hostOf, siteOf, VaultError, type Vault, type VaultLogin } from '../vault';
import type { Action } from './tools';

export interface LoginDeps {
  host: Host;
  vault: Vault;
  ask: boolean;
  gate: Risk[];
  approve(gate: Gate, a: Action): Promise<boolean>;
  /** Shared with the executor: a decline holds for the page. */
  declined: Set<string>;
  aborted(): boolean;
  /** How long to wait for a page that has no sign-in fields yet (tests: 0). */
  retryMs?: number;
}

type Out = { ok: boolean; text: string };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** The sign-in form: where the agent pointed, else the top frame, else any frame. Retries while the page renders. */
async function locate(a: Action, d: LoginDeps): Promise<{ ref?: string; form?: LoginForm; error?: string }> {
  const tries = a.ref ? 1 : 3;
  let firstError: string | undefined;
  for (let t = 0; t < tries; t++) {
    if (t) await sleep(d.retryMs ?? 700);
    const refs: (string | undefined)[] = a.ref ? [a.ref] : [undefined, ...(d.host.frameAliases?.() ?? []).map(n => `${n}:`)];
    for (const ref of refs) {
      const r = await d.host.act(ref, { op: 'loginForm' }, d.gate);
      if (!r.ok) {
        // A refusal (sign-up form, SMS code) in the top frame is the answer, unless a frame has a real sign-in form.
        firstError ??= r.error;
        if (a.ref) return { error: r.error };
        continue;
      }
      const f = r.form;
      if (f && (f.user || f.pass || f.otp)) return { ref, form: f };
    }
    if (firstError) break;
  }
  return { error: firstError };
}

export async function login(a: Action, urlBefore: string, d: LoginDeps): Promise<Out> {
  const { host, vault } = d;
  const found = await locate(a, d);
  if (!found.form) {
    if (found.error) return { ok: false, text: found.error };
    return { ok: false, text: 'there are no sign-in fields on this page. Open the sign-in page first (e.g. click "Sign in" or "Log in").' };
  }
  const form = found.form;
  const ref = found.ref;
  const site = hostOf(form.url);
  let list: VaultLogin[];
  try {
    list = await vault.logins(form.url);
  } catch (e) {
    return { ok: false, text: vaultMessage(e) };
  }
  if (!list.length) return { ok: false, text: `Bitwarden has no login saved for ${site}. Ask the user to sign in themselves.` };

  let pick: VaultLogin | undefined;
  if (a.option) {
    const r = choose(list, a.option);
    if ('error' in r) return { ok: false, text: `${r.error} ${choices(list, site)}` };
    pick = r.pick;
  } else if (list.length === 1) pick = list[0];
  else return { ok: false, text: choices(list, site) };

  if (form.otp && !form.user && !form.pass && !pick.hasTotp) {
    return { ok: false, text: `this page asks for a one-time code, and the Bitwarden login "${pick.name}" has no authenticator key. Ask the user for the code.` };
  }

  const page = urlBefore.split('#')[0];
  const key = `login@${page}`;
  // A frame from another site than the tab: the card says so (a page can frame a real sign-in form and cover it).
  const framed = sameSiteUrl(form.url, urlBefore) ? '' : ` (in a frame inside a page from ${hostOf(urlBefore)})`;
  const warn = framed ? `This sign-in form sits inside a page from ${hostOf(urlBefore)}, another site. Allow only if you meant to sign in to ${site} here.` : undefined;
  const what = `sign in to ${site}${framed} with Bitwarden login "${pick.name}" (${pick.hint})${a.enter ? ', then submit' : ''}`;
  if (d.declined.has(key)) return { ok: false, text: `the user already declined this (${what}). Stop trying; use done with success false and say what was not done.` };
  if (d.ask) {
    const yes = await d.approve({ risk: 'login', what, ...(warn ? { warn } : {}) }, a);
    if (d.aborted()) return { ok: false, text: 'stopped' };
    if (!yes) {
      d.declined.add(key);
      return { ok: false, text: `the user declined: ${what}. Do not try to sign in another way; use done with success false.` };
    }
  }

  let r: ProbeResult;
  const notes: string[] = [];
  try {
    const s = await vault.secret(pick.id, form.url, form.otp);
    host.redact?.(s);
    const username = form.user ? s.username || undefined : undefined;
    const password = form.pass ? s.password || undefined : undefined;
    const totp = form.otp ? s.totp : undefined;
    if (form.otp && !totp && s.totpError && !username && !password) return { ok: false, text: `${s.totpError}. Ask the user for the one-time code.` };
    if (!username && !password && !totp) {
      return { ok: false, text: `the Bitwarden login "${pick.name}" has no ${form.pass ? 'password' : form.user ? 'username' : 'code'} saved, so there is nothing to fill here. Ask the user.` };
    }
    if (form.pass && !password) notes.push('the login has no password saved; only the username was filled');
    if (form.user && !username && password) notes.push('the login has no username saved');
    r = await host.act(ref, { op: 'fillLogin', origin: new URL(form.url).origin, username, password, totp, enter: !!a.enter, approved: true }, d.gate);
  } catch (e) {
    return { ok: false, text: vaultMessage(e) };
  }
  if (!r.ok) return { ok: false, text: r.error };
  let text = `${r.msg} from Bitwarden login "${pick.name}" (the values are hidden from you)`;
  if (notes.length) text += `; ${notes.join('; ')}`;
  if (!form.pass && form.user) text += '. This page asks for the username first: continue (e.g. click "Next"), then use login again on the password page';
  else if (!a.enter) text += '. Submit the form to sign in';
  const moved = await host.settle(urlBefore);
  return { ok: true, text: `${text}.${moved ? ` ${moved}.` : ''}` };
}

/** The option: a list number, the full username (matched privately), an exact item name, or part of a name. */
function choose(list: VaultLogin[], option: string): { pick: VaultLogin } | { error: string } {
  const o = option.trim();
  const low = o.toLowerCase();
  if (/^#?\d+$/.test(o)) {
    const n = Number(o.replace('#', ''));
    return n >= 1 && n <= list.length ? { pick: list[n - 1] } : { error: `no saved login matches "${o}".` };
  }
  const one = (ms: VaultLogin[], how: string) => (ms.length === 1 ? { pick: ms[0] } : ms.length > 1 ? { error: `${ms.length} saved logins match "${o}" ${how}; use the number instead.` } : null);
  return (
    one(list.filter(l => l.isUser?.(o)), 'by username') ??
    one(list.filter(l => l.name.toLowerCase() === low), 'by name') ??
    one(list.filter(l => `${l.name} ${l.hint}`.toLowerCase().includes(low)), 'by name') ?? { error: `no saved login matches "${o}".` }
  );
}

function sameSiteUrl(a: string, b: string): boolean {
  try {
    const x = new URL(a).hostname;
    const y = new URL(b).hostname;
    return x === y || siteOf(x) === siteOf(y);
  } catch {
    return false;
  }
}

function choices(list: VaultLogin[], site: string): string {
  const items = list.slice(0, 9).map((l, i) => `${i + 1}) "${l.name}" ${l.hint}`).join(', ');
  const more = list.length > 9 ? ` (and ${list.length - 9} more)` : '';
  return `Bitwarden has ${list.length} logins for ${site}: ${items}${more}. Use login again with "option" set to the number of the account the task needs (or its full username, if the task gives it); if the task does not say which, ask the user.`;
}

function vaultMessage(e: unknown): string {
  if (e instanceof VaultError) return e.message;
  return `Bitwarden error: ${(e as Error)?.message ?? e}`;
}
