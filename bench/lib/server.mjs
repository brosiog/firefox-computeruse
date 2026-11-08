// The bench server: every job gets its own path (/t/<job>/…) on one origin, a second origin (localhost vs
// 127.0.0.1, same port) for cross-origin frames, the job queue the extension's bench build pulls from, and the oracle
// model (/v1, OpenAI-compatible) for oracle-mode runs.
import http from 'node:http';
import { interruptions, view } from './oracle.mjs';
import { applyPerturb } from './perturb.mjs';

export function createServer(port) {
  const jobs = new Map();
  const queue = [];
  const waiters = new Map();
  const origin = `http://127.0.0.1:${port}`;
  const altOrigin = `http://localhost:${port}`;

  const readBody = req =>
    new Promise(r => {
      let b = '';
      req.on('data', c => (b += c));
      req.on('end', () => r(b));
    });

  const send = (res, code, body, type = 'text/html; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };

  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, origin);
    try {
      if (u.pathname === '/e2e/next') {
        const job = queue.shift();
        if (!job) return send(res, 204, '');
        job.startedAt = Date.now();
        return send(
          res,
          200,
          JSON.stringify({
            id: job.id,
            settings: job.settings,
            task: job.inst.goal,
            startUrl: origin + job.base + (job.inst.start ?? '/'),
            tabUrl: origin + job.base,
            approve: job.inst.approve ?? 'yes',
            timeoutMs: job.timeoutMs,
          }),
          'application/json',
        );
      }
      if (u.pathname === '/e2e/report' && req.method === 'POST') {
        const rep = JSON.parse(await readBody(req));
        const job = jobs.get(rep.job);
        if (job) {
          job.report = rep;
          job.endedAt = Date.now();
          // Validation reads server-side state: let requests the page already sent (a delayed save) land first.
          for (let i = 0; i < 40 && job.inflight > 0; i++) await new Promise(r => setTimeout(r, 100));
          waiters.get(job.id)?.(job);
        }
        return send(res, 200, 'ok', 'text/plain');
      }
      if (u.pathname.startsWith('/v1/')) return oracleModel(req, res, u);

      const m = /^\/t\/([^/]+)(\/.*)?$/.exec(u.pathname);
      const job = m && jobs.get(m[1]);
      if (!job) return send(res, 404, 'no such job');
      const path = m[2] || '/';
      if (path === '/__trap') {
        job.log.push({ type: 'trap' });
        return send(res, 200, '<!doctype html><title>Verified</title><p>Verified.</p>');
      }
      if (path === '/__popup_subscribe') {
        job.log.push({ type: 'popup-subscribe' });
        return send(res, 200, 'ok', 'text/plain');
      }
      job.inflight = (job.inflight ?? 0) + 1;
      let out;
      try {
        if (job.perturb === 'slow') await new Promise(r => setTimeout(r, 500));
        const body = req.method === 'POST' ? new URLSearchParams(await readBody(req)) : null;
        out = await job.inst.route(path, { method: req.method, query: u.searchParams, form: body, url: u }, job);
      } finally {
        job.inflight--;
      }
      if (!out) return send(res, 404, '<!doctype html><title>Not found</title><h1>Not found</h1>');
      if (out.redirect) {
        res.writeHead(303, { location: job.base + out.redirect });
        return res.end();
      }
      if (out.text !== undefined) return send(res, out.status ?? 200, out.text, 'text/plain');
      // Frames are served raw; perturbations apply to top-level pages only.
      const html = out.frame ? out.html : applyPerturb(job.perturb, out.html, job);
      return send(res, out.status ?? 200, html);
    } catch (e) {
      console.error('route error', req.url, e);
      return send(res, 500, String(e?.stack ?? e), 'text/plain');
    }
  });

  // ---------- oracle model ----------
  async function oracleModel(req, res, u) {
    if (u.pathname.endsWith('/models')) return send(res, 200, JSON.stringify({ data: [{ id: 'oracle' }] }), 'application/json');
    const j = JSON.parse((await readBody(req)) || '{}');
    if (!Array.isArray(j.messages)) return send(res, 400, JSON.stringify({ error: { message: 'messages required' } }), 'application/json');
    const msgs = j.messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map(p => p.text ?? '').join('') }));
    const v = view(msgs);
    const id = (/\/t\/([^/]+)/.exec(v.all) || [])[1];
    const job = jobs.get(id);
    let action = { tool: 'done', answer: 'oracle: unknown job', success: false };
    if (job) {
      const verdict = interruptions(v, job) ?? job.inst.oracle(v, job);
      action = verdict?.act ?? { tool: 'done', answer: `oracle: no move at ${v.path}`, success: false };
    }
    const text = JSON.stringify(action);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: Math.ceil(msgs.reduce((n, m) => n + m.content.length, 0) / 3.6), completion_tokens: Math.ceil(text.length / 3.6) } })}\n\n`);
    res.end('data: [DONE]\n\n');
  }

  return {
    origin,
    altOrigin,
    jobs,
    listen: () => new Promise(r => srv.listen(port, '127.0.0.1', r)),
    close: () => srv.close(),
    enqueue(job) {
      job.base = `/t/${job.id}`;
      job.origin = origin;
      job.altOrigin = altOrigin;
      job.log = [];
      jobs.set(job.id, job);
      queue.push(job);
      return new Promise(r => waiters.set(job.id, r));
    },
  };
}
