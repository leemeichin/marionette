import { createInterface } from 'node:readline';
import type { Trajectory } from './types.js';
import {
  ProtocolError, RUNTIME_PROTOCOL_VERSION, parseRuntimeRequest,
  type RuntimeEvent, type RuntimeFailure, type RuntimePrincipal,
  type RuntimeResponse, type RuntimeSuccess,
} from './runtime-protocol.js';
import { executeRuntimeRequest, type RuntimeSnapshot } from './runtime.js';
import { RuntimeStoreError, commitRuntimeStore } from './runtime-store.js';

export const MAX_REQUEST_BYTES = 64 * 1024;

export interface RuntimeNotification {
  protocol: typeof RUNTIME_PROTOCOL_VERSION;
  type: 'event';
  event: RuntimeEvent;
}

export interface RuntimeLineResult {
  response: RuntimeResponse;
  notifications: RuntimeNotification[];
}

const success = (id: string | number, result: Record<string, unknown>): RuntimeSuccess => ({
  protocol: RUNTIME_PROTOCOL_VERSION,
  id,
  ok: true,
  result,
});

const failure = (
  id: string | number | null,
  code: RuntimeFailure['error']['code'],
  message: string,
  data?: Record<string, unknown>,
): RuntimeFailure => ({
  protocol: RUNTIME_PROTOCOL_VERSION,
  id,
  ok: false,
  error: { code, message, data },
});

export class RuntimeService {
  private initialized = false;

  constructor(
    private readonly trajectory: Trajectory,
    private snapshot: RuntimeSnapshot,
    private readonly storeRoot: string,
    private readonly principal: RuntimePrincipal,
  ) {}

  currentSnapshot(): RuntimeSnapshot {
    return this.snapshot;
  }

  async handleLine(line: string): Promise<RuntimeLineResult> {
    if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) {
      return {
        response: failure(null, 'invalid-request',
          `request exceeds ${MAX_REQUEST_BYTES} byte limit`),
        notifications: [],
      };
    }

    let input: unknown;
    try {
      input = JSON.parse(line);
    } catch {
      return {
        response: failure(null, 'invalid-request', 'request is not valid JSON'),
        notifications: [],
      };
    }

    try {
      const request = parseRuntimeRequest(input);
      if (!this.initialized && request.op !== 'initialize') {
        throw new ProtocolError('initialize must be the first request', 'invalid-request', request.id);
      }
      if (this.initialized && request.op === 'initialize') {
        throw new ProtocolError('connection is already initialized', 'invalid-request', request.id);
      }

      const before = this.snapshot;
      const executed = await executeRuntimeRequest(
        this.trajectory,
        before,
        this.principal,
        request,
      );
      if (request.op === 'initialize') this.initialized = true;
      if (executed.snapshot !== before) {
        commitRuntimeStore(this.storeRoot, this.trajectory, before, executed.snapshot, executed.events);
        this.snapshot = executed.snapshot;
      }
      return {
        response: success(request.id, { ...executed.result, replayed: executed.replayed }),
        notifications: executed.events.map((item) => ({
          protocol: RUNTIME_PROTOCOL_VERSION,
          type: 'event',
          event: item,
        })),
      };
    } catch (error) {
      if (error instanceof ProtocolError) {
        return {
          response: failure(error.requestId, error.code, error.message),
          notifications: [],
        };
      }
      if (error instanceof RuntimeStoreError) {
        const code = error.code === 'stale-revision' ? 'stale-revision' : 'internal-error';
        const rawId = input && typeof input === 'object' && 'id' in input
          ? (input as { id?: unknown }).id : null;
        const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
        return {
          response: failure(id, code, error.message, { storeCode: error.code }),
          notifications: [],
        };
      }
      const rawId = input && typeof input === 'object' && 'id' in input
        ? (input as { id?: unknown }).id : null;
      const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
      return {
        response: failure(id, 'internal-error', (error as Error).message),
        notifications: [],
      };
    }
  }
}

export async function serveRuntimeLines(
  service: RuntimeService,
  streams: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
    diagnostics?: NodeJS.WritableStream;
  },
): Promise<void> {
  const lines = createInterface({ input: streams.input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const result = await service.handleLine(line);
    streams.output.write(`${JSON.stringify(result.response)}\n`);
    for (const notification of result.notifications) {
      streams.output.write(`${JSON.stringify(notification)}\n`);
    }
  }
  streams.diagnostics?.write(
    `Marionette stopped · revision ${service.currentSnapshot().revision}\n`,
  );
}
