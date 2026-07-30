# Executing a Marionette plan (Phase 2)

Phase 1 answered *"is this plan sound?"*. Phase 2 answers *"an agent is holding
this plan — what exactly does it do next, and how does the work come back?"*

The seam is unchanged: the compiled trajectory JSON
([`spec/trajectory.schema.json`](../spec/trajectory.schema.json)) plus the
hash-bound state file. Execution adds one ingestion surface on top — the
**brief** — and two metadata vocabularies the brief resolves: **external refs**
and **delivery config**. Everything here is executor-agnostic: the pi agent's
native extension, a Claude session running the
[`marionette-execution` skill](../skills/marionette-execution/SKILL.md), and a
CI job all consume the same contract.

For a long-lived agent host, [`marionette start`](RUNTIME.md) exposes the
same walker as a compact local NDJSON process with revisions, idempotency,
event replay and principal-bound human checkpoints. It is an optional runtime
surface; it does not change this CLI loop or the DSL.

## The executor loop

```
┌─────────────────────────────────────────────────────────────┐
│  marionette brief plan.mar --json      ← "what now?"        │
│      │                                                      │
│      ├─ status: active         → do the phase's work, then  │
│      │     marionette state choose plan.mar <choice>        │
│      │        --actor agent --rationale "<evidence>"        │
│      │     (or `state advance` for an automatic next step)  │
│      │                                                      │
│      ├─ status: awaiting-observation → obtain each named    │
│      │     scalar, then `state observe` with its evidence   │
│      │                                                      │
│      ├─ status: waiting-timeout → park until the temporal   │
│      │     exit is due; the host may arrange the wake-up    │
│      │                                                      │
│      ├─ status: awaiting-operator → show full @ask packet;  │
│      │     trusted operator chooses and agent STOPS         │
│      ├─ status: awaiting-external → wait for another human; │
│      │     require their identity + evidence and STOP       │
│      ├─ status: awaiting-elicitation → present the agent's  │
│      │     @input question; operator answers, then resume   │
│      │                                                      │
│      ├─ status: stranded       → report; plan needs editing │
│      │     (then `marionette state rebind`)                 │
│      │                                                      │
│      └─ status: completed      → final report; done         │
└──────────────── repeat until completed ─────────────────────┘
```

The brief is the single source of "what now". The executor never chooses a
target node directly — it only takes choices the frontier says are available,
and every step records an actor and a rationale (G4). Structural guarantees
(gates, once-only exhaustion, `@human` refusal, drift detection) are enforced
by the walker, not by prompt discipline: an out-of-graph action is an *error*,
not a temptation.

## The brief (work packet)

`marionette brief <plan> --json` emits the machine contract
([`spec/brief.schema.json`](../spec/brief.schema.json)); without `--json` it
renders the same packet for humans. It contains:

- **plan** — file, project name, content hash (state binding), plan-level
  refs, and `intent` — the plan's `# summary:` and `# prompt:` metadata, so
  the executor holds the original ask, not just the current phase.
- **status** — `active` | `awaiting-observation` | `waiting-timeout` |
  `awaiting-operator` | `awaiting-external` | legacy `awaiting-human` |
  `awaiting-elicitation` | `stranded` | `completed`.
- **node** — the current phase: id, title (first body line), full prose body,
  raw meta, and normalised refs. The prose is the task description; it is
  the plan author's instruction to the executor.
- **variables** — the live variable snapshot gates are computed from.
- **pending observations** — the names and types the host must supply before
  traversal can continue. Record each with
  `marionette state observe <plan> <name> <json-value> --actor <name>
  --rationale "<source and timestamp>"`.
- **delivery** — the effective delivery config at this node (below).
- **frontier** — every choice with `available`/`blocked(+code)`, gate source,
  `human`/`loop`/`sticky` flags, optional hard `timeout`, target and target
  title. Blocked choices are shown so the executor can explain *why* it
  isn't taking them.
- **automatic next step** (`next` in the JSON contract) — the
  unconditional route to follow when the stage is done.
- **escalation** — present for operator/external/legacy human checkpoints;
  carries the complete decision packet and trusted response requirements.
- **elicitation** — present exactly when status is `awaiting-elicitation`;
  carries the open `@input` question, its fixed edge and answer instructions.
- **clarification** — on the phase entered through an answered `@input`, carries
  that question and answer as immediate work context.
