# Step overhead: speculative Jev calls, network-aware settle, warm connections

Browser, desktop and mobile.

Measured 2026-09-24 against `3d5f245` (before) on macOS, headless Chromium, TypeSafe provider
(`jev-1.13.0`), from Italy. Raw results are in [2026-09-24-step-overhead/](2026-09-24-step-overhead/).

## Results

**Spec runs** — the 17 runnable examples (`examples/*.yaml` without `google-flights` and
`login-fails`), 3 runs each, medians. *Overhead* is step time minus the page's own action time
(goto loads, clicks): settling, post-action waits, candidate scans, snapshots and Jev round trips.
One optional `wait` that runs to its 15 s timeout by design is left out of both.

| Metric | Before | After | Change |
|---|---:|---:|---:|
| Overhead | 46.2 s | 26.3 s | **−43.0%** |
| Overhead without `wait` idle (the demo page's own 5 s loading delay) | 42.0 s | 21.8 s | **−48%** |
| Visible Jev wait | 15.3 s | 5.0 s | −67% |
| Settle | 20.9 s | 12.9 s | −38% |
| Post-action wait | 5.2 s | 3.5 s | −33% |
| Suite wall time (includes page loads) | 87.3 s | 66.5 s | −24% |

**Agent mode** — `scripts/benchmark-mcp.mjs`: 14 MCP tool calls (open, fill, click, expect, check,
find, select, snapshot on the-internet) with 5 s of agent think time between calls, 2 runs each.

| Metric | Before | After | Change |
|---|---:|---:|---:|
| Tool time, all calls | 9.95 s | 5.64 s | **−43%** |
| Tool time without the 4 `open` page loads | 7.76 s | 3.50 s | **−55%** |
| A warm `step` (fill, expect, check, select) | ~620 ms | ~250–290 ms | −55% |

Also checked: `google-flights.yaml` (a real, busy site) passes before and after, 18.3 s → 13.4 s
total; `login-fails.yaml` still fails at the same claim. Unit tests: 145/145.

**Desktop and mobile** — the disposable fixture apps with real Jev (macOS Cocoa fixture; iOS 27
Simulator; Android API 36 emulator), 7 steps (fill, check, tap, expect, longpress, ...), old build
versus new, medians.

| Target | Cadence | Before | After | Change | Where it comes from |
|---|---|---:|---:|---:|---|
| Desktop | 5 s between steps | 4.07 s | 1.85 s | **−55%** | warm connections |
| Desktop | back to back | 2.31 s | 1.77 s | −23% | warm connections |
| iOS | 5 s between steps | 12.3 s | 9.8 s | **−20%** | warm connections |
| Android | 5 s between steps | 7.7 s | 4.9 s | **−36%** | warm connections |
| Android | back to back, early look on vs off | 6.16 s | 5.76 s | −6.5% | early look (below) |

Desktop and mobile steps had no settle wait of their own, so the browser change does not carry over
as it is. A desktop step is capture (3–14 ms on the fixture), Jev, action: nothing to hide Jev behind.
On iOS, XCUITest waits for the app to be idle inside the action (~340 ms for a tap), and a tree read
without that wait was neither faster nor different. On Android, UiAutomator waits for ~500 ms of quiet
inside the next tree read (480–600 ms after a tap, versus 12–110 ms without the wait), which is where
Jev can run. In a replay of the recorded Android spec, 7 of 10 Jev steps showed 0 ms of Jev wait. When
the quick tree was stale (the preview text arrived after it), the step was ~200 ms slower than before;
with seconds between steps (agent use) the UI is idle and the early look is skipped.

Native smoke tests after the change: Android deterministic and real Jev pass (authoring and replay);
iOS deterministic passes; macOS passes (screenshot skipped: no Screen Recording permission). The iOS
real-Jev run stops at `expect: Details are visible` with p=0.89, just under the 0.9 threshold,
before and after this change alike: a phrasing issue in that test, not a timing one.

## What changed

1. **Speculative Jev calls** (`settledAsk` in `src/browser/settled-ask.ts`). A step used to settle, then look,
   then ask Jev. Now it looks and asks at once, and settles in parallel. The early answer is kept
   only if the main document did not mutate after the look (a per-document clock mark), or a second
   look gives Jev identical input; otherwise the settled page is asked again (`reasked` in
   `--timing`). One re-ask in 3 benchmark runs; 4 on Google Flights, whose Jev tokens went from
   70k to 136k. The discarded answers are counted in the token totals.
2. **Network-aware, shorter settle** (`settlePage`). The DOM must be quiet for 300 ms (was 500),
   and no xhr/fetch younger than 2 s may be in flight. The old settle ignored the network, so a
   client-rendered page fetching for over 500 ms without touching the DOM already passed it.
3. **The candidate scan no longer restarts the quiet window**: observers ignore its own
   `data-jev-id` attribute writes.
4. **`fill`'s 500 ms debounce hold moved to the next step**, where it overlaps that step's Jev call.
   Steps that do not settle (`press`, `goto`, `mouse`, `css=` targets) still wait it out first.
   The post-action poll went from 50 ms to 10 ms.
5. **Warm, kept-alive Jev connections** (`src/jev/ask.ts`). Node's `fetch` closes an idle connection
   after 4 s, and agents think for longer than that between tool calls, so almost every agent step
   paid for a new connection. A global undici agent keeps connections for 60 s, and `warmUp()`
   sends two tiny Jev calls at startup (~100 untracked tokens per process). This covers the
   browser, desktop and mobile CLIs and MCP servers.
6. **Android early look** (`askSettled` in `src/core/automation.ts`, `AppiumAdapter.captureEarly`). Right
   after the previous step, a tree read without UiAutomator's idle wait goes to Jev while the normal
   read waits; the answer is kept only if both trees are identical. The check that the target did
   not change, right before each native action, is unchanged.
7. **Per-phase timing for desktop and mobile** (`capture`, `jev`, `act`, `idle`, `reasked`), where
   results only had `total` before.

## Limits of the underlying technology

- **Jev round trip.** `api.typesafe.ai` resolves to AWS us-west-2. From Europe the TCP round trip
  is ~185 ms, so a Jev call is ~230–290 ms at best, and every step that asks Jev pays it at least
  once. Now that Jev overlaps the settle, it is the floor of a step. Only a closer API region can
  lower it.
- **The first model call on each connection is slow** (~+350 ms). This is not TCP/TLS setup: a GET
  on the same connection does not remove it, a HEAD makes the server close the connection, and only a
  real `/v1/systemone` request warms it. It looks like the proxy in front of the API (Envoy/Istio)
  opening its own upstream connection. `warmUp()` hides it for two connections. Parallel requests
  (big-page chunks, re-asks) may still open a cold one.
- **No HTTP/2 from Node.** The API supports HTTP/2, but undici always offers HTTP/1.1 first, so
  parallel calls open separate connections instead of sharing one.
- **A fresh browser context per spec** means a cold HTTP cache and new connections to the site under
  test. That is most of the first `goto` of each spec (~1.3 s on the-internet versus ~0.12 s for the
  next one). This is the price of spec isolation. `--workers N` runs specs in parallel and is the
  biggest lever for a large suite.
- **Settling is a heuristic.** 300 ms of DOM quiet plus the network rule cannot see timers. A page
  that changes 400 ms after its last change, with no request, is observed before that change (500 ms
  had the same kind of blind spot, only later). `wait` is still the tool for delayed content.
- **Post-action grace.** After a click the step waits 200 ms of quiet to catch a navigation or
  request the click started. A navigation that a script starts a little later shows only as a
  request, and the next step's first look would then run in a page that is being replaced, so this
  wait cannot be skipped safely.

## Reproduce

```sh
npm run build
node scripts/benchmark-steps.mjs --runs 3 --out after.json --compare before.json
node scripts/benchmark-mcp.mjs --cli dist/cli.js --gap 5000 --runs 2 --out mcp-after.json
```

For a before run, build the older commit in a separate directory and pass its `dist/cli.js` as
`--cli` to either script.
