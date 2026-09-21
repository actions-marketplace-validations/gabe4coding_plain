# Contextual action targeting experiment

> **Baseline limitation:** two snapshot-file reads were incorrectly rejected by the benchmark
> helper. Baseline recovery may inflate the cost and time below. See the
> [corrected comparison](current-browser-comparison.md); do not use these historical ratios as
> evidence of savings against a fully functioning baseline.

This follow-up tests the information-loss diagnosis from the [initial benchmark](2026-09-21/findings.md).
The implementation at `8812f8e` adds bounded row/card/group evidence to browser action candidates.
It preserves candidate IDs and duplicate-label ordinals, rebuilds context on each action, and keeps
Jev responsible for choosing the target. Snapshot filtering, prompts, tool schemas, thresholds,
batching and post-action responses are unchanged.

For example, a repeated control can now reach Jev as:

```text
button[type=button] "View details" #54 context: article heading="Field notebook 32" text="In stock"
```

The original candidate contained only the button description and ordinal. The new evidence is
collected from DOM relationships; the main agent does not need to infer an ordinal from a snapshot.
Context excludes nested semantic items, hidden text and form values, and is bounded by ancestor,
node and character limits. This is a heuristic for conventional DOM layouts, not complete visual
or accessibility-tree understanding.

## Results

All **18/18 Jev-assisted attempts** and **18/18 fresh baseline attempts** succeeded. The matching
historical Jev-assisted sample succeeded in 10/18 attempts. Every new initial product/row action
picked the intended item; no Jev-assisted trial reopened the page or reported a failed action.
All nine row-edit trials saved exactly once, on the correct row, with the requested email.

| Main model | Jev-assisted successes, before → after | Main-agent calls, before → after | Mean cost per successful task after / fresh baseline | Mean seconds after / fresh baseline |
|---|---:|---:|---:|---:|
| Luna (small) | 2/6 → 6/6 | 71 → 44 | $0.001986 / $0.001675 | 17.8 / 28.6 |
| Terra (medium) | 2/6 → 6/6 | 55 → 43 | $0.013029 / $0.016041 | 18.7 / 18.8 |
| Astra (top) | 6/6 → 6/6 | 72 → 40 | $0.053331 / $0.067788 | 16.0 / 27.4 |

Across the 18 Jev-assisted workflows, main-agent calls fell from **198 to 127 (36%)** relative
to the historical sample. The fresh baseline used 125 calls. Against that fresh baseline,
measured cost was **18.6% higher for Luna, 18.8% lower for Terra and 21.3% lower for Astra**.
Mean elapsed time was 37.7%, 0.6% and 41.4% lower respectively. These are observed differences
on two selected workflows, not general savings or speed guarantees.

The aggregate cost advantage comes from catalog browsing. Record editing remained more expensive
than the fresh baseline in every tier (+41% Luna, +12% Terra, +23% Astra), while catalog costs were
7%, 50% and 57% lower respectively. Terra's catalog runs were also 45% slower despite their lower
cost. Every aggregate model-tier cost interval includes parity with the baseline; with only two
task clusters, those intervals are especially limited.

The evidence supports the missing-context diagnosis: the same natural-language product/row targets
now resolve correctly on the first attempt. The whole-workflow result also improves, despite
sending more descriptive evidence per candidate. It does not establish that every smart snapshot
or every Jev-assisted action saves money. Luna still costs more than its baseline, and context does
not remove the separate calls needed to edit and verify a form.

Recorded final-sample API spending was **$0.9231**, including **$0.0100** for Jev. An excluded
preparation sample recorded another $0.1271 before a code-review correction for headings wrapped
inside articles. All ten preparation trials, including the interrupted last trial, were excluded
before restarting the final run on the corrected commit. Unreported in-flight charges may be
missing from preparation spending; this is not a complete development invoice.

The regular suite passed **135 tests**, including four new browser regressions covering repeated
card controls, row isolation, hidden text and form values, bounded context, wrapped headings,
shadow hosts, preserved ordinals/action identity, and refreshed evidence after a DOM update.
Independent accounting reconstructed every final trial's API cost from recorded tokens and rates.
All 36 final trials had complete usage and natural completion, with no output-capped generation.

See the [full tables and traces](2026-09-21-context/README.md),
[per-trial data](2026-09-21-context/runs.jsonl), and
[excluded preparation record](2026-09-21-context/preparation-samples.json).

## Measurement

The frozen workflow harness runs the two previously problematic tasks, **catalog and record editing**,
three times with each of the same small, medium and top models. Both plainwright and the pinned
Playwright MCP baseline run afresh: 36 trials, including 18 Jev-assisted attempts. Each trial
measures the entire browser workflow, including discovery, actions, verification and recovery.

Task fixtures, agent prompts, harness source hashes, dependency versions and pricing match the
original experiment. The implementation commit, selected task subset, resulting randomized schedule,
and execution time differ. See the [full protocol](browser-workflows.md) for accounting and limits.

The before/after comparison uses only the matching catalog/record trials from the original sample,
with the same models, variants and repetitions. It is a historical comparison, not a randomized
old-code/new-code ablation. Provider load, stochastic model behavior and cache conditions can change.
The fresh baseline comparison is paired within this follow-up run.

These tasks were selected because they previously failed. They are useful for diagnosis but cannot
support a general claim about all workflows. The four other task types have not been remeasured.
Intervals generated by the standard analysis have only two task clusters here and should not be
interpreted as broad performance guarantees.

## Reproduce

With the dependencies and API keys described in the [protocol](browser-workflows.md):

```sh
node scripts/workflow-benchmark/run.mjs \
  --baseline=/tmp/plainwright-benchmark-baseline/node_modules/@playwright/mcp/cli.js \
  --out=/tmp/plainwright-context-results --tasks=catalog,record \
  --repeats=3 --seed=210926 --budget=5
node scripts/workflow-benchmark/analyze.mjs /tmp/plainwright-context-results
node scripts/workflow-benchmark/report.mjs /tmp/plainwright-context-results /tmp/plainwright-context-report
```

The original 108-trial artifacts remain unchanged. This experiment changes only candidate context;
batched form edits and post-action evidence remain separate, unimplemented experiments.
