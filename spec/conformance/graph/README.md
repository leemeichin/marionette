# Graph-semantics conformance vectors

One minimal plan per graph-layer diagnostic, with its expected findings
frozen in `cases.json`. These are the acceptance vectors for the normative
graph spec (`spec/rules/marionette.pl`, see ADR-0003): **any implementation
of the graph semantics must reproduce every vector exactly** — the code and
the line, not the message. Presentation (wording, suggestions, exit codes)
is deliberately out of scope; the TypeScript presentation layer lives in
`src/diagnostics.ts`.

`tests/oracle.test.ts` requires the production structured rule findings to
match every frozen vector exactly, including the MAR008 closing-edge line.
During the confidence window it also diffs the quarantined TypeScript shadow
over every plan in the repository plus deterministic seeded mutations.

Vector fields:

- `findings` — expected `"CODE:line"` set from the exact-match codes.
- `undeclaredCycle` — legacy shadow-comparison presence for MAR008. Production
  MAR008 is also present in `findings` as an exact `"MAR008:line"` value.
- `strands` — lines of once-only choices on a cycle (`STRAND`), the rule
  base's finding beyond the compiler (issue #8 item 2).

Adding a diagnostic means adding its clause, structured finding shape,
vector and presentation mapping — in that order.
