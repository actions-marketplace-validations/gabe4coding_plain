import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatValidation, validate } from './validate.js';
import { loadSpec } from './spec.js';
import { loadComputerSpec } from './computer-spec.js';
import { loadMobileSpec } from './mobile-spec.js';
import type { SuiteEngine } from './suite-types.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainwright-validate-d-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
let next = 0;
function fixture(body: string): string {
  const file = path.join(dir, `${next++}.yaml`);
  fs.writeFileSync(file, body);
  return file;
}
const browser: SuiteEngine<ReturnType<typeof loadSpec>> = { engine: 'browser', maxWorkers: 1, load: loadSpec,
  meta: (spec) => ({ name: spec.name, tags: spec.tags ?? [] }), run: async () => { throw new Error('must not run'); } };
const page = 'name: x\nurl: https://example.com\n';

test('validate accepts declared env leaves, including missing secret references, zero, false, and hooks', () => {
  const file = fixture(`${page}env:
  user: {name: $PLAINWRIGHT_LANE_D_MISSING_ENV}
  count: 0
  enabled: false
steps:
  - fill: {target: the username, value: '${'${env.user.name}'}'}
  - expect: '${'${env.count}'} ${'${env.enabled}'} ${'${hooks.dynamic.value}'}'
`);
  const [result] = validate(browser, [file]);
  assert.equal(result.error, undefined);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /PLAINWRIGHT_LANE_D_MISSING_ENV.*not set/);
});

test('validate checks URL and nested step fields and rejects missing or non-scalar env paths', () => {
  for (const expr of ['env.unknown', 'env.user.unknown', 'env.user', 'env.nil', 'env.list.0', 'env.user.name.more', 'env.toString', 'env.', 'env']) {
    const file = fixture(`${page}env: {user: {name: Bob}, nil: null, list: [a]}
steps:
  - fill: {target: the username, value: '${'${'}${expr}}'}
`);
    assert.match(validate(browser, [file])[0].error ?? '', /is not defined/, expr);
  }
  const file = fixture('name: x\nurl: "https://example.com/${env.host}"\nsteps:\n  - click: OK\n');
  assert.match(validate(browser, [file])[0].error ?? '', /\$\{env.host\}/);
});

test('validate loads every file and preserves warnings when a later placeholder check fails', () => {
  const files = [fixture(`${page}steps:\n  - click: OK\n`), fixture('name: bad\nsteps: []\n'),
    fixture(`${page}env: {user: $PLAINWRIGHT_LANE_D_MISSING_ENV}\nsteps:\n  - click: '\${env.absent}'\n`)];
  const results = validate(browser, files);
  assert.deepEqual(results.map((r) => r.file), files);
  assert.equal(results[0].error, undefined);
  assert.ok(results[1].error);
  assert.match(results[2].error ?? '', /env.absent/);
  assert.equal(results[2].warnings.length, 1);
});

test('validate stays generic across native engines', () => {
  const desktop: SuiteEngine<ReturnType<typeof loadComputerSpec>> = { engine: 'desktop', maxWorkers: 1, load: loadComputerSpec,
    meta: (spec) => ({ name: spec.name, tags: [] }), run: async () => { throw new Error('must not run'); } };
  const mobile: SuiteEngine<ReturnType<typeof loadMobileSpec>> = { engine: 'mobile', maxWorkers: 1, load: loadMobileSpec,
    meta: (spec) => ({ name: spec.name, tags: [] }), run: async () => { throw new Error('must not run'); } };
  const computerFile = fixture('name: desktop\napp: TestApp\nsteps:\n  - click: "${env.missing}"\n');
  const mobileFile = fixture('name: mobile\nplatform: android\ndevice: fixture\napp: org.test\nsteps:\n  - tap: "${env.missing}"\n');
  assert.match(validate(desktop, [computerFile])[0].error ?? '', /env.missing/);
  assert.match(validate(mobile, [mobileFile])[0].error ?? '', /env.missing/);
});

test('validation output shows successes, failures, and warnings', () => {
  assert.equal(formatValidation([{ file: 'ok.yaml', warnings: [] }, { file: 'warn.yaml', warnings: ['missing secret'] },
    { file: 'bad.yaml', error: 'unknown env.x', warnings: ['missing key'] }]),
  '✔ ok.yaml\n✔ warn.yaml\n! warn.yaml: missing secret\n✘ bad.yaml: unknown env.x\n! bad.yaml: missing key');
  assert.equal(formatValidation([]), '');
});
