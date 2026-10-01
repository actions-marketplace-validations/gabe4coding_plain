import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandFiles, parseSuiteArgs } from './options.js';
import { createReporters } from './reporters/index.js';
import { artifactsObserver } from './artifacts.js';
import { select, listSelected } from './select.js';
import { checkSchedule } from './schedule.js';
import { checkSpecTimeout } from './runner.js';

const parsed = (args: string[], engine: 'browser' | 'desktop' | 'mobile' = 'browser', env: NodeJS.ProcessEnv = {}) =>
  parseSuiteArgs([...args, 'case.yaml'], engine, env, '/tmp/plainwright-options-absent');

test('parses all suite flags and browser flags', () => {
  const { opts, flags } = parsed(['--workers', '4', '--retries', '0', '--bail', '0', '--grep', 'one',
    '--grep-invert', 'two', '--tag', 'smoke', '--tag', 'checkout', '--reporter', 'text', '--reporter', 'jsonl',
    '--timeout', '9000', '--headless', '--timing', '--channel', 'chrome']);
  assert.equal(opts.workers, 4);
  assert.equal(opts.retries, 0);
  assert.equal(opts.bail, 0);
  assert.deepEqual(opts.tags, ['smoke', 'checkout']);
  assert.deepEqual(opts.reporters.map((r) => r.name), ['text', 'jsonl']);
  assert.equal(opts.grep, 'one');
  assert.equal(opts.grepInvert, 'two');
  assert.equal(opts.timing, true);
  assert.equal(flags.timeout, '9000');
  assert.equal(flags.headless, true);
  assert.equal(flags.channel, 'chrome');
  assert.equal(parsed(['--bail']).opts.bail, 1);
  assert.equal(parsed(['--last-failed']).opts.lastFailed, true);
  assert.equal(parsed(['--list']).opts.list, true);
  assert.equal(parsed(['--max-tokens', '8']).opts.maxTokens, 8);
  assert.equal(parsed(['--spec-timeout', '500']).opts.specTimeout, 500);
  assert.equal(parsed(['--screenshot', 'on-failure', '--trace', 'on-failure']).opts.artifacts, undefined);
  assert.equal(parsed(['--server', 'http://localhost:4723'], 'mobile').flags.server, 'http://localhost:4723');
});

test('CLI overrides existing env fallback; env overrides defaults', () => {
  const env = { PLAINWRIGHT_PROFILE: '/env/profile', PLAINWRIGHT_CHANNEL: 'chrome', PLAINWRIGHT_CDP: 'http://env' };
  assert.equal(parsed(['--profile', '/cli/profile', '--timeout', '8000'], 'browser', env).flags.profile, '/cli/profile');
  assert.equal(parsed([], 'browser', env).flags.channel, 'chrome');
  assert.equal(parsed([], 'browser', env).flags.cdp, 'http://env');
  assert.equal(parsed([]).flags.timeout, '15000');
});

test('directory and glob expansion are sorted, while file positionals keep their order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainwright-options-'));
  fs.mkdirSync(path.join(dir, 'tests', 'deep'), { recursive: true });
  for (const file of ['tests/z.yaml', 'tests/a.yml', 'tests/deep/b.yaml', 'tests/no.txt'])
    fs.writeFileSync(path.join(dir, file), '');
  assert.deepEqual(expandFiles(['tests'], dir), ['tests/a.yml', 'tests/deep/b.yaml', 'tests/z.yaml']);
  assert.deepEqual(expandFiles(['tests/**/*.yaml'], dir), ['tests/deep/b.yaml', 'tests/z.yaml']);
  assert.deepEqual(expandFiles(['./tests/*.yaml'], dir), ['tests/z.yaml']);
  assert.deepEqual(expandFiles([path.join(dir, 'tests', '*.yaml')], dir), [path.join(dir, 'tests', 'z.yaml')]);
  assert.deepEqual(expandFiles(['tests/z.yaml', 'tests/a.yml'], dir), ['tests/z.yaml', 'tests/a.yml']);
  assert.throws(() => parseSuiteArgs(['tests/none/*.yaml'], 'browser', {}, dir), /no YAML files matched/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('all Phase 1 guards reject non-default values from their owner files', () => {
  const base = parsed([]).opts;
  assert.throws(() => createReporters({ ...base, reporters: [{ name: 'junit' }] }), /--reporter.*not implemented yet/);
  assert.throws(() => artifactsObserver({ ...base, artifacts: { dir: 'out', screenshot: 'always', trace: 'off' } }), /--artifacts.*not implemented yet/);
  for (const patch of [{ retries: 1 }, { bail: 1 }, { maxTokens: 10 }, { lastFailed: true }])
    assert.throws(() => checkSchedule({ ...base, ...patch }), /not implemented yet/);
  for (const patch of [{ grep: 'x' }, { grepInvert: 'x' }, { tags: ['x'] }])
    assert.throws(() => select([], { ...base, ...patch }), /not implemented yet/);
  assert.throws(() => listSelected([], { ...base, list: true }), /--list.*not implemented yet/);
  assert.throws(() => checkSpecTimeout(100), /--spec-timeout.*not implemented yet/);
  assert.throws(() => parsed(['--config', 'missing.yaml']), /--config.*file not found/);
  assert.throws(() => parsed(['--artifacts', 'out']), /--artifacts.*not implemented yet/);
  assert.throws(() => parsed(['--screenshot', 'always']), /--screenshot.*not implemented yet/);
  assert.throws(() => parsed(['--trace', 'always']), /--trace.*not implemented yet/);
});

test('worker constraints reject native concurrency and shared browser contexts', () => {
  assert.throws(() => parsed(['--workers', '2'], 'desktop'), /--workers > 1/);
  assert.throws(() => parsed(['--workers', '2'], 'mobile'), /--workers > 1/);
  assert.throws(() => parsed(['--workers', '2', '--profile', '/tmp/p']), /--workers > 1/);
  assert.throws(() => parsed(['--workers', '2', '--cdp', 'http://localhost']), /--workers > 1/);
});
