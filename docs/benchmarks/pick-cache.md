# Pick cache

The pick cache (`src/pick-cache.ts`, [running suites](../running.md#pick-cache)) replays a pick Jev made in
the last passing run when the fresh page has the same whole candidate list (values typed into text fields
aside) and exactly one candidate with the stored description. Two questions: is a replayed pick ever the
wrong element (safety), and how much does it save on a real suite (cost).

## Safety on stale pages (2026-10-02, `DESC_FORMAT` 2)

`scripts/benchmark-pick-cache.mjs` takes each saved page in `scripts/pick-states/` as the "before" state and
changes it the way a site changes between runs. For each target of `scripts/pick-cases.json` that has a
right answer, Jev picks on "before" with the flow's goal (the run that wrote the cache); the accepted pick
becomes the entry (`makeEntry`); the lookup runs on "after" (`match`). Every hit is checked against a fresh
Jev pick on "after": **wrong** = the fresh pick accepts another element or `none`, or the hit is not the
element the entry was made from; **unconfirmed** = the fresh pick accepts nothing (the cache acted where
Jev would have been inconclusive). Misses need no check: Jev picks then. Pass bar: 0 wrong, 0 unconfirmed,
every unsafe change a miss.

Changes on the saved pages: **unchanged** (the same page again), **row-added** (a new row at the top),
**row-removed**, **moved** (the targets moved to the end), **value-changed** (a text field's value, fill page
only), and the unsafe **renamed** (the target's text), **duplicate** (a second identical element: both get
` #n`) and **context** (the target's row text). Three built-in pages add unsafe changes the saved pages
lack: **value-label** (`input[type=submit] value="Subscribe"` becomes `Unsubscribe`), **better-row** (a newer
order row above the one picked for "the newest order's View link") and **dialog** (a cookie dialog over the
page).

```
node scripts/benchmark-pick-cache.mjs --runs 1 --skip turing-click
```

37 targets (34 on 10 saved pages; `turing-click`, 1,016 candidates at the cap, skipped for cost; 3 built-in);
31 stored, 3 rejected by Jev on "before", 3 not stored (one of several identical elements, ` #n`).

| Change | Safe | Targets | Hit, right | Wrong | Unconfirmed | Miss |
|---|---|---:|---:|---:|---:|---:|
| unchanged | yes | 28 | 28 | **0** | **0** | 0 |
| row-added | yes | 28 | 0 | 0 | 0 | 28 |
| row-removed | yes | 28 | 0 | 0 | 0 | 28 |
| moved | yes | 27 | 0 | 0 | 0 | 27 |
| value-changed | yes | 1 | 1 | **0** | **0** | 0 |
| renamed | no | 28 | 0 | 0 | 0 | 28 |
| duplicate | no | 28 | 0 | 0 | 0 | 28 |
| context | no | 14 | 0 | 0 | 0 | 14 |
| value-label | no | 1 | 0 | 0 | 0 | 1 |
| better-row | no | 1 | 0 | 0 | 0 | 1 |
| dialog | no | 1 | 0 | 0 | 0 | 1 |

Pass bar met: 0 wrong, 0 unconfirmed, every unsafe change missed; all 29 hits are in the case's expected ids.
Since every entry now carries the list hash, any change to a page's candidate list is a miss, safe changes
included: the cache pays off on pages that stay the same between runs (test environments), and Jev picks
on everything else. Cost: 59 Jev requests, 1,370,851 tokens.

Earlier runs, before the review fixes (`DESC_FORMAT` 1: `value=` dropped on every candidate, list hash only
on entries without `context:`): with the goal, 0 wrong and 1 unconfirmed hit (GitHub's "website link" after a
row was added, fresh score 0.37); 65 + 2 requests, 1,744,528 tokens. Without the goal, 5 wrong hits (4 the
vague "the comments link", which needs the goal; 1 caused by the inserted row itself); 38 requests, 1,516,780
tokens. The unconfirmed hit and the review's cases (a value-labelled button, a newer better row) are why
every entry now needs the whole list unchanged.

## Warm cache on the examples (2026-10-02, incomplete: the demo site was failing)

`scripts/benchmark-steps.mjs` passes `--picks` to the CLI, runs specs from `--dir` (a scratch copy of
`examples/`, so no sidecar lands in the repository), and reports per run the pick and claim calls and tokens
(`scripts/count-jev.mjs`, a `--import` preload that wraps the build's `intelligence`), `cachedPicks`,
`hitRate` = cached / (cached + Jev-picked targets), and every step's status (from a JSON report).

the-internet.herokuapp.com, which 16 of the 17 benchmarked examples use, mostly did not reach the `load`
event in a browser during these runs (its scripts and stylesheets stayed pending). The specs that failed
at their first `goto` changed from run to run, so the pass bars (≥80% hits, pick tokens −≥80%, same step
statuses) **could not be measured** on the whole set.

Second attempt, after the review fixes (fresh scratch copy):

| Command | Specs passed | Pick calls | Pick tokens | Claim calls / tokens | Cached |
|---|---|---:|---:|---:|---:|
| `--runs 2 --picks off` run 1 / 2 | 6 / 3 of 17 | 13 / 6 | 35,991 / 3,361 | 11 / 8,415, 5 / 2,281 | 0 |
| `--runs 1 --picks on` (cold) | 1 of 17 (todo) | 1 | 485 | 1 / 602 | 0 |

The cold run left one sidecar (`todo.picks.json`). The full warm run was not done: with 16 of 17 specs
failing at `goto` it would have measured the site, not the cache. On the one example the site outage did not
touch (`todo.yaml`, demo.playwright.dev), warm against off, 2 runs each:

| `todo.yaml`, median of 2 | off | warm (on) | Change |
|---|---:|---:|---:|
| pick calls / tokens | 1 / 485 | 0 / 0 | −100% |
| hit rate | 0% | 100% | |
| step time (`total`, ms) | 1,677 | 1,071 | −36% |
| Jev wait (`jev`, ms) | 759 | 105 | −86% |
| claim tokens | 602 | 602 | 0 |
| step statuses | | identical to off | |

First attempt (before the review fixes): off ×3, cold ×1, warm ×2; on the specs that passed in both the
cold and a warm run, 3 of 3 picks were replayed with no pick call and the same statuses.

Cost of the step benchmarks: first attempt 48 Jev calls, 49,959 tokens; second attempt 37 calls, 51,135
tokens, plus the todo runs (2 pick calls and 4 claim calls, 3,378 tokens).

To finish the measurement when the site is healthy again (each run ~3.5 min):

```
SCRATCH=$(mktemp -d); cp -R examples "$SCRATCH/examples"
node scripts/benchmark-steps.mjs --runs 2 --picks off --dir "$SCRATCH/examples" --out "$SCRATCH/off.json"
node scripts/benchmark-steps.mjs --runs 1 --picks on  --dir "$SCRATCH/examples" --out "$SCRATCH/cold.json"
node scripts/benchmark-steps.mjs --runs 2 --picks on  --dir "$SCRATCH/examples" --out "$SCRATCH/warm.json" --compare "$SCRATCH/off.json"
```
