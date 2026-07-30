import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import {
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { analyzeAmendment } from './amendment.ts';
import { compile, formatDiagnostics } from './compile.ts';
import { renderCompactGraph, renderMermaid } from './render.ts';
import { renderSvg } from './render-svg.ts';
import { summarize } from './summarize.ts';
import {
  MARIONETTE_PI_DISCOVER_CHANNEL,
  MARIONETTE_PI_EVENT_CHANNEL,
  MARIONETTE_PI_HUMAN_CHANNEL,
  MARIONETTE_PI_INTEGRATION_VERSION,
  MARIONETTE_PI_READY_CHANNEL,
  type MarionettePiAgentCommand,
  type MarionettePiAmendment,
  type MarionettePiAmendmentApproval,
  type MarionettePiAmendmentRequest,
  type MarionettePiBindRequest,
  type MarionettePiBinding,
  type MarionettePiDiscoveryRequest,
  type MarionettePiError,
  type MarionettePiEvent,
  type MarionettePiHostApi,
  type MarionettePiHumanAnswer,
  type MarionettePiHumanDecision,
  type MarionettePiHumanIdentityRequest,
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
const HUMAN_ANSWER_ENTRY = 'marionette-human-answer';
const AMENDMENT_ENTRY = 'marionette-amendment';

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

interface StoredAmendment {
  status: 'pending' | 'applied';
  proposal: MarionettePiAmendment;
  source: string;
}

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

const storedAmendment = (value: unknown): StoredAmendment | null => {
  if (!isRecord(value) || (value['status'] !== 'pending' && value['status'] !== 'applied') ||
      typeof value['source'] !== 'string' || !isRecord(value['proposal'])) return null;
  const proposal = value['proposal'] as unknown as MarionettePiAmendment;
  return typeof proposal.id === 'string' && typeof proposal.candidateHash === 'string'
    ? { status: value['status'], source: value['source'], proposal }
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

const writePlan = async (planFile: string, source: string, overwrite: boolean): Promise<void> => {
  await mkdir(dirname(planFile), { recursive: true });
  if (!overwrite) {
    await writeFile(planFile, source, { encoding: 'utf8', flag: 'wx' });
    return;
  }
  const temporary = `${planFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, source, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, planFile);
  } finally {
    await unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
};

const stagePlan = async (planFile: string, source: string): Promise<string> => {
  await mkdir(dirname(planFile), { recursive: true });
  const temporary = `${planFile}.${process.pid}.${randomUUID()}.amend`;
  await writeFile(temporary, source, { encoding: 'utf8', flag: 'wx' });
  return temporary;
};

const resultWithoutProjection = (result: RuntimeCommandResult): Record<string, unknown> => {
  const output = { ...result.result };
  delete output['projection'];
  return output;
};

const instructionsFor = (projection: RuntimeProjection): string => {
  switch (projection.status) {
    case 'awaiting-human':
      return 'Stop autonomous work and wait. The user must answer through /marionette-decide.';
    case 'awaiting-elicitation':
      return 'Stop autonomous work and wait. The user supplies context through /marionette-answer.';
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
  let pendingAmendment: StoredAmendment | null = null;

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
      ctx.ui.setWidget('marionette-amendment', undefined);
      return;
    }
    const phase = projection.node?.id ?? projection.status;
    ctx.ui.setStatus('marionette', `${phase} · r${projection.revision}`);
    if (projection.elicitation) {
      ctx.ui.setWidget('marionette-escalation', [
        `Marionette needs clarification (${projection.elicitation.id})`,
        `  ${projection.elicitation.question}`,
        'Use /marionette-answer to respond.',
      ]);
    } else if (projection.escalation) {
      const lines = [
        `Marionette needs a human decision (${projection.escalation.id})`,
        ...projection.escalation.choices.map((choice) => `  ${choice.id} — ${choice.label}`),
        ...projection.escalation.fallbacks.map((fallback) =>
          `  fallback ${fallback.choiceId} opens ${fallback.dueAt ?? 'at its authored timeout'}`),
        'Use /marionette-decide to respond.',
      ];
      ctx.ui.setWidget('marionette-escalation', lines);
    } else {
      ctx.ui.setWidget('marionette-escalation', undefined);
    }
    if (pendingAmendment?.status === 'pending') {
      ctx.ui.setWidget('marionette-amendment', [
        `Marionette amendment ready (${pendingAmendment.proposal.id})`,
        `  ${pendingAmendment.proposal.report.changes.length} future change(s)`,
        'Use /marionette-approve-amendment to inspect and apply it.',
      ]);
    } else {
      ctx.ui.setWidget('marionette-amendment', undefined);
    }
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
    kind: MarionettePiEvent['kind'] = 'runtime.result',
    amendment?: MarionettePiAmendment,
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
      ...eventBase(kind, cause),
      operation,
      amendment,
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
        case 'ask':
          result = await bridge.ask(
            command.choiceId,
            command.question,
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

  const executeHumanAnswer = async (
    response: MarionettePiHumanAnswer,
    cause: MarionettePiEvent['cause'],
  ): Promise<MarionettePiEvent> => {
    if (!bridge) {
      return failure(cause, new PiIntegrationError(
        'No Marionette run is bound.',
        'not-bound',
      ), 'humanAnswer');
    }
    try {
      const result = await bridge.humanAnswer(
        response.human,
        response.answer,
        response.idempotencyKey,
        response.profile,
        { budget: response.budget, rationale: response.rationale },
      );
      const event = acceptResult('humanAnswer', result, cause);
      pi.appendEntry(HUMAN_ANSWER_ENTRY, {
        human: response.human,
        answer: response.answer,
        rationale: response.rationale,
        revision: event.projection?.revision,
        eventSeqs: event.receipt?.eventSeqs ?? [],
      });
      publishProjection(event, response.triggerTurn ?? true);
      return event;
    } catch (error) {
      return failure(cause, error, 'humanAnswer');
    }
  };

  const proposeAmendment = async (
    request: MarionettePiAmendmentRequest,
    cause: MarionettePiEvent['cause'],
  ): Promise<MarionettePiEvent> => {
    if (!bridge) {
      return failure(cause, new PiIntegrationError(
        'No Marionette run is bound.',
        'not-bound',
      ));
    }
    if (!request.rationale.trim()) {
      return failure(cause, new PiIntegrationError(
        'An amendment proposal requires a rationale.',
        'invalid-request',
      ));
    }
    try {
      await bridge.refresh();
      const compiled = await compile(request.source, { file: bridge.planFile });
      if (!compiled.ok || !compiled.trajectory) {
        throw new PiIntegrationError(
          formatDiagnostics(compiled.diagnostics, bridge.planFile, { source: request.source }) ||
            'Amendment candidate did not produce a trajectory.',
          'invalid-request',
        );
      }
      const report = analyzeAmendment(
        bridge.currentTrajectory(),
        compiled.trajectory,
        bridge.currentState(),
      );
      if (!report.allowed) {
        throw new PiIntegrationError(
          'Amendment would rewrite completed work:\n' +
            report.violations.map((violation) => `- ${violation.message}`).join('\n'),
          'invalid-request',
        );
      }
      const id = `amend-${randomUUID()}`;
      const directory = join(dirname(bridge.planFile), '.marionette', 'amendments', bridge.runId);
      const candidateFile = join(directory, `${id}.mar`);
      const mermaidFile = join(directory, `${id}.mmd`);
      const svgFile = join(directory, `${id}.svg`);
      const compact = renderCompactGraph(compiled.trajectory);
      const mermaid = await renderMermaid(compiled.trajectory);
      const svg = await renderSvg(compiled.trajectory);
      await withFileMutationQueue(candidateFile, async () => {
        await mkdir(directory, { recursive: true });
        await writePlan(candidateFile, request.source, false);
        await writeFile(mermaidFile, mermaid, 'utf8');
        await writeFile(svgFile, svg, 'utf8');
      });
      const proposal: MarionettePiAmendment = {
        id,
        planFile: bridge.planFile,
        candidateFile,
        baseHash: report.fromHash,
        candidateHash: report.toHash,
        rationale: request.rationale,
        report,
        compact,
        mermaid,
        mermaidFile,
        svgFile,
        warnings: compiled.diagnostics.filter((item) => item.severity === 'warning').length,
      };
      pendingAmendment = { status: 'pending', proposal, source: request.source };
      pi.appendEntry(AMENDMENT_ENTRY, pendingAmendment);
      if (activeContext) updateUi(lastProjection, activeContext);
      return emit({
        ...eventBase('plan.amendment-proposed', cause),
        amendment: proposal,
        result: { diagnostics: compiled.diagnostics },
      });
    } catch (error) {
      return failure(cause, error);
    }
  };

  const approveAmendment = async (
    approval: MarionettePiAmendmentApproval,
    cause: MarionettePiEvent['cause'],
  ): Promise<MarionettePiEvent> => {
    if (!bridge) {
      return failure(cause, new PiIntegrationError('No Marionette run is bound.', 'not-bound'), 'humanAmend');
    }
    if (!pendingAmendment || pendingAmendment.status !== 'pending' ||
        pendingAmendment.proposal.id !== approval.proposalId) {
      return failure(cause, new PiIntegrationError(
        `No pending amendment "${approval.proposalId}" exists on this session branch.`,
        'invalid-request',
      ), 'humanAmend');
    }
    if (!approval.rationale.trim()) {
      return failure(cause, new PiIntegrationError(
        'Human approval requires a rationale.',
        'invalid-request',
      ), 'humanAmend');
    }
    try {
      const stored = pendingAmendment;
      await bridge.refresh();
      const compiled = await compile(stored.source, { file: bridge.planFile });
      if (!compiled.ok || !compiled.trajectory || compiled.trajectory.hash !== stored.proposal.candidateHash) {
        throw new PiIntegrationError('The pending amendment artifact no longer compiles to its reviewed hash.', 'invalid-request');
      }
      const report = analyzeAmendment(
        bridge.currentTrajectory(),
        compiled.trajectory,
        bridge.currentState(),
      );
      if (!report.allowed) {
        throw new PiIntegrationError(
          'The run advanced after proposal and the amendment is no longer safe:\n' +
            report.violations.map((violation) => `- ${violation.message}`).join('\n'),
          'invalid-request',
        );
      }
      let result: RuntimeCommandResult;
      await withFileMutationQueue(bridge.planFile, async () => {
        const staged = await stagePlan(bridge!.planFile, stored.source);
        try {
          result = await bridge!.humanAmend(approval.human, compiled.trajectory!, approval.rationale);
          await rename(staged, bridge!.planFile);
        } catch (error) {
          await unlink(staged).catch(() => undefined);
          throw error;
        }
      });
      pendingAmendment = { ...stored, status: 'applied' };
      pi.appendEntry(AMENDMENT_ENTRY, pendingAmendment);
      pi.appendEntry(BINDING_ENTRY, {
        planFile: bridge.planFile,
        runId: bridge.runId,
        integrationVersion: MARIONETTE_PI_INTEGRATION_VERSION,
        graphHash: bridge.graphHash,
        runtimeProtocol: RUNTIME_PROTOCOL_VERSION,
      } satisfies StoredBinding);
      const event = acceptResult('humanAmend', result!, cause, 'plan.rebound', stored.proposal);
      if (activeContext) updateUi(event.projection ?? null, activeContext);
      publishProjection(event, approval.triggerTurn ?? true);
      return event;
    } catch (error) {
      return failure(cause, error, 'humanAmend');
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

  const configuredAmendment = (ctx: ExtensionContext): StoredAmendment | null => {
    const entry = [...ctx.sessionManager.getBranch()].reverse().find((candidate) =>
      candidate.type === 'custom' && candidate.customType === AMENDMENT_ENTRY);
    const amendment = entry?.type === 'custom' ? storedAmendment(entry.data) : null;
    return amendment?.status === 'pending' ? amendment : null;
  };

  const unbind = (
    ctx: ExtensionContext,
    cause: MarionettePiEvent['cause'],
    persistBinding: boolean,
  ): MarionettePiEvent => {
    const prior = currentBinding();
    bridge = null;
    lastProjection = null;
    pendingAmendment = null;
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
    pendingAmendment = configuredAmendment(ctx);
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
    proposeAmendment: (request) => proposeAmendment(request, {
      source: 'host',
      name: 'proposeAmendment',
    }),
    approveAmendment: (approval) => approveAmendment(approval, {
      source: 'host',
      name: 'approveAmendment',
    }),
    humanChoose: (decision) => executeHuman(decision, {
      source: 'host',
      name: 'humanChoose',
    }),
    humanAnswer: (answer) => executeHumanAnswer(answer, {
      source: 'host',
      name: 'humanAnswer',
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

  pi.registerCommand('marionette-approve-amendment', {
    description: 'Approve the pending future-only plan amendment as a trusted human',
    handler: async (args, ctx) => {
      activeContext = ctx;
      if (!pendingAmendment || pendingAmendment.status !== 'pending') {
        ctx.ui.notify('No plan amendment is pending on this session branch.', 'warning');
        return;
      }
      const tokens = splitArgs(args);
      const proposalId = tokens[0] === pendingAmendment.proposal.id
        ? tokens.shift()!
        : pendingAmendment.proposal.id;
      let humanId = pi.getFlag('marionette-human');
      if (typeof humanId !== 'string') {
        pi.events.emit(MARIONETTE_PI_HUMAN_CHANNEL, {
          respond(value: string) {
            if (value.trim()) humanId = value.trim();
          },
        } satisfies MarionettePiHumanIdentityRequest);
      }
      if (typeof humanId !== 'string' && ctx.hasUI) {
        humanId = await ctx.ui.input('Your name', 'recorded as the amendment approver');
      }
      if (typeof humanId !== 'string' || !humanId.trim()) {
        ctx.ui.notify('Set --marionette-human <name> or provide a name through the host.', 'error');
        return;
      }
      let rationale = tokens.join(' ').trim();
      if (!rationale && ctx.hasUI) {
        rationale = (await ctx.ui.editor(
          `Approve ${pendingAmendment.proposal.report.changes.length} future-only change(s)`,
          pendingAmendment.proposal.rationale,
        ) ?? '').trim();
      }
      if (!rationale) {
        ctx.ui.notify('A human approval rationale is required.', 'error');
        return;
      }
      const event = await approveAmendment({
        human: {
          id: humanId.trim(),
          uri: `pi://human/${encodeURIComponent(humanId.trim())}`,
        },
        proposalId,
        rationale,
        triggerTurn: true,
      }, { source: 'command', name: 'marionette-approve-amendment' });
      if (event.error) ctx.ui.notify(event.error.message, 'error');
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
      if (typeof humanId !== 'string') {
        pi.events.emit(MARIONETTE_PI_HUMAN_CHANNEL, {
          respond(value: string) {
            if (value.trim()) humanId = value.trim();
          },
        } satisfies MarionettePiHumanIdentityRequest);
      }
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

  pi.registerCommand('marionette-answer', {
    description: 'Supply context for an open @ask checkpoint',
    handler: async (args, ctx) => {
      activeContext = ctx;
      const refresh = await executeAgent(
        { operation: 'next' },
        { source: 'command', name: 'marionette-answer:refresh' },
      );
      if (refresh.error || !refresh.projection) {
        ctx.ui.notify(refresh.error?.message ?? 'No Marionette run is bound.', 'error');
        return;
      }
      const elicitation = refresh.projection.elicitation;
      if (!elicitation) {
        ctx.ui.notify(
          `Run is ${refresh.projection.status}; no clarification is pending.`,
          'warning',
        );
        return;
      }

      let response = args.trim();
      if (!response && ctx.hasUI) {
        response = (await ctx.ui.editor(elicitation.question, '') ?? '').trim();
      }
      if (!response) {
        ctx.ui.notify('A clarification answer is required.', 'error');
        return;
      }

      let humanId = pi.getFlag('marionette-human');
      if (typeof humanId !== 'string') {
        pi.events.emit(MARIONETTE_PI_HUMAN_CHANNEL, {
          respond(value: string) {
            if (value.trim()) humanId = value.trim();
          },
        } satisfies MarionettePiHumanIdentityRequest);
      }
      if (typeof humanId !== 'string' && ctx.hasUI) {
        humanId = await ctx.ui.input('Your name', 'recorded as the answer source');
      }
      if (typeof humanId !== 'string' || !humanId.trim()) {
        ctx.ui.notify('Set --marionette-human <name> or provide a name in the prompt.', 'error');
        return;
      }

      const event = await executeHumanAnswer({
        human: {
          id: humanId.trim(),
          uri: `pi://human/${encodeURIComponent(humanId.trim())}`,
        },
        answer: response,
        idempotencyKey: `human:${elicitation.id}:answer`,
        triggerTurn: true,
      }, {
        source: 'command',
        name: 'marionette-answer',
      });
      if (event.error) ctx.ui.notify(event.error.message, 'error');
    },
  });

  pi.registerTool({
    name: 'marionette_amend',
    label: 'Marionette amendment proposal',
    description:
      'Compile and propose a future-only amendment to the bound run without changing its live plan. Completed phases are immutable; a human must approve through /marionette-approve-amendment or the trusted host API.',
    parameters: Type.Object({
      source: Type.String({ description: 'Complete candidate Marionette DSL source' }),
      rationale: Type.String({ description: 'Why the current executable future needs to change' }),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      activeContext = ctx;
      const event = await proposeAmendment(params, {
        source: 'tool',
        name: 'marionette_amend',
        id: toolCallId,
      });
      if (event.error || !event.amendment) {
        return {
          content: [{ type: 'text', text: event.error?.message ?? 'Amendment proposal failed.' }],
          details: event,
          isError: true,
        };
      }
      const proposal = event.amendment;
      const changes = proposal.report.changes.map((change) =>
        `- ${change.kind}: ${change.subject}${change.fields.length ? ` (${change.fields.join(', ')})` : ''}`,
      ).join('\n');
      return {
        content: [{
          type: 'text',
          text: [
            `Amendment ${proposal.id} is validated and awaiting trusted human approval.`,
            `Live plan unchanged: ${proposal.planFile}`,
            '',
            changes || '- no semantic changes',
            '',
            proposal.compact,
            '',
            `Candidate: ${proposal.candidateFile}`,
            `Mermaid: ${proposal.mermaidFile}`,
            `SVG: ${proposal.svgFile}`,
            'Use /marionette-approve-amendment to apply it.',
          ].join('\n'),
        }],
        details: event,
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg('toolTitle', theme.bold('marionette amend')), 0, 0);
    },
  });

  pi.registerTool({
    name: 'marionette_draft',
    label: 'Marionette draft',
    description:
      'Validate and atomically write a Marionette .mar plan. Invalid plans are not written; the result includes compiler diagnostics, summary, Mermaid graph, and graph hash.',
    parameters: Type.Object({
      path: Type.String({ description: 'Destination .mar path, relative to the Pi working directory or absolute' }),
      source: Type.String({ description: 'Complete Marionette DSL source' }),
      overwrite: Type.Optional(Type.Boolean({ description: 'Replace an existing plan during explicit refinement' })),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      activeContext = ctx;
      const planFile = resolve(ctx.cwd, params.path);
      if (extname(planFile) !== '.mar') throw new Error('Marionette plan path must end in .mar');
      const compiled = await compile(params.source, { file: planFile });
      const diagnostics = formatDiagnostics(compiled.diagnostics, planFile, { source: params.source });
      if (!compiled.ok || !compiled.trajectory) {
        return {
          content: [{ type: 'text', text: diagnostics || 'Plan did not produce a trajectory.' }],
          details: { ok: false, planFile, diagnostics: compiled.diagnostics },
        };
      }

      const summary = summarize(compiled.trajectory, {
        diagnostics: compiled.diagnostics,
        file: planFile,
      });
      const mermaid = await renderMermaid(compiled.trajectory);
      await withFileMutationQueue(planFile, () =>
        writePlan(planFile, params.source, params.overwrite === true));
      const draft = {
        planFile,
        graphHash: compiled.trajectory.hash,
        summary,
        mermaid,
        warnings: compiled.diagnostics.filter((item) => item.severity === 'warning').length,
      };
      const event = emit({
        ...eventBase('plan.drafted', {
          source: 'tool',
          name: 'marionette_draft',
          id: toolCallId,
        }),
        draft,
        result: { diagnostics: compiled.diagnostics },
      });
      return {
        content: [{ type: 'text', text: `${summary}\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`` }],
        details: { ok: true, ...draft, event },
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg('toolTitle', theme.bold('marionette draft ')) +
          theme.fg('muted', args.path) +
          (args.overwrite ? theme.fg('warning', ' (refine)') : ''),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as {
        ok?: boolean;
        planFile?: string;
        graphHash?: string;
        summary?: string;
        mermaid?: string;
        diagnostics?: unknown[];
      } | undefined;
      if (!details?.ok) {
        return new Text(theme.fg('error', 'Plan rejected by the compiler; no file written.'), 0, 0);
      }
      const base = `${theme.fg('success', '✓ Valid plan')} ${theme.fg('muted', details.planFile ?? '')}`;
      return new Text(
        expanded
          ? `${base}\n${details.summary ?? ''}\n\n${theme.fg('dim', details.mermaid ?? '')}`
          : `${base}\n${theme.fg('dim', details.graphHash ?? '')}`,
        0,
        0,
      );
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
      'The tool is agent-bound, cannot take @human choices, and opens @ask choices with a focused question.',
    promptSnippet: 'marionette_walk — authoritative work packet and traversal for the bound Marionette run',
    promptGuidelines: [
      'When marionette_walk is bound, use it instead of marionette brief or marionette state commands.',
      'After each phase, call marionette_walk exactly once with choose or advance and an evidence-based rationale.',
      'At awaiting-human, awaiting-elicitation, waiting-timeout, stranded, or completed status, stop autonomous traversal and follow the projection.',
    ],
    executionMode: 'sequential',
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal('capabilities'),
        Type.Literal('next'),
        Type.Literal('choose'),
        Type.Literal('ask'),
        Type.Literal('advance'),
        Type.Literal('observe'),
        Type.Literal('record'),
        Type.Literal('events'),
      ]),
      choiceId: Type.Optional(Type.String()),
      question: Type.Optional(Type.String()),
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
        case 'ask':
          if (!params.choiceId || !params.question || !params.rationale) {
            return {
              content: [{ type: 'text', text: 'ask requires choiceId, question, and rationale' }],
              details: failure(cause, new PiIntegrationError(
                'ask requires choiceId, question, and rationale',
                'invalid-request',
              ), 'ask'),
              isError: true,
            };
          }
          command = {
            operation: 'ask',
            choiceId: params.choiceId,
            question: params.question,
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
        ['awaiting-human', 'awaiting-elicitation', 'waiting-timeout', 'stranded', 'completed']
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
