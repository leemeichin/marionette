# Trajectory JSON — the contract (v0.5.0)

The compiled contract between Phase 1 (authoring/validation) and Phase 2 (agent
ingestion). `marionette compile plan.mar` produces a document conforming to
[`trajectory.schema.json`](./trajectory.schema.json); the runtime/agent consumes
it and never re-reads the DSL.

Phase 2 adds two sibling contracts:

- [`brief.schema.json`](./brief.schema.json) — the **work packet**
  (`marionette brief --json`): the ingestion surface executors act on.
- [`conformance/`](./conformance/README.md) — runtime-agnostic walk scripts
  any walker implementation must pass.
- [`runtime-protocol.schema.json`](./runtime-protocol.schema.json) — compact
  NDJSON requests for the local runtime process. Principal identity is bound
  by the connection and intentionally absent from request bodies.

## Top-level shape

```jsonc
{
  "spec": "0.5.0",                  // version of this document shape
  "hash": "sha256:…",               // content hash — see below
  "source": { "file": "plan.mar" }, // provenance; NOT part of the hash
  "variables": {                    // typed declarations
    "iteration": { "type": "number", "initial": 0, "line": 3 },
    "remaining": { "type": "number", "initial": null, "line": 4 }
  },
  "start": "build_mvp",             // entry node id
  "nodes": [ /* phases: body, actions, choices, next, meta, refs */ ],
  "meta": { "project": "…" },       // namespaced extension metadata
  "refs": [                         // normalised external references
    { "provider": "github", "kind": "repo", "id": "acme/platform", "url": "https://github.com/acme/platform" }
  ]
}
```

Key concepts, mapped to the PRD's requirements:

- **Nodes and choices** (P0.2): each node has prose `body`, entry `actions`
  (mutations), `choices` (edges with `label`, `sticky`, `gate`, `human`,
  `ask`, `loop`, optional `timeout`, `target`), observation checkpoints, and an
  optional automatic `next` step. `"END"` is the reserved terminal target.
- **Runtime observations:** a declaration with `initial: null` is late-bound
  and suspends initial entry until supplied. Node observations explicitly
  invalidate and refresh a typed scalar before that node may branch. Values
  and rationales are audited in state separately from decisions.
- **Temporal exits:** `choice.timeout` stores a parsed duration. Before expiry
  it is blocked; after expiry it becomes authoritative over ordinary exits.
- **Gates** (P0.4): stored both as `source` text (legibility) and as an
  expression `ast` (evaluation). The compiler statically verifies only what is
  trivially decidable and warns about the rest.
- **`@ask` operator decisions** (choice `ask: true`, spec 0.6+): the trusted
  operator selects one authored route with rationale; an agent cannot choose.
- **`@input` checkpoints** (choice `input: true`): an agent opens a focused
  question and the operator's answer advances the fixed edge.
- **`@human` external actions** (choice `human: true`, spec 0.6+): execution
  waits for another person's identity and durable evidence through `confirm`.
  Archived spec-0.5 ask/human bits retain their original runtime meaning.
- **`~loop~` edges** (choice `loop: true`): declared cycles. The compiler
  rejects undeclared cycles and loops without a satisfiable exit; the exit
  metadata lives on the sibling choices of the loop's cycle.
- **Content hash** (P0.7): sha256 over the canonical form of the document —
  keys sorted, no whitespace, with `hash`, `source` and all `line` fields
  excluded. Comments, formatting and file moves therefore do *not* invalidate
  state; any semantic change (variables, bodies, gates, edges, metadata) does.
  `plan.state.json` records this hash; on mismatch the runtime refuses to walk
  and asks for reconciliation.
- **Namespaced metadata** (P2 design insurance): `meta` objects at plan and
  node level carry `namespace:key` entries (e.g. `github:issue`) written as
  `# github:issue: 42` tag lines in the DSL. Extensions live here and cannot
  collide with the core contract. Repeated keys accumulate into arrays.
- **External refs**: the well-known namespaces (`github:*`, `jira`,
  `linear`, `ref`) are additionally normalised into structured `refs`
  (`{provider, kind, id, url}`) at plan and node level — see
  `docs/EXECUTION.md`. Unknown namespaces remain raw meta.

## State file (`plan.state.json`)

Not part of this schema (it is runtime state, not authored contract), but its
shape is stable:

```jsonc
{
  "version": 2,             // hard format version; older states are rejected
  "hash": "sha256:…",       // trajectory hash this state is bound to
  "status": "active",       // or "completed" once END is reached
  "current": "build_mvp",
  "variables": { "iteration": 2 },
  "pendingObservations": [],
  "pendingEntry": false,
  "activationStartedAt": "2026-07-28T10:00:00.000Z", // null after END
  "taken": ["build_mvp#1"], // exhausted once-only choices
  "observations": [
    { "at": "…", "actor": "…", "name": "remaining", "value": 7, "rationale": "queue query returned 7" }
  ],
  "pendingElicitation": null, // or the open @input question and fixed choice
  "elicitations": [],         // asked/answered clarification audit entries
  "log": [                  // decision log (G4): every taken branch
    { "at": "…", "actor": "…", "from": "…", "choice": "…", "label": "…", "to": "…", "rationale": "…" }
  ]
}
```

Direct self-loops preserve `activationStartedAt`, so timeout budgets survive
restarts and cannot be reset by retrying the same phase. Walker transitions
are asynchronous and immutable; successful operations return the next state.
Open question OQ5 (embed the log here vs. append-only sidecar) is still open;
v2 embeds it.
