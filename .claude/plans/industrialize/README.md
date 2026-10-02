# Industrialize plainwright: plan

Make the YAML test runner ready for CI and for teams: machine-readable reports, failure artifacts,
retries, test selection, config, reusable flows, browser context settings, and CI packaging.

- [contract.md](contract.md): the Phase 0 interfaces, file ownership and lane rules. Every agent
  reads it first.
- [prompts/](prompts/): one prompt per agent, ready to paste.

## Phases and order

```
F (CI) ───────────────────────────────────────────────┐
Phase 0 (contract) ──► A  B  C  D  E (parallel) ──────┼──► integrate ──► G (docs) ──► P2 (pick cache)
                                                      ┘
```

| Prompt | Agent | Branch | Starts from | Can run with |
|---|---|---|---|---|
| [00-phase0.md](prompts/00-phase0.md) | Phase 0: shared suite runner | `industrialize/phase0` | `main` (with this plan) | F |
| [F-ci.md](prompts/F-ci.md) | CI and packaging | `industrialize/f-ci` | `main` | everything |
| [A-reporting.md](prompts/A-reporting.md) | JUnit / JSON reporters, totals | `industrialize/a-reporting` | Phase 0 merged | B C D E F |
| [B-artifacts.md](prompts/B-artifacts.md) | Screenshots, traces, dumps | `industrialize/b-artifacts` | Phase 0 merged | A C D E F |
| [C-scheduling.md](prompts/C-scheduling.md) | Retries, flaky, bail, max tokens, last failed | `industrialize/c-scheduling` | Phase 0 merged | A B D E F |
| [D-selection.md](prompts/D-selection.md) | Tags, grep, list, config file, validate | `industrialize/d-selection` | Phase 0 merged | A B C E F |
| [E-spec-features.md](prompts/E-spec-features.md) | include, browser context, storage state, spec timeout | `industrialize/e-spec-features` | Phase 0 merged | A B C D F |
| [G-docs.md](prompts/G-docs.md) | Docs pass | `industrialize/g-docs` | all lanes merged | — |
| [P2-pick-cache-research.md](prompts/P2-pick-cache-research.md) | Pick cache: research and options only | none (read-only) | after integration | — |
| [P2-pick-cache-implement.md](prompts/P2-pick-cache-implement.md) | Pick cache: implement [pick-cache.md](pick-cache.md) | `industrialize/pick-cache` | `main` | — |

Every lane runs in its own git worktree (`claude --worktree`, or the Agent tool with
`isolation: worktree`). Agents commit on their local branch only; they never push, open PRs or merge.

## What stays in the main thread (with the human)

- Approving the Phase 0 result before lanes start.
- Merging branches, rebuilding `dist/` and `runtime.tgz`, pushing, opening PRs.
- Every design choice a lane reports as open.
- The pick-cache design (P2): the agent only gathers facts and proposes options.

## Integration checklist (main thread)

1. Merge `industrialize/f-ci` and `industrialize/phase0` into `main` (rebuild `dist/` first).
2. Start A–E from the new `main`.
3. Merge A–E one by one, in any order. Expected conflicts: none in `src/`; if one appears, the
   lane broke the ownership table — send it back.
4. `npm run build` once; commit `dist/` and the `runtime.tgz` files.
5. `npm test`; run `node dist/cli.js --headless examples/login.yaml` with a key; check the JUnit
   file, the artifacts folder, `--retries 1`, `--tag`, `--list`, `validate`.
6. Run G (docs), merge it.
7. Delete this plan folder, or keep it as a record.
