import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PickStore, entryKey, normalizeDesc, makeEntry, match, parseFile, formatFile, sidecarPath, pageOf, listHash,
  DESC_FORMAT, PICK_FILE_VERSION, type PickRef, type PickIO,
} from './pick-cache.js';
import { resolveTargets, type Candidate, type Intelligence } from './automation.js';
import { runSuite } from './suite.js';
import { loadSpec, parseStep, interpolate } from './spec.js';
import { loadComputerSpec, type ComputerSpec } from './computer-spec.js';
import { ComputerSession, runComputerSpec } from './computer.js';
import type { ComputerAdapter } from './computer-adapter.js';
import type { RunReport, SuiteEngine, SuiteOptions } from './suite-types.js';
import { MODEL_BY_PROVIDER } from './jev.js';

const MODEL = MODEL_BY_PROVIDER.typesafe;
const state = { url: 'https://shop.test/cart?x=1#top', title: 'Cart' };
const PAGE = 'https://shop.test/cart';
const ref = (index = 0, target = 'the Save button', goal?: string): PickRef => ({ at: { file: '/specs/a.yaml', index }, kind: 'click', target, goal });
const cands = (...descs: string[]): Candidate[] => descs.map((desc, id) => ({ id, desc }));
const memoryIO = (files: Record<string, string> = {}): PickIO & { files: Record<string, string> } => ({
  files,
  read: (file) => files[file],
  write: (file, text) => { files[file] = text; },
  remove: (file) => { delete files[file]; },
});

test('key encoding, sidecar path and page', () => {
  assert.equal(entryKey(ref(3, 'Log in', 'buy a book'), PAGE), JSON.stringify([3, 'click', 'Log in', 'buy a book', PAGE]));
  // JSON parts: a "|" in a target or goal cannot make two keys collide.
  assert.notEqual(entryKey(ref(0, 'a|b'), PAGE), entryKey(ref(0, 'a', 'b'), PAGE));
  // The page is part of the key: one flow used on two pages keeps two entries.
  assert.notEqual(entryKey(ref(), PAGE), entryKey(ref(), 'https://shop.test/checkout'));
  assert.equal(sidecarPath('/s/checkout.yaml'), '/s/checkout.picks.json');
  assert.equal(sidecarPath('/s/flows/login.yml'), '/s/flows/login.picks.json');
  assert.equal(pageOf(state), PAGE);
  assert.equal(pageOf({ url: 'desktop://4242', title: 'TextEdit' }), 'desktop://TextEdit');
  assert.equal(pageOf({ url: 'mobile://ios/com.apple.mobilecal', title: 'x' }), 'mobile://ios/com.apple.mobilecal');
});

test('a templated step keys a hash of its interpolated target, never the text', (t) => {
  const secret = { at: { file: '/specs/a.yaml', index: 2, templated: true }, kind: 'click', target: 'the row of alice@example.com' };
  const key = entryKey(secret, PAGE);
  assert.doesNotMatch(key, /alice/);
  assert.match(key, /"sha256:[0-9a-f]{64}"/);
  const dir = workspace(t);
  const file = path.join(dir, 'a.yaml');
  fs.writeFileSync(file, 'name: a\nurl: https://x.test\nenv: {user: alice}\nsteps:\n  - click: the row of ${env.user}\n  - click: Save\n');
  assert.deepEqual(loadSpec(file).steps.map((s) => s.at), [{ file, index: 0, templated: true }, { file, index: 1 }]);
});

test('value= is ignored only on text-entry fields: a submit or native value identifies the element', () => {
  const field: Candidate = { id: 0, desc: 'input[type=text] value="alice" name="user"', editable: true };
  assert.equal(normalizeDesc(field), 'input[type=text] name="user"');
  const submit = cands('input[type=submit] value="Subscribe"', 'a "Home"');
  const entry = makeEntry(submit[0], submit, state)!;
  assert.equal(match(entry, cands('input[type=submit] value="Unsubscribe"', 'a "Home"'), state), undefined);
  const native = cands('static_text "" value="Draft"', 'button "Send"');
  assert.equal(match(makeEntry(native[0], native, state)!, cands('static_text "" value="Sent"', 'button "Send"'), state), undefined);
  // A fill changes only the editable field's value: the entry and the list hash still match.
  const before: Candidate[] = [{ id: 0, desc: 'input name="q"', editable: true }, { id: 1, desc: 'button "Go"' }];
  const after: Candidate[] = [{ id: 0, desc: 'input value="books" name="q"', editable: true }, { id: 1, desc: 'button "Go"' }];
  assert.equal(match(makeEntry(before[1], before, state)!, after, state)?.id, 1);
  assert.equal(match(makeEntry(before[0], before, state)!, after, state)?.id, 0);
  assert.equal(DESC_FORMAT, 2);
});

