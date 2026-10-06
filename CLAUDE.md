plain runs natural-language test specs (YAML) on three engines: browser (`src/browser/`), desktop (`src/computer/`)
and mobile (`src/mobile/`); desktop and mobile share the native core in `src/native/`. Playwright (browser) or the
engine's adapter (desktop, mobile) performs actions; Jev (TypeSafe's model, via `@typesafe-ai/sdk` or the Vercel AI
SDK gateway) is the only decision maker. It picks the element a natural-language target describes (Choice) and
judges whether a natural-language claim holds (Noul) against the accessibility tree. Specs have no CSS selectors
except a browser-only `css=` escape hatch. The model is pinned (`MODEL_BY_PROVIDER` in `src/jev/provider.ts`):
thresholds and phrasing advice were tuned against it.

## Validation (mandatory)

Before any pull request, and before you report a change as done, follow the `validating-changes` skill
(`.claude/skills/validating-changes/SKILL.md`).

## Commands

```
npm run build                                               # src/ → dist/; after a clone and after each src/ change
npm test                                                    # build + node --test 'dist/**/*.test.js' 'scripts/*.test.mjs'
node --test dist/browser/runner.test.js                     # one file, after a build
node --test --test-name-pattern "<name>" dist/jev/pick.test.js   # one test case
npm run verify                                              # the key-free gate CI runs: tests, docs, examples, plugins
node scripts/validate.mjs                                   # the whole validation loop + the pre-PR stamp
```

No test in the regular suite needs a Jev API key.

## Rules for every task

- This repo is site-agnostic. Site-specific skills, environment facts, and regression specs belong in downstream
  plugins that depend on plain, not here.
- Specs never hold literal credentials, also the YAML examples in docs: put them in the spec's `env` block as `$VAR`
  references, used in steps as `${env.*}`.
- When you run plain against a site (per `plugins/plain/skills/using-plain/SKILL.md`): test environments only, stop
  before the last irreversible step (payment, booking, sending), never bypass bot protection.

## Where to read more

| Before you … | Read |
|---|---|
| change code (`src/`, `scripts/`, `bin/`, `plugins/`, `mods/`, `e2e/`, `examples/`, `package.json`) | `CODING_STANDARDS.md` |
| change the native, desktop or mobile engine | the `CLAUDE.md` (also `AGENTS.md`) in `src/native/`, `src/computer/` or `src/mobile/` |
| write or change a user doc (`README.md`, `docs/*.mdx`, `examples/mobile/README.md`) | the `writing-docs` skill (`.claude/skills/writing-docs/SKILL.md`) |
| open or update a pull request, or report a change as done | the `validating-changes` skill |
| run a spec, `validate`, `--list` or the MCP server from a checkout | `docs/running.mdx`; `docs/development.mdx`, "Build output" |
| run the live checks (e2e, claims gate, agent evals) or check what CI runs | `docs/development.mdx`, "Validation before a pull request" |
| run benchmarks or area evals | `docs/development.mdx`, "Performance checks"; results in `docs/benchmarks/` |
| release a version or change the npm package or plugin packaging | `docs/development.mdx`, "Releases" and "Plugin packaging" |
| use the plain MCP tools | the `using-plain` skill (`plugins/plain/skills/using-plain/SKILL.md`) |
