# Failure artifacts

Capture is opt-in. Set an output directory to collect screenshots, browser traces, and Jev debug
state for each spec attempt:

```sh
plainwright --headless --artifacts plainwright-results tests/
```

| Flag | Modes | Default with `--artifacts` |
| --- | --- | --- |
| `--artifacts DIR` | Output directory | Capture is off until a directory is set |
| `--screenshot MODE` | `off`, `on-failure`, `always` | `on-failure` |
| `--trace MODE` | `off`, `on-failure`, `always` | Browser: `on-failure`; desktop/mobile: `off` |

`--screenshot` and `--trace` alone print one warning and do not enable capture. The config file can
also set `artifacts.dir`, `artifacts.screenshot` and `artifacts.trace`
([configuration](running.md#configuration)); explicit flags override config values.

Screenshots work on browser, desktop, and mobile. `on-failure` captures each step whose status is
`fail`, `error`, or `inconclusive`; `skipped` steps do not trigger it. `always` does the same and
adds `final.png` after teardown while the session is still open. `off` disables screenshots.

Traces are browser-only. `on-failure` records the session and retains the trace when the attempt
does not pass; passing traces are discarded. `always` retains traces even for passing attempts.
Tracing is skipped with one note per run when using `--cdp`, because it would record the user's
other tabs in the attached context. Screenshots and dumps remain available. For desktop or
mobile the trace default is `off`; asking for any other trace mode is a configuration error:

```sh
plainwright-computer --artifacts plainwright-results tests/desktop.yaml
plainwright-mobile --artifacts plainwright-results tests/mobile.yaml
```

Jev debug JSON referenced by a step's `detail` is copied from the temporary `plainwright/`
directory even when screenshot and trace modes are both `off`. The original stays in place, so
the detail's path remains valid. Capture failures are reported once per run and do not change
test results; other evidence is still collected.

## Output layout and cleanup

For `tests/login.yaml`, an attempt with a failing step can produce:

```text
plainwright-results/
  .plainwright-results
  tests-login.yaml/
    attempt-0/
      step-2-fail.png
      trace.zip
      step-2-<original-dump-name>.json
```

Spec paths are made relative to the working directory, then path separators and characters
outside `[A-Za-z0-9._-]` become `-`. Colliding slugs get a numeric suffix; long slugs are shortened.
Concurrent specs and retries use separate folders. Step and attempt numbers are zero-based.
Artifact entries contain absolute paths and a step index when tied to a step. Empty attempt
folders are removed.

At run start, a missing or empty output directory receives the `.plainwright-results` marker.
In a marked directory, the spec folders of the previous run (folders that hold only `attempt-N`
folders) are deleted; any other file or folder is left alone. A nonempty unmarked directory is
left untouched. The output directory may not be the working directory or one of its parents, the
home folder, the filesystem root, or a folder that contains a spec being run. Symlinked output
directories and symlinked markers are refused. In each of these cases capture is disabled for the
run with one warning and the specs still run, so a CI job gets no artifacts: use a dedicated
directory such as `plainwright-results`.

Two runs must not share one output directory at the same time (for example a browser and a
mobile job on one CI machine): the second run clears the first one's previous results. Give each
job its own directory.

## Inspect and upload

Open a browser trace locally:

```sh
npx playwright show-trace plainwright-results/tests-login.yaml/attempt-0/trace.zip
```

After the test step, upload evidence on CI failure:

```yaml
- name: Run tests
  run: npx plainwright --headless --artifacts plainwright-results tests/
- name: Upload failure evidence
  if: failure()
  uses: actions/upload-artifact@v4
  with:
    name: plainwright-results
    path: plainwright-results/
    if-no-files-found: ignore
```

The marker is a hidden file and does not need to be uploaded. Traces include action screenshots
and snapshots, with source capture disabled; separate videos are not produced.