- **progress** — steps taken, phases visited/total, the visited path.
- **protocol** — the exact commands to record an outcome, plus the standing
  rules (do the work first; honest rationale; never choose `@ask` or confirm `@human` as agent;
  re-brief after every step).

## Runtime observations

An observation checkpoint deliberately separates *when a fact is refreshed*
from *how a host obtains it*. The brief may request a late-bound initial value
or a node-level refresh:

```console
marionette state observe plan.mar remaining 7 \
  --actor agent \
  --rationale "queue query at 09:30Z returned 7 items"
```

Use only the named source the phase or its refs imply; do not infer the value
from stale traversal state. The rationale identifies the lookup, measurement,
or human statement that produced it. Observations are type-checked and audited
separately from branch decisions.

Do not refresh an external queue after every item unless the plan explicitly
places a checkpoint there. A common batch shape observes once, drains the
captured count through a `while`, then reaches a refresh phase and observes
again. This keeps the snapshot stable while work is in flight and avoids
repeated lookups.

## @input elicitation

An available `@input` choice is agent-opened: the agent identifies that the
authored ambiguity applies and opens it with a concise, answerable question.
It does not use ordinary `choose`, and it does not ask the operator to approve
a route.

```console
marionette state ask plan.mar <choice> \
  --question "<the missing information>" \
  --actor agent \
  --rationale "<why this blocks the route>"
```

The brief then becomes `awaiting-elicitation`. Present its `elicitation`
payload verbatim and stop. A human answer is recorded through the trusted host
or, for the unbound CLI:

```console
marionette state answer plan.mar "<answer>" --actor <name>
```

The answer is audited separately, then the fixed `@input` edge advances. The
entered phase receives it as `clarification` in its work packet. It does not
select a target. If several known answers should lead to different targets,
the plan should author `@ask` choices for the trusted operator. Use `@human`
only when somebody external must act and provide evidence.

## Temporal exits

`timeout <duration> -> target` is a hard edge, not metadata. Before expiry it
is blocked; after expiry the walker blocks ordinary choices/automatic next and
makes the timeout exit authoritative. If the brief says `waiting-timeout`,
park and let the host arrange a wake-up; Marionette re-evaluates elapsed time
on its next operation rather than scheduling one itself.

Legacy `# timebox:` metadata remains advisory evidence for old plans. A brief
may still render it as overdue, but only the `timeout` syntax changes what the
walker permits.

## Portioning out the work (delivery config)

How work product is packaged and how often the executor reports back to the
primary agent/session is authored in the plan, not hard-coded in the executor.
Plan-level tags set the default; node-level tags override per phase:

```
# delivery: single-branch          ← plan default
# report: per-phase

=== auth_extraction ===
# delivery: pr-per-phase           ← this phase lands as its own PR
# delivery:branch: replatform/{phase}
```

