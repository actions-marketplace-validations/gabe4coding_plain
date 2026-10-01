#!/usr/bin/env node
// Offline read benchmark: the MCP `read` tool (src/read.ts) against `snapshot {mode:"smart", intent}` on saved
// pages (scripts/read-states/, refresh with capture-read-states.mjs) and questions with known answers
// (scripts/read-cases.json). A case is right when every expected string is in what the tool returned, or,
// for a `none` case, when read says not found. Reports Jev tokens and the characters an agent has to read.
//   node scripts/benchmark-read.mjs [--runs 1] [--only <page>] [--smart] [--labels short|full] [--dedupe on|off] [--out result.json]
// Needs a Jev key. Build first (npm run build).
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadEnvFiles } from '../dist/jev.js';
import { readAnswer, readOptions } from '../dist/read.js';
import { snapshotView } from '../dist/snapshot-view.js';
import { markUnchecked } from '../dist/page.js';

loadEnvFiles();
const { values } = parseArgs({ options: { runs: { type: 'string', default: '1' }, only: { type: 'string' }, smart: { type: 'boolean', default: false }, labels: { type: 'string', default: 'short' }, dedupe: { type: 'string', default: 'on' }, out: { type: 'string' } } });
readOptions.labels = values.labels;
readOptions.dedupe = values.dedupe === 'on';
const cases = JSON.parse(readFileSync(new URL('read-cases.json', import.meta.url), 'utf8')).filter((c) => !values.only || c.page === values.only);
// The same tree a live snapshot() gives now, also for pages saved before a change to it (it is idempotent).
const state = (page) => {
  const snap = JSON.parse(readFileSync(new URL(`read-states/${page}.json`, import.meta.url), 'utf8'));
  return { ...snap, aria: markUnchecked(snap.aria) };
};
const has = (text, c) => c.none ? false : c.expect.every((e) => text.includes(e));

const results = [];
await Promise.all(Array.from({ length: Number(values.runs) }, (_, run) => Promise.all(cases.map(async (c) => {
  const snap = state(c.page);
  const t = Date.now();
  const r = await readAnswer(snap, c.question).catch((err) => ({ error: String(err) }));
  const readMs = Date.now() - t;
  const text = r.found ? [...(r.context ?? []), r.answer].join('\n') : '';
  const row = { run, page: c.page, question: c.question, none: !!c.none,
    read: { right: c.none ? r.found === false : !!r.found && has(text, c), found: r.found, confidence: r.confidence, tokens: r.tokens ?? 0, chars: text.length, ms: readMs, scanned: r.scanned, error: r.error, answer: text.slice(0, 300), guesses: r.guesses } };
  if (values.smart) {
    const v = await snapshotView(snap, { mode: 'smart', intent: c.question }).catch((err) => ({ error: String(err) }));
    const aria = v.observed?.aria ?? '';
    row.smart = { right: c.none ? null : has(aria, c), tokens: v.jevTokens ?? 0, chars: aria.length, error: v.error };
  }
  results.push(row);
}))));

const sum = (rows, f) => rows.reduce((a, r) => a + f(r), 0);
const answerable = results.filter((r) => !r.none);
console.log(`read:  ${sum(results, (r) => r.read.right)}/${results.length} right (${sum(answerable, (r) => r.read.right)}/${answerable.length} answerable, ${sum(results.filter((r) => r.none), (r) => r.read.right)}/${results.filter((r) => r.none).length} none)` +
  `  jev ${Math.round(sum(results, (r) => r.read.tokens) / results.length)} tok/q  agent reads ${Math.round(sum(results, (r) => r.read.chars) / results.length)} chars/q  ${Math.round(sum(results, (r) => r.read.ms) / results.length)} ms/q`);
if (values.smart) console.log(`smart: ${sum(answerable, (r) => r.smart.right)}/${answerable.length} answerable contain the answer  jev ${Math.round(sum(results, (r) => r.smart.tokens) / results.length)} tok/q  agent reads ${Math.round(sum(results, (r) => r.smart.chars) / results.length)} chars/q`);
for (const r of results.filter((x) => !x.read.right)) console.log(`  MISS ${r.page}: ${r.question}\n       found=${r.read.found} conf=${r.read.confidence?.toFixed?.(2)} ${r.read.error ?? JSON.stringify(r.read.answer ?? '').slice(0, 200)} ${r.read.guesses ? JSON.stringify(r.read.guesses).slice(0, 200) : ''}`);
if (values.out) writeFileSync(values.out, JSON.stringify(results, null, 1));
