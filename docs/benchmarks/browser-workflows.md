# Browser workflow cost benchmark

This benchmark compares a main agent using plain (with Jev) with the same model using
Microsoft's Playwright MCP. It measures **complete UI workflows**, not snapshot compression in
isolation. Results apply to these synthetic tasks and this agent harness; they are not a claim
about every website, coding agent, or Playwright integration.

## Protocol

Six local, disposable browser tasks run three times per model and tool stack: 108 trials total.
The main models are `openai/gpt-5.6-luna`, `openai/gpt-5.6-terra`, and `openai/gpt-6-astra`,
through Vercel AI Gateway restricted to the OpenAI provider, with low reasoning effort.
Those are the returned model IDs, not immutable dated model snapshots. Jev uses the pinned
TypeSafe model `jev-1.13.0`.

| Task | Work required | Independent success check |
|---|---|---|
| Contact | Fill two fields and save | Exact saved name and email |
| Preferences | Change two selects and two checkboxes | Exact saved preferences, including no promotional email |
| Catalog | Find one item among 72 and open its details | Report the pickup code shown only on its detail page |
| Record | Choose one of 18 repeated Edit buttons, update email | Exactly one save, on the correct row, with the correct email |
| Wizard | Name a project, advance, choose template and visibility | Exact saved project configuration |
| Validation | Reserve an alias, recover if unavailable | Exact saved fallback alias and owner email |

Pairs share a task variant and model. A seeded shuffle chooses pair order and which stack runs
first. Trials run sequentially to avoid competition for the local browser. Each gets a fresh
browser process/context and conversation. The same installed Chromium executable runs both
stacks at 1280×720. The stacks retain their own Playwright versions and normal settling logic.
No timings or failures are discarded as outliers. Development pilots are excluded.

The agent sees the task, URL, tool descriptions, and a short usage guide for its stack.
It chooses its own actions, inspections, verification, and recovery. Calls in one model response
execute sequentially. A trial ends at `finish`, a final text response, 20 model generations,
an error, or a 180-second deadline. Success comes from saved fixture state or the requested
answer, never from the agent saying it succeeded. The fixture checks are also tested through
real browser controls before measurement.

