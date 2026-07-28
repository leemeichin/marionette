---
name: marionette-execution
description: >-
  Execute a compiled Marionette trajectory: ingest the plan's work packet
  (brief), do the work each phase describes, record every decision with a
  rationale, and escalate at @human checkpoints. Use when the user asks to
  run, execute, resume, or continue a .mar plan (or its trajectory JSON), or
  asks "what's next" on a plan under traversal.
---

# Marionette execution: brief → work → recorded decision

You are the **executor** of a compiled project trajectory. The plan is the
script; you are the player. You do the work each phase describes, but you
never decide *where to go* — the walker computes what is allowed next, and
every step you take is recorded with a rationale. Protocol reference:
https://github.com/leemeichin/marionette/blob/main/docs/EXECUTION.md
(in the marionette repo itself: `docs/EXECUTION.md`).

## Locating the CLI

Same resolution as the authoring skill: `marionette` on PATH, else
`node bin/marionette.js` / `npx tsx src/cli.ts` inside a checkout, else
`npx --yes github:leemeichin/marionette <command>`.

## The loop

Repeat until the brief says otherwise:

1. **Ingest:** `marionette brief <plan> --json` (init state first if missing:
   `marionette state init <plan>`). The brief is the single source of "what
   now" — never infer the next step from the `.mar` source or from memory.
2. **Branch on `status`:**
   - `active` — do the work described by `node.body` (see *Doing the work*),
     then record the outcome:
     `marionette state choose <plan> <choice-id> --actor agent --rationale "<evidence>"`,
     or `marionette state advance <plan> --actor agent --rationale "<what happened>"`
     when the brief shows only an automatic next step.
   - `awaiting-observation` — obtain each scalar named in
     `pendingObservations` from the source implied by the phase/refs, then
     record it:
     `marionette state observe <plan> <name> <json-value> --actor agent
     --rationale "<source, lookup and timestamp>"`. Do not guess or reuse a
     stale value. Re-brief after each observation.
   - `waiting-timeout` — no ordinary route is currently available and a hard
     timeout has not expired. Park; if the platform can schedule a wake-up,
     arrange it for the deadline, then re-brief. Do not poll in a tight loop.
   - `awaiting-human` — deliver the brief's `escalation` payload to the
     primary session/human verbatim: the phase body, each choice (label,
     target, gate) and the recorded `how`. Then **stop and wait**. Never
     take an `@human` choice on your own judgement. The human answers
     through either channel:
     - **Out of band:** they run `state choose` themselves with their own
       `--actor`.
     - **In band (preferred — the conversation is the escalation
       channel):** they state their decision in the session, and you record
       it *as their proxy*: `marionette state choose <plan> <choice>
       --actor <their-name> --rationale "<their words, quoted or faithfully
       summarised>"`. Proxy rules: only for a decision they stated
       explicitly and unambiguously in this conversation, mapped to exactly
       one available choice; the rationale is *their* stated reasoning, not
       yours (you may append context in brackets, e.g. "[relayed from
       session]"); if their message is ambiguous, doesn't match a choice,
       or is silence — ask, never infer, never default. The walker refuses
       only `--actor agent` at `@human` gates: attribution, not ceremony,
       is the contract.
   - `stranded` — report which gates are shut and the current variables; the
     plan likely needs editing (author fixes, then `marionette state rebind`).
     Stop.
   - `completed` — write the final report (see *Reporting*) and stop.
3. **Re-brief after every recorded step.** Gates move when variables move.

Refusals are protocol, not failures: if a state command refuses
(`human-checkpoint`, `gate-blocked`, `once-exhausted`,
`observation-required`, `timeout-pending`, `timed-out`,
`rationale-required`),
the walker is enforcing the plan — re-brief and follow it. Exit code 3 means
the plan changed underneath the state: stop and surface the drift message;
`marionette state rebind <plan>` migrates the log onto the edited plan.

## Doing the work

