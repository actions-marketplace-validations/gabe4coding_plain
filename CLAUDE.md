## Commands

Build (TypeScript, ESM, `src/` → `dist/`, `tsc` per `tsconfig.json`):

```
npm run build
```

Test (`node:test`; specs live next to their module as `src/**/*.test.ts`, compiled to `dist/**/*.test.js`):

```
npm test                                                    # build + node --test 'dist/**/*.test.js'
node --test dist/browser/runner.test.js                     # one file, after a build
node --test --test-name-pattern "<name>" dist/jev/pick.test.js   # one test case
```

No test in the regular suite needs a Jev API key: the `jev/` and `core/spec` tests exercise pure functions with injected env
objects, and `browser/runner.test.ts` drives real headless Chromium against `data:text/html` URLs with `goto` steps only.

Run a spec, or start the MCP server (`src/cli.ts` dispatches on the first positional):

```
node dist/cli.js [--headless] [--timeout 15000] examples/login.yaml [more.yaml ...]
node dist/cli.js --headless mcp
node dist/cli.js validate tests/                         # schemas/includes/placeholders, no key or session
node dist/cli.js --list --tag smoke tests/                # list selected specs; spec env still required
node dist/cli.js --headless --retries 1 --reporter text --reporter junit:out/junit.xml --artifacts plainwright-results tests/
```

Performance tracking (live sites and a Jev key; build first). `benchmark-steps.mjs` reports per-phase step overhead
(step time minus page action time) over the examples; `benchmark-mcp.mjs` times an agent-style MCP session with think
time between calls. Compare a change against a saved run; results and method in `docs/benchmarks/step-overhead.md`:

```
node scripts/benchmark-steps.mjs --runs 3 --out /tmp/new.json --compare /tmp/base.json
node scripts/benchmark-mcp.mjs --cli dist/cli.js --gap 5000 --runs 2
node scripts/benchmark-planner.mjs --runs 3          # sentence → steps planner vs scripts/planner-cases.json
node scripts/benchmark-picks.mjs --runs 3            # picks with/without goal on saved pages (scripts/pick-states/)
node scripts/benchmark-agent.mjs --runs 3            # a real claude -p agent, changed on vs off (costs Claude usage); --read both: read on vs off
node scripts/benchmark-read.mjs --runs 2 --smart     # read vs smart snapshot on saved pages (scripts/read-states/, read-cases.json)
node scripts/eval-browser-steps.mjs --variant v1     # step-time eval: examples + MCP session, overhead and same step statuses (.claude/hillclimb/, gitignored)
node scripts/benchmark-claims.mjs --runs 3           # expect judging on saved pages (scripts/claim-cases.json); false passes must stay 0
node scripts/benchmark-pick-cache.mjs --skip turing-click   # pick cache on stale saved pages; wrong/unconfirmed hits must stay 0
node scripts/benchmark-steps.mjs --picks on --dir <scratch copy of examples>   # warm pick cache; never --dir examples
```

`--headless` hides the browser (visible by default); `--timeout` is per-action (ms); `--profile <dir>` launches a
persistent context; `--channel chrome` launches an installed browser instead of the bundled Chromium; `--cdp <url>` attaches
to a running Chrome (`openPage()` in `src/browser/session.ts` picks one of the three; env fallbacks `PLAINWRIGHT_PROFILE`/
`PLAINWRIGHT_CHANNEL`/`PLAINWRIGHT_CDP` in `src/suite/options.ts`). The browser plugin `.mcp.json` runs `${CLAUDE_PLUGIN_ROOT}/bin/launch.mjs --headless mcp`, which installs and dispatches to the shared runtime.

Suite flags are shared by all three CLIs; native engines require `--workers 1` and default to `jsonl`
rather than browser `text`. Config comes from cwd `plainwright.config.yaml`/`.yml` or `--config`;
CLI > existing `PLAINWRIGHT_*` env > config > defaults. MCP ignores suite config. See `docs/running.mdx`.

