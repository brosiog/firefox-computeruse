// Task families are plug-ins: add a module here, retire one by removing it. A family must draw all page text through
// its ctx (split vocabulary), supply a validator on server-side state, and an oracle that reads the prompt.
// External suites (MiniWoB-style pages, WebArena slices) can be wrapped the same way; an oracle is optional
// (without one, steps are judged "unknown" and only episode metrics are reported).
import decline from './decline.mjs';
import form from './form.mjs';
import longpage from './longpage.mjs';
import multitab from './multitab.mjs';
import reviews from './reviews.mjs';
import shop from './shop.mjs';
import table from './table.mjs';
import todo from './todo.mjs';
import widgets from './widgets.mjs';

export const FAMILIES = Object.fromEntries([shop, form, table, longpage, widgets, multitab, todo, reviews, decline].map(f => [f.id, f]));
