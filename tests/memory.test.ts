import { describe, expect, it } from 'vitest';
import { addTurn, newChat, priorBlock, prune, type Chat } from '../src/chats';
import { addNote, notesBlock, parseNotes, rememberRequest } from '../src/memory';
import { taskMessage } from '../src/agent/prompt';

describe('notes', () => {
  it('parses plain lines, bullets and site-scoped lines', () => {
    expect(parseNotes('- I live in Austin\n\n• Prefer aisle seats\namazon.com: ship to work\nOn www.Delta.com, use my SkyMiles\n2) metric units')).toEqual([
      { text: 'I live in Austin' },
      { text: 'Prefer aisle seats' },
      { site: 'amazon.com', text: 'ship to work' },
      { site: 'delta.com', text: 'use my SkyMiles' },
      { text: 'metric units' },
    ]);
  });
  it('a time like 3:30 or a sentence with a colon is not a site', () => {
    expect(parseNotes('Meetings: never before 10\nwake at 6:30')).toEqual([{ text: 'Meetings: never before 10' }, { text: 'wake at 6:30' }]);
  });
  it('sends site notes only when that site is in play', () => {
    const raw = 'I live in Austin\namazon.com: ship to work';
    expect(notesBlock(raw, 'find a lamp', ['https://www.ikea.com/'])).not.toContain('ship to work');
    expect(notesBlock(raw, 'find a lamp', ['https://smile.amazon.com/x'])).toContain('(amazon.com) ship to work');
    expect(notesBlock(raw, 'order a lamp on Amazon', [''])).toContain('ship to work');
    expect(notesBlock(raw, 'x', [])).toContain('I live in Austin');
    expect(notesBlock('', 'x', [])).toBe('');
  });
  it('caps the block', () => {
    const raw = Array.from({ length: 200 }, (_, i) => `note number ${i} with some words`).join('\n');
    expect(notesBlock(raw, 'x', []).length).toBeLessThan(1700);
  });
  it('recognizes "remember that …" but not tasks', () => {
    expect(rememberRequest('Remember that I prefer window seats')).toBe('I prefer window seats');
    expect(rememberRequest('please remember: my zip is 78701')).toBe('my zip is 78701');
    expect(rememberRequest('remember to buy milk')).toBeNull();
    expect(rememberRequest('do you remember my zip?')).toBeNull();
    expect(rememberRequest('remember what I asked?')).toBeNull();
    expect(rememberRequest('book a flight')).toBeNull();
  });
  it('appends notes without duplicates', () => {
    expect(addNote('', 'a')).toBe('a');
    expect(addNote('a\n', 'b')).toBe('a\nb');
    expect(addNote('a\nB', 'b')).toBe('a\nB');
  });
});

describe('conversations', () => {
  const turn = (task: string, at: number) => ({ task, answer: `did ${task}`, success: true, at });
  it('titles a chat by its first task and gives the model earlier turns', () => {
    let c = newChat(1);
    c = addTurn(c, turn('find the cheapest hub', 2));
    c = addTurn(c, turn('buy it', 3));
    expect(c.title).toBe('find the cheapest hub');
    const b = priorBlock(c.turns);
    expect(b).toContain('User: find the cheapest hub\nYou answered: did find the cheapest hub');
    expect(b).toContain('User: buy it');
    expect(priorBlock([])).toBe('');
    // Context goes before the task, so the task stays the last thing the model reads before the page.
    expect(taskMessage('and the second one?', '2026-01-01', undefined, b).indexOf('Task: and the second one?')).toBeGreaterThan(b.length - 1);
  });
  it('keeps only recent turns and short answers in context', () => {
    const turns = Array.from({ length: 12 }, (_, i) => ({ task: `t${i}`, answer: 'x'.repeat(5000), success: i % 2 === 0, at: i }));
    const b = priorBlock(turns);
    expect(b).toContain('4 older turn(s) left out');
    expect(b).not.toContain('User: t3\n');
    expect(b).toContain('could not finish');
    expect(b.length).toBeLessThan(8 * 1300 + 200);
  });
  it('deletes chats past the retention window, newest first', () => {
    const day = 86400000;
    const now = 100 * day;
    const mk = (id: string, ago: number): Chat => ({ id, title: id, created: 0, updated: now - ago * day, turns: [] });
    const all = [mk('old', 40), mk('new', 1), mk('mid', 10)];
    expect(prune(all, 'forever', now).map(c => c.id)).toEqual(['new', 'mid', 'old']);
    expect(prune(all, '30', now).map(c => c.id)).toEqual(['new', 'mid']);
    expect(prune(all, '7', now).map(c => c.id)).toEqual(['new']);
  });
});
