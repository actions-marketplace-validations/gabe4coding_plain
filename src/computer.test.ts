import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerSession, runComputerSpec } from './computer.js';
import type { RunObserver } from './suite-types.js';
import { loadComputerSpec, parseComputerStep, ComputerTargetSchema } from './computer-spec.js';
import { matchesKind, captureTree, type ComputerAdapter } from './computer-adapter.js';
import { createComputerServer } from './computer-mcp.js';
import { serialQueue } from './serial-queue.js';
import type { Intelligence } from './automation.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

class FakeAdapter implements ComputerAdapter<string> {
  log: unknown[] = []; text = 'Ready'; closed = 0;
  async apps() { return [{ name: 'Fixture', pid: 42 }]; }
  async open(target: unknown) { this.log.push(target); return { name: 'Fixture', pid: 42 }; }
  async capture(kind: unknown, within?: string) { this.log.push(['capture', kind, within]); return {
    snapshot: { url: 'desktop://42', title: 'Fixture', aria: this.text, truncated: false },
    candidates: [{ id: 0, desc: 'button Preview' }], elements: new Map([[0, 'control']]),
  }; }
  async act(...args: unknown[]) { this.log.push(args); }
  async press(key: string) { this.log.push(['press', key]); if (key === 'bad') throw new Error('input failed'); }
  async mouse(x: number, y: number) { this.log.push(['mouse', x, y]); }
  async drag(...args: unknown[]) { this.log.push(['drag', ...args]); }
  async screenshot() { return Buffer.from('png'); }
  async close() { this.closed++; }
}
const ai: Intelligence = {
  pick: async (_c, targets) => targets.map((_, i) => ({ id: 0, probability: .95, probabilities: { '0': .95 }, tokens: i === 0 ? 10 : 0 })),
  judge: async (_state, claims) => ({ probabilities: claims.map(() => .95), tokens: 7 }),
  describe: async () => ({ screen: { type: 'other', probability: .99, confidence: .99 }, signals: {}, relevance: [], tokens: 100 }),
};
test('desktop schema accepts shared steps and rejects browser-only vocabulary before acting', () => {
  for (const raw of [{ goto: '/' }, { upload: { target: 'file', files: ['a'] } }, { select: { target: 'list', value: 'a' } }, { click: 'css=button' }, { scroll: 'bottom' }]) assert.throws(() => parseComputerStep(raw));
  assert.equal(parseComputerStep({ scroll: 'down: the list' }).kind, 'scroll');
  assert.throws(() => ComputerTargetSchema.parse({ app: 'A', pid: 1 }));
  assert.throws(() => ComputerTargetSchema.parse({}));
});
test('desktop filters respect editable, disabled, hidden and checked controls', () => {
  const el = { visible: true, enabled: true, editable: true, checked: null, actions: [], focusable: true, role: 'text_field' };
  assert.equal(matchesKind(el, 'fill'), true);
  assert.equal(matchesKind({ ...el, enabled: false }, 'fill'), false);
  assert.equal(matchesKind({ ...el, visible: false }, 'click'), false);
  assert.equal(matchesKind({ ...el, checked: 'on' }, 'check'), true);
});
test('desktop acts only after accepted picks, and a drag shares one model call', async () => {
  const adapter = new FakeAdapter(); const session = new ComputerSession(adapter, 100, ai);
  assert.equal((await session.step({ fill: { target: 'Message', value: 'Hello' } })).status, 'pass');
  assert.deepEqual(adapter.log.at(-1), ['fill', 'control', 'Hello']);
  await session.step({ drag: { source: 'source', target: 'dest' } });
  assert.equal(session.calls, 2); assert.equal(session.tokens, 20);
  const reject = new ComputerSession(adapter, 100, { ...ai, pick: async () => [{ id: 0, probability: .1, probabilities: {}, tokens: 1 }] });
  const before = adapter.log.length;
  assert.equal((await reject.step({ click: 'Preview' })).status, 'inconclusive');
  assert.equal(adapter.log.length, before + 1); // capture only
});
test('scoped expectations use subtree, combine claims, and fail beats inconclusive', async () => {
  const adapter = new FakeAdapter();
  const session = new ComputerSession(adapter, 100, { ...ai, judge: async () => ({ probabilities: [.5, .05], tokens: 8 }) });
  const r = await session.step({ expect: { that: ['a', 'b'], within: 'panel' }, optional: true });
  assert.equal(r.status, 'fail'); assert.equal(session.tokens, 18);
  assert.deepEqual(adapter.log.at(-1), ['capture', 'region', 'control']);
});
test('optional tolerates errors but an explicit expectation failure is preserved', async () => {
  const session = new ComputerSession(new FakeAdapter(), 100, ai);
  assert.equal((await session.step({ press: 'bad', optional: true })).status, 'skipped');
  assert.equal((await session.step({ press: 'bad' })).status, 'error');
});
test('wait avoids rejudging unchanged negative snapshots and returns inconclusive at timeout', async () => {
  const session = new ComputerSession(new FakeAdapter(), 20, { ...ai, judge: async () => ({ probabilities: [0], tokens: 2 }) });
  assert.equal((await session.step({ wait: 'Ready' })).status, 'inconclusive');
  assert.equal(session.calls, 1);
});
test('desktop YAML resolves env and hooks, teardown sees failures, and detach always runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'computer-spec-'));
  try {
    writeFileSync(join(dir, 'hooks.mjs'), `import {writeFileSync} from 'node:fs'; export const setup=()=>({key:'bad'}); export const teardown=({result})=>writeFileSync(${JSON.stringify(join(dir, 'result.json'))},JSON.stringify(result));`);
    writeFileSync(join(dir, 'test.yaml'), 'name: test\napp: Fixture\nhooks: ./hooks.mjs\nsteps:\n  - press: "${hooks.key}"\n');
    const adapter = new FakeAdapter();
    const result = await runComputerSpec(loadComputerSpec(join(dir, 'test.yaml')), new ComputerSession(adapter, 100, ai));
    assert.equal(result.status, 'error'); assert.equal(adapter.closed, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')).status, 'error');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('setup failure does not attach or call teardown; teardown failure marks run error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'computer-hooks-'));
  try {
    for (const setup of [true, false]) {
      const file = join(dir, 'hooks.mjs');
      writeFileSync(file, setup ? 'export const setup=()=>{throw Error("setup failure")}; export const teardown=()=>{throw Error("should not run")};' : 'export const teardown=()=>{throw Error("teardown failure")};');
      const adapter = new FakeAdapter();
      const r = await runComputerSpec({ name: 'test', app: 'Fixture', dir, hooks: file, env: {}, steps: [] }, new ComputerSession(adapter, 100, ai));
      assert.equal(r.status, 'error'); assert.equal(adapter.closed, 1);
      assert.equal(r.steps.at(-1)?.step, setup ? 'setup' : 'teardown');
      if (setup) assert.equal(adapter.log.length, 0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('sessionOpen fires before the adapter opens and the screenshot is taken on sessionClose', async () => {
  class RecordingAdapter extends FakeAdapter {
    events: string[] = [];
    async open(target: unknown) { this.events.push('open'); return super.open(target); }
    async screenshot() { this.events.push('screenshot'); return super.screenshot(); }
    async close() { this.events.push('close'); return super.close(); }
  }
  const adapter = new RecordingAdapter();
  const dir = mkdtempSync(join(tmpdir(), 'native-observer-'));
  const shot = join(dir, 'shots', 'screen.png');
  const observer: RunObserver = {
    async sessionOpen() { assert.deepEqual(adapter.events, []); },
    async sessionClose({ target }) {
      assert.deepEqual(adapter.events, ['open']);
      await target.screenshot(shot);
      assert.deepEqual(adapter.events, ['open', 'screenshot']);
      return [{ kind: 'screenshot', path: shot }];
    },
  };
  try {
    const result = await runComputerSpec({ name: 'observer', app: 'Fixture', dir, env: {}, steps: [] },
      new ComputerSession(adapter, 100), observer, { file: 'observer.yaml', name: 'observer', tags: [], attempt: 0 });
    assert.equal(result.status, 'pass');
    assert.deepEqual(adapter.events, ['open', 'screenshot', 'close']);
    assert.equal(readFileSync(shot).toString(), 'png');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('queue serializes operations and continues after rejection', async () => {
  const queue = serialQueue(); const log: number[] = [];
  const first = queue(async () => { await new Promise(r => setTimeout(r, 5)); log.push(1); throw new Error('failed'); });
  const second = queue(async () => { log.push(2); });
  await assert.rejects(first); await second; assert.deepEqual(log, [1, 2]);
});
test('real MCP protocol records successful placeholder steps, saves replayable YAML, and resets on open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'computer-mcp-'));
  const adapter = new FakeAdapter();
  const { server, close } = createComputerServer(adapter, 100, ai);
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  async function call(name: string, args: Record<string, unknown> = {}) {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.ok(r.structuredContent, `${name} must return structuredContent`);
    assert.deepEqual(r.structuredContent, JSON.parse((r.content as { text: string }[])[0].text));
    return r.structuredContent as Record<string, any>;
  }
  try {
    const listed = await client.listTools(); assert.equal(listed.tools.length, 10);
    for (const apps of [[{ name: 'Fixture', pid: 42 }], []]) {
      adapter.apps = async () => apps;
      const result = await client.callTool({ name: 'apps', arguments: {} });
      assert.ok(!result.isError);
      assert.deepEqual(result.structuredContent, { apps });
      assert.deepEqual(JSON.parse((result.content as { text: string }[])[0].text), apps);
    }
    const error = await client.callTool({ name: 'step', arguments: { step: { press: 'Enter' } } });
    assert.equal(error.isError, true);
    assert.equal(error.structuredContent, undefined);
    assert.match((error.content as { text: string }[])[0].text, /call open first/);
    const hook = join(dir, 'hooks.mjs'); writeFileSync(hook, "export const setup=()=>({text:'leased value'});");
    const opened = await call('open', { pid: 42, hooks: hook });
    assert.deepEqual(opened.placeholders, ['${hooks.text}']);
    const screenshot = await client.callTool({ name: 'screenshot', arguments: {} });
    assert.ok(!screenshot.isError);
    assert.equal(screenshot.structuredContent, undefined);
    assert.deepEqual(screenshot.content, [{ type: 'image', mimeType: 'image/png', data: Buffer.from('png').toString('base64') }]);
    assert.equal((await call('find', { kind: 'click', target: 'Preview' })).found, true);
    await call('step', { step: { fill: { target: 'Message', value: '${hooks.text}' } } });
    assert.deepEqual(adapter.log.filter((e) => !(Array.isArray(e) && e[0] === 'capture')).at(-1), ['fill', 'control', 'leased value']);
    await call('step', { step: { press: 'bad' } });
    await call('snapshot');
    const compact = await call('snapshot', { mode: 'compact' });
    assert.equal(compact.observed.aria, 'Ready'); assert.equal(compact.jevTokens, 0);
    const smart = await call('snapshot', { mode: 'smart', within: 'panel', intent: 'inspect the controls' });
    assert.equal(smart.inferred.screen.type, 'other'); assert.equal(smart.jevTokens, 110);
    assert.ok(smart.ms.total >= smart.ms.jev);
    const path = join(dir, 'saved.yaml'); await call('save', { path });
    assert.match(readFileSync(path, 'utf8'), /\$\{hooks.text\}/);
    const spec = loadComputerSpec(path); assert.equal(spec.app, 'Fixture'); assert.equal(spec.steps.length, 1); assert.equal(spec.hooks, hook);
    await call('open', { app: 'Fixture', activate: false });
    assert.ok((await client.callTool({ name: 'save', arguments: { path } })).isError);
    await call('close');
    assert.ok((await client.callTool({ name: 'snapshot', arguments: {} })).isError);
  } finally { await close(); await client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('a window that appears after the previous step is waited for, not reported as no candidates', async () => {
  class LateWindow extends FakeAdapter {
    empty = 2;
    async capture(kind: unknown, within?: string) {
      const frame = await super.capture(kind, within);
      return this.empty-- > 0 ? { ...frame, candidates: [], elements: new Map() } : frame;
    }
  }
  const adapter = new LateWindow();
  const result = await new ComputerSession(adapter, 1000, ai).step({ click: 'Preview' });
  assert.equal(result.status, 'pass');
  assert.equal(adapter.log.filter((e) => Array.isArray(e) && e[0] === 'capture').length, 3);
  assert.ok((result.ms?.idle ?? 0) >= 250);
});

const node = (role: string, name: string | null, value: string | null, children: unknown[] = [], actions = ['press']) => ({
  role, name, value, visible: true, enabled: true, editable: false, checked: null, selected: false, focused: false,
  actions, focusable: false, modal: false, children: async () => children,
});

test('captureTree: a label inside a control is not a second candidate; an unnamed control takes its inner text', async () => {
  const tree = node('web_area', 'Slack', null, [
    node('tab', 'Files & links', '0', [node('static_text', '', 'Files & links')]),
    node('button', '', '', [node('group', null, null, [node('static_text', '', 'Activity')], [])]),
    node('tab', '', '0', [node('group', null, null, [node('static_text', '', 'DMs')])]), // a pressable group inside: a part, not a candidate
    node('row', 'Report', null, [node('button', 'Edit', null)]),
    node('static_text', '', 'Standalone label'),
  ], []);
  const { candidates, web } = await captureTree(tree as never, 'click', 1000);
  assert.equal(web.size, candidates.length); // all inside the web_area: pointer clicks
  assert.deepEqual(candidates.map((c) => c.desc), [
    'tab "Files & links" value="0" in web_area "Slack"',
    'button "" value="" text="Activity" in web_area "Slack"',
    'tab "" value="0" text="DMs" in web_area "Slack"',
    'row "Report" in web_area "Slack"',
    'button "Edit" in row "Report"',
    'static_text "" value="Standalone label" in web_area "Slack"',
  ]);
});

test('captureTree: a row is one candidate named by its cells; one window and the app are not repeated as context', async () => {
  const cell = (text: string) => node('table_cell', '', null, [node('static_text', '', text, [], [])], ['focus']);
  const tree = node('application', 'Fork', null, [node('window', 'plainwright', null, [
    node('table_row', '', null, [cell('Fix the parser'), cell('Ann'), cell('813f225'), cell('Today at 22:55')], []),
    node('text_area', '', 'x'.repeat(500), [], ['set_value']),
    node('list', 'Folders', null, [node('button', 'Notes', null)]),
  ], [])], []);
  const { candidates, snapshot } = await captureTree(tree as never, 'click', 1000);
  assert.deepEqual(candidates.map((c) => c.desc), [
    'table_row "" text="Fix the parser Ann 813f225 Today at 22:55"',
    `text_area "" value="${'x'.repeat(100)}…"`,
    'list "Folders"',
    'button "Notes" in list "Folders"',
  ]);
  assert.ok(snapshot.aria.includes('x'.repeat(500))); // the snapshot keeps the whole value
});
