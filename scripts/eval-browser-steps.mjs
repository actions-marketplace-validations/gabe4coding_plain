#!/usr/bin/env node
// Browser step-time eval: how long plain's own work takes per step, in spec runs and in an
// agent-style MCP session, and whether every step still ends the same way. Built for a hillclimb
// loop (baseline, v1, v2, ... under one flow directory); the report builder reads what it writes.
//
//   node scripts/eval-browser-steps.mjs [--flow .claude/hillclimb/browser-step-time] [--variant baseline]
//     [--reps 3] [--mcp-reps 2] [--gap 5000] [--cli dist/cli.js] [--only spec|mcp] [--timeout-s 900]
//     [--write-expected] [--approve-harness]
//
// Cases: every examples/*.yaml except google-flights (live third-party site), run in one CLI process
// per rep (headless, --timing, like scripts/benchmark-steps.mjs), and the MCP session of
// scripts/benchmark-mcp.mjs, one session per rep with --gap ms of think time, scored as 4 cases.
//
// Per case: `overhead_s` (the headline, lower is better) and `same_status` (1 when the spec status and
// every step status match <flow>/expected.json; 0 otherwise). Spec overhead is step time minus the
// page's action time and the page's own delay a wait sees (`idle`), leaving out optional steps that
// were skipped (a wait that runs to its timeout by design). MCP overhead is the tool time the agent waits on, leaving out `open` (page loads).
//
// Rows go to <flow>/<variant>/results.jsonl as each rep finishes; traces to traces/<id>_rep<k>.json.
// A rep whose process timed out or crashed, or a case that hit a Jev API or site error, goes to
// errors.jsonl instead, so plumbing is never scored as a slower or wrong step. Resume is per
// (case, rep): a rep with every row written is skipped.
//
// --write-expected records the step statuses of this run's first rep as <flow>/expected.json (a
// human reviews it; it changes the harness sha, so the next run needs --approve-harness). The runner
// refuses to start when this file, expected.json or any _state.json.harness_paths entry changed since
// the last --approve-harness, which is the user's to pass.
//
// Needs a Jev key, like any spec run, and a build (npm run build).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    flow: { type: 'string', default: '.claude/hillclimb/browser-step-time' },
    variant: { type: 'string', default: 'baseline' },
    reps: { type: 'string', default: '3' },
    'mcp-reps': { type: 'string', default: '2' },
    gap: { type: 'string', default: '5000' },
    cli: { type: 'string', default: 'dist/cli.js' },
    only: { type: 'string' },
    'timeout-s': { type: 'string', default: '900' },
    'write-expected': { type: 'boolean', default: false },
    'approve-harness': { type: 'boolean', default: false },
  },
});
if (!/^(baseline|v[1-9]\d*)$/.test(values.variant)) exit(`--variant must be 'baseline' or 'v<N>', got '${values.variant}'`);
if (values.only && !['spec', 'mcp'].includes(values.only)) exit(`--only must be spec or mcp`);
const flow = values.flow;
const vdir = join(flow, values.variant);
const timeoutMs = Number(values['timeout-s']) * 1000;
const gap = Number(values.gap);
mkdirSync(join(vdir, 'traces'), { recursive: true });

function exit(message) {
  console.error(message);
  process.exit(2);
}

// --- harness gate ---------------------------------------------------------------------------------

