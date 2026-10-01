// Lane D's "not implemented yet" guards. Lane D deletes this file (or turns it into real tests) when it
// removes them; no other test file asserts them, so lanes never edit the same test lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { select, listSelected } from './select.js';
import { loadConfig } from './config.js';
import { runSuite } from './suite.js';
import type { SuiteEngine, SuiteOptions } from './suite-types.js';

const base: SuiteOptions = { files: ['case.yaml'], workers: 1, retries: 0, bail: 0, lastFailed: false, tags: [], list: false,
  reporters: [{ name: 'text' }], timing: false };

test('lane D guards: --grep, --grep-invert, --tag, --list, a config file', async () => {
  for (const patch of [{ grep: 'x' }, { grepInvert: 'x' }, { tags: ['x'] }])
    assert.throws(() => select([], { ...base, ...patch }), /not implemented yet/);
  assert.throws(() => listSelected([], { ...base, list: true }), /--list.*not implemented yet/);
  // The --list guard fails before any key is asked for.
  let calls = 0;
  const engine: SuiteEngine<string> = { engine: 'browser', maxWorkers: 1, load: (file) => file, meta: (name) => ({ name, tags: [] }),
    run: async () => { throw new Error('not run'); } };
  await assert.rejects(runSuite(engine, { ...base, list: true }, {
    provider: () => { calls++; throw new Error('key required'); }, warmUp: () => {},
  }), /--list: not implemented yet/);
  assert.equal(calls, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainwright-guards-d-'));
  try {
    fs.writeFileSync(path.join(dir, 'plainwright.config.yaml'), 'workers: 2\n');
    assert.throws(() => loadConfig(dir), /--config: not implemented yet/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
