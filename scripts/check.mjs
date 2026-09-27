// `pnpm check`: builds the app into a temp folder, runs the full test suite
// against that build and verifies nothing was left behind (files or processes).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const require = createRequire(import.meta.url);
const ng = require.resolve('@angular/cli/bin/ng.js');
const tmp = mkdtempSync(join(tmpdir(), 'myconversor-check-'));
const ours = () => readdirSync(tmpdir()).filter((f) => f.startsWith('myconversor-test-'));
const before = new Set(ours());
const snapshot = () =>
  spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
  }).stdout ?? '';
const gitBefore = snapshot();
let failed = false;

/** Runs one step, printing its title and recording failures. */
function step(title, cmd, args, env = {}) {
  console.log(`\n\x1b[33m■ ${title}\x1b[0m`);
  const res = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) {
    failed = true;
    console.error(`\x1b[31m✗ ${title} failed\x1b[0m`);
  }
  return res.status === 0;
}

try {
  const out = join(tmp, 'build');
  const web = join(out, 'browser');
  if (
    step('Build the app (into a temp folder)', process.execPath, [
      ng,
      'build',
      '--output-path',
      out,
      '--no-progress',
    ]) &&
    step('Optimize the HTML', process.execPath, ['scripts/optimize-html.mjs', web])
  ) {
    step(
      'Full test (API, FFmpeg, yt-dlp, accounts, web)',
      process.execPath,
      ['--test', 'test/app.test.mjs'],
      {
        MYCONVERSOR_TEST_WEB: web,
      },
    );
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n\x1b[33m■ No leftovers\x1b[0m');
const leftovers = ours().filter((f) => !before.has(f));
const gitAfter = snapshot();
const checks = [
  ['temporary build folder removed', !existsSync(tmp)],
  ['temporary test folders removed', leftovers.length === 0],
  ['repository unchanged', gitAfter === gitBefore],
];
for (const [label, ok] of checks) {
  console.log(`${ok ? '\x1b[32m✓' : '\x1b[31m✗'} ${label}\x1b[0m`);
  if (!ok) failed = true;
}
console.log(failed ? '\n\x1b[31mCheck FAILED\x1b[0m' : '\n\x1b[32mAll good ✔\x1b[0m');
process.exit(failed ? 1 : 0);
