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
3. **Semantics and presentation are separated.** The rule engine returns
   structured findings and refusal details; every user-facing sentence lives
   in `src/diagnostics.ts` or the TypeScript adapter. Conformance is judged on
   findings and state transitions, never message strings.
4. **The normative rules are also the production engine.** Compilation calls
   `graph_findings_json/1`; walking calls the pure explicit-state relations
   `initial_state/2`, `available/3`, `blocked/5`, `refusal/5` and `apply/5`.
   `src/rule-engine.ts` lazy-loads one bundled wasm instance, serializes every
   facts-load/query transaction, and binds JSON inputs rather than
   interpolating source.
5. **The former TypeScript graph and walker implementations are quarantined
   under `tests/reference/`.** CI differentially checks them during a 30-day
   confidence window. If the window remains clean, remove the shadow on or
   after 2026-08-27; production must not import it.

## Cutover amendment — 2026-07-28

The graph and walker cutover is complete. Public traversal methods are now
asynchronous and immutable: successful operations return a new state, while a
refusal returns no state and leaves the input byte-for-byte unchanged. Walker
state is explicit data rather than mutable Prolog facts, so concurrent callers
cannot leak traversal state through the singleton engine.

Persisted state is a hard v2 format with `version: 2` and
`activationStartedAt`. Version 1 is intentionally rejected; callers
re-initialise rather than relying on an implicit migration. Direct self-loops
preserve the activation timestamp, which makes timeout behaviour durable
across process restarts.

Engine performance is recorded by `npm run bench:engine`. It is measurement
only: this decision establishes no latency threshold.

## Consequences

- New graph diagnostics land spec-first: clause → structured finding →
  conformance vector → presentation adapter.
- The fact schema (`marionette facts`, spec/rules/README.md) is a public
  contract; changes to it are spec changes.
- A future non-TS implementation (or the pi agent's native ingestion)
  targets the rules + vectors, not the TS source.
- The API cutover is intentionally breaking: `compile`, validation, briefs,
  rendering, runtime replay and all walker operations await the shared engine.
