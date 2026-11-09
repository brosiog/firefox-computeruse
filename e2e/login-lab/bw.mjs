// A fake `bw serve` for the login lab, with failure modes. Strict where the real one is: a request carrying an Origin
// header, or with a Host other than localhost/127.0.0.1, gets 403 (counted in `log.rejected`).
//
// handle({ method, path, headers }) → { status, body, delay } so the same logic runs behind a real HTTP server (Firefox
// lab) and behind a fetch shim (unit lab).

export const TOTP = '492817';

/**
 * modes: locked | unauthenticated | html403 | garbage | 500 | failNoMessage | dataNull | slow | totpFail | item404 |
 * getOtherSite | listNotArray
 */
export function createBw() {
  const bw = { items: [], mode: null, log: { calls: [], rejected: 0 } };
  bw.handle = ({ method = 'GET', path, headers = {} }) => {
    const u = new URL(path, 'http://localhost');
    bw.log.calls.push(`${method} ${u.pathname}${u.search}`);
    const host = String(headers.host ?? 'localhost:1').toLowerCase();
    if (headers.origin !== undefined || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
      bw.log.rejected++;
      return { status: 403, body: '' };
    }
    const ok = data => ({ status: 200, body: JSON.stringify({ success: true, data }) });
    const fail = (message, status = 400) => ({ status, body: JSON.stringify({ success: false, message }) });
    const m = bw.mode;
    if (m === 'html403') return { status: 403, body: '<html>Forbidden</html>' };
    if (m === 'garbage') return { status: 200, body: '{"success": tru' };
    if (m === '500') return { status: 500, body: 'Internal Server Error' };
    const status = m === 'locked' ? 'locked' : m === 'unauthenticated' ? 'unauthenticated' : 'unlocked';
    if (u.pathname === '/status') return ok({ object: 'template', template: { status, userEmail: 'owner@lab.test' } });
    if (m === 'locked') return fail('Vault is locked.');
    if (m === 'unauthenticated') return fail('You are not logged in.');
    if (m === 'failNoMessage') return { status: 400, body: JSON.stringify({ success: false }) };
    if (m === 'dataNull') return ok(null);
    const delay = m === 'slow' ? 2500 : 0;
    if (u.pathname === '/list/object/items') {
      if (m === 'listNotArray') return ok({ object: 'list', data: { nope: true } });
      return { ...ok({ object: 'list', data: bw.items }), delay };
    }
    let r = /^\/object\/item\/(.+)$/.exec(u.pathname);
    if (r) {
      if (m === 'item404') return fail('Not found.', 404);
      const it = bw.items.find(i => i.id === r[1]);
      if (!it) return fail('Not found.', 404);
      if (m === 'getOtherSite') return ok({ ...it, login: { ...it.login, uris: [{ uri: 'http://evil.test' }] } });
      return { ...ok(it), delay };
    }
    r = /^\/object\/totp\/(.+)$/.exec(u.pathname);
    if (r) {
      if (m === 'totpFail') return fail('Internal error.', 500);
      const it = bw.items.find(i => i.id === r[1]);
      if (!it?.login?.totp) return fail('No TOTP available for this login.');
      return ok({ object: 'string', data: TOTP });
    }
    return fail('Not found.', 404);
  };
  /** A fetch for the unit lab. */
  bw.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const r = bw.handle({ method: init.method ?? 'GET', path: u.pathname + u.search, headers: { host: u.host } });
    if (r.delay) await new Promise(res => setTimeout(res, Math.min(r.delay, 50)));
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  return bw;
}
