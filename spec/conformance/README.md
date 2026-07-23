# Walker conformance suite

Runtime-agnostic conformance cases for the Phase 2 walker (PRD P1, issue #3).
Any walker implementation — the TypeScript reference runtime in `src/state.ts`,
a future Go binary, the pi agent's native ingestion — must pass every case in
`cases/` to claim conformance. The TypeScript runner lives in
`tests/conformance.test.ts`.

## Case format

Each case is a JSON walk script:

```json
{
  "case": "short-name",
  "description": "what this case proves",
  "plan": "examples/paas_replatform.mar",
  "steps": [
    { "choose": "0", "actor": "agent", "rationale": "why", "expect": { "current": "auth_extraction" } },
    { "choose": "1", "actor": "agent", "expect": { "error": "rationale-required" } },
    { "advance": true, "actor": "agent", "rationale": "why", "expect": { "status": "completed" } },
    { "expect": { "variables": { "auth_cutbacks": 1 } } }
  ]
}
```

- `plan` — path relative to the repository root. The walker compiles it (or
  consumes the equivalent trajectory JSON) and initialises fresh state before
  the first step.
- Each step performs at most one operation: `choose` takes a choice by index,
  id, or unambiguous label prefix; `advance: true` follows the fallthrough
  divert. A step with neither is a pure assertion on the current state.
- `actor` defaults to `"agent"`; `rationale` is omitted where the case is
  probing refusal behaviour.

## Expectations

- `expect.error` — the operation MUST be refused with this machine code (see
  `WalkErrorCode` in `src/state.ts`: `completed`, `unknown-node`,
  `unknown-choice`, `ambiguous-choice`, `gate-blocked`, `once-exhausted`,
  `human-checkpoint`, `rationale-required`, `no-divert`, `migration-blocked`,
  `invalid-state`). A refused operation MUST leave the state unchanged — the
  runner verifies this bit-for-bit (modulo timestamps, which the runner pins).
- `expect.current` — the current node id after the step.
- `expect.status` — `active` or `completed` (the state file's status).
- `expect.variables` — a subset match against the state's variables.

Every successful `choose`/`advance` MUST append a decision-log entry carrying
actor, timestamp, target and rationale (G4); the runner checks the log length
grows by exactly one per successful operation and never on a refusal.
