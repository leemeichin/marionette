import { buildBrief, type Brief } from './brief.js';
import { sha256Hex } from './hash.js';
import { advance, initState, observe, takeChoice, WalkError } from './state.js';
import type { PlanState, Ref, Trajectory } from './types.js';
import {
  ProtocolError, RUNTIME_PROTOCOL_VERSION, graphReference,
  type ProjectionProfile, type RuntimeBudget, type RuntimeEvent,
  type RuntimeEscalation, type RuntimeEventKind, type RuntimePrincipal, type RuntimeProjection,
  type RuntimeRequest,
} from './runtime-protocol.js';

export interface RuntimeIdempotencyRecord {
  fingerprint: string;
  revision: number;
  eventSeqs: number[];
}

export interface RuntimeSnapshot {
  runId: string;
  revision: number;
  state: PlanState;
  events: RuntimeEvent[];
  idempotency: Record<string, RuntimeIdempotencyRecord>;
}

export interface RuntimeCommandOptions {
  at?: string;
}

export interface RuntimeCommandResult {
  snapshot: RuntimeSnapshot;
  result: Record<string, unknown>;
  events: RuntimeEvent[];
  replayed: boolean;
}

const clone = <T>(value: T): T => structuredClone(value);

const title = (body: string, fallback: string): string =>
  body.split('\n')[0] || fallback;

const requestFingerprint = async (request: RuntimeRequest): Promise<string> => {
  const semantic = { ...request } as Record<string, unknown>;
  delete semantic['id'];
  delete semantic['profile'];
  delete semantic['budget'];
  return sha256Hex(JSON.stringify(semantic));
};

const isWrite = (request: RuntimeRequest): request is Extract<RuntimeRequest, {
  op: 'choose' | 'advance' | 'observe' | 'record';
}> => request.op === 'choose' || request.op === 'advance' ||
  request.op === 'observe' || request.op === 'record';

const event = (
  snapshot: RuntimeSnapshot,
  trajectory: Trajectory,
  kind: RuntimeEventKind,
  at: string,
  data: Record<string, unknown>,
  options: {
    principal?: RuntimePrincipal;
    nodeId?: string;
    choiceId?: string;
    offset?: number;
  } = {},
): RuntimeEvent => ({
  protocol: RUNTIME_PROTOCOL_VERSION,
  seq: (snapshot.events.at(-1)?.seq ?? 0) + 1 + (options.offset ?? 0),
  at,
  runId: snapshot.runId,
  kind,
  graph: graphReference(trajectory.hash, options.nodeId, options.choiceId),
  principal: options.principal,
  data,
});

const escalationUri = (runId: string, eventSeq: number): string =>
  `marionette://run/${encodeURIComponent(runId)}/escalation/${eventSeq}`;

function escalationPayload(
  brief: Brief,
  snapshot: RuntimeSnapshot,
  eventSeq: number,
  expectedRevision: number,
  includeTargets = true,
): RuntimeEscalation | null {
  if (!brief.escalation) return null;
  const byId = new Map(brief.frontier.map((choice) => [choice.id, choice]));
  return {
    id: escalationUri(snapshot.runId, eventSeq),
    expectedRevision,
    reason: brief.escalation.reason,
    choices: brief.escalation.choices.map((id) => {
      const choice = byId.get(id);
      return {
        id,
        label: choice?.label ?? id,
        target: includeTargets ? choice?.target : undefined,
      };
    }),
    fallbacks: brief.escalation.fallbacks.map((fallback) => ({
      choiceId: fallback.choice,
      label: fallback.label,
      target: includeTargets ? fallback.target : undefined,
      dueAt: fallback.dueAt,
    })),
    response: { operation: 'choose' },
  };
}

async function statusEvent(
  trajectory: Trajectory,
  snapshot: RuntimeSnapshot,
  at: string,
  offset: number,
  expectedRevision: number,
): Promise<RuntimeEvent | null> {
  const brief = await buildBrief(trajectory, snapshot.state, { at });
  const nodeId = brief.node?.id;
  if (brief.status === 'completed') {
    return event(snapshot, trajectory, 'run.completed', at, {}, { nodeId, offset });
  }
  if (brief.status === 'awaiting-human') {
    const required = event(snapshot, trajectory, 'human.required', at, {}, { nodeId, offset });
    required.data = escalationPayload(
      brief,
      snapshot,
      required.seq,
      expectedRevision,
    ) as unknown as Record<string, unknown>;
    return required;
  }
  if (brief.status === 'awaiting-observation') {
    return event(snapshot, trajectory, 'observation.required', at, {
      observations: brief.pendingObservations,
    }, { nodeId, offset });
  }
  if (brief.status === 'stranded') {
    return event(snapshot, trajectory, 'run.stranded', at, {
      choices: brief.frontier.map((choice) => ({
        id: choice.id,
        blockedCode: choice.blockedCode,
      })),
    }, { nodeId, offset });
  }
  return null;
}

