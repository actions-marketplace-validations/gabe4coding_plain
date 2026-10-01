You are lane D (selection, config, validate) of the "industrialize plainwright" plan, in the
repository at the root of your working directory. Read `CLAUDE.md`, then
`.claude/plans/industrialize/contract.md` (all of it; §4 signatures and `LoadOptions`, §5 options
and §7 rules matter most). Phase 0 is already merged: `select()`, `loadConfig()` and `validate()`
exist as stubs and are already wired into the CLIs.

Branch: create and work on `industrialize/d-selection`, starting from `main`.

## Files you own (edit only these, plus new files you create)

`src/select.ts`, `src/config.ts`, `src/validate.ts`, `docs/selection-and-config.md` (new), new tests
`src/select*.test.ts`, `src/config*.test.ts`, `src/validate*.test.ts`.

## Your task

Remove the "not implemented yet" guards Phase 0 put in `src/select.ts` and `src/config.ts`.

1. `select(specs, opts)`, applied in this order, keeping input order:
   - `--grep RE`: keep a spec when RE matches its `name` OR its file path (relative to cwd).
     `--grep-invert RE`: drop those that match. An invalid regex is an error (exit 2).
   - `--tag T` (repeatable): keep a spec only if its `tags` contain ALL given tags (decided).
   - `--last-failed`: keep only files in `readLastFailed(cwd)` (from `src/last-run.ts`, lane C;
     today a stub returning `undefined`). `undefined` → keep everything and print one note
     `no previous run found; running all selected specs`.
   - Specs with a load error are always kept (so they are reported), whatever the filters.
2. `--list`: `runSuite` prints what `select` returned and stops (check how Phase 0 wired the output;
   if the printing lives in a frozen file, give `select.ts` a `formatList(specs)` and report the
   one-line wiring change). Format: one line per spec, `<file>  <name>  [tag, tag]`. No browser, no
   Jev key.
3. `loadConfig(cwd, explicit?)`: read `plainwright.config.yaml` (or `.yml`) in `cwd`, or the
   explicit `--config` path. Keys are the config-key column of contract §5 plus the engine flags
   (`timeout`, `headless`, `profile`, `channel`, `cdp`, `server`). Validate with Zod: an unknown key
   or a wrong type is an error naming the file and the key. Relative paths in it (`artifacts.dir`,
   `profile`, reporter outputs) resolve against the config file's folder. Optional `files:` list (or
   folders/globs) used when the command line gives no spec paths. No `$VAR` expansion in v1
   (secrets belong in the env, not in the config).
4. `validate(engine, files)`: load every file with `LoadOptions.onMissingEnv` (so a missing `$VAR`
   is a warning, not an error: validate runs in PR CI without secrets). Also check statically that
   every `${env.a.b}` used in `url` or steps exists in the spec's `env` block (a `$VAR` leaf counts
   as present); `${hooks.*}` cannot be checked and is skipped. Output: `✔ <file>`, `✘ <file>:
   <error>`, `! <file>: <warning>`; exit 1 if any error, else 0. No browser, no Jev key.
5. `docs/selection-and-config.md`: grep, tags, last failed, list, the config file (full key table
   and an example), validate in CI.

## Tests

New files, no browser, no key: each filter alone and combined, order kept, load errors kept,
invalid regex, `--last-failed` with and without a previous run (inject or stub `readLastFailed` via a
temp cwd), config parsing (unknown key, wrong type, relative paths, `files:`), validate on fixture
specs (valid, invalid schema, missing `$VAR` → warning, unknown `${env.x}` → error, `${hooks.x}`
skipped). Put fixture YAML under `src/fixtures/` or a temp dir, not under `examples/`.

## Rules

- Edit only the files you own. If you need a change in a frozen file, do not make it: describe it in
  your report.
- `npm test` must pass. Do NOT commit `dist/` or `plugins/*/runtime.tgz`
  (`git checkout -- dist plugins` before committing).
- Commit on your branch. Do NOT push, open a PR or merge.

## Report back

Branch and SHA, `npm test` summary, a sample `--list` and `validate` output, and any change you need
in a frozen file.
