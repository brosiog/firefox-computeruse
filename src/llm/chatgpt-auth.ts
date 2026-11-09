// Sign in with ChatGPT (OpenAI's open-source token-sharing flow): the agent runs on the user's ChatGPT plan through
// the public Responses API. https://developers.openai.com/siwc/token-sharing-open-source
//
// Runs in the background page only, so a rotating refresh token is never refreshed by two sidebars at once. The
// sidebar asks for a token with runtime.sendMessage (see `handleChatGptMessage`).
//
// The flow wants an HTTP loopback redirect (http://127.0.0.1:<port>/auth/callback). An extension can't listen on a
// port, but it doesn't need to: the callback is a navigation of the sign-in tab, so webRequest sees it, takes the
// code from the URL and cancels the request before anything connects to that port.

declare const browser: any;

export const AUTH_ISSUER = 'https://auth.openai.com';
const AUTHORIZE_URL = `${AUTH_ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${AUTH_ISSUER}/api/accounts/oauth/token`;
export const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const DYNAMIC_CLIENT = 'dynamic_agent_client';
const APP_NAME = 'Firefox Computer Use';
const STORE_KEY = 'chatgptAuth';
/** Refresh this long before the access token expires. */
const REFRESH_EARLY_MS = 5 * 60_000;

export interface ChatGptAuth {
  /** Stable, opaque per-install id (urn:uuid). Kept across sign-outs. */
  hostId: string;
  /** Issued client id (oaiapp_…) from dynamic registration. Kept across sign-outs. */
  clientId?: string;
  email?: string;
  subject?: string;
  idToken?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
  scopes?: string[];
}

export interface ChatGptStatus {
  signedIn: boolean;
  email?: string;
}

export class AuthError extends Error {
  /** `relogin`: the refresh token is unusable; the user has to sign in again. */
  constructor(
    message: string,
    readonly relogin = false,
  ) {
    super(message);
  }
}

// ---------- small pure helpers (unit-tested) ----------

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), c => c.charCodeAt(0));
}

export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

export function decodeJwt(token: string): { header: any; payload: any; signed: Uint8Array; sig: Uint8Array } {
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) throw new AuthError('malformed ID token');
  const dec = (x: string) => JSON.parse(new TextDecoder().decode(b64urlDecode(x)));
  return { header: dec(h), payload: dec(p), signed: new TextEncoder().encode(`${h}.${p}`), sig: b64urlDecode(sig) };
}

export interface AuthorizeParams {
  clientId?: string;
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
  idTokenHint?: string;
  loginHint?: string;
}

export function authorizeUrl(p: AuthorizeParams): string {
  const q = new URLSearchParams();
  const reauth = !!p.clientId;
  q.set('client_id', p.clientId || DYNAMIC_CLIENT);
  // Display metadata for the first (dynamic) registration only.
  if (!reauth) q.set('agent_name_hint', APP_NAME);
  q.set('ext_agent_host_id', p.hostId);
  if (reauth && p.idTokenHint) q.set('id_token_hint', p.idTokenHint);
  if (reauth && p.loginHint) q.set('login_hint', p.loginHint);
  q.set('response_type', 'code');
  q.set('redirect_uri', p.redirectUri);
  q.set('scope', SCOPE);
  q.set('resource', RESOURCE);
  q.set('state', p.state);
  q.set('nonce', p.nonce);
  q.set('code_challenge_method', 'S256');
  q.set('code_challenge', p.challenge);
  return `${AUTHORIZE_URL}?${q}`;
}

/** Checks a loopback callback URL against the pending request; returns the code and the client id to use. */
export function parseCallback(url: string, expect: { state: string; clientId?: string }): { code: string; clientId: string } {
  const u = new URL(url);
  const q = u.searchParams;
  if (q.get('state') !== expect.state) throw new AuthError('sign-in callback had the wrong state; try again');
  const err = q.get('error');
  if (err) throw new AuthError(err === 'access_denied' ? 'sign-in was cancelled' : `sign-in failed: ${q.get('error_description') || err}`);
  const code = q.get('code');
  if (!code) throw new AuthError('sign-in callback had no code');
  const issued = q.get('client_id');
  if (expect.clientId && issued && issued !== expect.clientId) throw new AuthError('sign-in returned a different client id; try again');
  const clientId = expect.clientId || issued;
  if (!clientId || clientId === DYNAMIC_CLIENT) throw new AuthError('ChatGPT did not finish registering this app; try again');
  return { code, clientId };
}

