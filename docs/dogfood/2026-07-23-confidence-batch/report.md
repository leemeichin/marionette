# Confidence batch — 2026-07-23 (sessions 15–38)

Third round of simulated dogfooding, run to tighten the confidence bound on
the first-session compile metric past a 90% floor rather than the Phase 1
≥70% bar. Same method as the earlier batches
([sessions 1–5](../2026-07-23-simulated-batch/report.md),
[6–14](../2026-07-23-stress-batch/report.md)): fresh-context agents, skill +
`docs/DSL.md` + raw notes only, pre-validation snapshots
(`plan.first.mar` + verbatim `first-validate.log`), every snapshot
independently re-validated. This round stores snapshots and logs only, to
keep the repo lean at this volume.

## Headline

**36/36 (100%) zero-error first passes** across every from-scratch session
to date (1–5, 8–38). **Wilson 95% lower bound: 90.4%** — the metric is now
statistically above 90%, not just observed there. 19/36 were also
zero-warning under `--strict`; the other 17 carried only expected MAR014
warnings (reset counters and dynamic facts — both unverifiable by design),
surfaced per the skill's protocol. Revision-loop tests (6–7) remain 2/2.

Scenario spread this round: kitchen renovation, book contract, incident
response program, API v1 sunset, staff hire, DC exit, OSS 2.0 release,
payments reconciliation (contradictory notes), podcast season, university
course, payment-provider swap, six-language localization, WCAG AA program,
ERP migration, feature-store rollout, mobile OS update, wedding, SOC 2
Type II, live-ops season, clinic scheduling rollout, newsletter business,
WMS deployment, on-call overhaul, and a triple-veto agency rebrand (22
`@human` choices, still clean).

Sessions 15–22 ran against the pre-DX toolchain, 23–38 against the DX
build; three wave-1 sessions (18, 20 partially, 22) were killed by an
infrastructure API limit, not by the skill — 20 was scored from its
completed protocol artifacts, 18 and 22 were re-run fresh.

## Effect of the DX validator fix

The cycle-edge monotonic-gate fix (extending the `eventuallyFalse`
exemption beyond `~loop~`-marked edges) retroactively eliminates the false
MAR014s in sessions 15, 16, 17 (now 0-warning) and reduces 20 to its two
legitimately-unverifiable per-wave reset gates. Post-fix, essentially all
remaining MAR014 noise across the corpus traces to **counter resets**
(issue #8 item 3) — the one language-design question left open — plus
genuine dynamic facts, which should warn.

## Reading the numbers honestly

These are simulated sessions: one model family, one harness, notes written
by an agent rather than typed by a human mid-thought. The corpus is broad
(30+ domains, simple through 18-phase programs, three adversarial/trap
sets) and the protocol is snapshot-verified, but the number the Phase 1
gate ultimately wants confirmation from is manual, casual usage. Treat
90.4% as the floor the simulation establishes, not a promise.
