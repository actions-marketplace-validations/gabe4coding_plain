---
name: using-plainwright-computer
description: Drive and inspect native desktop applications through the plainwright-computer MCP tools, or record and replay desktop YAML tests. Use for computer use on macOS, Windows, or Linux; use the browser plugin for web pages.
---

# Plainwright Computer

xa11y performs native desktop actions. Jev selects accessibility elements and judges claims;
do not replace Jev with your own coordinate guesses. Use this plugin in test environments.
Stop before the final irreversible action (payment, booking, sending), and never bypass bot protection.

## Attach and act

- `apps` lists running applications and their pids without focusing them. `open` attaches by exact
  `app` name or `pid`, never both. It does not launch an app. `activate: true` (default) brings a
  window forward; use `activate: false` for reading without activation.
- `step` accepts one YAML-style action as a JSON object. Describe one unambiguous element using
  accessibility names. `find` is a dry run of Jev targeting, useful when a target is unclear.
- `snapshot` reads the app tree; `within` selects a region. `screenshot` returns a window PNG for
  inspection. Neither reading is recorded. Jev uses accessibility text, not screenshots; a canvas
  with no accessible controls needs application accessibility support, not invented targets.
- On `inconclusive`, rephrase the target or split the claim. After an error, inspect current state
  before retrying an action: a native action can take effect before its error is reported.
- Simulated keys/pointer actions require the attached app to be foreground. If focus changed,
  `open` it again only when the user's task calls for activation. Opening starts a new recording.
- `close` detaches and runs teardown; it leaves the app running.

```yaml
fill: {target: "the Message text field", value: "hello"}
# Other individual step objects:
click: "the Preview button"
check: "the Enable preview checkbox"
uncheck: "the Enable preview checkbox"
hover: "the help icon"
dblclick: "the document icon"
rightclick: "the first row"
scroll: "down: the results list" # up: also supported; one wheel movement, not scroll-to-end
press: "Control+a" # use Meta for Command on macOS; native key names are platform dependent
drag: {source: "the first row", target: "the destination folder"}
expect: ["The preview says hello", "The preview checkbox is checked"]
expect: {that: "The preview says hello", within: "the preview panel"}
wait: "The results are visible"
```

`mouse: {x: 100, y: 100}` uses logical desktop coordinates, only when the user supplies them or
an observed accessibility bound establishes them. Browser `css=`, `goto`, `select`, and `upload`
are unavailable. Operate native menus and file dialogs through their accessible controls.
A pick passes at confidence >= 0.5 (probability when confidence is absent); a claim passes at
p >= 0.9, fails at p <= 0.1, otherwise is inconclusive. `wait` polls up to eight Jev calls within
the configured polling deadline. An in-flight model/native call may outlast that deadline.

## Record and replay

`open` may receive a `hooks` path. Setup runs before attachment and exposes `${hooks.*}` names;
use those placeholders, especially for credentials. `save` writes only passing steps, preserving
placeholders and a relative hooks path. Failed/inconclusive/skipped attempts are omitted. No
`${env.*}` namespace exists in MCP; add an `env` block to a saved YAML spec for batch replay:

```yaml
name: Desktop preview
app: Desktop Test Fixture
env:
  message: $TEST_MESSAGE
steps:
  - fill: {target: "the Message text field", value: "${env.message}"}
  - click: "the Preview button"
  - expect: "The preview contains the test message"
```

Run `node <plugin-root>/bin/launch.mjs <spec.yaml>` (or the
`plainwright-computer` binary in a repository checkout). Desktop specs run sequentially.
Hooks use the same isolated setup/teardown child contract as plainwright. Explicit assertion
failures are never skipped by `optional: true`; only errors/inconclusive results can be skipped.
Never put literal credentials into specs, hook recordings, or tool arguments.

## Setup failures

The shared API key settings are `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY`, optionally
`JEV_PROVIDER=typesafe|gateway`, loaded from cwd `.env` then `~/.config/plainwright/.env`.
MCP can list its tools and read the desktop without a Jev key.
macOS requires the executing host's Accessibility permission and may require Screen Recording
for window content/screenshots. Linux requires an AT-SPI2 desktop; input/screenshot capabilities
vary with the display server. A permission error is actionable setup information: tell the user
which permission the native backend requests. Do not attempt to change OS privacy settings.
