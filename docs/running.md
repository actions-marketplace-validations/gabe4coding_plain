# Running suites

These options apply to browser, desktop, and mobile YAML suites. Supply files,
directories, or quoted globs; directories expand recursively to `.yaml`/`.yml`
files, and globs support `*` and `**`. Matches for each input are sorted; selection
keeps input order. Keep steps-only flow files outside the paths you run as specs.

Browser runs support `--workers N` (default `1`) in isolated contexts. Desktop
and mobile require one worker; browser `--profile` and `--cdp` also require one.
Reports stream in input order even if concurrent specs finish out of order.
A free worker can start the next spec while an earlier spec is still running.

`--timeout MS` defaults to `15000` per action (browser `0` disables it; native
requires a positive value). `--spec-timeout MS` sets a positive whole-attempt
budget, overridden by the spec’s `timeout:`; there is no whole-attempt cap by
default. Opening and setup consume that budget, but cleanup may finish after it.
See [spec timeouts](spec-reference.md#timeouts) for the deadline behavior.

Exit codes: `0` when every selected spec passes (including flaky passes, or an
empty selection), `1` for non-passing results or load errors, `2` for invocation,
config, or missing provider errors. [Reporting](reporting.md) describes output
formats; [artifacts](artifacts.md) describes optional evidence capture.

## Select specs

```sh
plainwright --grep 'Login|Checkout' tests/
plainwright --grep-invert 'Refund' tests/
plainwright --tag smoke --tag checkout tests/
plainwright --list --tag smoke tests/
```

`--grep` matches a JavaScript regular expression against the spec name **or** its
file path relative to the current working directory. `--grep-invert` excludes a
spec when either matches. Invalid expressions are usage errors (exit 2).
Expressions are case-sensitive; quote them to prevent shell expansion.

`--tag` can be repeated. A spec must have **all** requested tags; matches are
exact and case-sensitive. Declare tags in YAML as a string or a list:

```yaml
name: Checkout with a saved address
tags: [smoke, checkout]
url: https://test.example.com
steps:
  - expect: The checkout page is shown
```

Filters combine in this order: grep and grep-invert, tags, then last failed.
Specs that fail to load still produce errors even when they would not match a
filter, so filtering cannot hide broken YAML.

`--list` prints one line per selected spec and stops before requesting a model
key, opening a browser, or running hooks:

```text
tests/checkout.yaml  Checkout with a saved address  [smoke, checkout]
```

An untagged spec ends with `[]`. An empty selection prints nothing.

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
that spec keeps its last completed attempt’s status and all completed attempts; it is not
marked skipped and has no `skipReason`. The run’s `stopped` field is only set when at least
one spec never starts, so it can be absent when only retries were cut short. A pass
remains a pass even if its final attempt reaches the budget.

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
  skipped specs and load errors, and excludes flaky passes. Every current load error
  is still reported, even for a file excluded by filters.

The record is shared by all three engines in the working directory. `--list` and `validate`
do not update it. A completed run with no selected specs replaces it with an empty record.

## Load errors

A spec that fails to load is reported as `error` but never runs, so it is not retried and does not count
toward `--bail`.

## Configuration

The CLI discovers `plainwright.config.yaml` in the current working directory,
then `plainwright.config.yml` if the `.yaml` file is absent. Use `--config FILE`
to select another file. A missing explicit file is an error. An absent default
file uses CLI defaults. MCP mode does not read a suite config.

```yaml
files: [tests/]
workers: 1
headless: true
timeout: 15000
tags: [smoke]
grepInvert: Refund
reporters:
  - text
```

Run `plainwright` with no positional paths to use `files`. Explicit positional
paths replace this list. Config paths (`files`, `profile`, `artifacts.dir`, and
reporter outputs) resolve relative to the config file's folder, including when
it is selected with `--config`. CLI paths keep their usual cwd-relative meaning.
Absolute paths stay absolute. Config strings do not expand `$VAR`; secrets
belong in the environment and in spec `env` references.

Precedence is CLI flags, existing `PLAINWRIGHT_*` environment settings, config,
then defaults. The existing environment settings are `PLAINWRIGHT_PROFILE`,
`PLAINWRIGHT_CHANNEL`, `PLAINWRIGHT_CDP`, and `PLAINWRIGHT_APPIUM_URL`.
CLI `--tag` and `--reporter` values replace their config lists.

Unknown keys, incorrect types, and invalid numeric ranges are errors naming the
config file and key. Use YAML numbers and booleans, rather than quoted strings.

| Key | Type | Default / meaning |
| --- | --- | --- |
| `files` | list of strings | Files, directories, or globs used when no run paths are given |
| `workers` | positive integer | `1`; desktop/mobile require `1`; browser profile/CDP also require `1` |
| `retries` | nonnegative integer | `0`; additional attempts |
| `bail` | nonnegative integer | `0`; stop after this many final non-passes; `0` disables |
| `maxTokens` | positive integer | Unset; stop starting specs/retries at this completed-attempt token total |
| `grep` | string | Unset; include names or paths matching this regex |
| `grepInvert` | string | Unset; exclude names or paths matching this regex |
| `tags` | nonempty string or list of them | `[]`; require all tags |
| `reporters` | nonempty list of strings or mappings | Browser: `[text]`; native: `[jsonl]`; mappings use `name` and optional `output`; strings use `NAME[:FILE]` |
| `timing` | boolean | `false`; browser text timing |
| `artifacts.dir` | nonempty string | Unset; setting it (here or with `--artifacts`) enables capture |
| `artifacts.screenshot` | `off`, `on-failure`, or `always` | `on-failure` once a dir is set |
| `artifacts.trace` | `off`, `on-failure`, or `always` | `on-failure` on browser, `off` on desktop/mobile; native runs reject other modes once a dir is set |
| `specTimeout` | positive integer | Unset; whole-spec milliseconds; spec `timeout` wins |
| `timeout` | nonnegative number | `15000`; per-action milliseconds; `0` disables browser timeout; native requires greater than `0` |
| `headless` | boolean | `false`; browser only |
| `profile` | nonempty string | Unset; persistent browser profile folder |
| `channel` | nonempty string | Unset; installed browser channel, e.g. `chrome` |
| `cdp` | nonempty string | Unset; attach to a browser CDP endpoint |
| `server` | nonempty string | Mobile Appium server URL; otherwise existing environment / adapter default |

`--list`, `--last-failed`, and `--config` are invocation controls and have no
config keys. Each `artifacts` key may be set alone: a mode in the config can pair
with `--artifacts <dir>` on the command line. An empty config file is an empty
config. A `profile` starting with `~` is expanded to your home folder.

An example:

```yaml
files: ['tests/**/*.yaml']
headless: true
workers: 4
retries: 1
reporters:
  - text
  - junit:reports/junit.xml
  - {name: json, output: reports/results.json}
artifacts:
  dir: plainwright-results
  screenshot: on-failure
  trace: on-failure
```

## Validate in CI

```sh
plainwright validate tests/
plainwright-computer validate tests/desktop/
plainwright-mobile validate tests/mobile/
```

Validation loads every file, expands includes, and checks its schema and placeholders
in the browser URL, desktop app, mobile platform/device/app/capabilities, and step
strings. Nested env paths must point to scalar leaves; missing,
null, object, and array values cannot be interpolated. A `$VAR` leaf counts as
declared even if the environment variable is absent. Missing environment
variables produce warnings, so PR CI can validate specs without secrets.
`${hooks.*}` references are skipped because setup data is only known at runtime.
Validation does not open sessions, run hooks, or request a Jev key.

Exit codes: `0` when all files validate (warnings allowed), `1` when any file
fails, `2` for invocation or config errors. Selection flags do not filter
validation; give the paths to check explicitly.

The shared formatter produces:

```text
✔ tests/login.yaml
✔ tests/secret.yaml
! tests/secret.yaml: tests/secret.yaml: "env.password" references $TEST_PASSWORD but that env var is not set
✘ tests/broken.yaml: ${env.unknown} is not defined
```

`validate` prints these lines on stdout and exits 1 if any spec has an error.
`${env.*}` is checked in `url`, desktop `app`, the mobile target fields and every
step; `${hooks.*}` is known only after setup and is skipped; any other namespace
is an error. `--list` also reports specs that fail to load (on stderr) and then
exits 1. Unlike `validate`, listing resolves `$VAR` leaves normally, so required
spec environment variables must be set. Validation checks schema and placeholders;
it does not check runtime device presets, stored browser state, or hook exports.
