# Interpretation and audit of the corrected comparison

This is a fresh comparison of plain at `0c1698e` against Playwright MCP 0.0.82:
six workflows × three repetitions × three main models × two stacks = **108 trials**.
The production implementation includes contextual action candidates and batching. It is not a
snapshot-only test or an isolated causal measurement of Jev. See the
[protocol](../current-browser-comparison.md) and [full tables](README.md).

## What the measurements support

Plain's measured API cost per task was **6.5% higher for Luna, 23.8% lower for Terra and
10.3% lower for Astra**. Mean elapsed time was **52.1%, 25.5% and 51.2% lower**, respectively.
All costs include recorded main-agent and Jev calls, including recovery and verification.
All 108 trials returned complete usage and finished naturally; none reached the output cap.

The task-cluster cost intervals are 0.967–1.163× for Luna, 0.664–0.907× for Terra and
0.767–1.058× for Astra. Luna and Astra include parity. Six task types and three repetitions
are too few for broad performance or reliability claims. Timing includes provider load,
model inference and the stacks' own browser waits; it does not isolate Jev's inference speed.

Savings are not uniform. Luna contact creation cost 27.8% more, account editing 18.4% more and
validation 11.4% more. Astra account editing cost 19.7% more. Terra catalog browsing cost 44.4%
less but took 53.9% longer. Per-task tables remain available so these tradeoffs are visible.

Main-agent generations fell from **412 to 333 (19.2%)**, and cumulative main input from
1,037,645 to 823,470 tokens (20.6%). These totals include repeatedly supplied conversation
context. There were 63 successful batch calls containing 180 actions. Jev still makes its
normal per-action decisions; batching reduces main-agent round trips, not Jev's call count.
The earlier [batch ablation](../browser-batching.md) addresses that mechanism separately.
This comparison alone cannot attribute all differences to one implementation feature.

## The strict-oracle failure

Plain passed 54/54 strict checks and the baseline 53/54. In baseline `run-064`
(Terra, account editing, repeat 2), the agent selected the correct account and saved the exact
requested email, observed the success confirmation, navigated away and back, and saved the
same account again. Both saved events contain `row: "12"` and `alex33@example.test`.
No other account was changed. The strict record oracle requires exactly one save.

The fixture reloads its initial display rather than persisting edits into a subsequent page
load. This limitation can provoke extra verification and repeated work. Both stacks reached
the requested values or answer in **54/54 trials** if identical repeated saves are allowed.
The original strict score is retained; do not describe this result as a wrong-account edit or
claim that plain is generally more reliable.

The primary cost and time totals retain this trial and every other trial. A diagnostic removes
both `run-063` and `run-064`: on Terra's remaining 17 successful, naturally completed pairs
with complete usage, plain cost **19.9% less** and took **21.7% less time**. The respective
ratio intervals are 0.677–0.931× and 0.695–0.977×. Thus the aggregate Terra advantage is not
entirely caused by this repeated-save case. Luna and Astra's subsets are unchanged.

## Baseline correction and preparation

The artifact-reader helper previously canonicalized requested files but not its allowed output
directory. macOS resolves `/tmp` to `/private/tmp`, so valid linked snapshot files were rejected.
The fix canonicalizes both paths and retains containment checks against sibling directories,
traversal and symlink escapes. The previously rejected real snapshot and a regression test pass.
Five artifact reads in the corrected sample all succeeded.

The initial attempt was stopped after 23 recorded trials. Its complete data, including the
baseline timeout and deliberately interrupted last plain trial, are retained in
[preparation](preparation/exclusion.json), with [checksums](preparation/sha256.json).
Every trial from that attempt was excluded before a fresh 108-trial run on the corrected commit.
This is a harness correction, not an outcome-based removal of individual failures.

Preparation recorded **$0.372098602**, but two interrupted API requests returned no final usage.
That is a lower bound, not a complete invoice. The corrected sample recorded **$2.167853682**,
of which **$0.014309442** was Jev. Combined recorded API spending for these two attempts is
**$2.539952284**, excluding any unreported interrupted-call charges, local compute, subscriptions,
taxes, historical experiments and the benchmarking assistant's own work.

The original 108-trial baseline had eight rejected artifact reads; the contextual-targeting
follow-up had two. Those agents recovered through inline snapshots, potentially adding cost
and time. Their reports now carry limitation notices; raw measurements and hashes are preserved.
The batching ablation had no artifact reads and is unaffected. The current claim uses only the
corrected fresh baseline, not percentages combined across historical experiments.

## Validation and evidence

The independent audit reconstructed every trial's cost from uncached input, cache reads,
cache writes and output, then added measured Jev input at the captured rate. Reasoning is
included in output and is not charged twice. Maximum floating-point difference from reported
main-agent charges was below $0.000000000001. Hypothetical uncached repricing appears separately
and is not presented as an observed invoice.

The audit verified the complete randomized schedule, 18 trials per model/arm, frozen execution
source hashes and matching production runtime blobs. Provider/model pins match the manifest.
All requested saved fields and catalog codes were checked against independent fixture evidence.
All 18 validation workflows first received a rejection for `studio`, observed the visible
unavailability message, and only then used the requested fallback. Every batch returned ordered
results with consistent completed/remaining counts. No trial was discarded from the primary sample.

Seven benchmark tests pass, covering accounting, report handling of incomplete billing, artifact
containment, oracles and all six browser fixtures. The production code is unchanged from the
previously validated 140-test suite. Publication also checks artifact hashes, local links and
configured credentials against all artifacts, including decompressed traces.

The [machine-readable audit](audit.json), [summary](summary.json), [trials](runs.jsonl),
[manifest](manifest.json), [pricing](pricing.json), [compressed traces](traces.jsonl.gz) and
[checksums](sha256.json) support these conclusions. The suite omits live-site network behavior,
authentication, visual-only controls, CAPTCHA, mobile and desktop automation. It also constrains
both agents to the supplied text UI tools, rather than comparing arbitrary browser code or skills.
