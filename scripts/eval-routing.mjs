#!/usr/bin/env node
// Routing eval: fresh `claude -p` and `codex exec` agents answer task questions whose answer sits behind a route of
// the agent notes: CLAUDE.md (also AGENTS.md) points to CODING_STANDARDS.md, the engine notes, the skills and docs.
// Each final answer is graded against its case in scripts/routing-cases.json: it must match every `expect` regex and
// no `forbid` regex, case-insensitive. A fail means an agent did not find a rule: fix the route, not the case.
// Local only (it costs Claude and Codex usage), never in CI. Each agent runs read-only in this checkout, with its
// CLAUDE.md / AGENTS.md and skills, isolated from the user's setup:
//   - Claude: Read, Grep and Glob only; project settings only, so no user plugins, hooks or permissions; no MCP
//     server; no user CLAUDE.md or rules (they load with project settings too); no auto memory (shared by all
//     worktrees of the repo). Org-managed settings still apply: they rank above every flag.
//   - Codex: a read-only sandbox, a Codex home that holds only the user's Codex login, and an empty HOME, as Codex
//     also reads the user's skills in ~/.agents/skills.
//
//   node scripts/eval-routing.mjs [--agent claude,codex] [--only <id,id>] [--runs 1] [--jobs 3]
//                                 [--claude-model sonnet] [--codex-model <model>] [--out result.json]
//
// Needs the agent CLIs; no Jev key or build. Exit 1 when any run fails.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { codexEnv, collect } from './agent-cli.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CASES_FILE = join(root, 'scripts/routing-cases.json');
const SUFFIX = "Answer from this repository's instruction files only. Do not change any file. Be brief: list each " +
  'required action and cite the file where its rule is.';
const CLAUDE_TOOLS = ['Read', 'Grep', 'Glob'];
const MAX_BUDGET_USD = '1';
const CASE_KEYS = ['id', 'question', 'expect', 'forbid'];

/**
 * The cases of `file`. Throws on a case without a unique id, a question or an `expect`, with an invalid regex, or with
 * an unknown key: a misspelled `forbid` would check nothing.
 */
export function loadCases(file = CASES_FILE) {
  const cases = JSON.parse(readFileSync(file, 'utf8'));
  const ids = new Set();
  for (const testCase of cases) {
    const name = `routing case ${JSON.stringify(testCase.id)}`;
    if (typeof testCase.id !== 'string' || !testCase.id || ids.has(testCase.id)) {
      throw new Error(`${name}: needs a unique id`);
    }
    ids.add(testCase.id);
    if (typeof testCase.question !== 'string' || !testCase.question.trim()) {
      throw new Error(`${name}: needs a question`);
    }
    if (!Array.isArray(testCase.expect) || !testCase.expect.length) throw new Error(`${name}: needs an expect`);
    if (testCase.forbid !== undefined && !Array.isArray(testCase.forbid)) throw new Error(`${name}: forbid is a list`);
    const unknown = Object.keys(testCase).filter((key) => !CASE_KEYS.includes(key));
    if (unknown.length) throw new Error(`${name}: unknown key ${unknown.join(', ')} (${CASE_KEYS.join(', ')})`);
    // Grading compiles every regex, so an invalid one fails here, before any agent runs.
    grade(testCase, '');
  }
  return cases;
}

/** What is wrong with `answer`: each `expect` regex it misses, each `forbid` it matches; empty when it passes. */
export function grade(testCase, answer) {
  const regex = (pattern) => {
    try {
      return new RegExp(pattern, 'i');
    } catch (error) {
      throw new Error(`routing case ${JSON.stringify(testCase.id)}: invalid regex /${pattern}/: ${error.message}`);
    }
  };
  return [
    ...testCase.expect.filter((pattern) => !regex(pattern).test(answer)).map((pattern) => `missing /${pattern}/`),
    ...(testCase.forbid ?? []).filter((pattern) => regex(pattern).test(answer))
      .map((pattern) => `forbidden /${pattern}/`),
  ];
}

const AGENTS = { claude: runClaude, codex: runCodex };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

