// Lane A's "not implemented yet" guards. Lane A deletes this file (or turns it into real tests) when it
// removes them; no other test file asserts them, so lanes never edit the same test lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReporters } from './reporters/index.js';
import type { SuiteOptions } from './suite-types.js';

const base: SuiteOptions = { files: ['case.yaml'], workers: 1, retries: 0, bail: 0, lastFailed: false, tags: [], list: false,
  reporters: [{ name: 'text' }], timing: false };

test('lane A guard: reporters other than text/jsonl, and reporter outputs', () => {
  assert.throws(() => createReporters({ ...base, reporters: [{ name: 'junit' }] }), /--reporter.*not implemented yet/);
  assert.throws(() => createReporters({ ...base, reporters: [{ name: 'text', output: 'out.txt' }] }), /--reporter output: not implemented yet/);
});
