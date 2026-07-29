---
name: marionette-authoring
description: >-
  Turn natural-language project notes, goals, or a conversation into a
  compiled Marionette trajectory (.mar plan + trajectory JSON). Use when the
  user wants to plan a project as a directed graph of phases, decisions,
  gates, loops, human checkpoints and elicitation checkpoints, or asks to draft/revise/review a .mar
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
   importantly — which decisions a human must make and where an agent may
   need open-ended context through `@ask`. Ask at most one round of
   clarifying questions, and only for decisions that change the graph's
   shape.
2. **Draft the `.mar` script** (conventions below).
3. **Compile-check:** `marionette validate <plan>.mar --strict`. If it
   fails, fix every diagnostic — each error carries a line number and a
   `help:` suggestion — and validate again. Budget one revision loop; if the
   second attempt still errors, show the user the remaining diagnostics
   instead of silently iterating. Two things to know about that loop:
   - **Reference errors produce a conservative partial graph pass.**
     Undefined targets or variables (MAR003/MAR004) no longer hide
     independent dead ends and cycles. Findings that depend on the broken
     edge are withheld rather than guessed, so fix the references and
     validate again before treating the graph as clean.
   - **Expected warnings still fail `--strict`.** Zero *errors* is the bar;
     a plan whose only diagnostics are expected MAR014 dynamic-fact
     warnings is a legitimate end state — surface those warnings to the
     user and stop, even though the strict exit code is 1. Don't restructure
     a correct plan just to silence them.
4. **Check cycle stickiness:** `marionette oracle <plan>.mar`. The oracle
   repeats the rule-base diagnostics and adds `STRAND` findings for
   once-only (`*`) choices anywhere on a cycle. For each `STRAND`, either
   change the choice to sticky (`+`) or keep it once-only deliberately and
   call out why exhausting that route cannot strand the traversal.
5. **Produce the review artifacts:** `marionette compile <plan>.mar` (the
   contract), `render` (Mermaid), and `summarize` (plain language). Present
   the summary and graph to the user, calling out every `@human` checkpoint,
   every `@ask` elicitation and any "unverified gate" warnings for manual
   review.
6. **Only if the user wants to start traversal:**
   `marionette state init <plan>.mar`.
7. **Log the outcome** (dogfood metric): tell the user whether the first
   validate pass succeeded with zero errors — that is the "first-session
   compile success" data point the Marionette project tracks.

## Starting from an issue tracker (`marionette import`)

When the project already lives in Jira, Linear or GitHub Issues, don't
transcribe tickets into DSL by hand — fetch and scaffold
(reference: `docs/SYNC.md` in the marionette repo):

1. **Fetch with the tools in your context** — a GitHub MCP server, a
   Jira/Linear integration, a CLI. Marionette holds no tracker connection;
   if you have no tool for the user's tracker, say so and ask them to paste
   the issue list instead of inventing one.
2. **Shape the issues as neutral JSON** and let the scaffolder write the DSL:

   ```json
   { "tracker": "github", "context": "acme/platform",
     "issues": [ { "id": 12, "title": "Fix login redirect" } ] }
   ```

   `marionette import issues.json -o plan.mar` emits a compiling draft:
   `--mode queue` (default) is one work-queue phase with a compact loop —
   one iteration per imported issue, O(1) tokens in phase count; `--mode
   phases` is one linked phase per issue. Treat the draft as raw material
   for the workflow above — reshape phases, add gates and `@human`
   checkpoints; the issue links ride along on the metadata.
3. **Bind the tracker once.** If the user's tracker is ambiguous (or nothing
   in context says which they use), ask once, then record it in the preamble
   (`# tracker: github|jira|linear`) so no future session has to re-ask —
   the plan is the project's memory.

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
- **Anchor phases to their sources.** A phase body says what the work *is*;
  where the details live is a ref. When the notes mention an issue, ticket,
  PR or document, attach it to the phase with the namespaced metadata tags
  (`# github:issue: 41`, `# jira: PROJ-123`, `# linear: ENG-42`,
  `# ref: https://…`), and put shared context (`# github:repo:`,
  `# jira:site:`) in the preamble so ids resolve to URLs. The executor
  reads refs before starting a phase — a phase whose work depends on
  context that exists somewhere but isn't reffed is a draft defect: the
  plan is asking the executor to guess. Don't expect the user to supply
  ticket ids: when the notes imply external context without naming it,
  discover it with your own tools (search the tracker the preamble scopes,
  the repo, the docs), or leave the phase unlinked and note that
  `marionette sync` will emit `ensure-issue` ops the executor can apply —
  ask the user only when discovery comes up empty.
- **Standing services are a pattern, not a smell.** Open-ended maintenance
  ("investigate and fix bugs as they arrive") is an evidence-gated sticky
  `~loop~` over an external queue, an `@human` retirement door, and a
  `# wake:` tag naming what re-activates the phase so executors park
  instead of polling:

  ```
  === triage ===
  Investigate and fix the next bug from the queue.
  # wake: github issues labeled "bug" pushed to acme/shop
  + [Queue has work — bug fixed or rejected] ~loop~ -> triage
  * [Service retired] @human -> END
  ```

  The loop is unbounded by design; the bound is the evidence claim on the
  loop edge (only taken when work exists) plus the human door.
