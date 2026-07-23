# Plan summary: plans/runtime_process.mar

Starts at **protocol_contract**. 6 phases, 0 decision points (phases with 2+ choices), 6 choices overall.

- **Human checkpoints:** none — the agent can traverse the whole plan autonomously
- **Declared loops:** none
- **Gates:** 0 gated choices, of which 0 unverified (review manually)
- **Variables:** none
- **Contract hash:** `sha256:038e9db48db1…`

## Traversal status

The plan is **completed** (reached END) after 7 steps.

Decisions taken:
- 2026-07-23T18:45:05.619Z — **agent** chose "Protocol contract tests pass" at protocol_contract → command_engine — Runtime protocol v0.1 types, strict parser, graph references and JSON Schema added; TypeScript check and 5 focused contract tests pass, including rejection of actor spoofing.
- 2026-07-23T18:47:12.265Z — **agent** chose "Command engine tests pass" at command_engine → event_persistence — Immutable runtime command processor added with principal-bound human authority, exact choice IDs, optimistic revisions, idempotent retries, graph-linked lifecycle events and signal/work/debug projections; TypeScript check and 10 focused tests pass.
- 2026-07-23T18:49:05.289Z — **agent** chose "Persistence and replay tests pass" at event_persistence → stdio_runtime — Added a single-writer file store with 64 KiB bounded JSONL events, fsynced atomic snapshots, hash-addressed trajectory archives, journal replay/repair, persisted idempotency and stale disk revision checks; TypeScript check and 15 focused tests pass.
- 2026-07-23T18:50:22.724Z — **agent** chose "Stdio integration tests pass" at stdio_runtime → cli_and_docs — Added a handshake-gated single-writer NDJSON service with 64 KiB request bounds, correlated compact responses, event notifications, clean stdout/stderr separation and durable commits; TypeScript check and 17 focused tests including stdio integration pass.
- 2026-07-23T18:54:03.161Z — **agent** chose "CLI surface and runtime guide are complete" at cli_and_docs → verification — CLI now exposes create/resume runtime mode with principal binding and clean stdio; runtime guide documents NDJSON framing, compact profiles, context filtering, retries, graph-linked records and recovery, with README/spec/execution links. Build and 19 focused tests pass.
- 2026-07-23T18:55:13.282Z — **agent** chose "Full verification passes" at verification → END — Full verification passed: TypeScript check, production build, strict plan validation, JSON parsing, git diff hygiene, compiled-bin NDJSON traversal, and all 83 tests including existing walker conformance and new runtime coverage.

## Walkthrough

### protocol_contract (start)
The runtime protocol is a small, versioned command/query/event contract that
does not depend on MCP or change the DSL. Its schemas and fixtures define
compact projections, exact choice references, revisions and idempotency.
- **Protocol contract tests pass** → command_engine

### command_engine
The existing walker is wrapped by an immutable command processor that binds
principal roles, rejects stale revisions and returns lifecycle events plus the
next compact projection without duplicating graph semantics.
- **Command engine tests pass** → event_persistence

### event_persistence
Runtime events are durably appended as bounded JSONL records, compiled graphs
are archived by content hash, and state snapshots are written atomically so a
run can be reopened and its historical graph references resolved.
- **Persistence and replay tests pass** → stdio_runtime

### stdio_runtime
A single-writer runtime process accepts newline-delimited JSON commands over
stdio, emits correlated responses and lifecycle events, and keeps diagnostics
on stderr so an agent host can communicate without context-heavy tooling.
- **Stdio integration tests pass** → cli_and_docs

### cli_and_docs
The CLI exposes the runtime process and documentation explains ownership,
framing, compact context profiles, identity boundaries and how a host should
consume events without injecting the whole stream into model context.
- **CLI surface and runtime guide are complete** → verification

### verification
The TypeScript check, complete test suite, existing walker conformance cases
and a representative end-to-end runtime traversal all pass without changing
the Marionette DSL or weakening current refusal guarantees.
- **Full verification passes** → END

## Compiler report

No defects, no warnings. The plan is structurally sound: every phase is reachable, every path has an exit, and all declared loops have a verified exit.
