#!/usr/bin/env node
// Planner benchmark: plans every sentence in scripts/planner-cases.json with the live Jev model and
// compares the plan with the expected one. Reports the pass rate, the failures, and tokens per case.
// Change the planner only when the pass rate goes up; --runs N shows cases whose answer flips.
//
//   node scripts/benchmark-planner.mjs [--runs 1] [--only <substring>] [--out result.json] [--compare base.json]
//
// Needs a Jev key. Build first (npm run build).
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadEnvFiles } from '../dist/jev.js';
import { plan } from '../dist/planner.js';

const { values } = parseArgs({ options: { runs: { type: 'string', default: '1' }, only: { type: 'string' }, out: { type: 'string' }, compare: { type: 'string' } } });
loadEnvFiles();
const cases = JSON.parse(readFileSync(new URL('./planner-cases.json', import.meta.url))).cases
  .filter((c) => !values.only || c.say.toLowerCase().includes(values.only.toLowerCase()));

const norm = (s) => String(s).toLowerCase().trim().replace(/[.?!,;]+$/, '').replace(/^the\s+/, '').replace(/\s+/g, ' ');
const same = (want, got) => (Array.isArray(want) ? want : [want]).some((w) => w === '*' ? got !== undefined : norm(w) === norm(got));

// A plan item as a comparable tuple, in the case file's shape.
function tuple(item) {
  if (item.kind === 'unknown') return ['unknown', item.reason]; // the reason is shown, never compared
  if (item.kind !== 'step') return item.kind === 'open' ? ['open', item.app] : item.kind === 'ask' ? ['ask', item.claim] : [item.kind];
  const [kind, arg] = Object.entries(item.step)[0];
  if (kind === 'fill') return ['fill', arg.target, arg.value];
  if (kind === 'scroll') { const [dir, ...area] = arg.split(':'); return ['scroll', dir, area.join(':').trim()]; }
  return [kind, arg];
}
const matches = (want, got) => want.length === got.length && want.every((w, i) => w[0] === got[i][0] && w.slice(1).every((x, j) => same(x, got[i][j + 1])));

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
  return out;
}

const runs = Number(values.runs);
const results = await mapLimit(cases, 4, async (c) => {
  const tries = [];
  for (let r = 0; r < runs; r++) {
    try { const { items, tokens } = await plan(c.say); tries.push({ got: items.map(tuple), tokens }); }
    catch (error) { tries.push({ got: [['error', String(error)]], tokens: 0 }); }
  }
  return { say: c.say, want: c.plan, tries, passes: tries.filter((t) => matches(c.plan, t.got)).length };
});

const total = results.length * runs;
const passed = results.reduce((n, r) => n + r.passes, 0);
const tokens = results.flatMap((r) => r.tries.map((t) => t.tokens));
for (const r of results.filter((r) => r.passes < runs)) {
  console.log(`✘ ${r.passes}/${runs}  ${r.say}`);
  console.log(`    want ${JSON.stringify(r.want)}`);
  for (const t of r.tries.filter((t) => !matches(r.want, t.got))) console.log(`    got  ${JSON.stringify(t.got)}`);
}
const rate = passed / total;
console.log(`\npass ${passed}/${total} (${(rate * 100).toFixed(1)}%), median ${tokens.sort((a, b) => a - b)[tokens.length >> 1]} tokens per sentence`);
if (values.compare) {
  const base = JSON.parse(readFileSync(values.compare, 'utf8'));
  console.log(`base ${(base.rate * 100).toFixed(1)}% → ${(rate * 100).toFixed(1)}% (${rate >= base.rate ? '+' : ''}${((rate - base.rate) * 100).toFixed(1)} points)`);
}
if (values.out) writeFileSync(values.out, JSON.stringify({ rate, passed, total, results }, null, 1));
