import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compile } from '../src/compile.js';
import { executeRuntimeRequest } from '../src/runtime.js';
import {
  MAX_EVENT_BYTES, RuntimeStoreError, commitRuntimeStore, initializeRuntimeStore,
  claimRuntimeProcess, loadRuntimeStore, readRuntimeEvents, releaseRuntimeProcess,
  resolveArchivedTrajectory, runtimePaths,
} from '../src/runtime-store.js';
import { RUNTIME_PROTOCOL_VERSION, type RuntimePrincipal } from '../src/runtime-protocol.js';

const AT = '2026-07-23T21:00:00.000Z';
const AGENT: RuntimePrincipal = { id: 'agent-1', role: 'agent' };
const trajectory = (await compile(`
=== a ===
Alpha.
* [Go] -> b
=== b ===
Beta.
-> END
`)).trajectory!;

const withStore = async (fn: (root: string) => void | Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), 'marionette-runtime-store-'));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test('runtime store initializes a journal, atomic snapshot, and hash-addressed graph', () => withStore(async (root) => {
  const snapshot = await initializeRuntimeStore(root, trajectory, { runId: 'run-1', at: AT, principal: AGENT });
  const paths = runtimePaths(root, 'run-1', trajectory.hash);
  assert.equal(snapshot.events.length, 2);
  assert.equal(readRuntimeEvents(paths.events).length, 2);
  assert.equal(JSON.parse(readFileSync(paths.snapshot, 'utf8')).revision, 0);
  assert.equal((await resolveArchivedTrajectory(root, trajectory.hash)).hash, trajectory.hash);
}));

test('runtime store commits and replays decisions from the authoritative journal', () => withStore(async (root) => {
  const before = await initializeRuntimeStore(root, trajectory, { runId: 'run-2', at: AT, principal: AGENT });
  const result = await executeRuntimeRequest(trajectory, before, AGENT, {
    protocol: RUNTIME_PROTOCOL_VERSION,
    id: 1,
    op: 'choose',
    choiceId: 'a#0',
    rationale: 'alpha done',
    expectedRevision: 0,
    idempotencyKey: 'decision-1',
  }, { at: AT });
  commitRuntimeStore(root, trajectory, before, result.snapshot, result.events);

  const reopened = await loadRuntimeStore(root, 'run-2', trajectory);
  assert.equal(reopened.revision, 1);
  assert.equal(reopened.state.current, 'b');
  assert.equal(reopened.events.length, 4);
  assert.equal(reopened.idempotency['decision-1']?.revision, 1);
  assert.deepEqual(reopened.idempotency['decision-1']?.eventSeqs, [3, 4]);
}));

test('runtime store repairs a corrupt snapshot by replaying the journal', () => withStore(async (root) => {
  await initializeRuntimeStore(root, trajectory, { runId: 'run-3', at: AT });
  const paths = runtimePaths(root, 'run-3', trajectory.hash);
  writeFileSync(paths.snapshot, '{partial', 'utf8');
  const reopened = await loadRuntimeStore(root, 'run-3', trajectory);
  assert.equal(reopened.state.current, 'a');
  assert.equal(JSON.parse(readFileSync(paths.snapshot, 'utf8')).revision, 0);
}));

test('runtime store rejects stale concurrent commits', () => withStore(async (root) => {
  const before = await initializeRuntimeStore(root, trajectory, { runId: 'run-4', at: AT });
  const paths = runtimePaths(root, 'run-4', trajectory.hash);
  const cached = JSON.parse(readFileSync(paths.snapshot, 'utf8'));
  cached.revision = 2;
  writeFileSync(paths.snapshot, `${JSON.stringify(cached)}\n`, 'utf8');
  assert.throws(
    () => commitRuntimeStore(root, trajectory, before, before, []),
    (error: unknown) => error instanceof RuntimeStoreError && error.code === 'stale-revision',
  );
}));

test('runtime store bounds individual journal records', () => withStore(async (root) => {
  const snapshot = await initializeRuntimeStore(root, trajectory, { runId: 'run-5', at: AT });
  const oversized = structuredClone(snapshot.events[0]);
  oversized.seq = 3;
  oversized.data = { payload: 'x'.repeat(MAX_EVENT_BYTES) };
  assert.throws(
    () => commitRuntimeStore(root, trajectory, snapshot, snapshot, [oversized]),
    (error: unknown) => error instanceof RuntimeStoreError && error.code === 'event-too-large',
  );
}));

test('runtime process registration cleans up stale ownership records', () => withStore(async (root) => {
  await initializeRuntimeStore(root, trajectory, { runId: 'run-6', at: AT });
  const record = claimRuntimeProcess(root, 'run-6', trajectory.hash, { pid: 999_999, at: AT });
  assert.equal(record.pid, 999_999);
  assert.equal(JSON.parse(readFileSync(runtimePaths(root, 'run-6', trajectory.hash).process, 'utf8')).runId, 'run-6');
  releaseRuntimeProcess(root, 'run-6', trajectory.hash, 999_999);
  assert.equal(existsSync(runtimePaths(root, 'run-6', trajectory.hash).process), false);
}));

test('runtime journal replays observation writes before later decisions', () => withStore(async (root) => {
  const dynamic = (await compile(`
VAR remaining: number = ?
=== a ===
~ remaining -= 1
while {remaining > 0} -> a
else -> END
`)).trajectory!;
  const before = await initializeRuntimeStore(root, dynamic, {
    runId: 'run-observe', at: AT, principal: AGENT,
  });
  const observed = await executeRuntimeRequest(dynamic, before, AGENT, {
    protocol: RUNTIME_PROTOCOL_VERSION,
    id: 20,
    op: 'observe',
    name: 'remaining',
    value: 2,
    rationale: 'fresh two-item snapshot',
    expectedRevision: 0,
    idempotencyKey: 'observe-1',
  }, { at: AT });
  commitRuntimeStore(root, dynamic, before, observed.snapshot, observed.events);

  const reopened = await loadRuntimeStore(root, 'run-observe', dynamic);
  assert.equal(reopened.revision, 1);
  assert.equal(reopened.state.variables['remaining'], 1);
  assert.equal(reopened.state.observations[0].variable, 'remaining');
  assert.equal(reopened.idempotency['observe-1']?.revision, 1);
}));