export async function createRuntimeSnapshot(
  trajectory: Trajectory,
  options: { runId: string; at?: string; principal?: RuntimePrincipal },
): Promise<RuntimeSnapshot> {
  const at = options.at ?? new Date().toISOString();
  const state = await initState(trajectory, options.principal?.id ?? 'system', at);
  const snapshot: RuntimeSnapshot = {
    runId: options.runId,
    revision: 0,
    state,
    events: [],
    idempotency: {},
  };
  const started = event(snapshot, trajectory, 'run.started', at, {
    start: trajectory.start,
  }, { principal: options.principal, nodeId: trajectory.start });
  snapshot.events.push(started);
  if (state.status === 'completed') {
    snapshot.events.push(event(snapshot, trajectory, 'run.completed', at, {}, {
      principal: options.principal,
      offset: 0,
    }));
  } else {
    snapshot.events.push(event(snapshot, trajectory, 'node.entered', at, {
      from: null,
    }, { principal: options.principal, nodeId: state.current, offset: 0 }));
    const terminal = await statusEvent(trajectory, snapshot, at, 0, snapshot.revision);
    if (terminal) snapshot.events.push(terminal);
  }
  return snapshot;
}

export async function buildRuntimeProjection(
  trajectory: Trajectory,
  snapshot: RuntimeSnapshot,
  options: { profile?: ProjectionProfile; budget?: RuntimeBudget; at?: string } = {},
): Promise<RuntimeProjection> {
  const profile = options.profile ?? 'work';
  const brief = await buildBrief(trajectory, snapshot.state, { at: options.at });
  const omitted: string[] = [];
  let truncated = false;
  const maxItems = options.budget?.maxItems ??
    (profile === 'signal' ? 8 : Number.POSITIVE_INFINITY);
  const sourceChoices = profile === 'signal'
    ? brief.frontier.filter((choice) => choice.available)
    : brief.frontier;
  const selectedChoices = sourceChoices.slice(0, maxItems);
  if (selectedChoices.length < sourceChoices.length) {
    truncated = true;
    omitted.push(`choices:${sourceChoices.length - selectedChoices.length}`);
  }

  const node = brief.node
    ? {
        id: brief.node.id,
        title: brief.node.title,
        bodyRef: `${graphReference(trajectory.hash, brief.node.id).uri}/body`,
      } as NonNullable<RuntimeProjection['node']>
    : null;

  if (node && profile !== 'signal') {
    const maxBodyChars = options.budget?.maxBodyChars ?? Number.POSITIVE_INFINITY;
    node.body = brief.node!.body.length > maxBodyChars
      ? brief.node!.body.slice(0, maxBodyChars)
      : brief.node!.body;
    if (node.body.length < brief.node!.body.length) {
      truncated = true;
      omitted.push(`node.body:${brief.node!.body.length - node.body.length}`);
    }
    node.refs = brief.node!.refs;
    node.timebox = brief.node!.timebox;
    node.priority = brief.node!.priority;
    node.enteredAt = brief.node!.enteredAt;
    if (profile === 'debug') node.meta = brief.node!.meta;
  }

  const escalationEvent = brief.escalation
    ? [...snapshot.events].reverse().find((item) =>
        item.kind === 'human.required' && item.graph.nodeId === brief.node?.id)
    : undefined;
  const escalation = brief.escalation
    ? escalationPayload(
        brief,
        snapshot,
        escalationEvent?.seq ?? (snapshot.events.at(-1)?.seq ?? 0) + 1,
        snapshot.revision,
        profile !== 'signal',
      )
    : null;

  return {
    runId: snapshot.runId,
    revision: snapshot.revision,
    cursor: snapshot.events.at(-1)?.seq ?? 0,
    graphHash: trajectory.hash,
    status: brief.status,
    plan: profile === 'signal' ? undefined : brief.plan,
    node,
    delivery: profile === 'signal' ? undefined : brief.delivery,
    choices: selectedChoices.map((choice) => ({
      id: choice.id,
      label: choice.label,
      human: choice.human,
      target: profile === 'signal' ? undefined : choice.target,
      targetTitle: profile === 'signal' ? undefined : choice.targetTitle,
      sticky: profile === 'signal' ? undefined : choice.sticky,
      loop: profile === 'signal' ? undefined : choice.loop,
      available: profile === 'signal' ? undefined : choice.available,
      gate: profile === 'signal' ? undefined : choice.gate,
      timeout: profile === 'signal' ? undefined : choice.timeout,
      dueAt: profile === 'signal' || !choice.timeout
        ? undefined
        : snapshot.state.activationStartedAt === null
          ? null
          : new Date(
              Date.parse(snapshot.state.activationStartedAt) +
              choice.timeout.seconds * 1_000,
            ).toISOString(),
      blocked: profile !== 'signal' && choice.blocked && choice.blockedCode
        ? { code: choice.blockedCode, reason: choice.blocked }
        : undefined,
    })),
    next: brief.next
      ? {
          target: brief.next.target,
          targetTitle: profile === 'signal' ? undefined : brief.next.targetTitle,
        }
      : null,
    observations: brief.pendingObservations,
    escalation,
    variables: profile === 'signal' ? undefined : brief.variables,
    progress: profile === 'signal' ? undefined : brief.progress,
    truncated,
    omitted,
  };
}

