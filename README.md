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
$ marionette brief plan.mar --json    # → work packet: what an executor does next
$ marionette state choose plan.mar 1 --actor agent --rationale "metrics red, iterate"
$ marionette state rebind plan.mar    # migrate state onto an edited plan, keeping the log
$ marionette start plan.mar --run agent-1  # start a local agent runtime
```

## Getting started

```console
$ npm install && npm link      # builds and puts `marionette` on your PATH
$ marionette validate examples/build_mvp.mar
$ npm test
```

Or zero-clone from anywhere: `npx --yes github:leemeichin/marionette validate plan.mar`.

**Install the authoring skill** (drafts plans from natural-language notes) in
any Claude Code session:

```
/plugin marketplace add leemeichin/marionette
/plugin install marionette@marionette
```

Full install options and the dogfood kick-off protocol: [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md).

## Layout

- `docs/PRD.md` — product requirements document
- `docs/DSL.md` — DSL v0 language reference
- `docs/EXECUTION.md` — Phase 2: the executor loop, work packet, refs, delivery config, escalation
- `docs/RUNTIME.md` — local start/stop lifecycle and compact NDJSON protocol
- `docs/decisions/` — ADRs (0001: Ink influence-only; 0002: TypeScript now, contract-first portability)
- `skills/marionette-authoring/` — the P0.5 authoring skill: NL notes → validated `.mar`
- `skills/marionette-execution/` — the executor skill: brief → work → recorded decision (both installable as a plugin)
- `docs/GETTING-STARTED.md` — install the CLI + skills, and the dogfood kick-off protocol
- `docs/PARKING.md` — out-of-scope ideas parking lot
- `spec/` — the contracts: trajectory JSON, brief (work packet), walker conformance suite
- `spec/runtime-protocol.schema.json` — versioned local runtime request contract
- `src/` — compiler, validators, gate analysis, renderer, summarizer, state engine, brief, CLI
- `plans/` — dogfood: Marionette's own development trajectory (G5)
- `examples/`, `tests/` — worked examples (incl. the Phase 2 baseline), golden files, conformance runner

## Status

Phase 1 feature-complete: trajectory JSON schema v0 (P0.1), DSL v0 compiler
with structural validation and gate checking (P0.2–P0.4), the authoring
skill (P0.5), Mermaid render + summaries (P0.6), hash-bound state with drift
detection (P0.7), CI-ready CLI (P0.8). The dogfood gate passed (38 authoring
sessions, 36/36 first-pass clean on the compile metric).

Phase 2 (ingestion & execution) is underway: the `brief` work packet
(`spec/brief.schema.json`) is the executor's ingestion surface; external
refs (`github:`/`jira`/`linear`/`ref`) and delivery config (`delivery:`/
`report:`) ride on plan metadata; the reference walker enforces gates,
`@human` escalation and rationale logging with machine-readable refusal
codes; `state rebind` migrates live state across plan edits; and a
runtime-agnostic conformance suite (`spec/conformance/`) holds any future
walker to the same behaviour — the pi agent integration is next (issue #4,
OQ2 escalation channel). Dogfooding is live: `plans/marionette.mar` tracks
this project and CI re-validates plan + state drift on every push.
