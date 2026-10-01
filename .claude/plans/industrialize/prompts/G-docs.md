You are lane G (docs pass) of the "industrialize plainwright" plan, in the repository at the root of
your working directory. Read `CLAUDE.md` and `.claude/plans/industrialize/contract.md`. All lanes
(Phase 0, A–F) are merged into `main`: the features exist in `src/` and each lane wrote its own page
(`docs/reporting.md`, `docs/artifacts.md`, `docs/scheduling.md`, `docs/selection-and-config.md`,
`docs/drafts/spec-features.md`, `docs/ci.md`).

Branch: create and work on `industrialize/g-docs`, starting from `main`.

## Your task

Make the docs match the code, everywhere, in one consistent voice. The code is the source of truth:
check every flag, default and message against `src/options.ts`, `src/suite-types.ts`,
`src/spec.ts` and the lane files before you write it down.

1. `docs/spec-reference.md`: add `tags`, `timeout`, the `browser:` block and the `include` step
   from `docs/drafts/spec-features.md`; then delete `docs/drafts/`. Add a "Reports and artifacts"
   pointer to the Outcomes section, and the `flaky` meaning.
2. `README.md`: the "Run options and results" table gets every new flag (grouped: running,
   selection, reports, artifacts); the "Configuration" section mentions `plainwright.config.yaml`;
   the "Documentation" table links the new pages. Keep the quick start short.
3. Decide whether `docs/scheduling.md` and `docs/selection-and-config.md` read better as one
   `docs/running.md`. Merge them only if they overlap; fix every link either way.
4. `docs/computer-use.md` and `docs/mobile-use.md`: which new flags and spec fields apply on
   desktop and mobile (retries, bail, max tokens, grep, tags, list, validate, config, reporters,
   `--artifacts`/`--screenshot`, `timeout`, `include`), and which do not (`--trace`, `browser:`,
   `--workers > 1`).
5. Skills: `plugins/plainwright/skills/using-plainwright/` (SKILL.md, authoring.md) and the desktop
   and mobile SKILL.md files: when authoring or replaying specs, mention `include` for shared flows,
   `tags`, `validate` before running, and `--reporter`/`--artifacts` for CI. Keep them short; skills
   are read by agents on every use.
6. `CLAUDE.md` (Commands and Architecture sections): add `src/suite.ts`, `src/options.ts`,
   `src/schedule.ts`, `src/select.ts`, `src/config.ts`, `src/validate.ts`, `src/artifacts.ts`,
   `src/reporters/`, `src/include.ts`, `src/context-options.ts`, `src/last-run.ts` in the same terse
   style as the existing entries, and the new commands (`validate`, `--list`).
7. Keep identity/version/description aligned across each plugin's manifests only if you changed
   any (you should not need to).

## Rules

- Docs and skills only; do not edit `src/`.
- Run `npm test` (it must still pass; docs do not affect it, but the build regenerates
  `runtime.tgz`, which includes the skills — revert `dist/` and `plugins/*/runtime.tgz` before
  committing: the integrator rebuilds).
- Commit on your branch. Do NOT push, open a PR or merge.

## Report back

Branch and SHA, the list of files changed, and every place where a lane's page disagreed with the
code (and which one you trusted).
