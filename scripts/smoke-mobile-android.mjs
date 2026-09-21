// Native Android validation with a disposable offline app. Requires a booted emulator and Appium.
// --live-jev additionally verifies real natural-language authoring, assertions and recorded replay.
import assert from 'node:assert/strict';
import { installMobileFixture, fixtureApp } from './mobile-fixture.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppiumAdapter } from '../dist/mobile-adapter.js';
import { createMobileServer } from '../dist/mobile-mcp.js';
import { MobileSession, runMobileSpec } from '../dist/mobile.js';
import { loadMobileSpec } from '../dist/mobile-spec.js';
import { intelligence } from '../dist/automation.js';
import { USER_ENV_FILE } from '../dist/jev.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const java = process.env.JAVA_HOME;
const device = process.env.PLAINWRIGHT_MOBILE_DEVICE;
assert.ok(sdk && java && device, 'Set ANDROID_HOME, JAVA_HOME and PLAINWRIGHT_MOBILE_DEVICE');
const live = process.argv.includes('--live-jev');
if (live) for (const file of [join(root, '.env'), USER_ENV_FILE]) { try { process.loadEnvFile(file); } catch {} }
const output = mkdtempSync(join(tmpdir(), 'plainwright-android-results-'));
const app = fixtureApp;
let uninstall;
const restart = () => execFileSync(join(sdk, 'platform-tools/adb'), ['-s', device, 'shell', 'am', 'force-stop', app]);
const adapter = new AppiumAdapter(process.env.PLAINWRIGHT_APPIUM_URL, 60000);
const message = 'Android adapter works';
const deterministic = {
  pick: async (candidates, targets) => targets.map((target, i) => {
    const prefix = {
      'the Message text field': 'android.widget.EditText "Message"',
      'the Enable preview switch': 'android.widget.Switch "Enable preview"',
      'the Preview button': 'android.widget.Button "Preview"',
      'the Hold for details button': 'android.widget.Button "Hold for details"',
      'the Fixture results list': 'android.widget.ScrollView "Fixture results list"',
    }[target];
    assert.ok(prefix, `Unknown fixture target: ${target}`);
    const matches = candidates.filter(c => c.desc.toLowerCase().startsWith(prefix.toLowerCase()));
    assert.equal(matches.length, 1, `Expected unique ${target}: ${JSON.stringify(candidates)}`);
    return { id: matches[0].id, probability: 1, probabilities: { [matches[0].id]: 1 }, tokens: i === 0 ? 1 : 0 };
  }),
  judge: async (state, claims) => ({ probabilities: claims.map(claim => {
    if (claim === 'The preview says Android adapter works') return state.aria.includes(`Preview: ${message}`) ? 1 : 0;
    if (claim === 'Details are visible') return state.aria.includes('Details are visible') ? 1 : 0;
    throw new Error(`Unknown fixture claim: ${claim}`);
  }), tokens: 1 }),
};
const ai = live ? intelligence : deterministic;
const { server, close } = createMobileServer(adapter, 60000, ai);
const client = new Client({ name: 'native-android-smoke', version: '1' });
const [a, b] = InMemoryTransport.createLinkedPair();
const results = [];
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  assert.ok(!r.isError, JSON.stringify(r));
  return JSON.parse(r.content[0].text);
}
async function step(raw) {
  const r = await call('step', { step: raw });
  results.push(r); console.log(`${r.status}: ${r.step}`);
  assert.equal(r.status, 'pass', JSON.stringify(r));
}
try {
  uninstall = installMobileFixture('android', device);
  console.log('Installed disposable android fixture; opening Appium session.');
  await server.connect(a); await client.connect(b);
  await call('open', { platform: 'android', device, app, capabilities: { 'appium:appActivity': '.MobileAndroidFixture' } });
  await step({ fill: { target: 'the Message text field', value: message } });
  await step({ press: 'HideKeyboard' });
  assert.ok((await call('snapshot')).aria.includes(`value="${message}"`));
  await step({ check: 'the Enable preview switch' });
  await step({ check: 'the Enable preview switch' });
  assert.match((await call('snapshot')).aria, /android.widget.Switch "Enable preview" \[checked=true\]/);
  await step({ uncheck: 'the Enable preview switch' });
  assert.match((await call('snapshot')).aria, /android.widget.Switch "Enable preview" \[checked=false\]/);
  await step({ check: 'the Enable preview switch' });
  await step({ tap: 'the Preview button' });
  assert.ok((await call('snapshot')).aria.includes(`Preview: ${message}`));
  await step({ expect: 'The preview says Android adapter works' });
  await step({ longpress: 'the Hold for details button' });
  assert.ok((await call('snapshot')).aria.includes('Details are visible'));
  await step({ expect: 'Details are visible' });
  writeFileSync(join(output, 'preview.png'), await adapter.screenshot());
  await step({ scroll: 'down: the Fixture results list' });
  await step({ swipe: 'down' });
  const specPath = join(output, 'recorded.yaml');
  await call('save', { path: specPath, name: 'Native Android preview' });
  await call('close');
  restart(); // Reset only this disposable fixture before replay.
  const replay = await runMobileSpec(loadMobileSpec(specPath), new MobileSession(new AppiumAdapter(process.env.PLAINWRIGHT_APPIUM_URL, 60000), 60000, ai));
  writeFileSync(join(output, 'report.json'), JSON.stringify({ device, liveJev: live, authoring: results, replay }, null, 2));
  assert.equal(replay.status, 'pass', JSON.stringify(replay));
  console.log(`Native Android authoring and replay passed (${live ? 'real Jev' : 'injected intelligence'}). Results: ${output}`);
} catch (error) {
  writeFileSync(join(output, 'failure.json'), JSON.stringify({ device, liveJev: live, authoring: results, error: String(error) }, null, 2));
  throw error;
} finally {
  try { await close(); await client.close(); await server.close(); }
  finally {
    try { uninstall?.(); }
    catch (error) { console.error(`Fixture cleanup failed: ${error.message}`); process.exitCode = 1; }
  }
}
