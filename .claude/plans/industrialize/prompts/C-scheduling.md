You are lane C (scheduling) of the "industrialize plainwright" plan, in the repository at the root of
your working directory. Read `CLAUDE.md`, then `.claude/plans/industrialize/contract.md` (all of it;
§2 result model, §4 signatures, §5 options and §7 rules matter most). Phase 0 is already merged:
`schedule()` and `src/last-run.ts` exist as stubs, and `runSuite` already calls them.

Branch: create and work on `industrialize/c-scheduling`, starting from `main`.

## Files you own (edit only these, plus new files you create)

`src/schedule.ts`, `src/last-run.ts`, `docs/scheduling.md` (new), new tests
`src/schedule*.test.ts`, `src/last-run*.test.ts`.

## Your task

Remove the "not implemented yet" guards for `--retries`, `--bail`, `--max-tokens` and `--last-failed` that Phase 0 put in `src/schedule.ts`.

1. Retries (`--retries N`): an attempt whose status is not `pass` is run again, up to N more times,
   right away in the same worker slot (so input-order streaming still works). A load error is never
   retried. Each attempt gets `attempt` 0..N. A spec that passes after a failed attempt is
   `flaky: true`, status `pass`.
2. `--bail N`: once N specs have a final non-pass status (flaky does not count), start no new spec;
   specs already running finish; specs never started get `status: 'skipped'`,
   `skipReason: 'bail'`, no attempts, and still appear in input order. Set `RunReport.stopped`
   through what the suite reads from your output (check how Phase 0 wired it).
3. `--max-tokens N`: before starting a spec or a retry, if total tokens so far ≥ N, do not start
   it: `skipped`, `skipReason: 'max-tokens'`. Running ones finish. Retries count toward the total.
4. Concurrency: at most `opts.workers` attempts in flight. Results come out as an async iterable in
   input order, each as soon as it and all earlier ones are final.
5. `src/last-run.ts`: `writeLastRun` writes `.plainwright/last-run.json` (create the folder):
   `{ "schemaVersion": 1, "finishedAt", "engine", "specs": [{ "file", "status", "flaky" }] }`, file
   paths absolute. `readLastFailed` returns the absolute files whose final status was not `pass`,
   or `undefined` when there is no file (or it is unreadable: then print one warning). Lane D's
   `select()` calls `readLastFailed` for `--last-failed`; do not implement the filtering yourself.
   With `--last-failed` and no previous failures, D's select runs nothing — that is fine.
6. `docs/scheduling.md`: retries and flaky, bail, max tokens, last failed, with examples.

## Tests

New files, with a fake `runOne` (no browser, no key): retry counts, flaky marking, no retry of load
errors, bail with workers 1 and 4 (running specs finish, never-started ones skipped), max-tokens
including retries, input-order output when attempts finish out of order, last-run file round trip,
unreadable last-run file.

## Rules

- Edit only the files you own. If you need a change in a frozen file (`suite.ts`, `suite-types.ts`,
  ...), do not make it: describe it in your report.
- `npm test` must pass. Do NOT commit `dist/` or `plugins/*/runtime.tgz`
  (`git checkout -- dist plugins` before committing).
- Commit on your branch. Do NOT push, open a PR or merge.

## Report back

Branch and SHA, `npm test` summary, and any change you need in a frozen file.
