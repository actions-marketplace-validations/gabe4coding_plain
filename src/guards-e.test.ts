// Lane E's "not implemented yet" guards. Lane E deletes this file (or turns it into real tests) when it
// removes them; no other test file asserts them, so lanes never edit the same test lines.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSpecTimeoutFlag } from './spec-features.js';
import { loadSpec } from './spec.js';
import { loadComputerSpec } from './computer-spec.js';
import { loadMobileSpec } from './mobile-spec.js';
import { validate } from './validate.js';
import type { SuiteEngine } from './suite-types.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainwright-guards-e-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (name: string, body: string): string => { const file = path.join(dir, name); fs.writeFileSync(file, body); return file; };
const page = 'name: x\nurl: https://example.com\nsteps:\n  - goto: https://example.com\n';
const browser: SuiteEngine<ReturnType<typeof loadSpec>> = { engine: 'browser', maxWorkers: 1, load: loadSpec,
  meta: (spec) => ({ name: spec.name, tags: spec.tags ?? [], timeoutMs: spec.timeout }), run: async () => { throw new Error('not run'); } };
const desktop: SuiteEngine<ReturnType<typeof loadComputerSpec>> = { engine: 'desktop', maxWorkers: 1, load: loadComputerSpec,
  meta: (spec) => ({ name: spec.name, tags: spec.tags ?? [], timeoutMs: spec.timeout }), run: async () => { throw new Error('not run'); } };

test('lane E guards: --spec-timeout, include, spec timeout and browser: at load time', () => {
  assert.throws(() => checkSpecTimeoutFlag(100), /--spec-timeout.*not implemented yet/);
  assert.throws(() => loadSpec(write('include.yaml', 'name: x\nurl: https://example.com\nsteps:\n  - include: flow.yaml\n')), /include: not implemented yet/);
  assert.throws(() => loadSpec(write('timeout.yaml', page.replace('steps:', 'timeout: 120000\nsteps:'))), /timeout\.yaml: timeout: not implemented yet/);
  assert.throws(() => loadSpec(write('browser.yaml', page.replace('steps:', 'browser:\n  colorScheme: dark\nsteps:'))), /browser: not implemented yet/);
  assert.throws(() => loadComputerSpec(write('desktop.yaml', 'name: x\napp: Notes\ntimeout: 120000\nsteps:\n  - click: Save\n')), /timeout: not implemented yet/);
  assert.throws(() => loadMobileSpec(write('mobile.yaml', 'name: x\nplatform: ios\ndevice: simulator\napp: app\ntimeout: 120000\nsteps:\n  - tap: Save\n')), /timeout: not implemented yet/);
});

test('lane E guards are load errors, so validate reports them next to missing-env warnings', () => {
  const timeout = write('v-timeout.yaml', page.replace('steps:', 'timeout: 120000\nsteps:'));
  const context = write('v-browser.yaml', page.replace('steps:', 'browser:\n  viewport: {width: 1280, height: 800}\nsteps:'));
  const both = write('v-missing-timeout.yaml', 'name: x\nurl: https://example.com\ntimeout: 1000\nenv: {token: $PLAINWRIGHT_VALIDATE_MISSING}\nsteps:\n  - goto: https://example.com\n');
  const native = write('v-native.yaml', 'name: x\napp: Notes\ntimeout: 120000\nsteps:\n  - click: Save\n');
  const [timeoutR, contextR, bothR] = validate(browser, [timeout, context, both]);
  assert.match(timeoutR.error ?? '', /v-timeout\.yaml: timeout: not implemented yet/);
  assert.match(contextR.error ?? '', /v-browser\.yaml: browser: not implemented yet/);
  assert.match(bothR.error ?? '', /timeout: not implemented yet/);
  assert.match(bothR.warnings[0], /env var is not set/);
  assert.match(validate(desktop, [native])[0].error ?? '', /timeout: not implemented yet/);
});
