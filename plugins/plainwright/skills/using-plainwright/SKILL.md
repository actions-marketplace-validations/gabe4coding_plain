---
name: using-plainwright
description: Use when driving a website through the plainwright MCP tools (open, step, batch, find, snapshot, ask, evaluate, save) — for a browser task, for reading data off a page, or for writing, debugging or replaying a plainwright YAML end-to-end test — including when a step comes back inconclusive.
---

# Using plainwright

## Overview

JSON tool results are available in MCP `structuredContent`, with the existing serialized JSON
also kept in `content` text blocks for older clients. Prefer `structuredContent` when available.
MCP tool errors use `isError: true` and a text message; action outcomes (including
`status: "error"`) remain structured results.

Playwright acts, the Jev model decides: it picks the element your words describe and judges whether your
claim holds against the page's accessibility tree. You never see the page. You write words Jev can answer
with one clear yes. The lever is wording, not thresholds.

## Two modes, pick one first

**REQUIRED: before the first tool call, Read the file for your mode** (it sits next to this file):

- The user wants something **done or read** on a site (search, compare, extract, check a page):
  `browsing.md`. Nothing is saved in this mode.
- The user wants a **test**: a spec, a regression check, or a saved spec fails on replay:
  `authoring.md`.

The rules below apply to both.

## How outcomes are decided

- A pick is accepted when Jev's confidence is ≥ 0.5 and the answer is not `none`. Otherwise the step is
  `inconclusive` and `detail` lists the top guesses with their probabilities.
- A claim passes at p ≥ 0.9, fails at p ≤ 0.1, and is `inconclusive` in between. `optional: true` turns an
  inconclusive or error step into `skipped`.
- `ask {claims, within?}` judges 1–16 claims in one Jev call without acting or recording: each is `yes`
  (p ≥ 0.9), `no` (p ≤ 0.1) or `unsure`. When a step fails or is inconclusive, ask one claim per possible
  cause ("An error message is shown", "The Submit button is disabled", "A cookie banner covers the form")
  before reading a snapshot. It cannot explain in free text. Use `expect` only for assertions that belong
  in the test: `ask` never changes the session status and `save` never records it.
- Rejected picks and non-passing claims dump the exact state Jev saw to `$TMPDIR/plainwright/*.json`; the path
  is in `detail`.

## Writing a target (click, fill, hover, select, check, scroll)

One element, one true answer, named the way the accessibility tree names it: role, visible text, and what
sets it apart from its siblings.

- `the Login button`, `the username textbox`, `the edit link in the 5th table row`
- `the cuisine search input (not the location field)`
- `the Edit button for Account 32`: browser candidates retain bounded surrounding row/card context,
  including headings and visible text. Duplicate-button ordinals still work. Context is rebuilt per
  action, but can be omitted or truncated in deeply nested or unlabeled layouts.
- `the earliest available day`, never `an available day`: several valid answers split the probability
- `check` and `uncheck` mean "make it selected, or not". They work on checkboxes, radios, switches, and filter
  chips or toggle buttons that expose their state, and do nothing when the state is already right. A chip with
  no state to read is a `click`.
- `scroll: bottom` and `scroll: top` scroll the page and report the distance in `detail`. `did not move` means
  the content scrolls inside an element: `scroll: the results list` instead.
- A dialog that opened by itself (a calendar after picking a place, a menu after a hover) is already there:
  do not click its trigger again, that closes it.

## Writing a claim (expect, wait)

A claim is one fact about something that is visible when the condition holds.

- Presence, not absence: `the message "It's gone!" is shown`, not `the checkbox is no longer visible`.
  Absence is hard to prove from a snapshot.
- Prove state by acting: to check an input is enabled, `fill` it, then assert the typed value is shown. Type a
  value that shares no words with the page: `hello` passed at 0.98 where `enabled-check` stalled at 0.8.
- One fact per string. Several facts: `expect: [fact 1, fact 2]`, one snapshot and one Jev call.
- Name things as the tree does: `a heading with the text "Secure Area"`, not `a title`.
- Nondeterministic pages: claim what is stable (`a notification bar is shown at the top`), not the random text.
- `wait` when the thing appears after a delay or animation; `expect` for a settled page.

## Snapshot views

For a sequence of already-known actions, use `batch {steps:[...]}` with 1–16 ordinary step objects.
It validates the whole request before acting, resolves fresh targets for each action, and stops
on the first non-pass, including `skipped`. Read the indexed results and `stoppedAt` before recovery;
earlier actions are not rolled back. Only passing actions are saved, as individual YAML steps.
When a later action depends on reading new information, end the batch and inspect first.

Known actions need no preliminary snapshot; `step` finds its own targets. For discovery,
`snapshot {mode:"compact"}` returns exact excerpts without a classification call;
`snapshot {mode:"smart",intent:"the task"}` adds Jev screen/error/loading/dialog classifications
and filters to relevant UI regions at p >= 0.5, plus recognized alerts/dialogs and necessary
context. It does not fill spare space with unrelated content. `inferred.selection` reports
`focused`, `no-confident-match`, or an unfiltered `fallback` if classification fails. Check
`coverage.filteredLines` and `unassessedRegions` (up to 64 regions are assessed).
Without intent, smart returns a compact overview. Raw remains the default. `maxChars` defaults to 20,000
for raw and 6,000 for compact/smart (maximum 60,000). `intent` is smart-only, literal text.
Compact/smart return `observed.aria`, omission counts in `coverage`, timings and `jevTokens`.
Smart `inferred` is advisory: screen confidence must reach 0.9 (probability fallback), signals
are present at p >= 0.9, absent at p <= 0.1, otherwise inconclusive; truncated captures cannot
establish absence. Failed classification returns compact evidence with unavailable inference.
Omitted content is not absent. Expand using `within` or raw mode when reading exact data;
do not infer total row counts from excerpts. Classification adds a model call and may cost more
on small trees; action targeting and assertion thresholds are unchanged.

## After a miss

Read `detail` first: the top guesses say what Jev thought you meant.

1. First miss: rephrase with the words of the top guess and name the sibling to exclude.
2. Second miss on the same fact: the fact is the problem, not the words. Assert a different visible effect,
   use a different test value, prove it by acting, or scope with `expect: {that, within}`.
3. Third miss: `snapshot` with `within` or a small `maxChars` to see the tree, then `css=` as the last resort,
   with a comment saying why.

A third rephrasing of the same fact is never the next move.

## Common mistakes

| Mistake | Fix |
|---|---|
| `expect: "the secure area is shown with a success message"` | Two facts: use the list form |
| `wait: "the checkbox is gone"` | Absence: `wait: the message "It's gone!" is shown` |
| `expect` to check a guess while debugging | `ask`: not recorded, does not fail the session |
| `snapshot` of the whole page to read a table | `snapshot` with `within`, or `evaluate` |
| `check: the Hotels chip` on a plain button | `click` it; `check` needs a state to read |
| Reading the tool's source to learn the thresholds | They are listed above |

## Safety

Test environments for tests; the user's own accounts only when they asked for it. Stop before the last
irreversible step: payment, booking, sending, posting, deleting. Credentials go in a spec's `env` block as `$VAR`
environment references and are used as `${env.*}` in steps, never as literals. Never bypass bot protection: if a
site blocks the browser, say so.