| Tag | Values | Meaning |
|---|---|---|
| `# delivery:` | `pr-per-phase` | each phase's work lands as its own pull request |
| | `branch-per-phase` | a branch per phase; PRs at the executor's discretion |
| | `single-pr` | one pull request for the whole traversal |
| | `single-branch` | one branch, commits per phase, no PR automation |
| | `none` *(default)* | no prescribed packaging (non-code plans, executor's discretion) |
| `# report:` | `per-phase` *(default)* | report back after every phase |
| | `at-checkpoints` | report only at `@human` checkpoints and completion |
| | `at-end` | one report when the traversal completes (or strands) |
| `# delivery:branch:` | any string | branch name template; `{phase}` expands to the node id |

Unknown values warn (`MAR019`) and fall back to the defaults, so a typo can't
silently change delivery behaviour. A "report" is executor-shaped — a chat
message from a subagent, a PR description, a CI summary — but its cadence and
packaging are the plan author's call, versioned with the plan.

## External refs (cross-referencing Jira, GitHub, Linear, …)

Nodes and plans reference external sources through the existing namespaced
metadata — no new syntax, just well-known namespaces the compiler normalises
into structured `refs` (in the trajectory *and* the brief), so executors never
re-parse conventions:

```
# github:repo: acme/platform           context + repo ref (plan level, usually)
# jira:site: https://acme.atlassian.net
# linear:workspace: acme

=== auth_extraction ===
# github:issue: 22                     → https://github.com/acme/platform/issues/22
# github:pr: other/repo#9              explicit repo wins over context
# jira: PROJ-123, PROJ-124             comma-separated lists allowed
# linear: ENG-42
# ref: https://wiki.acme.dev/brief     generic link
```

Each becomes `{ provider, kind, id, url }`; the URL is synthesised when the
context (`github:repo`, `jira:site`, `linear:workspace`) makes it derivable,
else `null` with the id preserved. Malformed values warn (`MAR018`). Repeated
tags accumulate. The provider/kind sets are open — unknown namespaces stay
available as raw meta for custom extensions.

Refs are deliberately *references*: the executor decides what to do with
them (read the issue for context, comment progress, close on phase exit)
per its own capabilities. When a plan should actively mirror to a tracker —
issues created per phase, decisions commented, issues closed on completion —
that is computed, not improvised: `marionette sync` emits a deterministic
manifest the executor applies with its own tracker tools, and
`marionette import` scaffolds a plan *from* an existing backlog. See
[`SYNC.md`](SYNC.md).

## Operator decisions and external human actions

When available routes are operator `@ask` choices, status is
`awaiting-operator`. When they require external `@human` action, status is
`awaiting-external`. Both carry a complete decision packet: plan summary and
prompt, full phase body, refs, variables, progress, reason, exact choices,
target titles/effects, revision, response operation, evidence requirements,
and graph-authored timeout fallbacks.

The operator resolves `@ask` through `/marionette-decide` or `state choose`
with their rationale. External `@human` is deliberately different: the
operator waits for somebody else, then records that person's identity and a
durable evidence reference through `/marionette-confirm-human`, the host API,
or `state confirm`. The agent-facing tool can do neither. A spec-0.5 archived
`@human` epoch retains its legacy human-choice behavior during replay.

There is no implicit timeout or default. Silence parks the run. If the plan
authors a timeout edge, its id and due time appear in the packet and only the
walker can open it. Runtime emits durable `operator.required`,
`external.required`, and `external.confirmed` events with graph hash,
revision, actor, rationale, and evidence.

See [`ADR-0006`](decisions/0006-interactive-and-external-human-gates.md) for
the authority split and [`ADR-0004`](decisions/0004-human-escalation-protocol.md)
for the underlying host-mediated escalation principles.

## Editing a live plan: immutable past, editable future

Plans change mid-flight. Any semantic edit changes the content hash, but an
approved amendment may now update the executable future without rewriting
recorded work.

A phase id becomes immutable as soon as a recorded choice or automatic advance
leaves it. Its prose, actions, observations, metadata, refs, choices, gates,
and targets must remain semantically identical. Variables used by such a phase
also keep their declarations. The current phase and every never-completed
phase may be updated, removed, rerouted, or extended, except that the current
phase itself must survive. A phase id revisited through a loop remains frozen;
introduce a new successor id when the new activation needs different work. An
open `@ask` choice must retain its exact id, marker, and target.

State-file workflow:

```console
# Existing pre-amendment state files establish this once, before editing:
marionette state baseline plan.mar

# After editing, inspect the semantic report without changing state:
marionette state rebind plan.mar --dry-run --json

# Apply only after review:
marionette state rebind plan.mar \
  --actor lee --rationale "approved the future-only changes"
```

`state init` archives its baseline automatically. Rebind resolves that old
hash-addressed trajectory, refuses completed-work changes with
`migration-blocked`, archives an accepted candidate, migrates compatible
future variables, and appends an attributed old-hash → new-hash amendment
entry. A dry run and every refusal leave state untouched. If a legacy state
has already drifted without an archive, restore the source matching its state
hash, run `state baseline`, then edit again; use `state init --force` only when
discarding history is intentional.

An executor proposes rather than applies. In a bound Pi run it calls
`marionette_amend` with complete candidate source and a rationale. The tool
compiler-checks it, enforces the same future-only policy, leaves the live plan
unchanged, and writes compact, Mermaid, and SVG review artifacts. Only a
trusted human can apply it through `/marionette-approve-amendment` or the host
API. `marionette_walk` has no amendment approval operation. Runtime approval
archives the new graph and appends `plan.rebound`; all earlier events retain
their original graph hashes and replay under those graph epochs.

The `marionette-execution` skill carries the full proposal protocol, including
the park-don't-spin rule for standing service phases (`# wake:`, see DSL.md).

## Conformance

Any walker implementation must pass the walk scripts in
[`spec/conformance/`](../spec/conformance/README.md) — refusals must carry the
same machine codes (`WalkErrorCode`), refused operations must not mutate
state, and every successful step must append exactly one log entry. The
baseline case traverses [`examples/paas_replatform.mar`](../examples/paas_replatform.mar),
which exercises every DSL v0 construct plus the execution metadata.
