You are lane B (failure artifacts) of the "industrialize plainwright" plan, in the repository at the
root of your working directory. Read `CLAUDE.md`, then `.claude/plans/industrialize/contract.md`
(all of it; §3 observers and §7 rules matter most). Phase 0 is already merged: `RunObserver`,
`CaptureTarget` and the `artifactsObserver()` stub exist, and `runSpec` / `runNativeSpec` already call
the observer.

Branch: create and work on `industrialize/b-artifacts`, starting from `main`.

## Files you own (edit only these, plus new files you create)

`src/artifacts.ts`, `docs/artifacts.md` (new), new tests `src/artifacts*.test.ts`.

## Your task

Remove the "not implemented yet" guard for `--artifacts`, `--screenshot` and `--trace` that Phase 0 put in `src/artifacts.ts`.

Implement `artifactsObserver(opts)`: `null` when `opts.artifacts` is undefined, else an observer that
writes evidence for each attempt. Capture is off until `artifacts.dir` is set (`--artifacts <dir>`
or the config). Phase 0 (`options.ts`, contract §9) already validates the modes, passes them in
`opts.artifacts` only when a dir is set, and warns when they come without one — do not repeat that.
On desktop/mobile, `sessionOpen` fires only after the adapter is attached (§9), so a screenshot is
safe in every observer call you get.

1. Layout: `<dir>/<slug of the spec file path relative to cwd>/attempt-<n>/`. Slug: path separators
   and anything outside `[A-Za-z0-9._-]` become `-`. Two specs never share a folder, even with
   `--workers 4`.
2. Run start: if `<dir>` exists and contains the marker file `.plainwright-results` (which you
   create), empty it; if it exists WITHOUT the marker and is not empty, do not delete anything:
   fail the observer with a clear message (`<dir> exists and was not created by plainwright`).
   Never delete a folder you did not create.
3. Screenshots (`--screenshot`): `on-failure` → at `stepEnd` when the status is `fail`, `error` or
   `inconclusive` (not `skipped`), file `step-<index>-<status>.png`; `always` → also a final
   `final.png` at `sessionClose`. Use `CaptureTarget.screenshot`. Works for browser, desktop and
   mobile. A screenshot failure (page already closed, device gone) is reported once and ignored.
4. Traces (`--trace`, browser only): at `sessionOpen`, `page().context().tracing.start({ screenshots:
   true, snapshots: true, sources: false })`; at `sessionClose`, `tracing.stop({ path })` to
   `trace.zip` when the mode is `always`, or `on-failure` and the attempt did not pass; else
   `tracing.stop()` with no path. Not with `--cdp` (it would record the user's own tabs): skip it
   and add one note to stderr per run. On desktop/mobile, `--trace` other than `off` is an error
   raised when the observer is created.
5. Jev dumps: steps write debug JSON to `$TMPDIR/plainwright/` and put the path in the step
   `detail` (e.g. `— state: /tmp/.../plainwright/...json`). At `sessionClose`, find every such path
   in the attempt's step details and COPY it into the attempt folder (do not move: the detail text
   still points at the original). No change to `src/results.ts`.
6. Return every written file as an `Artifact` from `sessionClose` (`screenshot`, `trace`, `dump`,
   with `step` index when known). Delete the attempt folder if it ends up empty.
7. `docs/artifacts.md`: flags, layout, how to open a trace (`npx playwright show-trace
   <trace.zip>`), CI upload example (`actions/upload-artifact` on failure).

## Tests

Your guards are asserted only in `src/guards-b.test.ts`. Delete it (or rewrite it as real tests of
the new behavior) when you remove the guards. Do not edit any other existing test file.

New files. Use a fake `CaptureTarget` for screenshot logic and folder rules (marker, refusal to
delete a foreign folder, slugs, empty-folder removal, dump copying from details). One test with real
headless Chromium against a `data:text/html` URL (as in `src/runner.test.ts`) proving a trace.zip is
written for a failing attempt and not for a passing one with `on-failure`. No key, no network.

## Rules

- Edit only the files you own. If you need a change in a frozen file, do not make it: describe it in
  your report.
- `npm test` must pass. Do NOT commit `dist/` or `plugins/*/runtime.tgz`
  (`git checkout -- dist plugins` before committing).
- Commit on your branch. Do NOT push, open a PR or merge.

## Report back

Branch and SHA, `npm test` summary, the folder tree a sample failing run produces, and any change you
need in a frozen file.
