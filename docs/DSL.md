# Marionette DSL v0 reference

A `.mar` file is a line-oriented script. Humans normally don't hand-write it
(authoring is NL → draft, see PRD §2.4), but it is the durable, diffable source
of truth, so it stays small and legible.

```
// Comments run to the end of the line (at line start or after whitespace,
// so URLs like https://… survive).
# project: my-project          // plan-level metadata tag (preamble)
VAR iteration = 0              // typed variables: number, boolean, "string"
VAR approved = false

-> build_mvp                   // optional explicit start (default: first phase)

=== build_mvp ===              // a phase (node)
Ship the smallest testable slice.       // prose body: what this phase is
# github:issue: 12                      // node-level metadata tag
~ iteration += 1                        // mutation, applied on entry (=, +=, -=)
* [Metrics green] @human -> beta_launch          // once-only choice, human checkpoint
+ {iteration < 3} [Go again] ~loop~ -> build_mvp // sticky choice, gated, declared loop
* {iteration >= 3} [Three strikes] -> pivot

=== beta_launch ===
Launch to the beta cohort.
-> END                         // fallthrough divert; END terminates the plan

=== pivot ===
* [Pivot] @human ~loop~ -> build_mvp
* [Kill it] @human -> END
```

## Constructs

| Construct | Syntax | Notes |
|---|---|---|
| Phase | `=== name ===` | Unique `[A-Za-z_]\w*` id; trailing `===` optional. `END` is reserved. |
| Body | prose lines | Joined verbatim; first line is used as the node title when rendering. |
| Variable | `VAR name = literal` | Preamble only. Type inferred from the literal (number, `true`/`false`, `"string"`). |
| Mutation | `~ name = expr` · `~ name += expr` · `~ name -= expr` | Applied in order when the phase is **entered**. `+=`/`-=` require numbers. |
| Choice (once) | `* [Label] -> target` | May be taken at most once per traversal. |
| Choice (sticky) | `+ [Label] -> target` | Repeatable. Use for loop edges. |
| Gate | `{expr}` before or after the label | Choice is available only while the expression is true. |
| Human checkpoint | `@human` on a choice | The agent must pause and escalate; only a human may record this decision. |
| Loop | `~loop~` on a choice | Declares an intentional cycle. A cycle is declared when **any one** of its edges carries `~loop~` (convention: the returning edge); overlapping cycles each need a marked edge. Undeclared cycles are compile errors. |
| Divert | `-> target` on its own line | Fallthrough edge. At most one per phase; must come after choices. |
| End | `-> END` | Terminal. Reaching it completes the plan. |
| Metadata | `# key: value` · `# tag` | Plan-level in the preamble, node-level inside a phase. Namespaced keys (`github:issue`) are the extension mechanism. Repeated keys accumulate into a list. |

## Expressions

Operands: numbers (`3`, `1.5`), booleans, `"strings"`, variables.
Operators, loosest to tightest: `||`/`or` · `&&`/`and` · `==` `!=` ·
`<` `<=` `>` `>=` · `+` `-` · `*` `/` `%` · unary `!`/`not`, `-` · `( )`.
Comparisons are type-checked at runtime; `+` concatenates strings.

## What the compiler guarantees (G1)

Structural errors (fail the build): dead ends (MAR006), unreachable phases
(MAR007), undefined targets (MAR003) and variables (MAR004), duplicates
(MAR002, MAR005), undeclared cycles (MAR008), loops with no exit (MAR009) or
provably-unsatisfiable exits (MAR010), `@human` without an escalation path
(MAR012), type mismatches (MAR015).

Warnings (review, or fail with `--strict`): constant-false gates (MAR011),
`~loop~` on a non-cycle (MAR013), **unverified gates** (MAR014 — anything
beyond constant expressions and monotonic counters; the compiler never claims
"verified" for gates it cannot decide), unused variables (MAR016), once-only
loop edges (MAR017), malformed external refs (MAR018), unknown delivery/report
values (MAR019), unknown tracker values (MAR020).

## Well-known metadata namespaces (Phase 2)

