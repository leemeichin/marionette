---
name: marionette-authoring
description: >-
  Turn natural-language project notes, goals, or a conversation into a
  compiled Marionette trajectory (.mar plan + trajectory JSON). Use when the
  user wants to plan a project as a directed graph of phases, decisions,
  gates, loops and human checkpoints, or asks to draft/revise/review a .mar
  plan. Drafts are compiler-checked; errors get one revision loop.
---

# Marionette authoring: notes → validated trajectory

You are drafting a **project trajectory**: a directed graph an AI agent will
traverse and humans will gate. The deliverable is a `.mar` script that
compiles cleanly, plus its rendered graph and summary for review. The full
language reference: https://github.com/leemeichin/marionette/blob/main/docs/DSL.md
(in the marionette repo itself: `docs/DSL.md`); the compiled contract is
`spec/trajectory.schema.json` there.

## Locating the compiler

Resolve the `marionette` CLI once, in this order, and reuse it:

1. `marionette` already on PATH (installed via `npm link` or `npm install -g`) —
   check with `marionette version`.
2. Inside a marionette repo checkout: `node bin/marionette.js` (after
   `npm install && npm run build`), or `npx tsx src/cli.ts` without a build.
3. Anywhere else: `npx --yes github:leemeichin/marionette <command>` —
   installs and builds transparently on first use.

Below, `marionette` means whichever form resolved.

## Workflow

1. **Extract the graph from the notes.** Identify: phases (states of the
   project, not tickets), the decisions that connect them, the conditions
   gating each path, where iteration genuinely happens, and — most
   importantly — which decisions a human must make. Ask at most one round of
   clarifying questions, and only for decisions that change the graph's
   shape.
2. **Draft the `.mar` script** (conventions below).
3. **Compile-check:** `marionette validate <plan>.mar --strict`. If it
   fails, fix every diagnostic — each error carries a line number and a
   `help:` suggestion — and validate again. Budget one revision loop; if the
   second attempt still errors, show the user the remaining diagnostics
   instead of silently iterating. Two things to know about that loop:
   - **Reference errors mask graph diagnostics.** Undefined targets or
     variables (MAR003/MAR004) stop the validator before dead-end, cycle
     and loop analysis runs. When you fix them, don't just patch the listed
     lines — re-check the whole draft against the conventions below
     (exits, `~loop~`, sticky edges), or the next validate will surface a
     second wave of structural errors and burn the budget.
   - **Expected warnings still fail `--strict`.** Zero *errors* is the bar;
     a plan whose only diagnostics are expected MAR014 dynamic-fact
     warnings is a legitimate end state — surface those warnings to the
     user and stop, even though the strict exit code is 1. Don't restructure
     a correct plan just to silence them.
4. **Produce the review artifacts:** `marionette compile <plan>.mar` (the
   contract), `render` (Mermaid), and `summarize` (plain language). Present
   the summary and graph to the user, calling out every `@human` checkpoint
   and any "unverified gate" warnings for manual review.
5. **Only if the user wants to start traversal:**
   `marionette state init <plan>.mar`.
6. **Log the outcome** (dogfood metric): tell the user whether the first
   validate pass succeeded with zero errors — that is the "first-session
   compile success" data point the Marionette project tracks.

## Drafting conventions

- **Phases are states, not tasks.** 5–15 phases for most projects. Each body
  is 1–3 sentences of prose stating what the phase means and what "done"
  looks like. First line becomes the node title in renders.
- **Match the plan's weight to the project's stakes.** A weekend migration
  does not need four counters and a contingency hub; a production cutover
  does. Add phases, counters and fallback paths the notes imply — not every
  one the DSL can express. When in doubt, the smaller graph is the better
  draft: reviewers read it cold, and structure that isn't in the notes is
  yours to justify.
