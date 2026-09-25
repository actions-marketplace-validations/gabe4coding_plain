# Picks with and without the flow's goal

`scripts/benchmark-picks.mjs` asks 41 targets against 11 saved candidate lists (`scripts/pick-states/`,
captured by `page.ts` on 2026-09-25 from Hacker News, GitHub search / repo / issues, Wikipedia, Open
Library, TodoMVC and the-internet's login page), through the real `pickElements`, once without a goal and
once with `goal` in the pick state. Saved pages keep the input fixed: a change in the numbers is a change
in the asking, not in the page.

Case types (`scripts/pick-cases.json`):

- **clear**: the words name one element (`the new link in the top bar`).
- **vague**: the words fit several elements; the goal says which (`the comments link`, goal "read the
  discussion about F-Droid 2.0").
- **conflict**: the goal is about another element; the words must win (`the Sign in link`, goal "find the
  top repositories about jev").
- **none**: the target is not on the page; the right answer is `none`.

## Result (2026-09-25, 3 runs, 123 picks per mode)

| Goal | Type | Right | Wrong (accepted) | Inconclusive | Tokens/pick |
|---|---|---|---|---|---|
| off | all | 86 | **21** | 16 | 27,714 |
| on | all | **117** | **0** | 6 | 27,735 |
| off | clear | 31 | 0 | 2 | |
| on | clear | 33 | 0 | 0 | |
| off | vague | 13 | 21 | 11 | |
| on | vague | 42 | 0 | 3 | |
| off | conflict | 27 | 0 | 3 | |
| on | conflict | 27 | 0 | 3 | |
| off / on | none | 15 / 15 | 0 / 0 | 0 / 0 | |

- Without a goal, a vague target is accepted on the first match with high confidence (0.7–0.96): the top-bar
  `comments` link, the first `Star` button, the username field for "the text field" when the password was
  meant. These are wrong clicks, not inconclusive ones.
- With the goal every one of them lands on the element the flow is about, and no conflict case follows the
  goal against the words. `the Code button` is inconclusive with and without it (0.49 / 0.48).
- `the text field` on the login page (goal "type the password") goes from wrong (username, 0.96) to
  inconclusive: the goal is a hint, not enough on its own for two identical-looking fields.
- Tokens: +0.1%. The goal is a field of the state; naming it in the question ("use the goal only to break
  ties") was tried in a scratch run and did slightly worse (108 vs 112 right, 0 wrong for both).

Limits: the cases were written for this experiment (the vague ones where a goal can help), in English, on
browser pages only; claims (`expect`/`wait`) never get the goal, since a goal pushes a judgment toward
"the flow worked".
