/**
 * Host adapter for the Pi proving ground.
 *
 * The model-facing methods are permanently bound to an agent principal. A
 * human decision enters through `humanChoose`, which a trusted Pi command/UI
 * invokes outside the model tool surface.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compile, formatDiagnostics } from './compile.ts';
import { RuntimeRunController } from './runtime-host.ts';
import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeBudget,
  type RuntimeEvent,
  type ProjectionProfile,
  type RuntimePrincipal,
} from './runtime-protocol.ts';
import type { RuntimeCommandResult } from './runtime.ts';
import {
  initializeRuntimeStore,
  loadRuntimeStore,
  RuntimeStoreError,
} from './runtime-store.ts';
import type { Ref, Trajectory, Value } from './types.ts';

export interface PiAgentBridgeOptions {
  planFile: string;
  runId: string;
  sessionId: string;
  /** Base used to resolve a relative planFile. Defaults to process.cwd(). */
  cwd?: string;
  storeRoot?: string;
}

export class PiAgentBridgeError extends Error {
  constructor(message: string, public readonly code: 'invalid-plan' | 'runtime-store') {
    super(message);
    this.name = 'PiAgentBridgeError';
  }
}

export class PiAgentBridge {
  readonly planFile: string;
  readonly runId: string;
  readonly storeRoot: string;
  readonly graphHash: string;
  readonly agentPrincipal: RuntimePrincipal;

  private requestSequence = 0;
  private operationTail: Promise<void> = Promise.resolve();
  private readonly idempotencyRevisions = new Map<string, number>();

  private constructor(
    planFile: string,
    runId: string,
    sessionId: string,
    storeRoot: string,
    private readonly trajectory: Trajectory,
    private readonly controller: RuntimeRunController,
  ) {
    this.planFile = planFile;
    this.runId = runId;
    this.storeRoot = storeRoot;
    this.graphHash = trajectory.hash;
    this.agentPrincipal = {
      id: `pi:${sessionId}`,
      role: 'agent',
      uri: `pi://session/${encodeURIComponent(sessionId)}`,
    };
    this.indexIdempotency(controller.currentSnapshot().events);
  }

  private indexIdempotency(events: RuntimeEvent[]): void {
    this.idempotencyRevisions.clear();
    for (const item of events) {
      const key = item.data['idempotencyKey'];
      const expectedRevision = item.data['expectedRevision'];
      if (typeof key === 'string' && Number.isSafeInteger(expectedRevision)) {
        this.idempotencyRevisions.set(key, expectedRevision as number);
      }
    }
  }

  static async open(options: PiAgentBridgeOptions): Promise<PiAgentBridge> {
    const planFile = resolve(options.cwd ?? process.cwd(), options.planFile);
    const source = readFileSync(planFile, 'utf8');
    const compiled = await compile(source, { file: planFile });
    if (!compiled.ok || !compiled.trajectory) {
      throw new PiAgentBridgeError(
        formatDiagnostics(compiled.diagnostics, planFile, { source }),
        'invalid-plan',
      );
    }
    const storeRoot = options.storeRoot ?? join(dirname(planFile), '.marionette');
    let snapshot;
    try {
      snapshot = await loadRuntimeStore(storeRoot, options.runId, compiled.trajectory);
    } catch (error) {
      if (!(error instanceof RuntimeStoreError) || error.code !== 'run-not-found') {
        throw new PiAgentBridgeError((error as Error).message, 'runtime-store');
      }
      snapshot = await initializeRuntimeStore(storeRoot, compiled.trajectory, {
        runId: options.runId,
        principal: {
          id: `pi:${options.sessionId}`,
          role: 'agent',
          uri: `pi://session/${encodeURIComponent(options.sessionId)}`,
        },
      });
    }
    return new PiAgentBridge(
      planFile,
      options.runId,
      options.sessionId,
      storeRoot,
      compiled.trajectory,
      new RuntimeRunController(compiled.trajectory, snapshot, storeRoot),
    );
  }

  revision(): number {
    return this.controller.currentSnapshot().revision;
  }

