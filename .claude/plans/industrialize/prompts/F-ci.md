You are lane F (CI and packaging) of the "industrialize plainwright" plan, in the repository at the
root of your working directory. Read `CLAUDE.md` and `.claude/plans/industrialize/contract.md` §5
(the CLI flags that will exist) and §7 (rules). You do not depend on Phase 0: start now.

Branch: create and work on `industrialize/f-ci`, starting from `main`.

## Files you own (edit only these, plus new files you create)

`.github/**`, `Dockerfile`, `.dockerignore`, `action.yml` (repo root), `docs/ci.md` (new).
Do not edit `src/`, `package.json`, the lockfile, README or other docs.

## Your task

1. `.github/workflows/test.yml` for this repo: on pull requests and pushes to `main`;
   `ubuntu-latest`; Node 22 with npm cache; `npm ci`; `npx playwright install --with-deps
   chromium`; `npm test`. No secrets: the regular suite needs no Jev key (see `CLAUDE.md`).
2. A "dist is up to date" check in the same workflow: `npm run build`, then fail if
   `git status --porcelain dist` is not empty, with a message telling the contributor to rebuild and
   commit `dist/`. First check whether `plugins/*/runtime.tgz` is reproducible (build twice on a
   clean checkout and compare hashes). If it is, check it too; if not, leave it out and say so in
   your report (do not change `scripts/build-plugins.mjs`).
3. `Dockerfile`: `FROM mcr.microsoft.com/playwright:v1.63.0-noble` (match the `playwright` version
   in `package-lock.json`; read it there), copy the repo, `npm ci --omit=dev`, use the image's
   browsers (no second Chromium download; check how `bin/plainwright.mjs` and the launcher decide to
   install Chromium and make sure the image does not trigger it — set
   `PLAYWRIGHT_BROWSERS_PATH` if needed), non-root user, `WORKDIR /work`,
   `ENTRYPOINT ["node", "/app/dist/cli.js", "--headless"]`. `.dockerignore` excludes
   `node_modules`, `.git`, `.claude`, `plugins/*/.runtime`, `.env`. Build it locally if Docker is
   available and run `docker run --rm plainwright --help`-style smoke (the CLI prints usage and exits
   2 without spec files; that is the expected result). If Docker is not available, say so.
4. `action.yml`: a composite GitHub Action for other repos.
   Inputs: `specs` (required; files, folders or globs), `args` (extra CLI flags, default `''`),
   `junit` (default `plainwright-results/junit.xml`), `artifacts` (default `plainwright-results`),
   `node-version` (default `22`). Steps: setup-node; `npm ci --omit=dev` in
   `${{ github.action_path }}`; `npx playwright install --with-deps chromium` from there; run
   `node ${{ github.action_path }}/dist/cli.js --headless --reporter text --reporter
   junit:${{ inputs.junit }} --artifacts ${{ inputs.artifacts }} ${{ inputs.args }} ${{ inputs.specs }}`;
   upload `${{ inputs.artifacts }}` with `actions/upload-artifact@v4` when the run fails
   (`if: failure()`). The API key comes from the caller's env (`TYPESAFE_API_KEY` or
   `AI_GATEWAY_API_KEY` as secrets); never echo it. Note: `--reporter` and `--artifacts` only work
   after lanes A and B merge; write the action for the final flags anyway.
   Pass inputs to `run:` through `env:` variables, not inline `${{ }}` in the script, to avoid
   script injection.
5. Pin third-party actions to a major version tag (`actions/checkout@v4`, `actions/setup-node@v4`,
   `actions/upload-artifact@v4`).
6. `docs/ci.md`: the action (minimal and full examples with secrets), the Docker image (`docker run
   -v $PWD:/work -e TYPESAFE_API_KEY plainwright tests/`), GitLab CI example with
   `artifacts:reports:junit`, and a note that specs must target test environments only (repeat the
   rule from `plugins/plainwright/skills/using-plainwright/SKILL.md`).

## Verification

- `actionlint` if installed (else say so); `yamllint`-clean YAML.
- Run the workflow steps locally where possible (`npm ci`, `npm test`, the dist check).

## Rules

- Edit only the files you own.
- Do NOT commit `dist/` or `plugins/*/runtime.tgz` changes (`git checkout -- dist plugins`).
- Commit on your branch. Do NOT push, open a PR, merge, or publish an image or a release.

## Report back

Branch and SHA, what you verified locally and what you could not, the runtime.tgz reproducibility
result, and the Docker smoke output.
