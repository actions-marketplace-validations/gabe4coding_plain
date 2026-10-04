// Integration test of the plugin npx shim: the shim runs as a process, with a stand-in `npx` first on PATH that
// records the arguments and the folder it was started with. POSIX only, as the stand-in is a shell script.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const shim = join(dirname(fileURLToPath(import.meta.url)), 'plugin-npx.mjs');
const SPEC = '@gabe4coding/plain@2.0.0';
const ARGS = ['-y', `--package=${SPEC}`, 'plain', '--headless', 'mcp'];
const skip = process.platform === 'win32' ? 'the stand-in npx is a shell script' : false;

let root;

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plain-npx-shim-')));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'npx'), '#!/bin/sh\nnode -e \'console.log(JSON.stringify({ args: process.argv.slice(1), cwd: process.cwd() }))\' -- "$@"\n');
  chmodSync(join(root, 'bin', 'npx'), 0o755);
});

after(() => rmSync(root, { recursive: true, force: true }));

/** A folder under the test root, with a package.json of that name when `name` is given. */
function folder(path, name) {
  const dir = join(root, path);
  mkdirSync(dir, { recursive: true });
  if (name) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '2.0.0' }));
  return dir;
}

/** What the stand-in npx received when the shim ran in `cwd`. */
function run(cwd) {
  const result = spawnSync(process.execPath, [shim, ...ARGS], {
    cwd, encoding: 'utf8', env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('in a checkout of the package, the shim asks for it under an alias and keeps the folder', { skip }, () => {
  const checkout = folder('checkout', '@gabe4coding/plain');
  const nested = folder('checkout/src/deep');
  for (const cwd of [checkout, nested]) {
    assert.deepEqual(run(cwd), { args: ['-y', `--package=gabe4coding-plain@npm:${SPEC}`, 'plain', '--headless', 'mcp'], cwd });
  }
});

test('in any other project, the shim passes the arguments unchanged', { skip }, () => {
  const other = folder('other', 'my-app');
  const installed = folder('checkout-with-modules/app');
  folder('checkout-with-modules', '@gabe4coding/plain');
  mkdirSync(join(installed, 'node_modules'));
  const bare = folder('bare');
  for (const cwd of [other, installed, bare]) assert.deepEqual(run(cwd), { args: ARGS, cwd });
});
