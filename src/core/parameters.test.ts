import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fill, mapStrings, parameterize, parametersOf } from './parameters.js';

const run = (title: string, day: number) => parametersOf({ env: { site: 'https://shop.test' }, hooks: { title, day, user: { name: 'Ada' } } });

test('a value becomes its placeholder, and the next run fills its own value in', () => {
  const first = run('Plain 1234', 15);
  const recorded = parameterize("getByRole('row', { name: 'Plain 1234 15 Nov' })", first);
  assert.equal(recorded, "getByRole('row', { name: '${hooks.title} ${hooks.day} Nov' })");
  assert.equal(fill(recorded, run('Plain 5678', 16)), "getByRole('row', { name: 'Plain 5678 16 Nov' })");
  assert.equal(parameterize('the Plain 5678 event row', run('Plain 5678', 16)), parameterize('the Plain 1234 event row', first));
});

test('a short value is replaced only where no letter or digit touches it; a long one anywhere', () => {
  const values = run('Moka', 15);
  assert.equal(parameterize('15 Nov 2015, 150 g', values), '${hooks.day} Nov 2015, 150 g');
  assert.equal(parameterize('Moka pot', values), '${hooks.title} pot');
  assert.equal(parameterize('Hello Ada', values), 'Hello ${hooks.user.name}');
});

test('one pass: a placeholder put in is never matched again, and an unknown placeholder stays as page text', () => {
  const values = parametersOf({ env: {}, hooks: { a: 'hooks', b: 'xhooksx' } });
  assert.equal(parameterize('xhooksx and hooks', values), '${hooks.b} and ${hooks.a}');
  assert.equal(fill('price ${hooks.missing} and ${hooks.a}', values), 'price ${hooks.missing} and hooks');
});

test('mapStrings changes data fields and leaves the names in `keep`', () => {
  const locator = { strategy: 'role', parts: [{ by: 'role', role: 'row', name: 'row Ada' }] };
  assert.deepEqual(mapStrings(locator, (text) => parameterize(text, run('t', 1)), new Set(['by', 'strategy', 'role'])),
    { strategy: 'role', parts: [{ by: 'role', role: 'row', name: 'row ${hooks.user.name}' }] });
});
