You are implementing Phase 0 of the "industrialize plainwright" plan in the repository at the root of
your working directory (a TypeScript ESM project; read `CLAUDE.md` first for build, test and
architecture rules).

Branch: create and work on `industrialize/phase0`, starting from `main`.

## Your task

Implement the contract in `.claude/plans/industrialize/contract.md` exactly. Read all of it before
you write code. Phase 0 is a refactor with no behavior change: it creates the shared suite runner and
every file the later lanes will own, with final signatures and trivial bodies.

Concretely:

1. `src/suite-types.ts`: every type in §2–§5 of the contract.
2. `src/suite.ts`: `runSuite(engine, opts)` following the five steps in §4, calling the lane files.
   `specEnd` is called in input order (today's `cli.ts` prints in input order while later specs keep
   running; keep that). Call `writeLastRun(cwd, report)` at the end.
3. `src/options.ts`: the flag table of §5 with `node:util` `parseArgs` (`multiple: true` for
   `--tag` and `--reporter`), config merge (CLI > existing `PLAINWRIGHT_*` env > config file >
   default), and expansion of directory/glob positionals to sorted `*.yaml`/`*.yml` files without
   new dependencies (Node 22: `fs.readdirSync(dir, { recursive: true })`; for globs, `fs.globSync`
   if available in Node 22.22, else a minimal `*`/`**` matcher). Shell-expanded file lists must
   keep working unchanged.
4. Move today's text printing from `src/cli.ts` into `src/reporters/text.ts` and today's JSON-line
   printing from `nativeCli` (`src/native.ts`) into `src/reporters/jsonl.ts`. Default reporter:
   `text` for the browser CLI, `jsonl` for desktop and mobile.
5. Stubs with final signatures: `src/schedule.ts` (today's `mapLimitSettled` behavior, no retries),
   `src/last-run.ts`, `src/select.ts`, `src/config.ts` (returns `{}`; `--config` with a path that
   does not exist is an error), `src/validate.ts` (load errors only), `src/artifacts.ts` (returns
   `null`), `src/reporters/index.ts`, `src/include.ts` (throws `include: not implemented yet` when a
   raw step has an `include` key), `src/context-options.ts` (move the auth/geolocation code out of
   `openPage` in `src/runner.ts`, unchanged).
6. `src/cli.ts` and `nativeCli` become thin wrappers: build a `SuiteEngine`, parse options, call
   `runSuite`, exit with 0/1/2 as today. `mcp` stays as today. `validate <files>` is a subcommand.
   The Jev provider check (`provider()`) moves from CLI start to just before the first spec runs, so
   `--list` and `validate` need no key.
7. `runSpec` (`src/runner.ts`) and `runNativeSpec` (`src/native.ts`) take an optional
   `RunObserver` and `SpecInfo` and call `sessionOpen` / `stepEnd` / `sessionClose` at the points in
   §3, with a `CaptureTarget` (browser: `page.screenshot`; native: `adapter.screenshot()` written to
   the file). Observer errors are caught and printed once per observer per run; they never change a
   status. MCP callers pass nothing and behave as today.
8. `src/spec.ts` / `src/results.ts`: the schema fields of §6 (`tags`, `timeout`, `browser:` block
   for browser specs only), step `origin` and `label()` prefix (§4), `LoadOptions.onMissingEnv`
   for `loadSpec` and `loadNativeSpec`, and `include` expansion called on raw steps before parsing.
   Desktop/mobile spec schemas (`src/computer-spec.ts`, `src/mobile-spec.ts`) get `tags` and
   `timeout` only.
9. Every new flag and spec field that is not implemented yet fails with
   `<flag or field>: not implemented yet` when given a non-default value. Put each guard in the
   lane-owned stub listed in the contract's guard table, never in `options.ts`, `spec.ts` or
   `suite.ts`: each lane later removes only its own guards. The spec field `tags` is the exception:
   it is only metadata, so it is accepted and carried in `Loaded.tags`.
10. Add `plainwright-results/` and `.plainwright/` to `.gitignore`.

## Tests (new files only; do not edit existing tests except imports)

- `src/reporters/text.test.ts`: golden tests proving the browser output is unchanged. BEFORE moving
  the printing code, write the expected strings from the current `src/cli.ts` formatting. Use a fake
  `SuiteEngine` that returns fixed results. Cover pass, fail, inconclusive, skipped, error, a load
  error, `--timing` on/off, and `--workers 4` with results finishing out of order (output stays in
  input order).
- `src/reporters/jsonl.test.ts`: one JSON line per spec, same fields as today's `nativeCli`.
- `src/options.test.ts`: every flag parses; precedence; directory and glob expansion; every
  "not implemented yet" path; `--workers > 1` errors on desktop/mobile and with `--profile`/`--cdp`.
- `src/suite.test.ts`: observer call order with a fake engine; observer errors do not change
  statuses; `--list`/`validate` paths do not call `provider()`.
- `src/runner-observer.test.ts`: real headless Chromium against `data:text/html` URLs with `goto`
  steps only (like `src/runner.test.ts`): `sessionOpen`, `stepEnd`, `sessionClose` fire, and the
  screenshot file is written.
- Spec loading: `tags`, `timeout`, `browser:` accepted for browser; `browser:` rejected for desktop
  and mobile; `origin` label prefix; a user-written `origin` key is rejected; `onMissingEnv`
  collects instead of throwing.

No test may need a Jev key or network access.

## Rules

- Follow `CLAUDE.md`. Match the surrounding code style (dense, few comments, `ponytail:` notes only
  where the existing code uses that style).
- Do not change `src/steps.ts`, `src/jev.ts`, the MCP servers or `NativeSession`.
- Run `npm test` and make it pass. Do NOT commit `dist/` or `plugins/*/runtime.tgz` (revert them
  with `git checkout -- dist plugins` before committing if the build changed them).
- Commit on `industrialize/phase0` with clear messages. Do NOT push, open a PR or merge.
- If the contract is wrong or impossible somewhere, do not invent a new design: make the smallest
  choice that keeps every later lane's files and signatures intact, and list it in your report.

## Report back

- Branch name and final commit SHA.
- `npm test` summary (pass/fail counts).
- Every place you deviated from the contract, and why.
- Anything a later lane must know that the contract does not say.
