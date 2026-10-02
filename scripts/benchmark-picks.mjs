#!/usr/bin/env node
// Pick benchmark: asks every target in scripts/pick-cases.json against its saved candidate list
// (scripts/pick-states/), with the live Jev model through the real pickElements, with and without the
// flow's goal. Saved pages keep the input fixed, so a change in the numbers is a change in the asking.
// Reports right / wrong (accepted but not an expected id) / inconclusive per case type, and tokens.
//
//   node scripts/benchmark-picks.mjs [--runs 1] [--goal both|on|off] [--only <substring>] [--out result.json]
//
// Needs a Jev key. Build first (npm run build).
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadEnvFiles, pickElements, decide } from '../dist/jev/jev.js';

const { values } = parseArgs({ options: { runs: { type: 'string', default: '1' }, goal: { type: 'string', default: 'both' }, only: { type: 'string' }, out: { type: 'string' } } });
loadEnvFiles();
const cases = JSON.parse(readFileSync(new URL('./pick-cases.json', import.meta.url))).cases
  .filter((c) => !values.only || `${c.page} ${c.target}`.toLowerCase().includes(values.only.toLowerCase()));
const pages = {};
const page = (name) => (pages[name] ??= JSON.parse(readFileSync(new URL(`./pick-states/${name}.json`, import.meta.url))));
const modes = values.goal === 'both' ? ['off', 'on'] : [values.goal];

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
  return out;
}

const jobs = [];
for (let run = 0; run < Number(values.runs); run++) for (const c of cases) for (const mode of modes) jobs.push({ run, c, mode });
const results = await mapLimit(jobs, 6, async ({ run, c, mode }) => {
  const state = page(c.page);
  try {
    const [p] = await pickElements(state.candidates, [c.target], { url: state.url, title: state.title, ...(mode === 'on' ? { goal: c.goal } : {}) });
    const score = p.confidence ?? p.probability;
    const accepted = p.id !== null && decide(score, 'pick') === 'pass';
    const outcome = c.expect.length === 0 ? (accepted ? 'wrong' : 'right') : !accepted ? 'inconclusive' : c.expect.includes(p.id) ? 'right' : 'wrong';
    return { run, mode, ...c, outcome, id: p.id, score, tokens: p.tokens };
  } catch (err) {
    return { run, mode, ...c, outcome: 'error', error: String(err).slice(0, 200), tokens: 0 };
  }
});

const rows = {};
for (const r of results) for (const key of [`${r.mode} all`, `${r.mode} ${r.type}`]) {
  const x = (rows[key] ??= { n: 0, right: 0, wrong: 0, inconclusive: 0, error: 0, tokens: 0 });
  x.n++; x[r.outcome]++; x.tokens += r.tokens;
}
console.log('goal type         n   right  wrong  inconclusive  error  tokens/pick');
for (const [k, x] of Object.entries(rows).sort()) {
  const [mode, type] = k.split(' ');
  console.log(`${mode.padEnd(4)} ${type.padEnd(10)} ${String(x.n).padStart(4)} ${String(x.right).padStart(7)} ${String(x.wrong).padStart(6)} ${String(x.inconclusive).padStart(13)} ${String(x.error).padStart(6)} ${String(Math.round(x.tokens / x.n)).padStart(12)}`);
}
const bad = results.filter((r) => r.outcome !== 'right');
if (bad.length) console.log('\nNot right:');
for (const r of bad) console.log(`  goal ${r.mode} ${r.outcome.padEnd(12)} ${r.page} "${r.target}" → ${r.id ?? r.error ?? 'none'}${r.score === undefined ? '' : ` (${r.score.toFixed(2)})`}`);
if (values.out) writeFileSync(values.out, JSON.stringify(results, null, 1));
