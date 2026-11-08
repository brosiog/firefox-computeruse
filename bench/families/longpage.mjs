// A long article with near-identical controls far below the fold; exactly one is right.
import { button, esc, page } from '../lib/gen.mjs';
import { quote, ref } from '../lib/oracle.mjs';

export default {
  id: 'longpage',
  about: 'target control many screens down among near-duplicates (find vs scroll, distractor resistance)',
  make(ctx) {
    const topic = ctx.word('topic');
    const year = ctx.int(2019, 2025);
    const q = ctx.int(1, 4);
    const sections = ctx.int(10, 16);
    const para = () => Array.from({ length: ctx.int(3, 6) }, () => `The ${topic} working group reviewed findings from site ${ctx.int(1, 90)} and noted a ${ctx.int(2, 40)}% change.`).join(' ');
    return {
      goal: `On this page, download the Q${q} ${year} report about ${topic}.`,
      data: { q, year, topic },
      route(path, req, job) {
        const b = job.base;
        if (path === '/') {
          const secs = Array.from({ length: sections }, (_, i) => `<h2>Section ${i + 1}</h2><p>${para()}</p><p>${para()}</p>`).join('');
          const btns = ctx
            .shuffle([1, 2, 3, 4].flatMap(k => [[k, year], [k, year - 1]]))
            .map(([k, y]) => `<p>${button(ctx, `Download Q${k} ${y} report`, { js: `fetch('${b}/dl?q=${k}&y=${y}').then(()=>{this.textContent='Downloaded ✓'})` })}</p>`)
            .join('');
          return { html: page(ctx, { title: `${topic} — annual review`, body: `<h1>${esc(topic)}: annual review</h1>${secs}<h2>Downloads</h2>${btns}`, nav: [[`${b}/`, 'Review']] }) };
        }
        if (path.startsWith('/dl')) {
          job.log.push({ type: 'dl', q: Number(req.query.get('q')), y: Number(req.query.get('y')) });
          return { text: 'ok' };
        }
        return null;
      },
      validate(job) {
        const d = job.log.filter(e => e.type === 'dl');
        if (!d.length) return { pass: false, reason: 'nothing downloaded' };
        if (d.some(e => e.q !== q || e.y !== year)) return { pass: false, reason: `downloaded ${d.map(e => `Q${e.q} ${e.y}`).join(', ')}` };
        return { pass: true };
      },
      oracle(v) {
        if (/Downloaded ✓/.test(v.page) || /clicked [^\n]*Download Q/.test(v.all)) {
          if (new RegExp(`clicked [^\\n]*"Download Q${q} ${year} report"`).test(v.all)) return { act: { tool: 'done', answer: 'Downloaded.', success: true }, accept: [{ tool: 'done' }] };
        }
        const r = ref(v, new RegExp(`^(button|link|clickable) "Download Q${q} ${year} report"`, 'i'));
        if (r) return { act: { tool: 'click', ref: r }, accept: [{ tool: 'click', ref: r }] };
        return { act: { tool: 'find', text: `Download Q${q} ${year}` }, accept: [{ tool: 'find' }, { tool: 'scroll', dir: 'down' }, { tool: 'key', key: /end|pagedown/i }] };
      },
    };
  },
};
void quote;
