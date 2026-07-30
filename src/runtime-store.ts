import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { trajectoryHash } from './compile.ts';
import {
  answer, ask, confirmExternal, initState, takeChoice, advance, observe, rebindState,
} from './state.ts';
import type { PlanState, Ref, Trajectory } from './types.ts';
import type {
  RuntimeEvent, RuntimePrincipal,
} from './runtime-protocol.ts';
import {
  createRuntimeSnapshot,
  type RuntimeIdempotencyRecord,
  type RuntimeSnapshot,
} from './runtime.ts';

export const RUNTIME_STORE_VERSION = 2;
export const MAX_EVENT_BYTES = 64 * 1024;

interface StoredSnapshot {
  version: typeof RUNTIME_STORE_VERSION;
  graphHash: string;
  runId: string;
  revision: number;
  cursor: number;
  state: PlanState;
  idempotency: Record<string, RuntimeIdempotencyRecord>;
}

export interface RuntimePaths {
  root: string;
  graph: string;
  run: string;
  snapshot: string;
  events: string;
  process: string;
}

export interface RuntimeProcessRecord {
  pid: number;
  runId: string;
  graphHash: string;
  startedAt: string;
}

export class RuntimeStoreError extends Error {
  constructor(message: string, public readonly code:
    | 'invalid-run-id'
    | 'run-exists'
    | 'run-not-found'
    | 'graph-mismatch'
    | 'corrupt-journal'
    | 'event-too-large'
    | 'stale-revision'
    | 'run-active') {
    super(message);
    this.name = 'RuntimeStoreError';
  }
}

const safeRunId = (runId: string): string => {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new RuntimeStoreError(
      `invalid run id "${runId}"; use letters, digits, dot, underscore, or hyphen`,
      'invalid-run-id',
    );
  }
  return runId;
};

const graphFileName = (hash: string): string =>
  `${hash.replace(/[^A-Za-z0-9._-]/g, '-')}.trajectory.json`;

