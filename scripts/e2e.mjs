#!/usr/bin/env node
// Live end-to-end gate: the real CLI and the real MCP server, with real Jev picks and judgments, against the local
// site in e2e/site.mjs (no remote site, so a failure is plainwright's or Jev's, never the network's).
//
// 1. Specs: runs e2e/*.yaml in one suite run and checks each final status. A spec tagged `expect-fail` must end
//    `fail` (a pass there is a false pass); every other spec must pass. A pass on a retry counts, and is listed.
// 2. Agent path: an MCP session opens the login page, logs in with one `batch`, checks the result with `ask` and
//    `read`, saves the flow, and the saved spec must pass when the CLI runs it.
//
//   node scripts/e2e.mjs [--retries 1] [--only <substring of a spec file>] [--skip-mcp]
//
// Needs a Jev key and a build (npm run build). Exit 1 when any check fails.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startSite, USER } from '../e2e/site.mjs';

const { values } = parseArgs({ options: {
  retries: { type: 'string', default: '1' },
  only: { type: 'string' },
  'skip-mcp': { type: 'boolean', default: false },
} });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist/cli.js');
const scratch = mkdtempSync(join(tmpdir(), 'plainwright-e2e-'));
const problems = [];
const notes = [];

const site = await startSite();
const env = { ...process.env, PLAINWRIGHT_E2E_SITE: site.url };
// Async on purpose: the site is served from this process, so a sync child would block every request it makes.
// --picks off: every pick goes to Jev (a cached pick would test the cache, not Jev), and no sidecar is written.
const runCli = (args) => new Promise((done, fail) => spawn(process.execPath, [cli, '--headless', '--picks', 'off', ...args], { cwd: root, env, stdio: 'inherit' })
  .on('error', fail).on('exit', (code) => done(code)));

try {
  await checkSpecs();
  if (!values['skip-mcp']) await checkAgentPath(Number(values.retries) + 1);
} finally {
  await site.close();
  rmSync(scratch, { recursive: true, force: true });
}

for (const note of notes) console.log(`note: ${note}`);
if (problems.length) {
  console.error(`\nE2E FAILED:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('\nE2E passed.');

async function checkSpecs() {
  const files = readdirSync(join(root, 'e2e')).filter((n) => n.endsWith('.yaml'))
    .filter((n) => !values.only || n.includes(values.only)).map((n) => join('e2e', n));
  if (!files.length) return void problems.push(`no e2e spec matches --only ${values.only}`);
  const reportFile = join(scratch, 'report.json');
  // The exit code is not the verdict: the expect-fail spec fails on purpose. The report is.
  await runCli(['--retries', values.retries, '--reporter', 'text', '--reporter', `json:${reportFile}`, ...files]);
  let report;
  try { report = JSON.parse(readFileSync(reportFile, 'utf8')); } catch { return void problems.push('the suite run wrote no JSON report'); }
  for (const spec of report.specs) {
    const expected = spec.tags.includes('expect-fail') ? 'fail' : 'pass';
    const error = spec.loadError ?? spec.attempts.at(-1)?.error;
    if (spec.status !== expected || (expected === 'fail' && spec.flaky)) {
      problems.push(`${spec.file}: expected ${expected}, got ${spec.flaky ? 'pass on a retry' : spec.status}${error ? ` (${error})` : ''}`);
    } else if (spec.flaky) {
      notes.push(`${spec.file} passed only on a retry (flaky): look at its first attempt`);
    }
  }
  console.log(`specs: ${report.specs.length}, jev calls ${report.totals.jevCalls}, tokens ${report.totals.tokens}`);
}

async function checkAgentPath(attempts) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const failure = await agentSession(join(scratch, `recorded-${attempt}.yaml`)).catch((error) => String(error));
    if (!failure) {
      if (attempt > 1) notes.push('the MCP session passed only on a retry (flaky)');
      return;
    }
    console.error(`MCP session attempt ${attempt} failed: ${failure}`);
    if (attempt === attempts) problems.push(`MCP session: ${failure}`);
  }
}

/** One agent-style session; resolves to undefined when every check holds, else to what went wrong. */
async function agentSession(saved) {
  const client = new Client({ name: 'plainwright-e2e', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, '--headless', 'mcp'], env, stderr: 'inherit' }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`${name} returned an error: ${result.content[0]?.text}`);
    return result.structuredContent;
  };
  try {
    await call('open', { url: `${site.url}/login`, goal: 'log in as the test user' });
    const batch = await call('batch', { steps: [
      { fill: { target: 'the Username field', value: USER.name } },
      { fill: { target: 'the Password field', value: USER.pass } },
      { click: 'the Login button' },
    ] });
    if (batch.status !== 'pass') return `batch ended ${batch.status} at step ${batch.stoppedAt}: ${JSON.stringify(batch.results.at(-1))}`;
    const asked = await call('ask', { claims: ['the Secure Area heading is shown', 'the login form is shown'] });
    const answers = asked.answers.map((a) => a.answer).join(',');
    if (answers !== 'yes,no') return `ask answered ${answers}, expected yes,no: ${JSON.stringify(asked.answers)}`;
    const read = await call('read', { question: 'What does the status message say?' });
    if (!/logged into a secure area/i.test(JSON.stringify(read))) return `read did not return the status message: ${JSON.stringify(read)}`;
    await call('save', { path: saved, name: 'recorded login' });
  } finally {
    await client.close();
  }
  const code = await runCli(['--reporter', 'text', saved]);
  return code === 0 ? undefined : `the saved spec did not pass on replay (exit ${code})`;
}
