import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PickStore, entryKey, normalizeDesc, makeEntry, match, parseFile, formatFile, sidecarPath, pageOf, listHash,
  DESC_FORMAT, PICK_FILE_VERSION, type PickRef, type PickIO,
} from './pick-cache.js';
import type { Candidate, Intelligence } from './automation.js';
import { runSuite } from './suite.js';
import { loadSpec } from './spec.js';
import { loadComputerSpec, type ComputerSpec } from './computer-spec.js';
import { ComputerSession, runComputerSpec } from './computer.js';
import type { ComputerAdapter } from './computer-adapter.js';
import type { RunReport, SuiteEngine, SuiteOptions } from './suite-types.js';
import { MODEL_BY_PROVIDER } from './jev.js';

const MODEL = MODEL_BY_PROVIDER.typesafe;
const state = { url: 'https://shop.test/cart?x=1#top', title: 'Cart' };
const ref = (index = 0, target = 'the Save button', goal?: string): PickRef => ({ at: { file: '/specs/a.yaml', index }, kind: 'click', target, goal });
const cands = (...descs: string[]): Candidate[] => descs.map((desc, id) => ({ id, desc }));
const memoryIO = (files: Record<string, string> = {}): PickIO & { files: Record<string, string> } => ({
  files,
  read: (file) => files[file],
  write: (file, text) => { files[file] = text; },
  remove: (file) => { delete files[file]; },
});

test('key, sidecar path, page and desc normalization', () => {
  assert.equal(entryKey(ref(3, 'Log in', 'buy a book')), '3|click|Log in|buy a book');
  assert.equal(entryKey(ref(3, 'Log in')), '3|click|Log in|');
  assert.equal(sidecarPath('/s/checkout.yaml'), '/s/checkout.picks.json');
  assert.equal(sidecarPath('/s/flows/login.yml'), '/s/flows/login.picks.json');
  assert.equal(pageOf(state), 'https://shop.test/cart');
  assert.equal(pageOf({ url: 'desktop://4242', title: 'TextEdit' }), 'desktop://TextEdit');
  assert.equal(pageOf({ url: 'mobile://ios/com.apple.mobilecal', title: 'x' }), 'mobile://ios/com.apple.mobilecal');
  // A fill changes value=, not the element: browser (raw) and native (JSON) forms are both dropped.
  assert.equal(normalizeDesc('input[type=text] value="alice" name="user"'), 'input[type=text] name="user"');
  assert.equal(normalizeDesc('text_field "Message" value="say \\"hi\\"" [focused]'), 'text_field "Message" [focused]');
});

test('ordinal and rejected picks are never stored; a no-context entry carries the list hash', () => {
  const list = cands('button "Save" context: form heading="Profile"', 'img alt="Avatar" #1', 'img alt="Avatar" #2', 'button "Go"');
  assert.equal(makeEntry(list[1], list, state), null);
  assert.equal(makeEntry(list[2], list, state), null);
  const withContext = makeEntry(list[0], list, state)!;
  assert.deepEqual(withContext, { desc: list[0].desc, frame: '', page: 'https://shop.test/cart' });
  const bare = makeEntry(list[3], list, state)!;
  assert.equal(bare.list, listHash(list));
  // Two inputs that differ only by value would both match: not stored.
  const twins = cands('input value="a" name="q"', 'input value="b" name="q"');
  assert.equal(makeEntry(twins[0], twins, state), null);
  const framed = cands('[iframe checkout] button "Pay" context: form heading="Card"');
  assert.equal(makeEntry(framed[0], framed, state)!.frame, 'checkout');
  // A `none` pick or a rejected one never reaches the store (resolveTargets returns no candidate);
  // a pick replaced by an unstorable one deletes the old entry.
  const store = new PickStore('on', MODEL, memoryIO());
  store.set(ref(), withContext);
  const run = store.attempt(0);
  run.accept(ref(), list[1], list, state);
  run.endStep('pass');
  run.finish(true);
  assert.equal(store.get(ref()), undefined);
});

