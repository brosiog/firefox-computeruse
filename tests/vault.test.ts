// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createExecutor } from '../src/agent/loop';
import { parseAction, toolsFor } from '../src/agent/tools';
import { systemPrompt } from '../src/agent/prompt';
import { createBridgeHandler } from '../src/bridge';
import type { Host } from '../src/browser/host';
import type { Gate, LoginForm } from '../src/protocol';
import { DEFAULTS, type Settings } from '../src/settings';
import { createVault, maskUsername, sameSite, siteOf } from '../src/vault';

const PASSWORD = 'hunter2-SECRET';
const USERNAME = 'jane.doe@gmail.com';
const TOTP = '492817';

/** A fake `bw serve`: two GitHub logins, one for another site. Records requests. */
function fakeBw(opts: { locked?: boolean; items?: any[] } = {}) {
  const calls: string[] = [];
  const items = opts.items ?? [
    { id: 'a1', type: 1, name: 'GitHub', login: { username: USERNAME, password: PASSWORD, totp: 'otpauth://x', uris: [{ uri: 'https://github.com/login', match: null }] } },
    { id: 'b2', type: 1, name: 'Evil', login: { username: 'x', password: 'y', uris: [{ uri: 'https://github.com.evil.test' }] } },
  ];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const f = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    calls.push(`${init?.method ?? 'GET'} ${u.pathname}${u.search}`);
    if (u.pathname === '/status') return json({ success: true, data: { object: 'template', template: { status: opts.locked ? 'locked' : 'unlocked', userEmail: 'me@x.test' } } });
    if (opts.locked) return json({ success: false, message: 'Vault is locked.' }, 400);
    if (u.pathname === '/list/object/items') return json({ success: true, data: { object: 'list', data: items } });
    const m = /^\/object\/(item|totp)\/(.+)$/.exec(u.pathname);
    if (m) {
      const it = items.find(i => i.id === m[2]);
      if (!it) return json({ success: false, message: 'Not found.' }, 404);
      return json({ success: true, data: m[1] === 'item' ? it : { object: 'string', data: TOTP } });
    }
    return json({ success: false, message: 'nope' }, 404);
  }) as unknown as typeof fetch;
  return { f, calls };
}

function fakeHost(form: Partial<LoginForm>, log: any[]): Host {
  return {
    tabId: 1,
    observe: async () => ({ url: 'https://github.com/login', title: '', refs: [], text: '' }),
    act: async (_ref, cmd: any) => {
      log.push(cmd);
      if (cmd.op === 'loginForm') return { ok: true, msg: 'ok', form: { url: 'https://github.com/login', user: true, pass: true, otp: false, ...form } };
      if (cmd.op === 'fillLogin') return { ok: true, msg: 'filled the username and password' };
      return { ok: true, msg: 'ok' };
    },
    settle: async () => '',
    navigate: async () => '',
    back: async () => '',
    tabs: async () => [],
    newTab: async () => '',
    switchTab: async () => '',
    closeTab: async () => '',
    screenshot: async () => null,
  };
}

function exec(o: { form?: Partial<LoginForm>; bw?: ReturnType<typeof fakeBw>; approve?: boolean; ask?: boolean; approval?: Settings['approval'] } = {}) {
  const log: any[] = [];
  const gates: Gate[] = [];
  const bw = o.bw ?? fakeBw();
  const e = createExecutor({
    host: fakeHost(o.form ?? {}, log),
    settings: { ...DEFAULTS, vault: true, vaultAsk: o.ask ?? true, approval: o.approval ?? DEFAULTS.approval },
    ui: { approve: async g => (gates.push(g), o.approve ?? true), ask: async () => null },
    signal: new AbortController().signal,
    vault: createVault('http://localhost:8087', bw.f),
  });
  return { e, log, gates, bw };
}

const run = (e: ReturnType<typeof exec>['e'], json: string) => {
  const p = parseAction(json, false, true);
  if (!p.ok) throw new Error(p.error);
  return e.run(p.action, 'https://github.com/login');
};

