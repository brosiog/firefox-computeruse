// Bitwarden, through the Bitwarden CLI's local API (`bw serve`, http://localhost:8087 by default). The agent can sign in
// with the user's saved logins, but it never sees them. It only gets the item's name and a masked username. The secrets
// go from the vault straight into the page's fields (see fillLogin in src/agent/login.ts) and are masked in every page
// state afterwards.
//
// The vault must be unlocked: by the user running `bw unlock` before `bw serve`, or from Settings → Bitwarden (the
// master password goes to `bw serve` only and is never stored). When `bw serve` is locked or not running, logins fail
// with a message the agent can pass on.
//
// `bw serve` rejects requests that carry an Origin header (CSRF protection). The background page already strips it
// from every request the extension's own pages make.

export type VaultState = 'unlocked' | 'locked' | 'unauthenticated' | 'unreachable';

export interface VaultStatus {
  state: VaultState;
  /** The account, for the settings panel only (never sent to the model). */
  email?: string;
  error?: string;
}

/** A saved login as the agent may see it: no password, and the username masked. */
export interface VaultLogin {
  id: string;
  name: string;
  /** e.g. `j•••@gmail.com`, so the agent (and the approval card) can tell accounts apart. */
  hint: string;
  hasTotp: boolean;
}

/** What gets filled into the page. Lives only between the vault fetch and the fill. */
export interface VaultSecret {
  username: string;
  password: string;
  totp?: string;
}

export interface Vault {
  status(): Promise<VaultStatus>;
  /** Logins saved for `pageUrl`, matched by Bitwarden's own URI rules and then re-checked here (sameSite). */
  logins(pageUrl: string): Promise<VaultLogin[]>;
  /** The credentials of one item, re-checked against `pageUrl`. `totp` only when asked (it is a fresh code). */
  secret(id: string, pageUrl: string, withTotp: boolean): Promise<VaultSecret>;
  unlock(password: string): Promise<VaultStatus>;
  lock(): Promise<void>;
}

export class VaultError extends Error {}

type Fetch = typeof fetch;

