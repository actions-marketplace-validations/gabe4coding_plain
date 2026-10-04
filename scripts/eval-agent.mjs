#!/usr/bin/env node
// Agent eval: real `claude -p` and `codex exec` agents do tasks on the local e2e site (e2e/site.mjs) through this
// checkout's browser MCP server, with this checkout's plugin skill. Each run is graded, not read by eye:
//   - the answer:   the final message must contain what the page shows (or, for `refused`, must not claim a login);
//   - the tools:    the page is reached only through this checkout's plainwright (a shell may run its CLI, never
//                   curl the page), no tool call failed or named a missing tool, and the plainwright call count
//                   stays inside the task's budget;
//   - the artifact: for `record`, the spec the agent saved must pass when the CLI runs it.
// Local only (it costs Claude and Codex usage), never in CI. Each agent runs isolated from the user's setup:
// Claude with --strict-mcp-config and no setting sources, Codex with a temporary CODEX_HOME that holds only the
// test server and a link to the user's Codex login.
//
//   node scripts/eval-agent.mjs [--agent claude,codex] [--only <task,task>] [--runs 1] [--jobs 3]
//                               [--claude-model sonnet] [--codex-model <model>] [--out result.json]
//
// Needs the agent CLIs, a Jev key and a build (npm run build). Exit 1 when any run fails a check.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startSite, USER } from '../e2e/site.mjs';

const { values } = parseArgs({ options: {
  agent: { type: 'string', default: 'claude,codex' },
  only: { type: 'string' },
  runs: { type: 'string', default: '1' },
  jobs: { type: 'string', default: '3' },
  'claude-model': { type: 'string', default: 'sonnet' },
  'codex-model': { type: 'string' },
  out: { type: 'string' },
} });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist/cli.js');
const SKILL_DIR = join(root, 'plugins/plainwright/skills/using-plainwright');
const MAX_BUDGET_USD = '2';
const scratch = mkdtempSync(join(tmpdir(), 'plainwright-agent-eval-'));
const site = await startSite();

// `budget` is the most plainwright tool calls a good run needs, with room for one look too many.
const TASKS = {
  reference: {
    prompt: `Open ${site.url}/spatial-reference. Fill the field immediately below the Shipping heading with "Upper entry", click Move heading, then fill the field immediately below the Shipping heading with "Lower entry". Use a natural-language target relative to the heading for both fills. Tell me the exact status message shown.`,
    answer: /Upper field:\s*Upper entry;\s*Lower field:\s*Lower entry/i, budget: 8, referenceFill: true,
  },
  spatial: {
    prompt: `Open ${site.url}/spatial and click the button on the left using a natural-language target. Tell me the exact status message shown after the click.`,
    answer: /B clicked/i, notAnswer: /A clicked/i, budget: 7, spatialClick: true,
  },
  login: {
    prompt: `Open ${site.url}/login, log in with username ${USER.name} and password ${USER.pass}, and tell me the exact status message shown after the login.`,
    answer: /logged into a secure area/i, budget: 8,
  },
  refused: {
    prompt: `Open ${site.url}/login, log in with username ${USER.name} and password wrong-password, and tell me whether the login worked and what message the page shows.`,
    answer: /password is invalid/i, notAnswer: /logged into a secure area/i, budget: 8,
  },
  form: {
    prompt: `Open ${site.url}/forms, choose Large in the Size list, then search for pizza with the Search field and the Enter key. Tell me the text of the search result.`,
    answer: /results for pizza/i, budget: 9,
  },
  late: {
    prompt: `Open ${site.url}/waits, click the Build report button, and tell me the heading that appears after it.`,
    answer: /report ready/i, budget: 7,
  },
  record: {
    prompt: (dir) => `Write a plainwright end-to-end test: at ${site.url}/login, log in as ${USER.name} with password ` +
      `${USER.pass}, and check that the Secure Area is shown. Save it as ${join(dir, 'login.yaml')}.`,
    answer: /login\.yaml/, budget: 10, saves: 'login.yaml',
  },
};

const skill = ['SKILL.md', 'browsing.md', 'authoring.md']
  .map((file) => readFileSync(join(SKILL_DIR, file), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '')).join('\n\n');
