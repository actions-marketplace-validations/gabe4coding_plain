# Agent cost with `changed` in step results

`scripts/benchmark-agent.mjs` runs a real agent (`claude -p`, Sonnet 5, the plainwright skill and browsing
mode as system prompt, only this repo's MCP server) on six public read-only tasks, with `changed` off
(`PLAINWRIGHT_CHANGES=0`) and on. `changed` lists what the action did to the page: title/URL if they
changed, the new accessibility-tree lines (1,500 characters) and the removed count.

## Result (2026-09-25, 3 runs per task and mode, 36 runs, all answers correct)

| Per task (average) | Off | On | Change |
|---|---|---|---|
| Tool calls | 4.7 | 3.3 | -30% |
| of which snapshot + ask + evaluate | 1.8 | 0.9 | -50% |
| Agent tokens (incl. cached prompt) | 109k | 83k | -24% |
| Agent output tokens | 592 | 458 | -23% |
| Cost | $0.051 | $0.041 | -20% |
| Wall time | 17 s | 14 s | -18% |

| Task | Calls off → on | Cost off → on |
|---|---|---|
| Hacker News: open "new", first story | 4.7 → 2.0 | $0.069 → $0.031 |
| the-internet: log in, log out, both messages | 5.7 → 3.0 | $0.039 → $0.026 |
| Open Library: search, first result's author and year | 8.0 → 6.0 | $0.104 → $0.100 |
| TodoMVC: add three, complete one, items left | 2.7 → 2.0 | $0.024 → $0.021 |
| Wikipedia: search, open article, birth date | 3.3 → 3.0 | $0.040 → $0.031 |
| GitHub: Issues tab, first issue title | 4.0 → 4.0 | $0.029 → $0.035 |

The gain is largest when the answer appears right after an action (a flash message, a new page's
first rows): the agent reads it from `changed` instead of a `snapshot`/`ask`. GitHub's issue titles
are past the first 1,500 characters of the new page, so the agent still needed a snapshot there.
Each step pays one settle and one tree read after the action; the whole runs were still faster.

## Desktop and mobile (2026-09-25)

The native MCP servers return the same `changed` (same diff, same cap). A step that picks a target diffs
against its own pre-action capture (`NativeSession.firstSnapshot`); only press, swipe and mouse capture before
acting. Live on an iOS 27 simulator (Settings: General → About → back twice), MCP call time per step:

| | tap General | tap About | back | back |
|---|---|---|---|---|
| changed off | 2.6 s | 2.2 s | 2.2 s | 2.1 s |
| changed on, separate before capture | 4.5 s | 3.6 s | 3.5 s | 3.5 s |
| changed on, reusing the step's capture | 3.1 s | 2.7 s | 2.9 s | 2.9 s |

So `changed` costs one capture (~0.6 s on iOS) per step. On iOS the added lines include the chain of
`XCUIElementTypeOther` wrappers that repeat the screen name, which uses part of the 1,500-character cap.
`read` on the About screen answered "iOS Version, 27.0" for 1.1k Jev tokens in 0.8 s.
