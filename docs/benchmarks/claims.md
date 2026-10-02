# Claims: does an `expect` judge right?

`scripts/benchmark-claims.mjs` judges 181 claims with known answers (73 hold, 108 do not) on 28 saved pages, through
the same `judgeState` and `decide()` an `expect` step uses. Saved pages keep the input fixed: a change in the
numbers is a change in the judging, not in the page.

- UI states (`scripts/claim-states/`, `capture-claim-states.mjs`, plain Playwright actions, no Jev): the-internet
  login with a wrong and a right password, checkboxes, a dropdown, dynamic loading before and after, dynamic
  controls, and TodoMVC with three todos and one completed.
- Regions (`region: true`, judged as an `expect` with `within` sees them), from practice.expandtesting.com and
  the-internet: each drag-and-drop box after the drag, both boxes, a login message, a table row and one cell.
- Ad-funded pages (`ad-*`, practice.expandtesting.com, saved from a plainwright run on 2026-10-02, not
  re-capturable: ads change on each load): login success, a dropdown, checkboxes, and drag and drop.
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

## Regions without the page URL, and short ad links (2026-10-02)

A live MCP session on practice.expandtesting.com showed two weaknesses. Both reproduce on saved pages.

**A region was doubted.** After box A was dragged onto box B, `expect: {that: the letter "B" is shown, within:
"css=#column-a"}` stayed inconclusive at p = 0.86, on a region tree of exactly `- text: B`. Other phrasings did
not help: "the box shows the letter B" 0.84, "the text is B" 0.80, "B is shown" 0.70. The page context did: the
same claim on the same tree gets 0.95 with the URL and title left out, 0.91 with only the URL left out, and 0.88
with only the title left out.

Leaving out both is not right in general. The live e2e found a counter case: the `Feed` region of
`e2e/site.mjs` with Post 1 to Post 6, and "the feed shows Post 3 or a later post", gets 0.92 with the URL and
title and 0.80 without both. On the 29 region cases (6 of them on that feed, 3 runs each), with what Jev gets:

| | URL and title (baseline) | nothing | title only |
|---|---|---|---|
| Right | 63 / 87 | 72 / 87 | **72 / 87** |
| False pass / false fail | 0 / 0 | 0 / 0 | 0 / 0 |
| Lowest p, claim holds | 0.52 | 0.25 | 0.51 |
| Highest p, claim does not hold | 0.70 | 0.62 | 0.59 |

"Nothing" drops the feed claim to 0.80 and "the letter B comes before the letter A" on `- text: B A` to 0.26.
"Title only" moves no case much toward the wrong side. `judgeState` now sends a region (`snapshotRegion` marks it
`region: true`) with the page title and without the URL.

**Ad links filled whole-page claims.** On the same site, a whole-page `expect` cost 15k to 26k Jev tokens. The
login-success state was 41,447 characters: 39,461 in ad iframes, and 38,133 in `/url:` lines. One ad link target
is up to 1,900 characters of tracking query. Link targets on the saved content pages stay under 250 characters.
A claim now gets each link target over 200 characters cut to its part before `?` or `#`, and to 200 characters (`shortenUrls`,
before the 60k cap), and a snapshot leaves out iframes with an empty tree. The empty iframes also caused a second Jev call:
an empty reCAPTCHA frame header appeared between the early and the settled look, so `settledAsk` asked again.
Cross-origin iframes are not dropped: a payment form or an embedded widget is real content, and ad text
("Garden tools on sale") is visible content that a claim can name.

3 runs each, 187 cases (561 judgments), back to back on the same saved pages:

| | baseline | change |
|---|---|---|
| False pass / false fail | 0 / 0 | 0 / 0 |
| Right | 475 (84.7%) | **482 (85.9%)** |
| Inconclusive | 86 (15.3%) | 79 (14.1%) |
| Jev tokens per claim | 5,539 | **3,739** |

Split by whether the change touched the page (7 regions, 4 ad pages, and Hacker News and GitHub with a few long
links):

| | pages it touched (177) | pages it did not touch (384) |
|---|---|---|
| Right | 139 → **145** | 336 → 337 |
| Inconclusive | 38 → 32 | 48 → 47 |
| Jev tokens per claim | 9,781 → **4,076** | 3,584 → 3,584 |
| Highest p, claim does not hold | 0.72 → 0.60 | 0.75 → 0.80 |

The pages it did not touch get the same input in both arms, so their movement is run-to-run noise: the 0.80 is
the Einstein over-count on the quotes page, the closest call of the set since the first run.

