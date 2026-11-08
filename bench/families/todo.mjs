// A list that re-renders (and re-sorts) after every change: elements are replaced, so refs from before an action are
// stale after it. Also a gated delete.
import { esc, page } from '../lib/gen.mjs';
import { quote, ref } from '../lib/oracle.mjs';

const VERBS = ['Renew', 'Email', 'Book', 'Order', 'Return', 'Review', 'Pay', 'Call', 'Pick up', 'Archive'];

export default {
  id: 'todo',
  about: 're-rendering list (stale refs), check items, gated delete',
  make(ctx) {
    const items = [];
    while (items.length < 7) {
      const t = `${ctx.pick(VERBS)} ${ctx.word('product')} for ${ctx.word('first')}`;
      if (!items.includes(t)) items.push(t);
    }
    const [a, b2, c] = ctx.shuffle(items);
    return {
      goal: `In my to-do list, mark "${a}" and "${b2}" as done, and delete "${c}".`,
      data: { a, b: b2, c },
      route(path, req, job) {
        const b = job.base;
        if (path !== '/') return path === '/state' && req.method === 'POST' ? (job.log.push({ type: 'state', s: JSON.parse(req.form.get('s')) }), { text: 'ok' }) : null;
        const script = `let items=${JSON.stringify(items.map(t => ({ t, done: false })))};
          const render=()=>{items.sort((x,y)=>x.done-y.done);const ul=$id('list');ul.innerHTML='';
          for(const it of items){const li=document.createElement('li');li.innerHTML='<label><input type="checkbox"'+(it.done?' checked':'')+'> '+it.t+'</label> <button type="button" aria-label="Delete '+it.t+'">🗑</button>';
          li.querySelector('input').onchange=e=>{it.done=e.target.checked;sync()};li.querySelector('button').onclick=()=>{items=items.filter(x=>x!==it);sync()};ul.appendChild(li)}
          $id('count').textContent=items.filter(x=>!x.done).length+' open';};
          const sync=()=>{fetch('${b}/state',{method:'POST',body:new URLSearchParams({s:JSON.stringify(items)})});setTimeout(render,${ctx.int(50, 250)})};render();`;
        return { html: page(ctx, { title: 'To-do', body: `<h1>To-do</h1><p id="count"></p><ul id="list" style="list-style:none;padding:0"></ul>`, script, nav: [[`${b}/`, 'To-do']] }) };
      },
      validate(job) {
        const s = job.log.filter(e => e.type === 'state').pop()?.s;
        if (!s) return { pass: false, reason: 'no change made' };
        const by = Object.fromEntries(s.map(x => [x.t, x.done]));
        const bad = [];
        if (by[a] !== true) bad.push(`"${a}" not done`);
        if (by[b2] !== true) bad.push(`"${b2}" not done`);
        if (c in by) bad.push(`"${c}" not deleted`);
        for (const t of items) if (t !== a && t !== b2 && t !== c && (by[t] !== false)) bad.push(`"${t}" changed`);
        return bad.length ? { pass: false, reason: bad.join('; ') } : { pass: true };
      },
      oracle(v) {
        const acc = [];
        for (const t of [a, b2]) {
          const r = ref(v, new RegExp(`^checkbox "${quote(t)}" unchecked`, 'i'));
          if (r) acc.push({ tool: 'click', ref: r });
        }
        const del = ref(v, new RegExp(`^button "Delete ${quote(c)}"`, 'i'));
        if (del) acc.push({ tool: 'click', ref: del });
        if (acc.length) return { act: { tool: 'click', ref: acc[0].ref }, accept: acc };
        return { act: { tool: 'done', answer: 'Done.', success: true }, accept: [{ tool: 'done' }] };
      },
    };
  },
};
void esc;
