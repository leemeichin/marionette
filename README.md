# Marionette

**The project plan is the agent's script; the compiler guarantees the script is sound; humans author and gate it.**

Marionette is a plain-text trajectory language for projects and decision trees, inspired by [Ink](https://github.com/inkle/ink) and its compiler `inklecate`. Humans author (with AI assistance) a legible script of phases, decisions, gates, and human checkpoints; the compiler validates it into a canonical JSON graph; an AI agent traverses that graph — bounded, auditable, and unable to route around the plan.

```
VAR iteration = 0

=== build_mvp ===
Ship the smallest testable slice.
~ iteration += 1
* [Metrics green] @human -> beta_launch
+ {iteration < 3} [Learnings, go again] ~loop~ -> build_mvp
* {iteration >= 3} [Three strikes] -> pivot_or_kill
```

```console
$ marionette validate plan.mar        # dead ends, unreachable phases, undeclared
                                      # cycles, unbounded loops → compile errors
$ marionette compile plan.mar         # → plan.trajectory.json (the contract)
$ marionette render plan.mar          # → Mermaid graph, human gates highlighted
$ marionette summarize plan.mar       # → plain-language review summary
$ marionette state init plan.mar      # → plan.state.json bound by content hash
$ marionette state choose plan.mar 1 --actor agent --rationale "metrics red, iterate"
```

## Getting started

```console
$ npm install && npm run build
$ node bin/marionette.js validate examples/build_mvp.mar
$ npm test
```

## Layout

- `docs/PRD.md` — product requirements document
- `docs/DSL.md` — DSL v0 language reference
- `docs/decisions/` — architecture decision records (ADR-0001: Ink reuse → influence-only)
- `docs/PARKING.md` — out-of-scope ideas parking lot
- `spec/` — the trajectory JSON schema (the contract between authoring and execution)
- `src/` — compiler, validators, gate analysis, renderer, summarizer, state engine, CLI
- `plans/` — dogfood: Marionette's own development trajectory (G5)
- `examples/`, `tests/` — worked examples, golden files, and a failing fixture per defect class

## Status

Phase 1 in progress. Done: OQ1 spike (ADR-0001, influence-only), trajectory
JSON schema v0, DSL v0 compiler with structural validation (P0.1–P0.4),
Mermaid render + summaries (P0.6), hash-bound state with drift detection
(P0.7), CI-ready CLI (P0.8), and a minimal reference walker so dogfooding can
start now. Next: the NL → draft-script authoring skill (P0.5), then Phase 2
(agent ingestion — see `plans/marionette.mar`).
