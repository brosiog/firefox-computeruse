// System-prompt variants for replay: leave-one-out ablations of each rule and section, and compressed forms. A rule
// whose removal changes nothing is costing tokens (prefill on every cache miss, memory for every context) for free;
// a rule whose removal breaks decisions is earning its place.

export function promptVariants(core, { vision = false } = {}) {
  const base = core.systemPrompt({ vision, reasoning: true });
  const out = { base: { system: base } };
  // Sections are separated by blank lines: intro, page-state legend, actions (+ chaining), rules.
  const [intro, legend, actions, rules] = base.split('\n\n');
  const join = parts => parts.filter(Boolean).join('\n\n');
  out['no-legend'] = { system: join([intro, actions, rules]) };
  out['actions-sig-only'] = { system: join([intro, legend, actions.split('\n').map(l => (l.startsWith('{') ? l.split('  ')[0] : l)).join('\n'), rules]) };
  out['no-chain-doc'] = { system: join([intro, legend, actions.split('\n').filter(l => !l.startsWith('Page actions can')).join('\n'), rules]) };
  out['no-rules'] = { system: join([intro, legend, actions]) };
  const ruleList = rules.replace(/^Rules: /, '').split(/(?<=\.) (?=[A-Z])/);
  ruleList.forEach((r, i) => {
    out[`drop-rule-${i + 1}`] = { system: join([intro, legend, actions, 'Rules: ' + ruleList.filter((_, j) => j !== i).join(' ')]), about: r.slice(0, 90) };
  });
  out.minimal = { system: join([intro, actions.split('\n').map(l => l.split('  ')[0]).join('\n')]) };
  // Settings variants: the same prompt, different decoding contract.
  out.nothink = { system: core.systemPrompt({ vision, reasoning: false }), settings: { reasoning: false } };
  return out;
}

export const tokensOf = s => Math.ceil(s.length / 3.3);