Jev tokens per claim on the ad pages: login 26,383 → 1,826, dropdown 25,915 → 3,724, drag and drop 16,283 →
1,544, checkboxes 15,247 → 1,567. The ad text stays: "an advertisement for Thinkmate computing hardware is shown"
passes at 0.98 in both arms. Two claims on these pages got less sure, both safe: "a country is selected" (does
not hold) 2/3 → 0/3 right at p = 0.14–0.18 (baseline 0.10–0.12), and "the page has exactly two checkboxes" 3/3
→ 1/3 right at p = 0.89–0.90 (baseline 0.93–0.94). On the regions:

| Region claim | baseline p | change p |
|---|---|---|
| `- text: B`, "the letter "B" is shown" (holds) | 0.83–0.85 | **0.92–0.93** |
| `- text: A`, "the letter "A" is shown" (holds) | 0.88–0.90 | **0.92** |
| `- text: A`, "the letter "B" is shown" (does not hold) | 0.10–0.11 | **0.05–0.06** |
| cell `fbach@yahoo.com`, "the email fbach@yahoo.com is shown" (holds) | 0.89 | **0.91** |
| a login error message, "a Login button is shown" (outside the region) | 0.68–0.69 | 0.42–0.43 |
| the Feed region, "the feed shows Post 3 or a later post" (holds) | 0.91–0.93 | 0.90–0.91 |

The margins on the passing region claims are thin (0.90–0.93), but steady across runs: `e2e/regions.yaml` passed
at 0.91–0.93 in 3 of 3 runs, and `e2e/waits.yaml` in 3 of 3.

**Still open: a claim on the position of a box with no role.** The boxes are plain `div` elements, so the whole
page tree shows only `B A`. "The first box shows the letter B and the second box shows A" stays inconclusive in
both arms (p = 0.67–0.77), and so does its false twin (0.54–0.72). Nothing in the tree says which box is first.
`within` on each box is the way (`docs/phrasing.mdx`), but a region pick has no layout: `within: the first box`
picked the header "A" (the box that started first), or nothing. Use `css=` for such a box.

Live check of the same flow on practice.expandtesting.com: `within: "css=#column-a"` passes at 0.92–0.93 in 3 of 3
runs (baseline 0.86, inconclusive). `scripts/benchmark-steps.mjs` on that flow plus TodoMVC, 3 runs each: median claim tokens
12,296 → 8,678, overhead 9,545 → 8,139 ms, re-asks 3 → 2. Ads change on each load (one baseline run had 29,668
claim tokens), so the saved pages above are the measure. `e2e/regions.yaml` and `e2e/regions-fails.yaml` cover both
on the local site.

## Unchecked mark (2026-10-01)

Playwright's tree marks a checked control `[checked]` and an unchecked one with nothing. `toSnapshot()`
(`src/browser/page.ts`, `markUnchecked`) now writes `[checked=false]` on an unchecked checkbox, radio, switch or
checkable menu item, as the mobile tree already did. The benchmark passes saved pages through the same function.
Baseline and change were run back to back, 3 runs each (417 judgments each).

| | baseline | `[checked=false]` |
|---|---|---|
| False pass / false fail | 0 / 0 | 0 / 0 |
| Right | 351 (84.2%) | **371 (89.0%)** |
| Inconclusive | 66 (15.8%) | **46 (11.0%)** |
| Jev tokens per claim | 4,685 | 4,689 |

Split by whether the mark changed the page (checkboxes, dynamic controls, TodoMVC, and the radios and switch on
the Wikipedia and Open Library pages):

| | pages the mark changed (156) | pages it did not change (261) |
|---|---|---|
| Right | 134 → **156** | 217 → 215 |
| Inconclusive | 22 → **0** | 44 → 46 |
| Highest p, claim does not hold | 0.63 → **0.10** | 0.67 → 0.78 |
| Lowest p, claim holds | 0.92 → 0.96 | 0.48 → 0.46 |

The pages it did not change get the same input in both arms, so their movement (±2 right, the Einstein count
at 0.67 → 0.78) is run-to-run noise. On the changed pages every case is now right: "the text field is enabled
and the checkbox is checked" (it is not) went from 0.51–0.63 to 0.02–0.03, "checkbox 1 is checked" from
0.12–0.26 to 0.02, and "checkbox 2 is checked" (true) from 0.92–0.93 to 0.98. The read benchmark (`benchmark-read.mjs`, which
now passes its saved pages through `markUnchecked` too) is unchanged: 38/38 right before and after, 2 runs each,
Jev tokens on the two pages with radios (Wikipedia, Open Library) within 0.1%. The table below is the baseline,
before the mark.

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
  checkbox is checked" (the checkbox is not) gets 0.51–0.53: Jev cannot tell that the second half is false.
  Fixed by the unchecked mark above.
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
