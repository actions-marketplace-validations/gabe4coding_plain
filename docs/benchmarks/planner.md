# Planner benchmark

`src/planner.ts` turns one sentence into plan items with two Jev requests (see
[computer use](../computer-use.md#one-sentence-plan-and-do)). `scripts/benchmark-planner.mjs` plans the 41
sentences of `scripts/planner-cases.json` with the live model and compares each plan with the expected
one (case-insensitive, a leading "the" and trailing punctuation ignored).

```
node scripts/benchmark-planner.mjs --runs 3 --out /tmp/new.json --compare /tmp/base.json
```

## 2026-09-24, jev-1.13.0

| Change | Pass rate | Kept |
|---|---|---|
| Baseline: one Noul per "and"/comma ("does a new action begin here?"); argument spans need confidence ≥ 0.5 | 76.8% (63/82) | |
| Spans taken without a confidence gate; a dot splits only before a space or the end; "Calculator app" → "Calculator" | 87.8% (72/82) | yes |
| Split by one Choice among the whole readings of each ambiguous piece | 97.6% (80/82) | yes |
| Target question asks for "the thing to act on … with where it is" | 95.1% (117/123) | no: fixed "Rock and Roll in the genre list", broke one-word targets ("Cancel", "Apply") |
| Final, 3 runs | 97.6% (120/123), median 3,206 tokens per sentence | |

What mattered:

- **Overlapping options split the probability.** Argument options are every run of words, so "the OK button"
  and "OK button" are both right and share the probability (0.61/0.36, confidence 0.57; "the report file"
  0.46/0.40, confidence 0.41). A confidence gate rejected good picks; the top option is taken unless it is
  `none`. The action question keeps its gate: its options are distinct.
- **Judge whole readings, not single boundaries.** Asked per "and" in isolation, the split was near 0.5 and
  flipped between runs ("buy milk | and eggs"). Offered as complete readings ("1. type salt 2. pepper in the
  box" vs "1. type salt and pepper in the box"), Jev chose right every time.
- **Examples in instructions leak.** An example phrase that matched words of the sentence ("milk and eggs")
  pushed every boundary to "no" (0.10–0.32). Keep instructions general.

Known failure: "Click Rock and Roll in the genre list" targets "the genre list".
