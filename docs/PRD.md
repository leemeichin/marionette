# PRD: Marionette

*A compiled, plain-text project trajectory language — authored by humans, validated by a compiler, traversed by AI agents.*

**Status:** Draft v0.2 · **Repo:** marionette · **Prior art / influence:** Ink & inklecate (MIT)

---

## 1. Problem Statement

Project plans are either rigid linear tools (Gantt, boards) or unvalidatable freeform canvases (Obsidian, Miro). Neither can express what a real project is: a directed graph of phases, decisions, and conditional paths. This gap becomes acute when the entity executing the plan is an AI agent: agents need a machine-precise definition of *what is allowed next, under what conditions, and where a human must decide* — while humans need the same artifact to remain legible, reviewable, and versionable.

Without this, contingencies live in heads, agent autonomy boundaries are prompt-soup, and plans silently diverge from reality.

## 2. Product Concept

Marionette borrows Ink's three-layer architecture and flips the player:

| Layer | Ink | Marionette |
|---|---|---|
| Language | Narrative script (knots, choices, arrow transitions, state) | Trajectory script: phases, decision points, gates, state, human checkpoints, bounded loops |
| Compiler | inklecate → story JSON | `marionette compile` → **trajectory JSON (the contract)** + static validation |
| Runtime/player | Human player in a game | **AI agent** walking the graph; humans author, review, and gate |

**One-liner:** *The project plan is the agent's script; the compiler guarantees the script is sound; humans author and gate it.*

### Core design decisions (settled)

1. **File storage, service-free.** A plan is `plan.mar` (script) + `plan.state.json` (traversal state) side by side. Git-compatible but not git-required. The state file references the compiled graph **by content hash**, so the runtime detects plan/state version drift and triggers reconciliation instead of misapplying history.
2. **DAG by default; loops are intentional.** Cycles are a compile error unless marked (`~loop~`). A declared loop must have at least one sibling exit path whose gate is satisfiable (e.g., a monotonic counter), else: *potential infinite loop* error. Each loop traversal is a distinct decision-log entry.
3. **Human checkpoints are first-class.** `@human` marks a choice the agent cannot take autonomously — it must pause and escalate. The autonomy boundary is thereby authored, versioned, and diffable.
4. **Syntax is masked by UX.** Humans normally don't hand-write the DSL. Authoring is NL → draft script (skill-assisted); review is rendered graph + plain-language summary. The DSL remains the durable, diffable source of truth.
5. **The compiled JSON is the seam.** Authoring/validation (Phase 1) produces it; agent ingestion (Phase 2) consumes it. Spec the schema first; the phases decouple.

### Illustrative syntax

```
=== build_mvp ===
Ship the smallest testable slice.
~ iteration += 1
* [Metrics green] @human -> beta_launch
* {iteration < 3} [Learnings, go again] ~loop~ -> build_mvp
* {iteration >= 3} [Three strikes] -> pivot_or_kill
```

## 3. Goals

- **G1 — Soundness:** 100% of compiled plans are structurally valid; no dead ends, unreachable phases, undefined targets/variables, or unbounded loops can pass the compiler.
- **G2 — Agent-native:** A reference agent (pi agent proving ground) can ingest the trajectory JSON and traverse it end-to-end, honoring gates and escalating at `@human` checkpoints, with zero plan-specific prompt engineering.
- **G3 — Legibility:** A reviewer with no DSL knowledge can understand a rendered plan (graph + summary) in under 5 minutes for a ≤50-node trajectory.
- **G4 — Audit trail:** Every taken branch (including loop iterations and escalations) records actor, timestamp, and rationale.
- **G5 — Dogfood:** Marionette's own development runs on a Marionette trajectory by end of Phase 1.

## 4. Non-Goals

- **Not a scheduler.** No calendar math, resource leveling. Dates are just variables.
- **Not a task tracker.** Nodes are phases/decisions, not tickets. (Integrations: P2.)
- **Not a freeform canvas.** Constraint is the product.
- **Not a general agent-orchestration framework.** Differentiation = the *human-legible plan* that compiles to the machine contract. Lose the readability half → LangGraph clone; lose the compilation half → prose plans agents reinterpret.
- **Not multiplayer/real-time.** Files + version control suffice for v1.
- **Not Ink's narrative feature set.** No tunnels, threads, rich interpolation — unless adopted deliberately (see Open Questions on engine reuse).

## 5. Users & Stories

**Persona A — PM / founder (author & gatekeeper)**
- As a PM, I want to describe my project in natural language and get a draft trajectory script so that I never hand-write syntax.
- As a PM, I want compile-time errors for dead ends, unreachable phases, and unbounded loops so that my contingency plan provably has an exit for every scenario.
- As a PM, I want to mark decisions `@human` so that the agent's autonomy boundary is explicit and reviewable.
- As a PM, I want a migration report when I edit a live plan so that recorded history reconciles safely with the new graph.

**Persona B — AI agent (player)**
- As an agent, I want a validated JSON graph with evaluable gates so that "what can I do next" is computed, not inferred.
- As an agent, I want bounded loops with exit conditions so that iteration is a guardrailed retry, not an open loop.
- As an agent, I want a defined escalation action at `@human` nodes so that pausing is a protocol, not a judgment call.

**Persona C — Reviewer / stakeholder**
- As a reviewer, I want a rendered graph with loose ends and human gates highlighted, plus a plain-language summary, so that I can approve a plan before an agent runs it.
- As a stakeholder, I want the taken path highlighted with rationale per decision so that status and "why" are one artifact.

