# Snapshot views

Browser, desktop, and mobile MCP `snapshot` accept `mode: raw | compact | smart`, optional
`within`, `maxChars`, and a smart-only `intent`. The default remains `raw`.
Known actions need no preliminary snapshot: `step` captures fresh candidates itself. Use an
overview when deciding what to do next, or a scoped raw snapshot to read exact data.

```json
{"mode":"compact"}
{"mode":"smart","intent":"Change the delivery address"}
{"mode":"raw","within":"the delivery address form","maxChars":12000}
```

| Mode | Evidence | Model work |
| --- | --- | --- |
| `raw` | Existing `aria` response, prefix capped at 20,000 characters by default | No classification |
| `compact` | `observed.aria` excerpts, 6,000-character default | No classification |
| `smart` | With `intent`, only task-relevant regions, necessary context, and recognized critical messages; adds `inferred` classifications | One batched Jev request; provider retries can still occur |

`maxChars` is an integer from 1 to 60,000 and limits evidence text, not the complete JSON response.
`within` still resolves a region using Jev (browser `css=` bypasses that). Smart mode needs a
model key for classification even without `within`. `intent` is at most 2,000 characters and is
literal task context, not a hooks/env template. These reads are not recorded in saved specs.

## Iframe labels

`frameLabel()` (`src/browser/frames.ts`) uses the frame's name when it is set, otherwise the URL pathname,
otherwise the raw URL. A whole-page snapshot appends each readable iframe's accessibility tree under
a `--- iframe <label> ---` line. `snapshotRegion` adds no iframe headers. Candidates inside an iframe
use the same label as a `[iframe <label>] ` prefix; where those candidates sit in the list is in the
[phrasing guide](phrasing.md#how-jev-decides).

## Evidence and inference

Compact views remove only anonymous wrapper lines. They prioritize recognized dialogs, alerts,
and status regions, followed by headings and controls, ordinary content, and navigation/footer
content. Selected lines retain their original text, states, values, named ancestors, iframe
identity, and source order. Whole lines are selected; a line and its ancestors that cannot fit
are omitted rather than cut mid-label. Unknown roles remain eligible for selection.

In browser trees an unchecked checkbox, radio, switch or checkable menu item shows `[checked=false]`,
a checked one `[checked]` and a mixed one `[checked=mixed]` (`markUnchecked` in `src/browser/page.ts`), so the
state is always written on the line, as in the mobile tree. The mark reaches Jev, `snapshot` views and
`changed` lines alike.

Smart mode classifies the captured interface as `authentication`, `form`, `results`, `detail`,
`dashboard`, `other`, or `unknown`. It also returns independent `blockingDialog`, `error`, and
`loading` signals with probabilities. Screen classification needs confidence >= 0.9 (chosen
probability fallback); otherwise the type is `unknown`. Signals are `present` at p >= 0.9,
`absent` at p <= 0.1, and `inconclusive` between. When the source capture is truncated, negative
signals remain `inconclusive`. These prototype classification thresholds do not change element
pick or assertion thresholds.

With `intent`, the capture is divided by UI structure: forms, search regions, landmarks, named
groups, lists/tables, and heading sections. Jev judges each region's own evidence in the same
request, using ancestors for context. Regions at p >= 0.5 are retained; unrelated regions are
filtered out. Recognized dialogs, alerts, and status regions remain eligible regardless of
relevance. Necessary ancestors and section headings are retained with selected content. The
response stops when that evidence is exhausted: unused space is never filled with unrelated
content. When relevant content exceeds `maxChars`, critical messages come first, then regions
ranked by relevance. Relevance does not establish a state claim or authorize an action.

At most 64 regions are assessed in one request, prioritizing recognized critical regions and
regions containing headings/controls. `coverage.unassessedRegions` reports any remaining ones;
unassessed regions cannot establish absence and are not assumed relevant. Semantic boundaries
depend on accessibility structure: a poorly structured region may still mix unrelated content.
Without intent, smart mode makes four classification judgments and returns a compact overview.
The model sees assessed regions before the output budget is applied. No generated label,
value, or message is used as observed evidence. Action targeting is unchanged.

For task-focused calls, `inferred.selection.status` is `focused` when at least one region
matches, `no-confident-match` when none reaches 0.5, or `fallback` when classification is
unavailable. No-match responses contain only any recognized critical messages and their context;
they do not invent an answer or silently revert to unrelated content. `matchedRegions` and
`uncertainRegions` (0.1 < p < 0.5) let the agent decide whether to expand the scope or rephrase.

`coverage` reports source/returned character counts, source line count, removed wrappers,
omitted content lines, `filteredLines` excluded by task filtering (including unassessed regions), omitted recognized critical lines,
and `sourceTruncated`. `unassessedRegions` is included in smart mode. Top-level
`truncated` means source truncation or omitted content; wrapper removal alone does not set it.
An excerpt can omit siblings, rows, or messages. Never treat missing content as absent or use
the excerpt to count all rows. `omittedCriticalLines: 0` only concerns recognized roles, not
every possible error or blocker. Inferences describe the captured scope and may depend on
evidence omitted from the response. Expand with `within`, a larger budget, or raw mode as needed.

If Jev is unavailable or returns invalid answers, smart mode returns compact evidence with
`inferred.status: unavailable` and a reason. Empty captures also have unavailable inference and
skip classification. A task-focused fallback is labeled `inferred.selection.status: fallback`;
its evidence is an unfiltered compact overview. No negative conclusions are manufactured on failure.

## Measuring the tradeoff

Compact/smart responses report `jevTokens` and milliseconds for `projection` (including Jev),
`jev`, and MCP `total` (including capture and region resolution). Token usage includes region
selection when scoped. A failed classification reports `jevTokens: null` because a failed
provider request may consume tokens without returning usage. These are not main-agent tokens.

```sh
npm run build
node scripts/benchmark-snapshots.mjs
node scripts/benchmark-snapshots.mjs --live-jev
node scripts/benchmark-snapshots.mjs --live-jev --fixture=late-task-data
```

The microbenchmark compares synthetic captures at an equal 6,000-character evidence budget,
reporting full response characters, retained expected text, elapsed projection time, and Jev
usage. The default compares raw and compact without a key. `--live-jev` loads the usual env
files and adds actual smart classifications; it makes paid API calls where applicable.
It does not measure UI capture, main-agent tokens, task success, or native platform parity.

Small trees may produce larger compact/smart responses because metadata costs more than the
removed wrappers. Classification adds latency and still requires the underlying capture. Use
representative end-to-end tasks to evaluate missed information, follow-up reads, task success,
total model cost, and wall-clock time before changing defaults or enabling automatic observations.

Task filtering can reduce the main agent's input while increasing Jev usage because more
independent regions require more questions. Measure both sides rather than equating shorter
evidence with lower total cost.
