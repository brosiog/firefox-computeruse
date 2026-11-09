// Fixture shop + a fake OpenAI-compatible model server for the end-to-end run.
//
// The fake model is a small rule-based policy that reads the page state in the prompt, like a model would, and replies
// with one JSON action over SSE. It behaves like Splash/Ollama where it matters for the extension:
// - it rejects requests that carry a moz-extension:// Origin header (the background must strip it),
// - it reports prompt_tokens and cached_tokens (computed from the prefix shared with the previous request),
// - it accepts response_format json_schema.
import http from 'node:http';

const SHOP = 'http://127.0.0.1';
const FRAME = 'http://localhost'; // a different origin: the card field lives in a cross-origin iframe
export const PORTS = { shop: 8791, frame: 8792, model: 8793 };
export const state = { gates: [], approveNext: null, orders: [], requests: [], originRejected: 0, prefixShare: [], config: null, report: null, onReport: null };

const layout = (title, body, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px system-ui;margin:0}header{display:flex;gap:12px;padding:10px;background:#eee}main{padding:16px}
.card{border:1px solid #ccc;padding:8px;margin:6px 0;cursor:pointer}.modal{position:fixed;inset:0;background:#0006;display:flex;align-items:center;justify-content:center}
.modal>div{background:#fff;padding:20px}</style>${extra}</head><body>
<header><a href="/">Home</a><a href="/deals">Deals</a><a href="/help">Help</a></header><main>${body}</main></body></html>`;

const PRODUCTS = [
  { id: 1, name: 'MegaDock USB-C Hub 12-in-1', price: 89.0 },
  { id: 2, name: 'TinyHub USB-C 4-port', price: 19.5 },
  { id: 3, name: 'ProLink USB Hub 7-port', price: 34.99 },
];

function shop(req, res, port, framePort) {
  const u = new URL(req.url, `${SHOP}:${port}`);
  const send = (html, code = 200) => {
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  };
  if (u.pathname === '/e2e/next') {
    // One job, then nothing: the background stops asking.
    if (state.served) {
      res.writeHead(204);
      return res.end();
    }
    state.served = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: 'e2e', startUrl: state.config.tabUrl + '/', ...state.config }));
  }
  if (u.pathname === '/e2e/approve') {
    // e2e:bridge: the panel asks how to answer an approval card; the test sets the answer and sees which gate fired.
    state.gates.push(u.searchParams.get('risk'));
    res.writeHead(200, { 'content-type': 'text/plain' });
    return setTimeout(() => res.end(state.approveNext ?? 'no'), 300);
  }
  if (u.pathname === '/e2e/report' && req.method === 'POST') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      state.report = JSON.parse(body);
      res.end('ok');
      state.onReport?.(state.report);
    });
    return;
  }
  if (u.pathname === '/') {
    return send(
      layout(
        'Hub Shop',
        `<h1>Hub Shop</h1><p>All the hubs you need.</p>
        <form role="search" action="/search"><input name="q" aria-label="Search products" placeholder="Search"><button>Search</button></form>
        <div class="modal" id="consent" role="dialog" aria-modal="true" aria-label="Cookies"><div><p>We use cookies.</p>
        <button onclick="document.getElementById('consent').remove()">Accept all</button></div></div>`,
      ),
    );
  }
  if (u.pathname === '/search') {
    const q = (u.searchParams.get('q') || '').toLowerCase();
    const hits = PRODUCTS.filter(p => q.split(/\s+/).some(w => p.name.toLowerCase().includes(w)));
    const filler = Array.from({ length: 30 }, (_, i) => `<p>Sponsored accessory ${i + 1} — cables, adapters and more.</p>`).join('');
    return send(
      layout(
        'Results',
        `<h1>Results for "${q}"</h1><label>Sort <select><option>Relevance</option><option>Price</option></select></label>
        ${hits.map(p => `<div class="card" onclick="location.href='/product/${p.id}'"><h3>${p.name}</h3><p>Price: $${p.price.toFixed(2)}</p></div>`).join('')}
        ${filler}`,
      ),
    );
  }
  const pm = /^\/product\/(\d+)$/.exec(u.pathname);
  if (pm) {
    const p = PRODUCTS.find(x => x.id === Number(pm[1]));
    return send(
      layout(
        p.name,
        `<h1>${p.name}</h1><p>Price: $${p.price.toFixed(2)}</p>
        <label for="qty">Quantity</label><select id="qty"><option>1</option><option>2</option><option>3</option></select>
        <div id="buy">Loading…</div><p id="msg"></p>`,
        `<script>
        // The button appears late (client rendering), and the checkout link opens a new tab.
        setTimeout(() => {
          document.getElementById('buy').innerHTML = '<button id="add">Add to cart</button>';
          document.getElementById('add').addEventListener('click', () => {
            const q = document.getElementById('qty').value;
            document.getElementById('msg').innerHTML = 'Added ' + q + ' to your cart. <a href="/checkout?p=${p.id}&qty=' + q + '" target="_blank">Proceed to checkout</a>';
          });
        }, 400);
        </script>`,
      ),
    );
  }
  if (u.pathname === '/checkout') {
    return send(
      layout(
        'Checkout',
        `<h1>Checkout</h1><form method="post" action="/order">
        <input type="hidden" name="p" value="${u.searchParams.get('p')}"><input type="hidden" name="qty" value="${u.searchParams.get('qty')}">
        <label>Full name <input name="name" required></label>
        <iframe src="${FRAME}:${framePort}/card" style="width:360px;height:120px;border:1px solid #ccc"></iframe>
        <button type="submit">Place order</button></form>`,
      ),
    );
  }
  if (u.pathname === '/order' && req.method === 'POST') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const f = new URLSearchParams(body);
      const order = { p: f.get('p'), qty: f.get('qty'), name: f.get('name'), number: 'A' + (1000 + state.orders.length + 234) };
      state.orders.push(order);
      send(layout('Order confirmed', `<h1>Thank you!</h1><p>Order number: ${order.number}</p><p>${order.qty} × product ${order.p} for ${order.name}.</p>`));
    });
    return;
  }
  send(layout('Not found', '<h1>Not found</h1>'), 404);
}

function cardFrame(req, res) {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><body style="font:14px system-ui"><label>Card holder <input id="holder" autocomplete="cc-name"></label>
  <p id="echo"></p><script>document.getElementById('holder').addEventListener('input', e => document.getElementById('echo').textContent = 'Holder: ' + e.target.value)</script></body>`);
}

// ---------- fake model ----------

const lastUser = msgs => [...msgs].reverse().find(m => m.role === 'user')?.content ?? '';
const textOf = c => (typeof c === 'string' ? c : c.map(p => p.text ?? '').join(''));
const ref = (page, re) => {
  for (const line of page.split('\n')) {
    const m = /^\s*\[([\d:]+)\]\s(.*)$/.exec(line);
    if (m && re.test(m[2])) return m[1];
  }
  return null;
};

export function policy(msgs) {
  const all = msgs.map(m => textOf(m.content)).join('\n');
  const tail = textOf(lastUser(msgs));
  const page = (/<page>\n([\s\S]*?)<\/page>/.exec(tail) || [])[1] ?? '';
  const url = (/^URL: (.*)$/m.exec(tail) || [])[1] ?? '';
  const say = (think, a) => ({ think, ...a });

  if (/Modal dialog open/.test(tail) && ref(page, /"Accept all"/)) return say('Close the cookie dialog.', { tool: 'click', ref: ref(page, /"Accept all"/) });
  if (url.endsWith(':' + new URL(url || 'http://x').port + '/') && ref(page, /textbox "Search products"/)) {
    return say('Search for USB hubs.', { tool: 'type', ref: ref(page, /textbox "Search products"/), text: 'usb hub', enter: true });
  }
  if (url.includes('/search')) {
    // Use read with a query to compare prices, then click the cheapest product card.
    const readResults = [...all.matchAll(/Price: \$([\d.]+)/g)];
    if (!/"tool":"read"/.test(all)) return say('Compare prices.', { tool: 'read', query: 'price' });
    const cards = page.split('\n').filter(l => /clickable ".*Price: \$/.test(l));
    let best = null;
    for (const l of cards) {
      const m = /^\[([\d:]+)\].*Price: \$([\d.]+)/.exec(l);
      if (m && (!best || Number(m[2]) < best.price)) best = { ref: m[1], price: Number(m[2]) };
    }
    if (best && readResults.length) return say(`Cheapest is $${best.price}.`, { tool: 'click', ref: best.ref });
    return say('Look for products.', { tool: 'find', text: 'Price' });
  }
  if (url.includes('/product/')) {
    const qty = ref(page, /combobox "Quantity"/);
    if (qty && !/combobox "Quantity" value="2"/.test(page)) return say('Set quantity to 2.', { tool: 'select', ref: qty, option: '2' });
    const checkout = ref(page, /link "Proceed to checkout"/);
    if (checkout) return say('Go to checkout.', { tool: 'click', ref: checkout });
    const add = ref(page, /button "Add to cart"/);
    if (add) return say('Add it to the cart.', { tool: 'click', ref: add });
    return say('The buy button is still loading.', { tool: 'wait', seconds: 1 });
  }
  if (url.includes('/checkout')) {
    const name = ref(page, /textbox "Full name" empty/);
    if (name) return say('Fill in the name.', { tool: 'type', ref: name, text: 'Ada Lovelace' });
    const holder = ref(page, /textbox "Card holder" empty/);
    if (holder) return say('Fill in the card holder in the payment frame.', { tool: 'type', ref: holder, text: 'Ada Lovelace' });
    const place = ref(page, /button "Place order"/);
    if (place) return say('Place the order.', { tool: 'click', ref: place });
  }
  if (/Order number: (\w+)/.test(page)) {
    const n = /Order number: (\w+)/.exec(page)[1];
    return say('Done.', { tool: 'done', answer: `Ordered 2 × TinyHub USB-C 4-port ($19.50). Order number ${n}.`, success: true });
  }
  return say('Unexpected page.', { tool: 'done', answer: `stuck at ${url}`, success: false });
}

function sharedPrefix(a, b) {
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function model(req, res) {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'fake-splash' }] }));
  }
  if (/^moz-extension:/.test(req.headers.origin || '')) {
    state.originRejected++;
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('origin not allowed');
  }
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    if (!Array.isArray(j.messages)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'messages required' } }));
    }
    const flat = j.messages.map(m => `<${m.role}>${textOf(m.content)}`).join('');
    const prev = state.requests[state.requests.length - 1];
    const cached = prev ? sharedPrefix(prev.flat, flat) : 0;
    state.requests.push({ flat, response_format: j.response_format?.type, reasoning_effort: j.reasoning_effort });
    if (prev) state.prefixShare.push(cached / flat.length);
    const action = policy(j.messages);
    const text = JSON.stringify(action);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // Stream in small chunks like a real server.
    for (let i = 0; i < text.length; i += 12) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 12) } }] })}\n\n`);
    }
    const usage = {
      prompt_tokens: Math.ceil(flat.length / 4),
      completion_tokens: Math.ceil(text.length / 4),
      prompt_tokens_details: { cached_tokens: Math.floor(cached / 4) },
    };
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
}

export function start() {
  return new Promise(resolve => {
    const servers = {};
    const shopSrv = http.createServer((q, r) => shop(q, r, servers.shop, servers.frame));
    const frameSrv = http.createServer(cardFrame);
    const modelSrv = http.createServer(model);
    let n = 0;
    const done = () => ++n === 3 && resolve({ ...servers, close: () => [shopSrv, frameSrv, modelSrv].forEach(s => s.close()) });
    shopSrv.listen(PORTS.shop, '127.0.0.1', () => ((servers.shop = PORTS.shop), done()));
    frameSrv.listen(PORTS.frame, '127.0.0.1', () => ((servers.frame = PORTS.frame), done()));
    modelSrv.listen(PORTS.model, '127.0.0.1', () => ((servers.model = PORTS.model), done()));
  });
}
