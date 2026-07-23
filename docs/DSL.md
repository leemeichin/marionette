# Marionette DSL v0 reference

A `.mar` file is a line-oriented script. Humans normally don't hand-write it
(authoring is NL → draft, see PRD §2.4), but it is the durable, diffable source
of truth, so it stays small and legible.

```
// Comments run to the end of the line, anywhere.
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
| Loop | `~loop~` on a choice | Declares an intentional cycle. Undeclared cycles are compile errors. |
| Divert | `-> target` on its own line | Fallthrough edge. At most one per phase; must come after choices. |
| End | `-> END` | Terminal. Reaching it completes the plan. |
| Metadata | `# key: value` · `# tag` | Plan-level in the preamble, node-level inside a phase. Namespaced keys (`github:issue`) are the extension mechanism. |

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
loop edges (MAR017).

## Loop verification

A declared loop passes when its cycle has at least one exit that is ungated,
or whose gate is trivially decidable and satisfiable — e.g. a **monotonic
counter**: `~ i += 1` inside the loop with an exit gate `{i >= 3}`. A
loop-continue gate that provably shuts (`{i < 3}` with an increasing `i`) also
counts as a verified bounded loop. Everything else is enumerated as an
unverified-gate warning.
