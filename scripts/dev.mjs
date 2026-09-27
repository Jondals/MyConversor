// `pnpm start`: runs the API server (auto-restarts on changes in server/) and the
// Angular dev server together, with prefixed logs. Ctrl+C stops both.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ng = require.resolve('@angular/cli/bin/ng.js');
const children = [];

/** Spawns a Node process and prefixes its output with a coloured tag. */
function start(name, args, color) {
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (d) => process.stdout.write(String(d).replace(/^(?=.)/gm, tag)));
  }
  child.on('exit', (code) => {
    if (code && !stopping) {
      console.error(`${tag}exited with code ${code}`);
      stop(code);
    }
  });
  children.push(child);
}

let stopping = false;
/** Stops every child process and exits. */
function stop(code = 0) {
  stopping = true;
  for (const c of children) c.kill();
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

start('api', ['--watch', '--watch-path=server', 'server/index.mjs'], '33');
start('web', [ng, 'serve'], '36');
console.log('\n  MyConversor → \x1b[1mhttp://localhost:4200\x1b[0m  (Ctrl+C to quit)\n');