describe('site matching', () => {
  it('matches the saved site and its subdomains, not lookalikes or downgrades', () => {
    expect(sameSite('https://github.com/login', 'https://github.com/session')).toBe(true);
    expect(sameSite('github.com', 'https://www.github.com/')).toBe(true);
    expect(sameSite('https://github.com', 'https://github.com.evil.test/')).toBe(false);
    expect(sameSite('https://github.com', 'https://evilgithub.com/')).toBe(false);
    expect(sameSite('https://github.com', 'http://github.com/')).toBe(false);
    expect(sameSite('https://bank.co.uk', 'https://other.co.uk/')).toBe(false);
    expect(sameSite('https://a.github.io', 'https://b.github.io/')).toBe(false);
    expect(sameSite('http://localhost:3000', 'http://localhost:4000/')).toBe(false);
    expect(sameSite('https://github.com', 'javascript:alert(1)')).toBe(false);
    expect(siteOf('login.bank.co.uk')).toBe('bank.co.uk');
  });

  it('masks usernames', () => {
    expect(maskUsername(USERNAME)).toBe('j•••@gmail.com');
    expect(maskUsername('janedoe')).toBe('j•••');
    expect(maskUsername('')).toBe('(no username)');
  });
});

describe('vault client', () => {
  it('lists only matching logins, without secrets', async () => {
    const bw = fakeBw();
    const list = await createVault('http://localhost:8087/', bw.f).logins('https://github.com/login');
    expect(list).toEqual([{ id: 'a1', name: 'GitHub', hint: 'j•••@gmail.com', hasTotp: true }]);
    expect(JSON.stringify(list)).not.toContain(PASSWORD);
    expect(bw.calls[0]).toBe('GET /list/object/items?url=https%3A%2F%2Fgithub.com%2Flogin');
  });

  it('reports a locked or unreachable vault', async () => {
    const v = createVault('http://localhost:8087', fakeBw({ locked: true }).f);
    expect((await v.status()).state).toBe('locked');
    await expect(v.logins('https://github.com/')).rejects.toThrow(/locked/);
    const down = createVault('http://localhost:1', (async () => {
      throw new TypeError('NetworkError');
    }) as unknown as typeof fetch);
    expect((await down.status()).state).toBe('unreachable');
  });

  it('refuses to hand out an item for another site', async () => {
    const v = createVault('http://localhost:8087', fakeBw().f);
    await expect(v.secret('a1', 'https://evil.test/', false)).rejects.toThrow(/not saved for evil.test/);
  });
});

