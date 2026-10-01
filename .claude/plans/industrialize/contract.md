# Phase 0 contract: shared suite runner

Status: APPROVED (decisions in §8). Phase 0 is built; **§9 lists where the code differs from or adds to §1–§6, and §9 wins.**

Goal of Phase 0: a refactor with **no behavior change** that creates every seam the Phase 1 lanes
need. After Phase 0 merges, each lane fills in the body of files it owns and does not edit any
file owned by another lane (docs excepted, see §7).

Acceptance test for Phase 0:

- `npm test` passes; no existing test is edited except imports.
- Browser text output is unchanged. Live runs are not byte-comparable (token counts vary), so this
  is proven with golden tests: a fake `SuiteEngine` returning fixed results, and expected strings
  written from the **current** `cli.ts` formatting before it is moved. Cover pass, fail,
  inconclusive, skipped, error, a load error, `--timing` on and off, and `--workers 4` with results
  finishing out of order (output must stay in input order).
- Desktop and mobile CLIs still print one JSON line per spec (the `jsonl` reporter), same fields.
- Exit codes unchanged (0 / 1 / 2).
- Every new flag and spec field parses, and any non-default value fails with
  `<flag or field>: not implemented yet` instead of being silently ignored: exit 2 for a flag, a
  load error or spec `error` for a spec field. **Each guard lives in the stub file of the lane that
  implements it** (table below), never in a frozen file, so a lane removes only its own guards:

  | Guard for | Lives in | Lane |
  |---|---|---|
  | `--reporter` other than text/jsonl | `src/reporters/index.ts` | A |
  | `--artifacts` (with any `--screenshot` / `--trace` mode) | `src/artifacts.ts` (`artifactsObserver`) | B |
  | `--retries`, `--bail`, `--max-tokens`, `--last-failed` | `src/schedule.ts` | C |
  | `--grep`, `--grep-invert`, `--tag`, `--list` | `src/select.ts` | D |
  | `--config`, a config file present | `src/config.ts` | D |
  | `validate` | `src/validate.ts` (stub: load errors only, no guard needed) | D |
  | `include` step | `src/include.ts` | E |
  | spec `timeout`, non-empty `browser:` block (at load, so `validate` reports them) | `src/spec-features.ts` (`checkSpecFeatures`) | E |
  | `--spec-timeout` | `src/spec-features.ts` (`checkSpecTimeoutFlag`) | E |

  The suite calls `select`, `createReporters`, `artifactsObserver` and `schedule` before any spec
  starts, so their flag guards exit 2 before a browser opens.
- `--list` and `validate` (still stubs) must not require a Jev key: the provider check moves from
  CLI start to just before the first spec runs. `mcp` keeps today's behavior.

---

## 1. File map and ownership

| File | Created in Phase 0 as | Owner after Phase 0 |
|---|---|---|
| `src/suite-types.ts` | all types below, no logic | frozen (changes go through the main thread) |
| `src/suite.ts` | `runSuite()`, the one loop used by all three CLIs | frozen |
| `src/options.ts` | flag table, `parseSuiteArgs()`, precedence merge | frozen |
| `src/reporters/index.ts` | registry `name → factory` | A |
| `src/reporters/text.ts` | today's ✔/✘ printing, moved from `cli.ts` | A |
| `src/reporters/jsonl.ts` | today's native JSON-per-line printing, moved from `nativeCli` | A |
| `src/schedule.ts` | `schedule()` = today's `mapLimitSettled`, no retries | C |
| `src/last-run.ts` | `readLastFailed()` → `undefined`, `writeLastRun()` no-op; `runSuite` already calls `writeLastRun` at the end | C |
| `src/artifacts.ts` | `artifactsObserver()` returning `null` | B |
| `src/select.ts` | `select()` returning every input | D |
| `src/config.ts` | `loadConfig()` returning `{}` | D |
| `src/validate.ts` | `validate()` = load each spec, report load errors | D |
| `src/include.ts` | `expandIncludes()` that throws if an `include` step exists | E |
| `src/context-options.ts` | `browserContextOptions()` = today's auth/geolocation code from `openPage` | E |
| `src/cli.ts`, `src/native.ts` (`nativeCli`) | thin wrappers over `runSuite` | frozen |
| `src/runner.ts` (`runSpec`, `openSession`, `openPage`), `runNativeSpec` in `src/native.ts` | take an optional `RunObserver` and `SpecInfo`; call it at the fixed points of §3 | E (the observer calls must stay where Phase 0 put them) |
| `src/spec.ts`, `src/results.ts` | new schema fields (§6), `origin` on steps, `LoadOptions` (§4) | frozen |
| `.github/`, `Dockerfile`, `action.yml`, `.dockerignore` | — | F |

