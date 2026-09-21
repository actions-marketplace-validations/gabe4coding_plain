# Mobile use

`plainwright-mobile` drives installed native iOS and Android apps, including React Native,
through Appium. Jev selects controls and judges claims from the native UI tree. Interactive
MCP authoring and YAML replay use the same adapter and session implementation.

## Setup

Requirements: Node 22+, npm, a running Appium server, a booted simulator/emulator or connected
test device, and the test application already installed. Plainwright uses WebdriverIO 9.31.4 as
the client; Appium and its platform drivers are managed separately on the automation host.
The mobile plugin does not install Chromium, launch emulators, install apps, or reset app data.

```sh
npm install -g appium
appium driver install uiautomator2 # Android host: Android SDK, Java and adb
appium driver install xcuitest    # iOS host: macOS and Xcode
appium                           # default http://127.0.0.1:4723
```

Install only the drivers for the platforms you use. Match the installed Appium, driver, SDK and
OS versions using the upstream [Android requirements](https://github.com/appium/appium-uiautomator2-driver)
and [iOS requirements](https://appium.github.io/appium-xcuitest-driver/latest/getting-started/requirements/).
Run `appium driver doctor uiautomator2` or `appium driver doctor xcuitest` for setup diagnostics.
Physical iPhones require a provisioned/signed WebDriverAgent; see
[iOS provisioning](https://appium.github.io/appium-xcuitest-driver/latest/getting-started/provisioning-profile/).
Appium can run on a different host from Plainwright.

Find the explicit device ID using `adb devices -l` (Android), `xcrun simctl list devices booted`
(iOS Simulator), or Xcode's Devices window (physical iOS). Plainwright requires this ID and never
chooses an arbitrary connected device. Use dedicated test devices; screen actions also reach
system dialogs and keyboards. Each device must have only one active automation session.

From this checkout:

```sh
npm ci
npm run build
node bin/plainwright-mobile.mjs mcp
node bin/plainwright-mobile.mjs --server http://127.0.0.1:4723 --timeout 15000 path/to/mobile.yaml
```

`--server` overrides `PLAINWRIGHT_APPIUM_URL`, which defaults to `http://127.0.0.1:4723`.
Base paths such as `/wd/hub` are supported. Endpoint URLs cannot contain credentials, queries
or fragments. This initial adapter targets native contexts; webview context switching and
authenticated device-cloud connections are not provided.

Environment loading follows the other CLIs: existing process variables win, then cwd `.env`,
then `~/.config/plainwright/.env` (respecting `XDG_CONFIG_HOME`). Targeting/assertions require
`TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY`, with optional `JEV_PROVIDER=typesafe|gateway`.
MCP discovery, `list_devices`, `list_apps`, `open`, unscoped raw/compact `snapshot`, `screenshot` and
`close` need no model key. Smart snapshots use Jev for classification, falling back explicitly
to compact evidence if unavailable.

## Plugin formats

`plugins/plainwright-mobile/` follows the browser and computer plugin format:

- Portable `plugin.json` and `mcp.json` (cwd `${PLUGIN_ROOT}`).
- Claude Code `.claude-plugin/plugin.json` and `.mcp.json` (launcher `${CLAUDE_PLUGIN_ROOT}/bin/launch.mjs`).
- Codex `.codex-plugin/plugin.json`, using the same `.mcp.json` and `skills/`.
- Generated `runtime.tgz`, `bin/launch.mjs` and license.

Both repository marketplaces list the new plugin. After making this branch available to your
marketplace host, install `plainwright-mobile@plainwright-marketplace`. To try this checkout
directly with Claude Code:

```sh
claude --plugin-dir /absolute/path/to/plainwright/plugins/plainwright-mobile
```

Or start `node plugins/plainwright-mobile/bin/launch.mjs mcp` from any MCP client. First use
installs the shared runtime in an ignored `.runtime/` cache by archive hash. One root manifest
and lockfile own all dependencies; each plugin contains the same standalone runtime archive.
Builds do not install or replace plugins in your personal plugin cache.

## Agent tools

All nine tools are serialized, including reads, so a snapshot cannot race another MCP action.

| Tool | Purpose |
|---|---|
| `list_devices {platform?}` | Discover connected Android devices/emulators and available iOS simulators on the MCP host. Returns `device`, `platform`, name, type, state and `ready`, plus per-platform setup errors. No session required. |
| `list_apps {platform, device, query?, include_system?, offset?, limit?}` | List installed app IDs on an explicit ready local device. iOS also returns display names; Android returns package IDs, including packages without a launchable UI. Case-insensitive search matches ID/name. `include_system` defaults true, `offset` 0 and `limit` 100 (max 500). Pass `nextOffset` to retrieve another page; `total` counts filtered matches. |
| `open {platform, device, app, capabilities?, hooks?}` | Launch/activate an installed app. `platform` is `ios` or `android`; `device` is a UDID/ADB serial; `app` is a bundle ID/package. Starts a new recording and tears down the old session. |
| `step {step}` | Execute one YAML-style action or assertion; return status, detail, timing and Jev tokens. |
| `find {kind, target}` | Resolve without acting. Kinds: `click`, `fill`, `check`, `region`, `scroll`. Use `click` for tap/longpress targets. |
| `snapshot {within?, maxChars?, mode?, intent?}` | Raw text by default (20,000 chars); `compact`/`smart` default to 6,000. Maximum 60,000. Scoped reads resolve a region with Jev. Smart-only `intent` filters to relevant UI regions plus critical messages. See [snapshot views](snapshots.md). |
| `screenshot {}` | Return a device PNG for inspection; pixels are not supplied to Jev. |
| `save {path, name?}` | Write passing recorded steps with platform, device, app, capabilities and relative hooks path. Rejects empty recordings. |
| `close {}` | Run teardown and delete the Appium session. Does not uninstall or clear app data. |

Start with `list_devices`, select the intended ready device, then call `list_apps` with its
`platform` and `device`. Copy the returned `app` identifier into `open`. Discovery does not
launch apps, boot devices, create Appium sessions, or modify recordings. ADB may start its
local host daemon if it is not already running.

Discovery returns `scope: "local"`: it uses SDK tools on the **MCP process host**, independent
of the Appium URL. Android uses ADB from `ANDROID_HOME`/`ANDROID_SDK_ROOT`, a conventional SDK
location, or `PATH`. iOS uses Xcode's `xcrun simctl` and macOS `plutil`. Missing SDKs or failed
device queries appear in `list_devices.errors`, while results from the other platform remain
available. App lookup failures are tool errors, not empty successful lists. Unavailable simulator
runtimes are excluded; shut-down simulators are listed with `ready: false`.

Discovery currently covers Android devices/emulators and iOS simulators. For **physical
iPhones or remote Appium hosts**, obtain the device/app IDs on that host and pass them directly
to `open`; these two discovery tools do not enumerate them. Installed packages are not a promise
that each package has a launchable, accessible UI.

`open` accepts extra vendor-prefixed capabilities for details such as `appium:appActivity` on
Android or `appium:xcodeOrgId` / `appium:xcodeSigningId` on iOS. Platform, driver, device, app,
reset, launch and native-context capabilities are managed by Plainwright and cannot be overridden.
Plainwright sets `noReset: true` and explicitly activates the app. Platform lifecycle behavior
still depends on the installed Appium driver. It does not reset the app between replay runs;
prepare the starting screen/data in hooks or explicit test steps.

## Mobile specs

This example assumes an installed test app exposing the described controls. Supply your app's
package/bundle ID and device, or resolve them through an `env` block:

```yaml
name: Preview a message
platform: android
device: "${env.device}"
app: "${env.app}"
env:
  device: $TEST_DEVICE
  app: $TEST_APP
  message: $TEST_MESSAGE
steps:
  - fill: {target: "the Message text field", value: "${env.message}"}
  - check: "the Enable preview switch"
  - tap: "the Preview button"
  - expect: "The preview contains the test message"
```

For iOS, use `platform: ios`, an iOS UDID and bundle ID. Steps can be shared when both versions
expose equivalent flows; platform-specific navigation and accessibility differences still need
verification on each platform. Unknown top-level keys and unsupported actions fail explicitly.

| Step | Behavior |
|---|---|
| `tap: "the button"`, `click: "the button"` | Tap a Jev-selected native element. |
| `fill: {target: "Email", value: "${env.email}"}` | Clear and replace text in an input. On iOS picker wheels, select the requested value without clearing; values follow the control's native format. |
| `longpress: "the row"` | Hold a selected element for one second. |
| `dblclick: "the image"` | Native double tap. |
| `check`, `uncheck` | Read Android `checked` or iOS switch `value` and tap only if needed. Unknown/mixed states error. |
| `scroll: "down: the results list"` | One scroll gesture in the selected container; directions up/down/left/right navigate content. Does not promise to reach the end. |
| `swipe: left` | One finger swipe across the screen, in the named finger direction. |
| `swipe: {direction: up, within: "the carousel"}` | Swipe within a Jev-selected region. |
| `press: Home` / `HideKeyboard` | Platform device/keyboard action. Dismissing a keyboard can fail when the platform cannot dismiss it. |
| `press: Back` / `Enter` | Android only; iOS returns an error. On iOS tap the visible back/keyboard button. |
| `expect: ["claim", "another claim"]` | Judge atomic claims together. Supports `{that, within}` scoping. |
| `wait: "claim"` | Poll until the claim passes, up to eight model calls; unchanged definite negatives are not rejudged. |

`goto`, `select`, `upload`, `hover`, `rightclick`, `mouse`, `drag`, and `css=` are unsupported.
Operate native menus and pickers via their visible controls. `optional: true` converts errors
and inconclusive results to skipped; an explicit failed assertion still fails.

Picks require confidence >= 0.5 (probability fallback); assertions pass at p >= 0.9, fail at
p <= 0.1, otherwise are inconclusive. Captures cap at 5,000 nodes / 32 levels, 1,016 candidates
and 60,000 text characters. Truncation is reported; source XML above 5 MB is rejected.
Native source is normalized with names, types, values and states. React Native pressable parents
can inherit their children's labels. Controls hidden or disabled in the native tree are excluded
from actionable candidates. On iOS, a control's explicit visibility is respected even when a
layout ancestor reports invisible; hidden layout nodes do not hide visible descendants.
Android visibility remains inherited. Jev does not see React component internals, DOM selectors or pixels.
Custom canvas controls require accessibility support in the app.

The adapter checks a selected node's path and identity against a fresh tree before resolving its
Appium handle. UI changes return an error rather than acting on a changed target. As with native
automation generally, UI can still change between a check and an action. Inspect state after an
error before retrying; text clearing or another input may already have taken effect. Transport
retries are disabled to avoid automatically repeating side effects. Driver/native commands and
model retries may outlast the polling deadline; `--timeout` also sets the HTTP request timeout.

## Hooks, recording and results

`hooks: ./hooks/fixture.mjs` uses the existing isolated [hooks contract](hooks.md). Setup runs
before opening the device session. `${env.*}` and `${hooks.*}` interpolate device, app,
capabilities and steps for file replay. A successful setup always gets teardown, even after an
open/action failure. A setup failure skips teardown. Teardown and session-close failures make
the run error, and session cleanup is attempted in all cases.

MCP exposes `${hooks.*}` only. Use hook placeholders for credentials and other dynamic data;
`save` preserves them in steps and target settings and makes the hooks path relative to the
saved file. Reads and failed/inconclusive/skipped attempts are not recorded. Never place literal
credentials in specs or recorded tool arguments. Opening again starts a new recording.

Batch replay runs files sequentially and prints one JSON result per spec. Exit 0 means all
passed; 1 means failure/error/inconclusive; 2 means CLI usage/provider configuration errors.
Results use the shared statuses, timing, debug dumps in `$TMPDIR/plainwright/` and token counts.

## Verification

For complete YAML examples, see [examples/mobile](../examples/mobile/README.md):
[Android](../examples/mobile/android.yaml) and [iOS Simulator](../examples/mobile/ios.yaml).
Their hooks build, install and clean up the offline fixture automatically; run them with the
mobile CLI and a configured Jev provider. They share the fixture installer used by the native
smoke commands below.

The same directory includes recorded Contacts and Calendar flows. Their app-specific starting
conditions and manual data cleanup are documented in the [example guide](../examples/mobile/README.md#recorded-app-flows).
Use the disposable fixtures above for repeatable smoke testing.

`npm test` includes mobile parser/session tests with injected intelligence, isolated hooks,
MCP recording-to-replay tests, native XML fixtures, and actual WebdriverIO HTTP requests against
a local Appium-protocol fixture for both platforms. These tests require neither a model key
nor native SDKs. They do not establish physical-device or simulator compatibility by themselves.

An opt-in connection/tree/PNG smoke runs against your installed test app without a model key:

```sh
PLAINWRIGHT_MOBILE_PLATFORM=android \
PLAINWRIGHT_MOBILE_DEVICE=emulator-5554 \
PLAINWRIGHT_MOBILE_APP=com.example.fixture \
npm run test:mobile
```

Use `ios` and its UDID/bundle ID for iOS. `PLAINWRIGHT_MOBILE_CAPABILITIES` optionally supplies
a JSON capability object for this smoke; `PLAINWRIGHT_APPIUM_URL` selects the server. This
smoke verifies connection, tree and screenshot only. Validate taps, input, gestures and a full
record/save/replay flow on each target OS/device before claiming native parity.

### Disposable Android fixture

For Android, the repository also builds and temporarily installs a small offline native fixture.
It exercises real text entry, idempotent check/uncheck, tap, long press, scrolling, swipe,
screenshots, MCP recording, and replay of the saved YAML after restarting the fixture.
The fixture is uninstalled afterward. It refuses to overwrite an existing fixture installation.

Install Android SDK Platform 36 and Build-Tools 36.0.0, set `ANDROID_HOME` and `JAVA_HOME`, boot
your emulator, and start Appium with UiAutomator2. No Gradle or application project is needed:

```sh
PLAINWRIGHT_MOBILE_DEVICE=emulator-5554 npm run test:mobile:android
# Also exercise the real model using the shared provider configuration:
PLAINWRIGHT_MOBILE_DEVICE=emulator-5554 npm run test:mobile:android -- --live-jev
```

The default run injects deterministic fixture targeting and checks the actual native UI state.
`--live-jev` uses real Jev selections and assertions in both authoring and replay, while retaining
the native state checks. Both modes leave `recorded.yaml`, `report.json` and `preview.png` in a
temporary results directory printed at completion. `PLAINWRIGHT_ANDROID_BUILD_TOOLS` can select
another installed build-tools version; the fixture compiles against Android SDK Platform 36.
This validates native Android controls; it does not establish React Native-specific or iOS parity.

### Disposable iOS Simulator fixture

The iOS smoke builds an offline UIKit fixture with the selected Xcode's simulator SDK, installs
it temporarily, records native actions through MCP, and replays the saved YAML after restarting
the fixture. It refuses to overwrite an existing fixture installation and uninstalls its app
afterward. This test targets simulators; it does not require an Apple developer account.

Install Xcode and an iOS Simulator runtime, finish Xcode's first-launch setup, and select its
developer directory (`xcode-select -p` should point inside Xcode). Install Appium's XCUITest
driver **before** starting the Appium server. Boot an iPhone simulator in Xcode/Simulator, then:

```sh
xcrun simctl list devices booted
PLAINWRIGHT_MOBILE_DEVICE=<simulator-udid> npm run test:mobile:ios
# Also verify real Jev targeting and assertions in authoring and replay:
PLAINWRIGHT_MOBILE_DEVICE=<simulator-udid> npm run test:mobile:ios -- --live-jev
```

The first session builds WebDriverAgent and can take several minutes. The smoke allows four
minutes per Appium request. Set `PLAINWRIGHT_APPIUM_URL` if your server uses a different address
or port. As with Android, the script prints a temporary directory containing `recorded.yaml`,
`report.json` and `preview.png`. No application project, CocoaPods or separate build system is
needed. Simulator success does not establish physical-iPhone or React Native-specific parity.
The iOS fixture dismisses its keyboard by tapping its visible Done key; generic
`press: HideKeyboard` can fail on iPhone, depending on the keyboard and application.
