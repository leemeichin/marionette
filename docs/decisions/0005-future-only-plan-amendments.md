# ADR-0005: Live plan amendments freeze completed phases, not the future

- **Status:** Proposed — implementation in progress
- **Date:** 2026-07-30

## Context

A trajectory hash currently makes all semantic plan changes look alike. The
state-file walker can permissively rebind after drift, while durable runtime
runs reject every graph change. Neither behavior expresses the intended
contract: recorded work is history, but unfinished work is still a plan.

An amendment must not make an old decision appear to have been taken under new
prose, actions, gates, or destinations. It must also remain deterministic after
a restart and safe when a phase id is revisited by a loop.

## Decision

1. **Completion freezes a phase id.** A phase is completed when a recorded
   choice or automatic advance leaves it. Its complete compiled node contract
   (body, entry actions, observations, choices, targets, metadata, and refs)
   is immutable in every later trajectory. The initial `plan started` entry
   does not freeze the start phase.
2. **The current activation is editable only before that id has ever been
   completed.** If a loop revisits a previously completed phase id, that node
   remains frozen. Authors add a new future phase and route to it instead of
   rewriting the repeated id. This conservative id-level rule is stable across
   state files and event replay.
3. **Never-completed phases are future.** They may be changed or removed, and
   new phases may be added, provided the compiled trajectory is valid and the
   active current phase still exists. Outgoing routes from the editable current
   phase may therefore admit newly discovered work.
4. **Variables used by frozen nodes are frozen declarations.** Their name,
   type, and initializer cannot change or disappear. Other declarations may be
   added, changed, or removed; migration preserves compatible live values and
   reports additions, removals, resets, and required observations.
5. **An open input request is an active interaction contract.** Its exact choice id,
   `@input` marker, and target must survive until answered. Amendments that alter
   it are refused even when its phase is otherwise editable.
6. **History resolves through graph epochs.** Every historical record keeps its
   original graph hash. Applying an amendment archives the new trajectory and
   appends one attributed `plan.rebound` event linking old and new hashes; no
   prior event or archived graph is rewritten.
7. **Approval is a trust-boundary operation.** Agents may compile and propose a
   candidate. A local CLI user or trusted host may inspect the complete
   decision packet—semantic diff, proposal rationale, and graph artifacts—and
   apply it with an actor and rationale. This is an operator `@ask`-class
   decision, not evidence for an `@human` action. The model-facing
   traversal tool cannot approve an amendment.
8. **Validation is pure and application is atomic.** Comparison produces a
   structured allowed-change/violation report without mutating state. A
   refusal leaves the source, state, snapshot, journal, and active graph
   unchanged.

Plan-level descriptive metadata may evolve because historical events resolve
against their archived graph. It does not override the frozen node and
variable rules above.

## Required conformance cases

- allow adding a phase after the editable current phase;
- allow editing or deleting a never-completed future phase;
- reject any semantic change to a completed phase or its choices;
- reject deleting the current phase;
- reject changing a variable referenced by a completed phase;
- preserve an open `@input` edge exactly (and replay legacy spec-0.5 `@ask` inputs);
- freeze a phase id after one loop activation has completed it;
- preserve old graph references through amendment, replay, and restart;
- reject stale or concurrent amendment writes without partial persistence.

## Consequences

- Rebinding now requires the old hash-addressed trajectory; a legacy state that
  lacks it must establish a baseline before the source is edited or restore
  the old source.
- A source file can contain frozen phases even though only future phases remain
  executable. The archive, rather than mutable source text, is authoritative
  for historical interpretation.
- Runtime controllers and journals become graph-epoch aware, but ordinary walk
  commands remain bound to exactly one current graph at a time.
