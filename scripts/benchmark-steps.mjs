#!/usr/bin/env node
// Step-overhead benchmark: runs specs through the CLI with --timing, N times, and reports where the
// wall time goes. "Overhead" is step time minus the page's own action time (goto loads, clicks):
// settle, post-action waits, candidate scans, snapshots and Jev round trips. Skipped optional steps
// are reported apart, since a wait that runs to its timeout by design is not overhead.
//
//   node scripts/benchmark-steps.mjs [--cli dist/cli.js] [--runs 3] [--out result.json] [--compare base.json]
//     [--mode judge|no-judge|auto-healing] [--dir examples] [spec.yaml ...]
//
// Defaults to every <dir>/*.yaml (examples/) except google-flights (live third-party site) and login-fails
// (fails by design). Needs a Jev key, like any spec run. Build first (npm run build).
// --mode is passed to the CLI (run modes, docs/running.mdx); judge and auto-healing write *.lock.json next to the
// specs, so point --dir at a scratch copy of examples/, never at the repository's. Each run also reports
// pick/claim calls and tokens (scripts/count-jev.mjs), replayed and healed steps and every step's status (JSON report).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  options: { cli: { type: 'string', default: 'dist/cli.js' }, runs: { type: 'string', default: '3' }, out: { type: 'string' }, compare: { type: 'string' },
    mode: { type: 'string' }, dir: { type: 'string', default: 'examples' } },
  allowPositionals: true,
});
const specs = positionals.length
  ? positionals
  : readdirSync(values.dir).filter((f) => f.endsWith('.yaml') && !/google-flights|login-fails/.test(f)).map((f) => path.join(values.dir, f));
const counter = new URL('./count-jev.mjs', import.meta.url).href;

// Lock use and per-step outcome from the JSON report: replayed and healed steps, and every step's status in order.
function outcome(file) {
  let report;
  try { report = JSON.parse(readFileSync(file, 'utf8')); } catch { return { replayed: 0, healed: 0, statuses: [] }; }
  const statuses = report.specs.flatMap((spec) => (spec.attempts.at(-1)?.steps ?? []).map((step) => `${spec.name} › ${step.step}: ${step.status}`));
  return { replayed: report.totals.replayed ?? 0, healed: report.totals.healed ?? 0, statuses };
}

function parse(stdout) {
  const phases = {};
  let skipped = 0;
  let steps = 0;
  let failed = 0;
  let last = null;
  for (const line of stdout.split('\n')) {
    const step = /^  (✔|✘|\?|») /.exec(line);
    if (step) last = step[1];
    if (/^(✘|\?) /.test(line)) failed++;
    const ms = /^    ms (.*)$/.exec(line);
    if (!ms) continue;
    const m = Object.fromEntries(ms[1].split(' ').map((kv) => kv.split('=')).map(([k, v]) => [k, Number(v)]));
    steps++;
    if (last === '»') {
      skipped += m.total;
      continue;
    }
    for (const [k, v] of Object.entries(m)) if (k !== 'polls') phases[k] = (phases[k] ?? 0) + v;
  }
  const overhead = (phases.total ?? 0) - (phases.action ?? 0);
  return { steps, failed, skippedMs: skipped, phases, overhead };
}

