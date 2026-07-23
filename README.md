# Marionette

**The project plan is the agent's script; the compiler guarantees the script is sound; humans author and gate it.**

Marionette is a plain-text language for project trajectories — the phases a
project moves through, the decisions that connect them, and the conditions
under which each path opens. You write a plan as a small, legible script (or
let an AI draft it from your notes); a compiler validates it into a canonical
JSON graph; an AI agent then executes the project by *walking* that graph —
bounded, auditable, and unable to route around the plan. Decisions marked
`@human` are ones the agent cannot take: it must stop and escalate to you.

The design is borrowed from [Ink](https://github.com/inkle/ink), the
interactive-fiction language, with the player swapped out: instead of a human
choosing their way through a story compiled by `inklecate`, an AI agent
chooses its way through your project — and the human holds the gates.

## What that looks like

A plan is a `.mar` file: phases (`=== name ===`), choices (`*` once-only,
`+` repeatable), gates (`{expr}`), declared loops (`~loop~`), and human
checkpoints (`@human`).

```
# project: checkout-revamp
VAR attempts = 0

=== build_checkout ===
Rebuild the checkout flow behind a feature flag.
~ attempts += 1
* [Cohort converts] @human -> rollout
+ {attempts < 5} [Conversion flat — iterate] ~loop~ -> build_checkout
* {attempts >= 5} [Not converging — rethink] @human -> rethink

=== rethink ===
Five iterations without lift: take the flow back to research.
+ [New direction agreed] @human ~loop~ -> build_checkout
* [Park the revamp] @human -> END

=== rollout ===
Ramp the flag to 100% and retire the old flow.
-> END
```

That's the whole plan: iterate on checkout conversion up to five times, a
human decides when it's shipped (or when to rethink), and every route ends
somewhere on purpose.

### The compiler holds the line

Forget the loop bound and leave a phase without an exit, and the plan does
not compile — dead ends, unreachable phases, undeclared cycles, loops with
no satisfiable exit, and `@human` checkpoints with no escalation path are
all build failures, each with a line number and a fix:

```console
$ marionette validate checkout.mar
checkout.mar:10: error[MAR006]: phase "rollout" is a dead end: no choices and no divert
  10 | === rollout ===
  help: add a choice or divert (e.g. "-> END") so every path has an exit
checkout.mar:8: error[MAR008]: undeclared cycle: build_checkout -> build_checkout
  8 | + [Conversion flat — iterate] -> build_checkout
  help: cycles must be intentional: mark the returning choice with ~loop~
✗ checkout.mar: 2 errors, 0 warnings
```

### An agent walks it, a human gates it

Once the plan compiles, traversal state lives next to it in
`checkout.state.json`, bound to the compiled graph by content hash. The
agent asks what's next, does the work, and records each decision with a
rationale:

```console
$ marionette state init checkout.mar
initialised checkout.state.json bound to sha256:86c1623dd475…
current: build_checkout
Rebuild the checkout flow behind a feature flag.
variables: attempts=1
choices:
  [0] Cohort converts @human -> rollout
  [1] Conversion flat — iterate ~loop~ {attempts < 5} -> build_checkout
  [2] Not converging — rethink @human {attempts >= 5} -> rethink  [unavailable: gate {attempts >= 5} is false]
```

The `@human` checkpoint is enforced, not advisory — the walker refuses the
agent and tells it to escalate:

```console
$ marionette state choose checkout.mar 0 --actor agent --rationale "metrics look good"
error: choice "Cohort converts" is an @human checkpoint: an agent may not take it autonomously. Escalate to a human; a human records the decision with --actor <name>.
```

So the agent takes the path that is its to take, and the human takes the
gate when the evidence is in — both logged, with actor, timestamp and
rationale:

```console
$ marionette state choose checkout.mar 1 --actor agent --rationale "conversion flat; iterating on the payment step"
current: build_checkout
Rebuild the checkout flow behind a feature flag.
variables: attempts=2
…
$ marionette state choose checkout.mar 0 --actor lee --rationale "cohort shows +9% completion; ship it"
current: rollout
Ramp the flag to 100% and retire the old flow.
variables: attempts=2
no choices; divert available -> END (marionette state advance)
```

Edit the plan mid-project and the hash binding catches it: drift is an
error (exit code 3), and `marionette state rebind` migrates the live state
onto the new graph with a report of what changed, keeping the decision log.

## The command surface

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
$ marionette import issues.json -o plan.mar  # scaffold a plan from tracker issues
$ marionette sync plan.mar --json     # → manifest: what your tracker should show
```

Humans normally don't hand-write the DSL: the bundled **authoring skill**
turns natural-language notes into a validated `.mar` draft, and `render` +
`summarize` produce the graph and plain-English walkthrough a reviewer
signs off on. The **execution skill** is the other half: it ingests the
`brief` work packet, does the work each phase describes, and records every
decision — escalating at each `@human` gate.

## Getting started

```console
$ npm install && npm link      # builds and puts `marionette` on your PATH
$ marionette validate examples/build_mvp.mar
$ npm test
```

Or zero-clone from anywhere: `npx --yes github:leemeichin/marionette validate plan.mar`.

**Install the skills** (authoring and execution) in any Claude Code session:

```
/plugin marketplace add leemeichin/marionette
/plugin install marionette@marionette
```

Full install options and the dogfood kick-off protocol: [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md).

**Documentation site:** [`docs-site/`](docs-site/) is a static site with
interactive, transcript-faithful terminal demos, the syntax reference, and
end-to-end usage guides — deployable to Cloudflare with `wrangler deploy`
(see [`docs-site/README.md`](docs-site/README.md)).

## Layout

- `docs/PRD.md` — product requirements document
- `docs/DSL.md` — DSL v0 language reference
- `docs/EXECUTION.md` — Phase 2: the executor loop, work packet, refs, delivery config, escalation
- `docs/SYNC.md` — tracker import/export: `marionette import` and the `sync` manifest (Jira/Linear/GitHub)
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
- `docs-site/` — the documentation site: terminal-faithful demos, reference, guides
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
walker to the same behaviour. The **local runtime** has landed
(`marionette start`/`stop`, [`docs/RUNTIME.md`](docs/RUNTIME.md)): a
single-writer process speaking compact NDJSON
(`spec/runtime-protocol.schema.json`) with role-bound connections, revision
checks, idempotent writes and an append-only journal — the pi agent
integration builds on it next (issue #4, OQ2 escalation channel).
Tracker integration landed connection-free: `marionette import` ingests a
Jira/Linear/GitHub backlog into a plan, and `marionette sync` computes the
manifest an executor applies with its own tracker tools
([`docs/SYNC.md`](docs/SYNC.md)). Dogfooding is live:
`plans/marionette.mar` tracks this project and CI re-validates plan +
state drift on every push.
