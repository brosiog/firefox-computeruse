// "Things to remember": notes the user writes in plain sentences, one per line. No model parses them: a line that
// starts with a site ("amazon.com: ship to my work address", "On amazon.com, …") applies only when the task or the
// tabs involve that site; every other line applies to every task. They reach the model in the task message.

export interface Note {
  /** Hostname the note is scoped to (no www.), or undefined for a note that always applies. */
  site?: string;
  text: string;
}

const MAX_CHARS = 1500;
const SITE = /^(?:on|at|for)?\s*((?:[a-z0-9-]+\.)+[a-z]{2,})\s*[:,–—-]\s*(.+)$/i;

export function parseNotes(raw: string): Note[] {
  const out: Note[] = [];
  for (let line of (raw ?? '').split('\n')) {
    line = line.replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, '').trim();
    if (!line) continue;
    const m = SITE.exec(line);
    if (m) out.push({ site: m[1].toLowerCase().replace(/^www\./, ''), text: m[2].trim() });
    else out.push({ text: line });
  }
  return out;
}

/** True when a site-scoped note concerns this task: a URL in play is on that site, or the task names it. */
function applies(site: string, task: string, urls: string[]): boolean {
  for (const u of urls) {
    try {
      const h = new URL(u).hostname.toLowerCase().replace(/^www\./, '');
      if (h === site || h.endsWith('.' + site)) return true;
    } catch {
      // not a URL
    }
  }
  const t = task.toLowerCase();
  if (t.includes(site)) return true;
  const label = site.split('.').slice(-2)[0];
  return label.length >= 4 && new RegExp(`\\b${label.replace(/[^a-z0-9-]/g, '')}\\b`).test(t);
}

/** The notes that apply to this task, as text for the model. Empty when there are none. */
export function notesBlock(raw: string, task: string, urls: string[]): string {
  const lines: string[] = [];
  let used = 0;
  // Site notes first: when the cap bites, the ones that matched this task are the most relevant.
  const notes = parseNotes(raw);
  const pick = [...notes.filter(n => n.site && applies(n.site, task, urls)), ...notes.filter(n => !n.site)];
  for (const n of pick) {
    const line = n.site ? `- (${n.site}) ${n.text}` : `- ${n.text}`;
    if (used + line.length > MAX_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';
  return `The user asked you to remember these (use them when relevant; the task wins if they conflict):\n${lines.join('\n')}`;
}

/** "remember that I prefer window seats" → "I prefer window seats". Null when the message is not a remember request. */
export function rememberRequest(msg: string): string | null {
  const m = /^\s*(?:please\s+)?remember(?:\s+that)?\s*[:,]?\s+(.+)$/is.exec(msg);
  if (!m) return null;
  const note = m[1].trim().replace(/\s+/g, ' ');
  // "remember to …" and questions are tasks, not facts.
  if (/^to\s/i.test(note) || /\?$/.test(note)) return null;
  return note;
}

/** Appends a note on its own line, unless the same note is already there. */
export function addNote(raw: string, note: string): string {
  const have = parseNotes(raw).some(n => (n.site ? `${n.site}: ${n.text}` : n.text).toLowerCase() === note.toLowerCase());
  if (have) return raw;
  return raw.trim() ? `${raw.replace(/\s+$/, '')}\n${note}` : note;
}
