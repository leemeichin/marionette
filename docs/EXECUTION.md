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

For a long-lived agent host, [`marionette runtime`](RUNTIME.md) exposes the
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
│      │     (or `state advance` for a fallthrough divert)    │
│      │                                                      │
│      ├─ status: awaiting-human → deliver the escalation     │
│      │     payload to the primary session and STOP          │
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

- **plan** — file, project name, content hash (state binding), plan-level refs.
- **status** — `active` | `awaiting-human` | `stranded` | `completed`.
- **node** — the current phase: id, title (first body line), full prose body,
  raw meta, and normalised refs. The prose is the task description; it is
  the plan author's instruction to the executor.
- **variables** — the live variable snapshot gates are computed from.
- **delivery** — the effective delivery config at this node (below).
- **frontier** — every choice with `available`/`blocked(+code)`, gate source,
  `human`/`loop`/`sticky` flags, target and target title. Blocked choices are
  shown so the executor can explain *why* it isn't taking them.
- **divert** — the fallthrough edge, if any.
- **escalation** — present exactly when status is `awaiting-human` (below).
- **progress** — steps taken, phases visited/total, the visited path.
- **protocol** — the exact commands to record an outcome, plus the standing
  rules (do the work first; honest rationale; never take `@human` as agent;
  re-brief after every step).

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

Refs are deliberately *references*, not sync: the executor decides what to do
with them (read the issue for context, comment progress, close on phase exit)
per its own capabilities. Status sync remains parked (PRD P2).

## @human escalation (OQ2 proposal)

When every available choice at the current node is `@human`, the brief's
status becomes `awaiting-human` and it carries a structured escalation:

```json
"escalation": {
  "reason": "every choice at this phase is an @human checkpoint",
  "choices": ["dogfood_gate#0", "dogfood_gate#1"],
  "how": "pause and escalate: present this phase and its choices to a human; a human records the decision with `marionette state choose <plan> <choice> --actor <name> --rationale <text>`. Do not take these choices autonomously."
}
```

The *channel* is executor-specific (a chat message to the primary session, a
PR comment, a Slack ping); the *payload* is this escalation object plus the
node body and frontier — everything a human needs to decide without opening
the repo. There is no timeout/fallback: an unanswered escalation simply leaves
the plan parked at the checkpoint, visible in `brief`/`render`/`summarize`.
(The walker separately refuses `--actor agent` on `@human` choices with the
`human-checkpoint` error code, so escalation is enforced, not advisory.)
The formal decision on OQ2 is itself `@human`-gated in the dogfood plan
(`escalation_protocol` node, issue #4); this payload is the working proposal.

## Editing a live plan: `state rebind`

Plans change mid-flight. Any semantic edit changes the content hash, and every
walk command then refuses with a drift error (exit 3). The sanctioned paths:

- `marionette state rebind <plan>` — migrate the existing state onto the
  edited plan, *keeping the decision log*: taken-choice ids that vanished are
  dropped (reported), removed variables dropped, new variables added at their
  initials, type-changed variables reset (reported). Refused
  (`migration-blocked`) when the current phase no longer exists — that
  decision needs a human.
- `marionette state init --force` — start over (history discarded).

## Conformance

Any walker implementation must pass the walk scripts in
[`spec/conformance/`](../spec/conformance/README.md) — refusals must carry the
same machine codes (`WalkErrorCode`), refused operations must not mutate
state, and every successful step must append exactly one log entry. The
baseline case traverses [`examples/paas_replatform.mar`](../examples/paas_replatform.mar),
which exercises every DSL v0 construct plus the execution metadata.
