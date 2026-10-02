#!/usr/bin/env node
// Pick-cache safety benchmark on a stale-page set. Each saved page in scripts/pick-states/ is the "before"
// state; code changes it the way a site changes between runs (a row added or removed, the targets moved,
// renamed, duplicated, a field's value or a row's context changed) to make the "after" states. For every
// target of scripts/pick-cases.json: Jev picks on "before" (the run that wrote the cache); the accepted pick
// becomes the entry (src/pick-cache.ts makeEntry); the lookup runs on "after" (match). Every hit is then
// checked against a fresh Jev pick on "after":
//   right        the fresh pick accepts the same element
//   wrong        the fresh pick accepts another element or says none, or the hit is another element — bar: 0
//   unconfirmed  the fresh pick accepts nothing above the threshold (reported, not counted as wrong)
// Unsafe changes (renamed, duplicate, context) must always miss. Misses need no fresh pick: Jev picks then.
// Targets are asked with their flow's goal, as a spec with `goal:` asks them (--goal off drops it), one Jev
// request per (page, goal) on "before" and one per (page, goal, change) with hits. A change that leaves the
// page as it was (e.g. "context" on a page whose targets have none) is not counted. `in expect` checks the
// hit against the case's right ids.
//
//   node scripts/benchmark-pick-cache.mjs [--runs 1] [--goal on|off] [--skip turing-click] [--only <page>] [--out result.json]
//
// Needs a Jev key. Build first (npm run build).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadEnvFiles, pickElements, decide } from '../dist/jev.js';
import { makeEntry, match } from '../dist/pick-cache.js';

const { values } = parseArgs({ options: { runs: { type: 'string', default: '1' }, goal: { type: 'string', default: 'on' },
  skip: { type: 'string', multiple: true }, only: { type: 'string' }, out: { type: 'string' } } });
loadEnvFiles();
const skip = new Set(values.skip ?? []);
const cases = JSON.parse(readFileSync(new URL('./pick-cases.json', import.meta.url))).cases.filter((c) => c.expect.length && !skip.has(c.page) && (!values.only || c.page.includes(values.only)));
const pages = Object.fromEntries(readdirSync(new URL('./pick-states/', import.meta.url)).filter((f) => f.endsWith('.json'))
  .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(new URL(`./pick-states/${f}`, import.meta.url)))]));

