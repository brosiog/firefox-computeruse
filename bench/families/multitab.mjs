// Compare one item across two vendor pages that open in new tabs; answer needs both facts (cross-tab memory).
import { esc, page } from '../lib/gen.mjs';
import { quote, ref } from '../lib/oracle.mjs';

export default {
  id: 'multitab',
  about: 'two new-tab pages, compare a fact across them, answer with a computed difference',
  make(ctx) {
    const item = `${ctx.word('brand')} ${ctx.word('product')}`;
    const vendors = ctx.shuffle(['Northwind', 'Contoso', 'Fabrikam', 'Tailspin', 'Wingtip', 'Adatum']).slice(0, 3);
    const [v1, v2] = vendors;
    let p1 = ctx.int(2000, 9000);
    let p2 = ctx.int(2000, 9000);
    if (p1 === p2) p2 += 150;
    const prices = { [v1]: p1 / 100, [v2]: p2 / 100, [vendors[2]]: ctx.int(2000, 9000) / 100 };
    const cheaper = prices[v1] < prices[v2] ? v1 : v2;
    const diff = Math.abs(prices[v1] - prices[v2]).toFixed(2);
    return {
      goal: `Compare the price of the ${item} at ${v1} and at ${v2} (their pages open in new tabs from the comparison page). Which is cheaper, and by how much?`,
      data: { v1, v2, prices, cheaper, diff, item },
      route(path, req, job) {
        const b = job.base;
        if (path === '/') {
          const links = vendors.map(v => `<li><a href="${b}/v/${v}" target="_blank">See ${esc(item)} at ${v}</a></li>`).join('');
          return { html: page(ctx, { title: 'Price compare', body: `<h1>Where to buy the ${esc(item)}</h1><ul>${links}</ul>`, nav: [[`${b}/`, 'Compare']] }) };
        }
        const m = /^\/v\/(\w+)$/.exec(path);
        if (m && prices[m[1]] !== undefined) {
          job.log.push({ type: 'visit', v: m[1] });
          const other = `<p>Shipping: ${ctx.int(2, 9)}-${ctx.int(10, 14)} days.</p><p>Rating: ${ctx.int(30, 50) / 10} stars.</p>`;
          return { html: page(ctx, { title: `${m[1]} — ${item}`, body: `<h1>${m[1]}</h1><h2>${esc(item)}</h2><p>Our price: $${prices[m[1]].toFixed(2)}</p>${other}`, nav: [[`${b}/v/${m[1]}`, m[1]]] }) };
        }
        return null;
      },
      validate(_job, out) {
        const a = out.answer;
        if (!a.includes(cheaper)) return { pass: false, reason: `cheaper vendor ${cheaper} not named` };
        if (!a.includes(diff) && !a.includes(diff.replace(/\.?0+$/, ''))) return { pass: false, reason: `difference ${diff} missing` };
        return { pass: true };
      },
      oracle(v, job) {
        // Known = the price appears in what the model has seen or written (page history, or its own notes).
        const seen = x => v.all.includes(prices[x].toFixed(2));
        const s1 = seen(v1);
        const s2 = seen(v2);
        if (s1 && s2) return { act: { tool: 'done', answer: `${cheaper} is cheaper by $${diff}.`, success: true }, accept: [{ tool: 'done', answer: new RegExp(quote(cheaper)) }] };
        const want = !s1 ? v1 : v2;
        const link = ref(v, new RegExp(`^link "See [^"]* at ${want}"`, 'i'));
        if (link) return { act: { tool: 'click', ref: link }, accept: [{ tool: 'click', ref: link }, { tool: 'tab_new', url: new RegExp(want) }] };
        // On a vendor tab: go back to the comparison page (another tab), or open the other vendor directly.
        const tabN = (/\[(\d+)\]\*? Price compare/.exec(v.tabs) || [])[1];
        const accept = [{ tool: 'tab_new', url: new RegExp(want) }, { tool: 'navigate', url: new RegExp(`/v/${want}|/t/[^/]+/?$`) }, { tool: 'back' }, { tool: 'tab_close' }];
        if (tabN) accept.push({ tool: 'tab_switch', tab: Number(tabN) });
        return { act: tabN ? { tool: 'tab_switch', tab: Number(tabN) } : { tool: 'navigate', url: `${job.origin}${job.base}/` }, accept };
      },
    };
  },
};
