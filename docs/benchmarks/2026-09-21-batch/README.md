# Browser workflow results — 2026-09-21

36 trials; 6 synthetic workflows, 1 repetition, two tool configurations and 3 main models. Total recorded API cost: **$0.7700**. Development pilots and the benchmarking agent’s own work are excluded.

See the [protocol and reproduction instructions](../browser-workflows.md). These are measurements of this harness and task suite, not a general website-performance guarantee.

This is a batching ablation: both arms use the same plain/Jev implementation. Only `plain` exposes `batch` and its usage guidance; `plain-unbatched` uses individual steps. The control is **not Playwright MCP**.

Read the [interpretation and failure analysis](findings.md).

## Full-sample results

All trials, including failures, contribute to cost and time. Success means the independent task oracle passed. Natural completions additionally require the agent to finish before a limit/error.

| Main model | Stack | Oracle successes | Natural completions | Mean cost/task | Cost/success (failures included) | Mean seconds | Median seconds | p95 seconds |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| gpt-5.6-luna | plain-unbatched | 6/6 | 6/6 | $0.0017 | $0.0017 | 25.4 | 23.7 | 38.3 |
| gpt-5.6-luna | plain | 6/6 | 6/6 | $0.0014 | $0.0014 | 17.9 | 19.5 | 21.5 |
| gpt-5.6-terra | plain-unbatched | 6/6 | 6/6 | $0.0119 | $0.0119 | 20.8 | 22.1 | 25.8 |
| gpt-5.6-terra | plain | 6/6 | 6/6 | $0.0111 | $0.0111 | 16.8 | 15.3 | 25.3 |
| gpt-6-astra | plain-unbatched | 6/6 | 6/6 | $0.0546 | $0.0546 | 22.5 | 21.9 | 29.1 |
| gpt-6-astra | plain | 6/6 | 6/6 | $0.0476 | $0.0476 | 20.3 | 20.1 | 24.2 |

## Paired comparisons

Ratios are plain / plain-unbatched. Below 1 means lower cost or less elapsed time. Intervals resample task types, preserving repetitions and pairs; they are descriptive and based on a small suite.

| Main model | Cost ratio [95% interval] | Time ratio [95% interval] | Cost ratio, both succeeded | Time ratio, both succeeded |
|---|---:|---:|---:|---:|
| gpt-5.6-luna | 0.85× [0.74×, 0.94×] | 0.71× [0.56×, 0.90×] | 0.85× | 0.71× |
| gpt-5.6-terra | 0.93× [0.85×, 1.02×] | 0.80× [0.69×, 0.93×] | 0.93× | 0.80× |
| gpt-6-astra | 0.87× [0.79×, 0.95×] | 0.90× [0.84×, 0.97×] | 0.87× | 0.90× |

## Usage and cost sensitivity

Main-agent input totals include repeatedly supplied conversation context. Cached reads and writes are subsets of that input. Output includes reasoning. The uncached column is a hypothetical repricing of measured usage, not a second experiment.

| Main model | Stack | Main calls | Browser/helper calls | Main input | Cache reads | Cache writes | Main output | Reasoning | Jev calls | Jev input | Jev cost | Hypothetical uncached mean cost |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| gpt-5.6-luna | plain-unbatched | 51 | 47 | 121422 | 108820 | 12449 | 2143 | 408 | 38 | 49145 | $0.0021 | $0.0048 |
| gpt-5.6-luna | plain | 38 | 32 | 93082 | 82008 | 10960 | 1709 | 287 | 36 | 47192 | $0.0020 | $0.0038 |
| gpt-5.6-terra | plain-unbatched | 51 | 45 | 114422 | 103309 | 10960 | 1774 | 204 | 32 | 42779 | $0.0018 | $0.0420 |
| gpt-5.6-terra | plain | 38 | 32 | 97129 | 85777 | 11238 | 1614 | 204 | 32 | 42870 | $0.0018 | $0.0359 |
| gpt-6-astra | plain-unbatched | 50 | 44 | 112810 | 100050 | 12610 | 1342 | 0 | 23 | 33196 | $0.0014 | $0.1994 |
| gpt-6-astra | plain | 36 | 30 | 89403 | 77313 | 11982 | 1133 | 0 | 23 | 23490 | $0.0010 | $0.1586 |

## Where elapsed time goes

Means per trial. Model time includes API latency and inference; tool time includes browser work and Jev calls. Different tool stacks and provider latency both affect the observed speed; this is not an isolated measure of Jev inference speed.

