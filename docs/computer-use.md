# Computer use

`plainwright-computer` drives native desktop applications with
[xa11y](https://github.com/xa11y/xa11y). Jev makes the same natural-language target choices and
assertion judgments as the browser engine. The existing `plainwright` plugin continues to use
Playwright; desktop automation is a separate plugin and CLI entrypoint.

## Backend choice

The requirement is accessible controls plus native actions, not just moving a mouse. xa11y's
TypeScript API exposes native accessibility on macOS (AXUIElement), Windows (UI Automation),
and Linux (AT-SPI2), with MIT-licensed source and platform binaries. We pin
`@crowecawcaw/xa11y` to `0.15.0` and isolate it behind `ComputerAdapter`. It is a newer library,
so platform quirks and upstream API changes need validation before upgrading.

Alternatives evaluated on 2026-09-20:

| Backend | Fit for this project |
|---|---|
| [xa11y](https://xa11y.dev/api/javascript/) | Chosen: native accessibility, actions, keyboard/pointer simulation and screenshots in one Node API across desktop platforms. |
| [Appium Mac2](https://appium.github.io/appium-mac2-driver/v4/getting-started/) | Established macOS automation, but requires an Appium server, Xcode and a separate driver stack. Desktop portability needs other drivers. |
| [nut.js](https://nutjs.dev/) | Strong keyboard/mouse/screen automation. Packaged accessibility tooling and prebuilt distributions involve commercial tiers; adds distribution requirements to this MIT repository. |
| [Computer Use Protocol TypeScript SDK](https://github.com/computeruseprotocol/typescript-sdk) | Similar accessibility approach, but its repository was archived on April 30, 2026. |

Jev sees accessibility text, not screenshots. Apps with inaccessible canvas controls are outside
natural-language targeting's current coverage. This is not a vision-based agent.

## Install and start

Requirements: Node 22+, npm, a running desktop session, and a Jev provider key for targeting/assertions.
Browser dependencies do not need native permissions. xa11y is optional in the root package and
loaded only for desktop operations; the desktop plugin reports an actionable error if the optional native package is unavailable.
Keep optional platform packages enabled when installing xa11y.

From a clone:

```sh
npm ci
npm run build
node bin/plainwright-computer.mjs mcp
node bin/plainwright-computer.mjs --timeout 15000 path/to/desktop.yaml
```

The plugin directory is `plugins/plainwright-computer/`, alongside the browser plugin at
`plugins/plainwright/`. One root `package.json` and lockfile own both engines. Each plugin includes
the same generated `runtime.tgz`; its launcher installs that shared package into an ignored
`.runtime/` cache on first use, with install progress on stderr. Starting the desktop plugin does
not install Chromium or require a neighboring browser-plugin installation:

```sh
node plugins/plainwright-computer/bin/launch.mjs mcp
```

Both repository marketplaces list `plainwright-computer`. With this checkout added as your
marketplace, select that plugin in your host. Claude Code can also load the directory directly:

```sh
claude --plugin-dir /absolute/path/to/plainwright/plugins/plainwright-computer
```

The repository's portable `plugin.json` / `mcp.json`, Codex compatibility manifest, and Claude
manifest/config all name the same server, `plainwright-computer`. The portable configuration
uses `${PLUGIN_ROOT}` as cwd; Claude uses `${CLAUDE_PLUGIN_ROOT}` in its launcher path. The
plugin does not install itself into your personal plugin cache during a repository build.

Environment lookup is shared with plainwright: process environment, cwd `.env`, then
`~/.config/plainwright/.env` (or the equivalent under `XDG_CONFIG_HOME`). Existing variables win.
Use `TYPESAFE_API_KEY`, or `AI_GATEWAY_API_KEY`; `JEV_PROVIDER` can force the provider. MCP discovery,
`apps`, unscoped `snapshot`, and `screenshot` do not require a Jev key.

## Platform setup

- **macOS:** grant the host executing Node Accessibility permission. Depending on macOS version,
  System Settings labels it Accessibility or Device Control and Data Access. Screen Recording
  permission may also be needed for window contents and screenshots. Restart the host if macOS
  requires it. The library reports permission errors; the plugin does not change privacy settings.
- **Windows:** use an interactive UI Automation desktop. Apps at a different integrity/elevation
  level may not expose the same controls or accept input.
- **Linux:** use an AT-SPI2-enabled desktop. Pointer, keyboard and screenshot support depends on the
  desktop/display server; accessibility availability does not imply unrestricted Wayland input.

Read the upstream [installation](https://xa11y.dev/how-to/install/) and
[platform documentation](https://xa11y.dev/reference/platforms/) for native prerequisites.
The cross-platform API is implemented; native verification in this repository currently targets macOS.

## Agent tools

| Tool | Purpose |
|---|---|
| `apps {}` | List running accessible app names/pids; no focus change. |
| `open {app}` or `open {pid}` | Attach to exactly one running app. `activate` defaults to true; false leaves focus alone. Optional `hooks` runs setup before attachment. |
| `step {step}` | Execute one natural-language action/assertion and return status, detail, timings, and token count. |
| `find {kind, target}` | Dry-run a target with Jev. Kinds: click, fill, check, hover, region, scroll. |
| `snapshot {within?, maxChars?}` | Read accessibility text; default 20,000 chars, maximum 60,000. `within` resolves a region with Jev. |
| `screenshot {}` | Return a PNG of an attached app window. Not supplied to Jev. |
| `save {path, name?}` | Save successful steps as desktop YAML. Rejects an empty recording. |
| `close {}` | Detach and run teardown; leave the application running. |

`open` attaches; it does not launch arbitrary programs. Applications must already be running,
which keeps batch setup in the user's environment or hooks. Every `open` starts a new recording
and releases the previous hook lease. `save` uses the app name, not an ephemeral pid, for replay.
All requests in a server are serialized, including reads. Different server processes still share
one physical desktop: do not run multiple desktop sessions in parallel.

Native accessibility actions operate on captured handles. Simulated keyboard/pointer actions also
check that the attached app's pid is currently foreground. A focus change returns an error;
it does not silently activate an unrelated window. OS focus can still change between that check
and an input event, so use a dedicated test desktop for unattended runs.

## Desktop specs

```yaml
name: Preview a message
app: Desktop Test Fixture
env:
  message: $TEST_MESSAGE
hooks: ./hooks/fixture.mjs # optional; use setup to prepare the test application/data
steps:
  - fill: {target: "the Message text field", value: "${env.message}"}
  - check: "the Enable preview checkbox"
  - click: "the Preview button"
  - expect: "The preview contains the test message"
```

Top-level keys are `name`, `app`, optional `env` and `hooks`, and a nonempty `steps` list.
Unknown top-level keys are rejected so browser settings cannot be silently ignored. Environment
references and `${env.*}` / `${hooks.*}` interpolation are the browser engine's existing logic.
Store credentials as `$VAR` references in `env`, or return them from hooks; never record literals.
MCP supports `${hooks.*}` only and preserves placeholders in `save`.

Supported steps reuse the browser schema:

| Step | Desktop behavior |
|---|---|
| `click`, `fill` | Invoke the accessible control; replace its text value. |
| `check`, `uncheck` | Toggle only if the exposed checked state differs. Mixed states error instead of guessing. |
| `hover`, `dblclick`, `rightclick` | Simulated pointer action on the control's bounds. |
| `scroll: "down: the list"` / `"up: the list"` | One wheel movement at a resolved region. Does not claim to reach the end. |
| `press: "Control+a"` | Key or modifier+key chord. Use `Meta` for Command on macOS. |
| `mouse: {x, y}` | Pointer move in logical desktop coordinates. |
| `drag: {source, target}` | Resolve both endpoints in one Jev batch, then simulate a drag. |
| `expect: [...]` | Judge multiple atomic claims in one request; can scope with `{that, within}`. |
| `wait: "claim"` | Poll accessibility state, with up to eight Jev calls; avoid rejudging unchanged definite failures. |

Browser `goto`, `select`, `upload`, `css=`, and browser scroll-to-edge syntax are rejected.
Use accessible native menus and file-dialog controls instead. `optional: true` changes only
inconclusive/error to skipped; a definite failed expectation still fails the run.

The shared thresholds apply: picks need confidence >= 0.5 (probability fallback); claims pass at
p >= 0.9, fail at p <= 0.1, otherwise are inconclusive. Rejections dump state to the same
`$TMPDIR/plainwright/` debug directory. Candidate lists cap at 1,016; captures limit text to
60,000 characters, traversal to 5,000 nodes/32 levels, and prioritize modal siblings. `truncated`
reports caps; use a scoped snapshot for dense apps. The timeout bounds app lookup and capture/wait
polling budgets; an individual native call or Jev request/retry can outlast the polling deadline.

Batch specs run sequentially. Exit 0 means all passed, 1 means a spec failed/errored/was inconclusive,
2 means invalid CLI usage or missing provider configuration. Hooks share the isolated child-process
contract described in [hooks](hooks.md), with a desktop spec's `app` replacing the browser's `url`.
Teardown runs after a successful setup even when attachment, interpolation, or a step fails. A
setup failure skips teardown; a teardown failure makes the run error. Detach never quits the app.

## Implementation and verification

`automation.ts` owns the generic target adapter, candidate/snapshot data, accepted-pick mapping,
assertion retry logic, and injectable intelligence. Both Playwright's `resolveLocators` and
`ComputerSession.find` use it. `results.ts`, `spec.ts` and `hooks.ts` supply shared status/labels,
parsing/interpolation, and hook lifecycle. Browser-specific settling/navigation stays in the browser
adapter; desktop capture/actions live in `computer-adapter.ts`.

`npm run build` compiles TypeScript, then `scripts/build-plugins.mjs` creates the same committed
`runtime.tgz` in both plugin folders from the root package, compiled files, CLI binaries, and license.
The root lockfile becomes an npm shrinkwrap inside the archive, so plugin installs use the locked
dependency graph. There are no plugin-specific package manifests or lockfiles. The launcher
caches by archive hash, so a rebuilt archive gets a fresh runtime installation.

```sh
npm test                    # browser regression + desktop adapter/protocol tests, no API key
npm run test:computer:mac    # opt-in: creates a disposable Cocoa app, needs native permissions
```

The native smoke test injects deterministic model choices and asserts actual application state.
It covers attachment, tree capture, fill/click, idempotent check/uncheck, keyboard input, hover,
and PNG capture. The fixture is closed and removed afterward. It does not require a model key.
Windows and Linux need equivalent native smoke runs on their own hosts before claiming native parity.
