// Publish a completed run's auditable evidence and readable tables. Does not edit README claims.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const source = resolve(process.argv[2]);
const destination = resolve(process.argv[3]);
const summary = JSON.parse(readFileSync(resolve(source, 'summary.json')));
const manifest = JSON.parse(readFileSync(resolve(source, 'manifest.json')));
const armNames = manifest.arms ?? ['plainwright', 'playwright'];
const [treatment, control] = armNames;
const toolFiles = armNames.map(arm => `${arm}-tools.json`);
const runsText = readFileSync(resolve(source, 'runs.jsonl'), 'utf8');
const runs = runsText.trim().split('\n').map(s => JSON.parse(s));
const incomplete = runs.filter(r => !r.usageComplete);
if (!summary.complete || runs.length !== manifest.schedule.length) throw new Error('Cannot publish an incomplete sample');
for (let i = 0; i < runs.length; i++) {
  for (const key of ['model', 'task', 'repeat', 'arm']) if (runs[i][key] !== manifest.schedule[i][key]) throw new Error(`Schedule mismatch in ${runs[i].id}`);
}
mkdirSync(destination, { recursive: true });
// Keep exact measured costs and usage. Scrub host home/temp prefixes from artifact paths only.
const sanitize = text => text.replaceAll(process.env.HOME, '<home>').replace(/\/private\/var\/folders\/[^"\s]+?(?=\/plainwright\/)/g, '<tmp>').replace(/\/var\/folders\/[^"\s]+?(?=\/plainwright\/)/g, '<tmp>');
const dataFiles = ['manifest.json', 'pricing.json', 'summary.json', 'runs.jsonl', ...toolFiles,
  ...(existsSync(resolve(source, 'audit.json')) ? ['audit.json'] : [])];
for (const file of dataFiles) {
  writeFileSync(resolve(destination, file), sanitize(readFileSync(resolve(source, file), 'utf8')));
}
const traces = runs.map(r => JSON.stringify({ id: r.id, ...JSON.parse(readFileSync(resolve(source, `${r.id}-trace.json`), 'utf8')) })).join('\n') + '\n';
const compressed = gzipSync(sanitize(traces));
writeFileSync(resolve(destination, 'traces.jsonl.gz'), compressed);
const hashes = Object.fromEntries([...dataFiles, 'traces.jsonl.gz'].map(file => [file, createHash('sha256').update(readFileSync(resolve(destination, file))).digest('hex')]));
writeFileSync(resolve(destination, 'sha256.json'), JSON.stringify(hashes, null, 2) + '\n');

