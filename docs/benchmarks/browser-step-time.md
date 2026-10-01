# Browser step time: settle after load, shorter quiet window, click holds

Browser only (spec runs and the MCP server). Measured 2026-10-01 on macOS, headless Chromium, TypeSafe
provider (`jev-1.13.0`), from Italy, with `scripts/eval-browser-steps.mjs`: the 18 runnable examples
(`examples/*.yaml` except `google-flights`) in one CLI process per rep, and the `benchmark-mcp.mjs`
session (10 calls plus 4 `open`, 5 s think time) scored as 4 cases. *Overhead* is step time minus the
page's own action time and minus the page's own delay a `wait` sees (`idle`); MCP overhead is the tool
time of every call except `open`. A guard requires every step status to match the expected ones.

## Result

Baseline code (`5fc5974`) and the result, run back to back the same day (3 spec reps, 4 MCP sessions):

| Metric | Before | After | Change |
|---|---:|---:|---:|
| Spec overhead, 18 specs | 23.56 s (22.82–24.07) | 21.18 s (20.58–21.75) | **−10.1%** |
| Spec overhead, without the two specs that depend on the demo site's shared file list | 21.73 s | 19.63 s | −9.7% |
| MCP overhead, 10 calls | 5.38 s (5.19–5.38) | 4.89 s (4.52–4.93) | **−9.0%** |
| Same step statuses | 70/70 | 70/70 | |

18 of 22 cases got faster. A no-change rerun of the baseline moved the spec suite −0.1% (MCP moves up to
~6% at 2 sessions, hence 4). `google-flights.yaml` (held out, a live third-party site) fails on its last
`wait` in both builds at a similar rate (3/7 before, 4/7 after): on those runs Google's results page has
no "Top departing flights" heading at all. Its overhead −2.7%.

## Changes, in the order measured

| Change | Spec | MCP | Kept |
|---|---:|---:|---|
| The parser's inserts do not count as page activity once the page has loaded: the first step after every goto used to wait a full quiet window on a static page | −0.7% (−2.7% w/o site specs) | −6.2% | yes |
| Settle quiet window 300 → 150 ms | −5.2% | −1.3% | yes |
| A click watches 50 ms, then holds the next step's settle to 200 ms after it (was a flat 200 ms post-action wait) | −10% | ≈ | no: exposed a popup race |
| Same, plus a popup holds the next step's settle until it is the active page | −8.6% (−4.1% w/o site specs) | +3% (noise) | yes |
| `fill`'s post-action grace 200 → 50 ms | −2.8%, from unrelated specs | ≈ | no |

Each row is against the previous kept state. On spec steps the Jev call runs while the page settles, so
a shorter settle mostly turns into visible Jev wait: the per-step floor is now the Jev round trip
(~250–500 ms). The click change surfaced a real race the 200 ms wait had been hiding: the step after a
click that opens a new tab could judge the opener page while the tab was still loading.
