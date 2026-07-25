# Graph-semantics conformance vectors

One minimal plan per graph-layer diagnostic, with its expected findings
frozen in `cases.json`. These are the acceptance vectors for the normative
graph spec (`spec/rules/marionette.pl`, see ADR-0003): **any implementation
of the graph semantics must reproduce every vector exactly** — the code and
the line, not the message. Presentation (wording, suggestions, exit codes)
is deliberately out of scope; that layer lives per-implementation
(`src/diagnostics.ts` in the reference implementation).

`tests/oracle.test.ts` runs each vector through both current
implementations — the TypeScript semantic core (`analyzePlan`) and the rule
base on the bundled engine — and asserts three-way agreement with the frozen
expectations. Beyond these vectors, the same harness diffs the two
implementations over every plan in the repository plus a deterministic
mutation batch per plan (seeded graph defects), so agreement is enforced far
beyond the minimal cases.

Vector fields:

- `findings` — expected `"CODE:line"` set from the exact-match codes.
- `undeclaredCycle` — MAR008 presence. The rules state the semantic form
  (every effective simple cycle carries a `~loop~` edge); the TS validator
  approximates with DFS back edges, so MAR008 is compared on presence.
- `strands` — lines of once-only choices on a cycle (`STRAND`), the rule
  base's finding beyond the compiler (issue #8 item 2).

Adding a diagnostic to the language means adding its clause to the rule
base, its vector here, and its implementation — in that order.
