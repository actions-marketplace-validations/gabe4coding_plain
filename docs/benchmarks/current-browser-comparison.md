# Current plain versus Playwright MCP

This is a fresh, direct comparison of current plain (contextual action candidates and
batching enabled) against Playwright MCP 0.0.82. It measures complete browser workflows and
does not combine percentages from the earlier implementation experiments.

## Results

The completed run recorded **$2.167853682** across 108 trials, with complete usage accounting.
Costs include Jev and main-agent calls. Ratios below are plain / Playwright MCP; intervals
resample the six task types while preserving repetitions and paired arms.

| Main model | Cost change [95% ratio interval] | Mean time change [95% ratio interval] | Strict oracle: plain / baseline |
|---|---:|---:|---:|
| Luna | +6.5% [0.967–1.163×] | −52.1% [0.368–0.622×] | 18/18 / 18/18 |
| Terra | −23.8% [0.664–0.907×] | −25.5% [0.662–0.943×] | 18/18 / 17/18 |
| Astra | −10.3% [0.767–1.058×] | −51.2% [0.380–0.647×] | 18/18 / 18/18 |

Luna and Astra's cost intervals include parity. Both stacks reached the desired values or answer
in all trials; the baseline's one strict failure was a second save of the correct account after
reloading a fixture whose display resets. Removing both sides of that pair leaves Terra 19.9%
cheaper and 21.7% faster. Do not interpret the strict success difference as a production reliability
advantage. Astra account editing cost 19.7% more; Terra catalog browsing took 53.9% longer.

See the [complete tables](2026-09-21-current/README.md),
[interpretation and audit](2026-09-21-current/findings.md), and
[raw evidence](2026-09-21-current/runs.jsonl). All 108 trials remain in the primary results.

## Protocol

The measured plain revision is `0c1698e`. Both stacks run all six local workflows with
the same small, medium and top main-agent models, three repetitions per task/model/stack:
**108 trials, comprising 54 paired comparisons**. Both implementations and the corrected execution harness were
frozen throughout the run. Analysis and publication code was extended to flag incomplete billing
and report pairs with successful natural completion and complete usage; execution was unchanged.
The seed `210926` determines pair order and which stack runs first.

The task variants and randomized schedule match the original full benchmark. Playwright MCP's
version, guide, tool set and dependency versions are unchanged. The artifact reader now
canonicalizes both the allowed directory and requested path; earlier runs incorrectly rejected
valid snapshot files when macOS resolved `/tmp` to `/private/tmp`. Plain's guide now explains
batching, and its tool set includes `batch`. Both agents may issue multiple tool calls in one
model turn. The baseline retains bulk form filling and its normal snapshot-file behavior.

Main models are `openai/gpt-5.6-luna`, `openai/gpt-5.6-terra` and `openai/gpt-6-astra`, through
the configured gateway restricted to the OpenAI provider, with low reasoning effort. Jev is
pinned to `jev-1.13.0`. Provider aliases are not immutable dated model snapshots. API prices,
model IDs, cache usage, exact prompts, tool schemas and source hashes are recorded in the artifacts.

Trials run serially in fresh headless browser sessions using the same installed Chromium
executable. They include discovery, actions, verification, recovery, browser startup/navigation,
model calls and Jev calls. MCP setup and teardown are outside the elapsed-time measurement.
Independent fixture oracles check the requested saved state or answer. Every final trial,
including failures, contributes to cost and time; no outliers are discarded.

Cost per successful task includes spending on failures. Cached input, cache writes, output and
reasoning are accounted for at the captured rates and checked against reported API charges.
The separate uncached repricing is hypothetical, not a second run. Task-cluster intervals
resample the six workflow types while preserving paired arms and repetitions.

These are six synthetic UI workflows, with no real network-dependent application data,
authentication, CAPTCHA, screenshots, arbitrary browser code, or CSS fallbacks in the Jev arm.
Results describe this tool-stack comparison, not an isolated causal effect of Jev or a guarantee
for arbitrary websites. See the [shared protocol](browser-workflows.md) for full scope and accounting.

## Reproduce

After installing the dependencies, Chromium and the pinned baseline as described in the protocol:

```sh
node scripts/workflow-benchmark/run.mjs --comparison=playwright \
  --baseline=/tmp/plain-benchmark-baseline/node_modules/@playwright/mcp/cli.js \
  --out=/tmp/plain-current-results --repeats=3 --seed=210926 --budget=10
node scripts/workflow-benchmark/analyze.mjs /tmp/plain-current-results
node scripts/workflow-benchmark/report.mjs /tmp/plain-current-results /tmp/plain-current-report
```

The original [108-trial report](2026-09-21/README.md),
[contextual-targeting experiment](contextual-targeting.md), and
[batching ablation](browser-batching.md) remain separate, with baseline-limitation notices added to the affected reports.
The new comparison uses
fresh baseline trials rather than treating their historical costs as a current control.

## Excluded preparation and earlier baseline limitation

The first attempt at this comparison was stopped after 23 recorded trials when the artifact-reader
audit found the path-canonicalization bug. It recorded $0.372098602; two interrupted requests had
no final usage, so this is a lower bound on preparation charges. The whole attempt, both arms,
is excluded from the corrected comparison. The [exclusion record](2026-09-21-current/preparation/exclusion.json)
and [compressed traces](2026-09-21-current/preparation/traces.jsonl.gz) preserve that attempt.
The Luna baseline timeout is retained in that record;
the final plain trial was interrupted deliberately to fix the harness.

The original 108-trial report had eight rejected artifact reads, and the contextual-targeting
follow-up had two. Their baseline agents recovered using inline snapshots, but recovery could
increase cost and time. Those comparisons cannot establish savings against a fully functioning
Playwright MCP integration. Their raw measurements remain available with this limitation marked.
The batching ablation had no artifact reads and is unaffected by this bug.
