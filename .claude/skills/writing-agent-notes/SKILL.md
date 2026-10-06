---
name: writing-agent-notes
description: Use before you add, change or remove a rule or fact in an agent note of the plain repo (CLAUDE.md, CODING_STANDARDS.md, an engine note src/*/CLAUDE.md, a skill in .claude/skills/), and when a change taught you something an agent would get wrong again. Says what is worth writing down, which file owns it, the size limits and the checks.
---

# Writing plain agent notes

Agent notes are the files agents load to work in this repo: `CLAUDE.md` (every session; `AGENTS.md` is a symlink
to it for Codex), `CODING_STANDARDS.md` (before a code change), the engine notes
`src/{native,computer,mobile}/CLAUDE.md` (work in that folder) and the skills in `.claude/skills/` (by their
`description`; Codex reads them through `.agents/skills/`). User docs are not agent notes: follow the
`writing-docs` skill for those.

## 1. Is it worth writing down?

Write a learning only when all three hold:

- An agent would get it wrong again without it.
- No test, check or type can catch it. If one can, write that instead: a check holds on every run, a sentence only
  when someone reads it.
- The code does not show it at once (`ls`, a file name, `package.json`, the module's header comment).

Otherwise write nothing. Every session that loads a note pays for each line of it.

A learning in your own agent memory that is about this repo belongs in its owner here: Codex, cloud sessions and
other contributors do not see your memory.

## 2. Which file owns it

One owner per rule: the place that loads earliest for every task that needs it, and nowhere else.

| The rule applies to | Owner |
|---|---|
| Every task, also a question or a docs-only change | `CLAUDE.md` |
| Code changes in more than one folder | `CODING_STANDARDS.md` |
| Work in one folder | That folder's `CLAUDE.md`; create it if missing, with an `AGENTS.md` symlink to it |
| One module | The module's header comment |
| The procedure that proves a change: what to run, in which order, how to report | The `validating-changes` skill |
| What a user or contributor reads | Its owner doc (the `writing-docs` skill, "Doc owners") |
| One kind of task with its own trigger and more than a few lines | A new skill in `.claude/skills/<name>/`, an `.agents/skills/<name>` symlink, a route in `CLAUDE.md` |

When you move a rule, delete the old copy. When the code drops a fact, delete its note.

## 3. Format

- Terse and imperative. Technical names in backticks. Wrap at about 118 characters, except tables and commands.
- No history words ("now", "new", "moved", "previously"): a note says what is true, git says when it changed.
- A pointer to another file says when to read it: "Before you X, read Y".
- Cite so that `check:agent-notes` can verify it: a path in backticks, from the repo root, the note's folder or a
  folder named earlier in the same list item or table row; a section as `` `file`, "Heading" `` with the exact
  heading text; a symbol as `` `Name` in `path` ``.

## 4. Size limits

`npm run check:agent-notes` fails when a note is over its limit: `CLAUDE.md` 40 lines, `CODING_STANDARDS.md` 120,
each engine note 60, each skill 150 (constants in `scripts/check-agent-notes.mjs`). When a note is over its limit,
split by when each rule applies, not by topic:

1. Remove no-ops: a rule a tool enforces, a fact another file states where the agent reads it, a fact the code
   shows.
2. Move each rule to the narrowest owner in the table above: a one-folder rule to that folder's `CLAUDE.md`, a
   one-module rule to the module's comment.
3. Raise a limit only when every line left applies to every task that loads the note. Say why in the pull request.

## 5. Check the change

- `npm run check:agent-notes` (also part of `npm run verify`): the size limits, and every cited path, section and
  symbol exists. It does not check that a rule is true or still needed: read the code for that.
- When a route or a rule an agent must find changes, add or change a case in `scripts/routing-cases.json`
  (`CODING_STANDARDS.md`, "Tests"). `node scripts/eval-routing.mjs` asks fresh Claude and Codex agents each
  question and grades the answers; `scripts/validate.mjs` runs it when an agent note changes.
