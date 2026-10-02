#!/usr/bin/env node
// Claim benchmark: judges every claim in scripts/claim-cases.json against its saved page (scripts/claim-states/,
// refresh with capture-claim-states.mjs, or scripts/read-states/) with the live Jev model, through the same
// judgeState and decide() an `expect` step uses. Saved pages keep the input fixed, so a change in the numbers
// is a change in the judging.
//
// The headline is the false pass: a claim that does not hold, judged pass. In a test that is a bug that ships,
// so it must stay 0. A false fail breaks a good run; inconclusive asks for a rephrase or a retry. The margins
// show how close the worst cases came to the thresholds (pass >= 0.9, fail <= 0.1), which moves before the
// counts do. Flips are cases whose decision changed between runs.
//
//   node scripts/benchmark-claims.mjs [--runs 1] [--group single|page] [--only <substring>] [--out result.json] [--compare base.json] [--gate]
//
// --gate: exit 1 on any false pass, or on a Jev error (a claim that was not judged proves nothing). CI runs it.
// --group single: one claim per Jev call, like an `expect` with one claim (default).
// --group page:   all claims of one page (and the same events) in one call, like an `expect` with a list.
// Needs a Jev key. Build first (npm run build).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadEnvFiles } from '../dist/jev/provider.js';
import { decide } from '../dist/jev/decide.js';
import { judgeState } from '../dist/core/automation.js';
import { markUnchecked, shortenUrls } from '../dist/browser/page.js';

const { values } = parseArgs({ options: { gate: { type: 'boolean', default: false }, runs: { type: 'string', default: '1' }, group: { type: 'string', default: 'single' }, only: { type: 'string' }, out: { type: 'string' }, compare: { type: 'string' } } });
if (!['single', 'page'].includes(values.group)) throw new Error('--group must be single or page');
loadEnvFiles();
const cases = JSON.parse(readFileSync(new URL('./claim-cases.json', import.meta.url))).cases
  .map((c, i) => ({ id: i, ...c, events: c.events ?? [] }))
  .filter((c) => !values.only || `${c.page} ${c.type} ${c.claim}`.toLowerCase().includes(values.only.toLowerCase()));
const pages = {};
function page(name) {
  if (pages[name]) return pages[name];
  const file = ['claim-states', 'read-states'].map((dir) => new URL(`./${dir}/${name}.json`, import.meta.url)).find((u) => existsSync(u));
  if (!file) throw new Error(`no saved state for page "${name}" in scripts/claim-states/ or scripts/read-states/`);
  // The same tree a live claim gets now, also for pages saved before a change to it (both are idempotent).
  // A region state (`region: true`) is judged as a `within` region.
  const state = JSON.parse(readFileSync(file));
  return (pages[name] = { ...state, aria: shortenUrls(markUnchecked(state.aria)) });
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
  return out;
}

// A call is the claims one Jev request judges together.
const calls = [];
for (let run = 0; run < Number(values.runs); run++) {
  if (values.group === 'single') for (const c of cases) calls.push({ run, cases: [c] });
  else {
    const byState = new Map();
    for (const c of cases) {
      const key = `${c.page}\n${JSON.stringify(c.events)}`;
      byState.set(key, [...(byState.get(key) ?? []), c]);
    }
    for (const group of byState.values()) calls.push({ run, cases: group });
  }
}

const outcomeOf = (c, decision) => decision === c.expect ? 'right' : decision === 'inconclusive' ? 'inconclusive'
  : decision === 'pass' ? 'falsePass' : 'falseFail';
const results = (await mapLimit(calls, 6, async ({ run, cases: group }) => {
  const t = Date.now();
  try {
    const { probabilities, tokens } = await judgeState(page(group[0].page), group.map((c) => c.claim), group[0].events);
    const ms = Date.now() - t;
    return group.map((c, i) => {
      const decision = decide(probabilities[i], 'expect');
      return { run, ...c, p: probabilities[i], decision, outcome: outcomeOf(c, decision), tokens: tokens / group.length, ms };
    });
  } catch (err) {
    return group.map((c) => ({ run, ...c, outcome: 'error', error: String(err).slice(0, 200), tokens: 0, ms: Date.now() - t }));
  }
})).flat();

function summarize(rows) {
  const x = { n: rows.length, right: 0, falsePass: 0, falseFail: 0, inconclusive: 0, error: 0, tokens: 0, ms: 0 };
  for (const r of rows) { x[r.outcome]++; x.tokens += r.tokens; x.ms += r.ms; }
  const judged = rows.filter((r) => r.p !== undefined);
  const holds = judged.filter((r) => r.expect === 'pass').map((r) => r.p);
  const fails = judged.filter((r) => r.expect === 'fail').map((r) => r.p);
  return { ...x, tokensPerClaim: Math.round(x.tokens / (x.n || 1)), msPerClaim: Math.round(x.ms / (x.n || 1)),
    minPassP: holds.length ? Math.min(...holds) : null, maxFailP: fails.length ? Math.max(...fails) : null };
}
// Same case, different decisions across runs: the judging is not stable on a fixed input.
function flips(rows) {
  const byCase = new Map();
  for (const r of rows) byCase.set(r.id, [...(byCase.get(r.id) ?? []), r]);
  return [...byCase.values()].filter((rs) => new Set(rs.map((r) => r.decision ?? 'error')).size > 1);
}

