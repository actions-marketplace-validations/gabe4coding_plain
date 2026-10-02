import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { expandIncludes, splitSource } from './include.js';
import { loadSpec, interpolate } from './spec.js';
import { loadComputerSpec } from './computer-spec.js';
import { loadMobileSpec, mobileLabel } from './mobile-spec.js';
import { label } from './results.js';

function fixture(t: import('node:test').TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainwright-include-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, raw: unknown) => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, stringify(raw));
    return file;
  };
  return { dir, write, root: path.join(dir, 'root.yaml') };
}

test('nested includes resolve from each source, keep placeholders, and label their actual origin', (t) => {
  const { write } = fixture(t);
  write('flows/nested/next.yaml', { steps: [{ click: '${hooks.button}' }] });
  write('flows/login.yaml', { steps: [{ fill: { target: 'Name', value: '${env.user}' } }, { include: './nested/next.yaml' }] });
  const spec = loadSpec(write('root.yaml', { name: 'root', url: 'about:blank', env: { user: 'Ada' }, steps: [{ goto: 'about:blank' }, { include: 'flows/login.yaml' }] }));
  assert.equal(spec.steps.length, 3);
  assert.equal(spec.steps[0].origin, undefined);
  assert.equal(spec.steps[1].origin, path.join('flows', 'login.yaml'));
  assert.equal(spec.steps[2].origin, path.join('flows', 'nested', 'next.yaml'));
  assert.equal(label(spec.steps[2]), `${path.join('flows', 'nested', 'next.yaml')} › click "\${hooks.button}"`);
  const resolved = interpolate(spec.steps, { env: spec.env!, hooks: { button: 'Login' } }, spec.name);
  assert.equal(label(resolved[2]), `${path.join('flows', 'nested', 'next.yaml')} › click "Login"`);
  assert.equal(resolved[1].kind === 'fill' && resolved[1].value, 'Ada');
});

test('the same flow can be included twice and paths can leave the root folder', (t) => {
  const { write } = fixture(t);
  write('shared.yaml', { steps: [{ press: 'Enter' }] });
  const file = write('tests/root.yaml', { steps: [] });
  assert.deepEqual(expandIncludes([{ include: '../shared.yaml' }, { include: '../shared.yaml', optional: false }], file).map((step) => splitSource(step).step),
    [{ press: 'Enter', origin: '../shared.yaml' }, { press: 'Enter', origin: '../shared.yaml' }]);
});

test('include cycles name the complete chain, including a cycle through a symlink', (t) => {
  const { root, write, dir } = fixture(t);
  write('flows/b.yaml', { steps: [{ include: '../root.yaml' }] });
  assert.throws(() => expandIncludes([{ include: 'flows/b.yaml' }], root), /root.yaml → flows[/\\]b.yaml → root.yaml/);
  write('root.yaml', { steps: [{ include: 'alias.yaml' }] });
  fs.symlinkSync(root, path.join(dir, 'alias.yaml'));
  assert.throws(() => expandIncludes([{ include: 'alias.yaml' }], root), /root.yaml → alias.yaml/);
});

test('included files reject extra keys and malformed steps with the source filename', (t) => {
  const { root, write } = fixture(t);
  for (const key of ['name', 'env', 'hooks', 'browser', 'timeout']) {
    write('bad.yaml', { steps: [], [key]: {} });
    assert.throws(() => expandIncludes([{ include: 'bad.yaml' }], root), new RegExp(`bad.yaml:.*"${key}"`));
  }
  for (const raw of [null, [], 'flow', {}, { steps: {} }]) {
    write('bad.yaml', raw);
    assert.throws(() => expandIncludes([{ include: 'bad.yaml' }], root), /bad.yaml:.*(steps|included file)/);
  }
  assert.throws(() => expandIncludes([{ include: 'missing.yaml' }], root), /missing.yaml:.*ENOENT/);
});

test('include directives reject optional true, extra action keys, and invalid paths', (t) => {
  const { root } = fixture(t);
  assert.throws(() => expandIncludes([{ include: 'flow.yaml', optional: true }], root), /optional: true on include.*v1/);
  assert.throws(() => expandIncludes([{ include: 'flow.yaml', click: 'Login' }], root), /unexpected key "click"/);
  for (const include of [null, {}, '', '   ', 123])
    assert.throws(() => expandIncludes([{ include }], root), /include must be a non-empty path/);
});

test('user origin is rejected in root steps, flow steps, and include directives', (t) => {
  const { root, write } = fixture(t);
  for (const step of [{ click: 'Login', origin: 'fake' }, { include: 'flow.yaml', origin: 'fake' }])
    assert.throws(() => expandIncludes([step], root), /root.yaml: origin: reserved/);
  write('flow.yaml', { steps: [{ click: 'Login', origin: 'fake' }] });
  assert.throws(() => expandIncludes([{ include: 'flow.yaml' }], root), /flow.yaml: origin: reserved/);
});

test('desktop and mobile loaders expand includes and preserve origin labels', (t) => {
  const { write } = fixture(t);
  write('desktop-flow.yaml', { steps: [{ click: 'Save' }] });
  write('mobile-flow.yaml', { steps: [{ tap: 'Save' }, { swipe: 'up' }] });
  const computer = loadComputerSpec(write('desktop.yaml', { name: 'desktop', app: 'Fixture', timeout: 1000, steps: [{ include: 'desktop-flow.yaml' }] }));
  const mobile = loadMobileSpec(write('mobile.yaml', { name: 'mobile', platform: 'android', device: 'fixture', app: 'app.fixture', timeout: 1000, steps: [{ include: 'mobile-flow.yaml' }] }));
  assert.equal(label(computer.steps[0]), 'desktop-flow.yaml › click "Save"');
  assert.equal(mobileLabel(mobile.steps[0]), 'mobile-flow.yaml › tap "Save"');
  assert.equal(mobileLabel(mobile.steps[1]), 'mobile-flow.yaml › swipe up');
});
