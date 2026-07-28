import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  MARIONETTE_PI_DISCOVER_CHANNEL,
  MARIONETTE_PI_EVENT_CHANNEL,
  MARIONETTE_PI_INTEGRATION_VERSION,
  MARIONETTE_PI_READY_CHANNEL,
  type MarionettePiAgentCommand,
  type MarionettePiBindRequest,
  type MarionettePiBinding,
  type MarionettePiDiscoveryRequest,
  type MarionettePiError,
  type MarionettePiEvent,
  type MarionettePiHostApi,
  type MarionettePiHumanDecision,
} from './pi-integration.ts';
import {
  PiAgentBridge,
  PiAgentBridgeError,
} from './pi-agent.ts';
import {
  ProtocolError,
  RUNTIME_PROTOCOL_VERSION,
  type ProjectionProfile,
  type RuntimeBudget,
  type RuntimeProjection,
} from './runtime-protocol.ts';
import type { RuntimeCommandResult } from './runtime.ts';
import { RuntimeStoreError } from './runtime-store.ts';
import type { Ref, Value } from './types.ts';

const BINDING_ENTRY = 'marionette-binding';
const EVENT_ENTRY = 'marionette-event';
const PROJECTION_MESSAGE = 'marionette-projection';
const HUMAN_DECISION_ENTRY = 'marionette-human-decision';

interface StoredBinding {
  planFile: string;
  runId: string;
  integrationVersion?: string;
  graphHash?: string;
  runtimeProtocol?: string;
}

interface StoredUnbound {
  unbound: true;
  integrationVersion: string;
}

type BindingEntryData = StoredBinding | StoredUnbound;

class PiIntegrationError extends Error {
  readonly name = 'PiIntegrationError';

  constructor(message: string, public readonly code: 'not-bound' | 'invalid-request') {
    super(message);
  }
}

const splitArgs = (input: string): string[] =>
  [...input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '');

const safeRunId = (value: string): string =>
  value.replace(/[^A-Za-z0-9._-]/g, '-');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const storedBinding = (value: unknown): StoredBinding | null => {
  if (!isRecord(value) || value['unbound'] === true) return null;
  return typeof value['planFile'] === 'string' && typeof value['runId'] === 'string'
    ? { planFile: value['planFile'], runId: value['runId'] }
    : null;
};

const projectionOf = (result: RuntimeCommandResult): RuntimeProjection | undefined => {
  const projection = result.result['projection'];
  return isRecord(projection) ? projection as unknown as RuntimeProjection : undefined;
};

const errorDetails = (error: unknown): MarionettePiError => {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof PiIntegrationError) {
    return {
      name: error.name,
      code: error.code,
      message,
    };
  }
  if (error instanceof ProtocolError) {
    return {
      name: error.name,
      code: error.code,
      message,
      requestId: error.requestId,
    };
  }
  if (error instanceof RuntimeStoreError) {
    return {
      name: error.name,
      code: 'runtime-store',
      message,
      data: { storeCode: error.code },
    };
  }
  if (error instanceof PiAgentBridgeError) {
    return {
      name: error.name,
      code: error.code,
      message,
    };
  }
  return {
    name: error instanceof Error ? error.name : 'Error',
    code: 'internal-error',
    message,
  };
};

const profileOf = (value: unknown): ProjectionProfile =>
  value === 'signal' || value === 'debug' ? value : 'work';

const budgetOf = (value: unknown): RuntimeBudget | undefined => {
  if (!isRecord(value)) return undefined;
  const budget: RuntimeBudget = {};
  if (Number.isSafeInteger(value['maxItems'])) budget.maxItems = value['maxItems'] as number;
  if (Number.isSafeInteger(value['maxBodyChars'])) {
    budget.maxBodyChars = value['maxBodyChars'] as number;
  }
  return Object.keys(budget).length > 0 ? budget : undefined;
};

const refsOf = (value: unknown): Ref[] | undefined =>
  Array.isArray(value) ? value as Ref[] : undefined;

