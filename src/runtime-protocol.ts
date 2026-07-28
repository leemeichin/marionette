import type { Ref, Value } from './types.ts';
import type { Brief, BriefStatus } from './brief.ts';
import type { WalkErrorCode } from './state.ts';

export const RUNTIME_PROTOCOL_VERSION = '0.3.0';

export type RuntimeRole = 'agent' | 'human' | 'system';
export type ProjectionProfile = 'signal' | 'work' | 'debug';

export interface RuntimePrincipal {
  id: string;
  role: RuntimeRole;
  /** Optional stable provenance URI, for example a pibarm session URI. */
  uri?: string;
}

export interface RuntimeBudget {
  /** Hard upper bound for items in repeated fields such as choices and events. */
  maxItems?: number;
  /** Hint for the largest node body the caller wants inlined. */
  maxBodyChars?: number;
}

interface RequestBase {
  protocol: typeof RUNTIME_PROTOCOL_VERSION;
  id: string | number;
}

export interface InitializeRequest extends RequestBase {
  op: 'initialize';
  client: { name: string; version: string };
}

export interface NextRequest extends RequestBase {
  op: 'next';
  profile?: ProjectionProfile;
  budget?: RuntimeBudget;
}

export interface ChooseRequest extends RequestBase {
  op: 'choose';
  choiceId: string;
  rationale: string;
  expectedRevision: number;
  idempotencyKey?: string;
  profile?: ProjectionProfile;
  budget?: RuntimeBudget;
  evidence?: Ref[];
}

export interface AdvanceRequest extends RequestBase {
  op: 'advance';
  rationale: string;
  expectedRevision: number;
  idempotencyKey?: string;
  profile?: ProjectionProfile;
  budget?: RuntimeBudget;
  evidence?: Ref[];
}

export interface ObserveRequest extends RequestBase {
  op: 'observe';
  name: string;
  value: Value;
  rationale: string;
  expectedRevision: number;
  idempotencyKey?: string;
  profile?: ProjectionProfile;
  budget?: RuntimeBudget;
  evidence?: Ref[];
}

export interface RecordRequest extends RequestBase {
  op: 'record';
  kind: string;
  summary: string;
  rationale?: string;
  expectedRevision: number;
  idempotencyKey?: string;
  refs?: Ref[];
}

export interface EventsRequest extends RequestBase {
  op: 'events';
  after?: number;
  limit?: number;
}

export type RuntimeRequest =
  | InitializeRequest
  | NextRequest
  | ChooseRequest
  | AdvanceRequest
  | ObserveRequest
  | RecordRequest
  | EventsRequest;

export type RuntimeEventKind =
  | 'run.started'
  | 'node.entered'
  | 'decision.committed'
  | 'decision.refused'
  | 'observation.required'
  | 'observation.recorded'
  | 'record.attached'
  | 'human.required'
  | 'run.stranded'
  | 'run.completed'
  | 'plan.drifted'
  | 'plan.rebound';

export interface GraphReference {
  trajectoryHash: string;
  nodeId?: string;
  choiceId?: string;
  uri: string;
}

export interface RuntimeEvent {
  protocol: typeof RUNTIME_PROTOCOL_VERSION;
  seq: number;
  at: string;
  runId: string;
  kind: RuntimeEventKind;
  graph: GraphReference;
  principal?: RuntimePrincipal;
  data: Record<string, unknown>;
}

export interface RuntimeChoiceProjection {
  id: string;
  label: string;
  human: boolean;
  target?: string;
  targetTitle?: string | null;
  sticky?: boolean;
  loop?: boolean;
  available?: boolean;
  gate?: string | null;
  timeout?: { source: string; seconds: number } | null;
  /** Absolute opening time for a graph-authored timeout edge. */
  dueAt?: string | null;
  blocked?: {
    code:
      | 'once-exhausted'
      | 'gate-blocked'
      | 'observation-required'
      | 'timeout-pending'
      | 'timed-out';
    reason: string;
  } | null;
}

export interface RuntimeEscalation {
  /** Stable for one activation of an @human checkpoint. */
  id: string;
  /**
   * Revision a human response must claim. Hosts should fetch `next` before
   * responding because graph-linked records can advance the revision without
   * changing the checkpoint activation.
   */
  expectedRevision: number;
  reason: string;
  choices: Array<{
    id: string;
    label: string;
    target?: string;
  }>;
  /**
   * Only graph-authored timeout choices can end a silent escalation. Empty
   * means the run remains parked indefinitely.
   */
  fallbacks: Array<{
    choiceId: string;
    label: string;
    target?: string;
    dueAt: string | null;
  }>;
  response: {
    operation: 'choose';
  };
}

