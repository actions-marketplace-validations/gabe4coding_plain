You are the research agent for Phase 2 (pick cache) of the "industrialize plainwright" plan, in the
repository at the root of your working directory. Read `CLAUDE.md` first.

This is a READ-ONLY task: gather facts and propose options. Do not change code, do not commit.
The design decision is made by the human afterwards, not by you.

## Background

Today every run of a YAML spec asks Jev to pick the element for every action target, even when the
page has not changed since the last passing run. That costs tokens and time on every CI run, and a
borderline pick can change between runs. The idea: after a step passes, remember what it resolved
to; on the next run, reuse it when it still matches, and ask Jev only when it does not. This touches
a core rule of the project ("Jev is the only decision maker"), so the options must say clearly how
each one keeps or bends that rule.

## Questions to answer, with file:line evidence

1. How a pick works today, end to end, for the browser: candidate collection (`src/candidates.ts`),
   `data-jev-id`, `pickElements()` (`src/jev.ts`), acceptance, and the action in `src/steps.ts`.
   What identity does a chosen element have at action time (selector, role+name, ids)?
2. The same for desktop and mobile (`src/automation.ts`, `src/native.ts`, the adapters): what
   identity is captured and revalidated before a native action (CLAUDE.md mentions identity
   revalidation and iOS class chains)? Could the same mechanism serve as a cache key?
3. What data is available to judge "the page has not changed enough": the candidate list, the
   snapshot, the `goal`, the target text. What is cheap to hash?
4. From the benchmark data in `docs/benchmarks/` and the scripts in `scripts/` (`benchmark-steps`,
   `benchmark-picks`, `pick-cases.json`, `pick-states/`): what share of step time and tokens is the
   pick on the examples? Give numbers with their source file. Do not run anything that needs a Jev
   key or the network unless the key is already configured; if you run benchmarks, say exactly
   which command and how many runs.
5. Prior art: how other tools do this (Playwright codegen locators, self-healing locators in tools
   like Healenium, Stagehand/`browser-use` action caching, Testim smart locators). Short, with the
   mechanism of each, not marketing.

## Options to propose (2 to 4)

For each option: mechanism; where the cache lives (file next to the spec? `.plainwright/`?
committed or not?); cache key; when it is invalidated; what happens on a miss; how a stale hit is
detected BEFORE acting (a wrong click on a stale hit is the main risk); cost/time saving estimate
from question 4; effect on determinism; how it fits browser, desktop and mobile; how it changes the
"Jev is the only decision maker" rule; which benchmark (`scripts/benchmark-*.mjs`) would prove it,
and the pass bar you would set.

Include at least: (a) a pure cache that re-validates the stored element against the current
candidates with no Jev call; (b) a "confirm" mode where Jev still decides but is asked a cheaper
yes/no question about the cached element first; (c) doing nothing and explaining why.

## Report back

A structured report: answers 1–5 with evidence, the options table, the risks you see, and the
questions the human must decide. No recommendation is required; if you give one, keep it separate
and say what would change your mind.