Environment: `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY` (`TYPESAFE_API_KEY` wins if both set), or force one with
`JEV_PROVIDER=typesafe|gateway` (`src/jev/provider.ts`, `selectProvider`). `src/cli.ts` loads `.env` from the cwd, then
`~/.config/plainwright/.env` (`USER_ENV_FILE` in `src/jev/provider.ts`), via Node's native `process.loadEnvFile()` (no `dotenv`);
variables already in the environment are never overridden. The user file exists because Codex passes plugin MCP
servers no shell environment. Spec runs check for a key just before execution; `validate` and `--list` need none.
MCP mode keeps serving and the first Jev call returns the message as a tool error.

`dist/` is committed on purpose — this repo is also a Claude Code plugin and ships its built output
(`bin/plainwright.mjs` runs `dist/cli.js` directly; on first run it also lazy-installs npm deps and Chromium).
`dist/**/*.test.js` is gitignored. Rebuild before committing a `src/` change so `dist/` matches it.

## Architecture

Playwright performs actions; Jev (TypeSafe's model, via `@typesafe-ai/sdk` or the Vercel AI SDK gateway) is the
only decision maker. It picks the element a natural-language target describes (Choice) and judges whether a
natural-language claim holds (Noul) against the page's accessibility tree. Specs have no CSS selectors except a
`css=` escape hatch.

Source layout (tests sit next to their module):

- `src/cli.ts` — the browser CLI entry (`plainwright`); `src/computer/cli.ts` and `src/mobile/cli.ts` are the other two.
- `src/core/` — engine-independent: spec schemas and loading (`spec.ts`, `include.ts`, `interpolate.ts`, `step-kind.ts`),
  the shared targeting/judging boundary (`automation.ts`), results and labels (`results.ts`), hooks (`hooks.ts`,
  `hooks-child.ts`), the pick cache, `read`, snapshot views, `changed` diffs and MCP result helpers.
- `src/jev/` — the model: `provider.ts` (keys, env files, pinned models), `ask.ts` (the one request path, retries,
  `isTooLong`, `warmUp`), `pick.ts`, `judge.ts`, `decide.ts` (thresholds), `describe.ts` (smart snapshot classification).
- `src/browser/` — Playwright: `session.ts` (launch, listeners, popups, downloads), `runner.ts` (`runSpec`), `steps.ts`
  (step handlers), `activity.ts` (settling, request tracking, `mayNavigate`), `settled-ask.ts`, `locate.ts` (targets),
  `judge-page.ts` (claims), `candidates.ts`, `page.ts` (snapshots, DOM clock), `notes.ts` (console noise), `mcp.ts`.
- `src/native/` — the shared desktop/mobile core (`session.ts`, `run-spec.ts`, `cli.ts`, `mcp.ts`).
- `src/computer/` and `src/mobile/` — each platform's `adapter.ts`, `spec.ts`, `session.ts`, `mcp.ts`, `cli.ts`
  (plus `computer/planner.ts`, `mobile/tree.ts`, `mobile/discovery.ts`).
- `src/suite/` — what all three CLIs share for spec suites: `run-suite.ts`, `types.ts`, `options.ts`, `config.ts`,
  `schedule.ts`, `select.ts`, `validate.ts`, `last-run.ts`, `artifacts.ts`, `spec-timeout.ts`, `reporters/`.

- `src/suite/run-suite.ts` — `runSuite`: load all specs, select (load errors always kept), list without a key or build
  observers → schedule attempts → totals/reporters → persist last run. All engines share it; output stays in
  input order. `src/suite/types.ts` owns attempts/spec/run reports, observers and engine adapters; `flaky` is
  a separate boolean and counts as pass.
- `src/suite/options.ts` — shared CLI flags, file/directory/`*`/`**` expansion and CLI/env/config/default precedence;
  `--list` and `validate` are key-free. Native concurrency and profile/CDP worker conflicts fail early.
- `src/suite/schedule.ts` — worker slots, retries, flaky passes, bail after final non-passes and completed-attempt
  token budget. In-flight attempts finish; cut retries retain their last status; never-started specs are skipped.
- `src/suite/select.ts` — name/cwd-relative-path regexes, all requested tags, last-failed intersection (no or invalid
  record: run all selected specs; no failures: run none) and list output.
- `src/suite/config.ts` — strict YAML config discovery/validation, paths relative to its file; MCP does not read it.
- `src/suite/validate.ts` — load/expand schemas and check interpolated fields without sessions/hooks; absent `$VAR`
  leaves warn, `${hooks.*}` waits for runtime, unknown namespaces or unresolved `${env.*}` fail validation.
- `src/suite/artifacts.ts` — optional observer for failure-step screenshots, final screenshots, browser traces and
  copied Jev dumps; dedicated marked directories, per-spec/attempt folders, no CDP trace or native trace.
- `src/suite/reporters/` — text/jsonl stdout and JUnit/JSON file observers; one stdout reporter, distinct file paths;
  JSON schema version 1, Surefire retry failure/error elements, all-attempt usage and artifact paths.
- `src/core/pick-cache.ts` — pick cache (`--picks on|read|off`, config `picks`; MCP never): a sidecar per source file
  (`x.yaml` → `x.picks.json`, committed), key JSON `[index in file, step kind, interpolated target (sha256 when the
  raw step had `${`), goal, page]`, value the accepted candidate's desc (`value=` dropped only on `editable`
  text-entry candidates, browser only), frame label, page (origin+path) and a sha1 of the whole normalized list.
  `resolveTargets` (`TargetAdapter.cached`) acts on a hit only when the list hash is equal and exactly one candidate
  matches; misses go to Jev as before. Never stored: ` #n` ordinals, rejected/`none` picks. Loaders put
  `at: {file, index, templated?}` on each parsed step (never from YAML/MCP; `interpolate` and `validate` skip it).
  One `PickStore` per suite run, model id `MODEL_BY_PROVIDER.typesafe` for both providers; a `PickAttempt` per
  attempt (`SpecInfo.picks`): attempt > 0 never reads, a step that does not pass stores nothing, a passing attempt
  commits, a failing one evicts the hits it used; sidecars written once after the last spec, deterministic, empty
  ones deleted. Another model or `DESC_FORMAT` ignores the file: bump `DESC_FORMAT` when `describe()`/`candidates()`
  or a native candidate desc changes. `scripts/benchmark-pick-cache.mjs` (stale pages: wrong and unconfirmed hits
  must stay 0); results in `docs/benchmarks/pick-cache.md`.
- `src/core/include.ts` — nested steps-only YAML flows expanded before validation; paths relative to each includer,
  cycle/source-index diagnostics, origin labels; included placeholders use root env/hooks, not flow-local data.
- `src/browser/context-options.ts` — device/context overrides, auth/geolocation and storage state; CDP rejects context
  settings, profiles cannot load storage state. `runSpec` saves state only after passing steps and teardown.
- `src/suite/last-run.ts` — atomic cwd `.plainwright/last-run.json`, absolute spec paths and final status/flaky;
  `readLastFailed` returns `undefined` (no or invalid record) or the set of non-pass files; list/validate never replace it.
- `src/core/spec.ts` — `loadSpec()` parses a YAML file into a `Spec` (`name`, `url`, `dialogs`, optional `auth`,
  `geolocation`, `env`, `hooks`, `tags`, `timeout`, `browser`, plus expanded `steps`). `$VAR` leaves in
  `auth`/`env` resolve from `process.env` at load time. `interpolate()` (`src/core/interpolate.ts`) replaces `${env.*}`/`${hooks.*}` in any string; any other namespace, or an unresolved
  leaf, is an error.
- `src/browser/candidates.ts` — candidate collection (`scanCandidatesInPage` runs inside the page, so its helpers are nested) (`candidates()`, selector + shadow-DOM walk per step kind, with
  cursor-pointer/tabindex extras for `click`/`hover`; for `check` also `aria-pressed` toggles and labels of
  sizeless checkboxes). Candidates are ordered in layers before the cap: dialog content, then the page, then
  nav/footer, so a cookie banner appended at the end of the body is never cut.
- `src/browser/page.ts` — accessibility snapshot (`snapshot()`/`snapshotRegion()`, 60k-char cap; an unchecked
  checkable control gets `[checked=false]`, `markUnchecked`) and DOM-quiet waiting
  (`settle()`, `mark()`, `unchangedSince()`). `page.ts` (snapshot sections) and `candidates.ts` (candidate prefixes)
  both label iframes with `frameLabel()` (`src/browser/frames.ts`).
- `src/jev/` — provider selection (`provider.ts`) and the `ask()` call to either backend (`ask.ts`); `pickElements()` (`pick.ts`) (one Choice per
  target; ≤254 candidates per request, more are split into equal chunks asked in parallel and merged by
  `mergePicks()`; a request over the token limit (`isTooLong`, 400 or 422 `max_tokens_exceeded`) is halved the same way, which splits the score when two chunks disagree; ceiling `MAX_CANDIDATES` = 1016); `judge()` (one Noul per claim, `judge.ts`); `decide()` (`decide.ts`): a claim passes at p ≥ 0.9, fails at
  p ≤ 0.1, else `inconclusive`; a pick is accepted when (`confidence` if TypeSafe returned one, else
  `probability`) ≥ 0.5 and the answer isn't `none`. A rejected pick or non-passing claim dumps the exact state
  to `$TMPDIR/plainwright/*.json` (`dumpDebug` in `src/core/results.ts`). A pick's state carries the flow's `goal`
  (spec `goal:` or MCP `open {goal}`, browser, desktop and mobile) when there is one, never in the question; claims never see it. The model is pinned (`MODEL_BY_PROVIDER`), not `jev-latest`:
  thresholds and phrasing advice were tuned against it. The TypeSafe SDK client handles timeouts and retries
  (429/5xx, `Retry-After`); the gateway path keeps its own retry loop because the AI SDK's backoff cannot outlast
  a rate-limit window. A global undici keep-alive dispatcher keeps API connections open between calls (Node's default
  drops them after 4 s, and the first model call on a new connection costs ~350 ms more); `warmUp()` sends two tiny
  Jev calls at CLI/MCP start so the first steps find warm connections.
- `src/browser/steps.ts` — one handler per step kind (`goto`, `fill`, `click`, `hover`, `dblclick`, `rightclick`,
  `select`, `check`, `uncheck`, `upload`, `scroll`, `wait`, `press`, `drag`, `mouse`, `expect`), each accepting
  `optional: true`. An action step is snapshot candidates → Jev picks while the page settles → Playwright acts;
  `expect`/`wait` are snapshot → Jev judges while the page settles (`settledAsk` in `settled-ask.ts`: the early answer is kept only if
  the main document did not mutate after the look, via `mark()`/`unchangedSince()`, or a second look is identical;
  otherwise the settled state is asked again and `ms.reasked` counts it). `settlePage()` (`activity.ts`) = DOM quiet 150 ms (mutations before the load event do not count) plus no
  xhr/fetch younger than 2 s in flight, 3 s cap; observers ignore the scan's own `data-jev-id` writes. A click's 200 ms
  hold and `fill`'s 500 ms debounce hold (`mayNavigate` `holdMs`; clicks watch only 50 ms themselves), and a loading
  popup (`holdActivity` in the session's popup handler), are waited by the next step's settle, or by `waitHold` in `runStep` for steps
  that do not settle first (`settlesFirst`). Several `expect` claims share one Jev call; fail beats inconclusive beats
  pass across them. `check`/`uncheck` read the state (a control's `checked`, following a label, or
  aria-checked/aria-pressed) and click only when it must change (`setChecked`); `scroll: top|bottom` (and spoken
  forms, `scrollEdge`) scrolls `document.scrollingElement` and reports the distance. A scan with no candidates is
  retried for up to 2 s (`APPEAR_MS` in `locate.ts`, a page still redirecting after `open`). `wait: {that, within}` picks the region
  once and polls only its tree (`judgeRegion` in `judge-page.ts`).
- `src/browser/runner.ts` — `runSpec()`: fork the hooks child first (fails fast, before the browser opens) → open a
  session → `setup()` → interpolate `url`/`steps` with `{env, hooks: data}` → run steps → `teardown()` in
  `finally` → close the child → close the session. `Status` is `pass | fail | inconclusive | error | skipped`.
  A setup error yields a single `setup` step and `error`, with no teardown; a teardown error always makes the
  run `error`. `src/suite/spec-timeout.ts` bounds steps by the remaining attempt budget; opening/setup consume it,
  cleanup is allowed to finish afterward. Optional steps cannot skip a spec timeout. Steps go through
  `runStepSafely` (`src/browser/steps.ts`), shared with `src/browser/mcp.ts`: errors become results, optional misses become `skipped`.
- Hooks contract: an ES module next to the spec (`hooks:`, resolved relative to the spec file) with optional
  `setup({spec})` (its return becomes `${hooks.*}`) and `teardown({spec, data, result})`, run in its own child
  process (`src/core/hooks-child.ts`, forked by `startHooks`) — one per spec run, so module-level state never leaks
  between specs and `--workers` can't make hooks interfere. Only JSON crosses the IPC channel. Dataset shape is
  not imposed. See `examples/login-dataset.yaml` + `examples/hooks/login-dataset.mjs`.
- `src/browser/mcp.ts` — MCP server over stdio with one persistent browser session; tools `open`, `step`, `find`,
  `snapshot` (whole page or `within` a region), `ask` (yes/no claims, `askPage` in `src/browser/judge-page.ts`), `read` (a question answered with
  the page's own lines: Jev picks the first and last line, `src/core/read.ts`; `PLAINWRIGHT_READ=0` hides it), `evaluate` (a JS expression's JSON value), `save`. `snapshot`, `ask`, `read` and
  `evaluate` read without acting and are not recorded. `step`/`batch` results carry `changed` (title/url if changed,
  new aria lines capped at 1,500 chars, removed count; `src/core/aria-changes.ts`, after a settle; `PLAINWRIGHT_CHANGES=0`
  turns it off). `save` writes a YAML spec with `${hooks.*}` placeholders kept and `hooks:` relative to the
  saved file. `${env.*}` is not available in an MCP session, only `${hooks.*}`. stdout is the JSON-RPC channel,
  so all logging goes to `console.error`.
- Console noise (`isConsoleNoise` in `src/browser/notes.ts`): CSP/blocked/failed-resource errors and errors from another
  site's script never reach `events` (Jev) and are counted in one note per drain; the page's own errors stay listed.
- `src/cli.ts` — entry point: loads `.env`, then dispatches to `mcp` or to running each spec file in order.
- Plugins live at `plugins/plainwright/` (browser), `plugins/plainwright-computer/` (desktop), and
  `plugins/plainwright-mobile/` (mobile), each
  with portable `plugin.json`/`mcp.json`, `.claude-plugin/plugin.json`/`.mcp.json`, a Codex compatibility
  manifest, its skill, and a generated `runtime.tgz`. Both root marketplaces point at these directories.
  Keep identity/version/description aligned across each plugin's manifests. Browser skill lives at
  `plugins/plainwright/skills/using-plainwright/` (SKILL.md, browsing.md, authoring.md).
- One root `package.json` and lockfile own all dependencies and all CLI binaries. `scripts/build-plugins.mjs`
  packages compiled runtime plus the root manifest/lockfile into the same archive for all plugins.
  `scripts/plugin-launcher.mjs` is copied into each plugin and caches the installed runtime by archive hash.
  Never add per-plugin package manifests, symlinks or parent-directory runtime imports.
- Docs: see "Documentation" below for the doc set, the owner of each topic and the writing rules.

## Documentation

User docs are `README.md`, `docs/*.mdx` and `examples/mobile/README.md`. They are for humans first: a developer or
QA engineer who writes, runs or debugs specs, or uses the plugins with an agent. Contributor detail goes in
`docs/development.mdx` or in this file, never in a user doc. Out of this set: `docs/benchmarks/**` (dated
measurement records, kept as `.md`, not rewritten after the fact), the plugin skills (agent-facing; the plugin
loader needs `.md`) and this file.

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
| Build, tests, native smoke tests, packaging | `docs/development.mdx` |

A desktop or mobile doc states only what differs from the browser docs and links to them for the rest.

Format: plain MDX that GitHub still renders.

- Each `docs/*.mdx` starts with frontmatter (`title`, one-sentence `description`) and an H1 with the same title.
  The two `README.md` files have no frontmatter (GitHub shows it as a table) but must still compile as MDX.
- No JSX components, `import`/`export`, `{/* */}` or `<!-- -->` comments, or `<https://…>` autolinks.
- In prose, `{`, `}`, `<` and `>` go inside inline code. HTML only where Markdown cannot do it (a centered
  image), with every tag closed (`<img … />`, `<br />`).
- Relative links use the `.mdx` name and a GitHub heading slug. Renaming a heading means fixing every link to it
  (`grep -rn "<file>.mdx#<old-slug>"` over the repo, including the skills and `docs/benchmarks`).
- `.github/workflows/test.yml` greps `docs/ci.mdx` for the Playwright image tag: keep the tag in that file and in
  the `Dockerfile` in sync with the lockfile.

Language: ASD-STE100 writing rules (Simplified Technical English), practical level. Technical names are allowed
(step kinds, flags, tool and file names, product names).

- Instructions: imperative, one instruction per sentence, at most 20 words, condition first ("If X, do Y").
- Descriptions: at most 25 words per sentence, one topic per sentence, at most 6 sentences per paragraph.
- Active voice, simple present. "can" for possibility, "must" for a requirement, "do not" for a prohibition.
- No should/may/might/would/could, contractions, semicolons, e.g./i.e./etc., filler words (just, simply,
  easily), -ing forms where a plain verb works, or phrasal verbs where one verb exists. Keep the articles.
- One word for one meaning across all docs: spec (a YAML test file), flow (an included steps-only file), step,
  target (an element description), claim (a statement for `expect`/`wait`/`ask`), pick, judgment, engine
  (browser, desktop, mobile; say "desktop", not "computer", except in the package name), and the statuses `pass`,
  `fail`, `inconclusive`, `error`, `skipped`, `flaky`.
- Vertical lists for three or more items; numbered lists when order matters. A warning starts with the
  instruction, then gives the reason.

Content:

- The code is the source of truth. Check every default, limit and behavior in `src/` before you write it. Do not
  document a planned or guessed behavior.
- Lead with what the reader wants to do and a short example; reference tables come after.
- Keep only facts that change what a user does or understands. Leave out function, module and type names (unless
  the user types them, such as a hook export or a config key), internal constants with no user effect, history
  ("before", "legacy", "unchanged", "this branch") and benchmark numbers (link the report in `docs/benchmarks/`).
- Keep the edge cases that give a silent wrong result, for example: a browser spec ignores unknown keys, `url` is
  only the base for `goto`, a `wait` never ends `fail`, `save` overwrites with no warning.
- Every browser example starts with `goto`. Full spec examples must pass `node dist/cli.js validate` (or the
  `computer`/`mobile` CLI); config examples must pass `--list`.

Check a doc change: compile each changed file with `@mdx-js/mdx` (MDX 3, with `remark-gfm` and
`remark-frontmatter`), check that every relative link and anchor resolves, and validate the YAML examples.

## Constraints

- This repo is site-agnostic. Site-specific skills, environment facts, and regression specs belong in downstream
  plugins that depend on plainwright, not here.
- Specs never hold literal credentials: put them in the spec's `env` block as `$VAR` references, used in steps as
  `${env.*}`.
- `examples/*.yaml` run against public demo sites; `examples/fixtures/` and `examples/hooks/` back the
  `login-dataset.yaml` example.
- Per `plugins/plainwright/skills/using-plainwright/SKILL.md`: test environments only, stop before the last irreversible step
  (payment, booking, sending), never bypass bot protection.

## Computer use

- `src/core/automation.ts` is the shared generic target adapter, candidate/snapshot types, pick acceptance and judgment retry logic. Browser, desktop and mobile paths use it. `src/core/results.ts` shares labels/status/debug output.
- `src/core/hooks.ts` owns the generic isolated hook runner (`startHooks`) and `placeholderPaths`, used by all three MCP servers.
- `src/native/` is the shared desktop/mobile core: `NativeSession` (`session.ts`; Jev targeting via `askSettled`, expect/wait polling, phase timing; subclasses implement `parse`, `label` and `act`), `runNativeSpec` (`run-spec.ts`; hooks → open → steps → teardown → close) and `nativeCli` (`cli.ts`). `src/native/mcp.ts` (`createNativeServer`, `serveNative`) holds the shared step/find/snapshot/ask/read/screenshot/save/close tools; each platform registers its own open and discovery tools first. As in the browser: `step` results carry `changed` (diffed against the step's own first whole-screen capture, `NativeSession.firstSnapshot`; press/swipe/mouse capture first), picks see `goal` (`open {goal}`, spec `goal:`), and `read` answers with tree lines.
- `src/computer/adapter.ts` implements `ComputerAdapter` using pinned xa11y (`@crowecawcaw/xa11y` 0.15.0). Native import is lazy; use the CommonJS default export (Node does not synthesize all named exports). `captureTree` (unit-tested with fake nodes) skips control parts (text, groups, images, table cells) inside a candidate, names unnamed candidates by their inner text, drops the single-window/application context and shortens long values; `click` inside a `web_area` is a pointer click, elsewhere the accessibility press when the element offers one (else a pointer click).
- `src/computer/spec.ts`, `session.ts`, `mcp.ts`, `cli.ts` provide desktop parsing, actions, the `apps`/`open` tools (ten serialized MCP tools in all), and sequential batch replay, on top of `src/native/`. Desktop specs have `app`, not `url`.
- `src/computer/planner.ts` turns one sentence into plan items (code proposes splits/actions/word spans, Jev picks, arguments are copied verbatim); `plainwright-computer plan|do "<sentence>"` in `src/computer/cli.ts`. Change it only when `scripts/benchmark-planner.mjs` improves; results in `docs/benchmarks/planner.md`.
- `plugins/plainwright-computer/` is a separate portable/Codex/Claude plugin. `npm run build` regenerates all plugin runtime archives via `scripts/build-plugins.mjs`; never edit generated files directly. The root package and lockfile are the only dependency sources.
- Keep desktop tool names, thresholds and step support synchronized in `docs/computer-use.mdx` and the plugin's `skills/using-plainwright-computer/SKILL.md`. Browser-only steps must fail explicitly on desktop.
- `npm run test:computer:mac` is an opt-in native smoke against a disposable Cocoa fixture (Accessibility/Screen Recording permissions required); regular `npm test` uses injected desktop adapters and no model keys. Windows/Linux native parity requires testing on those platforms.

## Mobile use

- `src/mobile/adapter.ts` provides injectable `MobileAdapter` and lazy WebdriverIO `AppiumAdapter`. Appium and platform drivers are external host prerequisites; never auto-install apps or reset app data. Explicit `platform`, `device` (UDID/ADB serial) and installed `app` are required.
- `src/mobile/tree.ts` normalizes native XCUITest/UiAutomator2 XML into shared candidates/snapshots. `isRoleMarker()`, applied in `mobileFrame()`, drops a Jetpack Compose role-marker child from candidates when its clickable attribute is false, it is not long-clickable, it has no text or content-desc, and its bounds are set and match its clickable parent; the child stays in the snapshot. Native paths stay inside the adapter; Jev remains the sole target decision maker. Revalidate captured identity before native actions.
- `src/mobile/spec.ts`, `session.ts`, `mcp.ts`, `cli.ts` provide mobile parsing, actions, the discovery/`open` tools (eleven serialized tools in all), and sequential replay, on top of `src/native/`.
- iOS tree reads are dominated by XCUITest's `visible` attribute. `AppiumAdapter` revalidates targets from the lookup response (`IOS_FOUND_ATTRIBUTES`, incl. `attribute/visible`), and with `fastTargets` (set by `mobile/cli.ts` and `mobile/mcp.ts`; MCP `find` calls `preferExact`, and `changed` never diffs against an approximate frame: `firstSnapshot` skips them, the previous step's after capture stands in) picks targets from a source without `visible` (`parseMobileTree` `boundsVisibility`, frame `approximate`); `MobileSession.act` keeps such a pick when accepted (>= 0.5, like any pick) and visible, else re-picks from an exact capture (`ms.retargeted`); fast and exact trees picked the same element in 24/24 recorded Calendar asks, with lower confidence on sheets. Claim `within` regions are also picked from the approximate tree (containers only, `NativeSession.region(within, true)`); the first exact look must show a visible node or `HiddenTargetError` re-picks. Reads exclude `accessible` except for click candidates; iOS lookups use class chains (`MobileNode.chain`). Measure with `examples/mobile/ios-calendar.yaml`.
- `NativeSession.settled()` uses `askSettled` (`core/automation.ts`): within 1 s of the previous step (or `noteActivity()` after open), Android reads a quick tree (`AppiumAdapter.captureEarly`, `waitForIdleTimeout` 0 for one read, then restored) and Jev works on it while the idle-waiting `capture()` runs; the answer is kept only if both frames are identical, else re-asked (`ms.reasked`). iOS returns null (no gain measured). The pre-action identity revalidation is unchanged.
- `src/mobile/discovery.ts` implements session-free local `list_devices`/`list_apps` through ADB and simctl/plutil, with injected commands for tests. Discovery targets the MCP host, not remote Appium; physical iPhone discovery is not supported. Keep discovery scope, pagination and setup diagnostics synchronized in the mobile docs/skill.
- The mobile plugin follows the same portable/Codex/Claude layout, root dependency ownership, generated runtime and marketplace conventions. Keep tool names, supported steps and thresholds aligned in `docs/mobile-use.mdx` and its skill.
- Mobile adds tap/longpress/swipe and supports selected shared steps; reject browser/desktop-only vocabulary explicitly. Android Back/Enter do not have generic iOS equivalents. Native context only; no webview switching.
- Regular tests use injected intelligence and a local Appium HTTP fixture with real WebdriverIO. `npm run test:mobile` is an opt-in device tree/PNG smoke using PLAINWRIGHT_MOBILE_PLATFORM/DEVICE/APP and optional PLAINWRIGHT_APPIUM_URL/CAPABILITIES. Native actions and record/replay need validation on both real platforms before claiming parity.
- `npm run test:mobile:android` builds a disposable offline Java fixture with SDK Platform 36 and Build-Tools 36.0.0, installs it on PLAINWRIGHT_MOBILE_DEVICE, validates actions/MCP authoring/saved replay and uninstalls it. Requires ANDROID_HOME, JAVA_HOME and Appium. `-- --live-jev` uses the configured model; default targeting is deterministic. Artifacts stay in a temporary results directory, not the repository.
- `npm run test:mobile:ios` builds a disposable UIKit fixture with Xcode's simulator SDK, installs it on the booted simulator identified by PLAINWRIGHT_MOBILE_DEVICE, validates actions/MCP recording/replay and uninstalls it. Requires macOS, Xcode, an iOS runtime and Appium with XCUITest. Supports `-- --live-jev` and PLAINWRIGHT_APPIUM_URL; no developer account is needed for this simulator-only test.
- Runnable mobile YAML lives in `examples/mobile/` so the top-level browser glob remains valid. Its `examples/hooks/mobile-fixture.mjs` hook and both native smoke scripts share `scripts/mobile-fixture.mjs` for fixture installation/cleanup. Example device IDs come from PLAINWRIGHT_MOBILE_DEVICE, never checked-in personal UDIDs.
