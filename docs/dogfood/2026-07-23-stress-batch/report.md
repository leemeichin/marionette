# Stress + scale batch — 2026-07-23 (sessions 6–14)

Follow-up to [`../2026-07-23-simulated-batch/report.md`](../2026-07-23-simulated-batch/report.md)
(sessions 1–5, 5/5 clean). This round had three goals: force the unhappy
path to exercise the revision loop, re-test after landing the skill/DSL
fixes from [#8](https://github.com/leemeichin/marionette/issues/8)
(items 1, 2, 4 plus revision-loop guidance), and push the sample size
toward a ≥90–95% bar rather than the Phase 1 ≥70% bar.

Method as before: fresh-context agents, skill + `docs/DSL.md` + raw notes
only, first drafts snapshotted before validation and independently
re-verified. Sessions 6–7 are **seeded-defect revision tests** (a broken
"colleague draft" to repair — they do not count toward the first-session
compile metric). Sessions 8–14 are from-scratch authoring sessions and do.

## Headline numbers

**First-session compile success (zero errors on first `validate --strict`):
12/12 (100%)** across all from-scratch sessions to date (1–5, 8–14).
Wilson 95% lower bound at 12/12 ≈ 76%; the observed rate clears the 90–95%
target, but more sessions would tighten the bound.

Strict-clean (zero warnings too): 8/12. The other four (9, 10, 12, 14)
carried only *expected* MAR014 dynamic-fact/reset-counter warnings, each
surfaced to the user per the skill rather than churned on — under the
protocol those are ✅ data points with review flags, not failures.

Revision tests: **2/2 recovered to strict-clean within the one-revision
budget** (details below).

| # | Type | Scenario | First pass | Outcome |
|---|---|---|---|---|
| 6 | revision (seeded) | search revamp; typo errors masking structural errors | 2 errors (seeded) | valid in 1 loop — agent swept structure while fixing names, dodging the masked second wave |
| 7 | revision (seeded) | nightly pipeline; errors + warning mix incl. tautological gate | 2 errors + 3 warnings (seeded) | strict-clean in 1 loop — MAR014 removed as a semantic fix, not churn |
| 8 | scratch | 2-quarter PaaS re-platforming, 4 workstreams, board hub | ✅ 0 err, 0 warn | 18 phases, 11 verified loops, zero unverified gates |
| 9 | scratch (trap) | "no humans, retry forever, never end" release train | ✅ 0 err, 2 warn | conflicts flagged explicitly; strict-clean after 1 revision |
| 10 | scratch | PCB → 500-unit production run, respin budget, MCU fallback | ✅ 0 err, 3 warn | MAR014 on continue-gates surfaced; loop provably bounded via exits |
| 11 | scratch | 300-person conference, replacement-pick loop, go/no-go | ✅ 0 err, 0 warn | 13 phases |
| 12 | scratch | fraud-ML migration, dynamic drift/loss gates, auto-fallback | ✅ 0 err, 6 warn | textbook expected-MAR014 handling; risk-team boundary modeled correctly |
| 13 | scratch | GDPR retention program, DPO bounce loops, external audit | ✅ 0 err, 0 warn | 11 phases, all counters verified |
| 14 | scratch | publisher vertical-slice milestone, streak gauntlet, cure period | ✅ 0 err, 5 warn | reset-counter MAR014s surfaced as expected |

## What the unhappy paths showed

- **Session 6 (masked diagnostics).** The seed's two reference typos
  (MAR003/004) suppress *all* graph analysis (`src/validate.ts` bails
  before dead-end/cycle/loop checks), hiding two undeclared cycles and a
  dead end. The agent recovered in one loop only because it re-checked the
  whole draft against the conventions while fixing the typos. The skill now
  tells authors to do exactly that; a compiler that partially reports
  graph diagnostics alongside reference errors would remove the trap
  entirely (noted on #8).
- **Session 7 (warning discipline).** Distinguished a tautological gate
  (removable — semantic fix) from genuine dynamic facts (surface, don't
  churn). Also surfaced that the skill didn't say expected warnings leave
  `--strict` at exit 1; the skill now does.
- **Session 9 (hostile notes).** "No sign-offs, retry forever, never end"
  fights both the compiler and the skill. The agent flagged all three
  conflicts explicitly and shipped a compilable compromise (one `@human`
  "retire the train" terminus; everything else autonomous). No silent
  requirement-dropping observed.

## New friction found this round

1. **`~loop~` placement changes what gets verified** (session 10). The
   monotonic-counter exemption for loop-continue gates applies only to
   choices carrying `~loop~` (`src/validate.ts:113`), so `{respins < 2}`
   on a cycle edge *not* bearing the mark comes back MAR014-unverified
   even though the counter is monotonic and the paired `{respins >= 2}`
   exits verify. Either extend `eventuallyFalse` to any gated edge whose
   source and target share the cycle's SCC, or teach the skill to put
   `~loop~` on the gated returning edge.
2. **Counter resets guarantee MAR014** (sessions 9, 12, 14). Restart
   semantics ("the whole evaluation starts over", streaks, per-night retry
   budgets) force `~ n = 0`, which breaks monotonicity analysis. This is
   issue #8 item 3 hit organically three times in one batch — it is the
   dominant source of unverified-gate noise in realistic plans.
3. **No parallel tracks** (sessions 10, 11). "Parallel-ish" workstreams
   get serialized with the parallelism relegated to prose. Both agents
   handled it gracefully, but it is a recurring modeling gap worth a PRD
   note.

## Artifacts

Sessions 6–7: `plan.seeded.mar` (the broken input), numbered
`validate-N.log`s, fixed `plan.mar`, render, summary. Sessions 8–14: same
layout as the first batch (`plan.first.mar`, `first-validate.log`,
`plan.mar`, `plan.mmd`, `summary.txt`). All first-pass logs verified
untouched against independent re-validation.
