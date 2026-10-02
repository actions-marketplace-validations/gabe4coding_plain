#!/usr/bin/env node
// The validation loop every change goes through before a pull request (skill: .claude/skills/validating-changes,
// also .agents/skills/ for Codex). It runs the gates in order and stops at the first failure:
//   1. npm run verify          key-free: build (strict tsc), tests, docs, examples, plugin install smoke
//   2. node scripts/e2e.mjs    live Jev, local site: specs with expected statuses, MCP record and replay
//   3. claims eval --gate      live Jev, saved pages: false passes must stay 0
//   4. agent evals             real claude -p and codex exec runs; only when the MCP tools, their results or the
//                              browser skill changed (--agents on|off forces it)
// Then it lists the area evals the changed files call for, which need a judgment (compare with main), and writes
// the stamp scripts/pr-gate.mjs checks. Live steps need a Jev key; agent evals need the claude and codex CLIs.
//
//   node scripts/validate.mjs [--base origin/main] [--agents auto|on|off]
import { spawn, execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { workingTree, writeStamp } from './validation-stamp.mjs';

const { values } = parseArgs({ options: {
  base: { type: 'string', default: 'origin/main' },
  agents: { type: 'string', default: 'auto' },
} });
if (!['auto', 'on', 'off'].includes(values.agents)) throw new Error('--agents must be auto, on or off');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

// What an agent sees of the browser engine: tool shapes, results and the skill that teaches them.
const AGENT_SURFACE = [/^src\/browser\/mcp\.ts$/, /^src\/core\/(mcp-result|read|aria-changes|snapshot-view)\.ts$/,
  /^plugins\/plainwright\/skills\//];
// Area evals: a change here can make Jev's answers or the step time worse without failing a gate.
const AREA_EVALS = [
  [/^src\/(jev\/(pick|describe|ask)|browser\/(candidates|locate)|core\/automation)\.ts$/,
    'node scripts/benchmark-picks.mjs --runs 3   (compare with main: picks must not get worse)'],
  [/^src\/(jev\/(judge|decide|ask)|browser\/(judge-page|page)|core\/automation)\.ts$/,
    'node scripts/benchmark-claims.mjs --runs 3   (compare with main: false passes 0, no new false fails)'],
  [/^src\/core\/read\.ts$/, 'node scripts/benchmark-read.mjs --runs 2 --smart   (compare with main)'],
  [/^src\/core\/(pick-cache|automation)\.ts$/, 'node scripts/benchmark-pick-cache.mjs   (wrong and unconfirmed hits must stay 0)'],
  [/^src\/computer\/planner\.ts$/, 'node scripts/benchmark-planner.mjs --runs 3   (change only when it improves)'],
  [/^src\/browser\/(activity|settled-ask|steps|session|runner)\.ts$/,
    'node scripts/benchmark-steps.mjs --runs 3 --compare <main run>   (step overhead must not grow)'],
  [/^src\/core\/snapshot-view\.ts$/, 'node scripts/benchmark-snapshots.mjs   (compare with main)'],
  [/^src\/(computer|native)\//, 'npm run test:computer:mac   (on macOS, with Accessibility permission)'],
  [/^src\/(mobile|native)\//, 'npm run test:mobile:android and npm run test:mobile:ios   (with a device or simulator)'],
  [/^examples\/[^/]+\.yaml$/, 'node dist/cli.js --headless <each changed example>   (live demo sites)'],
];

function changedFiles() {
  const base = git(['merge-base', values.base, 'HEAD']);
  const committed = git(['diff', '--name-only', `${base}...HEAD`]).split('\n');
  const working = git(['status', '--porcelain', '--untracked-files=all']).split('\n').map((line) => line.slice(3).split(' -> ').at(-1));
  return [...new Set([...committed, ...working])].filter(Boolean);
}

function run(label, command, args) {
  console.log(`\n=== ${label}: ${command} ${args.join(' ')}`);
  return new Promise((done) => spawn(command, args, { cwd: root, stdio: 'inherit' }).on('exit', (code) => done(code === 0)));
}

const changed = changedFiles();
const agentEvals = values.agents === 'on' || (values.agents === 'auto' && changed.some((f) => AGENT_SURFACE.some((re) => re.test(f))));
const steps = [
  ['key-free gate', 'npm', ['run', 'verify']],
  ['live e2e', process.execPath, ['scripts/e2e.mjs']],
  ['claims gate', process.execPath, ['scripts/benchmark-claims.mjs', '--gate']],
  ...(agentEvals ? [['agent evals', process.execPath, ['scripts/eval-agent.mjs']]] : []),
];
for (const [label, command, args] of steps) {
  if (!(await run(label, command, args))) {
    console.error(`\nVALIDATION FAILED at "${label}". Fix the cause; do not weaken the check. No stamp written.`);
    process.exit(1);
  }
}

const areaEvals = AREA_EVALS.filter(([re]) => changed.some((f) => re.test(f))).map(([, how]) => how);
writeStamp(workingTree(), { base: values.base, ran: steps.map(([label]) => label), areaEvals });
console.log(`\nVALIDATION PASSED: ${steps.map(([label]) => label).join(', ')}.` +
  (agentEvals ? '' : ' Agent evals not needed: no MCP tool, result or browser skill change.'));
if (areaEvals.length) console.log(`\nArea evals still to run and compare (the skill says how):\n${areaEvals.map((how) => `  - ${how}`).join('\n')}`);
console.log('\nThen finish the review steps of the validating-changes skill. The stamp covers the current files: ' +
  'if you change a file after this, run this again before the pull request.');
