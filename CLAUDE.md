## Validation (mandatory)

Before any pull request, and before you report a change as done, follow the `validating-changes` skill
(`.claude/skills/validating-changes/SKILL.md`; Codex reads the same file through `.agents/skills/`). Its core is
`node scripts/validate.mjs`; a `PreToolUse` hook (`.claude/settings.json`, `.codex/hooks.json`,
`scripts/pr-gate.mjs`) blocks `gh pr create` until that passed on exactly the files of HEAD.

- Evidence that counts: integration tests at a real boundary, the live e2e suite, evals and real agent runs.
  Unit tests only for pure logic with edge cases.
- Never weaken a gate to get green (thresholds, expected statuses, `optional`, skipped tests, eval checks).
- CI is the last gate, not the first: `Test` runs `npm run verify`; `Live` runs the e2e and the claims gate with
  the `TYPESAFE_API_KEY` secret on pull requests that touch the runtime. Agent evals run only locally.

## Commands

Build (TypeScript, ESM, `src/` → `dist/`, `tsc` per `tsconfig.json`; strict, plus no unused locals/parameters,
explicit `override`, no implicit returns):

```
npm run build
```

Test (`node:test`; specs live next to their module as `src/**/*.test.ts`, compiled to `dist/**/*.test.js`; tests of
`scripts/` are `scripts/*.test.mjs`, run as they are):

```
npm test                                                    # build + node --test 'dist/**/*.test.js' 'scripts/*.test.mjs'
npm run check:docs                                          # MDX, STE rules, links and anchors of the user docs
npm run check:examples                                      # validate examples/, e2e/ and the doc YAML, per engine
npm run test:plugins                                        # install each plugin archive in isolation, list MCP tools
npm run verify                                              # all of the above: the key-free gate CI runs
node --test dist/browser/runner.test.js                     # one file, after a build
node --test --test-name-pattern "<name>" dist/jev/pick.test.js   # one test case
```

No test in the regular suite needs a Jev API key: the `jev/` and `core/spec` tests exercise pure functions with
injected env objects, and `browser/runner.test.ts` drives real headless Chromium against `data:text/html` URLs.

Live checks (Jev key, build first). No remote site: `e2e/site.mjs` serves the pages on `127.0.0.1` from the runner
process, and the `e2e/*.yaml` specs reach it through `${env.site}`. A spec tagged `expect-fail` must end `fail`.

```
node scripts/e2e.mjs [--only forms] [--skip-mcp]            # e2e specs + MCP open/batch/ask/read/save/replay
node scripts/benchmark-claims.mjs --gate                    # exit 1 on a false pass or a Jev error
npm run verify:live                                         # build + both of the above
node scripts/eval-agent.mjs [--agent claude,codex] [--only login]   # graded claude -p / codex exec runs; local only
node scripts/validate.mjs                                   # the whole loop + the pre-PR stamp
```

Run a spec, or start the MCP server (`src/cli.ts` dispatches on the first positional):

```
node dist/cli.js [--headless] [--timeout 15000] examples/login.yaml [more.yaml ...]
node dist/cli.js --headless mcp
node dist/cli.js validate tests/                         # schemas/includes/placeholders, no key or session
node dist/cli.js --list --tag smoke tests/                # list selected specs; spec env still required
```

- Flags, config file and precedence: `docs/running.mdx`. Real browser (`--profile`, `--channel`, `--cdp`):
  `docs/agent-mode.mdx`.
- API key and env files: `docs/getting-started.mdx`. Spec runs check for a key just before execution;
  `validate` and `--list` need none; MCP mode keeps serving and the first Jev call returns the message as a tool
  error.
- Benchmarks and area evals: `docs/development.mdx`, "Performance checks"; method and results in
  `docs/benchmarks/`. Compare a change against a saved run of main.

`dist/` is committed on purpose — this repo is also a Claude Code plugin and ships its built output
(`bin/plainwright.mjs` runs `dist/cli.js` directly; on first run it also lazy-installs npm deps and Chromium).
`dist/**/*.test.js` is gitignored. Rebuild before committing a `src/` change so `dist/` matches it.

## Architecture

