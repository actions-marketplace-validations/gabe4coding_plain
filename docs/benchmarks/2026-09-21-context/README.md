# Browser workflow results — 2026-09-21

36 trials; 2 synthetic workflows, 3 repetitions, two tool stacks and 3 main models. Total recorded API cost: **$0.9231**. Development pilots and the benchmarking agent’s own work are excluded.

See the [protocol and reproduction instructions](../browser-workflows.md). These are measurements of this harness and task suite, not a general website-performance guarantee.

Read the [interpretation and failure analysis](findings.md).

## Full-sample results

All trials, including failures, contribute to cost and time. Success means the independent task oracle passed. Natural completions additionally require the agent to finish before a limit/error.

| Main model | Stack | Oracle successes | Natural completions | Mean cost/task | Cost/success (failures included) | Mean seconds | Median seconds | p95 seconds |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| gpt-5.6-luna | playwright | 6/6 | 6/6 | $0.0017 | $0.0017 | 28.6 | 24.3 | 50.1 |
| gpt-5.6-luna | plainwright | 6/6 | 6/6 | $0.0020 | $0.0020 | 17.8 | 17.9 | 25.0 |
| gpt-5.6-terra | playwright | 6/6 | 6/6 | $0.0160 | $0.0160 | 18.8 | 17.0 | 31.2 |
| gpt-5.6-terra | plainwright | 6/6 | 6/6 | $0.0130 | $0.0130 | 18.7 | 19.1 | 23.5 |
| gpt-6-astra | playwright | 6/6 | 6/6 | $0.0678 | $0.0678 | 27.4 | 28.4 | 36.5 |
| gpt-6-astra | plainwright | 6/6 | 6/6 | $0.0533 | $0.0533 | 16.0 | 15.8 | 20.3 |

## Paired comparisons

Ratios are plainwright / Playwright MCP. Below 1 means lower cost or less elapsed time. Intervals resample task types, preserving repetitions and pairs; they are descriptive and based on a small suite.

| Main model | Cost ratio [95% interval] | Time ratio [95% interval] | Cost ratio, both succeeded | Time ratio, both succeeded |
|---|---:|---:|---:|---:|
| gpt-5.6-luna | 1.19× [0.93×, 1.41×] | 0.62× [0.58×, 0.71×] | 1.19× | 0.62× |
| gpt-5.6-terra | 0.81× [0.50×, 1.12×] | 0.99× [0.83×, 1.45×] | 0.81× | 0.99× |
| gpt-6-astra | 0.79× [0.43×, 1.23×] | 0.59× [0.57×, 0.61×] | 0.79× | 0.59× |

## Usage and cost sensitivity

Main-agent input totals include repeatedly supplied conversation context. Cached reads and writes are subsets of that input. Output includes reasoning. The uncached column is a hypothetical repricing of measured usage, not a second experiment.

| Main model | Stack | Main calls | Browser/helper calls | Main input | Cache reads | Cache writes | Main output | Reasoning | Jev calls | Jev input | Jev cost | Hypothetical uncached mean cost |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| gpt-5.6-luna | playwright | 44 | 38 | 149369 | 126370 | 22867 | 1482 | 290 | 0 | 0 | $0.0000 | $0.0053 |
| gpt-5.6-luna | plainwright | 44 | 38 | 128585 | 113451 | 15002 | 2095 | 646 | 25 | 79884 | $0.0034 | $0.0053 |
| gpt-5.6-terra | playwright | 40 | 34 | 135670 | 112690 | 22860 | 1360 | 229 | 0 | 0 | $0.0000 | $0.0479 |
| gpt-5.6-terra | plainwright | 43 | 37 | 116640 | 103470 | 13041 | 1764 | 308 | 26 | 82138 | $0.0034 | $0.0430 |
| gpt-6-astra | playwright | 41 | 35 | 123946 | 103847 | 19976 | 1039 | 0 | 0 | 0 | $0.0000 | $0.2152 |
| gpt-6-astra | plainwright | 40 | 34 | 107552 | 94364 | 13068 | 1158 | 0 | 21 | 75590 | $0.0032 | $0.1894 |

