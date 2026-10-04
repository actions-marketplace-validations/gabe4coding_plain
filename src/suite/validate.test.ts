import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from './validate.js';
import { loadSpec } from '../core/spec.js';
import { loadComputerSpec } from '../computer/spec.js';
import type { SuiteEngine } from './types.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-validate-'));
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

test('validate keeps missing-env warnings next to a clean load', () => {
  const missing = write('missing.yaml', 'name: x\nurl: https://example.com\nenv: {token: $PLAIN_VALIDATE_MISSING}\nsteps:\n  - goto: https://example.com\n');
  const [okR, warn] = validate(browser, [write('ok.yaml', page), missing]);
  assert.deepEqual(okR, { file: okR.file, warnings: [] });
  assert.equal(warn.error, undefined);
  assert.match(warn.warnings[0], /env var is not set/);
  assert.match(validate(desktop, [write('bad.yaml', 'name: x\nsteps: []\n')])[0].error ?? '', /app|steps/);
});
