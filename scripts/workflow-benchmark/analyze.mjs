import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? '/tmp/plainwright-workflow-benchmark');
const runs = readFileSync(resolve(dir, 'runs.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json')));
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
const mean = (xs, f) => sum(xs, f) / xs.length;
const quantile = (xs, q) => { const sorted = [...xs].sort((a, b) => a - b); const position = (sorted.length - 1) * q; const low = Math.floor(position); return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low); };
const metrics = xs => ({
  trials: xs.length, successes: xs.filter(r => r.success).length,
  naturalCompletions: xs.filter(r => r.success && ['finish', 'text'].includes(r.ended)).length,
  terminations: Object.fromEntries([...new Set(xs.map(r => r.ended))].map(ended => [ended, xs.filter(r => r.ended === ended).length])),
  totalCost: sum(xs, r => r.totalCost), meanCost: mean(xs, r => r.totalCost),
  costPerSuccess: xs.some(r => r.success) ? sum(xs, r => r.totalCost) / xs.filter(r => r.success).length : null,
  meanNoCacheCost: mean(xs, r => r.noCacheCost),
  meanSeconds: mean(xs, r => r.elapsedMs / 1000), medianSeconds: quantile(xs.map(r => r.elapsedMs / 1000), 0.5), p95Seconds: quantile(xs.map(r => r.elapsedMs / 1000), 0.95),
  mainCalls: sum(xs, r => r.main.length), browserCalls: sum(xs, r => r.calls.length), jevCalls: sum(xs, r => r.jev.length),
  inputTokens: sum(xs, r => sum(r.main, m => m.usage.inputTokens ?? 0)),
  cachedInputTokens: sum(xs, r => sum(r.main, m => m.usage.inputTokenDetails.cacheReadTokens ?? 0)),
  cacheWriteTokens: sum(xs, r => sum(r.main, m => m.usage.inputTokenDetails.cacheWriteTokens ?? 0)),
  outputTokens: sum(xs, r => sum(r.main, m => m.usage.outputTokens ?? 0)),
  reasoningTokens: sum(xs, r => sum(r.main, m => m.usage.outputTokenDetails.reasoningTokens ?? 0)),
  jevInputTokens: sum(xs, r => sum(r.jev, j => j.usage?.input_tokens ?? 0)),
  mainSeconds: sum(xs, r => sum(r.main, m => m.elapsedMs / 1000)), browserSeconds: sum(xs, r => sum(r.calls, c => c.elapsedMs / 1000)),
  mainCost: sum(xs, r => r.mainCost), jevCost: sum(xs, r => r.jevCost),
  incompleteUsageTrials: xs.filter(r => !r.usageComplete).length,
  outputLimitGenerations: sum(xs, r => r.main.filter(m => m.usage.outputTokens >= 4096).length),
  nonObjectToolArguments: sum(xs, r => r.calls.filter(c => c.input === null || typeof c.input !== 'object').length),
  maxReportedCostDrift: Math.max(0, ...xs.flatMap(r => r.main.filter(m => m.reportedCost != null).map(m => Math.abs(m.reportedCost - m.listCost)))),
});

// Cluster bootstrap over task types, retaining every repetition and paired arm.
// This interval describes only this small task suite, not the population of websites.
function comparison(xs) {
  const tasks = [...new Set(xs.map(r => r.task))];
  let rng = 210926;
  const random = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return (rng >>> 0) / 4294967296; };
  const ratio = (sample, key) => sum(sample.filter(r => r.arm === 'plainwright'), r => r[key]) / sum(sample.filter(r => r.arm === 'playwright'), r => r[key]);
  const cost = [], speed = [];
  for (let i = 0; i < 10000; i++) {
    const sample = tasks.flatMap(() => { const task = tasks[Math.floor(random() * tasks.length)]; return xs.filter(r => r.task === task); });
    cost.push(ratio(sample, 'totalCost')); speed.push(ratio(sample, 'elapsedMs'));
  }
  return { costRatio: ratio(xs, 'totalCost'), costRatio95: [quantile(cost, .025), quantile(cost, .975)], timeRatio: ratio(xs, 'elapsedMs'), timeRatio95: [quantile(speed, .025), quantile(speed, .975)] };
}
const models = manifest.models.filter(model => runs.some(r => r.model === model));
const byModel = Object.fromEntries(models.map(model => {
  const xs = runs.filter(r => r.model === model);
  return [model, { plainwright: metrics(xs.filter(r => r.arm === 'plainwright')), playwright: metrics(xs.filter(r => r.arm === 'playwright')), comparison: comparison(xs) }];
}));
const byTask = Object.fromEntries(models.flatMap(model => manifest.tasks.map(task => [`${model}/${task}`, Object.fromEntries(['plainwright', 'playwright'].map(arm => [arm, metrics(runs.filter(r => r.model === model && r.task === task && r.arm === arm))]))])));
const pairedSuccess = runs.filter(r => r.success && runs.some(o => o.model === r.model && o.task === r.task && o.repeat === r.repeat && o.arm !== r.arm && o.success));
// Diagnostic sensitivity only; the primary sample always retains output-capped generations.
const noOutputCap = runs.filter(r => !runs.some(o => o.model === r.model && o.task === r.task && o.repeat === r.repeat && o.main.some(m => m.usage.outputTokens >= 4096)));
const report = { trials: runs.length, plannedTrials: manifest.schedule.length, complete: runs.length === manifest.schedule.length, totalCost: sum(runs, r => r.totalCost), byModel, byTask, pairedSuccessful: Object.fromEntries(models.map(model => [model, comparison(pairedSuccess.filter(r => r.model === model))])), noOutputCapSensitivity: Object.fromEntries(models.map(model => { const xs = noOutputCap.filter(r => r.model === model); return [model, { trials: xs.length, ...comparison(xs) }]; })) };
writeFileSync(resolve(dir, 'summary.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ trials: report.trials, plannedTrials: report.plannedTrials, totalCost: report.totalCost, byModel }, null, 2));
