# ADR-0006: Separate operator questions from external human actions

- **Status:** Proposed — implemented for review
- **Date:** 2026-07-30

## Context

The current `@human` surface conflates two different boundaries:

1. Marionette needs the person currently operating the session to choose among
   authored outcomes; and
2. work cannot continue until another person performs or approves something,
   such as a reviewer approving a pull request.

The final review of the live-amendment work exposed the confusion directly.
It presented two routes as an `@human` escalation, although the host was simply
asking its operator to decide. It also rendered little more than the choice
labels, so the operator lacked enough context to make an informed decision.

The existing `@ask` spelling is currently used for free-text clarification on
a fixed edge. That makes the natural phrase “ask the operator which option”
unavailable and forces ordinary local decisions through the more ambiguous
`@human` marker.

## Decision

### Gate taxonomy

1. **`@ask` is an interactive operator decision.** It marks authored routes
   that Marionette presents to the person currently operating the trusted
   host. The operator selects exactly one available `@ask` choice and supplies
   a rationale. The agent cannot select it. A phase may expose two or more
   `@ask` choices; that is the normal review/accept/rework shape.
2. **`@human` is an external human action.** It means execution is waiting for
   a person other than the agent/operator to approve or perform something.
   The host does not offer the route as the operator's own decision. It records
   the external actor's identity, rationale, and evidence (for example the PR
   review URL) through a distinct confirmation API/command.
3. **`@input` replaces the old fixed-route clarification meaning of `@ask`.**
   The agent opens one `@input` edge with a focused free-text question; the
   operator answers, and the already-authored target is unchanged. This keeps
   “missing context”, “operator chooses a route”, and “external person acted”
   as three different protocol states.
4. A choice cannot carry more than one of `@ask`, `@input`, or `@human`.
   Mixed ordinary/interactive/external frontiers remain legal, but status and
   UI must describe every available authority class rather than silently
   collapsing them.

### Authority and evidence

- `@ask` is resolved through the trusted operator UI (`/marionette-decide` in
  Pi) and records that operator as the decision actor.
- `@input` is opened by the agent and answered through
  `/marionette-answer`, retaining the existing fixed-edge clarification audit.
- `@human` is resolved through a new external confirmation surface. It requires
  an external actor identity and at least one durable evidence reference. A
  trusted host may attest that external action; the model-facing walker cannot.
- Runtime events distinguish `decision.committed`, `input.required` /
  `input.answered`, and `external.required` / `external.confirmed`. Historical
  spec-0.5 graph epochs continue replaying the former `@ask` elicitation
  semantics; new trajectories use the revised spec and explicit `@input` bit.

### Decision packets

Every operator or external-human checkpoint must project a complete review
packet, not a half-sentence. The packet includes:

- plan summary and original prompt when available;
- phase id, complete phase body, refs, and progress;
- why the gate is waiting and which authority can resolve it;
- every available choice with label, exact id, target, target phase title,
  gate/timeout information, and the effect of selecting it;
- relevant variables and recently attached records/evidence;
- the expected revision and exact trusted response operation;
- graph-authored fallback timing, or an explicit statement that none exists.

Pi widgets show this packet in a compact but multi-line form and provide the
full packet in event/tool details. Amendment approval additionally shows the
semantic diff, proposal rationale, and candidate/Mermaid/SVG artifact paths.

## Compatibility

- Compiled trajectories and runtime protocol get versioned additive fields;
  archived spec-0.5 trajectories remain replayable under their original gate
  meanings.
- Source plans using old free-text `@ask` migrate to `@input`. Documentation,
  examples, skills, and diagnostics stop describing `@ask` as clarification.
- `@human` is intentionally stricter for new graph epochs: a local operator
  choice without external identity/evidence is refused. Older epochs retain
  the old role-bound behavior for replay and completion.

## Required conformance cases

- two `@ask` choices project one rich operator decision packet and only the
  trusted operator can choose one;
- an agent cannot select `@ask`, answer `@input`, or confirm `@human`;
- `@input` preserves focused-question/fixed-target behavior;
- `@human` remains parked until external identity and evidence are recorded;
- the session operator cannot accidentally self-confirm an external action;
- decision packets include full phase context, targets, progress, and revision;
- old spec-0.5 elicitation journals replay unchanged after upgrade;
- Pi tree/restart restoration retains pending operator, input, and external
  packets without shrinking their context.

## Consequences

The DSL and protocol gain one marker and clearer states, but hosts can now map
each gate to the correct interaction: ask the current user, collect missing
text, or wait for someone outside the session. Review decisions become
informed audit events rather than labels presented without context.