  private requestId(): string {
    return `pi-${++this.requestSequence}`;
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operationTail.then(operation);
    this.operationTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async refreshUnlocked(): Promise<void> {
    await this.controller.reload(async () =>
      loadRuntimeStore(this.storeRoot, this.runId, this.trajectory));
    this.indexIdempotency(this.controller.currentSnapshot().events);
  }

  refresh(): Promise<void> {
    return this.serialized(() => this.refreshUnlocked());
  }

  private write(
    idempotencyKey: string,
    request: (expectedRevision: number) =>
      Parameters<RuntimeRunController['execute']>[1],
    principal: RuntimePrincipal = this.agentPrincipal,
  ): Promise<RuntimeCommandResult> {
    return this.serialized(async () => {
      await this.refreshUnlocked();
      const expectedRevision =
        this.idempotencyRevisions.get(idempotencyKey) ?? this.revision();
      const result = await this.controller.execute(
        principal,
        request(expectedRevision),
      );
      this.idempotencyRevisions.set(idempotencyKey, expectedRevision);
      return result;
    });
  }

  initialize(
    client: { name: string; version: string } = {
      name: 'marionette-pi-extension',
      version: '1',
    },
  ): Promise<RuntimeCommandResult> {
    return this.serialized(async () => {
      await this.refreshUnlocked();
      return this.controller.execute(this.agentPrincipal, {
        protocol: RUNTIME_PROTOCOL_VERSION,
        id: this.requestId(),
        op: 'initialize',
        client,
      });
    });
  }

  next(
    profile: ProjectionProfile = 'work',
    budget?: RuntimeBudget,
  ): Promise<RuntimeCommandResult> {
    return this.serialized(async () => {
      await this.refreshUnlocked();
      return this.controller.execute(this.agentPrincipal, {
        protocol: RUNTIME_PROTOCOL_VERSION,
        id: this.requestId(),
        op: 'next',
        profile,
        budget,
      });
    });
  }

  choose(
    choiceId: string,
    rationale: string,
    idempotencyKey: string,
    profile: ProjectionProfile = 'work',
    options: { budget?: RuntimeBudget; evidence?: Ref[] } = {},
  ): Promise<RuntimeCommandResult> {
    return this.write(idempotencyKey, (expectedRevision) => ({
      protocol: RUNTIME_PROTOCOL_VERSION,
      id: this.requestId(),
      op: 'choose',
      choiceId,
      rationale,
      expectedRevision,
      idempotencyKey,
      profile,
      ...options,
    }));
  }

  advance(
    rationale: string,
    idempotencyKey: string,
    profile: ProjectionProfile = 'work',
    options: { budget?: RuntimeBudget; evidence?: Ref[] } = {},
  ): Promise<RuntimeCommandResult> {
    return this.write(idempotencyKey, (expectedRevision) => ({
      protocol: RUNTIME_PROTOCOL_VERSION,
      id: this.requestId(),
      op: 'advance',
      rationale,
      expectedRevision,
      idempotencyKey,
      profile,
      ...options,
    }));
  }

  observe(
    name: string,
    value: Value,
    rationale: string,
    idempotencyKey: string,
    profile: ProjectionProfile = 'work',
    options: { budget?: RuntimeBudget; evidence?: Ref[] } = {},
  ): Promise<RuntimeCommandResult> {
    return this.write(idempotencyKey, (expectedRevision) => ({
      protocol: RUNTIME_PROTOCOL_VERSION,
      id: this.requestId(),
      op: 'observe',
      name,
      value,
      rationale,
      expectedRevision,
      idempotencyKey,
      profile,
      ...options,
    }));
  }

  record(
    kind: string,
    summary: string,
    idempotencyKey: string,
    options: { rationale?: string; refs?: Ref[] } = {},
  ): Promise<RuntimeCommandResult> {
    return this.write(idempotencyKey, (expectedRevision) => ({
      protocol: RUNTIME_PROTOCOL_VERSION,
      id: this.requestId(),
      op: 'record',
      kind,
      summary,
      expectedRevision,
      idempotencyKey,
      ...options,
    }));
  }

  events(after = 0, limit = 100): Promise<RuntimeCommandResult> {
    return this.serialized(async () => {
      await this.refreshUnlocked();
      return this.controller.execute(this.agentPrincipal, {
        protocol: RUNTIME_PROTOCOL_VERSION,
        id: this.requestId(),
        op: 'events',
        after,
        limit,
      });
    });
  }

  humanChoose(
    human: Omit<RuntimePrincipal, 'role'>,
    choiceId: string,
    rationale: string,
    idempotencyKey: string,
    profile: ProjectionProfile = 'work',
    options: { budget?: RuntimeBudget; evidence?: Ref[] } = {},
  ): Promise<RuntimeCommandResult> {
    return this.write(idempotencyKey, (expectedRevision) => ({
      protocol: RUNTIME_PROTOCOL_VERSION,
      id: this.requestId(),
      op: 'choose',
      choiceId,
      rationale,
      expectedRevision,
      idempotencyKey,
      profile,
      ...options,
    }), { ...human, role: 'human' });
  }
}
