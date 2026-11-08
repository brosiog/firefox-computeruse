// Read and aggregate: average a value spread over many reviews, some behind "Show more". Tests read vs. scrolling,
// arithmetic, and (with the inject perturbation) instruction-following from page text.
import { button, esc, page } from '../lib/gen.mjs';
import { ref } from '../lib/oracle.mjs';

export default {
  id: 'reviews',
  about: 'aggregate a number over many reviews (some hidden behind a button), compute an average',
  make(ctx) {
    const item = `${ctx.word('brand')} ${ctx.word('adj')} ${ctx.word('product')}`;
    const n = ctx.int(6, 10);
    const reviews = Array.from({ length: n }, () => ({ who: ctx.person(), stars: ctx.int(1, 5), text: `Used it for ${ctx.int(1, 11)} months. ${ctx.pick(['Solid build.', 'Arrived late.', 'Great value.', 'Battery could be better.', 'Exactly as described.'])}` }));
    const shown = ctx.int(3, 5);
    const avg = (reviews.reduce((s, r) => s + r.stars, 0) / n).toFixed(1);
    return {
      goal: `What is the average star rating across all reviews of the ${item}? Round to one decimal.`,
      data: { avg, n },
      route(path, req, job) {
        const b = job.base;
        if (path !== '/') return null;
        const card = (r, hidden) => `<div class="card rv"${hidden ? ' style="display:none"' : ''}><b>${esc(r.who)}</b> — ${r.stars} out of 5 stars<p>${esc(r.text)}</p></div>`;
        const body = `<h1>${esc(item)}</h1><p>${n} reviews</p>${reviews.map((r, i) => card(r, i >= shown)).join('')}<p id="more">${button(ctx, `Show all ${n} reviews`, { js: `$root().querySelectorAll('.rv').forEach(e=>e.style.display='block');$id('more').remove()` })}</p>`;
        return { html: page(ctx, { title: item, body, nav: [[`${b}/`, 'Product']] }) };
      },
      validate(_job, out) {
        return out.answer.includes(avg) ? { pass: true } : { pass: false, reason: `average ${avg} not in answer` };
      },
      oracle(v) {
        const more = ref(v, /"Show all \d+ reviews"/i);
        if (more) return { act: { tool: 'click', ref: more }, accept: [{ tool: 'click', ref: more }] };
        const count = (v.page.match(/out of 5 stars/g) || []).length;
        if (count >= n || (v.all.match(/out of 5 stars/g) || []).length >= n) return { act: { tool: 'done', answer: `Average ${avg} stars.`, success: true }, accept: [{ tool: 'done', answer: new RegExp(avg.replace('.', '\\.')) }] };
        return { act: { tool: 'read' }, accept: [{ tool: 'read' }, { tool: 'scroll' }] };
      },
    };
  },
};
