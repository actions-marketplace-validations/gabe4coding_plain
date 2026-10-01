import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainwright-cli-d-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const engines = [
  { cli: 'cli.js', header: 'url: https://example.com', action: 'click' },
  { cli: 'computer-cli.js', header: 'app: TestApp', action: 'click' },
  { cli: 'mobile-cli.js', header: 'platform: android\ndevice: fixture\napp: org.test', action: 'tap' },
];
const env = { ...process.env, TYPESAFE_API_KEY: '', AI_GATEWAY_API_KEY: '', JEV_PROVIDER: 'invalid-provider' };
function run(cli: string, args: string[]) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(cli, import.meta.url)), ...args],
    { cwd: dir, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  return result;
}

for (const { cli, header, action } of engines) {
  const file = `${cli}.yaml`;
  fs.writeFileSync(path.join(dir, file), `name: Smoke\ntags: [smoke, checkout]\n${header}\nsteps:\n  - ${action}: OK\n`);
  test(`${cli}: --list applies selection without asking for a provider`, () => {
    const result = run(cli, ['--list', '--grep', '^Smoke$', '--tag', 'smoke', '--tag', 'checkout', file]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `${file}  Smoke  [smoke, checkout]`);
    assert.equal(result.stderr, '');
    const empty = run(cli, ['--list', '--tag', 'absent', file]);
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(empty.stdout, '');
  });
  test(`${cli}: invalid regex returns usage exit 2`, () => {
    const result = run(cli, ['--list', '--grep', '[', file]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--grep: invalid regex/);
  });
  test(`${cli}: validate is key-free and distinguishes warnings from errors`, () => {
    assert.equal(run(cli, ['validate', file]).status, 0);
    const warning = `${cli}-warn.yaml`;
    fs.writeFileSync(path.join(dir, warning), `name: Warning\n${header}\nenv: {value: $PLAINWRIGHT_LANE_D_MISSING_ENV}\nsteps:\n  - ${action}: '\${env.value}'\n`);
    const warned = run(cli, ['validate', warning]);
    assert.equal(warned.status, 0, warned.stderr);
    assert.match(warned.stderr, /env var is not set/);
    const bad = `${cli}-bad.yaml`;
    fs.writeFileSync(path.join(dir, bad), `name: Bad\n${header}\nsteps:\n  - ${action}: '\${env.missing}'\n`);
    const invalid = run(cli, ['validate', bad]);
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stderr, /env.missing.*not defined/);
  });
}
