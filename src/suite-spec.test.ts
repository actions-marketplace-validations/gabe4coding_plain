import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSpec, parseStep } from './spec.js';
import { loadComputerSpec } from './computer-spec.js';
import { loadMobileSpec } from './mobile-spec.js';
import { label } from './results.js';

const write = (body: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainwright-suite-spec-'));
  const file = path.join(dir, 'case.yaml'); fs.writeFileSync(file, body); return file;
};

test('browser loads metadata and declared context fields', () => {
  const spec = loadSpec(write(`name: x\nurl: https://example.com\ntags: [smoke, checkout]\ntimeout: 120000\nbrowser:\n  viewport: {width: 1280, height: 800}\n  colorScheme: dark\nsteps:\n  - goto: https://example.com\n`));
  assert.deepEqual(spec.tags, ['smoke', 'checkout']);
  assert.equal(spec.timeout, 120000);
  assert.equal(spec.browser?.viewport?.width, 1280);
  assert.equal(spec.browser?.colorScheme, 'dark');
});

test('native schemas accept tags and timeout, and reject browser fields', () => {
  const desktop = loadComputerSpec(write('name: x\napp: Notes\ntags: [smoke]\ntimeout: 120000\nsteps:\n  - click: Save\n'));
  assert.deepEqual(desktop.tags, ['smoke']); assert.equal(desktop.timeout, 120000);
  const mobile = loadMobileSpec(write('name: x\nplatform: ios\ndevice: simulator\napp: app\ntags: [smoke]\ntimeout: 120000\nsteps:\n  - tap: Save\n'));
  assert.deepEqual(mobile.tags, ['smoke']); assert.equal(mobile.timeout, 120000);
  assert.throws(() => loadComputerSpec(write('name: x\napp: Notes\nbrowser: {}\nsteps:\n  - click: Save\n')));
  assert.throws(() => loadMobileSpec(write('name: x\nplatform: ios\ndevice: simulator\napp: app\nbrowser: {}\nsteps:\n  - tap: Save\n')));
});

test('step origin prefixes labels; user-written origin is rejected', () => {
  assert.equal(label(parseStep('x', 0, { click: 'Login', origin: 'flows/login.yaml' })), 'flows/login.yaml › click "Login"');
  assert.throws(() => loadSpec(write('name: x\nurl: https://example.com\nsteps:\n  - click: Login\n    origin: fake\n')), /origin: reserved/);
  assert.throws(() => parseStep('x', 0, { click: 'Login', hover: 'Save' }), /"optional" and "origin"/);
  assert.throws(() => loadSpec(write('name: x\nurl: https://example.com\nsteps:\n  - include: flow.yaml\n')), /include: not implemented yet/);
});

test('onMissingEnv collects missing values while preserving the literal reference', () => {
  const file = write('name: x\nurl: https://example.com\nauth: {user: $PLAINWRIGHT_TEST_MISSING_USER, pass: ok}\nenv: {token: $PLAINWRIGHT_TEST_MISSING_TOKEN}\nsteps:\n  - goto: https://example.com\n');
  const warnings: string[] = [];
  const spec = loadSpec(file, { onMissingEnv: (message) => warnings.push(message) });
  assert.equal(spec.auth?.user, '$PLAINWRIGHT_TEST_MISSING_USER');
  assert.equal(spec.env?.token, '$PLAINWRIGHT_TEST_MISSING_TOKEN');
  assert.equal(warnings.length, 2);
  assert.throws(() => loadSpec(file), /env var is not set/);
});
