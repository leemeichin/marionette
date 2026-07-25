# ADR-0003: The rule base is the normative graph-semantics spec

**Status:** Accepted · **Date:** 2026-07-25 · **Relates to:** ADR-0002

## Context

A compiled plan is a database of facts over a graph of state machines, so
the structural validators were restated as SWI-Prolog rules
(`spec/rules/marionette.pl`) and differentially tested against the
TypeScript implementation over the full dogfood corpus plus deterministic
mutation batches. The rule base runs everywhere the npm package installs
(bundled `swipl-wasm` engine), each MAR code reads as a one-clause claim
about the graph, and the harness has already caught real defects in both
directions. The question this ADR answers: which artifact is the spec?

## Decision

1. **`spec/rules/marionette.pl` is normative for the graph layer** — the
   diagnostics computed over the compiled graph (dead ends, reachability,
   cycles, loop exits, gate verdicts, timebox shape: MAR006–MAR011,
   MAR013–MAR014, MAR017, MAR023, and the STRAND finding). An
   implementation conforms iff it reproduces the rules' findings — code and
   line — on the conformance vectors (`spec/conformance/graph/`) and stays
   divergence-free under the differential harness (`tests/oracle.test.ts`).
2. **The lexical and reference layers stay spec'd by prose + test vectors**
   (MAR001–MAR005, MAR012, MAR015–MAR016, MAR018–MAR022): facts are emitted
   post-parse, so the rule base cannot express, e.g., a duplicate phase
   header. This scoping is deliberate, not an omission.
3. **Semantics and presentation are separated in the reference
   implementation.** `analyzePlan` (src/validate.ts) returns findings as
   data; every user-facing sentence lives in `src/diagnostics.ts` (same
   split for walker refusals). Conformance is judged on findings, never on
   message strings — wording, did-you-mean suggestions and exit codes are
   implementation UX, free to differ.
4. **Two executable implementations are kept while the language moves.**
   The TS core is the product implementation; the rules are the spec that
   also executes. CI enforces agreement on every push. Neither is deleted
   while the DSL is changing — the differential property is what catches
   spec bugs, and it dies with a single implementation.

## Cutover (option D)

The walker follows the same path (planned): traversal semantics —
availability, frontier, refusal codes, transitions — stated as rules,
conformance walk scripts run against both walkers, then a deliberate
cutover decision. Trigger criteria for making the rules the *only* engine
of record for any layer:

- the layer's rules unchanged across several releases (the language has
  stopped moving there);
- engine cost measured and acceptable on the CLI path (wasm init is ~1s;
  lazy-load or precompiled state if it matters);
- the presentation layer fully decoupled (no semantic decision left in TS
  that the rules don't state).

Until those hold, "the oracle is the engine" means: the rules decide what
correct is; TypeScript executes it fast and phrases it well.

## Consequences

- New diagnostics land spec-first: clause → conformance vector →
  implementation (the order is enforced socially, the agreement by CI).
- The fact schema (`marionette facts`, spec/rules/README.md) is a public
  contract; changes to it are spec changes.
- A future non-TS implementation (or the pi agent's native ingestion)
  targets the rules + vectors, not the TS source.