The rest of `src/native.ts` (`NativeSession`), `src/steps.ts`, `src/jev.ts` and the MCP servers are
not touched by any lane.

Phase 0 also adds `plainwright-results/` and `.plainwright/` to `.gitignore`, so lanes B and C
never edit it.

"Frozen" means a lane that needs a change there asks the main thread; it does not edit the file in
its branch.

---

## 2. Result model (`src/suite-types.ts`)

`TestResult` (what `runSpec` / `runNativeSpec` return today) stays as is and is renamed in the
types only:

```ts
/** One execution of one spec. Unchanged shape of today's TestResult. */
export type AttemptResult = TestResult; // { name, status, steps, jevCalls, totalTokens }

export type Engine = 'browser' | 'desktop' | 'mobile';

export interface Artifact {
  kind: 'screenshot' | 'trace' | 'dump';
  path: string;          // absolute
  step?: number;         // index in AttemptResult.steps, when tied to one step
}

export interface Attempt extends AttemptResult {
  attempt: number;       // 0-based; >0 only with retries
  durationMs: number;    // wall time of this attempt, measured by the suite
  artifacts: Artifact[];
}

export interface SpecReport {
  file: string;          // as given on the command line
  name: string;          // spec `name`, or the file name when loading failed
  tags: string[];
  /** Final status: the last attempt's status, or 'error' when loading failed, or 'skipped' when the run stopped before it. */
  status: Status;
  /** status === 'pass' && attempts.length > 1. Counts as passing for the exit code. */
  flaky: boolean;
  attempts: Attempt[];   // empty when loading failed or the spec was skipped
  loadError?: string;
  skipReason?: 'bail' | 'max-tokens';
}

export interface RunReport {
  engine: Engine;
  provider: string;      // 'typesafe' | 'gateway'
  model: string;         // MODEL_BY_PROVIDER[provider]
  startedAt: string;     // ISO
  durationMs: number;
  specs: SpecReport[];   // input order, after selection
  totals: { jevCalls: number; tokens: number; passed: number; failed: number; flaky: number; skipped: number };
  stopped?: 'bail' | 'max-tokens';
  status: 'pass' | 'fail'; // 'pass' iff every spec is pass (flaky included)
}
```

Notes:

- `Status` (`src/results.ts`) is **not** extended. `flaky` is a separate boolean so step statuses,
  hooks `teardown({result})` and MCP results are untouched.
- Exit code: 0 when `RunReport.status === 'pass'`, 1 otherwise, 2 for usage/config errors (as today).

---

## 3. Lifecycle (`RunObserver`)

Artifacts and reporters both plug in through one interface. Every method is optional and async.

