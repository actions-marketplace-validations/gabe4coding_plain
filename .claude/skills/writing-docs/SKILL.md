---
name: writing-docs
description: Use before you write or change a user doc in the plainwright repo (README.md, docs/*.mdx, examples/mobile/README.md). Gives the MDX format rules, the ASD-STE100 language rules, the content rules and how to check a doc change.
---

# Writing plainwright user docs

User docs are `README.md`, `docs/*.mdx` and `examples/mobile/README.md`. They are for humans first: a developer or
QA engineer who writes, runs or debugs specs, or uses the plugins with an agent. Contributor detail goes in
`docs/development.mdx` or `CLAUDE.md`, never in a user doc. Out of this set: `docs/benchmarks/**` (dated
measurement records, kept as `.md`, not rewritten after the fact), the plugin skills (agent-facing; the plugin
loader needs `.md`) and `CLAUDE.md`.

Which doc owns which topic, and when a code change must update a doc: see the table in `CLAUDE.md`,
section "Documentation". One owner per topic. Other docs link to the owner and do not repeat it. A desktop or
mobile doc states only what differs from the browser docs and links to them for the rest.

## Format

Plain MDX that GitHub still renders.

- Each `docs/*.mdx` starts with frontmatter (`title`, one-sentence `description`) and an H1 with the same title.
  The two `README.md` files have no frontmatter (GitHub shows it as a table) but must still compile as MDX.
- No JSX components, `import`/`export`, `{/* */}` or `<!-- -->` comments, or `<https://…>` autolinks.
- In prose, `{`, `}`, `<` and `>` go inside inline code. HTML only where Markdown cannot do it (a centered
  image), with every tag closed (`<img … />`, `<br />`).
- Relative links use the `.mdx` name and a GitHub heading slug. Renaming a heading means fixing every link to it
  (`grep -rn "<file>.mdx#<old-slug>"` over the repo, including the skills and `docs/benchmarks`).
- `.github/workflows/test.yml` greps `docs/ci.mdx` for the Playwright image tag: keep the tag in that file and in
  the `Dockerfile` in sync with the lockfile.

## Language

ASD-STE100 writing rules (Simplified Technical English), practical level. Technical names are allowed (step
kinds, flags, tool and file names, product names).

- Instructions: imperative, one instruction per sentence, at most 20 words, condition first ("If X, do Y").
- Descriptions: at most 25 words per sentence, one topic per sentence, at most 6 sentences per paragraph.
- Active voice, simple present. "can" for possibility, "must" for a requirement, "do not" for a prohibition.
- No should/may/might/would/could, contractions, semicolons, e.g./i.e./etc., filler words (just, simply,
  easily), -ing forms where a plain verb works, or phrasal verbs where one verb exists. Keep the articles.
- One word for one meaning across all docs: spec (a YAML test file), flow (an included steps-only file), step,
  target (an element description), claim (a statement for `expect`/`wait`/`ask`), pick, judgment, engine
  (browser, desktop, mobile; say "desktop", not "computer", except in the package name), and the statuses `pass`,
  `fail`, `inconclusive`, `error`, `skipped`, `flaky`.
- Vertical lists for three or more items; numbered lists when order matters. A warning starts with the
  instruction, then gives the reason.

## Content

- The code is the source of truth. Check every default, limit and behavior in `src/` before you write it. Do not
  document a planned or guessed behavior.
- Lead with what the reader wants to do and a short example; reference tables come after.
- Keep only facts that change what a user does or understands. Leave out function, module and type names (unless
  the user types them, such as a hook export or a config key), internal constants with no user effect, history
  ("before", "legacy", "unchanged", "this branch") and benchmark numbers (link the report in `docs/benchmarks/`).
- Keep the edge cases that give a silent wrong result, for example: `url` is only the base for `goto`, a `wait`
  never ends `fail`, `save` overwrites with no warning.
- Every browser example starts with `goto`. Full spec examples must pass `node dist/cli.js validate` (or the
  `computer`/`mobile` CLI); config examples must pass `--list`.

## Check

```bash
npm run check:docs
```

`scripts/check-docs.mjs` (also run in CI) checks that every user doc compiles as MDX 3 (GFM + frontmatter), has a
`title`/`description` frontmatter whose title is the H1 (`.mdx` files), uses no JSX/comments/autolinks, and passes
the mechanical STE rules (sentences of 25 words or fewer, no modals, contractions, semicolons, filler words or
Latin abbreviations). It also checks that every relative link and anchor resolves, also in `CLAUDE.md`,
`docs/benchmarks/` and the skills. It does not check facts or word choice: validate the YAML examples and read the
code for those.