## 6. Requirements

### Must-Have (P0) — Phase 1: authoring, review, validation (the skill)

| # | Requirement | Acceptance criteria (abridged) |
|---|---|---|
| P0.1 | **Trajectory JSON schema** (the contract): nodes, edges, choices, gates, variables, `@human`, `~loop~` + exit metadata, content hash | Schema published in `/spec`; validator rejects nonconforming docs; round-trips script → JSON losslessly |
| P0.2 | **DSL v0**: phases, choices (`*`/`+`), automatic next steps (`->`), `END`, typed vars, mutation (`~`), gates (`{}`), `@human`, `~loop~` | All constructs parse; golden-file tests per construct |
| P0.3 | **Compiler validation (structural)**: dead ends, unreachable nodes, undefined vars/targets, undeclared cycles, loops without satisfiable exit, `@human` without escalation path | Each defect class has failing fixture + line-numbered, suggestion-bearing error |
| P0.4 | **Gate checking (trivially decidable only)**: constant comparisons, monotonic counters. Everything else → warning: "unverified gate — review manually" | No false "verified" claims; warnings enumerate unverified gates |
| P0.5 | **Produce**: NL/notes → draft script (skill capability) | Draft compiles or errors are surfaced for one revision loop |
| P0.6 | **Review**: Mermaid render (taken-path/frontier/gates highlighted) + plain-language plan summary incl. defect and warning report | Legible ≤200 nodes; summary counts decision points, loops, human gates, unverified gates |
| P0.7 | **State file + hash binding**: `plan.state.json` bound to compiled hash; drift detected | Mutating the script invalidates stale state with a clear reconciliation prompt |
| P0.8 | **CLI**: `marionette compile | validate | render | summarize` | Exit codes suitable for CI |

### Nice-to-Have (P1) — Phase 2: ingestion & execution

- Reference runtime: graph walker + gate evaluator consuming trajectory JSON; decision log writer (actor/timestamp/rationale)
- Pi agent integration (proving ground): native ingestion, traversal, `@human` escalation channel
- Live-plan migration report (visited-node diff) on re-compile
- Simulation mode: hypothetical traversal without committing state
- Editor support: syntax highlighting, inline compile errors

### Future Considerations (P2)

- Richer gate satisfiability analysis (or inherited from Ink engine — see OQ1)
- Integrations: node status ↔ Jira/Linear/GitHub; variables fed by external data
- Branch probabilities/weights → expected-value analysis
- Multi-plan portfolios; cross-trajectory transitions
- Multi-agent traversal (role-scoped choices beyond `@human`)
- *Design insurance now:* namespaced metadata in the JSON schema so extensions don't break the contract.

## 7. Success Metrics

**Leading (Phase 1, weeks):**
- First-session compile success ≥70% for skill-drafted plans
- NL → valid compiled plan median < 20 min
- ≥60% of dogfood plans use ≥2 branches and ≥1 gate (differentiators actually used)

**Leading (Phase 2, weeks):**
- Pi agent completes a ≥15-node trajectory with ≥1 loop and ≥1 `@human` escalation, zero out-of-graph actions
- 100% of taken branches have logged rationale

**Lagging (quarters):**
- ≥40% of created plans still traversal-active at 90 days
- Qualitative (N=10): reviewers report trusting the rendered plan as ground truth

## 8. Open Questions

- **[OQ1 — RESOLVED, see `docs/decisions/0001-ink-engine-reuse.md`: influence-only]** **Reuse Ink's compiler/runtime as engine vs. influence-only.** inklecate already detects loose ends and undefined arrow targets, and the Ink *runtime* evaluates conditions dynamically — which may give a cheap answer for gate reachability via exhaustive/heuristic traversal ("simulate all paths") rather than static analysis. Unknowns: how much narrative machinery comes along, whether its JSON format can carry our metadata, C# runtime fit for our stack. **Time-boxed spike: 3 days, decision recorded in repo.**
- **[OQ2, Eng, blocking]** Escalation protocol shape for `@human` in Phase 2 (channel, payload, timeout/fallback semantics).
- **[OQ3, Design, non-blocking]** Node payload size: sentence vs. document; whether nodes can reference external docs.
- **[OQ4, Product, non-blocking]** Loop exits: counter-based vs. always-available "Enough. Decide." repeatable choice — dogfood both, pick a default.
- **[OQ5, Data, non-blocking]** Decision-log format: embed in state file vs. append-only sidecar log.

## 9. Phasing

- **Phase 0 (days):** OQ1 spike (Ink engine reuse). Publish trajectory JSON schema v0 regardless of outcome — the contract precedes the implementation.
- **Phase 1 (~6 wks):** DSL + compiler + validation + render/summarize + CLI, packaged as a skill (SKILL.md + validator script). **Gate to exit:** Marionette plans its own Phase 2 in Marionette (G5).
- **Phase 2 (~6 wks):** Reference runtime + pi agent ingestion + escalation channel + migration report. **Gate to exit:** G2 metric met on the proving ground.
- **Phase 3:** Simulation, editor tooling, external dogfooders (≥3 teams, ≥30 days).

## 10. Scope Guardrails

Any scope addition requires a removal or an explicit phase push. Parking lot lives in `docs/PARKING.md`. The tightest test for every proposal: *does it serve "human-legible plan, compiler-guaranteed soundness, agent-native traversal"?* If it only serves one of the three, it waits.
