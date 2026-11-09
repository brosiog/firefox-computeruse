// Messages between the agent (sidebar page) and the probe (content script in every frame).
// Everything here must be structured-clone safe: it crosses scripting.executeScript.

export type ScrollDir = 'up' | 'down' | 'left' | 'right';

export type ProbeCmd =
  | { op: 'snapshot'; budget: number }
  | { op: 'click'; id: number; approved?: boolean }
  | { op: 'type'; id: number; text: string; clear: boolean; enter: boolean; approved?: boolean }
  | { op: 'select'; id: number; option: string }
  | { op: 'key'; key: string; id?: number; approved?: boolean }
  | { op: 'scroll'; dir: ScrollDir; id?: number; pages?: number }
  | { op: 'hover'; id: number }
  | { op: 'read'; offset: number; budget: number; query?: string }
  | { op: 'find'; text: string; limit: number }
  | { op: 'settle'; quietMs: number; maxMs: number }
  | { op: 'marks'; show: boolean }
  /** Finds the sign-in fields (in the form around `id`, or the frame). Reports which exist, never their values. */
  | { op: 'loginForm'; id?: number }
  /** Fills vault credentials into the sign-in fields, only if the frame is still on `origin`. */
  | { op: 'fillLogin'; id?: number; origin: string; username?: string; password?: string; totp?: string; enter: boolean; approved?: boolean };

/** What a consequential action is, decided in the page before anything is dispatched. */
/** exfil: sending a form to another site than the page's; suspicious: acting on page text aimed at the agent;
 *  login: filling a saved password-manager login. */
export type Risk = 'read' | 'write' | 'delete' | 'pay' | 'secret' | 'exfil' | 'suspicious' | 'login';

export interface Gate {
  risk: Risk;
  /** Human-readable description of what would happen, e.g. `button "Place order"`. */
  what: string;
}

export interface ProbeOk {
  ok: true;
  /** One-line receipt for the model. */
  msg: string;
  /** Present when the action wants the host to open a URL itself (target=_blank links). */
  openUrl?: string;
  /** URLs of links shown so far in this document (navigation provenance). */
  links?: string[];
  /** loginForm only. */
  form?: LoginForm;
}

/** The sign-in fields a frame has, for the vault lookup. */
export interface LoginForm {
  /** The frame's own URL: credentials are matched against this, not the tab's. */
  url: string;
  user: boolean;
  pass: boolean;
  otp: boolean;
}

export interface ProbeErr {
  ok: false;
  error: string;
  /** Set when the action was withheld pending the user's approval. Nothing was dispatched. */
  gate?: Gate;
}

export type ProbeResult = ProbeOk | ProbeErr;

export interface Snapshot {
  ok: true;
  frameId: number;
  url: string;
  title: string;
  /** Compact text lines, refs already prefixed for this frame. Contains ‹frame:N› placeholders. */
  text: string;
  /** Header facts about scroll state, modal, counts. */
  scroll: string;
  /** Refs that were emitted, for diffing between steps. */
  refs: string[];
  /** Viewport size of this frame; tiny frames are dropped by the host. */
  vw: number;
  vh: number;
  hidden: { above: number; below: number; dropped: number; chrome?: number };
  links: string[];
  /** Lines that read as written to AI agents (shown with ⚠). */
  flagged?: number;
  modal: string | null;
}