const statePath = join(flow, '_state.json');
const expectedPath = join(flow, 'expected.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};

function harnessSha() {
  const self = fileURLToPath(import.meta.url);
  const paths = [...new Set([self, resolve(expectedPath), ...(state.harness_paths ?? []).map((p) => resolve(p))])].sort();
  const h = createHash('sha256');
  for (const p of paths) {
    if (!existsSync(p)) continue;
    h.update(relative(process.cwd(), p)).update('\0').update(readFileSync(p)).update('\0');
  }
  return h.digest('hex');
}

function checkHarness() {
  const sha = harnessSha();
  if (state.harness_sha === sha) return;
  if (values['approve-harness']) {
    state.harness_sha = sha;
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
    console.error(`harness approved: sha256 ${sha.slice(0, 12)} recorded in ${statePath}`);
    return;
  }
  exit(`harness ${state.harness_sha ? 'changed since the last approved run' : 'not approved yet'} (now ${sha.slice(0, 12)}). ` +
    `Review this runner, expected.json and _state.json.harness_paths, then run once with --approve-harness.`);
}
if (!values['write-expected']) checkHarness();

// --- cases ----------------------------------------------------------------------------------------

const specFiles = readdirSync('examples').filter((f) => f.endsWith('.yaml') && f !== 'google-flights.yaml').sort();
const site = 'https://the-internet.herokuapp.com';
// The MCP session of scripts/benchmark-mcp.mjs, grouped into the flows an agent would run.
const MCP_GROUPS = [
  ['mcp-login', [
    ['open', { url: `${site}/login` }],
    ['step', { step: { fill: { target: 'the username field', value: 'tomsmith' } } }],
    ['step', { step: { fill: { target: 'the password field', value: 'SuperSecretPassword!' } } }],
    ['step', { step: { click: 'the login button' } }],
    ['step', { step: { expect: 'the user is logged in and sees a success message' } }],
  ]],
  ['mcp-checkboxes', [
    ['open', { url: `${site}/checkboxes` }],
    ['step', { step: { check: 'the first checkbox, not the second' } }],
    ['step', { step: { expect: 'the first checkbox is checked' } }],
  ]],
  ['mcp-dropdown', [
    ['open', { url: `${site}/dropdown` }],
    ['find', { kind: 'select', target: 'the dropdown list' }],
    ['step', { step: { select: { target: 'the dropdown list', value: 'Option 2' } } }],
    ['step', { step: { expect: "the dropdown's selected option is Option 2" } }],
  ]],
  ['mcp-tables', [
    ['open', { url: `${site}/tables` }],
    ['snapshot', { within: 'the first table' }],
  ]],
];

const expected = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, 'utf8')) : {};
const resultsPath = join(vdir, 'results.jsonl');
const errorsPath = join(vdir, 'errors.jsonl');
const done = new Set();
if (existsSync(resultsPath)) {
  for (const line of readFileSync(resultsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      done.add(`${r.prompt_id}\0${r.rep}`);
    } catch {}
  }
}
for (const p of [resultsPath, errorsPath]) {
  if (existsSync(p) && !readFileSync(p, 'utf8').endsWith('\n') && readFileSync(p).length) appendFileSync(p, '\n');
}

// A Jev API or site outage is not a step result. Matched on the step detail of an errored step.
// Kept narrow on purpose: a real step failure dropped as plumbing would hide a regression.
const SERVING = /\b(?:429|50[0-4]) (?:status|Too Many|Internal|Bad Gateway|Service Unavailable|Gateway)|Too Many Requests|rate.?limit|overloaded|Connection error|ECONN(?:RESET|REFUSED)|EAI_AGAIN|fetch failed|socket hang up|requires \w+_API_KEY/i;
const SITE = /net::ERR_|Navigation timeout|ERR_NAME_NOT_RESOLVED/i;

const s = (ms) => Math.round(ms) / 1000;
const sameStatus = (id, got) => {
  const want = expected[id];
  return want && JSON.stringify(want) === JSON.stringify(got) ? 1 : 0;
};

function writeRow(row, trace) {
  appendFileSync(resultsPath, JSON.stringify(row) + '\n');
  writeFileSync(join(vdir, 'traces', `${row.prompt_id}_rep${row.rep}.json`), JSON.stringify(trace, null, 2));
}
function writeError(id, rep, failure_class, error) {
  appendFileSync(errorsPath, JSON.stringify({ prompt_id: id, rep, failure_class, error: String(error).slice(0, 2000) }) + '\n');
  console.error(`  ${id} rep${rep} not scored (${failure_class}): ${String(error).split('\n')[0].slice(0, 200)}`);
}

// --- spec runs ------------------------------------------------------------------------------------

function run(cmd, args) {
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      res({ code, signal, stdout, stderr });
    });
  });
}

const STEP_STATUS = { '✔': 'pass', '?': 'inconclusive', '»': 'skipped', '✘': 'fail' };

// Splits the CLI's --timing output into one block per spec, in input order (one worker).
function parseSpecs(stdout) {
  const specs = [];
  let cur = null;
  let step = null;
  for (const line of stdout.split('\n')) {
    let m;
    if ((m = /^(✔|✘|\?|») (.*?)(?:  \((\d+) Jev calls, (\d+) tokens\))?$/.exec(line))) {
      cur = { status: STEP_STATUS[m[1]], name: m[2], jevCalls: Number(m[3] ?? 0), tokens: Number(m[4] ?? 0), steps: [], error: null };
      specs.push(cur);
      step = null;
    } else if (cur && (m = /^  error: (.*)$/.exec(line))) {
      cur.error = m[1];
    } else if (cur && (m = /^  (✔|✘|\?|») (.*)$/.exec(line))) {
      step = { status: STEP_STATUS[m[1]], text: m[2], ms: null };
      cur.steps.push(step);
    } else if (step && (m = /^    ms (.*)$/.exec(line))) {
      step.ms = Object.fromEntries(m[1].split(' ').map((kv) => kv.split('=')).map(([k, v]) => [k, Number(v)]));
    }
  }
  return specs;
}

