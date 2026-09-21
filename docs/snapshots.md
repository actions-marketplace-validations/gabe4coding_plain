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
| `smart` | Same excerpt format, plus `inferred` classifications and optional task relevance | One batched Jev request; provider retries can still occur |

`maxChars` is an integer from 1 to 60,000 and limits evidence text, not the complete JSON response.
`within` still resolves a region using Jev (browser `css=` bypasses that). Smart mode needs a
model key for classification even without `within`. `intent` is at most 2,000 characters and is
literal task context, not a hooks/env template. These reads are not recorded in saved specs.

## Evidence and inference

Compact views remove only anonymous wrapper lines. They prioritize recognized dialogs, alerts,
and status regions, followed by headings and controls, ordinary content, and navigation/footer
content. Selected lines retain their original text, states, values, named ancestors, iframe
identity, and source order. Whole lines are selected; a line and its ancestors that cannot fit
are omitted rather than cut mid-label. Unknown roles remain eligible for selection.

Smart mode classifies the captured interface as `authentication`, `form`, `results`, `detail`,
`dashboard`, `other`, or `unknown`. It also returns independent `blockingDialog`, `error`, and
`loading` signals with probabilities. Screen classification needs confidence >= 0.9 (chosen
probability fallback); otherwise the type is `unknown`. Signals are `present` at p >= 0.9,
`absent` at p <= 0.1, and `inconclusive` between. When the source capture is truncated, negative
signals remain `inconclusive`. These prototype classification thresholds do not change element
pick or assertion thresholds.

With `intent`, the capture is divided into at most 24 text blocks with ancestor context. Jev
judges each block's relevance in the same request. Blocks at p >= 0.5 are ranked by probability,
below recognized critical regions and above ordinary controls. Relevance only orders evidence;
it does not establish a state claim or authorize an action. This is coarse prioritization: a
block can contain several unrelated elements. Without intent there are only four questions.
The model sees the captured evidence before the output budget is applied. No generated label,
value, or message is used as observed UI evidence. Classification does not affect action targeting.

`coverage` reports source/returned character counts, source line count, removed wrappers,
omitted content lines, omitted recognized critical lines, and `sourceTruncated`. Top-level
`truncated` means source truncation or omitted content; wrapper removal alone does not set it.
An excerpt can omit siblings, rows, or messages. Never treat missing content as absent or use
the excerpt to count all rows. `omittedCriticalLines: 0` only concerns recognized roles, not
every possible error or blocker. Inferences describe the captured scope and may depend on
evidence omitted from the response. Expand with `within`, a larger budget, or raw mode as needed.

If Jev is unavailable or returns invalid answers, smart mode returns compact evidence with
`inferred.status: unavailable` and a reason. Empty captures also have unavailable inference and
skip classification. No negative conclusions are manufactured on failure.

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

### Initial measurement (2026-09-21)

On the synthetic `late-task-data` fixture, both raw and compact missed the requested address at
the equal 6,000-character budget. Smart retained both the region name and exact address. That
single Jev run took 1,003 ms and consumed 13,831 tokens; its relevance score for the final block
was 0.74. The earlier 0.9 relevance cutoff missed it, motivating a separate 0.5 cutoff for
evidence ranking while retaining stricter state-claim thresholds.

The complete smart response was 7,310 characters, versus 6,794 raw and 7,025 compact. This
demonstrates better evidence selection at a fixed budget, not a measured token or latency
reduction. Small-form measurements also showed metadata overhead exceeding wrapper savings.
These are individual synthetic runs, not a task-success evaluation or model calibration study.