export interface RuntimeProjection {
  runId: string;
  revision: number;
  cursor: number;
  graphHash: string;
  status: BriefStatus;
  /** Executor context, omitted only from the compact signal profile. */
  plan?: Brief['plan'];
  node: {
    id: string;
    title: string;
    body?: string;
    bodyRef?: string;
    refs?: Ref[];
    meta?: Record<string, string | string[]>;
    timebox?: NonNullable<Brief['node']>['timebox'];
    priority?: NonNullable<Brief['node']>['priority'];
    enteredAt?: string | null;
  } | null;
  /** Effective delivery/reporting policy, omitted only from signal projections. */
  delivery?: Brief['delivery'];
  choices: RuntimeChoiceProjection[];
  next: { target: string; targetTitle?: string | null } | null;
  observations: Array<{ name: string; type: string }>;
  /** Present exactly when status is awaiting-human. */
  escalation: RuntimeEscalation | null;
  variables?: Record<string, Value>;
  progress?: { steps: number; nodesVisited: number; nodesTotal: number; path: string[] };
  truncated: boolean;
  omitted: string[];
}

export interface RuntimeSuccess {
  protocol: typeof RUNTIME_PROTOCOL_VERSION;
  id: string | number;
  ok: true;
  result: Record<string, unknown>;
}

export interface RuntimeFailure {
  protocol: typeof RUNTIME_PROTOCOL_VERSION;
  id: string | number | null;
  ok: false;
  error: {
    code: RuntimeErrorCode;
    message: string;
    data?: Record<string, unknown>;
  };
}

export type RuntimeResponse = RuntimeSuccess | RuntimeFailure;

export type RuntimeErrorCode =
  | WalkErrorCode
  | 'invalid-request'
  | 'unsupported-version'
  | 'stale-revision'
  | 'forbidden'
  | 'internal-error';

export class ProtocolError extends Error {
  constructor(
    message: string,
    public readonly code: RuntimeErrorCode,
    public readonly requestId: string | number | null = null,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const requireString = (value: unknown, field: string, id: string | number | null): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProtocolError(`"${field}" must be a non-empty string`, 'invalid-request', id);
  }
  return value;
};

const requireRevision = (value: unknown, id: string | number | null): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProtocolError('"expectedRevision" must be a non-negative integer', 'invalid-request', id);
  }
  return value as number;
};

const requireValue = (value: unknown, id: string | number | null): Value => {
  if (typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))) {
    return value;
  }
  throw new ProtocolError('"value" must be a finite number, boolean, or string', 'invalid-request', id);
};

function assertOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  id: string | number | null,
): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ProtocolError(`unknown request field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`,
      'invalid-request', id);
  }
}

function parseProfile(value: unknown, id: string | number | null): ProjectionProfile | undefined {
  if (value === undefined) return undefined;
  if (value === 'signal' || value === 'work' || value === 'debug') return value;
  throw new ProtocolError('"profile" must be signal, work, or debug', 'invalid-request', id);
}

function parseBudget(value: unknown, id: string | number | null): RuntimeBudget | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new ProtocolError('"budget" must be an object', 'invalid-request', id);
  assertOnlyKeys(value, ['maxItems', 'maxBodyChars'], id);
  const result: RuntimeBudget = {};
  for (const key of ['maxItems', 'maxBodyChars'] as const) {
    if (value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) {
      throw new ProtocolError(`"budget.${key}" must be a non-negative integer`, 'invalid-request', id);
    }
    result[key] = value[key] as number;
  }
  return result;
}

/**
 * Parse the deliberately small wire contract. Principal/actor is absent by
 * design: it is bound by the process that owns the connection.
 */
