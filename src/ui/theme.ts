// Makes the sidebar wear the browser's current theme. Firefox reports the active theme through browser.theme, including
// per-window themes other extensions set at run time (the "recolor the toolbar to match the page" kind call
// theme.update(windowId, …) as you browse). We read that window's theme on load and again on every theme.onUpdated,
// and map its colors onto the CSS tokens in style.css. With no theme colors (the default system theme) the tokens
// are cleared and style.css's own Firefox light/dark palette applies via prefers-color-scheme.

export type RGB = [number, number, number, number];
type ThemeColors = Record<string, unknown> | null | undefined;

/** Parses the color forms theme manifests use: '#rgb', '#rrggbb(aa)', 'rgb()/rgba()', or an [r, g, b(, a)] array. */
export function parseColor(v: unknown): RGB | null {
  if (Array.isArray(v) && v.length >= 3 && v.every(n => typeof n === 'number')) {
    return [v[0], v[1], v[2], v[3] ?? 1];
  }
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const ch = (p: string) => (p.endsWith('%') ? (parseFloat(p) * 255) / 100 : parseFloat(p));
    const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    const out: RGB = [ch(parts[0]), ch(parts[1]), ch(parts[2]), a];
    return out.every(Number.isFinite) ? out : null;
  }
  return null;
}

/** Any CSS color (named colors, hsl(), …): let the engine resolve it. Null outside a DOM or when invalid. */
function resolveColor(v: unknown): RGB | null {
  const direct = parseColor(v);
  if (direct || typeof v !== 'string' || typeof document === 'undefined') return direct;
  const probe = document.createElement('span');
  probe.style.color = v;
  if (!probe.style.color) return null;
  document.body.append(probe);
  const c = parseColor(getComputedStyle(probe).color);
  probe.remove();
  return c;
}

const css = ([r, g, b, a]: RGB) => (a >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${a})`);

/** WCAG relative luminance. */
export function luminance([r, g, b]: RGB): number {
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
export const contrast = (a: RGB, b: RGB) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** Composites a translucent color over an opaque one (theme colors are often rgba). */
const over = (top: RGB, base: RGB): RGB => {
  const a = top[3];
  return [0, 1, 2].map(i => Math.round(top[i] * a + base[i] * (1 - a))).concat(1) as RGB;
};

/** Maps a theme's colors to the sidebar's CSS tokens. Returns null when the theme sets nothing usable. */
export function themeTokens(colors: ThemeColors): { tokens: Record<string, string>; dark: boolean } | null {
  if (!colors) return null;
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const c = resolveColor(colors[k]);
      if (c) return c;
    }
    return null;
  };
  const bgRaw = pick('sidebar', 'toolbar', 'frame', 'tab_selected');
  if (!bgRaw) return null;
  // Layered like the browser draws it: a translucent toolbar sits on the frame.
  const frame = pick('frame') ?? [255, 255, 255, 1];
  const bg = over(bgRaw, over(frame, [255, 255, 255, 1]));
  const dark = luminance(bg) < 0.25;
  let fg = pick('sidebar_text', 'toolbar_text', 'tab_text', 'tab_background_text', 'frame_text');
  if (!fg || contrast(over(fg, bg), bg) < 3) fg = dark ? [251, 251, 254, 1] : [21, 20, 26, 1];
  fg = over(fg, bg);

  const tokens: Record<string, string> = { '--bg': css(bg), '--fg': css(fg) };

  const field = pick('toolbar_field', 'popup');
  if (field) {
    const f = over(field, bg);
    tokens['--field-bg'] = css(f);
    const ft = pick('toolbar_field_text', 'popup_text');
    tokens['--field-fg'] = css(ft && contrast(over(ft, f), f) >= 3 ? over(ft, f) : fg);
  }
  const popup = pick('popup');
  if (popup) {
    const p = over(popup, bg);
    tokens['--popup-bg'] = css(p);
    const pt = pick('popup_text');
    tokens['--popup-fg'] = css(pt && contrast(over(pt, p), p) >= 3 ? over(pt, p) : fg);
  }
  const border = pick('sidebar_border', 'toolbar_bottom_separator', 'toolbar_field_border');
  if (border) tokens['--line'] = css(border);

  // Accent: the theme's own highlight, if it stands out from the background; otherwise style.css's Firefox blue.
  for (const k of ['tab_line', 'icons_attention', 'sidebar_highlight', 'toolbar_field_border_focus']) {
    const c = pick(k);
    if (!c) continue;
    const a = over(c, bg);
    if (contrast(a, bg) < 1.8) continue;
    tokens['--accent'] = css(a);
    tokens['--accent-fg'] = contrast(a, [255, 255, 255, 1]) >= contrast(a, [21, 20, 26, 1]) ? '#ffffff' : '#15141a';
    break;
  }
  return { tokens, dark };
}

const ALL = ['--bg', '--fg', '--field-bg', '--field-fg', '--popup-bg', '--popup-fg', '--line', '--accent', '--accent-fg'];

export function applyTheme(colors: ThemeColors, root: HTMLElement = document.documentElement) {
  for (const k of ALL) root.style.removeProperty(k);
  const t = themeTokens(colors);
  if (!t) {
    delete root.dataset.scheme;
    return;
  }
  for (const [k, v] of Object.entries(t.tokens)) root.style.setProperty(k, v);
  root.dataset.scheme = t.dark ? 'dark' : 'light';
}

/** Follows this window's theme. Needs the "theme" permission; without the API it leaves style.css's defaults. */
export async function followTheme(browser: any) {
  if (!browser?.theme?.getCurrent) return;
  let windowId: number | undefined;
  try {
    windowId = (await browser.windows.getCurrent()).id;
  } catch {
    /* a page outside a window: use the global theme */
  }
  const refresh = async () => {
    try {
      const theme = await browser.theme.getCurrent(windowId);
      applyTheme(theme?.colors);
    } catch {
      applyTheme(null);
    }
  };
  browser.theme.onUpdated?.addListener((info: { windowId?: number }) => {
    if (info?.windowId === undefined || info.windowId === windowId) void refresh();
  });
  await refresh();
}
