# Browsing: do or read something on a site

Steps act, two tools read, nothing is saved. There is no test here: do not `save`, do not replay.

## Workflow

1. `open` the URL. Pass `headed: true` when the user wants to watch, or when the site blocks a headless browser
   (title "Access Denied", an empty page). Pass `goal`: the user's task in one sentence ("read the discussion
   about F-Droid 2.0"); picks use it to settle vague targets. Do not `snapshot` first: `step` and `find` do the looking.
2. Drive with `step`, one action per call, or `batch {steps:[...]}` for up to 16 already-known actions.
   Batch runs sequentially and stops on the first non-pass, including `skipped`; inspect its indexed
   results and `stoppedAt`. End the batch before a decision that needs new page information.
   Read `status`, `detail`, `notes`, `url` and `changed` after every call: `changed.added` holds the new
   page lines (a message, a menu, the top of a new page), often the answer itself. A cookie
   or consent dialog comes first: `click: the button that accepts all cookies`.
   When the next action is unknown, use `snapshot {mode:"compact"}` for an overview or
   `snapshot {mode:"smart",intent:"the task"}` for task-focused evidence and Jev classifications. Check omission counts;
   use scoped raw snapshots for exact data. These are optional discovery reads, not prerequisites.
3. Read the data once the page is there:
   - `read {question}` returns the exact page lines that answer it ("the author and year of the first result"). Start here; add `within` on a large page, it costs fewer Jev tokens.
   - `snapshot` with `within: "the results list"` (or `css=...`) returns only that region's tree. A table comes as
     rows and cells you read directly. Start with a small `maxChars`.
   - `evaluate` with a JavaScript expression returns clean JSON:
     `[...document.querySelectorAll('article')].map(a => a.innerText)`. Use it when the region tree is still
     too long or you want exact fields.
   Never the whole-page snapshot for data.
4. Report what you found to the user, with the page URL. Stop.

## Steps that help here

- Lists that load late: `wait: the results list is visible`, then read.
- Autocomplete: a suggestion list can open seconds after `fill`. If the suggestion is not found, `ask` whether
  the box holds your text and whether a suggestion list is shown, then `wait: a list of suggestions is shown`;
  do not retype. `press: Enter` often submits the search instead.
- Pages with hundreds of links (Wikipedia, Hacker News, GitHub lists) cost 20–35k Jev tokens per pick. Read data
  with `read`, `evaluate` or a scoped `snapshot`, and navigate by URL (`open`) when you know it, instead of clicking.
- Filters: `check: the Hotels filter chip` (a no-op if already on). A chip without a state: `click`.
- Long pages: `scroll: bottom`, read the distance in `detail`; `press: End` and `press: Escape` also work.
- A popover or calendar that opened by itself is already open: act inside it, do not click its trigger again.

## The user's real browser

A session starts as a fresh browser with no logins. Signed-in sessions need the server started with
`--profile` and `--channel chrome`, or `--cdp` to attach to a running Chrome (see `docs/agent-mode.md` in the
plugin). You cannot change that from inside a session: if the task needs the user's accounts, say so and stop.

Anything you do in a real browser happens in the user's accounts. Stop before payment, booking, sending,
posting or deleting.
