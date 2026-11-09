// Release-build checks on dist/ (run `pnpm build` first). These guard things the unit tests can't see:
//   - the manifest is the one we mean to ship (MV3, gecko id, version, exactly these permissions, no CSP regression);
//   - every file the manifest and pages reference exists;
//   - no e2e/bench test hook leaked into the release build;
//   - no sourcemaps, and the bundle stays inside its size budget;
//   - bridge/fcu.mjs (when present) still has no dependencies beyond Node built-ins.
//
//   node scripts/check-build.mjs
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');

// Changing any of these is a deliberate act: update the expectation here in the same PR so reviewers see it.
const EXPECT = {
  geckoId: 'firefox-computeruse@local',
  permissions: ['scripting', 'storage', 'tabs', 'webNavigation', 'webRequest', 'webRequestBlocking'],
  hostPermissions: ['<all_urls>'],
  // Total bytes in dist/. ~146 kB: main is ~123 kB (prompt-injection defenses, Sign in with ChatGPT, @-attached tabs)
  // and Bitwarden logins add ~23 kB (sign-in field finder, redaction, vault client). The budget leaves room to grow,
  // not to double.
  maxBytes: 150_000,
};
// Strings that only exist in test-only code paths (tree-shaken from release builds): the background job loop, the
// sidebar's e2e/bench harness, and the step traces the bench records.
const TEST_HOOK_MARKERS = ['/e2e/next', 'sidepanel.html?tabUrl=', '/e2e/report', '/e2e/approve', 'promptChars'];

const errors = [];
const fail = msg => errors.push(msg);
const ok = msg => console.log(`  ok  ${msg}`);

if (!existsSync(join(dist, 'manifest.json'))) {
  console.error('dist/manifest.json not found; run `pnpm build` first.');
  process.exit(2);
}

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
})(dist);
const rel = p => p.slice(dist.length + 1);
const has = p => existsSync(join(dist, p.replace(/^\//, '')));

// ---- manifest ----
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const m = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const same = (a = [], b = []) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

if (m.manifest_version === 3) ok('manifest_version 3');
else fail(`manifest_version is ${m.manifest_version}, expected 3`);

if (m.version === pkg.version) ok(`version ${m.version} matches package.json`);
else fail(`manifest version ${m.version} != package.json version ${pkg.version}`);

const gecko = m.browser_specific_settings?.gecko ?? {};
if (gecko.id === EXPECT.geckoId) ok(`gecko id ${gecko.id}`);
else fail(`gecko id is ${gecko.id}, expected ${EXPECT.geckoId} (changing it orphans installed copies)`);
if (gecko.strict_min_version) ok(`strict_min_version ${gecko.strict_min_version}`);
else fail('gecko.strict_min_version missing');

if (same(m.permissions, EXPECT.permissions)) ok(`permissions: ${m.permissions.join(', ')}`);
else fail(`permissions changed: got [${m.permissions}], expected [${EXPECT.permissions}]. If intended, update scripts/check-build.mjs.`);
if (same(m.host_permissions, EXPECT.hostPermissions)) ok(`host_permissions: ${m.host_permissions.join(', ')}`);
else fail(`host_permissions changed: got [${m.host_permissions}], expected [${EXPECT.hostPermissions}]`);
if (m.optional_permissions?.length) fail(`unexpected optional_permissions: ${m.optional_permissions}`);

// Firefox's default MV3 CSP adds upgrade-insecure-requests, which breaks plain-HTTP LAN model servers (see wxt.config.ts).
const csp = m.content_security_policy?.extension_pages;
if (!csp) fail('content_security_policy.extension_pages missing: Firefox would apply its default (upgrade-insecure-requests)');
else if (/upgrade-insecure-requests/.test(csp)) fail(`CSP contains upgrade-insecure-requests: ${csp}`);
else if (/unsafe-eval|unsafe-inline|https?:/.test(csp)) fail(`CSP loosened: ${csp}`);
else ok(`CSP: ${csp}`);

// ---- referenced files exist ----
const refs = [
  ...(m.background?.scripts ?? []),
  m.background?.page,
  m.sidebar_action?.default_panel,
  m.sidebar_action?.default_icon,
  m.action?.default_icon,
  m.action?.default_popup,
  ...Object.values(m.icons ?? {}),
].filter(x => typeof x === 'string');
for (const f of files.filter(f => f.endsWith('.html'))) {
  const html = readFileSync(f, 'utf8');
  for (const [, u] of html.matchAll(/\b(?:src|href)="([^"#?]+)"/g)) if (!/^(https?:|data:|moz-extension:)/.test(u)) refs.push(u);
}
const missing = refs.filter(r => !has(r));
if (missing.length) fail(`manifest/pages reference missing files: ${missing.join(', ')}`);
else ok(`${refs.length} referenced files present`);
const remote = files
  .filter(f => f.endsWith('.html'))
  .flatMap(f => [...readFileSync(f, 'utf8').matchAll(/<script[^>]+src="(https?:[^"]+)"/g)].map(x => `${rel(f)}: ${x[1]}`));
if (remote.length) fail(`remote scripts in pages (not allowed for add-ons): ${remote.join(', ')}`);

// ---- no test hooks, no sourcemaps ----
const leaks = [];
for (const f of files.filter(f => /\.(js|html)$/.test(f))) {
  const text = readFileSync(f, 'utf8');
  for (const mk of TEST_HOOK_MARKERS) if (text.includes(mk)) leaks.push(`${rel(f)} contains "${mk}"`);
}
if (leaks.length) fail(`test hook leaked into the release build (was WXT_E2E_URL/WXT_BRIDGE_TEST set?):\n      ${leaks.join('\n      ')}`);
else ok('no e2e/bench test hooks in the release build');
const maps = files.filter(f => f.endsWith('.map'));
if (maps.length) fail(`sourcemaps in dist: ${maps.map(rel).join(', ')}`);
else ok('no sourcemaps');

// ---- size budget ----
const total = files.reduce((n, f) => n + statSync(f).size, 0);
const kb = n => `${(n / 1000).toFixed(1)} kB`;
if (total <= EXPECT.maxBytes) ok(`size ${kb(total)} (budget ${kb(EXPECT.maxBytes)})`);
else {
  const top = files.map(f => [rel(f), statSync(f).size]).sort((a, b) => b[1] - a[1]).slice(0, 5);
  fail(`dist is ${kb(total)}, over the ${kb(EXPECT.maxBytes)} budget. Largest: ${top.map(([f, n]) => `${f} ${kb(n)}`).join(', ')}`);
}

// ---- bridge: Node built-ins only ----
const bridge = resolve(root, 'bridge/fcu.mjs');
if (existsSync(bridge)) {
  const src = readFileSync(bridge, 'utf8');
  const specs = [...src.matchAll(/(?:^|\n)\s*import\s[^'"]*?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(x => x[1] ?? x[2] ?? x[3]);
  const builtin = new Set(builtinModules);
  const bad = specs.filter(s => !(s.startsWith('node:') || builtin.has(s) || s.startsWith('./') || s.startsWith('../')));
  if (bad.length) fail(`bridge/fcu.mjs must only use Node built-ins; imports: ${bad.join(', ')}`);
  else ok(`bridge/fcu.mjs imports only Node built-ins (${specs.length})`);
}

if (errors.length) {
  console.error(`\ncheck-build: ${errors.length} problem(s)`);
  for (const e of errors) console.error(`  FAIL ${e}`);
  process.exit(1);
}
console.log('\ncheck-build: clean');
