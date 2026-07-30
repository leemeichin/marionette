import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/compile.ts';
import { analyzeAmendment } from '../src/amendment.ts';
import { ask, initState, takeChoice } from '../src/state.ts';

const AT = '2026-07-30T14:00:00.000Z';
const compiled = async (source: string) => (await compile(source)).trajectory!;

test('amendment permits additions and edits confined to unfinished phases', async () => {
  const previous = await compiled(`
VAR approved = true
=== a ===
Alpha.
* [Go] {approved} -> b
=== b ===
Beta.
* [Continue] -> c
=== c ===
Gamma.
-> END
`);
  let state = await initState(previous, 'system', AT);
  state = await takeChoice(previous, state, 'a#0', { actor: 'agent', rationale: 'alpha done', at: AT });
  const candidate = await compiled(`
VAR approved = true
VAR retries = 0
=== a ===
Alpha.
* [Go] {approved} -> b
=== b ===
Beta now includes newly discovered work.
* [Continue] -> inserted
=== inserted ===
Do the inserted work.
-> c
=== c ===
Gamma, updated before execution.
-> END
`);

  const report = analyzeAmendment(previous, candidate, state);
  assert.equal(report.allowed, true);
  assert.deepEqual(report.frozenPhases, ['a']);
  assert.deepEqual(report.frozenVariables, ['approved']);
  assert.ok(report.changes.some((change) => change.kind === 'phase-added' && change.subject === 'inserted'));
  assert.ok(report.changes.some((change) => change.kind === 'phase-updated' && change.subject === 'b'));
  assert.ok(report.changes.some((change) => change.kind === 'variable-added' && change.subject === 'retries'));
});

test('amendment rejects completed phase and frozen variable changes', async () => {
  const previous = await compiled(`
VAR approved = true
=== a ===
Alpha.
* [Go] {approved} -> b
=== b ===
Beta.
-> END
`);
  let state = await initState(previous, 'system', AT);
  state = await takeChoice(previous, state, 'a#0', { actor: 'agent', rationale: 'alpha done', at: AT });
  const candidate = await compiled(`
VAR approved = false
=== a ===
Alpha rewritten.
-> b
=== b ===
Beta.
-> END
`);

  const report = analyzeAmendment(previous, candidate, state);
  assert.equal(report.allowed, false);
  assert.ok(report.violations.some((violation) =>
    violation.code === 'completed-phase-changed' && violation.fields.includes('choices')));
  assert.ok(report.violations.some((violation) => violation.code === 'frozen-variable-changed'));
});

test('amendment rejects deleting the current phase', async () => {
  const previous = await compiled('=== a ===\nAlpha.\n-> b\n=== b ===\nBeta.\n-> END\n');
  const state = await initState(previous, 'system', AT);
  const candidate = await compiled('=== b ===\nBeta.\n-> END\n');
  const report = analyzeAmendment(previous, candidate, state);
  assert.ok(report.violations.some((violation) => violation.code === 'current-phase-removed'));
});

test('a phase id revisited through a loop remains frozen', async () => {
  const previous = await compiled(`
=== a ===
Alpha.
+ [Retry] ~loop~ -> a
* [Done] -> END
`);
  let state = await initState(previous, 'system', AT);
  state = await takeChoice(previous, state, 'a#0', { actor: 'agent', rationale: 'retry', at: AT });
  const candidate = await compiled(`
=== a ===
Alpha rewritten during the second activation.
+ [Retry] ~loop~ -> a
* [Done] -> END
`);
  const report = analyzeAmendment(previous, candidate, state);
  assert.deepEqual(report.frozenPhases, ['a']);
  assert.ok(report.violations.some((violation) => violation.code === 'completed-phase-changed'));
});

test('an open elicitation keeps its exact ask edge and target', async () => {
  const previous = await compiled(`
=== a ===
* [Clarify] @ask -> b
=== b ===
Beta.
-> END
`);
  let state = await initState(previous, 'system', AT);
  state = await ask(previous, state, 'a#0', {
    actor: 'agent', question: 'Which target?', rationale: 'ambiguous', at: AT,
  });
  const candidate = await compiled(`
=== a ===
* [Clarify] @ask -> c
=== b ===
Beta.
-> END
=== c ===
Changed destination.
-> END
`);
  const report = analyzeAmendment(previous, candidate, state);
  assert.ok(report.violations.some((violation) => violation.code === 'pending-elicitation-changed'));
});

test('a completed run has no amendable executable future', async () => {
  const previous = await compiled('=== a ===\n* [Done] -> END\n');
  let state = await initState(previous, 'system', AT);
  state = await takeChoice(previous, state, 'a#0', { actor: 'agent', rationale: 'done', at: AT });
  const candidate = await compiled('=== a ===\nChanged after completion.\n* [Done] -> END\n');
  const report = analyzeAmendment(previous, candidate, state);
  assert.ok(report.violations.some((violation) => violation.code === 'completed-run'));
});
