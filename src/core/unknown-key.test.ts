import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closest, unknownKey } from './unknown-key.js';

test('closest finds a near key: one edit under 5 letters, two from 5, swaps and case count once', () => {
  const keys = ['that', 'within', 'optional', 'timeout', 'url', 'steps'];
  assert.equal(closest('whithin', keys), 'within');
  assert.equal(closest('Within', keys), 'within');
  assert.equal(closest('optinal', keys), 'optional');
  assert.equal(closest('timeuot', keys), 'timeout');
  assert.equal(closest('step', keys), 'steps');
  assert.equal(closest('uri', keys), 'url');
  assert.equal(closest('urll', keys), 'url');
  assert.equal(closest('ulr', keys), 'url');
  assert.equal(closest('uxx', keys), undefined);
  assert.equal(closest('metadata', keys), undefined);
  assert.equal(closest('x', []), undefined);
});

test('unknownKey names the key, then a suggestion or the expected keys', () => {
  assert.equal(unknownKey('whithin', ['that', 'within']), 'unknown key "whithin"; did you mean "within"?');
  assert.equal(unknownKey('metadata', ['that', 'within']), 'unknown key "metadata" (expected one of that, within)');
  assert.equal(unknownKey('metadata', []), 'unknown key "metadata"');
});
