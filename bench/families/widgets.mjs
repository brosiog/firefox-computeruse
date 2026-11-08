// Settings behind a hover menu, with toggles that are custom elements rendering role=switch inside closed shadow
// roots, then save.
import { button, page } from '../lib/gen.mjs';
import { quote, ref } from '../lib/oracle.mjs';

const SETTINGS = ['Email notifications', 'SMS alerts', 'Weekly digest', 'Location sharing', 'Personalized ads', 'Read receipts'];

export default {
  id: 'widgets',
  about: 'hover menu navigation, closed-shadow-root switches, save',
  make(ctx) {
    const init = Object.fromEntries(SETTINGS.map(s => [s, ctx.r() < 0.5]));
    const [on, off] = ctx.shuffle(SETTINGS).slice(0, 2);
    init[on] = false;
    init[off] = true;
    const L = { save: ctx.word('save') };
    const want = { ...init, [on]: true, [off]: false };
    return {
      goal: `Open the privacy settings from the Account menu, turn on "${on}" and turn off "${off}", then save. Leave the other settings as they are.`,
      data: { on, off, init, want, L },
      route(path, req, job) {
        const b = job.base;
        const nav = [[`${b}/`, 'Home']];
        if (path === '/') {
          const menu = `<span class="has-menu" style="position:relative;display:inline-block"><span tabindex="0" style="cursor:pointer;padding:4px 8px;border:1px solid #999">Account ▾</span>
            <span class="menu"><a href="${b}/profile">Profile</a><br><a href="${b}/privacy">Privacy settings</a><br><a href="${b}/billing">Billing</a></span></span>`;
          return { html: page(ctx, { title: 'Dashboard', body: `<div style="display:flex;justify-content:space-between"><h1>Dashboard</h1>${menu}</div><p>Welcome back.</p>`, nav }) };
        }
        if (path === '/privacy') {
          const state = job.data.saved ?? init;
          const rows = SETTINGS.map(s => `<p><x-switch data-label="${s}" data-on="${state[s] ? 1 : 0}"></x-switch></p>`).join('');
          const script = `customElements.define('x-switch',class extends HTMLElement{connectedCallback(){const r=this.attachShadow({mode:'closed'});
            const on=this.dataset.on==='1';r.innerHTML='<style>b{display:inline-block;width:36px;height:20px;border-radius:10px;background:#ccc;vertical-align:middle}b[aria-checked=true]{background:#2a7}</style><b role="switch" tabindex="0" aria-checked="'+on+'" aria-label="'+this.dataset.label+'"></b> <span>'+this.dataset.label+'</span>';
            const s=r.querySelector('b');s.onclick=()=>{const v=s.getAttribute('aria-checked')!=='true';s.setAttribute('aria-checked',v);this.dataset.on=v?'1':'0'}}});
            window.__save=()=>{const o={};$root().querySelectorAll('x-switch').forEach(x=>o[x.dataset.label]=x.dataset.on==='1');$id('st').textContent='Saving…';fetch('${b}/save',{method:'POST',body:new URLSearchParams({s:JSON.stringify(o)})}).then(()=>$id('st').textContent='Settings saved.')}`;
          return { html: page(ctx, { title: 'Privacy settings', body: `<h1>Privacy settings</h1>${rows}<p>${button(ctx, L.save, { js: 'window.__save()' })} <span id="st"></span></p>`, script, nav }) };
        }
        if (path === '/save' && req.method === 'POST') {
          job.data.saved = JSON.parse(req.form.get('s'));
          job.log.push({ type: 'save', s: job.data.saved });
          return { text: 'ok' };
        }
        if (path === '/profile' || path === '/billing') return { html: page(ctx, { title: path.slice(1), body: `<h1>${path.slice(1)}</h1><p>Nothing here.</p>`, nav }) };
        return null;
      },
      validate(job) {
        const saves = job.log.filter(e => e.type === 'save');
        if (!saves.length) return { pass: false, reason: 'never saved' };
        const s = saves[saves.length - 1].s;
        const bad = SETTINGS.filter(k => s[k] !== want[k]);
        return bad.length ? { pass: false, reason: `wrong: ${bad.join(', ')}` } : { pass: true };
      },
      oracle(v, job) {
        if (/Settings saved\./.test(v.page)) return { act: { tool: 'done', answer: 'Saved.', success: true }, accept: [{ tool: 'done' }] };
        if (v.path === '/' || v.path === '') {
          const link = ref(v, /^link "Privacy settings"/i);
          if (link) return { act: { tool: 'click', ref: link }, accept: [{ tool: 'click', ref: link }, { tool: 'navigate', url: /privacy/ }] };
          const acct = ref(v, /"Account/i);
          const hovered = /hovered [^\n]*Account/.test(v.user);
          const accept = [{ tool: 'hover', ref: acct }, { tool: 'click', ref: acct }, { tool: 'navigate', url: /privacy/ }, { tool: 'find', text: /privacy/i }];
          if (hovered) return { act: { tool: 'find', text: 'Privacy settings' }, accept };
          return { act: { tool: 'hover', ref: acct }, accept };
        }
        if (v.path.startsWith('/privacy')) {
          const acc = [];
          const a = ref(v, new RegExp(`^switch "${quote(on)}" unchecked`, 'i'));
          const c = ref(v, new RegExp(`^switch "${quote(off)}" checked`, 'i'));
          if (a) acc.push({ tool: 'click', ref: a });
          if (c) acc.push({ tool: 'click', ref: c });
          if (acc.length) return { act: { tool: 'click', ref: acc[0].ref }, accept: acc };
          const save = ref(v, new RegExp(`^(button|link|clickable) "${quote(L.save)}"`, 'i'));
          if (save) return { act: { tool: 'click', ref: save }, accept: [{ tool: 'click', ref: save }] };
        }
        return { act: { tool: 'navigate', url: `${job.origin}${job.base}/privacy` }, accept: [{ tool: 'back' }, { tool: 'navigate', url: /privacy/ }] };
      },
    };
  },
};
