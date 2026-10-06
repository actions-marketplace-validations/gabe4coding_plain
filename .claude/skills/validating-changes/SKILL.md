---
name: validating-changes
description: Use before you open, update or mark ready any pull request in the plain repo, and before you report a code, doc, test or plugin change as done. Runs the full validation loop (key-free gate, live e2e and evals, agent evals, code/doc/test review) and records the pass a pre-PR hook checks.
---

# Validating a plain change

Mandatory before every pull request. A hook blocks `gh pr create` until `node scripts/validate.mjs` has passed
on exactly the files of HEAD. CI repeats the gates; it is the last line, not the first.

The hook sees only shell commands, so it catches only `gh pr create`. A pull request opened another way (the
GitHub web page, `gh api`, a GitHub MCP tool) is not blocked, but the rule still holds: validate first.

Unit tests prove little here. The evidence that counts: integration tests at a real boundary, the live e2e
suite, the evals and real agent runs. A green result that you did not see run is not evidence.

## 1. Scope

List what changed: `git diff --name-only origin/main...HEAD` and `git status`. Note which areas it touches
(browser steps, picks, judgments, MCP tools, skills, desktop, mobile, suite, docs, plugins).

## 2. Make the evidence exist

Before you run anything, check the change carries its own proof. Choose the strongest that fits:

| Change | Required evidence |
|---|---|
| New or changed browser behavior a user sees | A spec in `e2e/` (page in `e2e/site.mjs`); a negative case tagged `expect-fail` when a false pass is possible |
| Jev-facing input (candidates, snapshot, prompts, thresholds) | A case in the matching eval data (`scripts/*-cases.json`, saved states) |
| MCP tool, result shape or browser skill | An `eval-agent.mjs` task when no task covers it |
| Suite, reporters, config, CLI flags | An integration test that runs the CLI or `runSuite` on real files |
| Desktop or mobile engine | A test with the injected adapter, and the native smoke when you can run it |
| Pure logic with edge cases | A unit test is fine here, and only here |

Prefer real Chromium on `data:` URLs or the local site, the MCP server over stdio, and the Appium HTTP fixture
over mocks. Do not add a test that only restates the implementation.

## 3. Run the loop

```bash
node scripts/validate.mjs
```

It runs `npm run verify`, the live e2e (`scripts/e2e.mjs`), the claims gate and, when the MCP surface or the
browser skill changed, the agent evals (`scripts/eval-agent.mjs`, Claude and Codex). It stops at the first
failure and writes the stamp only when all pass.

- On a failure, find the cause and fix it. Never weaken a gate to get green: no lower threshold, no changed
  expected status, no `optional: true`, no skipped test, no looser eval check.
- A live check that passes only on a retry is a finding. Name it in the report. Do not hide it.
- A missing Jev key or agent CLI is a blocker to report, not a pass. Ask the user.

## 4. Area evals

`validate.mjs` ends with the area evals the changed files call for. For each one:

1. Run it on main first: `git worktree add /tmp/pw-main origin/main`, `npm ci && npm run build` there, run the
   eval with `--out /tmp/base.json`.
2. Run it on the branch with `--compare /tmp/base.json`.
3. Judge the delta. False passes and wrong cache hits must stay 0. Any metric that gets worse needs a reason in
   the report, or a fix.

## 5. Review the diff

Review your own diff against main as a reviewer would. In Claude Code, run the `code-review` skill on the diff.
In Codex, run `codex exec review --base origin/main`. Then check each point yourself:

- **Correctness**: edge cases, error paths, a step that could pass when it should fail.
- **Organization** (the refactor standard): one job per module, in the folder of its area; names say what
  things do; one statement per line; named constants, not magic numbers; reuse the shared helpers
  (`errorMessage`, `isFailure`, `decideAll`, `DUMP_DIR`, the enum lists) and search before you add one.
- **Comments**: only non-obvious reasons. No history ("before", "now", "new"), no restated code.
- **No dead code**: no unused export, file or branch (strict `tsc` catches unused locals only).
- **Fit**: matches the idiom and comment density of the code around it.
- **Generated files**: the plugin files `npm run build` writes (MCP configs, npx shim, versions, mod)
  committed with the source. `dist/` is never committed.

## 6. Docs and agent-facing text

- A change to step kinds, keys, flags, config, defaults, thresholds, statuses, exit codes, MCP tools or env
  loading lands in its owner doc (table in the `writing-docs` skill, "Doc owners") in the same change. Follow the
  `writing-docs` skill for any user doc you touch.
- Tool names and thresholds also go in the plugin skills under `plugins/*/skills/`.
- Module comments describe the new behavior when a module changes. `CODING_STANDARDS.md` (source layout,
  cross-module rules) and the engine notes (`src/{native,computer,mobile}/CLAUDE.md`) change when the layout or a
  cross-module rule changes; `CLAUDE.md` changes when a command or a route in its table changes.
- `check:docs` and `check:examples` already ran in `verify`. They do not check facts: read the code for those.

## 7. Report

After a change from steps 5 or 6, run `node scripts/validate.mjs` again: the stamp covers files, not intentions.
Then report to the user, and put the same summary in the pull request description:

- Each check that ran, with its result (e2e specs, claims numbers, agent runs passed).
- Area eval deltas against main.
- What did not run, and why (no device, no key, not on macOS).
- Findings: flaky checks, gaps you saw but did not fix.
