# CI and containers

The regular `npm test` suite needs no Jev API key. It builds the TypeScript output and runs local tests. The repository's GitHub workflow also checks that `dist/` and the plugin runtime archives match `npm run build`.

Before a live run, validate specs or list the selected ones without a model key
or session:

```sh
node bin/plainwright.mjs validate tests/
node bin/plainwright.mjs --list --tag smoke tests/
```

`validate` warns about absent spec environment variables; `--list` requires them
when loading specs. Keep reusable flow files outside the suite’s spec paths.
[Running suites](running.md) covers config, selection, retries and token budgets.

## GitHub Action

The root `action.yml` runs YAML specs from the caller's checkout. Supply a Jev key as a repository secret. A minimal caller workflow is:

```yaml
name: Browser specs
on: [pull_request]
jobs:
  specs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: gabe4coding/plainwright@main
        with:
          specs: tests/
        env:
          TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
```

### Inputs

| Input | Default | Meaning |
|---|---|---|
| `specs` | required | Space-separated spec files, directories or globs |
| `args` | `''` | Extra CLI flags, added after the action's own flags (so `--picks off` here wins over `picks`) |
| `picks` | `read` | [Pick cache](running.md#pick-cache) mode: `read` reuses the committed `*.picks.json` sidecars and never writes them; `on` or `off` as in the CLI. Empty passes no `--picks`, so `plainwright.config.yaml` or the CLI default (`on`) applies |
| `junit` | `plainwright-results/junit.xml` | JUnit XML path, uploaded on every run. Empty turns off the JUnit reporter and its upload |
| `artifacts` | `plainwright-results` | Directory for failure screenshots and traces, uploaded when the run fails. Empty turns off capture and the upload |
| `artifact-name` | `plainwright-results` | Name of the failure artifact; the JUnit report is uploaded as `<artifact-name>-junit` |
| `node-version` | `22` | Node.js version for `actions/setup-node` |

To set the paths explicitly, or pass extra flags, use `with:`. `args` and `specs` use shell-style quoting for values containing spaces; they are parsed as arguments, never run as a shell script.

```yaml
name: Browser specs
on: [pull_request]
jobs:
  specs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: gabe4coding/plainwright@main
        with:
          specs: 'tests/smoke/ tests/checkout/*.yaml'
          args: '--workers 2 --retries 1'
          picks: read
          junit: plainwright-results/junit.xml
          artifacts: plainwright-results
          node-version: '22'
        env:
          TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
          # Or use AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}
```

### What the action does

1. Installs Node.js, its own locked runtime dependencies and Chromium.
2. Runs `plainwright --headless --reporter text`, plus `--picks <picks>`, `--reporter junit:<junit>` and `--artifacts <artifacts>` for each of those inputs that is not empty, then `args`, then `specs`. The step fails when a spec does not pass.
3. Uploads the JUnit file as the `<artifact-name>-junit` artifact on every run, passed or failed, when `junit` is set. A run that stops before writing it (for example a missing key) gives a warning, not an error.
4. Uploads the `artifacts` directory as the `<artifact-name>` artifact only when the run fails, and only when `artifacts` is set. With the default paths the JUnit file is inside this directory, so it is in both artifacts.

With the default `picks: read`, a CI run reuses committed picks and leaves the working tree unchanged. To refresh the sidecars, run with `on` locally and commit them. Artifact names must be unique in a workflow run, so in a matrix give each job its own `artifact-name` (for example `plainwright-results-${{ matrix.site }}`). See [reporting](reporting.md) and [artifacts](artifacts.md) for formats and capture defaults.

The action uploads the JUnit file but does not publish it as a check. To see results on the pull request, add a JUnit reporter action after it, with `if: ${{ !cancelled() }}` and the same `junit` path; such actions usually need `permissions: checks: write`.

## Docker

The image uses Playwright 1.63.0's bundled Chromium and runs as `pwuser`. Build and run it from the Plainwright repository:

```sh
docker build -t plainwright .
docker run --rm -v "$PWD:/work" -e TYPESAFE_API_KEY plainwright tests/
```

The mounted directory is the spec working directory. Set `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY` in the host environment and pass only the variable name with `-e`; keep credentials out of spec files and image layers. Running without spec files prints usage and exits 2.

## GitLab CI

For a repository with Plainwright source and a `tests/` directory, this job saves the JUnit report and failure artifacts:

```yaml
browser-specs:
  image: mcr.microsoft.com/playwright:v1.63.0-noble
  variables:
    PLAYWRIGHT_BROWSERS_PATH: /ms-playwright
  script:
    - npm ci
    - node dist/cli.js --headless --picks read --reporter text --reporter junit:plainwright-results/junit.xml --artifacts plainwright-results tests/
  artifacts:
    when: always
    paths:
      - plainwright-results/
    reports:
      junit: plainwright-results/junit.xml
```

Configure `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY` as a masked CI variable for live specs.

Point specs at test environments only, stop before the last irreversible step (payment, booking, sending), and never bypass bot protection.