```ts
/** What an observer may capture from a live session; the same for browser and native. */
export interface CaptureTarget {
  engine: Engine;
  screenshot(file: string): Promise<void>;
  /** Browser only: the active Playwright page (it can change after a popup). */
  page?(): import('playwright').Page;
}

export interface SpecInfo { file: string; name: string; tags: string[]; attempt: number }

export interface RunObserver {
  /** Once, after selection, before the first spec starts. */
  runStart?(e: { engine: Engine; specs: { file: string; name: string; tags: string[] }[] }): Promise<void>;
  /** Session is open, before setup hooks and the first step. Where tracing starts. */
  sessionOpen?(e: SpecInfo & { target: CaptureTarget }): Promise<void>;
  /** After every step, before the next one. Where a failure screenshot is taken. */
  stepEnd?(e: SpecInfo & { index: number; result: StepResult; target: CaptureTarget }): Promise<void>;
  /** Last steps ran, teardown done, session still open. Returns artifacts to attach to this attempt. */
  sessionClose?(e: SpecInfo & { status: Status; target: CaptureTarget }): Promise<Artifact[]>;
  /** A spec is final (all its attempts done). Called in INPUT ORDER, so streamed output stays stable. */
  specEnd?(e: { report: SpecReport }): Promise<void>;
  /** Once, after the last spec. Where file reporters write. */
  runEnd?(e: { report: RunReport }): Promise<void>;
}
```

Rules:

- `runSpec(spec, opts, observer?)` and `runNativeSpec(spec, session, open, observer?)` gain the last
  optional argument. MCP calls them without it, so MCP is unchanged.
- Observer errors never change a spec's status. They are printed to stderr once per observer
  per run (`plainwright: artifacts: <message>`).
- `sessionOpen` / `stepEnd` / `sessionClose` run inside the attempt and count toward its time.
- The suite combines observers in this order: artifacts first, then reporters, so a reporter's
  `specEnd` already sees the artifact paths.
- No `recordVideo` in Phase 1: a Playwright trace already holds a screencast of each action, and
  video would need a context option, which couples lane B to lane E. Revisit later if asked.

---

## 4. Engine adapter (what each CLI gives `runSuite`)

```ts
export interface SuiteEngine<S> {
  engine: Engine;
  /** Parse one file. Throws on invalid spec (becomes SpecReport.loadError). Includes are already expanded. */
  load(file: string, opts?: LoadOptions): S;
  meta(spec: S): { name: string; tags: string[]; timeoutMs?: number };
  run(spec: S, observer: RunObserver | undefined, info: SpecInfo): Promise<AttemptResult>;
  /** 1 for desktop and mobile (one physical input stream). */
  maxWorkers: number;
  /** After the whole run, e.g. closeSharedBrowser(). */
  close?(): Promise<void>;
}

export function runSuite<S>(engine: SuiteEngine<S>, opts: SuiteOptions): Promise<RunReport>;
```

`runSuite` steps, each one a call into a lane-owned file:

1. `files` → `load()` each (load errors kept as `SpecReport`s).
2. `select(loaded, opts)` (D) → the specs to run. With `--list`, print and stop.
3. Build observers: `artifactsObserver(opts)` (B) + `createReporters(opts)` (A).
4. `schedule(selected, opts, runOne)` (C) → `SpecReport`s, retries and stop rules inside.
5. Sum totals, call `runEnd`, `engine.close()`, return the report.

`validate` (D) is a separate entry point that only does step 1 for every file and exits 0/1.

### `LoadOptions` (Phase 0, in `src/spec.ts`; `loadSpec` and `loadNativeSpec` both take it)

```ts
export interface LoadOptions {
  /** When set, a missing `$VAR` does not throw: it is reported here and the leaf keeps the literal
   *  "$VAR" text. Used by `validate`, which runs in PR CI where secrets are absent. */
  onMissingEnv?: (message: string) => void;
}
```

### Step `origin` (Phase 0, in `src/spec.ts` and `src/results.ts`)

Every step schema gets `origin: z.string().optional()`. `parseStep` accepts an `origin` key next
to `optional` (it is not a step kind). `label()` prefixes it: `flows/login.yaml › click "Login"`.
`include.ts` (E) is the only producer; it rejects a user-written `origin` key in a spec file.

### Engine flags

```ts
/** Engine-specific flags, as today: browser headless/profile/channel/cdp, mobile server, all timeout. */
export type EngineFlags = Record<string, string | boolean | undefined>;
```

### Lane-owned function signatures