// ---------- storage ----------

async function load(): Promise<ChatGptAuth> {
  const { [STORE_KEY]: a } = await browser.storage.local.get(STORE_KEY);
  if (a?.hostId) return a;
  const fresh: ChatGptAuth = { hostId: `urn:uuid:${crypto.randomUUID()}` };
  await save(fresh);
  return fresh;
}

const save = (a: ChatGptAuth) => browser.storage.local.set({ [STORE_KEY]: a });

export async function status(): Promise<ChatGptStatus> {
  const a = await load();
  return { signedIn: !!a.refreshToken, email: a.email };
}

// ---------- token endpoint ----------

async function tokenRequest(form: Record<string, string>): Promise<any> {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  } catch (e) {
    throw new AuthError(`cannot reach ${AUTH_ISSUER}: ${(e as Error).message}`);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = String(j.error?.code ?? j.error ?? j.code ?? res.status);
    const terminal = /invalid_grant|invalid_refresh_token|token_expired|refresh_token_(expired|invalidated|reused)/.test(code);
    throw new AuthError(`ChatGPT sign-in: ${j.error_description ?? j.error?.message ?? code}`, terminal);
  }
  return j;
}

let jwks: { at: number; keys: any[] } | null = null;
async function signingKey(kid: string): Promise<CryptoKey> {
  if (!jwks || Date.now() - jwks.at > 3600_000 || !jwks.keys.some(k => k.kid === kid)) {
    const conf = await (await fetch(`${AUTH_ISSUER}/.well-known/openid-configuration`)).json();
    jwks = { at: Date.now(), keys: (await (await fetch(conf.jwks_uri)).json()).keys ?? [] };
  }
  const jwk = jwks.keys.find(k => k.kid === kid);
  if (!jwk) throw new AuthError('ID token signed with an unknown key');
  return crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

/** Signature (OpenAI JWKS), issuer, audience, expiry and nonce. Returns the claims. */
async function validateIdToken(idToken: string, clientId: string, nonce: string): Promise<any> {
  const { header, payload, signed, sig } = decodeJwt(idToken);
  if (header.alg !== 'RS256') throw new AuthError(`unexpected ID token algorithm ${header.alg}`);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', await signingKey(header.kid), sig as BufferSource, signed as BufferSource);
  if (!ok) throw new AuthError('ID token signature is invalid');
  checkClaims(payload, clientId, nonce);
  return payload;
}

export function checkClaims(c: any, clientId: string, nonce: string, now = Date.now()) {
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (c.iss !== AUTH_ISSUER) throw new AuthError('ID token has the wrong issuer');
  if (!aud.includes(clientId)) throw new AuthError('ID token is for a different client');
  if (typeof c.exp !== 'number' || c.exp * 1000 < now - 60_000) throw new AuthError('ID token has expired');
  if (c.nonce !== nonce) throw new AuthError('ID token nonce does not match');
  if (!c.sub) throw new AuthError('ID token has no subject');
}

function withTokens(a: ChatGptAuth, t: any): ChatGptAuth {
  const scopes = typeof t.scope === 'string' ? t.scope.split(/\s+/).filter(Boolean) : a.scopes;
  return {
    ...a,
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? a.refreshToken,
    idToken: t.id_token ?? a.idToken,
    expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000,
    scopes,
  };
}

// ---------- sign in / out ----------

/** Opens ChatGPT sign-in in a tab and resolves once the tokens are stored. */
export async function signIn(): Promise<ChatGptStatus> {
  const a = await load();
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);
  // Any port works (only the port may vary); a random high one never collides with a real local listener, and the
  // request is cancelled before connecting anyway.
  const port = 20000 + Math.floor(Math.random() * 40000);
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const url = authorizeUrl({
    clientId: a.clientId,
    hostId: a.hostId,
    redirectUri,
    state,
    nonce,
    challenge: await pkceChallenge(verifier),
    idTokenHint: a.idToken,
    loginHint: a.email,
  });

  const tab = await browser.tabs.create({ url, active: true });
  const callbackUrl = await new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      browser.webRequest.onBeforeRequest.removeListener(onReq);
      browser.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
    };
    const onReq = (d: { url: string; tabId: number }) => {
      const u = new URL(d.url);
      if (d.tabId !== tab.id || u.port !== String(port) || u.pathname !== '/auth/callback') return {};
      cleanup();
      resolve(d.url);
      return { cancel: true };
    };
    const onRemoved = (id: number) => {
      if (id !== tab.id) return;
      cleanup();
      reject(new AuthError('sign-in tab was closed'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new AuthError('sign-in timed out'));
    }, 15 * 60_000);
    browser.webRequest.onBeforeRequest.addListener(onReq, { urls: ['http://127.0.0.1/auth/callback*'], tabId: tab.id }, ['blocking']);
    browser.tabs.onRemoved.addListener(onRemoved);
  });
  await browser.tabs.remove(tab.id).catch(() => {});

  const { code, clientId } = parseCallback(callbackUrl, { state, clientId: a.clientId });
  // Keep the issued client id even if the rest fails: a retry reauthorizes instead of registering again.
  if (clientId !== a.clientId) await save({ ...(await load()), clientId });
  const t = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE });
  const claims = await validateIdToken(t.id_token, clientId, nonce);
  const next = withTokens({ ...(await load()), clientId, subject: claims.sub, email: claims.email }, t);
  if (!next.scopes?.includes(PLAN_SCOPE)) throw new AuthError('ChatGPT did not grant plan usage to this app (scope chatgpt.tokens.use.direct missing)');
  await save(next);
  return { signedIn: true, email: next.email };
}