test('lookup needs exactly one equal desc on the same page, and the same list without context', () => {
  const list = cands('a "Home"', 'button "Save" context: form heading="Profile"', 'button "Go"');
  const entry = makeEntry(list[1], list, state)!;
  assert.equal(match(entry, list, state)?.id, 1);
  // A row added above: ids move, the desc still names one element.
  const moved = cands('a "New"', ...list.map((c) => c.desc));
  assert.equal(match(entry, moved, { ...state, url: 'https://shop.test/cart?y=2' })?.id, 2);
  assert.equal(match(entry, list, { ...state, url: 'https://shop.test/checkout' }), undefined);
  assert.equal(match(entry, cands('button "Save as" context: form heading="Profile"'), state), undefined);
  assert.equal(match(entry, cands(list[1].desc, list[1].desc), state), undefined);
  assert.equal(match(entry, cands(`[iframe x] ${list[1].desc}`), state), undefined);
  const bare = makeEntry(list[2], list, state)!;
  assert.equal(match(bare, list, state)?.id, 2);
  assert.equal(match(bare, cands(...list.map((c) => c.desc), 'a "Help"'), state), undefined);
  // After a fill the value changed; the list hash ignores values too.
  const filled = cands('input name="q"', 'button "Go"');
  const field = makeEntry(filled[0], filled, state)!;
  assert.equal(match(field, cands('input value="books" name="q"', 'button "Go"'), state)?.id, 0);
});

test('the file is ignored on another version, model or desc format; output is deterministic; empty files are deleted', () => {
  const entries = new Map([['10|click|b|', { desc: 'b', frame: '', page: 'p' }], ['2|fill|a|', { desc: 'a', frame: '', page: 'p', list: 'h' }]]);
  const text = formatFile(MODEL, entries);
  assert.equal(text, formatFile(MODEL, new Map([...entries].reverse())));
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(Object.keys(JSON.parse(text).entries), ['2|fill|a|', '10|click|b|']);
  assert.doesNotMatch(text, /20\d\d-/);
  assert.equal(parseFile(text, MODEL)?.size, 2);
  assert.equal(parseFile(text, 'jev-0.0.1'), null);
  const file = JSON.parse(text);
  assert.equal(parseFile(JSON.stringify({ ...file, desc: DESC_FORMAT + 1 }), MODEL), null);
  assert.equal(parseFile(JSON.stringify({ ...file, version: PICK_FILE_VERSION + 1 }), MODEL), null);
  assert.equal(parseFile('{not json', MODEL), null);

  const io = memoryIO({ '/specs/a.picks.json': formatFile(MODEL, new Map([['0|click|the Save button|', { desc: 'x', frame: '', page: 'p' }]])) });
  const store = new PickStore('on', MODEL, io);
  const run = store.attempt(0);
  assert.ok(store.get(ref()));
  run.hit(ref());
  run.endStep('fail');
  run.finish(false);
  assert.deepEqual(store.write(), ['/specs/a.picks.json']);
  assert.equal(io.files['/specs/a.picks.json'], undefined);
});

test('attempt > 0 never reads; read mode never writes; off neither reads nor stores', () => {
  const list = cands('button "Save" context: form heading="Profile"');
  const entry = makeEntry(list[0], list, state)!;
  const seeded = () => memoryIO({ '/specs/a.picks.json': formatFile(MODEL, new Map([[entryKey(ref()), entry]])) });
  const on = new PickStore('on', MODEL, seeded());
  assert.equal(on.attempt(0).lookup(ref(), list, state)?.id, 0);
  assert.equal(on.attempt(1).lookup(ref(), list, state), undefined);
  const readIO = seeded();
  const read = new PickStore('read', MODEL, readIO);
  const r = read.attempt(0);
  assert.equal(r.lookup(ref(1), list, state), undefined);
  r.accept(ref(1), list[0], list, state); r.endStep('pass'); r.finish(true);
  assert.deepEqual(read.write(), []);
  assert.deepEqual(Object.keys(readIO.files), ['/specs/a.picks.json']);
  const off = new PickStore('off', MODEL, seeded());
  assert.equal(off.attempt(0).lookup(ref(), list, state), undefined);
});

// ---- suite level: the desktop engine with an injected adapter and injected intelligence ----

class Screen implements ComputerAdapter<number> {
  descs = ['button "Save"', 'button "Cancel"'];
  acted: string[] = [];
  async apps() { return [{ name: 'Fixture', pid: 7 }]; }
  async open() { return { name: 'Fixture', pid: 7 }; }
  async capture() {
    return { snapshot: { url: 'desktop://7', title: 'Fixture', aria: this.descs.join('\n'), truncated: false },
      candidates: cands(...this.descs), elements: new Map(this.descs.map((_, i) => [i, i])) };
  }
  async act(action: string, element: number) { this.acted.push(`${action} ${this.descs[element]}`); }
  async press() {} async mouse() {} async drag() {}
  async screenshot() { return Buffer.from('png'); }
  async close() {}
}

