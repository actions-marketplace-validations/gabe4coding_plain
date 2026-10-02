# Session Pane Mod Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code mod, shipped inside the browser, desktop and mobile plugins, that draws a live pane of each plainwright session — target, goal, steps with status and Jev tokens — with **Save as spec** and **Copy last failure** controls.

**Architecture:** One source at `mods/session-pane/` (a small dev plugin). Three files under `hooks/session-pane/`: `model.ts` (pure: tool result → pane state), `view.ts` (pure: state → element tree), `register.ts` (the only file using the mods API). `scripts/build-plugins.mjs` copies `hooks/` into each plugin and writes a per-plugin `config.ts`. The mod only observes: every tool result goes back to Claude unchanged.

**Tech Stack:** Claude Code mods (v2.1.287+), TypeScript hooks module loaded by Claude Code (no `tsc` step), `claude plugin test` with the `claude-code/testing` kit, Node build script.

**Spec:** `docs/superpowers/specs/2026-10-02-session-pane-mod-design.md`

**Mod docs (read when a step surprises you):** https://code.claude.com/docs/en/plugins/mods/reference.md, `.../interface.md`, `.../events.md`, `.../test.md`. The declarations for the installed version are written to `mods/session-pane/.claude-plugin/types/` each time Claude Code loads the mod with `--plugin-dir`; trust those over the docs.

**Decisions taken while planning (differ slightly from the spec):**
- The per-plugin `config.ts` names the plugin and engine (`browser` | `native`) instead of reading `$.plugin.name`: it is explicit, and tests run with the browser values.
- `/<plugin>-pane` *shows* the pane (it does not toggle). Esc or the pane's close mark hides it. The pane opens by itself only on the first successful `open` of a session.
- Only `$.mcp.call`'s server name is learned at runtime, from the first matched tool name (`mcp__plugin_plainwright_plainwright__step` → `plugin_plainwright_plainwright`, a spelling `$.mcp.call` accepts).

---

## File structure

| File | Responsibility |
| :- | :- |
| `mods/session-pane/.claude-plugin/plugin.json` | Dev plugin manifest, so `claude plugin test` / `--plugin-dir` can load the source |
| `mods/session-pane/hooks/hooks.json` | Points at `./session-pane/register.ts` (copied to each plugin as is) |
| `mods/session-pane/hooks/session-pane/config.ts` | `PLUGIN`, `ENGINE` — browser values here; generated per plugin |
| `mods/session-pane/hooks/session-pane/model.ts` | State, `payload`, `jsonOf`, `stepLabel`, `apply`, `counts`, `saveName` |
| `mods/session-pane/hooks/session-pane/view.ts` | `fit`, `spread`, `render` |
| `mods/session-pane/hooks/session-pane/register.ts` | Hooks: `session.start`, `session.end`, `command.run`, `tool.call`, `ui.render`; save and copy |
| `mods/session-pane/hooks/session-pane/*.test.ts` | Tests (`model`, `view`, `register`); never copied into plugins |
| `scripts/build-plugins.mjs` | Copies the mod into each plugin, writes its `config.ts` |
| `plugins/*/hooks/` | Generated; never edit |
| `.gitignore` | Ignores the `.claude-plugin/types/` Claude Code writes |
| `package.json` | `test:mods` script |
| `docs/agent-mode.md`, three `SKILL.md`, `CLAUDE.md` | Docs |
| Plugin manifests, `src/computer/mcp.ts`, `src/mobile/mcp.ts` | Version bump |

Root `tsconfig.json` has `"include": ["src"]`, so nothing under `mods/` or `plugins/*/hooks/` is compiled by `tsc` or packed into `runtime.tgz` (which is built from `dist/`).

---

### Task 1: Dev plugin skeleton and API probe

Confirms the three open checks from the spec before any real code: the tool-name prefix, the shape `next(e)` resolves to for a plainwright MCP tool, and that a hooks module can import a sibling `.ts` file.

**Files:**
- Create: `mods/session-pane/.claude-plugin/plugin.json`
- Create: `mods/session-pane/hooks/hooks.json`
- Create: `mods/session-pane/hooks/session-pane/config.ts`
- Create (temporary, not committed): `mods/session-pane/hooks/session-pane/register.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Write the manifest**

`mods/session-pane/.claude-plugin/plugin.json`:

```json
{
  "name": "plainwright-session-pane",
  "version": "0.0.0",
  "description": "Development copy of the plainwright session pane mod; scripts/build-plugins.mjs copies its hooks/ into each plugin",
  "author": { "name": "Gabriele Pavanello" }
}
```

- [ ] **Step 2: Write hooks.json**

`mods/session-pane/hooks/hooks.json`:

```json
{
  "modules": ["./session-pane/register.ts"]
}
```

- [ ] **Step 3: Write config.ts**

`mods/session-pane/hooks/session-pane/config.ts`:

```ts
/**
 * Which plainwright plugin this copy of the mod ships in. scripts/build-plugins.mjs rewrites this file in each
 * plugin; this source copy holds the browser plugin's values, which the tests use.
 */
export const PLUGIN: string = 'plainwright';
/** `native` (desktop, mobile): `open` starts a new flow, so the pane starts over, as the server's transcript does. */
export const ENGINE: 'browser' | 'native' = 'browser';
```

- [ ] **Step 4: Write the temporary probe**

`mods/session-pane/hooks/session-pane/register.ts` (replaced in Task 4):

```ts
import { PLUGIN } from './config.ts';