- **Every phase needs an exit** — a choice or a divert. Terminal outcomes
  divert to `END`. The compiler hard-errors on dead ends; don't rely on it,
  design exits up front, including failure/contingency paths ("what if this
  doesn't work?" deserves a phase, not a hope).
- **`@human` marks the autonomy boundary.** Put it on: approvals and
  go/no-go calls, spending/scope/kill decisions, anything irreversible, and
  judgment calls the notes assign to a person. Do not put it on steps an
  agent can verify mechanically (tests green, artifact produced). If a plan
  has zero `@human` checkpoints, ask the user whether that's intended.
- **Loops must be declared and bounded.** Any edge that revisits an earlier
  phase gets `~loop~` and should be sticky (`+`), with a counter pattern so
  the compiler can verify the exit:

  ```
  VAR attempts = 0
  === iterate ===
  ~ attempts += 1
  + {attempts < 3} [Try again] ~loop~ -> iterate
  * {attempts >= 3} [Not converging] @human -> rethink
  * [It works] -> next_phase
  ```

  The always-available `@human` escape (`+ [Enough. Decide.] @human -> …`)
  is the alternative when no natural counter exists (PRD OQ4 — both are
  acceptable; prefer the counter when the notes imply a budget).

  **`~loop~` placement:** the compiler accepts a cycle once **any one edge
  on it** carries `~loop~`; put it on the returning edge (the one that
  jumps back to an earlier phase). When cycles overlap — e.g. several
  phases all return to one hub — mark the returning edge of *each* cycle;
  extra `~loop~` marks are harmless, a missing one is MAR008.

  **Sticky edges inside cycles:** every choice on a path the traversal can
  revisit should be sticky (`+`), not just the `~loop~` edge. A once-only
  (`*`) choice inside a multi-phase cycle is consumed on the first pass and
  can strand the second iteration at runtime — and the compiler only warns
  (MAR017) about the `~loop~` edge itself, so this one is on you. Reserve
  `*` for edges on straight-line, visited-once paths.
- **Gates use declared variables only.** Declare every variable with `VAR`
  in the preamble with a typed literal. Prefer gates the compiler can verify
  (constants, monotonic counters). Dynamic-fact gates (e.g.
  `{metrics_green}` set by a mutation) are fine but will be listed as
  "unverified — review manually"; mention them to the user.
- **Metadata rides on tags.** `# project: <name>` in the preamble;
  `# github:issue: <n>` on a node to link it to a tracker item. Namespaced
  keys only for extensions.
- **Naming:** `snake_case` phase ids that read as states (`beta_launch`,
  `pivot_or_kill`); choice labels are short human sentences, since reviewers
  and decision logs read them verbatim.

## Fixing compiler diagnostics

| Code | Meaning | Usual fix |
|---|---|---|
| MAR003/004 | undefined target/variable | typo — take the `did you mean` suggestion, or declare it |
| MAR006 | dead end | add an exit choice or `-> END` |
| MAR007 | unreachable phase | link it from a real decision, or delete it |
| MAR008 | undeclared cycle | if the loop is intentional, add `~loop~` to the returning choice; otherwise re-point the edge |
| MAR009/010 | loop without (satisfiable) exit | add a counter-gated or `@human` sibling exit |
| MAR012 | `@human` with no escalation path | give the choice a `-> target` |
| MAR014 (warn) | unverified gate | expected for dynamic facts — surface to the user, don't churn |
| MAR017 (warn) | once-only loop edge | change `*` to `+` |

## Example transformation

Notes: *"Build the importer. If the vendor API works out, ship it; we'll try
tweaking it up to three times. If not, fall back to CSV upload. Sam signs
off before anything ships."*

```
# project: importer
VAR api_attempts = 0

=== build_importer ===
Build the importer against the vendor API.
~ api_attempts += 1
* [API integration works] -> signoff
+ {api_attempts < 3} [Tweak and retry] ~loop~ -> build_importer
* {api_attempts >= 3} [API not viable] -> csv_fallback

=== csv_fallback ===
Fall back to CSV upload: same importer surface, manual ingestion.
* [Fallback works] -> signoff

=== signoff ===
Sam reviews the shipped surface.
* [Sam approves, ship it] @human -> END
+ [Changes requested] @human ~loop~ -> build_importer
```