/** Revokes the refresh token (best effort) and clears tokens. Keeps the host id and issued client id, as OpenAI asks. */
export async function signOut(): Promise<{ revoked: boolean }> {
  const a = await load();
  let revoked = !a.refreshToken;
  if (a.refreshToken && a.clientId) {
    try {
      const conf = await (await fetch(`${AUTH_ISSUER}/.well-known/openid-configuration`)).json();
      const r = await fetch(conf.revocation_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: a.refreshToken, token_type_hint: 'refresh_token', client_id: a.clientId }),
      });
      revoked = r.ok;
    } catch {
      revoked = false;
    }
  }
  await save({ hostId: a.hostId, clientId: a.clientId, email: a.email, subject: a.subject });
  return { revoked };
}

// ---------- access tokens ----------

let refreshing: Promise<string> | null = null;

/** A valid access token, refreshed when it is close to expiry (or `force`, after a 401). Refreshes are serialized. */
export function accessToken(force = false): Promise<string> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const a = await load();
    if (!a.refreshToken || !a.clientId) throw new AuthError('not signed in to ChatGPT; open Settings and choose Continue with ChatGPT', true);
    if (!force && a.accessToken && (a.expiresAt ?? 0) - Date.now() > REFRESH_EARLY_MS) return a.accessToken;
    try {
      const t = await tokenRequest({ grant_type: 'refresh_token', client_id: a.clientId, refresh_token: a.refreshToken, resource: RESOURCE });
      const next = withTokens(await load(), t);
      await save(next);
      return next.accessToken!;
    } catch (e) {
      if ((e as AuthError).relogin) {
        await save({ hostId: a.hostId, clientId: a.clientId, email: a.email, subject: a.subject, idToken: a.idToken });
        throw new AuthError('ChatGPT session ended; sign in again in Settings', true);
      }
      throw e;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

// ---------- messaging (background ↔ sidebar) ----------

export type ChatGptMessage = { type: 'chatgpt-token'; force?: boolean } | { type: 'chatgpt-signin' } | { type: 'chatgpt-signout' } | { type: 'chatgpt-status' };

/** Background side. Replies are `{ ok, value }` or `{ ok: false, error, relogin }` (errors don't cross sendMessage). */
export function handleChatGptMessage(m: any): Promise<unknown> | undefined {
  const run = (f: () => Promise<unknown>) =>
    f().then(
      value => ({ ok: true, value }),
      (e: AuthError) => ({ ok: false, error: e.message ?? String(e), relogin: !!e.relogin }),
    );
  switch (m?.type) {
    case 'chatgpt-token':
      return run(() => accessToken(!!m.force));
    case 'chatgpt-signin':
      return run(signIn);
    case 'chatgpt-signout':
      return run(signOut);
    case 'chatgpt-status':
      return run(status);
  }
  return undefined;
}

/** Sidebar side. */
export async function askBackground<T>(m: ChatGptMessage): Promise<T> {
  const r = await browser.runtime.sendMessage(m);
  if (!r) throw new AuthError('the extension background did not answer; reload the extension');
  if (!r.ok) throw new AuthError(r.error, r.relogin);
  return r.value as T;
}
