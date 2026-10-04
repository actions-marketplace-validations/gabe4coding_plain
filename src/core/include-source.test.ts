import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSpec } from './spec.js';
import { loadComputerSpec } from '../computer/spec.js';
import { Xa11yAdapter } from '../computer/adapter.js';
import { label } from './results.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-include-source-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (name: string, body: string): string => {
  const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); return file;
};

test('a bad step inside an included file is reported at that file and its own index', () => {
  write('flows/f.yaml', 'steps:\n  - click: A\n  - clik: B\n');
  const root = write('r.yaml', 'name: r\nurl: https://example.com\nsteps:\n  - goto: /\n  - include: flows/f.yaml\n');
  assert.throws(() => loadSpec(root), /flows\/f\.yaml: step 1: unknown key "clik"; did you mean "click"\?/);
  const after = write('r2.yaml', 'name: r\nurl: https://example.com\nsteps:\n  - include: flows/ok.yaml\n  - clik: C\n');
  write('flows/ok.yaml', 'steps:\n  - click: A\n  - click: B\n');
  assert.throws(() => loadSpec(after), new RegExp(`${after.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: step 1: unknown key "clik"`));
  const desktop = write('d.yaml', 'name: d\napp: Notes\nsteps:\n  - include: flows/f.yaml\n');
  assert.throws(() => loadComputerSpec(desktop), /flows\/f\.yaml.*1/);
});

test('expanded steps keep only their own keys plus origin', () => {
  write('flows/ok.yaml', 'steps:\n  - click: A\n');
  const spec = loadSpec(write('k.yaml', 'name: k\nurl: https://example.com\nsteps:\n  - goto: /\n  - include: flows/ok.yaml\n'));
  assert.deepEqual(spec.steps.map(label), ['goto /', 'flows/ok.yaml › click "A"']);
  assert.deepEqual(Object.getOwnPropertySymbols(spec.steps[1]), []);
});

test('a closed desktop adapter refuses to act', async () => {
  const adapter = new Xa11yAdapter(100);
  await adapter.close();
  await assert.rejects(adapter.act('click', {} as never), /call open first/);
});
