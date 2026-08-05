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
{"protocol":"0.5.0","id":1,"op":"initialize","client":{"name":"pibarm","version":"0.1"}}
```

After initialization, the host uses:

- `next` — read the current projection.
- `choose` — take an autonomous choice or trusted operator `@ask` route with
  rationale, expected revision and optional idempotency key.
- `confirm` — attest an `@human` action with a human principal and at least
  one durable evidence reference. The protocol's `external-human` role means
  external to agent authority, not necessarily a different session operator.
- `ask` — open an exact `@input` choice with a focused question and rationale.
- `answer` — supply human-authored context for the open elicitation.
- `advance` — follow the automatic next step with the same write controls.
- `observe` — supply a requested scalar value with its source/evidence in the
  rationale. This does not move the walker.
- `record` — attach a graph-linked record without moving the walker.
- `events` — replay journal events after a sequence cursor.

Writes return their receipt and the next projection together. Successful
writes are followed by event notification lines; a host that does not need
push handling can ignore those and use `events` by cursor.

## Compact context profiles

`next`, `choose`, `ask`, `answer`, `advance`, and `observe` accept `profile`:

- `signal` — status, node identity and currently available choices. It omits
  node prose, targets, variables and history.
- `work` — the executor-complete default; adds plan intent, delivery policy,
  the complete node body and frontier, refs, targets, gates, blockers,
  variables, progress, pacing metadata and timeout deadlines.
- `debug` — the same complete packet plus raw node metadata for diagnosis.

`budget.maxItems` bounds choices and `budget.maxBodyChars` bounds inline node
prose. Truncated projections contain `truncated: true`, an `omitted` summary
and a `bodyRef` that can be resolved against the archived trajectory.

```json
{"protocol":"0.5.0","id":2,"op":"next","profile":"signal","budget":{"maxItems":4}}
```

The host should keep event traffic outside model context. Wake or prompt the
model only for actionable states such as a new node, `observation.required`,
`operator.required`, `external.required`, `elicitation.required`,
`run.stranded`, or `run.completed`.

## Operator decisions and evidenced human confirmations

`operator.required` wakes the trusted host when `@ask` routes require its
current operator. `external.required` parks until a human attests the action
with durable evidence. Both project a stable escalation id and a complete decision packet: plan
intent, full phase body, refs, variables, progress, exact choices,
target titles/effects, expected revision, response operation, evidence
requirement, and graph-authored fallbacks.

The operator resolves `@ask` with an exact `choose` under a human-bound
principal. `@human` instead requires evidenced `confirm`. The wire role remains
`external-human` because the authority is outside the agent; the confirmer may
also be the current Pi operator:

```json
{"protocol":"0.5.0","id":3,"op":"confirm","choiceId":"approval#0","rationale":"maintainer approved PR #12","expectedRevision":2,"evidence":[{"provider":"github","kind":"review","id":"acme/repo#12","url":"https://github.com/acme/repo/pull/12#pullrequestreview-1"}]}
```

Success emits `external.confirmed` with the actual human actor and evidence.
The runtime does not compare that actor with the plan committer or operator.
Agent tools cannot issue either trusted response. Silence parks the run; only
a graph-authored timeout fallback may end the wait.

## Input elicitation

`@input` is a two-write exchange. An agent-bound principal opens it:

```json
{"protocol":"0.5.0","id":3,"op":"ask","choiceId":"design#1","question":"Must the release run without network access after unpacking?","rationale":"the packaging route depends on this constraint","expectedRevision":2,"idempotencyKey":"ask-42"}
```

The runtime emits `elicitation.required` and projects
`awaiting-elicitation`. The payload has a stable activation id, the focused
question and the already-authored edge. A human-bound principal answers:

```json
{"protocol":"0.5.0","id":4,"op":"answer","answer":"Yes; unpacking is allowed, but no runtime download.","expectedRevision":3,"idempotencyKey":"answer-42"}
```

The runtime records `elicitation.answered`, advances the fixed edge and
resumes the agent. The answer is context rather than authority: it neither
chooses a target nor confirms an evidenced `@human` action.

## Graph epochs and live amendments

A durable run is not tied to one graph forever. It is tied to an append-only
sequence of graph epochs. Ordinary decisions retain the trajectory hash that
was current when they were recorded. A trusted future-only amendment:

1. compares the archived current trajectory with the compiled candidate;
2. refuses changes to every completed phase id and variable declaration used
   by completed work;
3. archives the candidate by hash;
4. migrates the live future state; and
5. appends one human- or system-attributed `plan.rebound` event containing the
   old/new hashes, rationale, expected revision, and structured report.

Journal replay starts from `run.started`, resolves each archived trajectory,
and switches graphs only at `plan.rebound`. Historical events are never
rewritten to the new hash. Revisions and the single-writer snapshot check apply
to amendments just as they do to decisions; a stale concurrent amendment
leaves the accepted epoch active.

Amendment approval is intentionally not an agent runtime request. A trusted
host uses `RuntimeRunController.amend` (the Pi host API wraps it), while the
model-facing command plane remains `next|choose|ask|answer|advance|observe|record|events`;
trusted hosts additionally expose external `confirm`.
This keeps graph authority at the same trust boundary as human checkpoints.

## Pi proving-ground integration

The npm package is also a Pi package. Install it once, then bind a session at
launch:

```console
pi install git:github.com/leemeichin/marionette
pi \
  --marionette-plan plans/marionette.mar \
  --marionette-run implementation