Playwright performs actions; Jev (TypeSafe's model, via `@typesafe-ai/sdk` or the Vercel AI SDK gateway) is the
only decision maker. It picks the element a natural-language target describes (Choice) and judges whether a
natural-language claim holds (Noul) against the page's accessibility tree. Specs have no CSS selectors except a
`css=` escape hatch. The model is pinned (`MODEL_BY_PROVIDER` in `src/jev/provider.ts`): thresholds and phrasing
advice were tuned against it.

Source layout (tests sit next to their module; details live in each module's comments):

- `src/cli.ts` — the browser CLI entry (`plainwright`); `src/computer/cli.ts` and `src/mobile/cli.ts` are the other two.
- `src/core/` — engine-independent: spec schemas and loading (`spec.ts`, `include.ts`, `interpolate.ts`,
  `step-kind.ts`, `unknown-key.ts`), the shared targeting/judging boundary (`automation.ts`), results, labels and
  debug dumps (`results.ts`), hooks (`hooks.ts`, `hooks-child.ts`), the pick cache (`pick-cache.ts`), `read`,
  snapshot views and `changed` diffs (`aria-changes.ts`).
- `src/jev/` — the model: `provider.ts` (keys, env files, pinned models), `ask.ts` (the one request path, retries,
  `warmUp`), `pick.ts`, `judge.ts`, `decide.ts` (thresholds), `describe.ts` (smart snapshot classification).
- `src/browser/` — Playwright: `session.ts` (launch, listeners, popups, downloads), `runner.ts` (`runSpec`),
  `steps.ts` (step handlers), `activity.ts` (settling, request tracking), `settled-ask.ts`, `locate.ts` (targets),
  `judge-page.ts` (claims), `candidates.ts`, `frames.ts`, `layer.ts`, `page.ts` (snapshots, DOM clock),
  `context-options.ts`, `notes.ts` (console noise), `mcp.ts` (the browser MCP server).
- `src/native/` — the shared desktop/mobile core; `src/computer/` and `src/mobile/` — each platform on top of it.
  Each of these three folders has its own `CLAUDE.md` (also `AGENTS.md`): read it before you change that engine.
- `src/suite/` — what all three CLIs share for spec suites: `run-suite.ts`, `types.ts`, `options.ts`, `config.ts`,
  `schedule.ts`, `select.ts`, `validate.ts`, `last-run.ts`, `artifacts.ts`, `spec-timeout.ts`, `reporters/`.

Rules that cross modules:

- When `describe()`/`candidates()` or a native candidate description changes, bump `DESC_FORMAT` in
  `src/core/pick-cache.ts`, so stored picks are ignored.
- MCP servers use stdout as the JSON-RPC channel: all logging goes to `console.error`.
- Plugins live at `plugins/plainwright/` (browser), `plugins/plainwright-computer/` (desktop) and
  `plugins/plainwright-mobile/` (mobile). Keep identity/version/description aligned across each plugin's manifests
  (layout in `docs/development.mdx`, "Plugin packaging"). Browser skill: `plugins/plainwright/skills/using-plainwright/`.
- One root `package.json` and lockfile own all dependencies and all CLI binaries. Never add per-plugin package
  manifests, symlinks or parent-directory runtime imports. Never edit generated files (`dist/`,
  `plugins/*/runtime.tgz`, `plugins/*/bin/launch.mjs`).
- `mods/session-pane/` — a Claude Code mod that draws each plugin's MCP tool results; `hooks/session-pane/` holds
  `model.ts` (pure state), `view.ts` (pure tree) and `register.ts` (the only mods API user).
  `scripts/build-plugins.mjs` copies `hooks/` into each plugin; never edit `plugins/*/hooks/`. Not compiled by
  `tsc`, not in `runtime.tgz`, invisible to Codex. Tests: `npm run test:mods` (needs the `claude` CLI).

## Documentation

User docs are `README.md`, `docs/*.mdx` and `examples/mobile/README.md`, for humans first. Before you write or
change one, follow the `writing-docs` skill (`.claude/skills/writing-docs/SKILL.md`): format, ASD-STE100 language
and content rules. Contributor detail goes in `docs/development.mdx` or in this file, never in a user doc.

When to update: a change to step kinds, spec keys, CLI flags, config keys, defaults, thresholds, statuses, exit
codes, MCP tools or arguments, env loading, or plugin install steps lands in its owner doc in the same change (and
in the plugin skill, for thresholds and tool names). Remove a fact from the docs when the code drops it.

One owner per topic. Other docs link to the owner and do not repeat it:

| Topic | Owner |
|---|---|
| Landing page: pitch, quick start, one spec, docs table, usage rules (keep it near 100 lines) | `README.md` |
| Requirements, API key and env files, plugin install (Claude Code, Codex), run from a checkout, env var table | `docs/getting-started.mdx` |
| Browser spec format, top-level keys, all step kinds, includes, browser context, what Jev sees, placeholders | `docs/spec-reference.mdx` |
| Writing targets and claims, thresholds, fixing `inconclusive` | `docs/phrasing.mdx` |
| Hooks | `docs/hooks.mdx` |
| All CLI flags, config file and keys, precedence, selection, retries, bail, budgets, pick cache, `validate`, exit codes | `docs/running.mdx` |
| Report formats | `docs/reporting.mdx` |
| Screenshots, traces, debug dumps | `docs/artifacts.mdx` |
| GitHub Action (inputs table from `action.yml`), GitLab, Docker | `docs/ci.mdx` |
| Browser MCP tools, `save`, `changed`, `read`, real browser (profile, channel, CDP) | `docs/agent-mode.mdx` |
| Snapshot modes | `docs/snapshots.mdx` |
| Desktop engine: setup, spec and step differences, tools, plan/do | `docs/computer-use.mdx` |
| Mobile engine: Appium setup, spec and step differences, gestures, tools, discovery | `docs/mobile-use.mdx` |
| How to run the runnable mobile examples | `examples/mobile/README.md` |
| Benchmark summary and links to `docs/benchmarks/*.md` | `docs/performance.mdx` |
| Build, tests, native smoke tests, packaging, benchmark commands | `docs/development.mdx` |

## Constraints

- This repo is site-agnostic. Site-specific skills, environment facts, and regression specs belong in downstream
  plugins that depend on plainwright, not here.
- Specs never hold literal credentials: put them in the spec's `env` block as `$VAR` references, used in steps as
  `${env.*}`.
- `examples/*.yaml` run against public demo sites; `examples/fixtures/` and `examples/hooks/` back the
  `login-dataset.yaml` example. They are user demos, checked offline only (`check:examples`).
- `e2e/` is the live gate: every page it needs lives in `e2e/site.mjs`, never on a remote site, so a failure is
  plainwright's or Jev's. Phrase its targets and claims so one clear answer exists; when Jev misses on such a page,
  suspect the product (what Jev is shown) before the wording.
- Per `plugins/plainwright/skills/using-plainwright/SKILL.md`: test environments only, stop before the last irreversible step
  (payment, booking, sending), never bypass bot protection.
- Desktop and mobile: Appium and platform drivers are host prerequisites; never auto-install apps or reset app
  data. Browser-only steps must fail explicitly on desktop and mobile.
