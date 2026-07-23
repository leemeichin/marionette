# Simulated dogfood batch — 2026-07-23

Five simulated first sessions of the `marionette-authoring` skill, run per the
protocol in [`docs/GETTING-STARTED.md`](../../GETTING-STARTED.md) §3 and
recorded on [#2](https://github.com/leemeichin/marionette/issues/2).

**Method.** Each session was a fresh-context agent given only
`skills/marionette-authoring/SKILL.md`, `docs/DSL.md`, and raw natural-language
project notes (no access to `examples/` or `plans/`). Scenarios escalate from
simple to complex. Each agent snapshotted its draft (`plan.first.mar`) *before*
the first `validate --strict` run and saved that run's output verbatim
(`first-validate.log`); every first draft was then independently re-validated
outside the agent to confirm the self-reported result. Simulated sessions
complement — not replace — manual dogfood sessions; the ≥70% call on
`plans/marionette.mar` should weigh both.

**Caveat.** These sessions could not exercise the clarifying-questions step
(agents were told to pick defaults), and all five ran against the same compiler
build on one machine.

## Results: 5/5 first-pass clean (100%)

| # | Scenario (complexity) | First pass | Revisions | Warnings | Phases/choices |
|---|---|---|---|---|---|
| 1 | WordPress → Hugo blog migration (simple, one approver) | ✅ 0 errors | 0 | 0 | 9 / 20 |
| 2 | CLI plugin system: flag → bounded beta → scope-cut fork → maintainer signoff (simple-medium) | ✅ 0 errors | 0 | 0 | 9 / 12 |
| 3 | MySQL → Postgres: bounded spike → dual-write fallback → DBA signoff → rollback paths (medium) | ✅ 0 errors | 0 | 0 | 9 / — |
| 4 | Mobile app launch: crash-rate beta loop, App Store rejection loop, marketing go/no-go, incident pull-back (medium-complex) | ✅ 0 errors | 0 | 0 | 8 / — |
| 5 | Startup pivot quarter: 3 spikes, board pick/kill, SOC 2 side-gate, partner-count beta, CEO contract signoff (complex) | ✅ 0 errors | 0 | 0 | 10 / 20 |

In every session the final plan is byte-identical to the pre-validation
snapshot — no revision loop was needed anywhere. No MAR014 "unverified gate"
warnings either: all five drafts expressed budgets as compiler-verifiable
monotonic counters.

G3 spot-check (sessions 1 and 5 reviewed cold): renders and summaries were
legible without DSL knowledge; every `@human` checkpoint was called out.

## Friction the sessions surfaced (skill/DSL feedback)

1. **`~loop~` placement on multi-phase cycles is under-specified** (sessions
   1, 2). Whether every edge of a cycle needs `~loop~` or one edge per cycle
   suffices wasn't clear from SKILL.md or DSL.md; agents marked defensively
   and "were guessing".
2. **Sticky-vs-once-only inside cycles deserves an explicit rule** (session
   1). An exhausted `*` exit on a cycle-participating edge could strand a
   traversal; the skill implies it via MAR017 but never states "make every
   cycle-participating edge sticky".
3. **No counter reset / per-choice mutations** (sessions 4, 5). Mutations run
   on phase entry only, so (a) re-entering a loop phase after a late-plan
   pull-back resumes with a spent budget, and (b) budgets across *sequential*
   phases (session 5's six-week spike budget) can't be modeled as a verifiable
   counter at all and end up in prose.
4. **Skill may over-elaborate simple projects** (session 1): a personal blog
   migration came back with 4 counters, 9 phases and a `reassess` hub —
   structurally sound, but heavier than the notes imply. Worth a "match the
   plan's weight to the project's stakes" note in the skill.

Items 1–2 are skill/docs wording fixes; item 3 is a language design question
(PRD territory); item 4 is a skill calibration tweak.

## Artifacts

Each `session<N>/` contains the plan as first-drafted (`plan.mar`), the
verbatim first strict-validation output (`first-validate.log`), the Mermaid
render (`plan.mmd`), and the plain-language summary (`summary.txt`). The exact
notes given to each session are reproduced in `notes.md` alongside them.
