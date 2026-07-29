/**
 * Stable contract between the Marionette Pi extension and trusted host
 * integrations such as pibarm.
 *
 * Runtime requests remain the command plane. These envelopes are the
 * lifecycle/notification plane and are delivered consistently through Pi
 * tool details, custom session entries/messages, and the shared event bus.
 */

import type {
  ProjectionProfile,
  RuntimeBudget,
  RuntimeEvent,
  RuntimePrincipal,
  RuntimeProjection,
} from './runtime-protocol.ts';
import type { Ref, Value } from './types.ts';

export const MARIONETTE_PI_INTEGRATION_VERSION = '1.1.0';
export const MARIONETTE_PI_EVENT_CHANNEL = 'marionette:event:v1';
export const MARIONETTE_PI_READY_CHANNEL = 'marionette:ready:v1';
export const MARIONETTE_PI_DISCOVER_CHANNEL = 'marionette:discover:v1';
export const MARIONETTE_PI_HUMAN_CHANNEL = 'marionette:human:v1';

export interface MarionettePiBinding {
  planFile: string;
  runId: string;
  graphHash: string;
  runtimeProtocol: string;
  cursor: number;
  agentPrincipal: RuntimePrincipal;
}

export interface MarionettePiReceipt {
  revision?: number;
  eventSeqs: number[];
  replayed: boolean;
}

export interface MarionettePiError {
  name: string;
  code: string;
  message: string;
  requestId?: string | number | null;
  data?: Record<string, unknown>;
}

export type MarionettePiEventKind =
  | 'binding.bound'
  | 'binding.unbound'
  | 'plan.drafted'
  | 'runtime.result'
  | 'integration.error';

export interface MarionettePiDraft {
  planFile: string;
  graphHash: string;
  summary: string;
  mermaid: string;
  warnings: number;
}

export interface MarionettePiEvent {
  integration: 'marionette.pi';
  protocol: typeof MARIONETTE_PI_INTEGRATION_VERSION;
  kind: MarionettePiEventKind;
  at: string;
  cause: {
    source: 'session' | 'command' | 'tool' | 'host';
    name: string;
    id?: string;
  };
  binding: MarionettePiBinding | null;
  operation?: MarionettePiAgentCommand['operation'] | 'humanChoose';
  projection?: RuntimeProjection;
  events?: RuntimeEvent[];
  receipt?: MarionettePiReceipt;
  result?: Record<string, unknown>;
  draft?: MarionettePiDraft;
  error?: MarionettePiError;
}

interface ProjectionOptions {
  profile?: ProjectionProfile;
  budget?: RuntimeBudget;
}

interface EvidenceOptions extends ProjectionOptions {
  evidence?: Ref[];
}

export type MarionettePiAgentCommand =
  | {
      operation: 'capabilities';
      client?: { name: string; version: string };
    }
  | ({ operation: 'next' } & ProjectionOptions)
  | ({
      operation: 'choose';
      choiceId: string;
      rationale: string;
      idempotencyKey: string;
    } & EvidenceOptions)
  | ({
      operation: 'advance';
      rationale: string;
      idempotencyKey: string;
    } & EvidenceOptions)
  | ({
      operation: 'observe';
      name: string;
      value: Value;
      rationale: string;
      idempotencyKey: string;
    } & EvidenceOptions)
  | {
      operation: 'record';
      kind: string;
      summary: string;
      rationale?: string;
      refs?: Ref[];
      idempotencyKey: string;
    }
  | {
      operation: 'events';
      after?: number;
      limit?: number;
    };

export interface MarionettePiHumanDecision extends EvidenceOptions {
  human: Omit<RuntimePrincipal, 'role'>;
  choiceId: string;
  rationale: string;
  idempotencyKey: string;
  /** Defaults to true so the agent resumes after the trusted decision. */
  triggerTurn?: boolean;
}

export interface MarionettePiBindRequest {
  planFile: string;
  runId?: string;
  /** Defaults to false; hosts decide when binding should start an agent turn. */
  triggerTurn?: boolean;
}

/**
 * A trusted in-process extension can discover this API through the ready or
 * discover channels. Pi extensions already execute with full host authority;
 * callers must not expose humanChoose to the model tool surface.
 */
export interface MarionettePiHostApi {
  readonly protocol: typeof MARIONETTE_PI_INTEGRATION_VERSION;
  getBinding(): MarionettePiBinding | null;
  bind(request: MarionettePiBindRequest): Promise<MarionettePiEvent>;
  unbind(): Promise<MarionettePiEvent>;
  execute(command: MarionettePiAgentCommand): Promise<MarionettePiEvent>;
  humanChoose(decision: MarionettePiHumanDecision): Promise<MarionettePiEvent>;
}

export interface MarionettePiDiscoveryRequest {
  respond(api: MarionettePiHostApi): void;
}

export interface MarionettePiHumanIdentityRequest {
  respond(humanId: string): void;
}