// candidates.ts: identical base descs (the part before " context: ") get " #n" in list order.
function renumber(descs) {
  const split = descs.map((d) => {
    const at = d.indexOf(' context: ');
    const base = (at < 0 ? d : d.slice(0, at)).replace(/ #\d+$/, '');
    return { base, rest: at < 0 ? '' : d.slice(at) };
  });
  const counts = new Map();
  for (const { base } of split) counts.set(base, (counts.get(base) ?? 0) + 1);
  const seen = new Map();
  return split.map(({ base, rest }) => {
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base}${counts.get(base) > 1 ? ` #${n}` : ''}${rest}`;
  });
}
// A change works on {key, desc} items (key = the element's identity across states) and returns new items.
const renameFirstQuoted = (desc) => desc.replace(/"([^"]*)"/, (_m, text) => `"${text} (renamed)"`);
const CHANGES = {
  'row-added': { safe: true, apply: (items) => [{ key: 'new', desc: 'a "Sponsored: example.org" href=/item context: tr text="Sponsored: example.org | 2 points"' }, ...items] },
  'row-removed': { safe: true, apply: (items, targets) => { const i = items.findIndex((it) => !targets.has(it.key)); return items.filter((_, j) => j !== i); } },
  moved: { safe: true, apply: (items, targets) => [...items.filter((it) => !targets.has(it.key)), ...items.filter((it) => targets.has(it.key))] },
  'value-changed': { safe: true, kinds: ['fill'], apply: (items, targets) => items.map((it) => !targets.has(it.key) ? it
    : { ...it, desc: / value="[^"]*"/.test(it.desc) ? it.desc.replace(/ value="[^"]*"/, ' value="changed"') : it.desc.replace(/^(\S+)/, '$1 value="typed by the test"') }) },
  renamed: { safe: false, apply: (items, targets) => items.map((it) => targets.has(it.key) ? { ...it, desc: renameFirstQuoted(it.desc) } : it) },
  duplicate: { safe: false, apply: (items, targets) => items.flatMap((it) => targets.has(it.key) ? [it, { key: `${it.key}-copy`, desc: it.desc }] : [it]) },
  context: { safe: false, apply: (items, targets) => items.map((it) => targets.has(it.key) && it.desc.includes(' context: ')
    ? { ...it, desc: it.desc.replace(/ context: .*$/, ' context: tr text="another row"') } : it) },
};

function build(state, change, targetIds) {
  const items = state.candidates.map((c) => ({ key: c.id, desc: c.desc }));
  const changed = CHANGES[change].apply(items, new Set(targetIds));
  const descs = renumber(changed.map((it) => it.desc));
  return { candidates: descs.map((desc, id) => ({ id, desc })), keys: changed.map((it) => it.key) };
}
const sameList = (a, b) => a.length === b.length && a.every((c, i) => c.desc === b[i].desc);

const accepted = (p) => p.id !== null && decide(p.confidence ?? p.probability, 'pick') === 'pass';
let tokens = 0, requests = 0;
async function pick(candidates, targets, state, goal) {
  requests++;
  const picks = await pickElements(candidates, targets, { url: state.url, title: state.title, ...(goal ? { goal } : {}) });
  for (const p of picks) tokens += p.tokens;
  return picks;
}

const rows = [];
const useGoal = values.goal !== 'off';
const groups = Object.values(Object.groupBy(cases, (c) => `${c.page}|${useGoal ? c.goal : ''}`));
for (let run = 0; run < Number(values.runs); run++) {
  for (const list of groups) {
    const name = list[0].page, goal = useGoal ? list[0].goal : undefined;
    const state = pages[name];
    if (run === 0 && renumber(state.candidates.map((c) => c.desc)).some((d, i) => d !== state.candidates[i].desc))
      console.error(`${name}: saved ordinals differ from the renumbering rule; changes renumber the whole list`);
    const before = await pick(state.candidates, list.map((c) => c.target), state, goal);
    const entries = list.map((c, i) => {
      const p = before[i];
      if (!accepted(p)) return { c, status: 'before-rejected' };
      const candidate = state.candidates.find((x) => x.id === p.id);
      const entry = makeEntry(candidate, state.candidates, state);
      return entry ? { c, entry, picked: p.id } : { c, status: 'not-stored', picked: p.id };
    });
    const stored = entries.filter((e) => e.entry);
    for (const e of entries.filter((e) => !e.entry)) rows.push({ run, page: name, target: e.c.target, change: '-', outcome: e.status });
    for (const [change, spec] of Object.entries(CHANGES)) {
      if (spec.kinds && !spec.kinds.includes(state.kind)) continue;
      const after = build(state, change, stored.map((e) => e.picked));
      if (sameList(after.candidates, state.candidates)) continue;
      const looked = stored.map((e) => ({ e, hit: match(e.entry, after.candidates, state) }));
      const hits = looked.filter((l) => l.hit);
      const fresh = hits.length ? await pick(after.candidates, hits.map((l) => l.e.c.target), state, goal) : [];
      for (const l of looked) {
        const row = { run, page: name, target: l.e.c.target, change, safe: spec.safe, context: l.e.entry.list === undefined };
        if (!l.hit) { rows.push({ ...row, outcome: 'miss' }); continue; }
        const p = fresh[hits.indexOf(l)];
        // The hit must name the element the entry was made from (same identity key) and the fresh pick must agree.
        const sameElement = after.keys[l.hit.id] === l.e.picked;
        const outcome = !sameElement ? 'wrong' : !accepted(p) ? (p.id === null ? 'wrong' : 'unconfirmed') : p.id === l.hit.id ? 'right' : 'wrong';
        rows.push({ ...row, outcome, expected: l.e.c.expect.includes(after.keys[l.hit.id]), hit: l.hit.id, fresh: p.id, score: p.confidence ?? p.probability });
      }
    }
  }
}

const table = {};
for (const r of rows) {
  const t = (table[r.change] ??= { change: r.change, safe: r.safe, n: 0, right: 0, wrong: 0, unconfirmed: 0, miss: 0, 'not-stored': 0, 'before-rejected': 0, expected: 0 });
  t.n++; t[r.outcome]++; if (r.expected) t.expected++;
}
console.log('change          safe     n  hit-right  wrong  unconfirmed  miss  in-expect  (before: not-stored / rejected)');
for (const t of Object.values(table)) {
  console.log(`${t.change.padEnd(14)} ${String(t.safe ?? '').padEnd(5)} ${String(t.n).padStart(5)} ${String(t.right).padStart(10)} ${String(t.wrong).padStart(6)} ${String(t.unconfirmed).padStart(12)} ${String(t.miss).padStart(5)} ${String(t.expected).padStart(10)}` +
    (t.change === '-' ? `  (${t['not-stored']} / ${t['before-rejected']})` : ''));
}
const unsafeHits = rows.filter((r) => r.safe === false && r.outcome !== 'miss');
const wrong = rows.filter((r) => r.outcome === 'wrong');
console.log(`\nwrong hits: ${wrong.length} (bar: 0); unsafe changes that hit: ${unsafeHits.length} (bar: 0); Jev requests: ${requests}, tokens: ${tokens}`);
for (const r of [...new Set([...wrong, ...unsafeHits])]) console.log(`  ${r.outcome} ${r.change} ${r.page} "${r.target}" hit=${r.hit} fresh=${r.fresh}`);
for (const r of rows.filter((r) => r.outcome === 'unconfirmed')) console.log(`  unconfirmed ${r.change} ${r.page} "${r.target}" hit=${r.hit} fresh=${r.fresh} (${r.score?.toFixed(2)})`);
if (values.out) writeFileSync(values.out, JSON.stringify({ requests, tokens, rows }, null, 1));
process.exitCode = wrong.length || unsafeHits.length ? 1 : 0;
