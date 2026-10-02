# The `read` tool

`read {question, within?}` answers a question with the page's own accessibility-tree lines (`src/core/read.ts`).
Code numbers the lines, Jev picks the first and the last line of the answer (two Choice questions, one
request), and the lines in between are copied verbatim. Measured 2026-09-25.

## Offline: read vs smart snapshot

`node scripts/benchmark-read.mjs --runs 2 --smart`: 19 questions with known answers (17 answerable, 2 with no
answer on the page) on 8 saved pages (`scripts/read-states/`: Wikipedia, Hacker News, GitHub repo and issues,
Open Library search, the-internet tables, books.toscrape, quotes.toscrape). A case is right when every expected
string is in what the tool returned.

| | right | Jev tokens / question | characters the agent reads |
|---|---|---|---|
| `read` | 38/38 (34/34 answerable, 4/4 none) | 20.7k | 154 |
| `snapshot {mode:"smart", intent: question}` | 27/34 contain the answer | 14.8k | 4,451 |

Per page (read): tables 1.9k tokens, quotes 5.6k, Hacker News 6.0k, books 13.7k, GitHub issues 17.8k,
GitHub repo 29.1k, Open Library 31.7k, Wikipedia 47.4k. `within` keeps a large page near the small ones.

### What moved the numbers

| Version | right | Jev tokens / question |
|---|---|---|
| Regions first (one Noul per region), then lines | 16/19 | 30.7k |
| All lines, chunks of 254 in parallel, options carry the line text | 18/19 | 41.4k |
| Same, options are only `line N` labels | 18/19 | 35.9k |
| + only lines that carry text (no `/url:`, no bare `- list:`) | 19/19 | 29.8k |
| Regions first (one Choice over regions), keep lines up to 0.9 probability, two chunks max | 38/38 | 28.3k |
| Same, one chunk max | 32/38 (missed the Wikipedia infobox) | ~22k |
| **Text lines, minus lines repeating their parent's text (a row's cells, a heading's link)** | **38/38** | **20.7k** |

- A Choice option costs ~22 Jev tokens per question whatever its label (254 options: ~5.7k tokens with an
  empty label, ~6.9k with `line N`), so the number of options, not the state, sets the cost.
- A row, its cell and its link carry the same text and split the probability; the chosen line's ancestors and
  descendants are counted as one answer (`familyScore`).
- Jev picking the region first was unreliable (the infobox region scored below navigation lists), so it was
  dropped.

## Agent: read on vs off

`node scripts/benchmark-agent.mjs --read both --runs 2`: a Sonnet agent, seven data tasks (hn, wiki, gh, ol,
books, tables, repo), `changed` on in both modes; off hides the tool and its skill lines.

| | tool calls | agent tokens | cost / task | time |
|---|---|---|---|---|
| read off | 3.1 | 77.8k | $0.043 | 13 s |
| read on | 3.1 | 75.6k | $0.033 (-23%) | 13 s |

All 28 answers were right (the Hacker News story differs between runs because the live "new" page changed).
The gain is on pages where the agent otherwise read a snapshot: Wikipedia $0.069 → $0.026, GitHub repo
$0.040 → $0.023, GitHub issues $0.037 → $0.028. No change on books, tables and Hacker News (small pages, or
`changed` already held the answer) and Open Library (the agent navigated with snapshots before reading).
Jev tokens for `read` come on top; on a large page without `within` they are about a region pick's.
