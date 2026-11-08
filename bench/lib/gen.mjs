// Procedural generation primitives. Everything a task shows is drawn from a seed, so every seed is a new site.
//
// Anti-overfitting: vocabulary and skins are partitioned by split. Holdout jobs draw words, labels and layouts that
// dev jobs never contain, so a prompt tuned on dev cannot memorize holdout surface forms. Families draw everything
// through `ctx` (never hard-code page text) so the partition holds.

export function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

const POOLS = {
  dev: {
    product: ['USB hub', 'desk lamp', 'water bottle', 'backpack', 'keyboard', 'monitor stand', 'phone case', 'notebook'],
    brand: ['Nimbus', 'Arcto', 'Velo', 'Kestrel', 'Lumio', 'Brava', 'Orbix', 'Tandem'],
    adj: ['Compact', 'Pro', 'Ultra', 'Classic', 'Mini', 'Max', 'Eco', 'Prime'],
    first: ['Ada', 'Grace', 'Alan', 'Linus', 'Edsger', 'Barbara', 'Ken', 'Margaret'],
    last: ['Lovelace', 'Hopper', 'Turing', 'Torvalds', 'Dijkstra', 'Liskov', 'Thompson', 'Hamilton'],
    city: ['Lisbon', 'Osaka', 'Denver', 'Tallinn', 'Accra', 'Quito'],
    dept: ['Sales', 'Support', 'Research', 'Finance', 'Legal'],
    topic: ['solar storms', 'urban beekeeping', 'deep sea cables', 'glacier retreat', 'retro computing'],
    addToCart: ['Add to cart', 'Add to basket'],
    checkout: ['Proceed to checkout', 'Go to checkout'],
    placeOrder: ['Place order', 'Buy now'],
    submit: ['Submit', 'Create account'],
    save: ['Save changes', 'Save'],
    dismiss: ['No thanks', 'Close'],
    next: ['Next', 'Next page'],
  },
  holdout: {
    product: ['tripod', 'travel mug', 'wireless mouse', 'yoga mat', 'label printer', 'drawing tablet'],
    brand: ['Quill', 'Zephyr', 'Mosaic', 'Halcyon', 'Ferro', 'Juniper'],
    adj: ['Lite', 'Plus', 'Studio', 'Air', 'Core', 'Edge'],
    first: ['Hedy', 'Katherine', 'Claude', 'Radia', 'Donald', 'Frances'],
    last: ['Lamarr', 'Johnson', 'Shannon', 'Perlman', 'Knuth', 'Allen'],
    city: ['Bergen', 'Cusco', 'Hobart', 'Tbilisi', 'Windhoek'],
    dept: ['Logistics', 'Design', 'Security', 'Procurement'],
    topic: ['mushroom networks', 'tidal power', 'ancient bread', 'satellite debris'],
    addToCart: ['Add to bag', 'Put in cart'],
    checkout: ['Continue to payment', 'Review order'],
    placeOrder: ['Confirm purchase', 'Complete order'],
    submit: ['Register', 'Sign me up'],
    save: ['Apply settings', 'Update preferences'],
    dismiss: ['Maybe later', 'Dismiss'],
    next: ['More results', 'Older'],
  },
};

/** All words a split can show; the prompt lint checks none of them leak into the system prompt. */
export const allVocab = () => Object.values(POOLS).flatMap(p => Object.values(p).flat());

export const SKINS = { dev: ['classic', 'app', 'cards'], holdout: ['shadow', 'rtl-nav'] };
export const BUTTON_STYLES = { dev: ['native', 'div-role', 'pointer-span'], holdout: ['anchor-hash', 'native'] };

export function makeCtx(split, seed) {
  const r = rng(seed);
  const pool = POOLS[split];
  const pick = a => a[Math.floor(r() * a.length)];
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const shuffle = a => {
    const b = [...a];
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
    return b;
  };
  const word = k => pick(pool[k]);
  const skin = pick(SKINS[split]);
  const buttonStyle = pick(BUTTON_STYLES[split]);
  return { split, seed, r, pick, int, shuffle, word, pool, skin, buttonStyle, person: () => `${word('first')} ${word('last')}` };
}

export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * A clickable control in the job's button style. `js` runs on activation; `submit` submits the enclosing form.
 * The point: the same task must pass whether the control is a <button>, an ARIA div, a bare cursor:pointer span, or a
 * href="#" anchor.
 */
