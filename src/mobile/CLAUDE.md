# Mobile engine

Built on the native core (`src/native/CLAUDE.md`).

- `adapter.ts` provides the injectable `MobileAdapter` and the lazy WebdriverIO `AppiumAdapter`. Appium and
  platform drivers are external host prerequisites; never auto-install apps or reset app data. Explicit
  `platform`, `device` (UDID/ADB serial) and installed `app` are required.
- `tree.ts` normalizes native XCUITest/UiAutomator2 XML into shared candidates/snapshots. `isRoleMarker()`,
  applied in `mobileFrame()`, drops a Jetpack Compose role-marker child from candidates when its clickable
  attribute is false, it is not long-clickable, it has no text or content-desc, and its bounds are set and match
  its clickable parent; the child stays in the snapshot. Native paths stay inside the adapter; Jev remains the sole
  target decision maker. Revalidate captured identity before native actions.
- `spec.ts`, `session.ts`, `mcp.ts`, `cli.ts` provide mobile parsing, actions, the discovery/`open` tools (eleven
  serialized tools in all), and sequential replay.
- iOS tree reads are dominated by XCUITest's `visible` attribute. `AppiumAdapter` revalidates targets from the
  lookup response (`IOS_FOUND_ATTRIBUTES`, incl. `attribute/visible`), and with `fastTargets` (set by `cli.ts` and
  `mcp.ts`; MCP `find` calls `preferExact`, and `changed` never diffs against an approximate frame: `firstSnapshot`
  skips them, the previous step's after capture stands in) picks targets from a source without `visible`
  (`parseMobileTree` `boundsVisibility`, frame `approximate`). `MobileSession.act` keeps such a pick when accepted
  (>= 0.5, like any pick) and visible, else re-picks from an exact capture (`ms.retargeted`); fast and exact trees
  picked the same element in 24/24 recorded Calendar asks, with lower confidence on sheets. Claim `within` regions
  are also picked from the approximate tree (containers only, `NativeSession.region(within, true)`); the first
  exact look must show a visible node or `HiddenTargetError` re-picks. Reads exclude `accessible` except for click
  candidates; iOS lookups use class chains (`MobileNode.chain`). Measure with `examples/mobile/ios-calendar.yaml`.
- iOS keyboard: XCUITest does not wait for the keyboard. On iOS 27 it stays below the screen (`visible="false"`)
  for ~1-1.5 s after `elementSendKeys` returns, so the next capture would have no keys.
  `AppiumAdapter.keyboardShown()` runs after an iOS `fill` and after a click on a text-entry role
  (`IOS_TEXT_ENTRY`): it polls the `**/XCUIElementTypeKeyboard` class-chain lookup (its `attribute/visible`, ~60 ms
  per lookup) until visible or absent, at most `KEYBOARD_MS` (3 s, capped by the action timeout). The return key
  is `XCUIElementTypeButton` name `Done`, label `done` (drawn as a checkmark).
- Android early reads: `AppiumAdapter.captureEarly` sets `waitForIdleTimeout` 0 for one read, then restores it
  (see `src/native/CLAUDE.md`).
- `discovery.ts` implements session-free local `list_devices`/`list_apps` through ADB and simctl/plutil, with
  injected commands for tests. Discovery targets the MCP host, not remote Appium; physical iPhone discovery is not
  supported. Keep discovery scope, pagination and setup diagnostics synchronized in the mobile docs/skill.
- The mobile plugin follows the same portable/Codex/Claude layout, root dependency ownership, generated runtime and
  marketplace conventions. Keep tool names, supported steps and thresholds aligned in `docs/mobile-use.mdx` and its
  skill.
- Mobile adds tap/longpress/swipe and supports selected shared steps; reject browser/desktop-only vocabulary
  explicitly. Android Back/Enter do not have generic iOS equivalents. Native context only; no webview switching.
- Regular tests use injected intelligence and a local Appium HTTP fixture with real WebdriverIO. The opt-in device
  smokes (`npm run test:mobile`, `test:mobile:android`, `test:mobile:ios`) and their variables are in
  `docs/development.mdx`, "Verification". Native actions and record/replay need validation on both real platforms
  before claiming parity.
- Runnable mobile YAML lives in `examples/mobile/` so the top-level browser glob remains valid. Its
  `examples/hooks/mobile-fixture.mjs` hook and both native smoke scripts share `scripts/mobile-fixture.mjs` for
  fixture installation/cleanup. Example device IDs come from `PLAIN_MOBILE_DEVICE`, never checked-in personal
  UDIDs.
