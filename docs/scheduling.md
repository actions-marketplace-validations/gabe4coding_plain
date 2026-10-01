# Scheduling and previous runs

Scheduling options apply to browser, desktop and mobile spec runs. Browser runs support
`--workers N` (default `1`); desktop and mobile runs require one worker. Reports stream in
input order even when concurrent specs finish out of order. A free worker can start the next
spec while an earlier spec is still running.

## Retries and flaky passes

`--retries N` allows up to N additional attempts after any non-pass result (`fail`, `error`,
`inconclusive` or `skipped`). Each retry starts immediately in the same worker slot. Attempts
are numbered from `0`; their tokens, timing and artifacts remain in the spec report.
Invalid specs produce a load error and are never retried. An error thrown while running a
loaded spec is retried like any other non-pass attempt.

```sh
plainwright --headless --workers 4 --retries 2 tests/
plainwright-computer --retries 1 tests/desktop.yaml
```

A spec that passes on a retry has final status `pass` and `flaky: true`. It counts as passing
for the suite exit code and does not count toward bail. A spec that exhausts its retries keeps
the last attempt's status and is not flaky. The default is `--retries 0`.

## Bail

`--bail N` stops starting new specs after N specs have a final non-pass status. Failed attempts
do not count individually: retries finish before a spec counts. `--bail` alone means
`--bail 1`; `--bail 0` (the default) disables this limit.

```sh
plainwright --headless --retries 1 --bail tests/
plainwright --headless --workers 4 --bail 2 tests/
```

Specs already running finish, including their retries. With multiple workers, more than N
specs can therefore fail. Specs never started appear in input order with `status: skipped`,
`skipReason: bail`, and no attempts.

## Token budget

`--max-tokens N` stops starting specs or retries once the total tokens reported by completed
attempts reaches N. It includes every attempt, including failures and retries. N must be a
positive integer.

```sh
plainwright --headless --retries 2 --max-tokens 50000 tests/
```

Running attempts finish, so this is a scheduling limit rather than a hard spending cap:
a single attempt or concurrent attempts can exceed it. Never-started specs have
`status: skipped`, `skipReason: max-tokens`, and no attempts. If the budget prevents a retry,
that spec is also skipped with the same reason, but keeps all attempts already completed
so their token usage is still counted. A pass remains a pass even if its final attempt
reaches the budget.

When bail and the budget both block a new spec at the same scheduling check, bail takes
precedence. Once a stop reason is recorded, later never-started specs keep that reason.
Retries of running specs remain subject to the token budget even after bail.

## Previous failures

Completed runs save `.plainwright/last-run.json` under the working directory. It contains
`schemaVersion: 1`, an ISO `finishedAt` timestamp, the engine, and each spec's absolute file
path, final status and flaky flag. Each completed run replaces the previous record. The
folder is gitignored; an atomic replacement prevents readers from seeing partial JSON.
A write failure prints a warning and does not change the run's result.

```sh
plainwright --headless tests/
plainwright --headless --last-failed tests/
```

`--last-failed` intersects the selected specs with the previous run's non-pass files:

- No previous file, or an unreadable/invalid file: run every selected spec, with
  `no previous run found; running all selected specs`. An unreadable file also prints a read warning.
- A previous run with no failures: run nothing, with `no failures in the last run`.
- Otherwise: run only the selected files whose final status was not `pass`. This includes
  skipped specs and load errors, and excludes flaky passes. Load errors from the current
  selection are still reported.

The record is shared by all three engines in the working directory. Selection owns the
filtering and fallback notes; the scheduler does not filter specs itself.

## Integration requirements

Lane C implements the scheduler and last-run reader/writer. On the Phase 0 base, lane D
still needs to connect `--last-failed` selection to `readLastFailed()`.
Two changes also need to land in the frozen `src/suite.ts` during integration:

- Populate `RunReport.stopped` from the scheduler's `SpecReport.skipReason` values before
  calling `runEnd` (currently Phase 0 leaves it unset).
- Count load errors toward `--bail` by including them in scheduling's failure count
  without running or retrying them. Phase 0 reports them outside `schedule()`, whose
  `Loaded<S>[]` input only contains successfully loaded specs.

The scheduling limits described above currently apply to the loaded specs passed to
`schedule()`; load errors still report `error` with no attempts.
