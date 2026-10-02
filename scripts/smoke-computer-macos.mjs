// Opt-in native smoke: operates only a disposable Cocoa fixture; no Jev key required.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Xa11yAdapter } from '../dist/computer/adapter.js';
import { ComputerSession } from '../dist/computer/session.js';
if (process.platform !== 'darwin') throw new Error('This fixture requires macOS; the adapter API is cross-platform');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'plainwright-native-'));
let fixture;
const adapter = new Xa11yAdapter(15000);
try {
  const binary = join(dir, 'PlainwrightFixture');
  execFileSync('xcrun', ['clang', '-fobjc-arc', '-framework', 'Cocoa', join(root, 'scripts/fixtures/computer-macos.m'), '-o', binary], { stdio: 'inherit' });
  fixture = spawn(binary, [], { stdio: 'ignore' });
  await once(fixture, 'spawn');
  await new Promise(r => setTimeout(r, 800));
  await adapter.open({ pid: fixture.pid }, true);
  const ai = {
    pick: async (candidates, targets) => targets.map((target, i) => {
      const matches = candidates.filter(c => c.desc.startsWith(target));
      assert.equal(matches.length, 1, `Expected unique fixture control ${target}: ${JSON.stringify(candidates)}`);
      return { id: matches[0].id, probability: 1, probabilities: { [matches[0].id]: 1 }, tokens: i === 0 ? 1 : 0 };
    }),
    judge: async () => { throw new Error('Smoke assertions read actual native state'); },
  };
  const session = new ComputerSession(adapter, 15000, ai);
  async function step(raw) {
    const result = await session.step(raw);
    assert.equal(result.status, 'pass', JSON.stringify(result));
  }
  const fills = await adapter.capture('fill');
  assert.ok(fills.candidates.length, JSON.stringify(fills.snapshot));
  const message = fills.candidates.find(c => c.desc.includes('Message'));
  assert.ok(message, JSON.stringify(fills.candidates));
  const target = message.desc.split(' value=')[0].split(' [')[0].split(' in ')[0];
  await step({ fill: { target, value: 'desktop adapter works' } });
  const checks = await adapter.capture('check');
  const checkbox = checks.candidates.find(c => c.desc.includes('Enable preview'));
  assert.ok(checkbox, JSON.stringify(checks.candidates));
  const checkTarget = checkbox.desc.split(' value=')[0].split(' [')[0].split(' in ')[0];
  await step({ check: checkTarget });
  await step({ check: checkTarget }); // Must stay checked, not toggle back.
  let snap = await session.snapshot(); assert.match(snap.aria, /checked=on/);
  await step({ uncheck: checkTarget });
  snap = await session.snapshot(); assert.match(snap.aria, /checked=off/);
  await step({ click: 'button "Preview"' });
  snap = await session.snapshot(); assert.match(snap.aria, /Preview: desktop adapter works/);
  await step({ press: 'Tab' });
  await step({ hover: 'button "Preview"' });
  if (!process.argv.includes('--skip-screenshot')) {
    const png = await adapter.screenshot();
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
  }
  console.log('Native macOS smoke passed: attach, capture, fill, click, idempotent check/uncheck, key, hover.' + (process.argv.includes('--skip-screenshot') ? ' Screenshot skipped explicitly.' : ' Screenshot passed.'));
} finally {
  await adapter.close();
  if (fixture && fixture.exitCode === null) {
    const exited = once(fixture, 'exit'); fixture.kill(); await exited;
  }
  rmSync(dir, { recursive: true, force: true });
}
