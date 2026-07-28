# Marionette start/stop

`marionette start` turns the existing compiled graph and walker into a
single-writer local process. It is deliberately not an MCP server: an agent
host communicates with it over newline-delimited JSON (NDJSON), consumes most
lifecycle events programmatically, and injects only the compact projection the
model needs.

The runtime consumes the same validated trajectory JSON as `brief` and
`state`, including late-bound observations and temporal exits.

## Start or resume a run

Create a run whose connection is bound to an agent principal:

```console
marionette start plan.mar --run implementation \
  --principal coding-agent --role agent \
  --principal-uri pibarm://session/example
```

If the run does not exist, `start` creates it. If it already exists, `start`
resumes it. Use `--create` when you want creation to fail if the run exists.

Stop a registered foreground/background process from another terminal:

```console
marionette stop plan.mar --run implementation
```

Or press Ctrl-C in the terminal running `start`.

`marionette runtime` remains accepted as a compatibility alias for hosts that
adopted the initial spike spelling.

Resume it explicitly after the process or host restarts:

```console
marionette start plan.mar --run implementation \
  --principal coding-agent --role agent
```

The default store is `.marionette` beside the plan. `--store <dir>` overrides
it. Standard output contains protocol messages only; friendly start/stop and
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
{"protocol":"0.2.0","id":1,"op":"initialize","client":{"name":"pibarm","version":"0.1"}}
```

After initialization, the host uses:

- `next` — read the current projection.
- `choose` — take an exact choice id with rationale, expected revision and
  optional idempotency key.
- `advance` — follow the automatic next step with the same write controls.
- `observe` — supply a requested scalar value with its source/evidence in the
  rationale. This does not move the walker.
- `record` — attach a graph-linked record without moving the walker.
- `events` — replay journal events after a sequence cursor.

Writes return their receipt and the next projection together. Successful
writes are followed by event notification lines; a host that does not need
push handling can ignore those and use `events` by cursor.

## Compact context profiles

`next`, `choose`, `advance`, and `observe` accept `profile`:

- `signal` — status, node identity and currently available choices. It omits
  node prose, targets, variables and history.
- `work` — the default; adds the current node body, refs and choice targets.
- `debug` — adds blocked choices, gates, variables, metadata and progress.

`budget.maxItems` bounds choices and `budget.maxBodyChars` bounds inline node
prose. Truncated projections contain `truncated: true`, an `omitted` summary
and a `bodyRef` that can be resolved against the archived trajectory.

```json
{"protocol":"0.2.0","id":2,"op":"next","profile":"signal","budget":{"maxItems":4}}
```

The host should keep event traffic outside model context. Wake or prompt the
model only for actionable states such as a new node, `observation.required`,
`human.required`, `run.stranded`, or `run.completed`.

## Writes, identity and retries

A choice command is intentionally small:

```json
{"protocol":"0.2.0","id":3,"op":"choose","choiceId":"build#0","rationale":"unit and integration tests pass","expectedRevision":2,"idempotencyKey":"turn-42","profile":"signal"}
```

- Choice ids must be exact; CLI label prefixes are not accepted.
- `expectedRevision` rejects stale writers.
- Repeating the same `idempotencyKey` and command returns the original receipt
  without appending another decision.
- Reusing a key for different command content is refused.
- The process-bound principal—not request data—is recorded as the actor.

An observation command fills exactly one value requested by the projection:

```json
{"protocol":"0.2.0","id":4,"op":"observe","name":"remaining","value":7,"rationale":"7 items returned by the queue query at 09:30Z","expectedRevision":3,"idempotencyKey":"queue-2026-07-28T09:30Z","profile":"signal"}
```

Values are typed scalars: number, boolean, or string. An initial declaration
such as `VAR remaining: number = ?` suspends entry to the start phase until it
is supplied. A node-level `? remaining` requests a refresh only when that
checkpoint is reached; the value then remains stable while the captured batch
is drained. Each successful observation emits `observation.recorded` and is
kept in a separate audit stream from branch decisions.

`record` provides pibarm-style graph-linked decision records without advancing:

```json
{"protocol":"0.2.0","id":5,"op":"record","kind":"architecture-decision","summary":"Use local NDJSON IPC","rationale":"The host can filter lifecycle traffic before model context","expectedRevision":4,"idempotencyKey":"adr-7"}
```

Every event carries the immutable trajectory hash, current node/choice when
applicable, and a `marionette://trajectory/...` URI.

## Timeouts

`timeout 3d -> fallback` is a hard temporal edge. The projection reports it as
blocked with `timeout-pending` before the phase budget expires. Once expired,
ordinary choices and automatic next steps are blocked with `timed-out`, and
the timeout edge becomes available. A direct self-loop retains the activation
time; leaving the phase and later entering it starts a new budget.

The runtime evaluates time when processing the next command. It deliberately
does not schedule its own wake-up; a long-lived host may schedule one and call
`next` at expiry. Legacy `# timebox:` metadata remains advisory and does not
have these semantics.

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
