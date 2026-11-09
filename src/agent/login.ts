// The login tool: sign in with a saved Bitwarden login without the agent seeing it.
//
//   1. The probe reports which sign-in fields the frame has, and the frame's URL (not the tab's).
//   2. The vault lists the logins saved for that URL; the agent sees only names and masked usernames.
//   3. The user approves the fill in the sidebar (unless they turned that off).
//   4. The credentials go from the vault into the probe's fill command, which checks the frame is still on the same
//      origin, fills the fields, and marks them secret so later page states mask them.
// The result text says what was filled, never with what. Nothing here puts a secret in a string the agent receives.

import type { Gate, ProbeResult, Risk } from '../protocol';
import type { Host } from '../browser/host';
import { hostOf, VaultError, type Vault, type VaultLogin } from '../vault';
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
}

type Out = { ok: boolean; text: string };

export async function login(a: Action, urlBefore: string, d: LoginDeps): Promise<Out> {
  const { host, vault } = d;
  const found = await host.act(a.ref, { op: 'loginForm' }, d.gate);
  if (!found.ok) return { ok: false, text: found.error };
  const form = found.form;
  if (!form || (!form.user && !form.pass && !form.otp)) {
    return { ok: false, text: 'there are no sign-in fields on this page. Open the sign-in page first (e.g. click "Sign in" or "Log in").' };
  }
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
    const o = a.option.trim().toLowerCase();
    const n = Number(o.replace(/^#/, ''));
    pick = Number.isInteger(n) && n >= 1 && n <= list.length ? list[n - 1] : list.find(l => l.name.toLowerCase() === o) ?? list.find(l => `${l.name} ${l.hint}`.toLowerCase().includes(o));
    if (!pick) return { ok: false, text: `no saved login matches "${a.option}". ${choices(list, site)}` };
  } else if (list.length === 1) pick = list[0];
  else return { ok: false, text: choices(list, site) };

  if (form.otp && !form.user && !form.pass && !pick.hasTotp) {
    return { ok: false, text: `this page asks for a one-time code, and the Bitwarden login "${pick.name}" has no authenticator key. Ask the user for the code.` };
  }

  const page = urlBefore.split('#')[0];
  const key = `login@${page}`;
  const what = `sign in to ${site} with Bitwarden login "${pick.name}" (${pick.hint})${a.enter ? ', then submit' : ''}`;
  if (d.declined.has(key)) return { ok: false, text: `the user already declined this (${what}). Stop trying; use done with success false and say what was not done.` };
  if (d.ask) {
    const yes = await d.approve({ risk: 'login', what }, a);
    if (d.aborted()) return { ok: false, text: 'stopped' };
    if (!yes) {
      d.declined.add(key);
      return { ok: false, text: `the user declined: ${what}. Do not try to sign in another way; use done with success false.` };
    }
  }

  let r: ProbeResult;
  try {
    const s = await vault.secret(pick.id, form.url, form.otp);
    r = await host.act(
      a.ref,
      {
        op: 'fillLogin',
        origin: new URL(form.url).origin,
        username: form.user ? s.username || undefined : undefined,
        password: form.pass ? s.password || undefined : undefined,
        totp: form.otp ? s.totp : undefined,
        enter: !!a.enter,
        approved: true,
      },
      d.gate,
    );
  } catch (e) {
    return { ok: false, text: vaultMessage(e) };
  }
  if (!r.ok) return { ok: false, text: r.error };
  let text = `${r.msg} from Bitwarden login "${pick.name}" (the values are hidden from you)`;
  if (!form.pass && form.user) text += '. This page asks for the username first: continue (e.g. click "Next"), then use login again on the password page';
  else if (!a.enter) text += '. Submit the form to sign in';
  const moved = await host.settle(urlBefore);
  return { ok: true, text: `${text}.${moved ? ` ${moved}.` : ''}` };
}

function choices(list: VaultLogin[], site: string): string {
  const items = list.slice(0, 9).map((l, i) => `${i + 1}) "${l.name}" ${l.hint}`).join(', ');
  return `Bitwarden has ${list.length} logins for ${site}: ${items}. Use login again with "option" set to the number of the account the task needs; if the task does not say which, ask the user.`;
}

function vaultMessage(e: unknown): string {
  if (e instanceof VaultError) return e.message;
  return `Bitwarden error: ${(e as Error)?.message ?? e}`;
}
