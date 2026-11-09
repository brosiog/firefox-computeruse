// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { applyTheme, contrast, parseColor, themeTokens } from '../src/ui/theme';

describe('parseColor', () => {
  it('reads the forms theme manifests use', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255, 1]);
    expect(parseColor('#1c1b2280')).toEqual([28, 27, 34, 128 / 255]);
    expect(parseColor('rgb(10, 20, 30)')).toEqual([10, 20, 30, 1]);
    expect(parseColor('rgba(10 20 30 / 50%)')).toEqual([10, 20, 30, 0.5]);
    expect(parseColor([1, 2, 3])).toEqual([1, 2, 3, 1]);
    expect(parseColor('nope')).toBeNull();
    expect(parseColor(undefined)).toBeNull();
  });
});

describe('themeTokens', () => {
  it('leaves the default palette alone when the theme has no colors', () => {
    expect(themeTokens(null)).toBeNull();
    expect(themeTokens({})).toBeNull();
  });

  it('maps a page-adaptive dark theme (only frame/toolbar set) onto the sidebar', () => {
    const t = themeTokens({ frame: '#102030', toolbar: 'rgb(20, 40, 60)', toolbar_text: '#eeeeee', toolbar_field: '#0a0a0a' })!;
    expect(t.dark).toBe(true);
    expect(t.tokens['--bg']).toBe('rgb(20 40 60)');
    expect(t.tokens['--fg']).toBe('rgb(238 238 238)');
    expect(t.tokens['--field-bg']).toBe('rgb(10 10 10)');
  });

  it('prefers sidebar colors, composites translucency, and fixes unreadable text', () => {
    const t = themeTokens({ frame: '#ffffff', sidebar: 'rgba(0, 0, 0, 0.5)', sidebar_text: '#808080' })!;
    expect(t.tokens['--bg']).toBe('rgb(128 128 128)');
    // grey on grey fails contrast: falls back to a readable default
    expect(contrast(parseColor(t.tokens['--fg'])!, parseColor(t.tokens['--bg'])!)).toBeGreaterThan(3);
  });

  it('takes the accent from the theme only when it stands out, with a readable label color', () => {
    const t = themeTokens({ toolbar: '#ffffff', tab_line: '#ffff00' })!;
    expect(t.tokens['--accent']).toBeUndefined(); // yellow on white: too faint
    const u = themeTokens({ toolbar: '#ffffff', tab_line: '#7a00e0' })!;
    expect(u.tokens['--accent']).toBe('rgb(122 0 224)');
    expect(u.tokens['--accent-fg']).toBe('#ffffff');
  });
});

describe('applyTheme', () => {
  it('sets and clears tokens and the scheme', () => {
    const root = document.createElement('div');
    applyTheme({ toolbar: '#000000' }, root);
    expect(root.dataset.scheme).toBe('dark');
    expect(root.style.getPropertyValue('--bg')).toBe('rgb(0 0 0)');
    applyTheme(null, root);
    expect(root.dataset.scheme).toBeUndefined();
    expect(root.style.getPropertyValue('--bg')).toBe('');
  });
});
