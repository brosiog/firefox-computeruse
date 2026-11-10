// Saved conversations: what the user asked and what the agent answered, kept in browser storage on this computer.
// Only these text turns are kept (not page states, not tab contents), and a retention setting deletes old ones.

export interface Turn {
  task: string;
  answer: string;
  success: boolean;
  at: number;
}

export interface Chat {
  id: string;
  title: string;
  created: number;
  updated: number;
  turns: Turn[];
}

/** 'forever', or a number of days as text. */
export type Retention = 'forever' | '1' | '7' | '30' | '90';

const KEY = 'chats';
const MAX_CHATS = 200;
const MAX_TURNS_IN_CONTEXT = 8;
const MAX_ANSWER_CHARS = 1200;
const MAX_TASK_CHARS = 600;

declare const browser: any;

export async function loadChats(): Promise<Chat[]> {
  try {
    const r = await browser.storage.local.get(KEY);
    return Array.isArray(r[KEY]) ? r[KEY] : [];
  } catch {
    return [];
  }
}

export async function saveChats(chats: Chat[]): Promise<void> {
  await browser.storage.local.set({ [KEY]: chats.slice(0, MAX_CHATS) });
}

/** Chats not touched within the retention window are dropped. Newest first. */
export function prune(chats: Chat[], keep: Retention | string, now = Date.now()): Chat[] {
  const days = Number(keep);
  const sorted = [...chats].sort((a, b) => b.updated - a.updated);
  if (!days) return sorted.slice(0, MAX_CHATS);
  return sorted.filter(c => now - c.updated < days * 86400000).slice(0, MAX_CHATS);
}

export function newChat(now = Date.now()): Chat {
  return { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: '', created: now, updated: now, turns: [] };
}

export function addTurn(chat: Chat, turn: Turn): Chat {
  return { ...chat, title: chat.title || turn.task.replace(/\s+/g, ' ').slice(0, 80), updated: turn.at, turns: [...chat.turns, turn] };
}

/**
 * The earlier turns as text for the model, newest few only, answers shortened. Goes into the task message, which is
 * fixed for the whole run, so it costs one prefill per run and keeps the prompt cache prefix stable across steps.
 */
export function priorBlock(turns: Turn[]): string {
  const recent = turns.slice(-MAX_TURNS_IN_CONTEXT);
  if (!recent.length) return '';
  const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + ' …' : s);
  const lines = recent.map(
    t => `User: ${cut(t.task, MAX_TASK_CHARS)}\nYou ${t.success ? 'answered' : 'could not finish'}: ${cut(t.answer || '(no answer)', MAX_ANSWER_CHARS)}`,
  );
  const skipped = turns.length - recent.length;
  return `Earlier in this conversation${skipped ? ` (${skipped} older turn(s) left out)` : ''}. The new task may refer to it ("that", "the second one", "do it again"):\n${lines.join('\n\n')}`;
}