const money = v => v.toFixed(6);
const ratio = v => Number.isFinite(v) ? `${v.toFixed(2)}×` : '—';
const tier = model => model.split('/')[1];
const lines = [
  `# Browser workflow results — ${manifest.startedAt.slice(0, 10)}`, '',
  `${runs.length} trials; ${manifest.tasks.length} synthetic workflows, ${manifest.repeats} repetition${manifest.repeats === 1 ? '' : 's'}, two tool configurations and ${manifest.models.length} main models. Total recorded API cost: **$${summary.totalCost.toFixed(4)}**. Development pilots and the benchmarking agent’s own work are excluded.`, '',
  ...(incomplete.length ? [`**Incomplete billing:** ${incomplete.length} trial(s) lack final usage for at least one request. Costs below are recorded charges and may underestimate actual spending. Affected trials: ${incomplete.map(r => r.id).join(', ')}. Ratios involving these trials are not exact total-cost comparisons.`, ''] : []),
  'See the [protocol and reproduction instructions](../browser-workflows.md). These are measurements of this harness and task suite, not a general website-performance guarantee.', '',
  ...(manifest.comparison === 'batch' ? ['This is a batching ablation: both arms use the same plainwright/Jev implementation. Only `plainwright` exposes `batch` and its usage guidance; `plainwright-unbatched` uses individual steps. The control is **not Playwright MCP**.', ''] : []),
  ...(existsSync(resolve(destination, 'findings.md')) ? ['Read the [interpretation and failure analysis](findings.md).', ''] : []),
  ...(existsSync(resolve(destination, 'comparison.svg')) ? ['![Cost, elapsed time and task success by main model](comparison.svg)', ''] : []),
  '## Full-sample results', '',
  'All trials, including failures, contribute to cost and time. Success means the independent task oracle passed. Successful natural completions additionally require the agent to finish before a limit/error.', '',
  '| Main model | Stack | Oracle successes | Successful natural completions | Mean cost/task | Cost/success (failures included) | Mean seconds | Median seconds | p95 seconds |',
  '|---|---|---:|---:|---:|---:|---:|---:|---:|',
];
for (const [model, arms] of Object.entries(summary.byModel)) for (const arm of [...armNames].reverse()) {
  const m = arms[arm];
  lines.push(`| ${tier(model)} | ${arm} | ${m.successes}/${m.trials} | ${m.naturalCompletions}/${m.trials} | $${money(m.meanCost)} | ${m.costPerSuccess == null ? '—' : '$' + money(m.costPerSuccess)} | ${m.meanSeconds.toFixed(1)} | ${m.medianSeconds.toFixed(1)} | ${m.p95Seconds.toFixed(1)} |`);
}
lines.push('', '## Paired comparisons', '', `Ratios are ${treatment} / ${control}. Below 1 means lower cost or less elapsed time. Intervals resample task types, preserving repetitions and pairs; they are descriptive and based on a small suite.`, '', '| Main model | Cost ratio [95% interval] | Time ratio [95% interval] | Cost ratio, both succeeded | Time ratio, both succeeded |', '|---|---:|---:|---:|---:|');
for (const [model, arms] of Object.entries(summary.byModel)) {
  const c = arms.comparison, s = summary.pairedSuccessful[model];
  lines.push(`| ${tier(model)} | ${ratio(c.costRatio)} [${c.costRatio95.map(ratio).join(', ')}] | ${ratio(c.timeRatio)} [${c.timeRatio95.map(ratio).join(', ')}] | ${ratio(s.costRatio)} | ${ratio(s.timeRatio)} |`);
}
lines.push('', '## Usage and cost sensitivity', '', 'Main-agent input totals include repeatedly supplied conversation context. Cached reads and writes are subsets of that input. Output includes reasoning. The uncached column is a hypothetical repricing of measured usage, not a second experiment.', '', '| Main model | Stack | Main calls | Browser/helper calls | Main input | Cache reads | Cache writes | Main output | Reasoning | Jev calls | Jev input | Jev cost | Hypothetical uncached mean cost |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const [model, arms] of Object.entries(summary.byModel)) for (const arm of [...armNames].reverse()) {
  const m = arms[arm];
  lines.push(`| ${tier(model)} | ${arm} | ${m.mainCalls} | ${m.browserCalls} | ${m.inputTokens} | ${m.cachedInputTokens} | ${m.cacheWriteTokens} | ${m.outputTokens} | ${m.reasoningTokens} | ${m.jevCalls} | ${m.jevInputTokens} | $${money(m.jevCost)} | $${money(m.meanNoCacheCost)} |`);
}
lines.push('', '## Where elapsed time goes', '', 'Means per trial. Model time includes API latency and inference; tool time includes browser work and Jev calls. Different tool stacks and provider latency both affect the observed speed; this is not an isolated measure of Jev inference speed.', '', '| Main model | Stack | Main-model seconds | Browser/helper seconds |', '|---|---|---:|---:|');
for (const [model, arms] of Object.entries(summary.byModel)) for (const arm of [...armNames].reverse()) {
  const m = arms[arm];
  lines.push(`| ${tier(model)} | ${arm} | ${(m.mainSeconds / m.trials).toFixed(1)} | ${(m.browserSeconds / m.trials).toFixed(1)} |`);
}
for (const model of manifest.models) {
  lines.push('', `## Tasks: ${tier(model)}`, '', `Treatment: ${treatment}; control: ${control}.`, '', '| Task | Successes: treatment / control | Mean cost: treatment / control | Mean seconds: treatment / control |', '|---|---:|---:|---:|');
  for (const task of manifest.tasks) {
    const p = summary.byTask[`${model}/${task}`][treatment], b = summary.byTask[`${model}/${task}`][control];
    lines.push(`| ${task} | ${p.successes}/${p.trials} / ${b.successes}/${b.trials} | $${money(p.meanCost)} / $${money(b.meanCost)} | ${p.meanSeconds.toFixed(1)} / ${b.meanSeconds.toFixed(1)} |`);
  }
}
const limited = runs.filter(r => !['finish', 'text'].includes(r.ended));
const outputCapped = runs.filter(r => r.main.some(m => m.usage.outputTokens >= 4096));
lines.push('', '## Limits and evidence', '',
  `- Non-natural terminations: ${limited.length}. ${limited.map(r => `${r.id}: ${r.ended}, oracle ${r.success ? 'passed' : 'failed'}`).join('; ') || 'None.'}`,
  `- Trials with incomplete usage accounting: ${incomplete.length}. ${incomplete.map(r => r.id).join(', ') || 'All calls had usable accounting.'}`,
  `- Trials containing an output-capped generation (4,096 tokens): ${outputCapped.length}. ${outputCapped.map(r => r.id).join(', ') || 'None.'} Malformed calls and their recovery costs remain in the primary results. These can reflect model/tool-schema integration, not just UI targeting.`,
  '- Production behavior was frozen during the run. Failures, recoveries and expensive outliers remain in the sample.',
  '- This suite has no authentication, CAPTCHA, real network-dependent application data, visual-only controls, mobile or desktop automation. It does not test direct Playwright code generation or CLI/skills agents.',
  `- Model aliases, API load, caching, machine conditions and prompts can change the results. Repetitions per task: ${manifest.repeats}; this does not establish a production reliability rate.`,
  '- Costs use reported gateway charges plus measured Jev input tokens at its published rate. They exclude local hardware, subscriptions, taxes and setup.',
  '',
  'Artifacts: [summary](summary.json), [per-trial measurements](runs.jsonl), [manifest and exact prompts](manifest.json), [pricing snapshot](pricing.json), [compressed traces](traces.jsonl.gz), and [SHA-256 checksums](sha256.json). Host home/temp prefixes in paths are sanitized; measured usage and costs are preserved.',
  '');