function brain(screen: Screen, verdicts: number[] = []) {
  const calls = { pick: 0, judge: 0 };
  const ai: Intelligence = {
    pick: async (candidates, targets) => {
      calls.pick++;
      return targets.map((target, i) => {
        const hit = candidates.find((c) => c.desc.includes(`"${target}"`));
        return { id: hit?.id ?? null, probability: hit ? 0.95 : 0.9, probabilities: {}, tokens: i === 0 ? 100 : 0 };
      });
    },
    judge: async (_s, claims) => { calls.judge++; return { probabilities: claims.map(() => verdicts.shift() ?? 0.95), tokens: 5 }; },
  };
  return { ai, calls, screen };
}

const desktop = (b: ReturnType<typeof brain>): SuiteEngine<ComputerSpec> => ({ engine: 'desktop', maxWorkers: 1, load: loadComputerSpec,
  meta: (spec) => ({ name: spec.name, tags: [] }),
  run: (spec, observer, info) => runComputerSpec(spec, new ComputerSession(b.screen, 50, b.ai), observer, info) });

function workspace(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainwright-pick-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const SPEC = 'name: save\napp: Fixture\nsteps:\n  - click: Save\n  - expect: saved\n';
const options = (files: string[], extra: Partial<SuiteOptions> = {}): SuiteOptions => ({ files, workers: 1, retries: 0, bail: 0,
  lastFailed: false, tags: [], list: false, reporters: [], timing: false, ...extra });
async function suite<S>(engine: SuiteEngine<S>, opts: SuiteOptions): Promise<RunReport> {
  const log = console.log, error = console.error;
  console.log = () => {}; console.error = () => {};
  const cwd = process.cwd();
  process.chdir(path.dirname(opts.files[0])); // last-run.json lands in the temp folder
  try { return await runSuite(engine, opts, { provider: () => 'typesafe', warmUp: () => {} }); }
  finally { process.chdir(cwd); console.log = log; console.error = error; }
}
const steps = (report: RunReport, spec = 0, attempt = -1) => report.specs[spec].attempts.at(attempt)!.steps;

test('cold run picks and writes the sidecar; warm run makes zero pick calls and marks the step cached', async (t) => {
  const dir = workspace(t);
  const file = path.join(dir, 'save.yaml');
  fs.writeFileSync(file, SPEC);
  const cold = brain(new Screen());
  const first = await suite(desktop(cold), options([file]));
  assert.equal(first.status, 'pass');
  assert.equal(cold.calls.pick, 1);
  const sidecar = JSON.parse(fs.readFileSync(path.join(dir, 'save.picks.json'), 'utf8'));
  assert.deepEqual(Object.keys(sidecar.entries), ['0|click|Save|']);
  assert.equal(sidecar.entries['0|click|Save|'].desc, 'button "Save"');
  assert.equal(sidecar.entries['0|click|Save|'].page, 'desktop://Fixture');
  assert.ok(sidecar.entries['0|click|Save|'].list, 'no context: the list hash guards the entry');
  const before = fs.readFileSync(path.join(dir, 'save.picks.json'), 'utf8');

  const warm = brain(new Screen());
  const second = await suite(desktop(warm), options([file]));
  assert.equal(second.status, 'pass');
  assert.equal(warm.calls.pick, 0);
  assert.deepEqual(warm.screen.acted, ['click button "Save"']);
  const [click] = steps(second);
  assert.equal(click.cached, true);
  assert.match(click.detail!, /\(cached pick\)$/);
  assert.equal(click.ms?.cached, 1);
  assert.equal(second.totals.cachedPicks, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'save.picks.json'), 'utf8'), before, 'a warm run leaves the file as it was');
});

test('a changed page misses and asks Jev: desc differs, or the list changed', async (t) => {
  const dir = workspace(t);
  const file = path.join(dir, 'save.yaml');
  fs.writeFileSync(file, SPEC);
  await suite(desktop(brain(new Screen())), options([file]));
  for (const descs of [['button "Save"', 'button "Cancel"', 'button "Help"'], ['button "Save"', 'button "Save"', 'button "Cancel"']]) {
    const screen = new Screen(); screen.descs = descs;
    const b = brain(screen);
    const report = await suite(desktop(b), options([file], { picks: 'read' }));
    assert.equal(b.calls.pick, 1, descs.join(', '));
    assert.equal(steps(report)[0].cached, undefined);
  }
  const renamed = new Screen(); renamed.descs = ['button "Save draft"', 'button "Save"'];
  const b = brain(renamed);
  await suite(desktop(b), options([file], { picks: 'read' }));
  assert.equal(b.calls.pick, 1);
});

