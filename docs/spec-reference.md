# Spec reference

This page describes browser specs. [Desktop specs](computer-use.md#desktop-specs) use `app`
instead of `url`; [mobile specs](mobile-use.md#mobile-specs) use `platform`, `device` and `app`.
All three engines support `tags`, `timeout`, and reusable `include` flows.

A spec is one YAML file: a name, a start URL, optional settings, and a list of steps run in order.

Specs are validated with Zod when loaded. Invalid fields report the source file and, for steps,
the zero-based step index. Mapping fields must be objects, and coordinates must be finite numbers.

```yaml
name: login works                        # label in the report
url: https://the-internet.herokuapp.com  # base for relative `goto`
dialogs: accept                          # accept | dismiss, default accept
auth: { user: $BASIC_USER, pass: $BASIC_PASS }
geolocation: { lat: 48.85, lon: 2.35 }
env: { path: /login }
hooks: ./hooks/dataset.mjs
tags: [smoke, login]
timeout: 120000                         # whole-attempt budget in ms
steps:
  - goto: "${env.path}"
  - click: the Login button
```

## Top-level keys

| Key | Meaning |
|---|---|
| `name` | Label in the report. |
| `url` | Start URL. Relative `goto` paths resolve against it. May contain `${env.*}` and `${hooks.*}`. |
| `goal` | Optional. What the whole flow is for, in one sentence. Every pick sees it, so a vague target (`the comments link`) picks the element the flow is about; the target's words win when they disagree. Claims (`expect`, `wait`) never see it. Desktop and mobile specs take it too. |
| `dialogs` | How `alert`, `confirm` and `prompt` are answered: `accept` (default) or `dismiss`. Each dialog is logged on the step that fired it. |
| `auth` | `{ user, pass }` HTTP credentials for Basic or Digest prompts. |
| `geolocation` | `{ lat, lon }` emulates a GPS position and grants the `geolocation` permission. |
| `env` | Static data for the spec, nested as you like. Used in steps as `${env.*}`. |
| `hooks` | Path, relative to the spec file, of a setup/teardown module. See [hooks.md](hooks.md). |
| `tags` | Optional string or list, e.g. `smoke` or `[smoke, checkout]`. `--tag` requires all requested tags. |
| `timeout` | Optional positive safe integer in milliseconds; whole-attempt budget, overriding `--spec-timeout`. No whole-attempt cap by default. |
| `browser` | Optional browser-context settings; see below. Desktop/mobile reject this block. |
| `steps` | A nonempty list of steps, run in order, including reusable `include` flows. |

**`$VAR` values.** A leaf string starting with `$` in `auth` or in nested `env` mappings is replaced by
`process.env.VAR` when the spec loads. A missing variable is an error that names it. This is how a
credential stays out of the file. Array contents are not walked for `$VAR` references.
`geolocation` takes numeric coordinates directly.

### Browser context

```yaml
browser:
  device: iPhone 15
  viewport: {width: 1280, height: 800}
  locale: it-IT
  timezone: Europe/Rome
  colorScheme: dark
  storageState: ./.auth/user.json
  saveState: ./.auth/user.json
```

| Key | Meaning |
| --- | --- |
| `viewport` | `{width, height}` in pixels, both positive integers; overrides the device viewport. |
| `device` | An exact Playwright device name, e.g. `iPhone 15`; sets viewport, user agent, touch and scale. Explicit browser keys override the preset. The CLI still launches Chromium by default. |
| `locale` | Context locale, e.g. `it-IT`. |
| `timezone` | Context timezone, e.g. `Europe/Rome`. |
| `colorScheme` | `light` or `dark`. |
| `storageState` | Load JSON cookies/localStorage into a fresh context. Incompatible with `--profile`. |
| `saveState` | Write cookies/localStorage after the attempt and teardown pass, creating parent folders. A non-passing attempt never creates or overwrites it. A save error makes the attempt `error`. |

State paths resolve relative to the spec file. Run a login spec with `saveState`
first, then specs with `storageState`; there is no dependency ordering between
specs. Missing input state fails at session open with
`storageState file not found: <path> (run the spec that saves it first)`.
Using the same input/output path requires an existing file on the first run.
State files can contain credentials; keep `.auth/` or your chosen path out of
version control.

`--cdp` rejects any nonempty `browser:` block, as well as `auth` and `geolocation`,
because it attaches to an existing context. An empty browser block is allowed.
`--profile` supports device, viewport, locale, timezone, color scheme and
`saveState`, but cannot load `storageState`.

### Timeouts

`--timeout MS` is the per-action timeout (default `15000`; browser `0` disables
it). `timeout:` or `--spec-timeout MS` sets a separate budget for each attempt;
a retry receives a fresh budget. Opening, setup hooks and observer calls consume
it. Each step races the remaining time. Expiration reports `error` with
`spec timeout after <ms> ms`, even for an optional step, and no later step starts.

The deadline is enforced at steps: opening and setup finish before it is checked,
and teardown and session cleanup may finish after it. Closing the browser context
or mobile session stops the interrupted action; a desktop action already running
can finish, while an action that has not yet started is refused. It is not a hard
wall-clock limit on the whole process.

## Steps

A step is a mapping with one key, the step kind, plus an optional `optional: true`. Targeted actions
take a **target**: a sentence Jev resolves to one element, or `css=<selector>` to skip Jev and use
the selector directly.

### Reusable flows

Use `include` to share login or setup steps across specs on any engine:

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

`flows/login.yaml` contains only `steps:`:

```yaml
steps:
  - fill: {target: the Username field, value: '${env.user}'}
  - fill: {target: the Password field, value: '${env.password}'}
  - click: the Login button
```

Includes expand at load time before step validation. Paths resolve relative to the
including file; nested includes are allowed and cycles report the full chain.
Included placeholders use the root spec’s `env`/`hooks`. Other step paths, such as
`upload.files`, still resolve relative to the root spec. Included files have no
`env`, `hooks`, name or target settings of their own. Keep them outside directories
or globs passed as spec inputs.

Results label the actual source file, e.g.
`flows/login.yaml › click "the Login button"`; load errors name its source step
index. `origin` is reserved for the loader. `optional: true` on an include is
unsupported; individual included steps may be optional. `include` is a YAML
loader feature and cannot be sent to MCP `step`/`batch` or produced by `save`.

### Actions

| Step | Form | Notes |
|---|---|---|
| `goto` | `goto: /path` or a full URL | Relative paths resolve against `url`. |
| `click` | `click: <target>` | May navigate or open a popup. |
| `dblclick`, `rightclick` | `dblclick: <target>` | Same rules as `click`. |
| `fill` | `fill: { target, value }` | Types into the field. |
| `press` | `press: Enter` | A Playwright key name, sent to the focused element. |
| `hover` | `hover: <target>` | Candidates also include `img`, `svg` and `figure`. |
| `select` | `select: { target, value }` | Native `<select>`. Tries the option's label, then its value. |
| `check`, `uncheck` | `check: <target>` | Makes the target selected, or not. Checkboxes and radios (through their label when the input has no size), `role=checkbox|radio|switch|menuitemcheckbox`, and toggle buttons with `aria-pressed`. The state is read first: a no-op when already right, an error when the click did not change it. A chip with no state is a `click`. |
| `upload` | `upload: { target, files: [...] }` | An `input[type=file]`. Paths resolve relative to the spec file. |
| `scroll` | `scroll: <target>`, `top` or `bottom` | `top` and `bottom` (also written `the bottom of the page`) scroll the document and report the distance in `detail`. `did not move` means the content scrolls inside an element: scroll that element instead. Anything else scrolls that element into view. |
| `drag` | `drag: { source, target }` | Both resolved like `click` targets in one Jev request, then dragged with a manual hover, mouse down, hover, mouse up sequence so native HTML5 drag-and-drop works. |
| `mouse` | `mouse: { x, y }` | Moves the mouse to a page position. `y` may be negative, for example to trigger an exit-intent handler above the viewport. |

### Checks

| Step | Form | Notes |
|---|---|---|
| `expect` | `expect: <claim>` | Judged against a snapshot of the settled page. |
| | `expect: [claim, claim]` | Several claims, one snapshot, one Jev request. The step fails if any claim fails, is inconclusive if any is inconclusive and none failed, otherwise passes. |
| | `expect: { that: <claim or list>, within: <target> }` | Judges only that region's accessibility tree (`main`, `dialog`, `form`, `table`, `[role=region]`...). Useful once a page has more than one thing going on. |
| `wait` | `wait: <claim>` or `wait: { that, within }` | Asks the claim every 1.5 s, up to 8 times, until it holds or the step timeout runs out; a poll that sees the same page after a clear no skips the model. `within` picks the region once and polls only its tree: on a large page it costs less per poll (Wikipedia 17k → 10k tokens), and it is picked again if it re-renders. |
| | `wait: css=<selector>` | Waits until the selector is visible. |

### When a step looks at the page

Every step that asks Jev acts on, or judges, a *settled* page: the DOM has not changed for 150 ms (counted from the load event: the parser building the page does not count) and
no xhr/fetch that started in the last 2 s is still in flight (an older request is a long poll or a
stream and stops counting), with a 3 s cap. The step does not wait idle for that: it looks at the page
at once and sends Jev that early look while the page settles. The answer is used only if the page did
not change meanwhile (or a second look gives Jev the same input); otherwise the settled page is asked
again. `--timing` shows that as `reasked=1`. The early answer's tokens still count, so a page that keeps
changing costs more tokens but never acts on a stale answer.

After an action, `click`, `dblclick`, `rightclick` and `press` wait until the page is quiet for 50 ms
(or a navigation they started has loaded), and the page counts as settled only 200 ms after the action,
so a request the click starts a little later is still waited for. `fill` waits for 200 ms of quiet, and
the page counts as settled only 500 ms after typing, for a debounced autocomplete or validation request.
The next step waits out the rest of that time, overlapped with its own Jev call. A new tab the action
opens keeps the next step waiting until it has loaded and become the active page.

A spec run reuses the element Jev picked in the last passing run while the page still has exactly one
element that matches it, without a Jev call (`(cached pick)` in the step detail). The choices live in
`*.picks.json` next to each spec and flow file: see the [pick cache](running.md#pick-cache).

### `optional: true`

Turns an `inconclusive` or `error` result into `skipped` and the run continues. Use it for things that
may or may not appear, like a cookie banner.

## Outcomes

| Status | Symbol | Meaning |
|---|---|---|
| `pass` | `✔` | The action or assertion passed. |
| `fail` | `✘` | Jev is confident the claim does not hold. |
| `inconclusive` | `?` | Jev is not sure: a pick below the acceptance threshold, or a claim in the grey zone, or a `css=` target that matches several elements. `detail` lists the top guesses and the path of a JSON dump of what Jev saw. |
| `error` | `✘` | An exception: a timeout, a `css=` target that matched nothing, a navigation failure. |
| `skipped` | `»` | An `optional` step that was inconclusive or errored; at suite level, a spec never started because of bail or the token budget. |

An attempt stops on the first non-pass step other than an optional skip; teardown
errors make it `error`. Optional skips alone do not prevent a passing attempt.
With retries, the spec uses its last completed attempt’s status. A pass on a retry
has `flaky: true`, a separate flag rather than a step status; it counts as passing
for the exit code. The CLI exits `0` when every reported spec passes, `1` otherwise,
and `2` for invocation/config/provider errors. An empty selection passes.
See [running suites](running.md) for retries and stop rules, and the
[phrasing guide](phrasing.md#how-jev-decides) for judgment thresholds.

### Reports and artifacts

Browser output defaults to `text`; desktop/mobile default to `jsonl`. Use
`--reporter junit:out/junit.xml` or `--reporter json:out/run.json` for CI and
`--artifacts plainwright-results` for evidence capture. Reporters alone do not
capture artifacts. See [reporting](reporting.md) for formats and flaky results,
and [artifacts](artifacts.md) for screenshots, browser traces and debug dumps.

## What Jev can see

Jev gets the page's accessibility tree (capped at 60k characters; a larger tree is halved, with a
warning) and, for `expect` and `wait`, a run-level `events` list (the last 30) covering things the tree
never shows:

- dialogs, and how they were answered
- popups and new tabs. A new tab becomes the active page for every following step, with dialog,
  download and error capture attached to it. Closing the browser closes every tab.
- downloads, saved to a fresh per-session directory under `$TMPDIR/plainwright-downloads-*/<suggested filename>`
- uncaught page errors and the page's own `console.error` messages. Console errors about resources
  the browser blocked or failed to load (CSP violations, `Failed to load resource`, `net::ERR_*`) and
  errors logged by another site's script (ads, trackers) are left out: Jev never sees them, and step
  `notes` count them in one line (`console: 96 errors from other sites or blocked resources …`).

Each message is cut to 300 characters (the full length is noted), and a message repeated back to back
is kept once with a count, `(×3)`. Step `notes` follow the same rules.

So `expect: a file was downloaded` and `expect: a JavaScript error happened` are answerable.

## Placeholders

`${env.*}` and `${hooks.*}` are replaced in `url` and in every step string (`fill.value`, `click`,
`expect`, ...). An unresolved placeholder, or any other namespace, fails the run before the first step
and names the exact `${...}` text.
