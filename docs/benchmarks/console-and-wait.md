# Console noise, empty first scans, and wait cost

From agent feedback after browsing Uber, Yahoo Finance, Booking and trivago (2026-09-25).

## Console noise

Ad-heavy pages log dozens of console errors about resources the browser blocked or another site's
script. They were listed one by one in step `notes` and sent to Jev with every judgment.

| Yahoo Finance, click "Accept all" | Before | After |
|---|---|---|
| Notes | 96, 26,381 chars | 1, 94 chars ("console: 103 errors from other sites or blocked resources …") |
| Next click (Statistics tab) | 8, 2,310 chars | 1, 93 chars |

Agent run (`scripts/benchmark-agent.mjs --only yahoo --changed on --runs 3`, Sonnet 5; "accept cookies,
open Statistics, trailing P/E"): 98.5k → 82.3k agent tokens (-17%), $0.112 → $0.102 (-9%), 4.0 → 3.3 tool
calls, same answer in all six runs. The page's own errors are kept: `examples/components-jserror.yaml`
still passes at p=0.98.

## Empty first scan

Booking redirected after `open` returned; the first click scanned the page mid-redirect and answered "no
candidates" in 243 ms. A scan with no candidates is now retried for up to 2 s (the desktop adapter already
did this).

## wait cost

A whole-page `wait` on a static page costs one poll: after a clear no, polls that see the same page skip
the model. The 118k–147k tokens seen on Booking came from a page that kept changing (ads, carousels)
while the answer stayed in the grey zone (p=0.12, 0.20), so every poll was a new question.

`wait: {that, within}` picks the region once and polls only its tree. Four pages, a claim that holds and
one that never holds, 2 runs each (`tokens per wait`):

| Page | Whole page | within |
|---|---|---|
| Wikipedia, Alan Turing (infobox) | 17.1k | 9.7k |
| GitHub, playwright issues (list) | 15.9k / 10.8k | 10.7k |
| Yahoo, statistics (valuation table) | 9.6–10.1k | 10.9k |
| Hacker News (story list) | 11.8k | region pick inconclusive (c≈0.3) |

It saves where the page is large and the region is easy to name, costs slightly more on a page whose
region is most of the page, and depends on the region pick. The skill advises it for large or changing
pages.
