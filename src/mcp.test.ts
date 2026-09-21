import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Drives the real server over stdio, as a plugin host does. CSS targets avoid paid model calls.
let client: Client;
const scratch = mkdtempSync(join(tmpdir(), 'plainwright-mcp-test-'));
before(async () => {
  client = new Client({ name: 'plainwright-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./cli.js', import.meta.url)), '--headless', '--timeout', '500', 'mcp'] }));
});
after(async () => { await client.close(); rmSync(scratch, { recursive: true, force: true }); });

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  assert.ok(!res.isError, res.content[0]?.text);
  return JSON.parse(res.content[0].text);
}

const PAGE =
  'data:text/html,' +
  encodeURIComponent(
    `<!doctype html><html><head><meta charset="utf-8"></head><body><main><table><tr><td>Hotel Roma</td><td>€120</td></tr></table></main><footer><a href="/x">Footer link</a></footer></body></html>`
  );

test('snapshot within a css= region returns only that subtree', async () => {
  await call('open', { url: PAGE });
  const snap = await call('snapshot', { within: 'css=main' });
  assert.match(snap.aria as string, /Hotel Roma/);
  assert.doesNotMatch(snap.aria as string, /Footer link/);
  assert.match(snap.region as string, /css=main/);
});

test('evaluate returns the JSON value of a page expression', async () => {
  const r = await call('evaluate', { js: '[...document.querySelectorAll("td")].map(td => td.innerText)' });
  assert.deepEqual(r.value, ['Hotel Roma', '€120']);
  const listed = await client.listTools();
  assert.ok(listed.tools.some((t) => t.name === 'evaluate'));
});

test('compact browser snapshots preserve scoped data without Jev and expose coverage', async () => {
  const r = await call('snapshot', { mode: 'compact', within: 'css=main', maxChars: 500 });
  assert.equal(r.mode, 'compact');
  assert.match((r.observed as { aria: string }).aria, /Hotel Roma/);
  assert.doesNotMatch((r.observed as { aria: string }).aria, /Footer link/);
  assert.equal(r.jevTokens, 0);
  assert.equal((r.coverage as { sourceTruncated: boolean }).sourceTruncated, false);
  assert.ok((r.ms as { total: number }).total >= 0);
});

const html = (body: string) => 'data:text/html,' + encodeURIComponent(`<!doctype html><body>${body}</body>`);

test('batch preflights all steps and placeholders before any action; enforces bounds', async () => {
  await call('open', { url: html('<input id="name">') });
  const first = { fill: { target: 'css=#name', value: 'must not happen' } };
  for (const steps of [[], Array(17).fill(first), [first, { unknown: 'action' }], [first, { fill: { target: 'css=#name', value: '${hooks.missing}' } }]]) {
    const r = await client.callTool({ name: 'batch', arguments: { steps } });
    assert.equal(r.isError, true);
    assert.equal((await call('evaluate', { js: 'document.querySelector("input").value' })).value, '');
  }
});

test('batch resolves each action after DOM replacement, serializes concurrent reads and saves flat hook placeholders', async () => {
  const hooks = join(scratch, 'hooks.mjs');
  writeFileSync(hooks, 'export function setup() { return { name: "Ada" }; }');
  await call('open', { hooks, url: html(`<button onclick="setTimeout(()=>document.querySelector('main').innerHTML='<input id=name>',50)">Next</button><main></main>`) });
  const steps = [{ click: 'css=button' }, { fill: { target: 'css=#name', value: '${hooks.name}' } }];
  const [result, read] = await Promise.all([
    call('batch', { steps }),
    call('evaluate', { js: 'document.querySelector("input")?.value ?? null' }),
  ]);
  assert.equal(result.status, 'pass');
  assert.equal(result.completed, 2);
  assert.equal(result.remaining, 0);
  assert.equal(result.stoppedAt, null);
  assert.equal(result.jevTokens, 0);
  assert.deepEqual((result.results as { index: number }[]).map(r => r.index), [0, 1]);
  assert.equal(read.value, 'Ada');
  const path = join(scratch, 'batch.yaml');
  await call('save', { path });
  const saved = parse(readFileSync(path, 'utf8'));
  assert.deepEqual(saved.steps.slice(-2), steps);
  assert.equal(saved.hooks, './hooks.mjs');
});

test('batch stops at a failed action, retains prior effects and records only the passing prefix', async () => {
  await call('open', { url: html('<input id="name"><button disabled>Unavailable</button>') });
  const path = join(scratch, 'partial.yaml');
  const before = await call('save', { path });
  const first = { fill: { target: 'css=#name', value: 'kept' } };
  const result = await call('batch', { steps: [first, { click: 'css=button' }, { fill: { target: 'css=#name', value: 'must not happen' } }] });
  assert.equal(result.status, 'error');
  assert.equal(result.completed, 1);
  assert.equal(result.stoppedAt, 1);
  assert.equal(result.remaining, 1);
  assert.equal((result.results as unknown[]).length, 2);
  assert.equal((await call('evaluate', { js: 'document.querySelector("input").value' })).value, 'kept');
  const after = await call('save', { path });
  assert.equal(after.steps, (before.steps as number) + 1);
  assert.deepEqual(parse(readFileSync(path, 'utf8')).steps.at(-1), first);
  // A rejected batch must not poison the session queue.
  assert.equal((await call('step', { step: { fill: { target: 'css=#name', value: 'recovered' } } })).status, 'pass');
});

test('batch stops on an optional skipped target instead of silently running dependent steps', async () => {
  // No actionable candidates: the natural-language resolver returns inconclusive without Jev.
  await call('open', { url: html('<p>Before</p>') });
  assert.equal((await call('step', { step: { click: 'the missing button', optional: true } })).status, 'skipped');
  const result = await call('batch', { steps: [{ click: 'the missing button', optional: true }, { goto: 'about:blank' }] });
  assert.equal(result.status, 'skipped');
  assert.equal(result.stoppedAt, 0);
  assert.equal(result.completed, 0);
  assert.equal(result.remaining, 1);
  assert.equal((await call('evaluate', { js: 'document.querySelector("p").textContent' })).value, 'Before');
});
