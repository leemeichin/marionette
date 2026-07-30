import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, trajectoryHash } from '../src/compile.ts';
import { buildBrief } from '../src/brief.ts';
import {
  WalkError, answer, ask, confirmExternal, initState, takeChoice,
} from '../src/state.ts';
import { createRuntimeSnapshot, executeRuntimeRequest } from '../src/runtime.ts';
import { RUNTIME_PROTOCOL_VERSION } from '../src/runtime-protocol.ts';

const AT = '2026-07-30T15:00:00.000Z';
const evidence = [{ provider: 'github', kind: 'review', id: 'acme/repo#12', url: 'https://github.com/acme/repo/pull/12' }];

test('an archived spec-0.5 ask still opens and answers as fixed-target input', async () => {
  const trajectory = (await compile(`
=== clarify ===
* [Need context] @ask -> END
`)).trajectory!;
  trajectory.spec = '0.5.0';
  trajectory.hash = await trajectoryHash(trajectory);
  let state = await initState(trajectory, 'system', AT);
  state = await ask(trajectory, state, 'clarify#0', {
    actor: 'agent', question: 'What context?', rationale: 'legacy graph', at: AT,
  });
  state = await answer(trajectory, state, { actor: 'lee', answer: 'legacy answer', at: AT });
  assert.equal(state.status, 'completed');
});

test('@ask is a trusted operator route decision with all choices projected', async () => {
  const trajectory = (await compile(`
=== review ===
Choose the release outcome after reviewing the evidence.
* [Approve] @ask -> END
* [Request changes] @ask -> rework
=== rework ===
Apply review feedback.
-> END
`)).trajectory!;
  const state = await initState(trajectory, 'system', AT);
  const brief = await buildBrief(trajectory, state);
  assert.equal(trajectory.spec, '0.6.0');
  assert.equal(brief.status, 'awaiting-operator');
  assert.equal(brief.escalation?.kind, 'operator');
  assert.deepEqual(brief.escalation?.choices, ['review#0', 'review#1']);
  await assert.rejects(
    () => takeChoice(trajectory, state, 'review#0', { actor: 'agent', rationale: 'self approve', at: AT }),
    (error: unknown) => error instanceof WalkError && error.code === 'operator-checkpoint',
  );
  const chosen = await takeChoice(trajectory, state, 'review#1', {
    actor: 'lee', rationale: 'the evidence needs revision', at: AT,
  });
  assert.equal(chosen.current, 'rework');
});

test('operator decision packets include recently attached evidence records', async () => {
  const trajectory = (await compile(`
=== review ===
Review the attached test report.
* [Approve] @ask -> END
* [Revise] @ask -> END
`)).trajectory!;
  const snapshot = await createRuntimeSnapshot(trajectory, { runId: 'packet-record', at: AT });
  const recorded = await executeRuntimeRequest(trajectory, snapshot, { id: 'agent', role: 'agent' }, {
    protocol: RUNTIME_PROTOCOL_VERSION,
    id: 10,
    op: 'record',
    kind: 'test-report',
    summary: 'All 42 integration tests pass',
    refs: evidence,
    expectedRevision: 0,
  }, { at: AT });
  const projection = recorded.result.projection as { escalation: { context: { recentRecords: Array<{ summary: string }> } } };
  assert.equal(projection.escalation.context.recentRecords[0].summary, 'All 42 integration tests pass');
});

test('@input keeps focused free-text clarification on a fixed route', async () => {
  const trajectory = (await compile(`
=== clarify ===
* [Need release targets] @input -> implement
=== implement ===
Use the supplied targets.
-> END
`)).trajectory!;
  let state = await initState(trajectory, 'system', AT);
  state = await ask(trajectory, state, 'clarify#0', {
    actor: 'agent', question: 'Which release targets?', rationale: 'not specified', at: AT,
  });
  assert.equal((await buildBrief(trajectory, state)).status, 'awaiting-elicitation');
  state = await answer(trajectory, state, { actor: 'lee', answer: 'Linux and macOS', at: AT });
  assert.equal(state.current, 'implement');
});

test('@human requires a distinct external principal and durable evidence', async () => {
  const trajectory = (await compile(`
=== approval ===
Wait for a maintainer to approve the pull request.
* [Maintainer approved] @human -> END
`)).trajectory!;
  const state = await initState(trajectory, 'system', AT);
  const brief = await buildBrief(trajectory, state);
  assert.equal(brief.status, 'awaiting-external');
  assert.equal(brief.escalation?.kind, 'external');
  await assert.rejects(
    () => takeChoice(trajectory, state, 'approval#0', {
      actor: 'lee', rationale: 'I approve my own PR', at: AT,
    }),
    (error: unknown) => error instanceof WalkError && error.code === 'external-confirmation-required',
  );
  await assert.rejects(
    () => confirmExternal(trajectory, state, 'approval#0', {
      actor: 'maintainer', rationale: 'approved', evidence: [], at: AT,
    }),
    (error: unknown) => error instanceof WalkError && error.code === 'external-evidence-required',
  );
  const confirmed = await confirmExternal(trajectory, state, 'approval#0', {
    actor: 'maintainer', rationale: 'approved in GitHub', evidence, at: AT,
  });
  assert.equal(confirmed.status, 'completed');
});

test('runtime confirm records the external actor and evidence separately', async () => {
  const trajectory = (await compile(`
=== approval ===
* [Maintainer approved] @human -> END
`)).trajectory!;
  const snapshot = await createRuntimeSnapshot(trajectory, { runId: 'external', at: AT });
  const result = await executeRuntimeRequest(
    trajectory,
    snapshot,
    { id: 'maintainer-1', role: 'external-human', uri: 'github://maintainer-1' },
    {
      protocol: RUNTIME_PROTOCOL_VERSION,
      id: 1,
      op: 'confirm',
      choiceId: 'approval#0',
      rationale: 'approved in GitHub',
      evidence,
      expectedRevision: 0,
    },
    { at: AT },
  );
  assert.equal(result.events[0].kind, 'external.confirmed');
  assert.equal(result.events[0].principal?.role, 'external-human');
  assert.deepEqual(result.events[0].data['evidence'], evidence);
  assert.equal(result.snapshot.state.status, 'completed');
});