export function button(ctx, label, { js = '', submit = false, id = '', style = ctx.buttonStyle } = {}) {
  const act = submit ? `this.closest('form').requestSubmit();${js}` : js;
  const idAttr = id ? ` id="${id}"` : '';
  switch (style) {
    case 'div-role':
      return `<div role="button" tabindex="0"${idAttr} class="btn" onclick="${esc(act)}" onkeydown="if(event.key==='Enter')this.click()">${esc(label)}</div>`;
    case 'pointer-span':
      return `<span${idAttr} class="btn" style="cursor:pointer" onclick="${esc(act)}">${esc(label)}</span>`;
    case 'anchor-hash':
      return `<a href="#"${idAttr} class="btn" onclick="event.preventDefault();${esc(act)}">${esc(label)}</a>`;
    default:
      return `<button type="${submit ? 'submit' : 'button'}"${idAttr} class="btn"${js ? ` onclick="${esc(js)}"` : ''}>${esc(label)}</button>`;
  }
}

const CSS = {
  base: `*{box-sizing:border-box}body{font:15px/1.4 system-ui,sans-serif;margin:0;color:#222}a{color:#0645ad}
.btn{display:inline-block;padding:6px 12px;border:1px solid #888;border-radius:6px;background:#f3f3f3;margin:4px 2px}
.card{border:1px solid #ccc;border-radius:8px;padding:10px;margin:8px 0}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}
.modal{position:fixed;inset:0;background:#0007;display:flex;align-items:center;justify-content:center;z-index:50}.modal>div{background:#fff;padding:20px;border-radius:10px;max-width:420px}
.menu{display:none;position:absolute;background:#fff;border:1px solid #aaa;padding:6px}.has-menu:hover .menu,.has-menu:focus-within .menu{display:block}`,
  classic: `header{display:flex;gap:14px;padding:10px 16px;background:#eef}main{max-width:900px;margin:0 auto;padding:16px}`,
  app: `html,body{height:100%;overflow:hidden}.shell{display:flex;height:100%}nav.side{width:200px;background:#f4f4f8;padding:12px;display:flex;flex-direction:column;gap:8px}
main{flex:1;overflow:auto;padding:16px}`,
  cards: `header{position:sticky;top:0;background:#fff;border-bottom:2px solid #333;padding:8px 16px;display:flex;gap:10px;z-index:5}main{padding:16px;display:block}
.card{display:inline-block;width:46%;vertical-align:top;margin:1%}`,
  shadow: `header{padding:10px 16px;background:#222;color:#fff;display:flex;gap:14px}header a{color:#9cf}main{padding:16px}`,
  'rtl-nav': `.shell{display:grid;grid-template-columns:1fr 220px}nav.side{order:2;background:#fafae8;padding:12px;display:flex;flex-direction:column;gap:6px}main{order:1;padding:20px}`,
};

/** Full page in the job's skin. `shadow` puts the main content inside a closed shadow root (holdout only). */
export function page(ctx, { title, body, head = '', script = '', nav = [] }) {
  const links = nav.map(([href, t]) => `<a href="${href}">${esc(t)}</a>`).join(' ');
  const css = `<style>${CSS.base}${CSS[ctx.skin] ?? ''}</style>`;
  let inner;
  switch (ctx.skin) {
    case 'app':
    case 'rtl-nav':
      inner = `<div class="shell"><nav class="side">${links}</nav><main>${body}</main></div>`;
      break;
    case 'shadow':
      inner = `<header>${links}</header><app-root></app-root>
<template id="tpl"><style>${CSS.base}main{padding:16px}</style><main>${body}</main></template>
<script>{const h=document.querySelector('app-root');const r=h.attachShadow({mode:'closed'});r.appendChild(document.getElementById('tpl').content.cloneNode(true));
window.__root=r;}</script>`;
      break;
    default:
      inner = `<header>${links}</header><main>${body}</main>`;
  }
  // Page scripts find elements through $q/$id so they work in the shadow skin too.
  const helpers = `<script>window.$root=()=>window.__root||document;window.$id=i=>$root().getElementById?$root().getElementById(i):$root().querySelector('#'+i);window.$q=s=>$root().querySelector(s);</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>${css}${head}${helpers}</head><body>${inner}${script ? `<script>${script}</script>` : ''}</body></html>`;
}
