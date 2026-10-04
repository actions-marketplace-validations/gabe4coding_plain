#!/usr/bin/env node
// Pick-cache safety benchmark on a stale-page set. Each saved page in scripts/pick-states/ is the "before"
// state; code changes it the way a site changes between runs (a row added or removed, the targets moved,
// renamed, duplicated, a field's value or a row's context changed) to make the "after" states, and
// "unchanged" is the same page again. Three small built-in pages add the changes the saved pages lack: a
// button identified by its value (Subscribe → Unsubscribe), a newer row that fits the target better, and a
// dialog over the page. For every target: Jev picks on "before" (the run that wrote the cache); the
// accepted high-confidence pick becomes the entry (src/core/pick-cache.ts makeEntry); the lookup runs on "after" (matchEntry). Every
// hit is checked against a fresh Jev pick on "after":
//   right        the fresh pick accepts the same element
//   wrong        the fresh pick accepts another element or says none, or the hit is another element
//   unconfirmed  the fresh pick accepts nothing above the threshold: the cache acted where Jev would not
// Pass bar: 0 wrong and 0 unconfirmed hits, and every unsafe change misses. Misses need no fresh pick.
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
import { loadEnvFiles } from '../dist/jev/provider.js';
import { pickElements } from '../dist/jev/pick.js';
import { decide } from '../dist/jev/decide.js';
import { makeEntry, matchEntry } from '../dist/core/pick-cache.js';

const { values } = parseArgs({ options: { runs: { type: 'string', default: '1' }, goal: { type: 'string', default: 'on' },
  skip: { type: 'string', multiple: true }, only: { type: 'string' }, out: { type: 'string' } } });
loadEnvFiles();
const skip = new Set(values.skip ?? []);
const keep = (page) => !skip.has(page) && (!values.only || page.includes(values.only));

// Saved states predate `editable`: mark text-entry fields the way candidates.ts does (no type or a text type).
const TEXT_TYPES = new Set(['text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date', 'datetime-local', 'month', 'time', 'week']);
const editable = (desc) => {
  const m = /^(?:\[iframe [^\]]*\] )?(textarea|input)(?:\[type=([^\]]+)\])?/.exec(desc);
  return !!m && (m[1] === 'textarea' || m[2] === undefined || TEXT_TYPES.has(m[2].toLowerCase()));
};
const withEditable = (candidates) => candidates.map((c) => (editable(c.desc) ? { ...c, editable: true } : c));
const list = (...descs) => descs.map((desc, id) => ({ id, desc }));

const pages = Object.fromEntries(readdirSync(new URL('./pick-states/', import.meta.url)).filter((f) => f.endsWith('.json'))
  .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(new URL(`./pick-states/${f}`, import.meta.url)))]));
const cases = JSON.parse(readFileSync(new URL('./pick-cases.json', import.meta.url))).cases.filter((c) => c.expect.length && keep(c.page));

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
  unchanged: { safe: true, apply: (items) => items },
  'row-added': { safe: true, apply: (items) => [{ key: 'new', desc: 'a "Sponsored: example.org" href=/item context: tr text="Sponsored: example.org | 2 points"' }, ...items] },
  'row-removed': { safe: true, apply: (items, targets) => { const i = items.findIndex((it) => !targets.has(it.key)); return items.filter((_, j) => j !== i); } },
  moved: { safe: true, apply: (items, targets) => [...items.filter((it) => !targets.has(it.key)), ...items.filter((it) => targets.has(it.key))] },
  'value-changed': { safe: true, kinds: ['fill'], apply: (items, targets) => items.map((it) => !targets.has(it.key) ? it
    : { ...it, desc: / value="[^"]*"/.test(it.desc) ? it.desc.replace(/ value="[^"]*"/, ' value="changed"') : it.desc.replace(/^(\S+)/, '$1 value="typed by the test"') }) },
  renamed: { safe: false, apply: (items, targets) => items.map((it) => targets.has(it.key) ? { ...it, desc: renameFirstQuoted(it.desc) } : it) },
  duplicate: { safe: false, apply: (items, targets) => items.flatMap((it) => targets.has(it.key) ? [it, { key: `${it.key}-copy`, desc: it.desc }] : [it]) },
  context: { safe: false, apply: (items, targets) => items.map((it) => targets.has(it.key) && it.desc.includes(' context: ')
    ? { ...it, desc: it.desc.replace(/ context: .*$/, ' context: tr text="another row"') } : it) },
  'layout-changed': { safe: false, apply: (items) => {
    const positioned = items.filter((item) => item.bounds);
    if (positioned.length < 2) return items;
    return items.map((item) => item === positioned[0] ? { ...item, bounds: positioned[1].bounds }
      : item === positioned[1] ? { ...item, bounds: positioned[0].bounds } : item);
  } },
  'reference-changed': { safe: false, apply: (items) => items, updateState: (state) => {
    const before = pages['spatial-reference'], after = pages['spatial-reference-moved'];
    if (!before || !after) return state;
    const layout = state.layout === before.layout ? after.layout : state.layout === after.layout ? before.layout : undefined;
    return layout === undefined ? state : { ...state, layout };
  } },
};

