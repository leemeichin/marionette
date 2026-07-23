# Marionette

**The project plan is the agent's script; the compiler guarantees the script is sound; humans author and gate it.**

Marionette is a plain-text trajectory language for projects and decision trees, inspired by [Ink](https://github.com/inkle/ink) and its compiler `inklecate`. Humans author (with AI assistance) a legible script of phases, decisions, gates, and human checkpoints; the compiler validates it into a canonical JSON graph; an AI agent traverses that graph — bounded, auditable, and unable to route around the plan.

## Layout

- `docs/PRD.md` — product requirements document (current draft)
- `docs/PARKING.md` — out-of-scope ideas parking lot
- `spec/` — the trajectory JSON schema (the contract between authoring and execution)

## Status

Pre-Phase-0. Next actions: (1) OQ1 spike — evaluate reusing Ink's compiler/runtime as the engine; (2) publish trajectory JSON schema v0.
