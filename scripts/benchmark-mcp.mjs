#!/usr/bin/env node
// Agent-mode latency benchmark: drives the MCP server the way an agent does — one tool call at a
// time with think time between calls — and reports how long each tool call takes. The sum is what
// the agent waits on the browser tool; think time is excluded.
//
//   node scripts/benchmark-mcp.mjs [--cli dist/cli.js] [--gap 5000] [--runs 2] [--out result.json]
//
// --gap is the pause between tool calls (an agent's model turn). It matters: an idle HTTP connection
// to the Jev API can be dropped between calls. Uses the-internet.herokuapp.com, like the examples.
// Needs a Jev key and a build (npm run build).
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const { values } = parseArgs({
  options: { cli: { type: 'string', default: 'dist/cli.js' }, gap: { type: 'string', default: '5000' }, runs: { type: 'string', default: '2' }, out: { type: 'string' } },
});
const gap = Number(values.gap);
const site = 'https://the-internet.herokuapp.com';

// A login flow, a form flow and a read: the tool calls an agent makes for them, in order.
const SESSION = [
  ['open', { url: `${site}/login` }],
  ['step', { step: { fill: { target: 'the username field', value: 'tomsmith' } } }],
  ['step', { step: { fill: { target: 'the password field', value: 'SuperSecretPassword!' } } }],
  ['step', { step: { click: 'the login button' } }],
  ['step', { step: { expect: 'the user is logged in and sees a success message' } }],
  ['open', { url: `${site}/checkboxes` }],
  ['step', { step: { check: 'the first checkbox, not the second' } }],
  ['step', { step: { expect: 'the first checkbox is checked' } }],
  ['open', { url: `${site}/dropdown` }],
  ['find', { kind: 'select', target: 'the dropdown list' }],
  ['step', { step: { select: { target: 'the dropdown list', value: 'Option 2' } } }],
  ['step', { step: { expect: "the dropdown's selected option is Option 2" } }],
  ['open', { url: `${site}/tables` }],
  ['snapshot', { within: 'the first table' }],
];

async function session() {
  const transport = new StdioClientTransport({ command: 'node', args: [values.cli, '--headless', 'mcp'], stderr: 'ignore' });
  const client = new Client({ name: 'benchmark', version: '1.0.0' });
  await client.connect(transport);
  const calls = [];
  for (const [name, args] of SESSION) {
    const start = performance.now();
    const res = await client.callTool({ name, arguments: args });
    const ms = Math.round(performance.now() - start);
    const text = res.content?.[0]?.text ?? '';
    const status = res.isError ? 'error' : (/"status":\s*"(\w+)"/.exec(text)?.[1] ?? 'ok');
    calls.push({ name, ms, status });
    if (gap) await new Promise((r) => setTimeout(r, gap));
  }
  await client.close();
  return calls;
}

const runs = [];
for (let i = 0; i < Number(values.runs); i++) {
  const calls = await session();
  const total = calls.reduce((s, c) => s + c.ms, 0);
  const bad = calls.filter((c) => !['ok', 'pass'].includes(c.status));
  runs.push({ total, calls });
  console.error(`run ${i + 1}: tool time ${total} ms over ${calls.length} calls${bad.length ? `, not passing: ${bad.map((c) => `${c.name}=${c.status}`).join(' ')}` : ''}`);
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const perCall = SESSION.map(([name], i) => ({ name, ms: median(runs.map((r) => r.calls[i].ms)) }));
const summary = { cli: values.cli, gap, total: median(runs.map((r) => r.total)), perCall, raw: runs };
console.log(JSON.stringify({ cli: summary.cli, gap, total: summary.total, perCall: perCall.map((c) => `${c.name}:${c.ms}`).join(' ') }));
if (values.out) writeFileSync(values.out, JSON.stringify(summary, null, 2));
