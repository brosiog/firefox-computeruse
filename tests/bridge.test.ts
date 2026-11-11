// @vitest-environment node
import { spawn, execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bridgeAuth, bridgeKey, createBridgeHandler, openBridgeCmd, startBridge, type BridgeCmd } from '../src/bridge';
import type { Host } from '../src/browser/host';
import { DEFAULTS } from '../src/settings';

function fakeHost(log: string[]): Host {
  let url = 'https://shop.test/';
  return {
    tabId: 1,
    observe: async () => ({ url, title: 'Shop', refs: ['1', '2'], text: `URL: ${url}\n<page>\n[1] textbox "Search"\n[2] button "Buy"\n</page>` }),
    act: async (ref, cmd: any) => {
      log.push(`${cmd.op}:${ref ?? ''}${cmd.approved ? ':approved' : ''}`);
      if (cmd.op === 'click' && ref === '2' && !cmd.approved) return { ok: false, error: 'gate', gate: { risk: 'pay', what: 'button "Buy"' } };
      return { ok: true, msg: `${cmd.op} done` };
    },
    settle: async () => '',
    navigate: async u => ((url = `https://${u}/`), `opened ${url}`),
    back: async () => 'back',
    tabs: async () => [],
    newTab: async () => 'new',
    switchTab: async () => 'sw',
    closeTab: async () => 'closed',
    screenshot: async () => 'SU1H',
  };
}

function handler(log: string[], over: Partial<Parameters<typeof createBridgeHandler>[0]> = {}) {
  const approvals: string[] = [];
  const settings = { ...DEFAULTS };
  const h = createBridgeHandler({
    settings: () => settings,
    target: async () => ({ tabId: 1, windowId: 1 }),
    approve: async g => (approvals.push(g.risk), true),
    runTask: async t => ({ success: true, answer: `did ${t}` }),
    busy: () => false,
    note: () => {},
    createHost: () => fakeHost(log),
    tabAlive: async () => true,
    ...over,
  });
  return { h, approvals };
}

describe('bridge handler', () => {
  it('runs actions, gates them, and returns the new page state', async () => {
    const log: string[] = [];
    const { h, approvals } = handler(log);
    const r = await h({ op: 'act', actions: [{ tool: 'type', ref: '1', text: 'hub', enter: true }, { tool: 'click', ref: '2' }] });
    expect(log).toEqual(['type:1', 'click:2', 'click:2:approved']);
    expect(approvals).toEqual(['pay']);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('click [2]: OK');
    expect(r.text).toContain('<page>');
  });

  it('stops after a page change and reports what did not run', async () => {
    const log: string[] = [];
    const { h } = handler(log);
    const r = await h({ op: 'act', actions: [{ tool: 'navigate', url: 'x.test' }, { tool: 'click', ref: '1' }], observe: false });
    expect(log).toEqual([]);
    expect(r.text).toContain('remaining 1 action(s) were not run');
    expect(r.text).not.toContain('<page>');
  });

  it('validates actions and refuses agent-loop-only tools', async () => {
    const { h } = handler([]);
    expect((await h({ op: 'act', actions: [{ tool: 'type', ref: '1' }] })).text).toContain('"text"');
    expect((await h({ op: 'act', actions: [{ tool: 'done', answer: 'x' }] })).ok).toBe(false);
    // Aliases the in-browser parser knows work here too.
    expect((await h({ op: 'act', actions: ['{"name":"go_to_url","arguments":{"url":"a.test"}}'], observe: false })).ok).toBe(true);
  });

  it('observe returns a screenshot on request; task delegates; busy blocks actions', async () => {
    const { h } = handler([], { busy: () => true });
    const o = await h({ op: 'observe', screenshot: true });
    expect(o.image).toBe('SU1H');
    expect((await h({ op: 'act', actions: [{ tool: 'back' }] })).ok).toBe(false);
    expect((await h({ op: 'task', task: 'it' })).text).toBe('did it');
  });
});

