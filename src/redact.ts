// Secrets the password manager filled, scrubbed from everything the agent receives afterwards: page states, action
// results, URLs, tab titles. The fill already masks the fields themselves; this catches the page repeating a value
// ("Welcome, jane@example.com", a title, a URL parameter, a keystroke echo).
//
// Lives in the sidebar for the life of the browsing session (the host). Values shorter than 4 characters are not
// scrubbed: they would blank ordinary words. Usernames match case-insensitively (emails are), passwords exactly.

export interface Redactor {
  add(value: string | undefined, caseInsensitive?: boolean): void;
  scrub(text: string): string;
  readonly size: number;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createRedactor(): Redactor {
  const pats = new Map<string, RegExp>();
  return {
    add(value, ci = false) {
      if (!value || value.trim().length < 4) return;
      const forms = new Set([value, encodeURIComponent(value), encodeURIComponent(value).replace(/%20/g, '+')]);
      for (const f of forms) {
        const key = `${ci ? 'i' : 's'}:${f}`;
        if (!pats.has(key)) pats.set(key, new RegExp(esc(f), ci ? 'gi' : 'g'));
      }
    },
    scrub(text) {
      if (!pats.size || !text) return text;
      let out = text;
      // Longest first, so a value containing another is replaced whole.
      for (const re of [...pats.values()].sort((a, b) => b.source.length - a.source.length)) out = out.replace(re, '•••');
      return out;
    },
    get size() {
      return pats.size;
    },
  };
}