lines.push('## Sensitivity: pairs without an output-capped generation', '', 'This diagnostic excludes **both** arms of a pair if either reached the generation output cap. It is not the headline sample. It shows whether generation failures dominate the comparison.', '', '| Main model | Remaining trials | Cost ratio | Time ratio |', '|---|---:|---:|---:|');
for (const [model, s] of Object.entries(summary.noOutputCapSensitivity)) lines.push(`| ${tier(model)} | ${s.trials} | ${ratio(s.costRatio)} | ${ratio(s.timeRatio)} |`);
lines.push('');
if (summary.pairedSuccessfulCompleteNatural) {
  lines.push('## Sensitivity: successful, naturally completed pairs with complete usage', '',
    'This diagnostic retains a pair only when both arms succeeded, finished naturally and have complete usage. The full sample above retains every trial; this filtered subset is not a replacement for it.', '',
    '| Main model | Remaining pairs | Cost ratio | Time ratio |', '|---|---:|---:|---:|');
  for (const [model, s] of Object.entries(summary.pairedSuccessfulCompleteNatural)) lines.push(`| ${tier(model)} | ${s.pairs} | ${ratio(s.costRatio)} | ${ratio(s.timeRatio)} |`);
  lines.push('');
}
writeFileSync(resolve(destination, 'README.md'), lines.join('\n'));
console.log(JSON.stringify({ destination, trials: runs.length, cost: summary.totalCost, incompleteUsage: incomplete.length, traceBytes: compressed.length }));
