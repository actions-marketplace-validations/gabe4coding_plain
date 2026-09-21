<p align="center">
  <img src="docs/banner.jpg" alt="plainwright: end-to-end browser tests written in plain English. A YAML step, click: the login button, goes through a semantic decision model that reads the page's accessibility tree and clicks the Login button." width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node 22 or newer">
  <img src="https://img.shields.io/badge/browser-Playwright-45ba4b.svg" alt="Driven by Playwright">
</p>

Browser, desktop and mobile automation written in plain English. Run YAML tests from the command line,
or let a coding agent explore a flow through MCP and save it as a replayable spec.

[Jev](https://typesafe.ai), a small decision model, selects the element a sentence describes and
judges whether a claim holds. It reads accessibility text; the automation backend performs the actions.

| | Browser | Desktop | Mobile |
|---|---|---|---|
| Plugin and CLI | `plainwright` | `plainwright-computer` | `plainwright-mobile` |
| Action backend | [Playwright](https://playwright.dev) | [xa11y](https://xa11y.dev) | [Appium](https://appium.io) + WebdriverIO |
| Spec target | `url`: a website | `app`: a running native application | `platform`, `device`, `app`: installed iOS/Android app |
| Platforms | Playwright-supported platforms | macOS, Windows and Linux API; native verification currently targets macOS | iOS/XCUITest and Android/UiAutomator2, including React Native; native validation required on target devices |

All engines share Jev decisions, assertions, environment interpolation, and setup/teardown hooks
through adapters. Native targeting requires accessible controls; screenshots are available for
inspection but are not supplied to Jev.

## Get started

Requirements: Node 22+, npm, and a [TypeSafe](https://typesafe.ai) API key or Vercel AI Gateway key.

Create `~/.config/plainwright/.env` with your provider key. All plugins and CLIs read this file:

```dotenv
TYPESAFE_API_KEY=<your key>
```

For desktop use, start the application before attaching. On macOS, grant the host running Node
Accessibility permission and Screen Recording permission for screenshots, then restart the host if
required. Windows needs an interactive UI Automation desktop; Linux needs an AT-SPI2-enabled desktop.
See [platform setup](docs/computer-use.md#platform-setup) for prerequisites and limitations.

For mobile, start Appium with XCUITest or UiAutomator2 and connect a test device or boot a
simulator/emulator with your app installed. See [mobile setup](docs/mobile-use.md#setup).

### Use with an agent

Add the marketplace, then install the plugins you need. Each includes an MCP server and a skill
that teaches the agent how to phrase actions, inspect results, and save a flow.

**Claude Code**

```sh
/plugin marketplace add gabe4coding/plainwright
/plugin install plainwright@plainwright-marketplace
/plugin install plainwright-computer@plainwright-marketplace
/plugin install plainwright-mobile@plainwright-marketplace
```

**Codex**

```sh
codex plugin marketplace add gabe4coding/plainwright
codex plugin add plainwright@plainwright-marketplace
codex plugin add plainwright-computer@plainwright-marketplace
codex plugin add plainwright-mobile@plainwright-marketplace
```

The first use installs the shared runtime dependencies. The browser plugin also installs Chromium.
Each server keeps one session, and the agent sends natural-language actions through `step`.

| Tools | Available in |
|---|---|
| `open`, `step`, `find`, `snapshot`, `save` | All plugins |
| `evaluate` | Browser: read a JavaScript expression's value |
| `apps` | Desktop: list running apps |
| `list_devices`, `list_apps` | Mobile: discover local devices and installed apps |
| `screenshot`, `close` | Desktop and mobile: capture native UI and release the session |

Use `save` to turn successful steps into a YAML spec. Desktop `open` attaches to a running app;
`close` leaves it running. For tool arguments and session behavior, see
[browser agent mode](docs/agent-mode.md), [desktop agent tools](docs/computer-use.md#agent-tools),
and [mobile agent tools](docs/mobile-use.md#agent-tools).

For UI discovery, opt into `snapshot {mode:"compact"}` for selected exact excerpts or
`snapshot {mode:"smart",intent:"the task"}` for Jev classifications and only task-relevant UI
regions, necessary context, and recognized critical messages.
Raw remains the default; see [snapshot views and tradeoffs](docs/snapshots.md).

### Run from a checkout

```sh
git clone https://github.com/gabe4coding/plainwright.git
cd plainwright
```

Run the included browser example. The launcher installs dependencies and Chromium on first use,
then opens a visible browser:

```sh
node bin/plainwright.mjs examples/todo.yaml
```

For desktop specs, install the shared dependencies first, then run a spec targeting an open app:

```sh
npm ci
node bin/plainwright-computer.mjs path/to/desktop.yaml
```

To connect an MCP client directly, start the corresponding server over stdio:

```sh
node bin/plainwright.mjs --headless mcp
node bin/plainwright-computer.mjs mcp
node bin/plainwright-mobile.mjs mcp
```

## Write a spec

A spec names its target and lists actions or checks. Describe controls by their accessibility role
and visible text, and write assertions as specific claims about the current state.

### Browser

```yaml
name: add a todo
url: https://demo.playwright.dev/todomvc
steps:
  - goto: /
  - fill: { target: "the new todo input", value: "buy milk" }
  - press: Enter
  - expect: "a todo item named 'buy milk' is listed"
```

Browser steps include navigation, dropdown selection, file upload, and a `css=` escape hatch.
See the [browser spec reference](docs/spec-reference.md) for all steps and top-level settings.

### Desktop

This example assumes a test app named `Desktop Test Fixture` is already running with the described
controls. Replace its name and targets to match your application:

```yaml
name: preview a message
app: Desktop Test Fixture
steps:
  - fill: { target: "the Message text field", value: "hello" }
  - check: "the Enable preview checkbox"
  - click: "the Preview button"
  - expect: "The preview says hello"
```

Desktop specs use `app` in place of `url`. Browser-only steps such as `goto`, `select`, `upload`,
and `css=` are rejected. See [desktop specs](docs/computer-use.md#desktop-specs) for supported steps.

### Mobile

The mobile MCP can discover local Android devices/emulators and iOS simulators with
`list_devices`, then find installed app IDs with `list_apps {platform, device, query?}`.
These tools work before `open` and require no model key. Discovery uses the MCP host's SDKs;
physical iPhones and remote Appium hosts still require explicit device/app IDs.

Mobile specs target an installed app by package/bundle ID and an explicit device ID. For example,
on an Android test emulator with your fixture installed:

```yaml
name: preview a mobile message
platform: android
device: emulator-5554
app: com.example.fixture
steps:
  - fill: {target: "the Message text field", value: "hello"}
  - tap: "the Preview button"
  - expect: "The preview says hello"
```

For iOS use `platform: ios`, the simulator/device UDID and app bundle ID. Run with
`node bin/plainwright-mobile.mjs path/to/mobile.yaml`. Mobile adds `tap`, `longpress` and `swipe`;
see [mobile specs](docs/mobile-use.md#mobile-specs) for gestures, platform differences and hooks.

Runnable [Android](examples/mobile/android.yaml) and [iOS Simulator](examples/mobile/ios.yaml)
examples build and install their own disposable native fixtures through hooks. Follow the
[example setup and commands](examples/mobile/README.md) to run them against your test device.

### Shared behavior

All engines support actions such as `click`, `fill`, `check`, and `press`, plus `wait` and `expect`
for assertions. `optional: true` skips an action that errors or is inconclusive; a definite failed
assertion still fails the run.

Keep credentials outside specs: reference `$VAR` in an `env` block and use `${env.*}` in steps.
[Hooks](docs/hooks.md) can prepare and release test data, exposing setup results as `${hooks.*}`.
The [phrasing guide](docs/phrasing.md) explains target selection, judgment thresholds, and how to
resolve an inconclusive result.

Top-level `examples/*.yaml` are browser specs against public demo sites; `examples/mobile/` contains
disposable native fixtures and recorded app flows with documented starting conditions. `examples/login-fails.yaml` is intended
to fail.

## Run options and results

All CLIs accept several spec paths and `--timeout` (default 15,000 ms). Desktop specs run sequentially
because they share one physical desktop. Mobile files also run sequentially; avoid concurrent
automation sessions on the same device.

```sh
node bin/plainwright.mjs --timeout 30000 spec.yaml other.yaml
node bin/plainwright-computer.mjs --timeout 30000 desktop.yaml other-desktop.yaml
```

The browser CLI also supports:

| Option | Purpose |
|---|---|
| `--headless` | Hide the browser window. |
| `--timing` | Print per-step, spec, and run phase timings. |
| `--workers 4` | Run specs concurrently in isolated browser contexts; requires the default launch mode. |
| `--profile ~/.plainwright` | Keep a persistent browser profile between runs. |
| `--channel chrome` | Use installed Google Chrome; can be combined with `--profile`. |
| `--cdp http://127.0.0.1:9222` | Attach to an existing Chrome debugging session. |

See [your real browser](docs/agent-mode.md#your-real-browser) for profile and attachment setup.
`--workers` cannot be combined with `--profile` or `--cdp`.

The browser CLI prints step results with `✔` for pass, `✘` for fail or error, `?` for inconclusive,
and `»` for skipped. The desktop and mobile CLIs print a JSON result per spec with the same statuses.
All exit with code 0 only when every spec passes.

## Configuration

All engines read the shell environment, then a `.env` in the current directory (see
[.env.example](.env.example)), then `~/.config/plainwright/.env`. A variable already set is never
overridden.

| Variable | Applies to | Meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | All | TypeSafe direct, the default backend. Wins when both provider keys are set. |
| `AI_GATEWAY_API_KEY` | All | Use Vercel AI Gateway. |
| `JEV_PROVIDER` | All | Force `typesafe` or `gateway`. |
| `PLAINWRIGHT_PROFILE` | Browser | Same as `--profile`. |
| `PLAINWRIGHT_CHANNEL` | Browser | Same as `--channel`. |
| `PLAINWRIGHT_CDP` | Browser | Same as `--cdp`. |
| `PLAINWRIGHT_APPIUM_URL` | Mobile | Appium URL; `--server` overrides it. Default `http://127.0.0.1:4723`. |

The browser environment settings also let a plugin use your preferred profile or running browser
without changing its launch arguments. Jev is pinned to a tested version (`jev-1.13.0` on TypeSafe)
because the decision thresholds and phrasing advice were tuned against it.

## Documentation

| Guide | Contents |
|---|---|
| [Browser spec reference](docs/spec-reference.md) | Steps and settings, including dialogs, authentication and geolocation. |
| [Browser agent mode](docs/agent-mode.md) | MCP tools, plugin setup, persistent profiles and Chrome attachment. |
| [Computer use](docs/computer-use.md) | Native setup, desktop steps and tools, backend comparison and platform limitations. |
| [Mobile use](docs/mobile-use.md) | Appium setup, iOS/Android steps, MCP authoring and native validation. |
| [Phrasing](docs/phrasing.md) | Targets, claims, confidence thresholds and inconclusive results. |
| [Hooks](docs/hooks.md) | Isolated setup/teardown and test-data interpolation. |

## Usage rules

- Test environments only. Stop before the last irreversible step: payment, booking, sending.
- No literal credentials in a spec. Use environment references or hooks.
- Never use it to bypass bot protection.

## Development

```sh
npm ci
npx playwright install chromium
npm test                  # build + browser, desktop and mobile tests; no API key needed
npm run build             # regenerate dist/ and all plugin runtime archives
npm run test:computer:mac  # opt-in native smoke using a disposable Cocoa fixture
npm run test:mobile        # opt-in Appium tree/PNG smoke; see mobile guide for env setup
npm run test:mobile:android # opt-in disposable Android fixture, MCP recording and replay
npm run test:mobile:ios     # opt-in disposable iOS Simulator fixture, MCP recording and replay
```

The desktop native smoke requires macOS Accessibility and Screen Recording permissions; desktop
Windows and Linux still need native verification on their own hosts. Mobile smoke tests require
the SDKs, running devices and Appium drivers described in the [mobile guide](docs/mobile-use.md#verification).

One root `package.json` and `package-lock.json` own all engines:

```text
package.json                 shared dependencies, CLI binaries and build
src/                         browser, desktop, mobile and shared adapters
dist/                        compiled runtime
plugins/
  plainwright/               browser manifests, skill and launcher
  plainwright-computer/      desktop manifests, skill and launcher
  plainwright-mobile/        mobile manifests, skill and launcher
```

Each plugin includes portable, Claude Code, and Codex compatibility manifests. Both root marketplaces
point at these directories. The build copies the same `runtime.tgz` into each plugin, with a shrinkwrap
derived from the root lockfile. Each plugin installs it into an ignored `.runtime/` cache on first use
and can run independently.

Compiled output and plugin archives are committed; rebuild after source changes.
[CLAUDE.md](CLAUDE.md) describes the architecture and contributor conventions.

## License

[MIT](LICENSE)