test('a failed attempt evicts its hits, the retry asks Jev, and its passing pick is stored again', async (t) => {
  const dir = workspace(t);
  const file = path.join(dir, 'save.yaml');
  fs.writeFileSync(file, SPEC);
  await suite(desktop(brain(new Screen())), options([file]));
  const b = brain(new Screen(), [0.02]); // attempt 1's claim fails, attempt 2's passes
  const report = await suite(desktop(b), options([file], { retries: 1 }));
  assert.equal(report.specs[0].status, 'pass');
  assert.equal(report.specs[0].flaky, true);
  assert.equal(steps(report, 0, 0)[0].cached, true);
  assert.match(steps(report, 0, 0)[1].detail!, /— cache: .+pick-cache\.json$/);
  assert.equal(steps(report, 0, 1)[0].cached, undefined, 'attempt > 0 never reads the cache');
  assert.equal(b.calls.pick, 1);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'save.picks.json'), 'utf8')).entries['0|click|Save|']);

  const failing = brain(new Screen(), [0.02]);
  await suite(desktop(failing), options([file]));
  assert.equal(fs.existsSync(path.join(dir, 'save.picks.json')), false, 'the only entry was evicted: the file is deleted');
});

test('a failed attempt writes nothing; read never writes; off never reads', async (t) => {
  const dir = workspace(t);
  const file = path.join(dir, 'save.yaml');
  fs.writeFileSync(file, SPEC);
  await suite(desktop(brain(new Screen(), [0.02])), options([file]));
  assert.equal(fs.existsSync(path.join(dir, 'save.picks.json')), false);
  await suite(desktop(brain(new Screen())), options([file], { picks: 'read' }));
  assert.equal(fs.existsSync(path.join(dir, 'save.picks.json')), false);
  await suite(desktop(brain(new Screen())), options([file]));
  assert.ok(fs.existsSync(path.join(dir, 'save.picks.json')));
  const off = brain(new Screen());
  const report = await suite(desktop(off), options([file], { picks: 'off' }));
  assert.equal(off.calls.pick, 1);
  assert.equal(report.totals.cachedPicks, 0);
});

test('an included flow writes its own sidecar, shared by the specs that include it', async (t) => {
  const dir = workspace(t);
  fs.mkdirSync(path.join(dir, 'flows'));
  fs.writeFileSync(path.join(dir, 'flows', 'save.yaml'), 'steps:\n  - click: Save\n');
  const a = path.join(dir, 'a.yaml'), c = path.join(dir, 'c.yaml');
  fs.writeFileSync(a, 'name: a\napp: Fixture\nsteps:\n  - include: flows/save.yaml\n  - expect: saved\n');
  fs.writeFileSync(c, 'name: c\napp: Fixture\nsteps:\n  - expect: ready\n  - include: flows/save.yaml\n');
  const loaded = loadComputerSpec(c);
  assert.deepEqual(loaded.steps[1].at, { file: path.join(dir, 'flows', 'save.yaml'), index: 0 });
  assert.deepEqual(loaded.steps[0].at, { file: c, index: 0 });
  const b = brain(new Screen());
  const report = await suite(desktop(b), options([a, c]));
  assert.equal(report.status, 'pass');
  assert.equal(b.calls.pick, 1, 'the second spec replays the pick the first one stored');
  assert.equal(steps(report, 1)[1].cached, true);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.picks.json')), []);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'flows', 'save.picks.json'), 'utf8')).entries), ['0|click|Save|']);
});

test('browser loader keeps each step source; YAML cannot set it', (t) => {
  const dir = workspace(t);
  const file = path.join(dir, 'b.yaml');
  fs.writeFileSync(file, 'name: b\nurl: https://example.test\nsteps:\n  - goto: /\n  - click: Go\n');
  assert.deepEqual(loadSpec(file).steps.map((s) => s.at), [{ file, index: 0 }, { file, index: 1 }]);
  fs.writeFileSync(file, 'name: b\nurl: https://example.test\nsteps:\n  - click: Go\n    at: { file: x, index: 3 }\n');
  assert.throws(() => loadSpec(file), /exactly one key/);
});