// Built-in pages: each has one change, unsafe by construction (the right element is another one, or covered).
const BUILT_IN = [
  { name: 'value-button', kind: 'click', url: 'https://news.test/newsletter', title: 'Newsletter',
    before: list('a "Home" href=/', 'input[type=submit] value="Subscribe" context: form heading="Newsletter"', 'a "Privacy" href=/privacy'),
    target: 'the Subscribe button', goal: 'subscribe to the newsletter', expect: [1],
    change: 'value-label', after: (items) => items.map((it) => it.key === 1 ? { ...it, desc: it.desc.replace('Subscribe', 'Unsubscribe') } : it) },
  { name: 'newest-order', kind: 'click', url: 'https://shop.test/orders', title: 'Your orders',
    before: list('a "Home" href=/', 'a "View" href=/orders/1234 context: tr text="Order 1234 · 2 items · shipped yesterday"',
      'a "View" href=/orders/1233 context: tr text="Order 1233 · 1 item · delivered last week"'),
    target: "the newest order's View link", goal: 'check the newest order', expect: [1],
    change: 'better-row', after: (items) => [items[0], { key: 'new', desc: 'a "View" href=/orders/1235 context: tr text="Order 1235 · 3 items · placed today"' }, ...items.slice(1)] },
  { name: 'dialog-overlay', kind: 'click', url: 'https://shop.test/mug', title: 'Blue mug',
    before: list('a "Home" href=/', 'button "Add to cart" context: article heading="Blue mug"', 'a "Reviews" href=/mug/reviews'),
    target: 'the Add to cart button', goal: 'buy the blue mug', expect: [1],
    change: 'dialog', after: (items) => [{ key: 'd1', desc: 'button "Accept all" context: dialog heading="We use cookies"' },
      { key: 'd2', desc: 'button "Reject all" context: dialog heading="We use cookies"' }, ...items] },
].filter((b) => keep(b.name));

const accepted = (p) => p.id !== null && decide(p.confidence ?? p.probability, 'pick') === 'pass';
let tokens = 0, requests = 0;
async function pick(candidates, targets, state, goal) {
  requests++;
  const picks = await pickElements(candidates, targets, { url: state.url, title: state.title,
    ...(state.layout ? { layout: state.layout } : {}), ...(goal ? { goal } : {}) });
  for (const p of picks) tokens += p.tokens;
  return picks;
}
const sameList = (a, b) => a.length === b.length && a.every((c, i) => c.desc === b[i].desc &&
  JSON.stringify(c.bounds) === JSON.stringify(b[i].bounds));