function checkRevision(snapshot: RuntimeSnapshot, expected: number, requestId: string | number): void {
  if (expected !== snapshot.revision) {
    throw new ProtocolError(
      `stale revision ${expected}; current revision is ${snapshot.revision}`,
      'stale-revision',
      requestId,
    );
  }
}

async function checkIdempotency(
  snapshot: RuntimeSnapshot,
  request: Extract<RuntimeRequest, { op: 'choose' | 'advance' | 'observe' | 'record' }>,
): Promise<RuntimeIdempotencyRecord | null> {
  if (!request.idempotencyKey) return null;
  const prior = snapshot.idempotency[request.idempotencyKey];
  if (!prior) return null;
  if (prior.fingerprint !== await requestFingerprint(request)) {
    throw new ProtocolError(
      `idempotency key "${request.idempotencyKey}" was already used for a different command`,
      'invalid-request',
      request.id,
    );
  }
  return prior;
}

function bindWalkActor(principal: RuntimePrincipal): string {
  return principal.role === 'agent' ? 'agent' : principal.id;
}

function exactChoice(trajectory: Trajectory, state: PlanState, choiceId: string) {
  const node = trajectory.nodes.find((candidate) => candidate.id === state.current);
  const choice = node?.choices.find((candidate) => candidate.id === choiceId);
  if (!choice) {
    throw new ProtocolError(
      `choice "${choiceId}" does not exist at node "${state.current}"; runtime commands require an exact choice id`,
      'unknown-choice',
    );
  }
  return { node: node!, choice };
}