```ts
// src/last-run.ts (C). File: .plainwright/last-run.json in the cwd.
export function readLastFailed(cwd: string): Set<string> | undefined; // files whose final status was not pass
export function writeLastRun(cwd: string, report: RunReport): void;
// src/schedule.ts (C)
export function schedule<S>(specs: Loaded<S>[], opts: SuiteOptions,
  runOne: (spec: Loaded<S>, attempt: number) => Promise<Attempt>): AsyncIterable<SpecReport>; // input order

// src/select.ts (D)
export function select<S>(specs: Loaded<S>[], opts: SuiteOptions): Loaded<S>[];

// src/config.ts (D)
export function loadConfig(cwd: string, explicit?: string): Partial<SuiteOptions & EngineFlags>;

// src/validate.ts (D)
export function validate<S>(engine: SuiteEngine<S>, files: string[]): { file: string; error?: string; warnings: string[] }[];

// src/artifacts.ts (B)
export function artifactsObserver(opts: SuiteOptions): RunObserver | null;

// src/reporters/index.ts (A)
export function createReporters(opts: SuiteOptions): RunObserver[];

// src/include.ts (E) — runs on raw YAML steps, before StepSchema, for all three engines
export function expandIncludes(rawSteps: unknown[], file: string): unknown[];

// src/context-options.ts (E)
export function browserContextOptions(spec: Spec, opts: RunOptions): BrowserContextOptions;

export interface Loaded<S> { file: string; spec: S; name: string; tags: string[]; timeoutMs?: number }
```

---

## 5. Options

### `SuiteOptions` (engine-independent)

```ts
export interface ReporterSpec { name: string; output?: string } // --reporter junit:out/junit.xml

export interface SuiteOptions {
  files: string[];
  workers: number;            // default 1
  retries: number;            // C, default 0
  bail: number;               // C, stop after N failed specs; 0 = never
  lastFailed: boolean;        // C+D, run only specs that failed in .plainwright/last-run.json (rules below)
  maxTokens?: number;         // C, stop starting new specs once totals.tokens >= this
  grep?: string;              // D, regex on spec name or file
  grepInvert?: string;        // D
  tags: string[];             // D, --tag smoke --tag checkout: spec must have ALL
  list: boolean;              // D
  reporters: ReporterSpec[];  // A, default [{name: 'text'}] browser, [{name: 'jsonl'}] native
  timing: boolean;            // A (text reporter), browser only, as today
  artifacts?: {               // B, undefined = off
    dir: string;              // no default: setting it turns capture on; conventionally 'plainwright-results'
    screenshot: 'off' | 'on-failure' | 'always'; // default 'on-failure' when dir is set
    trace: 'off' | 'on-failure' | 'always';      // default 'on-failure' when dir is set; browser only
  };
  specTimeout?: number;       // E, whole-spec cap in ms; spec `timeout:` wins
}
```

Capture stays off until `artifacts.dir` is set (with `--artifacts` or config). `--screenshot` and `--trace` alone don't turn it on, and their `on-failure` defaults in the flag table only apply once the dir is set.

### Flags (all three CLIs unless noted)

| Flag | Type | Default | Lane | Config key |
|---|---|---|---|---|
| `--workers N` | number | 1 | exists | `workers` |
| `--retries N` | number | 0 | C | `retries` |
| `--bail [N]` | number | 0 (`--bail` alone = 1) | C | `bail` |
| `--last-failed` | boolean | false | C | — |
| `--max-tokens N` | number | — | C | `maxTokens` |
| `--grep RE` / `--grep-invert RE` | string | — | D | `grep` / `grepInvert` |
| `--tag T` (repeatable) | string[] | [] | D | `tags` |
| `--list` | boolean | false | D | — |
| `--config FILE` | string | `./plainwright.config.yaml` if present | D | — |
| `--reporter NAME[:FILE]` (repeatable) | string[] | text / jsonl | A | `reporters` |
| `--artifacts DIR` | string | — | B | `artifacts.dir` |
| `--screenshot MODE` | enum | on-failure | B | `artifacts.screenshot` |
| `--trace MODE` (browser) | enum | on-failure | B | `artifacts.trace` |
| `--spec-timeout MS` | number | — | E | `specTimeout` |
| `--timing` (browser) | boolean | false | exists | `timing` |
| `--timeout MS` | number | 15000 | exists | `timeout` |
| `--headless`, `--profile`, `--channel`, `--cdp` (browser) | as today | | exists | same names |
| `--server URL` (mobile) | as today | | exists | `server` |

