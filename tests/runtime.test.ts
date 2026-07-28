import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/compile.ts';
import {
  buildRuntimeProjection, createRuntimeSnapshot, executeRuntimeRequest,
} from '../src/runtime.ts';
import {
  ProtocolError, RUNTIME_PROTOCOL_VERSION, type RuntimePrincipal,
} from '../src/runtime-protocol.ts';

const AT = '2026-07-23T20:00:00.000Z';
const AGENT: RuntimePrincipal = { id: 'agent-7', role: 'agent', uri: 'pibarm://session/s7' };
const HUMAN: RuntimePrincipal = { id: 'lee', role: 'human' };

const trajectory = (await compile(`
VAR n = 0
=== build ===
Build it.
~ n += 1
* [Ship] @human -> END
+ {n < 2} [Retry] ~loop~ -> build
`)).trajectory!;

const request = (overrides: Record<string, unknown> = {}) => ({
  protocol: RUNTIME_PROTOCOL_VERSION,
  id: 1,
  op: 'choose' as const,
  choiceId: 'build#1',
  rationale: 'first attempt needs work',
  expectedRevision: 0,
  idempotencyKey: 'turn-1',
  ...overrides,
});

test('runtime command engine is immutable and emits graph-bound lifecycle events', async () => {
  const initial = await createRuntimeSnapshot(trajectory, { runId: 'run-1', at: AT });
  const before = structuredClone(initial);
  const result = await executeRuntimeRequest(trajectory, initial, AGENT, request(), { at: AT });

  assert.deepEqual(initial, before, 'input snapshot must remain unchanged');
  assert.equal(result.snapshot.revision, 1);
  assert.equal(result.snapshot.state.variables['n'], 2);
  assert.deepEqual(result.events.map((item) => item.kind), ['decision.committed', 'node.entered', 'human.required']);
  assert.equal(result.events[0].graph.choiceId, 'build#1');
  assert.equal(result.events[0].principal?.uri, 'pibarm://session/s7');
  assert.equal(result.events[2].data['expectedRevision'], 1);
  assert.match(result.events[2].data['id'] as string, /\/escalation\/\d+$/);
  assert.deepEqual(result.events[2].data['choices'], [{
    id: 'build#0',
    label: 'Ship',
    target: 'END',
  }]);
  const projection = result.result.projection as Awaited<ReturnType<typeof buildRuntimeProjection>>;
  assert.equal(projection.escalation?.id, result.events[2].data['id']);
  assert.equal(projection.escalation?.expectedRevision, 1);
});

test('runtime binds human authority to the principal rather than request data', async () => {
  const initial = await createRuntimeSnapshot(trajectory, { runId: 'run-2', at: AT });
  await assert.rejects(
    () => executeRuntimeRequest(trajectory, initial, AGENT, request({
      id: 2,
      choiceId: 'build#0',
      rationale: 'pretend approval',
      idempotencyKey: undefined,
    }), { at: AT }),
    (error: unknown) => error instanceof ProtocolError && error.code === 'forbidden',
  );

  const approved = await executeRuntimeRequest(trajectory, initial, HUMAN, request({
    id: 3,
    choiceId: 'build#0',
    rationale: 'reviewed and approved',
    idempotencyKey: 'approval-1',
  }), { at: AT });
  assert.equal(approved.snapshot.state.status, 'completed');
  assert.deepEqual(approved.events.map((item) => item.kind), ['decision.committed', 'run.completed']);
});

test('runtime rejects stale writes and replays matching idempotent writes once', async () => {
  const initial = await createRuntimeSnapshot(trajectory, { runId: 'run-3', at: AT });
  const first = await executeRuntimeRequest(trajectory, initial, AGENT, request(), { at: AT });
  const replay = await executeRuntimeRequest(trajectory, first.snapshot, AGENT, request(), { at: AT });
  assert.equal(replay.replayed, true);
  assert.equal(replay.snapshot.events.length, first.snapshot.events.length);

  await assert.rejects(
    () => executeRuntimeRequest(trajectory, first.snapshot, AGENT, request({
      id: 4,
      idempotencyKey: 'other',
    }), { at: AT }),
    (error: unknown) => error instanceof ProtocolError && error.code === 'stale-revision',
  );
});

test('runtime projections progressively disclose context and enforce budgets', async () => {
  const initial = await createRuntimeSnapshot(trajectory, { runId: 'run-4', at: AT });
  const signal = await buildRuntimeProjection(trajectory, initial, { profile: 'signal' });
  assert.equal(signal.node?.body, undefined);
  assert.equal(signal.variables, undefined);
  assert.equal(signal.plan, undefined);
  assert.equal(signal.delivery, undefined);
  assert.deepEqual(signal.choices.map((choice) => choice.id), ['build#0', 'build#1']);

  const work = await buildRuntimeProjection(trajectory, initial, {
    profile: 'work',
    budget: { maxItems: 1, maxBodyChars: 5 },
  });
  assert.equal(work.node?.body, 'Build');
  assert.equal(work.choices.length, 1);
  assert.equal(work.truncated, true);
  assert.deepEqual(work.omitted, ['choices:1', 'node.body:4']);
  assert.equal(work.plan?.intent.summary, null);
  assert.ok(work.delivery);
  assert.deepEqual(work.variables, { n: 1 });
  assert.ok(work.progress);

  const debug = await buildRuntimeProjection(trajectory, initial, { profile: 'debug' });
  assert.deepEqual(debug.variables, { n: 1 });
  assert.ok(debug.progress);

  const completeWork = await buildRuntimeProjection(trajectory, initial, { profile: 'work' });
  assert.equal(completeWork.node?.body, 'Build it.');
  assert.equal(completeWork.choices.length, 2);
  assert.equal(completeWork.truncated, false);
});

