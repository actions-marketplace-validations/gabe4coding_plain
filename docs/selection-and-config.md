# Selection, configuration, and validation

These options apply to browser, desktop, and mobile YAML suites. Supply files,
directories, or quoted globs; directory and glob matches expand to YAML files in
sorted order. Selection keeps the resulting input order.

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

## Rerun failures

```sh
plainwright --last-failed --tag smoke tests/
```

The last-run record is `.plainwright/last-run.json` in the current working
directory. Only files whose final status was not `pass` run, after the other
filters. A missing or unreadable record runs every selected spec and prints
`no previous run found; running all selected specs`. A record with no failures
runs none and prints `no failures in the last run`. Load errors remain errors.

Last-run persistence and execution require the scheduling lane (C). This lane
implements the selection rule; Phase 0's scheduling guard still rejects
`--last-failed` until lane C is integrated.

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
| `retries` | nonnegative integer | `0`; additional attempts (C) |
| `bail` | nonnegative integer | `0`; stop after this many failed specs; `0` disables (C) |
| `maxTokens` | positive integer | Unset; stop starting specs at this token total (C) |
| `grep` | string | Unset; include names or paths matching this regex |
| `grepInvert` | string | Unset; exclude names or paths matching this regex |
| `tags` | list of nonempty strings | `[]`; require all tags |
| `reporters` | nonempty list of strings or mappings | Browser: `[text]`; native: `[jsonl]`; mappings use `name` and optional `output`; strings use `NAME[:FILE]` (A) |
| `timing` | boolean | `false`; browser text timing |
| `artifacts.dir` | nonempty string | Unset; setting it enables capture (B) |
| `artifacts.screenshot` | `off`, `on-failure`, or `always` | `on-failure` once `dir` is set (B) |
| `artifacts.trace` | `off`, `on-failure`, or `always` | `on-failure` once `dir` is set; browser only (B) |
| `specTimeout` | positive integer | Unset; whole-spec milliseconds; spec `timeout` wins (E) |
| `timeout` | nonnegative number | `15000`; per-action milliseconds; `0` disables browser timeout; native requires greater than `0` |
| `headless` | boolean | `false`; browser only |
| `profile` | nonempty string | Unset; persistent browser profile folder |
| `channel` | nonempty string | Unset; installed browser channel, e.g. `chrome` |
| `cdp` | nonempty string | Unset; attach to a browser CDP endpoint |
| `server` | nonempty string | Mobile Appium server URL; otherwise existing environment / adapter default |

`--list`, `--last-failed`, and `--config` are invocation controls and have no
config keys. An `artifacts` mapping requires `dir`. Features marked A, B, C, or E
are accepted as config but require their corresponding industrialize lane to
execute; Phase 0 otherwise reports `not implemented yet`.

An example after those lanes are integrated:

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

Validation loads every file and checks its schema and `${env.*}` references in
the URL and step strings. Nested env paths must point to scalar leaves; missing,
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
! tests/secret.yaml: missing environment variable
✘ tests/broken.yaml: ${env.unknown} is not defined
```

### Integration notes

The frozen browser and native CLI wrappers still print only error/warning
messages. Replace their validation output loops with
`console.error(formatValidation(results))` and import `formatValidation` from
`validate.ts` to enable the formatted output above. Their existing 0/1 exit
handling already works.

The frozen `runSuite` retains load errors on normal runs, but its `--list` early
return currently discards them. Integration should print those load errors and
return a failed report when any exist, while preserving the no-key/no-session
list behavior. The successful list output is already wired through
`listSelected` and needs no change.
