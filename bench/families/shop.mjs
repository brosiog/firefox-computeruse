// Search → compare prices → product page (quantity, late-rendered buy button) → checkout in a new tab → cross-origin
// payment frame → gated purchase → order number.
import { button, esc, page } from '../lib/gen.mjs';
import { quote, ref } from '../lib/oracle.mjs';

export default {
  id: 'shop',
  about: 'search, compare, select quantity, late button, new-tab checkout, cross-origin frame, payment approval',
  make(ctx) {
    const kind = ctx.word('product');
    const n = ctx.int(4, 6);
    const products = Array.from({ length: n }, (_, i) => ({
      id: 10 + i,
      name: `${ctx.word('brand')} ${ctx.word('adj')} ${kind} ${String.fromCharCode(65 + i)}${ctx.int(1, 9)}`,
      price: ctx.int(1500, 12000) / 100,
    }));
    const cheapest = products.reduce((a, b) => (b.price < a.price ? b : a));
    const qty = ctx.int(2, 3);
    const person = ctx.person();
    const L = { add: ctx.word('addToCart'), checkout: ctx.word('checkout'), place: ctx.word('placeOrder') };
    return {
      goal: `Find the cheapest ${kind} in this shop, order ${qty} of them for ${person}, and tell me the order number.`,
      data: { products, cheapest, qty, person, L, kind },
      route(path, req, job) {
        const b = job.base;
        const P = (title, body, script = '') => ({ html: page(ctx, { title, body, script, nav: [[`${b}/`, 'Home'], [`${b}/help`, 'Help']] }) });
        if (path === '/') {
          return P('Shop', `<h1>${esc(ctx.word('brand'))} Store</h1><form role="search" action="${b}/search"><label>Search the store <input name="q"></label> ${button(ctx, 'Search', { submit: true })}</form>`);
        }
        if (path.startsWith('/search')) {
          const q = (req.query.get('q') || '').toLowerCase();
          const hits = products.filter(p => q.split(/\s+/).filter(Boolean).some(w => p.name.toLowerCase().includes(w)));
          const list = ctx.shuffle(hits).map(p => `<div class="card"><h3><a href="${b}/p/${p.id}">${esc(p.name)}</a></h3><p>Price: $${p.price.toFixed(2)}</p></div>`).join('');
          return P('Results', `<h1>Results for “${esc(q)}”</h1>${list || '<p>No results.</p>'}`);
        }
        const pm = /^\/p\/(\d+)$/.exec(path);
        if (pm) {
          const p = products.find(x => x.id === Number(pm[1]));
          if (!p) return null;
          job.log.push({ type: 'view', id: p.id });
          return P(
            p.name,
            `<h1>${esc(p.name)}</h1><p>Price: $${p.price.toFixed(2)}</p><label for="qty">Quantity</label> <select id="qty">${[1, 2, 3, 4].map(i => `<option>${i}</option>`).join('')}</select>
            <div id="buy">Loading…</div><p id="msg"></p>`,
            `setTimeout(()=>{$id('buy').innerHTML=${JSON.stringify(button(ctx, L.add, { id: 'add', js: `const q=$id('qty').value;$id('msg').innerHTML='Added '+q+' to your cart. <a target=_blank href=${b}/checkout?p=${p.id}&qty='+q+'>${L.checkout}</a>';` }))}},${ctx.int(300, 900)});`,
          );
        }
        if (path.startsWith('/checkout')) {
          const frame = `${job.altOrigin}${b}/card`;
          return P(
            'Checkout',
            `<h1>Checkout</h1><form method="post" action="${b}/order"><input type="hidden" name="p" value="${esc(req.query.get('p'))}"><input type="hidden" name="qty" value="${esc(req.query.get('qty'))}">
            <p><label>Full name <input name="name" required></label></p><iframe src="${frame}" style="width:380px;height:110px;border:1px solid #ccc"></iframe><p>${button(ctx, L.place, { submit: true })}</p></form>`,
          );
        }
        if (path === '/card') {
          return { frame: true, html: `<!doctype html><body style="font:14px system-ui"><label>Name on card <input id="h" autocomplete="cc-name" oninput="fetch('${b}/card-holder?v='+encodeURIComponent(this.value))"></label></body>` };
        }
        if (path.startsWith('/card-holder')) {
          job.data.holder = req.query.get('v');
          return { text: 'ok' };
        }
        if (path === '/order' && req.method === 'POST') {
          const o = { p: Number(req.form.get('p')), qty: Number(req.form.get('qty')), name: req.form.get('name'), holder: job.data.holder, number: `${ctx.word('brand').slice(0, 2).toUpperCase()}-${ctx.int(10000, 99999)}` };
          job.log.push({ type: 'order', ...o });
          return P('Order confirmed', `<h1>Thank you!</h1><p>Order number: ${o.number}</p><p>${o.qty} × item ${o.p} for ${esc(o.name)}.</p>`);
        }
        if (path === '/help') return P('Help', '<h1>Help</h1><p>Contact support for help with orders.</p>');
        return null;
      },
      validate(job, out) {
        const orders = job.log.filter(e => e.type === 'order');
        const o = orders[0];
        if (orders.length !== 1) return { pass: false, reason: `${orders.length} orders placed` };
        if (o.p !== cheapest.id) return { pass: false, reason: `ordered item ${o.p}, cheapest is ${cheapest.id}` };
        if (o.qty !== qty) return { pass: false, reason: `quantity ${o.qty}, wanted ${qty}` };
        if (o.name !== person) return { pass: false, reason: `name "${o.name}"` };
        if (!out.answer.includes(o.number)) return { pass: false, reason: 'order number missing from the answer' };
        return { pass: true };
      },
      oracle(v, job) {
        const d = job.data;
        const p = v.path;
        const ctl = name => ref(v, new RegExp(`^(button|link|clickable) "${quote(name)}`, 'i'));
        if (p === '/' || p === '') {
          const box = ref(v, /^(textbox|searchbox) "Search/i);
          if (box) return { act: { think: 'Search.', tool: 'type', ref: box, text: kind, enter: true }, accept: [{ tool: 'type', ref: box, text: new RegExp(quote(kind.split(' ').pop()), 'i') }] };
        }
        if (p.startsWith('/search')) {
          const r = ctl(d.cheapest.name);
          if (r) return { act: { think: 'Open the cheapest.', tool: 'click', ref: r }, accept: [{ tool: 'click', ref: r }] };
        }
        const pm = /^\/p\/(\d+)/.exec(p);
        if (pm) {
          if (Number(pm[1]) !== d.cheapest.id) return { act: { tool: 'back' }, accept: [{ tool: 'back' }, { tool: 'navigate' }] };
          const sel = ref(v, /^combobox "Quantity"/i);
          if (sel && !new RegExp(`combobox "Quantity" value="${d.qty}"`).test(v.page)) return { act: { think: 'Set quantity.', tool: 'select', ref: sel, option: String(d.qty) }, accept: [{ tool: 'select', ref: sel, option: new RegExp(`^${d.qty}$`) }] };
          const co = ctl(d.L.checkout);
          if (co) return { act: { think: 'Checkout.', tool: 'click', ref: co }, accept: [{ tool: 'click', ref: co }] };
          const add = ctl(d.L.add);
          if (add) return { act: { think: 'Add.', tool: 'click', ref: add }, accept: [{ tool: 'click', ref: add }] };
          return { act: { tool: 'wait', seconds: 1 }, accept: [{ tool: 'wait' }] };
        }
        if (p.startsWith('/checkout')) {
          const name = ref(v, /^textbox "Full name" empty/i);
          const holder = ref(v, /^textbox "Name on card" empty/i);
          const place = ctl(d.L.place);
          const acc = [];
          if (name) acc.push({ tool: 'type', ref: name, text: new RegExp(`^${quote(d.person)}$`) });
          if (holder) acc.push({ tool: 'type', ref: holder, text: new RegExp(`^${quote(d.person)}$`) });
          // The card holder is optional for the order; the name is not.
          if (!name && place) acc.push({ tool: 'click', ref: place });
          if (acc.length) {
            const first = acc[0];
            return { act: first.tool === 'type' ? { think: 'Fill.', tool: 'type', ref: first.ref, text: d.person } : { think: 'Place.', tool: 'click', ref: place }, accept: acc };
          }
        }
        const num = /Order number: ([\w-]+)/.exec(v.page);
        if (num) return { act: { tool: 'done', answer: `Order number ${num[1]}.`, success: true }, accept: [{ tool: 'done', answer: new RegExp(quote(num[1])) }] };
        return null;
      },
    };
  },
};
