---
name: validating-changes
description: Use before you open, update or mark ready any pull request in the plain repo, and before you report a code, doc, test or plugin change as done. Runs the full validation loop (key-free gate, live e2e and evals, agent evals, code/doc/test review) and records the pass a pre-PR hook checks.
---

# Validating a plain change

Mandatory before every pull request. A hook blocks `gh pr create` until `node scripts/validate.mjs` has passed
on exactly the files of HEAD. CI repeats the gates; it is the last line, not the first.

The hook sees only shell commands, so it catches only `gh pr create`. A pull request opened another way (the
GitHub web page, `gh api`, a GitHub MCP tool) is not blocked, but the rule still holds: validate first.

A green result that you did not see run is not evidence.

## 1. Scope

List what changed: `git diff --name-only origin/main...HEAD` and `git status`. Note which areas it touches
(browser steps, picks, judgments, MCP tools, skills, desktop, mobile, suite, docs, plugins).

## 2. Make the evidence exist

Before you run anything, check that the change carries the evidence `CODING_STANDARDS.md`, "Tests" requires.

## 3. Run the loop

```bash
node scripts/validate.mjs
```

It runs `npm run verify`, the live e2e (`scripts/e2e.mjs`), the claims gate and, when the MCP surface or the
browser skill changed, the agent evals (`scripts/eval-agent.mjs`, Claude and Codex). It stops at the first
failure and writes the stamp only when all pass.

- On a failure, find the cause and fix it. Never weaken a gate to get green (`CODING_STANDARDS.md`, "Tests").
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
In Codex, run `codex exec review --base origin/main`. Then check the diff yourself against `CODING_STANDARDS.md`,
and for correctness: edge cases, error paths, a step that could pass when it should fail.

## 6. Docs and agent-facing text

- Check the diff against `CODING_STANDARDS.md`, "Docs that follow the code". Follow the `writing-docs` skill for
  any user doc you touch.
- `check:docs` and `check:examples` already ran in `verify`. They do not check facts: read the code for those.

## 7. Report

After a change from steps 5 or 6, run `node scripts/validate.mjs` again: the stamp covers files, not intentions.
Then report to the user, and put the same summary in the pull request description:

- Each check that ran, with its result (e2e specs, claims numbers, agent runs passed).
- Area eval deltas against main.
- What did not run, and why (no device, no key, not on macOS).
- Findings: flaky checks, gaps you saw but did not fix.
