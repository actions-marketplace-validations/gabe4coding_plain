import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonlReporter } from './jsonl.js';

test('native reporter prints one JSON line with the legacy result fields', async () => {
  const lines: string[] = [];
  const old = console.log;
  console.log = (line) => { lines.push(line); };
  try {
    await jsonlReporter().specEnd!({ report: { file: 'test.yaml', name: 'native', tags: [], status: 'pass', flaky: false,
      attempts: [{ name: 'native', status: 'pass', steps: [{ step: 'tap "Save"', status: 'pass' }],
        jevCalls: 2, totalTokens: 9, attempt: 0, durationMs: 12, artifacts: [] }] } });
  } finally { console.log = old; }
  assert.deepEqual(lines, ['{"name":"native","status":"pass","steps":[{"step":"tap \\"Save\\"","status":"pass"}],"jevCalls":2,"totalTokens":9}']);
});
