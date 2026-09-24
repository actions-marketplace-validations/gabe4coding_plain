#!/usr/bin/env node
// Step-overhead benchmark: runs specs through the CLI with --timing, N times, and reports where the
// wall time goes. "Overhead" is step time minus the page's own action time (goto loads, clicks):
// settle, post-action waits, candidate scans, snapshots and Jev round trips. Skipped optional steps
// are reported apart, since a wait that runs to its timeout by design is not overhead.
//
//   node scripts/benchmark-steps.mjs [--cli dist/cli.js] [--runs 3] [--out result.json] [--compare base.json] [spec.yaml ...]
//
// Defaults to every examples/*.yaml except google-flights (live third-party site) and login-fails
// (fails by design). Needs a Jev key, like any spec run. Build first (npm run build).
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  options: { cli: { type: 'string', default: 'dist/cli.js' }, runs: { type: 'string', default: '3' }, out: { type: 'string' }, compare: { type: 'string' } },
  allowPositionals: true,
});
const specs = positionals.length
  ? positionals
  : readdirSync('examples').filter((f) => f.endsWith('.yaml') && !/google-flights|login-fails/.test(f)).map((f) => `examples/${f}`);

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
  const start = Date.now();
  const res = spawnSync('node', [values.cli, '--headless', '--timing', ...specs], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const run = { wall: Date.now() - start, ...parse(res.stdout) };
  runs.push(run);
  console.error(`run ${i + 1}: wall=${run.wall} overhead=${run.overhead} jev=${run.phases.jev ?? 0} action=${run.phases.action ?? 0} skipped=${run.skippedMs} failedSpecs=${run.failed}`);
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
  },
  failedSpecs: runs.map((r) => r.failed),
  raw: runs,
};
if (values.out) writeFileSync(values.out, JSON.stringify(summary, null, 2));

const base = values.compare ? JSON.parse(readFileSync(values.compare, 'utf8')).median : null;
console.log('metric      median' + (base ? '      base   change' : ''));
for (const [k, v] of Object.entries(summary.median)) {
  const row = `${k.padEnd(10)} ${String(v).padStart(8)}`;
  if (!base || base[k] === undefined) console.log(row);
  else console.log(`${row}  ${String(base[k]).padStart(8)}  ${base[k] ? (((v - base[k]) / base[k]) * 100).toFixed(1).padStart(6) + '%' : ''}`);
}
