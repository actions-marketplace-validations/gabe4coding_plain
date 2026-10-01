You are lane A (reporting) of the "industrialize plainwright" plan, in the repository at the root of
your working directory. Read `CLAUDE.md`, then `.claude/plans/industrialize/contract.md` (all of it;
§2 result model, §3 observers and §7 rules matter most). Phase 0 is already merged: the shared
suite runner, the reporter registry and the stubs exist.

Branch: create and work on `industrialize/a-reporting`, starting from `main`.

## Files you own (edit only these, plus new files you create)

`src/reporters/**` (`index.ts`, `text.ts`, `jsonl.ts`, new `junit.ts`, new `json.ts`),
`docs/reporting.md` (new), new tests `src/reporters/*.test.ts`.

## Your task

Remove the `--reporter` "not implemented yet" guard Phase 0 put in `src/reporters/index.ts`. Read contract §9 first:
`createReporters` must return one observer per `ReporterSpec`, in order, and a thrown run is `Attempt.error`
(no steps) — the text reporter already prints it like a load error; keep that, and map it to `<error>` in JUnit.

1. `--reporter junit:<file>`: JUnit XML written at `runEnd`, no new dependency (escape XML by hand:
   `& < > " '` and strip characters that XML 1.0 forbids). Shape:
   - one `<testsuites>` with `name="plainwright <engine>"`, `tests`, `failures`, `errors`,
     `skipped`, `time` (seconds); one `<testsuite>` per spec file is NOT needed: use one
     `<testsuite name="plainwright">` holding one `<testcase>` per spec.
   - `<testcase classname="<file relative to cwd>" name="<spec name>" time="...">`.
   - final `fail` / `inconclusive` → `<failure message="<step label>" type="fail|inconclusive">`
     with the step `detail`; `error` or load error → `<error ...>`; `skipped` (bail / max-tokens)
     → `<skipped message="bail|max-tokens"/>`.
   - every earlier failed attempt of a spec that was retried → `<flakyFailure>` (pass in the end) or
     `<rerunFailure>` (still failing), the Maven Surefire rerun format that Jenkins and GitLab read.
   - `<system-out>`: the step list as the text reporter prints it, then one
     `[[ATTACHMENT|<absolute path>]]` line per artifact (the Jenkins/GitLab convention).
   - `<properties>`: `jevCalls`, `tokens`, `provider`, `model`, `attempts`.
   - the parent directory of the output file is created if missing.
2. `--reporter json:<file>`: the `RunReport` as JSON, plus `"schemaVersion": 1` at the top level.
3. `--reporter jsonl` (already exists): unchanged by default.
4. Text reporter (`text.ts`): output must stay byte-identical when there are no retries, no flaky
   specs and no skips (the Phase 0 golden tests must still pass unchanged). Add only:
   - a flaky spec prints `✔ <name>  (flaky, passed on attempt N; ...)`, and the failed attempts'
     failing step lines indented under it, prefixed `attempt K:`;
   - a skipped spec prints `» <file>  (skipped: bail|max-tokens)`;
   - a final summary line ONLY when more than one spec ran: `<p> passed, <f> failed, <k> flaky,
     <s> skipped  (<calls> Jev calls, <tokens> tokens, <seconds>s)`. Update the golden test for a
     multi-spec run only if Phase 0's golden tests have none; otherwise add new cases.
5. Several reporters may run at once (`--reporter text --reporter junit:out.xml`). A reporter that
   writes to stdout (`text`, `jsonl`) is at most one; two stdout reporters is an error (exit 2,
   raised from `createReporters`).
6. `docs/reporting.md`: flags, JUnit mapping table, example CI usage (GitHub Actions
   `mikepenz/action-junit-report` or GitLab `artifacts:reports:junit`), JSON schema summary.

## Tests

Your guards are asserted only in `src/guards-a.test.ts`. Delete it (or rewrite it as real tests of
the new behavior) when you remove the guards. Do not edit any other existing test file.

New files only, using fixed `RunReport` objects (no browser, no key, no network): XML escaping,
every status mapping, flaky and rerun failures, attachments, properties, two stdout reporters error,
text reporter flaky/skipped/summary lines. Validate the XML is well-formed (a small hand parser check
or parse with the `yaml`-free approach of your choice; no new dependency).

## Rules

- Edit only the files you own. If you need a change in a frozen file (`suite-types.ts`, `suite.ts`,
  `options.ts`, ...), do not make it: describe it in your report.
- `npm test` must pass. Do NOT commit `dist/` or `plugins/*/runtime.tgz`
  (`git checkout -- dist plugins` before committing).
- Commit on your branch. Do NOT push, open a PR or merge.

## Report back

Branch and SHA, `npm test` summary, a sample JUnit file (from a test fixture), and any change you
need in a frozen file.
