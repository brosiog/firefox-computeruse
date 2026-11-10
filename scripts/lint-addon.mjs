// Mozilla's add-on linter (the same addons-linter AMO runs) on dist/. Fails on any error, and on any warning that is
// not in ALLOWED below: known warnings stay visible in the log, new ones break the build.
//
//   node scripts/lint-addon.mjs        (run `pnpm build` first; fetches web-ext via pnpm dlx, nothing is installed)
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const WEB_EXT = 'web-ext@10.8.0';
const root = resolve(import.meta.dirname, '..');

// code → why it is accepted. Remove an entry when the cause goes away.
const ALLOWED = {
  // data_collection_permissions is new in Firefox 140 (Android 142). Desktop strict_min_version is 140, so the desktop
  // warning is gone. Firefox for Android is not supported below 142 by this key; the add-on is desktop-only in practice
  // and the warning stays until the Android floor is raised or the key is dropped for Android. AMO requires the key.
  KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION: 'data_collection_permissions vs Firefox for Android (needs 142); desktop min is 140',
};

let out;
try {
  out = execFileSync('pnpm', ['dlx', WEB_EXT, 'lint', '--source-dir', resolve(root, 'dist'), '--self-hosted', '--output', 'json', '--no-config-discovery'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
} catch (e) {
  // web-ext exits non-zero when there are errors; the JSON is still on stdout.
  out = e.stdout ?? '';
  if (!out.trim()) throw e;
}
const json = JSON.parse(out.slice(out.indexOf('{')));
const fmt = x => `${x.code} ${x.file ?? ''}${x.line ? ':' + x.line : ''}  ${String(x.message ?? '').replace(/<[^>]+>/g, '')}`;

const errors = json.errors ?? [];
const warnings = json.warnings ?? [];
const fresh = warnings.filter(w => !ALLOWED[w.code]);
for (const w of warnings.filter(w => ALLOWED[w.code])) console.log(`  allowed warning  ${w.code}  (${ALLOWED[w.code]})`);
for (const n of json.notices ?? []) console.log(`  notice  ${fmt(n)}`);
for (const w of fresh) console.error(`  WARNING  ${fmt(w)}`);
for (const e of errors) console.error(`  ERROR    ${fmt(e)}`);

if (errors.length || fresh.length) {
  console.error(`\nadd-on lint: ${errors.length} error(s), ${fresh.length} new warning(s). Fix them, or allow a warning in scripts/lint-addon.mjs with a reason.`);
  process.exit(1);
}
console.log(`\nadd-on lint: clean (${warnings.length} allowed warning(s))`);
