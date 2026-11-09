// @vitest-environment node
import { spawn, execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBridgeHandler, startBridge, type BridgeCmd } from '../src/bridge';
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

describe('bridge hub (bridge/fcu.mjs)', () => {
  const script = resolve(import.meta.dirname, '../bridge/fcu.mjs');
  const port = String(40000 + Math.floor(Math.random() * 20000));
  const env = { ...process.env, FCU_BRIDGE_PORT: port };

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
      const stop = startBridge(`http://127.0.0.1:${port}`, async cmd => (seen.push(cmd), { ok: true, text: `ran ${cmd.op}`, image: cmd.op === 'observe' ? 'SU1H' : undefined }), v => (up = v));
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

        // A web page can't reach it: a foreign Origin is refused even with the header.
        const r = await fetch(`http://127.0.0.1:${port}/call`, { method: 'POST', headers: { 'x-fcu': '1', origin: 'https://evil.test' }, body: '{}' });
        expect(r.status).toBe(403);
        const r2 = await fetch(`http://127.0.0.1:${port}/call`, { method: 'POST', body: '{}' });
        expect(r2.status).toBe(403);
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
    expect(Date.now() - t0).toBeLessThan(9000);
  }, 15000);
});