const total = summarize(results);
const flipped = flips(results);
const f2 = (p) => (p === null || p === undefined ? '   -' : p.toFixed(2));
console.log(`claims: ${total.n} judged (${cases.length} cases × ${values.runs} runs, group ${values.group})`);
console.log(`  FALSE PASS ${total.falsePass}   false fail ${total.falseFail}   inconclusive ${total.inconclusive}   right ${total.right}/${total.n}` +
  `   error ${total.error}   flips ${flipped.length}/${cases.length}`);
console.log(`  margins: lowest p on a claim that holds ${f2(total.minPassP)} (pass needs >= 0.9), highest p on a claim that does not ${f2(total.maxFailP)} (fail needs <= 0.1)`);
console.log(`  jev ${total.tokensPerClaim} tokens/claim, ${total.msPerClaim} ms/claim\n`);

const byType = {};
for (const r of results) (byType[`${r.type} ${r.expect}`] ??= []).push(r);
console.log('type       expect    n  right  falsePass  falseFail  inconclusive  minPassP  maxFailP');
for (const [k, rows] of Object.entries(byType).sort()) {
  const [type, expect] = k.split(' '), x = summarize(rows);
  console.log(`${type.padEnd(10)} ${expect.padEnd(6)} ${String(x.n).padStart(4)} ${String(x.right).padStart(6)} ${String(x.falsePass).padStart(10)} ${String(x.falseFail).padStart(10)} ${String(x.inconclusive).padStart(13)} ${f2(x.minPassP).padStart(9)} ${f2(x.maxFailP).padStart(9)}`);
}

const bad = results.filter((r) => r.outcome !== 'right');
if (bad.length) console.log('\nNot right:');
for (const r of bad.sort((a, b) => a.id - b.id || a.run - b.run)) {
  console.log(`  ${r.outcome.padEnd(12)} ${r.page.padEnd(16)} expect ${r.expect.padEnd(4)} p=${f2(r.p)}  "${r.claim}"${r.error ? ` ${r.error}` : ''}`);
}
if (flipped.length) console.log('\nFlips:');
for (const rs of flipped) console.log(`  ${rs[0].page.padEnd(16)} "${rs[0].claim}" → ${rs.map((r) => `${r.decision ?? 'error'} ${f2(r.p)}`).join(', ')}`);

if (values.compare) {
  const base = JSON.parse(readFileSync(values.compare, 'utf8'));
  const b = summarize(base.results);
  const pct = (x, k) => `${x[k]}/${x.n} (${(100 * x[k] / (x.n || 1)).toFixed(1)}%)`;
  console.log(`\nVs ${values.compare}:`);
  for (const k of ['falsePass', 'falseFail', 'inconclusive', 'right']) console.log(`  ${k.padEnd(14)} ${pct(b, k)} → ${pct(total, k)}`);
  console.log(`  tokens/claim ${b.tokensPerClaim} → ${total.tokensPerClaim}, ms/claim ${b.msPerClaim} → ${total.msPerClaim}`);
  console.log(`  margins: minPassP ${f2(b.minPassP)} → ${f2(total.minPassP)}, maxFailP ${f2(b.maxFailP)} → ${f2(total.maxFailP)}; flips ${flips(base.results).length} → ${flipped.length}`);
  // Per case, the share of runs that were right, so runs counts may differ between the two files.
  const rightShare = (rows) => {
    const m = new Map();
    for (const r of rows) { const s = m.get(r.claim + r.page + JSON.stringify(r.events)) ?? { r: 0, n: 0, c: r }; s.n++; s.r += r.outcome === 'right'; m.set(r.claim + r.page + JSON.stringify(r.events), s); }
    return m;
  };
  const before = rightShare(base.results), after = rightShare(results);
  for (const [k, a] of after) {
    const p = before.get(k);
    if (p && a.r / a.n !== p.r / p.n) console.log(`  ${a.r / a.n > p.r / p.n ? 'better' : 'WORSE '} ${p.r}/${p.n} → ${a.r}/${a.n} right  ${a.c.page} "${a.c.claim}"`);
  }
}
if (values.out) writeFileSync(values.out, JSON.stringify({ group: values.group, runs: Number(values.runs), summary: total, results }, null, 1));
if (values.gate && (total.falsePass || total.error)) {
  console.error(`\nGATE FAILED: ${total.falsePass} false pass(es), ${total.error} error(s). False passes must stay 0.`);
  process.exit(1);
}
