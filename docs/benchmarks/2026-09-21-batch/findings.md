# Browser batching: interpretation

Read the [experiment report](../browser-batching.md) for implementation details, results,
reproduction instructions, validation and limitations.

This is a **36-trial batching ablation using Jev in both arms**. The control is plain with
individual-step tools, not Playwright MCP. The treatment adds the batch tool and usage guidance.
Both arms may issue multiple tool calls in one model turn. All six workflows and three model
tiers run once in each arm; every final trial is retained.

Both arms achieved 18/18 successes. Main-agent calls fell from 152 to 112 (26%). Recorded API cost
fell 15%, 7% and 13% for Luna, Terra and Astra. Record-editing costs increased for Terra and Astra;
the aggregates retain those regressions. Timing also reflects provider latency and stochastic
workflow choices, including differences on catalog trials that used no batch.

This screening sample has one repetition per task/model/arm and cannot estimate within-task
variance or establish production reliability. Terra's cost-ratio interval includes parity.
The measured runtime was frozen at `52075e3`; post-measurement cancellation hardening is documented
separately. Final API spending was $0.7700, including Jev in both arms. No paid preparation trials
or final-trial exclusions are omitted from these totals.
