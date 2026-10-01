import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from './validate.js';
import { loadSpec } from './spec.js';
import { loadComputerSpec } from './computer-spec.js';
import type { SuiteEngine } from './suite-types.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainwright-validate-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (name: string, body: string): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
};
const browser: SuiteEngine<ReturnType<typeof loadSpec>> = { engine: 'browser', maxWorkers: 1, load: loadSpec,
  meta: (spec) => ({ name: spec.name, tags: spec.tags ?? [], timeoutMs: spec.timeout }),
  run: async () => { throw new Error('not run'); } };
const desktop: SuiteEngine<ReturnType<typeof loadComputerSpec>> = { engine: 'desktop', maxWorkers: 1, load: loadComputerSpec,
  meta: (spec) => ({ name: spec.name, tags: spec.tags ?? [], timeoutMs: spec.timeout }),
  run: async () => { throw new Error('not run'); } };
const page = 'name: x\nurl: https://example.com\nsteps:\n  - goto: https://example.com\n';

test('validate errors on timeout and non-empty browser: the load-time guards of lane E', () => {
  const ok = write('ok.yaml', page);
  const timeout = write('timeout.yaml', page.replace('steps:', 'timeout: 120000\nsteps:'));
  const context = write('browser.yaml', page.replace('steps:', 'browser:\n  viewport: {width: 1280, height: 800}\nsteps:'));
  const empty = write('empty.yaml', page.replace('steps:', 'browser: {}\nsteps:'));
  const native = write('native.yaml', 'name: x\napp: Notes\ntimeout: 120000\nsteps:\n  - click: Save\n');
  const [okR, timeoutR, contextR, emptyR] = validate(browser, [ok, timeout, context, empty]);
  assert.equal(okR.error, undefined);
  assert.match(timeoutR.error ?? '', /timeout\.yaml: timeout: not implemented yet/);
  assert.match(contextR.error ?? '', /browser\.yaml: browser: not implemented yet/);
  assert.equal(emptyR.error, undefined);
  assert.match(validate(desktop, [native])[0].error ?? '', /timeout: not implemented yet/);
  // The same guard stops a run before any browser opens: it is a load error.
  assert.throws(() => loadSpec(timeout), /timeout: not implemented yet/);
});

test('validate keeps load errors and missing-env warnings', () => {
  const missing = write('missing.yaml', 'name: x\nurl: https://example.com\nenv: {token: $PLAINWRIGHT_VALIDATE_MISSING}\nsteps:\n  - goto: https://example.com\n');
  const both = write('missing-timeout.yaml', 'name: x\nurl: https://example.com\ntimeout: 1000\nenv: {token: $PLAINWRIGHT_VALIDATE_MISSING}\nsteps:\n  - goto: https://example.com\n');
  const include = write('include.yaml', 'name: x\nurl: https://example.com\nsteps:\n  - include: flow.yaml\n');
  const [warn, timed, broken] = validate(browser, [missing, both, include]);
  assert.equal(warn.error, undefined);
  assert.match(warn.warnings[0], /env var is not set/);
  assert.match(timed.error ?? '', /timeout: not implemented yet/);
  assert.match(timed.warnings[0], /env var is not set/);
  assert.match(broken.error ?? '', /include: not implemented yet/);
});