`--last-failed` rules (C reads the file, D filters):

- no `.plainwright/last-run.json`, or an unreadable one → `readLastFailed` returns `undefined` →
  every selected spec runs, with one note `no previous run found; running all selected specs`;
- a last-run file that lists no failures → an empty `Set` → nothing runs (load errors are still
  reported), with one note `no failures in the last run`;
- otherwise → only the listed files run.

Subcommands (first positional, like `mcp`): `validate <files...>` (D).

Positional files may be directories or globs; `options.ts` expands them to `*.yaml`/`*.yml`, sorted,
so `plainwright tests/` works without the shell. (Phase 0 implements this; it is tiny.)

Precedence: CLI flag > `PLAINWRIGHT_*` env (existing ones only) > config file > default.
`--workers > 1` on desktop/mobile is an error (exit 2), as is combining it with `--profile`/`--cdp`
(as today).

---

## 6. Spec fields (declared in Phase 0, implemented by E unless noted)

All three engines:

```yaml
tags: [smoke, checkout]      # D uses it for --tag
timeout: 120000              # whole-spec cap in ms; overrides --spec-timeout
steps:
  - include: ./flows/login.yaml   # E: replaced by that file's `steps` at load time
```

- `include` is expanded on raw YAML **before** step validation, so it never reaches `runSpec`, the
  MCP server or `save`. The included file has only `steps:` (and may include again; a cycle is a
  load error naming the chain). Paths resolve relative to the including file. Placeholders in
  included steps resolve against the **including** spec's `env`/`hooks`. Each included step gets
  `origin` (§4), so its label reads `flows/login.yaml › click "the Login button"`.
- `timeout` (and `--spec-timeout`) is implemented by E inside `runSpec` / `runNativeSpec`: each step
  races the remaining time; when it runs out, the attempt is `error` with
  `detail: spec timeout after <ms> ms`, no further step starts, teardown still runs, then the session
  closes (which also stops the cut step).

Browser only, grouped so desktop/mobile schemas reject it by not having the key:

```yaml
browser:
  viewport: { width: 1280, height: 800 }
  device: iPhone 15          # a Playwright devices[] name; sets viewport, UA, touch, scale
  locale: it-IT
  timezone: Europe/Rome
  colorScheme: dark          # light | dark
  storageState: ./.auth/user.json   # load cookies/localStorage into the context
  saveState: ./.auth/user.json      # after a PASSING run, write the context's state here
```

- `--cdp` + any `browser:` key is an error (same rule as `auth`/`geolocation` today).
- `storageState`/`saveState` paths resolve relative to the spec file. A missing `storageState`
  file is an `error` at session open: `storageState file not found: <path> (run the spec that saves
  it first)`. There is no dependency system between specs in v1.
- `--profile` + `storageState` is an error (a persistent context cannot load one).

---

## 7. Rules for every lane

1. Work in your own worktree and branch, from the Phase 0 merge commit.
2. Edit only the files your lane owns (table in §1), plus new files under your own names.
3. Tests go in **new** `src/<lane-file>.test.ts` files. Use injected engines/observers; no Jev key,
   no network, like today's suite.
4. Do **not** commit `dist/` or `plugins/*/runtime.tgz`. The integrator rebuilds once.
5. Docs: write only your own new page — A `docs/reporting.md`, B `docs/artifacts.md`,
   C `docs/scheduling.md`, D `docs/selection-and-config.md`, E `docs/drafts/spec-features.md`,
   F `docs/ci.md`. Do not edit README, `spec-reference.md`, `computer-use.md`, `mobile-use.md`,
   `CLAUDE.md` or any SKILL.md: one docs agent (G) does those at the end.