const resultWithoutProjection = (result: RuntimeCommandResult): Record<string, unknown> => {
  const output = { ...result.result };
  delete output['projection'];
  return output;
};

const instructionsFor = (projection: RuntimeProjection): string => {
  switch (projection.status) {
    case 'awaiting-human':
      return 'Stop autonomous work and wait. The user must answer through /marionette-decide.';
    case 'awaiting-observation':
      return 'Obtain only the requested observations, then record each with marionette_walk.';
    case 'waiting-timeout':
      return 'Park until the graph-authored timeout dueAt; do not poll or take another choice.';
    case 'stranded':
      return 'Stop and report the blocked choices and variables. The plan needs intervention.';
    case 'completed':
      return 'The run is complete. Report the recorded outcome and stop.';
    case 'active':
      return 'Complete the current phase, then use marionette_walk for exactly one graph transition.';
  }
};

export default function marionetteExtension(pi: ExtensionAPI): void {
  let bridge: PiAgentBridge | null = null;
  let lastProjection: RuntimeProjection | null = null;
  let lastCursor = 0;
  let activeContext: ExtensionContext | null = null;

  pi.registerFlag('marionette-plan', {
    description: 'Bind this Pi session to a Marionette .mar plan',
    type: 'string',
  });
  pi.registerFlag('marionette-run', {
    description: 'Runtime run id used with --marionette-plan',
    type: 'string',
  });
  pi.registerFlag('marionette-human', {
    description: 'Human identity recorded by /marionette-decide',
    type: 'string',
  });

  const currentBinding = (): MarionettePiBinding | null => {
    if (!bridge) return null;
    return {
      planFile: bridge.planFile,
      runId: bridge.runId,
      graphHash: bridge.graphHash,
      runtimeProtocol: RUNTIME_PROTOCOL_VERSION,
      cursor: lastCursor,
      agentPrincipal: bridge.agentPrincipal,
    };
  };

  const updateUi = (projection: RuntimeProjection | null, ctx: ExtensionContext): void => {
    if (!projection) {
      ctx.ui.setStatus('marionette', undefined);
      ctx.ui.setWidget('marionette-escalation', undefined);
      return;
    }
    const phase = projection.node?.id ?? projection.status;
    ctx.ui.setStatus('marionette', `${phase} · r${projection.revision}`);
    if (!projection.escalation) {
      ctx.ui.setWidget('marionette-escalation', undefined);
      return;
    }
    const lines = [
      `Marionette needs a human decision (${projection.escalation.id})`,
      ...projection.escalation.choices.map((choice) => `  ${choice.id} — ${choice.label}`),
      ...projection.escalation.fallbacks.map((fallback) =>
        `  fallback ${fallback.choiceId} opens ${fallback.dueAt ?? 'at its authored timeout'}`),
      'Use /marionette-decide to respond.',
    ];
    ctx.ui.setWidget('marionette-escalation', lines);
  };

  const emit = (event: MarionettePiEvent, persist = activeContext !== null): MarionettePiEvent => {
    pi.events.emit(MARIONETTE_PI_EVENT_CHANNEL, event);
    if (persist) pi.appendEntry(EVENT_ENTRY, event);
    return event;
  };

  const eventBase = (
    kind: MarionettePiEvent['kind'],
    cause: MarionettePiEvent['cause'],
  ): Omit<MarionettePiEvent, 'operation' | 'projection' | 'events' | 'receipt' | 'result' | 'error'> => ({
    integration: 'marionette.pi',
    protocol: MARIONETTE_PI_INTEGRATION_VERSION,
    kind,
    at: new Date().toISOString(),
    cause,
    binding: currentBinding(),
  });

  const failure = (
    cause: MarionettePiEvent['cause'],
    error: unknown,
    operation?: MarionettePiEvent['operation'],
  ): MarionettePiEvent => emit({
    ...eventBase('integration.error', cause),
    operation,
    error: errorDetails(error),
  });

  const acceptResult = (
    operation: MarionettePiEvent['operation'],
    result: RuntimeCommandResult,
    cause: MarionettePiEvent['cause'],
  ): MarionettePiEvent => {
    const projection = projectionOf(result);
    if (projection) {
      lastProjection = projection;
      lastCursor = projection.cursor;
      if (activeContext) updateUi(projection, activeContext);
    } else if (Number.isSafeInteger(result.result['cursor'])) {
      lastCursor = result.result['cursor'] as number;
    }
    const rawEventSeqs = result.result['eventSeqs'];
    const eventSeqs = Array.isArray(rawEventSeqs) &&
      rawEventSeqs.every((value) => Number.isSafeInteger(value))
      ? rawEventSeqs as number[]
      : result.events.map((item) => item.seq);
    const rawRevision = result.result['revision'];
    return emit({
      ...eventBase('runtime.result', cause),
      operation,
      projection,
      events: result.events,
      receipt: {
        revision: Number.isSafeInteger(rawRevision)
          ? rawRevision as number
          : projection?.revision,
        eventSeqs,
        replayed: result.replayed,
      },
      result: resultWithoutProjection(result),
    });
  };

  const executeAgent = async (
    command: MarionettePiAgentCommand,
    cause: MarionettePiEvent['cause'],
  ): Promise<MarionettePiEvent> => {
    if (!bridge) {
      return failure(cause, new PiIntegrationError(
        'No run is bound. Ask the user to run /marionette-start <plan.mar>.',
        'not-bound',
      ), command.operation);
    }
    try {
      let result: RuntimeCommandResult;
      switch (command.operation) {
        case 'capabilities':
          result = await bridge.initialize(command.client);
          break;
        case 'next':
          result = await bridge.next(command.profile, command.budget);
          break;
        case 'choose':
          result = await bridge.choose(
            command.choiceId,
            command.rationale,
            command.idempotencyKey,
            command.profile,
            { budget: command.budget, evidence: command.evidence },
          );
          break;
        case 'advance':
          result = await bridge.advance(
            command.rationale,
            command.idempotencyKey,
            command.profile,
            { budget: command.budget, evidence: command.evidence },
          );
          break;
        case 'observe':
          result = await bridge.observe(
            command.name,
            command.value,
            command.rationale,
            command.idempotencyKey,
            command.profile,
            { budget: command.budget, evidence: command.evidence },
          );
          break;
        case 'record':
          result = await bridge.record(
            command.kind,
            command.summary,
            command.idempotencyKey,
            { rationale: command.rationale, refs: command.refs },
          );
          break;
        case 'events':
          result = await bridge.events(command.after, command.limit);
          break;
      }
      return acceptResult(command.operation, result, cause);
    } catch (error) {
      return failure(cause, error, command.operation);
    }
  };

  const publishProjection = (event: MarionettePiEvent, triggerTurn: boolean): void => {
    if (!event.projection) return;
    pi.sendMessage({
      customType: PROJECTION_MESSAGE,
      content: `${instructionsFor(event.projection)}\n\n${JSON.stringify(event.projection)}`,
      display: true,
      details: event,
    }, { triggerTurn, deliverAs: 'steer' });
  };

  const executeHuman = async (
    decision: MarionettePiHumanDecision,
    cause: MarionettePiEvent['cause'],
  ): Promise<MarionettePiEvent> => {
    if (!bridge) {
      return failure(cause, new PiIntegrationError(
        'No Marionette run is bound.',
        'not-bound',
      ), 'humanChoose');
    }
    try {
      const result = await bridge.humanChoose(
        decision.human,
        decision.choiceId,
        decision.rationale,
        decision.idempotencyKey,
        decision.profile,
        { budget: decision.budget, evidence: decision.evidence },
      );
      const event = acceptResult('humanChoose', result, cause);
      pi.appendEntry(HUMAN_DECISION_ENTRY, {
        choiceId: decision.choiceId,
        human: decision.human,
        rationale: decision.rationale,
        revision: event.projection?.revision,
        eventSeqs: event.receipt?.eventSeqs ?? [],
      });
      publishProjection(event, decision.triggerTurn ?? true);
      return event;
    } catch (error) {
      return failure(cause, error, 'humanChoose');
    }
  };

  const open = async (
    binding: StoredBinding,
    ctx: ExtensionContext,
    cause: MarionettePiEvent['cause'],
    persistBinding: boolean,
  ): Promise<MarionettePiEvent> => {
    const candidate = await PiAgentBridge.open({
      planFile: binding.planFile,
      runId: binding.runId,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
    });
    const result = await candidate.next();
    const projection = projectionOf(result);
    if (!projection) throw new Error('Marionette runtime returned no projection');
    bridge = candidate;
    lastProjection = projection;
    lastCursor = projection.cursor;
    updateUi(projection, ctx);
    if (persistBinding) {
      const entry: BindingEntryData = {
        planFile: candidate.planFile,
        runId: candidate.runId,
        integrationVersion: MARIONETTE_PI_INTEGRATION_VERSION,
        graphHash: candidate.graphHash,
        runtimeProtocol: RUNTIME_PROTOCOL_VERSION,
      };
      pi.appendEntry(BINDING_ENTRY, entry);
    }
    return emit({
      ...eventBase('binding.bound', cause),
      projection,
      events: [],
      receipt: {
        revision: projection.revision,
        eventSeqs: [],
        replayed: false,
      },
    });
  };

  const configuredBinding = (ctx: ExtensionContext): StoredBinding | null => {
    const configuredPlan = pi.getFlag('marionette-plan');
    const configuredRun = pi.getFlag('marionette-run');
    if (typeof configuredPlan === 'string') {
      return {
        planFile: configuredPlan,
        runId: typeof configuredRun === 'string'
          ? configuredRun
          : safeRunId(`pi-${ctx.sessionManager.getSessionId()}`),
      };
    }
    const entry = [...ctx.sessionManager.getBranch()].reverse().find((candidate) =>
      candidate.type === 'custom' && candidate.customType === BINDING_ENTRY);
    return entry?.type === 'custom' ? storedBinding(entry.data) : null;
  };

  const unbind = (
    ctx: ExtensionContext,
    cause: MarionettePiEvent['cause'],
    persistBinding: boolean,
  ): MarionettePiEvent => {
    const prior = currentBinding();
    bridge = null;
    lastProjection = null;
    lastCursor = 0;
    updateUi(null, ctx);
    if (persistBinding) {
      const entry: StoredUnbound = {
        unbound: true,
        integrationVersion: MARIONETTE_PI_INTEGRATION_VERSION,
      };
      pi.appendEntry(BINDING_ENTRY, entry);
    }
    return emit({
      ...eventBase('binding.unbound', cause),
      binding: prior,
    });
  };

  const restore = async (
    ctx: ExtensionContext,
    cause: MarionettePiEvent['cause'],
  ): Promise<void> => {
    activeContext = ctx;
    const binding = configuredBinding(ctx);
    if (!binding) {
      if (bridge) {
        unbind(ctx, cause, false);
      } else {
        updateUi(null, ctx);
      }
      return;
    }
    try {
      await open(binding, ctx, cause, false);
    } catch (error) {
      bridge = null;
      lastProjection = null;
      lastCursor = 0;
      updateUi(null, ctx);
      const event = failure(cause, error);
      ctx.ui.notify(`Marionette resume failed: ${event.error?.message}`, 'error');
    }
  };

  const hostApi: MarionettePiHostApi = {
    protocol: MARIONETTE_PI_INTEGRATION_VERSION,
    getBinding: currentBinding,
    bind: async (request: MarionettePiBindRequest) => {
      const cause = { source: 'host' as const, name: 'bind' };
      if (!activeContext) {
        return failure(cause, new PiIntegrationError(
          'The Pi session has not started; bind after session_start.',
          'invalid-request',
        ));
      }
      try {
        const event = await open({
          planFile: request.planFile,
          runId: request.runId ??
            safeRunId(`pi-${activeContext.sessionManager.getSessionId()}`),
        }, activeContext, cause, true);
        if (request.triggerTurn) publishProjection(event, true);
        return event;
      } catch (error) {
        return failure(cause, error);
      }
    },
    unbind: async () => {
      const cause = { source: 'host' as const, name: 'unbind' };
      if (!activeContext) {
        return failure(cause, new PiIntegrationError(
          'The Pi session has not started; unbind after session_start.',
          'invalid-request',
        ));
      }
      if (typeof pi.getFlag('marionette-plan') === 'string') {
        return failure(cause, new PiIntegrationError(
          'Remove --marionette-plan before unbinding this session.',
          'invalid-request',
        ));
      }
      return unbind(activeContext, cause, true);
    },
    execute: (command) => executeAgent(command, {
      source: 'host',
      name: command.operation,
    }),
    humanChoose: (decision) => executeHuman(decision, {
      source: 'host',
      name: 'humanChoose',
    }),
  };

  const unsubscribeDiscovery = pi.events.on(
    MARIONETTE_PI_DISCOVER_CHANNEL,
    (value: unknown) => {
      if (isRecord(value) && typeof value['respond'] === 'function') {
        (value as unknown as MarionettePiDiscoveryRequest).respond(hostApi);
      }
    },
  );
  pi.events.emit(MARIONETTE_PI_READY_CHANNEL, hostApi);

  pi.registerCommand('marionette-start', {
    description: 'Start or resume a Marionette plan: /marionette-start <plan.mar> [run-id]',
    handler: async (args, ctx) => {
      activeContext = ctx;
      const [planFile, requestedRun] = splitArgs(args);
      if (!planFile) {
        ctx.ui.notify('Usage: /marionette-start <plan.mar> [run-id]', 'error');
        return;
      }
      const runId = requestedRun ??
        safeRunId(`pi-${ctx.sessionManager.getSessionId()}`);
      const cause = { source: 'command' as const, name: 'marionette-start' };
      try {
        const event = await open({ planFile, runId }, ctx, cause, true);
        publishProjection(event, true);
      } catch (error) {
        const event = failure(cause, error);
        ctx.ui.notify(event.error?.message ?? 'Marionette start failed', 'error');
      }
    },
  });

  pi.registerCommand('marionette-stop', {
    description: 'Unbind this Pi session without deleting the Marionette run',
    handler: async (_args, ctx) => {
      activeContext = ctx;
      if (typeof pi.getFlag('marionette-plan') === 'string') {
        ctx.ui.notify('Remove --marionette-plan to unbind this session.', 'warning');
        return;
      }
      unbind(ctx, { source: 'command', name: 'marionette-stop' }, true);
      ctx.ui.notify('Marionette run unbound; persisted runtime data was not deleted.', 'info');
    },
  });

  pi.registerCommand('marionette-decide', {
    description: 'Record a human answer at an @human checkpoint',
    handler: async (args, ctx) => {
      activeContext = ctx;
      const refresh = await executeAgent(
        { operation: 'next' },
        { source: 'command', name: 'marionette-decide:refresh' },
      );
      if (refresh.error || !refresh.projection) {
        ctx.ui.notify(refresh.error?.message ?? 'No Marionette run is bound.', 'error');
        return;
      }
      const escalation = refresh.projection.escalation;
      if (!escalation) {
        ctx.ui.notify(
          `Run is ${refresh.projection.status}; no human decision is pending.`,
          'warning',
        );
        return;
      }

      const tokens = splitArgs(args);
      let choiceId = tokens.shift();
      if (!choiceId && ctx.hasUI) {
        const labels = escalation.choices.map((choice) => `${choice.id} — ${choice.label}`);
        const selected = await ctx.ui.select('Choose a Marionette outcome', labels);
        choiceId = escalation.choices[labels.indexOf(selected ?? '')]?.id;
      }
      const choice = escalation.choices.find((candidate) => candidate.id === choiceId);
      if (!choice) {
        ctx.ui.notify(
          `Choose one of: ${escalation.choices.map((candidate) => candidate.id).join(', ')}`,
          'error',
        );
        return;
      }

      let humanId = pi.getFlag('marionette-human');
      if (typeof humanId !== 'string' && ctx.hasUI) {
        humanId = await ctx.ui.input('Your name', 'recorded as the decision actor');
      }
      if (typeof humanId !== 'string' || !humanId.trim()) {
        ctx.ui.notify('Set --marionette-human <name> or provide a name in the prompt.', 'error');
        return;
      }

      let rationale = tokens.join(' ').trim();
      if (!rationale && ctx.hasUI) {
        rationale = (await ctx.ui.editor('Decision rationale', '') ?? '').trim();
      }
      if (!rationale) {
        ctx.ui.notify('A human rationale is required.', 'error');
        return;
      }

      const event = await executeHuman({
        human: {
          id: humanId.trim(),
          uri: `pi://human/${encodeURIComponent(humanId.trim())}`,
        },
        choiceId: choice.id,
        rationale,
        idempotencyKey: `human:${escalation.id}:${choice.id}`,
        triggerTurn: true,
      }, {
        source: 'command',
        name: 'marionette-decide',
      });
      if (event.error) ctx.ui.notify(event.error.message, 'error');
    },
  });

  const refSchema = Type.Object({
    provider: Type.String(),
    kind: Type.String(),
    id: Type.String(),
    url: Type.Union([Type.String(), Type.Null()]),
  }, { additionalProperties: false });

  pi.registerTool({
    name: 'marionette_walk',
    label: 'Marionette walk',
    description:
      'Read or advance the bound Marionette run, attach records, or inspect its event journal. ' +
      'The tool is agent-bound and cannot take @human choices.',
    promptSnippet: 'marionette_walk — authoritative work packet and traversal for the bound Marionette run',
    promptGuidelines: [
      'When marionette_walk is bound, use it instead of marionette brief or marionette state commands.',
      'After each phase, call marionette_walk exactly once with choose or advance and an evidence-based rationale.',
      'At awaiting-human, waiting-timeout, stranded, or completed status, stop autonomous traversal and follow the projection.',
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal('capabilities'),
        Type.Literal('next'),
        Type.Literal('choose'),
        Type.Literal('advance'),
        Type.Literal('observe'),
        Type.Literal('record'),
        Type.Literal('events'),
      ]),
      choiceId: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      value: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
      rationale: Type.Optional(Type.String()),
      idempotencyKey: Type.Optional(Type.String()),
      profile: Type.Optional(Type.Union([
        Type.Literal('signal'),
        Type.Literal('work'),
        Type.Literal('debug'),
      ])),
      budget: Type.Optional(Type.Object({
        maxItems: Type.Optional(Type.Integer({ minimum: 0 })),
        maxBodyChars: Type.Optional(Type.Integer({ minimum: 0 })),
      }, { additionalProperties: false })),
      evidence: Type.Optional(Type.Array(refSchema)),
      recordKind: Type.Optional(Type.String()),
      summary: Type.Optional(Type.String()),
      refs: Type.Optional(Type.Array(refSchema)),
      after: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 0 })),
      clientName: Type.Optional(Type.String()),
      clientVersion: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      activeContext = ctx;
      const cause = {
        source: 'tool' as const,
        name: 'marionette_walk',
        id: toolCallId,
      };
      const writeKey = params.idempotencyKey ?? toolCallId;
      let command: MarionettePiAgentCommand | undefined;
      switch (params.operation) {
        case 'capabilities':
          command = {
            operation: 'capabilities',
            client: {
              name: params.clientName ?? 'marionette-pi-extension',
              version: params.clientVersion ?? MARIONETTE_PI_INTEGRATION_VERSION,
            },
          };
          break;
        case 'next':
          command = {
            operation: 'next',
            profile: profileOf(params.profile),
            budget: budgetOf(params.budget),
          };
          break;
        case 'choose':
          if (!params.choiceId || !params.rationale) {
            return {
              content: [{ type: 'text', text: 'choose requires choiceId and rationale' }],
              details: failure(cause, new PiIntegrationError(
                'choose requires choiceId and rationale',
                'invalid-request',
              ), 'choose'),
              isError: true,
            };
          }
          command = {
            operation: 'choose',
            choiceId: params.choiceId,
            rationale: params.rationale,
            idempotencyKey: writeKey,
            profile: profileOf(params.profile),
            budget: budgetOf(params.budget),
            evidence: refsOf(params.evidence),
          };
          break;
        case 'advance':
          if (!params.rationale) {
            return {
              content: [{ type: 'text', text: 'advance requires rationale' }],
              details: failure(cause, new PiIntegrationError(
                'advance requires rationale',
                'invalid-request',
              ), 'advance'),
              isError: true,
            };
          }
          command = {
            operation: 'advance',
            rationale: params.rationale,
            idempotencyKey: writeKey,
            profile: profileOf(params.profile),
            budget: budgetOf(params.budget),
            evidence: refsOf(params.evidence),
          };
          break;
        case 'observe':
          if (!params.name || params.value === undefined || !params.rationale) {
            return {
              content: [{
                type: 'text',
                text: 'observe requires name, value, and rationale',
              }],
              details: failure(cause, new PiIntegrationError(
                'observe requires name, value, and rationale',
                'invalid-request',
              ), 'observe'),
              isError: true,
            };
          }
          command = {
            operation: 'observe',
            name: params.name,
            value: params.value as Value,
            rationale: params.rationale,
            idempotencyKey: writeKey,
            profile: profileOf(params.profile),
            budget: budgetOf(params.budget),
            evidence: refsOf(params.evidence),
          };
          break;
        case 'record':
          if (!params.recordKind || !params.summary) {
            return {
              content: [{
                type: 'text',
                text: 'record requires recordKind and summary',
              }],
              details: failure(cause, new PiIntegrationError(
                'record requires recordKind and summary',
                'invalid-request',
              ), 'record'),
              isError: true,
            };
          }
          command = {
            operation: 'record',
            kind: params.recordKind,
            summary: params.summary,
            rationale: params.rationale,
            refs: refsOf(params.refs),
            idempotencyKey: writeKey,
          };
          break;
        case 'events':
          command = {
            operation: 'events',
            after: params.after,
            limit: params.limit,
          };
          break;
      }

      if (!command) {
        const event = failure(cause, new PiIntegrationError(
          `unknown marionette_walk operation ${JSON.stringify(params.operation)}`,
          'invalid-request',
        ));
        return {
          content: [{ type: 'text', text: event.error!.message }],
          details: event,
          isError: true,
        };
      }
      const event = await executeAgent(command, cause);
      if (event.error) {
        return {
          content: [{ type: 'text', text: event.error.message }],
          details: event,
          isError: true,
        };
      }
      const payload = event.projection ?? event.result ?? {};
      const stop = event.projection &&
        ['awaiting-human', 'waiting-timeout', 'stranded', 'completed']
          .includes(event.projection.status)
        ? `\nSTOP: ${instructionsFor(event.projection)}`
        : '';
      return {
        content: [{
          type: 'text',
          text: `${JSON.stringify(payload)}${stop}`,
        }],
        details: event,
      };
    },
  });

  pi.on('session_start', async (event, ctx) => {
    await restore(ctx, {
      source: 'session',
      name: `session_start:${event.reason}`,
    });
  });

  pi.on('session_tree', async (_event, ctx) => {
    await restore(ctx, {
      source: 'session',
      name: 'session_tree',
    });
  });

  pi.on('session_shutdown', (event, _ctx) => {
    if (bridge) {
      pi.events.emit(MARIONETTE_PI_EVENT_CHANNEL, {
        ...eventBase('binding.unbound', {
          source: 'session',
          name: `session_shutdown:${event.reason}`,
        }),
      } satisfies MarionettePiEvent);
    }
    activeContext = null;
    bridge = null;
    lastProjection = null;
    lastCursor = 0;
    unsubscribeDiscovery();
  });
}
