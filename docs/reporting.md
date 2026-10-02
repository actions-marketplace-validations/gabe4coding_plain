# Reporting

All three CLIs accept repeatable `--reporter NAME[:FILE]` flags. Browser runs default to `text`;
desktop and mobile runs default to `jsonl`. Explicit flags replace the default reporter list.

```sh
plainwright --headless --reporter text --reporter junit:out/junit.xml --reporter json:out/run.json tests/
plainwright-computer --reporter jsonl --reporter junit:out/desktop.xml tests/desktop/
plainwright-mobile --reporter json:out/mobile.json tests/mobile/
```

| Reporter | Destination | Behavior |
|---|---|---|
| `text` | stdout | Status icons, step labels and details; browser `--timing` adds phase timings. |
| `jsonl` | stdout | One line per executed spec, with the legacy native result fields. Load errors, thrown runs and never-started skips go to stderr. |
| `junit:FILE` | File | JUnit XML for CI, written when the suite finishes. |
| `json:FILE` | File | Complete run report, written when the suite finishes. |

`junit` and `json` require a nonempty file path and create missing parent directories. `text` and
`jsonl` do not accept file paths. At most one stdout reporter is allowed, including duplicate names.
Two file reporters cannot write the same resolved output path. Unknown names and
invalid combinations are usage errors (exit 2) before a session opens.
Reporters run in flag order. File-write failures are reported on stderr using the suite's observer
warning behavior; they do not change spec results or the exit code, so a CI job that needs the
file should also check that it exists.

Text output uses the same step format for ordinary runs. A flaky result adds `flaky, passed on attempt N` to
its header and prints the earlier attempts' failing steps underneath, prefixed `attempt K:`.
Attempt numbers in text are one-based. A spec skipped by a stop rule prints
`» <file>  (skipped: bail|max-tokens)`.
A run with retries or stop-rule skips prints a final summary when the report contains
more than one spec, including load errors and never-started skips:

```text
1 passed, 1 failed, 1 flaky, 1 skipped  (6 Jev calls, 90 tokens, 5.25s)
```

`passed` includes flaky specs. Summary counts and model usage include all attempts; elapsed time is the
suite's wall time. Ordinary runs retain their existing output without a new summary.

## JUnit XML

The document contains one `<testsuites name="plainwright <engine>">` and one
`<testsuite name="plainwright">`. There is one testcase per spec, in input order. Both parent
elements carry `tests`, `failures`, `errors`, `skipped`, and elapsed `time` in seconds. A testcase's
`classname` is the spec file relative to the working directory, `name` is the spec name, and
`time` is the sum of its attempts' durations in seconds. Load errors and unexecuted skips have
no attempts and zero duration. Jenkins splits `classname` at its last dot, so it shows
`tests/checkout.yaml` as package `tests/checkout`, class `yaml`.

| Final outcome | JUnit element |
|---|---|
| `pass` | No failure/error/skip element. |
| `fail` | `<failure type="fail" message="<step label>">` with the step detail. |
| `inconclusive` | `<failure type="inconclusive" message="<step label>">` with the step detail. |
| Step/run `error` | `<error type="error" message="<step label>">` with the step detail. |
| Load error or thrown `Attempt.error` | `<error type="error" message="<spec name>">` with the stored error. |
| `skipped` by bail/token budget | `<skipped message="bail|max-tokens"/>`. |
| Other `skipped` result | `<skipped message="skipped"/>`. |
| Earlier `fail`/`inconclusive` attempt, finally passing | `<flakyFailure>` with `message`, `type`, and `<stackTrace>` detail. |
| Earlier `error` attempt, finally passing | `<flakyError>` with the same attributes and detail. |
| Earlier `fail`/`inconclusive` attempt, finally non-passing | `<rerunFailure>` with the same attributes and detail. |
| Earlier `error` attempt, finally non-passing | `<rerunError>` with the same attributes and detail. |

Retry elements use the Maven Surefire format. Only final outcomes contribute to failure/error
counters, so a flaky pass remains passing. The relevant step supplies the label and detail; when
no step ran, the spec name and thrown error supply them.

Suite and testcase `<properties>` include `jevCalls`, `tokens`, `provider`, `model`, and `attempts`.
Testcase usage and duration include every retry. Suite usage comes from the run totals.
`<system-out>` contains the step lines with the text reporter's icons, labels, and details.
Multiple attempts have one-based `attempt N:` headings. Every artifact from every attempt adds
an attachment line for Jenkins/GitLab:

```text
[[ATTACHMENT|/absolute/path/to/screenshot.png]]
```

Artifact capture is enabled with `--artifacts DIR`; choosing a reporter alone does not capture
anything. Upload the files separately if your CI does not retain the runner's filesystem.
XML entities are escaped and characters forbidden by XML 1.0 are removed.

## CI examples

GitHub Actions, in a job with plainwright and its browser installed and the model key configured:

```yaml
- name: Run specs
  run: npx plainwright --headless --reporter text --reporter junit:out/junit.xml tests/
- name: Publish JUnit results
  if: always()
  uses: mikepenz/action-junit-report@v5
  with:
    report_paths: out/junit.xml
```

Give the job `checks: write` permission if the action publishes a check. GitLab, after installing
plainwright and its host prerequisites and setting the model key as a CI variable:

```yaml
test:
  script:
    - npx plainwright --headless --reporter text --reporter junit:out/junit.xml tests/
  artifacts:
    when: always
    paths:
      - out/
    reports:
      junit: out/junit.xml
```

## JSON schema summary

The JSON file is the `RunReport` with `schemaVersion: 1` added at the top level:

| Field | Contents |
|---|---|
| `schemaVersion` | `1`. |
| `engine`, `provider`, `model` | Execution engine and model identity. |
| `startedAt`, `durationMs` | ISO start time and elapsed milliseconds. |
| `status` | `pass` or `fail`; flaky passes count as passing. |
| `totals` | `jevCalls`, `tokens`, `passed`, `failed`, `flaky`, `skipped`. |
| `stopped` | Optional `bail` or `max-tokens` reason. |
| `specs` | Ordered spec reports: `file`, `name`, `tags`, `status`, `flaky`, `attempts`, optional `loadError`/`skipReason`. |
| `specs[].attempts[]` | Zero-based `attempt`, `name`, `status`, `steps`, `jevCalls`, `totalTokens`, `durationMs`, `artifacts`, optional thrown `error`. |
| `steps[]` | `step` label, `status`, optional `detail` and per-phase `ms`. |
| `artifacts[]` | `kind` (`screenshot`, `trace`, `dump`), absolute `path`, optional zero-based `step` index. |

Step statuses remain `pass`, `fail`, `inconclusive`, `error`, or `skipped`. Spec load errors and
unexecuted skips have empty `attempts`; flaky is a separate boolean. JSON preserves details and
artifact metadata verbatim. The default JSONL format is unchanged and does not add schemaVersion,
suite totals, attempts, or artifact metadata.

Retries and stop rules come from [running suites](running.md), artifacts from [artifacts](artifacts.md).
