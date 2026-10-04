# Jev cost reduction (2026-10-05)

Goal: at least 30% fewer Jev tokens, with the same step statuses, pick and claim accuracy, and step time.
Model `jev-1.13.0`, TypeSafe provider. Main is `ac702ba`.

## Results

| Workload | Main | Branch | Change |
|---|---:|---:|---:|
| Live e2e, 36 specs (`scripts/e2e.mjs`, `--picks off`), spec tokens | 176,542–179,873 (4 runs) | 123,811 | −30% to −31% |
| Live e2e, Jev requests | 157 | 125 | −20% |
| Live e2e with the MCP agent path, wall time | 78 s | 63–68 s | −13% to −19% |
| `benchmark-picks.mjs`, tokens per pick (saved real pages) | 19,900 | 14,300 | −28% |
| `benchmark-claims.mjs`, tokens per claim (saved real pages) | 3,163 | 3,163 | 0% |

Quality on the same runs:

- e2e: all 36 specs end with the expected status, the `expect-fail` specs included.
- Picks, 2 runs each: 104/14/6 right/wrong/inconclusive without the goal and 121/0/3 with it on main;
  105–106/14/4–5 and 122/0/2 on the branch.
- Claims gate, 2 runs each: 0 false passes on both. Right: 409 and 413 of 466 on main, 407 on the branch (three
  runs). Every case that differs has the same input on both sides and a probability at the 0.1 threshold.

On real pages, picks cost the most, so the pick change is the one that matters most there. Judgments on real pages
did not change: the e2e saving on judgments comes from fewer requests.

## Kept changes

Token counts are e2e totals from a request log, warm-up requests included. The pick-layout grouping (rejected
below) was in the runs from 138,559 to 129,811, then removed (131,827).

| Change | e2e tokens |
|---|---:|
| Main | 179,429 |
| A plain English prompt without a position word is semantic, with no route request | 143,035 |
| Bounds in whole pixels | 140,574 |
| A lowercase relation word outside quotes (left, below, between) is spatial, with no route request | 130,296 |
| No route for `scroll: top` or `bottom` | 129,811 |
| Pick elements as `id: description` lines, bounds only in the criteria | 127,828 |
| An `expect` also asks the claims of the next whole-page `expect` steps; they reuse the answer on the same page | 126,396 |
| The coordinate space said once per pick, not after each candidate | 126,121 |
| Pick criteria without the container context (`elements` keep it) | 125,657 |
| Judge layout: no `main:` label on a page without iframes, neighbors grouped per element | 124,395 |

## Rejected changes

| Change | Saving | Why rejected |
|---|---|---|
| Neighbors grouped per element in pick layouts | 2k e2e tokens | A reference pick fell from 0.75 to 0.56 mean confidence (10 calls). |
| Pick elements as lines with their bounds | 4k | The same pick fell to 0.58, and `spatial-reference.yaml` ended `inconclusive`. |
| No `main:` label in pick layouts | 1.6k | The reference pick fell from 0.86 to 0.55. |
| No pick `elements` (criteria only) | 47% per pick | 9 fewer right picks with the goal. |
| No page URL in picks | 25 tokens per pick | 12 inconclusive picks without the goal, against 4. |
| No link targets (`/url:` lines) in judged trees | 28% per claim | False count and quantifier claims rose toward pass (0.12 to 0.24 mean). |
| No layout header rules or `layoutRules` for judges | 1.5k–3.5k | Spatial negatives rose above 0.1. |

## Method

- Tokens: input plus output of each TypeSafe request, from a preload that wraps `TypeSafeClient.systemOne`.
- Probes: the same saved request sent 3–10 times per variant, with mean confidence or probability compared.
  Jev answers vary between calls, so one call is not evidence.
- Commands: `node scripts/e2e.mjs --retries 0`, `node scripts/benchmark-picks.mjs --runs 2`,
  `node scripts/benchmark-claims.mjs --gate --runs 2`, each on main and on the branch.

The long `/consent` page (60,000 characters at the snapshot cap) costs a third of the e2e tokens in three
judgments. A smaller cap or fewer link targets would save more, but both change what Jev can judge.