const PHASES = ['settle', 'jev', 'post', 'snapshot', 'candidates', 'reasked', 'idle'];

async function specRep(rep, recordExpected) {
  const ids = specFiles.map((f) => f.replace(/\.yaml$/, ''));
  if (!recordExpected && ids.every((id) => done.has(`${id}\0${rep}`))) return;
  const started = Date.now();
  const res = await run('node', [values.cli, '--headless', '--timing', ...specFiles.map((f) => `examples/${f}`)]);
  const wall = Date.now() - started;
  const specs = parseSpecs(res.stdout);
  if (res.signal || specs.length !== specFiles.length) {
    const why = res.signal ? `killed by ${res.signal} after ${wall} ms` : `parsed ${specs.length} of ${specFiles.length} specs (exit ${res.code})`;
    for (const id of ids) if (!done.has(`${id}\0${rep}`)) writeError(id, rep, res.signal ? 'timeout' : 'harness_error', `${why}\n${res.stderr.slice(-1500)}`);
    return;
  }
  specs.forEach((spec, i) => {
    const id = ids[i];
    const got = { status: spec.error ? 'error' : spec.status, steps: spec.steps.map((st) => st.status) };
    if (recordExpected) expected[id] = got;
    if (done.has(`${id}\0${rep}`)) return;
    const badDetail = spec.error ?? spec.steps.find((st) => st.status === 'fail' && (SERVING.test(st.text) || SITE.test(st.text)))?.text;
    if (badDetail && (SERVING.test(badDetail) || SITE.test(badDetail))) {
      writeError(id, rep, SERVING.test(badDetail) ? 'serving_error' : 'site_error', badDetail);
      return;
    }
    const sum = {};
    let skippedMs = 0;
    for (const st of spec.steps) {
      if (!st.ms) continue;
      if (st.status === 'skipped') {
        skippedMs += st.ms.total ?? 0;
        continue;
      }
      for (const [k, v] of Object.entries(st.ms)) if (k !== 'polls') sum[k] = (sum[k] ?? 0) + v;
    }
    // `idle` is the page's own delay seen by a wait (the demo's 5 s loader), not plain's work.
    const overhead = (sum.total ?? 0) - (sum.action ?? 0) - (sum.idle ?? 0);
    const yaml = readFileSync(`examples/${specFiles[i]}`, 'utf8');
    writeRow({
      prompt_id: id, rep, prompt: yaml, tags: ['spec', `${spec.steps.length} steps`], status: 'ok', stop_reason: null,
      grade: { overhead_s: s(overhead), same_status: sameStatus(id, got) },
      overhead_s: s(overhead), total_s: s(sum.total ?? 0), action_s: s(sum.action ?? 0), skipped_s: s(skippedMs),
      settle_s: s(sum.settle ?? 0), jev_s: s(sum.jev ?? 0), post_s: s(sum.post ?? 0), snapshot_s: s(sum.snapshot ?? 0),
      candidates_s: s(sum.candidates ?? 0), idle_s: s(sum.idle ?? 0), reasked: sum.reasked ?? 0,
      meta: { status: got, jev_calls: spec.jevCalls, jev_tokens: spec.tokens, rep_wall_s: s(wall), cli: values.cli },
    }, [
      { role: 'user', content: yaml },
      ...spec.steps.flatMap((st) => [
        { role: 'tool_call', name: st.status, content: st.text },
        { role: 'tool_result', content: JSON.stringify(st.ms ?? {}) },
      ]),
      { role: 'assistant', content: `spec ${got.status}; expected ${JSON.stringify(expected[id] ?? null)}` },
    ]);
  });
  console.error(`spec rep ${rep}: ${specs.length} specs, wall ${s(wall)} s`);
}

// --- MCP session ----------------------------------------------------------------------------------