| Main model | Stack | Main-model seconds | Browser/helper seconds |
|---|---|---:|---:|
| gpt-5.6-luna | plain-unbatched | 21.3 | 4.0 |
| gpt-5.6-luna | plain | 13.8 | 4.1 |
| gpt-5.6-terra | plain-unbatched | 17.2 | 3.7 |
| gpt-5.6-terra | plain | 12.8 | 4.0 |
| gpt-6-astra | plain-unbatched | 19.2 | 3.3 |
| gpt-6-astra | plain | 16.9 | 3.4 |

## Tasks: gpt-5.6-luna

Treatment: plain; control: plain-unbatched.

| Task | Successes: treatment / control | Mean cost: treatment / control | Mean seconds: treatment / control |
|---|---:|---:|---:|
| contact | 1/1 / 1/1 | $0.0009 / $0.0009 | 13.0 / 13.6 |
| preferences | 1/1 / 1/1 | $0.0010 / $0.0016 | 12.9 / 24.2 |
| catalog | 1/1 / 1/1 | $0.0015 / $0.0016 | 19.9 / 42.4 |
| record | 1/1 / 1/1 | $0.0020 / $0.0024 | 21.7 / 22.5 |
| wizard | 1/1 / 1/1 | $0.0016 / $0.0019 | 19.1 / 26.3 |
| validation | 1/1 / 1/1 | $0.0014 / $0.0015 | 21.1 / 23.2 |

## Tasks: gpt-5.6-terra

Treatment: plain; control: plain-unbatched.

| Task | Successes: treatment / control | Mean cost: treatment / control | Mean seconds: treatment / control |
|---|---:|---:|---:|
| contact | 1/1 / 1/1 | $0.0073 / $0.0080 | 14.4 / 15.8 |
| preferences | 1/1 / 1/1 | $0.0115 / $0.0130 | 14.8 / 21.8 |
| catalog | 1/1 / 1/1 | $0.0074 / $0.0092 | 10.2 / 15.1 |
| record | 1/1 / 1/1 | $0.0206 / $0.0187 | 27.9 / 26.5 |
| wizard | 1/1 / 1/1 | $0.0098 / $0.0113 | 15.8 / 23.6 |
| validation | 1/1 / 1/1 | $0.0100 / $0.0113 | 17.4 / 22.4 |

## Tasks: gpt-6-astra

Treatment: plain; control: plain-unbatched.

| Task | Successes: treatment / control | Mean cost: treatment / control | Mean seconds: treatment / control |
|---|---:|---:|---:|
| contact | 1/1 / 1/1 | $0.0283 / $0.0321 | 16.5 / 18.6 |
| preferences | 1/1 / 1/1 | $0.0339 / $0.0443 | 16.9 / 20.8 |
| catalog | 1/1 / 1/1 | $0.0526 / $0.0686 | 16.8 / 16.8 |
| record | 1/1 / 1/1 | $0.0863 / $0.0858 | 23.4 / 23.0 |
| wizard | 1/1 / 1/1 | $0.0424 / $0.0486 | 23.8 / 25.7 |
| validation | 1/1 / 1/1 | $0.0422 / $0.0482 | 24.4 / 30.2 |

## Limits and evidence

- Non-natural terminations: 0. None.
- Trials with incomplete usage accounting: 0. All calls had usable accounting.
- Trials containing an output-capped generation (4,096 tokens): 0. None. Malformed calls and their recovery costs remain in the primary results. These can reflect model/tool-schema integration, not just UI targeting.
- Production behavior was frozen during the run. Failures, recoveries and expensive outliers remain in the sample.
- This suite has no authentication, CAPTCHA, real network-dependent application data, visual-only controls, mobile or desktop automation. It does not test direct Playwright code generation or CLI/skills agents.
- Model aliases, API load, caching, machine conditions and prompts can change the results. Repetitions per task: 1; this does not establish a production reliability rate.
- Costs use reported gateway charges plus measured Jev input tokens at its published rate. They exclude local hardware, subscriptions, taxes and setup.

Artifacts: [summary](summary.json), [per-trial measurements](runs.jsonl), [manifest and exact prompts](manifest.json), [pricing snapshot](pricing.json), [compressed traces](traces.jsonl.gz), and [SHA-256 checksums](sha256.json). Host home/temp prefixes in paths are sanitized; measured usage and costs are preserved.

## Sensitivity: pairs without an output-capped generation

This diagnostic excludes **both** arms of a pair if either reached the generation output cap. It is not the headline sample. It shows whether generation failures dominate the comparison.

| Main model | Remaining trials | Cost ratio | Time ratio |
|---|---:|---:|---:|
| gpt-5.6-luna | 12 | 0.85× | 0.71× |
| gpt-5.6-terra | 12 | 0.93× | 0.80× |
| gpt-6-astra | 12 | 0.87× | 0.90× |