export function parseRuntimeRequest(input: unknown): RuntimeRequest {
  if (!isRecord(input)) throw new ProtocolError('request must be a JSON object', 'invalid-request');
  const rawId = input['id'];
  const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
  if (id === null) throw new ProtocolError('"id" must be a string or number', 'invalid-request');
  if (input['protocol'] !== RUNTIME_PROTOCOL_VERSION) {
    throw new ProtocolError(
      `unsupported protocol version ${JSON.stringify(input['protocol'])}; expected ${RUNTIME_PROTOCOL_VERSION}`,
      'unsupported-version',
      id,
    );
  }
  const op = requireString(input['op'], 'op', id);

  switch (op) {
    case 'initialize': {
      assertOnlyKeys(input, ['protocol', 'id', 'op', 'client'], id);
      if (!isRecord(input['client'])) throw new ProtocolError('"client" must be an object', 'invalid-request', id);
      assertOnlyKeys(input['client'], ['name', 'version'], id);
      return {
        protocol: RUNTIME_PROTOCOL_VERSION,
        id,
        op,
        client: {
          name: requireString(input['client']['name'], 'client.name', id),
          version: requireString(input['client']['version'], 'client.version', id),
        },
      };
    }
    case 'next': {
      assertOnlyKeys(input, ['protocol', 'id', 'op', 'profile', 'budget'], id);
      return {
        protocol: RUNTIME_PROTOCOL_VERSION, id, op,
        profile: parseProfile(input['profile'], id),
        budget: parseBudget(input['budget'], id),
      };
    }
    case 'choose': {
      assertOnlyKeys(input, [
        'protocol', 'id', 'op', 'choiceId', 'rationale', 'expectedRevision',
        'idempotencyKey', 'profile', 'budget', 'evidence',
      ], id);
      return {
        protocol: RUNTIME_PROTOCOL_VERSION, id, op,
        choiceId: requireString(input['choiceId'], 'choiceId', id),
        rationale: requireString(input['rationale'], 'rationale', id),
        expectedRevision: requireRevision(input['expectedRevision'], id),
        idempotencyKey: input['idempotencyKey'] === undefined
          ? undefined : requireString(input['idempotencyKey'], 'idempotencyKey', id),
        profile: parseProfile(input['profile'], id),
        budget: parseBudget(input['budget'], id),
        evidence: input['evidence'] as Ref[] | undefined,
      };
    }
    case 'advance': {
      assertOnlyKeys(input, [
        'protocol', 'id', 'op', 'rationale', 'expectedRevision',
        'idempotencyKey', 'profile', 'budget', 'evidence',
      ], id);
      return {
        protocol: RUNTIME_PROTOCOL_VERSION, id, op,
        rationale: requireString(input['rationale'], 'rationale', id),
        expectedRevision: requireRevision(input['expectedRevision'], id),
        idempotencyKey: input['idempotencyKey'] === undefined
          ? undefined : requireString(input['idempotencyKey'], 'idempotencyKey', id),
        profile: parseProfile(input['profile'], id),
        budget: parseBudget(input['budget'], id),
        evidence: input['evidence'] as Ref[] | undefined,
      };
    }
    case 'observe': {
      assertOnlyKeys(input, [
        'protocol', 'id', 'op', 'name', 'value', 'rationale', 'expectedRevision',
        'idempotencyKey', 'profile', 'budget', 'evidence',
      ], id);
      return {
        protocol: RUNTIME_PROTOCOL_VERSION, id, op,
        name: requireString(input['name'], 'name', id),
        value: requireValue(input['value'], id),
        rationale: requireString(input['rationale'], 'rationale', id),
        expectedRevision: requireRevision(input['expectedRevision'], id),
        idempotencyKey: input['idempotencyKey'] === undefined
          ? undefined : requireString(input['idempotencyKey'], 'idempotencyKey', id),
        profile: parseProfile(input['profile'], id),
        budget: parseBudget(input['budget'], id),
        evidence: input['evidence'] as Ref[] | undefined,
      };
    }
    case 'record': {
      assertOnlyKeys(input, [
        'protocol', 'id', 'op', 'kind', 'summary', 'rationale',
        'expectedRevision', 'idempotencyKey', 'refs',
      ], id);
      return {
        protocol: RUNTIME_PROTOCOL_VERSION, id, op,
        kind: requireString(input['kind'], 'kind', id),
        summary: requireString(input['summary'], 'summary', id),
        rationale: input['rationale'] === undefined
          ? undefined : requireString(input['rationale'], 'rationale', id),
        expectedRevision: requireRevision(input['expectedRevision'], id),
        idempotencyKey: input['idempotencyKey'] === undefined
          ? undefined : requireString(input['idempotencyKey'], 'idempotencyKey', id),
        refs: input['refs'] as Ref[] | undefined,
      };
    }
    case 'events': {
      assertOnlyKeys(input, ['protocol', 'id', 'op', 'after', 'limit'], id);
      const after = input['after'] === undefined ? undefined : requireRevision(input['after'], id);
      const limit = input['limit'] === undefined ? undefined : requireRevision(input['limit'], id);
      return { protocol: RUNTIME_PROTOCOL_VERSION, id, op, after, limit };
    }
    default:
      throw new ProtocolError(`unknown operation "${op}"`, 'invalid-request', id);
  }
}

export function graphReference(
  trajectoryHash: string,
  nodeId?: string,
  choiceId?: string,
): GraphReference {
  let uri = `marionette://trajectory/${encodeURIComponent(trajectoryHash)}`;
  if (nodeId) uri += `/node/${encodeURIComponent(nodeId)}`;
  if (choiceId) uri += `/choice/${encodeURIComponent(choiceId)}`;
  return { trajectoryHash, nodeId, choiceId, uri };
}
