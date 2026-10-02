# Spec features (lane E draft)

These rows are ready to add to the spec reference. Paths below resolve relative to the spec file.

| Key | Engines | Meaning |
| --- | --- | --- |
| `timeout` | Browser, desktop, mobile | Positive whole-spec budget in milliseconds; overrides `--spec-timeout`. No cap by default. |
| Step `include` | Browser, desktop, mobile | Expand a YAML file containing only `steps:`; nesting is allowed and paths resolve relative to the including file. |
| `browser.viewport` | Browser | `{width, height}` in pixels, both positive integers. Overrides the device viewport. |
| `browser.device` | Browser | A Playwright device name, such as `iPhone 15`; applies viewport, user agent, touch and scale settings. Explicit browser keys override the preset. |
| `browser.locale` | Browser | Context locale, such as `it-IT`. |
| `browser.timezone` | Browser | Context timezone, such as `Europe/Rome`. |
| `browser.colorScheme` | Browser | `light` or `dark`. |
| `browser.storageState` | Browser | JSON cookies/localStorage file to load into a fresh context. Run the saving spec first. Incompatible with `--profile`. |
| `browser.saveState` | Browser | Write the context's cookies/localStorage after steps and teardown pass, creating parent folders. A failing run never creates or overwrites this file. |

`--spec-timeout MS` supplies a default budget to every engine. Opening, setup hooks and observer calls consume the budget. Each step races the remaining time; expiration reports `error` with `spec timeout after <ms> ms`, including for optional steps. No subsequent step starts. Teardown still runs and then the session closes: the browser context and a mobile session stop the interrupted action, and a desktop action that has not started yet is refused, but a desktop action already in progress finishes. Setup and teardown keep their existing lifecycle: setup finishes before steps are considered, and cleanup is allowed to finish after the deadline.

With `--cdp`, any non-empty `browser:` block is rejected because its options cannot be applied to an existing context. An empty block is allowed. With `--profile`, device, viewport, locale, timezone and color scheme apply to the persistent context; `saveState` is supported.

## Reusable flows

Root spec:

```yaml
name: Account settings
url: https://test.example
env:
  user: $TEST_USER
  password: $TEST_PASSWORD
steps:
  - include: ./flows/login.yaml
  - click: the Settings link
```

`flows/login.yaml`:

```yaml
steps:
  - fill: {target: the Username field, value: '${env.user}'}
  - fill: {target: the Password field, value: '${env.password}'}
  - click: the Login button
```

Included files may contain only `steps:` and can include other flows. Their `${env.*}` and `${hooks.*}` placeholders resolve against the root spec. Results identify the actual source file, for example `flows/login.yaml › click "the Login button"`. Cycles report the full include chain. User-written `origin` keys are reserved, and `optional: true` on an include is unsupported in v1; individual flow steps may be optional.

## Logged-in state

Add `browser: {saveState: ./.auth/user.json}` to a login spec. After it passes, later specs can use `browser: {storageState: ./.auth/user.json}` to start logged in. The user runs the login spec first; there is no dependency ordering between specs. State is saved only after teardown succeeds. Missing input state fails at session open with `storageState file not found: <path> (run the spec that saves it first)`.

The state file holds session cookies and localStorage, which can contain credentials. Add `.auth/` (or the chosen state path) to your project's `.gitignore` and keep the file out of version control.

`storageState` and `saveState` may name the same file only after a first run has created it: a spec that loads a file which does not exist yet fails at open.
