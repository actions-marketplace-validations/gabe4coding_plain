# Browser batching experiment

This experiment measures whole browser workflows with and without the new `batch` tool. Both arms
use plain with contextual action candidates and Jev. It does **not** compare against
Playwright MCP; the [earlier stack comparison](2026-09-21/README.md) and
[contextual-targeting follow-up](contextual-targeting.md) remain separate.

## Results

Both arms completed **18/18 workflows successfully**. Exposing batching reduced total main-agent
calls from **152 to 112 (26.3%)**. Agents used 21 batch calls containing 60 actions across all 15
non-catalog treatment trials. The three catalog treatment trials used individual actions.

| Main model | Main-agent calls, batch / individual | Mean cost per successful task, batch / individual | Cost change | Mean seconds, batch / individual | Time change |
|---|---:|---:|---:|---:|---:|
| Luna (small) | 38 / 51 | $0.001406 / $0.001659 | −15.3% | 17.9 / 25.4 | −29.2% |
| Terra (medium) | 38 / 51 | $0.011108 / $0.011909 | −6.7% | 16.8 / 20.8 | −19.6% |
| Astra (top) | 36 / 50 | $0.047634 / $0.054612 | −12.8% | 20.3 / 22.5 | −9.9% |

These are observed differences in this screening sample. The six-task cost-ratio intervals were
0.74–0.94 for Luna, 0.85–1.02 for Terra and 0.79–0.95 for Astra; Terra's includes parity. With one
repetition per task, the intervals cannot capture within-task run-to-run variability. A larger
repeated sample is needed before claiming general savings or speedups.

Preferences showed the clearest reduction in decisions: 5 main-agent calls with batching versus
10, 9 and 9 individually for Luna, Terra and Astra. Their five-action batches all completed
successfully. Record editing was mixed: Terra used 9 calls in both arms and cost 10% more with
batching; Astra used 7 versus 8 calls but cost 0.5% more. Those regressions are retained in the
aggregate. Batching is useful when several known actions can be grouped; it does not remove the
need to inspect unfamiliar state or eliminate the cost of its own schema and result payload.

Timing needs particular caution. Luna's catalog task took 19.9s versus 42.4s despite using no
batch and five main-agent calls in each arm. That difference cannot be attributed to fewer batch
round trips. Provider latency and stochastic workflow choices contribute to the elapsed-time
comparison. Likewise, task-level cost differences where batching was unused are not evidence
that a batch executed more cheaply.

All recorded main-agent charges were independently reconstructed from tokens and captured rates;
Jev charges were reconstructed from observed HTTP usage in **both** arms. Every final trial had
complete usage and natural completion, with no output-capped generation. All 21 batches passed,
with correct indexed outcomes and per-step token totals. Record edits saved only the intended
row; all validation trials attempted the preferred alias, observed rejection, then saved the
correct fallback. No final trials were excluded, and no paid preparation trials were run.

Final-sample API spending was **$0.7700**, including **$0.0100 for Jev**. This excludes the coding
agent's own work and local infrastructure. The full implementation passed **140 product tests**;
the benchmark suite passed **6 tests**, including legacy/batching report compatibility.

See the [full tables and traces](2026-09-21-batch/README.md),
[per-trial measurements](2026-09-21-batch/runs.jsonl), and
[exact settings and prompts](2026-09-21-batch/manifest.json).

## What changed

`batch {steps:[...]}` accepts 1–16 ordinary step objects. It validates all step syntax and hook
placeholders before acting, then resolves and executes each action sequentially against the current
page. The first non-pass stops the batch; later entries are not attempted. Passing entries are
recorded individually for replay. The browser tool queue prevents interleaved reads or actions.
The [agent-mode reference](../agent-mode.mdx#batching-known-actions) describes the full contract.

Batching reduces main-agent round trips. It does not combine Jev decisions or reuse stale target
IDs. Every action still pays for normal fresh target resolution. Its tool description, request
and indexed result also add tokens; those costs are included in the measurements.

## Protocol

The measured runtime is frozen at `52075e3`. The `plain` arm exposes `batch` and a short
instruction to use it for known action sequences. The `plain-unbatched` arm exposes the
same individual-step tools and the previous usage guide. Both arms may emit several tool calls
in one model response, so the control is not forced to take a separate model turn per action.
The harness rejects tools outside each arm's allowlist.

This is an intervention on **tool availability plus usage guidance**, not an isolated comparison
of API shape with identical prompting. Other runtime behavior, model settings, task fixtures,
oracle checks, browser configuration and accounting are shared. The exact prompts and schemas are
saved in the run artifacts. Both arms incur Jev charges.

After measurement, `d70b031` added request-cancellation checks before the batch and between entries,
plus a real MCP/browser cancellation regression. The benchmark's compiled runtime stayed unchanged
until all 36 trials finished. None was canceled, and the cancellation checks do not change normal
step execution. Reports retain the exact measured commit rather than relabeling its revision.

The sample includes all six local workflows (contact, preferences, catalog, record, wizard,
validation), all three main model tiers, and one repetition per task/model/arm: **36 trials**.
A seeded shuffle randomizes paired order and arm order. Trials run sequentially in fresh browser
sessions. Every final trial contributes to the result, including failures and recovery costs.

This is a first-pass experiment. One repetition cannot estimate within-task variability; six
synthetic workflows cannot establish production reliability or general cost/speed savings.
Task-cluster bootstrap intervals describe this limited suite. Provider load, stochastic decisions,
and cache reuse can affect the comparisons. See the [shared protocol](browser-workflows.md) for
the independent success checks, token accounting, timing boundaries and exclusions from scope.

## Reproduce

With the configured API keys, installed dependencies and Chromium:

```sh
node scripts/workflow-benchmark/run.mjs --comparison=batch \
  --out=/tmp/plain-batch-results --repeats=1 --seed=210926 --budget=5
node scripts/workflow-benchmark/analyze.mjs /tmp/plain-batch-results
node scripts/workflow-benchmark/report.mjs /tmp/plain-batch-results /tmp/plain-batch-report
```

The first arm in `manifest.arms` is the treatment; the second is the control. Published ratios are
treatment divided by control. Historical manifests without arm names retain the original
plain/Playwright MCP comparison. Analysis tests verify both formats, and the generalized
analyzer reproduces the two historical summaries exactly.
