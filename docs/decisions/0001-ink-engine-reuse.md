# ADR-0001: Ink engine reuse — influence-only

**Status:** Accepted · **Date:** 2026-07-23 · **Resolves:** PRD OQ1

## Context

OQ1 asked whether to reuse Ink's compiler/runtime as Marionette's engine, or
treat Ink as influence-only. inklecate already detects loose ends and undefined
arrow transitions, and the Ink runtime evaluates conditions dynamically. The C# `dotnet`
runtime is not available in our target environments, but `inkjs` 2.4.0 ships a
full TypeScript port of the inklecate compiler, so the spike evaluated that.

## Spike

A Marionette-shaped plan (counter variable, gated choices, tags standing in for
`@human`/`~loop~`) was compiled with `inkjs/full`'s `Compiler`. Findings from
the emitted JSON:

1. **Ink's compiled JSON is a stack-machine bytecode, not a graph.** Gates
   compile to RPN instruction streams (`"ev"`, `{"VAR?": "iteration"}`, `3`,
   `"<"`, `"/ev"`); choices become container references with flag bitmasks
   (`{"*": ".^.c-1", "flg": 21}`); targets become relative container paths
   (`".^.^.^"`). Recovering a legible node/edge/gate graph from this means
   writing a decompiler — the opposite of P0.1's contract, and fatal to G3
   (reviewer legibility) since our JSON *is* the reviewable artifact.
2. **Our differentiating constructs don't fit.** `@human` and `~loop~` can ride
   along as Ink tags, but they'd be annotations the Ink engine ignores rather
   than first-class, validated semantics. Loop-exit satisfiability, undeclared
   -cycle detection, and human-escalation checks would still have to be written
   by us — against Ink's bytecode instead of a clean AST.
3. **Metadata carriage is awkward.** The Ink JSON format has no sanctioned
   extension point; our namespaced `meta` would have to live outside the
   document, breaking the single-artifact contract.
4. **What we'd actually reuse is small.** Loose-end/undefined-target detection
   is a few dozen lines over a graph we already have to build for rendering
   and summaries. The dynamic condition evaluator is ~200 lines (Pratt parser
   + evaluator).

## Decision

**Influence-only.** Marionette keeps Ink's *language design* (knots → phases,
`*`/`+` choices, `->` transitions, `{}` conditions, `~` mutations, `VAR`, `END`)
and its three-layer architecture, but implements its own compiler in
TypeScript with zero runtime dependencies. The compiled trajectory JSON is a
plain, schema-validated graph (`spec/trajectory.schema.json`).

Gate reachability uses trivially-decidable static analysis (constants,
never-mutated variables, monotonic counters) per P0.4, not Ink-style
exhaustive simulation; a simulation mode over our own graph remains a P1
option (PRD "Simulation mode") and is cheap to add because the walker already
exists in `src/state.ts`.

## Consequences

- We own ~2k lines of compiler/validator instead of a dependency on inkjs.
- The DSL can diverge from Ink where projects need it (typed vars, `@human`,
  `~loop~`, tags-as-metadata) without fighting a narrative-focused upstream.
- No tunnels/threads/interpolation unless we deliberately add them (PRD §4).
- The spike script is preserved in this ADR's history; re-evaluating later is
  cheap because the trajectory contract — not the engine — is the seam (PRD
  §2, design decision 5).

## Addendum (2026-07-23): does the compiled graph even need to be legible?

Review asked the sharper question: if we depended on Ink directly, would
compiled-artifact legibility matter at all? Honest answer: **legibility alone
is not the blocker.** G3 is satisfied by the DSL script plus the rendered
graph and summary, which could be produced from source. The compiled artifact
could in principle be opaque.

What it cannot be is **shapeless**. The hard requirements on the compiled
contract are graph-shape and stable node identity, because they carry:

- our differentiating validations (undeclared cycles, loop-exit
  satisfiability, `@human` escalation) — none of which inklecate performs, so
  they must be implemented against *some* graph model regardless;
- semantic content-hashing and state binding (P0.7), and the Phase 2
  migration report, which need node identity that survives recompilation —
  Ink's nested-container layout is compiler-version-sensitive;
- node-addressable metadata (`github:issue` per node) for tracker mapping;
- cheap multi-runtime ingestion: computing "what can I do next" from graph
  JSON is a page of code in any language, whereas Ink bytecode requires
  embedding a full Ink runtime (ports: C#, JS, Java, Rust — no Go).

So Ink-direct would not remove the need for a graph model; it would add a
decompilation step in front of one. Once graph-shape exists, legible JSON is
the same artifact at no extra cost. What Ink-direct genuinely offers —
battle-tested weave semantics and gate reachability via "simulate all paths"
— is available on our format too: the reference walker already exists, and
simulation mode over it is the planned P1 feature. Decision unchanged.