async function main() {
  const { values } = parseArgs({ options: {
    agent: { type: 'string', default: 'claude,codex' },
    only: { type: 'string' },
    runs: { type: 'string', default: '1' },
    jobs: { type: 'string', default: '3' },
    'claude-model': { type: 'string', default: 'sonnet' },
    'codex-model': { type: 'string' },
    out: { type: 'string' },
  } });
  const cases = loadCases();
  const agents = values.agent.split(',');
  for (const agent of agents) if (!AGENTS[agent]) throw new Error(`--agent: unknown agent "${agent}" (claude, codex)`);
  const known = cases.map((c) => c.id);
  const ids = values.only ? values.only.split(',') : known;
  for (const id of ids) if (!known.includes(id)) throw new Error(`--only: unknown case "${id}" (${known.join(', ')})`);

  const scratch = mkdtempSync(join(tmpdir(), 'plain-routing-eval-'));
  const jobs = [];
  for (let run = 0; run < Number(values.runs); run++) {
    for (const agent of agents) for (const id of ids) jobs.push({ run, agent, id });
  }
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Number(values.jobs) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const testCase = cases.find((c) => c.id === job.id);
      const dir = mkdtempSync(join(scratch, `${job.agent}-${job.id}-`));
      const { transcript, ...outcome } = await AGENTS[job.agent](`${testCase.question}\n\n${SUFFIX}`, values, dir);
      const problems = outcome.failed
        ? [`the agent did not finish: ${outcome.failed}`]
        : grade(testCase, outcome.answer);
      if (problems.length) {
        writeFileSync(join(dir, 'answer.md'), outcome.answer);
        if (transcript) writeFileSync(join(dir, 'transcript.jsonl'), transcript);
      }
      const result = { ...job, ...outcome, seconds: Math.round((outcome.ms ?? 0) / 1000), problems };
      results.push(result);
      console.log(`${result.agent.padEnd(8)}${result.id.padEnd(26)}${(problems.length ? 'FAIL' : 'pass').padEnd(6)}` +
        `${`${result.seconds}s`.padStart(5)}  ${problems.join('; ')}`.trimEnd());
    }
  }));

  if (values.out) writeFileSync(values.out, JSON.stringify(results, null, 1));
  const failed = results.filter((r) => r.problems.length);
  console.log(`\n${results.length - failed.length}/${results.length} routing runs passed.`);
  if (failed.length) {
    console.log(`Answers and transcripts of the failed runs: ${scratch}/<agent>-<case>-*/`);
    process.exit(1);
  }
  rmSync(scratch, { recursive: true, force: true });
}

function runClaude(prompt, values) {
  const settings = { claudeMdExcludes: [join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '**')] };
  const args = ['-p', prompt, '--model', values['claude-model'], '--output-format', 'stream-json', '--verbose',
    '--tools', CLAUDE_TOOLS.join(','), '--setting-sources', 'project', '--settings', JSON.stringify(settings),
    '--strict-mcp-config', '--no-session-persistence', '--max-budget-usd', MAX_BUDGET_USD];
  const env = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  return collect('claude', args, { cwd: root, env }, (events) => {
    const reads = events.flatMap((event) => event.type === 'assistant' ? event.message.content : [])
      .filter((content) => content.type === 'tool_use')
      .map((use) => `${use.name} ${use.input.file_path ?? use.input.pattern ?? ''}`);
    const result = events.find((event) => event.type === 'result');
    const leaks = isolationLeaks(events.find((event) => event.type === 'system' && event.subtype === 'init'));
    if (!result) return { failed: 'no result event', answer: '', reads };
    if (leaks.length) return { failed: `not isolated: ${leaks.join(', ')}`, answer: result.result ?? '', reads };
    if (result.is_error) return { failed: result.subtype, answer: result.result ?? '', reads };
    return { answer: result.result, reads, costUsd: result.total_cost_usd };
  });
}

/** What of the user's setup reached a Claude run, from its init event. */
function isolationLeaks(init) {
  if (!init) return ['no init event'];
  return [
    ...init.tools.filter((tool) => !CLAUDE_TOOLS.includes(tool)).map((tool) => `tool ${tool}`),
    ...init.mcp_servers.map((server) => `MCP server ${server.name}`),
    ...(init.memory_paths ? ['auto memory'] : []),
  ];
}

function runCodex(prompt, values, dir) {
  const args = ['exec', '--json', '--sandbox', 'read-only', '--cd', root,
    ...(values['codex-model'] ? ['-m', values['codex-model']] : []), prompt];
  const env = codexEnv(dir);
  return collect('codex', args, { cwd: root, env }, (events) => {
    const reads = [];
    let answer = '';
    for (const { type, item, error } of events) {
      if (type === 'item.completed' && item.type === 'command_execution') reads.push(item.command);
      if (type === 'item.completed' && item.type === 'agent_message') answer = item.text;
      if (type === 'turn.failed') return { failed: error?.message ?? 'turn failed', answer, reads };
      if (type === 'turn.completed') return { answer, reads };
    }
    return { failed: 'no turn.completed event', answer, reads };
  });
}
