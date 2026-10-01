import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { parseSuiteArgs } from './options.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plainwright-config-d-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
function fixture(body?: string, name = 'plainwright.config.yaml'): string {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  if (body !== undefined) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

test('config defaults to absent, discovers yml, prefers yaml and honors explicit paths', () => {
  assert.deepEqual(loadConfig(fixture()), {});
  const dir = fixture('workers: 2\n', 'plainwright.config.yml');
  assert.equal(loadConfig(dir).workers, 2);
  fs.writeFileSync(path.join(dir, 'plainwright.config.yaml'), 'workers: 3\n');
  assert.equal(loadConfig(dir).workers, 3);
  assert.equal(loadConfig(dir, 'plainwright.config.yml').workers, 2);
  assert.throws(() => loadConfig(dir, 'missing.yaml'), /--config: file not found/);
});

test('config resolves paths against an explicit config folder, including reporter strings and objects', () => {
  const dir = fixture(`files: [tests/, 'specs/**/*.yml']
profile: .profiles/test
artifacts: {dir: results, trace: always}
reporters: [text, 'junit:out/junit.xml', {name: json, output: out/results.json}]
`);
  const config = loadConfig(root, path.join(dir, 'plainwright.config.yaml'));
  assert.deepEqual(config.files, [path.join(dir, 'tests'), path.join(dir, 'specs/**/*.yml')]);
  assert.equal(config.profile, path.join(dir, '.profiles/test'));
  assert.deepEqual(config.artifacts, { dir: path.join(dir, 'results'), screenshot: 'on-failure', trace: 'always' });
  assert.deepEqual(config.reporters, [{ name: 'text' }, { name: 'junit', output: path.join(dir, 'out/junit.xml') },
    { name: 'json', output: path.join(dir, 'out/results.json') }]);
});

test('config accepts all documented keys with their types', () => {
  const dir = fixture(`workers: 2
retries: 1
bail: 1
maxTokens: 1000
grep: Checkout
grepInvert: Refund
tags: [smoke, checkout]
reporters: [text]
timing: true
specTimeout: 60000
timeout: 0
headless: true
profile: /tmp/plainwright-test-profile
channel: chrome
cdp: http://localhost:9222
server: http://localhost:4723
`);
  const config = loadConfig(dir);
  assert.equal(config.workers, 2);
  assert.equal(config.timeout, 0);
  assert.equal(config.headless, true);
  assert.deepEqual(config.tags, ['smoke', 'checkout']);
  assert.equal(config.cdp, 'http://localhost:9222');
  assert.equal(config.server, 'http://localhost:4723');
});

test('config rejects unknown keys and wrong types with file and key in the error', () => {
  const cases = [
    ['mystery: true', 'mystery'], ['workers: "2"', 'workers'], ['workers: 0', 'workers'],
    ['retries: -1', 'retries'], ['bail: 1.5', 'bail'], ['maxTokens: 0', 'maxTokens'],
    ['tags: smoke', 'tags'], ['files: tests/', 'files'], ['headless: yes', 'headless'],
    ['timeout: .inf', 'timeout'], ['specTimeout: 0', 'specTimeout'], ['profile: 12', 'profile'],
    ['artifacts: {dir: results, trace: sometimes}', 'artifacts.trace'],
    ['artifacts: {dir: results, typo: true}', 'artifacts.typo'], ['artifacts: {}', 'artifacts.dir'],
    ['reporters: [{name: text, typo: true}]', 'reporters.0.typo'], ['reporters: []', 'reporters'],
    ['reporters: ["junit:"]', 'reporters'], ['list: true', 'list'], ['lastFailed: true', 'lastFailed'],
  ];
  for (const [body, key] of cases) {
    const dir = fixture(body);
    assert.throws(() => loadConfig(dir), (error: unknown) => error instanceof Error &&
      error.message.includes(path.join(dir, 'plainwright.config.yaml')) && error.message.includes(key), body);
  }
});

test('config reports malformed YAML and non-mapping roots', () => {
  for (const body of ['workers: [', '[]', 'false', '']) {
    const dir = fixture(body);
    assert.throws(() => loadConfig(dir), (error: unknown) => error instanceof Error && error.message.includes('plainwright.config.yaml'));
  }
});

test('config does not expand dollar variables', () => {
  const dir = fixture('profile: $PROFILE\ngrep: $PATTERN\n');
  const config = loadConfig(dir);
  assert.equal(config.profile, path.join(dir, '$PROFILE'));
  assert.equal(config.grep, '$PATTERN');
});

test('real config integrates with file/glob expansion and CLI/env precedence', () => {
  const dir = fixture(`files: ['tests/**/*.yaml']
workers: 2
tags: [smoke]
grep: from-config
headless: true
profile: profile
timeout: 12000
`);
  fs.mkdirSync(path.join(dir, 'tests/nested'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests/b.yaml'), '');
  fs.writeFileSync(path.join(dir, 'tests/nested/a.yaml'), '');
  const defaults = parseSuiteArgs(['--workers', '1'], 'browser', {}, dir);
  assert.deepEqual(defaults.opts.files, [path.join(dir, 'tests/b.yaml'), path.join(dir, 'tests/nested/a.yaml')]);
  assert.equal(defaults.flags.headless, true);
  assert.equal(defaults.flags.timeout, '12000');
  assert.equal(defaults.flags.profile, path.join(dir, 'profile'));
  const override = parseSuiteArgs(['--workers', '1', '--tag', 'checkout', '--grep', 'cli', 'other.yaml'],
    'browser', { PLAINWRIGHT_PROFILE: '/tmp/env-profile' }, dir);
  assert.deepEqual(override.opts.files, ['other.yaml']);
  assert.deepEqual(override.opts.tags, ['checkout']);
  assert.equal(override.opts.grep, 'cli');
  assert.equal(override.flags.profile, '/tmp/env-profile');
  assert.equal(parseSuiteArgs(['--workers', '1', '--profile', '/tmp/cli-profile', 'other.yaml'], 'browser',
    { PLAINWRIGHT_PROFILE: '/tmp/env-profile' }, dir).flags.profile, '/tmp/cli-profile');
});
