import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { intelligence } from './automation.js';
import { loadSpec } from './spec.js';
import { runSpec, closeSharedBrowser } from './runner.js';
import { runSuite } from './suite.js';
import type { SuiteOptions } from './suite-types.js';

// Two buttons in one headed section, so the picked one has context; clicking "Go" writes a line the claim checks.
const PAGE = '<main><section><h2>Actions</h2><button onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<p>Clicked Go</p>\')">Go</button>' +
  '<button onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<p>Clicked Stop</p>\')">Stop</button></section></main>';

test('browser: a warm run acts on the same element without a pick call', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainwright-pick-cache-browser-'));
  const { pick, judge } = intelligence;
  t.after(async () => {
    intelligence.pick = pick; intelligence.judge = judge;
    await closeSharedBrowser();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = `data:text/html,${encodeURIComponent(PAGE)}`;
  const file = path.join(dir, 'go.yaml');
  fs.writeFileSync(file, `name: go\nurl: "${url}"\nsteps:\n  - goto: "${url}"\n  - click: the Go button\n  - expect: Go was clicked\n`);
  let picks = 0;
  intelligence.pick = async (candidates, targets) => {
    picks++;
    const go = candidates.find((c) => c.desc.startsWith('button "Go"'));
    return targets.map((_, i) => ({ id: go?.id ?? null, probability: 0.97, probabilities: {}, tokens: i === 0 ? 50 : 0 }));
  };
  intelligence.judge = async (state, claims) => {
    const { aria } = state as { aria: string };
    return { probabilities: claims.map(() => (/Clicked Go/.test(aria) && !/Clicked Stop/.test(aria) ? 0.97 : 0.02)), tokens: 3 };
  };
  const opts: SuiteOptions = { files: [file], workers: 1, retries: 0, bail: 0, lastFailed: false, tags: [], list: false, reporters: [], timing: false };
  const engine = { engine: 'browser' as const, maxWorkers: Infinity, load: loadSpec,
    meta: (spec: ReturnType<typeof loadSpec>) => ({ name: spec.name, tags: [] }),
    run: (spec: ReturnType<typeof loadSpec>, observer: Parameters<typeof runSpec>[2], info: Parameters<typeof runSpec>[3]) =>
      runSpec(spec, { headed: false, timeout: 5000 }, observer, info) };
  const services = { provider: () => 'typesafe' as const, warmUp: () => {} };
  const cwd = process.cwd(), error = console.error;
  process.chdir(dir); console.error = () => {};
  try {
    const cold = await runSuite(engine, opts, services);
    assert.equal(cold.status, 'pass', JSON.stringify(cold.specs[0].attempts[0].steps));
    assert.equal(picks, 1);
    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, 'go.picks.json'), 'utf8'));
    assert.match(sidecar.entries['1|click|the Go button|'].desc, /^button "Go" context: section heading="Actions"/);
    assert.equal(sidecar.entries['1|click|the Go button|'].list, undefined, 'a desc with context needs no list hash');

    const warm = await runSuite(engine, opts, services);
    assert.equal(warm.status, 'pass', JSON.stringify(warm.specs[0].attempts[0].steps));
    assert.equal(picks, 1, 'no pick call on the warm run');
    const click = warm.specs[0].attempts[0].steps[1];
    assert.equal(click.cached, true);
    assert.match(click.detail!, /^→ button "Go".*\(cached pick\)$/);
    assert.equal(warm.totals.cachedPicks, 1);
  } finally { process.chdir(cwd); console.error = error; }
});