6. `.gitignore` already has `plainwright-results/` and `.plainwright/` (added in Phase 0); do not edit it.
7. Do not push, open PRs or merge. Report the branch name and test output.

## 8. Decisions (approved)

1. `flaky` counts as pass for the exit code. No `--fail-on-flaky` in v1.
2. `--tag` with several values: the spec must have ALL of them.
3. `saveState`/`storageState` have no dependency system in v1: the user runs the login spec first.
4. Artifacts default to `plainwright-results/`, the last run to `.plainwright/last-run.json`, both
   in the cwd.
5. `include` files hold only `steps:`; no `env:` of their own.
6. No video in v1 (§3).

## 9. Phase 0 as built (wins over §1–§6)

Ownership additions:

| File | Owner |
|---|---|
| `src/observe.ts` (`observerCalls`: per-spec observer calls, errors printed once) | frozen |
| `src/spec-features.ts` (`checkSpecFeatures`, `checkSpecTimeoutFlag`) | E |

Signatures that differ from §3/§4:

- `runSuite(engine, opts, services?)`: `services = { provider, warmUp, observers? }` is for key-free tests.
- `runSpec(spec, opts, observer?, info?)`; `RunOptions.specTimeout` carries `--spec-timeout`.
- `runNativeSpec(spec, session, open, observer?, info?, specTimeout?)`; `specTimeout` is unused until E.
- `nativeCli(bin, usage, engine, { serve, load, meta, run(spec, timeout, values, observer?, info?, specTimeout?) })`.
- `parseSuiteArgs(argv, engine, env?, cwd?, readConfig = loadConfig)`; throws `UsageError` when no spec paths
  are given (each CLI prints its own usage line). `mcp` never reads the config file.
- `Attempt.error?: string`: `${error}` when `engine.run` threw before any step (no steps). The text reporter prints
  it like a load error (`✘ <file>` / `  error: <message>`); `jsonl` prints `<file>: <error>` on stderr, no stdout line.
  `SpecReport.loadError` is stored the same way (`${error}`).
- `RunObserver.sessionOpen` fires when the target can be captured, before the first step. Browser: right after
  the context opens, before setup hooks. Desktop/mobile: after setup hooks and `open()`. `stepEnd` fires only after
  it, `sessionClose` only when it fired.
- `runEnd` fires after `engine.close()` (so `ms run` prints after the browser closes, as before).

Lane helpers that frozen files call — a lane keeps exporting them with the same signature:

- C: `checkSchedule(opts)`, called by `runSuite` before any spec starts (exit 2 for a bad flag).
- D: `listSelected(specs, opts): boolean`; when it returns `true` (it printed the list), `runSuite` stops and
  returns an empty pass report without running anything or asking for a key.
- A: `createReporters(opts)` returns exactly one observer per `opts.reporters` entry, in the same order (the suite
  names each one after its `ReporterSpec` in warnings).

Options (`src/options.ts`, frozen) already do:

- CLI > existing `PLAINWRIGHT_*` env (`PROFILE`, `CHANNEL`, `CDP`, `APPIUM_URL`) > config > default for every config
  key, including `files:` (used when no paths are given), `artifacts.{dir,screenshot,trace}`, `tags`, `timing`,
  `headless`, `server`. Lane D's `loadConfig` only has to return a validated object with paths resolved.
- `--screenshot` / `--trace` are validated (`off | on-failure | always`) and passed through in `opts.artifacts`
  only when a dir is set; without a dir they print one warning. The desktop/mobile `--trace` rule (anything but
  `off` is an error) belongs to lane B, in `artifactsObserver`.
- `--timeout`: browser accepts `0` (Playwright's "no timeout"), desktop/mobile need a positive number.

Spec loading (`src/spec.ts`, frozen):

- `tags` accepts one string or a list (always a list after loading), for all engines.
- `origin` is attached by `withOrigin()` after parsing, only on the load path; `parseStep` (used by MCP) rejects
  an `origin` key as one key too many, as before Phase 0.

