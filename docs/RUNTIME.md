# Marionette local runtime

`marionette runtime` turns the existing compiled graph and walker into a
single-writer local process. It is deliberately not an MCP server: an agent
host communicates with it over newline-delimited JSON (NDJSON), consumes most
lifecycle events programmatically, and injects only the compact projection the
model needs.

The DSL and trajectory contract are unchanged. The runtime consumes the same
validated trajectory JSON as `brief` and `state`.

## Start or resume a run

Create a run whose connection is bound to an agent principal:

```console
marionette runtime plan.mar --run implementation --create \
  --principal coding-agent --role agent \
  --principal-uri pibarm://session/example
```

Resume it after the process or host restarts:

```console
marionette runtime plan.mar --run implementation \
  --principal coding-agent --role agent
```

The default store is `.marionette` beside the plan. `--store <dir>` overrides
it. Standard output contains protocol messages only; startup, shutdown and
diagnostic text goes to standard error.

`--role human` is for a trusted user-facing host connection. Role is fixed
when the process starts and is absent from command payloads, so an agent cannot
cross an `@human` checkpoint by changing an `actor` field. A host must not let
an untrusted model choose its launch arguments.

## Framing and handshake

Each input line is one JSON request. Each output line is either its correlated
response or an event notification. Requests and journal events are individually
bounded at 64 KiB.

The first request initializes the connection:

```json
{"protocol":"0.1.0","id":1,"op":"initialize","client":{"name":"pibarm","version":"0.1"}}
```

After initialization, the host uses:

- `next` — read the current projection.
- `choose` — take an exact choice id with rationale, expected revision and
  optional idempotency key.
- `advance` — follow a divert with the same write controls.
- `record` — attach a graph-linked record without moving the walker.
- `events` — replay journal events after a sequence cursor.

Writes return their receipt and the next projection together. Successful
writes are followed by event notification lines; a host that does not need
push handling can ignore those and use `events` by cursor.

## Compact context profiles

`next`, `choose`, and `advance` accept `profile`:

- `signal` — status, node identity and currently available choices. It omits
  node prose, targets, variables and history.
- `work` — the default; adds the current node body, refs and choice targets.
- `debug` — adds blocked choices, gates, variables, metadata and progress.

`budget.maxItems` bounds choices and `budget.maxBodyChars` bounds inline node
prose. Truncated projections contain `truncated: true`, an `omitted` summary
and a `bodyRef` that can be resolved against the archived trajectory.

```json
{"protocol":"0.1.0","id":2,"op":"next","profile":"signal","budget":{"maxItems":4}}
```

The host should keep event traffic outside model context. Wake or prompt the
model only for actionable states such as a new node, `human.required`,
`run.stranded`, or `run.completed`.

## Writes, identity and retries

A choice command is intentionally small:

```json
{"protocol":"0.1.0","id":3,"op":"choose","choiceId":"build#0","rationale":"unit and integration tests pass","expectedRevision":2,"idempotencyKey":"turn-42","profile":"signal"}
```

- Choice ids must be exact; CLI label prefixes are not accepted.
- `expectedRevision` rejects stale writers.
- Repeating the same `idempotencyKey` and command returns the original receipt
  without appending another decision.
- Reusing a key for different command content is refused.
- The process-bound principal—not request data—is recorded as the actor.

`record` provides pibarm-style graph-linked decision records without advancing:

```json
{"protocol":"0.1.0","id":4,"op":"record","kind":"architecture-decision","summary":"Use local NDJSON IPC","rationale":"The host can filter lifecycle traffic before model context","expectedRevision":3,"idempotencyKey":"adr-7"}
```

Every event carries the immutable trajectory hash, current node/choice when
applicable, and a `marionette://trajectory/...` URI.

## Persistence and recovery

The store contains:

```text
.marionette/
├── graphs/<hash>.trajectory.json
└── runs/<run-id>/
    ├── events.jsonl
    └── snapshot.json
```

The append-only event journal is authoritative. Compiled trajectories are
archived by content hash so historical decision references remain resolvable.
Snapshots are fsynced and atomically renamed; on resume they are rebuilt from
the journal, repairing a missing or interrupted snapshot write. One runtime
process owns writes for a run.

The protocol schema is
[`spec/runtime-protocol.schema.json`](../spec/runtime-protocol.schema.json).
