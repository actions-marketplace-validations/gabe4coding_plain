import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MobileSession, runMobileSpec } from './mobile.js';
import { loadMobileSpec, parseMobileStep, MobileTargetSchema } from './mobile-spec.js';
import type { MobileAdapter } from './mobile-adapter.js';
import type { MobileTarget } from './mobile-spec.js';
import { serialQueue, createMobileServer } from './mobile-mcp.js';
import type { Intelligence } from './automation.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

class FakeAdapter implements MobileAdapter<string> {
  log: unknown[] = []; text = 'Ready'; closed = 0;
  async open(target: MobileTarget) { this.log.push(target); return target; }
  async capture(kind: unknown, within?: string) { this.log.push(['capture', kind, within]); return {
    snapshot: { url: 'mobile://42', title: 'Fixture', aria: this.text, truncated: false },
    candidates: [{ id: 0, desc: 'button Preview' }], elements: new Map([[0, 'control']]),
  }; }
  async act(...args: unknown[]) { this.log.push(args); }
  async press(key: string) { this.log.push(['press', key]); if (key === 'Enter') throw new Error('input failed'); }
  async gesture(...args: unknown[]) { this.log.push(['gesture', ...args]); }
  async screenshot() { return Buffer.from('png'); }
  async close() { this.closed++; }
}
const ai: Intelligence = {
  pick: async (_c, targets) => targets.map((_, i) => ({ id: 0, probability: .95, probabilities: { '0': .95 }, tokens: i === 0 ? 10 : 0 })),
  judge: async (_state, claims) => ({ probabilities: claims.map(() => .95), tokens: 7 }),
  describe: async () => ({ screen: { type: 'other', probability: .99, confidence: .99 }, signals: {}, relevance: [], tokens: 100 }),
};
test('mobile schema accepts shared steps and rejects browser-only vocabulary before acting', () => {
  for (const raw of [{ goto: '/' }, { upload: { target: 'file', files: ['a'] } }, { select: { target: 'list', value: 'a' } }, { click: 'css=button' }, { scroll: 'bottom' },
    { hover: 'button' }, { rightclick: 'row' }, { mouse: { x: 1, y: 1 } }, { drag: { source: 'a', target: 'b' } },
    { swipe: 'diagonal' }, { swipe: { direction: 'left', within: 'css=panel' } }, { wait: 'css=button' }, { press: 'Control+a' }, { tap: 'x', click: 'y' }]) assert.throws(() => parseMobileStep(raw));
  for (const raw of [{ tap: 'button' }, { longpress: 'row' }, { swipe: 'left' }, { swipe: { direction: 'up', within: 'panel' } }, { press: '${hooks.key}' }]) assert.ok(parseMobileStep(raw));
  assert.equal(parseMobileStep({ scroll: 'down: the list' }).kind, 'scroll');
  assert.throws(() => MobileTargetSchema.parse({ app: 'A', pid: 1 }));
  assert.throws(() => MobileTargetSchema.parse({}));
  assert.throws(() => MobileTargetSchema.parse({ platform: 'android', device: 'serial', app: 'package', url: '/' }));
});
test('mobile acts only after accepted picks, and gestures retain their direction', async () => {
  const adapter = new FakeAdapter(); const session = new MobileSession(adapter, 100, ai);
  assert.equal((await session.step({ fill: { target: 'Message', value: 'Hello' } })).status, 'pass');
  assert.deepEqual(adapter.log.at(-1), ['fill', 'control', 'Hello']);
  await session.step({ swipe: { direction: 'left', within: 'panel' } });
  assert.deepEqual(adapter.log.at(-1), ['gesture', 'swipe', 'left', 'control']);
  assert.equal(session.calls, 2); assert.equal(session.tokens, 20);
  const reject = new MobileSession(adapter, 100, { ...ai, pick: async () => [{ id: 0, probability: .1, probabilities: {}, tokens: 1 }] });
  const before = adapter.log.length;
  assert.equal((await reject.step({ click: 'Preview' })).status, 'inconclusive');
  assert.equal(adapter.log.length, before + 1); // capture only
});
test('scoped expectations use subtree, combine claims, and fail beats inconclusive', async () => {
  const adapter = new FakeAdapter();
  const session = new MobileSession(adapter, 100, { ...ai, judge: async () => ({ probabilities: [.5, .05], tokens: 8 }) });
  const r = await session.step({ expect: { that: ['a', 'b'], within: 'panel' }, optional: true });
  assert.equal(r.status, 'fail'); assert.equal(session.tokens, 18);
  assert.deepEqual(adapter.log.at(-1), ['capture', 'region', 'control']);
});
test('optional tolerates errors but an explicit expectation failure is preserved', async () => {
  const session = new MobileSession(new FakeAdapter(), 100, ai);
  assert.equal((await session.step({ press: 'Enter', optional: true })).status, 'skipped');
  assert.equal((await session.step({ press: 'Enter' })).status, 'error');
});
test('wait avoids rejudging unchanged negative snapshots and returns inconclusive at timeout', async () => {
  const session = new MobileSession(new FakeAdapter(), 20, { ...ai, judge: async () => ({ probabilities: [0], tokens: 2 }) });
  assert.equal((await session.step({ wait: 'Ready' })).status, 'inconclusive');
  assert.equal(session.calls, 1);
});
test('mobile YAML resolves env and hooks, teardown sees failures, and detach always runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-spec-'));
  try {
    writeFileSync(join(dir, 'hooks.mjs'), `import {writeFileSync} from 'node:fs'; export const setup=()=>({key:'Enter'}); export const teardown=({result})=>writeFileSync(${JSON.stringify(join(dir, 'result.json'))},JSON.stringify(result));`);
    writeFileSync(join(dir, 'test.yaml'), 'name: test\nplatform: android\ndevice: emulator-5554\napp: Fixture\nhooks: ./hooks.mjs\nsteps:\n  - press: "${hooks.key}"\n');
    const adapter = new FakeAdapter();
    const result = await runMobileSpec(loadMobileSpec(join(dir, 'test.yaml')), new MobileSession(adapter, 100, ai));
    assert.equal(result.status, 'error'); assert.equal(adapter.closed, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')).status, 'error');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('setup failure does not attach or call teardown; teardown failure marks run error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-hooks-'));
  try {
    for (const setup of [true, false]) {
      const file = join(dir, 'hooks.mjs');
      writeFileSync(file, setup ? 'export const setup=()=>{throw Error("setup failure")}; export const teardown=()=>{throw Error("should not run")};' : 'export const teardown=()=>{throw Error("teardown failure")};');
      const adapter = new FakeAdapter();
      const r = await runMobileSpec({ name: 'test', platform: 'android', device: 'emulator-5554', app: 'Fixture', dir, hooks: file, env: {}, steps: [] }, new MobileSession(adapter, 100, ai));
      assert.equal(r.status, 'error'); assert.equal(adapter.closed, 1);
      assert.equal(r.steps.at(-1)?.step, setup ? 'setup' : 'teardown');
      if (setup) assert.equal(adapter.log.length, 0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('mobile replay resolves env target and reports close failure without losing action results', async () => {
  const adapter = new FakeAdapter();
  adapter.close = async () => { adapter.closed++; throw new Error('session deletion failed'); };
  const result = await runMobileSpec({ name: 'target interpolation', platform: 'android', device: '${env.device}', app: '${env.app}',
    capabilities: { 'appium:appActivity': '${env.activity}' }, dir: process.cwd(),
    env: { device: 'serial', app: 'com.example.fixture', activity: '.MainActivity' }, steps: [parseMobileStep({ tap: 'Preview' })],
  }, new MobileSession(adapter, 100, ai));
  assert.deepEqual(adapter.log[0], { platform: 'android', device: 'serial', app: 'com.example.fixture', capabilities: { 'appium:appActivity': '.MainActivity' } });
  assert.equal(result.status, 'error'); assert.equal(result.steps[0].status, 'pass');
  assert.equal(result.steps.at(-1)?.step, 'close'); assert.equal(adapter.closed, 1);
});
test('interpolated browser selectors are rejected before a mobile capture/action', async () => {
  const adapter = new FakeAdapter();
  const session = new MobileSession(adapter, 100, ai);
  const result = await session.run({ kind: 'tap', target: 'css=button' });
  assert.equal(result.status, 'error'); assert.equal(adapter.log.length, 0);
});
test('queue serializes operations and continues after rejection', async () => {
  const queue = serialQueue(); const log: number[] = [];
  const first = queue(async () => { await new Promise(r => setTimeout(r, 5)); log.push(1); throw new Error('failed'); });
  const second = queue(async () => { log.push(2); });
  await assert.rejects(first); await second; assert.deepEqual(log, [1, 2]);
});
test('real MCP protocol records successful placeholder steps, saves replayable YAML, and resets on open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-mcp-'));
  const adapter = new FakeAdapter();
  const discoveries: string[] = [];
  const { server, close } = createMobileServer(adapter, 100, ai, {
    listDevices: async (platform) => { discoveries.push(`devices:${platform}`); return { scope: 'local', devices: [], errors: [] }; },
    listApps: async ({ platform, device, offset }) => {
      discoveries.push(`apps:${device}`);
      return { scope: 'local', platform, device, apps: [{ app: 'Fixture' }], total: 1, offset, nextOffset: null };
    },
  });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  async function call(name: string, args: Record<string, unknown> = {}) {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, JSON.stringify(r));
    return JSON.parse((r.content as { text: string }[])[0].text);
  }
  try {
    const listed = await client.listTools(); assert.equal(listed.tools.length, 9);
    for (const name of ['list_devices', 'list_apps']) assert.equal(listed.tools.find(t => t.name === name)?.annotations?.readOnlyHint, true);
    await call('list_devices', { platform: 'android' });
    assert.equal((await call('list_apps', { platform: 'android', device: 'emulator-5554' })).apps[0].app, 'Fixture');
    assert.equal(adapter.log.length, 0); assert.equal(adapter.closed, 0);
    assert.deepEqual(discoveries, ['devices:android', 'apps:emulator-5554']);
    assert.ok((await client.callTool({ name: 'list_apps', arguments: { platform: 'android' } })).isError);
    assert.ok((await client.callTool({ name: 'step', arguments: { step: { press: 'Enter' } } })).isError);
    const hook = join(dir, 'hooks.mjs'); writeFileSync(hook, "export const setup=()=>({text:'leased value',app:'Fixture'});");
    const opened = await call('open', { platform: 'android', device: 'emulator-5554', app: '${hooks.app}', hooks: hook });
    assert.deepEqual(opened.placeholders, ['${hooks.text}', '${hooks.app}']);
    assert.equal(opened.app, 'Fixture');
    await call('step', { step: { fill: { target: 'Message', value: '${hooks.text}' } } });
    assert.deepEqual(adapter.log.at(-1), ['fill', 'control', 'leased value']);
    await call('step', { step: { press: 'Enter' } });
    await call('snapshot');
    const compact = await call('snapshot', { mode: 'compact' });
    assert.equal(compact.observed.aria, 'Ready'); assert.equal(compact.jevTokens, 0);
    const smart = await call('snapshot', { mode: 'smart', within: 'panel', intent: 'inspect the controls' });
    assert.equal(smart.inferred.screen.type, 'other'); assert.equal(smart.jevTokens, 110);
    assert.ok(smart.ms.total >= smart.ms.jev);
    await call('list_devices');
    await call('list_apps', { platform: 'android', device: 'emulator-5554' });
    const path = join(dir, 'saved.yaml'); await call('save', { path });
    assert.match(readFileSync(path, 'utf8'), /\$\{hooks.text\}/);
    const spec = loadMobileSpec(path); assert.equal(spec.app, '${hooks.app}'); assert.equal(spec.steps.length, 1); assert.equal(spec.hooks, hook);
    const replay = new FakeAdapter();
    const replayResult = await runMobileSpec(spec, new MobileSession(replay, 100, ai));
    assert.equal(replayResult.status, 'pass');
    assert.equal((replay.log[0] as MobileTarget).app, 'Fixture');
    assert.deepEqual(replay.log.at(-1), ['fill', 'control', 'leased value']);
    await call('open', { platform: 'ios', device: 'ios-udid', app: 'Fixture' });
    assert.ok((await client.callTool({ name: 'save', arguments: { path } })).isError);
    await call('close');
    assert.ok((await client.callTool({ name: 'snapshot', arguments: {} })).isError);
  } finally { await close(); await client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
