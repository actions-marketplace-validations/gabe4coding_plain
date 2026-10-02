# Pick cache

The pick cache (`src/pick-cache.ts`, [running suites](../running.md#pick-cache)) replays a pick Jev made in
the last passing run when the fresh page has exactly one candidate with the stored description. Two
questions: is a replayed pick ever the wrong element (safety), and how much does it save on a real suite
(cost).

## Safety on stale pages (2026-10-02)

`scripts/benchmark-pick-cache.mjs` takes each saved page in `scripts/pick-states/` as the "before" state and
changes it the way a site changes between runs. For each target of `scripts/pick-cases.json` that has a
right answer, Jev picks on "before" with the flow's goal (the run that wrote the cache); the accepted pick
becomes the entry (`makeEntry`); the lookup runs on "after" (`match`). Every hit is checked against a fresh
Jev pick on "after": **wrong** = the fresh pick accepts another element or `none`, or the hit is not the
element the entry was made from. Misses need no check: Jev picks then.

Changes: **row-added** (a new row at the top: every id moves), **row-removed** (one other element gone),
**moved** (the targets moved to the end of the list), **value-changed** (a field's value, fill page only),
and the unsafe ones that must always miss: **renamed** (the target's text), **duplicate** (a second
identical element: both get ` #n`), **context** (the target's row text changed).

```
node scripts/benchmark-pick-cache.mjs --runs 1 --skip turing-click
node scripts/benchmark-pick-cache.mjs --runs 1 --only login-fill      # value-changed (the only fill page)
```

34 targets on 10 pages (`turing-click`, 1,016 candidates at the cap, skipped for cost); 27 were stored,
7 were not: 4 picks Jev did not accept on "before", 3 picks of one of several identical elements (` #n`).

| Change | Safe | Targets | Hit, right | Wrong | Unconfirmed | Miss |
|---|---|---:|---:|---:|---:|---:|
| row-added | yes | 27 | 12 | **0** | 1 | 14 |
| row-removed | yes | 27 | 13 | **0** | 0 | 14 |
| moved | yes | 26 | 13 | **0** | 0 | 13 |
| value-changed | yes | 1 | 1 | **0** | 0 | 0 |
| renamed | no | 27 | 0 | **0** | 0 | 27 |
| duplicate | no | 27 | 0 | **0** | 0 | 27 |
| context | no | 13 | 0 | **0** | 0 | 13 |

Pass bar met: **0 wrong hits**, and every unsafe change missed. All 39 right hits are also in the case's
expected ids. The one unconfirmed hit is GitHub's repository "website link" after a row was added: the
fresh pick chose the same element but below the 0.5 acceptance score (0.37), so a fresh run would have
been inconclusive where the cache acted.

The misses on safe changes are all entries whose desc has no `context:` part (14 of the 27): they need the
whole candidate list to be unchanged, so any change on the page misses. Entries with context survive rows
added, removed or moved.

Cost: 65 + 2 Jev requests, 1,744,528 tokens.

A first run without the goal (`--goal off`, 38 requests, 1,516,780 tokens) reported 5 wrong hits. 4 were
"the comments link" on Hacker News, a vague target the goal is needed for: without it Jev's own choice moves
between comment links from one request to the next (as `docs/benchmarks/picks.md` measured: 21 wrong picks
without the goal, 0 with it). The fifth came from the inserted row itself (`href=/new`), which the fresh pick
took for "the new link in the top bar"; the inserted row is now a neutral sponsored link. A spec's goal is
part of the cache key and of the pick state, so the goal-on run is the one that matches how specs use the
cache.

## Warm cache on the examples (2026-10-02, incomplete: the demo site was failing)

`scripts/benchmark-steps.mjs` now passes `--picks` to the CLI, runs specs from `--dir` (a scratch copy of
`examples/`, so no sidecar lands in the repository), and reports per run the pick and claim calls and tokens
(`scripts/count-jev.mjs`, a `--import` preload that wraps the build's `intelligence`), `cachedPicks` and
every step's status (from a JSON report).

```
cp -R examples "$SCRATCH/examples"
node scripts/benchmark-steps.mjs --runs 3 --picks off --dir "$SCRATCH/examples" --out "$SCRATCH/off.json"
node scripts/benchmark-steps.mjs --runs 1 --picks on  --dir "$SCRATCH/examples" --out "$SCRATCH/cold.json"
node scripts/benchmark-steps.mjs --runs 2 --picks on  --dir "$SCRATCH/examples" --out "$SCRATCH/warm.json" --compare "$SCRATCH/cold.json"
```

During these runs the-internet.herokuapp.com, which 16 of the 17 benchmarked examples use, mostly did not
reach the `load` event in a browser (its scripts and stylesheets stayed pending; `curl` got each file in
under a second). 13 or 14 of 17 specs failed at their first `goto` in every run, and not the same ones from
run to run, so the pass bars (≥80% hits, pick tokens −≥80%, same step statuses) **could not be measured**
on the whole set.

| Run | Specs that passed | Jev pick targets | Pick tokens | Cached picks |
|---|---|---:|---:|---:|
| off 1 / 2 / 3 | 3 / 3 / 4 (a different set each run) | 3 / 4 / 1 | 1,735 / 2,321 / 479 | 0 |
| cold (on) | JS error, infinite scroll + dynamic loading, todo | 2 | 1,034 | 0 |
| warm 1 (on) | the same three | **0** | **0** | 2 |
| warm 2 (on) | JS error, todo, dialogs dismiss, dropdown | 7 | 4,132 | 1 |

On the specs that passed in both the cold run and a warm run, every pick was replayed: 3 of 3 (`fill the new
todo input` on TodoMVC twice, `click the Start button` on dynamic loading once), no pick call, the same step
statuses. Warm run 2's 7 pick calls are all from specs that never passed before (dialogs, dropdown), so
they had no entry yet. This shows the mechanism end to end on live pages; it is too small a sample for
the pass bars.

Cost: 48 Jev calls, 49,959 tokens over the 6 runs.

To finish the measurement when the site is healthy again (each run ~3.5 min):

```
SCRATCH=$(mktemp -d); cp -R examples "$SCRATCH/examples"
node scripts/benchmark-steps.mjs --runs 2 --picks off --dir "$SCRATCH/examples" --out "$SCRATCH/off.json"
node scripts/benchmark-steps.mjs --runs 1 --picks on  --dir "$SCRATCH/examples" --out "$SCRATCH/cold.json"
node scripts/benchmark-steps.mjs --runs 2 --picks on  --dir "$SCRATCH/examples" --out "$SCRATCH/warm.json" --compare "$SCRATCH/off.json"
```

Hit rate = `cachedPicks / (cachedPicks + pick targets)` per run (printed as `hitRate`); pick tokens and step
statuses are compared against the off run (`--compare`).