All tools explicitly use `strict: false` in the model API adapter, while retaining each MCP
server's own argument validation. This preserves genuinely optional MCP fields and free-form
step objects. Leaving strictness unspecified can cause Responses to normalize schemas and
require optional fields; see [OpenAI's function-calling documentation](https://developers.openai.com/api/docs/guides/function-calling#strict-mode).
During the original benchmark's preparation, a sample was stopped after 45 recorded trials when a controlled probe demonstrated
that a raw snapshot request acquired an unwanted `intent` argument under that default. The
entire preliminary sample, both stacks, was excluded. The product code and tasks were unchanged;
the corrected adapter was verified before restarting the formal sample. Two further preparation
trials (one interrupted) were excluded while clarifying the smart-only `intent` argument in the
agent guide. These preparation costs are recorded separately from the final sample.

The report distinguishes oracle success (the requested state or answer was reached) from a
natural completion (the agent also finished before a turn limit, timeout or error). A run can
save the correct state and continue inspecting until its limit; its full cost and elapsed time
still count. This distinction prevents a correct saved state from concealing an unfinished agent.

This is a **text-based UI-tool comparison**. Both arms omit arbitrary JavaScript execution,
network inspection, screenshots, shell access, hooks, and application source inspection.
The baseline retains bulk form filling, accessible selectors, snapshot search, scoped snapshots,
and the default snapshot-file behavior of `@playwright/mcp@0.0.82`. Both agents can read browser
snapshot artifacts through the same restricted `read_artifact` helper. The baseline is not forced
to reread an entire tree after each action. Current plain runs expose `open`, `step`, `batch`,
`find`, and `snapshot`; the original run predates `batch`. All snapshot modes are available and none is forced. Natural-language targeting is
required in its arm. This compares two tool stacks, not an isolated causal ablation of Jev.

The corrected harness at `0c1698e` canonicalizes artifact directories and requested paths before
checking containment. Earlier baseline comparisons rejected valid files under macOS's `/tmp`
symlink and required inline-snapshot recovery. See the [correction record](current-browser-comparison.md);
the old relative cost/time figures are qualified and must not support current savings claims.

## Cost and timing accounting

Every model generation records input, output, reasoning, cache-read and cache-write usage.
Main-agent cost uses the gateway's reported dollar cost. A separate reconstruction uses the
captured pricing catalog, including cache-write premiums and long-context tiers. Reasoning
tokens are already included in output usage and are not charged twice.

The benchmark preloads a passive HTTP observer in the plain MCP process to capture
actual Jev input/output usage, HTTP status and latency for each attempt. It records no keys,
request headers or request bodies. Jev costs $0.042 per million input tokens, with free output,
according to [TypeSafe's model documentation](https://docs.typesafe.ai/models).
Main-model prices are saved from the [gateway model catalog](https://ai-gateway.vercel.sh/v1/models).
See also [gateway pricing](https://vercel.com/docs/ai-gateway/pricing).

Total cost includes every recorded main-agent and Jev call, including recovery and verification.
Cost per successful task divides **all** trial spending by the number of successes, charging
failures to that denominator. Missing API usage is flagged, never treated as evidence of free
execution. These are API costs, excluding local compute, subscriptions, taxes and setup work.

Wall time starts immediately before the first main-model call and ends when the task ends.
It includes browser startup/navigation, snapshots, actions, Jev calls, model inference, recovery,
and network latency. MCP startup/tool discovery and shutdown are outside that interval; startup
is recorded separately. Token savings alone do not establish speed savings.

Caching is left enabled as provided by the service, including reuse between trials. Randomized
paired order reduces order bias but does not make cache conditions identical. A separate
**hypothetical uncached cost** reprices all measured main input tokens at the uncached rate;
it is a sensitivity analysis, not an observed bill or an uncached latency experiment.

Comparisons use ratios of total cost and total elapsed time across the same trials. A seeded
10,000-sample cluster bootstrap resamples task types, retaining paired arms and repetitions,
to show 95% intervals. Six task types are a small sample; these intervals do not establish
generalization to real websites. Per-task results and the subset where both arms succeeded
are also retained, so fast failures cannot hide behind an aggregate.

## Reproduce

Use Node 22+, the checkout's installed dependencies and Chromium, and configured
`AI_GATEWAY_API_KEY` and `TYPESAFE_API_KEY`. The runner follows the CLI's `.env` and user-env
loading order. This is opt-in and makes paid API calls; the default spend ceiling is $25,
checked between generations/trials, so an in-flight call can exceed it slightly.

```sh
npm ci
npm run build
npx playwright install chromium
npm install --prefix /tmp/plain-benchmark-baseline --ignore-scripts --no-audit --no-fund @playwright/mcp@0.0.82
node --test scripts/workflow-benchmark/*.test.mjs
node scripts/workflow-benchmark/run.mjs \
  --baseline=/tmp/plain-benchmark-baseline/node_modules/@playwright/mcp/cli.js \
  --out=/tmp/plain-workflow-results --repeats=3 --seed=210926 --budget=25
node scripts/workflow-benchmark/analyze.mjs /tmp/plain-workflow-results
node scripts/workflow-benchmark/report.mjs /tmp/plain-workflow-results /tmp/plain-workflow-report
```

An optional figure uses Python with Matplotlib (`3.9.4` and NumPy `2.0.2` for the checked-in
figure): `python3 scripts/workflow-benchmark/plot.py /tmp/plain-workflow-report`.

The output directory must be new. `--models=` and `--tasks=` accept comma-separated subsets
for smoke runs; do not mix them with the formal sample. The manifest saves the schedule,
prompts, allowed tools, versions, machine information and harness source hashes. `runs.jsonl`
contains every trial's usage, calls, cost, timing and independent outcome. Per-trial traces
retain the public synthetic UI evidence. `summary.json` is regenerated by the analysis script.

The fixture server has no oracle endpoint. Browser actions submit saved values to a local event
collector, and the harness checks them in memory after the agent stops. The main agent cannot
read fixture source, expected state, other trials, or API credentials through its tools.

## Batching ablation

New runs expose the browser `batch` tool in the plain arm. Historical reports retain their
original tool schemas and prompts. To isolate batching instead of comparing browser stacks, use
`--comparison=batch`. Both arms then launch the same plain runtime, with the same contextual
targeting, Jev model, fixtures and main-agent settings. `plain` exposes `batch` plus a short
usage instruction; `plain-unbatched` exposes only the individual-step tools and the previous
guide. Both can emit several tool calls in one model turn. Calls execute sequentially in both arms.

The manifest records the arm names and exact guides. This comparison measures the effect of exposing
batching with its guidance, including its schema/context overhead. It is not a comparison against
Playwright MCP and does not isolate API shape from prompting. Every individual action inside a batch
still resolves fresh targets and incurs its own Jev usage, captured by the same HTTP observer.

For a first pass across all six workflows and three main models (36 whole-workflow trials):

```sh
node scripts/workflow-benchmark/run.mjs --comparison=batch \
  --out=/tmp/plain-batch-results --repeats=1 --seed=210926 --budget=5
node scripts/workflow-benchmark/analyze.mjs /tmp/plain-batch-results
node scripts/workflow-benchmark/report.mjs /tmp/plain-batch-results /tmp/plain-batch-report
```

No separate Playwright MCP installation is needed for this mode. One repetition per task/model/arm
is a screening experiment: it cannot estimate within-task variability or establish reliability.
Retain every final trial and report independent outcomes alongside cost per successful task.
