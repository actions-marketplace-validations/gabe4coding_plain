import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { filterLastFailed, formatList, listSelected, select } from './select.js';
import { runSuite } from './suite.js';
import type { Loaded, SuiteEngine, SuiteOptions } from './suite-types.js';

const base: SuiteOptions = { files: [], workers: 1, retries: 0, bail: 0, lastFailed: false, tags: [], list: false,
  reporters: [{ name: 'text' }], timing: false };
const specs: Loaded<string>[] = [
  { file: 'tests/cart.yaml', name: 'Checkout', tags: ['smoke', 'checkout'], spec: 'cart' },
  { file: path.resolve('tests/login.yaml'), name: 'Login', tags: ['smoke'], spec: 'login' },
  { file: 'tests/checkout-refund.yml', name: 'Refund', tags: ['checkout'], spec: 'refund' },
];

test('selection matches name OR cwd-relative path, in input order', () => {
  assert.deepEqual(select(specs, { ...base, grep: 'Checkout|refund' }), [specs[0], specs[2]]);
  assert.deepEqual(select(specs, { ...base, grep: '^tests/login' }), [specs[1]]);
  assert.deepEqual(select(specs, { ...base, grep: '^/workspace' }), []);
  assert.deepEqual(select(specs, { ...base, grepInvert: 'Checkout|refund' }), [specs[1]]);
  assert.deepEqual(select(specs, { ...base, grep: '' }), specs);
  assert.deepEqual(select(specs, { ...base, grepInvert: '' }), []);
});

test('selection requires every tag and combines filters', () => {
  assert.deepEqual(select(specs, { ...base, tags: ['smoke'] }), [specs[0], specs[1]]);
  assert.deepEqual(select(specs, { ...base, tags: ['smoke', 'checkout'] }), [specs[0]]);
  assert.deepEqual(select(specs, { ...base, tags: ['missing'] }), []);
  assert.deepEqual(select(specs, { ...base, grep: 'tests/', grepInvert: 'refund', tags: ['smoke'] }), specs.slice(0, 2));
  assert.deepEqual(specs.map((s) => s.spec), ['cart', 'login', 'refund']);
});

test('invalid regex is a usage error even with no loaded specs', () => {
  for (const key of ['grep', 'grepInvert'] as const) {
    assert.throws(() => select([], { ...base, [key]: '[' }), new RegExp(`--${key === 'grep' ? 'grep' : 'grep-invert'}: invalid regex`));
  }
});

test('last-failed selection keeps all on absent history, none on empty history, and only listed files otherwise', () => {
  assert.equal(filterLastFailed(specs, undefined), specs);
  assert.deepEqual(filterLastFailed(specs, new Set()), []);
  assert.deepEqual(filterLastFailed(specs, new Set([path.resolve(specs[2].file), path.resolve(specs[0].file), path.resolve('deleted.yaml')])), [specs[0], specs[2]]);
  const tagged = select(specs, { ...base, tags: ['smoke'] });
  assert.deepEqual(filterLastFailed(tagged, new Set([path.resolve(specs[1].file), path.resolve(specs[2].file)])), [specs[1]]);
  assert.deepEqual(filterLastFailed([{ ...specs[0], file: './tests/../tests/cart.yaml' }], new Set([path.resolve(specs[0].file)])),
    [{ ...specs[0], file: './tests/../tests/cart.yaml' }]);
});

test('last-failed prints one note when persistence has no previous run', (t) => {
  const log = t.mock.method(console, 'error', () => {});
  assert.deepEqual(select(specs, { ...base, lastFailed: true, tags: ['smoke'] }), specs.slice(0, 2));
  assert.equal(log.mock.callCount(), 1);
  assert.equal(log.mock.calls[0].arguments[0], 'plainwright: no previous run found; running all selected specs');
});

test('list format includes files, names, tags and has no empty output', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  assert.equal(formatList([specs[0], { ...specs[2], tags: [] }]),
    'tests/cart.yaml  Checkout  [smoke, checkout]\ntests/checkout-refund.yml  Refund  []');
  assert.equal(listSelected(specs, base), false);
  assert.equal(listSelected([], { ...base, list: true }), true);
  assert.equal(log.mock.callCount(), 0);
  assert.equal(listSelected([specs[0]], { ...base, list: true }), true);
  assert.equal(log.mock.calls[0].arguments[0], formatList([specs[0]]));
});

const engine: SuiteEngine<string> = { engine: 'browser', maxWorkers: 1,
  load: (file) => { if (file === 'broken.yaml') throw new Error('bad YAML'); return file; },
  meta: (name) => ({ name, tags: ['smoke'] }), run: async () => { throw new Error('must not run'); } };
const noKey = { provider: (): never => { throw new Error('must not request a key'); }, warmUp: () => {} };

test('suite lists selected specs without provider, warmup, observers, or browser calls', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const report = await runSuite(engine, { ...base, files: ['b.yaml', 'a.yaml'], grepInvert: '^a', list: true },
    { ...noKey, warmUp: () => { throw new Error('must not warm up'); }, observers: [{ runStart: async () => { throw new Error('must not report'); } }] });
  assert.equal(report.status, 'pass');
  assert.equal(report.totals.jevCalls, 0);
  assert.equal(log.mock.calls[0].arguments[0], 'b.yaml  b.yaml  [smoke]');
});

test('suite retains load errors when every loaded spec is filtered out', async (t) => {
  t.mock.method(console, 'error', () => {});
  const report = await runSuite(engine, { ...base, files: ['good.yaml', 'broken.yaml'], grep: 'nothing', tags: ['missing'] }, noKey);
  assert.equal(report.status, 'fail');
  assert.equal(report.specs.length, 1);
  assert.equal(report.specs[0].file, 'broken.yaml');
  assert.match(report.specs[0].loadError ?? '', /bad YAML/);
});
