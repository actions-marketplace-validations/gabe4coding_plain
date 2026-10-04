import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readArtifact } from './artifacts.mjs';

test('artifact reader accepts linked output roots and rejects sibling/traversal/symlink escapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'plain-artifacts-'));
  try {
    const real = join(root, 'real'), alias = join(root, 'alias');
    mkdirSync(real);
    symlinkSync(real, alias, 'dir');
    mkdirSync(join(real, 'trial'));
    mkdirSync(join(real, 'trial-sibling'));
    writeFileSync(join(real, 'trial', 'page.yml'), 'one\ntwo\nthree');
    writeFileSync(join(real, 'trial-sibling', 'page.yml'), 'outside');
    symlinkSync(join(real, 'trial-sibling', 'page.yml'), join(real, 'trial', 'escape.yml'));
    assert.deepEqual(readArtifact(root, join(alias, 'trial'), { path: 'alias/trial/page.yml', startLine: 1, lineCount: 1 }),
      { totalLines: 3, startLine: 1, text: 'two' });
    for (const path of ['real/trial-sibling/page.yml', 'alias/trial/../trial-sibling/page.yml', 'alias/trial/escape.yml']) {
      assert.throws(() => readArtifact(root, join(alias, 'trial'), { path }), /Only this trial/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