const skillFile = join(scratch, 'skill.md');
// The skill names `<plugin dir>` for CLI commands; a real install resolves it, so the eval says it.
writeFileSync(skillFile, `# The plainwright skill (its files are below; you do not need to read them)\n\n` +
  `The plainwright MCP tools are already running as the \`pw\` server: use them for the browser. For the CLI ` +
  `commands the skill names (validate, replay), the plugin dir is ${join(root, 'plugins/plainwright')}.\n\n${skill}`);
const env = { ...process.env, PLAINWRIGHT_E2E_SITE: site.url };
const server = { command: process.execPath, args: [cli, '--headless', 'mcp'] };

const AGENTS = { claude: runClaude, codex: runCodex };
const agents = values.agent.split(',');
for (const agent of agents) if (!AGENTS[agent]) throw new Error(`--agent: unknown agent "${agent}" (claude, codex)`);
const tasks = values.only ? values.only.split(',') : Object.keys(TASKS);
for (const task of tasks) if (!TASKS[task]) throw new Error(`--only: unknown task "${task}" (${Object.keys(TASKS).join(', ')})`);

const results = [];
try {
  const jobs = [];
  for (let run = 0; run < Number(values.runs); run++) for (const agent of agents) for (const task of tasks) jobs.push({ run, agent, task });
  let next = 0;
  // Each agent drives its own browser through its own MCP server.
  await Promise.all(Array.from({ length: Number(values.jobs) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const dir = mkdtempSync(join(scratch, `${job.agent}-${job.task}-`));
      const spec = TASKS[job.task];
      const prompt = `${typeof spec.prompt === 'function' ? spec.prompt(dir) : spec.prompt} End with a one-line answer.`;
      const { transcript, ...outcome } = await AGENTS[job.agent](prompt, dir).catch((error) => ({ failed: String(error), calls: [], answer: '' }));
      const problems = await grade(spec, outcome, dir);
      if (problems.length && transcript) writeFileSync(join(dir, 'transcript.jsonl'), transcript);
      results.push({ ...job, ...outcome, dir, problems });
    }
  }));
} finally {
  await site.close();
}

report();
if (values.out) writeFileSync(values.out, JSON.stringify(results, null, 1));
if (results.some((r) => r.problems.length)) {
  console.log(`Transcripts of the failed runs: ${scratch}/<agent>-<task>-*/transcript.jsonl`);
  process.exit(1);
}
rmSync(scratch, { recursive: true, force: true });