export function register(on: any): void {
  on('tool.call', { tool: /^mcp__plugin_plainwright/ }, async ($: any, e: any, next: any) => {
    const outcome = await next(e);
    await $.fs.write('.session-pane-probe.json', JSON.stringify({ plugin: PLUGIN, tool: e.tool, keys: Object.keys(e), outcome }, null, 2));
    return outcome;
  });
}
```

- [ ] **Step 5: Validate the dev plugin**

Run: `claude plugin validate mods/session-pane`
Expected: no errors; a `hooks:` line naming `tool.call` and a `calls:` line naming `fs.write`.

- [ ] **Step 6: Run the probe against the installed plainwright plugin**

The installed `plainwright@…` plugin provides the MCP server; the dev plugin only watches it. Needs a Jev key (`~/.config/plainwright/.env` or env).

```bash
claude -p --plugin-dir mods/session-pane --allowedTools "mcp__plugin_plainwright_plainwright__open,mcp__plugin_plainwright_plainwright__step" "Call the plainwright open tool with url 'data:text/html,<h1>Hello</h1>', then the plainwright step tool with step {\"expect\": \"the heading says Hello\"}. Do nothing else."
```

Then: `cat .session-pane-probe.json`

Expected and what to record:
- `tool` is `mcp__plugin_plainwright_plainwright__step`. If the prefix differs, change the `TOOL` regex in Task 4 Step 3 and the `TOOL` constant in Task 4 Step 1 to match.
- `outcome` holds the step's JSON (`status`, `url`, `jevTokens`) somewhere under `result` or `text`. `payload()` in Task 2 accepts `result.structuredContent`, `result.content[].text`, a JSON string `result`, or `text`. If the probe shows another shape, add a test case for it in Task 2 Step 1 and handle it in `jsonOf`.
- The probe file exists at all: proof that `import './config.ts'` works. If the session logs an import error instead, rename the imports in Tasks 2–4 from `./x.ts` to `./x.js` style as the error asks, and rerun.

- [ ] **Step 7: Read the generated declarations for two calls**

Run:

```bash
grep -n "copy: (\|'mcp.call'\|toast: (" mods/session-pane/.claude-plugin/types/*.d.ts
```

Expected: `$.ui.copy` takes the text as its first argument (`copy: (text: string, …)`), `mcp.call` has `server`, `tool`, `args`. If `copy` takes an object, change the call in Task 4 Step 3 (`copy()`) to match.

- [ ] **Step 8: Remove the probe output, ignore generated types**

```bash
rm .session-pane-probe.json
```

Append to `.gitignore`:

```
# Mod type declarations Claude Code writes when it loads a mod with --plugin-dir.
mods/*/.claude-plugin/types/
plugins/*/.claude-plugin/types/
```

- [ ] **Step 9: Commit the skeleton (not the probe)**

```bash
git add .gitignore mods/session-pane/.claude-plugin/plugin.json mods/session-pane/hooks/hooks.json mods/session-pane/hooks/session-pane/config.ts
git commit -m "Add the session pane mod's dev plugin skeleton"
```

---

### Task 2: `model.ts` — tool results to pane state

**Files:**
- Create: `mods/session-pane/hooks/session-pane/model.ts`
- Test: `mods/session-pane/hooks/session-pane/model.test.ts`

- [ ] **Step 1: Write the failing tests**

`mods/session-pane/hooks/session-pane/model.test.ts`:

```ts
import { expect, test } from 'claude-code/testing';
import { MAX_ROWS, apply, counts, emptyState, payload, saveName, stepLabel } from './model.ts';

const DATA = { status: 'pass', url: 'https://example.test/', jevTokens: 12 };

test('payload reads structured content, a text block, a JSON string or the outcome text', async () => {
  expect(payload({ result: { structuredContent: DATA, content: [] } })).toEqual(DATA);
  expect(payload({ result: { content: [{ type: 'text', text: JSON.stringify(DATA) }] } })).toEqual(DATA);
  expect(payload({ result: [{ type: 'text', text: JSON.stringify(DATA) }] })).toEqual(DATA);
  expect(payload({ result: JSON.stringify(DATA) })).toEqual(DATA);
  expect(payload({ result: undefined, text: JSON.stringify(DATA) })).toEqual(DATA);
});

test('payload is null for a refused, failed or non-JSON result', async () => {
  expect(payload({ deny: 'no' })).toBe(null);
  expect(payload({ result: { content: [{ type: 'text', text: 'boom' }] }, isError: true })).toBe(null);
  expect(payload({ result: { content: [{ type: 'text', text: 'boom' }], isError: true } })).toBe(null);
  expect(payload({ result: 'not json' })).toBe(null);
  expect(payload(undefined)).toBe(null);
});

test('stepLabel names the kind and the words of its target or claim', async () => {
  expect(stepLabel({ click: 'Save' })).toBe('click "Save"');
  expect(stepLabel({ fill: { target: 'the Name field', value: 'Alex' } })).toBe('fill "the Name field"');
  expect(stepLabel({ expect: ['a heading', 'a list'] })).toBe('expect "a heading; a list"');
  expect(stepLabel({ wait: { that: 'results show', within: 'the list' } })).toBe('wait "results show"');
  expect(stepLabel({ optional: true, click: 'Accept cookies' })).toBe('click "Accept cookies"');
  expect(stepLabel({ press: 'Enter' })).toBe('press "Enter"');
  expect(stepLabel(undefined)).toBe('step');
});

test('browser open sets target and goal and adds a goto row; a later open keeps the goal', async () => {
  let state = apply(emptyState(), 'browser', 'open', { url: 'https://example.test', goal: 'Read the discussion' },
    { url: 'https://example.test/', title: 'Example', notes: [] });
  expect(state.target).toBe('https://example.test/');
  expect(state.goal).toBe('Read the discussion');
  expect(state.rows).toEqual([{ label: 'goto "https://example.test"', status: 'pass', tokens: 0 }]);
  state = apply(state, 'browser', 'open', { url: 'https://example.test/b' }, { url: 'https://example.test/b' });
  expect(state.goal).toBe('Read the discussion');
  expect(state.rows.length).toBe(2);
});

test('native open starts over, with the app as target', async () => {
  const before = apply(emptyState(), 'native', 'step', { step: { click: 'Add' } }, DATA);
  const state = apply(before, 'native', 'open', { app: 'Calculator' }, { placeholders: [] });
  expect(state).toEqual({ rows: [], tokens: 0, target: 'Calculator', goal: undefined });
});

test('a non-pass step keeps its detail, adds its tokens and becomes the last failure', async () => {
  const state = apply(emptyState(), 'browser', 'step', { step: { expect: 'comments are shown' } },
    { status: 'inconclusive', detail: 'p=0.62', notes: ['1 console error'], url: 'https://example.test/a', jevTokens: 340, changed: { added: 'x' } });
  expect(state.rows).toEqual([{ label: 'expect "comments are shown"', status: 'inconclusive', tokens: 340, detail: 'p=0.62' }]);
  expect(state.tokens).toBe(340);
  expect(state.target).toBe('https://example.test/a');
  expect(state.lastFailure).toEqual({ step: { expect: 'comments are shown' }, status: 'inconclusive', detail: 'p=0.62',
    notes: ['1 console error'], url: 'https://example.test/a', changed: { added: 'x' } });
});

test('a batch adds one row per attempted step and gives the batch change to its failure', async () => {
  const steps = [{ click: 'Next' }, { expect: 'page 2 shows' }, { click: 'Next' }];
  const state = apply(emptyState(), 'browser', 'batch', { steps }, {
    status: 'fail', stoppedAt: 1, url: 'https://example.test/2', jevTokens: 30, changed: { removed: 4 },
    results: [
      { index: 0, status: 'pass', notes: [], url: 'https://example.test/2', jevTokens: 10 },
      { index: 1, status: 'fail', detail: 'p=0.03', notes: [], url: 'https://example.test/2', jevTokens: 20 },
    ],
  });
  expect(state.rows.map((row) => row.label)).toEqual(['click "Next"', 'expect "page 2 shows"']);
  expect(state.tokens).toBe(30);
  expect(state.lastFailure?.changed).toEqual({ removed: 4 });
  expect(counts(state)).toEqual({ steps: 2, passed: 1 });
});

test('reads add a dim row and their tokens; save adds nothing', async () => {
  let state = apply(emptyState(), 'browser', 'ask', { claims: ['a', 'b'] }, { jevTokens: 50 });
  state = apply(state, 'browser', 'read', { question: 'the price' }, { jevTokens: 7 });
  state = apply(state, 'browser', 'save', { path: 'x.yaml' }, { path: '/w/x.yaml', steps: 2 });
  expect(state.rows).toEqual([
    { label: 'ask "a; b"', tokens: 50, dim: true },
    { label: 'read "the price"', tokens: 7, dim: true },
  ]);
  expect(state.tokens).toBe(57);
  expect(counts(state)).toEqual({ steps: 0, passed: 0 });
});

test('rows are capped at MAX_ROWS, oldest dropped', async () => {
  let state = emptyState();
  for (let i = 0; i < MAX_ROWS + 5; i += 1) state = apply(state, 'browser', 'step', { step: { click: `b${i}` } }, DATA);
  expect(state.rows.length).toBe(MAX_ROWS);
  expect(state.rows[0].label).toBe('click "b5"');
});

test('saveName makes a file name from the goal', async () => {
  expect(saveName('Read the F-Droid 2.0 discussion!')).toBe('read-the-f-droid-2-0-discussion.yaml');
  expect(saveName(undefined)).toBe('plainwright-session.yaml');
  expect(saveName('???')).toBe('plainwright-session.yaml');
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `claude plugin test mods/session-pane`
Expected: FAIL — the module `./model.ts` cannot be found.

- [ ] **Step 3: Write model.ts**

`mods/session-pane/hooks/session-pane/model.ts`:

```ts
export type Status = 'pass' | 'fail' | 'inconclusive' | 'error' | 'skipped';
export type Engine = 'browser' | 'native';
export type Row = { label: string; status?: Status; tokens: number; detail?: string; dim?: true };
export type Failure = { step: unknown; status: Status; detail?: string; notes?: unknown; url?: string; changed?: unknown };
export type State = { target?: string; goal?: string; rows: Row[]; tokens: number; lastFailure?: Failure };
type Data = Record<string, unknown>;

/** Older rows are dropped, so a long session does not grow the pane without bound. */
export const MAX_ROWS = 200;
const STATUSES: readonly Status[] = ['pass', 'fail', 'inconclusive', 'error', 'skipped'];