const runs = [];
for (let i = 0; i < Number(values.runs); i++) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'plain-bench-'));
  const json = path.join(scratch, 'report.json'), count = path.join(scratch, 'count.json');
  const start = Date.now();
  const res = spawnSync('node', ['--import', counter, values.cli, '--headless', '--timing', '--reporter', 'text', '--reporter', `json:${json}`,
    ...(values.mode ? ['--mode', values.mode] : []), ...specs],
  { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, PLAIN_BENCH_COUNT: count, PLAIN_BENCH_DIST: path.dirname(path.resolve(values.cli)) } });
  let jev = {};
  try { jev = JSON.parse(readFileSync(count, 'utf8')); } catch {}
  const run = { wall: Date.now() - start, ...parse(res.stdout), jev, ...outcome(json) };
  rmSync(scratch, { recursive: true, force: true });
  runs.push(run);
  console.error(`run ${i + 1}: wall=${run.wall} overhead=${run.overhead} jev=${run.phases.jev ?? 0} action=${run.phases.action ?? 0} skipped=${run.skippedMs} failedSpecs=${run.failed}` +
    ` picks=${jev.pickCalls ?? '?'} pickTokens=${jev.pickTokens ?? '?'} claims=${jev.judgeCalls ?? '?'} claimTokens=${jev.judgeTokens ?? '?'} routes=${jev.routeCalls ?? '?'} routeGroups=${jev.routeGroups ?? '?'} replayed=${run.replayed} healed=${run.healed}`);
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const keys = [...new Set(runs.flatMap((r) => Object.keys(r.phases)))];
const summary = {
  cli: values.cli,
  specs,
  runs: runs.length,
  median: {
    wall: median(runs.map((r) => r.wall)),
    overhead: median(runs.map((r) => r.overhead)),
    skippedMs: median(runs.map((r) => r.skippedMs)),
    ...Object.fromEntries(keys.map((k) => [k, median(runs.map((r) => r.phases[k] ?? 0))])),
    pickCalls: median(runs.map((r) => r.jev.pickCalls ?? 0)),
    pickTokens: median(runs.map((r) => r.jev.pickTokens ?? 0)),
    claimTokens: median(runs.map((r) => r.jev.judgeTokens ?? 0)),
    routeCalls: median(runs.map((r) => r.jev.routeCalls ?? 0)),
    routeGroups: median(runs.map((r) => r.jev.routeGroups ?? 0)),
    routeTokens: median(runs.map((r) => r.jev.routeTokens ?? 0)),
    replayed: median(runs.map((r) => r.replayed)),
    healed: median(runs.map((r) => r.healed)),
  },
  // Same step statuses in every run (and, with --compare, as the base run).
  statuses: runs[0]?.statuses ?? [],
  statusesStable: runs.every((r) => JSON.stringify(r.statuses) === JSON.stringify(runs[0].statuses)),
  failedSpecs: runs.map((r) => r.failed),
  raw: runs,
};
if (values.out) writeFileSync(values.out, JSON.stringify(summary, null, 2));

const baseFile = values.compare ? JSON.parse(readFileSync(values.compare, 'utf8')) : null;
const base = baseFile?.median ?? null;
console.log(`step statuses ${summary.statusesStable ? 'identical across runs' : 'DIFFER across runs'}` +
  (baseFile?.statuses ? `, ${JSON.stringify(baseFile.statuses) === JSON.stringify(summary.statuses) ? 'identical to' : 'DIFFERENT from'} the base` : ''));
if (baseFile?.statuses) {
  // By step label, so a spec that stopped early in one run does not shift every later line.
  const byStep = (lines) => new Map(lines.map((line) => [line.slice(0, line.lastIndexOf(': ')), line.slice(line.lastIndexOf(': ') + 2)]));
  const now = byStep(summary.statuses), then = byStep(baseFile.statuses);
  for (const step of new Set([...then.keys(), ...now.keys()])) {
    if (now.get(step) !== then.get(step)) console.log(`  ${step}: ${now.get(step) ?? 'not run'}  (base: ${then.get(step) ?? 'not run'})`);
  }
}
console.log('metric      median' + (base ? '      base   change' : ''));
for (const [k, v] of Object.entries(summary.median)) {
  const row = `${k.padEnd(10)} ${String(v).padStart(8)}`;
  if (!base || base[k] === undefined) console.log(row);
  else console.log(`${row}  ${String(base[k]).padStart(8)}  ${base[k] ? (((v - base[k]) / base[k]) * 100).toFixed(1).padStart(6) + '%' : ''}`);
}