/** What is wrong with one run, as a list of reasons; empty when it passes. */
async function grade(spec, outcome, dir) {
  if (outcome.failed) return [`the agent did not finish: ${outcome.failed}`];
  const problems = [];
  const plainwright = outcome.calls.filter((c) => c.server === 'pw');
  if (!spec.answer.test(outcome.answer)) problems.push(`answer lacks ${spec.answer}: "${outcome.answer.slice(0, 160)}"`);
  if (spec.notAnswer?.test(outcome.answer)) problems.push(`answer claims ${spec.notAnswer}, which the page never showed`);
  if (!plainwright.some((c) => c.tool === 'open')) problems.push('never called the plainwright open tool');
  const steps = plainwright.flatMap((call) => call.tool === 'step' ? [call.args?.step] : call.tool === 'batch' ? call.args?.steps ?? [] : []);
  if (spec.spatialClick) {
    if (!steps.some((step) => typeof step?.click === 'string' && !step.click.startsWith('css=') && /left/i.test(step.click))) {
      problems.push('never clicked with a natural-language spatial target');
    }
  }
  if (spec.referenceFill) {
    const fills = steps.map((step) => typeof step?.fill === 'string' ? step.fill : step?.fill?.target);
    if (fills.filter((target) => typeof target === 'string' && !target.startsWith('css=') &&
      /shipping/i.test(target) && /below|under|beneath/i.test(target)).length < 2) {
      problems.push('did not perform both fills with a natural-language target relative to the heading');
    }
  }
  // A shell may look around or run this checkout's CLI (the authoring skill replays specs that way), but the page
  // itself is reached only through plainwright, and only this checkout's plainwright.
  const shell = outcome.calls.filter((c) => c.server === 'shell');
  const offPage = shell.filter((c) => c.tool.includes(new URL(site.url).host) && !c.tool.includes(root));
  if (offPage.length) problems.push(`reached the page outside plainwright: ${offPage.map((c) => c.tool).join('; ')}`);
  const installed = shell.filter((c) => /plugins\/cache\/[^/ ]*plainwright/.test(c.tool));
  if (installed.length) problems.push(`used an installed plainwright, not this checkout: ${installed.map((c) => c.tool).join('; ')}`);
  const foreign = outcome.calls.filter((c) => c.server !== 'pw' && c.server !== 'shell');
  if (foreign.length) problems.push(`used other tools: ${foreign.map((c) => c.tool).join(', ')}`);
  const failed = plainwright.filter((c) => c.error);
  if (failed.length) problems.push(`failed tool calls (a missing tool counts): ${failed.map((c) => `${c.tool}: ${c.error}`.slice(0, 120)).join('; ')}`);
  if (plainwright.length > spec.budget) problems.push(`${plainwright.length} plainwright calls, budget ${spec.budget}`);
  if (spec.saves) {
    const saved = join(dir, spec.saves);
    if (!existsSync(saved)) problems.push(`no spec saved at ${spec.saves}`);
    else if (!/expect|wait/.test(readFileSync(saved, 'utf8'))) problems.push('the saved spec checks nothing (no expect or wait)');
    else {
      const code = await new Promise((done) => spawn(process.execPath, [cli, '--headless', '--picks', 'off', '--reporter', 'text', saved], { env, stdio: 'inherit' })
        .on('exit', done));
      if (code !== 0) problems.push(`the saved spec did not pass on replay (exit ${code})`);
    }
  }
  return problems;
}

function runClaude(prompt, dir) {
  const config = join(dir, 'mcp.json');
  writeFileSync(config, JSON.stringify({ mcpServers: { pw: { ...server, env } } }), { mode: 0o600 });
  const args = ['-p', prompt, '--model', values['claude-model'], '--output-format', 'stream-json', '--verbose',
    '--strict-mcp-config', '--mcp-config', config, '--tools', '', '--allowedTools', 'mcp__pw__*',
    '--setting-sources', '', '--append-system-prompt-file', skillFile, '--max-budget-usd', MAX_BUDGET_USD];
  return collect('claude', args, { cwd: dir }, (events) => {
    const calls = [];
    const byId = new Map();
    let answer = '';
    let result;
    for (const event of events) {
      for (const content of event.message?.content ?? []) {
        if (content.type === 'tool_use') {
          const [, serverName, tool] = /^mcp__([^_]+)__(.+)$/.exec(content.name) ?? [null, 'claude', content.name];
          const call = { server: serverName, tool, args: content.input };
          byId.set(content.id, call);
          calls.push(call);
        }
        if (content.type === 'tool_result') {
          const call = byId.get(content.tool_use_id);
          const text = [].concat(content.content).map((c) => c?.text ?? c).join(' ');
          if (call && content.is_error) call.error = text;
          else if (call?.server === 'pw' && ['step', 'batch'].includes(call.tool)) {
            try {
              const { status } = JSON.parse(text);
              if (status && status !== 'pass') call.error = `plainwright returned ${status}`;
            } catch { /* Non-JSON results still use the client's is_error flag. */ }
          }
        }
        if (content.type === 'text' && event.type === 'assistant') answer = content.text;
      }
      if (event.type === 'result') result = event;
    }
    if (!result) return { failed: 'no result event', calls, answer };
    return { calls, answer: lastLine(result.result ?? answer), costUsd: result.total_cost_usd, ms: result.duration_ms };
  });
}

