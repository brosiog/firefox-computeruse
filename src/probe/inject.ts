// Detection of page text written to AI agents. Best effort by design: it raises friction (a warning, approval before
// acting on that part of the page) but the guarantees come from the deterministic guards that do not depend on it
// (page boundary, hidden-text filtering, navigation provenance, cross-site form gating).

const PATTERNS: RegExp[] = [
  // Addressed to an AI / automated agent.
  /\b(attention|note|notice|message|instructions?|reminder)\b[^.\n]{0,20}\b(for|to)\s+(the\s+|all\s+|any\s+)?(ai|llm|automated|autonomous|browsing)\b/i,
  /\b(ai|llm|automated|browsing)\s+(assistants?|agents?|bots?|models?)\b[^.\n]{0,60}\b(must|should|need to|have to|are required|are instructed)\b/i,
  /\b(if you are|as)\s+an?\s+(ai|llm|language model)\b/i,
  // Overrides of the user's instructions.
  /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(instructions?|directions?|prompt|rules|guidelines|task)\b/i,
  /\byour\s+(real|actual|true|revised|updated)\s+(task|instructions?|objective|goal)\b/i,
  /\byour (previous|prior|original) (instructions?|task) (are|is|were|was)\b/i,
  // Role and protocol markers that belong to the agent's own prompt, not to a page.
  /(^|\n)\s*(system|developer)\s*(message|prompt|notice)?\s*:/i,
  /<\|?\s*(im_start|im_end|system|endoftext|eot_id)\s*\|?>/i,
  /\[\/?(system|inst|INST)\]/,
  /[<‹]\s*\/?\s*page\b/i,
  // Concealment from the user.
  /\b(do not|don'?t|never)\s+(tell|inform|notify|alert|mention (it |this )?to)\s+(the\s+)?user\b/i,
  // A few languages (the same override intent).
  /ignor(a|ar|e|ez|er|iere)\b[^.\n]{0,30}\b(instrucciones|instructions|anweisungen|istruzioni|instruções)/i,
  /(忽略|无视)(之前|以上|所有|先前)/,
];

export function looksInjected(text: string): boolean {
  if (!text || text.length < 6) return false;
  for (const re of PATTERNS) if (re.test(text)) return true;
  return false;
}

/** Controls that only make an injected dialog go away stay usable without approval. */
export const DISMISS = /^(close|dismiss|cancel|no thanks|not now|maybe later|skip|×|x|✕|got it)$/i;