test('runtime can attach a graph-linked record without advancing the walker', async () => {
  const initial = await createRuntimeSnapshot(trajectory, { runId: 'run-5', at: AT });
  const result = await executeRuntimeRequest(trajectory, initial, AGENT, {
    protocol: RUNTIME_PROTOCOL_VERSION,
    id: 5,
    op: 'record',
    kind: 'architecture-decision',
    summary: 'Use local NDJSON IPC',
    rationale: 'Keeps transport out of model context',
    expectedRevision: 0,
  }, { at: AT });
  assert.equal(result.snapshot.state.current, 'build');
  assert.equal(result.snapshot.revision, 1);
  assert.equal(result.events[0].kind, 'record.attached');
  assert.equal(result.events[0].graph.nodeId, 'build');
});

test('runtime records typed observations and unlocks a late-bound frontier', async () => {
  const dynamic = (await compile(`
VAR remaining: number = ?
=== work ===
~ remaining -= 1
while {remaining > 0} -> work
else -> END
`)).trajectory!;
  const initial = await createRuntimeSnapshot(dynamic, { runId: 'run-observe', at: AT });
  assert.deepEqual(initial.events.map((item) => item.kind),
    ['run.started', 'node.entered', 'observation.required']);
  assert.equal((await buildRuntimeProjection(dynamic, initial)).status, 'awaiting-observation');

  const result = await executeRuntimeRequest(dynamic, initial, AGENT, {
    protocol: RUNTIME_PROTOCOL_VERSION,
    id: 6,
    op: 'observe',
    name: 'remaining',
    value: 2,
    rationale: 'captured two units of work',
    expectedRevision: 0,
    idempotencyKey: 'observation-1',
  }, { at: AT });
  assert.equal(result.snapshot.state.variables['remaining'], 1);
  assert.equal(result.snapshot.revision, 1);
  assert.deepEqual(result.events.map((item) => item.kind), ['observation.recorded']);
  assert.equal(result.result.projection &&
    (result.result.projection as { status: string }).status, 'active');
});

test('runtime projections and writes use the same timeout evaluation time', async () => {
  const timed = (await compile(`
=== experiment ===
+ [Retry] ~loop~ -> experiment
timeout 1h [Budget spent] -> END
`)).trajectory!;
  const initial = await createRuntimeSnapshot(timed, { runId: 'run-timeout', at: AT });

  const before = await executeRuntimeRequest(timed, initial, AGENT, {
    protocol: RUNTIME_PROTOCOL_VERSION,
    id: 7,
    op: 'next',
    profile: 'debug',
  }, { at: '2026-07-23T20:30:00.000Z' });
  const beforeProjection = before.result.projection as Awaited<ReturnType<typeof buildRuntimeProjection>>;
  assert.equal(beforeProjection.choices[0].blocked, undefined);
  assert.equal(beforeProjection.choices[1].blocked?.code, 'timeout-pending');
  assert.equal(beforeProjection.choices[1].dueAt, '2026-07-23T21:00:00.000Z');

  const after = await executeRuntimeRequest(timed, initial, AGENT, {
    protocol: RUNTIME_PROTOCOL_VERSION,
    id: 8,
    op: 'next',
    profile: 'debug',
  }, { at: '2026-07-23T21:30:00.000Z' });
  const afterProjection = after.result.projection as Awaited<ReturnType<typeof buildRuntimeProjection>>;
  assert.equal(afterProjection.choices[0].blocked?.code, 'timed-out');
  assert.equal(afterProjection.choices[1].blocked, undefined);

  const completed = await executeRuntimeRequest(timed, initial, AGENT, {
    protocol: RUNTIME_PROTOCOL_VERSION,
    id: 9,
    op: 'choose',
    choiceId: 'experiment#1',
    rationale: 'hard budget elapsed',
    expectedRevision: 0,
  }, { at: '2026-07-23T21:30:00.000Z' });
  assert.equal(completed.snapshot.state.status, 'completed');
});

test('work projections carry timeout wake data and stranded diagnostics', async () => {
  const waiting = (await compile(`
=== wait ===
timeout 1h [Window opens] -> END
`)).trajectory!;
  const waitingState = await createRuntimeSnapshot(waiting, {
    runId: 'run-waiting',
    at: '2026-07-23T21:00:00.000Z',
  });
  const waitingProjection = await buildRuntimeProjection(waiting, waitingState, {
    profile: 'work',
    at: '2026-07-23T21:30:00.000Z',
  });
  assert.equal(waitingProjection.status, 'waiting-timeout');
  assert.equal(waitingProjection.choices[0].blocked?.code, 'timeout-pending');
  assert.equal(waitingProjection.choices[0].dueAt, '2026-07-23T22:00:00.000Z');

  const stranded = (await compile(`
VAR approved: boolean = false
=== blocked ===
* [Ship] {approved} -> END
`)).trajectory!;
  const strandedState = await createRuntimeSnapshot(stranded, {
    runId: 'run-stranded',
    at: AT,
  });
  const strandedProjection = await buildRuntimeProjection(stranded, strandedState, {
    profile: 'work',
  });
  assert.equal(strandedProjection.status, 'stranded');
  assert.equal(strandedProjection.choices[0].gate, 'approved');
  assert.equal(strandedProjection.choices[0].blocked?.code, 'gate-blocked');
  assert.deepEqual(strandedProjection.variables, { approved: false });
});