async function mcpRep(rep, recordExpected) {
  if (!recordExpected && MCP_GROUPS.every(([id]) => done.has(`${id}\0${rep}`))) return;
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: 'node', args: [values.cli, '--headless', 'mcp'], stderr: 'ignore' });
  const client = new Client({ name: 'eval-browser-steps', version: '1.0.0' });
  const groups = [];
  let failure = null;
  const ceiling = setTimeout(() => {
    failure = { cls: 'timeout', error: `MCP session exceeded ${values['timeout-s']} s` };
    transport.close().catch(() => {});
  }, timeoutMs);
  try {
    await client.connect(transport);
    for (const [id, calls] of MCP_GROUPS) {
      const out = [];
      for (const [name, args] of calls) {
        const t = performance.now();
        const res = await client.callTool({ name, arguments: args });
        const ms = performance.now() - t;
        const text = res.content?.[0]?.text ?? '';
        const status = res.isError ? 'error' : (/"status":\s*"(\w+)"/.exec(text)?.[1] ?? 'ok');
        out.push({ name, args, ms, status, text });
        if (gap) await new Promise((r) => setTimeout(r, gap));
      }
      groups.push([id, out]);
    }
  } catch (error) {
    failure ??= { cls: 'harness_error', error: error?.stack ?? String(error) };
  } finally {
    clearTimeout(ceiling);
    await client.close().catch(() => {});
  }
  for (const [id, out] of groups) {
    const got = { calls: out.map((c) => c.status) };
    if (recordExpected) expected[id] = got;
    if (done.has(`${id}\0${rep}`)) continue;
    const bad = out.find((c) => c.status === 'error' && (SERVING.test(c.text) || SITE.test(c.text)));
    if (bad) {
      writeError(id, rep, SERVING.test(bad.text) ? 'serving_error' : 'site_error', bad.text);
      continue;
    }
    const tool = out.reduce((t, c) => t + c.ms, 0);
    const overhead = out.filter((c) => c.name !== 'open').reduce((t, c) => t + c.ms, 0);
    writeRow({
      prompt_id: id, rep, prompt: out.map((c) => `${c.name} ${JSON.stringify(c.args)}`).join('\n'), tags: ['mcp', `${out.length} calls`],
      status: 'ok', stop_reason: null,
      grade: { overhead_s: s(overhead), same_status: sameStatus(id, got) },
      overhead_s: s(overhead), total_s: s(tool), open_s: s(tool - overhead), tool_calls: out.length,
      meta: { status: got, per_call_ms: out.map((c) => `${c.name}:${Math.round(c.ms)}`), gap_ms: gap, cli: values.cli },
    }, out.flatMap((c) => [
      { role: 'tool_call', name: c.name, content: JSON.stringify(c.args, null, 2) },
      { role: 'tool_result', content: `${Math.round(c.ms)} ms, ${c.status}\n${c.text.slice(0, 4000)}` },
    ]));
  }
  for (const [id] of MCP_GROUPS.slice(groups.length)) {
    if (!done.has(`${id}\0${rep}`)) writeError(id, rep, failure?.cls ?? 'harness_error', failure?.error ?? 'session ended early');
  }
  console.error(`mcp rep ${rep}: ${groups.length} of ${MCP_GROUPS.length} groups${failure ? ` (${failure.cls})` : ''}`);
}

// --- main -----------------------------------------------------------------------------------------

const specReps = Number(values.reps);
const mcpReps = Number(values['mcp-reps']);
for (let rep = 0; rep < specReps && values.only !== 'mcp'; rep++) await specRep(rep, values['write-expected'] && rep === 0);
for (let rep = 0; rep < mcpReps && values.only !== 'spec'; rep++) await mcpRep(rep, values['write-expected'] && rep === 0);
if (values['write-expected']) {
  writeFileSync(expectedPath, JSON.stringify(expected, null, 2) + '\n');
  console.error(`wrote ${expectedPath}: review it, then run with --approve-harness`);
}

// Summary: suite overhead per rep (sum over cases), median and range, and the same-status rate.
const rows = existsSync(resultsPath) ? readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const errors = existsSync(errorsPath) ? readFileSync(errorsPath, 'utf8').split('\n').filter(Boolean).length : 0;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function suite(rs, tag) {
  const byRep = {};
  for (const r of rs.filter((r) => r.tags[0] === tag)) byRep[r.rep] = (byRep[r.rep] ?? 0) + r.overhead_s;
  const xs = Object.values(byRep);
  return xs.length ? { median: Math.round(median(xs) * 1000) / 1000, min: Math.min(...xs), max: Math.max(...xs), reps: xs.length } : null;
}
const same = rows.filter((r) => r.grade.same_status === 1).length;
const summary = { variant: values.variant, spec: suite(rows, 'spec'), mcp: suite(rows, 'mcp'), same_status: `${same}/${rows.length}`, errors };
const baseRows = values.variant !== 'baseline' && existsSync(join(flow, 'baseline', 'results.jsonl'))
  ? readFileSync(join(flow, 'baseline', 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : null;
if (baseRows) {
  for (const tag of ['spec', 'mcp']) {
    const b = suite(baseRows, tag);
    if (b && summary[tag]) summary[tag].vs_baseline = `${(((summary[tag].median - b.median) / b.median) * 100).toFixed(1)}% (baseline ${b.median} s, ${b.min}–${b.max})`;
  }
}
writeFileSync(join(vdir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
