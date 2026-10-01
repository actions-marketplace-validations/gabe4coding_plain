You are lane E (spec features) of the "industrialize plainwright" plan, in the repository at the root
of your working directory. Read `CLAUDE.md`, then `.claude/plans/industrialize/contract.md` (all of
it; §1 ownership, §4 step `origin`, §6 spec fields and §7 rules matter most). Phase 0 is already
merged: the schema fields exist and fail with "not implemented yet", `expandIncludes()` and
`browserContextOptions()` exist as stubs, and the observer calls are in `runSpec` / `runNativeSpec`.

Branch: create and work on `industrialize/e-spec-features`, starting from `main`.

## Files you own (edit only these, plus new files you create)

`src/include.ts`, `src/spec-features.ts`, `src/context-options.ts`, `src/runner.ts` (`runSpec`, `openSession`, `openPage`),
`runNativeSpec` in `src/native.ts` (only that function), `docs/drafts/spec-features.md` (new), new
tests `src/include*.test.ts`, `src/context-options*.test.ts`, `src/spec-timeout*.test.ts`.
Keep every observer call in `runSpec` / `runNativeSpec` exactly where Phase 0 put it.

## Your task

1. `include:` (all engines, contract §6): `expandIncludes(rawSteps, file)` replaces each
   `{ include: <path> }` step with the `steps:` of that YAML file, recursively. The included file
   may contain only `steps:` (anything else is an error naming the file and key). Paths resolve
   relative to the file that contains the include. A cycle is an error naming the chain
   (`a.yaml → flows/b.yaml → a.yaml`). Each included step gets `origin: <path relative to the root
   spec's folder>`; a user-written `origin` key is an error. `optional: true` on an include step is
   an error in v1 (say so). Placeholders are not touched here: they resolve later against the root
   spec's `env`/`hooks`, as today.
2. `browser:` block (browser only), applied in `browserContextOptions()`: `viewport`, `device`
   (Playwright `devices[name]`; an unknown name is an error listing 3 close names), `locale`,
   `timezone` (→ `timezoneId`), `colorScheme`. `device` first, explicit keys override it. With
   `--cdp`, any `browser:` key is an error (same rule and wording style as `auth`/`geolocation`
   today). With `--profile`, these options go to `launchPersistentContext` (Playwright supports
   them there).
3. `storageState` / `saveState` (browser only): paths relative to the spec file. `storageState` is
   loaded into the new context; a missing file is an `error` at session open:
   `storageState file not found: <path> (run the spec that saves it first)`. `--profile` +
   `storageState` is an error. `saveState`: after a run whose final status is `pass`, before the
   session closes, write `context.storageState({ path })` (create the folder). Never write it for a
   non-passing run. Warn in the docs that the file holds session cookies and must be gitignored.
4. Spec timeout (all engines): `timeout:` in the spec, else `--spec-timeout`, else none. Each step
   races the remaining time. When it runs out: push a result `{ step: <label>, status: 'error',
   detail: 'spec timeout after <ms> ms' }`, start no further step, run teardown as today, then close
   the session (this also stops the cut step). Setup hooks count toward the time.
5. Remove the "not implemented yet" guards for `include` (`src/include.ts`) and for spec `timeout`,
   `browser:` and `--spec-timeout` (`src/spec-features.ts`, contract §9; they run at load time so
   `validate` reports them). Keep `checkSpecFeatures` / `checkSpecTimeoutFlag` exported (frozen files
   call them); they may become no-ops or keep real validation. `runNativeSpec` already receives
   `specTimeout`; `RunOptions.specTimeout` carries the flag for the browser.
6. `docs/drafts/spec-features.md`: the new keys as rows ready to paste into
   `docs/spec-reference.md`, plus a short "Reusable flows" and "Logged-in state" section.

## Tests

New files. `include`: nesting, relative paths, cycle, extra keys, `origin` labels, user `origin`
rejected (no browser). `browserContextOptions`: device + override, unknown device, `--cdp` and
`--profile` errors (no browser). With real headless Chromium against `data:text/html` URLs (as in
`src/runner.test.ts`, `goto` steps only): viewport and locale actually apply
(`evaluate`-free: check through a page whose script writes `innerWidth`/`navigator.language` into
the title, then a `goto` to it and read the result from the session), `saveState` written only on
pass, `storageState` round trip, spec timeout cuts a slow step and teardown still runs (use a hooks
fixture). Native spec timeout with an injected adapter. No key, no network.

## Rules

- Edit only the files you own. If you need a change in a frozen file, do not make it: describe it in
  your report.
- Do not change `src/steps.ts`, `src/jev.ts`, the MCP servers or `NativeSession`.
- `npm test` must pass. Do NOT commit `dist/` or `plugins/*/runtime.tgz`
  (`git checkout -- dist plugins` before committing).
- Commit on your branch. Do NOT push, open a PR or merge.

## Report back

Branch and SHA, `npm test` summary, and any change you need in a frozen file.