export const emptyState = (): State => ({ rows: [], tokens: 0 });

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const asStatus = (value: unknown): Status => (STATUSES.includes(value as Status) ? (value as Status) : 'error');
const capped = (rows: Row[]): Row[] => rows.slice(-MAX_ROWS);

/** The JSON object in an MCP result: its structured content, its first text block, or a JSON string. */
export function jsonOf(value: unknown): Data | null {
  if (typeof value === 'string') {
    try {
      return jsonOf(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) return jsonOf(value.find((block) => block?.type === 'text')?.text);
  if (!value || typeof value !== 'object') return null;
  const record = value as Data;
  if (record.structuredContent !== undefined) return jsonOf(record.structuredContent);
  if (record.content !== undefined) return jsonOf(record.content);
  return record;
}

/** What a plainwright tool returned, as `next(e)` hands it to a `tool.call` hook; null when refused or failed. */
export function payload(outcome: unknown): Data | null {
  if (!outcome || typeof outcome !== 'object') return null;
  const { deny, isError, result, text } = outcome as Data;
  if (deny !== undefined || isError) return null;
  if (result && typeof result === 'object' && (result as Data).isError) return null;
  return jsonOf(result) ?? jsonOf(text);
}

/** The words of a step's value: the string itself, or its target/claim field. */
function words(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(words).filter(Boolean).join('; ');
  if (value && typeof value === 'object') {
    const fields = value as Data;
    for (const key of ['target', 'that', 'url', 'to', 'key']) {
      const field = str(fields[key]);
      if (field) return field;
    }
    return words(Object.values(fields).find((field) => typeof field === 'string'));
  }
  return '';
}

/** `click "Save"` from `{ click: "Save" }`: the step kind, then the words naming its target or claim. */
export function stepLabel(step: unknown): string {
  if (!step || typeof step !== 'object') return 'step';
  const entry = Object.entries(step).find(([key]) => key !== 'optional');
  if (!entry) return 'step';
  const [kind, value] = entry;
  const text = words(value);
  return text ? `${kind} "${text}"` : kind;
}

type Outcome = Data & { step: unknown };

/** Adds one row per step outcome; a non-pass outcome becomes the last failure. */
function withSteps(state: State, outcomes: Outcome[], batchChange?: unknown): State {
  let next = state;
  for (const outcome of outcomes) {
    const status = asStatus(outcome.status);
    const tokens = num(outcome.jevTokens);
    const detail = status === 'pass' ? undefined : str(outcome.detail);
    const row: Row = { label: stepLabel(outcome.step), status, tokens, ...(detail ? { detail } : {}) };
    next = {
      ...next,
      target: str(outcome.url) ?? next.target,
      tokens: next.tokens + tokens,
      rows: capped([...next.rows, row]),
      lastFailure: status === 'pass' ? next.lastFailure : {
        step: outcome.step,
        status,
        detail: str(outcome.detail),
        notes: outcome.notes,
        url: str(outcome.url),
        changed: outcome.changed ?? batchChange,
      },
    };
  }
  return next;
}

/** Tools that read without acting: a dim row naming what they read. */
const READS: Record<string, (args: Data) => string | undefined> = {
  ask: (args) => (Array.isArray(args.claims) ? args.claims.join('; ') : undefined),
  read: (args) => str(args.question),
  find: (args) => str(args.target),
  snapshot: (args) => str(args.within),
};

/** The pane state after one plainwright call: the tool's short name, its arguments and its result JSON. */
export function apply(state: State, engine: Engine, tool: string, args: Data, data: Data): State {
  if (tool === 'open') {
    const target = str(data.url) ?? str(args.url) ?? str(args.app) ?? str(args.device) ?? state.target;
    if (engine === 'native') return { ...emptyState(), target, goal: str(args.goal) };
    const goto: Row = { label: `goto "${str(args.url) ?? target ?? ''}"`, status: 'pass', tokens: 0 };
    return { ...state, target, goal: str(args.goal) ?? state.goal, rows: capped([...state.rows, goto]) };
  }
  if (tool === 'step') return withSteps(state, [{ ...data, step: args.step }]);
  if (tool === 'batch') {
    const steps = Array.isArray(args.steps) ? args.steps : [];
    const results = Array.isArray(data.results) ? (data.results as Data[]) : [];
    return withSteps(state, results.map((result) => ({ ...result, step: steps[num(result.index)] })), data.changed);
  }
  const read = READS[tool];
  if (!read) return state;
  const tokens = num(data.jevTokens);
  const what = read(args);
  const row: Row = { label: what ? `${tool} "${what}"` : tool, tokens, dim: true };
  return { ...state, tokens: state.tokens + tokens, rows: capped([...state.rows, row]) };
}

/** Rows that are steps (reads are not), and how many of them passed. */
export function counts(state: State): { steps: number; passed: number } {
  const steps = state.rows.filter((row) => row.status !== undefined);
  return { steps: steps.length, passed: steps.filter((row) => row.status === 'pass').length };
}

/** A spec file name from the flow's goal: `read-the-discussion.yaml`. */
export function saveName(goal: string | undefined): string {
  const slug = (goal ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return `${slug || 'plainwright-session'}.yaml`;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `claude plugin test mods/session-pane`
Expected: all `model.test.ts` tests pass. (The probe `register.ts` still loads; it has no effect on these pure tests.)

- [ ] **Step 5: Commit**

```bash
git add mods/session-pane/hooks/session-pane/model.ts mods/session-pane/hooks/session-pane/model.test.ts
git commit -m "Turn plainwright tool results into session pane state"
```

---

### Task 3: `view.ts` — state to element tree

**Files:**
- Create: `mods/session-pane/hooks/session-pane/view.ts`
- Test: `mods/session-pane/hooks/session-pane/view.test.ts`

- [ ] **Step 1: Write the failing tests**

The tests use fake element factories that return plain `{ type, props }` objects, so no app is needed.

`mods/session-pane/hooks/session-pane/view.test.ts`:

```ts
import { expect, test } from 'claude-code/testing';
import { apply, emptyState } from './model.ts';
import { fit, render, spread, type Elements } from './view.ts';

type Node = { type: string; props: Record<string, any> };
const el = Object.fromEntries(['Box', 'Text', 'Button', 'Input'].map((type) => [type, (props: Record<string, unknown>) => ({ type, props })])) as Elements;

/** Every node of the tree, depth first. */
function nodes(node: Node): Node[] {
  const kids = (node.props.children ?? []).filter((kid: unknown) => typeof kid === 'object');
  return [node, ...kids.flatMap(nodes)];
}
const lines = (tree: unknown) => nodes(tree as Node).filter((node) => node.type === 'Text').map((node) => node.props.children.join(''));
const keyed = (tree: unknown, key: string) => nodes(tree as Node).find((node) => node.props.key === key);

const controls = (over = {}) => ({ columns: 40, savePath: 'flow.yaml', onSavePath: () => {}, onSave: () => {}, onCopy: () => {}, ...over });

test('fit cuts with an ellipsis; spread right-aligns the second part', async () => {
  expect(fit('abcdef', 4)).toBe('abc…');
  expect(fit('abc', 4)).toBe('abc');
  expect(spread('left', '9 tk', 12)).toBe('left    9 tk');
  expect(spread('a very long label', '9 tk', 12)).toBe('a very… 9 tk');
});

test('an empty session says it is waiting, and offers no copy button', async () => {
  const tree = render(emptyState(), el, controls());
  expect(lines(tree)).toContain('No page open yet');
  expect(lines(tree)).toContain('Waiting for the first step…');
  expect(keyed(tree, 'save')).toBeDefined();
  expect(keyed(tree, 'copy')).toBeUndefined();
});

test('steps show icon, label and tokens; a failure shows its detail and the copy button', async () => {
  let state = apply(emptyState(), 'browser', 'open', { url: 'https://example.test', goal: 'Read it' }, { url: 'https://example.test/' });
  state = apply(state, 'browser', 'step', { step: { expect: 'comments show' } }, { status: 'inconclusive', detail: 'p=0.62', jevTokens: 340 });
  const tree = render(state, el, controls());
  const text = lines(tree);
  expect(text).toContain('https://example.test/');
  expect(text).toContain('goal: Read it');
  expect(text).toContain('✓ goto "https://example.test"');
  expect(text).toContain(spread('? expect "comments show"', '340 tk', 40));
  expect(text).toContain('  inconclusive: p=0.62');
  expect(text).toContain('2 steps · 1 pass · 340 Jev tokens');
  expect(keyed(tree, 'copy')).toBeDefined();
});

test('the save controls pass the path on', async () => {
  const saved: (string | undefined)[] = [];
  const typed: string[] = [];
  const tree = render(emptyState(), el, controls({ onSave: (path?: string) => saved.push(path), onSavePath: (path: string) => typed.push(path) }));
  const input = keyed(tree, 'save-path')!;
  expect(input.props.value).toBe('flow.yaml');
  input.props.onInput('specs/a.yaml');
  input.props.onSubmit('specs/a.yaml');
  keyed(tree, 'save')!.props.onPress();
  expect(typed).toEqual(['specs/a.yaml']);
  expect(saved).toEqual(['specs/a.yaml', undefined]);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `claude plugin test mods/session-pane`
Expected: FAIL — `./view.ts` cannot be found.

- [ ] **Step 3: Write view.ts**

`mods/session-pane/hooks/session-pane/view.ts`:

```ts
import { counts, type State, type Status } from './model.ts';

/** The element factories `$.ui.resolve(e)` returns; only the four both the terminal and Desktop draw. */
export type Elements = Record<'Box' | 'Text' | 'Button' | 'Input', (props: Record<string, unknown>) => unknown>;
export type Controls = {
  columns: number;
  savePath: string;
  onSavePath: (path: string) => void;
  /** With a path from the field's Enter; without one from the button, which uses the latest typed path. */
  onSave: (path?: string) => unknown;
  onCopy: () => unknown;
};

const ICON: Record<Status, string> = { pass: '✓', fail: '✗', inconclusive: '?', error: '!', skipped: '–' };
const COLOR: Partial<Record<Status, string>> = { pass: 'green', fail: 'red', inconclusive: 'yellow', error: 'red' };

/** `text` cut to `width` characters, with an ellipsis when cut. */
export function fit(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…';
}

/** `left`, then spaces, then `right` ending at `width`; `left` is cut first. */
export function spread(left: string, right: string, width: number): string {
  if (!right) return fit(left, width);
  const start = fit(left, Math.max(1, width - right.length - 1));
  return start + ' '.repeat(Math.max(1, width - start.length - right.length)) + right;
}

/** The pane: target and goal, one line per row (detail under a non-pass step), totals, then the controls. */
export function render(state: State, el: Elements, controls: Controls): unknown {
  const { Box, Text, Button, Input } = el;
  const width = Math.max(20, controls.columns);
  const line = (text: string, style: Record<string, unknown> = {}) => Text({ ...style, children: [text] });

  const children: unknown[] = [line(fit(state.target ?? 'No page open yet', width), { bold: true })];
  if (state.goal) children.push(line(fit(`goal: ${state.goal}`, width), { dimColor: true }));
  children.push(line(' '));
  if (state.rows.length === 0) children.push(line('Waiting for the first step…', { dimColor: true }));
  for (const row of state.rows) {
    const icon = row.status ? ICON[row.status] : '·';
    const color = row.status && COLOR[row.status];
    const style = row.dim ? { dimColor: true } : color ? { color } : {};
    children.push(line(spread(`${icon} ${row.label}`, row.tokens ? `${row.tokens} tk` : '', width), style));
    if (row.detail) children.push(line(fit(`  ${row.status}: ${row.detail}`, width), { dimColor: true }));
  }

  const { steps, passed } = counts(state);
  children.push(line(' '));
  children.push(line(fit(`${steps} steps · ${passed} pass · ${state.tokens} Jev tokens`, width), { dimColor: true }));
  children.push(Input({
    key: 'save-path',
    label: 'Spec',
    value: controls.savePath,
    submitLabel: 'save',
    onInput: controls.onSavePath,
    onSubmit: (path: string) => controls.onSave(path),
  }));
  const buttons = [Button({ key: 'save', label: 'Save as spec', onPress: () => controls.onSave() })];
  if (state.lastFailure) buttons.push(Button({ key: 'copy', label: 'Copy last failure', onPress: () => controls.onCopy() }));
  children.push(Box({ flexDirection: 'row', columnGap: 2, children: buttons }));
  return Box({ flexDirection: 'column', children });
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `claude plugin test mods/session-pane`
Expected: all `model.test.ts` and `view.test.ts` tests pass.

- [ ] **Step 5: Commit**

```bash
git add mods/session-pane/hooks/session-pane/view.ts mods/session-pane/hooks/session-pane/view.test.ts
git commit -m "Draw the session pane from its state"
```

---

### Task 4: `register.ts` — the hooks

**Files:**
- Replace: `mods/session-pane/hooks/session-pane/register.ts` (the probe from Task 1)
- Test: `mods/session-pane/hooks/session-pane/register.test.ts`

- [ ] **Step 1: Write the failing tests**

`mods/session-pane/hooks/session-pane/register.test.ts`:

```ts
import { expect, test } from 'claude-code/testing';

const TOOL = 'mcp__plugin_plainwright_plainwright__';
const PANE = {
  plugin: 'plainwright-session-pane',
  component: 'Pane',
  requestId: 'plainwright',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'plainwright', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const;

/** A plainwright result as its MCP server sends it: one JSON text block, and the same object as structured content. */
const mcp = (data: object) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false });

const ANSWERS: Record<string, object> = {
  open: { url: 'https://example.test/', title: 'Example', notes: [] },
  step: { status: 'inconclusive', detail: 'p=0.62', notes: [], url: 'https://example.test/item', jevTokens: 340 },
};

/** Answers tool calls in Claude Code's place: plainwright tools from ANSWERS, any other tool with 'ok'. */
function stubTools(on: any, seen: unknown[] = []): void {
  on('tool.call', ($: any, e: any) => {
    const name = String(e.tool).startsWith(TOOL) ? String(e.tool).slice(TOOL.length) : '';
    const result = ANSWERS[name] ? mcp(ANSWERS[name]) : 'ok';
    seen.push(result);
    return { result };
  });
}
const placed = () => ({ value: { isPlaced: true } });
const done = () => ({ value: undefined });

test('records each step and returns the tool result unchanged', async ($, on) => {
  const seen: unknown[] = [];
  stubTools(on, seen);
  on('ui.open', placed);
  await $.tool.call({ tool: TOOL + 'open', url: 'https://example.test/', goal: 'Read the discussion' });
  const out = await $.tool.call({ tool: TOOL + 'step', step: { expect: 'comments are shown' } });
  expect(out).toEqual({ result: seen[1] });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: 'goal: Read the discussion' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^\? expect "comments are shown" +340 tk$/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: '  inconclusive: p=0.62' })).toBeDefined();
  await ui.unmount();
});

test('draws the same pane on Desktop', async ($, on) => {
  stubTools(on);
  on('ui.open', placed);
  await $.tool.call({ tool: TOOL + 'open', url: 'https://example.test/' });
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' });
  expect(await ui.find({ type: 'Text', text: '✓ goto "https://example.test/"' })).toBeDefined();
  await ui.unmount();
});

test('opens the pane on the first open only', async ($, on) => {
  let opens = 0;
  stubTools(on);
  on('ui.open', () => {
    opens += 1;
    return placed();
  });
  await $.tool.call({ tool: TOOL + 'open', url: 'https://example.test/' });
  await $.tool.call({ tool: TOOL + 'open', url: 'https://example.test/b' });
  expect(opens).toBe(1);
});

test('other tools leave the pane empty', async ($, on) => {
  stubTools(on);
  const out = await $.tool.call({ tool: 'Bash', command: 'ls' });
  expect(out).toEqual({ result: 'ok' });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: 'Waiting for the first step…' })).toBeDefined();
  await ui.unmount();
});

test('Save as spec calls the server save tool with the goal file name', async ($, on) => {
  const calls: any[] = [];
  const toasts: string[] = [];
  stubTools(on);
  on('ui.open', placed);
  on('mcp.call', ($: any, e: any) => {
    calls.push(e);
    return { value: mcp({ path: '/work/read-the-discussion.yaml', steps: 2 }) };
  });
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text);
    return done();
  });
  await $.tool.call({ tool: TOOL + 'open', url: 'https://example.test/', goal: 'Read the discussion' });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await ui.press({ key: 'save' });
  expect(calls[0]).toMatchObject({ server: 'plugin_plainwright_plainwright', tool: 'save', args: { path: 'read-the-discussion.yaml' } });
  expect(toasts).toContain('Saved 2 steps to /work/read-the-discussion.yaml');
  await ui.unmount();
});

test('a typed spec path is the one saved', async ($, on) => {
  const calls: any[] = [];
  stubTools(on);
  on('ui.open', placed);
  on('mcp.call', ($: any, e: any) => {
    calls.push(e);
    return { value: mcp({ path: '/work/specs/flow.yaml', steps: 1 }) };
  });
  on('ui.toast', done);
  await $.tool.call({ tool: TOOL + 'open', url: 'https://example.test/' });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await ui.input({ key: 'save-path', text: 'specs/flow.yaml' });
  expect(calls[0]).toMatchObject({ args: { path: 'specs/flow.yaml' } });
  await ui.unmount();
});

test('Copy last failure copies the failing step as JSON', async ($, on) => {
  const copied: string[] = [];
  stubTools(on);
  on('ui.open', placed);
  on('ui.copy', ($: any, e: any) => {
    copied.push(JSON.stringify(e));
    return { value: { isCopied: true } };
  });
  on('ui.toast', done);
  await $.tool.call({ tool: TOOL + 'open', url: 'https://example.test/' });
  await $.tool.call({ tool: TOOL + 'step', step: { expect: 'comments are shown' } });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await ui.press({ key: 'copy' });
  expect(copied[0]).toContain('inconclusive');
  expect(copied[0]).toContain('comments are shown');
  await ui.unmount();
});

test('the pane command shows the pane', async ($, on) => {
  let opens = 0;
  on('session.start', () => ({ cwd: '/work' }));
  on('command.register', done);
  on('ui.open', () => {
    opens += 1;
    return placed();
  });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' });
  await $.command.run({ command: 'plainwright-pane', args: '' });
  expect(opens).toBe(1);
});

test('a session end clears the pane', async ($, on) => {
  stubTools(on);
  on('ui.open', placed);
  on('session.end', () => ({}));
  await $.tool.call({ tool: TOOL + 'open', url: 'https://example.test/' });
  await $.session.end({ reason: 'clear' });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: 'Waiting for the first step…' })).toBeDefined();
  await ui.unmount();
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `claude plugin test mods/session-pane`
Expected: the `register.test.ts` tests FAIL (the probe draws nothing and makes no `ui.open`/`mcp.call`); `model` and `view` tests still pass.

- [ ] **Step 3: Replace register.ts**

`mods/session-pane/hooks/session-pane/register.ts`:

```ts
// The mods API is typed by the declarations Claude Code writes into .claude-plugin/types/ for the installed version;
// nothing type-checks this module at build time, so the hook arguments stay `any` here.
import { ENGINE, PLUGIN } from './config.ts';
import { apply, emptyState, jsonOf, payload, saveName, type State } from './model.ts';
import { render, type Elements } from './view.ts';

/** The pane and its command are named after the plugin, so each plugin's copy has its own. */
const PANE = PLUGIN;
const COMMAND = `${PLUGIN}-pane`;
/** Every tool of this plugin's MCP server, which has the plugin's name: `mcp__plugin_plainwright_plainwright__step`. */
const TOOL = new RegExp(`^mcp__plugin_${PLUGIN}_${PLUGIN}__(\\w+)$`);

let state: State = emptyState();
/** The server as `$.mcp.call` names it (`plugin_plainwright_plainwright`), learned from the first matched call. */
let server: string | undefined;
/** What the user typed in the Spec field; undefined follows the goal. */
let typedPath: string | undefined;
/** Whether this session's first `open` already showed the pane: later ones never reopen it. */
let shown = false;

function reset(): void {
  state = emptyState();
  server = undefined;
  typedPath = undefined;
  shown = false;
}

const specPath = (): string => typedPath?.trim() || saveName(state.goal);
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const errorText = (result: any): string => result?.content?.find((block: any) => block?.type === 'text')?.text ?? 'unknown error';

async function show($: any): Promise<void> {
  await $.ui.open({ id: PANE, title: PLUGIN });
}

/** Asks the plugin's own server to write the passing steps: the same session Claude is driving. */
async function save($: any, path: string): Promise<void> {
  if (!server) {
    $.ui.toast('No plainwright session yet: nothing to save');
    return;
  }
  try {
    const result = await $.mcp.call(server, 'save', { path });
    const data = jsonOf(result);
    $.ui.toast(result?.isError ? `Save failed: ${errorText(result)}` : `Saved ${data?.steps} steps to ${data?.path ?? path}`);
  } catch (error) {
    $.ui.toast(`Save failed: ${message(error)}`);
  }
}

async function copy($: any): Promise<void> {
  if (!state.lastFailure) return;
  try {
    await $.ui.copy(JSON.stringify(state.lastFailure, null, 2));
    $.ui.toast('Copied the last failure');
  } catch (error) {
    $.ui.toast(`Copy failed: ${message(error)}`);
  }
}

export function register(on: any): void {
  on('session.start', async ($: any, e: any, next: any) => {
    await $.command.register({ name: COMMAND, description: `Show the ${PLUGIN} session pane`, immediate: true });
    return next(e);
  });

  on('session.end', async ($: any, e: any, next: any) => {
    reset();
    return next(e);
  });

  on('command.run', { command: COMMAND }, async ($: any) => {
    await show($);
    return {};
  });

  // Observe only: the result goes back to Claude exactly as the server sent it, whatever happens in here.
  on('tool.call', { tool: TOOL }, async ($: any, e: any, next: any) => {
    const outcome = await next(e);
    try {
      const data = payload(outcome);
      if (data) {
        const tool = TOOL.exec(e.tool)![1];
        server ??= e.tool.slice('mcp__'.length, e.tool.lastIndexOf('__'));
        state = apply(state, ENGINE, tool, e, data);
        $.ui.invalidate('ui.render');
        if (tool === 'open' && !shown) {
          shown = true;
          await show($);
        }
      }
    } catch (error) {
      $.ui.toast(`${PLUGIN} pane: ${message(error)}`);
    }
    return outcome;
  });

  on('ui.render', { component: 'Pane' }, async ($: any, e: any, next: any) => {
    if (e.requestId !== PANE) return next(e);
    return render(state, $.ui.resolve(e) as Elements, {
      columns: e.props?.bodyColumns ?? 60,
      savePath: specPath(),
      onSavePath: (path) => {
        typedPath = path;
      },
      onSave: (path) => save($, path ?? specPath()),
      onCopy: () => copy($),
    });
  });
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `claude plugin test mods/session-pane`
Expected: all tests in the three files pass. If a stub name is reported under `the engine reported:` as `no implementation for <name>`, add the stub to that test (see the stub table in the test guide) rather than changing `register.ts`.

- [ ] **Step 5: Validate strictly**

Run: `claude plugin validate --strict mods/session-pane`
Expected: no errors or warnings. `hooks:` lists `session.start`, `session.end`, `command.run`, `tool.call`, `ui.render`; `calls:` lists `command.register`, `ui.open`, `ui.invalidate`, `ui.resolve`, `ui.toast`, `ui.copy`, `mcp.call`, and no `fs.*`, `process.*` or `http.*` (the probe's `fs.write` is gone).

- [ ] **Step 6: Commit**

```bash
git add mods/session-pane/hooks/session-pane/register.ts mods/session-pane/hooks/session-pane/register.test.ts
git commit -m "Hook the session pane into plainwright tool calls"
```

---

### Task 5: Ship the mod in each plugin

**Files:**
- Modify: `scripts/build-plugins.mjs` (the per-plugin loop near the end)
- Modify: `package.json` (`scripts`)
- Generated: `plugins/{plainwright,plainwright-computer,plainwright-mobile}/hooks/`

- [ ] **Step 1: Copy the mod in the build script**

In `scripts/build-plugins.mjs`, add this function after the `const stage = …` line:

```js
// The session pane mod (mods/session-pane/hooks/) ships in every plugin without its tests, with a config naming it.
const MOD = join(root, 'mods/session-pane/hooks');
function copyMod(plugin, name) {
  const target = join(plugin, 'hooks');
  rmSync(target, { recursive: true, force: true });
  for (const file of readdirSync(MOD, { recursive: true })) {
    const from = join(MOD, file);
    if (statSync(from).isDirectory() || file.endsWith('.test.ts')) continue;
    mkdirSync(dirname(join(target, file)), { recursive: true });
    copyFileSync(from, join(target, file));
  }
  const engine = name === 'plainwright' ? 'browser' : 'native';
  writeFileSync(join(target, 'session-pane/config.ts'), '// Generated by scripts/build-plugins.mjs from mods/session-pane/: do not edit.\n' +
    `export const PLUGIN: string = ${JSON.stringify(name)};\nexport const ENGINE: 'browser' | 'native' = ${JSON.stringify(engine)};\n`);
}
```

and call it in the per-plugin loop, after the `LICENSE` copy:

```js
    copyFileSync(join(root, 'LICENSE'), join(plugin, 'LICENSE'));
    copyMod(plugin, name);
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: exits 0. Then:

```bash
find plugins/*/hooks -type f | sort
cat plugins/plainwright-mobile/hooks/session-pane/config.ts
```

Expected: each plugin has `hooks/hooks.json` and `hooks/session-pane/{config,model,register,view}.ts`, no `*.test.ts`; the mobile config reads `PLUGIN: string = "plainwright-mobile"` and `ENGINE … = "native"`.

- [ ] **Step 3: Validate each plugin**

```bash
for p in plainwright plainwright-computer plainwright-mobile; do claude plugin validate --strict plugins/$p || exit 1; done
```

Expected: all three pass, each listing the mod's hooks and calls, and their MCP server and skill as before.

- [ ] **Step 4: Check the runtime archive and Codex are untouched**

```bash
tar -tzf plugins/plainwright/runtime.tgz | grep -c hooks/
git diff --stat -- plugins/*/.codex-plugin
```

Expected: `0` (the archive holds no mod files) and no Codex manifest change.

- [ ] **Step 5: Add the test script**

In `package.json` `scripts`, after `"test"`:

```json
    "test:mods": "claude plugin test mods/session-pane",
```

Run: `npm run test:mods`
Expected: all mod tests pass.

- [ ] **Step 6: Run the regular suite**

Run: `npm test`
Expected: passes as before (it does not touch `mods/`).

- [ ] **Step 7: Commit**

```bash
git add scripts/build-plugins.mjs package.json plugins/plainwright/hooks plugins/plainwright-computer/hooks plugins/plainwright-mobile/hooks
git commit -m "Ship the session pane mod in the browser, desktop and mobile plugins"
```

---

### Task 6: Manual check in a real session

No files change unless a problem is found. This catches what the test kit cannot: how the terminal and Desktop paint the pane, and the real server name for `$.mcp.call`.

- [ ] **Step 1: Terminal, browser plugin**

Disable the installed `plainwright` plugin for this check (`/plugin` → Installed), so only the built copy runs, then:

```bash
claude --plugin-dir plugins/plainwright
```

Ask: "Use plainwright to open https://the-internet.herokuapp.com/checkboxes with goal 'tick both checkboxes', check checkbox 1, then expect that both checkboxes are checked."

Check: the pane opens by itself on `open`; rows appear as steps finish, with icons and token counts; the footer totals add up; `/plainwright-pane` shows the pane again after Esc; **Save as spec** writes `tick-both-checkboxes.yaml` in the working directory and shows a toast; `node dist/cli.js --headless tick-both-checkboxes.yaml` passes. Then delete the file.

- [ ] **Step 2: A failing step**

Ask Claude to run one step `{"expect": "the page shows a shopping cart"}`. Check: a `✗` or `?` row with its detail line, the **Copy last failure** button appears, and the pasted clipboard holds the step JSON.

- [ ] **Step 3: Desktop app**

Set `CLAUDE_CODE_PLUGIN_DIRS` to the absolute path of `plugins/plainwright` in `~/.claude/settings.json` `env`, restart the Code tab, repeat Step 1. Check the pane draws and the buttons work. Remove the setting afterwards and re-enable the installed plugin.

- [ ] **Step 4: Fix and record**

If anything differs, fix it in `mods/session-pane/`, add a test that reproduces it, rerun `npm run build` and `npm run test:mods`, and commit with a message saying what the real session showed.

---

### Task 7: Docs and version bump

**Files:**
- Modify: `docs/agent-mode.md`
- Modify: `plugins/plainwright/skills/using-plainwright/SKILL.md`, `plugins/plainwright-computer/skills/using-plainwright-computer/SKILL.md`, `plugins/plainwright-mobile/skills/using-plainwright-mobile/SKILL.md`
- Modify: `CLAUDE.md`
- Modify: the three manifests in each plugin, `src/computer/mcp.ts`, `src/mobile/mcp.ts`

- [ ] **Step 1: Document the pane**

Append to `docs/agent-mode.md`:

```markdown
## Session pane (Claude Code)

In Claude Code v2.1.287 or later (terminal and the Desktop Code tab), each plainwright plugin ships a mod that
draws the session in a pane: the page or app, the flow's goal, one line per step with its status (✓ pass, ✗ fail,
? inconclusive, ! error, – skipped) and Jev tokens, and the totals. The pane opens by itself on the first `open` of a
session; `/plainwright-pane` (`/plainwright-computer-pane`, `/plainwright-mobile-pane`) shows it again.

- **Save as spec** writes the passing steps through the server's own `save` tool, to the path in the Spec field
  (by default a file name made from the goal, relative to the working directory).
- **Copy last failure** copies the last non-passing step, its detail, notes, URL and `changed` as JSON.

The mod only observes tool results; Claude reads exactly what it would without it. It draws nothing in
`claude -p`, the VS Code chat panel or cloud sessions, and Codex never loads it. Turn it off by disabling the plugin's
mods (`disableAllHooks`) or start Claude Code with `--safe-mode`. Its source is `mods/session-pane/`.
```

- [ ] **Step 2: Mention it in each skill**

In each of the three `SKILL.md` files, add this line at the end of the section that introduces the MCP tools (adjust the command name per plugin):

```markdown
In Claude Code the plugin also draws a session pane (`/plainwright-pane`) with each step's status and Jev tokens; it does not change any tool result.
```

- [ ] **Step 3: Update CLAUDE.md**

Under `## Architecture`, after the `Plugins live at …` bullet, add:

```markdown
- `mods/session-pane/` — a Claude Code mod (session pane) that observes each plugin's MCP tool results and draws
  them; `hooks/session-pane/` holds `model.ts` (pure state), `view.ts` (pure tree) and `register.ts` (the only mods
  API user). `scripts/build-plugins.mjs` copies `hooks/` into each plugin (tests excluded) and writes its
  `config.ts`; never edit `plugins/*/hooks/`. Not compiled by `tsc`, not in `runtime.tgz`, invisible to Codex.
  Tests: `npm run test:mods` (needs the `claude` CLI, outside `npm test`).
```

- [ ] **Step 4: Bump versions**

Browser plugin `0.6.18` → `0.7.0`; desktop and mobile `0.1.19` → `0.2.0`:

```bash
sed -i '' 's/"version": "0.6.18"/"version": "0.7.0"/' plugins/plainwright/plugin.json plugins/plainwright/.claude-plugin/plugin.json plugins/plainwright/.codex-plugin/plugin.json
for p in plainwright-computer plainwright-mobile; do sed -i '' 's/"version": "0.1.19"/"version": "0.2.0"/' plugins/$p/plugin.json plugins/$p/.claude-plugin/plugin.json plugins/$p/.codex-plugin/plugin.json; done
grep -n "0.1.19" src/computer/mcp.ts src/mobile/mcp.ts
```

For each line the last command prints, change `0.1.19` to `0.2.0` in that file. Then:

```bash
grep -rn '"version"' plugins/*/plugin.json plugins/*/.claude-plugin/plugin.json plugins/*/.codex-plugin/plugin.json
```

Expected: `0.7.0` three times, `0.2.0` six times.

- [ ] **Step 5: Rebuild and test**

```bash
npm run build
npm test
npm run test:mods
```

Expected: all pass; `dist/` and the runtime archives match `src/`.

- [ ] **Step 6: Commit**

```bash
git add docs/agent-mode.md CLAUDE.md plugins src/computer/mcp.ts src/mobile/mcp.ts dist
git commit -m "Document the session pane and bump plugin versions"
```

---

## Self-review notes

- Spec coverage: target/goal/rows/tokens (Tasks 2–3), save and copy (Tasks 3–4), auto-open and command (Task 4), all three plugins with native reset (Tasks 2, 5), observe-only and error handling (Task 4 `tool.call` hook and its "returns the tool result unchanged" test), testing (Tasks 2–4, `test:mods`), open checks (Task 1, Task 5 Steps 3–4), docs (Task 7).
- The spec's toggle command became show-only, and `$.plugin.name` became a generated `config.ts`; both are stated in the header.
