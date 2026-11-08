// Prompt lint: the system prompt must not contain fixture vocabulary (product names, people, button labels the
// generator uses). Prompt changes have to help in general, not on these tasks.
//   node bench/lint.mjs [extra-prompt-file …]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { allVocab } from './lib/gen.mjs';

const root = resolve(import.meta.dirname, '..');

export async function lintPrompts(extra = []) {
  const core = await import(resolve(root, 'bench/.build/core.mjs'));
  const prompts = [core.systemPrompt({ vision: false, reasoning: true }), core.systemPrompt({ vision: true, reasoning: false }), ...extra];
  // Generic words that are fine anywhere (they name UI concepts, not fixture content).
  const allowed = new Set(['save', 'close', 'next', 'submit', 'search', 'dismiss', 'register', 'pro', 'max', 'mini', 'core', 'edge', 'air', 'plus', 'prime', 'classic', 'compact', 'ultra', 'eco', 'lite', 'studio', 'sales', 'support', 'research', 'finance', 'legal', 'design', 'security']);
  const bad = [];
  for (const p of prompts) {
    const low = p.toLowerCase();
    for (const w of new Set(allVocab().map(x => x.toLowerCase()))) {
      if (allowed.has(w) || w.length < 4) continue;
      if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(low)) bad.push(`  "${w}"`);
    }
  }
  return [...new Set(bad)];
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bad = await lintPrompts(process.argv.slice(2).map(f => readFileSync(f, 'utf8')));
  if (bad.length) {
    console.error('fixture vocabulary found in prompts:\n' + bad.join('\n'));
    process.exit(1);
  }
  console.log('prompt lint: clean');
}
