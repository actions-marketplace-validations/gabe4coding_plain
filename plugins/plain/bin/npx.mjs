#!/usr/bin/env node
// Copied into each plugin as bin/npx.mjs by scripts/build-plugins.mjs: edit this file, not the copies.
// Runs `npx <args>` on this process's stdio, which is the MCP channel. Plugin hosts can start `node` on every
// platform, but on Windows `npx` is a .cmd script that some hosts cannot start without `cmd /c`.
//
// In a checkout of the package itself (this repository), npx takes the project for the installed package and runs
// nothing: the bins of a project are not in its own node_modules/.bin. There the package is asked for under an npm
// alias, which npx installs into its cache. Only there, because npx re-resolves an alias on every start.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PACKAGE_FLAG = '--package=';

/** The name in the package.json of the folder npx treats as the project: the nearest with package.json or node_modules. */
function projectName(dir) {
  for (;;) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, 'utf8')).name;
      } catch {
        return undefined;
      }
    }
    if (existsSync(join(dir, 'node_modules')) || dirname(dir) === dir) return undefined;
    dir = dirname(dir);
  }
}

const args = process.argv.slice(2);
const index = args.findIndex((arg) => arg.startsWith(PACKAGE_FLAG));
if (index >= 0) {
  const spec = args[index].slice(PACKAGE_FLAG.length);
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  if (projectName(process.cwd()) === name) args[index] = `${PACKAGE_FLAG}${name.replace(/^@/, '').replace('/', '-')}@npm:${spec}`;
}
const child = process.platform === 'win32'
  ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npx', ...args], { stdio: 'inherit' })
  : spawn('npx', args, { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { console.error(`plain: cannot start npx: ${error.message}`); process.exit(1); });
child.on('exit', (code) => process.exit(code ?? 1));