export function createVault(baseUrl: string, fetchImpl: Fetch = (...a) => fetch(...a)): Vault {
  const base = baseUrl.replace(/\/+$/, '');

  const call = async (path: string, init?: RequestInit): Promise<any> => {
    let r: Response;
    try {
      r = await fetchImpl(`${base}${path}`, { ...init, signal: AbortSignal.timeout(15000) });
    } catch {
      throw new VaultError(`Bitwarden is not reachable at ${base}. The user needs to run \`bw serve\`.`);
    }
    let body: any;
    try {
      body = await r.json();
    } catch {
      body = null;
    }
    if (r.status === 403 && !body) throw new VaultError(`Bitwarden at ${base} refused the request (HTTP 403). Check the host in the URL.`);
    if (!body?.success) {
      const msg = String(body?.message ?? `HTTP ${r.status}`);
      if (/locked/i.test(msg)) throw new VaultError('Bitwarden is locked. Ask the user to unlock it, then try again.');
      if (/not logged in/i.test(msg)) throw new VaultError('Bitwarden is not logged in. Ask the user to run `bw login`.');
      throw new VaultError(`Bitwarden: ${msg}`);
    }
    return body.data;
  };

  const vault: Vault = {
    async status() {
      try {
        const t = (await call('/status'))?.template ?? {};
        const state: VaultState = t.status === 'unlocked' || t.status === 'locked' ? t.status : 'unauthenticated';
        return { state, email: t.userEmail ?? undefined };
      } catch (e) {
        return { state: 'unreachable', error: (e as Error).message };
      }
    },

    async logins(pageUrl) {
      const data = await call(`/list/object/items?url=${encodeURIComponent(pageUrl)}`);
      const items: any[] = Array.isArray(data?.data) ? data.data : [];
      // The list carries whole decrypted items, passwords included: keep only what the agent may see.
      return items
        .filter(i => i?.type === 1 && !i.deletedDate && i.login && itemMatches(i, pageUrl))
        .map(i => ({ id: String(i.id), name: String(i.name ?? 'login'), hint: maskUsername(i.login.username), hasTotp: !!i.login.totp }));
    },

    async secret(id, pageUrl, withTotp) {
      if (!/^[\w-]+$/.test(id)) throw new VaultError('bad item id');
      const item = await call(`/object/item/${id}`);
      if (item?.type !== 1 || !item.login) throw new VaultError('that Bitwarden item is not a login');
      if (!itemMatches(item, pageUrl)) throw new VaultError(`that Bitwarden login is not saved for ${hostOf(pageUrl)}`);
      const s: VaultSecret = { username: String(item.login.username ?? ''), password: String(item.login.password ?? '') };
      if (withTotp && item.login.totp) {
        const t = await call(`/object/totp/${id}`).catch(() => null);
        if (typeof t?.data === 'string') s.totp = t.data;
      }
      return s;
    },

    async unlock(password) {
      try {
        await call('/unlock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
      } catch (e) {
        const st = await vault.status();
        return st.state === 'unlocked' ? st : { ...st, error: (e as Error).message };
      }
      return vault.status();
    },

    async lock() {
      await call('/lock', { method: 'POST' });
    },
  };
  return vault;
}

// ---------- matching ----------

/**
 * Whether a saved URI may be filled on `pageUrl`. Bitwarden already matched the item by its own rules (base domain by
 * default, or the item's match setting); this is a second, conservative check that the credential only ever goes to
 * the site it was saved for:
 * - the page is http(s), and never plain http when the login was saved for https;
 * - same host, or same registrable domain (www.github.com and github.com; not github.com.evil.test).
 */
export function sameSite(savedUri: string, pageUrl: string): boolean {
  let page: URL;
  let saved: URL;
  try {
    page = new URL(pageUrl);
    saved = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(savedUri) ? savedUri : `https://${savedUri}`);
  } catch {
    return false;
  }
  if (page.protocol !== 'https:' && page.protocol !== 'http:') return false;
  if (saved.protocol !== 'https:' && saved.protocol !== 'http:') return false;
  if (page.protocol === 'http:' && saved.protocol === 'https:') return false;
  const a = page.hostname.toLowerCase();
  const b = saved.hostname.toLowerCase();
  if (!a || !b) return false;
  if (a === b) return page.port === saved.port || !saved.port;
  // IPs and single-label hosts (localhost) match exactly or not at all.
  if (isIp(a) || isIp(b) || !a.includes('.') || !b.includes('.')) return false;
  return siteOf(a) === siteOf(b);
}

function itemMatches(item: any, pageUrl: string): boolean {
  const uris: any[] = Array.isArray(item?.login?.uris) ? item.login.uris : [];
  // match 5 is Bitwarden's "Never".
  return uris.some(u => typeof u?.uri === 'string' && u.match !== 5 && sameSite(u.uri, pageUrl));
}

const isIp = (h: string) => /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':') || h.startsWith('[');

// Two-label public suffixes are common enough under country codes (co.uk, com.au, ne.jp) that taking the last two
// labels would treat every site under them as one. Without a full public suffix list, a known second-level label
// under a two-letter TLD counts as part of the suffix. Errs toward not matching.
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'ne', 'or', 'go', 'gob', 'mil', 'nom', 'ltd', 'plc', 'sch', 'nhs', 'gv', 'gen', 'biz', 'info']);
// Hosting suffixes where every subdomain is someone else's site.
const SHARED = /\.(github\.io|gitlab\.io|pages\.dev|netlify\.app|vercel\.app|herokuapp\.com|web\.app|firebaseapp\.com|appspot\.com|blogspot\.com|azurewebsites\.net|cloudfront\.net|workers\.dev|fly\.dev|onrender\.com|s3\.amazonaws\.com)$/;

export function siteOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (SHARED.test(h)) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  const n = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  return parts.slice(-n).join('.');
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** `jane.doe@gmail.com` → `j•••@gmail.com`; `janedoe` → `j•••`; empty → `(no username)`. */
export function maskUsername(u: unknown): string {
  const s = typeof u === 'string' ? u.trim() : '';
  if (!s) return '(no username)';
  const at = s.lastIndexOf('@');
  if (at > 0) return `${s[0]}•••${s.slice(at)}`;
  return `${s[0]}•••`;
}