## Where elapsed time goes

Means per trial. Model time includes API latency and inference; tool time includes browser work and Jev calls. Different tool stacks and provider latency both affect the observed speed; this is not an isolated measure of Jev inference speed.

| Main model | Stack | Main-model seconds | Browser/helper seconds |
|---|---|---:|---:|
| gpt-5.6-luna | playwright | 24.3 | 4.3 |
| gpt-5.6-luna | plainwright | 14.7 | 3.1 |
| gpt-5.6-terra | playwright | 14.6 | 4.2 |
| gpt-5.6-terra | plainwright | 15.7 | 3.0 |
| gpt-6-astra | playwright | 23.2 | 4.2 |
| gpt-6-astra | plainwright | 13.0 | 3.0 |

## Tasks: gpt-5.6-luna

| Task | Successes: plainwright / baseline | Mean cost: plainwright / baseline | Mean seconds: plainwright / baseline |
|---|---:|---:|---:|
| catalog | 3/3 / 3/3 | $0.0015 / $0.0016 | 12.8 / 17.9 |
| record | 3/3 / 3/3 | $0.0025 / $0.0018 | 22.9 / 39.4 |

## Tasks: gpt-5.6-terra

| Task | Successes: plainwright / baseline | Mean cost: plainwright / baseline | Mean seconds: plainwright / baseline |
|---|---:|---:|---:|
| catalog | 3/3 / 3/3 | $0.0078 / $0.0157 | 14.7 / 10.2 |
| record | 3/3 / 3/3 | $0.0182 / $0.0163 | 22.7 / 27.4 |

## Tasks: gpt-6-astra

| Task | Successes: plainwright / baseline | Mean cost: plainwright / baseline | Mean seconds: plainwright / baseline |
|---|---:|---:|---:|
| catalog | 3/3 / 3/3 | $0.0326 / $0.0754 | 12.6 / 20.9 |
| record | 3/3 / 3/3 | $0.0741 / $0.0602 | 19.4 / 33.9 |

## Limits and evidence

- Non-natural terminations: 0. None.
- Trials with incomplete usage accounting: 0. All calls had usable accounting.
- Trials containing an output-capped generation (4,096 tokens): 0. None. Malformed calls and their recovery costs remain in the primary results. These can reflect model/tool-schema integration, not just UI targeting.
- Production behavior was frozen during the run. Failures, recoveries and expensive outliers remain in the sample.
- This suite has no authentication, CAPTCHA, real network-dependent application data, visual-only controls, mobile or desktop automation. It does not test direct Playwright code generation or CLI/skills agents.
- Model aliases, API load, caching, machine conditions and prompts can change the results. 3 repetitions per task do not establish a production reliability rate.
- Costs use reported gateway charges plus measured Jev input tokens at its published rate. They exclude local hardware, subscriptions, taxes and setup.

Artifacts: [summary](summary.json), [per-trial measurements](runs.jsonl), [manifest and exact prompts](manifest.json), [pricing snapshot](pricing.json), [compressed traces](traces.jsonl.gz), and [SHA-256 checksums](sha256.json). Host home/temp prefixes in paths are sanitized; measured usage and costs are preserved.

## Sensitivity: pairs without an output-capped generation

This diagnostic excludes **both** arms of a pair if either reached the generation output cap. It is not the headline sample. It shows whether generation failures dominate the comparison.

| Main model | Remaining trials | Cost ratio | Time ratio |
|---|---:|---:|---:|
| gpt-5.6-luna | 12 | 1.19× | 0.62× |
| gpt-5.6-terra | 12 | 0.81× | 0.99× |
| gpt-6-astra | 12 | 0.79× | 0.59× |
