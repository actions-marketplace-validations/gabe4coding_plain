# Recorded locators and no-judge replay

The lock file ([run modes](../running.mdx#run-modes), `src/core/lock.ts`) replaces the pick cache. A passing run
records a Playwright locator for each picked element (`src/browser/record-locator.ts`) and a hash of each claim's
passing state. Two questions: does a recorded locator ever act on the wrong element after the page changes
(safety), and how much of a real suite replays with no Jev call (coverage).

## Locator coverage and safety (2026-10-05)

`scripts/benchmark-locators.mjs` needs no Jev key: it records a locator for every candidate of every step kind
(click, fill, select, check), not only for picked ones, so it measures the recorder alone.

```
node scripts/benchmark-locators.mjs --url https://demo.playwright.dev/todomvc --url https://news.ycombinator.com \
  --url https://github.com/microsoft/playwright --url https://en.wikipedia.org/wiki/Playwright
```

Coverage: **888 of 888** candidates got a verified locator (exactly one match, and it is the picked element):
21 pages of `e2e/site.mjs`, a built-in orders page, and four public pages (Hacker News 231, GitHub 256, Wikipedia
266, TodoMVC 5). Strategies: role and name 551, `id` 106, scoped to a row/card/dialog 104, stable attribute 87, text
32, test id 4, leading text 2, equivalent links 2.

The first prototype reached 93%, then 84% on the public pages. The fixes that the benchmark drove:

- A scope text matched as a substring: `#1042` also matched a new row `#10420` (6 wrong hits on "lookalike").
  The scope now needs an element whose whole text is exactly the recorded one.
- Hacker News nests its story rows in a layout table: every outer row also held the text (58% there). A nested
  container now uses its innermost form, `tr:not(:has(tr))`.
- Playwright does not scope through a `<slot>`: a button slotted into a shadow-root dialog is scoped by the
  dialog's host element.
- Iframes (one frame part per level), links with the same name and `href` (equivalent), unnamed controls by
  position in their container, long `value` attributes (copy buttons) and a label that wraps its select.

Safety: on the orders page every element carries a hidden key. The 41 locators recorded there replay on changed
copies of the page; a replay that matches one element with another key is **wrong**.

| Change | Right | Wrong | Miss |
|---|---:|---:|---:|
| unchanged | 41 | **0** | 0 |
| row added at the top | 41 | **0** | 0 |
| row removed | 38 | **0** | 3 (the removed row) |
| rows and cards reordered | 41 | **0** | 0 |
| a status cell changed | 41 | **0** | 0 |
| generated ids changed | 41 | **0** | 0 |
| a button renamed | 37 | **0** | 4 (the renamed buttons) |
| a row duplicated | 38 | **0** | 3 (now ambiguous) |
| two icon buttons swapped | 35 | **0** | 6 (position locators: the markup hash differs) |
| lookalike row and card (`#10420`, `Moka pot XL`) | 33 | **0** | 8 |

The pick cache missed every pick on "row added" and "reordered", since it needed the whole candidate list
unchanged ([pick cache benchmark](https://github.com/gabe4coding/plain/blob/c99dcfc/docs/benchmarks/pick-cache.md)).
A recorded locator keeps those.

Not measured here, because no locator can know it: a target whose meaning depends on other elements ("the
newest order's View link") stays on the recorded element after a newer row appears. A spatial target records the
layout hash and misses when the layout changes.

## No-judge replay of the e2e specs (2026-10-05)

`node scripts/e2e.mjs` runs the 36 specs of `e2e/` from a scratch copy in `--mode judge` (202 Jev calls, 238,845
tokens), then again in `--mode no-judge` on the lock files that run wrote:

- **21 of 21** specs that passed replayed and passed, 48 steps from recorded locators, **0** Jev calls.
- **0 of 15** `expect-fail` specs passed in no-judge: a failed attempt writes no lock, so their steps are
  `inconclusive`.
- The MCP agent path saves its flow with the lock file; the saved spec passes in `--mode no-judge`, then in
  `--mode judge`.

On the first run of this check 18 of 21 replayed. A download claim hashed the run's temporary download folder,
and the state hash held the local server's random port: the hash now uses the URL path and the download name. An
iframe field had no locator yet. A pick at confidence 0.83 was not recorded: low-confidence picks are now recorded
as marginal, which no-judge replays and auto-healing asks Jev about again.

## Mobile examples on a simulator and an emulator (2026-10-05)

`examples/mobile/android-contacts.yaml` (Google Contacts, Android API 36 emulator) and
`examples/mobile/ios-calendar.yaml` (Apple Calendar, iPhone 18 Pro simulator, iOS 27), each run in `--mode judge`,
then `--mode no-judge`, then `--mode auto-healing`, from fresh lock files, with no manual step between the runs:

| Example | judge | no-judge | auto-healing |
|---|---|---|---|
| Android Contacts (14 steps) | pass, 16 Jev calls | **pass, 0 Jev calls** (8 steps replayed, 4 claims on recorded states) | pass, 11 Jev calls |
| iOS Calendar (25 steps) | pass, 29 Jev calls | 17 of 22 steps, 0 Jev calls | pass, 9 Jev calls (19 steps replayed) |

The iOS no-judge run stops at its last claim: the event page shows every event of that hour, and each run adds one
event, so the page differs from the recorded one. A claim about the whole screen of a growing list cannot replay.

What the device runs found and fixed:

- A run value made a new lock key and stayed in the file: keys, descriptions and states now hold placeholders
  (`${hooks.title}`), so one entry serves every run.
- Two identical controls (Starts and Ends, both `5 Oct 2026`) were not recorded: an entry now records its place
  among its twins and replays only among as many twins.
- An Android container is named by all the text it holds (the contact list), which each run changes: a replay now
  tries role and name first when no other element has them.
- Spatial guards and spatial claim states compared pixel bounds, which move by a point between two captures: they
  now compare tolerant neighbor relations, and a target's guard only its own relations (a clock elsewhere on the
  screen changed every minute).
- A no-judge miss named only the state seen: it now also names the recorded state, saved in the debug folder of
  the computer that recorded it.
- The examples left the app on another screen than the one they start on: they now end where they start, with
  optional first steps that recover from a run that stopped halfway.

## Step time against main (2026-10-05)

`scripts/benchmark-steps.mjs --runs 3` on the 21 passing e2e specs (`e2e/*.yaml` without `expect-fail`, 109
steps), served by `e2e/site.mjs` on this computer, so a difference is plain's and not a remote site's. `main`
(de9c4c1, `--picks off`) against this branch merged with it, `--mode judge`, then `--mode no-judge` on the lock files
the judge runs wrote. Medians per run:

| | main | judge | no-judge |
|---|---:|---:|---:|
| Wall time | 51.6 s | 54.6 s | **33.7 s** |
| Overhead (step time minus the page's own action time) | 33.4 s | 36.7 s | **15.5 s** |
| Jev time | 18.0 s | 18.6 s | 0 |
| Locator recording | | 0.8 s | |
| Locator replay | | | 1.5 s |
| Pick calls, pick + claim tokens | 48, 83k | 48, 83k | **0, 0** |

Every one of the 109 step statuses passed in all nine runs. Recording costs about 17 ms per Jev pick; the rest of
the judge median's 3.0 s is Jev latency and settle time on code paths this change does not touch (one judge run took
142.9 s, 108 s of it in Jev). No-judge removes 35% of the wall time and all Jev cost.

The same benchmark on `examples/` measured nothing: the-internet.herokuapp.com, which 16 of its specs use, failed to
load for 11 to 15 of them in every run, on main and on the branch.