```

Trusted decisions default to the author identity that `git var GIT_AUTHOR_IDENT`
resolves in the current repository. `--marionette-human lee` remains an
explicit override. The same fallback applies to `/marionette-decide`,
`/marionette-answer`, `/marionette-confirm-human`, and amendment approval;
Marionette does not compare it with the author of an earlier commit.

The package manifest points directly at `src/pi-extension.ts`; Pi loads that
TypeScript source through its extension loader. The compiled `dist/` tree is
still produced for Marionette's library and CLI consumers, but it is not a
prerequisite for loading the Pi extension. Source imports name the real
`.ts` files; TypeScript rewrites those relative specifiers to `.js` only when
emitting `dist/`.

You can author and approve a plan entirely in this standalone package with
`/plan <task>`, `/refine-plan`, and `/approve-plan [active|worktree <name>]`,
or bind an existing plan with `/marionette-start <plan.mar> [run-id]`. Draft
mode is read-only: Pi preserves the session's inspection and planning tools,
adds `marionette_draft`, and blocks built-in project writes, traversal, and
mutating shell commands.

`marionette_draft` compiler-checks complete DSL source before atomically
writing a `.mar` file. Invalid drafts never touch disk. Successful drafts are
shown immediately as a durable review card and include a minimal terminal
graph plus plain-language summary. The approval dialog repeats the plan
overview and compact walkthrough beside its choices, so approval does not rely
on transcript backscroll. The tool also writes sibling `.mmd` and `.svg` files
and returns their paths and `file:` URIs for out-of-band viewers. Overwriting
is opt-in for explicit refinement.

Worktree approval asks once per Pi session whether to enable GitHub's official
`gh stack` public-preview flow when the repository is hosted on GitHub. Opting
in requires GitHub CLI 2.90+, installs `github/gh-stack` only when needed, and
initializes the worktree branch against the repository trunk. Declining or a
setup failure keeps the normal worktree. The persisted execution metadata
records `branching: "standard" | "github-stack"`; stack layers stay together
inside that one worktree.

For a bound run, `marionette_amend` validates complete candidate source against
completed history, leaves the live source untouched, and returns a semantic
diff plus compact output and candidate/Mermaid/SVG artifact paths. The pending
proposal survives restart and `/tree` navigation. A trusted user applies it
with `/marionette-approve-amendment`; hosts use `proposeAmendment()` and
`approveAmendment()` on the typed API.

The model gets one agent-bound traversal tool, `marionette_walk`. It mirrors
the runtime command surface:

- `capabilities`, `next`, `choose`, `ask`, `advance`, `observe`, `record`, `events`
- `signal`, `work`, and `debug` projection profiles
- projection budgets, evidence/refs, idempotency receipts and event cursors

`work` is the executor-complete default: plan intent and refs, effective
delivery policy, the complete phase body and frontier, node pacing metadata,
variables, progress, timeout deadlines, blockers and escalation data. A
caller can deliberately bound it; `truncated`/`omitted` then tell the caller
to fetch `next` again with a larger budget.

At an escalation the agent must stop. The user answers through
`/marionette-decide`, which selects a choice, resolves the user's configured or repository Git
identity, captures the rationale, records the human-bound write, and injects
the resulting projection
so the agent can resume. A trusted embedding can instead provide an
authenticated human principal through the host API described below.
At an elicitation the trusted Pi host opens a native text editor, records the
answer, and resumes the agent. Operator choices likewise open as named native
choices without internal ids. Only explicitly high-risk `@human` actions ask
for a durable evidence URL. Slash commands remain compatibility fallbacks.

The binding is stored on the active Pi session branch and restored after
restart or `/tree` navigation. `/marionette-stop` appends an unbound tombstone
without deleting the durable runtime run.

### Pi host integration contract

The extension publishes a versioned notification envelope
(`marionette.pi` / `1.6.0`) with the same shape in four places:

1. `work_packet` (and legacy `marionette_walk`) tool-result `details`;
2. `marionette-projection` custom-message `details`;
3. durable `marionette-event` custom session entries;
4. Pi's shared `marionette:event:v1` extension event channel.

Every envelope identifies its cause and current binding and may carry the
projection, emitted runtime events, revision/event-sequence receipt, replay
state, operation result, a structured error, a validated draft, or an
amendment artifact. Successful proposals emit `plan.amendment-proposed`;
trusted application emits `plan.rebound`. Runtime traversal continues to emit
binding and runtime events. A host therefore never needs to parse rendered
prose, widgets, or the runtime store.

Trusted in-process extensions discover the typed `MarionettePiHostApi` through
either:

- `marionette:ready:v1`, emitted when the extension loads; or
- `marionette:discover:v1`, with `{ respond(api) { ... } }` for load-order
  independent discovery.

The API exposes draft/execution state through `getDraft()` and `getExecution()`,
lets a thin host router call `startDraft()`, and retains `getBinding()`,
`bind()`, `unbind()`, every agent-bound runtime operation through `execute()`,
future-only proposal/review through `proposeAmendment()` and trusted
`approveAmendment()`, plus separate `humanChoose()`, `externalConfirm()`, and
`humanAnswer()` methods accepting host-authenticated principals.
`resolveHumanIdentity()` lets a trusted host reuse the package's configured
identity/Git-author fallback without duplicating it. Before prompting,
compatibility commands ask `marionette:human:v1` for an optional
host-configured actor identity, then fall back to the repository Git author.
Channel
names, envelope types and the host interface are exported from the package. The shared event bus is the
notification plane; the host API or the runtime protocol remains the
request/response command plane.

When managed work is bound, Pi activates the generic `work_packet` tool. The
model receives task prose and named outcomes; engine names and internal choice
ids stay out of model-facing output. The legacy `marionette brief` /
`marionette state ...` flow
uses a separate `<plan>.state.json` store and must not be mixed into the same
run.

## Writes, identity and retries

A choice command is intentionally small:

```json
{"protocol":"0.5.0","id":5,"op":"choose","choiceId":"build#0","rationale":"unit and integration tests pass","expectedRevision":4,"idempotencyKey":"turn-42","profile":"signal"}
```

- Choice ids must be exact; CLI label prefixes are not accepted.
- `expectedRevision` rejects stale writers.
- Repeating the same `idempotencyKey` and command returns the original receipt
  without appending another decision.
- Reusing a key for different command content is refused.
- The process-bound principal—not request data—is recorded as the actor.

An observation command fills exactly one value requested by the projection:

```json
{"protocol":"0.5.0","id":6,"op":"observe","name":"remaining","value":7,"rationale":"7 items returned by the queue query at 09:30Z","expectedRevision":5,"idempotencyKey":"queue-2026-07-28T09:30Z","profile":"signal"}
```

Values are typed scalars: number, boolean, or string. An initial declaration
such as `VAR remaining: number = ?` suspends entry to the start phase until it
is supplied. A node-level `? remaining` requests a refresh only when that
checkpoint is reached; the value then remains stable until the loop reaches
the refresh phase. Each successful observation emits `observation.recorded`
and is kept in a separate audit stream from branch decisions.

`record` provides pibarm-style graph-linked decision records without advancing:

```json
{"protocol":"0.5.0","id":7,"op":"record","kind":"architecture-decision","summary":"Use local NDJSON IPC","rationale":"The host can filter lifecycle traffic before model context","expectedRevision":6,"idempotencyKey":"adr-7"}
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