export async function executeRuntimeRequest(
  trajectory: Trajectory,
  input: RuntimeSnapshot,
  principal: RuntimePrincipal,
  request: RuntimeRequest,
  options: RuntimeCommandOptions = {},
): Promise<RuntimeCommandResult> {
  if (request.op === 'initialize') {
    return {
      snapshot: input,
      events: [],
      replayed: false,
      result: {
        protocol: RUNTIME_PROTOCOL_VERSION,
        capabilities: {
          operations: ['next', 'choose', 'advance', 'observe', 'record', 'events'],
          projections: ['signal', 'work', 'debug'],
          idempotency: true,
          eventCursor: true,
        },
        runId: input.runId,
        graphHash: trajectory.hash,
      },
    };
  }

  if (request.op === 'next') {
    return {
      snapshot: input,
      events: [],
      replayed: false,
      result: {
        projection: await buildRuntimeProjection(trajectory, input, {
          ...request,
          at: options.at,
        }),
      },
    };
  }

  if (request.op === 'events') {
    const after = request.after ?? 0;
    const limit = Math.min(request.limit ?? 100, 1_000);
    const events = input.events.filter((item) => item.seq > after).slice(0, limit);
    return {
      snapshot: input,
      events: [],
      replayed: false,
      result: {
        events,
        cursor: events.at(-1)?.seq ?? after,
        hasMore: input.events.some((item) => item.seq > (events.at(-1)?.seq ?? after)),
      },
    };
  }

  const prior = await checkIdempotency(input, request);
  if (prior) {
    return {
      snapshot: input,
      events: [],
      replayed: true,
      result: {
        replayed: true,
        revision: prior.revision,
        eventSeqs: prior.eventSeqs,
        projection: await buildRuntimeProjection(trajectory, input,
          request.op === 'record'
            ? { at: options.at }
            : { ...request, at: options.at }),
      },
    };
  }
  checkRevision(input, request.expectedRevision, request.id);

  const at = options.at ?? new Date().toISOString();
  const snapshot = clone(input);
  const emitted: RuntimeEvent[] = [];

  try {
    if (request.op === 'choose') {
      const { node, choice } = exactChoice(trajectory, snapshot.state, request.choiceId);
      if (choice.human && principal.role !== 'human') {
        throw new ProtocolError(
          `choice "${choice.label}" is an @human checkpoint; connection principal is ${principal.role}`,
          'forbidden',
          request.id,
        );
      }
      snapshot.state = await takeChoice(trajectory, snapshot.state, choice.id, {
        actor: bindWalkActor(principal),
        rationale: request.rationale,
        at,
      });
      emitted.push(event(snapshot, trajectory, 'decision.committed', at, {
        from: node.id,
        to: choice.target,
        label: choice.label,
        rationale: request.rationale,
        evidence: request.evidence ?? [],
        expectedRevision: request.expectedRevision,
        idempotencyKey: request.idempotencyKey ?? null,
        commandFingerprint: await requestFingerprint(request),
      }, { principal, nodeId: node.id, choiceId: choice.id }));
    } else if (request.op === 'advance') {
      const from = snapshot.state.current;
      const node = trajectory.nodes.find((candidate) => candidate.id === from);
      const to = node?.next?.target;
      snapshot.state = await advance(trajectory, snapshot.state, {
        actor: bindWalkActor(principal),
        rationale: request.rationale,
        at,
      });
      emitted.push(event(snapshot, trajectory, 'decision.committed', at, {
        from,
        to,
        label: null,
        rationale: request.rationale,
        evidence: request.evidence ?? [],
        expectedRevision: request.expectedRevision,
        idempotencyKey: request.idempotencyKey ?? null,
        commandFingerprint: await requestFingerprint(request),
      }, { principal, nodeId: from }));
    } else if (request.op === 'observe') {
      snapshot.state = await observe(trajectory, snapshot.state, request.name, request.value, {
        actor: bindWalkActor(principal),
        rationale: request.rationale,
        at,
      });
      emitted.push(event(snapshot, trajectory, 'observation.recorded', at, {
        name: request.name,
        value: request.value,
        rationale: request.rationale,
        evidence: request.evidence ?? [],
        expectedRevision: request.expectedRevision,
        idempotencyKey: request.idempotencyKey ?? null,
        commandFingerprint: await requestFingerprint(request),
      }, {
        principal,
        nodeId: snapshot.state.status === 'completed' ? undefined : snapshot.state.current,
      }));
    } else {
      emitted.push(event(snapshot, trajectory, 'record.attached', at, {
        recordKind: request.kind,
        summary: request.summary,
        rationale: request.rationale ?? null,
        refs: request.refs ?? [],
        expectedRevision: request.expectedRevision,
        idempotencyKey: request.idempotencyKey ?? null,
        commandFingerprint: await requestFingerprint(request),
      }, { principal, nodeId: snapshot.state.status === 'completed' ? undefined : snapshot.state.current }));
    }
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    if (error instanceof WalkError) {
      throw new ProtocolError(error.message, error.code, request.id);
    }
    throw error;
  }

  if (request.op !== 'record') {
    if ((request.op === 'choose' || request.op === 'advance') &&
        snapshot.state.status === 'active') {
      emitted.push(event(snapshot, trajectory, 'node.entered', at, {
        from: input.state.current,
      }, {
        principal,
        nodeId: snapshot.state.current,
        offset: emitted.length,
      }));
    }
    const terminal = await statusEvent(
      trajectory,
      snapshot,
      at,
      emitted.length,
      snapshot.revision + 1,
    );
    if (terminal) emitted.push(terminal);
  }

  if (request.idempotencyKey && emitted.length > 0) {
    emitted[0].data['commandEventSeqs'] = emitted.map((item) => item.seq);
  }
  snapshot.events.push(...emitted);
  snapshot.revision++;
  if (request.idempotencyKey) {
    snapshot.idempotency[request.idempotencyKey] = {
      fingerprint: await requestFingerprint(request),
      revision: snapshot.revision,
      eventSeqs: emitted.map((item) => item.seq),
    };
  }

  return {
    snapshot,
    events: emitted,
    replayed: false,
    result: {
      revision: snapshot.revision,
      eventSeqs: emitted.map((item) => item.seq),
      projection: await buildRuntimeProjection(trajectory, snapshot,
        request.op === 'record' ? { at } : { ...request, at }),
    },
  };
}
