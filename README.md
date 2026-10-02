<p align="center">
  <img src="docs/banner.jpg" alt="plainwright: end-to-end browser tests written in plain English. A YAML step, click: the login button, goes through a semantic decision model that reads the page's accessibility tree and clicks the Login button." width="100%" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node 22 or newer" />
  <img src="https://img.shields.io/badge/browser-Playwright-45ba4b.svg" alt="Driven by Playwright" />
</p>

Write browser, desktop and mobile tests in plain English. Run the YAML specs from the command line. Or let a
coding agent explore a flow through MCP and save it as a spec.

[Jev](https://typesafe.ai), a small decision model, selects the element that a target describes and judges each
claim. Jev reads the accessibility tree, not screenshots. Playwright, xa11y or Appium do the actions.

<p align="center">
  <a href="docs/media/plainwright-explainer.mp4"><img src="docs/media/plainwright-explainer.jpg" alt="Video: plainwright, explained in 6 minutes. A click step, the login button, with Jev's probability for each candidate on the page; the Login button wins at 0.95." width="80%" /></a>
  <br />
  <sub><a href="docs/media/plainwright-explainer.mp4">Watch the 6-minute explainer</a>: plain-English specs, how Jev selects and judges, the three engines, agent mode, the pick cache, what Jev costs, and how it compares with a classic test framework.</sub>
</p>

| | Browser | Desktop | Mobile |
|---|---|---|---|
| Plugin and CLI | `plainwright` | `plainwright-computer` | `plainwright-mobile` |
| Actions by | [Playwright](https://playwright.dev) | [xa11y](https://xa11y.dev) | [Appium](https://appium.io) |
| Spec target | `url`: a website | `app`: a running application | `platform`, `device`, `app`: an installed app |
| Platforms | Chromium or Chrome | macOS (tested), Windows, Linux | iOS, Android, React Native |

## Quick start

You need Node 22 or newer, npm, and a [TypeSafe](https://typesafe.ai) API key (a Vercel AI Gateway key also works).

1. Put the key in `~/.config/plainwright/.env`. All plugins and CLIs read this file.

   ```dotenv
   TYPESAFE_API_KEY=<your key>
   ```

2. Install the browser plugin in your coding agent. In Claude Code:

   ```sh
   /plugin marketplace add gabe4coding/plainwright
   /plugin install plainwright@plainwright-marketplace
   ```

   In Codex:

   ```sh
   codex plugin marketplace add gabe4coding/plainwright
   codex plugin add plainwright@plainwright-marketplace
   ```

3. To run a spec from the command line, clone the repository and run an example. On the first run, the
   launcher installs the dependencies and Chromium.

   ```sh
   git clone https://github.com/gabe4coding/plainwright.git
   cd plainwright
   node bin/plainwright.mjs examples/todo.yaml
   ```

[Getting started](docs/getting-started.mdx) shows the desktop and mobile plugins, the key options and all
environment variables.

## A spec

A spec names its target and lists its steps. A browser spec starts with `goto`: `url` is only the base for `goto`.

```yaml
name: add a todo
url: https://demo.playwright.dev/todomvc
steps:
  - goto: /
  - fill: { target: "the new todo input", value: "buy milk" }
  - press: Enter
  - expect: "a todo item named 'buy milk' is listed"
```

Describe each element by its role and visible text. Write each claim as a specific statement about the
current state. The [phrasing guide](docs/phrasing.mdx) shows how.

In a [comparison on six browser workflows](docs/performance.mdx), an agent with plainwright used 25–52% less
time than with Playwright MCP. The API cost changed from 24% lower to 7% higher, by model.

## Documentation

| Guide | Contents |
|---|---|
| [Getting started](docs/getting-started.mdx) | Requirements, API key, plugin install, first specs, environment variables. |
| [Spec reference](docs/spec-reference.mdx) | Spec format, browser steps, reusable flows, browser context, login state. |
| [Phrasing](docs/phrasing.mdx) | Targets, claims, thresholds, inconclusive results. |
| [Hooks](docs/hooks.mdx) | Setup and teardown, test data in `${hooks.*}`. |
| [Running suites](docs/running.mdx) | CLI flags, config file, selection, retries, pick cache, exit codes. |
| [Reporting](docs/reporting.mdx) | Text, JSONL, JUnit and JSON output. |
| [Artifacts](docs/artifacts.mdx) | Screenshots, traces, debug dumps. |
| [CI and containers](docs/ci.mdx) | GitHub Action, GitLab, Docker. |
| [Agent mode](docs/agent-mode.mdx) | Browser MCP tools, `save`, your real browser. |
| [Snapshots](docs/snapshots.mdx) | Raw, compact and smart snapshot modes. |
| [Desktop](docs/computer-use.mdx) | Desktop setup, permissions, specs and tools. |
| [Mobile](docs/mobile-use.mdx) | Appium setup, mobile specs, gestures and tools. |
| [Performance](docs/performance.mdx) | Measured cost and speed, links to the benchmark reports. |
| [Development](docs/development.mdx) | Build, tests, native smoke tests, plugin packaging. |

## Usage rules

- Use plainwright on test environments only. Stop before the last irreversible step: payment, booking, sending.
- Do not put literal credentials in a spec. Use environment references or hooks.
- Do not use plainwright to bypass bot protection.

## License

[MIT](LICENSE)
