// Native iOS validation with a disposable offline app. Requires a booted simulator and Appium.
// --live-jev additionally verifies real natural-language authoring, assertions and recorded replay.
import assert from 'node:assert/strict';
import { installMobileFixture, fixtureApp } from './mobile-fixture.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppiumAdapter } from '../dist/mobile/adapter.js';
import { createMobileServer } from '../dist/mobile/mcp.js';
import { MobileSession, runMobileSpec } from '../dist/mobile/session.js';
import { loadMobileSpec } from '../dist/mobile/spec.js';
import { intelligence } from '../dist/core/automation.js';
import { USER_ENV_FILE } from '../dist/jev/jev.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const device = process.env.PLAINWRIGHT_MOBILE_DEVICE;
assert.ok(device, 'Set PLAINWRIGHT_MOBILE_DEVICE to a booted iOS simulator UDID');
const live = process.argv.includes('--live-jev');
if (live) for (const file of [join(root, '.env'), USER_ENV_FILE]) { try { process.loadEnvFile(file); } catch {} }
const output = mkdtempSync(join(tmpdir(), 'plainwright-ios-results-'));
const app = fixtureApp;
let uninstall;
const restart = () => execFileSync('xcrun', ['simctl', 'terminate', device, app]);
const adapter = new AppiumAdapter(process.env.PLAINWRIGHT_APPIUM_URL, 240000);
const message = 'iOS adapter works';
const deterministic = {
  pick: async (candidates, targets) => targets.map((target, i) => {
    const prefix = {
      'the Message text field': 'XCUIElementTypeTextField "Message"',
      'the Done keyboard button': 'XCUIElementTypeButton "Done"',
      'the Enable preview switch': 'XCUIElementTypeSwitch "Enable preview"',
      'the Preview button': 'XCUIElementTypeButton "Preview"',
      'the Hold for details button': 'XCUIElementTypeButton "Hold for details"',
      'the Fixture results list': 'XCUIElementTypeScrollView "Fixture results list"',
    }[target];
    assert.ok(prefix, `Unknown fixture target: ${target}`);
    const matches = candidates.filter(c => c.desc.toLowerCase().startsWith(prefix.toLowerCase()));
    assert.equal(matches.length, 1, `Expected unique ${target}: ${JSON.stringify(candidates)}`);
    return { id: matches[0].id, probability: 1, probabilities: { [matches[0].id]: 1 }, tokens: i === 0 ? 1 : 0 };
  }),
  judge: async (state, claims) => ({ probabilities: claims.map(claim => {
    if (claim === 'The preview says iOS adapter works') return state.aria.includes(`Preview: ${message}`) ? 1 : 0;
    if (claim === 'Details are visible') return state.aria.includes('Details are visible') ? 1 : 0;
    throw new Error(`Unknown fixture claim: ${claim}`);
  }), tokens: 1 }),
};
const ai = live ? intelligence : deterministic;
const { server, close } = createMobileServer(adapter, 240000, ai);
const client = new Client({ name: 'native-ios-smoke', version: '1' });
const [a, b] = InMemoryTransport.createLinkedPair();
const results = [];
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 });
  assert.ok(!r.isError, JSON.stringify(r));
  return JSON.parse(r.content[0].text);
}
async function step(raw) {
  const r = await call('step', { step: raw });
  results.push(r); console.log(`${r.status}: ${r.step}`);
  assert.equal(r.status, 'pass', JSON.stringify(r));
}
try {
  uninstall = installMobileFixture('ios', device);
  console.log('Installed disposable ios fixture; opening Appium session.');
  await server.connect(a); await client.connect(b);
  await call('open', { platform: 'ios', device, app, capabilities: { 'appium:wdaLaunchTimeout': 180000 } });
  await step({ fill: { target: 'the Message text field', value: message } });
  // XCUITest cannot generically dismiss every iPhone keyboard; use the app's explicit control.
  await step({ tap: 'the Done keyboard button' });
  assert.ok((await call('snapshot')).aria.includes(`value="${message}"`));
  await step({ check: 'the Enable preview switch' });
  await step({ check: 'the Enable preview switch' });
  assert.match((await call('snapshot')).aria, /XCUIElementTypeSwitch "Enable preview" value="1"/);
  await step({ uncheck: 'the Enable preview switch' });
  assert.match((await call('snapshot')).aria, /XCUIElementTypeSwitch "Enable preview" value="0"/);
  await step({ check: 'the Enable preview switch' });
  await step({ tap: 'the Preview button' });
  assert.ok((await call('snapshot')).aria.includes(`Preview: ${message}`));
  await step({ expect: 'The preview says iOS adapter works' });
  await step({ longpress: 'the Hold for details button' });
  assert.ok((await call('snapshot')).aria.includes('Details are visible'));
  await step({ expect: 'Details are visible' });
  writeFileSync(join(output, 'preview.png'), await adapter.screenshot());
  await step({ scroll: 'down: the Fixture results list' });
  await step({ swipe: 'down' });
  const specPath = join(output, 'recorded.yaml');
  await call('save', { path: specPath, name: 'Native iOS preview' });
  await call('close');
  restart(); // Reset only this disposable fixture before replay.
  const replay = await runMobileSpec(loadMobileSpec(specPath), new MobileSession(new AppiumAdapter(process.env.PLAINWRIGHT_APPIUM_URL, 240000), 240000, ai));
  writeFileSync(join(output, 'report.json'), JSON.stringify({ device, liveJev: live, authoring: results, replay }, null, 2));
  assert.equal(replay.status, 'pass', JSON.stringify(replay));
  console.log(`Native iOS authoring and replay passed (${live ? 'real Jev' : 'injected intelligence'}). Results: ${output}`);
} catch (error) {
  writeFileSync(join(output, 'failure.json'), JSON.stringify({ device, liveJev: live, authoring: results, error: String(error) }, null, 2));
  try {
    writeFileSync(join(output, 'failure.png'), await adapter.screenshot());
    writeFileSync(join(output, 'failure-tree.txt'), (await adapter.capture('region')).snapshot.aria);
  } catch {} // Preserve the original error if the Appium session never opened or has already closed.
  console.error(`Failure artifacts: ${output}`);
  throw error;
} finally {
  try { await close(); await client.close(); await server.close(); }
  finally {
    try { uninstall?.(); }
    catch (error) { console.error(`Fixture cleanup failed: ${error.message}`); process.exitCode = 1; }
  }
}
