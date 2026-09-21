import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('analysis and publication retain both arms and their costs for legacy and batching comparisons', () => {
  for (const comparison of ['playwright', 'batch']) {
    const dir = mkdtempSync(join(tmpdir(), 'plainwright-analysis-'));
    try {
      const control = comparison === 'batch' ? 'plainwright-unbatched' : 'playwright';
      const arms = ['plainwright', control];
      const runs = arms.map((arm, i) => ({ id: `run-${i + 1}`, model: 'test/model', task: 'contact', repeat: 0, arm,
        success: true, ended: 'finish', elapsedMs: i ? 2000 : 1000, totalCost: i ? 1 : 2,
        mainCost: i ? 1 : 1.5, jevCost: i ? 0 : .5, noCacheCost: 3, usageComplete: true,
        main: [{ elapsedMs: 500, reportedCost: i ? 1 : 1.5, listCost: i ? 1 : 1.5,
          usage: { inputTokens: 10, inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 }, outputTokens: 2, outputTokenDetails: { reasoningTokens: 0 } } }],
        jev: i ? [] : [{ usage: { input_tokens: 4 } }], calls: [{ name: 'open', input: {}, elapsedMs: 20 }],
      }));
      const manifest = { startedAt: '2026-09-21', models: ['test/model'], tasks: ['contact'], repeats: 1, schedule: runs,
        ...(comparison === 'batch' ? { comparison, arms } : {}) };
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
      writeFileSync(join(dir, 'runs.jsonl'), runs.map(r => JSON.stringify(r)).join('\n'));
      writeFileSync(join(dir, 'pricing.json'), '{}');
      for (const arm of arms) writeFileSync(join(dir, `${arm}-tools.json`), '[]');
      for (const r of runs) writeFileSync(join(dir, `${r.id}-trace.json`), '{"trace":[]}');
      execFileSync(process.execPath, [new URL('./analyze.mjs', import.meta.url).pathname, dir]);
      const summary = JSON.parse(readFileSync(join(dir, 'summary.json')));
      assert.equal(summary.totalCost, 3);
      assert.equal(summary.byModel['test/model'].comparison.costRatio, 2);
      assert.equal(summary.byModel['test/model'].comparison.timeRatio, .5);
      assert.equal(summary.byModel['test/model'][control].successes, 1);
      const out = join(dir, 'published');
      execFileSync(process.execPath, [new URL('./report.mjs', import.meta.url).pathname, dir, out]);
      const report = readFileSync(join(out, 'README.md'), 'utf8');
      assert.ok(report.includes(`plainwright / ${control}`));
      const hashes = JSON.parse(readFileSync(join(out, 'sha256.json')));
      assert.ok(hashes[`${control}-tools.json`]);
      if (comparison === 'batch') assert.match(report, /control is \*\*not Playwright MCP\*\*/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