test('ordinal and rejected picks are never stored; every entry carries the list hash', () => {
  const list = cands('button "Save" context: form heading="Profile"', 'img alt="Avatar" #1', 'img alt="Avatar" #2', 'button "Go"');
  assert.equal(makeEntry(list[1], list, state), null);
  assert.equal(makeEntry(list[2], list, state), null);
  assert.deepEqual(makeEntry(list[0], list, state), { desc: list[0].desc, frame: '', page: PAGE, list: listHash(list) });
  assert.equal(makeEntry(list[3], list, state)!.list, listHash(list));
  // Two text fields that differ only by value would both match: not stored.
  const twins: Candidate[] = [{ id: 0, desc: 'input value="a" name="q"', editable: true }, { id: 1, desc: 'input value="b" name="q"', editable: true }];
  assert.equal(makeEntry(twins[0], twins, state), null);
  const framed = cands('[iframe checkout] button "Pay" context: form heading="Card"');
  assert.equal(makeEntry(framed[0], framed, state)!.frame, 'checkout');
  // A pick replaced by an unstorable one deletes the old entry.
  const store = new PickStore('on', MODEL, memoryIO());
  store.set(ref(), PAGE, makeEntry(list[0], list, state));
  const run = store.attempt(0);
  run.accept(ref(), list[1], list, state);
  run.endStep('pass');
  run.finish(true);
  assert.equal(store.get(ref(), PAGE), undefined);
});

test('lookup needs the same page, the same whole list, and exactly one equal desc in the same frame', () => {
  const list = cands('a "Home"', 'a "View" context: tr text="Order 1234"', 'button "Go"');
  const entry = makeEntry(list[1], list, state)!;
  assert.equal(match(entry, list, { ...state, url: 'https://shop.test/cart?y=2' })?.id, 1);
  assert.equal(match(entry, list, { ...state, url: 'https://shop.test/checkout' }), undefined);
  // A newer, better-matching row ("the newest order's View link") changes the list: miss.
  assert.equal(match(entry, cands('a "Home"', 'a "View" context: tr text="Order 1235"', list[1].desc, 'button "Go"'), state), undefined);
  // A dialog over the page adds candidates first: miss.
  assert.equal(match(entry, cands('button "Accept all" context: dialog heading="Cookies"', ...list.map((c) => c.desc)), state), undefined);
  assert.equal(match(entry, cands(list[1].desc, list[1].desc), state), undefined);
  const framed = cands('a "Home"', `[iframe x] ${list[1].desc}`, 'button "Go"');
  assert.equal(match({ ...entry, list: listHash(framed) }, framed, state), undefined);
});

test('resolveTargets asks Jev only for the misses: one request, the cached target costs nothing', async () => {
  const list = cands('div "Box A" [draggable=true]', 'div "Box B" [draggable=true]');
  const asked: string[][] = [];
  const ai: Intelligence = {
    pick: async (_c, targets) => { asked.push(targets); return targets.map((_, i) => ({ id: 1, probability: 0.9, probabilities: {}, tokens: i === 0 ? 40 : 0 })); },
    judge: async () => ({ probabilities: [], tokens: 0 }),
  };
  const [source, dest] = await resolveTargets({ candidates: list, state, element: (c) => c.id,
    cached: (target) => (target === 'box A' ? list[0] : undefined) }, ['box A', 'box B'], ai);
  assert.deepEqual(asked, [['box B']]);
  assert.deepEqual([source.cached, source.usedJev, source.tokens, source.element], [true, false, 0, 0]);
  assert.deepEqual([dest.cached, dest.usedJev, dest.tokens, dest.element], [undefined, true, 40, 1]);
});

test('the file is ignored on another version, model or desc format; output is deterministic; empty files are deleted', () => {
  const k = (i: number, t: string) => JSON.stringify([i, 'click', t, '', 'p']);
  const entries = new Map([[k(10, 'b'), { desc: 'b', frame: '', page: 'p', list: 'h' }], [k(2, 'a'), { desc: 'a', frame: '', page: 'p', list: 'h' }]]);
  const text = formatFile(MODEL, entries);
  assert.equal(text, formatFile(MODEL, new Map([...entries].reverse())));
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(Object.keys(JSON.parse(text).entries), [k(2, 'a'), k(10, 'b')]);
  assert.doesNotMatch(text, /20\d\d-/);
  assert.equal(parseFile(text, MODEL)?.size, 2);
  assert.equal(parseFile(text, 'jev-0.0.1'), null);
  const file = JSON.parse(text);
  assert.equal(parseFile(JSON.stringify({ ...file, desc: DESC_FORMAT - 1 }), MODEL), null);
  assert.equal(parseFile(JSON.stringify({ ...file, version: PICK_FILE_VERSION + 1 }), MODEL), null);
  assert.equal(parseFile('{not json', MODEL), null);

  const list = cands('button "Save"');
  const io = memoryIO({ '/specs/a.picks.json': formatFile(MODEL, new Map([[entryKey(ref(), PAGE), makeEntry(list[0], list, state)!]])) });
  const store = new PickStore('on', MODEL, io);
  const run = store.attempt(0);
  assert.equal(run.lookup(ref(), list, state)?.id, 0);
  run.hit(ref(), state);
  run.endStep('fail');
  run.finish(false);
  assert.deepEqual(store.write(), ['/specs/a.picks.json']);
  assert.equal(io.files['/specs/a.picks.json'], undefined);
});

