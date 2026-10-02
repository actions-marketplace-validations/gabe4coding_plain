# Pick cache: design (approved decisions, 2026-10-02)

Goal: stop paying a Jev pick for a target whose page has not changed since the last passing run.
Cost first (a dense real-site pick is ~28k tokens); wall time improves as a side effect (~165 ms per
pick on the examples, far more on dense pages).

## Decisions (from the human)

1. Option (a): **replay after a strict match**. Jev decided once; code reuses that decision only when
   the fresh page has exactly one candidate that matches it. This is the accepted reading of
   "Jev is the only decision maker".
2. The cache is **committed** next to the specs: reviewable, identical on every CI machine.
3. **Cost first**: the design optimizes Jev tokens; it must not add Jev calls.
4. **Jev judges retries**: an attempt > 0 never reads the cache, and the hits used by a failed attempt
   are evicted.

## Evidence (P2 research)

- On unchanged saved pages Jev is already deterministic: 40/41 targets picked the same element with the
  same outcome across 3 runs, median score spread 0.01 (`benchmark-picks --runs 3 --goal on`, 123 picks,
  3.41M tokens, 117 right / 0 wrong / 6 inconclusive). The cache is about cost, not stability.
- A browser pick has no stable identity: the element is `[data-jev-id=N]`, an ordinal of that scan
  (`src/candidates.ts:256`). The only portable identity is the candidate `desc`.
- Mobile already revalidates path/chain + identity before every action (`src/mobile-adapter.ts:150`).
- All engines resolve targets through `resolveTargets()` (`src/automation.ts:38`): one hook point.

## Mechanism

A pick still scans the page (cheap: ~2–15 ms). Only the Jev call is skipped on a hit.

1. **Lookup** (attempt 0 only, cache mode `on` or `read`): find the entry for this step. A hit needs
   - the same key (below), the same page (`url` origin + path, query and hash ignored),
   - **exactly one** candidate whose normalized `desc` equals the stored one, in the same frame label.
   Normalized desc = the desc with `value="…"` removed (a fill changes it). Anything else is a miss.
2. **Hit**: act on that candidate, no Jev call. The step result gets `cached: true`, its detail ends with
   `(cached pick)`, and `ms.cached = 1`.
3. **Miss**: normal Jev pick. If accepted, a **pending** entry is recorded.
4. **What is never stored**: a rejected or `none` pick; a desc with a ` #n` ordinal (lists that change
   make it point at a different row); a desc with no `context:` part unless the entry also stores a hash
   of the whole candidate list and the lookup requires it to be identical.
5. **Commit**: pending entries of an attempt are written only if the attempt **passed**. Entries whose
   hit was used by a failed attempt are deleted. Writes happen once, at `runEnd`, merged from all
   workers (no concurrent file writes).
6. **Retries**: attempt > 0 bypasses lookup (Jev picks); if it passes, its picks replace the evicted
   entries. A spec that passes on a retry is `flaky`, as today.

## Key and file

- File: a sidecar per **source file**, next to it: `checkout.yaml` → `checkout.picks.json`;
  an included flow `flows/login.yaml` → `flows/login.picks.json`. A shared flow's entries are shared by
  every spec that includes it.
- Entry key: `<index in its source file>|<kind>|<interpolated target>|<goal or "">`. Data-driven specs
  get one entry per distinct interpolated target.
- Entry value: `{ "desc": "...", "frame": "<frame label or ''>", "page": "<origin+path>",
  "list"?: "<sha1 of all descs, only for no-context entries>" }`.
- File header: `{ "version": 1, "model": "<pinned model id>", "desc": <desc format version>,
  "entries": { ... } }`. A different model pin or desc-format version ignores the whole file (all misses)
  and the next passing run rewrites it. Bump the desc-format constant whenever `describe()` or
  `candidates()` output changes.
- Deterministic output: keys sorted, 2-space JSON, trailing newline, no timestamps, so diffs are small
  and reviewable. A file that would end up empty is deleted.
- The loader keeps each step's source (`file`, `index`) on the parsed step (like `origin`, attached after
  `parseStep`, never accepted from YAML or MCP).

## Modes

`--picks on|read|off` (config `picks`, env none): `on` (default) reads and writes; `read` never writes
(CI that should not dirty the tree); `off` neither. MCP sessions: `off` in v1.

## Visibility

- Step result `cached?: boolean`; detail suffix `(cached pick)`; `ms.cached`.
- `RunReport.totals.cachedPicks` and the text summary / JUnit properties show it.
- A failure after a hit dumps the entry (`cache: <file>.json` in the detail) so the artifacts observer
  copies it.

## Proof (pass bars)

- New `scripts/benchmark-pick-cache.mjs` on a **stale-page set**: pairs of saved states before/after a
  change (row added/removed, label renamed, element moved, a second identical button) built from
  `scripts/pick-states/`. Bar: **0 wrong actions** (a hit must never select a different element than a
  fresh Jev pick would accept); every unsafe change must be a miss.
- Warm rerun of `examples/*.yaml` (a cold run writes the cache, a second run reads it):
  `benchmark-steps.mjs --runs 3` with the cache warm vs `--picks off`: ≥80% of picks are hits, pick Jev
  tokens −≥80%, same step statuses (`eval-browser-steps.mjs`).
- Regular `npm test` stays key-free: unit tests use injected intelligence.
