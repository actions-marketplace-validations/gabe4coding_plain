# Desktop engine

Built on the native core (`src/native/CLAUDE.md`). Desktop specs have `app`, not `url`.

- `adapter.ts` implements `ComputerAdapter` using pinned xa11y (`@crowecawcaw/xa11y` 0.15.0). The native import is
  lazy; use the CommonJS default export (Node does not synthesize all named exports). `captureTree` (unit-tested
  with fake nodes) skips control parts (text, groups, images, table cells) inside a candidate, names unnamed
  candidates by their inner text, drops the single-window/application context and shortens long values. `click`
  inside a `web_area` is a pointer click, elsewhere the accessibility press when the element offers one (else a
  pointer click).
- `spec.ts`, `session.ts`, `mcp.ts`, `cli.ts` provide desktop parsing, actions, the `apps`/`open` tools (ten
  serialized MCP tools in all), and sequential batch replay.
- `planner.ts` turns one sentence into plan items (code proposes splits/actions/word spans, Jev picks, arguments
  are copied verbatim); `plain-computer plan|do "<sentence>"` in `cli.ts`. Change it only when
  `scripts/benchmark-planner.mjs` improves; results in `docs/benchmarks/planner.md`.
- Regular `npm test` uses injected desktop adapters and no model keys. `npm run test:computer:mac` is the opt-in
  native smoke (`docs/development.mdx`, "Desktop on macOS"). Windows/Linux native parity requires testing on those
  platforms.