test('attempt > 0 never reads; read mode never writes; off neither reads nor stores', () => {
  const list = cands('button "Save" context: form heading="Profile"');
  const entry = makeEntry(list[0], list, state)!;
  const seeded = () => memoryIO({ '/specs/a.picks.json': formatFile(MODEL, new Map([[entryKey(ref(), PAGE), entry]])) });
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

test('`at` comes only from the loader: YAML and MCP steps cannot set it, interpolation leaves it alone', (t) => {
  assert.throws(() => parseStep('mcp', 0, { click: 'Go', at: { file: 'x', index: 3 } }), /exactly one key/);
  const dir = workspace(t);
  const odd = path.join(dir, '${env.x} folder');
  fs.mkdirSync(odd);
  const file = path.join(odd, 'b.yaml');
  fs.writeFileSync(file, 'name: b\nurl: https://example.test\nsteps:\n  - goto: /\n  - click: Go\n');
  const spec = loadSpec(file);
  assert.deepEqual(spec.steps.map((s) => s.at), [{ file, index: 0 }, { file, index: 1 }]);
  assert.deepEqual(interpolate(spec.steps, { env: {}, hooks: {} }, 'b').map((s) => s.at), [{ file, index: 0 }, { file, index: 1 }]);
  fs.writeFileSync(file, 'name: b\nurl: https://example.test\nsteps:\n  - click: Go\n    at: { file: x, index: 3 }\n');
  assert.throws(() => loadSpec(file), /at: reserved for the loader/);
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
const SAVE_KEY = JSON.stringify([0, 'click', 'Save', '', 'desktop://Fixture']);
const options = (files: string[], extra: Partial<SuiteOptions> = {}): SuiteOptions => ({ files, workers: 1, retries: 0, bail: 0,
  lastFailed: false, tags: [], list: false, reporters: [], timing: false, ...extra });
async function suite<S>(engine: SuiteEngine<S>, opts: SuiteOptions, provider: 'typesafe' | 'gateway' = 'typesafe'): Promise<RunReport> {
  const log = console.log, error = console.error;
  console.log = () => {}; console.error = () => {};
  const cwd = process.cwd();
  process.chdir(path.dirname(opts.files[0])); // last-run.json lands in the temp folder
  try { return await runSuite(engine, opts, { provider: () => provider, warmUp: () => {} }); }
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
  assert.deepEqual(Object.keys(sidecar.entries), [SAVE_KEY]);
  assert.equal(sidecar.entries[SAVE_KEY].desc, 'button "Save"');
  assert.equal(sidecar.entries[SAVE_KEY].page, 'desktop://Fixture');
  assert.ok(sidecar.entries[SAVE_KEY].list);
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

test('the cache model is the versioned TypeSafe id on either provider', async (t) => {
  const dir = workspace(t);
  const file = path.join(dir, 'save.yaml');
  fs.writeFileSync(file, SPEC);
  await suite(desktop(brain(new Screen())), options([file]), 'gateway');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'save.picks.json'), 'utf8')).model, MODEL_BY_PROVIDER.typesafe);
  const warm = brain(new Screen());
  await suite(desktop(warm), options([file]), 'typesafe');
  assert.equal(warm.calls.pick, 0, 'switching provider keeps the sidecar');
});

test('a changed page misses and asks Jev: desc differs, or the list changed', async (t) => {
  const dir = workspace(t);
  const file = path.join(dir, 'save.yaml');
  fs.writeFileSync(file, SPEC);
  await suite(desktop(brain(new Screen())), options([file]));
  for (const descs of [['button "Save"', 'button "Cancel"', 'button "Help"'], ['button "Save"', 'button "Save"', 'button "Cancel"'],
    ['button "Save draft"', 'button "Save"']]) {
    const screen = new Screen(); screen.descs = descs;
    const b = brain(screen);
    const report = await suite(desktop(b), options([file], { picks: 'read' }));
    assert.equal(b.calls.pick, 1, descs.join(', '));
    assert.equal(steps(report)[0].cached, undefined);
  }
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
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'save.picks.json'), 'utf8')).entries[SAVE_KEY]);

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
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'flows', 'save.picks.json'), 'utf8')).entries), [SAVE_KEY]);
});