All metadata rides on one syntax — `# key: value` tags, plan-level in the
preamble, node-level inside a phase (the construct table above). The
namespaces below are the ones the compiler *normalises* (into structured
`refs`, the delivery config, the tracker binding and the plan's intent) and
validates; every other namespace passes through untouched as extension
metadata.

Two plain keys anchor the plan to its origin, so the file never operates
in a vacuum — `summarize` leads with them and the executor's brief carries
them as `plan.intent`:

```
# summary: One-line executive abstract of what this plan achieves and why.
# prompt: """
The original ask, verbatim — a fenced value is a container for markdown:
paragraphs, blank lines and list syntax survive untouched. `#` at line
start inside the fence is text, not metadata. Closes at the first line
containing only """.
"""
```

Two node-level pacing keys encode time and urgency **as evidence, never as
a gate** — the walker never consults the clock (determinism, replay and
static gate verification depend on that):

```
=== spike_realtime_sync ===
Try CRDT-based sync; a working prototype against the test suite decides.
# timebox: 3d
# priority: high
* [Prototype holds up — adopt] -> integrate_sync
* [Not viable or timebox spent] -> polling_fallback
```

- `# timebox: <n><m|h|d|w>` — advisory wall-clock budget for a speculative
  phase. The brief carries it alongside `enteredAt` (derived from the
  decision log); an overdue timebox is the executor's evidence for taking
  the abandon door, and the log records that time drove the exit. Malformed
  values warn (**MAR021**); a timebox on a phase with only one exit warns
  (**MAR023**) — with a single door, spending or not spending the budget
  changes nothing, so the speculative shape needs both an "adopt" and an
  "abandon" exit.
- `# priority: critical|high|normal|low` — executor ordering hint when
  phases or plans compete for a session; mapped to tracker priority by
  `sync` ops. Never reorders the walker's frontier. Unknown values warn
  (**MAR022**).

A further plain key, `# wake:`, declares what re-activates a standing
(service) phase — a loop over an external queue — so executors and
schedulers can park instead of polling. It passes through as ordinary
metadata: the walker never schedules; the executing platform owns waking.

```
=== triage ===
Investigate and fix the next bug from the queue.
# wake: github issues labeled "bug" pushed to acme/shop
+ [Queue has work — bug fixed or rejected] ~loop~ -> triage
* [Service retired] @human -> END
```

Any metadata key accepts the fenced form (`# key: """` … `"""`); short
values keep the one-line form. An unterminated fence is a parse error
(`MAR001`).

Two conventions apply uniformly: repeated occurrences of a key accumulate
into a list, and wherever a single value is needed (project, tracker,
delivery, report, context tags) the **last occurrence wins**.

| Tag | Level | Meaning | Validated | Reference |
|---|---|---|---|---|
| `# project:` | plan | display name used in briefs, summaries and manifests | — | — |
| `# summary:` | plan | executive abstract; leads `summarize`, carried in the brief as `plan.intent` | — | [`EXECUTION.md`](EXECUTION.md) |
| `# prompt:` | plan | the original ask, verbatim (usually fenced); carried as `plan.intent` | — | [`EXECUTION.md`](EXECUTION.md) |
| `# tracker:` | **plan only** | which tracker `marionette sync` binds to: `github` \| `jira` \| `linear`. Node-level tags have no effect and warn. | MAR020 | [`SYNC.md`](SYNC.md) |
| `# github:repo:` | plan (node may override for its refs) | GitHub context, e.g. `acme/platform`; also a `repo` ref | MAR018 | [`EXECUTION.md`](EXECUTION.md) |
| `# github:issue:` · `# github:pr:` | node or plan | issue/PR refs: `22`, `other/repo#9`, comma lists | MAR018 | [`EXECUTION.md`](EXECUTION.md) |
| `# jira:site:` | plan (node override) | Jira site URL context | — | [`EXECUTION.md`](EXECUTION.md) |
| `# jira:` | node or plan | issue keys: `PROJ-123`, comma lists | MAR018 | [`EXECUTION.md`](EXECUTION.md) |
| `# linear:workspace:` | plan (node override) | Linear workspace slug context | — | [`EXECUTION.md`](EXECUTION.md) |
| `# linear:` | node or plan | issue ids: `ENG-42`, comma lists | MAR018 | [`EXECUTION.md`](EXECUTION.md) |
| `# ref:` | node or plan | generic http(s) link | MAR018 | [`EXECUTION.md`](EXECUTION.md) |
| `# delivery:` | plan default, node override | `pr-per-phase` \| `branch-per-phase` \| `single-pr` \| `single-branch` \| `none` | MAR019 | [`EXECUTION.md`](EXECUTION.md) |
| `# delivery:branch:` | plan default, node override | branch template; `{phase}` → node id | — | [`EXECUTION.md`](EXECUTION.md) |
| `# report:` | plan default, node override | `per-phase` \| `at-checkpoints` \| `at-end` | MAR019 | [`EXECUTION.md`](EXECUTION.md) |

## Loop verification

A declared loop passes when its cycle has at least one exit that is ungated,
or whose gate is trivially decidable and satisfiable — e.g. a **monotonic
counter**: `~ i += 1` inside the loop with an exit gate `{i >= 3}`. A
loop-continue gate that provably shuts (`{i < 3}` with an increasing `i`) also
counts as a verified bounded loop — on *any* edge of the cycle, whether or not
that edge carries the `~loop~` mark. Everything else is enumerated as an
unverified-gate warning. Note that resetting a counter (`~ i = 0`) anywhere
makes its gates non-monotonic and therefore unverifiable; those gates warn by
design — review them manually.

Authoring note: once-only (`*`) choices anywhere **inside** a cycle are
consumed on the first pass and can strand a later iteration at runtime. The
compiler warns (MAR017) only when the `~loop~` edge itself is once-only;
keeping every cycle-participating edge sticky (`+`) is an authoring
convention, not a compiler guarantee.
