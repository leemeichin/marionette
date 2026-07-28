# ADR-0004: Human escalation is a durable, host-mediated checkpoint

- **Status:** Proposed — implemented for proving-ground review
- **Date:** 2026-07-28
- **Issue:** [#4](https://github.com/leemeichin/marionette/issues/4)

## Context

`@human` is Marionette's authored autonomy boundary. The walker already
refuses an agent taking such a choice, but OQ2 left three operational questions
open: how a human is reached, what the host sends, and what happens when nobody
answers.

The runtime is deliberately transport-neutral. It cannot assume chat, Slack,
a pull-request comment, or a terminal, and transport policy must not become a
second source of graph semantics.

## Decision

1. **The host owns the channel.** In-band conversation is preferred when a
   trusted user-facing host exists; other hosts may use any channel that
   preserves the same payload and attribution.
2. **`human.required` is a durable wake signal.** It carries a stable
   escalation URI, the current expected revision, the reason, exact choices,
   and any graph-authored timeout fallbacks. The host fetches `next` before
   presenting or resolving it so node prose and the latest revision are
   current.
3. **Identity is selected at the host trust boundary.** Runtime requests never
   contain an actor field. Agent tools remain bound to an agent principal. A
   human answer enters through a distinct trusted UI/connection and is
   recorded with the human principal and their rationale.
4. **There is no implicit escalation timeout or default choice.** Silence
   leaves the run parked. If a plan needs a timed fallback, it authors a
   normal `timeout` choice; that choice and its due time appear in the
   escalation payload, and the Prolog frontier remains the authority on when
   it opens.
5. **Resolution uses the existing `choose` write.** Exact choice ids,
   expected revisions, idempotency keys, append-only events, and restart replay
   apply unchanged. Re-entering an `@human` phase creates a new escalation id.

The Pi integration implements this split with an agent-only
`marionette_walk` tool and a user-only `/marionette-decide` command.

## Consequences

- Marionette can add Slack, web, or tracker adapters without changing walker
  semantics.
- An unanswered checkpoint consumes no hidden timer and cannot silently route
  the project.
- Hosts must retain or replay event cursors and refresh `next` before writing.
- A trusted host needs two authority paths even when both share one serialized
  runtime owner.

This ADR becomes accepted only when a human records the
`escalation_protocol` exit in Marionette's own plan with a rationale.
