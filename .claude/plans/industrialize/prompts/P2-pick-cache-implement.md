You are implementing the pick cache of the plainwright "industrialize" plan, in the repository at the
root of your working directory (TypeScript ESM; read `CLAUDE.md` first for build, test and architecture
rules).

Branch: create and work on `industrialize/pick-cache`, starting from `main`.

## Spec

Read `.claude/plans/industrialize/pick-cache.md` completely: decisions, mechanism, key and file format,
modes, visibility and pass bars. Implement it exactly. The four decisions at the top were made by the
human and are not open. If the design is wrong or impossible somewhere, make the smallest choice that
keeps the safety rules (strict match, never store ordinals/`none`, attempt > 0 bypasses, write only after
a passing attempt) and list it in your report.

## Where it goes

This is a single lane; you may edit any file you need, but keep changes small and local:

- New `src/pick-cache.ts`: file load/validate (version, model pin, desc-format version), key building,
  normalized desc, lookup (exactly one match), pending entries per attempt, commit/evict, deterministic
  write. Pure where possible; file I/O in one place.
- `src/automation.ts` `resolveTargets()`: the shared hook for browser, desktop and mobile. Take an
  optional cache handle in the `TargetAdapter` (or a parameter); on a hit return the matching candidate's
  element with `usedJev: false`, `tokens: 0`, `cached: true`. Do not change the Jev path otherwise.
- `src/spec.ts` and the native loaders: keep each step's source (`file`, `index`) on the parsed step after
  `parseStep`/`parseOne`, the way `withOrigin` attaches `origin` (use the source `splitSource()` already
  returns). Never accepted from YAML or MCP; not written by `save`.
- `src/steps.ts` (browser) and `NativeSession` (`src/native.ts`): pass the cache handle and the step's
  key parts (source, kind, interpolated target, goal, page) into `resolveTargets`; add `cached` and the
  `(cached pick)` detail suffix and `ms.cached`.
- `src/runner.ts` / `runNativeSpec`: know the attempt number (`SpecInfo.attempt`); attempt > 0 bypasses
  lookup. Report which hits an attempt used and its pending entries, so the suite can commit or evict.
- `src/suite.ts` / `src/suite-types.ts`: one cache store per run; commit pending entries of passing
  attempts, evict hits of failed attempts, write all touched sidecars once after the last spec (before
  `runEnd`). `RunReport.totals.cachedPicks`.
- `src/options.ts` / `src/config.ts`: `--picks on|read|off` (default `on`), config key `picks`.
- `src/reporters/`: show `cachedPicks` in the text summary line (when it already prints), JUnit
  properties and JSON (it is in the report already).
- MCP servers: cache `off`.

## Tests (key-free, `npm test`)

- `src/pick-cache.test.ts`: key building, desc normalization (`value=` dropped), exactly-one rule,
  ordinal and `none` never stored, no-context entries need the list hash, version/model mismatch ignores
  the file, deterministic output (sorted, no timestamps), empty file deleted.
- Suite-level with injected intelligence (count `pick` calls): cold run calls Jev and writes the sidecar;
  warm run makes **zero** pick calls and marks steps `cached`; a changed page (desc differs, or two
  matches) misses and calls Jev; a failed attempt evicts its hits and the retry calls Jev (attempt 1
  never reads); a failed attempt writes nothing; `read` never writes; `off` never reads; included flows
  write their own sidecar shared by two specs.
- Browser: one real headless Chromium test on `data:text/html` pages with injected intelligence: warm
  run acts on the same element without a pick call.

## Benchmarks (Jev is approved; keep cost bounded)

1. Write `scripts/benchmark-pick-cache.mjs`: a stale-page set built from `scripts/pick-states/` (pairs of
   before/after states: a row added/removed, a label renamed, an element moved, a second identical
   button, a value changed). For each pair: take the accepted pick on "before" as the cache entry, then
   check the lookup on "after" against a fresh Jev pick on "after". Report hits, misses and **wrong
   hits** (a hit on an element the fresh pick would not accept). Pass bar: 0 wrong hits.
2. Warm-cache step benchmark on the examples: run `node scripts/benchmark-steps.mjs --runs 1` once cold
   (writes sidecars into a scratch copy of `examples/` — never commit generated sidecars for the
   examples), then `--runs 3` warm, and compare against `--picks off`. Report hit rate, pick Jev tokens
   and step-time deltas, and that step statuses are unchanged. Pass bars: ≥80% hits, pick tokens −≥80%.
3. For every command: exact command, runs, Jev calls and tokens. Do not run `benchmark-agent.mjs`.

## Docs

Update `docs/running.md` (a "Pick cache" section: what it is, modes, the sidecar files and committing
them, when an entry is reused or dropped, how to reset: delete the sidecar), `docs/spec-reference.md`
(one pointer), `README.md` (the flag row), the three SKILL.md files (one line: commit `*.picks.json`
next to specs; `--picks read` in CI) and the `CLAUDE.md` architecture entry for `src/pick-cache.ts`.
Record the benchmark results in `docs/benchmarks/pick-cache.md`.

## Rules

- `npm test` must pass. Rebuild before committing a `src/` change so `dist/` and `plugins/*/runtime.tgz`
  match (this is a single lane, so commit them; CI checks it).
- Commit on your branch. Do NOT push, open a PR or merge.

## Report back

Branch and SHA, `npm test` summary, the benchmark tables with costs, every deviation from the design,
and anything the human should decide before merge.