// One group: a "before" page, its targets, and the changes to try on it.
const useGoal = values.goal !== 'off';
const groups = [
  ...Object.values(Object.groupBy(cases, (c) => `${c.page}|${useGoal ? c.goal : ''}`)).map((cs) => ({
    name: cs[0].page, state: pages[cs[0].page], cases: cs, goal: useGoal ? cs[0].goal : undefined,
    changes: Object.entries(CHANGES).filter(([, spec]) => !spec.kinds || spec.kinds.includes(pages[cs[0].page].kind))
      .map(([change, spec]) => ({ change, safe: spec.safe, apply: spec.apply, updateState: spec.updateState })),
  })),
  ...BUILT_IN.map((b) => ({ name: b.name, state: { url: b.url, title: b.title, kind: b.kind, candidates: b.before },
    cases: [{ target: b.target, expect: b.expect }], goal: useGoal ? b.goal : undefined,
    changes: [{ change: b.change, safe: false, apply: b.after }] })),
];

const rows = [];
for (let run = 0; run < Number(values.runs); run++) {
  for (const group of groups) {
    const { name, state, goal } = group;
    const before = withEditable(state.candidates);
    if (run === 0 && renumber(before.map((c) => c.desc)).some((d, i) => d !== before[i].desc))
      console.error(`${name}: saved ordinals differ from the renumbering rule; changes renumber the whole list`);
    const picked = await pick(before, group.cases.map((c) => c.target), state, goal);
    const entries = group.cases.map((c, i) => {
      const p = picked[i];
      if (!accepted(p)) return { c, status: 'before-rejected' };
      const entry = makeEntry(before.find((x) => x.id === p.id), before, state, p.confidence ?? p.probability);
      return entry ? { c, entry, picked: p.id, score: p.confidence ?? p.probability } : { c, status: 'not-stored', picked: p.id };
    });
    const stored = entries.filter((e) => e.entry);
    for (const e of entries.filter((e) => !e.entry)) rows.push({ run, page: name, target: e.c.target, change: '-', outcome: e.status });
    for (const { change, safe, apply, updateState } of group.changes) {
      const items = apply(before.map((c) => ({ key: c.id, desc: c.desc, ...(c.bounds ? { bounds: c.bounds } : {}) })), new Set(stored.map((e) => e.picked)));
      const after = withEditable(renumber(items.map((it) => it.desc)).map((desc, id) => ({ id, desc,
        ...(items[id].bounds ? { bounds: items[id].bounds } : {}) })));
      const afterState = updateState ? updateState(state) : state;
      if (change !== 'unchanged' && sameList(after, before) && state.layout === afterState.layout) continue;
      const looked = stored.map((e) => ({ e, hit: matchEntry(e.entry, after, afterState) }));
      const hits = looked.filter((l) => l.hit);
      const fresh = hits.length ? await pick(after, hits.map((l) => l.e.c.target), afterState, goal) : [];
      for (const l of looked) {
        const row = { run, page: name, target: l.e.c.target, change, safe, beforeScore: l.e.score };
        if (!l.hit) { rows.push({ ...row, outcome: 'miss' }); continue; }
        const p = fresh[hits.indexOf(l)];
        // The hit must name the element the entry was made from (same identity key) and the fresh pick must agree.
        const sameElement = items[l.hit.id].key === l.e.picked;
        const outcome = !sameElement ? 'wrong' : !accepted(p) ? (p.id === null ? 'wrong' : 'unconfirmed') : p.id === l.hit.id ? 'right' : 'wrong';
        rows.push({ ...row, outcome, expected: l.e.c.expect.includes(items[l.hit.id].key), hit: l.hit.id, fresh: p.id, score: p.confidence ?? p.probability });
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
const failed = rows.filter((r) => r.outcome === 'wrong' || r.outcome === 'unconfirmed');
console.log(`\nwrong or unconfirmed hits: ${failed.length} (bar: 0); unsafe changes that hit: ${unsafeHits.length} (bar: 0); Jev requests: ${requests}, tokens: ${tokens}`);
for (const r of [...new Set([...failed, ...unsafeHits])]) console.log(`  ${r.outcome} ${r.change} ${r.page} "${r.target}" hit=${r.hit} fresh=${r.fresh}${r.score === undefined ? '' : ` (${r.score.toFixed(2)})`}`);
if (values.out) writeFileSync(values.out, JSON.stringify({ requests, tokens, rows }, null, 1));
process.exitCode = failed.length || unsafeHits.length ? 1 : 0;