- **Speculative phases get a temporal exit.** "Try this; if it works
  continue, if not abandon — don't sink time into it" uses `timeout` when
  expiry must change what traversal permits:

  ```
  === spike_realtime_sync ===
  Try CRDT-based sync; a working prototype against the test suite decides.
  * [Prototype holds up — adopt] -> integrate_sync
  timeout 3d [Budget spent] -> polling_fallback
  ```

  The timeout is a hard edge: before expiry it is blocked; after expiry it
  becomes authoritative and ordinary exits close. Use legacy `# timebox:`
  only when elapsed time is advisory evidence and should not control the
  walker. `# priority:` (critical|high|normal|low) remains metadata because
  it orders work outside a single traversal.
- **Every phase needs an exit** — a choice or an automatic next step. Terminal
  outcomes point to `END`. The compiler hard-errors on dead ends; don't rely on it,
  design exits up front, including failure/contingency paths ("what if this
  doesn't work?" deserves a phase, not a hope).
- **`@human` marks the autonomy boundary.** Put it on: approvals and
  go/no-go calls, spending/scope/kill decisions, anything irreversible, and
  judgment calls the notes assign to a person. Do not put it on steps an
  agent can verify mechanically (tests green, artifact produced). If a plan
  has zero `@human` checkpoints, ask the user whether that's intended.
- **`@ask` marks the ambiguity boundary.** Put it on an agent-owned route
  which cannot continue without open-ended human context:
  `* [I'm not sure] @ask -> reconsider`. The agent opens one focused
  question, the answer is audited, and the fixed edge advances. Do not use it
  when the human owns the route (`@human`) or when known answers should be
  ordinary choices. A choice cannot carry both flags. Source uses the
  searchable ASCII `@ask`; renders use `‽`.
- **Choose the loop form that matches the stopping condition.** Fixed retry
  budgets still use a monotonic counter, explicit gates and `~loop~`:

  ```
  VAR attempts = 0
  === iterate ===
  ~ attempts += 1
  + {attempts < 3} [Try again] ~loop~ -> iterate
  * {attempts >= 3} [Not converging] @human -> rethink
  * [It works] -> next_phase
  ```

  For a condition only known at runtime, declare a typed late-bound value,
  refresh it at explicit `?` checkpoints, and use the paired form:

  ```
  VAR remaining: number = ?

  === work ===
  Process one unit from the captured batch.
  ~ remaining -= 1
  while {remaining > 0} -> work
  else -> refresh

  === refresh ===
  Refresh the count after the batch is exhausted.
  ? remaining
  while {remaining > 0} -> work
  else -> END
  ```

  This syntax is source-neutral: the value might be queue depth, health,
  capacity, or a score. `while` marks its true arm as the loop; `until`
  marks its `else` arm. Their immediate `else` makes the decision exhaustive,
  and both compile to ordinary sticky choices. The compiler may emit MAR014
  when it cannot prove how an observed condition evolves; surface the warning
  rather than inventing a bound.

  The always-available `@human` escape (`+ [Enough. Decide.] @human -> …`)
  remains appropriate when a person owns termination.

  **`~loop~` placement:** the compiler accepts a cycle once **any one edge
  on it** carries `~loop~`; put it on the returning edge (the one that
  jumps back to an earlier phase). When cycles overlap — e.g. several
  phases all return to one hub — mark the returning edge of *each* cycle;
  extra `~loop~` marks are harmless, a missing one is MAR008.

  **Sticky edges inside cycles:** every choice on a path the traversal can
  revisit should be sticky (`+`), not just the `~loop~` edge. A once-only
  (`*`) choice inside a multi-phase cycle is consumed on the first pass and
  can strand the second iteration at runtime. Validation warns (MAR017) when
  the marked `~loop~` edge itself is once-only; the required oracle pass adds
  `STRAND` for once-only choices elsewhere on the cycle. Reserve `*` for
  straight-line paths or intentional one-shot routes whose exhaustion cannot
  strand a later visit.
- **Gates use declared variables only.** Declare every variable with `VAR`
  in the preamble: use a typed literal for authored state, or
  `VAR name: type = ?` for a runtime observation. Prefer gates the compiler can verify
  (constants, monotonic counters). Dynamic-fact gates (e.g.
  `{metrics_green}` set by a mutation) are fine but will be listed as
  "unverified — review manually"; mention them to the user.
- **Anchor the intent.** Open the preamble with `# summary:` (one-line
  executive abstract) and the user's ask verbatim in a fenced block —
  `# prompt: """` … `"""` is a container for markdown, so keep their
  paragraphs intact. The plan must not operate in a vacuum: reviewers see
  these first in `summarize`, and executors receive them in the brief as
  `plan.intent`.
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
| STRAND (oracle) | once-only choice anywhere on a cycle | change to `+`, or document why the one-shot route is safe |

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
