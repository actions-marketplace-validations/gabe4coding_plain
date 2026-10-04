import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSpec, parseStep, withOrigin } from '../core/spec.js';
import { loadComputerSpec } from '../computer/spec.js';
import { loadMobileSpec } from '../mobile/spec.js';
import { label } from '../core/results.js';

const write = (body: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-suite-spec-'));
  const file = path.join(dir, 'case.yaml'); fs.writeFileSync(file, body); return file;
};

test('browser loads tags; browser: keeps its strict shape', () => {
  const page = 'name: x\nurl: https://example.com\nsteps:\n  - goto: https://example.com\n';
  assert.deepEqual(loadSpec(write(page.replace('steps:', 'tags: [smoke, checkout]\nsteps:'))).tags, ['smoke', 'checkout']);
  assert.deepEqual(loadSpec(write(page.replace('steps:', 'tags: smoke\nsteps:'))).tags, ['smoke']);
  assert.throws(() => loadSpec(write(page.replace('steps:', 'browser:\n  colour: dark\nsteps:'))), /browser/);
  assert.equal(loadSpec(write(page.replace('steps:', 'browser: {}\nsteps:'))).name, 'x');
});

test('native schemas accept tags and reject browser fields', () => {
  assert.deepEqual(loadComputerSpec(write('name: x\napp: Notes\ntags: [smoke]\nsteps:\n  - click: Save\n')).tags, ['smoke']);
  assert.deepEqual(loadMobileSpec(write('name: x\nplatform: ios\ndevice: simulator\napp: app\ntags: smoke\nsteps:\n  - tap: Save\n')).tags, ['smoke']);
  assert.throws(() => loadComputerSpec(write('name: x\napp: Notes\nbrowser: {}\nsteps:\n  - click: Save\n')));
  assert.throws(() => loadMobileSpec(write('name: x\nplatform: ios\ndevice: simulator\napp: app\nbrowser: {}\nsteps:\n  - tap: Save\n')));
});

test('step origin prefixes labels; user-written and MCP origin is rejected', () => {
  assert.equal(label(withOrigin({ click: 'Login', origin: 'flows/login.yaml' }, (raw) => parseStep('x', 0, raw))), 'flows/login.yaml › click "Login"');
  assert.throws(() => loadSpec(write('name: x\nurl: https://example.com\nsteps:\n  - click: Login\n    origin: fake\n')), /origin: reserved/);
  // MCP `step`/`batch` parse with parseStep: only the loader sets origin.
  assert.throws(() => parseStep('x', 0, { click: 'Login', origin: 'o' }), /step 0: "origin" is reserved for the loader/);
});

test('onMissingEnv collects missing values while preserving the literal reference', () => {
  const file = write('name: x\nurl: https://example.com\nauth: {user: $PLAIN_TEST_MISSING_USER, pass: ok}\nenv: {token: $PLAIN_TEST_MISSING_TOKEN}\nsteps:\n  - goto: https://example.com\n');
  const warnings: string[] = [];
  const spec = loadSpec(file, { onMissingEnv: (message) => warnings.push(message) });
  assert.equal(spec.auth?.user, '$PLAIN_TEST_MISSING_USER');
  assert.equal(spec.env?.token, '$PLAIN_TEST_MISSING_TOKEN');
  assert.equal(warnings.length, 2);
  assert.throws(() => loadSpec(file), /env var is not set/);
});

test('at and origin are rejected inside a step mapping too (YAML and MCP)', () => {
  assert.throws(() => parseStep('mcp', 0, { fill: { target: 'x', value: 'y', at: { file: '/evil', index: 9 } } }), /"at" is reserved for the loader/);
  assert.throws(() => parseStep('mcp', 0, { fill: { target: 'x', value: 'y', origin: 'flows/x.yaml' } }), /"origin" is reserved for the loader/);
});

test('native specs name an unknown top-level or step key and suggest the closest one', () => {
  const mobile = 'name: x\nplatform: ios\ndevice: simulator\napp: app\n';
  assert.throws(() => loadComputerSpec(write('name: x\napp: Notes\nstep: []\n')), /unknown key "step"; did you mean "steps"\?/);
  assert.throws(() => loadComputerSpec(write('name: x\napp: Notes\nsteps:\n  - expect: {that: a, whithin: b}\n')),
    /step 0 "expect": unknown key "whithin"; did you mean "within"\?/);
  assert.throws(() => loadComputerSpec(write('name: x\napp: Notes\nsteps:\n  - goto: /\n')), /goto is browser-only/);
  assert.throws(() => loadMobileSpec(write(`${mobile}devise: x\nsteps:\n  - tap: Save\n`)), /unknown key "devise"; did you mean "device"\?/);
  assert.throws(() => loadMobileSpec(write(`${mobile}steps:\n  - tapp: Save\n`)), /step 0: unknown key "tapp"; did you mean "tap"\?/);
  assert.throws(() => loadMobileSpec(write(`${mobile}steps:\n  - tap: Save\n    optinal: true\n`)), /unknown key "optinal"; did you mean "optional"\?/);
  assert.throws(() => loadMobileSpec(write(`${mobile}steps:\n  - swipe: {direction: up, whithin: list}\n`)),
    /step 0 "swipe": unknown key "whithin"; did you mean "within"\?/);
  assert.throws(() => loadMobileSpec(write(`${mobile}steps:\n  - wait: {that: a, whithin: b}\n`)), /"wait": unknown key "whithin"/);
  assert.throws(() => loadMobileSpec(write(`${mobile}steps:\n  - hover: Save\n`)), /hover is not supported on mobile/);
  const ok = loadMobileSpec(write(`${mobile}capabilities: {anyKey: 1}\nsteps:\n  - tap: Save\n    optional: true\n  - swipe: {direction: up, within: list}\n`));
  assert.deepEqual(ok.steps.map((step) => step.kind), ['tap', 'swipe']);
});
