# Contextual targeting: interpretation

> **Baseline limitation discovered during the later audit:** the benchmark helper rejected all 2
> attempted snapshot-file reads because it compared canonical `/private/tmp` paths with `/tmp`.
> Baseline agents recovered using inline snapshots, adding potential cost and time. These figures
> do not establish savings against a fully functioning baseline. See the
> [corrected comparison](../current-browser-comparison.md). Raw measurements are preserved.

Read the [experiment report](../contextual-targeting.md) for the implementation, before/after
comparison, test coverage, preparation exclusions, reproduction command and limitations.

This is a separate **36-trial, two-workflow follow-up**, not a replacement for the original
108-trial, six-workflow benchmark. All 18 Jev-assisted and all 18 fresh baseline workflows passed.
The matching historical Jev-assisted subset passed 10/18. Main-agent calls fell from 198 to 127
historically; the fresh baseline used 125.

The first product/row action selected the correct target in every Jev-assisted trial. No such
trial reopened its page or reported a failed action. Recorded API spending was $0.9231, excluding
the $0.1271 preparation sample documented in [preparation-samples.json](preparation-samples.json).

The two tasks were chosen because the original implementation failed on them. Cost and latency
ratios, including intervals based on only two task clusters, do not generalize to other sites or
the four unmeasured workflow types. The before/after comparison is historical; the fresh baseline
comparison is paired within this run. The implementation was frozen at `8812f8e` throughout the
final run, and no final trials were discarded.