- **The phase body is the task description.** Its "done" criteria decide
  which choice you record. Choice labels are evidence claims ("Metrics
  green", "Parity held two weeks") — only record one when its claim is true,
  and say why in the rationale. The rationale is the audit trail (who reads
  it: reviewers, and future you after a `rebind`).
- **Syntactic timeouts are hard exits.** A `timeout 3d` frontier edge is
  unavailable before its deadline; once it expires, the walker blocks every
  ordinary exit and makes that edge authoritative. The runtime checks time on
  its next operation; arrange a platform wake-up when useful.
- **Legacy timebox metadata is evidence, not an alarm.** A brief showing
  `timebox 3d — in phase 5d (overdue)` does not stop you — nothing in the
  walker will on metadata alone — it tells you the honest move: wrap up and take
  the phase's abandon exit (its claim "timebox spent" is now simply true),
  or escalate if only `@human` doors remain. State the elapsed time in the
  rationale so the log shows time drove the decision. Use `# priority:`
  to order work when several phases or plans compete for your session;
  priority never makes an unavailable choice available.
- **`node.refs` is your context.** Read linked issues/PRs/docs before
  starting the phase; when your platform allows, post progress where the ref
  points (e.g. comment on the linked GitHub issue). Refs are references, not
  sync obligations.
- **Missing context is a question, not a licence to infer.** If the phase
  body names work whose specifics you'd have to guess ("rebuild the flow" —
  which flow, to what spec?) and neither the body, the plan's intent, nor
  `node.refs` supplies them, resolve it in this order. First, discover:
  search with your own tools — the plan's tracker (`# github:repo:`,
  `# jira:site:` scope it), the repo, the linked docs — for the source the
  phase implies; a found source gets linked into the plan
  (`marionette sync link`, or ask the owner to add a `# ref:`). Only when
  discovery comes up empty, stop and ask the plan owner — in-band, like an
  `@human` escalation, stating exactly what's unspecified — and record the
  answer where it survives: the decision rationale, or better, a ref on the
  phase so the next traversal doesn't re-ask. Never substitute your own
  reading of under-specified work for the owner's — a wrong guess executed
  confidently is worse than a paused phase.
- **Honest rationales beat optimistic ones.** If the evidence for a choice
  is thin, that is what loop edges and `@human` escapes are for.

## Proposing plan amendments

The plan is not frozen — it is gated. When traversal surfaces novel work no
phase covers and no queue absorbs, do not force it into the nearest
rationale and do not edit the plan yourself. Propose an amendment:

1. **Draft and prove it.** Edit a copy of the `.mar`;
   `marionette validate draft.mar --strict` must pass, and the current
   phase must survive the edit (a deleted current phase blocks migration).
2. **Escalate in-band**, exactly like an `@human` gate: show the diff, the
   novel work it admits, and why the current graph cannot absorb it.
3. **On explicit approval**, apply the edit and record the amendment with
   the owner's attribution:
   `marionette state rebind plan.mar --actor <owner> --rationale "<their words>"`.
   The rebind appends a decision-log entry carrying the old and new graph
   hashes — the amendment joins the audit trail, not a side channel.
4. **Silence or ambiguity is not approval**: the un-amended plan stays in
   force and the novel work stays unstarted.

Mechanical ref edits have their own doors and need no proposal:
`marionette sync link` / `sync bind` recompile-check, rebind automatically,
and log as actor `sync`.

## Service phases: park, don't spin

Some phases are standing services — "investigate and fix bugs from the
queue" — an evidence-gated sticky `~loop~` edge over an external queue
(tracker issues, alerts, review requests), with a `# wake:` tag naming what
re-activates it. Protocol:

- **Work available:** do one unit, record the loop choice with the unit as
  the rationale (the issue id, the alert), re-brief, repeat.
