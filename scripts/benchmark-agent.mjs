#!/usr/bin/env node
// Agent benchmark: a real `claude -p` agent does six public browsing tasks through this repo's MCP server,
// with `changed` in step/batch results off (PLAINWRIGHT_CHANGES=0) and on. Reports tool calls, agent tokens,
// cost and time per task, and each final answer (check them by eye). Costs Claude usage.
//
//   node scripts/benchmark-agent.mjs [--runs 1] [--model sonnet] [--only <task>] [--changed both|on|off]
//                                    [--cli <path to cli.js or a plugin's bin/launch.mjs>] [--out result.json]
// --cli compares another build (an installed plugin version) on the same tasks.
//
// Needs the `claude` CLI and a Jev key. Build first (npm run build).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const { values } = parseArgs({ options: { runs: { type: 'string', default: '1' }, model: { type: 'string', default: 'sonnet' }, only: { type: 'string' }, out: { type: 'string' }, changed: { type: 'string', default: 'both' }, cli: { type: 'string' } } });
const CLI = values.cli ?? fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const modes = values.changed === 'both' ? [false, true] : [values.changed === 'on'];
const SKILL = new URL('../plugins/plainwright/skills/using-plainwright/', import.meta.url);
const TASKS = {
  hn: 'Open https://news.ycombinator.com, click the "new" link in the top bar, and tell me the title of the first story on that page.',
  wiki: 'Open https://en.wikipedia.org, search for Alan Turing using the search box, open his article, and tell me his date of birth.',
  gh: 'Open https://github.com/microsoft/playwright, click the Issues tab, and tell me the title of the first issue in the list.',
  login: 'Open https://the-internet.herokuapp.com/login, log in with username tomsmith and password SuperSecretPassword!, tell me the message shown after login, then log out and tell me the message shown.',
  ol: 'Open https://openlibrary.org, search for "the left hand of darkness" with the site search, and tell me the author and first published year of the first result.',
  yahoo: 'Open https://finance.yahoo.com/quote/AAPL/, accept the cookies, open the Statistics tab and tell me the trailing P/E.',
  todo: 'Open https://demo.playwright.dev/todomvc, add three todos: milk, eggs, bread. Mark eggs as completed. Tell me how many items are left.',
};
// yahoo is the console-noise task (an ad-heavy page): run it with --only yahoo.
const tasks = Object.keys(TASKS).filter((t) => values.only ? t === values.only : t !== 'yahoo');
const dir = mkdtempSync(join(tmpdir(), 'plainwright-agent-bench-'));
// The skill as the agent gets it from the plugin: SKILL.md without front matter, then the browsing mode.
const skill = readFileSync(new URL('SKILL.md', SKILL), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '') + '\n' + readFileSync(new URL('browsing.md', SKILL), 'utf8');
writeFileSync(join(dir, 'skill.md'), skill);
for (const on of [false, true]) writeFileSync(join(dir, `mcp-${on}.json`), JSON.stringify({ mcpServers: { pw: { command: process.execPath, args: [CLI, '--headless', 'mcp'], env: { PLAINWRIGHT_CHANGES: on ? '1' : '0' } } } }));

function run(task, on) {
  return new Promise((resolve) => {
    const args = ['-p', `${TASKS[task]} End with a one-line answer.`, '--model', values.model, '--output-format', 'stream-json', '--verbose',
      '--strict-mcp-config', '--mcp-config', join(dir, `mcp-${on}.json`), '--tools', '', '--allowedTools', 'mcp__pw__*',
      '--setting-sources', '', '--append-system-prompt-file', join(dir, 'skill.md'), '--max-budget-usd', '2'];
    const p = spawn('claude', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => {
      const calls = {}; let result = null, answer = '';
      for (const line of out.split('\n')) {
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.type === 'assistant') for (const c of m.message.content ?? []) {
          if (c.type === 'tool_use') { const n = c.name.replace('mcp__pw__', ''); calls[n] = (calls[n] ?? 0) + 1; }
          if (c.type === 'text') answer = c.text;
        }
        if (m.type === 'result') result = m;
      }
      const u = result?.usage ?? {};
      resolve({ task, changed: on, calls, toolCalls: Object.values(calls).reduce((a, b) => a + b, 0),
        tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0),
        output: u.output_tokens ?? 0, cost: result?.total_cost_usd ?? 0, ms: result?.duration_ms ?? 0,
        answer: answer.split('\n').filter(Boolean).at(-1) ?? '', ok: result !== null });
    });
  });
}

const jobs = [];
for (let r = 0; r < Number(values.runs); r++) for (const t of tasks) for (const on of modes) jobs.push([t, on]);
const results = [];
let next = 0;
await Promise.all(Array.from({ length: 3 }, async () => { while (next < jobs.length) { const [t, on] = jobs[next++]; results.push(await run(t, on)); } }));

const rows = {};
for (const r of results.filter((x) => x.ok)) for (const key of [`${r.task} ${r.changed ? 'on' : 'off'}`, `ALL ${r.changed ? 'on' : 'off'}`]) {
  const x = (rows[key] ??= { n: 0, calls: 0, tokens: 0, output: 0, cost: 0, ms: 0 });
  x.n++; x.calls += r.toolCalls; x.tokens += r.tokens; x.output += r.output; x.cost += r.cost; x.ms += r.ms;
}
console.log('task  changed  n  calls  tokens  output   cost    time');
for (const [k, x] of Object.entries(rows).sort()) {
  const [task, on] = k.split(' ');
  console.log(`${task.padEnd(6)}${on.padEnd(8)}${String(x.n).padStart(2)} ${(x.calls / x.n).toFixed(1).padStart(6)} ${String(Math.round(x.tokens / x.n)).padStart(7)} ${String(Math.round(x.output / x.n)).padStart(7)} ${('$' + (x.cost / x.n).toFixed(3)).padStart(7)} ${((x.ms / x.n / 1000).toFixed(0) + 's').padStart(6)}`);
}
console.log('\nAnswers:');
for (const r of results) console.log(`  ${r.task.padEnd(6)}${r.changed ? 'on ' : 'off'} ${r.ok ? r.answer.slice(0, 120) : 'NO RESULT'}`);
if (values.out) writeFileSync(values.out, JSON.stringify(results, null, 1));
