// Preload for benchmark-steps.mjs (node --import): counts the pick and claim calls a CLI run makes, by
// wrapping the shared `intelligence` object of the build under test, and writes the counts to
// $PLAINWRIGHT_BENCH_COUNT when the process exits. Benchmark-only: nothing in src/ loads it.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const out = process.env.PLAINWRIGHT_BENCH_COUNT;
const dist = process.env.PLAINWRIGHT_BENCH_DIST;
if (out && dist) {
  const { intelligence } = await import(pathToFileURL(path.resolve(dist, 'core/automation.js')).href);
  const counts = { pickCalls: 0, pickTargets: 0, pickTokens: 0, judgeCalls: 0, judgeTokens: 0,
    routeCalls: 0, routeGroups: 0, routeTokens: 0 };
  const { pick, judge, ask } = intelligence;
  intelligence.ask = async (state, questions) => {
    const result = await ask(state, questions);
    if (state && typeof state === 'object' && Array.isArray(state.groups)) {
      counts.routeCalls++; counts.routeGroups += state.groups.length; counts.routeTokens += result.tokens;
    }
    return result;
  };
  intelligence.pick = async (candidates, targets, state) => {
    const picks = await pick(candidates, targets, state);
    counts.pickCalls++; counts.pickTargets += targets.length;
    for (const p of picks) counts.pickTokens += p.tokens;
    return picks;
  };
  intelligence.judge = async (state, claims) => {
    const result = await judge(state, claims);
    counts.judgeCalls++; counts.judgeTokens += result.tokens;
    return result;
  };
  process.on('exit', () => writeFileSync(out, JSON.stringify(counts)));
}
