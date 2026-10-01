# Claims: does an `expect` judge right?

`scripts/benchmark-claims.mjs` judges 139 claims with known answers (50 hold, 89 do not) on 16 saved pages, through
the same `judgeState` and `decide()` an `expect` step uses. Saved pages keep the input fixed: a change in the
numbers is a change in the judging, not in the page.

- UI states (`scripts/claim-states/`, `capture-claim-states.mjs`, plain Playwright actions, no Jev): the-internet
  login with a wrong and a right password, checkboxes, a dropdown, dynamic loading before and after, dynamic
  controls, and TodoMVC with three todos and one completed.
- Content pages, shared with the read benchmark (`scripts/read-states/`): Wikipedia, Hacker News, GitHub repo and
  issues, Open Library, the-internet tables, books.toscrape, quotes.toscrape.

Case types (`scripts/claim-cases.json`): **outcome** (a flow's result, as a test says it), **fact**, **near** (one
detail wrong: a year, a price, a count), **absent**, **state** (checked, selected, enabled), **negation** ("no
error is shown"), **count**, **order**, **event** (judged from the runner's events: pageerror, dialog, download),
and the hard false kinds: **compound** (two parts, one false), **quantifier** (all, every, at least one),
**superlative** (the most, the cheapest), **swap** (the true value of another row or field: Frank's email given
to Jason, forks read as stars) and **scope** (true elsewhere on the page: the second story's site given to the
first). Most hard types have a true partner, so always answering "no" does not score.

What to read, in order:

1. **False pass**: a claim that does not hold, judged pass. In a test this is a bug that ships. It must stay 0.
2. **False fail**: a good run marked failed.
3. **Inconclusive**: safe, but the author has to rephrase or retry.
4. **Margins**: the lowest p on a claim that holds and the highest p on a claim that does not. They move before
   the counts do, so they show a change that is getting close to a threshold (pass ≥ 0.9, fail ≤ 0.1).
5. **Flips**: cases whose decision changed between runs on the same input.

```
node scripts/capture-claim-states.mjs                  # only to refresh the UI states; re-check the cases after
node scripts/benchmark-claims.mjs --runs 3 --out /tmp/base.json
node scripts/benchmark-claims.mjs --runs 3 --compare /tmp/base.json
node scripts/benchmark-claims.mjs --group page         # all claims of a page in one call, like an expect list
```

## Result (2026-10-01, jev-1.13.0, one claim per call, 3 runs, 417 judgments)

| | |
|---|---|
| False pass | **0** / 417 |
| False fail | 0 |
| Inconclusive | 64 (15.3%) |
| Right | 353 (84.7%) |
| Lowest p, claim holds | 0.51 |
| Highest p, claim does not hold | **0.75** |
| Flips | 5 / 139 |
| Jev tokens per claim | 4,685 |

| Type | holds: right / n | does not hold: right / n (rest inconclusive) |
|---|---|---|
| fact, order, superlative, scope | 63 / 63 | 27 / 27 |
| near | | 66 / 69 |
| swap | | 21 / 24 |
| compound | 6 / 6 | 21 / 27 |
| absent | | 18 / 21 |
| quantifier | 3 / 3 | 8 / 12 |
| event | 9 / 12 | 15 / 15 |
| outcome | 10 / 15 | 6 / 9 |
| negation | 9 / 15 | 9 / 9 |
| state | 17 / 21 | 13 / 24 |
| count | 15 / 15 | **17 / 30** |

- No false pass and no false fail. Every inconclusive result is the safe kind.
- **Counts are the weak spot.** A wrong count is inconclusive almost half the time, and the over-count "four of the
  quotes are by Albert Einstein" (there are three) is the closest call of the whole set: p = 0.67–0.75. The
  under-count "two of the quotes" sits at 0.35.
- **An unchecked control is hard to read.** The tree marks a checked box `[checked]` and an unchecked one with
  nothing. "Checkbox 1 is checked" on an unchecked box gets 0.12–0.28, and "the text field is enabled and the
  checkbox is checked" (the checkbox is not) gets 0.51–0.53: Jev cannot tell that the second half is false. An
  explicit unchecked mark in the tree is a candidate fix to measure here.
- **Small UI pages are less certain than large ones.** "The text Hello World! is displayed", true and the page's
  only heading, gets 0.88–0.90; facts on large content pages are all right (lowest p 0.93).
- Claims about something being gone ("nothing is loading" 0.51, "the Start button is gone" 0.77–0.79) are
  weaker than claims about something being there.

## First result, 74 cases (2026-10-01)

Before the hard false kinds were added. Grouping a page's claims in one call used a third of the tokens at about
the same accuracy (one run each, so not conclusive):

| | one claim per call (2 runs) | claims of a page in one call (1 run) |
|---|---|---|
| False pass | **0** / 148 | **0** / 74 |
| False fail | 0 | 0 |
| Inconclusive | 22 (14.9%) | 12 (16.2%) |
| Right | 126 (85.1%) | 62 (83.8%) |
| Lowest p, claim holds | 0.48 | 0.50 |
| Highest p, claim does not hold | **0.78** | 0.80 |
| Flips | 2 / 74 | – |
| Jev tokens per claim | 3,810 | 1,226 |