describe('bridge handler tab following', () => {
  it('keeps the agent\'s own tab, but follows a tab the user switched to', async () => {
    let active = 1;
    (globalThis as any).browser = { tabs: { query: async () => [{ id: active }], get: async (id: number) => ({ id, url: 'https://x.test/', status: 'complete' }) } };
    const made: number[] = [];
    try {
      const h = createBridgeHandler({
        settings: () => DEFAULTS,
        target: async () => ({ tabId: active, windowId: 1 }),
        approve: async () => true,
        runTask: async () => null,
        busy: () => false,
        note: () => {},
        tabAlive: async () => true,
        createHost: tabId => (made.push(tabId), { ...fakeHost([]), tabId }),
      });
      await h({ op: 'observe' });
      await h({ op: 'observe' });
      expect(made).toEqual([1]);
      active = 2; // the user clicked another tab
      await h({ op: 'observe' });
      expect(made).toEqual([1, 2]);
      await h({ op: 'observe' });
      expect(made).toEqual([1, 2]);
    } finally {
      delete (globalThis as any).browser;
    }
  });
});

const TOKEN = 'test-pairing-token-0123456789abcdef';
const hmac = (msg: string, key = TOKEN) => createHmac('sha256', key).update(msg).digest('hex');

describe('bridge pairing', () => {
  it('is off by default', () => {
    expect(DEFAULTS.bridgeUrl).toBe('');
    expect(DEFAULTS.bridgeToken).toBe('');
  });

  it('opens only commands signed with the token, for this session, byte for byte', async () => {
    const key = await bridgeKey(TOKEN);
    const cmd = JSON.stringify({ op: 'observe', screenshot: true });
    const msg = (over: Record<string, unknown> = {}) => ({ id: 'j1', cmd, sig: hmac(`j1\ns1\n${cmd}`), ...over });
    expect(await openBridgeCmd(key, 's1', msg())).toEqual({ id: 'j1', cmd: { op: 'observe', screenshot: true } });
    expect(await openBridgeCmd(key, 's1', msg({ sig: hmac(`j1\ns1\n${cmd}`, 'another-token') }))).toBeNull();
    expect(await openBridgeCmd(key, 's2', msg())).toBeNull(); // signed for another sidebar
    expect(await openBridgeCmd(key, 's1', msg({ id: 'j2' }))).toBeNull();
    expect(await openBridgeCmd(key, 's1', msg({ cmd: JSON.stringify({ op: 'task', task: 'x' }) }))).toBeNull();
    expect(await openBridgeCmd(key, 's1', msg({ sig: undefined }))).toBeNull();
    expect(await openBridgeCmd(key, 's1', { id: 'j1', cmd: { op: 'observe' }, sig: hmac('j1\ns1\n{"op":"observe"}') })).toBeNull(); // an object, not signed text
  });

  it('request auth is a fresh MAC, never the token', async () => {
    const a = await bridgeAuth(await bridgeKey(TOKEN), '/poll', '{"session":"s"}');
    const m = /^FCU (\d+)\.([\w-]+)\.([0-9a-f]{64})$/.exec(a)!;
    expect(m).not.toBeNull();
    expect(a).not.toContain(TOKEN);
    expect(m[3]).toBe(hmac(`fcu-req\n${m[1]}\n${m[2]}\n/poll\n{"session":"s"}`));
    expect(await bridgeAuth(await bridgeKey(TOKEN), '/poll', '{"session":"s"}')).not.toBe(a);
  });

  it('the sidebar runs a hub\'s command only with a valid sig (a squatter on the port cannot drive it)', async () => {
    // A fake hub: hands out one forged command, one replay-free valid one, then nothing.
    const auths: string[] = [];
    let n = 0;
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c)).on('end', () => {
        auths.push(String(req.headers.authorization));
        if (req.url !== '/poll') return res.writeHead(204).end();
        const { session } = JSON.parse(body);
        n++;
        const cmd = JSON.stringify({ op: 'task', task: n === 1 ? 'forged' : 'real' });
        const sig = n === 1 ? hmac(`j${n}\n${session}\n${cmd}`, 'guessed-token') : hmac(`j${n}\n${session}\n${cmd}`);
        if (n > 2) return void setTimeout(() => res.writeHead(204).end(), 200);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `j${n}`, cmd, sig }));
      });
    });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    const ran: string[] = [];
    const issues: string[] = [];
    const stop = startBridge(`http://127.0.0.1:${(srv.address() as any).port}`, TOKEN, async c => (ran.push((c as any).task), { ok: true, text: '' }), () => {}, t => issues.push(t));
    try {
      for (let i = 0; i < 100 && !ran.length; i++) await new Promise(r => setTimeout(r, 50));
      expect(ran).toEqual(['real']);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain('not signed with the pairing token');
      expect(auths.every(a => a.startsWith('FCU ') && !a.includes(TOKEN))).toBe(true);
    } finally {
      stop();
      srv.close();
    }
  }, 10000);

  it('an empty poll reply shows the hub as connected only when it is signed over the poll nonce', async () => {
    for (const signed of [false, true]) {
      const srv = http.createServer((req, res) => {
        req.resume().on('end', () => {
          const nonce = String(req.headers.authorization).split(' ')[1].split('.')[1];
          setTimeout(() => res.writeHead(204, signed ? { 'x-fcu-sig': hmac(`fcu-idle\n${nonce}`) } : {}).end(), 50);
        });
      });
      await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
      let up = false;
      const issues: string[] = [];
      const stop = startBridge(`http://127.0.0.1:${(srv.address() as any).port}`, TOKEN, async () => ({ ok: true, text: '' }), v => (up = v), t => issues.push(t));
      try {
        await new Promise(r => setTimeout(r, 400));
        expect(up).toBe(signed);
        expect(issues.length).toBe(signed ? 0 : 1);
      } finally {
        stop();
        srv.close();
      }
    }
  }, 10000);
});