function runCodex(prompt, dir) {
  // An empty Codex home: no user plugins or apps (an installed plainwright would shadow this checkout), hooks or memories.
  const home = join(dir, 'codex-home');
  const userHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  mkdirSync(home);
  symlinkSync(join(userHome, 'auth.json'), join(home, 'auth.json'));
  const toml = (value) => JSON.stringify(value);
  writeFileSync(join(home, 'config.toml'), [
    // The account's apps and remote plugins add hundreds of tools, and the agent then misses plainwright's.
    '[features]',
    'apps = false',
    'plugins = false',
    'remote_plugin = false',
    '[mcp_servers.pw]',
    `command = ${toml(server.command)}`,
    `args = [${server.args.map(toml).join(', ')}]`,
    'default_tools_approval_mode = "approve"',
    'tool_timeout_sec = 300',
    // Several agents start a browser at once: the default 10 s start budget is too short.
    'startup_timeout_sec = 120',
    '[mcp_servers.pw.env]',
    `PLAINWRIGHT_E2E_SITE = ${toml(site.url)}`,
    ...['TYPESAFE_API_KEY', 'AI_GATEWAY_API_KEY', 'JEV_PROVIDER'].filter((name) => env[name])
      .map((name) => `${name} = ${toml(env[name])}`),
  ].join('\n') + '\n', { mode: 0o600 });
  const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', dir,
    ...(values['codex-model'] ? ['-m', values['codex-model']] : []), `${readFileSync(skillFile, 'utf8')}\n\n# Task\n\n${prompt}`];
  return collect('codex', args, { cwd: dir, env: { ...process.env, CODEX_HOME: home }, stdin: 'ignore' }, (events) => {
    const calls = [];
    let answer = '';
    let done = false;
    for (const { type, item, error } of events) {
      if (type === 'item.completed' && item.type === 'mcp_tool_call') {
        const status = item.result?.structured_content?.status;
        const failed = item.error?.message ?? (status && status !== 'pass' ? `plainwright returned ${status}` : undefined);
        calls.push({ server: item.server, tool: item.tool, args: item.arguments, ...(failed ? { error: failed } : {}) });
      }
      if (type === 'item.completed' && item.type === 'command_execution') calls.push({ server: 'shell', tool: item.command });
      if (type === 'item.completed' && item.type === 'agent_message') answer = item.text;
      if (type === 'turn.completed') done = true;
      if (type === 'turn.failed') return { failed: error?.message ?? 'turn failed', calls, answer };
    }
    return done ? { calls, answer: lastLine(answer) } : { failed: 'no turn.completed event', calls, answer };
  });
}

/** Runs an agent CLI, parses its JSON lines with `parse`; the process's own failure becomes `failed`. */
function collect(command, args, { cwd, env: childEnv = process.env, stdin = 'ignore' }, parse) {
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, env: childEnv, stdio: [stdin, 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', (error) => done({ failed: `${command}: ${error.message}`, calls: [], answer: '' }));
    child.on('close', (code) => {
      const events = out.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
      const parsed = { ...parse(events), transcript: out };
      if (!parsed.failed && code !== 0) parsed.failed = `${command} exited ${code}: ${err.trim().split('\n').at(-1) ?? ''}`;
      done({ ms: Date.now() - started, ...parsed });
    });
  });
}

function lastLine(text) {
  return text.split('\n').filter((line) => line.trim()).at(-1) ?? '';
}

function report() {
  console.log('\nagent   task     result  calls  shell  time   cost     plainwright tools');
  for (const r of results.sort((a, b) => a.agent.localeCompare(b.agent) || a.task.localeCompare(b.task) || a.run - b.run)) {
    const tools = r.calls.filter((c) => c.server === 'pw').map((c) => c.tool).join(' ');
    const shell = r.calls.filter((c) => c.server === 'shell').length;
    const cost = r.costUsd === undefined ? '' : `$${r.costUsd.toFixed(3)}`;
    console.log(`${r.agent.padEnd(8)}${r.task.padEnd(9)}${(r.problems.length ? 'FAIL' : 'pass').padEnd(8)}` +
      `${String(r.calls.length - shell).padStart(5)}${String(shell).padStart(7)}${`${Math.round((r.ms ?? 0) / 1000)}s`.padStart(7)}` +
      `${cost.padStart(9)}  ${tools}`);
    for (const problem of r.problems) console.log(`        - ${problem}`);
  }
  const failed = results.filter((r) => r.problems.length).length;
  console.log(`\n${results.length - failed}/${results.length} agent runs passed.`);
}
