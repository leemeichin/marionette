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
VAR remaining: number = ?      // late-bound: supplied by the runtime

-> build_mvp                   // optional explicit start (default: first phase)

=== build_mvp ===              // a phase (node)
Ship the smallest testable slice.       // prose body: what this phase is
# github:issue: 12                      // node-level metadata tag
~ iteration += 1                        // mutation, applied on entry (=, +=, -=)
* [Metrics green] @ask -> beta_launch            // trusted operator chooses this route
* [I'm not sure] @input -> clarify               // collect text before this edge advances
+ {iteration < 3} [Go again] ~loop~ -> build_mvp // sticky choice, gated, declared loop
* {iteration >= 3} [Three strikes] -> pivot

=== beta_launch ===
Launch to the beta cohort.
-> END                         // automatic next step; END completes the plan

=== pivot ===
* [Pivot] @ask ~loop~ -> build_mvp
* [Kill it] @ask -> END
```

## Constructs

| Construct | Syntax | Notes |
|---|---|---|
| Phase | `=== name ===` | Unique `[A-Za-z_]\w*` id; trailing `===` optional. `END` is reserved. |
| Body | prose lines | Joined verbatim; first line is used as the node title when rendering. |
| Variable | `VAR name = literal` | Preamble only. Type inferred from the literal (number, `true`/`false`, `"string"`). |
| Late-bound variable | `VAR name: number = ?` | Preamble only. Explicit type is required; traversal suspends until the runtime supplies its initial value. |
| Mutation | `~ name = expr` · `~ name += expr` · `~ name -= expr` | Applied in order when the phase is **entered**. `+=`/`-=` require numbers. |
| Observation | `? name` | Invalidates `name` on each visit and requests a fresh typed value after the phase work, before branching. |
| Choice (once) | `* [Label] -> target` | May be taken at most once per traversal. |
| Choice (sticky) | `+ [Label] -> target` | Repeatable. Use for loop edges. |
| Gate | `{expr}` before or after the label | Choice is available only while the expression is true. |
| Operator decision | `@ask` on a choice | The trusted operator chooses an authored route with rationale. Rendered as `?`. |
| Input checkpoint | `@input` on a choice | The agent asks for free text; the operator supplies context, then the fixed edge advances. Rendered as `‽`. |
| Human confirmation | `@human` on a choice | A human must attest the action with their identity and durable evidence. Rendered as `✋`. |
| Loop | `~loop~` on a choice | Declares an intentional cycle. A cycle is declared when **any one** of its edges carries `~loop~` (convention: the returning edge); overlapping cycles each need a marked edge. Undeclared cycles are compile errors. |
| Conditional loop | `while {expr} -> target` · `else -> target` | An exhaustive sticky pair. `while` declares its true arm as the repeating edge. Optional `[labels]` may precede each arrow. |
| Conditional exit | `until {expr} -> target` · `else -> target` | An exhaustive sticky pair. `until` exits on true and declares its `else` arm as the repeating edge. |
| Timeout exit | `timeout 3d -> target` | Hard phase budget. Before expiry the edge is blocked; after expiry it is the authoritative exit and ordinary choices are blocked. Optional `[label]` before the arrow. |
| Automatic next step (`next` in JSON) | `-> target` on its own line | Unconditional route when a stage is done. At most one per phase; place it after choices. |
| End | `-> END` | Terminal. Reaching it completes the plan. |
| Metadata | `# key: value` · `# tag` | Plan-level in the preamble, node-level inside a phase. Namespaced keys (`github:issue`) are the extension mechanism. Repeated keys accumulate into a list. |

## Expressions

Operands: numbers (`3`, `1.5`), booleans, `"strings"`, variables.
Operators, loosest to tightest: `||`/`or` · `&&`/`and` · `==` `!=` ·
`<` `<=` `>` `>=` · `+` `-` · `*` `/` `%` · unary `!`/`not`, `-` · `( )`.
Comparisons are type-checked at runtime; `+` concatenates strings.

## Runtime observations

`?` is a suspension point, not a connector or an implicit lookup. Marionette
names the value and enforces its type; the executing host obtains it with
whatever capabilities it already has and records it through
`state observe` or the runtime protocol's `observe` operation.

```
VAR remaining: number = ?

=== work ===
Process one unit from the current batch.
~ remaining -= 1
while {remaining > 0} -> work
else -> refresh

=== refresh ===
Refresh the external count.
? remaining
while {remaining > 0} -> work
else -> END
```

`VAR remaining: number = ?` requests the first value before start-node entry
mutations run. A later `? remaining` controls the refresh cadence explicitly:
the old value is removed, choices are blocked with `observation-required`,
and the supplied value remains stable until another observation or mutation.
Every observation records actor, timestamp, value and rationale separately
from the decision log.

This is deliberately source-neutral. The same construct can represent a work
count, test health, rollout capacity, a measured score or any other scalar
fact. Marionette never assumes how the host obtains it.

## Operator, input, and human-confirmation checkpoints

Use `@ask` when the current trusted operator owns a route decision:

```
* [Approve release] @ask -> rollout
+ [Request changes] @ask ~loop~ -> rework
```

The agent cannot choose either edge. Status becomes `awaiting-operator`; the
host presents a complete decision packet (plan intent, full phase body,
progress, refs, variables, choices, targets/effects, revision and fallbacks).
In Pi, the trusted host opens a native choice dialog and records the selected
label without exposing internal choice ids or command syntax. The CLI fallback
is `state choose --actor <operator>`.

Use `@input` when the route is fixed but context is missing:

```
* [Need target platforms] @input -> reconsider
```

The agent opens it with `state ask --question ... --actor agent`; traversal
parks at `awaiting-elicitation`. In Pi, the trusted host opens a native text
editor automatically. The operator's answer is audited, the fixed edge
advances, and the next work packet carries the clarification. This is context,
not approval or route selection.

Reserve `@human` for explicitly high-risk actions whose external evidence is
useful independently of the workflow, such as production release, security or
legal sign-off, or a maintainer approval URL. Routine review, feature
acceptance, scope, rework, and loop termination use `@ask`:

```
* [Maintainer approved PR] @human -> merge
```

Status becomes `awaiting-external`. The agent cannot choose it; a trusted
human must confirm it rather than taking it as an ordinary route. After the
action exists, record the confirming human and durable evidence:

```console
marionette state confirm plan.mar 0 --actor maintainer \
  --evidence https://github.com/acme/repo/pull/12#pullrequestreview-1 \
  --rationale "approved the PR"
```

In Pi, the confirming identity defaults to the Git author configured in the
current repository. Marionette does not compare that identity with the plan's
committer or with an operator identity; the boundary is human-versus-agent,
not person-versus-person.

A choice cannot combine `@ask`, `@input`, and `@human`. Archived spec-0.5
trajectories retain their old meanings during replay; source using the former
free-text `@ask` form migrates to `@input`.

## While and until

`while`/`until` remove the boilerplate from the common two-door loop:

```
while {remaining > 0} [More work] -> work
else [Done] -> finish

until {tests_green} -> release
else -> retry
```

The `else` line must immediately follow its `while`/`until`. Both arms are
sticky because the decision point may be revisited. The compiler generates
the complementary `!condition` gate and the appropriate loop declaration;
labels are optional and default to the condition/`otherwise`. These forms
compile to the same choices, gates and loop facts as the longhand syntax, so
existing analysis and runtimes do not have a second control-flow model.

Use a `VAR` counter and longhand gates for a fixed retry budget. Use
`while`/`until` when the stopping condition is the point of the loop. A
condition driven by runtime observations may still produce MAR014 when its
eventual truth cannot be proven; that warning is the compiler being honest,
not a rejection of the construct.

## Timeouts

A timeout affects traversal and is therefore syntax:

```
=== experiment ===
Try the speculative approach.
* [Succeeded] -> integrate
+ [Another attempt] ~loop~ -> experiment
timeout 3d [Budget spent] -> fallback
```

The duration is measured from the current phase activation. A direct self-loop
does not reset it; leaving the phase and later returning does. Before expiry,
the timeout choice is blocked with `timeout-pending`. Once expired, ordinary
choices and automatic next steps are blocked and the timeout exit is
available. Marionette does not schedule a wake-up: a long-lived host may do
that, while a CLI run observes the timeout on its next `brief`/choice.

For compatibility, `# timebox:` remains an advisory annotation for older
plans. It never affects the walker. New plans whose time budget changes the
route should use `timeout <duration> -> target`.

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

MAR003/MAR004 reference errors do not suppress independent graph diagnostics.
The compiler checks a conservative closed projection, reports definite defects
such as unrelated dead ends and cycles, and withholds findings whose truth
depends on the broken edge or gate. Validate again after fixing the references
to check the complete graph.

`marionette oracle plan.mar` adds `STRAND` findings for once-only (`*`)
choices anywhere on a cycle, not only the choice carrying `~loop~`. Treat each
as a review point: make it sticky unless exhausting that route is intentional
and cannot strand a later visit.

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

Node-level priority remains execution metadata. The legacy `# timebox:` form
is advisory only; executable time limits use the `timeout` syntax above.

```
=== spike_realtime_sync ===
Try CRDT-based sync; a working prototype against the test suite decides.
# priority: high
* [Prototype holds up — adopt] -> integrate_sync
timeout 3d [Not viable in time] -> polling_fallback
```

- `# timebox: <n><m|h|d|w>` — legacy advisory wall-clock budget for a speculative
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
* [Service retired] @ask -> END
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
| `# delivery:` | plan default, node override | `pr-per-phase` \| `branch-per-phase` \| `stacked-prs` \| `single-pr` \| `single-branch` \| `none` | MAR019 | [`EXECUTION.md`](EXECUTION.md) |
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
