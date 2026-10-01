// Lane B's "not implemented yet" guards. Lane B deletes this file (or turns it into real tests) when it
// removes them; no other test file asserts them, so lanes never edit the same test lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artifactsObserver } from './artifacts.js';
import type { SuiteOptions } from './suite-types.js';

const base: SuiteOptions = { files: ['case.yaml'], workers: 1, retries: 0, bail: 0, lastFailed: false, tags: [], list: false,
  reporters: [{ name: 'text' }], timing: false };

test('lane B guard: --artifacts with any mode', () => {
  assert.equal(artifactsObserver(base), null);
  assert.throws(() => artifactsObserver({ ...base, artifacts: { dir: 'out', screenshot: 'always', trace: 'off' } }), /--artifacts.*not implemented yet/);
});