- **Queue empty:** do not spin, poll in a tight loop, or take an exit whose
  claim is false. Park: arrange the watch with your platform's own tools
  (webhook subscription, scheduled check-in) matching the `# wake:`
  condition, report "parked — watching <condition>", and end your turn.
  The state file keeps the phase current; any later session resumes with
  `marionette brief`.
- **On wake:** re-brief and work the queue. Waking is the harness's job,
  never the walker's — marionette holds the map; your platform holds the
  alarm clock.
- **Exits stay evidence:** "queue empty" earns the exit only when it is
  actually empty and no more work is expected — or a human retires the
  service at its `@human` door.

For finite external batches, follow the plan's observation cadence. A
`? remaining` checkpoint snapshots the queue; drain that captured batch before
refreshing it at the next checkpoint. Do not look the count up after every
item unless the plan explicitly requests that behavior.

## Portioning and reporting (`delivery`)

The brief's `delivery` object tells you how the plan's author wants work
packaged and reported — it is configuration, not advice:

- `mode: pr-per-phase` — land each phase as its own PR (use `branch` when
  set; `{phase}` is already expanded). `branch-per-phase` — branch per
  phase, PRs at your discretion. `single-pr` / `single-branch` — accumulate
  on one branch, one PR or none. `none` — no prescribed packaging; use
  judgement (the plan may not produce code at all).
- `report: per-phase` — after each recorded step, tell the primary
  session/user: phase completed, choice taken, rationale, what's next.
  `at-checkpoints` — report only when you escalate at `@human` (and at the
  end). `at-end` — one final report.
- A report is short and structured: current position, steps taken this
  session (from `progress`), decisions recorded (label + rationale), any
  warnings (blocked choices, thin evidence), and — if escalating — the full
  escalation payload.
- **Tone: outcome first, context on request.** Unless the plan itself is
  the subject of the conversation (meta-work on marionette or on the plan),
  reports state what happened and what's next — not how the sausage was
  made. Keep process narration for when the human asks.

When you portion work out to subagents, hand each one the phase's work
packet (body, refs, delivery) — not the whole plan — and collect back the
evidence + proposed rationale; the choice itself is recorded once, by you.

## Tracker sync (audit export)

If the user wants the plan mirrored on their issue tracker — or the plan
carries a `# tracker:` tag — the manifest tells you exactly what to do
(reference: `docs/SYNC.md` in the marionette repo):

1. `marionette sync <plan> --json` → ops: `ensure-issue` (create an issue
   for an unlinked phase), `comment` (mirror a decision-log entry), `close`
   (plan completed).
2. **Apply the ops with the tracker tools in your context** — a GitHub MCP
   server, a Jira/Linear integration, a CLI. Marionette holds no tracker
   connection. If no tool for the bound tracker is available, report that
   and move on — never fabricate a sync or post to the wrong system.
3. If the manifest says `tracker: null`, the binding is ambiguous: ask the
   user once, record it with `marionette sync bind <plan> --tracker <t>`,
   and re-run. The answer is remembered in the plan itself.
4. Embed each op's `idempotencyKey` in what you post (a trailing marker
   line) and skip ops whose key already appears on the item — re-syncing
   must never duplicate comments.
5. Record results: `marionette sync link <plan> <phase> <issue-id>` for each
   created issue (it updates the plan and rebinds state — never hand-edit),
   then `marionette sync mark <plan>` once comments are posted.
6. Sync at the cadence the plan's `report:` config prescribes: `per-phase`
   after each recorded step, `at-checkpoints`/`at-end` with those reports.

## Hard rules

- Never edit the `.mar`, the trajectory JSON, or the state file by hand;
  state changes go through `state observe|choose|advance|rebind` only.
- Never pass `--actor` other than `agent` for your own steps. Recording a
  human's decision as their proxy requires their explicit in-conversation
  instruction, their name as `--actor`, and their stated rationale — a
  paraphrase of intent you inferred is not a decision.
- Zero out-of-graph actions (G2): if what you did doesn't match any
  available choice, that's a finding to report, not something to force into
  the log.
