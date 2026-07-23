import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/compile.js';
import {
  buildRuntimeProjection, createRuntimeSnapshot, executeRuntimeRequest,
} from '../src/runtime.js';
import {
  ProtocolError, RUNTIME_PROTOCOL_VERSION, type RuntimePrincipal,
} from '../src/runtime-protocol.js';

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
  const initial = createRuntimeSnapshot(trajectory, { runId: 'run-1', at: AT });
  const before = structuredClone(initial);
  const result = await executeRuntimeRequest(trajectory, initial, AGENT, request(), { at: AT });

  assert.deepEqual(initial, before, 'input snapshot must remain unchanged');
  assert.equal(result.snapshot.revision, 1);
  assert.equal(result.snapshot.state.variables['n'], 2);
  assert.deepEqual(result.events.map((item) => item.kind), ['decision.committed', 'node.entered', 'human.required']);
  assert.equal(result.events[0].graph.choiceId, 'build#1');
  assert.equal(result.events[0].principal?.uri, 'pibarm://session/s7');
});

test('runtime binds human authority to the principal rather than request data', async () => {
  const initial = createRuntimeSnapshot(trajectory, { runId: 'run-2', at: AT });
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
  const initial = createRuntimeSnapshot(trajectory, { runId: 'run-3', at: AT });
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
  const initial = createRuntimeSnapshot(trajectory, { runId: 'run-4', at: AT });
  const signal = buildRuntimeProjection(trajectory, initial, { profile: 'signal' });
  assert.equal(signal.node?.body, undefined);
  assert.equal(signal.variables, undefined);
  assert.deepEqual(signal.choices.map((choice) => choice.id), ['build#0', 'build#1']);

  const work = buildRuntimeProjection(trajectory, initial, {
    profile: 'work',
    budget: { maxItems: 1, maxBodyChars: 5 },
  });
  assert.equal(work.node?.body, 'Build');
  assert.equal(work.choices.length, 1);
  assert.equal(work.truncated, true);
  assert.deepEqual(work.omitted, ['choices:1', 'node.body:4']);

  const debug = buildRuntimeProjection(trajectory, initial, { profile: 'debug' });
  assert.deepEqual(debug.variables, { n: 1 });
  assert.ok(debug.progress);
});

test('runtime can attach a graph-linked record without advancing the walker', async () => {
  const initial = createRuntimeSnapshot(trajectory, { runId: 'run-5', at: AT });
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