describe('bridge hub (bridge/fcu.mjs)', () => {
  const script = resolve(import.meta.dirname, '../bridge/fcu.mjs');
  const port = String(40000 + Math.floor(Math.random() * 20000));
  const env = { ...process.env, FCU_BRIDGE_PORT: port, FCU_BRIDGE_TOKEN: TOKEN };

  it('MCP over stdio, a CLI relay, and the extension poll loop', async () => {
    const mcp = spawn(process.execPath, [script], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    const pending = new Map<number, (m: any) => void>();
    let buf = '';
    mcp.stdout.setEncoding('utf8').on('data', c => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        pending.get(m.id)?.(m);
      }
    });
    let n = 0;
    const rpc = (method: string, params?: unknown) =>
      new Promise<any>(res => {
        const id = ++n;
        pending.set(id, res);
        mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });

    try {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
      expect(init.result.serverInfo.name).toBe('firefox-computeruse');
      const list = await rpc('tools/list');
      expect(list.result.tools.map((t: any) => t.name)).toEqual(['browser_observe', 'browser_act', 'browser_task']);

      // The "extension": the real poll client with a stub handler.
      const seen: BridgeCmd[] = [];
      let up = false;
      const stop = startBridge(`http://127.0.0.1:${port}`, TOKEN, async cmd => (seen.push(cmd), { ok: true, text: `ran ${cmd.op}`, image: cmd.op === 'observe' ? 'SU1H' : undefined }), v => (up = v));
      try {
        const obs = await rpc('tools/call', { name: 'browser_observe', arguments: { screenshot: true } });
        expect(obs.result.content).toEqual([{ type: 'text', text: 'ran observe' }, { type: 'image', data: 'SU1H', mimeType: 'image/jpeg' }]);
        expect(up).toBe(true);
        const act = await rpc('tools/call', { name: 'browser_act', arguments: { actions: [{ tool: 'click', ref: '3' }] } });
        expect(act.result.isError).toBe(false);
        expect(seen[1]).toEqual({ op: 'act', actions: [{ tool: 'click', ref: '3' }], observe: true, screenshot: false });

        // A second bridge process (another harness, or the CLI) relays through the first one's hub.
        const out = await new Promise<string>((res, rej) =>
          execFile(process.execPath, [script, 'task', 'find', 'a', 'hub'], { env }, (e, so) => (e ? rej(e) : res(so))),
        );
        expect(out.trim()).toBe('ran task');
        expect(seen[2]).toEqual({ op: 'task', task: 'find a hub' });

        // A web page can't reach it: a foreign Origin is refused even with the header and the token.
        const bearer = { 'x-fcu': '1', authorization: `Bearer ${TOKEN}` };
        const r = await fetch(`http://127.0.0.1:${port}/call`, { method: 'POST', headers: { ...bearer, origin: 'https://evil.test' }, body: '{}' });
        expect(r.status).toBe(403);
        const r2 = await fetch(`http://127.0.0.1:${port}/call`, { method: 'POST', body: '{}' });
        expect(r2.status).toBe(403);
        // Nor can another local process without the token (or with a wrong one, or a replayed request).
        for (const path of ['/ping', '/poll', '/result', '/call']) {
          expect((await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'x-fcu': '1' }, body: '{}' })).status).toBe(403);
          expect((await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'x-fcu': '1', authorization: 'Bearer nope' }, body: '{}' })).status).toBe(403);
        }
        const ping = await fetch(`http://127.0.0.1:${port}/ping`, { method: 'POST', headers: bearer, body: '{}' });
        expect(ping.status).toBe(200);
        expect((await ping.json()).fcu).toBeTruthy();
        const auth = await bridgeAuth(await bridgeKey(TOKEN), '/ping', '{}');
        const signed = () => fetch(`http://127.0.0.1:${port}/ping`, { method: 'POST', headers: { 'x-fcu': '1', authorization: auth }, body: '{}' });
        expect((await signed()).status).toBe(200);
        expect((await signed()).status).toBe(403); // same nonce again
        const other = await bridgeAuth(await bridgeKey(TOKEN), '/ping', '{}');
        expect((await fetch(`http://127.0.0.1:${port}/ping`, { method: 'POST', headers: { 'x-fcu': '1', authorization: other }, body: '{"x":1}' })).status).toBe(403); // body changed
        expect((await fetch(`http://127.0.0.1:${port}/poll`, { method: 'POST', headers: { 'x-fcu': '1', authorization: other }, body: '{}' })).status).toBe(403); // path changed

        // A relay with another token is refused, and says why.
        const wrong = await new Promise<string>(res =>
          execFile(process.execPath, [script, 'observe'], { env: { ...env, FCU_BRIDGE_TOKEN: 'someone-else' } }, (_e, _so, se) => res(se)),
        );
        expect(wrong).toContain('refused this process\'s pairing token');
      } finally {
        stop();
      }
    } finally {
      mcp.kill();
    }
  }, 30000);

  it('fails fast with a clear message when the sidebar is not connected', async () => {
    const t0 = Date.now();
    const err = await new Promise<string>(res =>
      execFile(process.execPath, [script, 'observe'], { env: { ...env, FCU_BRIDGE_PORT: String(Number(port) + 1) } }, (_e, _so, se) => res(se)),
    );
    expect(err).toContain('not connected');
    expect(err).toContain('fcu.mjs token');
    expect(Date.now() - t0).toBeLessThan(9000);
  }, 15000);

  it('makes a per-user token file once (0600 in a 0700 dir) and reuses it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fcu-token-'));
    const { FCU_BRIDGE_TOKEN: _, ...base } = env;
    const tokenOut = () =>
      new Promise<string>((res, rej) => execFile(process.execPath, [script, 'token'], { env: { ...base, XDG_CONFIG_HOME: dir } }, (e, so) => (e ? rej(e) : res(so.trim()))));
    try {
      const t1 = await tokenOut();
      expect(t1).toMatch(/^[\w-]{43}$/); // 32 bytes, base64url
      expect(await tokenOut()).toBe(t1);
      if (process.platform !== 'win32') {
        expect(statSync(join(dir, 'fcu')).mode & 0o777).toBe(0o700);
        expect(statSync(join(dir, 'fcu', 'token')).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
