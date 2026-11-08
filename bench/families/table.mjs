// Look up one row in a paginated table: the target is on a later page, rows must be read across cells.
import { button, esc, page } from '../lib/gen.mjs';
import { quote, ref } from '../lib/oracle.mjs';

export default {
  id: 'table',
  about: 'paginated table lookup: find a row on a later page and report two of its cells',
  make(ctx) {
    const per = 15;
    // Every row has a distinct first+last name: near-namesakes ("Hedy S. Knuth" next to "Hedy Knuth") made the ground
    // truth ambiguous, and a model treating them as one person was arguably right. Rows are capped by the name pool.
    const combos = ctx.pool.first.length * ctx.pool.last.length;
    const total = Math.min(ctx.int(40, 60), combos - 2);
    const used = new Set();
    const rows = [];
    while (rows.length < total) {
      const name = ctx.person();
      if (used.has(name)) continue;
      used.add(name);
      rows.push({ name, dept: ctx.word('dept'), city: ctx.word('city'), salary: ctx.int(40, 190) * 1000 });
    }
    const ti = ctx.int(per, total - 1);
    const target = rows[ti];
    const pages = Math.ceil(total / per);
    const L = { next: ctx.word('next') };
    const fmt = n => `$${n.toLocaleString('en-US')}`;
    return {
      goal: `In the staff directory, find ${target.name} and tell me their office city and salary.`,
      data: { target, L },
      route(path, req, job) {
        const b = job.base;
        if (path !== '/' && !path.startsWith('/?')) return null;
        const pg = Math.min(pages, Math.max(1, Number(req.query.get('page')) || 1));
        const slice = rows.slice((pg - 1) * per, pg * per);
        const body = `<h1>Staff directory</h1><p>Page ${pg} of ${pages}</p><table><thead><tr><th>Name</th><th>Department</th><th>Office</th><th>Salary</th></tr></thead><tbody>
          ${slice.map(r => `<tr><td>${esc(r.name)}</td><td>${r.dept}</td><td>${r.city}</td><td>${fmt(r.salary)}</td></tr>`).join('')}</tbody></table>
          <p>${pg > 1 ? `<a href="${b}/?page=${pg - 1}">Previous</a>` : ''} ${pg < pages ? button(ctx, L.next, { js: `location.href='${b}/?page=${pg + 1}'` }) : ''}</p>`;
        return { html: page(ctx, { title: `Directory — page ${pg}`, body, nav: [[`${b}/`, 'Directory']] }) };
      },
      validate(_job, out) {
        const a = out.answer.replace(/,/g, '');
        const okCity = a.includes(target.city);
        const okSal = a.includes(String(target.salary)) || a.includes(`${target.salary / 1000}k`) || a.includes(`${target.salary / 1000}K`);
        if (!okCity || !okSal) return { pass: false, reason: `answer lacks ${!okCity ? `city ${target.city}` : ''} ${!okSal ? `salary ${target.salary}` : ''}`.trim() };
        return { pass: true };
      },
      oracle(v) {
        const text = v.user.replace(/^Task:.*$/m, '');
        const near = () => {
          for (let i = text.indexOf(target.name); i >= 0; i = text.indexOf(target.name, i + 1)) {
            const w = text.slice(i, i + target.name.length + 120);
            // The name must not continue (another row with a longer name), and the row's cells must follow it.
            if (/^[A-Za-z]/.test(text[i + target.name.length] ?? '') ) continue;
            if (w.includes(target.city) && w.includes(fmt(target.salary))) return true;
          }
          return false;
        };
        const done = { act: { tool: 'done', answer: `${target.name}: ${target.city}, ${fmt(target.salary)}.`, success: true }, accept: [{ tool: 'done', answer: new RegExp(quote(target.city)) }] };
        if (near()) return done;
        const next = ref(v, new RegExp(`^(button|link|clickable) "${quote(L.next)}"`, 'i'));
        const pager = next ? [{ tool: 'click', ref: next }, { tool: 'navigate', url: /page=/ }] : [];
        const missing = /nothing on this page matches|No text on this page matches|No exact match for|Nothing on this page contains|No line contains all/.test(text);
        if (missing && next) return { act: { tool: 'click', ref: next }, accept: pager };
        // On this page but not readable yet (below the fold, or cells split): read the row.
        if (text.includes(target.name) && !missing) return { act: { tool: 'read', query: target.name }, accept: [{ tool: 'read' }, { tool: 'scroll' }] };
        return { act: { tool: 'find', text: target.name }, accept: pager };
      },
    };
  },
};
