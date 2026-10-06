# Coding standards

Read this before you change code: `src/`, `scripts/`, `bin/`, `plugins/`, `mods/`, `e2e/`, `examples/` or
`package.json`.

## Runtime

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