export function runtimePaths(root: string, runId: string, graphHash: string): RuntimePaths {
  const safe = safeRunId(runId);
  const run = join(root, 'runs', safe);
  return {
    root,
    graph: join(root, 'graphs', graphFileName(graphHash)),
    run,
    snapshot: join(run, 'snapshot.json'),
    events: join(run, 'events.jsonl'),
    process: join(run, 'process.json'),
  };
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

function stored(snapshot: RuntimeSnapshot, graphHash: string): StoredSnapshot {
  return {
    version: RUNTIME_STORE_VERSION,
    graphHash,
    runId: snapshot.runId,
    revision: snapshot.revision,
    cursor: snapshot.events.at(-1)?.seq ?? 0,
    state: snapshot.state,
    idempotency: snapshot.idempotency,
  };
}

function writeStoredSnapshot(path: string, snapshot: RuntimeSnapshot, graphHash: string): void {
  atomicWrite(path, `${JSON.stringify(stored(snapshot, graphHash), null, 2)}\n`);
}

function appendEvents(path: string, events: RuntimeEvent[]): void {
  if (events.length === 0) return;
  const lines = events.map((item) => {
    const line = JSON.stringify(item);
    const bytes = Buffer.byteLength(line);
    if (bytes > MAX_EVENT_BYTES) {
      throw new RuntimeStoreError(
        `runtime event ${item.seq} is ${bytes} bytes; maximum is ${MAX_EVENT_BYTES}`,
        'event-too-large',
      );
    }
    return line;
  });
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a', 0o600);
  try {
    writeSync(fd, `${lines.join('\n')}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readRuntimeEvents(path: string): RuntimeEvent[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  const events: RuntimeEvent[] = [];
  let expected = 1;
  for (const line of lines) {
    if (Buffer.byteLength(line) > MAX_EVENT_BYTES) {
      throw new RuntimeStoreError(`runtime event line exceeds ${MAX_EVENT_BYTES} bytes`, 'event-too-large');
    }
    let item: RuntimeEvent;
    try {
      item = JSON.parse(line) as RuntimeEvent;
    } catch {
      throw new RuntimeStoreError(`runtime journal contains invalid JSON at sequence ${expected}`, 'corrupt-journal');
    }
    if (item.seq !== expected) {
      throw new RuntimeStoreError(
        `runtime journal sequence is ${item.seq}; expected ${expected}`,
        'corrupt-journal',
      );
    }
    events.push(item);
    expected++;
  }
  return events;
}

export async function archiveTrajectory(root: string, trajectory: Trajectory): Promise<string> {
  const path = join(root, 'graphs', graphFileName(trajectory.hash));
  if (!existsSync(path)) {
    atomicWrite(path, `${JSON.stringify(trajectory, null, 2)}\n`);
  } else {
    const archived = JSON.parse(readFileSync(path, 'utf8')) as Trajectory;
    if (archived.hash !== trajectory.hash || await trajectoryHash(archived) !== trajectory.hash) {
      throw new RuntimeStoreError(`archived graph at ${path} has the wrong hash`, 'graph-mismatch');
    }
  }
  return path;
}

export async function resolveArchivedTrajectory(root: string, hash: string): Promise<Trajectory> {
  const path = join(root, 'graphs', graphFileName(hash));
  if (!existsSync(path)) {
    throw new RuntimeStoreError(`no archived trajectory for ${hash}`, 'run-not-found');
  }
  const trajectory = JSON.parse(readFileSync(path, 'utf8')) as Trajectory;
  if (trajectory.hash !== hash || await trajectoryHash(trajectory) !== hash) {
    throw new RuntimeStoreError(`archived graph at ${path} has the wrong hash`, 'graph-mismatch');
  }
  return trajectory;
}

/**
 * State-file traversal shares the same content-addressed graph archive as the
 * durable runtime. Custom state files still resolve relative to their own
 * directory, so moving a plan and its state/archive together is sufficient.
 */
export function stateGraphStoreRoot(stateFile: string): string {
  return join(dirname(stateFile), '.marionette');
}

export async function archiveStateTrajectory(
  stateFile: string,
  trajectory: Trajectory,
): Promise<string> {
  return archiveTrajectory(stateGraphStoreRoot(stateFile), trajectory);
}

export async function resolveStateTrajectory(
  stateFile: string,
  hash: string,
): Promise<Trajectory> {
  try {
    return await resolveArchivedTrajectory(stateGraphStoreRoot(stateFile), hash);
  } catch (error) {
    if (error instanceof RuntimeStoreError && error.code === 'run-not-found') {
      throw new RuntimeStoreError(
        `no archived baseline for state graph ${hash}; restore the source that matches this state ` +
        'and run "marionette state baseline <plan>" before editing it',
        'graph-mismatch',
      );
    }
    throw error;
  }
}

export async function initializeRuntimeStore(
  root: string,
  trajectory: Trajectory,
  options: { runId: string; at?: string; principal?: RuntimePrincipal },
): Promise<RuntimeSnapshot> {
  const paths = runtimePaths(root, options.runId, trajectory.hash);
  if (existsSync(paths.run)) {
    throw new RuntimeStoreError(`runtime run "${options.runId}" already exists`, 'run-exists');
  }
  await archiveTrajectory(root, trajectory);
  mkdirSync(paths.run, { recursive: true });
  const snapshot = await createRuntimeSnapshot(trajectory, options);
  appendEvents(paths.events, snapshot.events);
  writeStoredSnapshot(paths.snapshot, snapshot, trajectory.hash);
  return snapshot;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readRuntimeProcess(
  root: string,
  runId: string,
  graphHash: string,
): RuntimeProcessRecord | null {
  const path = runtimePaths(root, runId, graphHash).process;
  if (!existsSync(path)) return null;
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as RuntimeProcessRecord;
    if (record.runId !== runId || record.graphHash !== graphHash || !Number.isSafeInteger(record.pid)) {
      unlinkSync(path);
      return null;
    }
    return record;
  } catch {
    unlinkSync(path);
    return null;
  }
}

export function claimRuntimeProcess(
  root: string,
  runId: string,
  graphHash: string,
  options: { pid?: number; at?: string } = {},
): RuntimeProcessRecord {
  const paths = runtimePaths(root, runId, graphHash);
  const prior = readRuntimeProcess(root, runId, graphHash);
  if (prior && processIsAlive(prior.pid)) {
    throw new RuntimeStoreError(
      `run "${runId}" is already running (pid ${prior.pid})`,
      'run-active',
    );
  }
  const record: RuntimeProcessRecord = {
    pid: options.pid ?? process.pid,
    runId,
    graphHash,
    startedAt: options.at ?? new Date().toISOString(),
  };
  atomicWrite(paths.process, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function releaseRuntimeProcess(
  root: string,
  runId: string,
  graphHash: string,
  pid = process.pid,
): void {
  const paths = runtimePaths(root, runId, graphHash);
  const record = readRuntimeProcess(root, runId, graphHash);
  if (record?.pid === pid && existsSync(paths.process)) unlinkSync(paths.process);
}

export type StopRuntimeResult =
  | { status: 'not-running' }
  | { status: 'requested'; pid: number };

export function stopRuntimeProcess(
  root: string,
  runId: string,
  graphHash: string,
): StopRuntimeResult {
  const paths = runtimePaths(root, runId, graphHash);
  const record = readRuntimeProcess(root, runId, graphHash);
  if (!record) return { status: 'not-running' };
  if (!processIsAlive(record.pid)) {
    if (existsSync(paths.process)) unlinkSync(paths.process);
    return { status: 'not-running' };
  }
  try {
    process.kill(record.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      if (existsSync(paths.process)) unlinkSync(paths.process);
      return { status: 'not-running' };
    }
    throw new RuntimeStoreError(
      `could not stop run "${runId}" (pid ${record.pid}): ${(error as Error).message}`,
      'run-active',
    );
  }
  return { status: 'requested', pid: record.pid };
}

async function replayRuntimeEvents(
  root: string,
  expectedTrajectory: Trajectory,
  runId: string,
  events: RuntimeEvent[],
): Promise<RuntimeSnapshot> {
  const started = events.find((item) => item.kind === 'run.started');
  if (!started) throw new RuntimeStoreError('runtime journal has no run.started event', 'corrupt-journal');
  if (started.runId !== runId || events.some((item) => item.runId !== runId)) {
    throw new RuntimeStoreError('runtime journal contains events for a different run', 'corrupt-journal');
  }
  let trajectory = await resolveArchivedTrajectory(root, started.graph.trajectoryHash);
  const principal = started.principal;
  let state = await initState(trajectory, principal?.id ?? 'system', started.at);
  let revision = 0;
  const idempotency: Record<string, RuntimeIdempotencyRecord> = {};

  for (const item of events) {
    if (item.kind === 'plan.rebound') {
      const fromHash = item.data['fromHash'];
      const toHash = item.data['toHash'];
      const rationale = typeof item.data['rationale'] === 'string' ? item.data['rationale'] : undefined;
      if (fromHash !== trajectory.hash || toHash !== item.graph.trajectoryHash || !item.principal) {
        throw new RuntimeStoreError(
          `plan.rebound event ${item.seq} does not link the active graph epoch`,
          'corrupt-journal',
        );
      }
      const candidate = await resolveArchivedTrajectory(root, item.graph.trajectoryHash);
      try {
        rebindState(candidate, state, {
          previousTrajectory: trajectory,
          actor: item.principal.id,
          rationale,
          at: item.at,
        });
      } catch (error) {
        throw new RuntimeStoreError(
          `plan.rebound event ${item.seq} cannot be replayed: ${(error as Error).message}`,
          'corrupt-journal',
        );
      }
      trajectory = candidate;
      revision++;
      continue;
    }
    if (item.graph.trajectoryHash !== trajectory.hash) {
      throw new RuntimeStoreError(
        `runtime event ${item.seq} references graph ${item.graph.trajectoryHash} outside its epoch`,
        'graph-mismatch',
      );
    }
    if (item.kind !== 'decision.committed' &&
        item.kind !== 'external.confirmed' &&
        item.kind !== 'elicitation.required' &&
        item.kind !== 'elicitation.answered' &&
        item.kind !== 'observation.recorded' &&
        item.kind !== 'record.attached') continue;
    revision++;
    if (item.kind === 'decision.committed') {
      const rationale = typeof item.data['rationale'] === 'string' ? item.data['rationale'] : undefined;
      const actor = item.principal?.role === 'agent' ? 'agent' : item.principal?.id ?? 'system';
      if (item.graph.choiceId) {
        state = await takeChoice(trajectory, state, item.graph.choiceId, { actor, rationale, at: item.at });
      } else {
        state = await advance(trajectory, state, { actor, rationale, at: item.at });
      }
    } else if (item.kind === 'external.confirmed') {
      const rationale = typeof item.data['rationale'] === 'string' ? item.data['rationale'] : undefined;
      const evidence = Array.isArray(item.data['evidence']) ? item.data['evidence'] as Ref[] : [];
      if (!item.graph.choiceId || item.principal?.role !== 'external-human') {
        throw new RuntimeStoreError(
          `human confirmation event ${item.seq} has no confirming principal or choice`,
          'corrupt-journal',
        );
      }
      state = await confirmExternal(trajectory, state, item.graph.choiceId, {
        actor: item.principal.id,
        rationale,
        evidence,
        at: item.at,
      });
    } else if (item.kind === 'elicitation.required') {
      const question = item.data['question'];
      const rationale = typeof item.data['rationale'] === 'string' ? item.data['rationale'] : undefined;
      if (!item.graph.choiceId || typeof question !== 'string') {
        throw new RuntimeStoreError(
          `elicitation event ${item.seq} has no choice or question`,
          'corrupt-journal',
        );
      }
      state = await ask(trajectory, state, item.graph.choiceId, {
        actor: item.principal?.role === 'agent' ? 'agent' : item.principal?.id ?? 'agent',
        question,
        rationale,
        at: item.at,
      });
    } else if (item.kind === 'elicitation.answered') {
      const response = item.data['answer'];
      const rationale = typeof item.data['rationale'] === 'string' ? item.data['rationale'] : undefined;
      if (typeof response !== 'string' || item.principal?.role !== 'human') {
        throw new RuntimeStoreError(
          `elicitation answer event ${item.seq} has no human answer`,
          'corrupt-journal',
        );
      }
      state = await answer(trajectory, state, {
        actor: item.principal.id,
        answer: response,
        rationale,
        at: item.at,
      });
    } else if (item.kind === 'observation.recorded') {
      const name = item.data['name'];
      const value = item.data['value'];
      const rationale = typeof item.data['rationale'] === 'string' ? item.data['rationale'] : undefined;
      const actor = item.principal?.role === 'agent' ? 'agent' : item.principal?.id ?? 'system';
      if (typeof name !== 'string' ||
          (typeof value !== 'number' && typeof value !== 'boolean' && typeof value !== 'string') ||
          (typeof value === 'number' && !Number.isFinite(value))) {
        throw new RuntimeStoreError(
          `observation event ${item.seq} has an invalid name or value`,
          'corrupt-journal',
        );
      }
      state = await observe(trajectory, state, name, value, { actor, rationale, at: item.at });
    }
    const key = item.data['idempotencyKey'];
    const fingerprint = item.data['commandFingerprint'];
    if (typeof key === 'string' && typeof fingerprint === 'string') {
      const recordedSeqs = item.data['commandEventSeqs'];
      const eventSeqs = Array.isArray(recordedSeqs) &&
        recordedSeqs.every((value) => Number.isSafeInteger(value))
        ? recordedSeqs as number[]
        : [item.seq];
      idempotency[key] = { fingerprint, revision, eventSeqs };
    }
  }

  if (trajectory.hash !== expectedTrajectory.hash) {
    throw new RuntimeStoreError(
      `runtime run is bound to ${trajectory.hash}; supplied graph is ${expectedTrajectory.hash}`,
      'graph-mismatch',
    );
  }
  return { runId, revision, state, events, idempotency };
}

export async function loadRuntimeStore(
  root: string,
  runId: string,
  trajectory: Trajectory,
): Promise<RuntimeSnapshot> {
  const paths = runtimePaths(root, runId, trajectory.hash);
  if (!existsSync(paths.run) || !existsSync(paths.events)) {
    throw new RuntimeStoreError(`runtime run "${runId}" does not exist`, 'run-not-found');
  }
  const events = readRuntimeEvents(paths.events);
  const snapshot = await replayRuntimeEvents(root, trajectory, runId, events);
  // The journal is authoritative. Refreshing the snapshot also repairs a
  // missing or partially-written cache after an interrupted prior commit.
  writeStoredSnapshot(paths.snapshot, snapshot, trajectory.hash);
  return snapshot;
}

function readStoredRevision(path: string): number {
  try {
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as StoredSnapshot;
    return snapshot.revision;
  } catch {
    return -1;
  }
}

export function commitRuntimeStore(
  root: string,
  trajectory: Trajectory,
  before: RuntimeSnapshot,
  after: RuntimeSnapshot,
  emitted: RuntimeEvent[],
): void {
  const paths = runtimePaths(root, before.runId, trajectory.hash);
  if (!existsSync(paths.run)) {
    throw new RuntimeStoreError(`runtime run "${before.runId}" does not exist`, 'run-not-found');
  }
  const diskRevision = readStoredRevision(paths.snapshot);
  if (diskRevision !== before.revision) {
    throw new RuntimeStoreError(
      `runtime store revision is ${diskRevision}; command expected ${before.revision}`,
      'stale-revision',
    );
  }
  const expectedSeq = readRuntimeEvents(paths.events).length + 1;
  if (emitted.length > 0 && emitted[0].seq !== expectedSeq) {
    throw new RuntimeStoreError(
      `first emitted event is ${emitted[0].seq}; expected ${expectedSeq}`,
      'corrupt-journal',
    );
  }
  appendEvents(paths.events, emitted);
  writeStoredSnapshot(paths.snapshot, after, trajectory.hash);
}

export function runtimeStoreSize(root: string, runId: string, graphHash: string): {
  snapshotBytes: number;
  eventBytes: number;
} {
  const paths = runtimePaths(root, runId, graphHash);
  return {
    snapshotBytes: statSync(paths.snapshot).size,
    eventBytes: statSync(paths.events).size,
  };
}
