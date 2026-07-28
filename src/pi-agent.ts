/**
 * Host adapter for the Pi proving ground.
 *
 * The model-facing methods are permanently bound to an agent principal. A
 * human decision enters through `humanChoose`, which a trusted Pi command/UI
 * invokes outside the model tool surface.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compile, formatDiagnostics } from './compile.js';
import { RuntimeRunController } from './runtime-host.js';
import {
  RUNTIME_PROTOCOL_VERSION,
  type ProjectionProfile,
  type RuntimePrincipal,
} from './runtime-protocol.js';
import type { RuntimeCommandResult } from './runtime.js';
import {
  initializeRuntimeStore,
  loadRuntimeStore,
  RuntimeStoreError,
} from './runtime-store.js';
import type { Value } from './types.js';

export interface PiAgentBridgeOptions {
  planFile: string;
  runId: string;
  sessionId: string;
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
  readonly agentPrincipal: RuntimePrincipal;

  private requestSequence = 0;
  private readonly idempotencyRevisions = new Map<string, number>();

  private constructor(
    planFile: string,
    runId: string,
    sessionId: string,
    private readonly controller: RuntimeRunController,
  ) {
    this.planFile = planFile;
    this.runId = runId;
    this.agentPrincipal = {
      id: `pi:${sessionId}`,
      role: 'agent',
      uri: `pi://session/${encodeURIComponent(sessionId)}`,
    };
    for (const item of controller.currentSnapshot().events) {
      const key = item.data['idempotencyKey'];
      const expectedRevision = item.data['expectedRevision'];
      if (typeof key === 'string' && Number.isSafeInteger(expectedRevision)) {
        this.idempotencyRevisions.set(key, expectedRevision as number);
      }
    }
  }

  static async open(options: PiAgentBridgeOptions): Promise<PiAgentBridge> {
    const planFile = resolve(options.planFile);
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
      new RuntimeRunController(compiled.trajectory, snapshot, storeRoot),
    );
  }

  revision(): number {
    return this.controller.currentSnapshot().revision;
  }

  private requestId(): string {
    return `pi-${++this.requestSequence}`;
  }

  private async write(
    idempotencyKey: string,
    request: (expectedRevision: number) =>
      Parameters<RuntimeRunController['execute']>[1],
    principal: RuntimePrincipal = this.agentPrincipal,
  ): Promise<RuntimeCommandResult> {
    const expectedRevision =
      this.idempotencyRevisions.get(idempotencyKey) ?? this.revision();
    const result = await this.controller.execute(
      principal,
      request(expectedRevision),
    );
    this.idempotencyRevisions.set(idempotencyKey, expectedRevision);
    return result;
  }

  next(profile: ProjectionProfile = 'work'): Promise<RuntimeCommandResult> {
    return this.controller.execute(this.agentPrincipal, {
      protocol: RUNTIME_PROTOCOL_VERSION,
      id: this.requestId(),
      op: 'next',
      profile,
    });
  }

  choose(
    choiceId: string,
    rationale: string,
    idempotencyKey: string,
    profile: ProjectionProfile = 'work',
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
    }));
  }

  advance(
    rationale: string,
    idempotencyKey: string,
    profile: ProjectionProfile = 'work',
  ): Promise<RuntimeCommandResult> {
    return this.write(idempotencyKey, (expectedRevision) => ({
      protocol: RUNTIME_PROTOCOL_VERSION,
      id: this.requestId(),
      op: 'advance',
      rationale,
      expectedRevision,
      idempotencyKey,
      profile,
    }));
  }

  observe(
    name: string,
    value: Value,
    rationale: string,
    idempotencyKey: string,
    profile: ProjectionProfile = 'work',
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
    }));
  }

  humanChoose(
    human: Omit<RuntimePrincipal, 'role'>,
    choiceId: string,
    rationale: string,
    idempotencyKey: string,
    profile: ProjectionProfile = 'work',
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
    }), { ...human, role: 'human' });
  }
}
