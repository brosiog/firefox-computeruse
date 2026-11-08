// A sign-up form mixing every control kind: text fields, a native select, a custom ARIA listbox, radios, a checkbox
// that starts checked and must be unchecked, a required checkbox, and a gated submit.
import { button, esc, page } from '../lib/gen.mjs';
import { quote, ref } from '../lib/oracle.mjs';

const COUNTRIES = ['Portugal', 'Japan', 'Canada', 'Estonia', 'Ghana', 'Ecuador', 'Norway', 'Peru', 'Georgia', 'Namibia'];
const PLANS = ['Starter', 'Growth', 'Scale', 'Enterprise'];

export default {
  id: 'form',
  about: 'text fields, native select, custom listbox, radios, pre-checked checkbox, required checkbox, gated submit',
  make(ctx) {
    const first = ctx.word('first');
    const last = ctx.word('last');
    const email = `${first}.${last}${ctx.int(1, 99)}@example.org`.toLowerCase();
    const country = ctx.pick(COUNTRIES);
    const plan = ctx.pick(PLANS);
    const billing = ctx.pick(['Monthly', 'Yearly']);
    const L = { submit: ctx.word('submit') };
    const want = { first, last, email, country, plan, billing, newsletter: 'no', terms: 'yes' };
    return {
      goal: `Sign up ${first} ${last} (email ${email}) from ${country} on the ${plan} plan, billed ${billing.toLowerCase()}, without the newsletter. Accept the terms.`,
      data: { want, L },
      route(path, req, job) {
        const b = job.base;
        const P = (title, body, script = '') => ({ html: page(ctx, { title, body, script, nav: [[`${b}/`, 'Sign up'], [`${b}/pricing`, 'Pricing']] }) });
        if (path === '/') {
          const opts = ctx.shuffle(COUNTRIES).map(c => `<option>${c}</option>`).join('');
          const planOpts = PLANS.map(p => `<li role="option" aria-selected="false" data-v="${p}" style="padding:4px;cursor:pointer">${p}</li>`).join('');
          return P(
            'Create your account',
            `<h1>Create your account</h1><form method="post" action="${b}/signup" style="display:grid;gap:10px;max-width:440px">
            <label>First name <input name="first"></label><label>Last name <input name="last"></label><label>Email <input name="email" type="email"></label>
            <label>Country <select name="country"><option value="">Choose…</option>${opts}</select></label>
            <div>Plan: <input type="hidden" name="plan" id="plan"><span style="position:relative;display:inline-block">
              <button type="button" id="pbtn" aria-haspopup="listbox" aria-expanded="false" aria-label="Plan">Choose a plan</button>
              <ul role="listbox" id="plist" aria-label="Plans" style="display:none;position:absolute;background:#fff;border:1px solid #888;margin:0;padding:0;list-style:none;z-index:3">${planOpts}</ul></span></div>
            <fieldset><legend>Billing</legend><label><input type="radio" name="billing" value="Monthly"> Monthly</label> <label><input type="radio" name="billing" value="Yearly"> Yearly</label></fieldset>
            <label><input type="checkbox" name="newsletter" value="yes" checked> Send me the newsletter</label>
            <label><input type="checkbox" name="terms" value="yes"> I accept the terms of service</label>
            <p id="err" style="color:#b00"></p><div>${button(ctx, L.submit, { submit: true })}</div></form>`,
            `const pb=$id('pbtn'),pl=$id('plist');pb.onclick=()=>{const o=pl.style.display==='none';pl.style.display=o?'block':'none';pb.setAttribute('aria-expanded',o)};
            pl.querySelectorAll('[role=option]').forEach(li=>li.onclick=()=>{$id('plan').value=li.dataset.v;pb.textContent=li.dataset.v;pl.querySelectorAll('[role=option]').forEach(x=>x.setAttribute('aria-selected',x===li));pl.style.display='none';pb.setAttribute('aria-expanded','false')});
            $q('form').addEventListener('submit',e=>{const f=e.target;if(!f.terms.checked||!f.plan.value||!f.first.value){e.preventDefault();$id('err').textContent='Please fill in every field and accept the terms.'}});`,
          );
        }
        if (path === '/signup' && req.method === 'POST') {
          const got = Object.fromEntries(['first', 'last', 'email', 'country', 'plan', 'billing', 'newsletter', 'terms'].map(k => [k, req.form.get(k) ?? 'no']));
          job.log.push({ type: 'signup', got });
          return P('Welcome', `<h1>Welcome, ${esc(got.first)}!</h1><p>Your account is ready.</p>`);
        }
        if (path === '/pricing') return P('Pricing', `<h1>Pricing</h1>${PLANS.map(p => `<p>${p}: $${ctx.int(5, 99)}/mo</p>`).join('')}`);
        return null;
      },
      validate(job) {
        const s = job.log.filter(e => e.type === 'signup');
        if (s.length !== 1) return { pass: false, reason: `${s.length} submissions` };
        const bad = Object.entries(want).filter(([k, v]) => s[0].got[k] !== v);
        return bad.length ? { pass: false, reason: bad.map(([k, v]) => `${k}=${s[0].got[k]} (want ${v})`).join(', ') } : { pass: true };
      },
      oracle(v) {
        if (/Welcome, /.test(v.page)) return { act: { tool: 'done', answer: 'Signed up.', success: true }, accept: [{ tool: 'done' }] };
        const acc = [];
        const field = (label, value) => {
          const r = ref(v, new RegExp(`^textbox "${label}" (empty|value="(?!${quote(value)}")[^"]*")`, 'i'));
          if (r) acc.push({ act: { tool: 'type', ref: r, text: value }, spec: { tool: 'type', ref: r, text: new RegExp(`^${quote(value)}$`, 'i') } });
        };
        field('First name', first);
        field('Last name', last);
        field('Email', email);
        const sel = ref(v, /^combobox "Country"/i);
        if (sel && !new RegExp(`combobox "Country" value="${quote(country)}"`).test(v.page)) acc.push({ act: { tool: 'select', ref: sel, option: country }, spec: { tool: 'select', ref: sel, option: new RegExp(quote(country), 'i') } });
        const opt = ref(v, new RegExp(`^option "${plan}"`, 'i'));
        const pbtn = ref(v, /^button "Plan"/i);
        if (opt && !new RegExp(`option "${plan}" selected`).test(v.page)) acc.push({ act: { tool: 'click', ref: opt }, spec: { tool: 'click', ref: opt } });
        else if (pbtn && !opt && !hasPlan(v, plan)) acc.push({ act: { tool: 'click', ref: pbtn }, spec: { tool: 'click', ref: pbtn } });
        const radio = ref(v, new RegExp(`^radio "${billing}" unchecked`, 'i'));
        if (radio) acc.push({ act: { tool: 'click', ref: radio }, spec: { tool: 'click', ref: radio } });
        const nl = ref(v, /^checkbox "Send me the newsletter" checked/i);
        if (nl) acc.push({ act: { tool: 'click', ref: nl }, spec: { tool: 'click', ref: nl } });
        const terms = ref(v, /^checkbox "I accept the terms of service" unchecked/i);
        if (terms) acc.push({ act: { tool: 'click', ref: terms }, spec: { tool: 'click', ref: terms } });
        if (acc.length) {
          // Fields and toggles are independent: the oracle fills them in one chained step (the listbox opener is last,
          // since what it reveals is not on this page state yet).
          const now = acc.filter(x => !(x.act.tool === 'click' && x.act.ref === pbtn));
          const later = acc.filter(x => !now.includes(x));
          const seq = [...now, ...later].map(x => x.act);
          return { act: { think: 'Fill the form.', ...seq[0], then: seq.slice(1) }, accept: acc.map(a => a.spec) };
        }
        const sub = ref(v, new RegExp(`^(button|link|clickable) "${quote(L.submit)}"`, 'i'));
        if (sub) return { act: { think: 'Submit.', tool: 'click', ref: sub }, accept: [{ tool: 'click', ref: sub }] };
        return null;
      },
    };
  },
};

/** The plan button shows the chosen plan's name once one is picked: `button "Plan"` keeps its aria-label, so check the
 *  receipts in history instead. */
function hasPlan(v, plan) {
  return new RegExp(`clicked li "${quote(plan)}"`).test(v.all) || new RegExp(`option "${quote(plan)}" selected`).test(v.page);
}
