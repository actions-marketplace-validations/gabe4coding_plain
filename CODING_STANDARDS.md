# Coding standards

Read this before you change code: `src/`, `scripts/`, `bin/`, `plugins/`, `mods/`, `e2e/`, `examples/` or
`package.json`.

## Tests

- Evidence that counts: integration tests at a real boundary, the live e2e suite, evals and real agent runs.
  Unit tests only for pure logic with edge cases.
- Never weaken a gate to get green (thresholds, expected statuses, `optional`, skipped tests, eval checks).

## Docs that follow the code

- A change to step kinds, spec keys, CLI flags, config keys, defaults, thresholds, statuses, exit codes, MCP tools
  or arguments, env loading, or plugin install steps lands in its owner doc in the same change (and in the plugin
  skill, for thresholds and tool names). Owner of each topic: `.claude/skills/writing-docs/SKILL.md`, "Doc owners".
- Remove a fact from the docs when the code drops it.

## Runtime: lock files, MCP output, desktop and mobile

- When the recorded locator format (`src/browser/record-locator.ts`) or the claim state hash (`stateHash` in
  `src/browser/judge-page.ts`) changes, bump `LOCK_VERSION` in `src/core/lock.ts`, so old lock files are ignored.
- MCP servers use stdout as the JSON-RPC channel: all logging goes to `console.error`.
- Desktop and mobile: Appium and platform drivers are host prerequisites; never auto-install apps or reset app
  data. Browser-only steps must fail explicitly on desktop and mobile.

## Plugins and packaging

- One root `package.json` and lockfile own all dependencies and all CLI binaries. Never add per-plugin package
  manifests, symlinks or parent-directory runtime imports.
- The plugins hold no runtime code: their MCP configs run
  `node bin/npx.mjs -y --package=@gabe4coding/plain@<version>` (shim source: `scripts/plugin-npx.mjs`), so a
  plugin from a clone still runs the npm release. Plugin layout: `docs/development.mdx`, "Plugin packaging".
- Never edit the files `npm run build` generates in `plugins/*/`: the MCP configs, `bin/npx.mjs`, versions,
  `@gabe4coding/plain@<version>` in the skills, `LICENSE` and `hooks/`. Edit their sources instead.

## Session pane mod

- `mods/session-pane/` is a Claude Code mod that draws each plugin's MCP tool results.
  `mods/session-pane/hooks/session-pane/` holds `model.ts` (pure state), `view.ts` (pure tree) and `register.ts`
  (the only mods API user). `scripts/build-plugins.mjs` copies the mod's `hooks/` into each plugin.
- The mod is not compiled by `tsc` and is invisible to Codex. Tests: `npm run test:mods` (needs the `claude` CLI).

## Specs in `e2e/` and `examples/`

- `e2e/` is the live gate: every page it needs lives in `e2e/site.mjs`, never on a remote site, so a failure is
  plain's or Jev's. Phrase its targets and claims so one clear answer exists; when Jev misses on such a page,
  suspect the product (what Jev is shown) before the wording.
- `examples/*.yaml` run against public demo sites. They are user demos, checked offline only (`check:examples`).

## Source layout

Tests sit next to their module; details live in each module's comments.

- `src/cli.ts` — the browser CLI entry (`plain`); `src/computer/cli.ts` and `src/mobile/cli.ts` are the other two.
- `src/core/` — engine-independent: spec schemas and loading (`spec.ts`, `include.ts`, `interpolate.ts`,
  `step-kind.ts`, `unknown-key.ts`), the shared targeting/judging boundary (`automation.ts`), results, labels and
  debug dumps (`results.ts`), hooks (`hooks.ts`, `hooks-child.ts`), run modes and lock files (`lock.ts`), what every
  MCP `save` writes: secret placeholders, the spec and its lock (`save.ts`), `read`, snapshot views and `changed`
  diffs (`aria-changes.ts`), and the spatial evidence shared by all engines: prompt routes (`evidence.ts`, with
  `src/jev/evidence.ts`) and layout text (`layout.ts`).
- `src/jev/` — the model: `provider.ts` (keys, env files, pinned models), `ask.ts` (the one request path, retries,
  `warmUp`), `pick.ts`, `judge.ts`, `decide.ts` (thresholds), `describe.ts` (smart snapshot classification).
- `src/browser/` — Playwright: `session.ts` (launch, listeners, popups, downloads), `runner.ts` (`runSpec`),
  `steps.ts` (step handlers), `activity.ts` (settling, request tracking), `settled-ask.ts`, `locate.ts` (targets:
  replay, heal, record), `record-locator.ts` (the Playwright locator a passing pick records), `judge-page.ts`
  (claims), `candidates.ts`, `frames.ts`, `layer.ts`, `page.ts` (snapshots, DOM clock), `evidence.ts` (observation
  routing), `layout.ts` (read-only rendered bounds), `context-options.ts`, `notes.ts` (console noise), `mcp.ts`
  (the browser MCP server).
- `src/native/` — the shared desktop/mobile core; `src/computer/` and `src/mobile/` — each platform on top of it.
  Each of these three folders has its own `CLAUDE.md` (also `AGENTS.md`): read it before you change that engine.
- `src/suite/` — what all three CLIs share for spec suites: `run-suite.ts`, `types.ts`, `options.ts`, `config.ts`,
  `schedule.ts`, `select.ts`, `validate.ts`, `last-run.ts`, `artifacts.ts`, `spec-timeout.ts`, `reporters/`.
