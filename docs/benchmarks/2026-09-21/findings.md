# What the measurements support

> **Baseline limitation discovered during the later audit:** the benchmark helper rejected all 8
> attempted snapshot-file reads because it compared canonical `/private/tmp` paths with `/tmp`.
> Baseline agents recovered using inline snapshots, adding potential cost and time. These figures
> do not establish savings against a fully functioning baseline. See the
> [corrected comparison](../current-browser-comparison.md). Raw measurements are preserved.

The current implementation does **not** support a general “cheaper and faster” claim. The
complete sample shows a tradeoff: some workflows finish sooner, but main-agent spending and
recovery work increase. Results apply to this natural-language-targeting harness and six local
fixtures; plainwright's CSS escape hatch and arbitrary browser code were excluded.

| Main model | Mean cost per attempt vs baseline | Cost per successful task vs baseline | Mean elapsed time vs baseline | Successes, Jev / baseline |
|---|---:|---:|---:|---:|
| Luna | +50.3% | +93.2% | −30.9% | 14/18 / 18/18 |
| Terra | +3.9% | +33.6% | −2.9% | 14/18 / 18/18 |
| Astra | +30.7% | +30.7% | −21.7% | 18/18 / 18/18 |

Cost per success includes money spent on failures. Elapsed-time averages include every attempt,
so early wrong answers can look fast. On pairs where both stacks succeeded, the time ratios
were 0.64 for Luna, 0.94 for Terra and 0.78 for Astra, with cost ratios of 1.52, 1.23 and 1.31.
That successful-pair subset is diagnostic, not a replacement for the full sample.

Astra gives the cleanest comparison at equal observed completion: mean wall time was 24.9s
with plainwright versus 31.8s with Playwright MCP, at $0.0657 versus $0.0503 per task. Its
task-cluster 95% time-ratio interval is 0.62–1.02, which includes no improvement. Eighteen
successes do not establish a production reliability rate, and this sample does not justify a
guaranteed speed claim.

## Why cost did not fall

Across the 54 Jev-assisted attempts, Jev itself cost **$0.0184**. The main agent made **522 calls**,
versus **422** with the baseline. Each model tier also consumed more total main-agent input
tokens with plainwright: +40% for Luna, +15% for Terra and +48% for Astra. Smaller individual
snapshots did not translate into less conversation context over the whole workflow.

Cached context made repeated reads relatively inexpensive. However, removing that discount in
the hypothetical repricing still leaves plainwright more expensive in all three tiers. Cache
pricing alone does not explain the result. The detailed report separates model-call time from
browser/helper time; API latency and each stack's browser settling behavior also affect speed.

## A concrete information-loss problem

All six Luna/Terra catalog attempts returned another product's pickup code. One row-edit
attempt per model also failed. The fixture oracle caught these even when the agent or tool
reported success. In `run-012`, a wrong account was modified before the intended account was
updated, violating the requirement to leave other accounts unchanged.

The candidate description builder in [page.ts](../../../src/page.ts) includes the element's own
text/attributes and an ordinal for duplicate descriptions, but not its surrounding article or
row text. In `run-004`, a smart snapshot retained **Field notebook 32**, yet targeting its
**View details** button selected the 32nd repeated button and returned **OTHER-31**. The smart
snapshot and the action's candidate evidence are separate representations; retaining the heading
in the former did not preserve that relationship in the latter.

Astra recovered in all three catalog cases by reading more context and targeting the **54th
View details button**. Those extra inspections and retries explain part of its higher cost.
The next implementation experiment should preserve bounded parent/row context in action
candidates, then rerun this frozen suite. This report makes no claim about that unimplemented fix.

## Evidence and preparation

The [full tables](README.md), [per-trial data](runs.jsonl), [compressed traces](traces.jsonl.gz),
and [protocol](../browser-workflows.md) provide the underlying measurements. All 108 final
trials had complete usage records, no output-capped generations, and cost reconstruction
matching gateway charges to floating-point precision. Five local fixture/accounting tests passed.

Final-sample API spending was **$2.6115**. [Preparation samples](preparation-samples.json) record
another $1.7235 in excluded pilots and interrupted samples. Standalone schema probes and
interrupted in-flight charges are not fully accounted for there, so this is not a complete
invoice for developing the benchmark. None of those preparation runs contributes to the result.