describe('login tool', () => {
  it('is offered only when Bitwarden is on', () => {
    expect(toolsFor(false).map(t => t.name)).not.toContain('login');
    expect(parseAction('{"tool":"login"}', false).ok).toBe(false);
    expect(parseAction('{"tool":"sign_in","account":"2"}', false, true)).toMatchObject({ ok: true, action: { tool: 'login', option: '2' } });
    expect(systemPrompt({ vision: false, reasoning: true })).not.toContain('"login"');
    expect(systemPrompt({ vision: false, reasoning: true, login: true })).toContain('{"tool":"login","enter":true}');
  });

  it('every-action mode asks even with the sign-in ask off; full auto never asks', async () => {
    const every = exec({ ask: false, approval: 'every' });
    expect((await run(every.e, '{"tool":"login"}')).ok).toBe(true);
    expect(every.gates.map(g => g.risk)).toEqual(['login']);
    const off = exec({ ask: true, approval: 'off' });
    expect((await run(off.e, '{"tool":"login"}')).ok).toBe(true);
    expect(off.gates).toEqual([]);
    expect(off.log.find(c => c.op === 'fillLogin')).toMatchObject({ approved: true });
  });

  it('asks, then fills from the vault; the agent never sees the secrets', async () => {
    const { e, log, gates } = exec();
    const r = await run(e, '{"tool":"login","enter":true}');
    expect(r.ok).toBe(true);
    expect(gates).toEqual([{ risk: 'login', what: 'sign in to github.com with Bitwarden login "GitHub" (j•••@gmail.com), then submit' }]);
    const fill = log.find(c => c.op === 'fillLogin');
    expect(fill).toMatchObject({ origin: 'https://github.com', username: USERNAME, password: PASSWORD, enter: true, approved: true });
    expect(fill.totp).toBeUndefined();
    for (const s of [PASSWORD, USERNAME, TOTP]) expect(r.text).not.toContain(s);
    expect(r.text).toContain('hidden from you');
  });

  it('reads the vault only after approval, and a decline sticks', async () => {
    const { e, log, bw } = exec({ approve: false });
    const r = await run(e, '{"tool":"login"}');
    expect(r).toMatchObject({ ok: false });
    expect(r.text).toContain('declined');
    expect(log.some(c => c.op === 'fillLogin')).toBe(false);
    expect(bw.calls.some(c => c.startsWith('GET /object/'))).toBe(false);
    expect((await run(e, '{"tool":"login"}')).text).toContain('already declined');
  });

  it('can skip the approval when the user turned it off', async () => {
    const { e, gates } = exec({ ask: false });
    expect((await run(e, '{"tool":"login"}')).ok).toBe(true);
    expect(gates).toEqual([]);
  });

  it('fills a one-time code page from the authenticator key', async () => {
    const { e, log } = exec({ form: { user: false, pass: false, otp: true } });
    expect((await run(e, '{"tool":"login"}')).ok).toBe(true);
    expect(log.find(c => c.op === 'fillLogin')).toMatchObject({ totp: TOTP, username: undefined, password: undefined });
  });

  it('lists accounts when several match, and takes a choice', async () => {
    const items = [
      { id: 'a1', type: 1, name: 'GitHub', login: { username: USERNAME, password: PASSWORD, uris: [{ uri: 'github.com' }] } },
      { id: 'c3', type: 1, name: 'GitHub work', login: { username: 'jd@corp.test', password: 'w0rk', uris: [{ uri: 'github.com' }] } },
    ];
    const { e, log } = exec({ bw: fakeBw({ items }) });
    const r = await run(e, '{"tool":"login"}');
    expect(r.ok).toBe(false);
    expect(r.text).toContain('1) "GitHub" j•••@gmail.com, 2) "GitHub work" j•••@corp.test');
    expect(log.some(c => c.op === 'fillLogin')).toBe(false);
    expect((await run(e, '{"tool":"login","option":"2"}')).ok).toBe(true);
    expect(log.find(c => c.op === 'fillLogin').password).toBe('w0rk');
  });

  it('explains a locked vault, a page without fields, and a site without logins', async () => {
    expect((await run(exec({ bw: fakeBw({ locked: true }) }).e, '{"tool":"login"}')).text).toMatch(/locked/);
    expect((await run(exec({ form: { user: false, pass: false } }).e, '{"tool":"login"}')).text).toMatch(/no sign-in fields/);
    expect((await run(exec({ bw: fakeBw({ items: [] }) }).e, '{"tool":"login"}')).text).toMatch(/no login saved for github.com/);
  });
});

describe('bridge', () => {
  const host = (log: any[]) => fakeHost({}, log);
  const handler = (vaultOn: boolean, log: any[]) =>
    createBridgeHandler({
      settings: () => ({ ...DEFAULTS, vault: true }),
      target: async () => ({ tabId: 1, windowId: 1 }),
      approve: async () => true,
      runTask: async () => null,
      busy: () => false,
      note: () => {},
      vault: () => (vaultOn ? createVault('http://localhost:8087', fakeBw().f) : null),
      createHost: () => host(log),
      tabAlive: async () => true,
    });

  it('offers login to coding agents only when allowed', async () => {
    const off = await handler(false, [])({ op: 'act', actions: [{ tool: 'login' }], observe: false });
    expect(off).toMatchObject({ ok: false });
    expect(off.text).toContain('Unknown tool');
    const log: any[] = [];
    const on = await handler(true, log)({ op: 'act', actions: [{ tool: 'login' }], observe: false });
    expect(on.ok).toBe(true);
    expect(on.text).not.toContain(PASSWORD);
    expect(log.some(c => c.op === 'fillLogin')).toBe(true);
  });
});
