import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compile } from '../src/compile.ts';
import { executeRuntimeRequest } from '../src/runtime.ts';
import { RuntimeRunController } from '../src/runtime-host.ts';
import {
  MAX_EVENT_BYTES, RuntimeStoreError, commitRuntimeStore, initializeRuntimeStore,
  archiveStateTrajectory, claimRuntimeProcess, loadRuntimeStore, readRuntimeEvents,
  releaseRuntimeProcess, resolveArchivedTrajectory, resolveStateTrajectory, runtimePaths,
  stateGraphStoreRoot,
} from '../src/runtime-store.ts';
import { RUNTIME_PROTOCOL_VERSION, type RuntimePrincipal } from '../src/runtime-protocol.ts';

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

test('state-file traversal archives and resolves a trustworthy graph baseline', () => withStore(async (root) => {
  const stateFile = join(root, 'custom.state.json');
  const path = await archiveStateTrajectory(stateFile, trajectory);
  assert.equal(path, runtimePaths(stateGraphStoreRoot(stateFile), 'unused', trajectory.hash).graph);
  assert.equal((await resolveStateTrajectory(stateFile, trajectory.hash)).hash, trajectory.hash);
  await assert.rejects(
    () => resolveStateTrajectory(stateFile, 'sha256:missing'),
    (error: unknown) => error instanceof RuntimeStoreError &&
      error.code === 'graph-mismatch' && /state baseline/.test(error.message),
  );
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

test('runtime amendments preserve graph epochs through replay and restart', () => withStore(async (root) => {
  const previous = (await compile(`
=== a ===
Alpha.
* [Go] -> b
=== b ===
Beta.
-> END
`)).trajectory!;
  const candidate = (await compile(`
=== a ===
Alpha.
* [Go] -> b
=== b ===
Beta now includes future work.
-> c
=== c ===
New future phase.
-> END
`)).trajectory!;
  const initial = await initializeRuntimeStore(root, previous, {
    runId: 'run-amend', at: AT, principal: AGENT,
  });
  const stepped = await executeRuntimeRequest(previous, initial, AGENT, {
    protocol: RUNTIME_PROTOCOL_VERSION,
    id: 30,
    op: 'choose',
    choiceId: 'a#0',
    rationale: 'alpha complete',
    expectedRevision: 0,
  }, { at: AT });
  commitRuntimeStore(root, previous, initial, stepped.snapshot, stepped.events);

  const controller = new RuntimeRunController(previous, stepped.snapshot, root);
  const amended = await controller.amend(
    { id: 'lee', role: 'human', uri: 'pi://human/lee' },
    candidate,
    { rationale: 'add the newly discovered future phase', expectedRevision: 1, at: AT },
  );
  assert.equal(amended.snapshot.revision, 2);
  assert.equal(amended.events[0].kind, 'plan.rebound');
  assert.equal(amended.events[0].graph.trajectoryHash, candidate.hash);

  const events = readRuntimeEvents(runtimePaths(root, 'run-amend', candidate.hash).events);
  assert.equal(events.find((event) => event.kind === 'decision.committed')?.graph.trajectoryHash, previous.hash);
  assert.equal(events.find((event) => event.kind === 'plan.rebound')?.graph.trajectoryHash, candidate.hash);
  const reopened = await loadRuntimeStore(root, 'run-amend', candidate);
  assert.equal(reopened.revision, 2);
  assert.equal(reopened.state.hash, candidate.hash);
  assert.equal(reopened.state.current, 'b');
  assert.equal(reopened.state.log.at(-1)?.actor, 'lee');
}));

test('runtime amendments reject agents and stale revisions without journal writes', () => withStore(async (root) => {
  const before = await initializeRuntimeStore(root, trajectory, {
    runId: 'run-amend-refused', at: AT, principal: AGENT,
  });
  const candidate = (await compile(`
=== a ===
Alpha updated before completion.
* [Go] -> b
=== b ===
Beta.
-> END
`)).trajectory!;
  const controller = new RuntimeRunController(trajectory, before, root);
  await assert.rejects(
    () => controller.amend(AGENT, candidate, {
      rationale: 'agent attempted approval', expectedRevision: 0, at: AT,
    }),
    (error: unknown) => (error as { code?: string }).code === 'forbidden',
  );
  await assert.rejects(
    () => controller.amend({ id: 'lee', role: 'human' }, candidate, {
      rationale: 'stale approval', expectedRevision: 2, at: AT,
    }),
    (error: unknown) => (error as { code?: string }).code === 'stale-revision',
  );
  assert.equal(readRuntimeEvents(runtimePaths(root, 'run-amend-refused', trajectory.hash).events).length, 2);
}));

test('concurrent runtime amendment writers leave the first accepted graph active', () => withStore(async (root) => {
  const before = await initializeRuntimeStore(root, trajectory, {
    runId: 'run-amend-concurrent', at: AT, principal: AGENT,
  });
  const first = (await compile(`
=== a ===
Alpha amended by the first writer.
* [Go] -> b
=== b ===
Beta.
-> END
`)).trajectory!;
  const second = (await compile(`
=== a ===
Alpha amended by the stale writer.
* [Go] -> b
=== b ===
Beta.
-> END
`)).trajectory!;
  const controllerA = new RuntimeRunController(trajectory, structuredClone(before), root);
  const controllerB = new RuntimeRunController(trajectory, structuredClone(before), root);
  await controllerA.amend({ id: 'lee', role: 'human' }, first, {
    rationale: 'first approved amendment', expectedRevision: 0, at: AT,
  });
  await assert.rejects(
    () => controllerB.amend({ id: 'sam', role: 'human' }, second, {
      rationale: 'stale concurrent amendment', expectedRevision: 0, at: AT,
    }),
    (error: unknown) => error instanceof RuntimeStoreError && error.code === 'stale-revision',
  );
  const reopened = await loadRuntimeStore(root, 'run-amend-concurrent', first);
  assert.equal(reopened.state.hash, first.hash);
  assert.equal(reopened.revision, 1);
  assert.equal(reopened.events.filter((event) => event.kind === 'plan.rebound').length, 1);
}));

test('runtime journal replays evidenced human confirmation', () => withStore(async (root) => {
  const external = (await compile(`
=== approval ===
* [Maintainer approved] @human -> END
`)).trajectory!;
  const before = await initializeRuntimeStore(root, external, {
    runId: 'run-external', at: AT, principal: AGENT,
  });
  const evidence = [{
    provider: 'github', kind: 'review', id: 'acme/repo#12',
    url: 'https://github.com/acme/repo/pull/12',
  }];
  const result = await executeRuntimeRequest(
    external,
    before,
    { id: 'maintainer', role: 'external-human' },
    {
      protocol: RUNTIME_PROTOCOL_VERSION,
      id: 40,
      op: 'confirm',
      choiceId: 'approval#0',
      rationale: 'approved on GitHub',
      evidence,
      expectedRevision: 0,
    },
    { at: AT },
  );
  commitRuntimeStore(root, external, before, result.snapshot, result.events);
  const reopened = await loadRuntimeStore(root, 'run-external', external);
  assert.equal(reopened.state.status, 'completed');
  assert.equal(reopened.state.log.at(-1)?.actor, 'maintainer');
  assert.equal(reopened.events.find((event) => event.kind === 'external.confirmed')?.principal?.role,
    'external-human');
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
